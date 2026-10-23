import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import {
  ApplicationQuotaService,
  FREE_DAILY_APPLICATION_LIMIT,
  RESERVATION_TTL_MS,
  nextUtcMidnight,
} from '../services/applicationQuota.service.js';
import { paths } from '../services/rtdb/client.js';
import { isLiveRtdb, memoryDb, resetFirebase } from './helpers/firebaseTestEnv.js';
import { readPath, registerViaApi, rtdb } from './helpers/testApi.js';

const app = createApp();

const reserve = (auth: string, jobKey: string) =>
  request(app).post('/api/v1/profile/quota/reserve').set('Authorization', auth).send({ jobKey });
const commit = (auth: string, jobKey: string) =>
  request(app).post('/api/v1/profile/quota/commit').set('Authorization', auth).send({ jobKey });
const release = (auth: string, jobKey: string) =>
  request(app).post('/api/v1/profile/quota/release').set('Authorization', auth).send({ jobKey });
const getQuota = (auth: string) => request(app).get('/api/v1/profile/quota').set('Authorization', auth);

/** reserve + commit, the way the extension records a submitted application. */
async function apply(auth: string, jobKey: string) {
  const r = await reserve(auth, jobKey);
  if (r.status !== 200) return r;
  return commit(auth, jobKey);
}

const at = (iso: string) => Date.parse(iso);

