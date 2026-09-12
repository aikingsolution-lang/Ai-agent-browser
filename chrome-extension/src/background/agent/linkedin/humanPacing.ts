/**
 * LinkedIn Easy Apply — Human-Mimicry & Natural Pacing
 *
 * Implements non-uniform, Log-Normal and Poisson-distributed delays to evade
 * heuristic bot detection patterns. Provides realistic per-character typing
 * simulations that dispatch full native input event sequences.
 */

import { createLogger } from '@src/background/log';
import type Page from '@src/background/browser/page';

const logger = createLogger('LinkedInHumanPacing');

/**
 * Generates a random number from a standard normal distribution (Box-Muller transform).
 */
function randomStandardNormal(): number {
  let u1 = 0;
  let u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

/**
 * Samples a delay (in ms) from a Log-Normal distribution.
 * Log-normal distributions model human task reaction times with a natural right-skew.
 *
 * @param medianMs - Target median delay
 * @param sigma - Shape/dispersion parameter (typically 0.3 - 0.5)
 * @param minMs - Absolute minimum delay
 * @param maxMs - Absolute maximum delay
 */
export function getLogNormalDelay(
  medianMs: number,
  sigma = 0.35,
  minMs = medianMs * 0.5,
  maxMs = medianMs * 2.5,
): number {
  const mu = Math.log(medianMs);
  const z = randomStandardNormal();
  const sample = Math.exp(mu + sigma * z);
  return Math.round(Math.max(minMs, Math.min(maxMs, sample)));
}

/**
 * Inter-Application Delay:
 * Generates a realistic delay between consecutive job applications (median ~45s, range 25s - 120s).
 */
export function getInterJobDelay(): number {
  return getLogNormalDelay(45000, 0.45, 25000, 120000);
}

/**
 * Inter-Action Delay:
 * Generates a realistic delay between micro-actions like clicking buttons or selecting options (median 1.5s, range 800ms - 3500ms).
 */
export function getActionDelay(): number {
  return getLogNormalDelay(1500, 0.35, 800, 3500);
}

export class HumanPacingSimulator {
  /**
   * Pauses execution for a Log-Normal sampled action delay.
   */
  static async naturalActionPause(medianMs = 1500): Promise<number> {
    const delay = getLogNormalDelay(medianMs);
    await new Promise(resolve => setTimeout(resolve, delay));
    return delay;
  }

  /**
   * Pauses execution between job applications with long-tail human-like pacing.
   */
  static async interJobPause(): Promise<number> {
    const delay = getInterJobDelay();
    logger.info(`[HumanPacing] Natural pacing pause between jobs: ${(delay / 1000).toFixed(1)}s`);
    await new Promise(resolve => setTimeout(resolve, delay));
    return delay;
  }

  /**
   * Simulates realistic human typing on a DOM input element.
   * Types characters one by one with varying per-keystroke delays (50ms - 150ms)
   * and micro-pauses at word boundaries, firing real DOM input events.
   */
  static async simulateHumanTyping(page: Page, selector: string, text: string): Promise<boolean> {
    const puppeteerPage = page.puppeteerPage;
    if (!puppeteerPage) return false;

    try {
      // Focus and clear input first
      await puppeteerPage.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
        if (el) {
          el.focus();
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, selector);

      // Type each character with non-uniform delays
      for (let i = 0; i < text.length; i++) {
        const char = text[i];

        await puppeteerPage.evaluate(
          (sel: string, character: string) => {
            const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
            if (!el) return;

            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              el instanceof HTMLTextAreaElement
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype,
              'value',
            )?.set;

            const nextValue = (el.value || '') + character;
            if (nativeInputValueSetter) {
              nativeInputValueSetter.call(el, nextValue);
            } else {
              el.value = nextValue;
            }

            el.dispatchEvent(new KeyboardEvent('keydown', { key: character, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keypress', { key: character, bubbles: true }));
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: character, bubbles: true }));
          },
          selector,
          char,
        );

        // Per-keystroke typing delay (Gaussian 60ms - 140ms)
        let strokeDelay = getLogNormalDelay(85, 0.25, 45, 160);

        // Occasional micro-pause at word boundaries (spaces/punctuation)
        if (char === ' ' || char === '.' || char === ',') {
          strokeDelay += getLogNormalDelay(200, 0.3, 100, 400);
        }

        await new Promise(resolve => setTimeout(resolve, strokeDelay));
      }

      // Final change event
      await puppeteerPage.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
        if (el) {
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur();
        }
      }, selector);

      return true;
    } catch (err) {
      logger.warning(`Failed to simulate human typing for "${selector}":`, err);
      return false;
    }
  }
}
