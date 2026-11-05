import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('webextension-polyfill', () => ({
  default: {
    tabs: { get: vi.fn(), query: vi.fn(), update: vi.fn(), reload: vi.fn() },
    runtime: { id: 'mock-ext-id' },
  },
}));

import { careerBrainStore, DEFAULT_CAREER_BRAIN, type ICareerBrain } from '@extension/storage';
import {
  classifyAddressField,
  extractPostalCode,
  findAddressInResumeText,
  resolveGroundedAddressAnswer,
} from '../linkedin/addressResolver';
import {
  matchRuleBased,
  generateAutonomousFallbackAnswerWithSource,
  solveLinkedInFieldAutonomously,
  solveValidationErrorWithLLM,
  resolveModalFieldWithAudit,
  rememberResolvedAnswer,
  isMultiChoiceCheckboxGroup,
  pickProfileGroundedOption,
  type FormFieldDescriptor,
} from '../linkedin/formQuestionResolver';
import Page from '../../browser/page';

const IT_SPECIALIZATION_OPTIONS = [
  'Information Systems Management & Information Technology Management',
  'Network Administration & Management',
  'Software Development, Engineering & Analysis',
  'Web & Application Development',
  'Data Analytics',
  'Information Technology Management',
];

const baseBrain: ICareerBrain = {
  ...DEFAULT_CAREER_BRAIN,
  fullName: 'Pawan Kumar',
  email: 'pawan@example.com',
  phoneNumber: '+91 98765 43210',
  currentTitle: 'Python Developer',
  currentLocation: 'Bengaluru, Karnataka, India',
  resumeText: '',
  goldenAnswers: [],
  customAnswers: {},
};

const brainWithResume = (resumeText: string, extra: Partial<ICareerBrain> = {}): ICareerBrain => ({
  ...baseBrain,
  resumeText,
  ...extra,
});

// ── 1. Address label classification ─────────────────────────────────────────

describe('LinkedIn address fields: label classification', () => {
  it.each([
    ['Street', 'street'],
    ['Street address', 'street'],
    ['Street address line 1', 'street'],
    ['Address Line 1', 'street'],
    ['Address line 2', 'addressLine2'],
    ['Postal Code', 'postalCode'],
    ['Postal code Postal code', 'postalCode'],
    ['ZIP / Postal Code', 'postalCode'],
    ['ZIP code*', 'postalCode'],
    ['Pin Code', 'postalCode'],
    ['Pincode (optional)', 'postalCode'],
    ['Home address', 'fullAddress'],
    ['Current Address', 'fullAddress'],
    ['Address', 'fullAddress'],
  ])('"%s" -> %s', (label, kind) => {
    expect(classifyAddressField({ label, fieldType: 'text' })).toBe(kind);
  });

  it.each(['Email address', 'City', 'IP address', 'Website address', 'What is your current location?'])(
    '"%s" is not an address field',
    label => {
      expect(classifyAddressField({ label, fieldType: 'text' })).toBeNull();
    },
  );

  it('ignores radio / checkbox / dropdown questions that mention an address', () => {
    expect(classifyAddressField({ label: 'Street', fieldType: 'radio' })).toBeNull();
    expect(classifyAddressField({ label: 'Postal Code', fieldType: 'dropdown' })).toBeNull();
  });
});

// ── 2. Extraction from the resume ───────────────────────────────────────────

