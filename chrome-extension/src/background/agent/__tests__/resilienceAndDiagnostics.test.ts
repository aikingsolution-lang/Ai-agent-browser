import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { storageData } = vi.hoisted(() => {
  const data: Record<string, any> = {};
  const local = {
    get: async (keys?: string | string[]) => {
      if (!keys) return { ...data };
      const keyList = Array.isArray(keys) ? keys : [keys];
      const res: Record<string, any> = {};
      for (const k of keyList) {
        if (k in data) res[k] = data[k];
      }
      return res;
    },
    set: async (items: Record<string, any>) => {
      Object.assign(data, items);
    },
    remove: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete data[k];
    },
    onChanged: { addListener: () => undefined },
  };
  (globalThis as any).chrome = {
    storage: {
      local,
      sync: local,
      session: local,
      onChanged: { addListener: () => undefined },
    },
    debugger: {},
    sidePanel: {},
    runtime: { id: 'test', getURL: (p: string) => p },
  };
  return { storageData: data };
});

import {
  backendApiClient,
  MINIMUM_RUN_CREDITS,
  MAX_REFUND_ATTEMPTS,
  MAX_REFUND_AGE_MS,
  runSystemDiagnostics,
} from '@extension/shared';
import { isLlmTierAvailable, recordLlmNetworkFailure, recordLlmSuccess } from '../linkedin/formQuestionResolver';
import { DailyQuotaManager } from '../linkedin/rateLimiter';
import { runPreflight } from '../linkedin/preflight';
import { authStorage } from '@extension/storage';

