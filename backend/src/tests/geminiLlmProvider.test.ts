import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiLlmProvider } from '../services/llm/geminiLlmProvider.js';
import { AppError } from '../middleware/errorHandler.js';

describe('GeminiLlmProvider Unit Tests', () => {
  const mockApiKey = 'test-gemini-key-12345';
  const mockBaseUrl = 'https://mock.gemini.api/v1beta/openai';
  let provider: GeminiLlmProvider;

  beforeEach(() => {
    provider = new GeminiLlmProvider(mockApiKey, 'gemini-2.5-flash', mockBaseUrl);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Success: generates text completion and parses usage correctly', async () => {
    const mockResponsePayload = {
      id: 'chatcmpl-test-123',
      object: 'chat.completion',
      created: 1730000000,
      model: 'gemini-2.5-flash',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello! I am Google Gemini via the OpenAI-compatible gateway.',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 25,
        completion_tokens: 15,
        total_tokens: 40,
      },
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockResponsePayload,
    } as any);

    const result = await provider.generateCompletion({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Say hello' }],
      temperature: 0.2,
      maxTokens: 500,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOptions] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe(`${mockBaseUrl}/chat/completions`);
    expect((calledOptions as any).headers['Authorization']).toBe(`Bearer ${mockApiKey}`);
    const parsedBody = JSON.parse((calledOptions as any).body);
    expect(parsedBody.model).toBe('gemini-2.5-flash');
    expect(parsedBody.temperature).toBe(0.2);
    expect(parsedBody.max_tokens).toBe(500);

    expect(result.content).toBe('Hello! I am Google Gemini via the OpenAI-compatible gateway.');
    expect(result.promptTokens).toBe(25);
    expect(result.completionTokens).toBe(15);
    expect(result.totalTokens).toBe(40);
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toBeUndefined();
  });

  it('2. Tool call: parses tool_calls in message and sets finishReason to tool_calls', async () => {
    const mockResponsePayload = {
      id: 'chatcmpl-tool-123',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_abc123',
                type: 'function',
                function: {
                  name: 'click_element',
                  arguments: '{"selector":"#submit-button"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 20,
        total_tokens: 70,
      },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockResponsePayload,
    } as any);

    const result = await provider.generateCompletion({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Submit the application form' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'click_element',
            parameters: { type: 'object', properties: { selector: { type: 'string' } } },
          },
        },
      ],
    });

    expect(result.content).toBe('');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].id).toBe('call_abc123');
    expect(result.toolCalls![0].function.name).toBe('click_element');
    expect(result.totalTokens).toBe(70);
  });

  it('3. 429: Rate limit exceeded maps to AppError 429 PROVIDER_RATE_LIMIT', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({
        error: {
          code: 429,
          message: 'Resource has been exhausted (e.g. check quota).',
          status: 'RESOURCE_EXHAUSTED',
        },
      }),
    } as any);

    await expect(
      provider.generateCompletion({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({
      statusCode: 429,
      code: 'PROVIDER_RATE_LIMIT',
      message: expect.stringContaining('rate limit exceeded'),
    });
  });

  it('4. 403/401: Auth failure maps to AppError 403 PROVIDER_AUTH_ERROR', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({
        error: {
          code: 403,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'PERMISSION_DENIED',
        },
      }),
    } as any);

    await expect(
      provider.generateCompletion({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PROVIDER_AUTH_ERROR',
      message: expect.stringContaining('authentication failed'),
    });
  });

  it('5. 400: Bad request maps to AppError 400 PROVIDER_BAD_REQUEST', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          code: 400,
          message: 'Invalid argument provided.',
          status: 'INVALID_ARGUMENT',
        },
      }),
    } as any);

    await expect(
      provider.generateCompletion({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'PROVIDER_BAD_REQUEST',
    });
  });

  it('6. Timeout: AbortError maps to AppError 504 PROVIDER_TIMEOUT', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(abortErr);

    await expect(
      provider.generateCompletion({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({
      statusCode: 504,
      code: 'PROVIDER_TIMEOUT',
      message: expect.stringContaining('timed out'),
    });
  });

  it('7. Malformed response: missing choices array throws AppError 502 PROVIDER_INVALID_RESPONSE', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'chatcmpl-broken',
        choices: [],
      }),
    } as any);

    await expect(
      provider.generateCompletion({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'PROVIDER_INVALID_RESPONSE',
    });
  });

  it('8. Malformed response: invalid JSON body throws AppError 502 PROVIDER_INVALID_RESPONSE', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token < in JSON at position 0');
      },
    } as any);

    await expect(
      provider.generateCompletion({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'PROVIDER_INVALID_RESPONSE',
    });
  });
});
