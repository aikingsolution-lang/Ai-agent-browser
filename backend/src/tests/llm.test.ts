import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { LlmProviderFactory } from '../services/llm/llmProviderFactory.js';
import { BedrockLlmProvider } from '../services/llm/bedrockLlmProvider.js';
import { resetFirebase } from './helpers/firebaseTestEnv.js';
import { registerViaApi, rtdb } from './helpers/testApi.js';

const app = createApp();

describe('Phase 9 & Bedrock: Managed LLM Proxy Gateway + Usage Metering (Firebase RTDB)', () => {
  beforeEach(async () => {
    LlmProviderFactory.reset();
    await resetFirebase();
    await PlanSeedService.seedDefaultPlans();
  });

  async function registerUser(emailPrefix: string) {
    const user = await registerViaApi(app, { name: `${emailPrefix} User`, email: `${emailPrefix}@llmtest.com` });
    return { token: user.token, userId: user.uid };
  }

  it('1. Unauthenticated request to /api/v1/llm/chat is rejected with 401', async () => {
    const res = await request(app)
      .post('/api/v1/llm/chat')
      .send({ model: 'anthropic.claude-3-haiku-20240307-v1:0', messages: [{ role: 'user', content: 'Hello' }] });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('2. Request with invalid model is rejected with 400 Bad Request', async () => {
    const { token } = await registerUser('invalidmodel');

    const res = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ model: 'unsupported-super-model-v99', messages: [{ role: 'user', content: 'Hello' }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('3. Insufficient credits rejected with 402 INSUFFICIENT_CREDITS before calling provider', async () => {
    const { token, userId } = await registerUser('nocredits');
    await rtdb.patchBalance(userId, { remainingCredits: 0, usedCredits: 100 });

    const res = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ model: 'anthropic.claude-3-haiku-20240307-v1:0', messages: [{ role: 'user', content: 'Hello' }] });

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('INSUFFICIENT_CREDITS');
    expect(await rtdb.llmUsage(userId)).toHaveLength(0);
  });

  it('4. Successful LLM chat request deducts credits and records usage log', async () => {
    const { token, userId } = await registerUser('success');

    // No idempotency key and no run id: the usage log must still be written (no undefined fields reach RTDB).
    const res = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        messages: [{ role: 'user', content: 'What is the capital of France?' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.content).toBeDefined();
    expect(res.body.data.creditsDeducted).toBeGreaterThan(0);
    expect(res.body.data.isIdempotentRetry).toBe(false);

    const balance = await rtdb.balance(userId);
    expect(balance.remainingCredits).toBe(100 - res.body.data.creditsDeducted);

    const usageLog = (await rtdb.llmUsage(userId)).find(log => log.requestId === res.body.data.requestId);
    expect(usageLog).toBeDefined();
    expect(usageLog.status).toBe('SUCCESS');
    expect(usageLog.model).toBe('anthropic.claude-3-haiku-20240307-v1:0');

    const deduction = (await rtdb.ledger(userId)).find(entry => entry.type === 'USAGE_DEDUCTION');
    expect(deduction.metadata.requestId).toBe(res.body.data.requestId);
  });

  it('5. Duplicate request with same idempotencyKey returns cached response without double billing', async () => {
    const { token, userId } = await registerUser('idempotent');
    const idempotencyKey = 'llm-key-9999';
    const body = {
      model: 'anthropic.claude-3-haiku-20240307-v1:0',
      messages: [{ role: 'user', content: 'Explain quantum computing in 5 words.' }],
    };

    const res1 = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .set('x-idempotency-key', idempotencyKey)
      .send(body);
    expect(res1.status).toBe(200);
    expect(res1.body.data.isIdempotentRetry).toBe(false);
    const creditsSpent1 = res1.body.data.creditsDeducted;

    const res2 = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .set('x-idempotency-key', idempotencyKey)
      .send(body);
    expect(res2.status).toBe(200);
    expect(res2.body.data.isIdempotentRetry).toBe(true);
    expect(res2.body.data.requestId).toBe(res1.body.data.requestId);

    expect((await rtdb.balance(userId)).remainingCredits).toBe(100 - creditsSpent1);
    expect((await rtdb.llmUsage(userId)).filter(log => log.idempotencyKey === idempotencyKey)).toHaveLength(1);
  });

  it('6. Provider failure returns 502 Provider Error and deducts 0 credits', async () => {
    const { token, userId } = await registerUser('providerfail');
    LlmProviderFactory.setMockOptions({ shouldFail: true, failStatus: 502, failMessage: 'AWS Bedrock server down' });

    const res = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ model: 'anthropic.claude-3-haiku-20240307-v1:0', messages: [{ role: 'user', content: 'Test failure' }] });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PROVIDER_ERROR');
    expect((await rtdb.balance(userId)).remainingCredits).toBe(100);

    const failedLog = (await rtdb.llmUsage(userId)).find(log => log.status === 'FAILED');
    expect(failedLog).toBeDefined();
    expect(failedLog.creditsDeducted).toBe(0);
  });

  it('7. Provider timeout returns 504 Gateway Timeout and deducts 0 credits', async () => {
    const { token, userId } = await registerUser('providertimeout');
    LlmProviderFactory.setMockOptions({ shouldTimeout: true });

    const res = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ model: 'anthropic.claude-3-haiku-20240307-v1:0', messages: [{ role: 'user', content: 'Test timeout' }] });

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('PROVIDER_TIMEOUT');
    expect((await rtdb.balance(userId)).remainingCredits).toBe(100);

    const failedLog = (await rtdb.llmUsage(userId)).find(log => ['FAILED', 'TIMEOUT'].includes(log.status));
    expect(failedLog).toBeDefined();
    expect(failedLog.creditsDeducted).toBe(0);
  });

  it('8. User isolation: User A cannot see User B usage logs via GET /api/v1/llm/usage', async () => {
    const userA = await registerUser('usera');
    const userB = await registerUser('userb');

    await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ model: 'anthropic.claude-3-haiku-20240307-v1:0', messages: [{ role: 'user', content: 'User A query' }] });

    const resB = await request(app).get('/api/v1/llm/usage').set('Authorization', `Bearer ${userB.token}`);
    expect(resB.status).toBe(200);
    expect(resB.body.data.items.length).toBe(0);
    expect(resB.body.data.total).toBe(0);

    const resA = await request(app).get('/api/v1/llm/usage').set('Authorization', `Bearer ${userA.token}`);
    expect(resA.status).toBe(200);
    expect(resA.body.data.items.length).toBe(1);
    expect(resA.body.data.total).toBe(1);
    expect(resA.body.data.items[0].userId).toBe(userA.userId);
    expect(resA.body.data.items[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('9. Token and credit accounting for premium model anthropic.claude-3-5-sonnet-20240620-v1:0', async () => {
    const { token, userId } = await registerUser('premiummodel');

    const res = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        model: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        messages: [{ role: 'user', content: 'Write a detailed summary of astrophysics.' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.model).toBe('anthropic.claude-3-5-sonnet-20240620-v1:0');
    expect(res.body.data.creditsDeducted).toBeGreaterThanOrEqual(2);
    expect((await rtdb.balance(userId)).remainingCredits).toBe(100 - res.body.data.creditsDeducted);
  });

  it('10. SSE Streaming chat completion returns text/event-stream chunks', async () => {
    const { token, userId } = await registerUser('streaming');

    const res = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .set('x-run-id', 'run-stream-1')
      .send({
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        messages: [{ role: 'user', content: 'Tell me a joke.' }],
        stream: true,
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('data:');
    expect(res.text).toContain('[DONE]');

    // Streaming usage is billed and tagged with the run id (so it can be refunded per run)
    const deduction = (await rtdb.ledger(userId)).find(entry => entry.type === 'USAGE_DEDUCTION');
    expect(deduction.runId).toBe('run-stream-1');
  });

  it('11. BedrockLlmProvider handles Converse API response structure correctly with Bearer token', async () => {
    const mockApiKey = 'bedrock-bearer-test-token-12345';
    const provider = new BedrockLlmProvider(mockApiKey, 'us-east-1');
    expect(provider.providerName).toBe('bedrock');

    // Save global fetch
    const originalFetch = global.fetch;
    global.fetch = async (url: any, options: any) => {
      expect(options.headers.Authorization).toBe(`Bearer ${mockApiKey}`);
      expect(url).toContain('/model/anthropic.claude-3-5-sonnet-20240620-v1%3A0/converse');

      return new Response(
        JSON.stringify({
          output: {
            message: {
              role: 'assistant',
              content: [{ text: 'Mocked AWS Bedrock completion response' }],
            },
          },
          stopReason: 'end_turn',
          usage: {
            inputTokens: 12,
            outputTokens: 18,
            totalTokens: 30,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    try {
      const response = await provider.generateCompletion({
        model: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        messages: [{ role: 'user', content: 'Hello Bedrock' }],
      });

      expect(response.content).toBe('Mocked AWS Bedrock completion response');
      expect(response.promptTokens).toBe(12);
      expect(response.completionTokens).toBe(18);
      expect(response.totalTokens).toBe(30);
      expect(response.finishReason).toBe('end_turn');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("12. Accepts multi-turn chat messages with role = 'tool', empty content, and tool_calls without validation errors", async () => {
    const { token } = await registerUser('toolmessages');

    const res = await request(app)
      .post('/api/v1/llm/chat/completions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        model: 'amazon.nova-lite-v1:0',
        messages: [
          { role: 'user', content: 'Go to google.com' },
          { role: 'assistant', content: 'I will navigate to google.com' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', name: 'navigate' }] },
          { role: 'tool', content: 'Successfully navigated', tool_call_id: 'call_1' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.object).toBe('chat.completion');
    expect(res.body.choices).toBeDefined();
  });

  it('13. cleanJsonMarkdown extracts valid JSON from raw Nova Lite response prefixed with [Tool Output ...]', () => {
    const provider = new BedrockLlmProvider('test-key', 'us-east-1');

    // Fixture 1: Nova Lite outputting [Tool Output 1]: { ... }
    const rawFixture1 = `[Tool Output 1]: {
      "current_state": {
        "evaluation_previous_goal": "Successfully opened Amazon homepage",
        "memory": "Navigated to amazon.in",
        "next_goal": "Search for earphones under 5000"
      },
      "action": [
        { "input_text": { "index": 22, "text": "earphones" } }
      ]
    }`;

    const cleaned1 = provider.cleanJsonMarkdown(rawFixture1);
    const parsed1 = JSON.parse(cleaned1);
    expect(parsed1.current_state.evaluation_previous_goal).toBe('Successfully opened Amazon homepage');
    expect(parsed1.action).toHaveLength(1);
    expect(parsed1.action[0].input_text.text).toBe('earphones');

    // Fixture 2: Conversational preamble + [Tool Output]: + JSON + trailing text
    const rawFixture2 = `Based on the current page:\n[Tool Output]: {"current_state": {"memory": "step 2"}, "actions": [{"click_element": {"index": 5}}]}\nNote: click the search button next.`;
    const cleaned2 = provider.cleanJsonMarkdown(rawFixture2);
    const parsed2 = JSON.parse(cleaned2);
    expect(parsed2.current_state.memory).toBe('step 2');
    expect(parsed2.actions[0].click_element.index).toBe(5);

    // Fixture 3: Codeblock with think tags
    const rawFixture3 = `<think>I need to search on amazon.</think>\`\`\`json\n{"current_state": {"next_goal": "done"}, "action": [{"done": {"text": "task complete"}}]}\n\`\`\``;
    const cleaned3 = provider.cleanJsonMarkdown(rawFixture3);
    const parsed3 = JSON.parse(cleaned3);
    expect(parsed3.current_state.next_goal).toBe('done');
    expect(parsed3.action[0].done.text).toBe('task complete');
  });

  it('14. End-to-end LLM proxy cleans [Tool Output] Bedrock response so client receives valid JSON and credits are deducted', async () => {
    const { token, userId } = await registerUser('bedrocktoolfixture');

    const bedrockProvider = new BedrockLlmProvider('test-key', 'us-east-1');
    LlmProviderFactory.setOverrideProvider(bedrockProvider);

    const originalFetch = global.fetch;
    const rawBedrockPayload = `[Tool Output]: {
      "current_state": {
        "evaluation_previous_goal": "On search page",
        "memory": "Filtering price under 5000",
        "next_goal": "Select rating above 4"
      },
      "action": [
        { "click_element": { "index": 42 } }
      ]
    }`;

    global.fetch = async () => {
      return new Response(
        JSON.stringify({
          output: {
            message: {
              role: 'assistant',
              content: [{ text: rawBedrockPayload }],
            },
          },
          stopReason: 'end_turn',
          usage: {
            inputTokens: 150,
            outputTokens: 75,
            totalTokens: 225,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    try {
      const res = await request(app)
        .post('/api/v1/llm/chat/completions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          model: 'amazon.nova-lite-v1:0',
          messages: [{ role: 'user', content: 'Filter earphones under 5000' }],
        });

      expect(res.status).toBe(200);
      const returnedContent = res.body.choices[0].message.content;

      // Crucial: returned content must NOT start with [Tool Output] and must parse as valid JSON directly
      expect(returnedContent.startsWith('[Tool Output]')).toBe(false);
      const parsed = JSON.parse(returnedContent);
      expect(parsed.current_state.next_goal).toBe('Select rating above 4');
      expect(parsed.action[0].click_element.index).toBe(42);

      // Verify credits were properly deducted for successful response
      const balance = await rtdb.balance(userId);
      expect(balance?.remainingCredits).toBeLessThan(100);
    } finally {
      global.fetch = originalFetch;
      LlmProviderFactory.reset();
    }
  });

  it('15. Multi-turn execution after input_text merges consecutive user messages into strictly alternating Bedrock turns', () => {
    const provider = new BedrockLlmProvider('test-key', 'us-east-1');

    // Simulate multi-turn scenario where input_text just executed
    const messages = [
      { role: 'system', content: 'You are a browser automation assistant.' },
      { role: 'user', content: 'Turn 1: Initial task - find earphones on amazon' },
      {
        role: 'assistant',
        content: JSON.stringify({
          current_state: { next_goal: 'Type query into search input' },
          action: [{ input_text: { index: 12, text: 'earphone under 5000' } }],
        }),
      },
      // Consecutive user messages representing action execution result + updated DOM snapshot
      { role: 'user', content: 'Turn 3: Action result: Typed "earphone under 5000" into element [12]' },
      { role: 'user', content: 'Turn 4: Current browser state: Amazon search suggestions popup visible [33, 34, 35]' },
    ];

    const { systemMessages, bedrockMessages } = provider.formatBedrockMessages(messages);

    // 1. System message formatted correctly
    expect(systemMessages.length).toBe(1);
    expect(systemMessages[0].text).toBe('You are a browser automation assistant.');

    // 2. Turns must strictly alternate: user -> assistant -> user (length 3, NOT 4)
    expect(bedrockMessages.length).toBe(3);
    expect(bedrockMessages[0].role).toBe('user');
    expect(bedrockMessages[1].role).toBe('assistant');
    expect(bedrockMessages[2].role).toBe('user');

    // 3. Consecutive user messages (Turn 3 and 4) were merged into multiple content blocks in the final turn
    expect(bedrockMessages[2].content.length).toBe(2);
    expect(bedrockMessages[2].content[0].text).toContain('Action result: Typed');
    expect(bedrockMessages[2].content[1].text).toContain('Current browser state: Amazon search suggestions');
  });

  it('16. Bedrock empty response (length: 0) throws 502 PROVIDER_EMPTY_RESPONSE and deducts 0 credits', async () => {
    const { token, userId } = await registerUser('bedrockemptyuser');

    const bedrockProvider = new BedrockLlmProvider('test-key', 'us-east-1');
    LlmProviderFactory.setOverrideProvider(bedrockProvider);

    const originalFetch = global.fetch;

    // Simulate Bedrock returning empty output message content (length: 0)
    global.fetch = async () => {
      return new Response(
        JSON.stringify({
          output: {
            message: {
              role: 'assistant',
              content: [{ text: '' }],
            },
          },
          stopReason: 'end_turn',
          usage: {
            inputTokens: 2500,
            outputTokens: 0,
            totalTokens: 2500,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    try {
      expect((await rtdb.balance(userId)).remainingCredits).toBe(100);

      const res = await request(app)
        .post('/api/v1/llm/chat/completions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          model: 'amazon.nova-lite-v1:0',
          messages: [
            { role: 'user', content: 'Turn 1' },
            { role: 'assistant', content: 'Turn 2' },
            { role: 'user', content: 'Turn 3' },
          ],
        });

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('PROVIDER_EMPTY_RESPONSE');

      // 0 credits deducted when the provider returns an empty response
      expect((await rtdb.balance(userId)).remainingCredits).toBe(100);
    } finally {
      global.fetch = originalFetch;
      LlmProviderFactory.reset();
    }
  });

  it('17. Usage history is paginated newest first with an accurate total', async () => {
    const { token } = await registerUser('history');
    for (let i = 1; i <= 3; i++) {
      await request(app)
        .post('/api/v1/llm/chat')
        .set('Authorization', `Bearer ${token}`)
        .send({ model: 'anthropic.claude-3-haiku-20240307-v1:0', messages: [{ role: 'user', content: `q${i}` }] });
      await new Promise(resolve => setTimeout(resolve, 3));
    }

    const page1 = await request(app).get('/api/v1/llm/usage?page=1&limit=2').set('Authorization', `Bearer ${token}`);
    const page2 = await request(app).get('/api/v1/llm/usage?page=2&limit=2').set('Authorization', `Bearer ${token}`);
    expect(page1.body.data.total).toBe(3);
    expect(page1.body.data.items).toHaveLength(2);
    expect(page2.body.data.items).toHaveLength(1);
    const times = [...page1.body.data.items, ...page2.body.data.items].map((item: any) => Date.parse(item.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});
