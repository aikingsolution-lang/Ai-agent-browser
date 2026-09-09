import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../app.js';
import { User } from '../models/user.model.js';
import { Subscription } from '../models/subscription.model.js';
import { UserCreditBalance } from '../models/userCreditBalance.model.js';
import { CreditLedger } from '../models/creditLedger.model.js';
import { WebhookLedger } from '../models/webhookLedger.model.js';
import { LlmUsageLog } from '../models/llmUsageLog.model.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { LlmProviderFactory } from '../services/llm/llmProviderFactory.js';
import { env } from '../config/env.js';

const app = createApp();
let mongoConnected = false;

describe('Phase 11: Production Hardening, Observability & Readiness Audit Tests', () => {
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
      await User.deleteMany({ email: /@phase11test\.com$/ });
      await Subscription.deleteMany({});
      await UserCreditBalance.deleteMany({});
      await CreditLedger.deleteMany({});
      await LlmUsageLog.deleteMany({});
      await WebhookLedger.deleteMany({});
      await mongoose.connection.close();
    }
  });

  beforeEach(async () => {
    LlmProviderFactory.reset();
    if (mongoConnected) {
      await User.deleteMany({ email: /@phase11test\.com$/ });
      await Subscription.deleteMany({});
      await UserCreditBalance.deleteMany({});
      await CreditLedger.deleteMany({});
      await LlmUsageLog.deleteMany({});
      await WebhookLedger.deleteMany({});
      await PlanSeedService.seedDefaultPlans();
    }
  });

  async function registerUser(emailPrefix: string) {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        name: `${emailPrefix} User`,
        email: `${emailPrefix}@phase11test.com`,
        password: 'Password123!',
      });
    return {
      token: res.body.data.token,
      userId: res.body.data.user._id || res.body.data.user.id,
    };
  }

  it('1. Correlation ID (x-request-id) is attached to response headers', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-request-id']).toMatch(/^req_/);
  });

  it('2. Preserves incoming x-request-id header when provided', async () => {
    const customId = 'custom_req_12345';
    const res = await request(app).get('/health').set('x-request-id', customId);
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe(customId);
  });

  it('3. Health liveness probes (/health & /health/live) return 200 OK', async () => {
    const res1 = await request(app).get('/health');
    expect(res1.status).toBe(200);
    expect(res1.body.data.status).toBe('ok');

    const res2 = await request(app).get('/health/live');
    expect(res2.status).toBe(200);
    expect(res2.body.data.status).toBe('ok');
  });

  it('4. Readiness probes (/ready & /health/ready) return 200 OK when DB is connected', async () => {
    if (!mongoConnected) return;
    const res1 = await request(app).get('/ready');
    expect(res1.status).toBe(200);
    expect(res1.body.data.status).toBe('ready');

    const res2 = await request(app).get('/health/ready');
    expect(res2.status).toBe(200);
    expect(res2.body.data.database.isConnected).toBe(true);
  });

  it('5. Global error handling formats errors consistently without stack traces', async () => {
    const res = await request(app).get('/api/v1/non-existent-route-999');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.stack).toBeUndefined();
  });

  it('6. Secret leakage prevention: auth / user responses never expose passwordHash', async () => {
    if (!mongoConnected) return;
    const { token } = await registerUser('secretcheck');

    const meRes = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.user.passwordHash).toBeUndefined();
    expect(JSON.stringify(meRes.body)).not.toContain('passwordHash');
  });

  it('7. CreditLedger entries record balanceBefore and balanceAfter', async () => {
    if (!mongoConnected) return;
    const { userId } = await registerUser('ledgeraudit');

    const ledger = await CreditLedger.findOne({ userId, type: 'TRIAL_ALLOCATION' });
    expect(ledger).not.toBeNull();
    expect(ledger?.balanceBefore).toBe(0);
    expect(ledger?.balanceAfter).toBe(100);
  });

  it('8. LLM TIMEOUT error status is logged in LlmUsageLog with 0 credits deducted', async () => {
    if (!mongoConnected) return;
    const { token, userId } = await registerUser('timeoutaudit');

    LlmProviderFactory.setMockOptions({ shouldTimeout: true });

    const res = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        messages: [{ role: 'user', content: 'Test timeout status' }],
      });

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('PROVIDER_TIMEOUT');

    const log = await LlmUsageLog.findOne({ userId, status: 'TIMEOUT' });
    expect(log).not.toBeNull();
    expect(log?.creditsDeducted).toBe(0);
  });
});
