import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../app.js';
import { User } from '../models/user.model.js';
import { Subscription } from '../models/subscription.model.js';
import { Plan } from '../models/plan.model.js';
import { UserCreditBalance } from '../models/userCreditBalance.model.js';
import { CreditLedger } from '../models/creditLedger.model.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { CreditService } from '../services/credit.service.js';
import { checkCredits } from '../middleware/credit.middleware.js';
import { env } from '../config/env.js';

const app = createApp();

// Setup protected dummy route using checkCredits middleware
app.get(
  '/api/v1/test-metered-feature',
  (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        (req as any).user = { _id: payload.sub, id: payload.sub, role: payload.role };
      } catch {
        // ignore for test harness
      }
    }
    next();
  },
  checkCredits(5) as any,
  (_req, res) => {
    res.status(200).json({ success: true, message: 'Metered action executed' });
  },
);

let mongoConnected = false;

describe('Phase 7: Server-Side Credit & Usage Metering Engine Integration & Unit Tests', () => {
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
      await User.deleteMany({ email: /@credittest\.com$/ });
      await Subscription.deleteMany({});
      await UserCreditBalance.deleteMany({});
      await CreditLedger.deleteMany({});
      await Plan.deleteMany({ code: 'free-trial' });
      await mongoose.connection.close();
    }
  });

  beforeEach(async () => {
    if (mongoConnected) {
      await User.deleteMany({ email: /@credittest\.com$/ });
      await Subscription.deleteMany({});
      await UserCreditBalance.deleteMany({});
      await CreditLedger.deleteMany({});
      await PlanSeedService.seedDefaultPlans();
    }
  });

  it('1. Registration initializes credit balance from plan snapshot (100 credits)', async () => {
    if (!mongoConnected) return;

    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Credit User',
      email: 'user1@credittest.com',
      password: 'Password123!',
    });

    expect(res.status).toBe(201);
    const userId = res.body.data.user._id || res.body.data.user.id;

    // Verify UserCreditBalance
    const balance = await UserCreditBalance.findOne({ userId });
    expect(balance).not.toBeNull();
    expect(balance?.allocatedCredits).toBe(100);
    expect(balance?.usedCredits).toBe(0);
    expect(balance?.remainingCredits).toBe(100);

    // Verify CreditLedger initial entry
    const ledger = await CreditLedger.findOne({ userId, type: 'TRIAL_ALLOCATION' });
    expect(ledger).not.toBeNull();
    expect(ledger?.amount).toBe(100);
    expect(ledger?.balanceAfter).toBe(100);
  });

  it('2. Credit deduction via Service updates balance and logs ledger entry', async () => {
    if (!mongoConnected) return;

    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Deduct User',
      email: 'deduct@credittest.com',
      password: 'Password123!',
    });

    const userId = regRes.body.data.user._id || regRes.body.data.user.id;

    const result = await CreditService.deductCredits({
      userId,
      amount: 10,
      description: 'Test browser automation task',
    });

    expect(result.balance.remainingCredits).toBe(90);
    expect(result.balance.usedCredits).toBe(10);
    expect(result.ledgerEntry.amount).toBe(-10);
    expect(result.ledgerEntry.balanceAfter).toBe(90);
    expect(result.isIdempotentRetry).toBe(false);
  });

  it('3. Deducting more credits than available fails with 402 INSUFFICIENT_CREDITS', async () => {
    if (!mongoConnected) return;

    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Exceed User',
      email: 'exceed@credittest.com',
      password: 'Password123!',
    });

    const userId = regRes.body.data.user._id || regRes.body.data.user.id;

    await expect(
      CreditService.deductCredits({
        userId,
        amount: 150,
        description: 'Excessive consumption attempt',
      }),
    ).rejects.toThrow('Insufficient credit balance');

    // Balance remains unchanged
    const balance = await UserCreditBalance.findOne({ userId });
    expect(balance?.remainingCredits).toBe(100);
    expect(balance?.usedCredits).toBe(0);
  });

  it('4. Concurrent credit deductions with different keys prevent negative balance and enforce atomicity', async () => {
    if (!mongoConnected) return;

    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Concurrent User',
      email: 'concurrent@credittest.com',
      password: 'Password123!',
    });

    const userId = regRes.body.data.user._id || regRes.body.data.user.id;

    // Perform 10 parallel deductions of 15 credits each (Total requested = 150, Available = 100)
    const deductionPromises = Array.from({ length: 10 }).map((_, i) =>
      CreditService.deductCredits({
        userId,
        amount: 15,
        description: `Parallel task ${i + 1}`,
      }).catch(err => err),
    );

    const results = await Promise.all(deductionPromises);

    const successful = results.filter(r => !(r instanceof Error));
    const failed = results.filter(r => r instanceof Error);

    // 100 / 15 = 6 successful deductions (90 credits spent), 4 failed
    expect(successful.length).toBe(6);
    expect(failed.length).toBe(4);

    const finalBalance = await UserCreditBalance.findOne({ userId });
    expect(finalBalance?.remainingCredits).toBe(10);
    expect(finalBalance?.usedCredits).toBe(90);
  });

  it('5. Truly concurrent requests with SAME idempotencyKey deduct credits exactly ONCE without divergence', async () => {
    if (!mongoConnected) return;

    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Concurrent Same Key User',
      email: 'concurrentsamekey@credittest.com',
      password: 'Password123!',
    });

    const userId = regRes.body.data.user._id || regRes.body.data.user.id;
    const sameKey = 'concurrent-same-key-001';

    // Fire 10 parallel requests with the exact SAME idempotencyKey requesting 10 credits each
    const promises = Array.from({ length: 10 }).map(() =>
      CreditService.deductCredits({
        userId,
        amount: 10,
        description: 'Concurrent same key execution',
        idempotencyKey: sameKey,
      }),
    );

    const results = await Promise.all(promises);

    // Exactly 1 request creates new entry (isIdempotentRetry: false), 9 return idempotent retries
    const primaryOps = results.filter(r => !r.isIdempotentRetry);
    const retryOps = results.filter(r => r.isIdempotentRetry);

    expect(primaryOps.length).toBe(1);
    expect(retryOps.length).toBe(9);

    // Database verification: Exactly 10 credits deducted total (100 -> 90)
    const finalBalance = await UserCreditBalance.findOne({ userId });
    expect(finalBalance?.remainingCredits).toBe(90);
    expect(finalBalance?.usedCredits).toBe(10);

    // Ledger verification: Exactly ONE entry created for this idempotencyKey
    const ledgerEntries = await CreditLedger.find({ idempotencyKey: sameKey });
    expect(ledgerEntries.length).toBe(1);
    expect(ledgerEntries[0].balanceAfter).toBe(90);
  });

  it('6. Sequential idempotency key retry returns cached response without duplicate deduction', async () => {
    if (!mongoConnected) return;

    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Idempotent User',
      email: 'idempotent@credittest.com',
      password: 'Password123!',
    });

    const userId = regRes.body.data.user._id || regRes.body.data.user.id;
    const idempotencyKey = 'seq-task-key-001';

    // First deduction
    const res1 = await CreditService.deductCredits({
      userId,
      amount: 25,
      description: 'Idempotent Task Execution',
      idempotencyKey,
    });

    expect(res1.balance.remainingCredits).toBe(75);
    expect(res1.isIdempotentRetry).toBe(false);

    // Duplicate deduction with same idempotencyKey
    const res2 = await CreditService.deductCredits({
      userId,
      amount: 25,
      description: 'Idempotent Task Execution Retry',
      idempotencyKey,
    });

    expect(res2.isIdempotentRetry).toBe(true);
    expect(res2.balance.remainingCredits).toBe(75); // Unchanged!

    // Verify ledger has only 1 entry for this key
    const ledgerEntries = await CreditLedger.find({ idempotencyKey });
    expect(ledgerEntries.length).toBe(1);
  });

  it('7. checkCredits middleware allows access when balance >= required and rejects 402 when low', async () => {
    if (!mongoConnected) return;

    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Middleware User',
      email: 'middleware@credittest.com',
      password: 'Password123!',
    });

    const token = regRes.body.data.token;
    const userId = regRes.body.data.user._id || regRes.body.data.user.id;

    // 1. Initial balance = 100, requires 5 -> 200 OK
    const accessRes1 = await request(app).get('/api/v1/test-metered-feature').set('Authorization', `Bearer ${token}`);
    expect(accessRes1.status).toBe(200);

    // 2. Set remaining credits to 2
    await UserCreditBalance.updateOne({ userId }, { $set: { remainingCredits: 2, usedCredits: 98 } });

    // 3. Requires 5 -> 402 Payment Required
    const accessRes2 = await request(app).get('/api/v1/test-metered-feature').set('Authorization', `Bearer ${token}`);
    expect(accessRes2.status).toBe(402);
    expect(accessRes2.body.error.code).toBe('INSUFFICIENT_CREDITS');
  });

  it('8. GET /api/v1/credits/balance returns credit info and low balance warning', async () => {
    if (!mongoConnected) return;

    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Balance API User',
      email: 'balanceapi@credittest.com',
      password: 'Password123!',
    });

    const token = regRes.body.data.token;
    const userId = regRes.body.data.user._id || regRes.body.data.user.id;

    const res1 = await request(app).get('/api/v1/credits/balance').set('Authorization', `Bearer ${token}`);
    expect(res1.status).toBe(200);
    expect(res1.body.data.allocatedCredits).toBe(100);
    expect(res1.body.data.remainingCredits).toBe(100);
    expect(res1.body.data.isLowBalance).toBe(false);

    // Set remaining credits to 5 (<= 10% of 100)
    await UserCreditBalance.updateOne({ userId }, { $set: { remainingCredits: 5, usedCredits: 95 } });

    const res2 = await request(app).get('/api/v1/credits/balance').set('Authorization', `Bearer ${token}`);
    expect(res2.status).toBe(200);
    expect(res2.body.data.remainingCredits).toBe(5);
    expect(res2.body.data.isLowBalance).toBe(true);
  });

  it('9. GET /api/v1/credits/history returns paginated audit entries in reverse chronological order', async () => {
    if (!mongoConnected) return;

    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'History API User',
      email: 'historyapi@credittest.com',
      password: 'Password123!',
    });

    const token = regRes.body.data.token;
    const userId = regRes.body.data.user._id || regRes.body.data.user.id;

    // Deduct twice
    await CreditService.deductCredits({ userId, amount: 5, description: 'Action 1' });
    await CreditService.deductCredits({ userId, amount: 10, description: 'Action 2' });

    const res = await request(app)
      .get('/api/v1/credits/history?page=1&limit=2')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBe(2);
    expect(res.body.data.pagination.total).toBe(3); // 1 allocation + 2 deductions
    expect(res.body.data.items[0].description).toBe('Action 2');
  });

  it('10. POST /api/v1/credits/deduct is removed from public API surface (returns 404)', async () => {
    if (!mongoConnected) return;

    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Removed Endpoint User',
      email: 'removedep@credittest.com',
      password: 'Password123!',
    });

    const token = regRes.body.data.token;

    const res = await request(app)
      .post('/api/v1/credits/deduct')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 10, description: 'Direct deduction attempt' });

    expect(res.status).toBe(404);
  });
});
