import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { GeminiLlmProvider } from '../services/llm/geminiLlmProvider.js';
import { LlmProviderFactory } from '../services/llm/llmProviderFactory.js';
import { AppError } from '../middleware/errorHandler.js';
import { env } from '../config/env.js';
import { registerViaApi, rtdb } from './helpers/testApi.js';
import { resetFirebase } from './helpers/firebaseTestEnv.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { CreditRepository } from '../services/rtdb/repositories.js';

describe('GeminiLlmProvider & Hardening Tests', () => {
  const mockApiKey = 'test-gemini-key-12345';
  const mockBaseUrl = 'https://mock.gemini.api/v1beta/openai';
  let provider: GeminiLlmProvider;

  beforeEach(() => {
    provider = new GeminiLlmProvider(mockApiKey, 'gemini-3.5-flash', mockBaseUrl);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    LlmProviderFactory.reset();
  });

  it('1. Success: generates text completion and parses usage correctly', async () => {
    const mockResponsePayload = {
      id: 'chatcmpl-test-123',
      object: 'chat.completion',
      created: 1730000000,
      model: 'gemini-3.5-flash',
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
      model: 'gemini-3.5-flash',
      messages: [{ role: 'user', content: 'Say hello' }],
      temperature: 0.2,
      maxTokens: 500,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOptions] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe(`${mockBaseUrl}/chat/completions`);
    expect((calledOptions as any).headers['Authorization']).toBe(`Bearer ${mockApiKey}`);
    const parsedBody = JSON.parse((calledOptions as any).body);
    expect(parsedBody.model).toBe('gemini-3.5-flash');
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
                  name: 'NavigatorAgentOutput',
                  arguments:
                    '{"currentState":{"page_summary":"On job page"},"action":[{"type":"click","selector":"#apply"}]}',
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
      model: 'gemini-3.5-flash',
      messages: [{ role: 'user', content: 'Submit the application form' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'NavigatorAgentOutput',
            parameters: { type: 'object' },
          },
        },
      ],
      tool_choice: {
        type: 'function',
        function: { name: 'NavigatorAgentOutput' },
      },
    });

    expect(result.content).toBe('');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].id).toBe('call_abc123');
    expect(result.toolCalls![0].function.name).toBe('NavigatorAgentOutput');
    expect(result.totalTokens).toBe(70);
  });

  it('3. Retry with exponential backoff: succeeds after 1 retryable failure (503 then 200)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({
          error: { code: 503, message: 'High demand spike' },
        }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: { role: 'assistant', content: 'Recovered from spike!' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      } as any);

    const result = await provider.generateCompletion({
      model: 'gemini-3.5-flash',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('Recovered from spike!');
    expect(result.totalTokens).toBe(15);
  });

  it('4. 429: Rate limit exceeded maps to AppError 429 PROVIDER_RATE_LIMIT after retries exhausted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
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
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({
      statusCode: 429,
      code: 'PROVIDER_RATE_LIMIT',
      message: expect.stringContaining('rate limit exceeded'),
    });
  });

  it('5. 403/401: Auth failure does NOT retry and maps directly to AppError 403 PROVIDER_AUTH_ERROR', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
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
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PROVIDER_AUTH_ERROR',
      message: expect.stringContaining('authentication failed'),
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('6. 400: Bad request does NOT retry and maps to AppError 400 PROVIDER_BAD_REQUEST', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
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
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'PROVIDER_BAD_REQUEST',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('7. Timeout: AbortError maps to AppError 504 PROVIDER_TIMEOUT', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(abortErr);

    await expect(
      provider.generateCompletion({
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({
      statusCode: 504,
      code: 'PROVIDER_TIMEOUT',
      message: expect.stringContaining('timed out'),
    });
  });

  it('8. Malformed response: missing choices array throws AppError 502 PROVIDER_INVALID_RESPONSE', async () => {
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
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'PROVIDER_INVALID_RESPONSE',
    });
  });

  it('9. Empty response due to reasoning/length exhaustion throws 502 PROVIDER_EMPTY_RESPONSE', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'chatcmpl-reasoning-exhausted',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
            },
            finish_reason: 'length',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 4096, total_tokens: 4196 },
      }),
    } as any);

    await expect(
      provider.generateCompletion({
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'Complex logic problem' }],
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'PROVIDER_EMPTY_RESPONSE',
      message: expect.stringContaining('empty completion'),
    });
  });

  it('10. LlmProviderFactory fails loudly when GEMINI_API_KEY is missing outside test environment', () => {
    const origEnv = env.NODE_ENV;
    const origKey = env.GEMINI_API_KEY;

    try {
      (env as any).NODE_ENV = 'production';
      (env as any).LLM_PROVIDER = 'gemini';
      (env as any).GEMINI_API_KEY = '';

      expect(() => LlmProviderFactory.getProvider()).toThrowError(AppError);
      expect(() => LlmProviderFactory.getProvider()).toThrowError(/GEMINI_API_KEY is missing or empty/i);
    } finally {
      (env as any).NODE_ENV = origEnv;
      (env as any).GEMINI_API_KEY = origKey;
    }
  });

  it('11. End-to-end Controller: NavigatorAgent structuredOutput request returns tool_calls unchanged in OpenAI shape', async () => {
    await resetFirebase();
    await PlanSeedService.seedDefaultPlans();
    const app = createApp();
    const user = await registerViaApi(app, { name: 'Nav Test User', email: 'nav-test@example.com' });

    // Mock Gemini returning tool calls
    const mockToolCallResponse = {
      content: '',
      promptTokens: 80,
      completionTokens: 35,
      totalTokens: 115,
      finishReason: 'tool_calls',
      toolCalls: [
        {
          id: 'call_nav_001',
          type: 'function',
          function: {
            name: 'NavigatorAgentOutput',
            arguments: JSON.stringify({
              currentState: { page_summary: 'Easy Apply modal opened' },
              action: [{ type: 'click', selector: 'button[aria-label="Continue to next step"]' }],
            }),
          },
        },
      ],
    };

    const mockProvider = {
      providerName: 'gemini',
      generateCompletion: vi.fn().mockResolvedValue(mockToolCallResponse),
      streamCompletion: vi.fn(),
    };

    LlmProviderFactory.setOverrideProvider(mockProvider as any);

    const structuredTools = [
      {
        type: 'function',
        function: {
          name: 'NavigatorAgentOutput',
          description: 'Navigator structured output schema',
          parameters: {
            type: 'object',
            properties: {
              currentState: { type: 'object' },
              action: { type: 'array' },
            },
            required: ['currentState', 'action'],
          },
        },
      },
    ];

    const res = await request(app)
      .post('/api/v1/llm/chat/completions')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'What is the next action?' }],
        tools: structuredTools,
        tool_choice: { type: 'function', function: { name: 'NavigatorAgentOutput' } },
      });

    expect(res.status).toBe(200);
    expect(res.body.object).toBe('chat.completion');
    expect(res.body.choices).toHaveLength(1);
    const choice = res.body.choices[0];
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.role).toBe('assistant');
    expect(choice.message.content).toBe('');
    expect(choice.message.tool_calls).toHaveLength(1);
    expect(choice.message.tool_calls[0].id).toBe('call_nav_001');
    expect(choice.message.tool_calls[0].function.name).toBe('NavigatorAgentOutput');
    const parsedArgs = JSON.parse(choice.message.tool_calls[0].function.arguments);
    expect(parsedArgs.currentState.page_summary).toBe('Easy Apply modal opened');
    expect(parsedArgs.action[0].type).toBe('click');

    // Confirm token usage passed through
    expect(res.body.usage.prompt_tokens).toBe(80);
    expect(res.body.usage.completion_tokens).toBe(35);
    expect(res.body.usage.total_tokens).toBe(115);
  });

  it('12. Model Fallback Chain: primary model 404 automatically falls back to fallbackModel', async () => {
    const fallbackProvider = new GeminiLlmProvider(
      mockApiKey,
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      mockBaseUrl,
    );

    let callCount = 0;
    const requestedModels: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url, init) => {
        callCount++;
        const body = JSON.parse(init.body);
        requestedModels.push(body.model);

        if (body.model === 'gemini-3.5-flash') {
          // Primary model retired / 404
          return Promise.resolve({
            ok: false,
            status: 404,
            json: () =>
              Promise.resolve({
                error: {
                  code: 404,
                  message: 'This model models/gemini-3.5-flash is no longer available.',
                  status: 'NOT_FOUND',
                },
              }),
          });
        }

        // Fallback model succeeds
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Fallback response from gemini-3.5-flash-lite' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
            }),
        });
      }),
    );

    const res = await fallbackProvider.generateCompletion({
      model: 'gemini-3.5-flash',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(callCount).toBe(2);
    expect(requestedModels).toEqual(['gemini-3.5-flash', 'gemini-3.5-flash-lite']);
    expect(res.content).toBe('Fallback response from gemini-3.5-flash-lite');
    expect(res.totalTokens).toBe(18);
  });

  it('13. Model Fallback Chain: primary model 503 high demand falls back to fallbackModel', async () => {
    const fallbackProvider = new GeminiLlmProvider(
      mockApiKey,
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      mockBaseUrl,
    );

    const requestedModels: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url, init) => {
        const body = JSON.parse(init.body);
        requestedModels.push(body.model);

        if (body.model === 'gemini-3.5-flash') {
          // Primary model 503 high demand (non-retryable after backoff or direct)
          return Promise.resolve({
            ok: false,
            status: 503,
            json: () =>
              Promise.resolve({
                error: {
                  code: 503,
                  message: 'This model is currently experiencing high demand.',
                  status: 'UNAVAILABLE',
                },
              }),
          });
        }

        // Fallback model succeeds
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Fallback OK' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
            }),
        });
      }),
    );

    const res = await fallbackProvider.generateCompletion({
      model: 'gemini-3.5-flash',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(requestedModels).toContain('gemini-3.5-flash');
    expect(requestedModels).toContain('gemini-3.5-flash-lite');
    expect(res.content).toBe('Fallback OK');
  });

  it('14. Model Fallback Chain: throws when both primary and fallback fail', async () => {
    const fallbackProvider = new GeminiLlmProvider(
      mockApiKey,
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      mockBaseUrl,
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () =>
          Promise.resolve({
            error: {
              code: 404,
              message: 'Model not found',
              status: 'NOT_FOUND',
            },
          }),
      }),
    );

    await expect(
      fallbackProvider.generateCompletion({
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    ).rejects.toThrow();
  });
});
