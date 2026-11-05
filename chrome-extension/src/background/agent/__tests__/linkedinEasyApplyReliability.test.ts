/**
 * Regression tests for the live LinkedIn Easy Apply problems:
 *  - the required multi-select question "Which of the following have you personally owned in your
 *    recent role?" was never ticked;
 *  - a Gemini 429 was retried with backoff (minutes of "Application in progress");
 *  - Submit on a long review page was not found / could be clicked twice / success was missed.
 *
 * The page-level tests drive `Page` with a mocked Puppeteer page. The same scenarios run against
 * real Chrome with LinkedIn-shaped markup in the session's scratch tests; neither replaces a live
 * LinkedIn run.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

vi.mock('webextension-polyfill', () => ({
  default: {
    tabs: { get: vi.fn(), query: vi.fn(), update: vi.fn(), reload: vi.fn() },
    runtime: { id: 'mock-ext-id' },
  },
}));
// No configured AI provider in these tests: every AI request is an explicit mock.
vi.mock('../activeModelHelper', () => ({ getActiveChatModel: vi.fn().mockResolvedValue(undefined) }));

import {
  DEFAULT_AUTH_SESSION,
  DEFAULT_CAREER_BRAIN,
  authStorage,
  careerBrainStore,
  type ICareerBrain,
} from '@extension/storage';
import {
  assessCheckboxOptions,
  isExclusiveChoiceOption,
  parseMultiSelectAnswer,
  resolveChoiceContradictions,
  selectEvidenceSupportedOptions,
} from '../linkedin/checkboxGroupResolver';
import {
  explainUnanswerableLinkedInField,
  generateAutonomousFallbackAnswerWithSource,
  matchRuleBased,
  matchesQuestionLoosely,
  resolveLinkedInAddressField,
  prepareAnswerForLinkedInField,
  solveLinkedInCheckboxGroup,
  solveLinkedInFieldAutonomously,
  solveValidationErrorWithLLM,
  type FormFieldDescriptor,
} from '../linkedin/formQuestionResolver';
import {
  LINKEDIN_AI_CALL_TIMEOUT_MS,
  LinkedInAiPausedError,
  getLinkedInAiStats,
  isLinkedInAiPaused,
  linkedInAiPauseRemainingMs,
  resetLinkedInAiPolicy,
  wrapLinkedInAiModel,
} from '../linkedin/linkedinAiPolicy';
import { resetLlmCircuitBreaker } from '../llmCircuitBreaker';
import { createLinkedInSubmitter, type LinkedInSubmitPage } from '../linkedin/linkedinSubmit';
import { dedicatedJobRunner } from '../linkedin/dedicatedJobRunner';
import { outcomeForFailure } from '../../services/applicationHistory';
import Page, { type JobTopCardContext } from '../../browser/page';

/** A chat model whose `invoke` is a Vitest mock. */
const mockModel = (invoke: Mock = vi.fn()) => ({ invoke, model: { invoke } as unknown as BaseChatModel });

/** Lets a test reach the page's private Puppeteer handle and the global `chrome`. */
const setPuppeteerPage = (page: Page, puppeteerPage: Record<string, unknown>) => {
  (page as unknown as { _puppeteerPage: unknown })._puppeteerPage = puppeteerPage;
};
const stubChrome = () => vi.stubGlobal('chrome', { runtime: { id: 'mock-ext-id' }, tabs: { get: vi.fn() } });

type ModalSnapshot = NonNullable<Awaited<ReturnType<Page['captureModalSnapshot']>>>;

const OWNED_QUESTION = 'Which of the following have you personally owned in your recent role?';
const OWNED_OPTIONS = [
  'Building features from requirements to production',
  'Designing reusable React components',
  'Making frontend architecture decisions',
  'Improving application performance',
  'Writing frontend tests',
  'Reviewing code from other developers',
  'Supporting production issues',
  'Only implementing designs provided by others',
];

const ownedGroup = (suffix = ''): FormFieldDescriptor => ({
  label: `${OWNED_QUESTION}${suffix}`,
  fieldType: 'checkbox',
  options: OWNED_OPTIONS,
  required: true,
});

const brain = (extra: Partial<ICareerBrain> = {}): ICareerBrain => ({
  ...DEFAULT_CAREER_BRAIN,
  fullName: 'Test Candidate',
  email: 'candidate@example.com',
  currentTitle: 'Frontend Developer',
  resumeText: '',
  skills: [],
  workExperience: [],
  goldenAnswers: [],
  customAnswers: {},
  ...extra,
});