describe('Daily application quota (server-enforced)', () => {
  beforeEach(async () => {
    await resetFirebase();
    await PlanSeedService.seedDefaultPlans();
  });

  it('free users: applications 1–10 are allowed and the 11th is refused with QUOTA_EXCEEDED', async () => {
    const { auth } = await registerViaApi(app, { email: 'free@quota.test' });
    for (let i = 1; i <= 10; i++) {
      const res = await apply(auth, `linkedin:${i}`);
      expect(res.status).toBe(200);
      expect(res.body.data.counted).toBe(true);
      expect(res.body.data.quota).toMatchObject({ applied: i, limit: 10, remaining: 10 - i, plan: 'free' });
    }
    const eleventh = await reserve(auth, 'linkedin:11');
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(eleventh.body.error.details).toMatchObject({ applied: 10, limit: 10, remaining: 0, isPaid: false });
    expect(eleventh.body.message).toContain('Upgrade to Premium');

    const quota = await getQuota(auth);
    expect(quota.body.data).toMatchObject({
      applied: 10,
      limit: 10,
      remaining: 0,
      allowed: false,
      appliedToday: 10,
      dailyLimit: 10,
      tier: 'free',
      timezone: 'UTC',
    });
  });

  it('a held slot counts toward the limit; a failed submission releases it without being counted', async () => {
    const { auth } = await registerViaApi(app, { email: 'release@quota.test' });
    for (let i = 1; i <= 9; i++) await apply(auth, `linkedin:${i}`);

    expect((await reserve(auth, 'linkedin:10')).status).toBe(200);
    // The 10th slot is held: another job cannot take it
    expect((await reserve(auth, 'naukri:other')).status).toBe(429);

    // The submission failed: releasing frees the slot and nothing is counted
    const released = await release(auth, 'linkedin:10');
    expect(released.body.data.quota).toMatchObject({ applied: 9, reserved: 0, remaining: 1 });
    expect((await apply(auth, 'naukri:other')).body.data.quota).toMatchObject({ applied: 10, remaining: 0 });
  });

  it('duplicate retries never count twice', async () => {
    const { auth } = await registerViaApi(app, { email: 'dup@quota.test' });
    await apply(auth, 'indeed:abc');
    const again = await commit(auth, 'indeed:abc');
    expect(again.body.data).toMatchObject({ counted: false, quota: { applied: 1 } });

    // Re-reserving a job already counted today is granted without holding a slot
    const reserveAgain = await reserve(auth, 'indeed:abc');
    expect(reserveAgain.body.data).toMatchObject({
      granted: true,
      alreadyCounted: true,
      quota: { applied: 1, reserved: 0 },
    });

    // Reserving the same job twice holds one slot
    await reserve(auth, 'indeed:def');
    const twice = await reserve(auth, 'indeed:def');
    expect(twice.body.data.quota).toMatchObject({ applied: 1, reserved: 1 });
  });

  it('concurrent attempts never exceed the limit (20 parallel jobs → exactly 10 slots)', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'race@quota.test' });
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => reserve(auth, `linkedin:race-${i}`)));
    const granted = responses.filter(r => r.status === 200);
    expect(granted).toHaveLength(FREE_DAILY_APPLICATION_LIMIT);
    expect(responses.filter(r => r.status === 429)).toHaveLength(10);

    // Concurrent commits of the same job count it once
    const jobKey = `linkedin:race-${responses.findIndex(r => r.status === 200)}`;
    await Promise.all(Array.from({ length: 5 }, () => commit(auth, jobKey)));
    const stored = await readPath(paths.applicationQuota(uid));
    expect(stored.applied).toBe(1);
    expect(Object.keys(stored.reservations)).toHaveLength(9);
  });

  it('a slot that is never committed or released expires', async () => {
    const { uid } = await registerViaApi(app, { email: 'ttl@quota.test' });
    const t0 = at('2026-10-23T08:00:00.000Z');
    for (let i = 0; i < 10; i++) await ApplicationQuotaService.reserve(uid, `job:${i}`, t0);
    expect((await ApplicationQuotaService.reserve(uid, 'job:late', t0 + 1000)).granted).toBe(false);
    const afterTtl = await ApplicationQuotaService.reserve(uid, 'job:late', t0 + RESERVATION_TTL_MS + 1);
    expect(afterTtl.granted).toBe(true);
    expect(afterTtl.quota).toMatchObject({ applied: 0, reserved: 1 });
  });

  it('resets at the UTC day boundary', async () => {
    const { uid } = await registerViaApi(app, { email: 'reset@quota.test' });
    const lastMs = at('2026-10-23T23:59:59.999Z');
    for (let i = 0; i < 10; i++) {
      await ApplicationQuotaService.reserve(uid, `job:${i}`, lastMs);
      await ApplicationQuotaService.commit(uid, `job:${i}`, lastMs);
    }
    const sameDay = await ApplicationQuotaService.getStatus(uid, lastMs);
    expect(sameDay).toMatchObject({
      day: '2026-10-23',
      applied: 10,
      remaining: 0,
      resetsAt: '2026-10-24T00:00:00.000Z',
    });
    expect((await ApplicationQuotaService.reserve(uid, 'job:x', lastMs)).granted).toBe(false);

    const midnight = at('2026-10-24T00:00:00.000Z');
    const nextDay = await ApplicationQuotaService.reserve(uid, 'job:x', midnight);
    expect(nextDay.granted).toBe(true);
    expect(nextDay.quota).toMatchObject({ day: '2026-10-24', applied: 0, reserved: 1 });
    // A job counted yesterday may be counted again today (a new day's application)
    expect((await ApplicationQuotaService.commit(uid, 'job:0', midnight)).counted).toBe(true);
    expect(nextUtcMidnight(at('2026-12-31T18:30:00.000Z'))).toBe('2027-01-01T00:00:00.000Z');
  });

  it('quotas are per account: one user’s applications never use another user’s quota', async () => {
    const a = await registerViaApi(app, { email: 'a@quota.test' });
    const b = await registerViaApi(app, { email: 'b@quota.test' });
    for (let i = 1; i <= 10; i++) await apply(a.auth, `linkedin:${i}`);
    expect((await reserve(a.auth, 'linkedin:11')).status).toBe(429);
    // Same job key, other account: independent
    expect((await apply(b.auth, 'linkedin:1')).body.data.quota).toMatchObject({ applied: 1, limit: 10 });
  });

  it('the client cannot set its own limit or counts, and must be signed in', async () => {
    const { auth } = await registerViaApi(app, { email: 'forge@quota.test' });
    const forged = await request(app)
      .post('/api/v1/profile/quota/reserve')
      .set('Authorization', auth)
      .send({ jobKey: 'linkedin:1', limit: 9999, applied: 0 });
    expect(forged.status).toBe(400);
    expect((await request(app).post('/api/v1/profile/quota/reserve').set('Authorization', auth).send({})).status).toBe(
      400,
    );
    expect((await request(app).post('/api/v1/profile/quota/reserve').send({ jobKey: 'linkedin:1' })).status).toBe(401);
  });

  it('the legacy check-and-increment endpoint uses the same counter and limit', async () => {
    const { auth } = await registerViaApi(app, { email: 'legacy@quota.test' });
    await apply(auth, 'linkedin:1');
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(app).post('/api/v1/profile/quota/check-and-increment').set('Authorization', auth),
      ),
    );
    expect(results.filter(r => r.status === 200)).toHaveLength(9);
    expect(results.filter(r => r.status === 429)).toHaveLength(3);
    expect((await getQuota(auth)).body.data).toMatchObject({ applied: 10, remaining: 0 });
  });

  it('paid plans: an ACTIVE pro plan gets 100/day, power 500/day; a trial stays on the free limit', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'plans@quota.test' });
    expect((await getQuota(auth)).body.data).toMatchObject({ limit: 10, plan: 'free', isPaid: false });

    await rtdb.patchSubscription(uid, { status: 'ACTIVE', planCodeSnapshot: 'pro', isTrial: false });
    expect((await getQuota(auth)).body.data).toMatchObject({ limit: 100, plan: 'pro', isPaid: true, tier: 'premium' });

    await rtdb.patchSubscription(uid, { planCodeSnapshot: 'power' });
    expect((await getQuota(auth)).body.data).toMatchObject({ limit: 500, plan: 'power' });

    await rtdb.patchSubscription(uid, { status: 'TRIALING', planCodeSnapshot: 'free-trial', isTrial: true });
    expect((await getQuota(auth)).body.data).toMatchObject({ limit: 10, plan: 'free' });
  });
});

