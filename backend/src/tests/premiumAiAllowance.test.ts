import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { env } from '../config/env.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import {
  PremiumAiAllowanceService,
  premiumMonthlyAiTaskLimit,
  premiumTaskFor,
} from '../services/premiumAiAllowance.service.js';
import { ApplicationQuotaService } from '../services/applicationQuota.service.js';
import { isLiveRtdb, memoryDb, resetFirebase } from './helpers/firebaseTestEnv.js';
import { registerViaApi, rtdb } from './helpers/testApi.js';

const app = createApp();

// A small allowance so the limit can be reached in a test (the default is 1,000)
const configuredLimit = env.PREMIUM_MONTHLY_AI_TASK_LIMIT;
beforeAll(() => {
  env.PREMIUM_MONTHLY_AI_TASK_LIMIT = 3;
});
afterAll(() => {
  env.PREMIUM_MONTHLY_AI_TASK_LIMIT = configuredLimit;
});

const payment = (tier: 'Premium' | 'Diamond', endDate = '2099-01-01 00:00:00') => ({
  Status: 'Premium',
  SubscriptionType: tier,
  End_Date: endDate,
});

const chat = (auth: string, runId?: string, model = 'amazon.nova-lite-v1:0') => {
  const req = request(app).post('/api/v1/llm/chat').set('Authorization', auth);
  if (runId !== undefined) req.set('x-run-id', runId);
  return req.send({ model, messages: [{ role: 'user', content: 'Hello' }] });
};

const allowance = async (auth: string) =>
  (await request(app).get('/api/v1/llm/premium-allowance').set('Authorization', auth)).body.data;

/** Premium / Diamond only: free trial over, no credits left. */
async function premiumOnlyUser(email: string, tier: 'Premium' | 'Diamond' = 'Premium') {
  const user = await registerViaApi(app, { email });
  await rtdb.patchSubscription(user.uid, { status: 'EXPIRED', endedAt: Date.now() - 1000 });
  await rtdb.patchBalance(user.uid, { remainingCredits: 0 });
  await memoryDb.ref(`user/${user.uid}/Payment`).set(payment(tier));
  return user;
}

describe('which requests are a task', () => {
  it('one run id is one task; Auto Apply runs are not counted; no run id is a task of its own', () => {
    expect(premiumTaskFor('agent-task-1')).toEqual(premiumTaskFor('agent-task-1'));
    expect(premiumTaskFor('agent-task-1')).not.toEqual(premiumTaskFor('agent-task-2'));
    expect(premiumTaskFor('easy_apply_123_456')).toEqual({ counted: false });
    expect(premiumTaskFor('auto_loop_1793541564806_job42')).toEqual({ counted: false });
    const a = premiumTaskFor(undefined);
    const b = premiumTaskFor('');
    expect(a.counted && b.counted && a.key !== b.key).toBe(true);
  });
});

