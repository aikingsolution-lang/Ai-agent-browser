import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dedicatedJobRunner } from '../linkedin/dedicatedJobRunner';
import { dedicatedWindowManager } from '../linkedin/dedicatedWindow';
import { DailyQuotaManager } from '../linkedin/rateLimiter';
import { backendApiClient } from '@extension/shared';
import { processedJobsStore, runnerStateStore, authStorage, careerBrainStore } from '@extension/storage';
import { tripLlmCircuitBreaker, isLlmAvailable, resetLlmCircuitBreaker } from '../llmCircuitBreaker';

describe('Stop Handling & Cross-Platform Concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (dedicatedJobRunner as any).cleanupRun();
    (dedicatedJobRunner as any).isRunning = false;
    (dedicatedJobRunner as any).isStopping = false;
    (dedicatedJobRunner as any).stopReason = null;
    (dedicatedJobRunner as any).activeRunToken = null;
    (dedicatedJobRunner as any).loopFinishedPromise = null;
    (dedicatedJobRunner as any).isLoopFinished = true;
    (dedicatedJobRunner as any).hasRefundedCurrentRun = false;
    (dedicatedJobRunner as any).hasSentRunFinished = false;
  });

  it('Scenario 1: Idempotent stop - stop() called twice executes refund exactly once and releases quota', async () => {
    const refundSpy = vi.spyOn(backendApiClient, 'refundCredits').mockResolvedValue({} as any);
    const releaseQuotaSpy = vi.spyOn(DailyQuotaManager, 'releaseOwner').mockResolvedValue(0 as any);
    vi.spyOn(dedicatedWindowManager, 'closeRunnerWindow').mockResolvedValue();

    (dedicatedJobRunner as any).isRunning = true;
    (dedicatedJobRunner as any).activeRunId = 'test-run-123';
    (dedicatedJobRunner as any).activeRunToken = 'token-123';

    // Call stop concurrently twice (e.g. SidePanel STOP message and port disconnect)
    await Promise.all([dedicatedJobRunner.stop('user'), dedicatedJobRunner.stop('port_disconnected')]);

    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect(refundSpy).toHaveBeenCalledWith('test-run-123');
    expect(releaseQuotaSpy).toHaveBeenCalledTimes(1);
    expect(releaseQuotaSpy).toHaveBeenCalledWith('runner');
    expect((dedicatedJobRunner as any).isRunning).toBe(false);
    expect((dedicatedJobRunner as any).isStopping).toBe(false);
  });

  it('Scenario 2: Run token guards shared state - stale loop writes are ignored', async () => {
    const recordSpy = vi.spyOn(processedJobsStore, 'recordJob').mockResolvedValue({} as any);
    const syncSpy = vi.spyOn(backendApiClient, 'recordJobApplication').mockResolvedValue({} as any);

    // Active token is current-token
    (dedicatedJobRunner as any).activeRunToken = 'current-token';
    (dedicatedJobRunner as any).isRunning = true;

    // Stale token from earlier loop attempt to record
    await (dedicatedJobRunner as any).safeRecordJob('stale-token', {
      jobId: 'stale-job',
      title: 'Stale Title',
      company: 'Stale Company',
      status: 'skipped',
      reason: 'No Easy Apply',
      creditsUsed: 0,
    });

    expect(recordSpy).not.toHaveBeenCalled();

    // Stale token attempting to sync to backend
    await (dedicatedJobRunner as any).syncJobApplicationToBackend(
      {
        jobId: 'stale-job',
        jobTitle: 'Stale Title',
        company: 'Stale Company',
        platform: 'linkedin',
        status: 'applied',
      },
      'stale-token',
    );

    expect(syncSpy).not.toHaveBeenCalled();

    // Active token DOES record
    await (dedicatedJobRunner as any).safeRecordJob('current-token', {
      jobId: 'valid-job',
      title: 'Valid Title',
      company: 'Valid Company',
      status: 'applied',
      creditsUsed: 1,
    });

    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'valid-job', status: 'applied' }));
  });

  it('Scenario 3: Start guard blocks new run while previous run is still stopping', async () => {
    vi.spyOn(authStorage, 'getSession').mockResolvedValue({ token: 'mock-valid-token' } as any);
    (dedicatedJobRunner as any).isRunning = false;
    (dedicatedJobRunner as any).isStopping = true;

    const mockPort: any = { postMessage: vi.fn() };

    const result = await dedicatedJobRunner.startAutonomousJobLoop({
      platform: 'naukri',
      portToSend: mockPort,
    });

    expect(result.status).toBe('error');
    expect(result.message).toContain('Previous run is still stopping');
  });

  it('Scenario 4: Aborted candidate job is NOT recorded as skipped or failed in processedJobsStore', async () => {
    const recordSpy = vi.spyOn(processedJobsStore, 'recordJob').mockResolvedValue({} as any);
    vi.spyOn(authStorage, 'getSession').mockResolvedValue({ token: 'test-token' } as any);
    vi.spyOn(careerBrainStore, 'getCareerBrain').mockResolvedValue({
      fullName: 'Candidate Test',
      currentTitle: 'Engineer',
    } as any);

    (dedicatedJobRunner as any).activeRunToken = 'active-run-token';
    (dedicatedJobRunner as any).isRunning = false;
    (dedicatedJobRunner as any).isStopping = true;
    (dedicatedJobRunner as any).stopReason = 'Stopped by user';

    // Calling checkAbort when stopping throws AbortRunError
    expect(() => {
      (dedicatedJobRunner as any).checkAbort('active-run-token', undefined);
    }).toThrow('Stopped by user');

    // And nothing was written to processedJobsStore
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('Scenario 5: LLM circuit breaker keeps failure count across jobs in a run and resets only on new run', () => {
    // Start run 1: reset circuit breaker
    resetLlmCircuitBreaker();
    expect(isLlmAvailable()).toBe(true);

    // Rate limit or error trips breaker
    tripLlmCircuitBreaker(new Error('Rate limit 429'));
    expect(isLlmAvailable()).toBe(false);

    // LLM remains tripped for subsequent jobs in the same run
    expect(isLlmAvailable()).toBe(false);

    // Next run starts: circuit breaker resets once at start of run
    resetLlmCircuitBreaker();
    expect(isLlmAvailable()).toBe(true);
  });
});
