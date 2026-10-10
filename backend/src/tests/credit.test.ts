import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { CreditService } from '../services/credit.service.js';
import { resetFirebase, createTestUser } from './helpers/firebaseTestEnv.js';
import { registerViaApi, rtdb } from './helpers/testApi.js';

const app = createApp();

describe('Phase 7: Server-Side Credit & Usage Metering Engine (Firebase RTDB)', () => {
  beforeEach(async () => {
    await resetFirebase();
    await PlanSeedService.seedDefaultPlans();
  });

  it('1. Registration initializes credit balance from plan snapshot (100 credits)', async () => {
    const { uid } = await registerViaApi(app, { name: 'Credit User', email: 'user1@credittest.com' });

    const balance = await rtdb.balance(uid);
    expect(balance).not.toBeNull();
    expect(balance.allocatedCredits).toBe(100);
    expect(balance.usedCredits).toBe(0);
    expect(balance.remainingCredits).toBe(100);

    const ledger = (await rtdb.ledger(uid)).filter(entry => entry.type === 'TRIAL_ALLOCATION');
    expect(ledger).toHaveLength(1);
    expect(ledger[0].amount).toBe(100);
    expect(ledger[0].balanceAfter).toBe(100);
  });

  it('2. Credit deduction via Service updates balance and logs ledger entry', async () => {
    const { uid } = await registerViaApi(app, { email: 'deduct@credittest.com' });

    const result = await CreditService.deductCredits({
      userId: uid,
      amount: 10,
      description: 'Test browser automation task',
    });

    expect(result.balance.remainingCredits).toBe(90);
    expect(result.balance.usedCredits).toBe(10);
    expect(result.ledgerEntry.amount).toBe(-10);
    expect(result.ledgerEntry.balanceBefore).toBe(100);
    expect(result.ledgerEntry.balanceAfter).toBe(90);
    expect(result.isIdempotentRetry).toBe(false);
    // API shape matches the Mongo document (ISO dates, _id, userId)
    expect(result.ledgerEntry.userId).toBe(uid);
    expect(typeof result.ledgerEntry._id).toBe('string');
    expect(new Date(result.ledgerEntry.createdAt!).toISOString()).toBe(result.ledgerEntry.createdAt);
  });

  it('3. Deducting more credits than available fails with 402 INSUFFICIENT_CREDITS', async () => {
    const { uid } = await registerViaApi(app, { email: 'exceed@credittest.com' });

    await expect(
      CreditService.deductCredits({ userId: uid, amount: 150, description: 'Excessive consumption attempt' }),
    ).rejects.toThrow('Insufficient credit balance');

    const balance = await rtdb.balance(uid);
    expect(balance.remainingCredits).toBe(100);
    expect(balance.usedCredits).toBe(0);
  });

  it('3b. Deducting from a user with no balance node fails with 402 (no balance), never a negative balance', async () => {
    const { uid } = await createTestUser({ email: 'nobalance@credittest.com' });
    await expect(CreditService.deductCredits({ userId: uid, amount: 1, description: 'x' })).rejects.toMatchObject({
      statusCode: 402,
      code: 'INSUFFICIENT_CREDITS',
    });
    expect(await rtdb.balance(uid)).toBeNull();
  });

  it('4. Concurrent credit deductions with different keys prevent negative balance and enforce atomicity', async () => {
    const { uid } = await registerViaApi(app, { email: 'concurrent@credittest.com' });

    // 10 parallel deductions of 15 credits each (requested 150, available 100)
    const results = await Promise.all(
      Array.from({ length: 10 }).map((_, i) =>
        CreditService.deductCredits({ userId: uid, amount: 15, description: `Parallel task ${i + 1}` }).catch(
          err => err,
        ),
      ),
    );

    const successful = results.filter(r => !(r instanceof Error));
    const failed = results.filter(r => r instanceof Error);
    expect(successful.length).toBe(6);
    expect(failed.length).toBe(4);

    const finalBalance = await rtdb.balance(uid);
    expect(finalBalance.remainingCredits).toBe(10);
    expect(finalBalance.usedCredits).toBe(90);
    expect((await rtdb.ledger(uid)).filter(entry => entry.type === 'USAGE_DEDUCTION')).toHaveLength(6);
  });

  it('5. Truly concurrent requests with SAME idempotencyKey deduct credits exactly ONCE without divergence', async () => {
    const { uid } = await registerViaApi(app, { email: 'concurrentsamekey@credittest.com' });
    const sameKey = 'concurrent-same-key-001';

    const results = await Promise.all(
      Array.from({ length: 10 }).map(() =>
        CreditService.deductCredits({
          userId: uid,
          amount: 10,
          description: 'Concurrent same key execution',
          idempotencyKey: sameKey,
        }),
      ),
    );

    expect(results.filter(r => !r.isIdempotentRetry)).toHaveLength(1);
    expect(results.filter(r => r.isIdempotentRetry)).toHaveLength(9);

    const finalBalance = await rtdb.balance(uid);
    expect(finalBalance.remainingCredits).toBe(90);
    expect(finalBalance.usedCredits).toBe(10);

    const ledgerEntries = (await rtdb.ledger(uid)).filter(entry => entry.idempotencyKey === sameKey);
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0].amount).toBe(-10);
    expect(ledgerEntries[0].balanceAfter).toBe(90);
    // Every caller sees the same ledger entry
    expect(new Set(results.map(r => r.ledgerEntry._id)).size).toBe(1);
  });

  it('6. Sequential idempotency key retry returns cached response without duplicate deduction', async () => {
    const { uid } = await registerViaApi(app, { email: 'idempotent@credittest.com' });
    const idempotencyKey = 'seq-task-key-001';

    const res1 = await CreditService.deductCredits({
      userId: uid,
      amount: 25,
      description: 'Idempotent Task Execution',
      idempotencyKey,
    });
    expect(res1.balance.remainingCredits).toBe(75);
    expect(res1.isIdempotentRetry).toBe(false);

    const res2 = await CreditService.deductCredits({
      userId: uid,
      amount: 25,
      description: 'Idempotent Task Execution Retry',
      idempotencyKey,
    });
    expect(res2.isIdempotentRetry).toBe(true);
    expect(res2.balance.remainingCredits).toBe(75);

    expect((await rtdb.ledger(uid)).filter(entry => entry.idempotencyKey === idempotencyKey)).toHaveLength(1);
  });

  it('6b. A failed (insufficient) deduction releases its idempotency key so a later retry can succeed', async () => {
    const { uid } = await registerViaApi(app, { email: 'retryafterfail@credittest.com' });
    await rtdb.patchBalance(uid, { remainingCredits: 3, usedCredits: 97 });

    await expect(
      CreditService.deductCredits({ userId: uid, amount: 5, description: 'too much', idempotencyKey: 'k-1' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });

    await rtdb.patchBalance(uid, { remainingCredits: 50 });
    const retry = await CreditService.deductCredits({
      userId: uid,
      amount: 5,
      description: 'retry',
      idempotencyKey: 'k-1',
    });
    expect(retry.isIdempotentRetry).toBe(false);
    expect(retry.balance.remainingCredits).toBe(45);
  });

  it('6c. Idempotency keys are isolated per user (the same key on two accounts deducts from each)', async () => {
    const a = await registerViaApi(app, { email: 'keyA@credittest.com' });
    const b = await registerViaApi(app, { email: 'keyB@credittest.com' });

    const ra = await CreditService.deductCredits({
      userId: a.uid,
      amount: 7,
      description: 'a',
      idempotencyKey: 'shared-key',
    });
    const rb = await CreditService.deductCredits({
      userId: b.uid,
      amount: 7,
      description: 'b',
      idempotencyKey: 'shared-key',
    });

    expect(ra.isIdempotentRetry).toBe(false);
    expect(rb.isIdempotentRetry).toBe(false);
    expect(rb.ledgerEntry.userId).toBe(b.uid);
    expect((await rtdb.balance(a.uid)).remainingCredits).toBe(93);
    expect((await rtdb.balance(b.uid)).remainingCredits).toBe(93);
  });

  it('7. checkCredits middleware allows access when balance >= required and rejects 402 when low', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'middleware@credittest.com' });

    const accessRes1 = await request(app).get('/api/v1/test-metered-feature').set('Authorization', auth);
    expect(accessRes1.status).toBe(200);

    await rtdb.patchBalance(uid, { remainingCredits: 2, usedCredits: 98 });

    const accessRes2 = await request(app).get('/api/v1/test-metered-feature').set('Authorization', auth);
    expect(accessRes2.status).toBe(402);
    expect(accessRes2.body.error.code).toBe('INSUFFICIENT_CREDITS');
  });

  it('8. GET /api/v1/credits/balance returns credit info and low balance warning', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'balanceapi@credittest.com' });

    const res1 = await request(app).get('/api/v1/credits/balance').set('Authorization', auth);
    expect(res1.status).toBe(200);
    expect(res1.body.data.allocatedCredits).toBe(100);
    expect(res1.body.data.remainingCredits).toBe(100);
    expect(res1.body.data.isLowBalance).toBe(false);
    // ISO date strings, as the Mongo version returned
    expect(res1.body.data.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res1.body.data.periodEnd).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await rtdb.patchBalance(uid, { remainingCredits: 5, usedCredits: 95 });

    const res2 = await request(app).get('/api/v1/credits/balance').set('Authorization', auth);
    expect(res2.status).toBe(200);
    expect(res2.body.data.remainingCredits).toBe(5);
    expect(res2.body.data.isLowBalance).toBe(true);
  });

  it('9. GET /api/v1/credits/history returns paginated audit entries in reverse chronological order', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'historyapi@credittest.com' });

    await CreditService.deductCredits({ userId: uid, amount: 5, description: 'Action 1' });
    await new Promise(resolve => setTimeout(resolve, 5));
    await CreditService.deductCredits({ userId: uid, amount: 10, description: 'Action 2' });

    const res = await request(app).get('/api/v1/credits/history?page=1&limit=2').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBe(2);
    expect(res.body.data.pagination.total).toBe(3); // 1 allocation + 2 deductions
    expect(res.body.data.pagination.totalPages).toBe(2);
    expect(res.body.data.items[0].description).toBe('Action 2');

    const page2 = await request(app).get('/api/v1/credits/history?page=2&limit=2').set('Authorization', auth);
    expect(page2.body.data.items).toHaveLength(1);
    expect(page2.body.data.items[0].type).toBe('TRIAL_ALLOCATION');
  });

  it('10. POST /api/v1/credits/deduct is removed from public API surface (returns 404)', async () => {
    const { auth } = await registerViaApi(app, { email: 'removedep@credittest.com' });

    const res = await request(app)
      .post('/api/v1/credits/deduct')
      .set('Authorization', auth)
      .send({ amount: 10, description: 'Direct deduction attempt' });

    expect(res.status).toBe(404);
  });

  it('11. Refund for an agent run returns the deducted credits exactly once (also under concurrency)', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'refund@credittest.com' });

    await CreditService.deductCredits({ userId: uid, amount: 4, description: 'step 1', metadata: { runId: 'run-42' } });
    await CreditService.deductCredits({ userId: uid, amount: 6, description: 'step 2', metadata: { runId: 'run-42' } });
    await CreditService.deductCredits({
      userId: uid,
      amount: 3,
      description: 'other run',
      metadata: { runId: 'run-7' },
    });
    expect((await rtdb.balance(uid)).remainingCredits).toBe(87);

    const responses = await Promise.all(
      Array.from({ length: 4 }).map(() =>
        request(app).post('/api/v1/credits/refund').set('Authorization', auth).send({ runId: 'run-42' }),
      ),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.data.refundedAmount).toBe(10);
    }

    const balance = await rtdb.balance(uid);
    expect(balance.remainingCredits).toBe(97);
    expect(balance.usedCredits).toBe(3);
    expect((await rtdb.ledger(uid)).filter(entry => entry.type === 'REFUND')).toHaveLength(1);

    const missing = await request(app)
      .post('/api/v1/credits/refund')
      .set('Authorization', auth)
      .send({ runId: 'run-unknown' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('RUN_NOT_FOUND');
  });

  it('12. Admin top-up (scripts/topup_credits.ts) sets allocated = remaining and records an ADMIN_ADJUSTMENT', async () => {
    const { uid } = await registerViaApi(app, { email: 'topup@credittest.com' });
    await CreditService.deductCredits({ userId: uid, amount: 30, description: 'use' });

    const balance = await CreditService.adminSetBalance(uid, 500, 'Admin top-up');
    expect(balance).toMatchObject({ allocatedCredits: 500, remainingCredits: 500, usedCredits: 30 });
    const adjustment = (await rtdb.ledger(uid)).find(entry => entry.type === 'ADMIN_ADJUSTMENT');
    expect(adjustment).toMatchObject({ amount: 430, balanceBefore: 70, balanceAfter: 500 });

    const { uid: fresh } = await createTestUser({ email: 'nobalance-topup@credittest.com' });
    expect((await CreditService.adminSetBalance(fresh, 200, 'Admin top-up')).remainingCredits).toBe(200);
  });

  it('13. POST /api/v1/credits/refund/report-failed validates input and stores dropped refund record', async () => {
    const { auth } = await registerViaApi(app, { email: 'reportfailed@credittest.com' });

    // Invalid missing runId
    const resBad = await request(app)
      .post('/api/v1/credits/refund/report-failed')
      .set('Authorization', auth)
      .send({ idempotencyKey: 'refund_x' });
    expect(resBad.status).toBe(400);

    // Invalid reason format
    const resBadReason = await request(app)
      .post('/api/v1/credits/refund/report-failed')
      .set('Authorization', auth)
      .send({
        runId: 'run-fail-1',
        idempotencyKey: 'refund_run-fail-1',
        reason: 'invalid reason with spaces and special @#$%',
      });
    expect(resBadReason.status).toBe(400);

    // Valid call
    const resGood = await request(app)
      .post('/api/v1/credits/refund/report-failed')
      .set('Authorization', auth)
      .send({ runId: 'run-fail-1', idempotencyKey: 'refund_run-fail-1', reason: 'max_attempts_exceeded' });
    expect(resGood.status).toBe(200);
    expect(resGood.body.data.recorded).toBe(true);
  });

  it('14. POST /api/v1/credits/reconcile rejects with 403 when feature flag is disabled', async () => {
    const { env } = await import('../config/env.js');
    const originalFlag = env.ENABLE_CREDITS_RECONCILE;
    env.ENABLE_CREDITS_RECONCILE = false;

    try {
      const { auth } = await registerViaApi(app, { email: 'reconcile-disabled@credittest.com' });
      const res = await request(app).post('/api/v1/credits/reconcile').set('Authorization', auth);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FEATURE_DISABLED');
    } finally {
      env.ENABLE_CREDITS_RECONCILE = originalFlag;
    }
  });

  it('15. POST /api/v1/credits/reconcile rejects recent runs (<30 min), refunds eligible old runs once, and respects daily cap', async () => {
    const { env } = await import('../config/env.js');
    const originalFlag = env.ENABLE_CREDITS_RECONCILE;
    env.ENABLE_CREDITS_RECONCILE = true;

    try {
      const { uid, auth } = await registerViaApi(app, { email: 'reconcile@credittest.com' });

      // Deduct for run-recent (created right now: age < 30 min)
      await CreditService.deductCredits({
        userId: uid,
        amount: 5,
        description: 'recent run',
        metadata: { runId: 'run-recent' },
      });

      // Reconcile: run-recent must NOT be refunded
      const res1 = await request(app).post('/api/v1/credits/reconcile').set('Authorization', auth);
      expect(res1.status).toBe(200);
      expect(res1.body.data.reconciledCount).toBe(0);
      expect(res1.body.data.totalRefunded).toBe(0);

      // Simulate an old run from 45 minutes ago by directly appending a ledger entry
      const oldTimestamp = Date.now() - 45 * 60 * 1000;
      const oldEntry = {
        entryId: 'cl_test_old',
        uid,
        subscriptionId: 'sub_test',
        amount: -12,
        balanceBefore: 95,
        balanceAfter: 83,
        type: 'USAGE_DEDUCTION' as const,
        description: 'old unapplied run',
        runId: 'run-old-1',
        createdAt: oldTimestamp,
      };
      const { paths } = await import('../services/rtdb/client.js');
      const { testDb } = await import('./helpers/firebaseTestEnv.js');
      await testDb.ref(paths.creditLedgerEntry(uid, 'cl_test_old')).set(oldEntry);

      // Reconcile now: run-old-1 should be refunded
      const res2 = await request(app).post('/api/v1/credits/reconcile').set('Authorization', auth);
      expect(res2.status).toBe(200);
      expect(res2.body.data.reconciledCount).toBe(1);
      expect(res2.body.data.totalRefunded).toBe(12);
      expect(res2.body.data.refundedRunIds).toContain('run-old-1');

      // Never double refund: second reconcile run does not re-refund run-old-1
      const res3 = await request(app).post('/api/v1/credits/reconcile').set('Authorization', auth);
      expect(res3.status).toBe(200);
      expect(res3.body.data.reconciledCount).toBe(0);
      expect(res3.body.data.totalRefunded).toBe(0);

      // Daily cap test: add run exceeding remaining cap (> 50 total)
      const oldEntry2 = {
        entryId: 'cl_test_old_large',
        uid,
        subscriptionId: 'sub_test',
        amount: -45, // 12 already refunded + 45 = 57 > 50 cap
        balanceBefore: 83,
        balanceAfter: 38,
        type: 'USAGE_DEDUCTION' as const,
        description: 'large unapplied run exceeding cap',
        runId: 'run-old-large',
        createdAt: oldTimestamp,
      };
      await testDb.ref(paths.creditLedgerEntry(uid, 'cl_test_old_large')).set(oldEntry2);

      const resCap = await request(app).post('/api/v1/credits/reconcile').set('Authorization', auth);
      expect(resCap.status).toBe(200);
      expect(resCap.body.data.reconciledCount).toBe(0);
      expect(resCap.body.data.totalRefunded).toBe(0);
      expect(resCap.body.data.refundedRunIds).not.toContain('run-old-large');
    } finally {
      env.ENABLE_CREDITS_RECONCILE = originalFlag;
    }
  });

  it('16. Concurrent client refund and reconcile calls for the same runId never double refund', async () => {
    const { env } = await import('../config/env.js');
    const originalFlag = env.ENABLE_CREDITS_RECONCILE;
    env.ENABLE_CREDITS_RECONCILE = true;

    try {
      const { uid, auth } = await registerViaApi(app, { email: 'concurrent-refund@credittest.com' });
      const oldTimestamp = Date.now() - 45 * 60 * 1000;
      const testRunId = 'run-concurrent-test';

      const entry = {
        entryId: 'cl_test_concurrent',
        uid,
        subscriptionId: 'sub_test',
        amount: -10,
        balanceBefore: 100,
        balanceAfter: 90,
        type: 'USAGE_DEDUCTION' as const,
        description: 'concurrent test deduction',
        runId: testRunId,
        createdAt: oldTimestamp,
      };
      const { paths } = await import('../services/rtdb/client.js');
      const { testDb } = await import('./helpers/firebaseTestEnv.js');
      await testDb.ref(paths.creditLedgerEntry(uid, 'cl_test_concurrent')).set(entry);

      // Launch client refund and reconcile simultaneously
      const [resClient, resReconcile] = await Promise.all([
        request(app).post('/api/v1/credits/refund').set('Authorization', auth).send({ runId: testRunId }),
        request(app).post('/api/v1/credits/reconcile').set('Authorization', auth),
      ]);

      // Both operations succeed cleanly: whichever finishes first issues the refund,
      // and the second returns the completed idempotent result (200 with same refund details)
      // or 409 with IDEMPOTENCY_KEY_IN_PROGRESS only if racing while lock is held.
      expect([200, 409]).toContain(resClient.status);
      if (resClient.status === 409) {
        expect(resClient.body.error.code).toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
      } else {
        expect(resClient.body.data.refundedAmount).toBe(10);
      }
      expect(resReconcile.status).toBe(200);

      // Total ledger REFUND entries for this run must be exactly 1
      const ledger = await rtdb.ledger(uid);
      const refunds = ledger.filter(e => e.type === 'REFUND' && e.runId === testRunId);
      expect(refunds).toHaveLength(1);
      expect(refunds[0].amount).toBe(10);
    } finally {
      env.ENABLE_CREDITS_RECONCILE = originalFlag;
    }
  });

  it('17. Behavioral test: two users on the same IP have independent rate limits (user A hits 429, user B succeeds)', async () => {
    const express = (await import('express')).default;
    const rateLimit = (await import('express-rate-limit')).default;
    const { getLlmRateLimiterKey } = await import('../middleware/rateLimiter.js');

    // Test express app with a custom tight limiter (2 req/min) using our exact keyGenerator
    const testApp = express();
    testApp.use(express.json());

    // Middleware to set user from header for testing
    testApp.use((req: any, _res, next) => {
      const uid = req.headers['x-test-uid'];
      if (uid) req.user = { uid, _id: uid };
      next();
    });

    const testLimiter = rateLimit({
      windowMs: 60 * 1000,
      max: 2,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: getLlmRateLimiterKey,
      message: { success: false, error: { code: 'TOO_MANY_REQUESTS' } },
    });

    testApp.post('/test-llm', testLimiter, (_req, res) => {
      res.status(200).json({ success: true });
    });

    // Both users make requests from the same client / IP
    const client = request(testApp);

    // User A makes 2 allowed requests
    const resA1 = await client.post('/test-llm').set('x-test-uid', 'user-alpha');
    expect(resA1.status).toBe(200);

    const resA2 = await client.post('/test-llm').set('x-test-uid', 'user-alpha');
    expect(resA2.status).toBe(200);

    // User A makes 3rd request -> hits 429
    const resA3 = await client.post('/test-llm').set('x-test-uid', 'user-alpha');
    expect(resA3.status).toBe(429);
    expect(resA3.body.error.code).toBe('TOO_MANY_REQUESTS');

    // User B on the same IP has their own bucket and is not blocked
    const resB1 = await client.post('/test-llm').set('x-test-uid', 'user-beta');
    expect(resB1.status).toBe(200);
    expect(resB1.body.success).toBe(true);
  });

  it('18. Daily refund cap: user with 50 credits already refunded in 24h gets 429, user under cap succeeds', async () => {
    const { uid: userCapped, auth: authCapped } = await registerViaApi(app, { email: 'capped-refund@credittest.com' });
    const { uid: userUnder, auth: authUnder } = await registerViaApi(app, { email: 'under-refund@credittest.com' });
    const { paths } = await import('../services/rtdb/client.js');
    const { testDb } = await import('./helpers/firebaseTestEnv.js');

    const now = Date.now();

    // Setup userCapped: deduction of 10 for run-to-refund, and an existing recent refund of 50 credits in the last 24h
    const existingRefund = {
      entryId: 'cl_prior_refund',
      uid: userCapped,
      subscriptionId: 'sub_test',
      amount: 50,
      balanceBefore: 50,
      balanceAfter: 100,
      type: 'REFUND' as const,
      description: 'Prior refund',
      runId: 'run-prior',
      createdAt: now - 2 * 60 * 60 * 1000, // 2 hours ago
    };
    const deductionCapped = {
      entryId: 'cl_deduct_capped',
      uid: userCapped,
      subscriptionId: 'sub_test',
      amount: -10,
      balanceBefore: 100,
      balanceAfter: 90,
      type: 'USAGE_DEDUCTION' as const,
      description: 'Run deduction',
      runId: 'run-capped-attempt',
      createdAt: now - 30 * 60 * 1000,
    };
    await testDb.ref(paths.creditLedgerEntry(userCapped, 'cl_prior_refund')).set(existingRefund);
    await testDb.ref(paths.creditLedgerEntry(userCapped, 'cl_deduct_capped')).set(deductionCapped);

    // Calling refund on run-capped-attempt must be rejected with 429 DAILY_REFUND_LIMIT_EXCEEDED
    const resCapped = await request(app)
      .post('/api/v1/credits/refund')
      .set('Authorization', authCapped)
      .send({ runId: 'run-capped-attempt' });
    expect(resCapped.status).toBe(429);
    expect(resCapped.body.error.code).toBe('DAILY_REFUND_LIMIT_EXCEEDED');

    // Setup userUnder: has only 20 refunded in last 24h, requests 15 (total 35 <= 50 cap)
    const priorUnder = {
      entryId: 'cl_prior_under',
      uid: userUnder,
      subscriptionId: 'sub_test',
      amount: 20,
      balanceBefore: 80,
      balanceAfter: 100,
      type: 'REFUND' as const,
      description: 'Prior refund',
      runId: 'run-prior-under',
      createdAt: now - 2 * 60 * 60 * 1000,
    };
    const deductionUnder = {
      entryId: 'cl_deduct_under',
      uid: userUnder,
      subscriptionId: 'sub_test',
      amount: -15,
      balanceBefore: 100,
      balanceAfter: 85,
      type: 'USAGE_DEDUCTION' as const,
      description: 'Run deduction',
      runId: 'run-under-attempt',
      createdAt: now - 30 * 60 * 1000,
    };
    await testDb.ref(paths.creditLedgerEntry(userUnder, 'cl_prior_under')).set(priorUnder);
    await testDb.ref(paths.creditLedgerEntry(userUnder, 'cl_deduct_under')).set(deductionUnder);

    // Calling refund on run-under-attempt succeeds with 200
    const resUnder = await request(app)
      .post('/api/v1/credits/refund')
      .set('Authorization', authUnder)
      .send({ runId: 'run-under-attempt' });
    expect(resUnder.status).toBe(200);
    expect(resUnder.body.data.refundedAmount).toBe(15);
  });

  it('19. Stale claim: a PENDING claim older than STALE_CLAIM_MS is reclaimed, while a fresh claim is not', async () => {
    const { CreditRepository } = await import('../services/rtdb/repositories.js');
    const { STALE_CLAIM_MS } = await import('../services/credit.service.js');

    const testUid = 'user-claim-ttl-test';
    const testKeyFresh = 'key-fresh-claim';
    const testKeyStale = 'key-stale-claim';
    const now = Date.now();

    // 1. Fresh claim created 30 seconds ago (age < STALE_CLAIM_MS)
    const freshClaimAt = now - 30 * 1000;
    const { claimed: claimed1 } = await CreditRepository.claimIdempotency(testUid, testKeyFresh, freshClaimAt);
    expect(claimed1).toBe(true);

    // Attempting to reclaim fresh claim with stale cutoff now - STALE_CLAIM_MS must return false
    const staleCutoff = now - STALE_CLAIM_MS;
    const reclaimedFresh = await CreditRepository.reclaimStaleIdempotency(testUid, testKeyFresh, staleCutoff, now);
    expect(reclaimedFresh).toBe(false);

    // 2. Stale claim created 3 minutes ago (age > 2 min STALE_CLAIM_MS)
    const staleClaimAt = now - (STALE_CLAIM_MS + 60 * 1000);
    const { claimed: claimed2 } = await CreditRepository.claimIdempotency(testUid, testKeyStale, staleClaimAt);
    expect(claimed2).toBe(true);

    // Attempting to reclaim stale claim with stale cutoff now - STALE_CLAIM_MS must succeed
    const reclaimedStale = await CreditRepository.reclaimStaleIdempotency(testUid, testKeyStale, staleCutoff, now);
    expect(reclaimedStale).toBe(true);

    // Verify the claim's createdAt was refreshed to `now`
    const updatedClaim = await CreditRepository.getIdempotencyClaim(testUid, testKeyStale);
    expect(updatedClaim?.createdAt).toBe(now);
    expect(updatedClaim?.status).toBe('PENDING');
  });
});
