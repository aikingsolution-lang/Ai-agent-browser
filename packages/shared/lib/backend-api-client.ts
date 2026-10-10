export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  error?: {
    code?: string;
    details?: any;
  };
  timestamp?: string;
}

import { BACKEND_API_URL, FIREBASE_WEB_API_KEY, ENABLE_CREDITS_RECONCILE } from './config';

export type RefreshResult =
  | { status: 'ok'; idToken: string; refreshToken: string; userId: string | null }
  | { status: 'invalid' }
  | { status: 'unavailable' };

export type IdTokenCheck =
  | { status: 'ok'; user: { uid: string; _id?: string; name?: string; email?: string; role?: string; status?: string } }
  | { status: 'expired' }
  | { status: 'invalid' }
  | { status: 'unavailable' };

const SESSION_KEY = 'nanobrowser_auth_session';
const SIGNED_OUT_SESSION = {
  token: null,
  refreshToken: null,
  user: null,
  subscription: null,
  credits: null,
  premium: null,
  source: null,
};

type StoredSession = Record<string, unknown> & { token?: string | null; refreshToken?: string | null; user?: unknown };

async function readStoredSession(): Promise<StoredSession | null> {
  if (typeof chrome === 'undefined' || !chrome?.storage?.local) return null;
  return (await chrome.storage.local.get([SESSION_KEY]))?.[SESSION_KEY] ?? null;
}

async function writeStoredSession(session: StoredSession): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome?.storage?.local) return;
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

function sessionUidOf(user: unknown): string | null {
  if (!user || typeof user !== 'object') return null;
  const record = user as Record<string, unknown>;
  const id = record.uid ?? record._id ?? record.id;
  return typeof id === 'string' && id ? id : null;
}

