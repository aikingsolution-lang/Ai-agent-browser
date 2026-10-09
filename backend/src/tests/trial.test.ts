import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { PlanSeedService } from '../services/planSeed.service.js';
import { TrialService } from '../services/trial.service.js';
import { createApp } from '../app.js';
import { paths } from '../services/rtdb/client.js';
import { testDb, resetFirebase } from './helpers/firebaseTestEnv.js';
import { registerViaApi, rtdb } from './helpers/testApi.js';

// GET /api/v1/test-protected-feature (authenticate + checkEntitlement) is mounted by routes/index.ts when NODE_ENV=test.
const app = createApp();

const HOUR = 3600 * 1000;
const FIVE_DAYS = 5 * 24 * HOUR;

describe('Phase 6: Server-Side Free Trial Engine (Firebase RTDB)', () => {
  beforeEach(async () => {
    await resetFirebase();
    await PlanSeedService.seedDefaultPlans();
  });

  it('1. Idempotent default plan seeding creates free-trial plan', async () => {
    const plan1 = await PlanSeedService.seedDefaultPlans();
    const plan2 = await PlanSeedService.seedDefaultPlans();

    expect(plan1.code).toBe('free-trial');
    expect(plan1._id).toBe(plan2._id);
    expect(plan1.amount).toBe(0);
    expect(plan1.billingInterval).toBe('none');
  });

  it('2. User registration automatically creates a 5-day free trial subscription', async () => {
    const { uid, body } = await registerViaApi(app, { name: 'Trial User', email: 'user1@trialtest.com' });

    expect(body.success).toBe(true);
    expect(body.data.token).toBeDefined();
    expect(body.data.subscription).toBeDefined();
    expect(body.data.subscription.status).toBe('TRIALING');
    expect(body.data.subscription.isTrial).toBe(true);
    expect(body.data.subscription.planCodeSnapshot).toBe('free-trial');

    const subscription = await rtdb.subscription(uid);
    expect(subscription.status).toBe('TRIALING');
    expect(subscription.planCodeSnapshot).toBe('free-trial');
    const durationDays = (subscription.trialEndDate - subscription.trialStartDate) / (1000 * 60 * 60 * 24);
    expect(Math.round(durationDays)).toBe(5);
  });

  it('3. Attempting to create a second free trial for the same user throws 409 TRIAL_ALREADY_EXISTS', async () => {
    const { uid } = await registerViaApi(app, { email: 'singletrial@trialtest.com' });

    await expect(TrialService.createFreeTrial(uid)).rejects.toThrow(
      'User is not eligible for a free trial or already has an active subscription',
    );
  });

  it('3b. Concurrent trial creation for a brand-new user creates exactly one trial', async () => {
    const uid = 'concurrentTrialUid';
    const results = await Promise.allSettled(Array.from({ length: 5 }).map(() => TrialService.createFreeTrial(uid)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await rtdb.ledger(uid)).filter(entry => entry.type === 'TRIAL_ALLOCATION')).toHaveLength(1);
    expect((await rtdb.trialFlag(uid)).hasUsedTrial).toBe(true);
  });

  it('4. On-demand trial expiration transitions status to EXPIRED when trialEndDate is past', async () => {
    const { uid } = await registerViaApi(app, { email: 'expiring@trialtest.com' });

    const pastDate = Date.now() - HOUR;
    await rtdb.patchSubscription(uid, {
      trialStartDate: pastDate - FIVE_DAYS,
      trialEndDate: pastDate,
      currentPeriodEnd: pastDate,
    });

    const expiredSub = await TrialService.expireTrialIfEnded(uid);
    expect(expiredSub).not.toBeNull();
    expect(expiredSub?.status).toBe('EXPIRED');
    expect(expiredSub?.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const secondCall = await TrialService.expireTrialIfEnded(uid);
    expect(secondCall).toBeNull();
  });

  it('5. checkEntitlement middleware permits active trialing user and blocks expired user with 403', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'entitlement@trialtest.com' });

    const accessRes1 = await request(app).get('/api/v1/test-protected-feature').set('Authorization', auth);
    expect(accessRes1.status).toBe(200);
    expect(accessRes1.body.message).toBe('Access granted to premium feature');

    const pastDate = Date.now() - 1000;
    await rtdb.patchSubscription(uid, {
      trialStartDate: pastDate - FIVE_DAYS,
      trialEndDate: pastDate,
      currentPeriodEnd: pastDate,
    });

    const accessRes2 = await request(app).get('/api/v1/test-protected-feature').set('Authorization', auth);
    expect(accessRes2.status).toBe(403);
    expect(accessRes2.body.error.code).toBe('SUBSCRIPTION_EXPIRED');
  });

  it('6. Expired trial users can still authenticate, call /auth/me, and view /subscription/me', async () => {
    // (The old test logged in with /auth/login; that endpoint now calls Firebase Auth over the network and is
    // out of scope here, so the signed-in user's ID token is used directly.)
    const { uid, auth } = await registerViaApi(app, { name: 'Expired Auth User', email: 'expiredauth@trialtest.com' });

    const pastDate = Date.now() - HOUR;
    await rtdb.patchSubscription(uid, {
      status: 'EXPIRED',
      trialStartDate: pastDate - FIVE_DAYS,
      trialEndDate: pastDate,
    });

    const meRes = await request(app).get('/api/v1/auth/me').set('Authorization', auth);
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.user.email).toBe('expiredauth@trialtest.com');
    expect(meRes.body.data.user.name).toBe('Expired Auth User');

    const subRes = await request(app).get('/api/v1/subscription/me').set('Authorization', auth);
    expect(subRes.status).toBe(200);
    expect(subRes.body.data.status).toBe('EXPIRED');
    expect(subRes.body.data.hasActiveEntitlement).toBe(false);
    expect(subRes.body.data.trialInfo.isExpired).toBe(true);
  });

  it('7. Normal cancellation (ACTIVE + cancelAtPeriodEnd) retains entitlement until currentPeriodEnd', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'cancelled@trialtest.com' });

    await rtdb.patchSubscription(uid, {
      status: 'ACTIVE',
      cancelAtPeriodEnd: true,
      canceledAt: Date.now(),
      currentPeriodEnd: Date.now() + 86400 * 1000,
    });

    const subRes = await request(app).get('/api/v1/subscription/me').set('Authorization', auth);
    expect(subRes.status).toBe(200);
    expect(subRes.body.data.status).toBe('ACTIVE');
    expect(subRes.body.data.subscription.cancelAtPeriodEnd).toBe(true);
    expect(subRes.body.data.hasActiveEntitlement).toBe(true);

    const accessRes = await request(app).get('/api/v1/test-protected-feature').set('Authorization', auth);
    expect(accessRes.status).toBe(200);
  });

  it('8. Server startup / bulk reconciliation expires past-due trials in bulk', async () => {
    const users = [];
    for (let i = 1; i <= 3; i++) {
      users.push(await registerViaApi(app, { name: `Bulk User ${i}`, email: `bulk${i}@trialtest.com` }));
    }
    const untouched = await registerViaApi(app, { email: 'stillactive@trialtest.com' });

    const pastDate = Date.now() - HOUR;
    for (const user of users) {
      await rtdb.patchSubscription(user.uid, {
        trialStartDate: pastDate - FIVE_DAYS,
        trialEndDate: pastDate,
        currentPeriodEnd: pastDate,
      });
    }

    const count = await TrialService.reconcileExpiredTrials();
    expect(count).toBe(3);

    for (const user of users) {
      expect((await rtdb.subscription(user.uid)).status).toBe('EXPIRED');
    }
    expect((await rtdb.subscription(untouched.uid)).status).toBe('TRIALING');
  });

  it('9. Concurrent expireTrialIfEnded calls execute safely without duplicate errors', async () => {
    const { uid } = await registerViaApi(app, { email: 'concurrent@trialtest.com' });
    const pastDate = Date.now() - 1000;
    await rtdb.patchSubscription(uid, {
      trialStartDate: pastDate - FIVE_DAYS,
      trialEndDate: pastDate,
      currentPeriodEnd: pastDate,
    });

    const results = await Promise.all(Array.from({ length: 5 }).map(() => TrialService.expireTrialIfEnded(uid)));

    expect(results.filter(r => r !== null).length).toBe(1);
    expect((await rtdb.subscription(uid)).status).toBe('EXPIRED');
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

  it('11. Trial healing restores a lost trial subscription and its credits inside the 5-day window', async () => {
    const { uid } = await registerViaApi(app, { email: 'heal@trialtest.com' });
    // Simulate the subscription and balance nodes being lost
    await testDb.ref(paths.subscription(uid)).remove();
    await testDb.ref(paths.creditBalance(uid)).remove();

    const healed = await TrialService.healUserTrialSubscriptionIfEligible(uid);
    expect(healed?.status).toBe('TRIALING');
    expect((await rtdb.subscription(uid)).isTrial).toBe(true);
    expect((await rtdb.balance(uid)).remainingCredits).toBe(100);
  });
});
