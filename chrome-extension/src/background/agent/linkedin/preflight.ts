import { backendApiClient, MINIMUM_RUN_CREDITS } from '@extension/shared';
import { DailyQuotaManager } from './rateLimiter';
import { createLogger } from '@src/background/log';

const logger = createLogger('PreflightChecker');

export interface PreflightResult {
  ok: boolean;
  statusMessage: string;
  error?: string;
  details?: {
    healthOk: boolean;
    quotaAllowed: boolean;
    remainingCredits?: number;
  };
}

export interface PreflightDeps {
  apiClient?: {
    checkHealth: () => Promise<{ status: string }>;
    getCreditsBalance: () => Promise<{ success: boolean; data?: { remainingCredits: number } }>;
    getFreshToken?: () => Promise<string | null>;
    lastRefreshStatus?: 'ok' | 'invalid' | 'unavailable' | null;
  };
  getFreshToken?: () => Promise<string | null>;
  isOnline?: () => boolean;
  quotaManager?: {
    canApplyToday: () => Promise<{
      allowed: boolean;
      currentCount: number;
      maxQuota: number;
      reason?: 'quota_exceeded' | 'error';
    }>;
  };
  minCredits?: number;
}

/**
 * Executes fail-closed preflight checks before launching an Easy Apply automation run:
 * 0. User session & fresh authentication token
 * 1. Backend API reachability (health check)
 * 2. Daily application quota check
 * 3. Credit balance sufficiency
 */
export async function runPreflight(deps?: PreflightDeps): Promise<PreflightResult> {
  const client = deps?.apiClient || backendApiClient;
  const quota = deps?.quotaManager || DailyQuotaManager;
  const threshold = deps?.minCredits ?? MINIMUM_RUN_CREDITS;

  // 0. Authentication Check & Token Refresh — Fail closed if unauthenticated or refresh fails
  const tokenGetter =
    deps?.getFreshToken ||
    (deps?.apiClient?.getFreshToken ? () => deps.apiClient!.getFreshToken!() : () => backendApiClient.getFreshToken());

  let freshToken: string | null = null;
  let tokenErr: any = null;
  try {
    freshToken = await tokenGetter();
  } catch (err: any) {
    freshToken = null;
    tokenErr = err;
  }

  if (!freshToken) {
    // Distinguish offline / backend unavailable from session invalid/expired
    const isExplicitlyOffline = deps?.isOnline
      ? !deps.isOnline()
      : typeof navigator !== 'undefined' && navigator.onLine === false;
    const isNetworkError =
      Boolean(tokenErr) &&
      (tokenErr.code === 'OFFLINE' ||
        tokenErr.code === 'NETWORK_ERROR' ||
        tokenErr.message?.toLowerCase().includes('network') ||
        tokenErr.message?.toLowerCase().includes('fetch') ||
        tokenErr.message?.toLowerCase().includes('offline') ||
        tokenErr.message?.toLowerCase().includes('connection') ||
        tokenErr.message?.toLowerCase().includes('unavailable'));

    const lastStatus = (deps?.apiClient as any)?.lastRefreshStatus ?? (backendApiClient as any)?.lastRefreshStatus;
    const isUnavailable = lastStatus === 'unavailable';

    if (isExplicitlyOffline || isNetworkError || isUnavailable) {
      const offlineMsg = 'Cannot reach the server. Check your internet connection.';
      return {
        ok: false,
        statusMessage: offlineMsg,
        error: 'NETWORK_OFFLINE',
        details: { healthOk: false, quotaAllowed: false },
      };
    }

    const msg = 'Session expired. Please sign in again.';
    return {
      ok: false,
      statusMessage: msg,
      error: 'AUTH_REQUIRED',
      details: { healthOk: false, quotaAllowed: false },
    };
  }

  // 1. Health Probe - Fail Closed on ANY error or unreachable state
  try {
    const healthRes = await client.checkHealth();
    if (!healthRes?.status && (healthRes as any)?.success !== true) {
      const msg = `🛑 Backend API health probe failed (status: ${JSON.stringify(healthRes)}). Cannot start run.`;
      return {
        ok: false,
        statusMessage: msg,
        error: 'HEALTH_CHECK_FAILED',
        details: { healthOk: false, quotaAllowed: false },
      };
    }
  } catch (healthErr: any) {
    const msg = `🛑 Backend API is unreachable (${healthErr?.message || 'Connection failed'}). Cannot start run.`;
    return {
      ok: false,
      statusMessage: msg,
      error: 'HEALTH_CHECK_UNREACHABLE',
      details: { healthOk: false, quotaAllowed: false },
    };
  }

  // 2. Daily Quota Check - Fail Closed
  let quotaCheck: { allowed: boolean; currentCount: number; maxQuota: number; reason?: 'quota_exceeded' | 'error' };
  try {
    quotaCheck = await quota.canApplyToday();
  } catch (err: any) {
    quotaCheck = { allowed: false, currentCount: 0, maxQuota: 15, reason: 'error' };
  }

  if (!quotaCheck.allowed) {
    const msg =
      quotaCheck.reason === 'error'
        ? '🛑 Could not verify daily quota with backend. Run aborted for safety.'
        : `🛑 Daily application quota reached (${quotaCheck.currentCount}/${quotaCheck.maxQuota} today). Cannot start new run.`;
    return {
      ok: false,
      statusMessage: msg,
      error: quotaCheck.reason === 'error' ? 'QUOTA_VERIFICATION_FAILED' : 'QUOTA_EXCEEDED',
      details: { healthOk: true, quotaAllowed: false },
    };
  }

  // 3. Credit Balance Check - Fail Closed on ANY error, timeout, 5xx, or insufficient credits
  try {
    const balanceCheck = await client.getCreditsBalance();
    if (!balanceCheck || !balanceCheck.success || !balanceCheck.data) {
      const msg = `🛑 Failed to verify credit balance from server. Cannot start run.`;
      return {
        ok: false,
        statusMessage: msg,
        error: 'BALANCE_INVALID_RESPONSE',
        details: { healthOk: true, quotaAllowed: true },
      };
    }
    const remaining = balanceCheck.data.remainingCredits ?? 0;
    if (remaining < threshold) {
      const msg = `🛑 Insufficient credit balance (${remaining} remaining, minimum ${threshold} required). Please top up credits.`;
      return {
        ok: false,
        statusMessage: msg,
        error: 'INSUFFICIENT_CREDITS',
        details: { healthOk: true, quotaAllowed: true, remainingCredits: remaining },
      };
    }

    return {
      ok: true,
      statusMessage: 'Preflight verification successful. Ready to run.',
      details: { healthOk: true, quotaAllowed: true, remainingCredits: remaining },
    };
  } catch (balanceErr: any) {
    const msg = `🛑 Credit balance verification failed (${balanceErr?.message || 'Server connection error'}). Cannot start run.`;
    return {
      ok: false,
      statusMessage: msg,
      error: 'BALANCE_VERIFICATION_FAILED',
      details: { healthOk: true, quotaAllowed: true },
    };
  }
}
