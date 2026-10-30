import { AppError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';
import type { ILlmProvider, LlmCompletionRequest, LlmCompletionResponse } from './llmProvider.interface.js';

/**
 * Google Gemini LLM Provider using Google's OpenAI-compatible endpoint:
 * https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
 *
 * Why the OpenAI-compatible endpoint:
 * 1. Guarantees 100% response and request shape compatibility with LangChain and existing consumers.
 * 2. Directly accepts OpenAI-style `messages`, `temperature`, `max_tokens`, `tools`, and `tool_choice`.
 * 3. Transparently returns standard `choices[0].message.content`, `tool_calls`, `finish_reason`, and `usage`
 *    without complex bidirectional translation between Google and OpenAI schema types.
 * 4. Zero additional heavy SDK dependencies.
 *
 * Token & Credit Accounting:
 * - Total tokens are taken directly from `usage.total_tokens` (or `prompt_tokens` + `completion_tokens`).
 * - For reasoning / thinking models (Gemini 2.5/3.x), internal thinking tokens are included in `completion_tokens`
 *   as reported by Google's API, and therefore accurately billed without under-counting.
 *
 * Security:
 * - API key is injected via constructor from environment / Secret Manager.
 * - Never logs API keys or full prompt/content texts to logs.
 */
export class GeminiLlmProvider implements ILlmProvider {
  public readonly providerName = 'gemini';
  private apiKey: string;
  private defaultModel: string;
  private fallbackModel?: string;
  private baseUrl: string;
  private thinkingBudget?: number;
  private reasoningEffort?: 'none' | 'low' | 'medium' | 'high';

  constructor(
    apiKey: string,
    defaultModel = 'gemini-3.5-flash',
    fallbackModelOrBaseUrl?: string,
    baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai',
    thinkingBudget?: number,
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high',
  ) {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
    if (
      fallbackModelOrBaseUrl &&
      (fallbackModelOrBaseUrl.startsWith('http://') || fallbackModelOrBaseUrl.startsWith('https://'))
    ) {
      this.baseUrl = fallbackModelOrBaseUrl.replace(/\/+$/, '');
      this.fallbackModel = undefined;
    } else {
      this.fallbackModel = fallbackModelOrBaseUrl;
      this.baseUrl = baseUrl.replace(/\/+$/, '');
    }
    this.thinkingBudget = thinkingBudget;
    this.reasoningEffort = reasoningEffort;
  }

  private isFallbackEligible(err: any): boolean {
    const status = err?.statusCode || err?.status;
    const msg = String(err?.message || '').toLowerCase();
    const code = String(err?.code || '').toLowerCase();

    if (status === 404 || code === 'provider_model_not_found') return true;
    if (
      status === 503 ||
      code === 'provider_unavailable' ||
      msg.includes('503') ||
      msg.includes('high demand') ||
      msg.includes('spikes in demand')
    ) {
      return true;
    }
    if (msg.includes('not found') || msg.includes('no longer available') || msg.includes('retired')) return true;
    return false;
  }

  public async generateCompletion(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const primaryModel = request.model || this.defaultModel;
    try {
      return await this.executeChatCompletion(primaryModel, request);
    } catch (err: any) {
      if (this.fallbackModel && this.fallbackModel !== primaryModel && this.isFallbackEligible(err)) {
        logger.warn(
          `[GeminiLlmProvider] Primary model '${primaryModel}' failed (${err?.message || 'model unavailable or high demand'}). Falling back to '${this.fallbackModel}'...`,
        );
        return await this.executeChatCompletion(this.fallbackModel, request);
      }
      throw err;
    }
  }

  private async executeChatCompletion(
    effectiveModel: string,
    request: LlmCompletionRequest,
  ): Promise<LlmCompletionResponse> {
    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? 30000;
    const startTime = Date.now();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const endpoint = `${this.baseUrl}/chat/completions`;

    const requestPayload: Record<string, any> = {
      model: effectiveModel,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
    };

    if (request.maxTokens !== undefined) {
      requestPayload.max_tokens = request.maxTokens;
    }
    if (request.tools && Array.isArray(request.tools) && request.tools.length > 0) {
      requestPayload.tools = request.tools;
    }
    if (request.tool_choice !== undefined) {
      requestPayload.tool_choice = request.tool_choice;
    }
    // Note: Google's OpenAI-compatible endpoint accepts `reasoning_effort`, but rejects unknown `thinking` object with HTTP 400.
    if (this.reasoningEffort) {
      requestPayload.reasoning_effort = this.reasoningEffort;
    }

    const maxRetries = 2;
    let attempt = 0;
    let lastError: any = null;

    try {
      while (attempt <= maxRetries) {
        // Guard total execution time so retries finish comfortably before request timeout
        const elapsed = Date.now() - startTime;
        if (elapsed >= timeoutMs - 1000) {
          throw new AppError('LLM Provider request timed out', 504, 'PROVIDER_TIMEOUT');
        }

        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(requestPayload),
            signal: controller.signal,
          });

          if (!response.ok) {
            let errorData: any = {};
            try {
              errorData = await response.json();
            } catch {
              // Body was not JSON
            }

            const realErrorMessage =
              errorData?.error?.message ||
              errorData?.message ||
              `Gemini provider returned HTTP status ${response.status}`;

            logger.error('[GeminiLlmProvider] HTTP error from Gemini API:', {
              status: response.status,
              model: effectiveModel,
              attempt: attempt + 1,
              error: realErrorMessage,
            });

            const isRetryable = response.status === 429 || response.status >= 500;
            if (isRetryable && attempt < maxRetries) {
              attempt++;
              const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 3000); // 1000ms, 2000ms
              logger.warn(
                `[GeminiLlmProvider] Retryable status HTTP ${response.status}. Retrying in ${backoffMs}ms (attempt ${attempt}/${maxRetries})...`,
              );
              await new Promise(resolve => setTimeout(resolve, backoffMs));
              continue;
            }

            if (response.status === 429) {
              throw new AppError('Gemini rate limit exceeded. Please try again later.', 429, 'PROVIDER_RATE_LIMIT');
            }
            if (response.status === 401 || response.status === 403) {
              throw new AppError(
                'Gemini authentication failed. Please verify API key configuration.',
                403,
                'PROVIDER_AUTH_ERROR',
              );
            }
            if (response.status === 404) {
              throw new AppError(
                realErrorMessage || 'Gemini model not found or retired.',
                404,
                'PROVIDER_MODEL_NOT_FOUND',
              );
            }
            if (response.status === 503) {
              throw new AppError(
                realErrorMessage || 'Gemini service unavailable or experiencing high demand.',
                503,
                'PROVIDER_UNAVAILABLE',
              );
            }
            if (response.status >= 500) {
              throw new AppError('Gemini service error. Please try again later.', 502, 'PROVIDER_ERROR');
            }
            if (response.status === 400) {
              throw new AppError('Bad request sent to Gemini provider.', 400, 'PROVIDER_BAD_REQUEST');
            }
            throw new AppError('Failed to communicate with Gemini provider', 502, 'PROVIDER_ERROR');
          }

          let data: any;
          try {
            data = await response.json();
          } catch (parseErr) {
            logger.error('[GeminiLlmProvider] Failed to parse JSON response from Gemini:', parseErr);
            throw new AppError('Invalid response payload from Gemini', 502, 'PROVIDER_INVALID_RESPONSE');
          }

          const choice = data?.choices?.[0];
          if (!choice || typeof choice !== 'object') {
            logger.error('[GeminiLlmProvider] Malformed response: choices array is missing or empty.');
            throw new AppError('Invalid response payload from Gemini', 502, 'PROVIDER_INVALID_RESPONSE');
          }

          const message = choice.message || {};
          const content = typeof message.content === 'string' ? message.content : '';
          const toolCalls =
            Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? message.tool_calls : undefined;

          const finishReason = choice.finish_reason || (toolCalls ? 'tool_calls' : 'stop');

          // Empty replies or reasoning token exhaustion check:
          // If content is completely blank and no tool calls were returned, throw PROVIDER_EMPTY_RESPONSE
          if (!content.trim() && (!toolCalls || toolCalls.length === 0)) {
            logger.warn(
              `[GeminiLlmProvider] Empty content returned from Gemini with finishReason='${finishReason}'. Full choice:`,
              choice,
            );
            throw new AppError(
              `Gemini provider returned an empty completion (finishReason: ${finishReason}). The model may have exhausted max_tokens on internal reasoning or produced no output.`,
              502,
              'PROVIDER_EMPTY_RESPONSE',
            );
          }

          const usage = data.usage || {};
          const promptTokens = usage.prompt_tokens || 0;
          const completionTokens = usage.completion_tokens || 0;
          const totalTokens = usage.total_tokens || promptTokens + completionTokens;

          clearTimeout(timer);
          return {
            content,
            promptTokens,
            completionTokens,
            totalTokens,
            finishReason,
            ...(toolCalls ? { toolCalls } : {}),
          };
        } catch (fetchErr: any) {
          if (fetchErr instanceof AppError) {
            throw fetchErr;
          }
          if (fetchErr.name === 'AbortError') {
            throw new AppError('LLM Provider request timed out', 504, 'PROVIDER_TIMEOUT');
          }

          lastError = fetchErr;
          if (attempt < maxRetries) {
            attempt++;
            const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 3000);
            logger.warn(
              `[GeminiLlmProvider] Network error communicating with Gemini. Retrying in ${backoffMs}ms (attempt ${attempt}/${maxRetries})...`,
            );
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue;
          }
          break;
        }
      }

      clearTimeout(timer);
      logger.error('[GeminiLlmProvider] Request failed after retries:', lastError);
      throw new AppError('Failed to communicate with Gemini provider', 502, 'PROVIDER_ERROR');
    } catch (err: any) {
      clearTimeout(timer);
      if (err instanceof AppError) {
        throw err;
      }
      if (err.name === 'AbortError') {
        throw new AppError('LLM Provider request timed out', 504, 'PROVIDER_TIMEOUT');
      }
      logger.error('[GeminiLlmProvider] Request failed:', {
        name: err?.name,
        message: err?.message,
      });
      throw new AppError('Failed to communicate with Gemini provider', 502, 'PROVIDER_ERROR');
    }
  }

  public async streamCompletion(
    request: LlmCompletionRequest,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<LlmCompletionResponse> {
    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? 30000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const onAbort = () => controller.abort();
    if (signal) {
      signal.addEventListener('abort', onAbort);
    }

    const effectiveModel = request.model || this.defaultModel;
    const endpoint = `${this.baseUrl}/chat/completions`;

    const requestPayload: Record<string, any> = {
      model: effectiveModel,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      stream: true,
    };

    if (request.maxTokens !== undefined) {
      requestPayload.max_tokens = request.maxTokens;
    }
    if (request.tools && Array.isArray(request.tools) && request.tools.length > 0) {
      requestPayload.tools = request.tools;
    }
    if (request.tool_choice !== undefined) {
      requestPayload.tool_choice = request.tool_choice;
    }
    // Note: Google's OpenAI-compatible endpoint accepts `reasoning_effort`, but rejects unknown `thinking` object with HTTP 400.
    if (this.reasoningEffort) {
      requestPayload.reasoning_effort = this.reasoningEffort;
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        let errorData: any = {};
        try {
          errorData = await response.json();
        } catch {
          // not JSON
        }
        const realErrorMessage =
          errorData?.error?.message || errorData?.message || `Gemini streaming failed with HTTP ${response.status}`;

        logger.error('[GeminiLlmProvider] Streaming HTTP error from Gemini API:', {
          status: response.status,
          model: effectiveModel,
          error: realErrorMessage,
        });

        if (response.status === 429) {
          throw new AppError('Gemini rate limit exceeded during stream.', 429, 'PROVIDER_RATE_LIMIT');
        }
        if (response.status === 401 || response.status === 403) {
          throw new AppError('Gemini authentication failed during stream.', 403, 'PROVIDER_AUTH_ERROR');
        }
        if (response.status >= 500) {
          throw new AppError('Gemini service error during stream.', 502, 'PROVIDER_ERROR');
        }
        if (response.status === 400) {
          throw new AppError('Bad request sent to Gemini streaming provider.', 400, 'PROVIDER_BAD_REQUEST');
        }
        throw new AppError(`Gemini streaming failed with HTTP ${response.status}`, 502, 'PROVIDER_ERROR');
      }

      if (!response.body) {
        throw new AppError('No stream body returned by Gemini', 502, 'PROVIDER_INVALID_RESPONSE');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
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
              const json = JSON.parse(trimmed.slice(6));
              const deltaContent = json.choices?.[0]?.delta?.content;
              if (deltaContent) {
                fullContent += deltaContent;
                onChunk(deltaContent);
              }
            } catch {
              // Ignore malformed SSE chunk lines
            }
          }
        }
      }

      const promptText = request.messages
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')))
        .join(' ');
      const promptTokens = Math.max(1, Math.ceil(promptText.length / 4));
      const completionTokens = Math.max(1, Math.ceil(fullContent.length / 4));
      const totalTokens = promptTokens + completionTokens;

      return {
        content: fullContent,
        promptTokens,
        completionTokens,
        totalTokens,
        finishReason: 'stop',
      };
    } catch (err: any) {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      if (err instanceof AppError) {
        throw err;
      }
      if (err.name === 'AbortError') {
        throw new AppError('LLM Provider request timed out during stream', 504, 'PROVIDER_TIMEOUT');
      }
      logger.error('[GeminiLlmProvider] Streaming error:', {
        name: err?.name,
        message: err?.message,
      });
      throw new AppError('Failed during Gemini stream generation', 502, 'PROVIDER_ERROR');
    }
  }
}
