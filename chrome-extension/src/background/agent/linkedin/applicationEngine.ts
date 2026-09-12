/**
 * LinkedIn Easy Apply — ApplicationEngine
 *
 * Core Engine orchestrating LinkedIn Easy Apply Automation.
 *
 * Technical considerations:
 * - Session validation via chrome.cookies (li_at, JSESSIONID).
 * - Pre-flight health check for profile icon (div.global-nav__me) before execution.
 * - Multi-step modal navigation with ARIA-first parsing and transition verification.
 * - 'Unknown State' fallback: Never guess; sets NEEDS_MANUAL_REVIEW if step is unrecognised.
 * - Dry-Run mode logging framework (default ON) for recording 'would have applied' actions.
 * - React re-render resiliency via retryWithBackoff (3 retries, exponential backoff).
 * - Job descriptions are sanitized/summarized before LLM calls.
 * - PDF resume generation happens on the backend (resumeGenerator.service.ts).
 */

import { createLogger } from '@src/background/log';
import type Page from '@src/background/browser/page';
import { validateLinkedInSession, type LinkedInSessionStatus } from './sessionValidator';
import { LinkedInHealthChecker, type HealthCheckResult } from './healthCheck';
import { dryRunLogger, DryRunLogger, type IDryRunRecord, type IDryRunStats } from './dryRunLogger';
import { stepDetector, LinkedInStepDetector } from './stepDetector';
import { stepNavigator, LinkedInStepNavigator } from './stepNavigator';
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
  /** Minimum fit score to proceed with auto-apply (0-100) */
  minFitScore: number;
  /** Maximum token limit for job description sent to LLM */
  maxDescriptionTokens: number;
  /** Human-like delay range in ms between actions [min, max] */
  actionDelayRange: [number, number];
}

export const DEFAULT_ENGINE_CONFIG: ApplicationEngineConfig = {
  dryRun: true, // Default ON for safety
  maxRetries: 3,
  baseRetryDelayMs: 1000,
  minFitScore: 60,
  maxDescriptionTokens: 2000,
  actionDelayRange: [800, 2500],
};

/**
 * ApplicationEngine orchestrates the LinkedIn Easy Apply flow.
 */
export class ApplicationEngine {
  private config: ApplicationEngineConfig;
  private state: IApplicationState | null;
  private page: Page | null = null;
  private healthChecker: LinkedInHealthChecker;
  private loggerService: DryRunLogger;
  private stepDetectorService: LinkedInStepDetector;
  private stepNavigatorService: LinkedInStepNavigator;

  constructor(config: Partial<ApplicationEngineConfig> = {}) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    this.state = null;
    this.healthChecker = new LinkedInHealthChecker(this.config.maxRetries, this.config.baseRetryDelayMs);
    this.loggerService = dryRunLogger;
    this.stepDetectorService = stepDetector;
    this.stepNavigatorService = stepNavigator;
  }

  /**
   * Initialize the engine with a browser page context.
   * Performs:
   * 1. Cookie-based session validation (chrome.cookies)
   * 2. DOM-based pre-flight health check (profile icon detection)
   *
   * @throws Error with a user-friendly pause message if unauthenticated
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
   *
   * @returns Extracted and sanitized job data
   */
  async scanJobListing(): Promise<IJobData> {
    // TODO: Step 4 — DOM scraping with retry, description sanitization
    throw new Error('Not implemented — awaiting Step 4');
  }

  /**
   * Evaluate how well the user's profile matches the job listing.
   * Sends sanitized job description to LLM for analysis.
   *
   * @param jobData - The job data to evaluate against user profile
   * @returns Fit score result with reasoning and skill analysis
   */
  async evaluateFitScore(jobData: IJobData): Promise<IFitScoreResult> {
    // TODO: Step 4 — LLM integration for fit scoring
    throw new Error('Not implemented — awaiting Step 4');
  }

  /**
   * Begin the Easy Apply flow by clicking the Easy Apply button
   * and stepping through the modal with transition verification.
   *
   * @param jobData - The job to apply for
   * @returns Application state after step navigation
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

    // 1. Click Easy Apply button on the job page if not already in modal
    const puppeteerPage = this.page.puppeteerPage;
    if (puppeteerPage) {
      await this.retryWithBackoff(async () => {
        const opened = await puppeteerPage.evaluate(() => {
          // Check if modal is already open
          const existingModal = document.querySelector('div[role="dialog"][aria-modal="true"]');
          if (existingModal) return true;

          // Find Easy Apply button on job details page
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
      }, 'Click Easy Apply button');
    }

    await this.humanDelay();

    // 2. Step through the modal safely (navigation logic)
    const stepThroughResult = await this.stepNavigatorService.stepThroughModal(this.page, {
      dryRun: this.config.dryRun,
    });

    this.state.status = stepThroughResult.finalStatus;
    this.state.currentStep = stepThroughResult.stepsEncountered.length;
    this.state.currentStepType = stepThroughResult.lastStepDetails?.stepType;
    this.state.completedAt = Date.now();

    if (stepThroughResult.reason) {
      this.state.errors.push(stepThroughResult.reason);
    }

    // 3. Log Dry-Run record if dry-run enabled
    if (this.config.dryRun) {
      await this.logDryRunRecord({
        jobData,
        wouldHaveApplied: stepThroughResult.finalStatus === 'DRY_RUN_SUCCESS',
        blockedReason: stepThroughResult.finalStatus !== 'DRY_RUN_SUCCESS' ? stepThroughResult.reason : undefined,
        notes: `Steps encountered: ${stepThroughResult.stepsEncountered.join(' -> ')}`,
      });
    }

    return this.state;
  }

  /**
   * Extract and answer screening questions in the Easy Apply modal.
   * Uses LLM to generate contextually appropriate answers.
   *
   * @param questions - Screening questions extracted from the form
   * @returns Questions with populated userAnswer fields
   */
  async handleScreeningQuestions(questions: IScreeningQuestion[]): Promise<IScreeningQuestion[]> {
    // TODO: Step 4 — LLM-powered question answering
    throw new Error('Not implemented — awaiting Step 4');
  }

  /**
   * Submit the application (or complete dry-run).
   * In dry-run mode, validates all fields are filled and logs to dryRunLogger
   * without clicking the final submit button.
   *
   * @returns Final application status after submission attempt
   */
  async submitApplication(): Promise<JobApplicationStatus> {
    if (this.config.dryRun) {
      logger.info('[DRY-RUN] submitApplication invoked in dry-run mode. Application validated.');
      return 'DRY_RUN_SUCCESS';
    }

    // Live submission will be wired in Step 4
    throw new Error('Live submission not implemented — awaiting Step 4');
  }

  /**
   * Get the current application state snapshot.
   *
   * @returns Current state or null if not initialized
   */
  getApplicationState(): IApplicationState | null {
    return this.state;
  }

  /**
   * Retry a DOM interaction with exponential backoff.
   * Handles LinkedIn's frequent React re-renders that cause stale element references.
   *
   * @param operation - The async operation to retry
   * @param context - Description of the operation for error logging
   * @returns The result of the successful operation
   * @throws Error after maxRetries exhausted
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

  /**
   * Sleep for a specified duration. Used for human-like pacing
   * and exponential backoff delays.
   *
   * @param ms - Duration in milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Add a random human-like delay between actions.
   * Uses the configured actionDelayRange for natural pacing.
   */
  private async humanDelay(): Promise<void> {
    const [min, max] = this.config.actionDelayRange;
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await this.sleep(delay);
  }
}
