/**
 * LinkedIn Easy Apply — ApplicationEngine
 *
 * Deterministic State Machine Engine orchestrating LinkedIn Easy Apply Automation.
 *
 * Core Principles:
 * - Deterministic DOM execution using fail-safe selectors from selectors.ts.
 * - Fail-Fast Trigger Phase: Detects external apply indicators and skips non-Easy Apply jobs.
 * - Standard Screen Automation: Bypasses AI completely on Contact Info, Resume, and Review steps,
 *   injecting Career Brain profile data directly via synthetic events.
 * - Complex Questions Automation: Selectively triggers Bedrock AI / Career Brain Q&A solver only
 *   when custom screening questions are encountered.
 * - Forward Progression & Submission: Deterministic navigation loop hitting Next, Review, and Submit,
 *   with error watching and clean dismiss handling.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createLogger } from '@src/background/log';
import type BrowserContext from '@src/background/browser/context';
import type Page from '@src/background/browser/page';
import { careerBrainStore, type ICareerBrain } from '@extension/storage';
import { getCareerBrainData } from '@extension/storage/lib/profile/careerBrain';
import {
  LINKEDIN_APPLY_SELECTORS,
  LINKEDIN_MODAL_SELECTORS,
  LINKEDIN_INPUT_SELECTORS,
  LINKEDIN_ACTION_BUTTONS,
} from './selectors';
import {
  solveQuestions,
  solveScreeningQuestion,
  solveFormQuestionsWithBedrock,
  type QuestionSolution,
  type AIFormResponse,
} from './questionSolver';
import { validateLinkedInSession, type LinkedInSessionStatus } from './sessionValidator';
import { LinkedInHealthChecker, type HealthCheckResult } from './healthCheck';
import { DryRunLogger, dryRunLogger, type IDryRunRecord, type IDryRunStats } from './dryRunLogger';
import type { LinkedInStepDetector } from './stepDetector';
import { stepDetector } from './stepDetector';
import type { LinkedInStepNavigator } from './stepNavigator';
import { stepNavigator } from './stepNavigator';
import { evaluateJobFit, sanitizeJobDescription, MIN_FIT_SCORE_THRESHOLD } from './fitScorer';
import type { LinkedInFormFiller } from './formFiller';
import { formFiller } from './formFiller';
import type { LinkedInVisionFallback } from './visionFallback';
import { visionFallback } from './visionFallback';
import { HumanPacingSimulator } from './humanPacing';
import { DailyQuotaManager } from './rateLimiter';
import { ResumeApprovalGate } from './resumeApproval';
import { backendApiClient } from '@extension/shared';
import type {
  IJobData,
  IApplicationState,
  IScreeningQuestion,
  IFitScoreResult,
  IStepDetectionResult,
  IStepTransitionResult,
  JobApplicationStatus,
} from './types';

const logger = createLogger('LinkedInApplicationEngine');

/** Configuration options for the ApplicationEngine */
export interface ApplicationEngineConfig {
  /** Whether to actually submit the application or just dry-run (Default: true) */
  dryRun: boolean;
  /** Maximum number of retries for stale element recovery */
  maxRetries: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseRetryDelayMs: number;
  /** Minimum fit score to proceed with auto-apply (0-100, default: 75) */
  minFitScore: number;
  /** Maximum token limit for job description sent to LLM */
  maxDescriptionTokens: number;
  /** Human-like delay range in ms between actions [min, max] */
  actionDelayRange: [number, number];
  /** Max modal steps before safety timeout */
  maxModalSteps: number;
  /** Whether to generate and require tailored resume approval */
  requireTailoredResume: boolean;
}

export const DEFAULT_ENGINE_CONFIG: ApplicationEngineConfig = {
  dryRun: true, // Default ON for safety
  maxRetries: 3,
  baseRetryDelayMs: 1000,
  minFitScore: MIN_FIT_SCORE_THRESHOLD, // 75
  maxDescriptionTokens: 1000,
  actionDelayRange: [800, 2500],
  maxModalSteps: 15,
  requireTailoredResume: false,
};

/**
 * ApplicationEngine orchestrates the LinkedIn Easy Apply flow as a Deterministic State Machine.
 */
export class ApplicationEngine {
  private maxSteps = 15; // Fallback to prevent infinite loops
  private config: ApplicationEngineConfig;
  private state: IApplicationState | null = null;
  private page: Page | null = null;
  private context: BrowserContext | null = null;
  private llm?: BaseChatModel;
  private visionLLM?: BaseChatModel;
  private healthChecker: LinkedInHealthChecker;
  private loggerService: DryRunLogger;
  private stepDetectorService: LinkedInStepDetector;
  private stepNavigatorService: LinkedInStepNavigator;
  private formFillerService: LinkedInFormFiller;
  private visionFallbackService: LinkedInVisionFallback;

  constructor(
    contextOrConfig?: BrowserContext | Partial<ApplicationEngineConfig> | any,
    optionsOrConfig?: Partial<ApplicationEngineConfig> | { llm?: BaseChatModel; visionLLM?: BaseChatModel },
  ) {
    if (contextOrConfig && typeof contextOrConfig.getCurrentPage === 'function') {
      this.context = contextOrConfig as BrowserContext;
      this.config = { ...DEFAULT_ENGINE_CONFIG, ...(optionsOrConfig as Partial<ApplicationEngineConfig>) };
    } else {
      this.config = { ...DEFAULT_ENGINE_CONFIG, ...(contextOrConfig as Partial<ApplicationEngineConfig>) };
      const opts = optionsOrConfig as { llm?: BaseChatModel; visionLLM?: BaseChatModel };
      this.llm = opts?.llm;
      this.visionLLM = opts?.visionLLM || opts?.llm;
    }
    this.healthChecker = new LinkedInHealthChecker(this.config.maxRetries, this.config.baseRetryDelayMs);
    this.loggerService = dryRunLogger;
    this.stepDetectorService = stepDetector;
    this.stepNavigatorService = stepNavigator;
    this.formFillerService = formFiller;
    this.visionFallbackService = visionFallback;
  }

