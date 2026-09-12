/**
 * LinkedIn Easy Apply — Step Detector
 *
 * ARIA-first semantic DOM parser for identifying Easy Apply modal steps.
 * Avoids brittle CSS classes by leveraging ARIA roles, labels, semantic headers,
 * and form field structures.
 */

import { createLogger } from '@src/background/log';
import type Page from '@src/background/browser/page';
import type { EasyApplyStepType, IStepDetectionResult, IModalNavigationButtons, IModalErrorBanner } from './types';

const logger = createLogger('LinkedInStepDetector');

/**
 * Categorizes extracted header / legend text into a standardized EasyApplyStepType.
 */
export function classifyStepFromText(
  headerText: string,
  bodySnippet = '',
): {
  stepType: EasyApplyStepType;
  confidence: number;
} {
  const combined = `${headerText} ${bodySnippet}`.toLowerCase().trim();

  if (!combined) {
    return { stepType: 'UNKNOWN', confidence: 0 };
  }

  // 1. Submitted / Complete
  if (
    combined.includes('application sent') ||
    combined.includes('your application was sent') ||
    combined.includes('application submitted')
  ) {
    return { stepType: 'SUBMITTED', confidence: 0.95 };
  }

  // 2. Review Step
  if (
    combined.includes('review your application') ||
    combined.includes('review application') ||
    combined.includes('please review') ||
    headerText.toLowerCase().trim() === 'review'
  ) {
    return { stepType: 'REVIEW', confidence: 0.95 };
  }

  // 3. Resume / CV Step
  if (
    combined.includes('resume') ||
    combined.includes('cv') ||
    combined.includes('upload resume') ||
    combined.includes('attach resume') ||
    combined.includes('updated resume')
  ) {
    return { stepType: 'RESUME', confidence: 0.9 };
  }

  // 4. Contact Information Step
  if (
    combined.includes('contact info') ||
    combined.includes('contact information') ||
    combined.includes('email address') ||
    combined.includes('phone number') ||
    combined.includes('phone country code')
  ) {
    return { stepType: 'CONTACT_INFO', confidence: 0.9 };
  }

  // 5. Home Address / Location
  if (
    combined.includes('home address') ||
    combined.includes('address') ||
    combined.includes('postal code') ||
    combined.includes('city, state')
  ) {
    return { stepType: 'HOME_ADDRESS', confidence: 0.85 };
  }

  // 6. Work Experience
  if (
    combined.includes('work experience') ||
    combined.includes('employment history') ||
    combined.includes('recent experience')
  ) {
    return { stepType: 'WORK_EXPERIENCE', confidence: 0.85 };
  }

  // 7. Education
  if (combined.includes('education') || combined.includes('degree') || combined.includes('school or university')) {
    return { stepType: 'EDUCATION', confidence: 0.85 };
  }

  // 8. Voluntary Disclosures / Diversity / EEO
  if (
    combined.includes('voluntary') ||
    combined.includes('self-identification') ||
    combined.includes('equal opportunity') ||
    combined.includes('diversity') ||
    combined.includes('veteran status') ||
    combined.includes('disability')
  ) {
    return { stepType: 'VOLUNTARY_DISCLOSURES', confidence: 0.9 };
  }

  // 9. Screening / Additional Questions
  if (
    combined.includes('additional questions') ||
    combined.includes('screening questions') ||
    combined.includes('qualification questions') ||
    combined.includes('work authorization') ||
    combined.includes('questions')
  ) {
    return { stepType: 'SCREENING_QUESTIONS', confidence: 0.8 };
  }

  // Fallback: Unknown state (Never guess)
  return { stepType: 'UNKNOWN', confidence: 0.2 };
}

