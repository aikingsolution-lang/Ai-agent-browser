import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { v1Router } from '../routes/index.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { checkEntitlement } from '../middleware/entitlement.middleware.js';
import { User } from '../models/user.model.js';
import { Subscription } from '../models/subscription.model.js';
import { Plan } from '../models/plan.model.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { TrialService } from '../services/trial.service.js';
import { env } from '../config/env.js';
import { createApp } from '../app.js';

// Setup protected dummy route on v1Router BEFORE createApp() initializes Express app
v1Router.use('/test-protected-feature', authenticate, checkEntitlement, (_req, res) => {
  res.status(200).json({ success: true, message: 'Access granted to premium feature' });
});

const app = createApp();
import { setupTestDatabase, type TestDbInstance } from './setupTestDb.js';

let testDb: TestDbInstance;

describe('Phase 6: Server-Side Free Trial Engine Integration & Unit Tests', () => {
  beforeAll(async () => {
    testDb = await setupTestDatabase();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.clearCollections();
    await PlanSeedService.seedDefaultPlans();
  });

  it('1. Idempotent default plan seeding creates free-trial plan', async () => {
    const plan1 = await PlanSeedService.seedDefaultPlans();
    const plan2 = await PlanSeedService.seedDefaultPlans();

    expect(plan1.code).toBe('free-trial');
    expect(plan1._id.toString()).toBe(plan2._id.toString());
    expect(plan1.amount).toBe(0);
    expect(plan1.billingInterval).toBe('none');
  });

  it('2. User registration automatically creates a 5-day free trial subscription', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Trial User',
      email: 'user1@trialtest.com',
      password: 'Password123!',
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.subscription).toBeDefined();
    expect(res.body.data.subscription.status).toBe('TRIALING');
    expect(res.body.data.subscription.isTrial).toBe(true);

    const userId = res.body.data.user._id || res.body.data.user.id;
    const subscription = await Subscription.findOne({ userId });
    expect(subscription).not.toBeNull();
    expect(subscription?.status).toBe('TRIALING');
    expect(subscription?.planCodeSnapshot).toBe('free-trial');

    // Verify trial end date is approximately 5 days from trial start date
    const start = new Date(subscription!.trialStartDate!).getTime();
    const end = new Date(subscription!.trialEndDate!).getTime();
    const durationDays = (end - start) / (1000 * 60 * 60 * 24);
    expect(Math.round(durationDays)).toBe(5);
  });

  it('3. Attempting to create a second free trial for the same user throws 409 TRIAL_ALREADY_EXISTS', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Single Trial User',
      email: 'singletrial@trialtest.com',
      password: 'Password123!',
    });

    const userId = res.body.data.user._id || res.body.data.user.id;

    // Attempt direct creation of a second free trial
    await expect(TrialService.createFreeTrial(userId)).rejects.toThrow(
      'User is not eligible for a free trial or already has an active subscription',
    );
  });

  it('4. On-demand trial expiration transitions status to EXPIRED when trialEndDate is past', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Expiring Trial User',
      email: 'expiring@trialtest.com',
      password: 'Password123!',
    });

    const userId = res.body.data.user._id || res.body.data.user.id;

    // Manually push trialEndDate to 1 hour in the past (keeping 5-day duration)
    const pastDate = new Date(Date.now() - 3600 * 1000);
    const pastStart = new Date(pastDate.getTime() - 5 * 24 * 3600 * 1000);
    await Subscription.updateOne(
      { userId },
      { $set: { trialStartDate: pastStart, trialEndDate: pastDate, currentPeriodEnd: pastDate } },
    );

    // Trigger on-demand expiration
    const expiredSub = await TrialService.expireTrialIfEnded(userId);
    expect(expiredSub).not.toBeNull();
    expect(expiredSub?.status).toBe('EXPIRED');

    // Subsequent call returns null (already expired)
    const secondCall = await TrialService.expireTrialIfEnded(userId);
    expect(secondCall).toBeNull();
  });

  it('5. checkEntitlement middleware permits active trialing user and blocks expired user with 403', async () => {
    // Register active user
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Entitlement User',
      email: 'entitlement@trialtest.com',
      password: 'Password123!',
    });

    const token = res.body.data.token;
    const userId = res.body.data.user._id || res.body.data.user.id;

    // 1. Access protected route while trialing -> 200 OK
    const accessRes1 = await request(app).get('/api/v1/test-protected-feature').set('Authorization', `Bearer ${token}`);
    expect(accessRes1.status).toBe(200);
    expect(accessRes1.body.message).toBe('Access granted to premium feature');

    // 2. Expire trial in database (keeping 5-day duration)
    const pastDate = new Date(Date.now() - 1000);
    const pastStart = new Date(pastDate.getTime() - 5 * 24 * 3600 * 1000);
    await Subscription.updateOne(
      { userId },
      { $set: { trialStartDate: pastStart, trialEndDate: pastDate, currentPeriodEnd: pastDate } },
    );

    // 3. Access protected route after trial expiration -> 403 Forbidden
    const accessRes2 = await request(app).get('/api/v1/test-protected-feature').set('Authorization', `Bearer ${token}`);
    expect(accessRes2.status).toBe(403);
    expect(accessRes2.body.error.code).toBe('SUBSCRIPTION_EXPIRED');
  });

  it('6. Expired trial users can still authenticate, call /auth/me, and view /subscription/me', async () => {
    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Expired Auth User',
      email: 'expiredauth@trialtest.com',
      password: 'Password123!',
    });

    const userId = regRes.body.data.user._id || regRes.body.data.user.id;

    // Expire trial (keeping 5-day duration)
    const pastDate = new Date(Date.now() - 3600 * 1000);
    const pastStart = new Date(pastDate.getTime() - 5 * 24 * 3600 * 1000);
    await Subscription.updateOne(
      { userId },
      { $set: { status: 'EXPIRED', trialStartDate: pastStart, trialEndDate: pastDate } },
    );

    // Login still succeeds -> 200 OK
    const loginRes = await request(app).post('/api/v1/auth/login').send({
      email: 'expiredauth@trialtest.com',
      password: 'Password123!',
    });
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.data.token;

    // /auth/me succeeds -> 200 OK
    const meRes = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.user.email).toBe('expiredauth@trialtest.com');

    // /subscription/me succeeds -> 200 OK, indicates EXPIRED status and hasActiveEntitlement = false
    const subRes = await request(app).get('/api/v1/subscription/me').set('Authorization', `Bearer ${token}`);
    expect(subRes.status).toBe(200);
    expect(subRes.body.data.status).toBe('EXPIRED');
    expect(subRes.body.data.hasActiveEntitlement).toBe(false);
    expect(subRes.body.data.trialInfo.isExpired).toBe(true);
  });

  it('7. Normal cancellation (ACTIVE + cancelAtPeriodEnd) retains entitlement until currentPeriodEnd', async () => {
    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Cancelled User',
      email: 'cancelled@trialtest.com',
      password: 'Password123!',
    });

    const token = regRes.body.data.token;
    const userId = regRes.body.data.user._id || regRes.body.data.user.id;

    // Transition to ACTIVE with cancelAtPeriodEnd = true, currentPeriodEnd in the future
    const futureDate = new Date(Date.now() + 86400 * 1000);
    await Subscription.updateOne(
      { userId },
      {
        $set: {
          status: 'ACTIVE',
          cancelAtPeriodEnd: true,
          canceledAt: new Date(),
          currentPeriodEnd: futureDate,
        },
      },
    );

    // /subscription/me shows active entitlement
    const subRes = await request(app).get('/api/v1/subscription/me').set('Authorization', `Bearer ${token}`);
    expect(subRes.status).toBe(200);
    expect(subRes.body.data.status).toBe('ACTIVE');
    expect(subRes.body.data.subscription.cancelAtPeriodEnd).toBe(true);
    expect(subRes.body.data.hasActiveEntitlement).toBe(true);

    // Protected feature access is granted
    const accessRes = await request(app).get('/api/v1/test-protected-feature').set('Authorization', `Bearer ${token}`);
    expect(accessRes.status).toBe(200);
  });

  it('8. Server startup / bulk reconciliation expires past-due trials in bulk', async () => {
    // Register 3 users
    for (let i = 1; i <= 3; i++) {
      await request(app)
        .post('/api/v1/auth/register')
        .send({
          name: `Bulk User ${i}`,
          email: `bulk${i}@trialtest.com`,
          password: 'Password123!',
        });
    }

    // Set trialEndDate in the past for all 3 bulk users (keeping 5-day duration)
    const bulkUsers = await User.find({ email: /bulk.*@trialtest\.com$/ }).select('_id');
    const bulkUserIds = bulkUsers.map(u => u._id);
    const pastDate = new Date(Date.now() - 3600 * 1000);
    const pastStart = new Date(pastDate.getTime() - 5 * 24 * 3600 * 1000);
    await Subscription.updateMany(
      { userId: { $in: bulkUserIds }, isTrial: true },
      { $set: { trialStartDate: pastStart, trialEndDate: pastDate, currentPeriodEnd: pastDate } },
    );

    // Run bulk reconciliation
    const count = await TrialService.reconcileExpiredTrials();
    expect(count).toBe(3);

    const activeTrials = await Subscription.countDocuments({ userId: { $in: bulkUserIds }, status: 'TRIALING' });
    expect(activeTrials).toBe(0);

    const expiredTrials = await Subscription.countDocuments({ userId: { $in: bulkUserIds }, status: 'EXPIRED' });
    expect(expiredTrials).toBe(3);
  });

  it('9. Concurrent expireTrialIfEnded calls execute safely without duplicate errors', async () => {
    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Concurrent User',
      email: 'concurrent@trialtest.com',
      password: 'Password123!',
    });

    const userId = regRes.body.data.user._id || regRes.body.data.user.id;
    const pastDate = new Date(Date.now() - 1000);
    const pastStart = new Date(pastDate.getTime() - 5 * 24 * 3600 * 1000);
    await Subscription.updateOne(
      { userId },
      { $set: { trialStartDate: pastStart, trialEndDate: pastDate, currentPeriodEnd: pastDate } },
    );

    // Run 5 concurrent expiration attempts
    const results = await Promise.all([
      TrialService.expireTrialIfEnded(userId),
      TrialService.expireTrialIfEnded(userId),
      TrialService.expireTrialIfEnded(userId),
      TrialService.expireTrialIfEnded(userId),
      TrialService.expireTrialIfEnded(userId),
    ]);

    // Exactly one call updates and returns non-null subscription
    const updatedCount = results.filter(r => r !== null).length;
    expect(updatedCount).toBe(1);

    const finalSub = await Subscription.findOne({ userId });
    expect(finalSub?.status).toBe('EXPIRED');
  });

  it('10. Trial remaining time utility correctly calculates remaining days, hours, and isExpired status', () => {
    const now = new Date();
    const future3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const past1Hour = new Date(now.getTime() - 3600 * 1000);

    const activeInfo = TrialService.calculateTrialRemaining(future3Days);
    expect(activeInfo.isExpired).toBe(false);
    expect(activeInfo.remainingDays).toBe(3);
    expect(activeInfo.remainingHours).toBe(72);

    const expiredInfo = TrialService.calculateTrialRemaining(past1Hour);
    expect(expiredInfo.isExpired).toBe(true);
    expect(expiredInfo.remainingDays).toBe(0);
    expect(expiredInfo.remainingHours).toBe(0);
  });
});
