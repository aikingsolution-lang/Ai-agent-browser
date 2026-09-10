import { AppError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';
import type { ILlmProvider, LlmCompletionRequest, LlmCompletionResponse, LlmMessage } from './llmProvider.interface.js';

export class BedrockLlmProvider implements ILlmProvider {
  public readonly providerName = 'bedrock';
  private apiKey: string;
  private region: string;
  private baseUrl: string;

  constructor(apiKey: string, region = 'us-east-1', baseUrl?: string) {
    this.apiKey = apiKey;
    this.region = region;
    this.baseUrl = baseUrl || `https://bedrock-runtime.${region}.amazonaws.com`;
  }

  private formatBedrockMessages(messages: LlmMessage[]) {
    const systemMessages: { text: string }[] = [];
    const bedrockMessages: { role: 'user' | 'assistant'; content: { text: string }[] }[] = [];

    for (const msg of messages) {
      const rawContent = msg.content;
      const textContent =
        typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent || msg.tool_calls || '');

      if (msg.role === 'system') {
        systemMessages.push({ text: textContent || 'System Prompt' });
      } else if (msg.role === 'tool') {
        bedrockMessages.push({
          role: 'user',
          content: [{ text: `[Tool Output ${msg.name || msg.tool_call_id || ''}]: ${textContent || 'Success'}` }],
        });
      } else {
        bedrockMessages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: [{ text: textContent || ' ' }],
        });
      }
    }

    return { systemMessages, bedrockMessages };
  }

  private cleanJsonMarkdown(text: string): string {
    if (!text || typeof text !== 'string') return '';
    let cleaned = text.trim();
    // Strip think/thought XML blocks if present
    cleaned = cleaned.replace(/<(?:think|thought)>[\s\S]*?<\/(?:think|thought)>/gi, '').trim();
    // Strip XML opening/closing tags like <plan>...</plan> or <json>...</json>
    cleaned = cleaned
      .replace(/^<[a-z0-9_-]+>\s*/i, '')
      .replace(/\s*<\/[a-z0-9_-]+>$/i, '')
      .trim();
    // Strip markdown codeblocks
    if (cleaned.startsWith('```')) {
      cleaned = cleaned
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    }
    // If JSON is wrapped inside leftover text/XML, extract first { ... } or [ ... ]
    if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
      const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (match) {
        cleaned = match[1];
      }
    }
    return cleaned.trim();
  }

  public async generateCompletion(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? 30000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const { systemMessages, bedrockMessages } = this.formatBedrockMessages(request.messages);

    const endpoint = `${this.baseUrl}/model/${encodeURIComponent(request.model)}/converse`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          messages: bedrockMessages,
          ...(systemMessages.length > 0 ? { system: systemMessages } : {}),
          inferenceConfig: {
            temperature: request.temperature ?? 0.7,
            ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
          },
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
        const errMsg =
          errorData.message || errorData.error || `AWS Bedrock provider returned HTTP status ${response.status}`;

        if (response.status === 429) {
          throw new AppError('AWS Bedrock rate limit exceeded. Please try again later.', 429, 'PROVIDER_RATE_LIMIT');
        }
        if (response.status >= 500) {
          throw new AppError('AWS Bedrock service error. Please try again later.', 502, 'PROVIDER_ERROR');
        }
        throw new AppError(errMsg, 400, 'PROVIDER_BAD_REQUEST');
      }

      const data: any = await response.json();
      const rawMessageContent = data.output?.message?.content?.[0]?.text || '';
      const messageContent = this.cleanJsonMarkdown(rawMessageContent);
      const usage = data.usage || {};
      const promptTokens = usage.inputTokens || 0;
      const completionTokens = usage.outputTokens || 0;
      const totalTokens = usage.totalTokens || promptTokens + completionTokens;

      return {
        content: messageContent,
        promptTokens,
        completionTokens,
        totalTokens,
        finishReason: data.stopReason || 'stop',
      };
    } catch (err: any) {
      clearTimeout(timer);
      if (err instanceof AppError) {
        throw err;
      }
      if (err.name === 'AbortError') {
        throw new AppError('LLM Provider request timed out', 504, 'PROVIDER_TIMEOUT');
      }
      logger.error('AWS Bedrock Provider Request Error:', err);
      throw new AppError('Failed to communicate with AWS Bedrock provider', 502, 'PROVIDER_ERROR');
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

    const { systemMessages, bedrockMessages } = this.formatBedrockMessages(request.messages);
    const endpoint = `${this.baseUrl}/model/${encodeURIComponent(request.model)}/converse-stream`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          messages: bedrockMessages,
          ...(systemMessages.length > 0 ? { system: systemMessages } : {}),
          inferenceConfig: {
            temperature: request.temperature ?? 0.7,
            ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        if (response.status === 429) {
          throw new AppError('AWS Bedrock rate limit exceeded during stream.', 429, 'PROVIDER_RATE_LIMIT');
        }
        if (response.status >= 500) {
          throw new AppError('AWS Bedrock service error during stream.', 502, 'PROVIDER_ERROR');
        }
        throw new AppError(`AWS Bedrock streaming failed with HTTP ${response.status}`, 400, 'PROVIDER_BAD_REQUEST');
      }

      if (!response.body) {
        throw new AppError('No stream body returned by AWS Bedrock', 502, 'PROVIDER_INVALID_RESPONSE');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse chunks: support JSON lines, SSE lines, or AWS event-stream text matches
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let jsonStr = trimmed;
          if (trimmed.startsWith('data: ')) {
            jsonStr = trimmed.slice(6);
          }

          try {
            const json = JSON.parse(jsonStr);
            const textDelta = json.contentBlockDelta?.delta?.text || json.delta?.text || json.bytes || '';
            if (textDelta) {
              fullContent += textDelta;
              onChunk(textDelta);
            }
          } catch {
            // Regex fallback for binary AWS event streams containing text fragments
            const match = trimmed.match(/"text"\s*:\s*"([^"]+)"/);
            if (match && match[1]) {
              const textDelta = match[1];
              fullContent += textDelta;
              onChunk(textDelta);
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
      logger.error('AWS Bedrock Provider Streaming Error:', err);
      throw new AppError('Failed during AWS Bedrock stream generation', 502, 'PROVIDER_ERROR');
    }
  }
}
