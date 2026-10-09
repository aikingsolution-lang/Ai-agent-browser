/**
 * MongoDB → RTDB migration script: dry run, execution, re-runs, conflicts, uid strategies and the
 * read-only guarantee. Runs against fixture documents (real ObjectId / Date values) and the
 * in-memory RTDB — no MongoDB or Firebase project is touched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { BSON, ObjectId } from 'mongodb';
import { createApp } from '../app.js';
import { CreditService } from '../services/credit.service.js';
import { paths } from '../services/rtdb/client.js';
import { runMigration } from '../scripts/migrate-mongo-to-rtdb/migrate.js';
import { createRtdbTarget } from '../scripts/migrate-mongo-to-rtdb/target.js';
import { createExportFileSource, mongoSourceFromDb } from '../scripts/migrate-mongo-to-rtdb/source.js';
import { MONGO_COLLECTIONS, type MongoDoc, type MongoSource } from '../scripts/migrate-mongo-to-rtdb/types.js';
import {
  idTokenFor,
  isLiveRtdb,
  memoryAuth,
  memoryDb,
  namespaceIsEmpty,
  resetFirebase,
  testDb,
} from './helpers/firebaseTestEnv.js';
import { readPath, rtdb } from './helpers/testApi.js';

const app = createApp();
const day = 24 * 3600 * 1000;
const t0 = new Date('2026-06-01T10:00:00.000Z');
const at = (offsetDays: number) => new Date(t0.getTime() + offsetDays * day);

const ids = {
  u1: new ObjectId(),
  u2: new ObjectId(),
  u3: new ObjectId(),
  ghost: new ObjectId(),
  planTrial: new ObjectId(),
  planPro: new ObjectId(),
  subTrial1: new ObjectId(),
  subPro1: new ObjectId(),
  subTrial2: new ObjectId(),
};

function fixtures(): Record<string, MongoDoc[]> {
  const future = new Date(Date.now() + 20 * day);
  return {
    [MONGO_COLLECTIONS.users]: [
      {
        _id: ids.u1,
        name: 'Asha',
        email: 'asha@example.com',
        passwordHash: '$2a$12$abc',
        role: 'user',
        status: 'active',
        hasUsedTrial: true,
        trialUsedAt: at(0),
        createdAt: at(0),
        updatedAt: at(1),
        __v: 0,
      },
      {
        _id: ids.u2,
        name: 'Ben',
        email: 'ben@example.com',
        googleLinked: true,
        googleId: 'g-123',
        picture: 'https://p/x.jpg',
        role: 'user',
        status: 'active',
        hasUsedTrial: false,
        createdAt: at(2),
        updatedAt: at(2),
      },
      {
        _id: ids.u3,
        name: 'Cy',
        email: 'cy@example.com',
        passwordHash: '$2a$12$def',
        role: 'user',
        status: 'suspended',
        hasUsedTrial: false,
        createdAt: at(3),
        updatedAt: at(3),
      },
    ],
    [MONGO_COLLECTIONS.plans]: [
      {
        _id: ids.planTrial,
        code: 'free-trial',
        name: '5-Day Free Trial',
        description: 'trial',
        amount: 0,
        currency: 'INR',
        billingInterval: 'none',
        creditsPerBillingPeriod: 1000,
        rateLimitPerMinute: 60,
        features: ['all_models'],
        isActive: true,
        createdAt: at(0),
        updatedAt: at(0),
      },
      {
        _id: ids.planPro,
        code: 'pro',
        name: 'Pro Automation Plan',
        description: 'pro',
        amount: 149900,
        currency: 'INR',
        billingInterval: 'monthly',
        creditsPerBillingPeriod: 5000,
        rateLimitPerMinute: 300,
        features: ['all_models'],
        razorpayPlanId: 'plan_REALPRO',
        isActive: true,
        createdAt: at(0),
        updatedAt: at(5),
      },
    ],
    [MONGO_COLLECTIONS.subscriptions]: [
      {
        _id: ids.subTrial1,
        userId: ids.u1,
        planId: ids.planTrial,
        planCodeSnapshot: 'free-trial',
        planNameSnapshot: '5-Day Free Trial',
        amountSnapshot: 0,
        currencySnapshot: 'INR',
        billingIntervalSnapshot: 'none',
        creditsSnapshot: 1000,
        rateLimitSnapshot: 60,
        provider: 'manual',
        status: 'EXPIRED',
        isTrial: true,
        trialStartDate: at(0),
        trialEndDate: at(5),
        currentPeriodStart: at(0),
        currentPeriodEnd: at(5),
        cancelAtPeriodEnd: false,
        endedAt: at(5),
        createdAt: at(0),
        updatedAt: at(5),
      },
      {
        _id: ids.subPro1,
        userId: ids.u1,
        planId: ids.planPro,
        planCodeSnapshot: 'pro',
        planNameSnapshot: 'Pro Automation Plan',
        amountSnapshot: 149900,
        currencySnapshot: 'INR',
        billingIntervalSnapshot: 'monthly',
        creditsSnapshot: 5000,
        rateLimitSnapshot: 300,
        provider: 'razorpay',
        providerSubscriptionId: 'sub_RZP_ABC',
        status: 'ACTIVE',
        isTrial: false,
        currentPeriodStart: at(6),
        currentPeriodEnd: future,
        cancelAtPeriodEnd: false,
        lastEventTimestamp: at(6),
        createdAt: at(6),
        updatedAt: at(6),
      },
      {
        _id: ids.subTrial2,
        userId: ids.u2,
        planId: ids.planTrial,
        planCodeSnapshot: 'free-trial',
        planNameSnapshot: '5-Day Free Trial',
        amountSnapshot: 0,
        currencySnapshot: 'INR',
        billingIntervalSnapshot: 'none',
        creditsSnapshot: 1000,
        rateLimitSnapshot: 60,
        provider: 'manual',
        status: 'TRIALING',
        isTrial: true,
        trialStartDate: new Date(),
        trialEndDate: new Date(Date.now() + 4 * day),
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 4 * day),
        cancelAtPeriodEnd: false,
        createdAt: at(2),
        updatedAt: at(2),
      },
    ],
    [MONGO_COLLECTIONS.creditBalances]: [
      {
        _id: new ObjectId(),
        userId: ids.u1,
        subscriptionId: ids.subPro1,
        allocatedCredits: 5000,
        usedCredits: 1000,
        remainingCredits: 4000,
        periodStart: at(6),
        periodEnd: future,
        createdAt: at(0),
        updatedAt: at(7),
        isBlocked: false,
      },
      {
        _id: new ObjectId(),
        userId: ids.u2,
        subscriptionId: ids.subTrial2,
        allocatedCredits: 1000,
        usedCredits: 0,
        remainingCredits: 1000,
        periodStart: at(2),
        periodEnd: at(7),
        createdAt: at(2),
        updatedAt: at(2),
      },
    ],
    [MONGO_COLLECTIONS.creditLedger]: [
      {
        _id: new ObjectId(),
        userId: ids.u1,
        subscriptionId: ids.subTrial1,
        amount: 1000,
        balanceBefore: 0,
        balanceAfter: 1000,
        type: 'TRIAL_ALLOCATION',
        description: 'Initial trial',
        metadata: {},
        createdAt: at(0),
      },
      {
        _id: new ObjectId(),
        userId: ids.u1,
        subscriptionId: ids.subPro1,
        amount: 5000,
        balanceBefore: 900,
        balanceAfter: 5000,
        type: 'SUBSCRIPTION_RENEWAL',
        description: 'Paid',
        metadata: {},
        createdAt: at(6),
      },
      {
        _id: new ObjectId(),
        userId: ids.u1,
        subscriptionId: ids.subPro1,
        amount: -600,
        balanceBefore: 5000,
        balanceAfter: 4400,
        type: 'USAGE_DEDUCTION',
        description: 'LLM usage',
        idempotencyKey: 'llm_deduct_key-1',
        metadata: { runId: 'run-9', requestId: 'r1', 'weird.key': 1 },
        createdAt: at(7),
      },
      {
        _id: new ObjectId(),
        userId: ids.u1,
        subscriptionId: ids.subPro1,
        amount: -400,
        balanceBefore: 4400,
        balanceAfter: 4000,
        type: 'USAGE_DEDUCTION',
        description: 'LLM usage',
        metadata: { runId: 'run-9' },
        createdAt: at(7),
      },
      {
        _id: new ObjectId(),
        userId: ids.ghost,
        subscriptionId: ids.subPro1,
        amount: -1,
        balanceBefore: 1,
        balanceAfter: 0,
        type: 'USAGE_DEDUCTION',
        description: 'orphan',
        metadata: {},
        createdAt: at(7),
      },
    ],
    [MONGO_COLLECTIONS.jobApplications]: [
      {
        _id: new ObjectId(),
        userId: ids.u1,
        jobId: 'https://www.linkedin.com/jobs/view/42/',
        title: 'Engineer',
        company: 'Acme',
        location: 'Pune',
        salaryRange: '',
        fitScore: 88,
        platform: 'linkedin',
        applicationUrl: 'https://www.linkedin.com/jobs/view/42/',
        status: 'APPLIED',
        appliedAt: at(8),
        createdAt: at(8),
        updatedAt: at(8),
      },
      {
        _id: new ObjectId(),
        userId: ids.u1,
        jobId: 'naukri-77',
        title: 'Dev',
        company: 'Beta',
        location: '',
        salaryRange: '',
        fitScore: 50,
        platform: 'naukri',
        applicationUrl: '',
        status: 'QUEUED',
        appliedAt: null,
        createdAt: at(9),
        updatedAt: at(9),
      },
    ],
    [MONGO_COLLECTIONS.careerBrains]: [
      {
        _id: new ObjectId(),
        userId: ids.u1,
        fullName: 'Asha Rao',
        email: 'asha@example.com',
        phoneNumber: '+91 1',
        currentTitle: 'Engineer',
        resumeText: 'resume',
        skills: ['Node.js', 'C#'],
        yearsOfExperience: 3,
        hasWorkExperience: true,
        workExperience: [
          { id: 'w1', company: 'Acme', title: 'Eng', endMonth: null, endYear: null, isCurrent: true, source: 'resume' },
        ],
        workHistory: [{ role: 'Eng', company: 'Acme', duration: '2023 - Present', highlights: ['x'] }],
        skillExperience: { 'Node.js': 3, 'C#': 1 },
        customAnswers: { 'Relocate to Pune/Delhi?': 'Yes' },
        goldenAnswers: [{ id: 'g1', question: 'Notice?', answer: '30 days', category: 'General', isDefault: false }],
        tier: 'premium',
        dailyQuota: { appliedToday: 4, dailyLimit: 100, lastResetDate: '2026-10-01' },
        createdAt: at(1),
        updatedAt: at(9),
      },
    ],
    [MONGO_COLLECTIONS.llmUsage]: [
      {
        _id: new ObjectId(),
        requestId: 'llm_req_1',
        userId: ids.u1,
        provider: 'bedrock',
        model: 'amazon.nova-lite-v1:0',
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        creditsDeducted: 1,
        latencyMs: 300,
        status: 'SUCCESS',
        idempotencyKey: 'key-1',
        metadata: { content: 'cached answer', runId: 'run-9' },
        createdAt: at(7),
        updatedAt: at(7),
      },
      {
        _id: new ObjectId(),
        requestId: 'llm_req_2',
        userId: ids.u1,
        provider: 'bedrock',
        model: 'amazon.nova-lite-v1:0',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        creditsDeducted: 0,
        latencyMs: 30000,
        status: 'TIMEOUT',
        errorMessage: 'timeout',
        createdAt: at(8),
        updatedAt: at(8),
      },
    ],
    [MONGO_COLLECTIONS.webhooks]: [
      {
        _id: new ObjectId(),
        eventId: 'evt_1',
        eventType: 'subscription.charged',
        providerPaymentId: 'pay_1',
        status: 'PROCESSED',
        payload: { subscription: { entity: { id: 'sub_RZP_ABC' } } },
        processedAt: at(6),
        createdAt: at(6),
        updatedAt: at(6),
      },
      {
        _id: new ObjectId(),
        eventId: 'evt.weird/id',
        eventType: 'payment.failed',
        status: 'FAILED',
        errorMessage: 'x',
        payload: { 'odd.key': 1 },
        createdAt: at(6),
        updatedAt: at(6),
      },
    ],
    [MONGO_COLLECTIONS.refreshTokens]: [
      { _id: new ObjectId(), userId: ids.u1, tokenHash: 'a', expiresAt: future },
      { _id: new ObjectId(), userId: ids.u1, tokenHash: 'b', expiresAt: future },
    ],
  };
}

/** In-memory MongoSource over fixture documents (read-only by construction). */
function fixtureSource(collections: Record<string, MongoDoc[]>): MongoSource {
  const matches = (doc: MongoDoc, filter: Record<string, unknown>) =>
    Object.entries(filter).every(([key, value]) => String(doc[key]) === String(value));
  return {
    describe: () => 'fixtures',
    listCollections: async () => Object.keys(collections),
    count: async (name, filter = {}) => (collections[name] ?? []).filter(doc => matches(doc, filter)).length,
    async *find(name, filter = {}) {
      for (const doc of collections[name] ?? []) if (matches(doc, filter)) yield doc;
    },
    close: async () => undefined,
  };
}

