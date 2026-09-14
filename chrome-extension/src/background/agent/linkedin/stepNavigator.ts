/**
 * LinkedIn Easy Apply — Step Navigator
 *
 * Handles multi-step navigation through the Easy Apply modal.
 * Uses MutationObserver and DOM polling to verify step transitions.
 * Implements 3 retries with exponential backoff for stale element recovery.
 * Provides strict 'Unknown State' fallback to NEEDS_MANUAL_REVIEW without guessing.
 */

import { createLogger } from '@src/background/log';
import type Page from '@src/background/browser/page';
import { stepDetector, LinkedInStepDetector } from './stepDetector';
import type { EasyApplyStepType, IStepDetectionResult, IStepTransitionResult, JobApplicationStatus } from './types';

const logger = createLogger('LinkedInStepNavigator');

export interface StepNavigatorConfig {
  maxRetries: number;
  baseDelayMs: number;
  transitionTimeoutMs: number;
  maxModalSteps: number;
}

export const DEFAULT_NAVIGATOR_CONFIG: StepNavigatorConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  transitionTimeoutMs: 5000,
  maxModalSteps: 10,
};

export class LinkedInStepNavigator {
  private config: StepNavigatorConfig;
  private detector: LinkedInStepDetector;

  constructor(config: Partial<StepNavigatorConfig> = {}) {
    this.config = { ...DEFAULT_NAVIGATOR_CONFIG, ...config };
    this.detector = stepDetector;
  }

  /**
   * Clicks the primary forward action button ('Next' or 'Review') and verifies the DOM transition.
   */
  async advanceToNextStep(page: Page, currentStepResult: IStepDetectionResult): Promise<IStepTransitionResult> {
    const startTime = Date.now();
    const previousStep = currentStepResult.stepType;
    const previousHeader = currentStepResult.rawHeaderText;

    logger.info(`[StepNavigator] Advancing from step: ${previousStep} ("${previousHeader}")`);

    const puppeteerPage = page.puppeteerPage;
    if (!puppeteerPage) {
      return {
        success: false,
        previousStep,
        currentStep: previousStep,
        transitionTimeMs: 0,
        errorMessage: 'Puppeteer page not attached',
        needsManualReview: true,
      };
    }

    let clickSuccess = false;
    let clickError: Error | null = null;

    // Retry button click with exponential backoff for React re-render handling
    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        const clicked = await puppeteerPage.evaluate(() => {
          const modal = document.querySelector(
            'div[role="dialog"][aria-modal="true"], div[role="dialog"][aria-labelledby], .jobs-easy-apply-modal, div[data-test-modal]',
          );
          if (!modal) return { success: false, reason: 'Modal not found' };

          const buttons = Array.from(modal.querySelectorAll<HTMLButtonElement>('button, [role="button"]'));

          // Find primary forward action button
          const targetButton = buttons.find(btn => {
            if (btn.offsetParent === null) return false;
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();

            return (
              aria.includes('continue to next step') ||
              aria.includes('continue applying') ||
              aria.includes('next') ||
              aria.includes('review') ||
              text === 'next' ||
              text === 'continue' ||
              text.includes('continue applying') ||
              text.startsWith('review')
            );
          });

          if (!targetButton) {
            return { success: false, reason: 'Forward button (Next/Review) not found' };
          }

          if (targetButton.disabled || targetButton.getAttribute('aria-disabled') === 'true') {
            return { success: false, reason: 'Forward button is disabled' };
          }

          // Trigger click
          targetButton.click();
          return { success: true };
        });

        if (clicked.success) {
          clickSuccess = true;
          break;
        } else {
          clickError = new Error(clicked.reason);
        }
      } catch (err) {
        clickError = err instanceof Error ? err : new Error(String(err));
        logger.warning(`Click attempt ${attempt + 1} failed:`, clickError.message);
      }

