import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { paths } from '../services/rtdb/client.js';
import { testDb, resetFirebase } from './helpers/firebaseTestEnv.js';
import { patchPath, registerViaApi, rtdb } from './helpers/testApi.js';

const app = createApp();

describe('Trial Abuse Prevention & Expiration Integrity Tests (Firebase RTDB)', () => {
  beforeEach(async () => {
    await resetFirebase();
    await PlanSeedService.seedDefaultPlans();
  });

  it('1. Registration permanently records that the trial was used (trial_flags/{uid})', async () => {
    const { uid } = await registerViaApi(app, { name: 'Trial User', email: 'trialuser@example.com' });

    const flag = await rtdb.trialFlag(uid);
    expect(flag).toBeDefined();
    expect(flag.hasUsedTrial).toBe(true);
    expect(typeof flag.trialUsedAt).toBe('number');
  });

  it('2. Expired trial user calling GET /subscription/me returns status EXPIRED and DOES NOT auto-create a new trial', async () => {
    const { uid, auth } = await registerViaApi(app, { name: 'Expired Trial User', email: 'expiredtrial@example.com' });
    const originalSubscriptionId = (await rtdb.subscription(uid)).subscriptionId;

    const pastDate = Date.now() - 6 * 24 * 3600 * 1000;
    await rtdb.patchSubscription(uid, { status: 'EXPIRED', trialEndDate: pastDate, endedAt: pastDate });
    await patchPath(paths.trialFlag(uid), { trialUsedAt: pastDate });

    const meRes = await request(app).get('/api/v1/subscription/me').set('Authorization', auth);

    expect(meRes.status).toBe(200);
    expect(meRes.body.success).toBe(true);
    expect(meRes.body.data.status).toBe('EXPIRED');
    expect(meRes.body.data.hasActiveEntitlement).toBe(false);

    // CRITICAL: no new trial was created
    const currentSub = await rtdb.subscription(uid);
    expect(currentSub.subscriptionId).toBe(originalSubscriptionId);
    expect(currentSub.status).toBe('EXPIRED');
    expect((await rtdb.ledger(uid)).filter(entry => entry.type === 'TRIAL_ALLOCATION')).toHaveLength(1);
  });

  it('3. User who used the trial is rejected when attempting to activate a trial', async () => {
    const { auth } = await registerViaApi(app, { name: 'Reactivate Attempt User', email: 'reactivate@example.com' });

    const activateRes = await request(app).post('/api/v1/subscription/trial/activate').set('Authorization', auth);

    expect(activateRes.status).toBe(409);
    expect(activateRes.body.success).toBe(false);
    expect(activateRes.body.error?.code).toBe('TRIAL_ALREADY_EXISTS');
  });

  it('4. Even if the subscription node is deleted, the trial flag prevents new trial creation via /subscription/me', async () => {
    const { uid, auth } = await registerViaApi(app, { name: 'Deleted Sub User', email: 'deletedsub@example.com' });

    const pastDate = Date.now() - 6 * 24 * 3600 * 1000;
    await patchPath(paths.trialFlag(uid), { trialUsedAt: pastDate });
    await testDb.ref(paths.subscription(uid)).remove();

    const meRes = await request(app).get('/api/v1/subscription/me').set('Authorization', auth);

    expect(meRes.status).toBe(200);
    expect(meRes.body.success).toBe(true);
    expect(meRes.body.data.status).toBe('EXPIRED');
    expect(meRes.body.data.hasActiveEntitlement).toBe(false);
    expect(meRes.body.data.subscription).toBeNull();
    expect(await rtdb.subscription(uid)).toBeNull();
  });
});
