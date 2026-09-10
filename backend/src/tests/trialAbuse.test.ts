import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../app.js';
import { User } from '../models/user.model.js';
import { Subscription } from '../models/subscription.model.js';
import { PlanSeedService } from '../services/planSeed.service.js';

const app = createApp();

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
  await PlanSeedService.seedDefaultPlans();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Trial Abuse Prevention & Expiration Integrity Tests', () => {
  beforeEach(async () => {
    await User.deleteMany({});
    await Subscription.deleteMany({});
  });

  it('1. Registration automatically sets hasUsedTrial = true on User model', async () => {
    const registerRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Trial User',
      email: 'trialuser@example.com',
      password: 'Password123!',
    });

    expect(registerRes.status).toBe(201);
    expect(registerRes.body.success).toBe(true);

    const userInDb = await User.findOne({ email: 'trialuser@example.com' });
    expect(userInDb).toBeDefined();
    expect(userInDb?.hasUsedTrial).toBe(true);
    expect(userInDb?.trialUsedAt).toBeInstanceOf(Date);
  });

  it('2. Expired trial user calling GET /subscription/me returns status EXPIRED and DOES NOT auto-create a new trial', async () => {
    // Step 1: Register user (creates initial 5-day trial)
    const registerRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Expired Trial User',
      email: 'expiredtrial@example.com',
      password: 'Password123!',
    });
    const token = registerRes.body.data.token;
    const userId = registerRes.body.data.user._id;

    // Verify initial state
    const initialSubCount = await Subscription.countDocuments({ userId });
    expect(initialSubCount).toBe(1);

    // Step 2: Manually expire the trial subscription (simulate 5-day trial period passing)
    await Subscription.updateMany({ userId }, { $set: { status: 'EXPIRED', endedAt: new Date() } });

    // Step 3: Call GET /api/v1/subscription/me
    const meRes = await request(app).get('/api/v1/subscription/me').set('Authorization', `Bearer ${token}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.success).toBe(true);
    expect(meRes.body.data.status).toBe('EXPIRED');
    expect(meRes.body.data.hasActiveEntitlement).toBe(false);

    // Step 4: CRITICAL VERIFICATION — Ensure NO new trial subscription document was created!
    const finalSubCount = await Subscription.countDocuments({ userId });
    expect(finalSubCount).toBe(1);

    const currentSub = await Subscription.findOne({ userId });
    expect(currentSub?.status).toBe('EXPIRED');
  });

  it('3. User with hasUsedTrial = true is rejected when attempting to activate a trial', async () => {
    const registerRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Reactivate Attempt User',
      email: 'reactivate@example.com',
      password: 'Password123!',
    });
    const token = registerRes.body.data.token;

    // Attempt to manually trigger POST /api/v1/subscription/trial/activate
    const activateRes = await request(app)
      .post('/api/v1/subscription/trial/activate')
      .set('Authorization', `Bearer ${token}`);

    expect(activateRes.status).toBe(409);
    expect(activateRes.body.success).toBe(false);
    expect(activateRes.body.code).toBe('TRIAL_ALREADY_EXISTS');
  });

  it('4. Even if subscription documents are deleted, hasUsedTrial = true prevents new trial creation via /subscription/me', async () => {
    const registerRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Deleted Sub User',
      email: 'deletedsub@example.com',
      password: 'Password123!',
    });
    const token = registerRes.body.data.token;
    const userId = registerRes.body.data.user._id;

    // Simulate edge-case where subscription document is missing/deleted
    await Subscription.deleteMany({ userId });

    const meRes = await request(app).get('/api/v1/subscription/me').set('Authorization', `Bearer ${token}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.success).toBe(true);
    expect(meRes.body.data.status).toBe('EXPIRED');
    expect(meRes.body.data.hasActiveEntitlement).toBe(false);
    expect(meRes.body.data.subscription).toBeNull();

    // Verify 0 trial subscriptions were created
    const subCount = await Subscription.countDocuments({ userId });
    expect(subCount).toBe(0);
  });
});