describe('LinkedIn address fields: resume extraction', () => {
  it('splits an explicit Indian address line into street and PIN code', () => {
    const found = findAddressInResumeText(
      'Pawan Kumar\nPython Developer\nAddress: 221B, MG Road, Indiranagar, Bengaluru, Karnataka - 560038\nSkills: Python, Django',
    );
    expect(found?.street).toBe('221B, MG Road, Indiranagar');
    expect(found?.postalCode).toBe('560038');
  });

  it('handles a spaced PIN code and keeps the locality in the street', () => {
    const found = findAddressInResumeText(
      'Current Address: Flat 12B, Sunshine Apartments, Koramangala 5th Block, Bengaluru 560 095',
    );
    expect(found?.street).toBe('Flat 12B, Sunshine Apartments, Koramangala 5th Block');
    expect(found?.postalCode).toBe('560095');
  });

  it('prefers the current address over the permanent one', () => {
    const found = findAddressInResumeText(
      'Permanent Address: House 7, Civil Lines, Jaipur, Rajasthan 302006\nCurrent Address: Plot 12, Sector 62, Noida, Uttar Pradesh 201301',
    );
    expect(found?.street).toBe('Plot 12, Sector 62');
    expect(found?.postalCode).toBe('201301');
  });

  it('reads a resume-header address next to contact details', () => {
    const found = findAddressInResumeText(
      'John Doe\n123 Main St, Apt 4B, Austin, TX 78701, USA | +1 512 555 0101 | john@example.com\nSoftware Engineer',
    );
    expect(found?.street).toBe('123 Main St, Apt 4B');
    expect(found?.postalCode).toBe('78701');
  });

  it('returns nothing for a city-only address (never promotes the city to a street)', () => {
    expect(findAddressInResumeText('Address: Noida, UP\nPython Developer')).toBeNull();
    expect(findAddressInResumeText('Pawan Kumar | Bengaluru, India | pawan@example.com')).toBeNull();
  });

  it('does not mistake salaries, years or tool names for a postal code', () => {
    expect(findAddressInResumeText('Current CTC: 600000 | Expected CTC: 800000')).toBeNull();
    expect(findAddressInResumeText('B.Tech, Amity University, Noida 2019 - 2023')).toBeNull();
    expect(extractPostalCode('Tools: 7-Zip 2019, Git')).toBeNull();
  });

  it('accepts a labelled PIN code on its own', () => {
    const found = findAddressInResumeText('Personal details\nPincode: 560038\nNationality: Indian');
    expect(found?.postalCode).toBe('560038');
    expect(found?.street).toBeUndefined();
  });
});

// ── 3. Grounded answers (Career Brain answers first, then resume) ──────────

describe('LinkedIn address fields: grounded answers', () => {
  it('uses a saved Career Brain answer for exactly that component', () => {
    const brain = brainWithResume('Address: Plot 9, Sector 18, Noida 201301', {
      goldenAnswers: [{ id: 'g1', question: 'Street address', answer: '45 Residency Road' }],
    });
    const res = resolveGroundedAddressAnswer({ label: 'Street', fieldType: 'text' }, brain);
    expect(res?.answer).toBe('45 Residency Road');
    expect(res?.sourceDetail).toMatch(/Career Brain answer/);
  });

  it('derives street and postal code from a saved full-address answer', () => {
    const brain = brainWithResume('', {
      customAnswers: { 'Home address': '14, 2nd Cross, HSR Layout, Bengaluru, Karnataka 560102' },
    });
    expect(resolveGroundedAddressAnswer({ label: 'Street', fieldType: 'text' }, brain)?.answer).toBe(
      '14, 2nd Cross, HSR Layout',
    );
    expect(resolveGroundedAddressAnswer({ label: 'Postal Code', fieldType: 'text' }, brain)?.answer).toBe('560102');
  });

  it('formats a postal code for numeric inputs', () => {
    const brain = brainWithResume('Address: 221B, MG Road, Bengaluru 560 038');
    expect(resolveGroundedAddressAnswer({ label: 'Postal Code', fieldType: 'number' }, brain)?.answer).toBe('560038');
  });

  it('returns an empty answer when the candidate has no address on file', () => {
    const res = resolveGroundedAddressAnswer({ label: 'Street', fieldType: 'text' }, baseBrain);
    expect(res).toEqual(expect.objectContaining({ kind: 'street', answer: '' }));
  });
});

// ── 4. Resolver integration: never invent an address ───────────────────────

