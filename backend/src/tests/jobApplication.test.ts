import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { setupTestDatabase, type TestDbInstance } from './setupTestDb.js';

const app = createApp();
let testDb: TestDbInstance;

describe('Job Application Security & Sync Tests', () => {
  beforeAll(async () => {
    testDb = await setupTestDatabase();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.clearCollections();
  });

  it('1. Unauthenticated request to /api/v1/job-applications is rejected with 401', async () => {
    const res = await request(app).get('/api/v1/job-applications');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');

    const postRes = await request(app).post('/api/v1/job-applications').send({
      jobTitle: 'Frontend Engineer',
      company: 'Tech Corp',
    });
    expect(postRes.status).toBe(401);
  });

  it('2. Authenticated user can record job application and fields are persisted properly', async () => {
    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Job Seeker',
      email: 'seeker@test.com',
      password: 'Password123!',
    });
    const token = regRes.body.data.token;

    const postRes = await request(app).post('/api/v1/job-applications').set('Authorization', `Bearer ${token}`).send({
      jobTitle: 'Senior Full Stack Engineer',
      company: 'Stripe',
      platform: 'linkedin',
      applicationUrl: 'https://www.linkedin.com/jobs/view/1234567890/',
      location: 'San Francisco, CA',
      status: 'applied',
      appliedAt: new Date().toISOString(),
    });

    expect(postRes.status).toBe(200);
    expect(postRes.body.success).toBe(true);
    expect(postRes.body.data.title).toBe('Senior Full Stack Engineer');
    expect(postRes.body.data.company).toBe('Stripe');
    expect(postRes.body.data.platform).toBe('linkedin');
    expect(postRes.body.data.status).toBe('APPLIED');
    expect(postRes.body.data.userId).toBe(regRes.body.data.user._id);
  });

  it('3. User applications are strictly scoped to the authenticated user', async () => {
    // User 1
    const user1 = await request(app).post('/api/v1/auth/register').send({
      name: 'User One',
      email: 'user1@test.com',
      password: 'Password123!',
    });
    const token1 = user1.body.data.token;

    // User 2
    const user2 = await request(app).post('/api/v1/auth/register').send({
      name: 'User Two',
      email: 'user2@test.com',
      password: 'Password123!',
    });
    const token2 = user2.body.data.token;

    // User 1 records application
    await request(app).post('/api/v1/job-applications').set('Authorization', `Bearer ${token1}`).send({
      jobTitle: 'Backend Dev',
      company: 'Google',
      applicationUrl: 'https://www.linkedin.com/jobs/view/111/',
    });

    // User 2 lists applications - should be empty
    const listResUser2 = await request(app).get('/api/v1/job-applications').set('Authorization', `Bearer ${token2}`);

    expect(listResUser2.status).toBe(200);
    expect(listResUser2.body.data).toHaveLength(0);
    expect(listResUser2.body.pagination.total).toBe(0);

    // User 1 lists applications - should have 1
    const listResUser1 = await request(app).get('/api/v1/job-applications').set('Authorization', `Bearer ${token1}`);

    expect(listResUser1.status).toBe(200);
    expect(listResUser1.body.data).toHaveLength(1);
    expect(listResUser1.body.data[0].company).toBe('Google');
  });

  it('4. Duplicate check checks against authenticated user only', async () => {
    const user1 = await request(app).post('/api/v1/auth/register').send({
      name: 'User One',
      email: 'dup1@test.com',
      password: 'Password123!',
    });
    const token1 = user1.body.data.token;

    const user2 = await request(app).post('/api/v1/auth/register').send({
      name: 'User Two',
      email: 'dup2@test.com',
      password: 'Password123!',
    });
    const token2 = user2.body.data.token;

    const jobId = 'linkedin-job-999';

    // User 1 applies
    await request(app).post('/api/v1/job-applications').set('Authorization', `Bearer ${token1}`).send({
      jobId,
      jobTitle: 'Software Engineer',
      company: 'Meta',
    });

    // User 1 checks duplicate -> exists = true
    const check1 = await request(app)
      .get(`/api/v1/job-applications/check/${jobId}`)
      .set('Authorization', `Bearer ${token1}`);
    expect(check1.status).toBe(200);
    expect(check1.body.exists).toBe(true);

    // User 2 checks duplicate for same jobId -> exists = false
    const check2 = await request(app)
      .get(`/api/v1/job-applications/check/${jobId}`)
      .set('Authorization', `Bearer ${token2}`);
    expect(check2.status).toBe(200);
    expect(check2.body.exists).toBe(false);
  });
});
