import { createLogger } from '../log';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

const logger = createLogger('LLMCircuitBreaker');

export type LiveActivityAlertEmitter = (message: string, type?: 'info' | 'fail' | 'warn' | 'success') => void;

export const LLM_UNAVAILABLE_LIVE_MESSAGE =
  'AI service is unavailable. Questions that need AI are skipped; rule-based answers still work.';

interface CircuitBreakerState {
  isAvailable: boolean;
  unavailableReason?: string;
  hasAnnouncedLiveActivity: boolean;
  consecutiveTransientFailures: number;
}

let circuitBreakerState: CircuitBreakerState = {
  isAvailable: true,
  unavailableReason: undefined,
  hasAnnouncedLiveActivity: false,
  consecutiveTransientFailures: 0,
};

let registeredLiveActivityEmitter: LiveActivityAlertEmitter | null = null;

/**
 * Resets the LLM circuit breaker at the start of a run.
 * Accepts an optional Live Activity emitter callback for the run.
 */
export function resetLlmCircuitBreaker(emitter?: LiveActivityAlertEmitter | null): void {
  circuitBreakerState = {
    isAvailable: true,
    unavailableReason: undefined,
    hasAnnouncedLiveActivity: false,
    consecutiveTransientFailures: 0,
  };
  if (emitter !== undefined) {
    registeredLiveActivityEmitter = emitter;
  }
  logger.info('[LLMCircuitBreaker] Reset for new run. LLM is available.');
}

/**
 * Registers or updates the active Live Activity emitter.
 */
export function setLlmCircuitBreakerEmitter(emitter: LiveActivityAlertEmitter | null): void {
  registeredLiveActivityEmitter = emitter;
}

/**
 * Returns true if the LLM is available for the current run, false if circuit breaker is tripped.
 */
export function isLlmAvailable(): boolean {
  return circuitBreakerState.isAvailable;
}

/**
 * Checks if an error is a permanent configuration or authentication error that warrants
 * tripping the circuit breaker immediately on 1 failure (400, 401, 403, PROVIDER_BAD_REQUEST).
 */
export function isConfigurationError(err: unknown): boolean {
  if (!err) return false;
  const status = (err as any)?.status || (err as any)?.statusCode || (err as any)?.response?.status;
  if (status === 400 || status === 401 || status === 403 || status === '400' || status === '401' || status === '403') {
    return true;
  }
  const errCode = (err as any)?.code || (err as any)?.error?.code || (err as any)?.error?.type || '';
  if (typeof errCode === 'string' && (/PROVIDER_BAD_REQUEST/i.test(errCode) || /PROVIDER_AUTH_ERROR/i.test(errCode))) {
    return true;
  }
  const msg = ((err as any)?.message || String(err || '')).toLowerCase();
  return (
    msg.includes('provider_bad_request') ||
    msg.includes('provider_auth_error') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('invalid api key')
  );
}

/**
 * Checks if an error is a 429 rate limit error.
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const status = (err as any)?.status || (err as any)?.statusCode || (err as any)?.response?.status;
  if (status === 429 || status === '429') return true;
  const code = (err as any)?.code || (err as any)?.error?.code || (err as any)?.error?.type || '';
  if (typeof code === 'string' && (/PROVIDER_RATE_LIMIT/i.test(code) || /RATE_LIMIT/i.test(code))) return true;
  const msg = ((err as any)?.message || String(err || '')).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('quota exceeded')
  );
}

/**
 * Extracts Retry-After header or delay from error, converted to milliseconds (bounded between 500ms and 5000ms).
 */
export function extractRetryAfterMs(err: unknown): number {
  if (!err) return 1000;
  const headerVal =
    (err as any)?.response?.headers?.get?.('retry-after') ||
    (err as any)?.response?.headers?.['retry-after'] ||
    (err as any)?.retryAfter ||
    (err as any)?.error?.retryAfter;
  if (headerVal !== undefined) {
    const parsed = parseFloat(String(headerVal));
    if (!isNaN(parsed) && parsed >= 0) {
      const ms = Math.round(parsed * 1000);
      return Math.min(ms, 5000);
    }
  }
  return 1000;
}

/**
 * Checks if an error warrants tripping the LLM circuit breaker:
 * PROVIDER_BAD_REQUEST, 401/403, 429, or network error (failed to fetch, timeout, connection error).
 */
export function isCircuitBreakerError(err: unknown): boolean {
  if (!err) return false;

  const status =
    (err as any)?.status || (err as any)?.statusCode || (err as any)?.response?.status || (err as any)?.code;

  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 429 ||
    status === '401' ||
    status === '403' ||
    status === '429'
  ) {
    return true;
  }

  const errCode = (err as any)?.code || (err as any)?.error?.code || (err as any)?.error?.type || '';
  if (typeof errCode === 'string' && /PROVIDER_BAD_REQUEST/i.test(errCode)) {
    return true;
  }

  const msg = ((err as any)?.message || String(err || '')).toLowerCase();
  return (
    msg.includes('provider_bad_request') ||
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('429') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('quota exceeded') ||
    msg.includes('failed to fetch') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('connection error') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('timeout') ||
    msg.includes('socket hang up')
  );
}