describe('LinkedIn resolver: street / postal code fields', () => {
  const street: FormFieldDescriptor = { label: 'Street', fieldType: 'text', required: true };
  const postal: FormFieldDescriptor = { label: 'Postal Code', fieldType: 'text', required: true };
  const resumeWithAddress = 'Pawan Kumar\nAddress: 221B, MG Road, Indiranagar, Bengaluru, Karnataka - 560038';

  it('rule-based match fills street and postal code from the resume', () => {
    const brain = brainWithResume(resumeWithAddress);
    expect(matchRuleBased(street, brain)).toEqual(
      expect.objectContaining({ matched: true, answer: '221B, MG Road, Indiranagar' }),
    );
    expect(matchRuleBased(postal, brain)).toEqual(expect.objectContaining({ matched: true, answer: '560038' }));
  });

  it('never puts the city into the street field', () => {
    expect(matchRuleBased(street, baseBrain).matched).toBe(false);
    // The city question itself keeps working.
    expect(matchRuleBased({ label: 'City', fieldType: 'text' }, baseBrain)).toEqual(
      expect.objectContaining({ matched: true, answer: 'Bengaluru' }),
    );
  });

  it('healing fallback never writes "Not applicable" into an address field', () => {
    const fb = generateAutonomousFallbackAnswerWithSource(street, baseBrain, 'This field is required', 3);
    expect(fb.answer).toBe('');
  });

  it('address fields never reach the LLM (autonomous solver and validation healer)', async () => {
    const llm: any = { invoke: vi.fn() };
    const solved = await solveLinkedInFieldAutonomously(postal, baseBrain, llm);
    const healed = await solveValidationErrorWithLLM(
      { ...postal, errorText: 'Enter a valid postal code' },
      baseBrain,
      llm,
    );
    expect(solved.success).toBe(false);
    expect(healed.success).toBe(false);
    expect(llm.invoke).not.toHaveBeenCalled();
  });

  it('resolveModalFieldWithAudit fills the grounded street and reports MATCHED', async () => {
    const page: any = { fillModalFieldDirect: vi.fn().mockResolvedValue(true) };
    const audit = vi.fn();
    const res = await resolveModalFieldWithAudit(
      page,
      { ...street },
      brainWithResume(resumeWithAddress),
      undefined,
      audit,
      {
        sessionId: `addr-ok-${Date.now()}`,
      },
    );
    expect(res.success).toBe(true);
    expect(page.fillModalFieldDirect).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Street' }),
      '221B, MG Road, Indiranagar',
    );
    expect(audit).toHaveBeenCalledWith('MATCHED', 'Street', '221B, MG Road, Indiranagar', expect.any(String));
  });

  it('resolveModalFieldWithAudit leaves a required address blank and reports FAILED without asking the LLM', async () => {
    const page: any = { fillModalFieldDirect: vi.fn().mockResolvedValue(true) };
    const llm: any = { invoke: vi.fn() };
    const audit = vi.fn();
    const res = await resolveModalFieldWithAudit(page, { ...street }, baseBrain, llm, audit, {
      sessionId: `addr-none-${Date.now()}`,
    });
    expect(res.success).toBe(false);
    expect(res.category).toBe('FAILED');
    expect(page.fillModalFieldDirect).not.toHaveBeenCalled();
    expect(llm.invoke).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith('FAILED', 'Street', '(left blank)', expect.stringMatching(/never guessed/));
  });

  it('an optional address field with no data is left blank quietly (not FAILED)', async () => {
    const page: any = { fillModalFieldDirect: vi.fn().mockResolvedValue(true) };
    const audit = vi.fn();
    const res = await resolveModalFieldWithAudit(page, { ...street, required: false }, baseBrain, undefined, audit, {
      sessionId: `addr-opt-${Date.now()}`,
    });
    expect(res.success).toBe(true);
    expect(page.fillModalFieldDirect).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith('MATCHED', 'Street', '(left blank)', expect.stringMatching(/optional/));
  });

  it('reports FAILED (not success) when the grounded value does not stick in the form', async () => {
    const page: any = { fillModalFieldDirect: vi.fn().mockResolvedValue(false) };
    const audit = vi.fn();
    const res = await resolveModalFieldWithAudit(
      page,
      { ...postal },
      brainWithResume(resumeWithAddress),
      undefined,
      audit,
      {
        sessionId: `addr-domfail-${Date.now()}`,
      },
    );
    expect(res.success).toBe(false);
    expect(audit).toHaveBeenCalledWith('FAILED', 'Postal Code', '560038', expect.stringMatching(/could not be set/));
  });

  it('does not memorise address answers as golden answers', async () => {
    const save = vi.spyOn(careerBrainStore, 'saveGoldenAnswer').mockResolvedValue(undefined as any);
    await rememberResolvedAnswer('Postal Code', '560038');
    expect(save).not.toHaveBeenCalled();
    save.mockRestore();
  });
});

// ── 5. Multi-choice checkbox questions ──────────────────────────────────────