/** `exp` of a JWT in ms — read only to decide when to refresh; the backend verifies tokens. */
export function jwtExpiryMs(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

export const MAX_REFUND_ATTEMPTS = 5;
export const MAX_REFUND_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export class BackendApiClient {
  private baseUrl: string;
  private token: string | null = null;
  private refreshToken: string | null = null;
  private refreshPromise: Promise<string | null> | null = null;
  public lastRefreshStatus: 'ok' | 'invalid' | 'unavailable' | null = null;

  constructor(baseUrl = BACKEND_API_URL) {
    this.baseUrl = baseUrl;
  }

  public setToken(token: string | null): void {
    this.token = token;
  }

  public getToken(): string | null {
    return this.token;
  }

  public setRefreshToken(refreshToken: string | null): void {
    this.refreshToken = refreshToken;
  }

  public getRefreshToken(): string | null {
    return this.refreshToken;
  }

  /**
   * Mirrors the stored session (chrome.storage.local), including a sign-out or account switch made
   * in another extension context, so this instance never keeps acting as a previous user.
   */
  public async ensureToken(): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
        const res = await chrome.storage.local.get([SESSION_KEY]);
        const session = res?.[SESSION_KEY];
        this.token = session?.token || null;
        this.refreshToken = session?.refreshToken || null;
      }
    } catch {
      // Storage not accessible or not available in this context
    }
  }

  /**
   * Exchanges a Firebase refresh token for a new ID token, like the JobForm Automator extension:
   *   1. Firebase Secure Token API with the public Web API key;
   *   2. fallback: the backend's POST /auth/refresh (same exchange, server side).
   * 'invalid' means the refresh token is dead (revoked, expired, account disabled): sign out.
   * 'unavailable' means it could not be checked right now (offline, outage): keep the session.
   */
  public async exchangeRefreshToken(refreshToken: string): Promise<RefreshResult> {
    if (!refreshToken) {
      console.warn('[BackendApiClient] exchangeRefreshToken called without refreshToken (hasRefreshToken: false)');
      return { status: 'invalid' };
    }

    if (FIREBASE_WEB_API_KEY) {
      try {
        const res = await fetch(
          `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
          },
        );
        if (res.ok) {
          const data = await res.json();
          if (data?.id_token && data?.user_id) {
            return {
              status: 'ok',
              idToken: String(data.id_token),
              refreshToken: String(data.refresh_token || refreshToken),
              userId: String(data.user_id),
            };
          }
        } else {
          let googleErrorReason = `HTTP_${res.status}`;
          try {
            const errorBody = await res.json();
            googleErrorReason = errorBody?.error?.message || errorBody?.error || googleErrorReason;
          } catch {
            // response not JSON
          }
          console.warn(
            `[BackendApiClient] Secure token exchange failed with HTTP ${res.status}: ${googleErrorReason} (hasRefreshToken: ${Boolean(refreshToken)})`,
          );
          if (res.status === 400) {
            // INVALID_REFRESH_TOKEN, TOKEN_EXPIRED, USER_DISABLED, USER_NOT_FOUND
            return { status: 'invalid' };
          }
        }
        // 403 (key restricted) / 5xx: try the backend
      } catch (err: any) {
        console.warn(
          `[BackendApiClient] Secure token exchange network error: ${err?.message || 'Network error'} (hasRefreshToken: ${Boolean(refreshToken)})`,
        );
        // Network error: try the backend
      }
    }

    try {
      const res = await fetch(`${this.baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (res.status === 401) return { status: 'invalid' };
      const data = (await res.json().catch(() => null)) as ApiResponse<{
        token: string;
        refreshToken: string;
        userId?: string;
      }> | null;
      if (res.ok && data?.success && data.data?.token) {
        return {
          status: 'ok',
          idToken: data.data.token,
          refreshToken: data.data.refreshToken || refreshToken,
          userId: data.data.userId || null,
        };
      }
    } catch {
      // Offline
    }
    return { status: 'unavailable' };
  }

  /**
   * Refreshes the stored session's ID token. Returns the new token, or null when it could not be
   * refreshed. A dead refresh token ends the session (the user must sign in again); a temporary
   * failure keeps it for a later retry.
   */
  public async refreshAccessToken(): Promise<string | null> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        await this.ensureToken();
        const usedRefreshToken = this.refreshToken;
        if (!usedRefreshToken) {
          console.warn('[BackendApiClient] refreshAccessToken: no refreshToken present (hasRefreshToken: false)');
          return null;
        }

        const result = await this.exchangeRefreshToken(usedRefreshToken);
        this.lastRefreshStatus = result.status;
        const current = await readStoredSession();

        // The session changed while refreshing (sign-out or another account): never overwrite it.
        if (!current || current.refreshToken !== usedRefreshToken) {
          await this.ensureToken();
          return null;
        }

        const sessionUid = sessionUidOf(current.user);
        if (result.status === 'ok' && (!result.userId || !sessionUid || result.userId === sessionUid)) {
          this.setToken(result.idToken);
          this.setRefreshToken(result.refreshToken);
          await writeStoredSession({ ...current, token: result.idToken, refreshToken: result.refreshToken });
          return result.idToken;
        }

        if (result.status === 'unavailable') return null;

        // Dead refresh token, or a token for another account than the stored session: sign out.
        this.setToken(null);
        this.setRefreshToken(null);
        await writeStoredSession({ ...SIGNED_OUT_SESSION });
        return null;
      } catch {
        return null;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  /**
   * The stored ID token, refreshed first when it expires within `minValidityMs` (Firebase ID tokens
   * live one hour). Use before handing the token to a long-running consumer.
   */
  public async getFreshToken(minValidityMs = 5 * 60 * 1000): Promise<string | null> {
    await this.ensureToken();
    if (!this.token) return null;
    const expiresAt = jwtExpiryMs(this.token);
    if (expiresAt !== null && expiresAt - Date.now() > minValidityMs) return this.token;
    if (!this.refreshToken) return expiresAt === null || expiresAt > Date.now() ? this.token : null;
    const refreshed = await this.refreshAccessToken();
    if (refreshed) return refreshed;
    await this.ensureToken();
    if (!this.token) return null;
    const currentExpiry = jwtExpiryMs(this.token);
    return currentExpiry === null || currentExpiry > Date.now() ? this.token : null;
  }

  /**
   * Checks an ID token with the backend (GET /auth/me) without touching the stored session — used to
   * verify a session handed over by the JobForm Automator website before it is accepted.
   */
  public async checkIdToken(idToken: string): Promise<IdTokenCheck> {
    try {
      const res = await fetch(`${this.baseUrl}/auth/me`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      });
      const data = (await res.json().catch(() => null)) as ApiResponse<{
        user: { uid: string; _id?: string; name?: string; email?: string; role?: string; status?: string };
      }> | null;
      if (res.ok && data?.success && data.data?.user?.uid) {
        return { status: 'ok', user: data.data.user };
      }
      if (res.status === 401) {
        return { status: data?.error?.code === 'TOKEN_EXPIRED' ? 'expired' : 'invalid' };
      }
      return { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    }
  }

  private getHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}, isRetry = false): Promise<ApiResponse<T>> {
    await this.ensureToken();
    const url = `${this.baseUrl}${endpoint}`;
    const headers = this.getHeaders((options.headers as Record<string, string>) || {});

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      const isAuthEndpoint =
        endpoint === '/auth/refresh' || endpoint === '/auth/login' || endpoint === '/auth/register';

      if (response.status === 401 && !isRetry && !isAuthEndpoint) {
        const refreshedToken = await this.refreshAccessToken();
        if (refreshedToken) {
          return this.request<T>(endpoint, options, true);
        }
      }

      const data: ApiResponse<T> = await response.json();

      if (!response.ok || !data.success) {
        const errorObj = data.error || {};
        const code = errorObj.code || `HTTP_${response.status}`;
        const message = data.message || `Request failed with status ${response.status}`;
        const err = new Error(message) as any;
        err.status = response.status;
        err.code = code;
        err.details = errorObj.details;
        throw err;
      }

      return data;
    } catch (error: any) {
      if (error.status) throw error;
      const networkError = new Error(error.message || 'Failed to connect to backend server') as any;
      networkError.status = 503;
      networkError.code = 'NETWORK_ERROR';
      throw networkError;
    }
  }

  // --- Auth APIs ---
  // NanoBrowser has no login or registration of its own: users sign in on JobForm Automator and the
  // website session is handed to the extension (see accountSync.ts / acceptWebsiteSession).

  public async getMe() {
    return this.request<{ user: any; subscription: any }>('/auth/me', {
      method: 'GET',
    });
  }

  /**
   * Local sign-out: forgets this instance's tokens. Nothing is sent anywhere, so the JobForm
   * Automator website session (same Firebase account) stays signed in.
   */
  public logout(): void {
    this.setToken(null);
    this.setRefreshToken(null);
  }

  // --- Credit APIs ---
  public async getCreditsBalance() {
    return this.request<{
      allocatedCredits: number;
      usedCredits: number;
      remainingCredits: number;
      periodStart: string;
      periodEnd: string;
      isLowBalance: boolean;
    }>('/credits/balance', {
      method: 'GET',
    });
  }

  public async getCreditHistory(page = 1, limit = 20) {
    return this.request<{ items: any[]; total: number; page: number; limit: number }>(
      `/credits/history?page=${page}&limit=${limit}`,
      { method: 'GET' },
    );
  }

  public async addPendingRefund(runId: string, customKey?: string): Promise<string> {
    const idempotencyKey = customKey || `refund_${runId}`;
    try {
      if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
        const data = await chrome.storage.local.get(['nanobrowser_pending_refunds_v2', 'nanobrowser_pending_refunds']);
        const queue: Array<{ runId: string; idempotencyKey: string; createdAt: number; attempts: number }> =
          data?.nanobrowser_pending_refunds_v2 || [];
        const existing = queue.find(q => q.runId === runId);
        if (existing) {
          return existing.idempotencyKey;
        }
        queue.push({
          runId,
          idempotencyKey,
          createdAt: Date.now(),
          attempts: 0,
        });
        const legacyList: string[] = data?.nanobrowser_pending_refunds || [];
        if (!legacyList.includes(runId)) legacyList.push(runId);
        await chrome.storage.local.set({
          nanobrowser_pending_refunds_v2: queue,
          nanobrowser_pending_refunds: legacyList,
        });
      }
    } catch {
      // Ignore
    }
    return idempotencyKey;
  }

  public async removePendingRefund(runId: string): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
        const data = await chrome.storage.local.get(['nanobrowser_pending_refunds_v2', 'nanobrowser_pending_refunds']);
        const queue: Array<{ runId: string; idempotencyKey: string }> = data?.nanobrowser_pending_refunds_v2 || [];
        const filteredQueue = queue.filter(item => item.runId !== runId);
        const legacyList: string[] = data?.nanobrowser_pending_refunds || [];
        const filteredLegacy = legacyList.filter(id => id !== runId);
        await chrome.storage.local.set({
          nanobrowser_pending_refunds_v2: filteredQueue,
          nanobrowser_pending_refunds: filteredLegacy,
        });
      }
    } catch {
      // Ignore
    }
  }

  public async retryPendingRefunds(): Promise<void> {
    try {
      if (typeof chrome === 'undefined' || !chrome?.storage?.local) return;
      const data = await chrome.storage.local.get(['nanobrowser_pending_refunds_v2', 'nanobrowser_pending_refunds']);
      const queue: Array<{
        runId: string;
        idempotencyKey: string;
        createdAt: number;
        attempts: number;
        lastError?: string;
      }> = data?.nanobrowser_pending_refunds_v2 || [];

      // Migrate legacy string IDs if present
      const legacyList: string[] = data?.nanobrowser_pending_refunds || [];
      for (const legacyId of legacyList) {
        if (!queue.some(item => item.runId === legacyId)) {
          queue.push({
            runId: legacyId,
            idempotencyKey: `refund_${legacyId}`,
            createdAt: Date.now(),
            attempts: 0,
          });
        }
      }

      const now = Date.now();
      const activeQueue: typeof queue = [];
      const expiredOrExhausted: typeof queue = [];

      for (const item of queue) {
        const age = now - (item.createdAt || now);
        if (age > MAX_REFUND_AGE_MS || (item.attempts || 0) >= MAX_REFUND_ATTEMPTS) {
          expiredOrExhausted.push(item);
          console.warn(
            `[RefundQueue] Dropping refund for run ${item.runId}: attempts=${item.attempts}/${MAX_REFUND_ATTEMPTS}, ageMs=${age}/${MAX_REFUND_AGE_MS}`,
          );
        } else {
          activeQueue.push(item);
        }
      }

      if (expiredOrExhausted.length > 0) {
        const failedData = await chrome.storage.local.get(['nanobrowser_failed_refunds']);
        const failedList: Array<{
          runId: string;
          idempotencyKey: string;
          createdAt: number;
          droppedAt: number;
          attempts: number;
          lastError?: string;
          reason: string;
          reported?: boolean;
        }> = failedData?.nanobrowser_failed_refunds || [];

        for (const item of expiredOrExhausted) {
          const reason = (item.attempts || 0) >= MAX_REFUND_ATTEMPTS ? 'max_attempts_exceeded' : 'max_age_exceeded';
          const failedRecord = {
            runId: item.runId,
            idempotencyKey: item.idempotencyKey,
            createdAt: item.createdAt,
            droppedAt: Date.now(),
            attempts: item.attempts || 0,
            lastError: item.lastError,
            reason,
            reported: false,
          };
          failedList.push(failedRecord);
          console.error(
            `[RefundQueue] Permanently dropped refund for run ${item.runId} to nanobrowser_failed_refunds (${reason}): attempts=${item.attempts}/${MAX_REFUND_ATTEMPTS}, lastError=${item.lastError}`,
          );

          // Report dropped refund to authenticated backend endpoint when reachable
          this.reportFailedRefund({
            runId: item.runId,
            idempotencyKey: item.idempotencyKey,
            reason,
          })
            .then(async () => {
              failedRecord.reported = true;
              await chrome.storage.local.set({ nanobrowser_failed_refunds: failedList });
            })
            .catch(reportErr => {
              console.warn(
                `[RefundQueue] Could not report dropped refund for run ${item.runId} to backend:`,
                reportErr?.message,
              );
            });
        }

        await chrome.storage.local.set({
          nanobrowser_failed_refunds: failedList,
          nanobrowser_pending_refunds_v2: activeQueue,
          nanobrowser_pending_refunds: activeQueue.map(q => q.runId),
        });
      }

      // Retry reporting any previously un-reported entries in nanobrowser_failed_refunds
      try {
        const storedFailed = await chrome.storage.local.get(['nanobrowser_failed_refunds']);
        const list: Array<{ runId: string; idempotencyKey: string; reason: string; reported?: boolean }> =
          storedFailed?.nanobrowser_failed_refunds || [];
        let updated = false;
        for (const f of list) {
          if (!f.reported) {
            try {
              await this.reportFailedRefund({ runId: f.runId, idempotencyKey: f.idempotencyKey, reason: f.reason });
              f.reported = true;
              updated = true;
            } catch {
              // Will retry next interval
            }
          }
        }
        if (updated) {
          await chrome.storage.local.set({ nanobrowser_failed_refunds: list });
        }
      } catch {
        // Ignore
      }

      for (const item of activeQueue) {
        try {
          item.attempts = (item.attempts || 0) + 1;
          await this.refundCredits(item.runId, item.idempotencyKey);
        } catch (err: any) {
          item.lastError = err?.message || String(err);
          console.warn(
            `[RefundQueue] Retry attempt ${item.attempts}/${MAX_REFUND_ATTEMPTS} failed for run ${item.runId} (${err?.status || 'error'}):`,
            err?.message,
          );
          // Persist attempt count update
          await chrome.storage.local.set({
            nanobrowser_pending_refunds_v2: activeQueue.filter(q => (q.attempts || 0) < MAX_REFUND_ATTEMPTS),
            nanobrowser_pending_refunds: activeQueue
              .filter(q => (q.attempts || 0) < MAX_REFUND_ATTEMPTS)
              .map(q => q.runId),
          });
        }
      }
    } catch (err) {
      console.error('[RefundQueue] Error processing retryPendingRefunds:', err);
    }
  }

  public async refundCredits(
    runId: string,
    customIdempotencyKey?: string,
  ): Promise<{
    success: boolean;
    message?: string;
    data: {
      remainingCredits: number;
      usedCredits: number;
      allocatedCredits: number;
      refundedAmount: number;
      runId: string;
    };
  }> {
    const idempotencyKey = await this.addPendingRefund(runId, customIdempotencyKey);
    try {
      const res = await this.request<{
        remainingCredits: number;
        usedCredits: number;
        allocatedCredits: number;
        refundedAmount: number;
        runId: string;
      }>('/credits/refund', {
        method: 'POST',
        headers: {
          'x-idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ runId, idempotencyKey }),
      });
      // HTTP 200 Success: remove from pending queue
      await this.removePendingRefund(runId);
      return {
        ...res,
        data: res.data || {
          remainingCredits: 0,
          usedCredits: 0,
          allocatedCredits: 0,
          refundedAmount: 0,
          runId,
        },
      };
    } catch (error: any) {
      const errMsg = String(error?.message || '').toLowerCase();
      const isTerminal =
        error?.code === 'ALREADY_REFUNDED' ||
        errMsg.includes('already refunded') ||
        errMsg.includes('no billable usage') ||
        errMsg.includes('nothing to refund');

      if (isTerminal) {
        // Only remove on 200, ALREADY_REFUNDED, or "no billable usage"
        await this.removePendingRefund(runId);
        return {
          success: true,
          message: 'Already refunded or no billable usage',
          data: {
            remainingCredits: 0,
            usedCredits: 0,
            allocatedCredits: 0,
            refundedAmount: 0,
            runId,
          },
        };
      }

      // For 400/404 or transient 5xx/network errors, keep entry in queue, log, and throw
      console.warn(
        `[BackendApiClient] Refund call failed for run ${runId} (status ${error?.status || 'unknown'}):`,
        error?.message,
      );
      throw error;
    }
  }

  public async reportFailedRefund(payload: { runId: string; idempotencyKey: string; reason: string }) {
    return this.request<{ recorded: boolean }>('/credits/refund/report-failed', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public async reconcileUnappliedCredits() {
    if (!ENABLE_CREDITS_RECONCILE) {
      return {
        success: true,
        data: {
          reconciledCount: 0,
          totalRefunded: 0,
          refundedRunIds: [],
        },
      };
    }
    return this.request<{
      reconciledCount: number;
      totalRefunded: number;
      refundedRunIds: string[];
    }>('/credits/reconcile', {
      method: 'POST',
    });
  }

  // --- Subscription APIs ---
  public async getSubscriptionPlans() {
    return this.request<{ plans: any[] }>('/subscription/plans', {
      method: 'GET',
    });
  }

  public async getSubscriptionMe() {
    return this.request<{
      subscription: any;
      plan?: any;
      status?: string;
      hasActiveEntitlement?: boolean;
      trialInfo?: unknown;
      /** JobForm Automator premium status, read by the backend from the verified payment record. */
      premium?: JobformPremiumStatus | null;
    }>('/subscription/me', {
      method: 'GET',
    });
  }

  public async createCheckoutSession(planCode: string, idempotencyKey?: string) {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['x-idempotency-key'] = idempotencyKey;
    }
    return this.request<{
      subscriptionId: string;
      razorpaySubscriptionId: string;
      amount: number;
      currency: string;
      planCode: string;
      shortUrl?: string;
      planName?: string;
    }>('/subscription/checkout', {
      method: 'POST',
      headers,
      body: JSON.stringify({ planCode, idempotencyKey }),
    });
  }

  public async verifyPayment(payload: {
    razorpaySubscriptionId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  }) {
    return this.request<{ subscription: any }>('/subscription/verify-payment', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public async cancelSubscription() {
    return this.request<{ subscription: any }>('/subscription/cancel', {
      method: 'POST',
    });
  }

  // --- LLM Proxy APIs ---
  public async sendLlmChat(payload: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    max_tokens?: number;
    idempotencyKey?: string;
  }) {
    const headers: Record<string, string> = {};
    if (payload.idempotencyKey) {
      headers['x-idempotency-key'] = payload.idempotencyKey;
    }
    return this.request<{
      requestId: string;
      model: string;
      provider: string;
      content: string;
      usage: { promptTokens: number; completionTokens: number; totalTokens: number };
      creditsDeducted: number;
      isIdempotentRetry: boolean;
      latencyMs: number;
    }>('/llm/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  }

  public async streamLlmChat(
    payload: {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
      max_tokens?: number;
      idempotencyKey?: string;
    },
    onChunk: (chunk: string) => void,
  ) {
    const url = `${this.baseUrl}/llm/chat`;
    const headers = this.getHeaders();
    if (payload.idempotencyKey) {
      headers['x-idempotency-key'] = payload.idempotencyKey;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...payload, stream: true }),
    });

    if (!response.ok) {
      let errData: any = {};
      try {
        errData = await response.json();
      } catch {}
      const err = new Error(errData.message || `HTTP ${response.status}`) as any;
      err.status = response.status;
      err.code = errData.error?.code || 'STREAM_ERROR';
      throw err;
    }

    if (!response.body) {
      throw new Error('No stream body returned by server');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed === 'data: [DONE]') break;

        if (trimmed.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            if (parsed.chunk) {
              onChunk(parsed.chunk);
            }
          } catch {}
        }
      }
    }
  }

  public async getLlmUsage(page = 1, limit = 20) {
    return this.request<{ items: any[]; total: number; page: number; limit: number }>(
      `/llm/usage?page=${page}&limit=${limit}`,
      { method: 'GET' },
    );
  }

  /**
   * Uploads raw resume file (PDF/DOCX) to backend, extracts structured data via Bedrock AI,
   * and saves/syncs the updated CareerBrain.
   */
  public async uploadAndParseResume(
    file: File | Blob,
    fileName = 'resume.pdf',
  ): Promise<ApiResponse<ResumeParseApiResponse>> {
    const formData = new FormData();
    formData.append('resume', file, fileName);

    const headers: Record<string, string> = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(`${this.baseUrl}/resume/upload-and-parse`, {
      method: 'POST',
      headers,
      body: formData,
    });

    const data: ApiResponse<ResumeParseApiResponse> = await response.json();
    if (!response.ok || !data.success) {
      const err = new Error(data.message || `Upload failed with status ${response.status}`) as any;
      err.status = response.status;
      err.code = data.error?.code || `HTTP_${response.status}`;
      throw err;
    }
    return data;
  }

  // --- Job Application APIs ---
  public async recordJobApplication(payload: {
    jobId?: string;
    jobTitle: string;
    company: string;
    platform?: string;
    applicationUrl?: string;
    location?: string;
    salaryRange?: string;
    fitScore?: number;
    status?: string;
    appliedAt?: string;
  }) {
    return this.request<{ application: any }>('/job-applications', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public async getJobApplications(query: { status?: string; limit?: number; page?: number } = {}) {
    const params = new URLSearchParams();
    if (query.status) params.append('status', query.status);
    if (query.limit) params.append('limit', String(query.limit));
    if (query.page) params.append('page', String(query.page));

    const qs = params.toString();
    const endpoint = qs ? `/job-applications?${qs}` : '/job-applications';
    return this.request<{ items: any[]; total: number; page: number; limit: number }>(endpoint, {
      method: 'GET',
    });
  }

  public async checkDuplicateJob(jobId: string): Promise<boolean> {
    try {
      await this.ensureToken();
      if (!this.token) return false;
      const res = await this.request<{ exists: boolean }>(`/job-applications/check/${encodeURIComponent(jobId)}`, {
        method: 'GET',
      });
      return Boolean(res.data?.exists);
    } catch {
      return false;
    }
  }

  public async requestTailoredResume(params: {
    candidateName: string;
    candidateEmail: string;
    candidatePhone?: string;
    currentTitle?: string;
    skills: string[];
    targetKeywords: string[];
    jobTitle: string;
    company: string;
    backgroundNarrative?: string;
  }): Promise<BackendResumeResponse | null> {
    try {
      const res = await this.request<BackendResumeResponse>('/resume/generate', {
        method: 'POST',
        body: JSON.stringify(params),
      });
      return res.data || null;
    } catch {
      return null;
    }
  }

  public async syncCareerBrainProfile(profileData: any): Promise<boolean> {
    try {
      await this.ensureToken();
      if (!this.token) return false;
      const res = await this.request('/profile', {
        method: 'PUT',
        body: JSON.stringify(profileData),
      });
      return Boolean(res.success);
    } catch {
      return false;
    }
  }

  public async fetchCareerBrainProfile(): Promise<any | null> {
    try {
      await this.ensureToken();
      if (!this.token) return null;
      const res = await this.request('/profile', {
        method: 'GET',
      });
      return res.data || null;
    } catch {
      return null;
    }
  }

  public async getProfileQuota(): Promise<{
    allowed: boolean;
    appliedToday: number;
    dailyLimit: number;
    remaining: number;
    tier: string;
  } | null> {
    try {
      await this.ensureToken();
      if (!this.token) {
        return null;
      }
      const res = await this.request<{
        allowed: boolean;
        appliedToday: number;
        dailyLimit: number;
        remaining: number;
        tier: string;
      }>('/profile/quota', {
        method: 'GET',
      });
      return res.data || null;
    } catch {
      return null;
    }
  }

  public async checkAndIncrementDailyQuota(): Promise<{ allowed: boolean; appliedToday: number; dailyLimit: number }> {
    try {
      await this.ensureToken();
      if (!this.token) {
        return { allowed: true, appliedToday: 0, dailyLimit: 15 };
      }
      const res = await this.request<{ appliedToday: number; dailyLimit: number }>(
        '/profile/quota/check-and-increment',
        {
          method: 'POST',
        },
      );
      return {
        allowed: true,
        appliedToday: res.data?.appliedToday ?? 1,
        dailyLimit: res.data?.dailyLimit ?? 15,
      };
    } catch (err: any) {
      if (err.status === 429) {
        return {
          allowed: false,
          appliedToday: err.details?.appliedToday ?? 15,
          dailyLimit: err.details?.dailyLimit ?? 15,
        };
      }
      return { allowed: true, appliedToday: 0, dailyLimit: 15 };
    }
  }

  public async checkHealth(): Promise<{ status: string }> {
    const base = this.baseUrl.replace(/\/api\/v1\/?$/, '');
    const res = await fetch(`${base}/health`, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`Health check failed with HTTP ${res.status}`);
    }
    return (await res.json().catch(() => ({ status: 'ok' }))) as { status: string };
  }
}