export class LinkedInStepDetector {
  /**
   * Scans the active page for an Easy Apply modal dialog and detects the current step.
   */
  async detectCurrentStep(page: Page): Promise<IStepDetectionResult> {
    const puppeteerPage = page.puppeteerPage;
    if (!puppeteerPage) {
      logger.warning('Puppeteer page not attached. Cannot detect step.');
      return this.buildFallbackResult(false, 'Puppeteer page not attached');
    }

    try {
      const rawResult = await puppeteerPage.evaluate(() => {
        // 1. Locate modal dialog
        const modal = document.querySelector(
          'div[role="dialog"][aria-modal="true"], div[role="dialog"][aria-labelledby], .jobs-easy-apply-modal, div[data-test-modal]',
        ) as HTMLElement | null;

        if (!modal) {
          return {
            isModalOpen: false,
            rawHeaderText: '',
            bodySnippet: '',
            progressPercent: undefined,
            stepNumber: undefined,
            totalSteps: undefined,
            buttons: {
              hasNext: false,
              hasReview: false,
              hasSubmit: false,
              hasBack: false,
              hasDismiss: false,
            },
            errors: {
              hasError: false,
              errorMessages: [],
            },
          };
        }

        // 2. Extract semantic headings inside the modal
        const headings: string[] = [];
        const headingElements = modal.querySelectorAll('h1, h2, h3, h4, header, legend, [role="heading"]');

        headingElements.forEach(el => {
          const text = (el.textContent || '').trim();
          if (text) headings.push(text);
        });

        // Modal title specifically
        const modalTitle =
          modal.getAttribute('aria-label') ||
          modal.querySelector('h2, h3, [role="heading"]')?.textContent?.trim() ||
          '';

        const rawHeaderText = headings.length > 0 ? headings.join(' | ') : modalTitle;

        // Extract body text snippet for secondary taxonomy signals
        const bodySnippet = (modal.innerText || '').substring(0, 500);

        // 3. Progress bar detection
        let progressPercent: number | undefined;
        let stepNumber: number | undefined;
        let totalSteps: number | undefined;

        const progressBar = modal.querySelector('progress, [role="progressbar"]');
        if (progressBar) {
          const valNow = progressBar.getAttribute('aria-valuenow') || progressBar.getAttribute('value');
          if (valNow) {
            progressPercent = parseInt(valNow, 10);
          }
        }

        // Search for 'Step X of Y' in text
        const stepMatch =
          bodySnippet.match(/Step\s+(\d+)\s+of\s+(\d+)/i) || rawHeaderText.match(/Step\s+(\d+)\s+of\s+(\d+)/i);
        if (stepMatch) {
          stepNumber = parseInt(stepMatch[1], 10);
          totalSteps = parseInt(stepMatch[2], 10);
          if (totalSteps > 0 && progressPercent === undefined) {
            progressPercent = Math.round((stepNumber / totalSteps) * 100);
          }
        }

        // 4. Identify navigation action buttons
        const buttons = Array.from(modal.querySelectorAll<HTMLButtonElement>('button, [role="button"]'));

        let hasNext = false;
        let hasReview = false;
        let hasSubmit = false;
        let hasBack = false;
        let hasDismiss = false;
        let primaryActionLabel = '';

        for (const btn of buttons) {
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          const btnText = (btn.innerText || btn.textContent || '').trim().toLowerCase();
          const isVisible = btn.offsetParent !== null;

          if (!isVisible) continue;

          // Dismiss / Close
          if (
            ariaLabel.includes('dismiss') ||
            ariaLabel.includes('close') ||
            btnText === 'dismiss' ||
            btnText === 'cancel'
          ) {
            hasDismiss = true;
          }

          // Back
          if (ariaLabel.includes('back') || btnText === 'back' || btnText === 'previous') {
            hasBack = true;
          }

          // Submit Application
          if (ariaLabel.includes('submit application') || btnText === 'submit application' || btnText === 'submit') {
            hasSubmit = true;
            primaryActionLabel = 'Submit application';
          }

          // Review Application
          if (ariaLabel.includes('review') || btnText.startsWith('review')) {
            hasReview = true;
            if (!hasSubmit) primaryActionLabel = 'Review';
          }

          // Next / Continue
          if (
            ariaLabel.includes('continue to next step') ||
            ariaLabel.includes('next') ||
            btnText === 'next' ||
            btnText === 'continue'
          ) {
            hasNext = true;
            if (!hasSubmit && !hasReview) primaryActionLabel = 'Next';
          }
        }

        // 5. Detect validation errors in the modal
        const errorElements = modal.querySelectorAll(
          '[role="alert"], .artdeco-inline-feedback--error, [data-test-form-element-error-messages]',
        );

        const errorMessages: string[] = [];
        errorElements.forEach(el => {
          const text = (el.textContent || '').trim();
          if (text && !errorMessages.includes(text)) {
            errorMessages.push(text);
          }
        });

        return {
          isModalOpen: true,
          rawHeaderText,
          bodySnippet,
          progressPercent,
          stepNumber,
          totalSteps,
          buttons: {
            hasNext,
            hasReview,
            hasSubmit,
            hasBack,
            hasDismiss,
            primaryActionLabel,
          },
          errors: {
            hasError: errorMessages.length > 0,
            errorMessages,
          },
        };
      });

      if (!rawResult.isModalOpen) {
        return this.buildFallbackResult(false, 'Easy Apply modal dialog not found');
      }

      // Classify step using semantic taxonomy
      const { stepType, confidence } = classifyStepFromText(rawResult.rawHeaderText, rawResult.bodySnippet);

      // Edge case resolution: If primary action is Review and no explicit headers, likely review or questions
      let resolvedStepType = stepType;
      if (resolvedStepType === 'UNKNOWN') {
        if (rawResult.buttons.hasSubmit) {
          resolvedStepType = 'REVIEW';
        }
      }

      logger.info(
        `[StepDetector] Detected step: ${resolvedStepType} (confidence: ${confidence}). Header: "${rawResult.rawHeaderText}". Buttons: [Next:${rawResult.buttons.hasNext}, Review:${rawResult.buttons.hasReview}, Submit:${rawResult.buttons.hasSubmit}]`,
      );

      return {
        stepType: resolvedStepType,
        stepTitle: rawResult.rawHeaderText.split('|')[0]?.trim() || resolvedStepType,
        rawHeaderText: rawResult.rawHeaderText,
        progressPercent: rawResult.progressPercent,
        stepNumber: rawResult.stepNumber,
        totalSteps: rawResult.totalSteps,
        buttons: rawResult.buttons,
        errors: rawResult.errors,
        isModalOpen: true,
        confidence,
      };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error('Error during step detection:', err);
      return this.buildFallbackResult(false, `Detection failed: ${err}`);
    }
  }

  private buildFallbackResult(isModalOpen: boolean, message: string): IStepDetectionResult {
    return {
      stepType: 'UNKNOWN',
      stepTitle: message,
      rawHeaderText: '',
      buttons: {
        hasNext: false,
        hasReview: false,
        hasSubmit: false,
        hasBack: false,
        hasDismiss: false,
      },
      errors: {
        hasError: false,
        errorMessages: [],
      },
      isModalOpen,
      confidence: 0,
    };
  }
}

export const stepDetector = new LinkedInStepDetector();