const u1 = ids.u1.toHexString();
const u2 = ids.u2.toHexString();
const u3 = ids.u3.toHexString();

async function execute(options: Partial<Parameters<typeof runMigration>[2]> = {}, data = fixtures()) {
  const target = createRtdbTarget({ db: testDb, dryRun: false, label: 'test db' });
  return runMigration(fixtureSource(data), target, { uidStrategy: 'mongo-id', ...options });
}

describe('MongoDB → Firebase RTDB migration script', () => {
  beforeEach(async () => {
    await resetFirebase();
  });

  it('dry run reads and reports everything but writes nothing', async () => {
    const target = createRtdbTarget({ db: testDb, dryRun: true, label: 'test db' });
    const report = await runMigration(fixtureSource(fixtures()), target, { uidStrategy: 'mongo-id' });

    if (!isLiveRtdb) expect(memoryDb.writes).toBe(0);
    expect(await namespaceIsEmpty()).toBe(true);
    expect(report.mode).toBe('dry-run');
    expect(report.writes.paths).toBeGreaterThan(0);

    expect(report.entities.users).toMatchObject({ read: 3, migrated: 3, failed: 0, skipped: 0 });
    expect(report.entities.plans).toMatchObject({ read: 2, migrated: 2 });
    expect(report.entities.subscriptions).toMatchObject({ read: 3, migrated: 3, duplicates: 0 });
    expect(report.entities.creditBalances).toMatchObject({ read: 2, migrated: 2 });
    expect(report.entities.creditLedger).toMatchObject({ read: 4, migrated: 4, orphans: 1 });
    expect(report.entities.jobApplications).toMatchObject({ read: 2, migrated: 2 });
    expect(report.entities.careerBrains).toMatchObject({ read: 1, migrated: 1 });
    expect(report.entities.llmUsage).toMatchObject({ read: 2, migrated: 2 });
    expect(report.entities.webhooks).toMatchObject({ read: 2, migrated: 2 });
    expect(report.entities.refreshTokens).toMatchObject({ read: 2, skipped: 2 });
    expect(report.users).toMatchObject({ resolved: 3, unresolved: 0, withPassword: 2 });
    expect(report.sanitizedMetadataKeys).toBe(1);
  });

  it('execute writes the RTDB layout under nanobrowser/ only, keyed by uid, with Mongo ids preserved', async () => {
    // Simulated JobForm Automator root data — in-memory only (never written to the live database).
    if (!isLiveRtdb)
      await memoryDb.ref().update({ user: { someAutomatorUid: { fname: 'X' } }, users: { 'a@b,com': true } });
    const report = await execute();
    expect(Object.values(report.entities).reduce((sum, s) => sum + s.failed, 0)).toBe(0);

    if (!isLiveRtdb) {
      const rootKeys = Object.keys((await memoryDb.ref().get()).val()).sort();
      expect(rootKeys).toEqual(['nanobrowser', 'user', 'users']);
    }

    expect(await rtdb.userProfile(u1)).toMatchObject({
      name: 'Asha',
      email: 'asha@example.com',
      legacyId: u1,
      status: 'active',
    });
    expect((await rtdb.userProfile(u1)).passwordHash).toBeUndefined();
    expect((await rtdb.userProfile(u3)).status).toBe('suspended');
    expect(await rtdb.trialFlag(u1)).toEqual({ hasUsedTrial: true, trialUsedAt: at(0).getTime() });
    // u2 had a trial subscription but no hasUsedTrial flag → flag derived from the trial
    expect((await rtdb.trialFlag(u2)).hasUsedTrial).toBe(true);

    const current = await rtdb.subscription(u1);
    expect(current).toMatchObject({
      subscriptionId: ids.subPro1.toHexString(),
      status: 'ACTIVE',
      planCodeSnapshot: 'pro',
      providerSubscriptionId: 'sub_RZP_ABC',
      planId: ids.planPro.toHexString(),
    });
    expect(Object.keys(await readPath(paths.subscriptionHistory(u1)))).toEqual([ids.subTrial1.toHexString()]);
    expect(await readPath(paths.providerSubscription('sub_RZP_ABC'))).toMatchObject({
      uid: u1,
      subscriptionId: ids.subPro1.toHexString(),
    });

    expect(await rtdb.balance(u1)).toMatchObject({
      remainingCredits: 4000,
      allocatedCredits: 5000,
      usedCredits: 1000,
      subscriptionId: ids.subPro1.toHexString(),
    });
    expect((await rtdb.balance(u1)).isBlocked).toBeUndefined();
    expect(await rtdb.ledger(u1)).toHaveLength(4);
    expect(await readPath(paths.creditLedgerCount(u1))).toBe(4);
    const weird = (await rtdb.ledger(u1)).find(entry => entry.idempotencyKey === 'llm_deduct_key-1');
    expect(weird.metadata).toEqual({ runId: 'run-9', requestId: 'r1', weird_key: 1 });
    expect(weird.runId).toBe('run-9');

    const brain = await rtdb.careerBrain(u1);
    expect(brain.skillExperienceList).toEqual([
      { skill: 'Node.js', years: 3 },
      { skill: 'C#', years: 1 },
    ]);
    expect(brain.dailyQuota).toEqual({ appliedToday: 4, dailyLimit: 100, lastResetDate: '2026-10-01' });

    expect(await rtdb.jobApplications(u1)).toHaveLength(2);
    expect(await rtdb.llmUsage(u1)).toHaveLength(2);
    expect(await readPath(paths.plan('pro'))).toMatchObject({
      razorpayPlanId: 'plan_REALPRO',
      legacyId: ids.planPro.toHexString(),
    });
    expect(await readPath(paths.webhook('evt_1'))).toMatchObject({ status: 'PROCESSED', providerPaymentId: 'pay_1' });
    expect(Object.keys(await readPath(`${paths.root()}/processed_webhooks`))).toHaveLength(2);
    expect(await readPath(paths.migrationUser(u1))).toMatchObject({ legacyId: u1 });
    if (!isLiveRtdb) expect(memoryDb.unindexedQueries).toEqual([]);
  });

  it('migrated data is served by the API exactly as before (dates, maps, totals, idempotency)', async () => {
    await execute();
    await memoryAuth.createUser({ uid: u1, email: 'asha@example.com' });
    const auth = `Bearer ${idTokenFor(u1)}`;

    const balance = await request(app).get('/api/v1/credits/balance').set('Authorization', auth);
    expect(balance.body.data).toMatchObject({ allocatedCredits: 5000, remainingCredits: 4000, usedCredits: 1000 });
    expect(balance.body.data.periodStart).toBe(at(6).toISOString());

    const sub = await request(app).get('/api/v1/subscription/me').set('Authorization', auth);
    expect(sub.body.data.status).toBe('ACTIVE');
    expect(sub.body.data.subscription._id).toBe(ids.subPro1.toHexString());
    expect(sub.body.data.subscription.planCodeSnapshot).toBe('pro');

    const history = await request(app).get('/api/v1/credits/history?limit=2').set('Authorization', auth);
    expect(history.body.data.pagination.total).toBe(4);

    const profile = await request(app).get('/api/v1/profile').set('Authorization', auth);
    expect(profile.body.data.skillExperience).toEqual({ 'Node.js': 3, 'C#': 1 });
    expect(profile.body.data.customAnswers).toEqual({ 'Relocate to Pune/Delhi?': 'Yes' });
    expect(profile.body.data.tier).toBe('premium');

    const jobs = await request(app).get('/api/v1/job-applications').set('Authorization', auth);
    expect(jobs.body.pagination.total).toBe(2);
    const dup = await request(app)
      .get(`/api/v1/job-applications/check/${encodeURIComponent('naukri-77')}`)
      .set('Authorization', auth);
    expect(dup.body.exists).toBe(true);

    const usage = await request(app).get('/api/v1/llm/usage').set('Authorization', auth);
    expect(usage.body.data.total).toBe(2);

    // An idempotency key used before the migration is still honoured afterwards
    const retry = await CreditService.deductCredits({
      userId: u1,
      amount: 600,
      description: 'retry',
      idempotencyKey: 'llm_deduct_key-1',
    });
    expect(retry.isIdempotentRetry).toBe(true);
    expect((await rtdb.balance(u1)).remainingCredits).toBe(4000);

    // LLM idempotency (cached response) survives too
    const cached = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', auth)
      .set('x-idempotency-key', 'key-1')
      .send({ model: 'amazon.nova-lite-v1:0', messages: [{ role: 'user', content: 'x' }] });
    expect(cached.body.data).toMatchObject({
      isIdempotentRetry: true,
      content: 'cached answer',
      requestId: 'llm_req_1',
    });

    // Refund by run id works on migrated ledger entries
    const refund = await request(app)
      .post('/api/v1/credits/refund')
      .set('Authorization', auth)
      .send({ runId: 'run-9' });
    expect(refund.status).toBe(200);
    expect(refund.body.data.refundedAmount).toBe(1000);
  });

  it('re-running is idempotent: migrated users are skipped and nothing is duplicated', async () => {
    await execute();
    const before = JSON.stringify((await testDb.ref(paths.root()).get()).val());
    const second = await execute();
    expect(second.users.alreadyMigrated).toBe(3);
    expect(second.entities.users.skipped).toBe(3);
    expect(second.entities.plans.skipped).toBe(2);
    expect(second.entities.webhooks.skipped).toBe(2);
    const after = (await testDb.ref(paths.root()).get()).val();
    // Only the second run record was added
    delete after._migrations.mongo_to_rtdb.runs;
    const beforeParsed = JSON.parse(before);
    delete beforeParsed._migrations.mongo_to_rtdb.runs;
    expect(after).toEqual(beforeParsed);
  });

  it('an interrupted run is resumed for the same user; native RTDB data is never overwritten without --overwrite', async () => {
    // Interrupted: profile written with this legacyId, marker missing
    await testDb
      .ref(paths.userProfile(u1))
      .set({
        name: 'Asha',
        email: 'asha@example.com',
        role: 'user',
        status: 'active',
        legacyId: u1,
        createdAt: 1,
        updatedAt: 1,
      });
    // Native: u2 already uses the new backend
    await testDb
      .ref(paths.subscription(u2))
      .set({ subscriptionId: 'sub_native', uid: u2, status: 'TRIALING', createdAt: 1, updatedAt: 1 });

    const report = await execute();
    expect(report.entities.users.migrated).toBe(2); // u1 (resumed) + u3
    expect(report.users.conflicts).toBe(1);
    expect((await rtdb.subscription(u2)).subscriptionId).toBe('sub_native');
    expect(report.entities.subscriptions.skipped).toBe(1); // u2's trial
    expect(report.issues.some(issue => issue.uid === u2 && /did not come from the migration/.test(issue.reason))).toBe(
      true,
    );

    const forced = await execute({ overwrite: true, only: ['users'], user: u2 });
    expect(forced.entities.users.migrated).toBe(1);
    expect((await rtdb.subscription(u2)).subscriptionId).toBe(ids.subTrial2.toHexString());
  });

  it('uid map and email strategy: unresolved users and their documents are skipped and reported', async () => {
    const report = await execute({
      uidStrategy: 'email',
      lookupUidByEmail: async email => (email === 'ben@example.com' ? 'firebaseBen' : null),
      uidMap: { [u3]: 'firebaseCy' },
    });
    expect(report.users).toMatchObject({ resolved: 2, unresolved: 1 });
    expect((await rtdb.subscription('firebaseBen')).uid).toBe('firebaseBen');
    expect((await rtdb.userProfile('firebaseCy')).legacyId).toBe(u3);
    expect(await rtdb.userProfile(u1)).toBeNull();
    expect(report.entities.creditLedger.skipped).toBe(4);
    expect(report.entities.subscriptions.skipped).toBe(2);
    expect(report.issues.some(issue => issue.legacyId === u1 && issue.kind === 'skipped')).toBe(true);
  });

  it('the live Mongo source only ever reads (find / countDocuments / listCollections)', async () => {
    const calls: string[] = [];
    const data = fixtures();
    const forbidden = (name: string) => () => {
      throw new Error(`write method ${name} called on MongoDB`);
    };
    const stubDb: any = {
      databaseName: 'stub',
      listCollections: () => ({ toArray: async () => Object.keys(data).map(name => ({ name })) }),
      collection: (name: string) => {
        const docs = data[name] ?? [];
        const filtered = (filter: Record<string, unknown> = {}) =>
          docs.filter(doc => Object.entries(filter).every(([k, v]) => String(doc[k]) === String(v)));
        const collection: any = {
          countDocuments: async (filter: any) => {
            calls.push(`countDocuments:${name}`);
            return filtered(filter).length;
          },
          find: (filter: any) => {
            calls.push(`find:${name}`);
            const rows = filtered(filter);
            return {
              sort: () => ({
                async *[Symbol.asyncIterator]() {
                  yield* rows;
                },
                close: async () => undefined,
              }),
            };
          },
        };
        for (const method of [
          'insertOne',
          'insertMany',
          'updateOne',
          'updateMany',
          'replaceOne',
          'deleteOne',
          'deleteMany',
          'findOneAndUpdate',
          'findOneAndDelete',
          'bulkWrite',
          'drop',
        ]) {
          collection[method] = forbidden(method);
        }
        return collection;
      },
    };
    const source = mongoSourceFromDb(stubDb, 'stub', async () => undefined);
    const target = createRtdbTarget({ db: testDb, dryRun: false, label: 'test db' });
    const report = await runMigration(source, target, { uidStrategy: 'mongo-id' });

    expect(report.entities.users.migrated).toBe(3);
    expect(calls.every(call => /^(find|countDocuments):/.test(call))).toBe(true);
  });

  it('reads mongoexport (Extended JSON) files for an offline dry run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-mongoexport-'));
    try {
      const data = fixtures();
      for (const [name, docs] of Object.entries(data)) {
        fs.writeFileSync(
          path.join(dir, `${name}.json`),
          docs.map(doc => BSON.EJSON.stringify(doc, { relaxed: false })).join('\n'),
        );
      }
      const source = createExportFileSource(dir);
      const target = createRtdbTarget({ db: null, dryRun: true, label: 'no rtdb' });
      const report = await runMigration(source, target, { uidStrategy: 'mongo-id' });
      expect(report.entities.users.migrated).toBe(3);
      expect(report.entities.creditLedger).toMatchObject({ read: 4, orphans: 1 });
      expect(report.entities.careerBrains.migrated).toBe(1);
      expect(await namespaceIsEmpty()).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
