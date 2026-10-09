import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { ProfileService } from '../services/profile.service.js';
import { paths } from '../services/rtdb/client.js';
import { testDb, resetFirebase } from './helpers/firebaseTestEnv.js';
import { registerViaApi, rtdb } from './helpers/testApi.js';

const app = createApp();

/** Shape of the extension's default Career Brain profile (packages/storage/lib/profile/careerBrain.ts). */
function extensionProfile(overrides: Record<string, unknown> = {}) {
  return {
    fullName: 'Asha Rao',
    email: 'Asha.Rao@Example.com ',
    phoneNumber: '+91 90000 00000',
    currentTitle: 'Full Stack Developer',
    resumeText: 'Full stack developer with React.js and Node.js experience.',
    skills: ['React.js', 'Node.js', 'Express.js', 'MongoDB'],
    yearsOfExperience: 2,
    skillExperience: { 'React.js': 1, 'Node.js': 2, 'Express.js': 1, 'C#': 1, 'CI/CD': 1, '.NET': 1, MongoDB: 1 },
    customAnswers: {
      'Are you willing to relocate to Pune/Bengaluru?': 'Yes',
      'Expected CTC (in LPA, e.g. 6.5)': '8',
      'What is $2 + $2? [test]': '4',
    },
    goldenAnswers: [{ id: 'g1', question: 'Notice period?', answer: '30 days', category: 'Availability' }],
    preferredLocations: ['Pune', 'Remote'],
    noticePeriod: '30 days',
    // fields the client may send but must never control
    tier: 'premium',
    dailyQuota: { appliedToday: 0, dailyLimit: 9999, lastResetDate: '2000-01-01' },
    undefinedField: undefined,
    ...overrides,
  };
}

