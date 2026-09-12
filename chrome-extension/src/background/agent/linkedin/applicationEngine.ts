/**
 * LinkedIn Easy Apply — ApplicationEngine
 *
 * Core Engine orchestrating LinkedIn Easy Apply Automation.
 *
 * Technical considerations:
 * - Session validation via chrome.cookies (li_at, JSESSIONID).
 * - Pre-flight health check for profile icon (div.global-nav__me) before execution.
 * - RAG-based Fit Scoring with JD sanitization (skips jobs with score < 75).
 * - Career Brain screening question solver & React-compatible form filling.
 * - Multi-step modal navigation with ARIA-first parsing and transition verification.
 * - Vision Fallback: Strictly triggered only when DOM confidence < 0.4 or UNKNOWN step.
 * - 'Unknown State' fallback: Never guess; sets NEEDS_MANUAL_REVIEW if step is unrecognised.
 * - Dry-Run mode logging framework (default ON) for recording 'would have applied' actions.
 * - React re-render resiliency via retryWithBackoff (3 retries, exponential backoff).
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createLogger } from '@src/background/log';
import type Page from '@src/background/browser/page';
import { careerBrainStore, type ICareerBrain } from '@extension/storage';
import { validateLinkedInSession, type LinkedInSessionStatus } from './sessionValidator';
import { LinkedInHealthChecker, type HealthCheckResult } from './healthCheck';
import { dryRunLogger, DryRunLogger, type IDryRunRecord, type IDryRunStats } from './dryRunLogger';
import { stepDetector, LinkedInStepDetector } from './stepDetector';
import { stepNavigator, LinkedInStepNavigator } from './stepNavigator';
import { evaluateJobFit, sanitizeJobDescription, MIN_FIT_SCORE_THRESHOLD } from './fitScorer';
import { formFiller, LinkedInFormFiller } from './formFiller';
import { visionFallback, LinkedInVisionFallback } from './visionFallback';
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
}

export const DEFAULT_ENGINE_CONFIG: ApplicationEngineConfig = {
  dryRun: true, // Default ON for safety
  maxRetries: 3,
  baseRetryDelayMs: 1000,
  minFitScore: MIN_FIT_SCORE_THRESHOLD, // 75
  maxDescriptionTokens: 1000,
  actionDelayRange: [800, 2500],
  maxModalSteps: 10,
};

/**
 * ApplicationEngine orchestrates the LinkedIn Easy Apply flow.
 */
export class ApplicationEngine {
  private config: ApplicationEngineConfig;
  private state: IApplicationState | null;
  private page: Page | null = null;
  private llm?: BaseChatModel;
  private visionLLM?: BaseChatModel;
  private healthChecker: LinkedInHealthChecker;
  private loggerService: DryRunLogger;
  private stepDetectorService: LinkedInStepDetector;
  private stepNavigatorService: LinkedInStepNavigator;
  private formFillerService: LinkedInFormFiller;
  private visionFallbackService: LinkedInVisionFallback;

  constructor(
    config: Partial<ApplicationEngineConfig> = {},
    options: { llm?: BaseChatModel; visionLLM?: BaseChatModel } = {},
  ) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    this.state = null;
    this.llm = options.llm;
    this.visionLLM = options.visionLLM || options.llm;
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
   * Initialize the engine with a browser page context.
   */
  async initialize(page?: Page): Promise<void> {
    logger.info('Initializing ApplicationEngine (Dry-Run:', this.config.dryRun, ')...');

    if (page) {
      this.page = page;
    }

    // 1. Validate session cookies
    const cookieStatus: LinkedInSessionStatus = await validateLinkedInSession();
    if (!cookieStatus.isValid) {
      logger.warning('Session validation failed:', cookieStatus.message);
      throw new Error(cookieStatus.message);
    }

    // 2. Perform DOM health check if page context is provided
    if (this.page) {
      const healthStatus: HealthCheckResult = await this.healthChecker.runPreFlightCheck(this.page);
      if (!healthStatus.isLoggedIn) {
        logger.warning('Pre-flight health check failed:', healthStatus.message);
        throw new Error(healthStatus.message);
      }
    }

    logger.info('ApplicationEngine initialized successfully.');
  }

