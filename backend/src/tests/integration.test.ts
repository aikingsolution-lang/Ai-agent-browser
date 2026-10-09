import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { LlmProviderFactory } from '../services/llm/llmProviderFactory.js';
import { env } from '../config/env.js';
import { resetFirebase } from './helpers/firebaseTestEnv.js';
import { registerViaApi, rtdb } from './helpers/testApi.js';

const app = createApp();

describe('Phase 10: End-to-End Client & Extension Integration Test Suite (Firebase RTDB)', () => {
  beforeEach(async () => {
    LlmProviderFactory.reset();
    await resetFirebase();
    await PlanSeedService.seedDefaultPlans();
  });

  it('1. Complete User Lifecycle: Register -> Check Me -> View Credits -> Checkout -> Verify -> Use LLM -> Check Usage', async () => {
    // A. Register
    const { uid: userId, auth } = await registerViaApi(app, { name: 'E2E User', email: 'user@e2etest.com' });

    // B. Check Me & Subscription Me
    const meRes = await request(app).get('/api/v1/auth/me').set('Authorization', auth);
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.user.email).toBe('user@e2etest.com');

    const subRes = await request(app).get('/api/v1/subscription/me').set('Authorization', auth);
    expect(subRes.status).toBe(200);
    expect(subRes.body.data.subscription.status).toBe('TRIALING');

    // C. View Credits Balance
    const creditRes = await request(app).get('/api/v1/credits/balance').set('Authorization', auth);
    expect(creditRes.status).toBe(200);
    expect(creditRes.body.data.remainingCredits).toBe(100);

    // D. Fetch Subscription Plans
    const plansRes = await request(app).get('/api/v1/subscription/plans').set('Authorization', auth);
    expect(plansRes.status).toBe(200);
    expect(plansRes.body.data.plans.length).toBeGreaterThan(0);

    // E. Create Checkout Session for Pro plan
    const checkoutRes = await request(app)
      .post('/api/v1/subscription/checkout')
      .set('Authorization', auth)
      .send({ planCode: 'pro', idempotencyKey: 'e2e-checkout-key-1' });
    expect(checkoutRes.status).toBe(200);
    const razorpaySubId = checkoutRes.body.data.subscriptionId;
    expect(razorpaySubId).toBeDefined();

    // F. Verify Payment
    const e2ePaymentId = 'pay_e2e_mock_123';
    const e2eSignature = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
      .update(`${e2ePaymentId}|${razorpaySubId}`)
      .digest('hex');
    const verifyRes = await request(app)
      .post('/api/v1/subscription/verify-payment')
      .set('Authorization', auth)
      .send({
        razorpaySubscriptionId: razorpaySubId,
        razorpayPaymentId: e2ePaymentId,
        razorpaySignature: e2eSignature,
      });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.subscription.status).toBe('ACTIVE');

    // G. Send LLM Chat Request through Gateway Proxy
    const llmRes = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', auth)
      .send({
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        messages: [{ role: 'user', content: 'Run web automation task.' }],
        idempotencyKey: 'e2e-llm-chat-key-1',
      });
    expect(llmRes.status).toBe(200);
    expect(llmRes.body.data.content).toBeDefined();
    expect(llmRes.body.data.creditsDeducted).toBeGreaterThan(0);

    // H. View Usage History
    const usageRes = await request(app).get('/api/v1/llm/usage').set('Authorization', auth);
    expect(usageRes.status).toBe(200);
    expect(usageRes.body.data.items.length).toBe(1);
    expect(usageRes.body.data.items[0].userId).toBe(userId);
  });

  it('2. 401 Session Handling & Expired Token Rejection', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer bearer.invalid.token.str');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('3. 402 Insufficient Credits handling on LLM Request', async () => {
    const { uid, auth } = await registerViaApi(app, { name: 'Low Credit User', email: 'lowcredit@e2etest.com' });
    await rtdb.patchBalance(uid, { remainingCredits: 0, usedCredits: 100 });

    const res = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', auth)
      .send({
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        messages: [{ role: 'user', content: 'Low credit check' }],
      });

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('INSUFFICIENT_CREDITS');
  });
});
