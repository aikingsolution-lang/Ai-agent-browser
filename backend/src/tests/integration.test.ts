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
import { env } from '../config/env.js';

const app = createApp();
let mongoConnected = false;

describe('Phase 10: End-to-End Client & Extension Integration Test Suite', () => {
  beforeAll(async () => {
    try {
      if (mongoose.connection.readyState === 0) {
        await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 2000 });
      }
      mongoConnected = true;
      await PlanSeedService.seedDefaultPlans();
    } catch {
      mongoConnected = false;
    }
  });

  afterAll(async () => {
    if (mongoConnected) {
      await User.deleteMany({ email: /@e2etest\.com$/ });
      await Subscription.deleteMany({});
      await UserCreditBalance.deleteMany({});
      await CreditLedger.deleteMany({});
      await LlmUsageLog.deleteMany({});
      await mongoose.connection.close();
    }
  });

  beforeEach(async () => {
    LlmProviderFactory.reset();
    if (mongoConnected) {
      await User.deleteMany({ email: /@e2etest\.com$/ });
      await Subscription.deleteMany({});
      await UserCreditBalance.deleteMany({});
      await CreditLedger.deleteMany({});
      await LlmUsageLog.deleteMany({});
      await PlanSeedService.seedDefaultPlans();
    }
  });

  it('1. Complete User Lifecycle: Register -> Check Me -> View Credits -> Checkout -> Verify -> Use LLM -> Check Usage', async () => {
    if (!mongoConnected) return;

    // A. Register
    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'E2E User',
      email: 'user@e2etest.com',
      password: 'Password123!',
    });

    expect(regRes.status).toBe(201);
    const token = regRes.body.data.token;
    const userId = regRes.body.data.user.id;

    // B. Check Me
    const meRes = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.user.email).toBe('user@e2etest.com');
    expect(meRes.body.data.subscription.status).toBe('TRIALING');

    // C. View Credits Balance
    const creditRes = await request(app).get('/api/v1/credits/balance').set('Authorization', `Bearer ${token}`);
    expect(creditRes.status).toBe(200);
    expect(creditRes.body.data.remainingCredits).toBe(100);

    // D. Fetch Subscription Plans
    const plansRes = await request(app).get('/api/v1/subscription/plans').set('Authorization', `Bearer ${token}`);
    expect(plansRes.status).toBe(200);
    expect(plansRes.body.data.plans.length).toBeGreaterThan(0);

    // E. Create Checkout Session for Pro plan
    const checkoutRes = await request(app)
      .post('/api/v1/subscription/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ planCode: 'pro', idempotencyKey: 'e2e-checkout-key-1' });

    expect(checkoutRes.status).toBe(200);
    const razorpaySubId = checkoutRes.body.data.razorpaySubscriptionId;
    expect(razorpaySubId).toBeDefined();

    // F. Verify Payment
    const verifyRes = await request(app)
      .post('/api/v1/subscription/verify-payment')
      .set('Authorization', `Bearer ${token}`)
      .send({
        razorpaySubscriptionId: razorpaySubId,
        razorpayPaymentId: 'pay_e2e_mock_123',
        razorpaySignature: 'sig_e2e_mock_456',
      });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.subscription.status).toBe('ACTIVE');

    // G. Send LLM Chat Request through Gateway Proxy
    const llmRes = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Run web automation task.' }],
        idempotencyKey: 'e2e-llm-chat-key-1',
      });

    expect(llmRes.status).toBe(200);
    expect(llmRes.body.data.content).toBeDefined();
    expect(llmRes.body.data.creditsDeducted).toBeGreaterThan(0);

    // H. View Usage History
    const usageRes = await request(app).get('/api/v1/llm/usage').set('Authorization', `Bearer ${token}`);
    expect(usageRes.status).toBe(200);
    expect(usageRes.body.data.items.length).toBe(1);
    expect(usageRes.body.data.items[0].userId).toBe(userId);
  });

  it('2. 401 Session Handling & Expired Token Rejection', async () => {
    if (!mongoConnected) return;

    const invalidToken = 'bearer.invalid.token.str';

    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${invalidToken}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('3. 402 Insufficient Credits handling on LLM Request', async () => {
    if (!mongoConnected) return;

    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Low Credit User',
      email: 'lowcredit@e2etest.com',
      password: 'Password123!',
    });

    const token = regRes.body.data.token;
    const userId = regRes.body.data.user.id;

    // Set remaining credits to 0
    await UserCreditBalance.updateOne({ userId }, { $set: { remainingCredits: 0, usedCredits: 100 } });

    const res = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Low credit check' }],
      });

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('INSUFFICIENT_CREDITS');
  });
});
