import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { paths } from '../services/rtdb/client.js';
import { JobApplicationRepository } from '../services/rtdb/repositories.js';
import { resetFirebase, testDb } from './helpers/firebaseTestEnv.js';
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
      .send({ jobId: 'job-777', jobTitle: 'Final', company: 'Acme', status: 'APPLIED' });
    expect(first.body.data.title).toBe('Final');
    expect(first.body.data.status).toBe('APPLIED');

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

  it('7. The same job id on different platforms is two applications; the same platform deduplicates', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'platforms@test.com' });
    const post = (body: Record<string, unknown>) =>
      request(app).post('/api/v1/job-applications').set('Authorization', auth).send(body);

    const linkedin = await post({
      jobId: '4012345678',
      jobTitle: 'React Developer',
      company: 'Google',
      platform: 'linkedin',
    });
    const naukri = await post({
      jobId: '4012345678',
      jobTitle: 'Node.js Developer',
      company: 'TCS',
      platform: 'naukri',
    });
    const naukriAgain = await post({
      jobId: '4012345678',
      jobTitle: 'Node.js Developer',
      company: 'TCS',
      platform: 'Naukri',
    });
    const indeed = await post({
      jobId: 'a1b2c3d4e5f60718',
      jobTitle: 'Full Stack Developer',
      company: 'Amazon',
      applicationUrl: 'https://in.indeed.com/viewjob?jk=a1b2c3d4e5f60718',
    });

    expect(naukri.body.data._id).not.toBe(linkedin.body.data._id);
    expect(naukriAgain.body.data._id).toBe(naukri.body.data._id);
    expect(indeed.body.data.platform).toBe('indeed'); // inferred from the URL when no platform is posted
    const stored = await rtdb.jobApplications(uid);
    expect(stored.map(r => `${r.platform}:${r.company}`).sort()).toEqual([
      'indeed:Amazon',
      'linkedin:Google',
      'naukri:TCS',
    ]);

    const check = (jobId: string, platform?: string) =>
      request(app)
        .get(`/api/v1/job-applications/check/${jobId}${platform ? `?platform=${platform}` : ''}`)
        .set('Authorization', auth);
    expect((await check('4012345678')).body.application.company).toBe('Google');
    expect((await check('4012345678', 'naukri')).body.application.company).toBe('TCS');
    expect((await check('a1b2c3d4e5f60718', 'indeed')).body.exists).toBe(true);
    expect((await check('a1b2c3d4e5f60718')).body.exists).toBe(false);
  });

  it('8. A failed attempt does not block a retry and is upgraded in place when the retry succeeds', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'retry@test.com' });
    const failed = await request(app).post('/api/v1/job-applications').set('Authorization', auth).send({
      jobId: '777001',
      jobTitle: 'Backend Engineer',
      company: 'Infosys',
      platform: 'naukri',
      status: 'FAILED',
      failureReason: 'Could not complete questionnaire.',
    });
    expect(failed.body.data.status).toBe('FAILED');
    expect(failed.body.data.failureReason).toBe('Could not complete questionnaire.');

    const blocked = await request(app)
      .get('/api/v1/job-applications/check/777001?platform=naukri')
      .set('Authorization', auth);
    expect(blocked.body.exists).toBe(false);

    const appliedAt = '2026-11-01T10:30:00.000Z';
    const applied = await request(app).post('/api/v1/job-applications').set('Authorization', auth).send({
      jobId: '777001',
      jobTitle: 'Backend Engineer',
      company: 'Infosys',
      platform: 'naukri',
      status: 'APPLIED',
      appliedAt,
    });
    expect(applied.body.data._id).toBe(failed.body.data._id);
    expect(applied.body.data.status).toBe('APPLIED');
    expect(applied.body.data.failureReason).toBe('');
    expect(applied.body.data.appliedAt).toBe(appliedAt);
    expect(await rtdb.jobApplications(uid)).toHaveLength(1);
  });

  it('9. A verified submission is never downgraded and keeps its first submission time', async () => {
    const { auth } = await registerViaApi(app, { email: 'final@test.com' });
    const post = (body: Record<string, unknown>) =>
      request(app)
        .post('/api/v1/job-applications')
        .set('Authorization', auth)
        .send({ jobId: '99', jobTitle: 'QA Engineer', company: 'Wipro', platform: 'indeed', ...body });

    await post({ status: 'APPLIED', appliedAt: '2026-11-01T08:00:00.000Z', location: 'Pune' });
    for (const status of ['FAILED', 'NEEDS_MANUAL_REVIEW', 'QUEUED']) {
      const res = await post({ status, failureReason: 'later attempt', location: 'Elsewhere' });
      expect(res.body.data.status).toBe('APPLIED');
      expect(res.body.data.location).toBe('Pune');
      expect(res.body.data.failureReason).toBe('');
    }

    const resync = await post({
      status: 'APPLIED',
      appliedAt: '2026-11-02T08:00:00.000Z',
      jobDescription: 'Test APIs',
    });
    expect(resync.body.data.appliedAt).toBe('2026-11-01T08:00:00.000Z');
    expect(resync.body.data.jobDescription).toBe('Test APIs');
    expect(resync.body.data.location).toBe('Pune'); // not re-sent, so kept
  });

  it('10. Records written before keys were scoped by platform are updated instead of duplicated', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'legacy@test.com' });
    // A Naukri record as the Mongo migration (and earlier builds) stored it: keyed by the bare job id
    const appId = 'ja_legacy1';
    await testDb.ref(paths.jobApplication(uid, appId)).set({
      appId,
      uid,
      jobId: 'naukri-77',
      title: 'Data Analyst',
      company: 'HCL',
      location: '',
      salaryRange: '',
      fitScore: 0,
      platform: 'naukri',
      applicationUrl: '',
      status: 'APPLIED',
      appliedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    await testDb.ref(paths.jobApplicationKey(uid, JobApplicationRepository.jobKey('naukri-77'))).set(appId);

    const res = await request(app).post('/api/v1/job-applications').set('Authorization', auth).send({
      jobId: 'naukri-77',
      jobTitle: 'Data Analyst',
      company: 'HCL',
      platform: 'naukri',
      location: 'Noida',
    });
    expect(res.body.data._id).toBe(appId);
    expect(res.body.data.location).toBe('Noida');
    expect(await rtdb.jobApplications(uid)).toHaveLength(1);

    const check = await request(app)
      .get('/api/v1/job-applications/check/naukri-77?platform=naukri')
      .set('Authorization', auth);
    expect(check.body.application._id).toBe(appId);
  });

  it('11. Fields are capped and sanitised; unsafe links are dropped', async () => {
    const { auth } = await registerViaApi(app, { email: 'sanitise@test.com' });
    const res = await request(app)
      .post('/api/v1/job-applications')
      .set('Authorization', auth)
      .send({
        jobId: 'x1',
        jobTitle: '  Senior\n  Engineer  ',
        company: 'Acme',
        platform: 'Indeed <script>',
        jobDescription: 'a'.repeat(5000),
        companyWebsite: 'javascript:alert(1)',
      });
    expect(res.body.data.title).toBe('Senior Engineer');
    expect(res.body.data.platform).toBe('other');
    expect(res.body.data.jobDescription).toHaveLength(2000);
    expect(res.body.data.companyWebsite).toBe('');

    const website = await request(app)
      .post('/api/v1/job-applications')
      .set('Authorization', auth)
      .send({ jobId: 'x2', jobTitle: 'Dev', company: 'Acme', companyWebsite: 'https://acme.example/careers' });
    expect(website.body.data.companyWebsite).toBe('https://acme.example/careers');
    expect(website.body.data.title).toBe('Dev');

    const missing = await request(app)
      .post('/api/v1/job-applications')
      .set('Authorization', auth)
      .send({ jobId: 'x3' });
    expect(missing.body.data.title).toBe('Unknown Title');
    expect(missing.body.data.company).toBe('Unknown Company');
  });
});