  /**
   * Sets or updates the active Page instance.
   */
  setPage(page: Page): void {
    this.page = page;
  }

  /**
   * Detects the current step in the Easy Apply modal if open.
   */
  async detectModalStep(): Promise<IStepDetectionResult | null> {
    if (!this.page) return null;
    return this.stepDetectorService.detectCurrentStep(this.page);
  }

  /**
   * Advances one step forward in the Easy Apply modal with transition verification.
   */
  async advanceModalStep(currentStep: IStepDetectionResult): Promise<IStepTransitionResult | null> {
    if (!this.page) return null;
    return this.stepNavigatorService.advanceToNextStep(this.page, currentStep);
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

  /**
   * Scan the current LinkedIn job listing page and extract structured job data.
   * Sanitizes the job description for LLM consumption (respects maxDescriptionTokens).
   */
  async scanJobListing(): Promise<IJobData> {
    if (!this.page) throw new Error('Page not attached.');
    const puppeteerPage = this.page.puppeteerPage;
    if (!puppeteerPage) throw new Error('Puppeteer page not attached.');

    const rawJob = await puppeteerPage.evaluate(() => {
      const title =
        document
          .querySelector('.job-details-jobs-unified-top-card__job-title, h1.topcard__title, h1')
          ?.textContent?.trim() || '';
      const company =
        document
          .querySelector('.job-details-jobs-unified-top-card__company-name, a.topcard__org-name-link')
          ?.textContent?.trim() || '';
      const location =
        document
          .querySelector('.job-details-jobs-unified-top-card__bullet, .topcard__flavor--bullet')
          ?.textContent?.trim() || '';
      const description =
        document
          .querySelector('.jobs-description__content, #job-details, .show-more-less-html__markup')
          ?.textContent?.trim() || '';
      const isEasyApply = Boolean(document.querySelector('button[aria-label*="Easy Apply" i], .jobs-apply-button'));

      return { title, company, location, description, isEasyApply };
    });

    const sanitizedDescription = sanitizeJobDescription(rawJob.description, this.config.maxDescriptionTokens);
    const url = this.page.url() || '';
    const jobId = Math.abs(url.split('').reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0)).toString(16);

    return {
      url,
      jobId,
      title: rawJob.title || 'Unknown Position',
      company: rawJob.company || 'Unknown Company',
      location: rawJob.location || '',
      salaryRange: '',
      description: sanitizedDescription,
      jobType: 'Full-time',
      experienceLevel: 'Mid-Senior level',
      isEasyApply: rawJob.isEasyApply,
    };
  }

  /**
   * Evaluates how well the user's profile matches the job listing.
   */
  async evaluateFitScore(jobData: IJobData): Promise<IFitScoreResult> {
    const careerBrain = await careerBrainStore.getCareerBrain();
    return evaluateJobFit(jobData, careerBrain, this.llm);
  }

