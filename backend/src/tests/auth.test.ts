/**
 * Auth endpoints — database side only.
 *
 * Authentication itself now runs on Firebase Auth (outside the scope of the database migration),
 * so the tests of the removed JWT / bcrypt / refresh-token-rotation / Google-OAuth-library mechanics
 * were retired. What remains checks the behaviour that depends on the database (profile record,
 * free trial, credits) and the request validation / token-rejection paths that still apply.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { expiredIdTokenFor } from './helpers/memoryAuth.js';
import { createTestUser, idTokenFor, memoryAuth, resetFirebase } from './helpers/firebaseTestEnv.js';
import { registerViaApi, rtdb } from './helpers/testApi.js';

const app = createApp();

describe('Auth endpoints with Firebase Auth + RTDB', () => {
  beforeEach(async () => {
    await resetFirebase();
    await PlanSeedService.seedDefaultPlans();
  });

  it('1. Successful registration returns 201, a token, and writes the RTDB identity profile', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Test User', email: 'register@test.com', password: 'Password123!' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.user.email).toBe('register@test.com');
    expect(res.body.data.user.passwordHash).toBeUndefined();

    const profile = await rtdb.userProfile(res.body.data.user._id);
    expect(profile).toMatchObject({ name: 'Test User', email: 'register@test.com', role: 'user', status: 'active' });
    expect(typeof profile.createdAt).toBe('number');
  });

  it('2. Duplicate email registration returns 409 Conflict', async () => {
    await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'User One', email: 'duplicate@test.com', password: 'Password123!' });
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'User Two', email: 'duplicate@test.com', password: 'Password123!' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_EXISTS');
  });

  it('3. Email normalization trims whitespace and lowercases email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Normal User', email: '  NORMALIZE@TEST.COM  ', password: 'Password123!' });

    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe('normalize@test.com');
    expect((await rtdb.userProfile(res.body.data.user._id)).email).toBe('normalize@test.com');
  });

  it('4. Weak password (< 8 chars) returns 400 Bad Request', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Weak Pass', email: 'weak@test.com', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('5. Password longer than 72 characters returns 400 Bad Request', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Long Pass', email: 'long@test.com', password: 'A'.repeat(73) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('5b. Unicode password exceeding 72 UTF-8 bytes returns 400 Bad Request', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Emoji Pass', email: 'emoji@test.com', password: '🔑'.repeat(25) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('8. Missing bearer token returns 401 Unauthorized', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('9. Malformed bearer token returns 401 Unauthorized', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'Basic 12345');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('10. Invalid token returns 401 INVALID_TOKEN', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer invalid_jwt_string');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('11. Expired token returns 401 TOKEN_EXPIRED', async () => {
    const { uid } = await createTestUser({ email: 'expired@test.com' });
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${expiredIdTokenFor(uid)}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('13. Successful /auth/me returns current user details from the RTDB profile', async () => {
    const { auth } = await registerViaApi(app, { name: 'Me User', email: 'me@test.com' });

    const res = await request(app).get('/api/v1/auth/me').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('me@test.com');
    expect(res.body.data.user.name).toBe('Me User');
    expect(res.body.data.user.status).toBe('active');
  });

  it('14. /auth/me must never expose passwordHash', async () => {
    const { auth } = await registerViaApi(app, { name: 'Safe User', email: 'safe@test.com' });
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('16. Unknown request fields are rejected by Zod strict mode', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        name: 'Extra Field',
        email: 'extra@test.com',
        password: 'Password123!',
        unexpectedProperty: 'malicious_input',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('17. Logout endpoint returns success status', async () => {
    const res = await request(app).post('/api/v1/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('Successfully logged out');
  });

  it('18. Registration automatically provisions 5-day free trial subscription and 100 credits', async () => {
    const regRes = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Trial User', email: 'trialuser@test.com', password: 'Password123!' });
    expect(regRes.status).toBe(201);
    expect(regRes.body.data.subscription.planCodeSnapshot).toBe('free-trial');
    const auth = `Bearer ${idTokenFor(regRes.body.data.user._id)}`;

    const subRes = await request(app).get('/api/v1/subscription/me').set('Authorization', auth);
    expect(subRes.status).toBe(200);
    expect(subRes.body.data.status).toBe('TRIALING');
    expect(subRes.body.data.subscription.isTrial).toBe(true);
    expect(subRes.body.data.hasActiveEntitlement).toBe(true);

    const balanceRes = await request(app).get('/api/v1/credits/balance').set('Authorization', auth);
    expect(balanceRes.status).toBe(200);
    expect(balanceRes.body.data.allocatedCredits).toBe(100);
    expect(balanceRes.body.data.remainingCredits).toBe(100);
  });

  it('23. First Google sign-in (Firebase ID token) writes the profile and provisions the free trial; later sign-ins return it', async () => {
    // Database side of /auth/google only: the endpoint is called with a Firebase ID token for an
    // existing Firebase Auth user (how the extension obtains that token is an auth concern).
    const record = await memoryAuth.createUser({ email: 'googleuser@test.com', displayName: 'Google User' });

    const first = await request(app)
      .post('/api/v1/auth/google')
      .send({ idToken: idTokenFor(record.uid), nonce: 'n-1' });
    expect(first.status).toBe(200);
    expect(first.body.data.subscription.planCodeSnapshot).toBe('free-trial');
    expect(first.body.data.subscription.isTrial).toBe(true);
    expect((await rtdb.userProfile(record.uid)).email).toBe('googleuser@test.com');

    const second = await request(app)
      .post('/api/v1/auth/google')
      .send({ idToken: idTokenFor(record.uid), nonce: 'n-2' });
    expect(second.status).toBe(200);
    expect(second.body.data.subscription._id).toBe(first.body.data.subscription._id);
    expect((await rtdb.ledger(record.uid)).filter(entry => entry.type === 'TRIAL_ALLOCATION')).toHaveLength(1);
  });
});
