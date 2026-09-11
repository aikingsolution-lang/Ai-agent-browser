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

  public formatBedrockMessages(messages: LlmMessage[]) {
    const systemMessages: { text: string }[] = [];
    const rawBedrockMessages: { role: 'user' | 'assistant'; content: { text: string }[] }[] = [];

    for (const msg of messages) {
      const rawContent = msg.content;
      const textContent =
        typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent || msg.tool_calls || '');

      if (msg.role === 'system') {
        systemMessages.push({ text: textContent || 'System Prompt' });
      } else if (msg.role === 'tool') {
        rawBedrockMessages.push({
          role: 'user',
          content: [{ text: `Observation (${msg.name || msg.tool_call_id || 'tool'}): ${textContent || 'Success'}` }],
        });
      } else {
        // Only push non-empty content — skip whitespace-only blocks (they cause Bedrock to return empty responses)
        const text = textContent?.trim();
        if (text) {
          rawBedrockMessages.push({
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: [{ text }],
          });
        } else if (msg.role !== 'assistant') {
          // For user messages with no content, push a placeholder
          rawBedrockMessages.push({
            role: 'user',
            content: [{ text: 'Continue.' }],
          });
        }
        // Empty/whitespace assistant turns are silently dropped — they cause Bedrock blank responses
      }
    }

    // STRICT Bedrock Converse API Turn Alternation:
    // Bedrock Converse API requires strictly alternating roles (user -> assistant -> user -> assistant).
    // Merge consecutive messages of the same role so they never produce empty responses or schema errors.
    const bedrockMessages: { role: 'user' | 'assistant'; content: { text: string }[] }[] = [];

    for (const item of rawBedrockMessages) {
      // Sanity: drop assistant items that somehow ended up with only whitespace content
      const cleanedContent = item.content.filter(b => b.text?.trim());
      if (cleanedContent.length === 0) {
        // Skip entirely — don't push ghost assistant turns
        continue;
      }
      const cleanedItem = { role: item.role, content: cleanedContent };

      if (bedrockMessages.length === 0) {
        if (cleanedItem.role === 'assistant') {
          bedrockMessages.push({ role: 'user', content: [{ text: 'Begin task' }] });
        }
        bedrockMessages.push(cleanedItem);
      } else {
        const last = bedrockMessages[bedrockMessages.length - 1];
        if (last.role === cleanedItem.role) {
          last.content.push(...cleanedItem.content);
        } else {
          bedrockMessages.push(cleanedItem);
        }
      }
    }

    // Ensure the last message is always 'user' so the assistant knows to produce the next response
    if (bedrockMessages.length > 0 && bedrockMessages[bedrockMessages.length - 1].role === 'assistant') {
      bedrockMessages.push({ role: 'user', content: [{ text: 'Please provide the next step.' }] });
    }

    return { systemMessages, bedrockMessages };
  }

  public cleanJsonMarkdown(text: string): string {
    if (!text || typeof text !== 'string') return '';
    let cleaned = text.trim();

    // 1. Strip think/thought XML blocks if present
    cleaned = cleaned.replace(/<(?:think|thought)>[\s\S]*?<\/(?:think|thought)>/gi, '').trim();

    // 2. Strip XML opening/closing tags like <plan>...</plan>, <json>...</json>, <output>...</output>
    cleaned = cleaned
      .replace(/^<[a-z0-9_-]+>\s*/i, '')
      .replace(/\s*<\/[a-z0-9_-]+>$/i, '')
      .trim();

    // 3. Strip markdown codeblocks
    if (cleaned.includes('```')) {
      const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (match && match[1]) {
        cleaned = match[1].trim();
      } else {
        const parts = cleaned.split('```');
        if (parts.length >= 2) {
          cleaned = parts[1].replace(/^json\s*/i, '').trim();
        }
      }
    }

    // 4. Strip bracketed prefix headers like [Tool Output 1]:, [Action]:, [Tool Use]: etc.
    cleaned = cleaned
      .replace(/^\[(?:Tool\s+Output|Tool\s+Use|Tool|Action|Observation|Result|Call|Response)[^\]]*\]:?\s*/i, '')
      .trim();

    // 5. Test if already valid JSON directly
    try {
      JSON.parse(cleaned);
      return cleaned;
    } catch {
      // Continue to candidate extraction
    }

    // 6. Generic balanced candidate JSON extractor
    // Find all potential JSON start positions ('{' or '[')
    const candidates: string[] = [];
    for (let i = 0; i < cleaned.length; i++) {
      const char = cleaned[i];
      if (char === '{' || char === '[') {
        const openChar = char;
        const closeChar = char === '{' ? '}' : ']';
        let depth = 0;
        let inString = false;
        let escape = false;

        for (let j = i; j < cleaned.length; j++) {
          const c = cleaned[j];
          if (inString) {
            if (escape) {
              escape = false;
            } else if (c === '\\') {
              escape = true;
            } else if (c === '"') {
              inString = false;
            }
          } else {
            if (c === '"') {
              inString = true;
            } else if (c === openChar) {
              depth++;
            } else if (c === closeChar) {
              depth--;
              if (depth === 0) {
                candidates.push(cleaned.substring(i, j + 1));
                break;
              }
            }
          }
        }
      }
    }

    // Prefer candidates that parse as valid JSON
    for (const cand of candidates) {
      try {
        const parsed = JSON.parse(cand);
        if (parsed && typeof parsed === 'object') {
          return cand;
        }
      } catch {
        // Try fixing trailing commas
        try {
          const fixed = cand.replace(/,\s*([}\]])/g, '$1');
          JSON.parse(fixed);
          return fixed;
        } catch {
          // not valid JSON
        }
      }
    }

    // If no candidate parsed cleanly, fallback to the largest object candidate if available
    const objCandidates = candidates.filter(c => c.startsWith('{') && c.endsWith('}'));
    if (objCandidates.length > 0) {
      objCandidates.sort((a, b) => b.length - a.length);
      return objCandidates[0].trim();
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.length - a.length);
      return candidates[0].trim();
    }

    return cleaned.trim();
  }

  public async generateCompletion(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? 30000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const { systemMessages, bedrockMessages } = this.formatBedrockMessages(request.messages);

    const endpoint = `${this.baseUrl}/model/${encodeURIComponent(request.model)}/converse`;

    const effectiveMaxTokens = request.maxTokens || 4096;
    const requestPayload: any = {
      messages: bedrockMessages,
      ...(systemMessages.length > 0 ? { system: systemMessages } : {}),
      inferenceConfig: {
        temperature: request.temperature ?? 0.7,
        maxTokens: effectiveMaxTokens,
      },
    };

    logger.info(
      `[BedrockLlmProvider] === BEDROCK CONVERSE REQUEST ===\n` +
        JSON.stringify(
          {
            model: request.model,
            endpoint,
            inferenceConfig: requestPayload.inferenceConfig,
            systemCount: systemMessages.length,
            turnCount: bedrockMessages.length,
            turns: bedrockMessages.map((m, idx) => ({
              turn: idx + 1,
              role: m.role,
              blocks: m.content?.length,
              preview: m.content?.map((c: any) =>
                typeof c.text === 'string'
                  ? c.text.length > 80
                    ? c.text.substring(0, 80) + '...'
                    : c.text
                  : Object.keys(c),
              ),
            })),
          },
          null,
          2,
        ),
    );

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

      let rawMessageContent = '';
      if (Array.isArray(data.output?.message?.content)) {
        for (const block of data.output.message.content) {
          if (typeof block.text === 'string') {
            rawMessageContent += block.text;
          } else if (block.toolUse?.input) {
            rawMessageContent += JSON.stringify(block.toolUse.input);
          } else if (typeof block.reasoningContent?.text === 'string') {
            rawMessageContent += block.reasoningContent.text;
          } else {
            rawMessageContent += JSON.stringify(block);
          }
        }
      }

      logger.info(
        `[BedrockLlmProvider] === BEDROCK CONVERSE RESPONSE ===\n` +
          `Model: ${request.model}\n` +
          `StopReason: ${data.stopReason || 'none'}\n` +
          `Usage: ${JSON.stringify(data.usage || {})}\n` +
          `ContentBlocksCount: ${data.output?.message?.content?.length || 0}\n` +
          `RawLength: ${rawMessageContent.length}`,
      );

      if (rawMessageContent) {
        logger.info(`[BedrockLlmProvider] Raw output:\n${rawMessageContent}`);
      } else {
        logger.warn(
          `[BedrockLlmProvider] EMPTY raw output from ${request.model}! Full Bedrock response:\n${JSON.stringify(data, null, 2)}`,
        );
      }

      // Check if content was blocked by Bedrock guardrail or safety filter
      if (data.stopReason === 'content_filtered') {
        throw new AppError('AWS Bedrock safety filter blocked the web page content.', 400, 'PROVIDER_CONTENT_FILTERED');
      }

      // If Bedrock returned an empty response, throw 502 so 0 credits are deducted instead of crashing the client with empty JSON
      if (!rawMessageContent.trim()) {
        throw new AppError(
          `AWS Bedrock provider returned an empty completion (stopReason: ${data.stopReason || 'unknown'})`,
          502,
          'PROVIDER_EMPTY_RESPONSE',
        );
      }

      const messageContent = this.cleanJsonMarkdown(rawMessageContent);
      if (messageContent !== rawMessageContent) {
        logger.info(`[BedrockLlmProvider] Cleaned JSON output (length: ${messageContent.length}):\n${messageContent}`);
      }
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
            maxTokens: request.maxTokens || 4096,
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
