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

export class BackendApiClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl = 'http://localhost:5000/api/v1') {
    this.baseUrl = baseUrl;
  }

  public setToken(token: string | null): void {
    this.token = token;
  }

  public getToken(): string | null {
    return this.token;
  }

  public async ensureToken(): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
        const res = await chrome.storage.local.get(['nanobrowser_auth_session']);
        const session = res?.nanobrowser_auth_session;
        if (session?.token) {
          this.token = session.token;
        }
      }
    } catch {
      // Storage not accessible or not available in this context
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

      if (response.status === 401 && !isRetry) {
        // Token might have expired or updated; refresh from storage and retry once
        await this.ensureToken();
        if (this.token) {
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
    const res = await this.request<{ user: any; token: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (res.data?.token) {
      this.setToken(res.data.token);
    }
    return res;
  }

  public async login(payload: { email: string; password: string }) {
    const res = await this.request<{ user: any; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (res.data?.token) {
      this.setToken(res.data.token);
    }
    return res;
  }

  public async getMe() {
    return this.request<{ user: any; subscription: any }>('/auth/me', {
      method: 'GET',
    });
  }

  public logout() {
    this.setToken(null);
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
}

export interface IWorkExperience {
  role: string;
  company: string;
  duration?: string;
  highlights?: string[];
}

export interface ParsedResumeData {
  fullName: string;
  email: string;
  phoneNumber: string;
  currentTitle: string;
  skills: string[];
  yearsOfExperience: number;
  education: string;
  college?: string;
  cgpa?: string;
  currentCTC?: string;
  expectedCTC?: string;
  currentLocation?: string;
  noticePeriod?: string;
  workHistory: IWorkExperience[];
  backgroundNarrative: string;
  preferredLocation: string;
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