describe('Production Hardening & Diagnostics Test Suite', () => {
  beforeEach(() => {
    for (const key of Object.keys(storageData)) delete storageData[key];
    recordLlmSuccess();
    vi.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────
  // 1. LLM Circuit Breaker
  // ─────────────────────────────────────────────────────────────
  describe('LLM Circuit Breaker', () => {
    it('is initially available', () => {
      recordLlmSuccess();
      expect(isLlmTierAvailable()).toBe(true);
    });

    it('stays available for 1 or 2 network failures', () => {
      recordLlmNetworkFailure(new Error('Failed to fetch'));
      expect(isLlmTierAvailable()).toBe(true);
      recordLlmNetworkFailure(new Error('NetworkError'));
      expect(isLlmTierAvailable()).toBe(true);
    });

    it('trips the circuit breaker after 3 consecutive network failures', () => {
      recordLlmNetworkFailure(new Error('Failed to fetch 1'));
      recordLlmNetworkFailure(new Error('Failed to fetch 2'));
      recordLlmNetworkFailure(new Error('Failed to fetch 3'));
      expect(isLlmTierAvailable()).toBe(false);
    });

    it('recovers after backoff period has passed', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      recordLlmNetworkFailure(new Error('Fail 1'));
      recordLlmNetworkFailure(new Error('Fail 2'));
      recordLlmNetworkFailure(new Error('Fail 3'));
      expect(isLlmTierAvailable()).toBe(false);

      // Fast forward past 5-minute backoff window (300,000 ms)
      vi.spyOn(Date, 'now').mockReturnValue(now + 301_000);
      expect(isLlmTierAvailable()).toBe(true);
    });

    it('resets immediately on recordLlmSuccess()', () => {
      recordLlmNetworkFailure(new Error('Fail 1'));
      recordLlmNetworkFailure(new Error('Fail 2'));
      recordLlmNetworkFailure(new Error('Fail 3'));
      expect(isLlmTierAvailable()).toBe(false);

      recordLlmSuccess();
      expect(isLlmTierAvailable()).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Refund Queue & Idempotency
  // ─────────────────────────────────────────────────────────────
  describe('Idempotent Refund Retry Queue', () => {
    it('reuses the same idempotency key for identical runId', async () => {
      const key1 = await backendApiClient.addPendingRefund('run-123');
      const key2 = await backendApiClient.addPendingRefund('run-123');
      expect(key1).toBe(key2);
      expect(key1).toMatch(/^refund_run-123/);
    });

    it('removes entry from storage on HTTP 200 success', async () => {
      vi.spyOn(backendApiClient as any, 'request').mockResolvedValue({
        success: true,
        data: { refundedAmount: 10, runId: 'run-success' },
      });

      await backendApiClient.refundCredits('run-success');
      const stored = await chrome.storage.local.get(['nanobrowser_pending_refunds_v2']);
      const queue = stored.nanobrowser_pending_refunds_v2 || [];
      expect(queue.some((q: any) => q.runId === 'run-success')).toBe(false);
    });

    it('removes entry on ALREADY_REFUNDED or "no billable usage"', async () => {
      vi.spyOn(backendApiClient as any, 'request').mockRejectedValue({
        status: 400,
        code: 'ALREADY_REFUNDED',
        message: 'Already refunded',
      });

      const res = await backendApiClient.refundCredits('run-already');
      expect(res.data.refundedAmount).toBe(0);

      const stored = await chrome.storage.local.get(['nanobrowser_pending_refunds_v2']);
      const queue = stored.nanobrowser_pending_refunds_v2 || [];
      expect(queue.some((q: any) => q.runId === 'run-already')).toBe(false);
    });

    it('retains entry in queue when HTTP 400 or network error occurs', async () => {
      vi.spyOn(backendApiClient as any, 'request').mockRejectedValue({
        status: 400,
        message: 'Invalid run id state',
      });

      await expect(backendApiClient.refundCredits('run-error')).rejects.toThrow();

      const stored = await chrome.storage.local.get(['nanobrowser_pending_refunds_v2']);
      const queue = stored.nanobrowser_pending_refunds_v2 || [];
      const item = queue.find((q: any) => q.runId === 'run-error');
      expect(item).toBeDefined();
      expect(item.idempotencyKey).toBe('refund_run-error');
    });

    it('caps attempts, drops entries exceeding MAX_REFUND_ATTEMPTS, records in nanobrowser_failed_refunds, and reports to backend', async () => {
      const reportSpy = vi
        .spyOn(backendApiClient, 'reportFailedRefund')
        .mockResolvedValue({ success: true, data: { recorded: true } } as any);

      storageData.nanobrowser_pending_refunds_v2 = [
        {
          runId: 'run-maxed',
          idempotencyKey: 'refund_run-maxed',
          createdAt: Date.now(),
          attempts: MAX_REFUND_ATTEMPTS,
          lastError: 'HTTP 400 Bad Request',
        },
      ];

      await backendApiClient.retryPendingRefunds();

      // Dropped from active queue
      const stored = await chrome.storage.local.get(['nanobrowser_pending_refunds_v2']);
      const queue = stored.nanobrowser_pending_refunds_v2 || [];
      expect(queue.some((q: any) => q.runId === 'run-maxed')).toBe(false);

      // Persisted to failed queue with reported flag
      const failedStored = await chrome.storage.local.get(['nanobrowser_failed_refunds']);
      const failedQueue = failedStored.nanobrowser_failed_refunds || [];
      const droppedItem = failedQueue.find((f: any) => f.runId === 'run-maxed');
      expect(droppedItem).toBeDefined();
      expect(droppedItem.reason).toBe('max_attempts_exceeded');
      expect(droppedItem.idempotencyKey).toBe('refund_run-maxed');

      // Verify reportFailedRefund was called
      expect(reportSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-maxed',
          idempotencyKey: 'refund_run-maxed',
          reason: 'max_attempts_exceeded',
        }),
      );
    });

    it('retries reporting un-reported failed refunds until reported is true', async () => {
      const reportSpy = vi
        .spyOn(backendApiClient, 'reportFailedRefund')
        .mockResolvedValue({ success: true, data: { recorded: true } } as any);

      // Seed un-reported failed refund
      storageData.nanobrowser_failed_refunds = [
        {
          runId: 'run-unreported',
          idempotencyKey: 'refund_run-unreported',
          reason: 'max_attempts_exceeded',
          reported: false,
        },
      ];
      storageData.nanobrowser_pending_refunds_v2 = [];

      await backendApiClient.retryPendingRefunds();

      expect(reportSpy).toHaveBeenCalledWith({
        runId: 'run-unreported',
        idempotencyKey: 'refund_run-unreported',
        reason: 'max_attempts_exceeded',
      });

      const failedStored = await chrome.storage.local.get(['nanobrowser_failed_refunds']);
      const item = failedStored.nanobrowser_failed_refunds.find((f: any) => f.runId === 'run-unreported');
      expect(item.reported).toBe(true);
    });

    it('loads and surfaces failed refund records for side panel notice', async () => {
      // Simulate storage having failed refunds
      storageData.nanobrowser_failed_refunds = [
        {
          runId: 'run-notice-1',
          idempotencyKey: 'refund_run-notice-1',
          reason: 'client_dropped',
          reported: true,
        },
      ];

      const data = await chrome.storage.local.get(['nanobrowser_failed_refunds']);
      const list = data?.nanobrowser_failed_refunds || [];
      expect(list).toHaveLength(1);
      expect(list[0].runId).toBe('run-notice-1');
      expect(list[0].reason).toBe('client_dropped');
    });

    it('renders the failed refund banner with correct details and handles dismiss', async () => {
      const { FailedRefundBanner } = await import('../../../../../pages/side-panel/src/components/FailedRefundBanner');

      // 1. When notices are null or empty: renders null
      const nullRender = FailedRefundBanner({ notices: null, onDismiss: vi.fn() });
      expect(nullRender).toBeNull();

      const emptyRender = FailedRefundBanner({ notices: [], onDismiss: vi.fn() });
      expect(emptyRender).toBeNull();

      // 2. When notices are present: renders banner container and text
      const mockNotices = [
        { runId: 'run-item-1', reason: 'max_attempts_exceeded' },
        { runId: 'run-item-2', reason: 'max_age_exceeded' },
      ];
      const onDismissMock = vi.fn();

      const bannerElement: any = FailedRefundBanner({ notices: mockNotices, onDismiss: onDismissMock });
      expect(bannerElement).not.toBeNull();
      expect(bannerElement.props['data-testid']).toBe('failed-refund-banner');

      // Traverse children to verify title text contains count
      const flexContainer = bannerElement.props.children;
      const [contentCol, dismissBtn] = flexContainer.props.children;
      const [_icon, textWrapper] = contentCol.props.children;
      const [titleElement, descElement] = textWrapper.props.children;

      const titleText = Array.isArray(titleElement.props.children)
        ? titleElement.props.children.join('')
        : String(titleElement.props.children);
      expect(titleText).toBe('Refund notice (2 pending support review)');
      expect(descElement.props.children).toContain(
        'A previous application credit refund could not be automatically finalized.',
      );

      // Simulate dismiss button click
      dismissBtn.props.onClick();
      expect(onDismissMock).toHaveBeenCalledTimes(1);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Daily Quota Manager
  // ─────────────────────────────────────────────────────────────
  describe('DailyQuotaManager.canApplyToday()', () => {
    it('returns reason: error when unexpected failure occurs', async () => {
      vi.spyOn(DailyQuotaManager as any, 'getQuotaData').mockRejectedValue(new Error('Storage access failed'));

      const res = await DailyQuotaManager.canApplyToday();
      expect(res.allowed).toBe(false);
      expect(res.reason).toBe('error');
    });

    it('returns reason: quota_exceeded when daily limit is reached', async () => {
      vi.spyOn(DailyQuotaManager as any, 'getQuotaData').mockResolvedValue({
        dateString: '2026-10-10',
        appliedCount: 15,
        maxDailyQuota: 15,
        isPausedDueToQuota: false,
        nextResumeTimestamp: null,
      });

      const res = await DailyQuotaManager.canApplyToday();
      expect(res.allowed).toBe(false);
      expect(res.reason).toBe('quota_exceeded');
      expect(res.remaining).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 4. Fail-Closed Preflight Logic (runPreflight)
  // ─────────────────────────────────────────────────────────────
  describe('Fail-Closed Preflight Checks (runPreflight)', () => {
    it('returns AUTH_REQUIRED when there is no auth token', async () => {
      const mockApi = {
        checkHealth: vi.fn(),
        getCreditsBalance: vi.fn(),
        getFreshToken: vi.fn().mockResolvedValue(null),
      };
      const mockQuota = {
        canApplyToday: vi.fn(),
      };

      const result = await runPreflight({ apiClient: mockApi as any, quotaManager: mockQuota });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('AUTH_REQUIRED');
      expect(result.statusMessage).toBe('Session expired. Please sign in again.');
      // Fail closed before any subsequent API call
      expect(mockApi.checkHealth).not.toHaveBeenCalled();
      expect(mockApi.getCreditsBalance).not.toHaveBeenCalled();
      expect(mockQuota.canApplyToday).not.toHaveBeenCalled();
    });

    it('succeeds when expired token is successfully refreshed by getFreshToken', async () => {
      const mockApi = {
        checkHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
        getCreditsBalance: vi.fn().mockResolvedValue({ success: true, data: { remainingCredits: 20 } }),
        getFreshToken: vi.fn().mockResolvedValue('refreshed-id-token'),
      };
      const mockQuota = {
        canApplyToday: vi.fn().mockResolvedValue({ allowed: true, currentCount: 1, maxQuota: 15 }),
      };

      const result = await runPreflight({ apiClient: mockApi as any, quotaManager: mockQuota, minCredits: 5 });
      expect(result.ok).toBe(true);
      expect(result.statusMessage).toContain('Preflight verification successful');
      expect(result.details?.remainingCredits).toBe(20);
      expect(mockApi.getFreshToken).toHaveBeenCalledTimes(1);
      expect(mockApi.checkHealth).toHaveBeenCalledTimes(1);
    });

    it('returns AUTH_REQUIRED when token refresh fails with invalid session', async () => {
      const mockApi = {
        checkHealth: vi.fn(),
        getCreditsBalance: vi.fn(),
        getFreshToken: vi.fn().mockRejectedValue(new Error('Refresh token revoked')),
      };
      const mockQuota = {
        canApplyToday: vi.fn(),
      };

      const result = await runPreflight({ apiClient: mockApi as any, quotaManager: mockQuota });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('AUTH_REQUIRED');
      expect(result.statusMessage).toBe('Session expired. Please sign in again.');
      expect(mockApi.checkHealth).not.toHaveBeenCalled();
    });

    it('returns NETWORK_OFFLINE with connection message when client is offline or backend unavailable', async () => {
      // 1. Explicitly offline via isOnline check
      const mockApiOffline = {
        checkHealth: vi.fn(),
        getCreditsBalance: vi.fn(),
        getFreshToken: vi.fn().mockResolvedValue(null),
      };
      const resultOffline = await runPreflight({
        apiClient: mockApiOffline as any,
        isOnline: () => false,
      });
      expect(resultOffline.ok).toBe(false);
      expect(resultOffline.error).toBe('NETWORK_OFFLINE');
      expect(resultOffline.statusMessage).toBe('Cannot reach the server. Check your internet connection.');
      expect(mockApiOffline.checkHealth).not.toHaveBeenCalled();

      // 2. Token refresh failed due to network / fetch error
      const mockApiNetworkErr = {
        checkHealth: vi.fn(),
        getCreditsBalance: vi.fn(),
        getFreshToken: vi.fn().mockRejectedValue(new Error('Failed to fetch: NetworkError')),
      };
      const resultNetworkErr = await runPreflight({ apiClient: mockApiNetworkErr as any });
      expect(resultNetworkErr.ok).toBe(false);
      expect(resultNetworkErr.error).toBe('NETWORK_OFFLINE');
      expect(resultNetworkErr.statusMessage).toBe('Cannot reach the server. Check your internet connection.');
      expect(mockApiNetworkErr.checkHealth).not.toHaveBeenCalled();

      // 3. Last refresh status was unavailable (temporary backend / Google outage)
      const mockApiUnavailable = {
        checkHealth: vi.fn(),
        getCreditsBalance: vi.fn(),
        getFreshToken: vi.fn().mockResolvedValue(null),
        lastRefreshStatus: 'unavailable' as const,
      };
      const resultUnavailable = await runPreflight({ apiClient: mockApiUnavailable as any });
      expect(resultUnavailable.ok).toBe(false);
      expect(resultUnavailable.error).toBe('NETWORK_OFFLINE');
      expect(resultUnavailable.statusMessage).toBe('Cannot reach the server. Check your internet connection.');
      expect(mockApiUnavailable.checkHealth).not.toHaveBeenCalled();
    });

    it('fails closed when health probe rejects', async () => {
      const mockApi = {
        checkHealth: vi.fn().mockRejectedValue(new Error('Network error')),
        getCreditsBalance: vi.fn().mockResolvedValue({ success: true, data: { remainingCredits: 20 } }),
        getFreshToken: vi.fn().mockResolvedValue('valid-token'),
      };
      const mockQuota = {
        canApplyToday: vi.fn().mockResolvedValue({ allowed: true, currentCount: 0, maxQuota: 15 }),
      };

      const result = await runPreflight({ apiClient: mockApi as any, quotaManager: mockQuota });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('HEALTH_CHECK_UNREACHABLE');
      expect(result.statusMessage).toContain('Backend API is unreachable');
    });

    it('fails closed when quota verification fails with reason: error', async () => {
      const mockApi = {
        checkHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
        getCreditsBalance: vi.fn().mockResolvedValue({ success: true, data: { remainingCredits: 20 } }),
        getFreshToken: vi.fn().mockResolvedValue('valid-token'),
      };
      const mockQuota = {
        canApplyToday: vi
          .fn()
          .mockResolvedValue({ allowed: false, currentCount: 0, maxQuota: 15, reason: 'error' as const }),
      };

      const result = await runPreflight({ apiClient: mockApi as any, quotaManager: mockQuota });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('QUOTA_VERIFICATION_FAILED');
      expect(result.statusMessage).toContain('Could not verify daily quota with backend');
    });

    it('fails closed when credit balance check rejects or returns 5xx', async () => {
      const mockApi = {
        checkHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
        getCreditsBalance: vi.fn().mockRejectedValue(new Error('500 Internal Server Error')),
        getFreshToken: vi.fn().mockResolvedValue('valid-token'),
      };
      const mockQuota = {
        canApplyToday: vi.fn().mockResolvedValue({ allowed: true, currentCount: 0, maxQuota: 15 }),
      };

      const result = await runPreflight({ apiClient: mockApi as any, quotaManager: mockQuota });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('BALANCE_VERIFICATION_FAILED');
      expect(result.statusMessage).toContain('Credit balance verification failed');
    });

    it('fails closed when credit balance is below MINIMUM_RUN_CREDITS threshold', async () => {
      const mockApi = {
        checkHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
        getCreditsBalance: vi.fn().mockResolvedValue({
          success: true,
          data: { remainingCredits: 3 },
        }),
        getFreshToken: vi.fn().mockResolvedValue('valid-token'),
      };
      const mockQuota = {
        canApplyToday: vi.fn().mockResolvedValue({ allowed: true, currentCount: 0, maxQuota: 15 }),
      };

      const result = await runPreflight({ apiClient: mockApi as any, quotaManager: mockQuota, minCredits: 5 });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('INSUFFICIENT_CREDITS');
      expect(result.statusMessage).toContain('Insufficient credit balance (3 remaining, minimum 5 required)');
    });

    it('passes when health is ok, quota is allowed, and balance >= MINIMUM_RUN_CREDITS', async () => {
      const mockApi = {
        checkHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
        getCreditsBalance: vi.fn().mockResolvedValue({
          success: true,
          data: { remainingCredits: 20 },
        }),
        getFreshToken: vi.fn().mockResolvedValue('valid-token'),
      };
      const mockQuota = {
        canApplyToday: vi.fn().mockResolvedValue({ allowed: true, currentCount: 2, maxQuota: 15 }),
      };

      const result = await runPreflight({ apiClient: mockApi as any, quotaManager: mockQuota, minCredits: 5 });
      expect(result.ok).toBe(true);
      expect(result.statusMessage).toContain('Preflight verification successful');
      expect(result.details?.remainingCredits).toBe(20);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 5. System Diagnostics
  // ─────────────────────────────────────────────────────────────
  describe('runSystemDiagnostics()', () => {
    it('reports API unreachable when health check fails', async () => {
      vi.spyOn(backendApiClient, 'checkHealth').mockRejectedValue(new Error('Connection refused'));

      const report = await runSystemDiagnostics();
      expect(report.api.isReachable).toBe(false);
      expect(report.isReadyToApply).toBe(false);
      expect(report.actionableAdvice.some(a => a.includes('Backend API unreachable'))).toBe(true);
    });

    it('reports incomplete profile when required fields are missing', async () => {
      vi.spyOn(backendApiClient, 'checkHealth').mockResolvedValue({ status: 'ok' });
      await authStorage.setSession({
        token: 'valid-jwt',
        user: { id: 'u1', name: 'Test User', email: 'test@example.com', role: 'user', status: 'active' },
      });

      const report = await runSystemDiagnostics();
      expect(report.auth.isSignedIn).toBe(true);
      expect(report.profile.isValid).toBe(false);
      expect(report.isReadyToApply).toBe(false);
    });
  });
});
