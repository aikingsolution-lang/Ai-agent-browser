import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { CreditService } from '../services/credit.service.js';
import { resetFirebase, memoryDb } from './helpers/firebaseTestEnv.js';
import { registerViaApi, rtdb } from './helpers/testApi.js';
import { logger } from '../utils/logger.js';

const app = createApp();

describe('Refund Endpoints & Concurrency Integrity (/api/v1/credits/refund)', () => {
  beforeEach(async () => {
    await resetFirebase();
    await PlanSeedService.seedDefaultPlans();
  });

  it('Case (a): Run with deducted credits successfully refunds exact amount and restores balance', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'refund-case-a@test.com' });

    // Initial balance: 100
    await CreditService.deductCredits({
      userId: uid,
      amount: 8,
      description: 'Job application AI evaluation',
      metadata: { runId: 'run-case-a' },
    });

    const balanceAfterDeduct = await rtdb.balance(uid);
    expect(balanceAfterDeduct.remainingCredits).toBe(92);
    expect(balanceAfterDeduct.usedCredits).toBe(8);

    const res = await request(app)
      .post('/api/v1/credits/refund')
      .set('Authorization', auth)
      .send({ runId: 'run-case-a' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.refundedAmount).toBe(8);
    expect(res.body.data.remainingCredits).toBe(100);
    expect(res.body.data.usedCredits).toBe(0);
    expect(res.body.data.runId).toBe('run-case-a');

    const balanceAfterRefund = await rtdb.balance(uid);
    expect(balanceAfterRefund.remainingCredits).toBe(100);
    expect(balanceAfterRefund.usedCredits).toBe(0);
  });

  it('Case (b): Run with no usage record returns clear 404 RUN_NOT_FOUND (not 500)', async () => {
    const { auth } = await registerViaApi(app, { email: 'refund-case-b@test.com' });

    const res = await request(app)
      .post('/api/v1/credits/refund')
      .set('Authorization', auth)
      .send({ runId: 'auto_loop_unknown_12345' });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('RUN_NOT_FOUND');
    expect(res.body.message).toContain('No billable usage found');
  });

  it('Case (c) & Idempotency: Calling refund repeatedly returns same result and NEVER double-credits', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'refund-case-c@test.com' });

    await CreditService.deductCredits({
      userId: uid,
      amount: 15,
      description: 'Questionnaire answering',
      metadata: { runId: 'run-case-c' },
    });

    // 1st call
    const res1 = await request(app)
      .post('/api/v1/credits/refund')
      .set('Authorization', auth)
      .send({ runId: 'run-case-c' });

    expect(res1.status).toBe(200);
    expect(res1.body.data.refundedAmount).toBe(15);
    expect(res1.body.data.remainingCredits).toBe(100);

    // 2nd call (idempotent via completed idempotency record)
    const res2 = await request(app)
      .post('/api/v1/credits/refund')
      .set('Authorization', auth)
      .send({ runId: 'run-case-c' });

    expect(res2.status).toBe(200);
    expect(res2.body.data.refundedAmount).toBe(15);
    expect(res2.body.data.remainingCredits).toBe(100);

    // 3rd call
    const res3 = await request(app)
      .post('/api/v1/credits/refund')
      .set('Authorization', auth)
      .send({ runId: 'run-case-c' });

    expect(res3.status).toBe(200);
    expect(res3.body.data.refundedAmount).toBe(15);
    expect(res3.body.data.remainingCredits).toBe(100);

    // Verify database only has 1 REFUND entry in ledger
    const ledger = await rtdb.ledger(uid);
    const refunds = ledger.filter(e => e.type === 'REFUND');
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount).toBe(15);

    // Balance remains exactly 100, never 115 or 130
    const finalBalance = await rtdb.balance(uid);
    expect(finalBalance.remainingCredits).toBe(100);
  });

  it('Case (d): Invalid runId returns clear 400 INVALID_RUN_ID rather than 500', async () => {
    const { auth } = await registerViaApi(app, { email: 'refund-case-d@test.com' });

    // Missing runId
    const resMissing = await request(app).post('/api/v1/credits/refund').set('Authorization', auth).send({});
    expect(resMissing.status).toBe(400);
    expect(resMissing.body.error.code).toBe('INVALID_RUN_ID');

    // Empty runId
    const resEmpty = await request(app).post('/api/v1/credits/refund').set('Authorization', auth).send({ runId: '' });
    expect(resEmpty.status).toBe(400);
    expect(resEmpty.body.error.code).toBe('INVALID_RUN_ID');

    // Whitespace only
    const resWhitespace = await request(app)
      .post('/api/v1/credits/refund')
      .set('Authorization', auth)
      .send({ runId: '   ' });
    expect(resWhitespace.status).toBe(400);
    expect(resWhitespace.body.error.code).toBe('INVALID_RUN_ID');

    // Non-string
    const resNonString = await request(app)
      .post('/api/v1/credits/refund')
      .set('Authorization', auth)
      .send({ runId: 12345 });
    expect(resNonString.status).toBe(400);
    expect(resNonString.body.error.code).toBe('INVALID_RUN_ID');
  });

  it('Resilient query fallback: Missing RTDB .indexOn rule does not crash with 500', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'refund-fallback@test.com' });

    await CreditService.deductCredits({
      userId: uid,
      amount: 7,
      description: 'Usage before index issue',
      metadata: { runId: 'run-no-index' },
    });

    // Simulate missing index rules in RTDB
    memoryDb.setIndexRules([]);

    // Should gracefully fall back to user ledger scan and succeed with 200
    const res = await request(app)
      .post('/api/v1/credits/refund')
      .set('Authorization', auth)
      .send({ runId: 'run-no-index' });

    expect(res.status).toBe(200);
    expect(res.body.data.refundedAmount).toBe(7);
    expect(res.body.data.remainingCredits).toBe(100);

    // Unknown run with missing index rule also returns 404, never 500
    const resUnknown = await request(app)
      .post('/api/v1/credits/refund')
      .set('Authorization', auth)
      .send({ runId: 'run-not-there' });

    expect(resUnknown.status).toBe(404);
    expect(resUnknown.body.error.code).toBe('RUN_NOT_FOUND');
  });

  it('Emits structured server logs with requestId, userId, runId, and outcome', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'refund-logs@test.com' });

    await CreditService.deductCredits({
      userId: uid,
      amount: 4,
      description: 'Audit log check',
      metadata: { runId: 'run-structured-log' },
    });

    const infoSpy = vi.spyOn(logger, 'info');
    const errorSpy = vi.spyOn(logger, 'error');

    // Successful refund
    await request(app)
      .post('/api/v1/credits/refund')
      .set('Authorization', auth)
      .set('x-request-id', 'req-audit-123')
      .send({ runId: 'run-structured-log' });

    expect(infoSpy).toHaveBeenCalledWith(
      '[CreditController.refundCredits] Refund processed',
      expect.objectContaining({
        requestId: 'req-audit-123',
        userId: uid,
        runId: 'run-structured-log',
        outcome: 'SUCCESS',
        refundedAmount: 4,
      }),
    );

    // Failed refund (unknown run)
    await request(app)
      .post('/api/v1/credits/refund')
      .set('Authorization', auth)
      .set('x-request-id', 'req-audit-456')
      .send({ runId: 'run-missing-999' });

    expect(errorSpy).toHaveBeenCalledWith(
      '[CreditController.refundCredits] Refund failed',
      expect.objectContaining({
        requestId: 'req-audit-456',
        userId: uid,
        runId: 'run-missing-999',
        outcome: 'FAILED',
        statusCode: 404,
        errorCode: 'RUN_NOT_FOUND',
      }),
    );
  });

  it('Interrupted job refund vs completed application protection: refunds ONLY interrupted job credits', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'interrupted-run@test.com' });
    const loopRunId = `auto_loop_${Date.now()}`;

    // Job 1: AI form answering deducts 3 credits under per-job id `<loopRunId>_job1`
    await CreditService.deductCredits({
      userId: uid,
      amount: 3,
      description: 'Job 1 AI answering',
      metadata: { runId: `${loopRunId}_job1` },
    });

    // Job 1 successfully applied and recorded in backend job_applications
    const { JobApplicationRepository } = await import('../services/rtdb/repositories.js');
    await JobApplicationRepository.save(
      uid,
      {
        appId: 'app_job1_complete',
        uid,
        jobId: 'job1',
        platform: 'linkedin',
        title: 'Frontend Engineer',
        company: 'Acme Corp',
        location: 'Remote',
        salaryRange: '$120k',
        fitScore: 85,
        applicationUrl: 'https://linkedin.com/jobs/view/1',
        status: 'APPLIED',
        appliedAt: Date.now(),
        updatedAt: Date.now(),
        createdAt: Date.now(),
      },
      true,
    );

    // Job 2: AI form answering deducts 5 credits under per-job id `<loopRunId>_job2`
    await CreditService.deductCredits({
      userId: uid,
      amount: 5,
      description: 'Job 2 AI answering (interrupted)',
      metadata: { runId: `${loopRunId}_job2` },
    });

    // Job 2 is NOT recorded in job_applications as applied because the user pressed STOP mid-apply!
    const midBalance = await rtdb.balance(uid);
    expect(midBalance.remainingCredits).toBe(92); // 100 - 3 - 5
    expect(midBalance.usedCredits).toBe(8);

    // User pressed STOP: stop() requests refund for loop runId
    const res = await request(app).post('/api/v1/credits/refund').set('Authorization', auth).send({ runId: loopRunId });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Crucial: ONLY Job 2's 5 credits are refunded. Job 1's 3 credits are NOT refunded because it was completed!
    expect(res.body.data.refundedAmount).toBe(5);
    expect(res.body.data.remainingCredits).toBe(97); // 92 + 5
    expect(res.body.data.usedCredits).toBe(3); // only Job 1's completed usage remains

    // Idempotency: Second refund call for the same loop runId returns the exact same result and NEVER double-refunds
    const res2 = await request(app)
      .post('/api/v1/credits/refund')
      .set('Authorization', auth)
      .send({ runId: loopRunId });

    expect(res2.status).toBe(200);
    expect(res2.body.data.refundedAmount).toBe(5);
    expect(res2.body.data.remainingCredits).toBe(97);

    const finalBalance = await rtdb.balance(uid);
    expect(finalBalance.remainingCredits).toBe(97);
    expect(finalBalance.usedCredits).toBe(3);
  });

  it('No refund when all loop applications succeeded: completed applications are never refunded', async () => {
    const { uid, auth } = await registerViaApi(app, { email: 'all-completed-run@test.com' });
    const loopRunId = `auto_loop_${Date.now()}`;

    // Job A completed
    await CreditService.deductCredits({
      userId: uid,
      amount: 4,
      description: 'Job A answering',
      metadata: { runId: `${loopRunId}_jobA` },
    });
    const { JobApplicationRepository } = await import('../services/rtdb/repositories.js');
    await JobApplicationRepository.save(
      uid,
      {
        appId: 'app_jobA',
        uid,
        jobId: 'jobA',
        platform: 'naukri',
        title: 'Backend Engineer',
        company: 'Beta Corp',
        location: 'Remote',
        salaryRange: '$110k',
        fitScore: 80,
        applicationUrl: 'https://naukri.com/jobs/view/A',
        status: 'APPLIED',
        appliedAt: Date.now(),
        updatedAt: Date.now(),
        createdAt: Date.now(),
      },
      true,
    );

    // Stop called after Job A completed, with no in-progress job
    const res = await request(app).post('/api/v1/credits/refund').set('Authorization', auth).send({ runId: loopRunId });

    // Completed applications are never refunded
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RUN_NOT_FOUND');

    const finalBalance = await rtdb.balance(uid);
    expect(finalBalance.remainingCredits).toBe(96);
    expect(finalBalance.usedCredits).toBe(4);
  });
});