  /**
   * Sets or updates LLM models for scoring and vision.
   */
  setModels(models: { llm?: BaseChatModel; visionLLM?: BaseChatModel }): void {
    if (models.llm) this.llm = models.llm;
    if (models.visionLLM) this.visionLLM = models.visionLLM;
  }

  /**
   * Updates configuration (e.g. toggling Live Mode vs Dry Run).
   */
  updateConfig(config: Partial<ApplicationEngineConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info(`[ApplicationEngine] Config updated. Live Mode: ${!this.config.dryRun}`);
  }

  /**
   * Sets or updates the active BrowserContext.
   */
  setBrowserContext(context: BrowserContext): void {
    this.context = context;
  }

  /**
   * Sets or updates the active Page instance.
   */
  setPage(page: Page): void {
    this.page = page;
  }

  /**
   * Resolves the current active page.
   */
  private async getPage(): Promise<Page | null> {
    if (this.page) return this.page;
    if (this.context) {
      this.page = await this.context.getCurrentPage();
      return this.page;
    }
    return null;
  }

  /**
   * Constructs the targeted LinkedIn Job Search URL with exact predefined filters.
   */
  static buildJobSearchUrl(criteria?: { roles?: string[]; location?: string }): string {
    const defaultRoles = [
      'Frontend Developer',
      'React Developer',
      'MERN Stack Developer',
      'Full Stack Developer',
      'AI Evaluator',
    ];
    const roles = criteria?.roles && criteria.roles.length > 0 ? criteria.roles : defaultRoles;
    const keywords = roles.map(r => `"${r}"`).join(' OR ');
    const location = criteria?.location || 'Bengaluru, India';

    const params = new URLSearchParams({
      keywords,
      location,
      f_AL: 'true', // Easy Apply filter
      f_E: '1,2', // 1=Internship, 2=Entry level
      f_JT: 'F,I', // Full-time, Internship
      sortBy: 'R', // Most relevant
    });

    return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
  }

  private progressCallback: ((msg: string, isErr?: boolean) => void) | null = null;

  public setProgressCallback(cb: (msg: string, isErr?: boolean) => void): void {
    this.progressCallback = cb;
  }

  private notifyProgress(msg: string, isErr = false): void {
    logger.info(`[ApplicationEngine] ${msg}`);
    if (this.progressCallback) {
      try {
        this.progressCallback(msg, isErr);
      } catch {}
    }
  }

  /**
   * Initialize the engine with a browser page context.
   */
  async initialize(page?: Page): Promise<void> {
    logger.info('Initializing ApplicationEngine (Dry-Run:', this.config.dryRun, ')...');

    if (page) {
      this.page = page;
    }

    // 1. Validate session cookies (warn gracefully without throwing to prevent blocking active users)
    try {
      const cookieStatus: LinkedInSessionStatus = await validateLinkedInSession();
      if (!cookieStatus.isValid) {
        logger.warning('Session cookie check warning (continuing):', cookieStatus.message);
      }
    } catch (err) {
      logger.warning('Could not read LinkedIn cookies:', err);
    }

    // 2. Perform DOM health check if page context is provided
    if (this.page) {
      try {
        const healthStatus: HealthCheckResult = await this.healthChecker.runPreFlightCheck(this.page);
        if (!healthStatus.isLoggedIn) {
          logger.warning('Pre-flight health check warning (continuing):', healthStatus.message);
        }
      } catch (err) {
        logger.warning('Pre-flight health check encountered error:', err);
      }
    }

    logger.info('ApplicationEngine initialized successfully.');
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // ─── DETERMINISTIC STATE MACHINE ENTRY POINTS ───────────────────────────────
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * Main Entry Point for a Job URL
   */
  async processJob(): Promise<'SUBMITTED' | 'SKIPPED' | 'FAILED'> {
    try {
      const started = await this.triggerEasyApply();
      if (!started) return 'SKIPPED'; // It was an external job or already applied

      const success = await this.runModalLoop();
      return success ? 'SUBMITTED' : 'FAILED';
    } catch (error) {
      logger.error('[ApplicationEngine] Fatal error during application:', error);
      return 'FAILED';
    }
  }

  /**
   * STEP 1: Safely trigger the Easy Apply button with robust SPA polling
   */
  private async triggerEasyApply(): Promise<boolean> {
    const page = await this.getPage();
    if (!page) {
      logger.error('[ApplicationEngine] No active page available to trigger Easy Apply.');
      return false;
    }

    // Polling loop: Wait up to 8 seconds (16 attempts * 500ms) for SPA to hydrate
    const maxAttempts = 16;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // 1. Check if Easy Apply modal is ALREADY open
      const isAlreadyOpen = await page.evaluate(() => {
        const modal = document.querySelector(
          'div[role="dialog"][aria-modal="true"], div[data-test-modal], .jobs-easy-apply-modal',
        );
        return Boolean(modal);
      });

      if (isAlreadyOpen) {
        logger.info('[ApplicationEngine] Easy Apply modal is already open and ready.');
        return true;
      }

      // 2. Search for and click Easy Apply button in the live DOM
      const clicked = await page.evaluate((selectors: string[]) => {
        const clickButton = (btn: HTMLElement) => {
          btn.scrollIntoView({ behavior: 'instant', block: 'center' });
          btn.focus();
          const mouseOpts = { bubbles: true, cancelable: true, view: window };
          btn.dispatchEvent(new PointerEvent('pointerdown', mouseOpts));
          btn.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
          btn.dispatchEvent(new PointerEvent('pointerup', mouseOpts));
          btn.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
          btn.click();
        };

        // Direct selector candidates
        for (const sel of selectors) {
          const btn = document.querySelector(sel) as HTMLElement | null;
          if (btn && btn.offsetParent !== null && !btn.hasAttribute('disabled')) {
            clickButton(btn);
            return true;
          }
        }

        // Semantic search within buttons and links
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>(
            'button, [role="button"], a.jobs-apply-button, span.artdeco-button__text, .jobs-apply-button',
          ),
        );

        for (const el of candidates) {
          if (el.offsetParent === null) continue;
          const text = (el.innerText || el.textContent || '').trim().toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          if (
            (text === 'easy apply' ||
              text.includes('easy apply') ||
              aria.includes('easy apply') ||
              text.includes('continue with easy apply')) &&
            !text.includes('filter') &&
            !aria.includes('filter')
          ) {
            const target = (el.closest('button, [role="button"], a') as HTMLElement) || el;
            clickButton(target);
            return true;
          }
        }

        return false;
      }, LINKEDIN_APPLY_SELECTORS.easyApplyButtons);

      if (clicked) {
        logger.info(`[ApplicationEngine] Easy Apply button clicked on attempt ${attempt}. Waiting for modal...`);
        // Wait for modal to render in DOM (up to 5s)
        for (let m = 0; m < 10; m++) {
          await new Promise(r => setTimeout(r, 500));
          const hasModal = await page.evaluate(() => {
            const modal = document.querySelector(
              'div[role="dialog"][aria-modal="true"], div[data-test-modal], .jobs-easy-apply-modal',
            );
            return Boolean(modal);
          });
          if (hasModal) {
            logger.info('[ApplicationEngine] Easy Apply modal detected successfully.');
            return true;
          }
        }
      }

      await new Promise(r => setTimeout(r, 500));
    }