// Resume of a React developer who did most — not all — of the listed activities.
const FRONTEND_RESUME = [
  'Frontend Developer, Acme Corp (2021 - present)',
  'Built a reusable React component library with Storybook used across 4 products.',
  'Delivered features end-to-end from product requirements to production deployments via CI/CD.',
  'Improved page load times by 40% through code splitting and lazy loading.',
  'Wrote unit tests with Jest and React Testing Library.',
  'Reviewed pull requests for the team.',
  'Debugged and resolved production incidents.',
].join('\n');

const frontendDev = () =>
  brain({ resumeText: FRONTEND_RESUME, skills: ['React', 'TypeScript', 'JavaScript', 'Jest', 'CSS'] });

const rateLimitError = () => Object.assign(new Error('429 PROVIDER_RATE_LIMIT: Too Many Requests'), { status: 429 });

beforeEach(() => {
  resetLinkedInAiPolicy();
  resetLlmCircuitBreaker();
});

// ── 1. The multi-select question from the live run ───────────────────────────

describe('LinkedIn checkbox group: "personally owned in your recent role"', () => {
  it('selects every option the resume supports — and only those', () => {
    const { selected } = selectEvidenceSupportedOptions(OWNED_OPTIONS, frontendDev());
    expect(selected).toEqual([
      'Building features from requirements to production',
      'Designing reusable React components',
      'Improving application performance',
      'Writing frontend tests',
      'Reviewing code from other developers',
      'Supporting production issues',
    ]);
  });

  it('does not claim architecture decisions from weak words such as "scalable" or "state management"', () => {
    const b = brain({ resumeText: 'Built scalable React apps with Redux state management. Led a team of 3.' });
    const arch = assessCheckboxOptions(['Making frontend architecture decisions'], b)[0];
    expect(arch.supported).toBe(false);
    expect(arch.missing).toContain('architecture');

    const architect = brain({ resumeText: 'Architected the micro-frontend platform and led the migration.' });
    expect(assessCheckboxOptions(['Making frontend architecture decisions'], architect)[0].supported).toBe(true);
  });

  it('never auto-selects the exclusive "Only implementing designs provided by others" option', () => {
    expect(isExclusiveChoiceOption('Only implementing designs provided by others')).toBe(true);
    const designer = brain({ resumeText: 'Implemented designs provided by the design team in Figma.' });
    const only = assessCheckboxOptions(OWNED_OPTIONS, designer).find(a => a.option.startsWith('Only'));
    expect(only?.supported).toBe(false);
  });

  it('drops the exclusive option when an answer combines it with other options', () => {
    expect(
      resolveChoiceContradictions(['Writing frontend tests', 'Only implementing designs provided by others']),
    ).toEqual({ kept: ['Writing frontend tests'], dropped: ['Only implementing designs provided by others'] });
    const prepared = prepareAnswerForLinkedInField(
      ownedGroup(),
      'Writing frontend tests | Only implementing designs provided by others | Supporting production issues',
    );
    expect(prepared).toEqual(
      expect.objectContaining({ valid: true, value: 'Writing frontend tests | Supporting production issues' }),
    );
  });

  it('keeps a multi-option answer intact (the single-option guard used to reject or collapse it)', () => {
    const prepared = prepareAnswerForLinkedInField(
      ownedGroup(),
      '["Designing reusable React components", "Improving application performance"]',
    );
    expect(prepared.valid).toBe(true);
    expect(prepared.value).toBe('Designing reusable React components | Improving application performance');

    expect(
      parseMultiSelectAnswer('Writing frontend tests, Reviewing code from other developers', OWNED_OPTIONS).matched,
    ).toEqual(['Writing frontend tests', 'Reviewing code from other developers']);
    expect(prepareAnswerForLinkedInField(ownedGroup(), 'Cooking').valid).toBe(false);
  });

  it('answers from the resume without any AI request', async () => {
    const { invoke, model } = mockModel();
    const res = await solveLinkedInCheckboxGroup(ownedGroup(' (a)'), frontendDev(), model);
    expect(res.success).toBe(true);
    expect(res.source).toBe('Resume / Career Brain');
    expect(res.answer?.split(' | ')).toHaveLength(6);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('prefers a saved (approved) answer for the same question', async () => {
    const b = brain({
      resumeText: FRONTEND_RESUME,
      customAnswers: { [OWNED_QUESTION]: 'Writing frontend tests | Supporting production issues' },
    });
    const res = await solveLinkedInCheckboxGroup(ownedGroup(), b, undefined);
    expect(res).toEqual(
      expect.objectContaining({
        success: true,
        source: 'Approved Memory',
        answer: 'Writing frontend tests | Supporting production issues',
      }),
    );
  });

  it('asks the AI once for ALL options when the resume proves nothing, and reuses that answer', async () => {
    const { invoke, model } = mockModel(
      vi.fn().mockResolvedValue({
        content:
          '{"selected": ["Writing frontend tests", "Only implementing designs provided by others"], "reason": "resume mentions testing"}',
      }),
    );
    const field = ownedGroup(' (ai)');
    const first = await solveLinkedInCheckboxGroup(field, brain(), model);
    const second = await solveLinkedInCheckboxGroup({ ...field }, brain(), model);
    expect(first).toEqual(expect.objectContaining({ success: true, source: 'AI', answer: 'Writing frontend tests' }));
    expect(second.answer).toBe('Writing frontend tests');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('reports the question as unresolved (never guesses) when nothing supports any option', async () => {
    const field = ownedGroup(' (none)');
    const res = await solveLinkedInCheckboxGroup(field, brain({ currentTitle: 'Chef' }), undefined);
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/no option is supported by Career Brain \/ resume \(AI unavailable\)/);
    expect(generateAutonomousFallbackAnswerWithSource(field, brain({ currentTitle: 'Chef' })).answer).toBe('');
    expect(explainUnanswerableLinkedInField(field, brain({ currentTitle: 'Chef' }))).toMatch(/no option is supported/);
    // Answerable groups are not reported.
    expect(explainUnanswerableLinkedInField(field, frontendDev())).toBeNull();
  });

  it('the healing fallback uses the same grounded set (not the first option, not "Yes")', () => {
    const fb = generateAutonomousFallbackAnswerWithSource(ownedGroup(), frontendDev(), 'Please make a selection', 3);
    expect(fb.answer.split(' | ')).toContain('Writing frontend tests');
    expect(fb.answer).not.toMatch(/^Only/);
  });
});

// ── 2. Gemini 429: no retry storm, a bounded pause, answers continue ─────────

describe('LinkedIn AI policy: Gemini 429 and timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a rate-limited request once, then pauses AI instead of retrying', async () => {
    const err = rateLimitError();
    const invoke = vi.fn().mockRejectedValue(err);
    const model = wrapLinkedInAiModel(mockModel(invoke).model);

    await expect(model.invoke('q1')).rejects.toBe(err);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(isLinkedInAiPaused()).toBe(true);
    expect(linkedInAiPauseRemainingMs()).toBe(30_000);

    // While paused: fails at once, no request sent.
    await expect(model.invoke('q2')).rejects.toBeInstanceOf(LinkedInAiPausedError);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(getLinkedInAiStats()).toEqual(
      expect.objectContaining({ calls: 1, rateLimited: 1, skippedWhilePaused: 1, succeeded: 0 }),
    );
  });

  it('lengthens the pause on repeated 429s (30s, 60s, 120s) and resets after a success', async () => {
    const invoke = vi.fn().mockRejectedValue(rateLimitError());
    const model = wrapLinkedInAiModel(mockModel(invoke).model);
    for (const expected of [30_000, 60_000, 120_000, 120_000]) {
      await expect(model.invoke('q')).rejects.toThrow();
      expect(linkedInAiPauseRemainingMs()).toBe(expected);
      vi.setSystemTime(Date.now() + expected + 1);
    }
    invoke.mockResolvedValueOnce({ content: 'ok' });
    await expect(model.invoke('q')).resolves.toEqual({ content: 'ok' });
    invoke.mockRejectedValueOnce(rateLimitError());
    await expect(model.invoke('q')).rejects.toThrow();
    expect(linkedInAiPauseRemainingMs()).toBe(30_000);
  });

  it('bounds every request with a timeout and does not retry a timed-out request', async () => {
    const timeout = Object.assign(new Error('Request timed out.'), { name: 'TimeoutError' });
    const invoke = vi.fn().mockRejectedValue(timeout);
    const model = wrapLinkedInAiModel(mockModel(invoke).model);
    await expect(model.invoke('q', { tags: ['x'] })).rejects.toBe(timeout);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      'q',
      expect.objectContaining({ tags: ['x'], timeout: LINKEDIN_AI_CALL_TIMEOUT_MS }),
    );
    expect(getLinkedInAiStats().timedOut).toBe(1);
    expect(isLinkedInAiPaused()).toBe(false);
  });

  it('wraps a model only once', () => {
    const { model } = mockModel();
    const once = wrapLinkedInAiModel(model);
    const inner = once.invoke;
    expect(wrapLinkedInAiModel(once).invoke).toBe(inner);
  });

  it('while paused, questions are answered from the resume and AI is not called', async () => {
    const rateLimited = wrapLinkedInAiModel(mockModel(vi.fn().mockRejectedValue(rateLimitError())).model);
    await expect(rateLimited.invoke('q')).rejects.toThrow();
    expect(isLinkedInAiPaused()).toBe(true);
    const { invoke, model: llm } = mockModel();

    const group = await solveLinkedInFieldAutonomously(ownedGroup(' (paused)'), frontendDev(), llm);
    expect(group.success).toBe(true);
    expect(group.reason).toMatch(/^Resume \/ Career Brain/);

    const text = await solveLinkedInFieldAutonomously(
      { label: 'Describe your most complex project', fieldType: 'text', required: true },
      frontendDev(),
      llm,
    );
    expect(text).toEqual(expect.objectContaining({ success: false }));
    expect(text.reason).toMatch(/AI paused/);

    const healed = await solveValidationErrorWithLLM(
      {
        label: 'Describe your most complex project',
        fieldType: 'text',
        errorText: 'Please enter a valid answer',
      },
      frontendDev(),
      llm,
    );
    expect(healed.success).toBe(false);

    const unsupported = await solveLinkedInCheckboxGroup(ownedGroup(' (paused-none)'), brain(), llm);
    expect(unsupported.reason).toMatch(/AI paused after a Gemini 429/);
    expect(invoke).not.toHaveBeenCalled();
  });
});