describe('LinkedIn resolver: multi-choice checkbox questions', () => {
  const group: FormFieldDescriptor = {
    label: 'Current IT Specialization',
    fieldType: 'checkbox',
    options: IT_SPECIALIZATION_OPTIONS,
    required: true,
  };

  it('tells multi-choice groups apart from single consent checkboxes', () => {
    expect(isMultiChoiceCheckboxGroup(group)).toBe(true);
    expect(isMultiChoiceCheckboxGroup({ fieldType: 'checkbox', options: ['Yes', 'No'] })).toBe(false);
    expect(isMultiChoiceCheckboxGroup({ fieldType: 'radio', options: IT_SPECIALIZATION_OPTIONS })).toBe(false);
  });

  it('fallback picks only an option the profile clearly supports — never the first option by default', () => {
    const analyst = brainWithResume('Built Tableau dashboards and SQL reports.', {
      currentTitle: 'Data Analyst',
      skills: ['SQL', 'Data Analytics', 'Tableau'],
      workExperience: [],
    });
    expect(generateAutonomousFallbackAnswerWithSource(group, analyst).answer).toBe('Data Analytics');

    const noEvidence = brainWithResume('', { currentTitle: 'Chef', skills: ['Cooking'], workExperience: [] });
    expect(generateAutonomousFallbackAnswerWithSource(group, noEvidence).answer).toBe('');
    expect(pickProfileGroundedOption(IT_SPECIALIZATION_OPTIONS, noEvidence)).toBeNull();
  });

  it('an optional group is left untouched (no "No" sent to the form)', async () => {
    const page: any = { fillModalFieldDirect: vi.fn().mockResolvedValue(true) };
    const brain = brainWithResume('', { goldenAnswers: [], customAnswers: {} });
    const res = await resolveModalFieldWithAudit(page, { ...group, required: false }, brain, undefined, undefined, {
      sessionId: `cb-opt-${Date.now()}`,
    });
    expect(res.success).toBe(true);
    expect(page.fillModalFieldDirect).not.toHaveBeenCalledWith(expect.anything(), 'No');
  });
});

// ── 6. Page: interstitial prompt, covered button, checkbox escalation ───────

describe('Page: LinkedIn "Job search safety reminder" handling', () => {
  const interstitial = (controlFound = true) => ({
    modalFound: false,
    isIntermediate: true,
    intermediateAction: 'safety',
    needsTrustedClick: true,
    controlFound,
    controlDisabled: false,
    controlDesc: 'a "continue applying"',
    dialogTitle: 'Job search safety reminder',
    inputsCount: 0,
    buttonsCount: 0,
    hasClosedShadow: false,
  });
  const formOpen = { modalFound: true, inShadow: false, inputsCount: 3, buttonsCount: 2, hasClosedShadow: false };

  const makePage = (evaluate: any, handle: any) => {
    const page = new Page(101, 'https://www.linkedin.com/jobs/view/4478976575/', 'LinkedIn');
    (page as any)._puppeteerPage = { evaluate, $: vi.fn().mockResolvedValue(handle), click: vi.fn() };
    return page;
  };

  beforeEach(() => {
    (globalThis as any).chrome = { runtime: { id: 'mock-ext-id' }, tabs: { get: vi.fn() } };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clicks "Continue applying" once with a trusted click and reports the form as opened', async () => {
    vi.useFakeTimers();
    const handle = { click: vi.fn().mockResolvedValue(undefined), dispose: vi.fn().mockResolvedValue(undefined) };
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(interstitial())
      .mockResolvedValueOnce(interstitial())
      .mockResolvedValue(formOpen);
    const page = makePage(evaluate, handle);
    const pending = page.waitForEasyApplyModal(3500, 250);
    await vi.advanceTimersByTimeAsync(5000);
    const res = await pending;
    expect(res.opened).toBe(true);
    expect(res.interstitial).toEqual({ title: 'Job search safety reminder', clicks: 1, stillOpen: false });
    expect(handle.click).toHaveBeenCalledTimes(1);
    expect((page as any)._puppeteerPage.$).toHaveBeenCalledWith('pierce/[data-qoder-intermediate-target="1"]');
  });

  it('does not spend a click attempt when the control re-rendered before it could be clicked', async () => {
    vi.useFakeTimers();
    let clicked = false;
    const handle = {
      click: vi.fn(async () => {
        clicked = true;
      }),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    // 1st lookup: the marked control is gone (re-rendered) and the synthetic fallback finds nothing.
    const $ = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(handle);
    const evaluate = vi.fn(async (fn: unknown) =>
      typeof fn === 'function' && (fn as (...a: unknown[]) => unknown).length === 1
        ? false
        : clicked
          ? formOpen
          : interstitial(),
    );
    const page = new Page(101, 'https://www.linkedin.com/jobs/view/4478976575/', 'LinkedIn');
    (page as any)._puppeteerPage = { evaluate, $, click: vi.fn() };
    const pending = page.waitForEasyApplyModal(3500, 250);
    await vi.advanceTimersByTimeAsync(5000);
    const res = await pending;
    expect(res.opened).toBe(true);
    expect(res.interstitial?.clicks).toBe(1);
    expect(handle.click).toHaveBeenCalledTimes(1);
  });

  it('re-clicks only after a cooldown, at most 3 times, and reports the prompt as still open', async () => {
    vi.useFakeTimers();
    const handle = { click: vi.fn().mockResolvedValue(undefined), dispose: vi.fn().mockResolvedValue(undefined) };
    const evaluate = vi.fn().mockImplementation(async (fn: unknown) =>
      // Trusted clicks use `$`; any synthetic fallback evaluate (string arg) reports success.
      typeof fn === 'function' && (fn as any).length === 1 ? true : interstitial(),
    );
    const page = makePage(evaluate, handle);
    const pending = page.waitForEasyApplyModal(3500, 250);
    await vi.advanceTimersByTimeAsync(60000);
    const res = await pending;
    expect(res.opened).toBe(false);
    expect(res.interstitial?.stillOpen).toBe(true);
    expect(res.interstitial?.clicks).toBe(3);
    expect(res.error).toMatch(/stayed open after 3 "Continue applying" click/);
    // Attempts 1-2 are trusted clicks; the 3rd falls back to a synthetic click.
    expect(handle.click).toHaveBeenCalledTimes(2);
  });

  it('never clicks anything else when the "Continue applying" control is missing', async () => {
    vi.useFakeTimers();
    const handle = { click: vi.fn(), dispose: vi.fn() };
    const page = makePage(vi.fn().mockResolvedValue(interstitial(false)), handle);
    const pending = page.waitForEasyApplyModal(3500, 250);
    await vi.advanceTimersByTimeAsync(30000);
    const res = await pending;
    expect(res.opened).toBe(false);
    expect(res.error).toMatch(/button was not found/);
    expect(handle.click).not.toHaveBeenCalled();
  });

  it('does not "real-click" the Easy Apply button through a covering prompt', async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ present: true, coveredBy: 'dialog "Job search safety reminder"' })
      .mockResolvedValue(undefined);
    const page = makePage(evaluate, null);
    expect(await page.trustedClickEasyApplyButton()).toBe(false);
    expect((page as any)._puppeteerPage.click).not.toHaveBeenCalled();
  });
});