    // Fallback: Check if job is confirmed external apply
    const isExplicitExternal = await page.evaluate((indicators: string[]) => {
      for (const sel of indicators) {
        const el = document.querySelector(sel);
        if (el && (el as HTMLElement).offsetParent !== null) return true;
      }
      return false;
    }, LINKEDIN_APPLY_SELECTORS.externalApplyIndicators);

    if (isExplicitExternal) {
      logger.warning('[ApplicationEngine] Confirmed external application job. Skipping.');
      return false;
    }

    logger.warning('[ApplicationEngine] Could not open Easy Apply modal after polling.');
    return false;
  }

  /**
   * STEP 2: The Deterministic State Machine Loop
   */
  private async runModalLoop(): Promise<boolean> {
    const careerBrain = await getCareerBrainData();
    const page = await this.getPage();
    if (!page) return false;

    let stepCount = 0;

    while (stepCount < this.maxSteps) {
      stepCount++;

      // Check if already in success state
      const isInitialSuccess = await this.checkSuccessState(page);
      if (isInitialSuccess) {
        logger.info('[ApplicationEngine] Application already in submitted success state.');
        return true;
      }

      // 1. Detect current screen header
      const headerText = await this.detectCurrentScreen(page);
      if (!headerText) {
        const isSuccess = await this.checkSuccessState(page);
        if (isSuccess) return true;
      }

      logger.info(`[ApplicationEngine] Step ${stepCount} - Screen: "${headerText || 'Form Step'}"`);

      // 2. Deterministic Form Injection on every step (Contact, Address, Resume, Work Auth, Radios)
      await this.injectDeterministicData(page, careerBrain);

      // 3. Complex Questions: Trigger Bedrock AI / Career Brain Q&A solver for custom screening questions
      if (!this.isStandardScreen(headerText || '')) {
        await this.solveWithAI(page, careerBrain);
      }

      // Allow UI to register injected events
      await new Promise(r => setTimeout(r, 800));

      // In Dry-Run mode, if we reached the final submit button, record and exit safely
      if (this.config.dryRun) {
        const isFinalSubmitScreen = await page.evaluate((submitSelectors: string[]) => {
          for (const sel of submitSelectors) {
            const btn = document.querySelector(sel) as HTMLElement | null;
            if (btn && btn.offsetParent !== null && !btn.hasAttribute('disabled')) {
              const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
              const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
              if (
                text.includes('submit application') ||
                text === 'submit' ||
                aria.includes('submit application') ||
                aria.includes('submit') ||
                btn.getAttribute('data-control-name') === 'submit_unify'
              ) {
                return true;
              }
            }
          }
          return false;
        }, LINKEDIN_ACTION_BUTTONS.submit);

        if (isFinalSubmitScreen) {
          logger.info('[ApplicationEngine] [Dry-Run] Reached final Submit button. Simulating success safely.');
          await this.logDryRunRecord({
            jobData: {
              url: page.url() || '',
              jobId: 'dry_run_job',
              title: headerText || 'LinkedIn Job',
              company: 'Company',
              location: '',
              salaryRange: '',
              description: '',
              jobType: 'Full-time',
              experienceLevel: 'Entry level',
              isEasyApply: true,
            },
            wouldHaveApplied: true,
            fitScore: 85,
            notes: 'Reached final submit screen in dry-run mode.',
          });
          await this.dismissModal();
          return true;
        }
      }

      // 4. Progress to next step (Next, Review, or Submit)
      const progressed = await this.clickNextOrSubmit(page);
      if (!progressed) {
        const isDone = await this.checkSuccessState(page);
        if (isDone) return true;

        logger.error('[ApplicationEngine] Stuck on current screen. Aborting to prevent infinite loop.');
        return false;
      }

      // Allow UI to settle
      await new Promise(r => setTimeout(r, 1500));
    }

    return false; // Hit max steps without success
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // ─── HELPER METHODS ─────────────────────────────────────────────────────────
  // ═════════════════════════════════════════════════════════════════════════════

  private async detectCurrentScreen(page: Page): Promise<string | null> {
    return page.evaluate((selectors: string[]) => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent) return el.textContent.trim().toLowerCase();
      }
      return null;
    }, LINKEDIN_MODAL_SELECTORS.headerText);
  }

  private isStandardScreen(header: string): boolean {
    const standardHeaders = [
      'contact info',
      'contact information',
      'resume',
      'review',
      'home address',
      'email address',
      'phone number',
    ];
    return standardHeaders.some(h => header.includes(h));
  }

  private async injectDeterministicData(page: Page, data: ICareerBrain): Promise<void> {
    logger.info('[ApplicationEngine] Injecting deterministic Career Brain data...');
    const candidatePayload = {
      fullName: data.fullName || '',
      firstName: (data.fullName || '').trim().split(/\s+/)[0] || '',
      lastName: (data.fullName || '').trim().split(/\s+/).slice(1).join(' ') || '',
      email: data.email || '',
      phoneNumber: data.phoneNumber || '',
      currentTitle: data.currentTitle || '',
      yearsOfExperience: data.yearsOfExperience || 0,
      noticePeriod: data.noticePeriod || 'Immediate',
      workAuthorization: data.workAuthorization || 'Citizen of India / Authorized to work without sponsorship',
      salaryExpectation: data.salaryExpectation || 'Competitive',
      preferredLocation: data.preferredLocation || 'Bengaluru, India',
      portfolioUrl: data.portfolioUrl || '',
      githubUrl: data.githubUrl || '',
      linkedinUrl: data.linkedinUrl || '',
      goldenAnswers: (data.goldenAnswers || []).map(ga => ({ question: ga.question, answer: ga.answer })),
    };

    await page.evaluate((candidateData: typeof candidatePayload) => {
      const modal = document.querySelector(
        'div[role="dialog"][aria-modal="true"], div[data-test-modal], .jobs-easy-apply-modal',
      );
      if (!modal) return;

      // Native React-compatible input setter
      const setReactValue = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
        if (!value && value !== '0') return;
        input.focus();
        input.dispatchEvent(new Event('focus', { bubbles: true }));

        const proto =
          input instanceof HTMLTextAreaElement
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

        if (setter) {
          setter.call(input, value);
        } else {
          input.value = value;
        }

        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
      };

      // Native React-compatible select setter
      const setReactSelect = (select: HTMLSelectElement, matchText: string) => {
        if (!matchText) return;
        const lower = matchText.toLowerCase();
        for (let i = 0; i < select.options.length; i++) {
          const opt = select.options[i];
          const optText = (opt.text || opt.value || '').toLowerCase();
          if (optText.includes(lower) || lower.includes(optText)) {
            select.selectedIndex = i;
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }
      };

      // React-compatible radio clicker
      const clickReactRadio = (radio: HTMLInputElement) => {
        radio.scrollIntoView({ behavior: 'instant', block: 'center' });
        const mouseOpts = { bubbles: true, cancelable: true, view: window };
        radio.dispatchEvent(new PointerEvent('pointerdown', mouseOpts));
        radio.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
        radio.dispatchEvent(new PointerEvent('pointerup', mouseOpts));
        radio.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
        radio.click();
        radio.checked = true;
        radio.dispatchEvent(new Event('input', { bubbles: true }));
        radio.dispatchEvent(new Event('change', { bubbles: true }));

        // Also click associated label or container if available
        const label = modal.querySelector(`label[for="${radio.id}"]`) || radio.closest('label');
        if (label && label !== (radio as unknown as Element)) {
          label.dispatchEvent(new MouseEvent('click', mouseOpts));
        }
      };

      // 1. Phone number
      const phoneInputs = Array.from(
        modal.querySelectorAll<HTMLInputElement>(
          'input[type="tel"], input[id*="phone" i], input[name*="phone" i], input[autocomplete="tel"]',
        ),
      );
      for (const input of phoneInputs) {
        if (!input.value || input.value.trim() === '') {
          setReactValue(input, candidateData.phoneNumber);
        }
      }

      // 2. Email
      const emailInputs = Array.from(
        modal.querySelectorAll<HTMLInputElement>(
          'input[type="email"], input[id*="email" i], input[name*="email" i], input[autocomplete="email"]',
        ),
      );
      for (const input of emailInputs) {
        if (!input.value || input.value.trim() === '') {
          setReactValue(input, candidateData.email);
        }
      }

      // 3. First Name & Last Name
      const firstNameInputs = Array.from(
        modal.querySelectorAll<HTMLInputElement>(
          'input[id*="firstName" i], input[name*="firstName" i], input[autocomplete="given-name"]',
        ),
      );
      for (const input of firstNameInputs) {
        if (!input.value || input.value.trim() === '') {
          setReactValue(input, candidateData.firstName);
        }
      }

      const lastNameInputs = Array.from(
        modal.querySelectorAll<HTMLInputElement>(
          'input[id*="lastName" i], input[name*="lastName" i], input[autocomplete="family-name"]',
        ),
      );
      for (const input of lastNameInputs) {
        if (!input.value || input.value.trim() === '') {
          setReactValue(input, candidateData.lastName);
        }
      }

      // 4. City / Location
      const locationInputs = Array.from(
        modal.querySelectorAll<HTMLInputElement>(
          'input[id*="city" i], input[id*="location" i], input[name*="city" i], input[name*="location" i]',
        ),
      );
      for (const input of locationInputs) {
        if (!input.value || input.value.trim() === '') {
          setReactValue(input, candidateData.preferredLocation);
        }
      }

      // 5. Numeric Experience Inputs
      const numberInputs = Array.from(modal.querySelectorAll<HTMLInputElement>('input[type="number"]'));
      for (const input of numberInputs) {
        if (!input.value || input.value.trim() === '') {
          const expYears = candidateData.yearsOfExperience > 0 ? candidateData.yearsOfExperience : 3;
          setReactValue(input, expYears.toString());
        }
      }

      // 6. Work Authorization & Yes/No Radio Groups
      const fieldsets = Array.from(modal.querySelectorAll<HTMLElement>('fieldset, div[role="radiogroup"]'));
      for (const fs of fieldsets) {
        const legend = fs.querySelector('legend, [role="heading"], label');
        const questionText = (legend?.textContent || '').trim().toLowerCase();
        const radios = Array.from(fs.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
        if (radios.length === 0) continue;

        // Check if already answered
        if (radios.some(r => r.checked)) continue;

        let targetChoice = '';

        // Match Golden Q&A overrides first
        for (const ga of candidateData.goldenAnswers) {
          if (questionText.includes(ga.question.toLowerCase())) {
            targetChoice = ga.answer.toLowerCase();
            break;
          }
        }

        // Deterministic Heuristic Rules
        if (!targetChoice) {
          if (
            questionText.includes('authorized') ||
            questionText.includes('legally') ||
            questionText.includes('permit') ||
            questionText.includes('right to work')
          ) {
            targetChoice = 'yes';
          } else if (
            questionText.includes('sponsorship') ||
            questionText.includes('visa') ||
            questionText.includes('require sponsor')
          ) {
            targetChoice = 'no';
          } else if (
            questionText.includes('18 years') ||
            questionText.includes('age') ||
            questionText.includes('high school') ||
            questionText.includes('degree') ||
            questionText.includes('commute') ||
            questionText.includes('relocate') ||
            questionText.includes('background check')
          ) {
            targetChoice = 'yes';
          }
        }

        if (targetChoice) {
          for (const radio of radios) {
            const label = modal.querySelector(`label[for="${radio.id}"]`) || radio.closest('label');
            const labelText = (label?.textContent || radio.value || '').trim().toLowerCase();
            if (labelText === targetChoice || labelText.includes(targetChoice)) {
              clickReactRadio(radio);
              break;
            }
          }
        }
      }

      // 7. Native Dropdowns (Country code, Yes/No, Notice period)
      const selects = Array.from(modal.querySelectorAll<HTMLSelectElement>('select:not([disabled])'));
      for (const sel of selects) {
        const label = modal.querySelector(`label[for="${sel.id}"]`) || sel.closest('label');
        const selText = (label?.textContent || sel.name || '').toLowerCase();

        // Phone country code
        if (selText.includes('country') || selText.includes('code') || sel.name.includes('country')) {
          setReactSelect(sel, 'India');
          if (sel.selectedIndex <= 0) setReactSelect(sel, '+91');
        } else if (selText.includes('authorized') || selText.includes('permit')) {
          setReactSelect(sel, 'Yes');
        } else if (selText.includes('sponsorship') || selText.includes('visa')) {
          setReactSelect(sel, 'No');
        } else if (selText.includes('notice')) {
          setReactSelect(sel, 'Immediate');
        }
      }

      // 8. Resume Selection (Pre-uploaded resumes on LinkedIn)
      const resumeRadios = Array.from(modal.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
      let resumeSelected = false;

      for (const radio of resumeRadios) {
        const cardText = (radio.closest('div, label, li')?.textContent || '').toLowerCase();
        if (
          cardText.includes('.pdf') ||
          cardText.includes('.doc') ||
          cardText.includes('resume') ||
          radio.name.toLowerCase().includes('resume')
        ) {
          clickReactRadio(radio);
          resumeSelected = true;
          break;
        }
      }

      // Fallback: If on resume screen and no radio is checked yet, select first radio
      if (!resumeSelected && resumeRadios.length > 0 && !resumeRadios.some(r => r.checked)) {
        const firstRadio = resumeRadios[0];
        clickReactRadio(firstRadio);
      }
    }, candidatePayload);
  }

  private async solveWithAI(page: Page, data: ICareerBrain): Promise<void> {
    logger.info('[ApplicationEngine] Custom questions detected. Triggering Bedrock / Career Brain solver...');

    // 1. Scrape labels and inputs from current modal using LINKEDIN_INPUT_SELECTORS
    const extracted = await page.evaluate(() => {
      const modal = document.querySelector(
        'div[role="dialog"][aria-modal="true"], div[data-test-modal], .jobs-easy-apply-modal',
      );
      if (!modal) return { questions: [], formattedString: '' };

      const questions: Array<{
        questionId: string;
        questionText: string;
        questionType: 'text' | 'textarea' | 'dropdown' | 'single_select' | 'boolean';
        required: boolean;
        options: string[];
      }> = [];

      // 1. Discover text, number, and textarea inputs
      const textInputs = Array.from(
        modal.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          'input[type="text"], input[type="number"], input:not([type]), textarea',
        ),
      );
      for (const input of textInputs) {
        if (input.offsetParent === null) continue;
        const label = modal.querySelector(`label[for="${input.id}"]`) || input.closest('label');
        const questionText = (label?.textContent || input.placeholder || input.name || '').trim();
        const fieldId = input.id || input.name || `input_${questions.length}`;
        if (questionText) {
          questions.push({
            questionId: fieldId,
            questionText,
            questionType: input instanceof HTMLTextAreaElement ? 'textarea' : 'text',
            required: input.required || input.getAttribute('aria-required') === 'true',
            options: [],
          });
        }
      }

      // 2. Discover native select dropdowns
      const selectElements = Array.from(modal.querySelectorAll<HTMLSelectElement>('select:not([disabled])'));
      for (const select of selectElements) {
        if (select.offsetParent === null) continue;
        const label = modal.querySelector(`label[for="${select.id}"]`) || select.closest('label');
        const questionText = (label?.textContent || select.name || '').trim();
        const fieldId = select.id || select.name || `select_${questions.length}`;
        const options = Array.from(select.options)
          .map(o => (o.text || o.value || '').trim())
          .filter(t => t && !t.toLowerCase().includes('select an option'));

        if (questionText) {
          questions.push({
            questionId: fieldId,
            questionText,
            questionType: 'dropdown',
            required: select.required || select.getAttribute('aria-required') === 'true',
            options,
          });
        }
      }

      // 3. Discover radio button fieldsets
      const fieldsets = Array.from(modal.querySelectorAll<HTMLFieldSetElement>('fieldset'));
      for (const fs of fieldsets) {
        if (fs.offsetParent === null) continue;
        const legend = fs.querySelector('legend');
        const questionText = (legend?.textContent || '').trim();
        const radios = Array.from(fs.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
        const fieldId = fs.id || `fs_${questions.length}`;
        if (questionText && radios.length > 0) {
          const options = radios.map(r => {
            const lbl = fs.querySelector(`label[for="${r.id}"]`) || r.closest('label');
            return (lbl?.textContent || '').trim();
          });
          questions.push({
            questionId: fieldId,
            questionText,
            questionType:
              options.length === 2 && options.some(o => o.toLowerCase() === 'yes') ? 'boolean' : 'single_select',
            required: true,
            options,
          });
        }
      }

      // Format clean LLM string
      const formattedString = questions
        .map(q => {
          let line = `FieldId: ${q.questionId} | Type: ${q.questionType} | Question: ${q.questionText}`;
          if (q.options.length > 0) {
            line += ` | Options: [${q.options.join(', ')}]`;
          }
          return line;
        })
        .join('\n');

      return { questions, formattedString };
    });

    if (extracted.questions.length === 0) {
      logger.info('[ApplicationEngine] No unanswered screening questions detected on this step.');
      return;
    }

    logger.info(`[ApplicationEngine] Extracted ${extracted.questions.length} form questions for Bedrock solving.`);

    // 2. Format Golden Q&A overrides
    const goldenAnswersText = (data.goldenAnswers || []).map(ga => `Q: ${ga.question}\nA: ${ga.answer}`).join('\n\n');

    let answersToInject: Array<{ fieldId: string; answer: string }> = [];

    if (this.llm) {
      const bedrockResult = await solveFormQuestionsWithBedrock(
        this.llm,
        data.resumeText,
        goldenAnswersText,
        extracted.formattedString,
      );

      if (bedrockResult && Array.isArray(bedrockResult.answers)) {
        // Safety Net Check: If an unanswerable question is required, flag and handle escape hatch
        const unanswerableRequired = bedrockResult.answers.find(
          (a: AIFormResponse['answers'][number]) => !a.is_answerable,
        );
        if (unanswerableRequired) {
          logger.warning(
            `[ApplicationEngine] 🛑 Unanswerable question detected for field "${unanswerableRequired.fieldId}": ${unanswerableRequired.confidence_reasoning}.`,
          );
        }

        answersToInject = bedrockResult.answers
          .filter((a: AIFormResponse['answers'][number]) => a.is_answerable && Boolean(a.answer))
          .map((a: AIFormResponse['answers'][number]) => ({ fieldId: a.fieldId, answer: a.answer }));
      }
    }

    // Fallback: If Bedrock response was empty or LLM absent, use standard questionSolver
    if (answersToInject.length === 0) {
      const standardSolutions = await solveQuestions(
        extracted.questions.map((q: IScreeningQuestion) => ({
          ...q,
          userAnswer: null,
        })),
        data,
        this.llm,
      );

      answersToInject = standardSolutions
        .filter(s => s.isConfident && Boolean(s.answer))
        .map(s => ({ fieldId: s.questionId, answer: s.answer }));
    }

    // 3. Synthetic React event injection into DOM
    await page.evaluate((answers: Array<{ fieldId: string; answer: string }>) => {
      const modal = document.querySelector(
        'div[role="dialog"][aria-modal="true"], div[data-test-modal], .jobs-easy-apply-modal',
      );
      if (!modal) return;

      const setReactValue = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
        input.focus();
        input.dispatchEvent(new Event('focus', { bubbles: true }));
        const proto =
          input instanceof HTMLTextAreaElement
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) {
          setter.call(input, value);
        } else {
          input.value = value;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
      };

      for (const item of answers) {
        if (!item.answer) continue;

        // 1. Try finding input or select by ID
        const el = modal.querySelector<HTMLElement>(`#${item.fieldId}`);
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          setReactValue(el, item.answer);
          continue;
        }

        if (el instanceof HTMLSelectElement) {
          for (let i = 0; i < el.options.length; i++) {
            if (
              el.options[i].text.toLowerCase().includes(item.answer.toLowerCase()) ||
              el.options[i].value.toLowerCase().includes(item.answer.toLowerCase())
            ) {
              el.selectedIndex = i;
              el.dispatchEvent(new Event('change', { bubbles: true }));
              break;
            }
          }
          continue;
        }

        // 2. Try radio buttons
        const radios = Array.from(modal.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
        for (const radio of radios) {
          const label = modal.querySelector(`label[for="${radio.id}"]`) || radio.closest('label');
          const labelText = (label?.textContent || '').trim().toLowerCase();
          if (labelText === item.answer.toLowerCase() || labelText.includes(item.answer.toLowerCase())) {
            radio.click();
            radio.checked = true;
            radio.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          }
        }
      }
    }, answersToInject);
  }

  private async clickNextOrSubmit(page: Page): Promise<boolean> {
    return page.evaluate((actionButtons: { submit: string[]; nextOrReview: string[] }) => {
      const clickEl = (btn: HTMLElement) => {
        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
        btn.focus();
        const mouseOpts = { bubbles: true, cancelable: true, view: window };
        btn.dispatchEvent(new PointerEvent('pointerdown', mouseOpts));
        btn.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
        btn.dispatchEvent(new PointerEvent('pointerup', mouseOpts));
        btn.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
        btn.click();
      };

      // 1. Prioritize Submit button with explicit submit text/aria
      for (const sel of actionButtons.submit) {
        const btn = document.querySelector(sel) as HTMLElement | null;
        if (
          btn &&
          btn.offsetParent !== null &&
          !btn.hasAttribute('disabled') &&
          btn.getAttribute('aria-disabled') !== 'true'
        ) {
          const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
          const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (
            text.includes('submit') ||
            aria.includes('submit') ||
            btn.getAttribute('data-control-name') === 'submit_unify'
          ) {
            clickEl(btn);
            return true;
          }
        }
      }

      // 2. Next / Review buttons
      for (const sel of actionButtons.nextOrReview) {
        const btn = document.querySelector(sel) as HTMLElement | null;
        if (
          btn &&
          btn.offsetParent !== null &&
          !btn.hasAttribute('disabled') &&
          btn.getAttribute('aria-disabled') !== 'true'
        ) {
          clickEl(btn);
          return true;
        }
      }

      // 3. Fallback: Any primary button in modal footer
      const footerBtns = Array.from(
        document.querySelectorAll<HTMLElement>(
          'div[role="dialog"] footer button, .jobs-easy-apply-modal footer button',
        ),
      );
      for (const btn of footerBtns) {
        if (
          btn.offsetParent !== null &&
          !btn.hasAttribute('disabled') &&
          btn.getAttribute('aria-disabled') !== 'true'
        ) {
          const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
          if (
            text.includes('next') ||
            text.includes('review') ||
            text.includes('continue') ||
            text.includes('submit')
          ) {
            clickEl(btn);
            return true;
          }
        }
      }

      return false;
    }, LINKEDIN_ACTION_BUTTONS);
  }

  private async checkSuccessState(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const modal = document.querySelector('div[role="dialog"]');
      if (!modal) {
        // Modal closed or not present
        return false;
      }
      const text = (modal.textContent || '').toLowerCase();
      const isSuccess =
        text.includes('your application was sent') ||
        text.includes('application submitted') ||
        text.includes('application sent') ||
        text.includes('your application has been sent');

      if (isSuccess) {
        const dismissBtn = modal.querySelector<HTMLElement>(
          'button[aria-label*="dismiss" i], button.artdeco-modal__dismiss, button[data-test-modal-close-btn]',
        );
        if (dismissBtn) dismissBtn.click();
        return true;
      }
      return false;
    });
  }

  /**
   * Safely dismisses the modal and confirms discard if prompted.
   */
  async dismissModal(): Promise<void> {
    const page = await this.getPage();
    if (!page) return;

    await page.evaluate((selectors: { dismiss: string[]; discardConfirm: string[] }) => {
      for (const sel of selectors.dismiss) {
        const btn = document.querySelector(sel) as HTMLElement | null;
        if (btn && btn.offsetParent !== null) {
          btn.click();
          break;
        }
      }

      // Wait brief moment and confirm discard if LinkedIn prompts
      setTimeout(() => {
        for (const sel of selectors.discardConfirm) {
          const confirmBtn = document.querySelector(sel) as HTMLElement | null;
          if (confirmBtn && confirmBtn.offsetParent !== null) {
            confirmBtn.click();
            break;
          }
        }
      }, 500);
    }, LINKEDIN_ACTION_BUTTONS);
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // ─── COMPATIBILITY LAYER FOR QUEUE MANAGER & BUILDER.TS ─────────────────────
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * Evaluates how well the user's profile matches the job listing.
   */
  async evaluateFitScore(jobData: IJobData): Promise<IFitScoreResult> {
    const careerBrain = await careerBrainStore.getCareerBrain();
    return evaluateJobFit(jobData, careerBrain, this.llm);
  }

  /**
   * Scan the current LinkedIn job listing page and extract structured job data.
   */
  async scanJobListing(): Promise<IJobData> {
    const page = await this.getPage();
    if (!page) throw new Error('Page not attached.');

    // Wait up to 2.5 seconds for LinkedIn SPA hydration
    await new Promise(r => setTimeout(r, 2500));

    const deadCheck = await page.detectDeadJobOrErrorPage();
    if (deadCheck.isDeadJob) {
      logger.warning(`[ApplicationEngine] Dead job or removed posting detected: ${deadCheck.reason}`);
      const url = page.url() || '';
      const jobId = Math.abs(url.split('').reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0)).toString(16);
      return {
        url,
        jobId,
        title: 'Removed or Unavailable Job',
        company: 'LinkedIn',
        location: '',
        salaryRange: '',
        description: `Job removed or unavailable: ${deadCheck.reason}`,
        jobType: 'Full-time',
        experienceLevel: 'Mid-Senior level',
        isEasyApply: false,
      };
    }

    const rawJob = await page.evaluate((easySelectors: string[]) => {
      const titleSelectors = [
        '.job-details-jobs-unified-top-card__job-title',
        'h1.t-24',
        'h1.job-title',
        'h1.topcard__title',
        '.jobs-unified-top-card__job-title',
        'div.job-view-layout h1',
        'main h1',
        'h1',
      ];
      let title = '';
      for (const sel of titleSelectors) {
        const el = document.querySelector(sel);
        const text = el?.textContent?.trim();
        if (text && text.length > 1) {
          title = text;
          break;
        }
      }

      const companySelectors = [
        '.job-details-jobs-unified-top-card__company-name',
        '.job-details-jobs-unified-top-card__primary-description a',
        '.jobs-unified-top-card__company-name',
        'a.topcard__org-name-link',
        '.job-card-container__company-name',
        'a[data-tracking-control-name="public_jobs_topcard-org-name"]',
        'div.job-details-jobs-unified-top-card__company-name a',
      ];
      let company = '';
      for (const sel of companySelectors) {
        const el = document.querySelector(sel);
        const text = el?.textContent?.trim();
        if (text && text.length > 0) {
          company = text;
          break;
        }
      }

      const descEl = document.querySelector(
        '#job-details, .jobs-description__content, .jobs-box__html-content, article.jobs-description__container',
      );
      const description = descEl ? descEl.innerHTML || descEl.textContent || '' : '';

      // Check Easy Apply selectors first
      let hasEasyApply = false;
      for (const sel of easySelectors) {
        const btn = document.querySelector(sel);
        if (btn && (btn as HTMLElement).offsetParent !== null) {
          hasEasyApply = true;
          break;
        }
      }

      if (!hasEasyApply) {
        hasEasyApply = Array.from(document.querySelectorAll('button, [role="button"], a.jobs-apply-button')).some(
          el => {
            const text = (el.textContent || '').trim().toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            return (
              (text.includes('easy apply') || aria.includes('easy apply')) &&
              !text.includes('filter') &&
              !aria.includes('filter')
            );
          },
        );
      }

      return { title, company, description, isEasyApply: hasEasyApply };
    }, LINKEDIN_APPLY_SELECTORS.easyApplyButtons);

    const url = page.url() || '';
    const jobIdMatch = url.match(/\/jobs\/view\/(\d+)/);
    const jobId = jobIdMatch ? jobIdMatch[1] : 'default';

    return {
      url,
      jobId,
      title: rawJob.title || 'Unknown Position',
      company: rawJob.company || 'Unknown Company',
      location: 'Bengaluru, India',
      salaryRange: '',
      description: rawJob.description,
      jobType: 'Full-time',
      experienceLevel: 'Entry level',
      isEasyApply: rawJob.isEasyApply ?? true,
    };
  }

  /**
   * Complete Easy Apply execution pipeline for QueueManager / Builder compatibility.
   */
  async startApplication(jobData: IJobData): Promise<IApplicationState> {
    const page = await this.getPage();
    if (!page) {
      throw new Error('ApplicationEngine: Page context is required to start application.');
    }

    logger.info(
      `Starting Easy Apply flow for job: "${jobData.title}" at "${jobData.company}" (Live Mode: ${!this.config.dryRun})`,
    );

    this.state = {
      jobData,
      status: 'QUEUED',
      currentStep: 0,
      totalSteps: 1,
      screeningQuestions: [],
      errors: [],
      startedAt: Date.now(),
      completedAt: null,
    };

    // 0. Pre-Flight Dead / Removed Job Check
    const deadCheck = await page.detectDeadJobOrErrorPage();
    if (deadCheck.isDeadJob || jobData.title === 'Removed or Unavailable Job') {
      const msg = `Job "${jobData.title}" is no longer available on LinkedIn.`;
      logger.warning(`[ApplicationEngine] ${msg}`);
      this.state.status = 'SKIPPED_JOB_REMOVED';
      this.state.errors.push(msg);
      this.state.completedAt = Date.now();
      return this.state;
    }

    // 0b. Note: Live DOM Easy Apply verification is deferred to triggerEasyApply()
    // to prevent SPA hydration race conditions from aborting prematurely.

    // 1. Duplicate Check
    const isDuplicate = await backendApiClient.checkDuplicateJob(jobData.jobId);
    if (isDuplicate) {
      const msg = `Job "${jobData.title}" was already applied in database. Skipping.`;
      logger.info(`[ApplicationEngine] ${msg}`);
      this.state.status = 'APPLIED';
      this.state.errors.push(msg);
      this.state.completedAt = Date.now();
      return this.state;
    }

    // 2. Daily Quota Check
    const quotaCheck = await DailyQuotaManager.canApplyToday();
    if (!quotaCheck.allowed) {
      const msg = `Daily application quota reached (${quotaCheck.currentCount} today). Resuming tomorrow.`;
      logger.warning(`[ApplicationEngine] ${msg}`);
      this.state.status = 'QUEUED';
      this.state.errors.push(msg);
      this.state.completedAt = Date.now();
      return this.state;
    }

    // 3. RAG Fit Score Check (Only enforce if minFitScore is explicitly configured > 0)
    let fitScoreValue = 85;
    if (this.config.minFitScore > 0) {
      const fitResult = await this.evaluateFitScore(jobData);
      fitScoreValue = fitResult.score;
      if (fitResult.score < this.config.minFitScore) {
        const skipReason = `Skipped low fit (${fitResult.score} < ${this.config.minFitScore}): ${fitResult.reasoning}`;
        logger.warning(`[ApplicationEngine] ${skipReason}`);
        this.notifyProgress(`⏩ ${skipReason}`);
        this.state.status = 'SKIPPED_LOW_FIT';
        this.state.errors.push(skipReason);
        this.state.completedAt = Date.now();
        return this.state;
      }
    }

    // 4. Deterministic State Machine Execution
    const result = await this.processJob();

    if (result === 'SUBMITTED') {
      this.state.status = this.config.dryRun ? 'DRY_RUN_SUCCESS' : 'APPLIED';
      this.state.completedAt = Date.now();
      if (!this.config.dryRun) {
        await DailyQuotaManager.incrementAppliedCount();
        await backendApiClient.recordJobApplication({
          jobId: jobData.jobId,
          jobTitle: jobData.title,
          company: jobData.company,
          platform: 'linkedin',
          applicationUrl: jobData.url,
          location: jobData.location,
          salaryRange: jobData.salaryRange,
          fitScore: fitScoreValue,
          status: 'APPLIED',
        });
      }
    } else if (result === 'SKIPPED') {
      this.state.status = 'SKIPPED_EXTERNAL_SITE';
      this.state.completedAt = Date.now();
    } else {
      this.state.status = 'NEEDS_MANUAL_REVIEW';
      this.state.errors.push('State machine stopped or required manual review.');
      this.state.completedAt = Date.now();
    }

    return this.state;
  }

  /**
   * Logs a dry-run / simulated application record.
   */
  async logDryRunRecord(params: {
    jobData: IJobData;
    wouldHaveApplied: boolean;
    fitScore?: number;
    screeningAnswers?: IScreeningQuestion[];
    blockedReason?: string;
    notes?: string;
  }): Promise<IDryRunRecord> {
    return this.loggerService.logDryRun(params);
  }

  /**
   * Gets dry run statistics.
   */
  async getDryRunStats(): Promise<IDryRunStats> {
    return this.loggerService.getDryRunStats();
  }
}

export default ApplicationEngine;