// Writes simulated JobForm Automator payment records at user/{uid}/Payment, outside the namespace,
// so it only runs against the in-memory database.
describe.skipIf(isLiveRtdb)('Daily application quota — JobForm Automator Premium (verified server-side)', () => {
  beforeEach(async () => {
    await resetFirebase();
    await PlanSeedService.seedDefaultPlans();
  });

  const future = '2099-01-01 00:00:00';
  const past = '2001-01-01 00:00:00';

  it('Premium and Diamond get 300/day; an expired plan falls back to the free limit', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'premium@quota.test' });
    const payment = (fields: Record<string, unknown>) => memoryDb.ref(`user/${uid}/Payment`).set(fields);

    await payment({ Status: 'Premium', SubscriptionType: 'Premium', End_Date: future });
    expect((await getQuota(auth)).body.data).toMatchObject({ limit: 300, plan: 'premium', isPaid: true });

    await payment({ Status: 'Premium', SubscriptionType: 'Diamond', End_Date: future });
    expect((await getQuota(auth)).body.data).toMatchObject({ limit: 300, plan: 'diamond' });

    await payment({ Status: 'Premium', SubscriptionType: 'Premium', End_Date: past });
    expect((await getQuota(auth)).body.data).toMatchObject({ limit: 10, plan: 'free', isPaid: false });

    // A trial or unpaid record is not Premium
    await payment({ Status: 'FreeTrialStarted', SubscriptionType: 'FreeTrialStarted' });
    expect((await getQuota(auth)).body.data).toMatchObject({ limit: 10, plan: 'free' });
  });

  it('a Premium user is not stopped at 10; the highest entitlement wins (power 500 > Premium 300)', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'premium11@quota.test' });
    await memoryDb.ref(`user/${uid}/Payment`).set({ Status: 'Premium', SubscriptionType: 'Premium', End_Date: future });
    for (let i = 1; i <= 11; i++) expect((await apply(auth, `linkedin:${i}`)).status).toBe(200);
    expect((await getQuota(auth)).body.data).toMatchObject({ applied: 11, limit: 300, remaining: 289 });

    await rtdb.patchSubscription(uid, { status: 'ACTIVE', planCodeSnapshot: 'power', isTrial: false });
    expect((await getQuota(auth)).body.data).toMatchObject({ limit: 500, plan: 'power' });
  });

  it('Premium follows the account: another user never inherits it', async () => {
    const paid = await registerViaApi(app, { email: 'paid@quota.test' });
    const other = await registerViaApi(app, { email: 'other@quota.test' });
    await memoryDb
      .ref(`user/${paid.uid}/Payment`)
      .set({ Status: 'Premium', SubscriptionType: 'Premium', End_Date: future });
    expect((await getQuota(paid.auth)).body.data.limit).toBe(300);
    expect((await getQuota(other.auth)).body.data.limit).toBe(10);
  });
});
