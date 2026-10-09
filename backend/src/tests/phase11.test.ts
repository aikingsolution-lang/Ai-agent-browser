import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { LlmProviderFactory } from '../services/llm/llmProviderFactory.js';
import { setFirebaseAdminForTesting } from '../config/firebase-admin.js';
import { RTDB_ROOT } from '../services/rtdb/client.js';
import { memoryAuth, resetFirebase, testDb } from './helpers/firebaseTestEnv.js';
import { registerViaApi, rtdb } from './helpers/testApi.js';

const app = createApp();

describe('Phase 11: Production Hardening, Observability & Readiness Audit Tests (Firebase RTDB)', () => {
  beforeEach(async () => {
    LlmProviderFactory.reset();
    await resetFirebase();
    await PlanSeedService.seedDefaultPlans();
  });

  afterEach(() => {
    setFirebaseAdminForTesting({ db: testDb, auth: memoryAuth as any });
  });

  async function registerUser(emailPrefix: string) {
    const user = await registerViaApi(app, { name: `${emailPrefix} User`, email: `${emailPrefix}@phase11test.com` });
    return { token: user.token, userId: user.uid };
  }

  it('1. Correlation ID (x-request-id) is attached to response headers', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-request-id']).toMatch(/^req_/);
  });

  it('2. Preserves incoming x-request-id header when provided', async () => {
    const customId = 'custom_req_12345';
    const res = await request(app).get('/health').set('x-request-id', customId);
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe(customId);
  });

  it('3. Health liveness probes (/health & /health/live) return 200 OK', async () => {
    const res1 = await request(app).get('/health');
    expect(res1.status).toBe(200);
    expect(res1.body.data.status).toBe('ok');

    const res2 = await request(app).get('/health/live');
    expect(res2.status).toBe(200);
    expect(res2.body.data.status).toBe('ok');
  });

  it('4. Readiness probes (/ready & /health/ready) return 200 OK when the database is reachable', async () => {
    const res1 = await request(app).get('/ready');
    expect(res1.status).toBe(200);
    expect(res1.body.data.status).toBe('ready');

    const res2 = await request(app).get('/health/ready');
    expect(res2.status).toBe(200);
    expect(res2.body.data.database.isConnected).toBe(true);
    expect(res2.body.data.database.provider).toBe('firebase-rtdb');
    expect(res2.body.data.database.namespace).toBe(RTDB_ROOT);
    // No fake Mongo status any more
    expect(res2.body.data.mongo).toBeUndefined();
  });

  it('4b. Readiness returns 503 and database-backed routes fail closed when Firebase is not configured', async () => {
    const { token } = await registerUser('failclosed');
    setFirebaseAdminForTesting({ db: null });

    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.error.code).toBe('SERVICE_UNAVAILABLE');

    const balance = await request(app).get('/api/v1/credits/balance').set('Authorization', `Bearer ${token}`);
    expect(balance.status).toBe(503);

    const llm = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ model: 'anthropic.claude-3-haiku-20240307-v1:0', messages: [{ role: 'user', content: 'x' }] });
    expect(llm.status).toBe(503);
  });

  it('5. Global error handling formats errors consistently without stack traces', async () => {
    const res = await request(app).get('/api/v1/non-existent-route-999');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.stack).toBeUndefined();
  });

  it('6. Secret leakage prevention: auth / user responses never expose passwordHash', async () => {
    const { token } = await registerUser('secretcheck');

    const meRes = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.user.passwordHash).toBeUndefined();
    expect(JSON.stringify(meRes.body)).not.toContain('passwordHash');
  });

  it('7. Credit ledger entries record balanceBefore and balanceAfter', async () => {
    const { userId } = await registerUser('ledgeraudit');

    const ledger = (await rtdb.ledger(userId)).find(entry => entry.type === 'TRIAL_ALLOCATION');
    expect(ledger).toBeDefined();
    expect(ledger.balanceBefore).toBe(0);
    expect(ledger.balanceAfter).toBe(100);
  });

  it('8. LLM TIMEOUT error status is logged in the usage log with 0 credits deducted', async () => {
    const { token, userId } = await registerUser('timeoutaudit');
    LlmProviderFactory.setMockOptions({ shouldTimeout: true });

    const res = await request(app)
      .post('/api/v1/llm/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        messages: [{ role: 'user', content: 'Test timeout status' }],
      });

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('PROVIDER_TIMEOUT');

    const log = (await rtdb.llmUsage(userId)).find(entry => entry.status === 'TIMEOUT');
    expect(log).toBeDefined();
    expect(log.creditsDeducted).toBe(0);
  });

  it('9. CORS header dynamically allows any chrome-extension:// origin', async () => {
    const randomExtensionOrigin = 'chrome-extension://nffgienjkailamlolbllolenkbaakpff';
    const res = await request(app).get('/health').set('Origin', randomExtensionOrigin);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(randomExtensionOrigin);
  });
});