describe('Page: checkbox trusted-click escalation', () => {
  beforeEach(() => {
    (globalThis as any).chrome = { runtime: { id: 'mock-ext-id' }, tabs: { get: vi.fn() } };
  });

  const makePage = (evaluate: any, handles: any[]) => {
    const page = new Page(101, 'https://www.linkedin.com/jobs/view/1/', 'LinkedIn');
    (page as any)._puppeteerPage = { evaluate, $$: vi.fn().mockResolvedValue(handles), click: vi.fn() };
    return page;
  };

  it('clicks a box that ignored the synthetic click and reports success only after verifying it', async () => {
    const handle = {
      evaluate: vi.fn().mockResolvedValue(true), // still in the wrong state
      click: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, targetFound: true, isCheckboxOption: true }) // in-page attempt
      .mockResolvedValueOnce({ allOk: true, usedSetter: 0, total: 1 }) // verification
      .mockResolvedValue(undefined); // marker cleanup
    const page = makePage(evaluate, [handle]);
    const ok = await page.fillModalFieldDirect({ label: 'Current IT Specialization' }, 'Data Analytics');
    expect(ok).toBe(true);
    expect(handle.click).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0][3]).toEqual({ allowTrustedEscalation: true });
  });

  it('does not toggle a box that already reached the requested state', async () => {
    const handle = {
      evaluate: vi.fn().mockResolvedValue(false), // already correct
      click: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, targetFound: true, isCheckboxOption: true })
      .mockResolvedValueOnce({ allOk: true, usedSetter: 0, total: 1 })
      .mockResolvedValue(undefined);
    const page = makePage(evaluate, [handle]);
    expect(await page.fillModalFieldDirect({ label: 'Terms' }, 'Yes')).toBe(true);
    expect(handle.click).not.toHaveBeenCalled();
  });

  it('reports failure when the box is still unchecked after every attempt', async () => {
    const handle = {
      evaluate: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, targetFound: true, isCheckboxOption: true })
      .mockResolvedValueOnce({ allOk: false, usedSetter: 1, total: 1 })
      .mockResolvedValue(undefined);
    const page = makePage(evaluate, [handle]);
    expect(await page.fillModalFieldDirect({ label: 'Current IT Specialization' }, 'Data Analytics')).toBe(false);
  });
});

