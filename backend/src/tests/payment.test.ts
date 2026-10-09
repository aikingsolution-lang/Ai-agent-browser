import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../app.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { RazorpayService } from '../services/razorpay.service.js';
import { ProfileService } from '../services/profile.service.js';
import { SubscriptionLifecycleService } from '../services/subscriptionLifecycle.service.js';
import { paths } from '../services/rtdb/client.js';
import { env } from '../config/env.js';
import { testDb, resetFirebase } from './helpers/firebaseTestEnv.js';
import { readPath, registerViaApi, rtdb } from './helpers/testApi.js';

// GET /api/v1/test-entitled-feature (authenticate + checkEntitlement) is mounted by routes/index.ts when NODE_ENV=test.
const app = createApp();

function signWebhook(body: object): { raw: string; signature: string } {
  const raw = JSON.stringify(body);
  const signature = crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(Buffer.from(raw, 'utf8'))
    .digest('hex');
  return { raw, signature };
}

function postWebhook(body: object) {
  const { raw, signature } = signWebhook(body);
  return request(app)
    .post('/api/v1/webhooks/razorpay')
    .set('Content-Type', 'application/json')
    .set('x-razorpay-signature', signature)
    .send(raw);
}

function checkoutSignature(paymentId: string, subscriptionId: string): string {
  return crypto.createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${paymentId}|${subscriptionId}`).digest('hex');
}

/** Registers a user and starts a checkout, which links a Razorpay subscription id to the trial. */
async function userWithCheckout(email: string, planCode = 'pro') {
  const user = await registerViaApi(app, { email });
  const checkoutRes = await request(app)
    .post('/api/v1/subscription/checkout')
    .set('Authorization', user.auth)
    .send({ planCode });
  expect(checkoutRes.status).toBe(200);
  return { ...user, rzpSubId: checkoutRes.body.data.subscriptionId as string };
}

describe('Phase 8: Commercial Payment & Subscription Lifecycle Engine (Firebase RTDB)', () => {
  beforeEach(async () => {
    await resetFirebase();
    await PlanSeedService.seedDefaultPlans();
  });

  it('1. HMAC Checkout Signature Verification passes for valid signatures and rejects tampered ones', () => {
    const paymentId = 'pay_test_12345';
    const subscriptionId = 'sub_test_67890';
    expect(
      RazorpayService.verifyCheckoutSignature(paymentId, subscriptionId, checkoutSignature(paymentId, subscriptionId)),
    ).toBe(true);
    expect(RazorpayService.verifyCheckoutSignature(paymentId, subscriptionId, 'invalid_sig')).toBe(false);
  });

  it('2. HMAC Webhook Signature Verification passes for valid raw body signatures', () => {
    const rawBodyBuffer = Buffer.from(JSON.stringify({ event: 'subscription.charged', id: 'evt_100' }), 'utf8');
    const validSignature = crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBodyBuffer).digest('hex');

    expect(RazorpayService.verifyWebhookSignature(rawBodyBuffer, validSignature)).toBe(true);
    expect(RazorpayService.verifyWebhookSignature(rawBodyBuffer, 'tampered_signature')).toBe(false);
  });

  it('3. Dedicated raw-body webhook route handles signature check over raw Buffer', async () => {
    const res = await postWebhook({
      event_id: 'evt_raw_001',
      event: 'subscription.charged',
      payload: { subscription: { entity: { id: 'sub_non_existent', payment_id: 'pay_raw_001' } } },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect((await rtdb.webhook('evt_raw_001')).status).toBe('PROCESSED');
  });

  it('3b. Webhook with a bad signature is rejected and nothing is recorded', async () => {
    const { raw } = signWebhook({ event_id: 'evt_bad_sig', event: 'subscription.charged', payload: {} });
    const res = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', 'deadbeef')
      .send(raw);
    expect(res.status).toBe(401);
    expect(await rtdb.webhook('evt_bad_sig')).toBeNull();
  });

  it('4. POST /api/v1/subscription/checkout resolves DB Plan source of truth for paid plans', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'checkout@paytest.com' });

    const res = await request(app)
      .post('/api/v1/subscription/checkout')
      .set('Authorization', auth)
      .send({ planCode: 'pro' });
    expect(res.status).toBe(200);
    expect(res.body.data.planCode).toBe('pro');
    expect(res.body.data.amount).toBe(149900);
    expect(res.body.data.currency).toBe('INR');
    expect(res.body.data.subscriptionId).toBeDefined();

    // The Razorpay id is linked to the user's subscription and reserved for this user
    expect((await rtdb.subscription(uid)).providerSubscriptionId).toBe(res.body.data.subscriptionId);
    expect((await readPath(paths.providerSubscription(res.body.data.subscriptionId))).uid).toBe(uid);

    const freeRes = await request(app)
      .post('/api/v1/subscription/checkout')
      .set('Authorization', auth)
      .send({ planCode: 'free-trial' });
    expect(freeRes.status).toBe(400);
    expect(freeRes.body.error.code).toBe('INVALID_PLAN');

    const unknown = await request(app)
      .post('/api/v1/subscription/checkout')
      .set('Authorization', auth)
      .send({ planCode: 'gold/../x' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('PLAN_NOT_FOUND');
  });

  it('5. Checkout session idempotency & concurrency returns existing session on retry', async () => {
    const { auth } = await registerViaApi(app, { email: 'checkoutidem@paytest.com' });

    const res1 = await request(app)
      .post('/api/v1/subscription/checkout')
      .set('Authorization', auth)
      .send({ planCode: 'starter' });
    expect(res1.status).toBe(200);
    const subId1 = res1.body.data.subscriptionId;

    const responses = await Promise.all(
      Array.from({ length: 3 }).map(() =>
        request(app).post('/api/v1/subscription/checkout').set('Authorization', auth).send({ planCode: 'starter' }),
      ),
    );
    responses.forEach(res => {
      expect(res.status).toBe(200);
      expect(res.body.data.subscriptionId).toBe(subId1);
    });
  });

  it('6. Verify payment transitions trial subscription to ACTIVE and allocates paid credits', async () => {
    const { uid, auth, rzpSubId } = await userWithCheckout('verify@paytest.com');
    const paymentId = 'pay_verify_mock_123';

    const verifyRes = await request(app)
      .post('/api/v1/subscription/verify-payment')
      .set('Authorization', auth)
      .send({
        razorpayPaymentId: paymentId,
        razorpaySubscriptionId: rzpSubId,
        razorpaySignature: checkoutSignature(paymentId, rzpSubId),
      });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.subscription.status).toBe('ACTIVE');
    expect(verifyRes.body.data.subscription.isTrial).toBe(false);
    expect(verifyRes.body.data.hasActiveEntitlement).toBe(true);
    expect(verifyRes.body.data.subscription.currentPeriodEnd).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const creditBalance = await rtdb.balance(uid);
    expect(creditBalance.allocatedCredits).toBe(100);
    expect(creditBalance.subscriptionId).toBe((await rtdb.subscription(uid)).subscriptionId);
    expect((await rtdb.ledger(uid)).some(entry => entry.type === 'SUBSCRIPTION_RENEWAL')).toBe(true);
  });

  it('7. Duplicate payment verification is idempotent', async () => {
    const { auth, rzpSubId } = await userWithCheckout('dupverify@paytest.com', 'starter');
    const paymentId = 'pay_dup_verify_123';
    const payload = {
      razorpayPaymentId: paymentId,
      razorpaySubscriptionId: rzpSubId,
      razorpaySignature: checkoutSignature(paymentId, rzpSubId),
    };

    const res1 = await request(app)
      .post('/api/v1/subscription/verify-payment')
      .set('Authorization', auth)
      .send(payload);
    expect(res1.status).toBe(200);
    expect(res1.body.data.isIdempotentRetry).toBe(false);

    const res2 = await request(app)
      .post('/api/v1/subscription/verify-payment')
      .set('Authorization', auth)
      .send(payload);
    expect(res2.status).toBe(200);
    expect(res2.body.data.isIdempotentRetry).toBe(true);
  });

  it('8. Cross-user payment verification attempt is rejected with 403 FORBIDDEN (H2 Fix)', async () => {
    const userA = await userWithCheckout('usera@paytest.com');
    const userB = await registerViaApi(app, { email: 'userb@paytest.com' });

    const attackRes = await request(app)
      .post('/api/v1/subscription/verify-payment')
      .set('Authorization', userB.auth)
      .send({
        razorpayPaymentId: 'pay_attack_123',
        razorpaySubscriptionId: userA.rzpSubId,
        razorpaySignature: checkoutSignature('pay_attack_123', userA.rzpSubId),
      });

    expect(attackRes.status).toBe(403);
    expect(attackRes.body.error.code).toBe('FORBIDDEN');
    expect((await rtdb.subscription(userB.uid)).status).toBe('TRIALING');
  });

  it('9. PAST_DUE subscription past 72h is expired and entitlement is revoked (C1 Fix)', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'pastdue72h@paytest.com' });

    const past73Hours = Date.now() - 73 * 3600 * 1000;
    const pastStart = past73Hours - 5 * 24 * 3600 * 1000;
    await rtdb.patchSubscription(uid, {
      status: 'PAST_DUE',
      isTrial: false,
      pastDueStartedAt: past73Hours,
      trialStartDate: pastStart,
      trialEndDate: past73Hours,
      currentPeriodStart: pastStart,
      currentPeriodEnd: past73Hours,
    });

    const accessRes = await request(app).get('/api/v1/test-entitled-feature').set('Authorization', auth);
    expect(accessRes.status).toBe(403);
    expect(accessRes.body.error.code).toBe('SUBSCRIPTION_EXPIRED');
    expect((await rtdb.subscription(uid)).status).toBe('EXPIRED');
  });

  it('10. PAST_DUE subscription within 72h retains active entitlement (C1 Fix)', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'pastdue2h@paytest.com' });
    await rtdb.patchSubscription(uid, { status: 'PAST_DUE', pastDueStartedAt: Date.now() - 2 * 3600 * 1000 });

    const accessRes = await request(app).get('/api/v1/test-entitled-feature').set('Authorization', auth);
    expect(accessRes.status).toBe(200);
  });

  it('11. ACTIVE subscription with cancelAtPeriodEnd=true expires after period end (C1 Fix)', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'canceledended@paytest.com' });

    const past1Hour = Date.now() - 3600 * 1000;
    const pastStart = past1Hour - 5 * 24 * 3600 * 1000;
    await rtdb.patchSubscription(uid, {
      status: 'ACTIVE',
      isTrial: false,
      cancelAtPeriodEnd: true,
      currentPeriodStart: pastStart,
      currentPeriodEnd: past1Hour,
      trialStartDate: pastStart,
      trialEndDate: past1Hour,
    });

    const accessRes = await request(app).get('/api/v1/test-entitled-feature').set('Authorization', auth);
    expect(accessRes.status).toBe(403);
    expect(accessRes.body.error.code).toBe('SUBSCRIPTION_EXPIRED');
    expect((await rtdb.subscription(uid)).status).toBe('EXPIRED');
  });

  it('12. Stuck PROCESSING webhook event (> 2 mins) is reclaimed and reprocessed safely (H3 Fix)', async () => {
    const eventId = 'evt_stuck_001';
    const stuckTime = Date.now() - 150000; // 2.5 minutes ago
    await testDb.ref(paths.webhook(eventId)).set({
      eventId,
      eventType: 'subscription.charged',
      status: 'PROCESSING',
      payloadJson: '{"mock":true}',
      createdAt: stuckTime,
      updatedAt: stuckTime,
    });

    const res = await postWebhook({
      event_id: eventId,
      event: 'subscription.charged',
      payload: { subscription: { entity: { id: 'sub_stuck_test' } } },
    });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Webhook processed successfully');
    expect((await rtdb.webhook(eventId)).status).toBe('PROCESSED');
  });

  it('13. A PROCESSING event younger than 2 minutes is treated as in-flight, and PROCESSED events as duplicates', async () => {
    await testDb.ref(paths.webhook('evt_inflight')).set({
      eventId: 'evt_inflight',
      eventType: 'subscription.charged',
      status: 'PROCESSING',
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 1000,
    });
    const inFlight = await postWebhook({ event_id: 'evt_inflight', event: 'subscription.charged', payload: {} });
    expect(inFlight.status).toBe(200);
    expect(inFlight.body.message).toBe('Event currently processing');

    const first = await postWebhook({ event_id: 'evt_once', event: 'payment.failed', payload: {} });
    const second = await postWebhook({ event_id: 'evt_once', event: 'payment.failed', payload: {} });
    expect(first.body.message).toBe('Webhook processed successfully');
    expect(second.body.message).toBe('Event already processed');
  });

  it('14. subscription.activated without a payment entity activates the linked subscription (no undefined write)', async () => {
    const { uid, rzpSubId } = await userWithCheckout('webhookactivate@paytest.com');
    await testDb
      .ref(paths.careerBrain(uid))
      .set({
        uid,
        fullName: 'W',
        email: 'w@x.y',
        currentTitle: 't',
        resumeText: 'r',
        tier: 'free',
        dailyQuota: { appliedToday: 0, dailyLimit: 15, lastResetDate: '2026-01-01' },
        createdAt: 1,
        updatedAt: 1,
      });

    const res = await postWebhook({
      event_id: 'evt_activate_1',
      event: 'subscription.activated',
      created_at: Math.floor(Date.now() / 1000),
      payload: { subscription: { entity: { id: rzpSubId } } },
    });
    expect(res.status).toBe(200);

    const sub = await rtdb.subscription(uid);
    expect(sub.status).toBe('ACTIVE');
    expect(sub.isTrial).toBe(false);
    expect((await rtdb.careerBrain(uid)).tier).toBe('premium');
    expect((await rtdb.webhook('evt_activate_1')).providerPaymentId).toBeUndefined();
  });

  it('15. subscription.charged renews the period and resets credits in one atomic update; stale events are ignored', async () => {
    const { uid, auth, rzpSubId } = await userWithCheckout('webhookcharged@paytest.com');
    await request(app)
      .post('/api/v1/subscription/verify-payment')
      .set('Authorization', auth)
      .send({
        razorpayPaymentId: 'pay_1',
        razorpaySubscriptionId: rzpSubId,
        razorpaySignature: checkoutSignature('pay_1', rzpSubId),
      });
    await rtdb.patchBalance(uid, { remainingCredits: 3, usedCredits: 97 });

    const before = await rtdb.subscription(uid);
    const res = await postWebhook({
      event_id: 'evt_charged_1',
      event: 'subscription.charged',
      created_at: Math.floor(Date.now() / 1000) + 5,
      payload: {
        subscription: { entity: { id: rzpSubId } },
        payment: { entity: { id: 'pay_renew_1', amount: 149900, currency: 'INR' } },
      },
    });
    expect(res.status).toBe(200);

    const after = await rtdb.subscription(uid);
    expect(after.currentPeriodStart).toBeGreaterThanOrEqual(before.currentPeriodStart);
    expect((await rtdb.balance(uid)).remainingCredits).toBe(after.creditsSnapshot);
    expect((await rtdb.ledger(uid)).some(entry => entry.description === 'Renewal credit top-up (pay_renew_1)')).toBe(
      true,
    );

    // An older event (created before the last processed one) must not change anything
    const stale = await postWebhook({
      event_id: 'evt_halted_old',
      event: 'subscription.halted',
      created_at: Math.floor(Date.now() / 1000) - 3600,
      payload: { subscription: { entity: { id: rzpSubId } } },
    });
    expect(stale.body.message).toBe('Stale event ignored');
    expect((await rtdb.subscription(uid)).status).toBe('ACTIVE');
  });

  it('16. subscription.halted marks PAST_DUE; subscription.cancelled schedules cancellation', async () => {
    const { uid, rzpSubId } = await userWithCheckout('webhookhalted@paytest.com');
    const now = Math.floor(Date.now() / 1000);

    await postWebhook({
      event_id: 'evt_h1',
      event: 'subscription.halted',
      created_at: now,
      payload: { subscription: { entity: { id: rzpSubId } } },
    });
    const halted = await rtdb.subscription(uid);
    expect(halted.status).toBe('PAST_DUE');
    expect(typeof halted.pastDueStartedAt).toBe('number');

    await postWebhook({
      event_id: 'evt_c1',
      event: 'subscription.cancelled',
      created_at: now + 1,
      payload: { subscription: { entity: { id: rzpSubId } } },
    });
    expect((await rtdb.subscription(uid)).cancelAtPeriodEnd).toBe(true);
  });

  it('17. payment.captured upgrades the Career Brain of the user in the payment notes', async () => {
    const { uid } = await registerViaApi(app, { email: 'captured@paytest.com' });
    await ProfileService.syncProfile(uid, {
      fullName: 'Cap',
      email: 'captured@paytest.com',
      currentTitle: 'Dev',
      resumeText: 'text',
    });

    const res = await postWebhook({
      event_id: 'evt_captured_1',
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_cap_1', notes: { userId: uid } } } },
    });
    expect(res.status).toBe(200);
    expect((await rtdb.careerBrain(uid)).tier).toBe('premium');
  });

  it('18. User cancellation sets cancelAtPeriodEnd; without an active subscription it returns 404', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'cancelapi@paytest.com' });

    const res = await request(app).post('/api/v1/subscription/cancel').set('Authorization', auth).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.cancelAtPeriodEnd).toBe(true);
    expect((await rtdb.subscription(uid)).cancelAtPeriodEnd).toBe(true);

    await rtdb.patchSubscription(uid, { status: 'EXPIRED' });
    const again = await request(app).post('/api/v1/subscription/cancel').set('Authorization', auth).send({});
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('SUBSCRIPTION_NOT_FOUND');
  });

  it('20. Manual plan activation (scripts/activate_pro_user.ts) activates the plan, credits and premium tier', async () => {
    const { uid } = await registerViaApi(app, { email: 'manual@paytest.com' });
    await ProfileService.syncProfile(uid, {
      fullName: 'M',
      email: 'manual@paytest.com',
      currentTitle: 'Dev',
      resumeText: 'r',
    });
    const trialId = (await rtdb.subscription(uid)).subscriptionId;

    const sub = await SubscriptionLifecycleService.activatePlanManually(uid, 'pro', 30);

    expect(sub).toMatchObject({ _id: trialId, status: 'ACTIVE', planCodeSnapshot: 'pro', isTrial: false });
    expect((await rtdb.balance(uid)).remainingCredits).toBe(5000);
    expect((await rtdb.careerBrain(uid)).tier).toBe('premium');
    await expect(SubscriptionLifecycleService.activatePlanManually(uid, 'gold', 30)).rejects.toMatchObject({
      code: 'PLAN_NOT_FOUND',
    });
  });

  it('19. GET /subscription/plans lists active plans with the Mongo-era shape', async () => {
    const res = await request(app).get('/api/v1/subscription/plans');
    expect(res.status).toBe(200);
    expect(res.body.data.plans.map((p: any) => p.code)).toEqual(['free-trial', 'starter', 'pro', 'power']);
    expect(res.body.data.plans[2]).toMatchObject({ _id: 'pro', amount: 149900, currency: 'INR', isActive: true });
  });
});
