import { describe, it, expect, beforeEach, vi } from 'vitest';

const { storageData } = vi.hoisted(() => {
  const data: Record<string, any> = {};
  const clone = (v: any) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const local = {
    get: async (keys?: string | string[] | null) => {
      if (!keys) return clone(data);
      const res: Record<string, any> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (k in data) res[k] = clone(data[k]);
      return res;
    },
    set: async (items: Record<string, any>) => {
      for (const [k, v] of Object.entries(items)) data[k] = clone(v);
    },
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
    onChanged: { addListener: () => undefined },
  };
  (globalThis as any).chrome = {
    storage: { local, sync: local, session: local, onChanged: { addListener: () => undefined } },
    alarms: { create: async () => undefined },
    runtime: { id: 'test', getURL: (p: string) => p },
  };
  return { storageData: data };
});

import { backendApiClient } from '@extension/shared';
import { ACCOUNT_DATA_STORAGE_KEYS, authStorage } from '@extension/storage';
import {
  PENDING_APPLICATION_REPORTS_KEY,
  outcomeForFailure,
  reportApplication,
  retryPendingApplicationReports,
  toApplicationPayload,
  type ApplicationReport,
} from '../applicationHistory';

const signedInAs = (uid: string | null) =>
  vi
    .spyOn(authStorage, 'getSession')
    .mockResolvedValue(uid ? ({ token: 't', user: { id: uid, uid, _id: uid } } as any) : (null as any));

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

const report = (fields: Partial<ApplicationReport> = {}): ApplicationReport => ({
  platform: 'naukri',
  jobId: '250925012345',
  title: 'Node.js Developer',
  company: 'TCS',
  url: 'https://www.naukri.com/job-listings-node-js-developer-tcs-noida-250925012345',
  status: 'APPLIED',
  ...fields,
});