  /**
   * Runs the complete Easy Apply pipeline for a job:
   * 1. Evaluates Fit Score against Career Brain (skips if score < 75)
   * 2. Opens Easy Apply modal
   * 3. Multi-step form filling loop with Question Solver & Vision Fallback
   * 4. Step transition verification and dry-run recording
   */
  async startApplication(jobData: IJobData): Promise<IApplicationState> {
    if (!this.page) {
      throw new Error('ApplicationEngine: Page context is required to start application.');
    }

    logger.info(`Starting Easy Apply flow for job: "${jobData.title}" at "${jobData.company}"`);

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

    const careerBrain = await careerBrainStore.getCareerBrain();

    // ─── 1. RAG Fit Score Check ─────────────────────────────────────────────
    const fitResult = await this.evaluateFitScore(jobData);
    logger.info(`Job Fit Score for "${jobData.title}": ${fitResult.score}/100 (Threshold: ${this.config.minFitScore})`);

    if (fitResult.score < this.config.minFitScore) {
      const skipReason = `Skipped low fit (${fitResult.score} < ${this.config.minFitScore}): ${fitResult.reasoning}`;
      logger.warning(`[ApplicationEngine] ⏭️ ${skipReason}`);

      this.state.status = 'QUEUED';
      this.state.errors.push(skipReason);
      this.state.completedAt = Date.now();

      if (this.config.dryRun) {
        await this.logDryRunRecord({
          jobData,
          wouldHaveApplied: false,
          fitScore: fitResult.score,
          blockedReason: 'skipped_low_fit',
          notes: skipReason,
        });
      }

      return this.state;
    }

    // ─── 2. Open Easy Apply Modal ───────────────────────────────────────────
    const puppeteerPage = this.page.puppeteerPage;
    if (!puppeteerPage) {
      throw new Error('Puppeteer page not attached.');
    }

    await this.retryWithBackoff(async () => {
      const opened = await puppeteerPage.evaluate(() => {
        const existingModal = document.querySelector('div[role="dialog"][aria-modal="true"]');
        if (existingModal) return true;

        const applyBtn = document.querySelector<HTMLButtonElement>(
          'button[aria-label*="Easy Apply" i], .jobs-apply-button, button.jobs-apply-button',
        );
        if (applyBtn && applyBtn.offsetParent !== null) {
          applyBtn.click();
          return true;
        }
        return false;
      });

      if (!opened) {
        throw new Error('Easy Apply button not found or could not be clicked.');
      }
    }, 'Open Easy Apply Modal');

    await this.humanDelay();

    // ─── 3. Multi-Step Form Fill Loop ───────────────────────────────────────
    const collectedQuestions: IScreeningQuestion[] = [];
    let modalFinished = false;

    for (let stepCount = 0; stepCount < this.config.maxModalSteps; stepCount++) {
      let stepResult = await this.stepDetectorService.detectCurrentStep(this.page);

      if (!stepResult.isModalOpen) {
        this.state.status = 'NEEDS_MANUAL_REVIEW';
        this.state.errors.push('Modal closed unexpectedly during application.');
        break;
      }

      // Vision Fallback (Strictly fallback when confidence < 0.4 or UNKNOWN)
      if (stepResult.stepType === 'UNKNOWN' || stepResult.confidence < 0.4) {
        logger.warning(
          `[ApplicationEngine] Low DOM confidence (${stepResult.confidence}). Triggering Vision Fallback...`,
        );
        const visionResult = await this.visionFallbackService.evaluateModalWithVision(this.page, this.visionLLM);
        if (visionResult.stepType !== 'UNKNOWN') {
          stepResult = {
            ...stepResult,
            stepType: visionResult.stepType,
            confidence: visionResult.confidence,
          };
        } else {
          // Still unknown after vision fallback: Hault safely
          logger.warning('[ApplicationEngine] Unknown state could not be resolved. Flagging NEEDS_MANUAL_REVIEW.');
          this.state.status = 'NEEDS_MANUAL_REVIEW';
          this.state.errors.push('Unrecognized modal step state. Stopped safely.');
          break;
        }
      }

      this.state.currentStepType = stepResult.stepType;
      this.state.currentStep = stepCount + 1;

      // Check if we reached Review / Submit screen
      if (stepResult.stepType === 'REVIEW' || stepResult.buttons.hasSubmit) {
        logger.info('[ApplicationEngine] Reached application Review/Submit screen.');
        this.state.status = this.config.dryRun ? 'DRY_RUN_SUCCESS' : 'NEEDS_MANUAL_REVIEW';
        modalFinished = true;
        break;
      }

      // Fill Form Fields for Current Step
      const fillResult = await this.formFillerService.fillCurrentStep(this.page, stepResult, careerBrain, this.llm);

      if (fillResult.questionsAnswered.length > 0) {
        collectedQuestions.push(...fillResult.questionsAnswered);
      }

      if (fillResult.needsManualReview) {
        logger.warning(`[ApplicationEngine] Manual review required: ${fillResult.reason}`);
        this.state.status = 'NEEDS_MANUAL_REVIEW';
        if (fillResult.reason) this.state.errors.push(fillResult.reason);
        break;
      }

      await this.humanDelay();

      // Advance to Next Step
      if (stepResult.buttons.hasNext || stepResult.buttons.hasReview) {
        const transition = await this.stepNavigatorService.advanceToNextStep(this.page, stepResult);

        if (!transition.success) {
          logger.warning(`[ApplicationEngine] Transition failed: ${transition.errorMessage}`);
          this.state.status = 'NEEDS_MANUAL_REVIEW';
          if (transition.errorMessage) this.state.errors.push(transition.errorMessage);
          break;
        }
      } else {
        logger.warning(`[ApplicationEngine] No forward action button found on step ${stepResult.stepType}.`);
        this.state.status = 'NEEDS_MANUAL_REVIEW';
        this.state.errors.push(`No forward action button on step ${stepResult.stepType}.`);
        break;
      }
    }

    this.state.screeningQuestions = collectedQuestions;
    this.state.completedAt = Date.now();

    // ─── 4. Log Dry Run Result ──────────────────────────────────────────────
    if (this.config.dryRun) {
      await this.logDryRunRecord({
        jobData,
        wouldHaveApplied: this.state.status === 'DRY_RUN_SUCCESS',
        fitScore: fitResult.score,
        screeningAnswers: collectedQuestions,
        blockedReason: this.state.status !== 'DRY_RUN_SUCCESS' ? this.state.errors.join('; ') : undefined,
        notes: `Fit: ${fitResult.score}/100. Status: ${this.state.status}`,
      });
    }

    return this.state;
  }