/**
 * Trips the circuit breaker for the remainder of the current run.
 * Emits the Live Activity warning EXACTLY ONCE per run.
 */
export function tripLlmCircuitBreaker(err?: unknown, emitter?: LiveActivityAlertEmitter | null): void {
  const errMsg = (err as any)?.message || String(err || 'LLM error');
  circuitBreakerState.isAvailable = false;
  circuitBreakerState.unavailableReason = errMsg;

  if (!circuitBreakerState.hasAnnouncedLiveActivity) {
    circuitBreakerState.hasAnnouncedLiveActivity = true;
    const activeEmitter = emitter || registeredLiveActivityEmitter;
    if (activeEmitter) {
      try {
        activeEmitter(LLM_UNAVAILABLE_LIVE_MESSAGE, 'warn');
      } catch (emitterErr) {
        logger.warning('[LLMCircuitBreaker] Failed to emit Live Activity message:', emitterErr);
      }
    }
    logger.warning(`[LLMCircuitBreaker] Tripped! ${errMsg}. Emitted: "${LLM_UNAVAILABLE_LIVE_MESSAGE}"`);
  }
}

/**
 * Wraps a BaseChatModel instance with the circuit breaker.
 * - Single 429 honors Retry-After with a short wait and 1 retry.
 * - 400/401/403 configuration errors trip the breaker immediately.
 * - Transient errors trip only after 3 consecutive failures.
 */
export function wrapChatModelWithCircuitBreaker<T extends BaseChatModel>(
  model: T,
  emitter?: LiveActivityAlertEmitter | null,
): T {
  const originalInvoke = model.invoke.bind(model);

  model.invoke = async function (input: any, options?: any) {
    if (!isLlmAvailable()) {
      const unavailableErr = new Error(
        `LLM_UNAVAILABLE: ${circuitBreakerState.unavailableReason || 'Circuit breaker is active'}`,
      );
      (unavailableErr as any).code = 'LLM_UNAVAILABLE';
      throw unavailableErr;
    }

    try {
      const result = await originalInvoke(input, options);
      circuitBreakerState.consecutiveTransientFailures = 0;
      return result;
    } catch (err) {
      // 1. Immediate trip on configuration or auth errors (400, 401, 403)
      if (isConfigurationError(err)) {
        tripLlmCircuitBreaker(err, emitter);
        throw err;
      }

      let activeError = err;

      // 2. Rate limit 429: honor Retry-After with a short wait and 1 retry
      if (isRateLimitError(err)) {
        const waitMs = extractRetryAfterMs(err);
        logger.warning(`[LLMCircuitBreaker] 429 rate limit encountered. Waiting ${waitMs}ms before 1 retry...`);
        try {
          await new Promise(r => setTimeout(r, waitMs));
          const retryResult = await originalInvoke(input, options);
          circuitBreakerState.consecutiveTransientFailures = 0;
          return retryResult;
        } catch (retryErr) {
          activeError = retryErr;
        }
      }

      // 3. Transient failure: trip ONLY after 3 consecutive failures
      if (isCircuitBreakerError(activeError)) {
        circuitBreakerState.consecutiveTransientFailures++;
        logger.warning(
          `[LLMCircuitBreaker] Transient failure ${circuitBreakerState.consecutiveTransientFailures}/3: ${(activeError as any)?.message}`,
        );
        if (circuitBreakerState.consecutiveTransientFailures >= 3) {
          tripLlmCircuitBreaker(activeError, emitter);
        }
      }

      throw activeError;
    }
  };

  return model;
}

/**
 * Executes an arbitrary async LLM operation with circuit-breaker protection.
 * Returns null if the LLM is unavailable.
 */
export async function callWithLlmCircuitBreaker<T>(
  fn: () => Promise<T>,
  emitter?: LiveActivityAlertEmitter | null,
): Promise<T | null> {
  if (!isLlmAvailable()) {
    return null;
  }
  try {
    const result = await fn();
    circuitBreakerState.consecutiveTransientFailures = 0;
    return result;
  } catch (err) {
    if (isConfigurationError(err)) {
      tripLlmCircuitBreaker(err, emitter);
      throw err;
    }

    let activeError = err;
    if (isRateLimitError(err)) {
      const waitMs = extractRetryAfterMs(err);
      logger.warning(`[LLMCircuitBreaker] 429 rate limit encountered. Waiting ${waitMs}ms before 1 retry...`);
      try {
        await new Promise(r => setTimeout(r, waitMs));
        const retryResult = await fn();
        circuitBreakerState.consecutiveTransientFailures = 0;
        return retryResult;
      } catch (retryErr) {
        activeError = retryErr;
      }
    }

    if (isCircuitBreakerError(activeError)) {
      circuitBreakerState.consecutiveTransientFailures++;
      logger.warning(
        `[LLMCircuitBreaker] Transient failure ${circuitBreakerState.consecutiveTransientFailures}/3: ${(activeError as any)?.message}`,
      );
      if (circuitBreakerState.consecutiveTransientFailures >= 3) {
        tripLlmCircuitBreaker(activeError, emitter);
      }
    }
    throw activeError;
  }
}
