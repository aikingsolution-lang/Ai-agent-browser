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

import { BACKEND_API_URL } from './config';

export class BackendApiClient {
  private baseUrl: string;
  private token: string | null = null;
  private refreshToken: string | null = null;
  private refreshPromise: Promise<string | null> | null = null;

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

  public async ensureToken(): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
        const res = await chrome.storage.local.get(['nanobrowser_auth_session']);
        const session = res?.nanobrowser_auth_session;
        if (session?.token) {
          this.token = session.token;
        }
        if (session?.refreshToken) {
          this.refreshToken = session.refreshToken;
        }
      }
    } catch {
      // Storage not accessible or not available in this context
    }
  }

  public async refreshAccessToken(): Promise<string | null> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        await this.ensureToken();
        if (!this.refreshToken) {
          return null;
        }

        const res = await fetch(`${this.baseUrl}/auth/refresh`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refreshToken: this.refreshToken }),
        });

        if (!res.ok) {
          this.setToken(null);
          this.setRefreshToken(null);
          if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
            const current = (await chrome.storage.local.get(['nanobrowser_auth_session']))?.nanobrowser_auth_session;
            if (current) {
              await chrome.storage.local.set({
                nanobrowser_auth_session: {
                  ...current,
                  token: null,
                  refreshToken: null,
                },
              });
            }
          }
          return null;
        }

        const data: ApiResponse<{ token: string; refreshToken: string }> = await res.json();
        if (data.success && data.data?.token) {
          const newToken = data.data.token;
          const newRefreshToken = data.data.refreshToken || this.refreshToken;
          this.setToken(newToken);
          this.setRefreshToken(newRefreshToken);

          if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
            const current = (await chrome.storage.local.get(['nanobrowser_auth_session']))?.nanobrowser_auth_session;
            if (current) {
              await chrome.storage.local.set({
                nanobrowser_auth_session: {
                  ...current,
                  token: newToken,
                  refreshToken: newRefreshToken,
                },
              });
            }
          }
          return newToken;
        }
        return null;
      } catch {
        return null;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
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
  public async register(payload: { name: string; email: string; password: string }) {
    const res = await this.request<{ user: any; token: string; refreshToken?: string; subscription?: any }>(
      '/auth/register',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
    if (res.data?.token) {
      this.setToken(res.data.token);
    }
    if (res.data?.refreshToken) {
      this.setRefreshToken(res.data.refreshToken);
    }
    return res;
  }

  public async login(payload: { email: string; password: string }) {
    const res = await this.request<{ user: any; token: string; refreshToken?: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (res.data?.token) {
      this.setToken(res.data.token);
    }
    if (res.data?.refreshToken) {
      this.setRefreshToken(res.data.refreshToken);
    }
    return res;
  }

  public async loginWithGoogle(payload: { idToken: string; nonce: string }) {
    const res = await this.request<{ user: any; token: string; refreshToken?: string; subscription?: any }>(
      '/auth/google',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
    if (res.data?.token) {
      this.setToken(res.data.token);
    }
    if (res.data?.refreshToken) {
      this.setRefreshToken(res.data.refreshToken);
    }
    return res;
  }

  public async getMe() {
    return this.request<{ user: any; subscription: any }>('/auth/me', {
      method: 'GET',
    });
  }

  public async logout(): Promise<void> {
    try {
      if (this.refreshToken) {
        await fetch(`${this.baseUrl}/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: this.refreshToken }),
        });
      }
    } catch {
      // Ignore network errors on logout
    } finally {
      this.setToken(null);
      this.setRefreshToken(null);
    }
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

  public async addPendingRefund(runId: string): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
        const data = await chrome.storage.local.get(['nanobrowser_pending_refunds']);
        const list: string[] = data?.nanobrowser_pending_refunds || [];
        if (!list.includes(runId)) {
          list.push(runId);
          await chrome.storage.local.set({ nanobrowser_pending_refunds: list });
        }
      }
    } catch {
      // Ignore
    }
  }

  public async removePendingRefund(runId: string): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
        const data = await chrome.storage.local.get(['nanobrowser_pending_refunds']);
        const list: string[] = data?.nanobrowser_pending_refunds || [];
        const filtered = list.filter(id => id !== runId);
        await chrome.storage.local.set({ nanobrowser_pending_refunds: filtered });
      }
    } catch {
      // Ignore
    }
  }

  public async retryPendingRefunds(): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
        const data = await chrome.storage.local.get(['nanobrowser_pending_refunds']);
        const list: string[] = data?.nanobrowser_pending_refunds || [];
        for (const runId of list) {
          try {
            await this.refundCredits(runId);
          } catch {
            // Remains in queue if failed
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  public async refundCredits(runId: string) {
    await this.addPendingRefund(runId);
    try {
      const res = await this.request<{
        remainingCredits: number;
        usedCredits: number;
        allocatedCredits: number;
        refundedAmount: number;
        runId: string;
      }>('/credits/refund', {
        method: 'POST',
        body: JSON.stringify({ runId }),
      });
      await this.removePendingRefund(runId);
      return res;
    } catch (error: any) {
      const errMsg = String(error?.message || '').toLowerCase();
      if (
        error?.status === 400 ||
        error?.status === 404 ||
        error?.code === 'ALREADY_REFUNDED' ||
        error?.code === 'RUN_NOT_FOUND' ||
        errMsg.includes('no billable usage')
      ) {
        await this.removePendingRefund(runId);
        return {
          remainingCredits: 0,
          usedCredits: 0,
          allocatedCredits: 0,
          refundedAmount: 0,
          runId,
        };
      }
      throw error;
    }
  }

  // --- Subscription APIs ---
  public async getSubscriptionPlans() {
    return this.request<{ plans: any[] }>('/subscription/plans', {
      method: 'GET',
    });
  }

  public async getSubscriptionMe() {
    return this.request<{ subscription: any; plan: any }>('/subscription/me', {
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
