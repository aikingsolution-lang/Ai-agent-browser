import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type { BaseStorage } from '../base/types';

export interface DailyQuotaData {
  dateString: string;
  appliedCount: number;
  maxDailyQuota: number;
  isPausedDueToQuota: boolean;
  nextResumeTimestamp: number | null;
}

export const DEFAULT_DAILY_QUOTA: DailyQuotaData = {
  dateString: new Date().toISOString().split('T')[0],
  appliedCount: 0,
  maxDailyQuota: 15,
  isPausedDueToQuota: false,
  nextResumeTimestamp: null,
};

const storage = createStorage<DailyQuotaData>('linkedin_daily_quota', DEFAULT_DAILY_QUOTA, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export type DailyQuotaStorageType = BaseStorage<DailyQuotaData> & {
  getQuotaData: () => Promise<DailyQuotaData>;
  canApplyToday: () => Promise<{ allowed: boolean; remaining: number; currentCount: number }>;
  incrementAppliedCount: () => Promise<DailyQuotaData>;
  setMaxDailyLimit: (limit: number) => Promise<void>;
};

export const dailyQuotaStore: DailyQuotaStorageType = {
  ...storage,

  async getQuotaData(): Promise<DailyQuotaData> {
    const today = new Date().toISOString().split('T')[0];
    const data = (await storage.get()) || DEFAULT_DAILY_QUOTA;

    if (data.dateString !== today) {
      const freshData: DailyQuotaData = {
        ...data,
        dateString: today,
        appliedCount: 0,
        isPausedDueToQuota: false,
        nextResumeTimestamp: null,
      };
      await storage.set(freshData);
      return freshData;
    }

    return data;
  },

  async canApplyToday(): Promise<{ allowed: boolean; remaining: number; currentCount: number }> {
    const data = await this.getQuotaData();
    const remaining = Math.max(0, data.maxDailyQuota - data.appliedCount);
    const allowed = remaining > 0 && !data.isPausedDueToQuota;

    return {
      allowed,
      remaining,
      currentCount: data.appliedCount,
    };
  },

  async incrementAppliedCount(): Promise<DailyQuotaData> {
    const data = await this.getQuotaData();
    const newCount = data.appliedCount + 1;
    const isLimitHit = newCount >= data.maxDailyQuota;

    let nextResume: number | null = null;
    if (isLimitHit) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      nextResume = tomorrow.getTime();
    }

    const updatedData: DailyQuotaData = {
      ...data,
      appliedCount: newCount,
      isPausedDueToQuota: isLimitHit,
      nextResumeTimestamp: nextResume,
    };

    await storage.set(updatedData);
    return updatedData;
  },

  async setMaxDailyLimit(limit: number): Promise<void> {
    const data = await this.getQuotaData();
    await storage.set({
      ...data,
      maxDailyQuota: Math.max(1, limit),
    });
  },
};

export default dailyQuotaStore;
