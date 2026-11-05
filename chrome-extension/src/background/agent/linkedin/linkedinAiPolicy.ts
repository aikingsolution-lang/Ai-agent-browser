/**
 * AI call policy for LinkedIn Easy Apply form filling.
 *
 * Why: the LinkedIn form flow asks Gemini (through the backend) several times per form, and its
 * model was created with LangChain's default retry policy — an HTTP 429 is retried up to 6 times
 * with exponential backoff, i.e. one rate-limited request could hold the form for 1–2 minutes
 * before failing ("Application in progress" with nothing happening).
 *
 * Policy (LinkedIn form flow only — Naukri / Indeed keep their own models):
 *  - every call is bounded by a timeout and is never retried here;
 *  - an HTTP 429 / quota error pauses AI for a cooldown (30 s, 60 s, then 120 s) instead of
 *    re-sending the request; while paused, calls fail at once (no network) and the resolver uses
 *    Career Brain / resume / approved answers;
 *  - calls, 429s, timeouts and skips are counted per application for the run log.
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { isRateLimitError } from '../llmCircuitBreaker';
import { createLogger } from '../../log';

const logger = createLogger('LinkedInAI');

export const LINKEDIN_AI_CALL_TIMEOUT_MS = 25_000;
const RATE_LIMIT_COOLDOWNS_MS = [30_000, 60_000, 120_000];

export interface LinkedInAiStats {
  calls: number;
  succeeded: number;
  rateLimited: number;
  timedOut: number;
  failed: number;
  skippedWhilePaused: number;
}

const emptyStats = (): LinkedInAiStats => ({
  calls: 0,
  succeeded: 0,
  rateLimited: 0,
  timedOut: 0,
  failed: 0,
  skippedWhilePaused: 0,
});

let pausedUntil = 0;
let consecutiveRateLimits = 0;
let stats: LinkedInAiStats = emptyStats();

/** Starts a fresh per-application count (the 429 pause itself carries over: it is account-wide). */
export function resetLinkedInAiStats(): void {
  stats = emptyStats();
}

export function getLinkedInAiStats(): LinkedInAiStats {
  return { ...stats };
}

export function linkedInAiPauseRemainingMs(now: number = Date.now()): number {
  return Math.max(0, pausedUntil - now);
}

export function isLinkedInAiPaused(now: number = Date.now()): boolean {
  return pausedUntil > now;
}

/** Clears the pause and counters (start of a run, tests). */
export function resetLinkedInAiPolicy(): void {
  pausedUntil = 0;
  consecutiveRateLimits = 0;
  stats = emptyStats();
}

export function formatLinkedInAiStats(s: LinkedInAiStats = stats): string {
  return `${s.calls} AI request(s): ${s.succeeded} ok, ${s.rateLimited} rate-limited (429), ${s.timedOut} timed out, ${s.failed} failed, ${s.skippedWhilePaused} skipped while paused`;
}

function isTimeoutError(err: unknown): boolean {
  const name = String((err as { name?: string })?.name || '');
  const msg = String((err as { message?: string })?.message || err || '').toLowerCase();
  return name === 'AbortError' || name === 'TimeoutError' || /\baborted\b|timed out|timeout/.test(msg);
}

/** Thrown instead of sending a request while AI is paused after a 429. */
export class LinkedInAiPausedError extends Error {
  readonly status = 429;
  readonly code = 'LINKEDIN_AI_PAUSED';
  constructor(remainingMs: number) {
    super(
      `429 rate limit: AI paused for ${Math.ceil(remainingMs / 1000)}s after a Gemini rate limit (request not sent)`,
    );
    this.name = 'LinkedInAiPausedError';
  }
}

/**
 * Applies the policy to a chat model in place (idempotent) and returns it. Only `invoke` is
 * wrapped — it is the only entry point the LinkedIn resolver uses.
 */
export function wrapLinkedInAiModel<T extends BaseChatModel>(
  model: T,
  timeoutMs: number = LINKEDIN_AI_CALL_TIMEOUT_MS,
): T {
  const tagged = model as T & { __linkedInAiPolicy?: boolean };
  if (tagged.__linkedInAiPolicy) return model;
  const original = model.invoke.bind(model);
  (model as unknown as { invoke: (input: unknown, options?: Record<string, unknown>) => Promise<unknown> }).invoke =
    async (input: unknown, options?: Record<string, unknown>) => {
      const remaining = linkedInAiPauseRemainingMs();
      if (remaining > 0) {
        stats.skippedWhilePaused++;
        throw new LinkedInAiPausedError(remaining);
      }
      stats.calls++;
      try {
        const result = await original(
          input as Parameters<typeof original>[0],
          {
            ...(options || {}),
            timeout: timeoutMs,
          } as Parameters<typeof original>[1],
        );
        stats.succeeded++;
        consecutiveRateLimits = 0;
        return result;
      } catch (err) {
        if (isRateLimitError(err)) {
          stats.rateLimited++;
          const cooldown = RATE_LIMIT_COOLDOWNS_MS[Math.min(consecutiveRateLimits, RATE_LIMIT_COOLDOWNS_MS.length - 1)];
          consecutiveRateLimits++;
          pausedUntil = Date.now() + cooldown;
          logger.warning(
            `[LinkedIn][AI] Gemini 429 - retry skipped; AI paused ${cooldown / 1000}s (answers continue from Career Brain / resume / approved answers)`,
          );
        } else if (isTimeoutError(err)) {
          stats.timedOut++;
          logger.warning(`[LinkedIn][AI] Request timed out after ${timeoutMs / 1000}s - not retried`);
        } else {
          stats.failed++;
        }
        throw err;
      }
    };
  tagged.__linkedInAiPolicy = true;
  return model;
}