  /**
   * Extract and answer screening questions in the Easy Apply modal.
   */
  async handleScreeningQuestions(questions: IScreeningQuestion[]): Promise<IScreeningQuestion[]> {
    const careerBrain = await careerBrainStore.getCareerBrain();
    const answered: IScreeningQuestion[] = [];

    for (const q of questions) {
      const solution = await formFiller.fillCurrentStep(
        this.page!,
        {
          stepType: 'SCREENING_QUESTIONS',
          stepTitle: 'Screening',
          rawHeaderText: 'Screening',
          buttons: { hasNext: true, hasReview: false, hasSubmit: false, hasBack: false, hasDismiss: true },
          errors: { hasError: false, errorMessages: [] },
          isModalOpen: true,
          confidence: 1,
        },
        careerBrain,
        this.llm,
      );
      if (solution.questionsAnswered.length > 0) {
        answered.push(...solution.questionsAnswered);
      }
    }

    return answered;
  }

  /**
   * Submit the application (or complete dry-run).
   */
  async submitApplication(): Promise<JobApplicationStatus> {
    if (this.config.dryRun) {
      logger.info('[DRY-RUN] submitApplication in dry-run mode. Simulated application verified.');
      return 'DRY_RUN_SUCCESS';
    }

    // Live submission wired in Step 5
    throw new Error('Live submission not implemented — awaiting Step 5');
  }

  /**
   * Get current application state.
   */
  getApplicationState(): IApplicationState | null {
    return this.state;
  }

  /**
   * Retry operation with exponential backoff for React re-render handling.
   */
  async retryWithBackoff<T>(operation: () => Promise<T>, context: string): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.maxRetries - 1) {
          const delay = this.config.baseRetryDelayMs * Math.pow(2, attempt);
          await this.sleep(delay);
        }
      }
    }

    throw new Error(
      `[ApplicationEngine] ${context} failed after ${this.config.maxRetries} retries: ${lastError?.message}`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async humanDelay(): Promise<void> {
    const [min, max] = this.config.actionDelayRange;
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await this.sleep(delay);
  }
}
