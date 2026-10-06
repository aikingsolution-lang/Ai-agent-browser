// chrome-extension/src/background/agent/platforms/indeed/indeedPacing.ts

export interface DelayRange {
  minMs: number;
  maxMs: number;
}

/**
 * Named delay constants for Indeed auto-apply pacing.
 * Configured to exceed LinkedIn's baseline due to Indeed's aggressive Cloudflare/bot challenge heuristics.
 */
export const INDEED_PACING_CONFIG = {
  /**
   * Randomized pause between consecutive job applications (5 - 12 seconds).
   * Exceeds LinkedIn's 5 - 10 second baseline.
   */
  JOB_TO_JOB: { minMs: 5_000, maxMs: 12_000 } as DelayRange,

  /**
   * Randomized delay before clicking 'Continue' / transitioning form steps (1.2 - 2.8 seconds).
   */
  STEP_TRANSITION: { minMs: 1_200, maxMs: 2_800 } as DelayRange,

  /**
   * Randomized delay between interacting with individual form inputs (350ms - 900ms).
   */
  FIELD_INTERACTION: { minMs: 350, maxMs: 900 } as DelayRange,

  /**
   * Human-like typing jitter delay per character (35ms - 110ms).
   */
  KEYSTROKE_JITTER: { minMs: 35, maxMs: 110 } as DelayRange,

  /**
   * Initial pause after navigating to an Indeed job page or opening application modal (4s - 7s).
   */
  PAGE_SETTLE: { minMs: 4_000, maxMs: 7_000 } as DelayRange,
} as const;

export class IndeedPacing {
  /**
   * Calculates a randomized delay in milliseconds within the specified min/max bounds.
   */
  public getRandomDelay(range: DelayRange): number {
    const min = Math.min(range.minMs, range.maxMs);
    const max = Math.max(range.minMs, range.maxMs);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  public getJobToJobDelay(): number {
    return this.getRandomDelay(INDEED_PACING_CONFIG.JOB_TO_JOB);
  }

  public getStepTransitionDelay(): number {
    return this.getRandomDelay(INDEED_PACING_CONFIG.STEP_TRANSITION);
  }

  public getFieldInteractionDelay(): number {
    return this.getRandomDelay(INDEED_PACING_CONFIG.FIELD_INTERACTION);
  }

  public getKeystrokeDelay(): number {
    return this.getRandomDelay(INDEED_PACING_CONFIG.KEYSTROKE_JITTER);
  }

  public getPageSettleDelay(): number {
    return this.getRandomDelay(INDEED_PACING_CONFIG.PAGE_SETTLE);
  }

  /**
   * Asynchronously sleeps for a randomized duration matching the delay category,
   * respecting any provided AbortSignal.
   * @returns true if aborted, false if sleep completed normally
   */
  public async sleepPacing(range: DelayRange, signal?: AbortSignal): Promise<{ delayMs: number; wasAborted: boolean }> {
    const delayMs = this.getRandomDelay(range);
    if (!signal) {
      await new Promise(r => setTimeout(r, delayMs));
      return { delayMs, wasAborted: false };
    }

    if (signal.aborted) {
      return { delayMs: 0, wasAborted: true };
    }

    return new Promise(resolve => {
      let timer: any = null;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        resolve({ delayMs, wasAborted: true });
      };

      timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve({ delayMs, wasAborted: false });
      }, delayMs);

      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  public async waitPageSettle(signal?: AbortSignal): Promise<{ delayMs: number; wasAborted: boolean }> {
    return this.sleepPacing(INDEED_PACING_CONFIG.PAGE_SETTLE, signal);
  }

  public async waitStepTransition(signal?: AbortSignal): Promise<{ delayMs: number; wasAborted: boolean }> {
    return this.sleepPacing(INDEED_PACING_CONFIG.STEP_TRANSITION, signal);
  }

  public async waitFieldInteraction(
    signal?: AbortSignal,
    minMs?: number,
    maxMs?: number,
  ): Promise<{ delayMs: number; wasAborted: boolean }> {
    const range: DelayRange =
      minMs !== undefined && maxMs !== undefined ? { minMs, maxMs } : INDEED_PACING_CONFIG.FIELD_INTERACTION;
    return this.sleepPacing(range, signal);
  }

  public async waitJobToJob(signal?: AbortSignal): Promise<{ delayMs: number; wasAborted: boolean }> {
    return this.sleepPacing(INDEED_PACING_CONFIG.JOB_TO_JOB, signal);
  }
}

export const indeedPacing = new IndeedPacing();
