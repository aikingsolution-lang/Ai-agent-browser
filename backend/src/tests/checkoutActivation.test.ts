import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../app.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { paths } from '../services/rtdb/client.js';
import { env } from '../config/env.js';
import { resetFirebase } from './helpers/firebaseTestEnv.js';
import { readPath, registerViaApi, rtdb } from './helpers/testApi.js';

const app = createApp();

function postWebhook(body: object) {
  const raw = JSON.stringify(body);
  const signature = crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(Buffer.from(raw, 'utf8'))
    .digest('hex');
  return request(app)
    .post('/api/v1/webhooks/razorpay')
    .set('Content-Type', 'application/json')
    .set('x-razorpay-signature', signature)
    .send(raw);
}

const checkout = (auth: string, planCode: string) =>
  request(app).post('/api/v1/subscription/checkout').set('Authorization', auth).send({ planCode });

const signed = (paymentId: string, subscriptionId: string) =>
  crypto.createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${paymentId}|${subscriptionId}`).digest('hex');

let eventSeq = 0;
const nowSec = () => Math.floor(Date.now() / 1000);
/** Razorpay subscription event (activated / charged / authenticated / halted / cancelled). */
function subscriptionEvent(event: string, rzpSubId: string, extra: Record<string, unknown> = {}, paymentId?: string) {
  eventSeq++;
  return postWebhook({
    event_id: `evt_${event}_${eventSeq}`,
    event,
    created_at: nowSec() + eventSeq,
    payload: {
      subscription: { entity: { id: rzpSubId, ...extra } },
      ...(paymentId ? { payment: { entity: { id: paymentId } } } : {}),
    },
  });
}

async function paidUser(email: string, planCode: string) {
  const user = await registerViaApi(app, { email });
  const res = await checkout(user.auth, planCode);
  expect(res.status).toBe(200);
  const rzpSubId: string = res.body.data.subscriptionId;
  expect((await subscriptionEvent('subscription.activated', rzpSubId, { paid_count: 1 })).status).toBe(200);
  return { ...user, rzpSubId };
}

describe('Checkout → payment → activation (Starter/Pro/Power)', () => {
  beforeEach(async () => {
    await resetFirebase();
    await PlanSeedService.seedDefaultPlans();
  });

  it('bug 1: after the free trial expired, a purchase is still linked to the user and activates', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'expired@billing.test' });
    await rtdb.patchSubscription(uid, { status: 'EXPIRED', endedAt: Date.now() - 1000 });
    const trialId = (await rtdb.subscription(uid)).subscriptionId;

    const res = await checkout(auth, 'starter');
    expect(res.status).toBe(200);
    const rzpSubId = res.body.data.subscriptionId;
    expect(await readPath(paths.providerSubscription(rzpSubId))).toMatchObject({
      uid,
      planCode: 'starter',
      status: 'PENDING',
    });

    expect((await subscriptionEvent('subscription.activated', rzpSubId, { paid_count: 1 })).status).toBe(200);

    const sub = await rtdb.subscription(uid);
    expect(sub).toMatchObject({
      status: 'ACTIVE',
      isTrial: false,
      planCodeSnapshot: 'starter',
      creditsSnapshot: 1000,
      providerSubscriptionId: rzpSubId,
    });
    expect(await rtdb.balance(uid)).toMatchObject({ allocatedCredits: 1000, remainingCredits: 1000 });
    // The expired trial is kept in history
    expect(await readPath(paths.subscriptionHistoryEntry(uid, trialId))).toMatchObject({ status: 'EXPIRED' });
    expect((await readPath(paths.providerSubscription(rzpSubId))).status).toBe('ACTIVE');

    // AI access works on the purchased plan
    const entitled = await request(app).get('/api/v1/test-entitled-feature').set('Authorization', auth);
    expect(entitled.status).toBe(200);
  });

  it('bug 2: the plan actually purchased becomes active with its own credits (trial → pro via webhook)', async () => {
    const { uid, rzpSubId } = await paidUser('pro@billing.test', 'pro');
    expect(await rtdb.subscription(uid)).toMatchObject({
      status: 'ACTIVE',
      planCodeSnapshot: 'pro',
      planNameSnapshot: expect.any(String),
      creditsSnapshot: 5000,
      amountSnapshot: 149900,
      providerSubscriptionId: rzpSubId,
      providerPaidCount: 1,
    });
    expect((await rtdb.balance(uid)).remainingCredits).toBe(5000);
    expect((await rtdb.ledger(uid)).some(e => e.amount === 5000 && e.type === 'SUBSCRIPTION_RENEWAL')).toBe(true);
  });

  it('a paid user upgrading: the new plan replaces the old one and the old Razorpay subscription is superseded', async () => {
    const { uid, auth, rzpSubId: starterId } = await paidUser('upgrade@billing.test', 'starter');
    const starterRecordId = (await rtdb.subscription(uid)).subscriptionId;

    // Buying the plan you already have is refused
    const same = await checkout(auth, 'starter');
    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe('ALREADY_SUBSCRIBED');

    const up = await checkout(auth, 'power');
    expect(up.status).toBe(200);
    const powerId = up.body.data.subscriptionId;
    expect(powerId).not.toBe(starterId);
    // Nothing changes until the upgrade is paid
    expect((await rtdb.subscription(uid)).planCodeSnapshot).toBe('starter');

    await subscriptionEvent('subscription.charged', powerId, { paid_count: 1 }, 'pay_power_1');
    expect(await rtdb.subscription(uid)).toMatchObject({
      status: 'ACTIVE',
      planCodeSnapshot: 'power',
      creditsSnapshot: 25000,
      providerSubscriptionId: powerId,
    });
    expect((await rtdb.balance(uid)).remainingCredits).toBe(25000);
    expect((await readPath(paths.providerSubscription(starterId))).status).toBe('SUPERSEDED');
    expect(await readPath(paths.subscriptionHistoryEntry(uid, starterRecordId))).toMatchObject({
      planCodeSnapshot: 'starter',
      status: 'CANCELLED',
    });

    // A late charge on the replaced plan never downgrades the user
    await subscriptionEvent('subscription.charged', starterId, { paid_count: 2 }, 'pay_old');
    expect((await rtdb.subscription(uid)).planCodeSnapshot).toBe('power');
  });

  it('repeated checkout for the same unpaid plan returns the same Razorpay subscription', async () => {
    const { auth } = await registerViaApi(app, { email: 'repeat@billing.test' });
    const first = await checkout(auth, 'pro');
    const again = await Promise.all([checkout(auth, 'pro'), checkout(auth, 'pro')]);
    again.forEach(res => expect(res.body.data.subscriptionId).toBe(first.body.data.subscriptionId));
    // A different plan is a different checkout
    expect((await checkout(auth, 'starter')).body.data.subscriptionId).not.toBe(first.body.data.subscriptionId);
  });

  it('duplicate and overlapping payment events apply the purchase once', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'dupes@billing.test' });
    const rzpSubId = (await checkout(auth, 'pro')).body.data.subscriptionId;

    // First payment: Razorpay sends activated and charged (paid_count 1), in any order, possibly concurrently
    await Promise.all([
      subscriptionEvent('subscription.charged', rzpSubId, { paid_count: 1 }, 'pay_first'),
      subscriptionEvent('subscription.activated', rzpSubId, { paid_count: 1 }),
    ]);
    await rtdb.patchBalance(uid, { remainingCredits: 4000, usedCredits: 1000 });

    // The same webhook delivered twice
    const body = {
      event_id: 'evt_same_twice',
      event: 'subscription.charged',
      created_at: nowSec() + 100,
      payload: { subscription: { entity: { id: rzpSubId, paid_count: 1 } }, payment: { entity: { id: 'pay_first' } } },
    };
    expect((await postWebhook(body)).status).toBe(200);
    expect((await postWebhook(body)).body.message).toBe('Event already processed');

    // Credits used after activation were not refilled by any duplicate
    expect((await rtdb.balance(uid)).remainingCredits).toBe(4000);
    const sub = await rtdb.subscription(uid);
    expect(sub).toMatchObject({ planCodeSnapshot: 'pro', status: 'ACTIVE' });
    expect((await rtdb.ledger(uid)).filter(e => e.type === 'SUBSCRIPTION_RENEWAL')).toHaveLength(1);

    // A real renewal (paid_count 2) starts a new period with fresh credits
    await subscriptionEvent('subscription.charged', rzpSubId, { paid_count: 2 }, 'pay_second');
    expect((await rtdb.balance(uid)).remainingCredits).toBe(5000);
  });

  it('pending, failed and cancelled checkouts never change the current plan', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'pending@billing.test' });
    const trialBefore = await rtdb.subscription(uid);
    const balanceBefore = await rtdb.balance(uid);

    const pendingId = (await checkout(auth, 'pro')).body.data.subscriptionId;
    await subscriptionEvent('subscription.authenticated', pendingId);
    expect((await readPath(paths.providerSubscription(pendingId))).status).toBe('AUTHENTICATED');
    expect(await rtdb.subscription(uid)).toMatchObject({ status: trialBefore.status, planCodeSnapshot: 'free-trial' });

    await subscriptionEvent('subscription.halted', pendingId);
    expect((await readPath(paths.providerSubscription(pendingId))).status).toBe('FAILED');
    expect((await rtdb.subscription(uid)).status).toBe(trialBefore.status);
    expect(await rtdb.balance(uid)).toEqual(balanceBefore);

    const cancelledId = (await checkout(auth, 'starter')).body.data.subscriptionId;
    await subscriptionEvent('subscription.cancelled', cancelledId);
    expect((await readPath(paths.providerSubscription(cancelledId))).status).toBe('CANCELLED');
    expect(await readPath(paths.checkoutSession(uid, 'starter'))).toBeNull();
    expect((await rtdb.subscription(uid)).planCodeSnapshot).toBe('free-trial');
    // Starting that plan again creates a fresh checkout
    expect((await checkout(auth, 'starter')).body.data.subscriptionId).not.toBe(cancelledId);
  });

  it('nothing is granted without a verified payment: a forged checkout callback is rejected', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'forged@billing.test' });
    const rzpSubId = (await checkout(auth, 'power')).body.data.subscriptionId;
    const res = await request(app)
      .post('/api/v1/subscription/verify-payment')
      .set('Authorization', auth)
      .send({ razorpayPaymentId: 'pay_fake', razorpaySubscriptionId: rzpSubId, razorpaySignature: 'f'.repeat(64) });
    expect(res.status).toBe(401);
    expect((await rtdb.subscription(uid)).planCodeSnapshot).toBe('free-trial');
  });

  it('a payment always activates the buyer, never another account (account switching)', async () => {
    const buyer = await registerViaApi(app, { email: 'buyer@billing.test' });
    const other = await registerViaApi(app, { email: 'other@billing.test' });
    const rzpSubId = (await checkout(buyer.auth, 'pro')).body.data.subscriptionId;

    // Another signed-in account cannot claim the buyer's payment
    const steal = await request(app)
      .post('/api/v1/subscription/verify-payment')
      .set('Authorization', other.auth)
      .send({
        razorpayPaymentId: 'pay_x',
        razorpaySubscriptionId: rzpSubId,
        razorpaySignature: signed('pay_x', rzpSubId),
      });
    expect(steal.status).toBe(403);

    // The buyer's signed callback activates the buyer only
    const ok = await request(app)
      .post('/api/v1/subscription/verify-payment')
      .set('Authorization', buyer.auth)
      .send({
        razorpayPaymentId: 'pay_x',
        razorpaySubscriptionId: rzpSubId,
        razorpaySignature: signed('pay_x', rzpSubId),
      });
    expect(ok.status).toBe(200);
    expect((await rtdb.subscription(buyer.uid)).planCodeSnapshot).toBe('pro');
    expect((await rtdb.subscription(other.uid)).planCodeSnapshot).toBe('free-trial');
  });

  it('a subscription created before checkouts recorded the plan is resolved from its Razorpay notes', async () => {
    const { uid } = await registerViaApi(app, { email: 'legacy@billing.test' });
    const res = await subscriptionEvent('subscription.activated', 'sub_rzp_legacy_123', {
      paid_count: 1,
      notes: { userId: uid, planCode: 'pro' },
    });
    expect(res.status).toBe(200);
    expect(await rtdb.subscription(uid)).toMatchObject({ planCodeSnapshot: 'pro', status: 'ACTIVE' });
    expect((await readPath(paths.providerSubscription('sub_rzp_legacy_123'))).uid).toBe(uid);
  });
});
