import { AppError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';
import type { ILlmProvider, LlmCompletionRequest, LlmCompletionResponse } from './llmProvider.interface.js';

export class OpenAiLlmProvider implements ILlmProvider {
  public readonly providerName = 'openai';
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = 'https://api.openai.com/v1') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  public async generateCompletion(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? 30000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.temperature ?? 0.7,
          max_tokens: request.maxTokens,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        let errorData: any = {};
        try {
          errorData = await response.json();
        } catch {
          // Response was not JSON
        }
        const errMsg = errorData.error?.message || `OpenAI provider returned HTTP status ${response.status}`;

        if (response.status === 429) {
          throw new AppError('OpenAI rate limit exceeded. Please try again later.', 429, 'PROVIDER_RATE_LIMIT');
        }
        if (response.status >= 500) {
          throw new AppError('OpenAI service error. Please try again later.', 502, 'PROVIDER_ERROR');
        }
        throw new AppError(errMsg, 400, 'PROVIDER_BAD_REQUEST');
      }

      const data: any = await response.json();
      const choice = data.choices?.[0];
      if (!choice) {
        throw new AppError('Invalid response payload from OpenAI', 502, 'PROVIDER_INVALID_RESPONSE');
      }

      const usage = data.usage || {};
      const promptTokens = usage.prompt_tokens || 0;
      const completionTokens = usage.completion_tokens || 0;
      const totalTokens = usage.total_tokens || promptTokens + completionTokens;

      return {
        content: choice.message?.content || '',
        promptTokens,
        completionTokens,
        totalTokens,
        finishReason: choice.finish_reason || 'stop',
      };
    } catch (err: any) {
      clearTimeout(timer);
      if (err instanceof AppError) {
        throw err;
      }
      if (err.name === 'AbortError') {
        throw new AppError('LLM Provider request timed out', 504, 'PROVIDER_TIMEOUT');
      }
      logger.error('OpenAI Provider Request Error:', err);
      throw new AppError('Failed to communicate with OpenAI provider', 502, 'PROVIDER_ERROR');
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

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.temperature ?? 0.7,
          max_tokens: request.maxTokens,
          stream: true,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        if (response.status === 429) {
          throw new AppError('OpenAI rate limit exceeded during stream.', 429, 'PROVIDER_RATE_LIMIT');
        }
        if (response.status >= 500) {
          throw new AppError('OpenAI service error during stream.', 502, 'PROVIDER_ERROR');
        }
        throw new AppError(`OpenAI streaming failed with HTTP ${response.status}`, 400, 'PROVIDER_BAD_REQUEST');
      }

      if (!response.body) {
        throw new AppError('No stream body returned by OpenAI', 502, 'PROVIDER_INVALID_RESPONSE');
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
      logger.error('OpenAI Provider Streaming Error:', err);
      throw new AppError('Failed during OpenAI stream generation', 502, 'PROVIDER_ERROR');
    }
  }
}
