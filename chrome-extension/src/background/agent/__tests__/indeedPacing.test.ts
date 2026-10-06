import { describe, it, expect } from 'vitest';
import { indeedPacing, INDEED_PACING_CONFIG } from '../platforms/indeed/indeedPacing';

describe('IndeedPacing - Phase 4', () => {
  describe('Delay Range Validation', () => {
    it('JOB_TO_JOB delay is between 5,000ms and 12,000ms across multiple iterations', () => {
      for (let i = 0; i < 50; i++) {
        const delay = indeedPacing.getJobToJobDelay();
        expect(delay).toBeGreaterThanOrEqual(INDEED_PACING_CONFIG.JOB_TO_JOB.minMs);
        expect(delay).toBeLessThanOrEqual(INDEED_PACING_CONFIG.JOB_TO_JOB.maxMs);
      }
    });

    it('STEP_TRANSITION delay is between 1,200ms and 2,800ms across multiple iterations', () => {
      for (let i = 0; i < 50; i++) {
        const delay = indeedPacing.getStepTransitionDelay();
        expect(delay).toBeGreaterThanOrEqual(INDEED_PACING_CONFIG.STEP_TRANSITION.minMs);
        expect(delay).toBeLessThanOrEqual(INDEED_PACING_CONFIG.STEP_TRANSITION.maxMs);
      }
    });

    it('FIELD_INTERACTION delay is between 350ms and 900ms across multiple iterations', () => {
      for (let i = 0; i < 50; i++) {
        const delay = indeedPacing.getFieldInteractionDelay();
        expect(delay).toBeGreaterThanOrEqual(INDEED_PACING_CONFIG.FIELD_INTERACTION.minMs);
        expect(delay).toBeLessThanOrEqual(INDEED_PACING_CONFIG.FIELD_INTERACTION.maxMs);
      }
    });

    it('KEYSTROKE_JITTER delay is between 35ms and 110ms across multiple iterations', () => {
      for (let i = 0; i < 50; i++) {
        const delay = indeedPacing.getKeystrokeDelay();
        expect(delay).toBeGreaterThanOrEqual(INDEED_PACING_CONFIG.KEYSTROKE_JITTER.minMs);
        expect(delay).toBeLessThanOrEqual(INDEED_PACING_CONFIG.KEYSTROKE_JITTER.maxMs);
      }
    });

    it('PAGE_SETTLE delay is between 4,000ms and 7,000ms across multiple iterations', () => {
      for (let i = 0; i < 50; i++) {
        const delay = indeedPacing.getPageSettleDelay();
        expect(delay).toBeGreaterThanOrEqual(INDEED_PACING_CONFIG.PAGE_SETTLE.minMs);
        expect(delay).toBeLessThanOrEqual(INDEED_PACING_CONFIG.PAGE_SETTLE.maxMs);
      }
    });

    it('exceeds LinkedIn baseline job-to-job delay (LinkedIn max is 10s, Indeed max is 12s)', () => {
      expect(INDEED_PACING_CONFIG.JOB_TO_JOB.maxMs).toBeGreaterThanOrEqual(12_000);
      expect(INDEED_PACING_CONFIG.JOB_TO_JOB.minMs).toBeGreaterThanOrEqual(5_000);
    });
  });

  describe('sleepPacing with AbortSignal', () => {
    it('aborts immediately when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await indeedPacing.sleepPacing({ minMs: 5000, maxMs: 10000 }, controller.signal);
      expect(result.wasAborted).toBe(true);
      expect(result.delayMs).toBe(0);
    });

    it('can be aborted mid-sleep', async () => {
      const controller = new AbortController();
      const promise = indeedPacing.sleepPacing({ minMs: 2000, maxMs: 3000 }, controller.signal);

      // Abort after 20ms
      setTimeout(() => controller.abort(), 20);

      const result = await promise;
      expect(result.wasAborted).toBe(true);
    });
  });
});
