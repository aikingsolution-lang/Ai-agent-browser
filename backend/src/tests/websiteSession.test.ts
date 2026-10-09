/**
 * JobForm Automator website integration, backend side:
 *   - premium status comes only from user/{uid}/Payment (written by JobForm Automator's verified
 *     payment routes) with JobForm Automator's own rule, for the uid in the verified ID token;
 *   - the session the extension receives from the website (Firebase ID + refresh token) is checked
 *     by /auth/me and refreshed by /auth/refresh, and dead sessions fail with 401.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { getSubscriptionTier, parsePaymentDate, toJobformPremiumStatus } from '../services/jobformPremium.service.js';
import { createTestUser, isLiveRtdb, memoryDb, resetFirebase } from './helpers/firebaseTestEnv.js';

const app = createApp();
const fmt = (date: Date) => date.toISOString().replace('T', ' ').split('.')[0]; // JobForm Automator's format
const days = (n: number) => new Date(Date.now() + n * 86_400_000);

describe('JobForm Automator premium rule (copy of lib/interview/premium.ts)', () => {
  const now = new Date('2026-10-09T12:00:00Z');

  it('parses the stored "YYYY-MM-DD HH:mm:ss" UTC format and ISO strings', () => {
    expect(parsePaymentDate('2026-11-09 12:00:00')?.toISOString()).toBe('2026-11-09T12:00:00.000Z');
    expect(parsePaymentDate('2026-11-09T12:00:00.000Z')?.toISOString()).toBe('2026-11-09T12:00:00.000Z');
    expect(parsePaymentDate('not a date')).toBeNull();
    expect(parsePaymentDate(undefined)).toBeNull();
  });

  it('grants Premium / Diamond only for a paid record whose End_Date has not passed', () => {
    expect(
      getSubscriptionTier({ Status: 'Premium', SubscriptionType: 'Premium', End_Date: '2026-11-09 12:00:00' }, now),
    ).toBe('Premium');
    expect(
      getSubscriptionTier({ Status: 'Premium', SubscriptionType: 'Diamond', End_Date: '2046-10-09 12:00:00' }, now),
    ).toBe('Diamond');
    expect(getSubscriptionTier({ SubscriptionType: 'Premium', End_Date: '2026-11-09 12:00:00' }, now)).toBe('Premium'); // legacy
    expect(
      getSubscriptionTier({ Status: 'Premium', SubscriptionType: 'Premium', End_Date: '2026-10-09 11:59:59' }, now),
    ).toBe('Free');
    expect(
      getSubscriptionTier(
        { Status: 'Free', SubscriptionType: 'FreeTrialStarted', End_Date: '2030-01-01 00:00:00' },
        now,
      ),
    ).toBe('Free');
    expect(getSubscriptionTier({ SubscriptionType: 'Diamond' }, now)).toBe('Free'); // Diamond without paid status
    expect(getSubscriptionTier(null, now)).toBe('Free');
    // An unparseable End_Date keeps JobForm Automator's historical behaviour of trusting the status
    expect(getSubscriptionTier({ Status: 'Premium', End_Date: 'soon' }, now)).toBe('Premium');
  });

  it('reports an expired paid record as expired, not premium', () => {
    const status = toJobformPremiumStatus(
      { Status: 'Premium', SubscriptionType: 'Premium', End_Date: '2026-10-01 00:00:00' },
      now,
    );
    expect(status).toMatchObject({
      tier: 'Free',
      isPremium: false,
      expired: true,
      endDate: '2026-10-01T00:00:00.000Z',
    });
    expect(toJobformPremiumStatus(null, now)).toMatchObject({
      tier: 'Free',
      isPremium: false,
      expired: false,
      endDate: null,
    });
  });
});

// These tests write simulated JobForm Automator data at user/{uid}/Payment (outside the namespace),
// so they only run against the in-memory database — never against the real one.
describe.skipIf(isLiveRtdb)('GET /subscription/me — JobForm Automator premium status', () => {
  beforeEach(async () => {
    await resetFirebase();
  });

  async function setPayment(uid: string, payment: Record<string, unknown> | null) {
    await memoryDb.ref(`user/${uid}/Payment`).set(payment);
  }

  it('a payment verified by JobForm Automator (Premium, End_Date in the future) is premium', async () => {
    const user = await createTestUser();
    await setPayment(user.uid, {
      Status: 'Premium',
      SubscriptionType: 'Premium',
      Start_Date: fmt(new Date()),
      End_Date: fmt(days(30)),
      email_count: 0,
    });

    const res = await request(app).get('/api/v1/subscription/me').set('Authorization', user.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.premium).toMatchObject({
      source: 'jobform-automator',
      tier: 'Premium',
      isPremium: true,
      expired: false,
    });
    // NanoBrowser's own subscription data is unchanged by the addition
    expect(res.body.data.subscription.planCodeSnapshot).toBe('free-trial');
  });

  it('Diamond is reported as Diamond', async () => {
    const user = await createTestUser();
    await setPayment(user.uid, { Status: 'Premium', SubscriptionType: 'Diamond', End_Date: fmt(days(365 * 20)) });
    const res = await request(app).get('/api/v1/subscription/me').set('Authorization', user.auth);
    expect(res.body.data.premium).toMatchObject({ tier: 'Diamond', isPremium: true });
  });

  it('no payment record, an unpaid record, or an expired one is not premium', async () => {
    const free = await createTestUser();
    const trial = await createTestUser();
    const lapsed = await createTestUser();
    await setPayment(trial.uid, { Status: 'Free', SubscriptionType: 'FreeTrialStarted', End_Date: fmt(days(30)) });
    await setPayment(lapsed.uid, { Status: 'Premium', SubscriptionType: 'Premium', End_Date: fmt(days(-1)) });

    const tiers = [];
    for (const user of [free, trial, lapsed]) {
      const res = await request(app).get('/api/v1/subscription/me').set('Authorization', user.auth);
      expect(res.status).toBe(200);
      tiers.push([res.body.data.premium.tier, res.body.data.premium.isPremium, res.body.data.premium.expired]);
    }
    expect(tiers).toEqual([
      ['Free', false, false],
      ['Free', false, false],
      ['Free', false, true],
    ]);
  });

  it('expiry and revocation are picked up on the next request (nothing is cached)', async () => {
    const user = await createTestUser();
    await setPayment(user.uid, { Status: 'Premium', SubscriptionType: 'Premium', End_Date: fmt(days(30)) });
    const before = await request(app).get('/api/v1/subscription/me').set('Authorization', user.auth);
    expect(before.body.data.premium.isPremium).toBe(true);

    // JobForm Automator revokes / the period ends
    await setPayment(user.uid, { Status: 'Premium', SubscriptionType: 'Premium', End_Date: fmt(days(-0.01)) });
    const after = await request(app).get('/api/v1/subscription/me').set('Authorization', user.auth);
    expect(after.body.data.premium).toMatchObject({ isPremium: false, expired: true });

    await setPayment(user.uid, null);
    const removed = await request(app).get('/api/v1/subscription/me').set('Authorization', user.auth);
    expect(removed.body.data.premium).toMatchObject({ tier: 'Free', isPremium: false, expired: false });
  });

  it("status is always the token owner's: user B never sees user A's premium", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await setPayment(a.uid, { Status: 'Premium', SubscriptionType: 'Diamond', End_Date: fmt(days(30)) });

    const resB = await request(app).get('/api/v1/subscription/me').set('Authorization', b.auth);
    expect(resB.body.data.premium.isPremium).toBe(false);
    // Query parameters / body cannot select another user
    const spoof = await request(app)
      .get(`/api/v1/subscription/me?uid=${a.uid}`)
      .set('Authorization', b.auth)
      .send({ uid: a.uid });
    expect(spoof.body.data.premium.isPremium).toBe(false);
  });

  it('the endpoint never writes JobForm Automator data', async () => {
    const user = await createTestUser();
    const payment = { Status: 'Premium', SubscriptionType: 'Premium', End_Date: fmt(days(-1)), email_count: 3 };
    await setPayment(user.uid, payment);
    await request(app).get('/api/v1/subscription/me').set('Authorization', user.auth);
    expect((await memoryDb.ref(`user/${user.uid}`).get()).val()).toEqual({ Payment: payment });
  });

  it('a missing, invalid or expired ID token gets no premium status', async () => {
    const user = await createTestUser();
    await setPayment(user.uid, { Status: 'Premium', SubscriptionType: 'Premium', End_Date: fmt(days(30)) });
    for (const header of [
      undefined,
      'Bearer not-a-firebase-token',
      `Bearer test-expired-token:${user.uid}`,
      `Bearer test-id-token:unknown-uid`,
    ]) {
      const req = request(app).get('/api/v1/subscription/me');
      const res = header ? await req.set('Authorization', header) : await req;
      expect(res.status).toBe(401);
      expect(res.body.data?.premium).toBeUndefined();
    }
  });
});

describe('Website session tokens: /auth/me and /auth/refresh', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.FIREBASE_WEB_API_KEY;
  let secureTokenCalls: Array<{ url: string; body: string }> = [];

  beforeEach(async () => {
    await resetFirebase();
    secureTokenCalls = [];
    process.env.FIREBASE_WEB_API_KEY = 'public-web-api-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.FIREBASE_WEB_API_KEY;
    else process.env.FIREBASE_WEB_API_KEY = originalKey;
  });

  function mockSecureToken(handler: (refreshToken: string) => { status: number; body: any } | 'network-error') {
    global.fetch = (async (url: any, options: any) => {
      const target = String(url);
      if (!target.startsWith('https://securetoken.googleapis.com/')) return originalFetch(url, options);
      const body = String(options?.body ?? '');
      secureTokenCalls.push({ url: target, body });
      const result = handler(new URLSearchParams(body).get('refresh_token') ?? '');
      if (result === 'network-error') throw new TypeError('fetch failed');
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  }

  it('/auth/me accepts the ID token the website hands over and returns that uid', async () => {
    const user = await createTestUser({ email: 'web.user@example.com' });
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', user.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ uid: user.uid, _id: user.uid, email: 'web.user@example.com' });
  });

  it('/auth/me distinguishes an expired token (refreshable) from an invalid one', async () => {
    const user = await createTestUser();
    const expired = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer test-expired-token:${user.uid}`);
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('TOKEN_EXPIRED');
    const invalid = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer forged.jwt.token');
    expect(invalid.status).toBe(401);
    expect(invalid.body.error.code).toBe('INVALID_TOKEN');
  });

  it('/auth/refresh exchanges a valid refresh token through Firebase Secure Token and returns the uid', async () => {
    mockSecureToken(refreshToken =>
      refreshToken === 'good-refresh'
        ? {
            status: 200,
            body: {
              id_token: 'new-id-token',
              refresh_token: 'rotated-refresh',
              user_id: 'uid-123',
              expires_in: '3600',
            },
          }
        : { status: 400, body: { error: { message: 'INVALID_REFRESH_TOKEN' } } },
    );
    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'good-refresh' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ token: 'new-id-token', refreshToken: 'rotated-refresh', userId: 'uid-123' });
    expect(secureTokenCalls).toHaveLength(1);
    expect(secureTokenCalls[0].url).toContain('key=public-web-api-key');
    expect(new URLSearchParams(secureTokenCalls[0].body).get('grant_type')).toBe('refresh_token');
  });

  it('/auth/refresh: revoked / expired refresh token or disabled account → 401 (client signs out)', async () => {
    for (const message of ['INVALID_REFRESH_TOKEN', 'TOKEN_EXPIRED', 'USER_DISABLED', 'USER_NOT_FOUND']) {
      mockSecureToken(() => ({ status: 400, body: { error: { message } } }));
      const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'dead-refresh' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
      expect(res.body.data?.token).toBeUndefined();
    }
  });

  it('/auth/refresh: Secure Token outage → 503 (client keeps the session and retries later)', async () => {
    mockSecureToken(() => 'network-error');
    const down = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'good-refresh' });
    expect(down.status).toBe(503);
    mockSecureToken(() => ({ status: 500, body: {} }));
    const error = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'good-refresh' });
    expect(error.status).toBe(503);
  });

  it('/auth/refresh without FIREBASE_WEB_API_KEY is 501 (never a fake success)', async () => {
    delete process.env.FIREBASE_WEB_API_KEY;
    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'good-refresh' });
    expect(res.status).toBe(501);
    expect(res.body.success).toBe(false);
  });

  it('/auth/refresh rejects a missing refresh token', async () => {
    const res = await request(app).post('/api/v1/auth/refresh').send({});
    expect(res.status).toBe(400);
  });
});
