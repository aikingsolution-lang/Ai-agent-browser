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
}

let circuitBreakerState: CircuitBreakerState = {
  isAvailable: true,
  unavailableReason: undefined,
  hasAnnouncedLiveActivity: false,
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
 * If the circuit breaker is tripped, any invocation rejects immediately without contacting the LLM.
 * If invocation fails with a circuit breaker error, trips the circuit breaker for the current run.
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
      return await originalInvoke(input, options);
    } catch (err) {
      if (isCircuitBreakerError(err)) {
        tripLlmCircuitBreaker(err, emitter);
      }
      throw err;
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
    return await fn();
  } catch (err) {
    if (isCircuitBreakerError(err)) {
      tripLlmCircuitBreaker(err, emitter);
    }
    throw err;
  }
}