describe('Career Brain profile & daily quota (Firebase RTDB)', () => {
  beforeEach(async () => {
    await resetFirebase();
    await PlanSeedService.seedDefaultPlans();
  });

  it('1. PUT /profile accepts skill names and questions that are illegal RTDB keys and round-trips them', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'keys@profiletest.com' });

    const put = await request(app).put('/api/v1/profile').set('Authorization', auth).send(extensionProfile());
    expect(put.status).toBe(200);
    expect(put.body.data.skillExperience).toEqual({
      'React.js': 1,
      'Node.js': 2,
      'Express.js': 1,
      'C#': 1,
      'CI/CD': 1,
      '.NET': 1,
      MongoDB: 1,
    });
    expect(put.body.data.customAnswers['Are you willing to relocate to Pune/Bengaluru?']).toBe('Yes');
    expect(put.body.data.customAnswers['What is $2 + $2? [test]']).toBe('4');

    const get = await request(app).get('/api/v1/profile').set('Authorization', auth);
    expect(get.status).toBe(200);
    expect(get.body.data.skillExperience['Node.js']).toBe(2);
    expect(get.body.data.email).toBe('asha.rao@example.com'); // trimmed + lowercased like the Mongoose schema
    expect(get.body.data.userId).toBe(uid);
    expect(get.body.data.goldenAnswers[0]).toMatchObject({ id: 'g1', category: 'Availability', isDefault: false });

    // Stored form: entry lists, never user text as keys
    const stored = await rtdb.careerBrain(uid);
    expect(stored.skillExperienceList).toEqual(expect.arrayContaining([{ skill: 'Node.js', years: 2 }]));
    expect(stored.skillExperience).toBeUndefined();
  });

  it('2. The client can never set tier or dailyQuota', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'protected@profiletest.com' });
    await request(app).put('/api/v1/profile').set('Authorization', auth).send(extensionProfile());

    const stored = await rtdb.careerBrain(uid);
    expect(stored.tier).toBe('free');
    expect(stored.dailyQuota.dailyLimit).toBe(15);

    await request(app)
      .put('/api/v1/profile')
      .set('Authorization', auth)
      .send(extensionProfile({ fullName: 'Asha R.' }));
    const updated = await rtdb.careerBrain(uid);
    expect(updated.fullName).toBe('Asha R.');
    expect(updated.tier).toBe('free');
    expect(updated.dailyQuota.dailyLimit).toBe(15);
  });

  it('3. Creating a profile without the required fields fails with 400 (Mongoose "required" parity)', async () => {
    const { auth } = await registerViaApi(app, { email: 'required@profiletest.com' });
    const res = await request(app)
      .put('/api/v1/profile')
      .set('Authorization', auth)
      .send({ skills: ['Go'] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('4. GET /profile returns null for a user without a profile; profiles are isolated per user', async () => {
    const a = await registerViaApi(app, { email: 'a@profiletest.com' });
    const b = await registerViaApi(app, { email: 'b@profiletest.com' });
    await request(app).put('/api/v1/profile').set('Authorization', a.auth).send(extensionProfile());

    const resB = await request(app).get('/api/v1/profile').set('Authorization', b.auth);
    expect(resB.status).toBe(200);
    expect(resB.body.data).toBeNull();
  });

  it('5. Quota: concurrent check-and-increment never exceeds the daily limit', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'quota@profiletest.com' });

    const responses = await Promise.all(
      Array.from({ length: 20 }).map(() =>
        request(app).post('/api/v1/profile/quota/check-and-increment').set('Authorization', auth),
      ),
    );
    const allowed = responses.filter(res => res.status === 200);
    const rejected = responses.filter(res => res.status === 429);
    expect(allowed).toHaveLength(15);
    expect(rejected).toHaveLength(5);
    expect(rejected[0].body.error.code).toBe('QUOTA_EXCEEDED');

    const stored = await rtdb.careerBrain(uid);
    expect(stored.dailyQuota.appliedToday).toBe(15);
    // The first increment auto-created the placeholder profile, as the Mongo version did
    expect(stored.fullName).toBe('Candidate');

    const quota = await request(app).get('/api/v1/profile/quota').set('Authorization', auth);
    expect(quota.body.data).toMatchObject({
      allowed: false,
      appliedToday: 15,
      dailyLimit: 15,
      remaining: 0,
      tier: 'free',
    });
  });

  it('6. Quota resets on a new day and follows the paid plan limit (and a profile sync never clobbers it)', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'quotaplan@profiletest.com' });
    await request(app).put('/api/v1/profile').set('Authorization', auth).send(extensionProfile());
    await rtdb.patchSubscription(uid, { status: 'ACTIVE', planCodeSnapshot: 'pro', isTrial: false });
    await testDb
      .ref(paths.careerBrainField(uid, 'dailyQuota'))
      .set({ appliedToday: 15, dailyLimit: 15, lastResetDate: '2000-01-01' });

    const res = await request(app).post('/api/v1/profile/quota/check-and-increment').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ allowed: true, appliedToday: 1, dailyLimit: 100, tier: 'premium' });

    // A concurrent profile sync must not overwrite the quota
    await Promise.all([
      request(app)
        .put('/api/v1/profile')
        .set('Authorization', auth)
        .send(extensionProfile({ currentTitle: 'Lead' })),
      request(app).post('/api/v1/profile/quota/check-and-increment').set('Authorization', auth),
    ]);
    const stored = await rtdb.careerBrain(uid);
    expect(stored.dailyQuota.appliedToday).toBe(2);
    expect(stored.currentTitle).toBe('Lead');
    expect(stored.tier).toBe('premium');
  });

  it('7. upgradeToPremium sets tier and the plan limit; it is a no-op without a profile', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'premium@profiletest.com' });
    expect(await ProfileService.upgradeToPremium(uid, 100)).toBeNull();
    expect(await rtdb.careerBrain(uid)).toBeNull();

    await request(app).put('/api/v1/profile').set('Authorization', auth).send(extensionProfile());
    const upgraded = await ProfileService.upgradeToPremium(uid, 100);
    expect(upgraded?.tier).toBe('premium');
    expect(upgraded?.dailyQuota.dailyLimit).toBe(100);
  });
});
