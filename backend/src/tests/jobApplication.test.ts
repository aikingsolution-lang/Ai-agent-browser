import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { resetFirebase } from './helpers/firebaseTestEnv.js';
import { registerViaApi, rtdb } from './helpers/testApi.js';

const app = createApp();

describe('Job Application Security & Sync Tests (Firebase RTDB)', () => {
  beforeEach(async () => {
    await resetFirebase();
    await PlanSeedService.seedDefaultPlans();
  });

  it('1. Unauthenticated request to /api/v1/job-applications is rejected with 401', async () => {
    const res = await request(app).get('/api/v1/job-applications');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');

    const postRes = await request(app)
      .post('/api/v1/job-applications')
      .send({ jobTitle: 'Frontend Engineer', company: 'Tech Corp' });
    expect(postRes.status).toBe(401);
  });

  it('2. Authenticated user can record job application and fields are persisted properly', async () => {
    const { uid, auth } = await registerViaApi(app, { name: 'Job Seeker', email: 'seeker@test.com' });

    const postRes = await request(app).post('/api/v1/job-applications').set('Authorization', auth).send({
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
    expect(postRes.body.data.userId).toBe(uid);
    // The URL (with "." and "/") became the jobId value, never an RTDB key
    expect(postRes.body.data.jobId).toBe('https://www.linkedin.com/jobs/view/1234567890/');
    expect(postRes.body.data.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await rtdb.jobApplications(uid)).toHaveLength(1);
  });

  it('3. User applications are strictly scoped to the authenticated user', async () => {
    const user1 = await registerViaApi(app, { name: 'User One', email: 'user1@test.com' });
    const user2 = await registerViaApi(app, { name: 'User Two', email: 'user2@test.com' });

    await request(app).post('/api/v1/job-applications').set('Authorization', user1.auth).send({
      jobTitle: 'Backend Dev',
      company: 'Google',
      applicationUrl: 'https://www.linkedin.com/jobs/view/111/',
    });

    const listResUser2 = await request(app).get('/api/v1/job-applications').set('Authorization', user2.auth);
    expect(listResUser2.status).toBe(200);
    expect(listResUser2.body.data).toHaveLength(0);
    expect(listResUser2.body.pagination.total).toBe(0);

    const listResUser1 = await request(app).get('/api/v1/job-applications').set('Authorization', user1.auth);
    expect(listResUser1.status).toBe(200);
    expect(listResUser1.body.data).toHaveLength(1);
    expect(listResUser1.body.data[0].company).toBe('Google');
    expect(listResUser1.body.pagination.total).toBe(1);

    // User 2 cannot update User 1's application by id
    const appId = listResUser1.body.data[0]._id;
    const patch = await request(app)
      .patch(`/api/v1/job-applications/${appId}/status`)
      .set('Authorization', user2.auth)
      .send({ status: 'QUEUED' });
    expect(patch.status).toBe(404);
  });

  it('4. Duplicate check checks against authenticated user only', async () => {
    const user1 = await registerViaApi(app, { email: 'dup1@test.com' });
    const user2 = await registerViaApi(app, { email: 'dup2@test.com' });
    const jobId = 'linkedin-job-999';

    await request(app)
      .post('/api/v1/job-applications')
      .set('Authorization', user1.auth)
      .send({ jobId, jobTitle: 'Software Engineer', company: 'Meta' });

    const check1 = await request(app).get(`/api/v1/job-applications/check/${jobId}`).set('Authorization', user1.auth);
    expect(check1.status).toBe(200);
    expect(check1.body.exists).toBe(true);
    expect(check1.body.application.jobId).toBe(jobId);

    const check2 = await request(app).get(`/api/v1/job-applications/check/${jobId}`).set('Authorization', user2.auth);
    expect(check2.status).toBe(200);
    expect(check2.body.exists).toBe(false);
  });

  it('5. Recording the same jobId again updates the existing application (unique {user, jobId}), also under concurrency', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'upsert@test.com' });

    const results = await Promise.all(
      Array.from({ length: 5 }).map((_, i) =>
        request(app)
          .post('/api/v1/job-applications')
          .set('Authorization', auth)
          .send({ jobId: 'job-777', jobTitle: `Title ${i}`, company: 'Acme' }),
      ),
    );
    results.forEach(res => expect(res.status).toBe(200));
    expect(new Set(results.map(res => res.body.data._id)).size).toBe(1);

    const first = await request(app)
      .post('/api/v1/job-applications')
      .set('Authorization', auth)
      .send({ jobId: 'job-777', jobTitle: 'Final', company: 'Acme', status: 'NEEDS_MANUAL_REVIEW' });
    expect(first.body.data.title).toBe('Final');
    expect(first.body.data.status).toBe('NEEDS_MANUAL_REVIEW');

    const stored = await rtdb.jobApplications(uid);
    expect(stored).toHaveLength(1);
    const list = await request(app).get('/api/v1/job-applications').set('Authorization', auth);
    expect(list.body.pagination.total).toBe(1);
  });

  it('6. Listing supports status filter and newest-updated-first pagination; status updates work', async () => {
    const { auth } = await registerViaApi(app, { email: 'paging@test.com' });
    for (let i = 1; i <= 5; i++) {
      await request(app)
        .post('/api/v1/job-applications')
        .set('Authorization', auth)
        .send({ jobId: `job-${i}`, jobTitle: `Job ${i}`, company: 'Co', status: i % 2 === 0 ? 'QUEUED' : 'APPLIED' });
      await new Promise(resolve => setTimeout(resolve, 3));
    }

    const page1 = await request(app).get('/api/v1/job-applications?limit=2&page=1').set('Authorization', auth);
    expect(page1.body.data.map((a: any) => a.jobId)).toEqual(['job-5', 'job-4']);
    expect(page1.body.pagination).toEqual({ total: 5, page: 1, limit: 2, totalPages: 3 });

    const page3 = await request(app).get('/api/v1/job-applications?limit=2&page=3').set('Authorization', auth);
    expect(page3.body.data.map((a: any) => a.jobId)).toEqual(['job-1']);

    const queued = await request(app).get('/api/v1/job-applications?status=QUEUED').set('Authorization', auth);
    expect(queued.body.data.map((a: any) => a.jobId)).toEqual(['job-4', 'job-2']);
    expect(queued.body.pagination.total).toBe(2);

    const appId = queued.body.data[1]._id;
    const patched = await request(app)
      .patch(`/api/v1/job-applications/${appId}/status`)
      .set('Authorization', auth)
      .send({ status: 'applied' });
    expect(patched.status).toBe(200);
    expect(patched.body.data.status).toBe('APPLIED');

    const invalid = await request(app)
      .patch(`/api/v1/job-applications/${appId}/status`)
      .set('Authorization', auth)
      .send({ status: 'NOT_A_STATUS' });
    expect(invalid.status).toBe(400);
  });
});
