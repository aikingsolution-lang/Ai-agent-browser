import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { createApp } from '../app.js';
import { User } from '../models/user.model.js';
import { RefreshToken } from '../models/refreshToken.model.js';
import { env } from '../config/env.js';

import { OAuth2Client } from 'google-auth-library';
import { setupTestDatabase, type TestDbInstance } from './setupTestDb.js';

const app = createApp();
let testDb: TestDbInstance;

describe('Auth System Integration & Unit Tests', () => {
  beforeAll(async () => {
    testDb = await setupTestDatabase();
  }, 240000);

  afterAll(async () => {
    if (testDb) {
      await testDb.stop();
    }
  });

  beforeEach(async () => {
    await testDb.clearCollections();
  });

  it('1. Successful registration returns 201 Created and JWT token', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Test User',
      email: 'register@test.com',
      password: 'Password123!',
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.user.email).toBe('register@test.com');
    expect(res.body.data.user.passwordHash).toBeUndefined();
  });

  it('2. Duplicate email registration returns 409 Conflict', async () => {
    await request(app).post('/api/v1/auth/register').send({
      name: 'User One',
      email: 'duplicate@test.com',
      password: 'Password123!',
    });

    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'User Two',
      email: 'duplicate@test.com',
      password: 'Password123!',
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_EXISTS');
  });

  it('3. Email normalization trims whitespace and lowercases email', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Normal User',
      email: '  NORMALIZE@TEST.COM  ',
      password: 'Password123!',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe('normalize@test.com');

    // Logging in with lowercased email works
    const loginRes = await request(app).post('/api/v1/auth/login').send({
      email: 'normalize@test.com',
      password: 'Password123!',
    });

    expect(loginRes.status).toBe(200);
  });

  it('4. Weak password (< 8 chars) returns 400 Bad Request', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Weak Pass',
      email: 'weak@test.com',
      password: 'short',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('5. Password longer than 72 characters returns 400 Bad Request', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        name: 'Long Pass',
        email: 'long@test.com',
        password: 'A'.repeat(73),
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('5b. Unicode password exceeding 72 UTF-8 bytes returns 400 Bad Request', async () => {
    // 25 emoji characters * 4 bytes each = 100 bytes (> 72 bytes)
    const unicodePassword = '🔑'.repeat(25);
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Emoji Pass',
      email: 'emoji@test.com',
      password: unicodePassword,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('6. Successful login returns 200 OK and token', async () => {
    await request(app).post('/api/v1/auth/register').send({
      name: 'Login User',
      email: 'login@test.com',
      password: 'Password123!',
    });

    const res = await request(app).post('/api/v1/auth/login').send({
      email: 'login@test.com',
      password: 'Password123!',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.user.passwordHash).toBeUndefined();
  });

  it('7. Invalid password returns generic 401 Unauthorized', async () => {
    await request(app).post('/api/v1/auth/register').send({
      name: 'Invalid Pass',
      email: 'invalidpass@test.com',
      password: 'Password123!',
    });

    const res = await request(app).post('/api/v1/auth/login').send({
      email: 'invalidpass@test.com',
      password: 'WrongPassword!',
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid email or password');
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

  it('10. Invalid JWT returns 401 Unauthorized', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer invalid_jwt_string');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('11. Expired JWT returns 401 Unauthorized', async () => {
    const expiredToken = jwt.sign({ sub: new mongoose.Types.ObjectId().toString(), role: 'user' }, env.JWT_SECRET, {
      expiresIn: '-1s',
    });

    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('12. Suspended user cannot access protected endpoints', async () => {
    const reg = await request(app).post('/api/v1/auth/register').send({
      name: 'Suspended User',
      email: 'suspended@test.com',
      password: 'Password123!',
    });

    const userId = reg.body.data.user._id;
    const token = reg.body.data.token;

    // Suspend user directly in DB
    await User.findByIdAndUpdate(userId, { status: 'suspended' });

    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('13. Successful /auth/me returns current user details', async () => {
    const reg = await request(app).post('/api/v1/auth/register').send({
      name: 'Me User',
      email: 'me@test.com',
      password: 'Password123!',
    });

    const token = reg.body.data.token;

    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('me@test.com');
  });

  it('14. /auth/me must never expose passwordHash', async () => {
    const reg = await request(app).post('/api/v1/auth/register').send({
      name: 'Safe User',
      email: 'safe@test.com',
      password: 'Password123!',
    });

    const token = reg.body.data.token;

    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.passwordHash).toBeUndefined();
  });

  it('15. JWT contains only expected claims (sub, role, iat, exp)', async () => {
    const reg = await request(app).post('/api/v1/auth/register').send({
      name: 'Claims User',
      email: 'claims@test.com',
      password: 'Password123!',
    });

    const token = reg.body.data.token;
    const decoded: any = jwt.decode(token);

    expect(decoded.sub).toBeDefined();
    expect(decoded.role).toBe('user');
    expect(decoded.iat).toBeDefined();
    expect(decoded.exp).toBeDefined();

    // Verify email and name are NOT in token payload
    expect(decoded.email).toBeUndefined();
    expect(decoded.name).toBeUndefined();
  });

  it('16. Unknown request fields are rejected by Zod strict mode', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
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
    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Trial User',
      email: 'trialuser@test.com',
      password: 'Password123!',
    });

    expect(regRes.status).toBe(201);
    const token = regRes.body.data.token;

    // Verify GET /subscription/me immediately returns status TRIALING
    const subRes = await request(app).get('/api/v1/subscription/me').set('Authorization', `Bearer ${token}`);
    expect(subRes.status).toBe(200);
    expect(subRes.body.data.status).toBe('TRIALING');
    expect(subRes.body.data.subscription.isTrial).toBe(true);
    expect(subRes.body.data.hasActiveEntitlement).toBe(true);

    // Verify GET /credits/balance immediately returns 100 allocated credits
    const balanceRes = await request(app).get('/api/v1/credits/balance').set('Authorization', `Bearer ${token}`);
    expect(balanceRes.status).toBe(200);
    expect(balanceRes.body.data.allocatedCredits).toBe(100);
    expect(balanceRes.body.data.remainingCredits).toBe(100);
  });

  it('19. Successful refresh returns new access token and rotated refresh token', async () => {
    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Refresh User',
      email: 'refresh@test.com',
      password: 'Password123!',
    });

    expect(regRes.status).toBe(201);
    const originalRefreshToken = regRes.body.data.refreshToken;
    expect(originalRefreshToken).toBeDefined();

    const refreshRes = await request(app).post('/api/v1/auth/refresh').send({
      refreshToken: originalRefreshToken,
    });

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.success).toBe(true);
    expect(refreshRes.body.data.token).toBeDefined();
    expect(refreshRes.body.data.refreshToken).toBeDefined();
    expect(refreshRes.body.data.refreshToken).not.toBe(originalRefreshToken);

    // New access token works
    const meRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${refreshRes.body.data.token}`);
    expect(meRes.status).toBe(200);
  });

  it('20. Refresh token reuse triggers reuse detection and revokes all tokens for user', async () => {
    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Reuse User',
      email: 'reuse@test.com',
      password: 'Password123!',
    });

    const originalRefreshToken = regRes.body.data.refreshToken;

    // First rotation succeeds
    const firstRefreshRes = await request(app).post('/api/v1/auth/refresh').send({
      refreshToken: originalRefreshToken,
    });
    expect(firstRefreshRes.status).toBe(200);
    const secondRefreshToken = firstRefreshRes.body.data.refreshToken;

    // Attacker tries to reuse the original (already rotated) refresh token
    const reuseRes = await request(app).post('/api/v1/auth/refresh').send({
      refreshToken: originalRefreshToken,
    });
    expect(reuseRes.status).toBe(401);
    expect(reuseRes.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    // Due to reuse detection, the second refresh token is now also invalidated
    const secondTryRes = await request(app).post('/api/v1/auth/refresh').send({
      refreshToken: secondRefreshToken,
    });
    expect(secondTryRes.status).toBe(401);
  });

  it('21. Expired refresh token returns 401 TOKEN_EXPIRED', async () => {
    const expiredRefreshToken = jwt.sign({ sub: new mongoose.Types.ObjectId().toString() }, env.JWT_REFRESH_SECRET, {
      expiresIn: '-1s',
    });

    const res = await request(app).post('/api/v1/auth/refresh').send({
      refreshToken: expiredRefreshToken,
    });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('22. Logout revokes the refresh token so it cannot be refreshed', async () => {
    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Logout Refresh User',
      email: 'logoutrefresh@test.com',
      password: 'Password123!',
    });

    const refreshToken = regRes.body.data.refreshToken;

    // Call logout passing the refreshToken
    const logoutRes = await request(app).post('/api/v1/auth/logout').send({
      refreshToken,
    });
    expect(logoutRes.status).toBe(200);

    // Refreshing now should be rejected (revoked token reuse detection or invalid)
    const refreshRes = await request(app).post('/api/v1/auth/refresh').send({
      refreshToken,
    });
    expect(refreshRes.status).toBe(401);
  });

  it('23. Google sign-in registers new user and auto-provisions free trial', async () => {
    (env as any).GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';

    const verifySpy = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-12345',
        email: 'googleuser@test.com',
        email_verified: true,
        name: 'Google User',
        picture: 'https://example.com/photo.jpg',
        nonce: 'valid-nonce-123',
      }),
    } as any);

    const res = await request(app).post('/api/v1/auth/google').send({
      idToken: 'valid-google-id-token-123',
      nonce: 'valid-nonce-123',
    });

    verifySpy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
    expect(res.body.data.user.email).toBe('googleuser@test.com');
    expect(res.body.data.user.googleLinked).toBe(true);
    expect(res.body.data.subscription).toBeDefined();
    expect(res.body.data.subscription.planCodeSnapshot).toBe('free-trial');
    expect(res.body.data.subscription.isTrial).toBe(true);

    const dbUser = await User.findOne({ email: 'googleuser@test.com' });
    expect(dbUser).not.toBeNull();
    expect(dbUser?.googleId).toBe('google-sub-12345');
    expect(dbUser?.picture).toBe('https://example.com/photo.jpg');
    expect(dbUser?.passwordHash).toBeUndefined();
  });

  it('24. Google sign-in with existing user links account and returns tokens', async () => {
    (env as any).GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';

    await request(app).post('/api/v1/auth/register').send({
      name: 'Existing Account',
      email: 'existinggoogle@test.com',
      password: 'Password123!',
    });

    const verifySpy = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-99999',
        email: 'existinggoogle@test.com',
        email_verified: true,
        name: 'Existing Google',
        picture: 'https://example.com/existing.jpg',
        nonce: 'existing-nonce-999',
      }),
    } as any);

    const res = await request(app).post('/api/v1/auth/google').send({
      idToken: 'valid-google-token-existing',
      nonce: 'existing-nonce-999',
    });

    verifySpy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.user.email).toBe('existinggoogle@test.com');

    const dbUser = await User.findOne({ email: 'existinggoogle@test.com' });
    expect(dbUser?.googleLinked).toBe(true);
    expect(dbUser?.googleId).toBe('google-sub-99999');
    expect(dbUser?.picture).toBe('https://example.com/existing.jpg');
  });

  it('25. Google sign-in rejects unverified email address with 401', async () => {
    (env as any).GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';

    const verifySpy = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-unverified',
        email: 'unverified@test.com',
        email_verified: false,
        name: 'Unverified User',
        nonce: 'unverified-nonce',
      }),
    } as any);

    const res = await request(app).post('/api/v1/auth/google').send({
      idToken: 'valid-id-token-unverified',
      nonce: 'unverified-nonce',
    });

    verifySpy.mockRestore();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('26. Google sign-in rejects nonce mismatch with 401', async () => {
    (env as any).GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';

    const verifySpy = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-nonce-mismatch',
        email: 'noncemismatch@test.com',
        email_verified: true,
        name: 'Nonce Mismatch User',
        nonce: 'google-payload-nonce-A',
      }),
    } as any);

    const res = await request(app).post('/api/v1/auth/google').send({
      idToken: 'valid-token-nonce-mismatch',
      nonce: 'request-body-nonce-B',
    });

    verifySpy.mockRestore();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('NONCE_MISMATCH');
  });

  it('27. Google sign-in fails with invalid token and returns 401', async () => {
    (env as any).GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';

    const verifySpy = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockRejectedValue(new Error('Invalid token'));

    const res = await request(app).post('/api/v1/auth/google').send({
      idToken: 'invalid-token',
      nonce: 'any-nonce',
    });

    verifySpy.mockRestore();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_GOOGLE_TOKEN');
  });
});
