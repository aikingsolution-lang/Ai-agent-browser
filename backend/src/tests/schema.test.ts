import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { Plan } from '../models/plan.model.js';
import { Subscription } from '../models/subscription.model.js';
import { User } from '../models/user.model.js';
import { env } from '../config/env.js';

import { setupTestDatabase, type TestDbInstance } from './setupTestDb.js';

let testDb: TestDbInstance;

describe('Phase 5 Mongoose Schemas & Indexes Unit Tests', () => {
  beforeAll(async () => {
    testDb = await setupTestDatabase();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.clearCollections();
    await Plan.syncIndexes();
    await Subscription.syncIndexes();
  });

  it('1. Creates a valid free-trial Plan (amount=0, billingInterval="none")', async () => {
    await Plan.deleteOne({ code: 'test-free-trial' });

    const trialPlan = await Plan.create({
      code: 'test-free-trial',
      name: 'Free Trial Plan',
      description: '5-day evaluation trial',
      amount: 0,
      currency: 'INR',
      billingInterval: 'none',
      creditsPerBillingPeriod: 50,
      rateLimitPerMinute: 5,
      features: ['Basic AI Web Automation'],
    });

    expect(trialPlan._id).toBeDefined();
    expect(trialPlan.code).toBe('test-free-trial');
    expect(trialPlan.amount).toBe(0);
    expect(trialPlan.billingInterval).toBe('none');
  });

  it('2. Creates a valid paid Plan (amount=29900, billingInterval="monthly")', async () => {
    await Plan.deleteOne({ code: 'test-starter' });

    const paidPlan = await Plan.create({
      code: 'test-starter',
      name: 'Starter Plan',
      description: 'Monthly starter subscription',
      amount: 29900, // ₹299 = 29900 paise
      currency: 'INR',
      billingInterval: 'monthly',
      creditsPerBillingPeriod: 300,
      rateLimitPerMinute: 15,
      features: ['Full AI Automation', 'Priority Tasks'],
    });

    expect(paidPlan.code).toBe('test-starter');
    expect(paidPlan.amount).toBe(29900);
    expect(paidPlan.billingInterval).toBe('monthly');
  });

  it('3. Creates a valid trial Subscription (status="TRIALING", isTrial=true)', async () => {
    const user = await User.create({
      name: 'Trial User',
      email: 'trial@schematest.com',
      passwordHash: 'hash123',
    });

    await Plan.deleteOne({ code: 'test-free-trial' });

    const plan = await Plan.create({
      code: 'test-free-trial',
      name: 'Free Trial Plan',
      description: 'Trial Plan',
      amount: 0,
      billingInterval: 'none',
      creditsPerBillingPeriod: 50,
      rateLimitPerMinute: 5,
    });

    const now = new Date();
    const trialEnd = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

    const sub = await Subscription.create({
      userId: user._id,
      planId: plan._id,
      planCodeSnapshot: plan.code,
      planNameSnapshot: plan.name,
      amountSnapshot: plan.amount,
      currencySnapshot: plan.currency,
      billingIntervalSnapshot: plan.billingInterval,
      creditsSnapshot: plan.creditsPerBillingPeriod,
      rateLimitSnapshot: plan.rateLimitPerMinute,
      status: 'TRIALING',
      isTrial: true,
      trialStartDate: now,
      trialEndDate: trialEnd,
      currentPeriodStart: now,
      currentPeriodEnd: trialEnd,
    });

    expect(sub.status).toBe('TRIALING');
    expect(sub.isTrial).toBe(true);
    expect(sub.amountSnapshot).toBe(0);
    expect(sub.billingIntervalSnapshot).toBe('none');
  });

  it('4. Creates a valid paid Subscription (status="ACTIVE", amountSnapshot=29900)', async () => {
    const user = await User.create({
      name: 'Paid User',
      email: 'paid@schematest.com',
      passwordHash: 'hash123',
    });

    await Plan.deleteOne({ code: 'test-starter' });

    const plan = await Plan.create({
      code: 'test-starter',
      name: 'Starter Plan',
      description: 'Starter',
      amount: 29900,
      billingInterval: 'monthly',
      creditsPerBillingPeriod: 300,
      rateLimitPerMinute: 15,
    });

    const now = new Date();
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const sub = await Subscription.create({
      userId: user._id,
      planId: plan._id,
      planCodeSnapshot: plan.code,
      planNameSnapshot: plan.name,
      amountSnapshot: plan.amount,
      currencySnapshot: plan.currency,
      billingIntervalSnapshot: plan.billingInterval,
      creditsSnapshot: plan.creditsPerBillingPeriod,
      rateLimitSnapshot: plan.rateLimitPerMinute,
      status: 'ACTIVE',
      isTrial: false,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    });

    expect(sub.status).toBe('ACTIVE');
    expect(sub.isTrial).toBe(false);
    expect(sub.amountSnapshot).toBe(29900);
  });

  it('5. Rejects duplicate ACTIVE subscriptions for the same user', async () => {
    const userId = new Types.ObjectId();
    const planId = new Types.ObjectId();
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 1000);

    await Subscription.create({
      userId,
      planId,
      planCodeSnapshot: 'starter',
      planNameSnapshot: 'Starter Plan',
      amountSnapshot: 29900,
      currencySnapshot: 'INR',
      billingIntervalSnapshot: 'monthly',
      creditsSnapshot: 300,
      rateLimitSnapshot: 15,
      status: 'ACTIVE',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    });

    // Attempt second ACTIVE subscription for same user
    await expect(
      Subscription.create({
        userId,
        planId,
        planCodeSnapshot: 'pro',
        planNameSnapshot: 'Pro Plan',
        amountSnapshot: 69900,
        currencySnapshot: 'INR',
        billingIntervalSnapshot: 'monthly',
        creditsSnapshot: 1000,
        rateLimitSnapshot: 30,
        status: 'ACTIVE',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      }),
    ).rejects.toThrow(/E11000/);
  });

  it('6. Rejects concurrent TRIALING and ACTIVE subscriptions for the same user', async () => {
    const userId = new Types.ObjectId();
    const planId = new Types.ObjectId();
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 1000);

    await Subscription.create({
      userId,
      planId,
      planCodeSnapshot: 'free-trial',
      planNameSnapshot: 'Free Trial',
      amountSnapshot: 0,
      currencySnapshot: 'INR',
      billingIntervalSnapshot: 'none',
      creditsSnapshot: 50,
      rateLimitSnapshot: 5,
      status: 'TRIALING',
      isTrial: true,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    });

    // Attempt concurrent ACTIVE subscription
    await expect(
      Subscription.create({
        userId,
        planId,
        planCodeSnapshot: 'starter',
        planNameSnapshot: 'Starter Plan',
        amountSnapshot: 29900,
        currencySnapshot: 'INR',
        billingIntervalSnapshot: 'monthly',
        creditsSnapshot: 300,
        rateLimitSnapshot: 15,
        status: 'ACTIVE',
        isTrial: false,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      }),
    ).rejects.toThrow(/E11000/);
  });

  it('7. Rejects a second historical free trial for the same user (isTrial = true partial index)', async () => {
    const userId = new Types.ObjectId();
    const planId = new Types.ObjectId();
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 1000);

    // First trial subscription (now EXPIRED)
    await Subscription.create({
      userId,
      planId,
      planCodeSnapshot: 'free-trial',
      planNameSnapshot: 'Free Trial',
      amountSnapshot: 0,
      currencySnapshot: 'INR',
      billingIntervalSnapshot: 'none',
      creditsSnapshot: 50,
      rateLimitSnapshot: 5,
      status: 'EXPIRED',
      isTrial: true,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    });

    // Attempt second trial subscription for same user
    await expect(
      Subscription.create({
        userId,
        planId,
        planCodeSnapshot: 'free-trial',
        planNameSnapshot: 'Free Trial',
        amountSnapshot: 0,
        currencySnapshot: 'INR',
        billingIntervalSnapshot: 'none',
        creditsSnapshot: 50,
        rateLimitSnapshot: 5,
        status: 'TRIALING',
        isTrial: true,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      }),
    ).rejects.toThrow(/E11000/);
  });

  it('8. Allows multiple EXPIRED subscription records for the same user', async () => {
    const userId = new Types.ObjectId();
    const planId = new Types.ObjectId();
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 1000);

    const sub1 = await Subscription.create({
      userId,
      planId,
      planCodeSnapshot: 'starter',
      planNameSnapshot: 'Starter Plan',
      amountSnapshot: 29900,
      currencySnapshot: 'INR',
      billingIntervalSnapshot: 'monthly',
      creditsSnapshot: 300,
      rateLimitSnapshot: 15,
      status: 'EXPIRED',
      isTrial: false,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    });

    const sub2 = await Subscription.create({
      userId,
      planId,
      planCodeSnapshot: 'pro',
      planNameSnapshot: 'Pro Plan',
      amountSnapshot: 69900,
      currencySnapshot: 'INR',
      billingIntervalSnapshot: 'monthly',
      creditsSnapshot: 1000,
      rateLimitSnapshot: 30,
      status: 'EXPIRED',
      isTrial: false,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    });

    expect(sub1._id).toBeDefined();
    expect(sub2._id).toBeDefined();
  });

  it('9. Rejects invalid subscription status and billing interval enum values', async () => {
    const userId = new Types.ObjectId();
    const planId = new Types.ObjectId();
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 1000);

    await expect(
      Subscription.create({
        userId,
        planId,
        planCodeSnapshot: 'starter',
        planNameSnapshot: 'Starter Plan',
        amountSnapshot: 29900,
        currencySnapshot: 'INR',
        billingIntervalSnapshot: 'monthly',
        creditsSnapshot: 300,
        rateLimitSnapshot: 15,
        status: 'INVALID_STATUS' as any,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      }),
    ).rejects.toThrow(/validation failed/i);

    await expect(
      Plan.create({
        code: 'invalid-interval',
        name: 'Invalid Interval Plan',
        description: 'Test',
        amount: 1000,
        billingInterval: 'weekly' as any,
        creditsPerBillingPeriod: 100,
        rateLimitPerMinute: 10,
      }),
    ).rejects.toThrow(/validation failed/i);
  });

  it('10. Rejects invalid floating-point amount values (must be integer paise)', async () => {
    await expect(
      Plan.create({
        code: 'float-plan',
        name: 'Float Plan',
        description: 'Float Amount',
        amount: 299.5,
        billingInterval: 'monthly',
        creditsPerBillingPeriod: 300,
        rateLimitPerMinute: 15,
      }),
    ).rejects.toThrow(/integer/i);

    const userId = new Types.ObjectId();
    const planId = new Types.ObjectId();
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 1000);

    await expect(
      Subscription.create({
        userId,
        planId,
        planCodeSnapshot: 'starter',
        planNameSnapshot: 'Starter Plan',
        amountSnapshot: 299.99,
        currencySnapshot: 'INR',
        billingIntervalSnapshot: 'monthly',
        creditsSnapshot: 300,
        rateLimitSnapshot: 15,
        status: 'ACTIVE',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      }),
    ).rejects.toThrow(/integer/i);
  });

  it('11. Enforces currency format validation (3-letter ISO code)', async () => {
    await expect(
      Plan.create({
        code: 'bad-currency',
        name: 'Bad Currency Plan',
        description: 'Test',
        amount: 1000,
        currency: 'US', // Less than 3 letters
        billingInterval: 'monthly',
        creditsPerBillingPeriod: 100,
        rateLimitPerMinute: 10,
      }),
    ).rejects.toThrow(/validation failed/i);
  });

  it('12. Enforces positive credits and positive rate limits (>= 1)', async () => {
    await expect(
      Plan.create({
        code: 'zero-credits',
        name: 'Zero Credits Plan',
        description: 'Test',
        amount: 1000,
        billingInterval: 'monthly',
        creditsPerBillingPeriod: 0, // Must be >= 1
        rateLimitPerMinute: 10,
      }),
    ).rejects.toThrow(/validation failed/i);

    await expect(
      Plan.create({
        code: 'zero-rate',
        name: 'Zero Rate Plan',
        description: 'Test',
        amount: 1000,
        billingInterval: 'monthly',
        creditsPerBillingPeriod: 100,
        rateLimitPerMinute: 0, // Must be >= 1
      }),
    ).rejects.toThrow(/validation failed/i);
  });

  it('13. Enforces required fields validation for Plan and Subscription', async () => {
    // Missing code on Plan
    await expect(
      Plan.create({
        name: 'No Code Plan',
        description: 'Test',
        amount: 1000,
        billingInterval: 'monthly',
        creditsPerBillingPeriod: 100,
        rateLimitPerMinute: 10,
      } as any),
    ).rejects.toThrow(/validation failed/i);

    // Missing userId on Subscription
    await expect(
      Subscription.create({
        planId: new Types.ObjectId(),
        planCodeSnapshot: 'starter',
        planNameSnapshot: 'Starter Plan',
        amountSnapshot: 29900,
        currencySnapshot: 'INR',
        billingIntervalSnapshot: 'monthly',
        creditsSnapshot: 300,
        rateLimitSnapshot: 15,
        status: 'ACTIVE',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(),
      } as any),
    ).rejects.toThrow(/validation failed/i);
  });

  it('14. Enforces date ordering validation (currentPeriodEnd > currentPeriodStart & trialEndDate > trialStartDate)', async () => {
    const userId = new Types.ObjectId();
    const planId = new Types.ObjectId();
    const start = new Date('2026-09-07T12:00:00Z');
    const invalidEnd = new Date('2026-09-07T10:00:00Z'); // Before start

    await expect(
      Subscription.create({
        userId,
        planId,
        planCodeSnapshot: 'starter',
        planNameSnapshot: 'Starter Plan',
        amountSnapshot: 29900,
        currencySnapshot: 'INR',
        billingIntervalSnapshot: 'monthly',
        creditsSnapshot: 300,
        rateLimitSnapshot: 15,
        status: 'ACTIVE',
        currentPeriodStart: start,
        currentPeriodEnd: invalidEnd, // Invalid
      }),
    ).rejects.toThrow(/must be after/i);

    await expect(
      Subscription.create({
        userId,
        planId,
        planCodeSnapshot: 'free-trial',
        planNameSnapshot: 'Free Trial',
        amountSnapshot: 0,
        currencySnapshot: 'INR',
        billingIntervalSnapshot: 'none',
        creditsSnapshot: 50,
        rateLimitSnapshot: 5,
        status: 'TRIALING',
        isTrial: true,
        trialStartDate: start,
        trialEndDate: invalidEnd, // Invalid
        currentPeriodStart: start,
        currentPeriodEnd: new Date('2026-09-12T12:00:00Z'),
      }),
    ).rejects.toThrow(/must be after/i);
  });

  it('15. Verifies default values (isActive=true, isTrial=false, cancelAtPeriodEnd=false, currency="INR")', async () => {
    const plan = await Plan.create({
      code: 'default-test',
      name: 'Default Test Plan',
      description: 'Test defaults',
      amount: 1000,
      billingInterval: 'monthly',
      creditsPerBillingPeriod: 100,
      rateLimitPerMinute: 10,
    });

    expect(plan.isActive).toBe(true);
    expect(plan.currency).toBe('INR');

    const now = new Date();
    const periodEnd = new Date(now.getTime() + 1000);

    const sub = await Subscription.create({
      userId: new Types.ObjectId(),
      planId: plan._id,
      planCodeSnapshot: plan.code,
      planNameSnapshot: plan.name,
      amountSnapshot: plan.amount,
      currencySnapshot: plan.currency,
      billingIntervalSnapshot: plan.billingInterval,
      creditsSnapshot: plan.creditsPerBillingPeriod,
      rateLimitSnapshot: plan.rateLimitPerMinute,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    });

    expect(sub.isTrial).toBe(false);
    expect(sub.cancelAtPeriodEnd).toBe(false);
    expect(sub.status).toBe('TRIALING');
    expect(sub.provider).toBe('manual');
  });

  it('16. Verifies Plan code normalization (lowercases and trims code)', async () => {
    const plan = await Plan.create({
      code: '  STARTER-LOWER  ',
      name: 'Lower Plan',
      description: 'Test normalization',
      amount: 1000,
      billingInterval: 'monthly',
      creditsPerBillingPeriod: 100,
      rateLimitPerMinute: 10,
    });

    expect(plan.code).toBe('starter-lower');
  });

  it('17. Enforces unique sparse Razorpay Plan ID and Subscription ID indexes', async () => {
    // Duplicate razorpayPlanId
    await Plan.create({
      code: 'rzp-plan-1',
      name: 'Plan 1',
      description: 'Plan 1',
      amount: 1000,
      billingInterval: 'monthly',
      creditsPerBillingPeriod: 100,
      rateLimitPerMinute: 10,
      razorpayPlanId: 'plan_rzp_123',
    });

    await expect(
      Plan.create({
        code: 'rzp-plan-2',
        name: 'Plan 2',
        description: 'Plan 2',
        amount: 2000,
        billingInterval: 'monthly',
        creditsPerBillingPeriod: 200,
        rateLimitPerMinute: 20,
        razorpayPlanId: 'plan_rzp_123', // Duplicate
      }),
    ).rejects.toThrow(/E11000/);

    // Duplicate providerSubscriptionId
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 1000);

    await Subscription.create({
      userId: new Types.ObjectId(),
      planId: new Types.ObjectId(),
      planCodeSnapshot: 'starter',
      planNameSnapshot: 'Starter Plan',
      amountSnapshot: 29900,
      currencySnapshot: 'INR',
      billingIntervalSnapshot: 'monthly',
      creditsSnapshot: 300,
      rateLimitSnapshot: 15,
      status: 'EXPIRED',
      providerSubscriptionId: 'sub_rzp_999',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    });

    await expect(
      Subscription.create({
        userId: new Types.ObjectId(),
        planId: new Types.ObjectId(),
        planCodeSnapshot: 'pro',
        planNameSnapshot: 'Pro Plan',
        amountSnapshot: 69900,
        currencySnapshot: 'INR',
        billingIntervalSnapshot: 'monthly',
        creditsSnapshot: 1000,
        rateLimitSnapshot: 30,
        status: 'EXPIRED',
        providerSubscriptionId: 'sub_rzp_999', // Duplicate
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      }),
    ).rejects.toThrow(/E11000/);
  });
});