describe('application history reporting', () => {
  let sent: any[];

  beforeEach(() => {
    for (const key of Object.keys(storageData)) delete storageData[key];
    vi.restoreAllMocks();
    signedInAs('me');
    sent = [];
    vi.spyOn(backendApiClient, 'recordJobApplication').mockImplementation(async payload => {
      sent.push(payload);
      return { success: true } as any;
    });
  });

  it('only an unconfirmed final submit counts as "needs review"; everything else failed', () => {
    expect(outcomeForFailure('Submission was clicked but confirmation was not verified by LinkedIn DOM')).toBe(
      'NEEDS_MANUAL_REVIEW',
    );
    expect(outcomeForFailure('Application could not be confirmed after clicking apply button.')).toBe(
      'NEEDS_MANUAL_REVIEW',
    );
    expect(outcomeForFailure('Modal closed unexpectedly without confirmation')).toBe('FAILED');
    expect(outcomeForFailure('Application failed or submission could not be verified.')).toBe('FAILED');
    expect(outcomeForFailure('Could not complete questionnaire.')).toBe('FAILED');
    expect(outcomeForFailure(undefined)).toBe('FAILED');
  });

  it('builds the backend payload with platform, details and attempt time; placeholders become empty', () => {
    const at = Date.UTC(2026, 10, 1, 10, 30);
    const payload = toApplicationPayload(
      report({
        platform: 'linkedin',
        title: 'LinkedIn Job',
        company: '  Google \n LLC ',
        location: 'Remote',
        description: 'x'.repeat(3000),
        status: 'FAILED',
        reason: 'Could not advance step',
        at,
      }),
    );
    expect(payload).toMatchObject({
      jobId: '250925012345',
      jobTitle: '',
      company: 'Google LLC',
      platform: 'linkedin',
      location: 'Remote',
      status: 'FAILED',
      failureReason: 'Could not advance step',
      appliedAt: '2026-11-01T10:30:00.000Z',
    });
    expect(payload.jobDescription).toHaveLength(2000);
    expect(toApplicationPayload(report({ reason: 'ignored' })).failureReason).toBeUndefined();
  });

  it('sends the report for the signed-in account', async () => {
    await reportApplication(report({ location: 'Noida', salary: '6-9 Lacs PA' }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      platform: 'naukri',
      company: 'TCS',
      jobTitle: 'Node.js Developer',
      location: 'Noida',
      salaryRange: '6-9 Lacs PA',
      status: 'APPLIED',
    });
  });

  it('does nothing when no one is signed in', async () => {
    signedInAs(null);
    await reportApplication(report());
    expect(sent).toHaveLength(0);
    expect(storageData[PENDING_APPLICATION_REPORTS_KEY]).toBeUndefined();
  });

  it('queues a report the backend cannot take now and sends it before the next one', async () => {
    vi.mocked(backendApiClient.recordJobApplication).mockRejectedValueOnce(httpError(503));
    await reportApplication(report({ jobId: 'first' }));
    expect(sent).toHaveLength(0);
    expect(storageData[PENDING_APPLICATION_REPORTS_KEY]).toHaveLength(1);

    await reportApplication(report({ jobId: 'second', platform: 'indeed' }));
    expect(sent.map(p => p.jobId)).toEqual(['first', 'second']);
    expect(storageData[PENDING_APPLICATION_REPORTS_KEY]).toEqual([]);
  });

  it('drops a report the backend rejects as invalid instead of retrying it forever', async () => {
    vi.mocked(backendApiClient.recordJobApplication).mockRejectedValueOnce(httpError(400));
    await reportApplication(report());
    expect(storageData[PENDING_APPLICATION_REPORTS_KEY]).toBeUndefined();
  });

  it('never lets a queued failure replace a queued verified submission of the same job', async () => {
    vi.mocked(backendApiClient.recordJobApplication).mockRejectedValue(httpError(503));
    await reportApplication(report({ status: 'APPLIED' }));
    await reportApplication(report({ status: 'FAILED', reason: 'later attempt' }));
    expect(storageData[PENDING_APPLICATION_REPORTS_KEY].map((q: any) => q.payload.status)).toEqual(['APPLIED']);

    await reportApplication(report({ jobId: 'other', status: 'FAILED' }));
    await reportApplication(report({ jobId: 'other', status: 'APPLIED' }));
    expect(
      storageData[PENDING_APPLICATION_REPORTS_KEY].map((q: any) => `${q.payload.jobId}:${q.payload.status}`),
    ).toEqual(['250925012345:APPLIED', 'other:APPLIED']);
  });

  it("never sends another account's queued reports", async () => {
    storageData[PENDING_APPLICATION_REPORTS_KEY] = [
      { uid: 'someone-else', payload: toApplicationPayload(report({ jobId: 'theirs' })), queuedAt: Date.now() },
      { uid: 'me', payload: toApplicationPayload(report({ jobId: 'mine' })), queuedAt: Date.now() },
    ];
    await retryPendingApplicationReports();
    expect(sent.map(p => p.jobId)).toEqual(['mine']);
    expect(storageData[PENDING_APPLICATION_REPORTS_KEY]).toEqual([]);
  });

  it('stops retrying at the first report the backend still cannot take, keeping the rest in order', async () => {
    storageData[PENDING_APPLICATION_REPORTS_KEY] = ['a', 'b', 'c'].map(jobId => ({
      uid: 'me',
      payload: toApplicationPayload(report({ jobId })),
      queuedAt: Date.now(),
    }));
    vi.mocked(backendApiClient.recordJobApplication)
      .mockImplementationOnce(async payload => {
        sent.push(payload);
        return { success: true } as any;
      })
      .mockRejectedValueOnce(Object.assign(new Error('offline'), { status: 503, code: 'NETWORK_ERROR' }));

    await retryPendingApplicationReports();
    expect(sent.map(p => p.jobId)).toEqual(['a']);
    expect(storageData[PENDING_APPLICATION_REPORTS_KEY].map((q: any) => q.payload.jobId)).toEqual(['b', 'c']);
  });

  it('pending reports are account data, wiped when another account signs in', () => {
    expect(ACCOUNT_DATA_STORAGE_KEYS).toContain(PENDING_APPLICATION_REPORTS_KEY);
  });
});
