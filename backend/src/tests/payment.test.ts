import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { v1Router } from '../routes/index.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { checkEntitlement } from '../middleware/entitlement.middleware.js';
import { createApp } from '../app.js';
import { User } from '../models/user.model.js';
import { Subscription } from '../models/subscription.model.js';
import { UserCreditBalance } from '../models/userCreditBalance.model.js';
import { CreditLedger } from '../models/creditLedger.model.js';
import { WebhookLedger } from '../models/webhookLedger.model.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { RazorpayService } from '../services/razorpay.service.js';
import { env } from '../config/env.js';

// Setup protected dummy route on v1Router BEFORE createApp() initializes Express app
v1Router.use('/test-entitled-feature', authenticate, checkEntitlement, (_req, res) => {
  res.status(200).json({ success: true, message: 'Access granted' });
});

const app = createApp();
import { setupTestDatabase, type TestDbInstance } from './setupTestDb.js';

let testDb: TestDbInstance;

describe('Phase 8: Commercial Payment & Subscription Lifecycle Engine Integration Tests', () => {
  beforeAll(async () => {
    testDb = await setupTestDatabase();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.clearCollections();
    await PlanSeedService.seedDefaultPlans();
  });

  it('1. HMAC Checkout Signature Verification passes for valid signatures and rejects tampered ones', () => {
    const paymentId = 'pay_test_12345';
    const subscriptionId = 'sub_test_67890';
    const body = `${paymentId}|${subscriptionId}`;
    const validSignature = crypto.createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(body).digest('hex');

    expect(RazorpayService.verifyCheckoutSignature(paymentId, subscriptionId, validSignature)).toBe(true);
    expect(RazorpayService.verifyCheckoutSignature(paymentId, subscriptionId, 'invalid_sig')).toBe(false);
  });

  it('2. HMAC Webhook Signature Verification passes for valid raw body signatures', () => {
    const rawBodyBuffer = Buffer.from(JSON.stringify({ event: 'subscription.charged', id: 'evt_100' }), 'utf8');
    const validSignature = crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBodyBuffer).digest('hex');

    expect(RazorpayService.verifyWebhookSignature(rawBodyBuffer, validSignature)).toBe(true);
    expect(RazorpayService.verifyWebhookSignature(rawBodyBuffer, 'tampered_signature')).toBe(false);
  });

  it('3. Dedicated raw-body webhook route handles signature check over raw Buffer', async () => {
    const payloadObj = {
      event_id: 'evt_raw_001',
      event: 'subscription.charged',
      payload: {
        subscription: {
          entity: {
            id: 'sub_non_existent',
            payment_id: 'pay_raw_001',
          },
        },
      },
    };

    const rawBodyStr = JSON.stringify(payloadObj);
    const signature = crypto
      .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
      .update(Buffer.from(rawBodyStr, 'utf8'))
      .digest('hex');

    const res = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', signature)
      .send(rawBodyStr);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('4. POST /api/v1/subscription/checkout resolves DB Plan source of truth for paid plans', async () => {
    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Checkout User',
      email: 'checkout@paytest.com',
      password: 'Password123!',
    });

    const token = regRes.body.data.token;

    const res = await request(app)
      .post('/api/v1/subscription/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ planCode: 'pro' });

    expect(res.status).toBe(200);
    expect(res.body.data.planCode).toBe('pro');
    expect(res.body.data.amount).toBe(149900); // ₹1,499 in paise from DB
    expect(res.body.data.currency).toBe('INR');
    expect(res.body.data.subscriptionId).toBeDefined();

    // Rejects free trial plan checkout
    const freeRes = await request(app)
      .post('/api/v1/subscription/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ planCode: 'free-trial' });

    expect(freeRes.status).toBe(400);
    expect(freeRes.body.error.code).toBe('INVALID_PLAN');
  });

  it('5. Checkout session idempotency & concurrency returns existing session on retry', async () => {
    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Checkout Idempotency User',
      email: 'checkoutidem@paytest.com',
      password: 'Password123!',
    });

    const token = regRes.body.data.token;

    const res1 = await request(app)
      .post('/api/v1/subscription/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ planCode: 'starter' });

    expect(res1.status).toBe(200);
    const subId1 = res1.body.data.subscriptionId;

    // Parallel concurrent checkout calls for same user return same subscriptionId
    const promises = Array.from({ length: 3 }).map(() =>
      request(app)
        .post('/api/v1/subscription/checkout')
        .set('Authorization', `Bearer ${token}`)
        .send({ planCode: 'starter' }),
    );

    const responses = await Promise.all(promises);
    responses.forEach(res => {
      expect(res.status).toBe(200);
      expect(res.body.data.subscriptionId).toBe(subId1);
    });
  });

  it('6. Verify payment transitions trial subscription to ACTIVE and allocates paid credits', async () => {
    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Verify User',
      email: 'verify@paytest.com',
      password: 'Password123!',
    });

    const token = regRes.body.data.token;
    const userId = regRes.body.data.user._id || regRes.body.data.user.id;

    // Create checkout session for pro plan
    const checkoutRes = await request(app)
      .post('/api/v1/subscription/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ planCode: 'pro' });

    const subscriptionId = checkoutRes.body.data.subscriptionId;
    const paymentId = 'pay_verify_mock_123';
    const signature = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
      .update(`${paymentId}|${subscriptionId}`)
      .digest('hex');

    // Verify Payment
    const verifyRes = await request(app)
      .post('/api/v1/subscription/verify-payment')
      .set('Authorization', `Bearer ${token}`)
      .send({
        razorpayPaymentId: paymentId,
        razorpaySubscriptionId: subscriptionId,
        razorpaySignature: signature,
      });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.subscription.status).toBe('ACTIVE');
    expect(verifyRes.body.data.subscription.isTrial).toBe(false);
    expect(verifyRes.body.data.hasActiveEntitlement).toBe(true);

    const creditBalance = await UserCreditBalance.findOne({ userId });
    expect(creditBalance?.allocatedCredits).toBe(100);
  });

  it('7. Duplicate payment verification is idempotent', async () => {
    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Dup Verify User',
      email: 'dupverify@paytest.com',
      password: 'Password123!',
    });

    const token = regRes.body.data.token;

    const checkoutRes = await request(app)
      .post('/api/v1/subscription/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ planCode: 'starter' });

    const subscriptionId = checkoutRes.body.data.subscriptionId;
    const paymentId = 'pay_dup_verify_123';
    const signature = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
      .update(`${paymentId}|${subscriptionId}`)
      .digest('hex');

    const payload = {
      razorpayPaymentId: paymentId,
      razorpaySubscriptionId: subscriptionId,
      razorpaySignature: signature,
    };

    const res1 = await request(app)
      .post('/api/v1/subscription/verify-payment')
      .set('Authorization', `Bearer ${token}`)
      .send(payload);

    expect(res1.status).toBe(200);
    expect(res1.body.data.isIdempotentRetry).toBe(false);

    const res2 = await request(app)
      .post('/api/v1/subscription/verify-payment')
      .set('Authorization', `Bearer ${token}`)
      .send(payload);

    expect(res2.status).toBe(200);
    expect(res2.body.data.isIdempotentRetry).toBe(true);
  });

  it('8. Cross-user payment verification attempt is rejected with 403 FORBIDDEN (H2 Fix)', async () => {
    // Register User A
    const userARes = await request(app).post('/api/v1/auth/register').send({
      name: 'User A',
      email: 'usera@paytest.com',
      password: 'Password123!',
    });
    const tokenA = userARes.body.data.token;

    // User A creates checkout
    const checkoutA = await request(app)
      .post('/api/v1/subscription/checkout')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ planCode: 'pro' });

    const subIdA = checkoutA.body.data.subscriptionId;

    // Register User B
    const userBRes = await request(app).post('/api/v1/auth/register').send({
      name: 'User B',
      email: 'userb@paytest.com',
      password: 'Password123!',
    });
    const tokenB = userBRes.body.data.token;

    // User B attempts to verify User A's subscriptionId
    const signature = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
      .update(`pay_attack_123|${subIdA}`)
      .digest('hex');

    const attackRes = await request(app)
      .post('/api/v1/subscription/verify-payment')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        razorpayPaymentId: 'pay_attack_123',
        razorpaySubscriptionId: subIdA,
        razorpaySignature: signature,
      });

    expect(attackRes.status).toBe(403);
    expect(attackRes.body.error.code).toBe('FORBIDDEN');
  });

  it('9. PAST_DUE subscription past 72h is expired and entitlement is revoked (C1 Fix)', async () => {
    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'PastDue 72h User',
      email: 'pastdue72h@paytest.com',
      password: 'Password123!',
    });

    const token = regRes.body.data.token;
    const userId = regRes.body.data.user._id || regRes.body.data.user.id;

    // Set status to PAST_DUE with pastDueStartedAt 73 hours in the past
    const past73Hours = new Date(Date.now() - 73 * 3600 * 1000);
    const pastStart = new Date(past73Hours.getTime() - 5 * 24 * 3600 * 1000);
    await Subscription.updateOne(
      { userId },
      {
        $set: {
          status: 'PAST_DUE',
          isTrial: false,
          pastDueStartedAt: past73Hours,
          trialStartDate: pastStart,
          trialEndDate: past73Hours,
          currentPeriodStart: pastStart,
          currentPeriodEnd: past73Hours,
        },
      },
    );

    // Access protected route -> 403 SUBSCRIPTION_EXPIRED
    const accessRes = await request(app).get('/api/v1/test-entitled-feature').set('Authorization', `Bearer ${token}`);

    expect(accessRes.status).toBe(403);
    expect(accessRes.body.error.code).toBe('SUBSCRIPTION_EXPIRED');

    // DB status updated to EXPIRED
    const sub = await Subscription.findOne({ userId });
    expect(sub?.status).toBe('EXPIRED');
  });

  it('10. PAST_DUE subscription within 72h retains active entitlement (C1 Fix)', async () => {
    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'PastDue Within 72h User',
      email: 'pastdue2h@paytest.com',
      password: 'Password123!',
    });

    const token = regRes.body.data.token;
    const userId = regRes.body.data.user._id || regRes.body.data.user.id;

    // Set status to PAST_DUE with pastDueStartedAt 2 hours in the past
    const past2Hours = new Date(Date.now() - 2 * 3600 * 1000);
    await Subscription.updateOne({ userId }, { $set: { status: 'PAST_DUE', pastDueStartedAt: past2Hours } });

    // Access protected route -> 200 OK
    const accessRes = await request(app).get('/api/v1/test-entitled-feature').set('Authorization', `Bearer ${token}`);

    expect(accessRes.status).toBe(200);
  });

  it('11. ACTIVE subscription with cancelAtPeriodEnd=true expires after period end (C1 Fix)', async () => {
    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Cancelled Ended User',
      email: 'canceledended@paytest.com',
      password: 'Password123!',
    });

    const token = regRes.body.data.token;
    const userId = regRes.body.data.user._id || regRes.body.data.user.id;

    // Set status to ACTIVE, cancelAtPeriodEnd = true, currentPeriodEnd in the past
    const past1Hour = new Date(Date.now() - 3600 * 1000);
    const pastStart = new Date(past1Hour.getTime() - 5 * 24 * 3600 * 1000);
    await Subscription.updateOne(
      { userId },
      {
        $set: {
          status: 'ACTIVE',
          isTrial: false,
          cancelAtPeriodEnd: true,
          currentPeriodStart: pastStart,
          currentPeriodEnd: past1Hour,
          trialStartDate: pastStart,
          trialEndDate: past1Hour,
        },
      },
    );

    // Access protected route -> 403 SUBSCRIPTION_EXPIRED
    const accessRes = await request(app).get('/api/v1/test-entitled-feature').set('Authorization', `Bearer ${token}`);

    expect(accessRes.status).toBe(403);
    expect(accessRes.body.error.code).toBe('SUBSCRIPTION_EXPIRED');

    const sub = await Subscription.findOne({ userId });
    expect(sub?.status).toBe('EXPIRED');
  });

  it('12. Stuck PROCESSING webhook event (> 2 mins) is reclaimed and reprocessed safely (H3 Fix)', async () => {
    const eventId = 'evt_stuck_001';
    const stuckTime = new Date(Date.now() - 150000); // 2.5 minutes ago

    // Seed stuck PROCESSING entry
    await WebhookLedger.create({
      eventId,
      eventType: 'subscription.charged',
      status: 'PROCESSING',
      payload: { mock: true },
      createdAt: stuckTime,
    });

    const payloadObj = {
      event_id: eventId,
      event: 'subscription.charged',
      payload: { subscription: { entity: { id: 'sub_stuck_test' } } },
    };

    const rawBodyStr = JSON.stringify(payloadObj);
    const signature = crypto
      .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
      .update(Buffer.from(rawBodyStr, 'utf8'))
      .digest('hex');

    const res = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', signature)
      .send(rawBodyStr);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Webhook processed successfully');

    const ledger = await WebhookLedger.findOne({ eventId });
    expect(ledger?.status).toBe('PROCESSED');
  });
});