// ── 3. Submit: found on long review pages, one click, disabled never forced ──

describe('Page: LinkedIn Submit application', () => {
  beforeEach(() => {
    stubChrome();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const newPage = (puppeteerPage: Record<string, unknown>) => {
    const page = new Page(101, 'https://www.linkedin.com/jobs/view/4478976575/', 'LinkedIn');
    setPuppeteerPage(page, puppeteerPage);
    return page;
  };
  const topCard = { isAlreadyApplied: false, hasEasyApply: true } as unknown as JobTopCardContext;

  it('finds Submit after many "Edit" buttons on the review page', async () => {
    const page = newPage({ evaluate: vi.fn() });
    const edits = Array.from({ length: 10 }, (_, i) => `Edit section ${i + 1}`);
    vi.spyOn(page, 'captureModalSnapshot').mockResolvedValue({
      buttonTexts: ['Dismiss', ...edits].slice(0, 8),
      actionButtonTexts: ['Dismiss', ...edits, 'Back', 'Submit application'],
    } as unknown as ModalSnapshot);
    expect(await page.getModalActionButtons()).toEqual(expect.objectContaining({ hasSubmit: true }));
  });

  it('clicks the enabled Submit exactly once, with a trusted click', async () => {
    const handle = { click: vi.fn().mockResolvedValue(undefined), dispose: vi.fn().mockResolvedValue(undefined) };
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ clicked: false, marked: true, buttonText: 'Submit application' })
      .mockResolvedValue(undefined);
    const $ = vi.fn().mockResolvedValue(handle);
    const page = newPage({ evaluate, $ });
    const res = await page.submitApplication();
    expect(res).toEqual(
      expect.objectContaining({ clicked: true, method: 'trusted', buttonText: 'Submit application' }),
    );
    expect($).toHaveBeenCalledWith('pierce/[data-qoder-submit-target="1"]');
    expect(handle.click).toHaveBeenCalledTimes(1);
    // The in-page probe was asked to mark (not click) the button.
    expect(evaluate.mock.calls[0][1]).toBe(true);
    // No synthetic click on top of the trusted one: only the marker clean-up ran afterwards.
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('reports a disabled Submit with the reason and never clicks it', async () => {
    const handle = { click: vi.fn(), dispose: vi.fn() };
    const evaluate = vi.fn().mockResolvedValue({
      clicked: false,
      disabled: true,
      buttonText: 'Submit application',
      error: '"Submit application" is disabled - LinkedIn still considers a required answer missing',
    });
    const page = newPage({ evaluate, $: vi.fn().mockResolvedValue(handle) });
    const res = await page.submitApplication();
    expect(res.clicked).toBe(false);
    expect(res.disabled).toBe(true);
    expect(res.error).toMatch(/is disabled - LinkedIn still considers a required answer missing/);
    expect(handle.click).not.toHaveBeenCalled();
  });

  it('treats "Applied now" on the job card as a confirmed submission', async () => {
    vi.useFakeTimers();
    const page = newPage({ evaluate: vi.fn() });
    vi.spyOn(page, 'verifyApplicationConfirmation').mockResolvedValue({ confirmed: false });
    vi.spyOn(page, 'detectRecentAppliedStatus').mockResolvedValueOnce('').mockResolvedValue('Applied now');
    vi.spyOn(page, 'extractJobTopCardContext').mockResolvedValue(topCard);
    vi.spyOn(page, 'isEasyApplyModalOpen').mockResolvedValue(true);
    const pending = page.verifySubmissionConfirmation(20_000);
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await pending;
    expect(res.confirmed).toBe(true);
    expect(res.message).toMatch(/Applied now/);
  });

  it('gives up after its timeout (UNKNOWN for the caller) instead of waiting forever', async () => {
    vi.useFakeTimers();
    const page = newPage({ evaluate: vi.fn() });
    vi.spyOn(page, 'verifyApplicationConfirmation').mockResolvedValue({ confirmed: false });
    vi.spyOn(page, 'detectRecentAppliedStatus').mockResolvedValue('');
    vi.spyOn(page, 'extractJobTopCardContext').mockResolvedValue(topCard);
    vi.spyOn(page, 'isEasyApplyModalOpen').mockResolvedValue(true);
    let settled = false;
    const pending = page.verifySubmissionConfirmation(20_000).then(r => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await pending;
    expect(res.confirmed).toBe(false);
  });

  it('detectRecentAppliedStatus returns the in-page match', async () => {
    const page = newPage({ evaluate: vi.fn().mockResolvedValue('Applied 1 second ago') });
    expect(await page.detectRecentAppliedStatus()).toBe('Applied 1 second ago');
  });
});

// ── 4. Submission outcome: SUCCESS / FAILED / UNKNOWN, never a second click ──

describe('LinkedIn submitter: one click, three outcomes', () => {
  const formState = (over: Partial<Awaited<ReturnType<LinkedInSubmitPage['validateModalFormState']>>> = {}) => ({
    hasErrors: false,
    errors: [],
    emptyRequiredFields: [],
    ...over,
  });
  const fakePage = (over: Partial<Record<keyof LinkedInSubmitPage, Mock>> = {}) => ({
    submitApplication: vi.fn().mockResolvedValue({ clicked: true }),
    verifySubmissionConfirmation: vi
      .fn()
      .mockResolvedValue({ confirmed: true, message: 'LinkedIn shows "Applied now"' }),
    validateModalFormState: vi.fn().mockResolvedValue(formState()),
    ...over,
  });

  it('SUCCESS only when LinkedIn confirms', async () => {
    const page = fakePage();
    const submitter = createLinkedInSubmitter(page);
    expect(await submitter.submitOnce()).toEqual({ state: 'success', reason: 'LinkedIn shows "Applied now"' });
    expect(page.submitApplication).toHaveBeenCalledTimes(1);
    expect(page.verifySubmissionConfirmation).toHaveBeenCalledWith(20_000);
  });

  it('UNKNOWN when clicked but unconfirmed — and a second call never clicks again', async () => {
    const page = fakePage({ verifySubmissionConfirmation: vi.fn().mockResolvedValue({ confirmed: false }) });
    const onClicked = vi.fn();
    const submitter = createLinkedInSubmitter(page, { onClicked });
    const first = await submitter.submitOnce();
    expect(first.state).toBe('unknown');
    expect(submitter.clicked).toBe(true);
    expect(onClicked).toHaveBeenCalledTimes(1);
    // The dashboard shows it as "needs manual review", not as a plain failure or a success.
    expect(outcomeForFailure(first.reason)).toBe('NEEDS_MANUAL_REVIEW');

    const second = await submitter.submitOnce();
    expect(second.state).toBe('unknown');
    expect(page.submitApplication).toHaveBeenCalledTimes(1);
  });

  it('a late confirmation found on the second look is SUCCESS (still one click)', async () => {
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ confirmed: false })
      .mockResolvedValueOnce({ confirmed: true, message: 'confirmed late' });
    const page = fakePage({ verifySubmissionConfirmation: verify });
    const submitter = createLinkedInSubmitter(page);
    expect((await submitter.submitOnce()).state).toBe('unknown');
    expect(await submitter.submitOnce()).toEqual({ state: 'success', reason: 'confirmed late' });
    expect(page.submitApplication).toHaveBeenCalledTimes(1);
  });

  it('FAILED with the unanswered question when Submit is disabled (nothing clicked)', async () => {
    const page = fakePage({
      submitApplication: vi.fn().mockResolvedValue({
        clicked: false,
        disabled: true,
        error: '"Submit application" is disabled - LinkedIn still considers a required answer missing',
      }),
      validateModalFormState: vi
        .fn()
        .mockResolvedValue(formState({ hasErrors: true, emptyRequiredFields: [{ label: OWNED_QUESTION }] })),
    });
    const submitter = createLinkedInSubmitter(page);
    const res = await submitter.submitOnce();
    expect(res.state).toBe('failed');
    expect(res.reason).toContain(`(unanswered: ${OWNED_QUESTION})`);
    expect(submitter.clicked).toBe(false);
    expect(page.verifySubmissionConfirmation).not.toHaveBeenCalled();
    expect(outcomeForFailure(res.reason)).toBe('FAILED');
  });

  it('FAILED when LinkedIn answers the click with a validation error', async () => {
    const page = fakePage({
      verifySubmissionConfirmation: vi.fn().mockResolvedValue({ confirmed: false }),
      validateModalFormState: vi.fn().mockResolvedValue(
        formState({
          hasErrors: true,
          errors: [{ fieldLabel: 'Postal Code', errorText: 'Enter a valid postal code' }],
        }),
      ),
    });
    const res = await createLinkedInSubmitter(page).submitOnce();
    expect(res).toEqual({
      state: 'failed',
      reason: 'LinkedIn rejected the submission: "Postal Code" Enter a valid postal code',
    });
  });
});

// ── 5. "Application in progress" cannot run forever ─────────────────────────

describe('LinkedIn runner: whole-application time budget', () => {
  // The runner's private state and form loop, reached the way the runner itself calls them.
  type RunnerInternals = {
    isRunning: boolean;
    isStopping: boolean;
    enrichMissingCareerBrainFromPlatform: (page: unknown, careerBrain: ICareerBrain) => Promise<ICareerBrain>;
    fillAndSubmitModal: (
      page: unknown,
      job: { jobId: string; title: string; company: string; url: string },
      jobRunId: string,
    ) => Promise<{ success: boolean; reason?: string }>;
  };
  const runner = dedicatedJobRunner as unknown as RunnerInternals;

  beforeEach(() => {
    stubChrome();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T10:00:00Z'));
    vi.spyOn(careerBrainStore, 'getCareerBrain').mockResolvedValue(frontendDev());
    vi.spyOn(authStorage, 'getSession').mockResolvedValue(DEFAULT_AUTH_SESSION);
    vi.spyOn(runner, 'enrichMissingCareerBrainFromPlatform').mockImplementation(
      async (_page, careerBrain) => careerBrain,
    );
    runner.isRunning = true;
    runner.isStopping = false;
  });
  afterEach(() => {
    runner.isRunning = false;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  type RunnerInternalsWithChecks = RunnerInternals & {
    waitForManualCheckpointResolution: (...args: unknown[]) => Promise<{ solved: boolean; aborted?: boolean }>;
  };
  const job = {
    jobId: '4478976575',
    title: 'Frontend Developer',
    company: 'Acme',
    url: 'https://www.linkedin.com/jobs/view/4478976575/',
  };
  const snapshot = (inputs: number) => ({
    inputsCount: inputs,
    selectsCount: 0,
    contenteditableCount: 0,
    fieldsetsCount: 0,
    iframesCount: 0,
    spinnersCount: 0,
    shadowHosts: 0,
    shadowInputs: 0,
    hasFileInput: false,
    buttonTexts: ['Next'],
    actionButtonTexts: ['Next'],
  });
  // A step whose questions render after its footer: the runner re-scans it (next loop iteration).
  const slowStepPage = (over: Record<string, Mock> = {}) => ({
    resolveDraftSaveDialog: vi.fn().mockResolvedValue({ found: false }),
    detectSecurityCheckpoint: vi.fn().mockResolvedValue({ isCheckpoint: false }),
    verifyApplicationConfirmation: vi.fn().mockResolvedValue({ confirmed: false }),
    selectResumeInModal: vi.fn().mockResolvedValue({ selected: false }),
    scrollModalContent: vi.fn().mockResolvedValue(true),
    discoverModalFormFields: vi.fn().mockResolvedValue([]),
    validateModalFormState: vi.fn().mockResolvedValue({
      hasErrors: false,
      errors: [],
      emptyRequiredFields: [],
      invalidFieldsWithErrors: [],
      unfulfilledMandatoryFileUpload: null,
    }),
    captureModalSnapshot: vi.fn().mockResolvedValueOnce(snapshot(0)).mockResolvedValue(snapshot(1)),
    isEasyApplyModalOpen: vi.fn().mockResolvedValue(false),
    submitApplication: vi.fn(),
    ...over,
  });

  it('stops a form that is still not submitted after the budget, with a clear reason', async () => {
    const page = slowStepPage({
      // Each scan of the slow step "takes" two minutes.
      discoverModalFormFields: vi.fn().mockImplementation(async () => {
        vi.setSystemTime(Date.now() + 2 * 60 * 1000);
        return [];
      }),
    });
    const res = await runner.fillAndSubmitModal(page, job, 'run_budget_test');
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/^Application timed out after \d+ min on step 1 \(not submitted\)$/);
    expect(page.submitApplication).not.toHaveBeenCalled();
  }, 20_000);

  it('does not count time the candidate spends on a security check', async () => {
    const withChecks = runner as RunnerInternalsWithChecks;
    vi.spyOn(withChecks, 'waitForManualCheckpointResolution').mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 30 * 60 * 1000);
      return { solved: true, aborted: false };
    });
    const page = slowStepPage({
      detectSecurityCheckpoint: vi
        .fn()
        .mockResolvedValueOnce({ isCheckpoint: true })
        .mockResolvedValue({ isCheckpoint: false }),
      // Second step iteration: a leftover "Save this application?" prompt closes the form — a
      // quick, known exit that is only reached when the budget check let the step continue.
      resolveDraftSaveDialog: vi.fn().mockResolvedValueOnce({ found: false }).mockResolvedValue({ found: true }),
    });
    const res = await runner.fillAndSubmitModal(page, job, 'run_budget_manual');
    expect(res.reason).toMatch(/^Draft saved/);
    expect(res.reason).not.toMatch(/timed out/);
  }, 20_000);
});

