/**
 * The final "Submit application" click of a LinkedIn Easy Apply form.
 *
 * Submit is clicked at most ONCE per application. The outcome is one of:
 *  - success — LinkedIn confirmed it (confirmation dialog, "Applied … ago" on the job, …);
 *  - failed  — nothing was submitted: Submit missing / disabled / covered, or LinkedIn answered the
 *              click with a validation error;
 *  - unknown — Submit was clicked but no confirmation appeared in time. It is NOT clicked again (a
 *              late confirmation must not become a duplicate application). The reason text makes
 *              the application history show "Needs manual review" (see `outcomeForFailure`).
 */
import { createLogger } from '../../log';

const logger = createLogger('LinkedInSubmit');

export const LINKEDIN_SUBMIT_CONFIRM_TIMEOUT_MS = 20_000;

export type LinkedInSubmitState = 'success' | 'failed' | 'unknown';

export interface LinkedInSubmitOutcome {
  state: LinkedInSubmitState;
  reason: string;
}

/** The page operations the submitter needs (a subset of `Page`). */
export interface LinkedInSubmitPage {
  submitApplication(): Promise<{ clicked: boolean; error?: string; disabled?: boolean }>;
  verifySubmissionConfirmation(maxWaitMs?: number): Promise<{ confirmed: boolean; message?: string }>;
  validateModalFormState(): Promise<{
    hasErrors: boolean;
    errors: Array<{ fieldLabel?: string; errorText?: string }>;
    emptyRequiredFields: Array<{ label: string }>;
  }>;
}

export function unconfirmedSubmitReason(timeoutMs: number = LINKEDIN_SUBMIT_CONFIRM_TIMEOUT_MS): string {
  return `Submit was clicked but confirmation was not verified by LinkedIn within ${Math.round(
    timeoutMs / 1000,
  )}s - check LinkedIn "My jobs > Applied" (not re-submitted, to avoid a duplicate application)`;
}

export interface LinkedInSubmitter {
  /** True once Submit has been clicked for this application. */
  readonly clicked: boolean;
  /** The UNKNOWN-state reason (also used when the application budget runs out after the click). */
  readonly unknownReason: string;
  submitOnce(): Promise<LinkedInSubmitOutcome>;
}

/** One submitter per application form. */
export function createLinkedInSubmitter(
  page: LinkedInSubmitPage,
  options: { confirmTimeoutMs?: number; onClicked?: () => void } = {},
): LinkedInSubmitter {
  const confirmTimeoutMs = options.confirmTimeoutMs ?? LINKEDIN_SUBMIT_CONFIRM_TIMEOUT_MS;
  const unknownReason = unconfirmedSubmitReason(confirmTimeoutMs);
  let clicked = false;

  const missingAnswers = async (): Promise<string[]> => {
    const v = await page.validateModalFormState().catch(() => null);
    if (!v) return [];
    const labels = [
      ...(v.emptyRequiredFields || []).map(f => f.label),
      ...(v.errors || []).map(e => e.fieldLabel || ''),
    ].filter(Boolean);
    return Array.from(new Set(labels)).slice(0, 3);
  };

  return {
    get clicked() {
      return clicked;
    },
    unknownReason,
    async submitOnce(): Promise<LinkedInSubmitOutcome> {
      if (clicked) {
        // Already clicked: only look (briefly) for a late confirmation — never click again.
        const late = await page.verifySubmissionConfirmation(6000).catch(() => ({ confirmed: false, message: '' }));
        return late.confirmed
          ? { state: 'success', reason: late.message || 'confirmed' }
          : { state: 'unknown', reason: unknownReason };
      }

      const res = await page.submitApplication().catch(err => ({
        clicked: false,
        disabled: false,
        error: String((err as Error)?.message || err),
      }));
      if (!res.clicked) {
        let reason = res.error || 'Submit button could not be clicked';
        if (res.disabled) {
          const missing = await missingAnswers();
          if (missing.length > 0) reason += ` (unanswered: ${missing.join('; ')})`;
        }
        logger.warning(`[LinkedIn][Submit] Failure: ${reason}`);
        return { state: 'failed', reason };
      }

      clicked = true;
      options.onClicked?.();
      const confirm = await page
        .verifySubmissionConfirmation(confirmTimeoutMs)
        .catch(() => ({ confirmed: false, message: '' }));
      if (confirm.confirmed) {
        logger.info(`[LinkedIn][Submit] Success confirmation detected: ${confirm.message || 'confirmed'}`);
        return { state: 'success', reason: confirm.message || 'confirmed' };
      }

      // Still on the form with a validation error: LinkedIn refused the submission (nothing sent).
      const after = await page.validateModalFormState().catch(() => null);
      const firstError = after?.hasErrors ? after.errors?.[0] : undefined;
      if (firstError?.errorText) {
        const reason = `LinkedIn rejected the submission: ${firstError.fieldLabel ? `"${firstError.fieldLabel}" ` : ''}${
          firstError.errorText
        }`;
        logger.warning(`[LinkedIn][Submit] Failure: ${reason}`);
        return { state: 'failed', reason };
      }
      logger.warning(
        `[LinkedIn][Submit] Timeout: no confirmation within ${Math.round(confirmTimeoutMs / 1000)}s - not clicking again`,
      );
      return { state: 'unknown', reason: unknownReason };
    },
  };
}