export interface JobformPremiumStatus {
  source: 'jobform-automator';
  tier: 'Free' | 'Premium' | 'Diamond';
  isPremium: boolean;
  subscriptionType: string | null;
  startDate: string | null;
  endDate: string | null;
  expired: boolean;
  checkedAt: string;
}

export interface BackendResumeResponse {
  fileName: string;
  fileSize: number;
  base64Pdf: string;
  highlightedKeywords: string[];
}

export interface IWorkExperience {
  role: string;
  company: string;
  duration?: string;
  highlights?: string[];
}

export interface IWorkExperienceItem {
  id: string;
  company: string;
  title: string;
  startMonth?: string;
  startYear?: string;
  endMonth?: string | null;
  endYear?: string | null;
  isCurrent?: boolean;
  description?: string;
  source?: 'manual' | 'resume';
}

export interface IGoldenAnswerItem {
  id: string;
  question: string;
  answer: string;
  category?: string;
  isDefault?: boolean;
}

export interface ParsedResumeData {
  fullName: string;
  email: string;
  phoneNumber: string;
  currentTitle: string;
  skills: string[];
  yearsOfExperience: number;
  hasWorkExperience?: boolean;
  workExperience?: IWorkExperienceItem[];
  education: string;
  college?: string;
  cgpa?: string;
  currentCTC?: string;
  expectedCTC?: string;
  currentLocation?: string;
  noticePeriod?: string;
  workHistory: IWorkExperience[];
  backgroundNarrative: string;
  goldenAnswers?: IGoldenAnswerItem[];
  preferredLocation: string;
  preferredLocations?: string[];
  workAuthorization: string;
  salaryExpectation: string;
  portfolioUrl: string;
  githubUrl: string;
  linkedinUrl: string;
  skillExperience?: Record<string, number>;
  autoExtractedSkills?: string[];
}

export interface ResumeParseApiResponse {
  fileName: string;
  fileSize: number;
  parsedData: ParsedResumeData;
  careerBrain: any;
  rawText?: string;
}

export const backendApiClient = new BackendApiClient();