// Writes simulated JobForm Automator payment records at user/{uid}/Payment (outside the namespace),
// so it only runs against the in-memory database.
describe.skipIf(isLiveRtdb)('Premium / Diamond built-in Cloud API: monthly AI task allowance', () => {
  beforeEach(async () => {
    await resetFirebase();
    await PlanSeedService.seedDefaultPlans();
  });

  it('uses the configured allowance (3 here, 1,000 by default)', () => {
    expect(configuredLimit).toBe(1000);
    expect(premiumMonthlyAiTaskLimit()).toBe(3);
  });

  it('every request of the same task counts once, even concurrently', async () => {
    const { auth } = await premiumOnlyUser('same-task@allowance.test');
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => chat(auth, 'agent-task-A')));
    expect(results.map(r => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await allowance(auth)).toMatchObject({ tier: 'Premium', included: true, used: 1, limit: 3, remaining: 2 });
  });

  it("after the month's tasks: a new task is refused (402), started tasks and Auto Apply go on, no credits drawn", async () => {
    const { uid, auth } = await premiumOnlyUser('limit@allowance.test');
    for (const task of ['t1', 't2', 't3']) expect((await chat(auth, task)).status).toBe(200);

    const refused = await chat(auth, 't4');
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('PREMIUM_AI_TASK_LIMIT_REACHED');
    expect(refused.body.message).toMatch(/3 AI tasks a month/);

    expect((await chat(auth, 't2')).status).toBe(200); // already counted this month
    expect((await chat(auth, 'easy_apply_99_1')).status).toBe(200); // Auto Apply: daily quota instead
    expect((await chat(auth, 'auto_loop_1_job7')).status).toBe(200);
    expect((await chat(auth)).status).toBe(402); // no run id: a new task
    expect(await allowance(auth)).toMatchObject({ used: 3, remaining: 0 });
    expect(await rtdb.balance(uid)).toMatchObject({ remainingCredits: 0 });
  });

  it('a refused task is not left half-counted: it is refused again, and counts once the allowance renews', async () => {
    const { uid } = await premiumOnlyUser('refused@allowance.test');
    const now = Date.UTC(2026, 10, 15);
    for (const task of ['a', 'b', 'c']) {
      expect(await PremiumAiAllowanceService.chargeTask(uid, premiumTaskFor(task), now)).toBe(true);
    }
    expect(await PremiumAiAllowanceService.chargeTask(uid, premiumTaskFor('d'), now)).toBe(false);
    expect(await PremiumAiAllowanceService.chargeTask(uid, premiumTaskFor('d'), now)).toBe(false);
    const nextMonth = Date.UTC(2026, 11, 1);
    expect(await PremiumAiAllowanceService.chargeTask(uid, premiumTaskFor('d'), nextMonth)).toBe(true);
    expect(await PremiumAiAllowanceService.getUsed(uid, nextMonth)).toBe(1);
  });

  it('with its own credit plan, an account falls back to credits instead of being refused', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'fallback@allowance.test' }); // free trial + credits
    await memoryDb.ref(`user/${uid}/Payment`).set(payment('Premium'));
    for (const task of ['t1', 't2', 't3']) expect((await chat(auth, task)).status).toBe(200);
    const before = (await rtdb.balance(uid)).remainingCredits;
    expect((await chat(auth, 't4')).status).toBe(200);
    expect((await rtdb.balance(uid)).remainingCredits).toBeLessThan(before);
  });

  it('other models are not part of the allowance: they draw credits and leave it untouched', async () => {
    const { auth } = await premiumOnlyUser('model@allowance.test');
    const res = await chat(auth, 'sonnet-task', 'anthropic.claude-3-5-sonnet-20240620-v1:0');
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('INSUFFICIENT_CREDITS');
    expect(await allowance(auth)).toMatchObject({ used: 0 });
  });

  it('accounts without Premium: not included, nothing counted (credits as before)', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'free@allowance.test' });
    const before = (await rtdb.balance(uid)).remainingCredits;
    expect((await chat(auth, 'free-task')).status).toBe(200);
    expect((await rtdb.balance(uid)).remainingCredits).toBeLessThan(before);
    expect(await allowance(auth)).toMatchObject({ tier: 'Free', included: false, used: 0 });
  });

  it('an expired Premium is not included any more', async () => {
    const { uid, auth } = await premiumOnlyUser('expired@allowance.test');
    await memoryDb.ref(`user/${uid}/Payment`).set(payment('Premium', '2001-01-01 00:00:00'));
    expect((await chat(auth, 't1')).status).toBe(403);
    expect(await allowance(auth)).toMatchObject({ tier: 'Free', included: false });
  });

  it('upgrading Premium → Diamond: Diamond everywhere at once, same allowance, nothing of Premium kept', async () => {
    const { uid, auth } = await premiumOnlyUser('upgrade@allowance.test');
    await memoryDb.ref(`user/${uid}/Payment`).set(payment('Premium', '2026-12-01 00:00:00'));
    expect((await chat(auth, 't1')).status).toBe(200);

    // What the website's server writes for a verified Diamond payment
    await memoryDb.ref(`user/${uid}/Payment`).set(payment('Diamond', '2046-11-01 10:00:00'));
    expect(await allowance(auth)).toMatchObject({ tier: 'Diamond', included: true, used: 1, limit: 3 });
    expect(await ApplicationQuotaService.resolveEntitlement(uid)).toEqual({
      limit: 300,
      plan: 'diamond',
      isPaid: true,
    });
    const me = await request(app).get('/api/v1/subscription/me').set('Authorization', auth);
    expect(me.body.data.premium).toMatchObject({
      tier: 'Diamond',
      isPremium: true,
      endDate: expect.stringMatching(/^2046-11-01/),
    });
    expect((await chat(auth, 't2')).status).toBe(200);
  });

  it('the allowance belongs to the account: another account starts at zero', async () => {
    const a = await premiumOnlyUser('a@allowance.test');
    const b = await premiumOnlyUser('b@allowance.test', 'Diamond');
    for (const task of ['t1', 't2', 't3']) expect((await chat(a.auth, task)).status).toBe(200);
    expect((await chat(b.auth, 't1')).status).toBe(200);
    expect(await allowance(b.auth)).toMatchObject({ tier: 'Diamond', used: 1 });
  });

  it('the allowance endpoint needs a signed-in user', async () => {
    expect((await request(app).get('/api/v1/llm/premium-allowance')).status).toBe(401);
  });
});
