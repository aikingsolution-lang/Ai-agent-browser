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
 * - Human-Mimicry & Natural Pacing: Log-Normal delays & natural pseudo-typing.
 * - Daily Rate-Limiting: 15/day quota enforcement with next-day resumption.
 * - Resume Approval Gate: Generated resumes held in PENDING_RESUME_APPROVAL until user reviews.
 * - MongoDB Tracking: Populates JobApplication records & prevents duplicate applies.
 * - Live-Mode Ready: Submits application only when dryRun is explicitly set to false.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createLogger } from '@src/background/log';
import type Page from '@src/background/browser/page';
import { careerBrainStore, type ICareerBrain } from '@extension/storage';
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
import { LinkedInBackendClient } from './backendClient';
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
  maxModalSteps: 10,
  requireTailoredResume: false,
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
   * Updates configuration (e.g. toggling Live Mode vs Dry Run).
   */
  updateConfig(config: Partial<ApplicationEngineConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info(`[ApplicationEngine] Config updated. Live Mode: ${!this.config.dryRun}`);
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
   */
  async scanJobListing(): Promise<IJobData> {
    if (!this.page) throw new Error('Page not attached.');
    const puppeteerPage = this.page.puppeteerPage;
    if (!puppeteerPage) throw new Error('Puppeteer page not attached.');

    const deadCheck = await this.page.detectDeadJobOrErrorPage();
    if (deadCheck.isDeadJob) {
      logger.warning(`[ApplicationEngine] 🛑 Dead job or removed posting detected: ${deadCheck.reason}`);
      const url = this.page.url() || '';
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

    const rawJob = await puppeteerPage.evaluate(() => {
      // 1. Title Extraction (Modern Unified Top Card, Standalone View, or Heading)
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

      // 2. Company Extraction (Modern Link, Subtitle, or Topcard Flavor)
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
      // Fallback: If company still empty, check primary description container
      if (!company) {
        const primaryDesc = document.querySelector('.job-details-jobs-unified-top-card__primary-description');
        if (primaryDesc) {
          const firstLink = primaryDesc.querySelector('a');
          if (firstLink?.textContent?.trim()) {
            company = firstLink.textContent.trim();
          }
        }
      }

      // 3. Location Extraction
      const locationSelectors = [
        '.job-details-jobs-unified-top-card__bullet',
        '.job-details-jobs-unified-top-card__primary-description span:nth-of-type(1)',
        '.topcard__flavor--bullet',
        '.jobs-unified-top-card__bullet',
      ];
      let location = '';
      for (const sel of locationSelectors) {
        const el = document.querySelector(sel);
        const text = el?.textContent?.trim();
        if (text && text.length > 0) {
          location = text;
          break;
        }
      }

      // 4. Description Extraction
      const descriptionSelectors = [
        '.jobs-description__content',
        '#job-details',
        '.show-more-less-html__markup',
        '.jobs-box__html-content',
        '.jobs-description',
      ];
      let description = '';
      for (const sel of descriptionSelectors) {
        const el = document.querySelector(sel);
        const text = el?.textContent?.trim();
        if (text && text.length > 10) {
          description = text;
          break;
        }
      }

      // 5. Easy Apply Button Detection (Comprehensive & Resilient)
      // Look across aria-labels, textContent, button classes, and child spans/SVGs
      const allButtons = Array.from(document.querySelectorAll<HTMLElement>('button, a[role="button"]'));
      let isEasyApply = false;

      for (const btn of allButtons) {
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        const className = (btn.className || '').toLowerCase();

        // Check if button explicitly has "Easy Apply" or "in Easy Apply"
        if (
          ariaLabel.includes('easy apply') ||
          text.includes('easy apply') ||
          className.includes('jobs-apply-button--easy-apply') ||
          (className.includes('jobs-apply-button') && (ariaLabel.includes('easy apply') || text.includes('easy apply')))
        ) {
          isEasyApply = true;
          break;
        }
      }

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
   * 1. Duplicate Prevention Check (MongoDB)
   * 2. Daily Rate Limiting Quota Check (15/day)
   * 3. RAG Fit Score Evaluation (<75 skip)
   * 4. Resume Approval Gate (if tailored resume required)
   * 5. Multi-Step Form Filling with Natural Pacing & Vision Fallback
   * 6. Live Submission vs Dry-Run Logging
   * 7. MongoDB JobApplication Tracking Persistence
   */
  async startApplication(jobData: IJobData): Promise<IApplicationState> {
    if (!this.page) {
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

    // ─── 0. Pre-Flight Dead / Removed Job Check ────────────────────────────
    const deadCheck = await this.page.detectDeadJobOrErrorPage();
    if (deadCheck.isDeadJob || jobData.title === 'Removed or Unavailable Job') {
      const msg = `Job "${jobData.title}" is no longer available on LinkedIn (${deadCheck.reason || 'Job posting removed'}). Marked as SKIPPED_JOB_REMOVED.`;
      logger.warning(`[ApplicationEngine] 🛑 ${msg}`);
      this.state.status = 'SKIPPED_JOB_REMOVED';
      this.state.errors.push(msg);
      this.state.completedAt = Date.now();
      return this.state;
    }

    // ─── 0b. Strict Easy Apply Check (Defense in Depth: Layer 2) ──────────────
    if (!jobData.isEasyApply) {
      const msg = `Job "${jobData.title}" at "${jobData.company}" is an External Apply job (not Easy Apply). Skipping to avoid navigating off LinkedIn.`;
      logger.warning(`[ApplicationEngine] 🛑 ${msg}`);
      this.state.status = 'SKIPPED_EXTERNAL_SITE';
      this.state.errors.push(msg);
      this.state.completedAt = Date.now();
      return this.state;
    }

    const careerBrain = await careerBrainStore.getCareerBrain();

    // ─── 1. Duplicate Prevention Check ──────────────────────────────────────
    const isDuplicate = await LinkedInBackendClient.checkDuplicateJob(jobData.jobId);
    if (isDuplicate) {
      const msg = `Job "${jobData.title}" at "${jobData.company}" was already processed/applied in database. Skipping.`;
      logger.info(`[ApplicationEngine] ⏭️ ${msg}`);
      this.state.status = 'APPLIED';
      this.state.errors.push(msg);
      this.state.completedAt = Date.now();
      return this.state;
    }

    // ─── 2. Daily Quota Rate Limiting Check ──────────────────────────────────
    const quotaCheck = await DailyQuotaManager.canApplyToday();
    if (!quotaCheck.allowed) {
      const msg = `Daily application quota reached (${quotaCheck.currentCount} applications today). Auto-resumed scheduled for tomorrow.`;
      logger.warning(`[ApplicationEngine] 🛑 ${msg}`);
      this.state.status = 'QUEUED';
      this.state.errors.push(msg);
      this.state.completedAt = Date.now();
      return this.state;
    }

    // ─── 3. RAG Fit Score Check ─────────────────────────────────────────────
    const fitResult = await this.evaluateFitScore(jobData);
    logger.info(`Job Fit Score for "${jobData.title}": ${fitResult.score}/100 (Threshold: ${this.config.minFitScore})`);

    if (fitResult.score < this.config.minFitScore) {
      const skipReason = `Skipped low fit (${fitResult.score} < ${this.config.minFitScore}): ${fitResult.reasoning}`;
      logger.warning(`[ApplicationEngine] ⏭️ ${skipReason}`);

      this.state.status = 'QUEUED';
      this.state.errors.push(skipReason);
      this.state.completedAt = Date.now();

      await LinkedInBackendClient.recordJobApplication({
        jobData,
        fitScore: fitResult.score,
        status: 'QUEUED',
      });

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

    // ─── 4. Resume Approval Gate Check (If Tailored Resume Required) ─────────
    if (this.config.requireTailoredResume) {
      const approvedResume = await ResumeApprovalGate.getApprovedResumeForJob(jobData.jobId);

      if (!approvedResume) {
        logger.info('[ApplicationEngine] Requesting tailored resume from backend and pausing for user approval...');
        const generated = await LinkedInBackendClient.requestTailoredResume({
          candidateName: careerBrain.currentTitle || 'Candidate',
          candidateEmail: careerBrain.email,
          candidatePhone: careerBrain.phoneNumber,
          currentTitle: careerBrain.currentTitle,
          skills: careerBrain.skills,
          targetKeywords: fitResult.matchedSkills,
          jobTitle: jobData.title,
          company: jobData.company,
          backgroundNarrative: careerBrain.backgroundNarrative,
        });

        if (generated) {
          await ResumeApprovalGate.enqueueResumeForApproval({
            jobData,
            fileName: generated.fileName,
            fileSize: generated.fileSize,
            base64Pdf: generated.base64Pdf,
            highlightedKeywords: generated.highlightedKeywords,
          });

          this.state.status = 'PENDING_RESUME_APPROVAL';
          this.state.errors.push('Tailored resume generated. Awaiting user approval in Options page.');
          this.state.completedAt = Date.now();

          await LinkedInBackendClient.recordJobApplication({
            jobData,
            fitScore: fitResult.score,
            status: 'PENDING_RESUME_APPROVAL',
          });

          return this.state;
        }
      }
    }

    // ─── 5. Open Easy Apply Modal ───────────────────────────────────────────
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

    // Natural pacing pause
    await HumanPacingSimulator.naturalActionPause(1800);

    // Auto-dismiss LinkedIn 'Job search safety reminder' interstitial if present
    await puppeteerPage.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('div[role="dialog"]'));
      for (const dialog of dialogs) {
        const text = (dialog.textContent || '').toLowerCase();
        if (
          text.includes('safety reminder') ||
          text.includes('research the company') ||
          text.includes('report suspicious')
        ) {
          const continueBtn = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(btn => {
            const btnText = (btn.textContent || '').trim().toLowerCase();
            return btnText.includes('continue applying') || btnText.includes('continue');
          });
          if (continueBtn && continueBtn.offsetParent !== null) {
            continueBtn.click();
            break;
          }
        }
      }
    });

    await HumanPacingSimulator.naturalActionPause(1000);

    // ─── 6. Multi-Step Form Fill Loop ───────────────────────────────────────
    const collectedQuestions: IScreeningQuestion[] = [];
    let reachedReview = false;

    for (let stepCount = 0; stepCount < this.config.maxModalSteps; stepCount++) {
      // 0. CAPTCHA Shield: Anomaly Check before interacting with modal
      const captchaStatus = await this.page.detectCaptchaOrSecurityCheck();
      if (captchaStatus.isCaptcha) {
        logger.warning(
          `[ApplicationEngine] 🛡️ Security Challenge / CAPTCHA detected (${captchaStatus.type}). Pausing for user resolution...`,
        );
        let solved = false;
        for (let waitSec = 0; waitSec < 180; waitSec++) {
          await this.sleep(2000);
          const recheck = await this.page.detectCaptchaOrSecurityCheck().catch(() => ({ isCaptcha: false }));
          if (!recheck.isCaptcha) {
            solved = true;
            break;
          }
        }
        if (!solved) {
          logger.error('[ApplicationEngine] Security challenge was not cleared in 3 minutes. Aborting application.');
          this.state.status = 'NEEDS_MANUAL_REVIEW';
          this.state.errors.push(`Security verification challenge (${captchaStatus.type}) timed out.`);
          break;
        } else {
          logger.info('[ApplicationEngine] ✅ Security challenge cleared by user. Resuming application flow...');
          await this.sleep(1500);
        }
      }

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
        reachedReview = true;
        break;
      }

      // Fill Form Fields for Current Step
      const fillResult = await this.formFillerService.fillCurrentStep(this.page, stepResult, careerBrain, this.llm);

      if (fillResult.questionsAnswered.length > 0) {
        collectedQuestions.push(...fillResult.questionsAnswered);
      }

      if (fillResult.isMissingResume) {
        logger.warning(`[ApplicationEngine] 🛑 Missing pre-uploaded resume: ${fillResult.reason}`);
        this.state.status = 'SKIPPED_MISSING_RESUME';
        if (fillResult.reason) this.state.errors.push(fillResult.reason);
        // Cleanly dismiss the modal so browser isn't left stuck with modal open
        await this.stepNavigatorService.dismissModal(this.page).catch(() => {});
        break;
      }

      if (fillResult.needsManualReview) {
        logger.warning(`[ApplicationEngine] Manual review required: ${fillResult.reason}`);
        this.state.status = 'NEEDS_MANUAL_REVIEW';
        if (fillResult.reason) this.state.errors.push(fillResult.reason);
        break;
      }

      await HumanPacingSimulator.naturalActionPause(1500);

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

    // ─── 7. Final Submission / Dry-Run Outcome ──────────────────────────────
    if (reachedReview) {
      if (this.config.dryRun) {
        // DRY RUN: Stop here and mark success
        logger.info('[ApplicationEngine] [DRY-RUN] Simulation successful. Reached submit screen without applying.');
        this.state.status = 'DRY_RUN_SUCCESS';
      } else {
        // LIVE MODE: Click actual Submit Application button
        logger.info('[ApplicationEngine] 🚀 [LIVE MODE] Submitting actual job application...');
        const submitted = await this.executeLiveSubmission();

        if (submitted) {
          this.state.status = 'APPLIED';
          await DailyQuotaManager.incrementAppliedCount();
        } else {
          this.state.status = 'NEEDS_MANUAL_REVIEW';
          this.state.errors.push('Final submit button could not be confirmed.');
        }
      }
    }

    this.state.completedAt = Date.now();

    // ─── 8. Persist to MongoDB & Dry-Run Logger ──────────────────────────────
    await LinkedInBackendClient.recordJobApplication({
      jobData,
      fitScore: fitResult.score,
      status: this.state.status,
      appliedAt: this.state.status === 'APPLIED' ? new Date() : null,
    });

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
   * Executes the real final submission click on LinkedIn Easy Apply.
   */
  private async executeLiveSubmission(): Promise<boolean> {
    if (!this.page || !this.page.puppeteerPage) return false;

    try {
      await HumanPacingSimulator.naturalActionPause(2000);

      const submitted = await this.page.puppeteerPage.evaluate(() => {
        const modal = document.querySelector('div[role="dialog"][aria-modal="true"]');
        if (!modal) return false;

        const submitBtn = modal.querySelector<HTMLButtonElement>(
          'button[aria-label*="Submit application" i], button.jobs-apply-button',
        );

        if (submitBtn && submitBtn.offsetParent !== null && !submitBtn.disabled) {
          submitBtn.click();
          return true;
        }
        return false;
      });

      if (submitted) {
        // Wait for confirmation dialog
        await HumanPacingSimulator.naturalActionPause(3000);
        return true;
      }
      return false;
    } catch (err) {
      logger.error('Error during live submission execution:', err);
      return false;
    }
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

    const success = await this.executeLiveSubmission();
    return success ? 'APPLIED' : 'NEEDS_MANUAL_REVIEW';
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
}
