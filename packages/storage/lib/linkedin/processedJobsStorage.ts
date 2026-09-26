import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type { BaseStorage } from '../base/types';

export interface ProcessedJobRecord {
  jobId: string;
  url: string;
  title: string;
  company: string;
  status: 'applied' | 'skipped' | 'failed';
  reason?: string;
  creditsUsed: number;
  timestamp: number;
}

export interface ProcessedJobsData {
  appliedJobIds: string[];
  skippedJobIds: string[];
  records: ProcessedJobRecord[];
}

const DEFAULT_PROCESSED_JOBS: ProcessedJobsData = {
  appliedJobIds: [],
  skippedJobIds: [],
  records: [],
};

const storage = createStorage<ProcessedJobsData>('linkedin_processed_jobs', DEFAULT_PROCESSED_JOBS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export type ProcessedJobsStorageType = BaseStorage<ProcessedJobsData> & {
  isJobProcessed: (
    jobId: string,
  ) => Promise<{ isProcessed: boolean; status?: 'applied' | 'skipped' | 'failed'; record?: ProcessedJobRecord }>;
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

  async recordJob(record: Omit<ProcessedJobRecord, 'timestamp'>) {
    const data = (await storage.get()) || DEFAULT_PROCESSED_JOBS;
    const cleanId = String(record.jobId).trim();
    const fullRecord: ProcessedJobRecord = {
      ...record,
      jobId: cleanId,
      timestamp: Date.now(),
    };

    const appliedSet = new Set(data.appliedJobIds);
    const skippedSet = new Set(data.skippedJobIds);

    if (record.status === 'applied') {
      appliedSet.add(cleanId);
      skippedSet.delete(cleanId);
    } else if (record.status === 'skipped') {
      skippedSet.add(cleanId);
    }

    const updatedRecords = [fullRecord, ...data.records.filter(r => r.jobId !== cleanId)].slice(0, 500);

    const updatedData: ProcessedJobsData = {
      appliedJobIds: Array.from(appliedSet),
      skippedJobIds: Array.from(skippedSet),
      records: updatedRecords,
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