describe('Page: fill diagnostics', () => {
  beforeEach(() => {
    (globalThis as any).chrome = { runtime: { id: 'mock-ext-id' }, tabs: { get: vi.fn() } };
  });

  it('scrolls and looks again for a field that is not rendered yet, then records why it failed', async () => {
    const notFound = {
      ok: false,
      targetFound: false,
      isTextField: false,
      typeaheadUnresolved: false,
      isButtonOption: false,
      reason: 'field not found in the form (it may not be rendered yet)',
    };
    const evaluate = vi.fn().mockResolvedValue(notFound);
    const page = new Page(101, 'https://www.linkedin.com/jobs/view/1/', 'LinkedIn');
    (page as any)._puppeteerPage = { evaluate, $$: vi.fn().mockResolvedValue([]), click: vi.fn() };
    const scroll = vi.spyOn(page, 'scrollModalContent').mockResolvedValue(true);
    expect(await page.fillModalFieldDirect({ label: 'Experience in Years' }, '2')).toBe(false);
    expect(scroll).toHaveBeenCalledWith('bottom');
    expect(scroll).toHaveBeenCalledWith('top');
    expect(page.lastFillDiagnostics).toEqual(
      expect.objectContaining({ label: 'Experience in Years', ok: false, targetFound: false, reason: notFound.reason }),
    );
  });

  it('does not scroll-retry when the question was found but no option matched', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      ok: false,
      targetFound: false,
      reason: 'no option matches "Ten years" for "React?" (options: Less than 1 year | 1 to 2 years)',
    });
    const page = new Page(101, 'https://www.linkedin.com/jobs/view/1/', 'LinkedIn');
    (page as any)._puppeteerPage = { evaluate, $$: vi.fn().mockResolvedValue([]), click: vi.fn() };
    const scroll = vi.spyOn(page, 'scrollModalContent').mockResolvedValue(true);
    expect(await page.fillModalFieldDirect({ label: 'React?' }, 'Ten years')).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
    expect(page.lastFillDiagnostics?.reason).toMatch(/options: Less than 1 year \| 1 to 2 years/);
  });

  it('the resolver reports the page reason in its FAILED audit entry', async () => {
    const page: any = {
      fillModalFieldDirect: vi.fn().mockResolvedValue(false),
      lastFillDiagnostics: { reason: 'form shows "" instead of "560038"' },
    };
    const audit = vi.fn();
    const brain = brainWithResume('Address: 221B, MG Road, Indiranagar, Bengaluru, Karnataka - 560038');
    await resolveModalFieldWithAudit(
      page,
      { label: 'Postal Code', fieldType: 'text', required: true },
      brain,
      undefined,
      audit,
      {
        sessionId: `diag-${Date.now()}`,
      },
    );
    expect(audit).toHaveBeenCalledWith(
      'FAILED',
      'Postal Code',
      '560038',
      expect.stringContaining('form shows "" instead of "560038"'),
    );
  });
});

describe('LinkedIn resolver: AI answers are reused, not re-asked', () => {
  it('asks the AI once per question within a run', async () => {
    const llm: any = {
      invoke: vi.fn().mockResolvedValue({
        content: '{"answer":"2 to 3 years","confidence":"HIGH","reason":"React work since 2022 in the resume"}',
      }),
    };
    const field: FormFieldDescriptor = {
      label: `How many years of React production experience do you have? (${Date.now()})`,
      fieldType: 'radio',
      options: ['Less than 1 year', '1 to 2 years', '2 to 3 years', 'More than 3 years'],
    };
    const first = await solveLinkedInFieldAutonomously(field, baseBrain, llm);
    const second = await solveLinkedInFieldAutonomously({ ...field }, baseBrain, llm);
    expect(first).toEqual(expect.objectContaining({ success: true, answer: '2 to 3 years' }));
    expect(second).toEqual(expect.objectContaining({ success: true, answer: '2 to 3 years' }));
    expect(second.reason).toMatch(/reused/);
    expect(llm.invoke).toHaveBeenCalledTimes(1);

    // Different options are a different question.
    await solveLinkedInFieldAutonomously({ ...field, options: ['0-1 years', '2 to 3 years'] }, baseBrain, llm);
    expect(llm.invoke).toHaveBeenCalledTimes(2);
  });
});
