import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../app.js';
import { User } from '../models/user.model.js';
import { Subscription } from '../models/subscription.model.js';
import { UserCreditBalance } from '../models/userCreditBalance.model.js';
import { CreditLedger } from '../models/creditLedger.model.js';
import { LlmUsageLog } from '../models/llmUsageLog.model.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { LlmProviderFactory } from '../services/llm/llmProviderFactory.js';
import { BedrockLlmProvider } from '../services/llm/bedrockLlmProvider.js';
import { env } from '../config/env.js';

const app = createApp();
import { setupTestDatabase, type TestDbInstance } from './setupTestDb.js';

let testDb: TestDbInstance;

describe('Phase 9 & Bedrock: Managed LLM Proxy Gateway + Usage Metering Integration Tests', () => {
  beforeAll(async () => {
    testDb = await setupTestDatabase();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    LlmProviderFactory.reset();
    await testDb.clearCollections();
    await PlanSeedService.seedDefaultPlans();
  });

  async function registerUser(emailPrefix: string) {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        name: `${emailPrefix} User`,
        email: `${emailPrefix}@llmtest.com`,
        password: 'Password123!',
      });
    return {
      token: res.body.data.token,
      userId: res.body.data.user._id || res.body.data.user.id,
    };
  }

  it('1. Unauthenticated request to /api/v1/llm/chat is rejected with 401', async () => {
    const res = await request(app)
      .post('/api/v1/llm/chat')
      .send({
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        messages: [{ role: 'user', content: 'Hello' }],
      });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('2. Request with invalid model is rejected with 400 Bad Request', async () => {
    const { token } = await registerUser('invalidmodel');

    const res = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        model: 'unsupported-super-model-v99',
        messages: [{ role: 'user', content: 'Hello' }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('3. Insufficient credits rejected with 402 INSUFFICIENT_CREDITS before calling provider', async () => {
    const { token, userId } = await registerUser('nocredits');

    // Drain user credits to 0
    await UserCreditBalance.updateOne({ userId }, { $set: { remainingCredits: 0, usedCredits: 100 } });

    const res = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        messages: [{ role: 'user', content: 'Hello' }],
      });

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('INSUFFICIENT_CREDITS');

    // Verify 0 usage logs created
    const logs = await LlmUsageLog.find({ userId });
    expect(logs.length).toBe(0);
  });

  it('4. Successful LLM chat request deducts credits and records usage log', async () => {
    const { token, userId } = await registerUser('success');

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

    // Verify balance updated
    const balance = await UserCreditBalance.findOne({ userId });
    expect(balance?.remainingCredits).toBe(100 - res.body.data.creditsDeducted);

    // Verify LlmUsageLog document
    const usageLog = await LlmUsageLog.findOne({ userId, requestId: res.body.data.requestId });
    expect(usageLog).not.toBeNull();
    expect(usageLog?.status).toBe('SUCCESS');
    expect(usageLog?.model).toBe('anthropic.claude-3-haiku-20240307-v1:0');
  });

  it('5. Duplicate request with same idempotencyKey returns cached response without double billing', async () => {
    const { token, userId } = await registerUser('idempotent');
    const idempotencyKey = 'llm-key-9999';

    // First request
    const res1 = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .set('x-idempotency-key', idempotencyKey)
      .send({
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        messages: [{ role: 'user', content: 'Explain quantum computing in 5 words.' }],
      });

    expect(res1.status).toBe(200);
    expect(res1.body.data.isIdempotentRetry).toBe(false);
    const creditsSpent1 = res1.body.data.creditsDeducted;

    // Second request with same idempotencyKey
    const res2 = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .set('x-idempotency-key', idempotencyKey)
      .send({
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        messages: [{ role: 'user', content: 'Explain quantum computing in 5 words.' }],
      });

    expect(res2.status).toBe(200);
    expect(res2.body.data.isIdempotentRetry).toBe(true);

    // Balance should have deducted ONLY once
    const balance = await UserCreditBalance.findOne({ userId });
    expect(balance?.remainingCredits).toBe(100 - creditsSpent1);

    // Usage logs should contain only 1 log for this idempotency key
    const logs = await LlmUsageLog.find({ userId, idempotencyKey });
    expect(logs.length).toBe(1);
  });

  it('6. Provider failure returns 502 Provider Error and deducts 0 credits', async () => {
    const { token, userId } = await registerUser('providerfail');

    // Configure mock provider to fail
    LlmProviderFactory.setMockOptions({ shouldFail: true, failStatus: 502, failMessage: 'AWS Bedrock server down' });

    const res = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        messages: [{ role: 'user', content: 'Test failure' }],
      });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PROVIDER_ERROR');

    // Balance remains 100
    const balance = await UserCreditBalance.findOne({ userId });
    expect(balance?.remainingCredits).toBe(100);

    // Error usage log recorded with status FAILED
    const failedLog = await LlmUsageLog.findOne({ userId, status: 'FAILED' });
    expect(failedLog).not.toBeNull();
    expect(failedLog?.creditsDeducted).toBe(0);
  });

  it('7. Provider timeout returns 504 Gateway Timeout and deducts 0 credits', async () => {
    const { token, userId } = await registerUser('providertimeout');

    // Configure mock provider to timeout
    LlmProviderFactory.setMockOptions({ shouldTimeout: true });

    const res = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        messages: [{ role: 'user', content: 'Test timeout' }],
      });

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('PROVIDER_TIMEOUT');

    // Balance remains 100
    const balance = await UserCreditBalance.findOne({ userId });
    expect(balance?.remainingCredits).toBe(100);

    // Error usage log recorded with status TIMEOUT or FAILED
    const failedLog = await LlmUsageLog.findOne({ userId, status: { $in: ['FAILED', 'TIMEOUT'] } });
    expect(failedLog).not.toBeNull();
    expect(failedLog?.creditsDeducted).toBe(0);
  });

  it('8. User isolation: User A cannot see User B usage logs via GET /api/v1/llm/usage', async () => {
    const userA = await registerUser('usera');
    const userB = await registerUser('userb');

    // Perform LLM request as User A
    await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${userA.token}`)
      .send({
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        messages: [{ role: 'user', content: 'User A query' }],
      });

    // Query usage history as User B
    const resB = await request(app).get('/api/v1/llm/usage').set('Authorization', `Bearer ${userB.token}`);

    expect(resB.status).toBe(200);
    expect(resB.body.data.items.length).toBe(0);
    expect(resB.body.data.total).toBe(0);

    // Query usage history as User A
    const resA = await request(app).get('/api/v1/llm/usage').set('Authorization', `Bearer ${userA.token}`);

    expect(resA.status).toBe(200);
    expect(resA.body.data.items.length).toBe(1);
    expect(resA.body.data.items[0].userId).toBe(userA.userId);
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
    // Premium model applies 2x credit rate
    expect(res.body.data.creditsDeducted).toBeGreaterThanOrEqual(2);

    const balance = await UserCreditBalance.findOne({ userId });
    expect(balance?.remainingCredits).toBe(100 - res.body.data.creditsDeducted);
  });

  it('10. SSE Streaming chat completion returns text/event-stream chunks', async () => {
    const { token } = await registerUser('streaming');

    const res = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        messages: [{ role: 'user', content: 'Tell me a joke.' }],
        stream: true,
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('data:');
    expect(res.text).toContain('[DONE]');
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
      const balance = await UserCreditBalance.findOne({ userId });
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
      const balanceBefore = await UserCreditBalance.findOne({ userId });
      expect(balanceBefore?.remainingCredits).toBe(100);

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

      // Must fail with 502 Bad Gateway and PROVIDER_EMPTY_RESPONSE code
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('PROVIDER_EMPTY_RESPONSE');

      // Crucial: 0 credits should be deducted when provider returns empty response!
      const balanceAfter = await UserCreditBalance.findOne({ userId });
      expect(balanceAfter?.remainingCredits).toBe(100);
    } finally {
      global.fetch = originalFetch;
      LlmProviderFactory.reset();
    }
  });
});
