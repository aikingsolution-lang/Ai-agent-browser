import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { isLiveRtdb, memoryDb, resetFirebase } from './helpers/firebaseTestEnv.js';
import { registerViaApi, rtdb } from './helpers/testApi.js';

const app = createApp();

const premiumPayment = { Status: 'Premium', SubscriptionType: 'Premium', End_Date: '2099-01-01 00:00:00' };
const chat = (auth: string) =>
  request(app)
    .post('/api/v1/llm/chat')
    .set('Authorization', auth)
    .send({ model: 'anthropic.claude-3-haiku-20240307-v1:0', messages: [{ role: 'user', content: 'Hello' }] });

/** A user whose free trial is over and whose credits are used up. */
async function lapsedUser(email: string) {
  const user = await registerViaApi(app, { email });
  await rtdb.patchSubscription(user.uid, { status: 'EXPIRED', endedAt: Date.now() - 1000 });
  await rtdb.patchBalance(user.uid, { remainingCredits: 0 });
  return user;
}

// Writes simulated JobForm Automator payment records at user/{uid}/Payment (outside the namespace),
// so it only runs against the in-memory database.
describe.skipIf(isLiveRtdb)('Verified JobForm Automator Premium includes AI Auto Apply', () => {
  beforeEach(async () => {
    await resetFirebase();
    await PlanSeedService.seedDefaultPlans();
  });

  it('without Premium, an expired trial blocks AI access', async () => {
    const { auth } = await lapsedUser('lapsed@premium.test');
    const res = await request(app).get('/api/v1/test-entitled-feature').set('Authorization', auth);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SUBSCRIPTION_EXPIRED');
  });

  it('verified Premium keeps AI access after the trial and credits are gone, without drawing credits', async () => {
    const { uid, auth } = await lapsedUser('premium@premium.test');
    await memoryDb.ref(`user/${uid}/Payment`).set(premiumPayment);

    expect((await request(app).get('/api/v1/test-entitled-feature').set('Authorization', auth)).status).toBe(200);

    const res = await chat(auth);
    expect(res.status).toBe(200);
    expect(await rtdb.balance(uid)).toMatchObject({ remainingCredits: 0 });

    // Usage is still accounted for internally
    const usage = await rtdb.llmUsage(uid);
    const success = usage.find(u => u.status === 'SUCCESS');
    expect(success).toMatchObject({ creditsDeducted: 0 });
    expect(success.metadata).toMatchObject({ coveredBy: 'jobform-premium' });
    expect(success.metadata.creditsEquivalent).toBeGreaterThan(0);

    const balance = await request(app).get('/api/v1/credits/balance').set('Authorization', auth);
    expect(balance.body.data).toMatchObject({ premiumCovered: true, isLowBalance: false });
  });

  it('Diamond counts as Premium; an expired Premium does not', async () => {
    const { uid, auth } = await lapsedUser('diamond@premium.test');
    await memoryDb.ref(`user/${uid}/Payment`).set({ ...premiumPayment, SubscriptionType: 'Diamond' });
    expect((await chat(auth)).status).toBe(200);

    await memoryDb.ref(`user/${uid}/Payment`).set({ ...premiumPayment, End_Date: '2001-01-01 00:00:00' });
    expect((await chat(auth)).status).toBe(403);
    const balance = await request(app).get('/api/v1/credits/balance').set('Authorization', auth);
    expect(balance.body.data.premiumCovered).toBe(false);
  });

  it('a user with credits and Premium is not charged credits', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'both@premium.test' });
    await memoryDb.ref(`user/${uid}/Payment`).set(premiumPayment);
    const before = (await rtdb.balance(uid)).remainingCredits;
    expect((await chat(auth)).status).toBe(200);
    expect((await rtdb.balance(uid)).remainingCredits).toBe(before);
  });

  it('Premium and AI access never transfer to another account', async () => {
    const paid = await lapsedUser('paid@premium.test');
    const other = await lapsedUser('other@premium.test');
    await memoryDb.ref(`user/${paid.uid}/Payment`).set(premiumPayment);
    expect((await chat(paid.auth)).status).toBe(200);
    expect((await chat(other.auth)).status).toBe(403);
  });
});
