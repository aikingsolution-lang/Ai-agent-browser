import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type { BaseStorage } from '../base/types';

export interface IDryRunRecord {
  id: string;
  jobData: {
    url: string;
    jobId: string;
    title: string;
    company: string;
    location: string;
    salaryRange: string;
    description: string;
    jobType: string;
    experienceLevel: string;
    isEasyApply: boolean;
  };
  timestamp: number;
  wouldHaveApplied: boolean;
  fitScore?: number;
  screeningAnswers?: Array<{
    questionId: string;
    questionText: string;
    questionType: string;
    required: boolean;
    options: string[];
    userAnswer: string | null;
  }>;
  blockedReason?: string;
  notes?: string;
}

export interface IDryRunStats {
  totalLogged: number;
  eligibleCount: number;
  blockedCount: number;
  avgFitScore: number;
  lastRunTimestamp: number | null;
}

const DRY_RUN_STORAGE_KEY = 'linkedin_dry_run_records';

const dryRunStorage = createStorage<IDryRunRecord[]>(DRY_RUN_STORAGE_KEY, [], {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export type DryRunStorageType = BaseStorage<IDryRunRecord[]> & {
  logDryRun: (record: Omit<IDryRunRecord, 'id' | 'timestamp'>) => Promise<IDryRunRecord>;
  getDryRunHistory: () => Promise<IDryRunRecord[]>;
  clearDryRunHistory: () => Promise<void>;
  getDryRunStats: () => Promise<IDryRunStats>;
};

export const dryRunStore: DryRunStorageType = {
  ...dryRunStorage,

  async logDryRun(record: Omit<IDryRunRecord, 'id' | 'timestamp'>): Promise<IDryRunRecord> {
    const fullRecord: IDryRunRecord = {
      ...record,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    await dryRunStorage.set(prev => [fullRecord, ...(prev || [])]);
    return fullRecord;
  },

  async getDryRunHistory(): Promise<IDryRunRecord[]> {
    const records = await dryRunStorage.get();
    return records || [];
  },

  async clearDryRunHistory(): Promise<void> {
    await dryRunStorage.set([]);
  },

  async getDryRunStats(): Promise<IDryRunStats> {
    const records = await this.getDryRunHistory();
    const totalLogged = records.length;
    const eligibleCount = records.filter(r => r.wouldHaveApplied).length;
    const blockedCount = totalLogged - eligibleCount;

    const scores = records.map(r => r.fitScore).filter((s): s is number => typeof s === 'number' && !isNaN(s));

    const avgFitScore = scores.length > 0 ? Math.round(scores.reduce((sum, val) => sum + val, 0) / scores.length) : 0;

    const lastRunTimestamp = records.length > 0 ? records[0].timestamp : null;

    return {
      totalLogged,
      eligibleCount,
      blockedCount,
      avgFitScore,
      lastRunTimestamp,
    };
  },
};

export default dryRunStore;