// ── 6. Saved draft ("Continue") and form pacing ──────────────────────────────

describe('LinkedIn runner: resuming a saved draft via "Continue"', () => {
  type ResumeInternals = {
    isRunning: boolean;
    resumeSavedLinkedInApplication: (page: unknown, title: string, company: string) => Promise<boolean>;
  };
  const runner = dedicatedJobRunner as unknown as ResumeInternals;

  beforeEach(() => {
    stubChrome();
    runner.isRunning = true;
  });
  afterEach(() => {
    runner.isRunning = false;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const draftPage = (card: Partial<JobTopCardContext>, over: Record<string, Mock> = {}) => ({
    isEasyApplyModalOpen: vi.fn().mockResolvedValue(false),
    extractJobTopCardContext: vi.fn().mockResolvedValue({ hasEasyApply: true, isAlreadyApplied: false, ...card }),
    clickEasyApplyButton: vi.fn().mockResolvedValue({ success: true }),
    waitForEasyApplyModal: vi.fn().mockResolvedValue({ opened: true }),
    trustedClickEasyApplyButton: vi.fn().mockResolvedValue(true),
    ...over,
  });

  it('clicks "Continue" once and reports the form as open again', async () => {
    const page = draftPage({ hasSavedDraft: true });
    expect(await runner.resumeSavedLinkedInApplication(page, 'AWS Full Stack Engineer', 'Zorba AI')).toBe(true);
    expect(page.clickEasyApplyButton).toHaveBeenCalledTimes(1);
    expect(page.waitForEasyApplyModal).toHaveBeenCalledTimes(1);
  });

  it('escalates to a real click when the first click did not open the form', async () => {
    const page = draftPage(
      { hasSavedDraft: true },
      { waitForEasyApplyModal: vi.fn().mockResolvedValueOnce({ opened: false }).mockResolvedValue({ opened: true }) },
    );
    expect(await runner.resumeSavedLinkedInApplication(page, 'AWS Full Stack Engineer', 'Zorba AI')).toBe(true);
    expect(page.trustedClickEasyApplyButton).toHaveBeenCalledTimes(1);
  });

  it('never clicks without a saved draft, on an applied job, or while the form is still open', async () => {
    for (const page of [
      draftPage({ hasSavedDraft: false }),
      draftPage({ hasSavedDraft: true, isAlreadyApplied: true }),
      draftPage({ hasSavedDraft: true }, { isEasyApplyModalOpen: vi.fn().mockResolvedValue(true) }),
    ]) {
      expect(await runner.resumeSavedLinkedInApplication(page, 'AWS Full Stack Engineer', 'Zorba AI')).toBe(false);
      expect(page.clickEasyApplyButton).not.toHaveBeenCalled();
    }
  });
});

describe('LinkedIn runner: form pacing', () => {
  type PaceInternals = {
    interruptibleSleep: (ms: number) => Promise<boolean>;
    linkedInFormPause: (kind: 'afterAnswer' | 'beforeAdvance' | 'beforeSubmit') => Promise<void>;
  };
  const runner = dedicatedJobRunner as unknown as PaceInternals;
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['afterAnswer', 900, 1500],
    ['beforeAdvance', 900, 1600],
    ['beforeSubmit', 1500, 2500],
  ] as const)('%s waits between %d and %d ms (stop-aware sleep)', async (kind, min, max) => {
    const sleep = vi.spyOn(runner, 'interruptibleSleep').mockResolvedValue(false);
    for (let i = 0; i < 20; i++) await runner.linkedInFormPause(kind);
    const waits = sleep.mock.calls.map(c => c[0]);
    expect(waits).toHaveLength(20);
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(min);
    expect(Math.max(...waits)).toBeLessThanOrEqual(max);
  });
});

