import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type { BaseStorage } from '../base/types';

export interface ProcessedJobRecord {
  jobId: string;
  url: string;
  title: string;
  company: string;
  location?: string;
  platform?: 'linkedin' | 'naukri' | 'indeed' | string;
  status: 'applied' | 'skipped' | 'failed';
  reason?: string;
  fitScore?: number;
  creditsUsed: number;
  timestamp: number;
}

export interface ProcessedJobsData {
  appliedJobIds: string[];
  skippedJobIds: string[];
  records: ProcessedJobRecord[];
  /**
   * Negative cache: jobs that FAILED during processing, keyed by jobId, with the
   * failure reason and timestamp. Failed jobs are intentionally NOT part of the
   * applied/skipped sets so they can be retried — but only after the TTL expires.
   * This prevents every auto-apply run from re-burning credits on the same
   * deterministic failure (e.g. validation loop on a broken form).
   */
  failedJobs: Record<string, { reason?: string; timestamp: number }>;
  /**
   * Negative-cache schema version. Bump when a shipped fix changes failure
   * behavior (e.g. Easy Apply click / form-discovery fixes) so stale entries
   * recorded by older builds are invalidated instead of blocking re-tests for
   * the full 24h TTL.
   */
  failedJobsCacheVersion?: number;
}

/**
 * How long a failed job stays in the negative cache before it becomes eligible
 * for retry again. 24h is long enough to skip re-runs the same day but short
 * enough that a recruiter-side fix or profile update is honored the next day.
 */
export const FAILED_JOB_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Bump whenever a code change invalidates previously recorded failure reasons
 * (UI-mismatch fixes, click fixes, form-discovery fixes). Entries written by a
 * build with a different version are discarded on next read.
 */
export const NEGATIVE_CACHE_SCHEMA_VERSION = 1;

const DEFAULT_PROCESSED_JOBS: ProcessedJobsData = {
  appliedJobIds: [],
  skippedJobIds: [],
  records: [],
  failedJobs: {},
};

const storage = createStorage<ProcessedJobsData>('linkedin_processed_jobs', DEFAULT_PROCESSED_JOBS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

function pruneExpiredFailedJobs(data: ProcessedJobsData, now = Date.now()): ProcessedJobsData {
  let next: ProcessedJobsData = data;
  // Invalidate stale negative-cache entries written by older builds (pre-fix
  // failure reasons no longer describe current behavior).
  if ((data.failedJobsCacheVersion ?? 0) !== NEGATIVE_CACHE_SCHEMA_VERSION) {
    next = { ...data, failedJobs: {}, failedJobsCacheVersion: NEGATIVE_CACHE_SCHEMA_VERSION };
  }
  const entries = Object.entries(next.failedJobs || {});
  const kept = entries.filter(([, v]) => now - (v?.timestamp || 0) < FAILED_JOB_TTL_MS);
  if (kept.length === entries.length) return next;
  return {
    ...next,
    failedJobs: Object.fromEntries(kept),
  };
}

export type ProcessedJobsStorageType = BaseStorage<ProcessedJobsData> & {
  isJobProcessed: (
    jobId: string,
  ) => Promise<{ isProcessed: boolean; status?: 'applied' | 'skipped' | 'failed'; record?: ProcessedJobRecord }>;
  isJobRecentlyFailed: (jobId: string) => Promise<{ recentlyFailed: boolean; reason?: string; timestamp?: number }>;
  recordJob: (record: Omit<ProcessedJobRecord, 'timestamp'>) => Promise<ProcessedJobsData>;
  getAllRecords: () => Promise<ProcessedJobRecord[]>;
  clearRecords: () => Promise<void>;
};

export const processedJobsStore: ProcessedJobsStorageType = {
  ...storage,

  async isJobProcessed(jobId: string) {
    const data = (await storage.get()) || DEFAULT_PROCESSED_JOBS;
    const cleanId = String(jobId).trim();
    if (data.appliedJobIds.includes(cleanId)) {
      const record = data.records.find(r => r.jobId === cleanId);
      return { isProcessed: true, status: 'applied', record };
    }
    if (data.skippedJobIds.includes(cleanId)) {
      const record = data.records.find(r => r.jobId === cleanId);
      return { isProcessed: true, status: 'skipped', record };
    }
    return { isProcessed: false };
  },

  async isJobRecentlyFailed(jobId: string) {
    const raw = (await storage.get()) || DEFAULT_PROCESSED_JOBS;
    const data = pruneExpiredFailedJobs(raw);
    if (data !== raw) {
      await storage.set(data);
    }
    const entry = data.failedJobs?.[String(jobId).trim()];
    if (!entry) return { recentlyFailed: false };
    return { recentlyFailed: true, reason: entry.reason, timestamp: entry.timestamp };
  },

  async recordJob(record: Omit<ProcessedJobRecord, 'timestamp'>) {
    const raw = (await storage.get()) || DEFAULT_PROCESSED_JOBS;
    const data = pruneExpiredFailedJobs(raw);
    const cleanId = String(record.jobId).trim();
    const fullRecord: ProcessedJobRecord = {
      ...record,
      jobId: cleanId,
      timestamp: Date.now(),
    };

    const appliedSet = new Set(data.appliedJobIds);
    const skippedSet = new Set(data.skippedJobIds);
    const failedJobs: Record<string, { reason?: string; timestamp: number }> = { ...(data.failedJobs || {}) };

    if (record.status === 'applied') {
      appliedSet.add(cleanId);
      skippedSet.delete(cleanId);
      // A later success clears any prior negative-cache entry for this job.
      delete failedJobs[cleanId];
    } else if (record.status === 'skipped') {
      skippedSet.add(cleanId);
      // Permanent skip: also clear any negative-cache entry.
      delete failedJobs[cleanId];
    } else if (record.status === 'failed') {
      // Retryable failure: remember it for the TTL window so re-runs skip it.
      failedJobs[cleanId] = { reason: record.reason, timestamp: Date.now() };
    }

    const updatedRecords = [fullRecord, ...data.records.filter(r => r.jobId !== cleanId)].slice(0, 500);

    const updatedData: ProcessedJobsData = {
      appliedJobIds: Array.from(appliedSet),
      skippedJobIds: Array.from(skippedSet),
      records: updatedRecords,
      failedJobs,
      failedJobsCacheVersion: NEGATIVE_CACHE_SCHEMA_VERSION,
    };

    await storage.set(updatedData);
    return updatedData;
  },

  async getAllRecords() {
    const data = (await storage.get()) || DEFAULT_PROCESSED_JOBS;
    return data.records || [];
  },

  async clearRecords() {
    await storage.set(DEFAULT_PROCESSED_JOBS);
  },
};

export default processedJobsStore;
