import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type { BaseStorage } from '../base/types';

/**
 * Local copy of the daily application quota, for display only. The backend counts applications
 * and enforces the limit (GET /profile/quota, reserve/commit/release); nothing stored here can
 * allow an application, so clearing or editing it changes nothing but what is shown.
 */
export interface DailyQuotaData {
  /** UTC day (YYYY-MM-DD) the counters belong to. */
  dateString: string;
  appliedCount: number;
  maxDailyQuota: number;
  isPausedDueToQuota: boolean;
  nextResumeTimestamp: number | null;
  activePlanCode?: string;
  remaining?: number;
  reservedCount?: number;
  isPaid?: boolean;
  /** ISO time of the next reset (next UTC midnight). */
  resetsAt?: string;
  /** When this copy was last refreshed from the backend (ms). */
  syncedAt?: number;
}

/** Fields of the backend quota response used by the display copy. */
export interface ServerQuotaSnapshot {
  day: string;
  applied: number;
  reserved: number;
  limit: number;
  remaining: number;
  plan: string;
  isPaid: boolean;
  resetsAt: string;
}

const utcToday = () => new Date().toISOString().split('T')[0];

export const DEFAULT_DAILY_QUOTA: DailyQuotaData = {
  dateString: utcToday(),
  appliedCount: 0,
  maxDailyQuota: 10,
  isPausedDueToQuota: false,
  nextResumeTimestamp: null,
  activePlanCode: 'free',
};

const storage = createStorage<DailyQuotaData>('linkedin_daily_quota', DEFAULT_DAILY_QUOTA, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export type DailyQuotaStorageType = BaseStorage<DailyQuotaData> & {
  getQuotaData: () => Promise<DailyQuotaData>;
  applyServerQuota: (quota: ServerQuotaSnapshot) => Promise<DailyQuotaData>;
};

export const dailyQuotaStore: DailyQuotaStorageType = {
  ...storage,

  /** The last backend quota; after the UTC day changes, shows the new day as unused until refreshed. */
  async getQuotaData(): Promise<DailyQuotaData> {
    const data = (await storage.get()) || DEFAULT_DAILY_QUOTA;
    if (data.dateString === utcToday()) return data;
    return {
      ...data,
      dateString: utcToday(),
      appliedCount: 0,
      reservedCount: 0,
      remaining: data.maxDailyQuota,
      isPausedDueToQuota: false,
      nextResumeTimestamp: null,
    };
  },

  async applyServerQuota(quota: ServerQuotaSnapshot): Promise<DailyQuotaData> {
    const resetAt = Date.parse(quota.resetsAt);
    const next: DailyQuotaData = {
      dateString: quota.day,
      appliedCount: quota.applied,
      maxDailyQuota: quota.limit,
      remaining: quota.remaining,
      reservedCount: quota.reserved,
      activePlanCode: quota.plan,
      isPaid: quota.isPaid,
      resetsAt: quota.resetsAt,
      isPausedDueToQuota: quota.remaining <= 0,
      nextResumeTimestamp: quota.remaining <= 0 && Number.isFinite(resetAt) ? resetAt : null,
      syncedAt: Date.now(),
    };
    await storage.set(next);
    return next;
  },
};

export default dailyQuotaStore;