      if (attempt < this.config.maxRetries - 1) {
        const delay = this.config.baseDelayMs * Math.pow(2, attempt);
        await new Promise(res => setTimeout(res, delay));
      }
    }

    if (!clickSuccess) {
      return {
        success: false,
        previousStep,
        currentStep: previousStep,
        transitionTimeMs: Date.now() - startTime,
        errorMessage: `Failed to click forward button after ${this.config.maxRetries} attempts: ${clickError?.message}`,
        needsManualReview: true,
      };
    }

    // Verify DOM transition using polling / MutationObserver check
    const transitionResult = await this.waitForStepTransition(page, previousHeader);
    return {
      ...transitionResult,
      previousStep,
      transitionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Waits for the modal DOM to transition to a new step signature.
   */
  private async waitForStepTransition(
    page: Page,
    previousHeaderText: string,
  ): Promise<Omit<IStepTransitionResult, 'previousStep' | 'transitionTimeMs'>> {
    const pollIntervalMs = 250;
    const maxPolls = Math.ceil(this.config.transitionTimeoutMs / pollIntervalMs);

    for (let i = 0; i < maxPolls; i++) {
      await new Promise(res => setTimeout(res, pollIntervalMs));

      // 0. Ensure LinkedIn loading spinners / transition overlays are dismissed
      const puppeteerPage = page.puppeteerPage;
      if (puppeteerPage) {
        const isBusy = await puppeteerPage
          .evaluate(() => {
            const spinner = document.querySelector(
              '.artdeco-spinner, .artdeco-inline-feedback--loading, [data-test-modal-loading], .jobs-easy-apply-modal__loading',
            );
            return Boolean(spinner && (spinner as HTMLElement).offsetParent !== null);
          })
          .catch(() => false);

        if (isBusy) {
          continue; // Wait until spinner disappears
        }
      }

      const detected = await this.detector.detectCurrentStep(page);

      // 1. Check if modal closed
      if (!detected.isModalOpen) {
        logger.warning('[StepNavigator] Modal closed during step transition.');
        return {
          success: false,
          currentStep: 'UNKNOWN',
          errorMessage: 'Modal closed unexpectedly during transition.',
          needsManualReview: true,
        };
      }

      // 2. Check for form validation error banners
      if (detected.errors.hasError) {
        logger.warning(`[StepNavigator] Form validation errors detected: ${detected.errors.errorMessages.join(' | ')}`);
        return {
          success: false,
          currentStep: detected.stepType,
          stepDetails: detected,
          errorMessage: `Validation errors blocked navigation: ${detected.errors.errorMessages.join('; ')}`,
          needsManualReview: true,
        };
      }

      // 3. Check if header or step signature changed
      if (
        detected.rawHeaderText !== previousHeaderText ||
        detected.stepType === 'REVIEW' ||
        detected.stepType === 'SUBMITTED'
      ) {
        logger.info(`[StepNavigator] ✅ Step transition confirmed: ${detected.stepType} ("${detected.rawHeaderText}")`);
        return {
          success: true,
          currentStep: detected.stepType,
          stepDetails: detected,
          needsManualReview: detected.stepType === 'UNKNOWN',
        };
      }
    }

    // Transition timed out
    logger.warning('[StepNavigator] Transition verification timed out. DOM did not change.');
    const finalDetection = await this.detector.detectCurrentStep(page);

    return {
      success: false,
      currentStep: finalDetection.stepType,
      stepDetails: finalDetection,
      errorMessage: 'Transition verification timed out. Modal content remained unchanged.',
      needsManualReview: true,
    };
  }

  /**
   * Safely steps through the Easy Apply modal until the Review or Submit screen.
   * Does NOT fill data (data-filling is handled in Step 4).
   * If any unknown or unhandled state is reached, safely stops with NEEDS_MANUAL_REVIEW.
   */
  async stepThroughModal(
    page: Page,
    options: { dryRun?: boolean } = {},
  ): Promise<{
    finalStatus: JobApplicationStatus;
    stepsEncountered: EasyApplyStepType[];
    lastStepDetails?: IStepDetectionResult;
    reason?: string;
  }> {
    const stepsEncountered: EasyApplyStepType[] = [];
    logger.info('[StepNavigator] Starting safe modal step-through...');

    for (let stepCount = 0; stepCount < this.config.maxModalSteps; stepCount++) {
      const stepResult = await this.detector.detectCurrentStep(page);

      if (!stepResult.isModalOpen) {
        return {
          finalStatus: 'NEEDS_MANUAL_REVIEW',
          stepsEncountered,
          reason: 'Easy Apply modal dialog is not open.',
        };
      }

      stepsEncountered.push(stepResult.stepType);

      // Unknown State Fallback: Never guess or fill randomly
      if (stepResult.stepType === 'UNKNOWN' || stepResult.confidence < 0.4) {
        logger.warning(
          `[StepNavigator] ⚠️ Unknown modal step encountered: "${stepResult.rawHeaderText}". Setting NEEDS_MANUAL_REVIEW.`,
        );
        return {
          finalStatus: 'NEEDS_MANUAL_REVIEW',
          stepsEncountered,
          lastStepDetails: stepResult,
          reason: `Unrecognized modal step "${stepResult.rawHeaderText}". Aborting auto-navigation for manual review.`,
        };
      }

      // Reached Review or Submit screen
      if (stepResult.stepType === 'REVIEW' || stepResult.buttons.hasSubmit) {
        logger.info('[StepNavigator] Reached application Review/Submit screen.');
        return {
          finalStatus: options.dryRun ? 'DRY_RUN_SUCCESS' : 'NEEDS_MANUAL_REVIEW',
          stepsEncountered,
          lastStepDetails: stepResult,
          reason: 'Reached final review screen successfully.',
        };
      }

      // Can we advance?
      if (stepResult.buttons.hasNext || stepResult.buttons.hasReview) {
        const transition = await this.advanceToNextStep(page, stepResult);

        if (!transition.success) {
          logger.warning(`[StepNavigator] Advance failed at step ${stepResult.stepType}: ${transition.errorMessage}`);
          return {
            finalStatus: 'NEEDS_MANUAL_REVIEW',
            stepsEncountered,
            lastStepDetails: stepResult,
            reason: transition.errorMessage || 'Failed to advance to next step.',
          };
        }
      } else {
        // No forward button found and not at review screen
        logger.warning(`[StepNavigator] No forward navigation button found on step ${stepResult.stepType}.`);
        return {
          finalStatus: 'NEEDS_MANUAL_REVIEW',
          stepsEncountered,
          lastStepDetails: stepResult,
          reason: `No forward action button found at step ${stepResult.stepType}.`,
        };
      }
    }

    return {
      finalStatus: 'NEEDS_MANUAL_REVIEW',
      stepsEncountered,
      reason: `Exceeded maximum modal steps (${this.config.maxModalSteps}).`,
    };
  }

  /**
   * Dismisses the active Easy Apply modal safely.
   */
  async dismissModal(page: Page): Promise<boolean> {
    const puppeteerPage = page.puppeteerPage;
    if (!puppeteerPage) return false;

    try {
      return await puppeteerPage.evaluate(() => {
        const modal = document.querySelector(
          'div[role="dialog"][aria-modal="true"], div[role="dialog"][aria-labelledby], .jobs-easy-apply-modal',
        );
        if (!modal) return false;

        const dismissBtn = modal.querySelector<HTMLButtonElement>(
          'button[aria-label*="Dismiss" i], button[aria-label*="Close" i], button[data-test-modal-close-btn]',
        );

        if (dismissBtn) {
          dismissBtn.click();
          return true;
        }
        return false;
      });
    } catch {
      return false;
    }
  }
}

export const stepNavigator = new LinkedInStepNavigator();
