import { AppError } from '../../middleware/errorHandler.js';
import type { ILlmProvider, LlmCompletionRequest, LlmCompletionResponse } from './llmProvider.interface.js';

export interface MockLlmOptions {
  shouldFail?: boolean;
  failStatus?: number;
  failMessage?: string;
  shouldTimeout?: boolean;
  mockResponseText?: string;
}

export class MockLlmProvider implements ILlmProvider {
  public readonly providerName = 'mock';
  private options: MockLlmOptions;

  constructor(options: MockLlmOptions = {}) {
    this.options = options;
  }

  public setOptions(options: MockLlmOptions): void {
    this.options = { ...this.options, ...options };
  }

  public async generateCompletion(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const timeoutMs = request.timeoutMs ?? 10000;

    if (this.options.shouldTimeout) {
      await new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs, 200)));
      throw new AppError('LLM Provider request timed out', 504, 'PROVIDER_TIMEOUT');
    }

    if (this.options.shouldFail) {
      const status = this.options.failStatus ?? 502;
      const message = this.options.failMessage ?? 'LLM Provider service error';
      const code = status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_ERROR';
      throw new AppError(message, status, code);
    }

    const promptText = request.messages.map(m => m.content).join(' ');
    const promptTokens = Math.max(1, Math.ceil(promptText.length / 4));

    const content =
      this.options.mockResponseText ??
      `Mock response for model '${request.model}': I have processed your request with ${request.messages.length} messages.`;
    const completionTokens = Math.max(1, Math.ceil(content.length / 4));
    const totalTokens = promptTokens + completionTokens;

    return {
      content,
      promptTokens,
      completionTokens,
      totalTokens,
      finishReason: 'stop',
    };
  }

  public async streamCompletion(
    request: LlmCompletionRequest,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<LlmCompletionResponse> {
    if (this.options.shouldTimeout) {
      throw new AppError('LLM Provider request timed out during stream', 504, 'PROVIDER_TIMEOUT');
    }

    if (this.options.shouldFail) {
      const status = this.options.failStatus ?? 502;
      const message = this.options.failMessage ?? 'LLM Provider service error during stream';
      const code = status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_ERROR';
      throw new AppError(message, status, code);
    }

    const promptText = request.messages.map(m => m.content).join(' ');
    const promptTokens = Math.max(1, Math.ceil(promptText.length / 4));

    const content = this.options.mockResponseText ?? `Mock streaming response for model '${request.model}'.`;

    const chunks = content.split(' ');
    let emittedContent = '';

    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) {
        break;
      }
      const chunkText = (i > 0 ? ' ' : '') + chunks[i];
      emittedContent += chunkText;
      onChunk(chunkText);
    }

    const completionTokens = Math.max(1, Math.ceil(emittedContent.length / 4));
    const totalTokens = promptTokens + completionTokens;

    return {
      content: emittedContent,
      promptTokens,
      completionTokens,
      totalTokens,
      finishReason: signal?.aborted ? 'length' : 'stop',
    };
  }
}
