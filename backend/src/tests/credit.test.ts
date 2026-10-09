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
});