// ── 7. Live run (Preferred Square form): Country, City*, Skill Set, postal code ──

describe('LinkedIn resolver: address-step answers from the live Preferred Square form', () => {
  const AUTH_QUESTION = 'Are you legally authorized to work in India / your resident country?';
  const noidaDev = (extra: Partial<ICareerBrain> = {}) =>
    brain({
      currentLocation: 'Noida, Uttar Pradesh, India',
      skills: ['React', 'TypeScript', 'Node.js', 'AWS'],
      goldenAnswers: [{ id: 'auth', question: AUTH_QUESTION, answer: 'Yes' } as ICareerBrain['goldenAnswers'][number]],
      ...extra,
    });

  it('a one-word label is not matched to a saved Yes/No question that merely mentions it', () => {
    expect(matchesQuestionLoosely('Country', AUTH_QUESTION)).toBe(false);
    expect(matchesQuestionLoosely('Work', 'Are you willing to work from our Pune office?')).toBe(false);
    // The topic of the saved question still matches.
    expect(matchesQuestionLoosely('Notice period', 'What is your notice period?')).toBe(true);
    expect(matchesQuestionLoosely('LinkedIn', 'LinkedIn Profile URL')).toBe(true);
    expect(matchesQuestionLoosely('Expected CTC', 'What is your expected CTC in LPA?')).toBe(true);
    expect(matchesQuestionLoosely('Willing to relocate', 'Are you willing to relocate?')).toBe(true);
  });

  it('"Country*" is answered from the profile location, never with "Yes"', () => {
    const res = matchRuleBased({ label: 'Country*', fieldType: 'text', required: true }, noidaDev());
    expect(res).toEqual(expect.objectContaining({ matched: true, answer: 'India' }));
  });

  it('"City*" gets the city only, not the full location', () => {
    const res = matchRuleBased({ label: 'City*', fieldType: 'text', required: true }, noidaDev());
    expect(res.answer).toBe('Noida');
  });

  it('"Skill Set" is filled from the Career Brain skills', () => {
    const res = matchRuleBased({ label: 'Skill Set', fieldType: 'text' }, noidaDev());
    expect(res).toEqual(expect.objectContaining({ matched: true, answer: 'React, TypeScript, Node.js, AWS' }));
    const short = matchRuleBased(
      { label: 'Skills*', fieldType: 'text', maxLength: 18 } as FormFieldDescriptor,
      noidaDev(),
    );
    expect(short.answer).toBe('React, TypeScript');
  });

  it('a missing postal code is never invented, and the reason says how to add it', () => {
    const zip: FormFieldDescriptor = { label: 'Zip/Postal Code*', fieldType: 'text', required: true };
    expect(resolveLinkedInAddressField(zip, noidaDev())?.answer).toBe('');
    expect(explainUnanswerableLinkedInField(zip, noidaDev())).toMatch(
      /never invented\) - add it once in Career Brain settings > Golden Answers as "Postal Code"/,
    );
    // Once saved as a Golden Answer it is used.
    const saved = noidaDev({
      goldenAnswers: [
        { id: 'pin', question: 'Postal Code', answer: '201301' } as ICareerBrain['goldenAnswers'][number],
      ],
    });
    expect(resolveLinkedInAddressField(zip, saved)?.answer).toBe('201301');
    expect(explainUnanswerableLinkedInField(zip, saved)).toBeNull();
  });
});

// ── 8. Live run (Brevo): Yes / No consent question in "Additional Questions" ───

describe('LinkedIn resolver: Brevo future-contact consent (Yes / No radios)', () => {
  it('answers "Yes" once the options are read', () => {
    const field: FormFieldDescriptor = {
      label: 'I am allowing Brevo to contact me about future job opportunities for up to 2 years. Privacy Policy *',
      fieldType: 'radio',
      options: ['Yes', 'No'],
      required: true,
    };
    expect(matchRuleBased(field, frontendDev())).toEqual(expect.objectContaining({ matched: true, answer: 'Yes' }));
  });
});
