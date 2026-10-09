/**
 * RTDB data-model invariants. Replaces the Mongoose schema/index tests (schema.test.ts): the same
 * guarantees now come from the RTDB path layout and transactions instead of unique indexes.
 */
import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { PlanSeedService, PlanService } from '../services/planSeed.service.js';
import { TrialService } from '../services/trial.service.js';
import { CreditService } from '../services/credit.service.js';
import { JobApplicationService } from '../services/jobApplication.service.js';
import { SubscriptionRepository } from '../services/rtdb/repositories.js';
import { paths, RTDB_ROOT } from '../services/rtdb/client.js';
import { assertSafeUid, isSafeKey, keyForExternalId, stripUndefined } from '../services/rtdb/rtdbUtils.js';
import { env } from '../config/env.js';
import { isLiveRtdb, loadRulesFragment, memoryDb, resetFirebase, testDb } from './helpers/firebaseTestEnv.js';
import { registerViaApi, rtdb } from './helpers/testApi.js';

const app = createApp();

describe('RTDB data model invariants (replaces Mongoose schema & index tests)', () => {
  beforeEach(async () => {
    await resetFirebase();
    await PlanSeedService.seedDefaultPlans();
  });

  it('1-2. Seeded plans: free trial (amount 0, interval none) and paid plans with integer paise amounts', async () => {
    const plans = await PlanService.getActivePlans();
    const trial = plans.find(plan => plan.code === 'free-trial')!;
    expect(trial.amount).toBe(0);
    expect(trial.billingInterval).toBe('none');
    for (const plan of plans) {
      expect(Number.isInteger(plan.amount)).toBe(true);
      expect(plan.currency).toMatch(/^[A-Z]{3}$/);
      expect(plan.creditsPerBillingPeriod).toBeGreaterThanOrEqual(1);
      expect(plan.rateLimitPerMinute).toBeGreaterThanOrEqual(1);
      expect(plan.isActive).toBe(true);
    }
  });

  it('5-6. One current subscription per user: a trial cannot be created next to an entitled subscription', async () => {
    const { uid } = await registerViaApi(app, { email: 'one@datamodel.com' });
    await rtdb.patchSubscription(uid, { status: 'ACTIVE', isTrial: false });
    await testDb.ref(paths.trialFlag(uid)).remove();

    await expect(TrialService.createFreeTrial(uid)).rejects.toMatchObject({ code: 'TRIAL_ALREADY_EXISTS' });
    expect((await rtdb.subscription(uid)).status).toBe('ACTIVE');
  });

  it('7. A second free trial is rejected even after the first one expired', async () => {
    const { uid } = await registerViaApi(app, { email: 'twice@datamodel.com' });
    await rtdb.patchSubscription(uid, { status: 'EXPIRED' });
    await expect(TrialService.createFreeTrial(uid)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('8. Older (expired) subscriptions are kept in subscription_history, never overwritten', async () => {
    const { uid } = await registerViaApi(app, { email: 'history@datamodel.com' });
    const original = await rtdb.subscription(uid);
    await rtdb.patchSubscription(uid, { status: 'EXPIRED' });
    await testDb.ref(paths.trialFlag(uid)).remove(); // e.g. a migrated user who never had a trial flag

    await TrialService.createFreeTrial(uid);
    const history = await SubscriptionRepository.listHistory(uid);
    expect(history).toHaveLength(1);
    expect(history[0].subscriptionId).toBe(original.subscriptionId);
    expect(history[0].status).toBe('EXPIRED');
    expect((await rtdb.subscription(uid)).subscriptionId).not.toBe(original.subscriptionId);
  });

  it('15. Defaults on a new trial subscription', async () => {
    const { uid } = await registerViaApi(app, { email: 'defaults@datamodel.com' });
    const sub = await rtdb.subscription(uid);
    expect(sub).toMatchObject({ isTrial: true, cancelAtPeriodEnd: false, provider: 'manual', currencySnapshot: 'INR' });
    expect(sub.currentPeriodEnd).toBeGreaterThan(sub.currentPeriodStart);
    expect(sub.trialEndDate).toBeGreaterThan(sub.trialStartDate);
  });

  it('16. Plan codes are normalised (trimmed, lowercased) on lookup', async () => {
    expect((await PlanService.getActivePlan('  PRO '))?.code).toBe('pro');
    expect(await PlanService.getActivePlan('not-a-plan')).toBeNull();
    expect(await PlanService.getActivePlan('a/b')).toBeNull();
  });

  it('17. A Razorpay subscription id can be linked to only one user', async () => {
    const now = Date.now();
    const first = await SubscriptionRepository.claimProviderLink('sub_rzp_shared', {
      uid: 'userA',
      subscriptionId: 's1',
      providerSubscriptionId: 'sub_rzp_shared',
      linkedAt: now,
    });
    const second = await SubscriptionRepository.claimProviderLink('sub_rzp_shared', {
      uid: 'userB',
      subscriptionId: 's2',
      providerSubscriptionId: 'sub_rzp_shared',
      linkedAt: now,
    });
    expect(first).toEqual({ ownerUid: 'userA', claimedNow: true });
    expect(second).toEqual({ ownerUid: 'userA', claimedNow: false });
  });

  it('Path safety: every uid / id used in a path is validated, unsafe external ids are hashed', () => {
    expect(() => assertSafeUid('../../user/victim')).toThrow();
    expect(() => paths.subscription('a/b')).toThrow();
    expect(() => paths.creditBalance('')).toThrow();
    expect(() => paths.jobApplication('uid1', 'x.y')).toThrow();
    expect(isSafeKey('evt_123')).toBe(true);
    expect(keyForExternalId('evt_123')).toBe('evt_123');
    expect(keyForExternalId('evt.with/odd#chars')).toMatch(/^h_[0-9a-f]{40}$/);
    expect(stripUndefined({ a: undefined, b: { c: undefined, d: 1 } })).toEqual({ b: { d: 1 } });
  });

  // Skipped against the live database: it deliberately writes simulated JobForm Automator data at the root.
  it.skipIf(isLiveRtdb)(
    'Namespace isolation: a full user lifecycle writes nothing outside nanobrowser/ (no collision with JobForm Automator)',
    async () => {
      // Pre-existing automator data at the root must stay untouched
      const automatorData = {
        user: { someUid: { fname: 'A', Payment: { Status: 'Premium' } } },
        users: { 'someone@x,com': true },
        payment_records: { someUid: { pay_1: { plan: 'Premium' } } },
        jobApplications: { job1: { p1: { name: 'x' } } },
      };
      await memoryDb.ref().update(automatorData);

      const { uid, auth } = await registerViaApi(app, { email: 'lifecycle@datamodel.com' });
      await CreditService.deductCredits({
        userId: uid,
        amount: 3,
        description: 'x',
        idempotencyKey: 'k',
        metadata: { runId: 'r1' },
      });
      await JobApplicationService.recordApplication(uid, {
        jobId: 'https://example.com/jobs/1',
        title: 't',
        company: 'c',
        location: '',
        salaryRange: '',
        fitScore: 1,
        platform: 'linkedin',
        applicationUrl: '',
        status: 'APPLIED',
        appliedAt: Date.now(),
      });
      await request(app)
        .put('/api/v1/profile')
        .set('Authorization', auth)
        .send({ fullName: 'F', email: 'f@x.y', currentTitle: 'T', resumeText: 'R', skillExperience: { 'Node.js': 1 } });
      await request(app).post('/api/v1/profile/quota/check-and-increment').set('Authorization', auth);
      await request(app).post('/api/v1/subscription/checkout').set('Authorization', auth).send({ planCode: 'pro' });
      const raw = JSON.stringify({ event_id: 'evt_ns', event: 'payment.failed', payload: {} });
      await request(app)
        .post('/api/v1/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('x-razorpay-signature', crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex'))
        .send(raw);

      const rootKeys = Object.keys((await memoryDb.ref().get()).val()).sort();
      expect(rootKeys).toEqual([RTDB_ROOT, 'jobApplications', 'payment_records', 'user', 'users'].sort());
      for (const [key, value] of Object.entries(automatorData)) {
        expect((await memoryDb.ref(key).get()).val()).toEqual(value);
      }
    },
  );

  it('Index coverage: every query used by the services is declared in the rules fragment', () => {
    // The in-memory RTDB throws on orderByChild queries without a matching `.indexOn`, so any test
    // that ran a query has already verified this; this documents the declared indexes.
    const fragment = loadRulesFragment();
    expect(fragment.nanobrowser['.read']).toBe(false);
    expect(fragment.nanobrowser['.write']).toBe(false);
    expect(fragment.nanobrowser.subscriptions['.indexOn']).toContain('status');
    expect(fragment.nanobrowser.credit_ledger.$uid['.indexOn']).toEqual(expect.arrayContaining(['createdAt', 'runId']));
    expect(fragment.nanobrowser.job_applications.$uid['.indexOn']).toEqual(
      expect.arrayContaining(['updatedAt', 'status']),
    );
    expect(fragment.nanobrowser.llm_usage.$uid['.indexOn']).toEqual(
      expect.arrayContaining(['createdAt', 'idempotencyKey']),
    );
    if (!isLiveRtdb) expect(memoryDb.unindexedQueries).toEqual([]);
  });
});
