/**
 * LinkedIn Easy Apply — Rate Limiter & Daily Quota Manager
 *
 * Enforces daily application limits (default 15/day).
 * Automatically schedules next-day resumption via chrome.alarms when limits are hit.
 */

import { createStorage } from '@extension/storage/lib/base/base';
import { StorageEnum } from '@extension/storage/lib/base/enums';
import { createLogger } from '@src/background/log';

const logger = createLogger('LinkedInRateLimiter');

export interface DailyQuotaData {
  dateString: string; // YYYY-MM-DD
  appliedCount: number;
  maxDailyQuota: number;
  isPausedDueToQuota: boolean;
  nextResumeTimestamp: number | null;
}

const DEFAULT_QUOTA_DATA: DailyQuotaData = {
  dateString: new Date().toISOString().split('T')[0],
  appliedCount: 0,
  maxDailyQuota: 15, // Default 15 applications per day
  isPausedDueToQuota: false,
  nextResumeTimestamp: null,
};

const quotaStorage = createStorage<DailyQuotaData>('linkedin_daily_quota', DEFAULT_QUOTA_DATA, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const DAILY_RESUME_ALARM_NAME = 'linkedin_daily_quota_resume';

export class DailyQuotaManager {
  /**
   * Returns current day string formatted as YYYY-MM-DD.
   */
  private static getTodayString(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Retrieves active quota data, automatically resetting counts if the calendar date changed.
   */
  static async getQuotaData(): Promise<DailyQuotaData> {
    const today = this.getTodayString();
    const data = (await quotaStorage.get()) || DEFAULT_QUOTA_DATA;

    if (data.dateString !== today) {
      // New day: Reset counter
      const freshData: DailyQuotaData = {
        ...data,
        dateString: today,
        appliedCount: 0,
        isPausedDueToQuota: false,
        nextResumeTimestamp: null,
      };
      await quotaStorage.set(freshData);
      return freshData;
    }

    return data;
  }

  /**
   * Checks whether the user can perform an application today.
   */
  static async canApplyToday(): Promise<{ allowed: boolean; remaining: number; currentCount: number }> {
    const data = await this.getQuotaData();
    const remaining = Math.max(0, data.maxDailyQuota - data.appliedCount);
    const allowed = remaining > 0 && !data.isPausedDueToQuota;

    return {
      allowed,
      remaining,
      currentCount: data.appliedCount,
    };
  }

  /**
   * Increments the daily applied counter.
   */
  static async incrementAppliedCount(): Promise<DailyQuotaData> {
    const data = await this.getQuotaData();
    const newCount = data.appliedCount + 1;
    const isLimitHit = newCount >= data.maxDailyQuota;

    let nextResume: number | null = null;
    if (isLimitHit) {
      // Calculate next day midnight timestamp
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0); // Resume at 9:00 AM next day
      nextResume = tomorrow.getTime();

      await this.scheduleNextDayAlarm(nextResume);
    }

    const updatedData: DailyQuotaData = {
      ...data,
      appliedCount: newCount,
      isPausedDueToQuota: isLimitHit,
      nextResumeTimestamp: nextResume,
    };

    await quotaStorage.set(updatedData);
    logger.info(
      `[RateLimiter] Incremented daily applications: ${newCount}/${data.maxDailyQuota}. Limit hit: ${isLimitHit}`,
    );

    return updatedData;
  }

  /**
   * Configures max daily limit.
   */
  static async setMaxDailyLimit(limit: number): Promise<void> {
    const data = await this.getQuotaData();
    await quotaStorage.set({
      ...data,
      maxDailyQuota: Math.max(1, limit),
    });
  }

  /**
   * Schedules a chrome alarm to automatically resume next day.
   */
  private static async scheduleNextDayAlarm(resumeTimestamp: number): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome.alarms) {
        await chrome.alarms.create(DAILY_RESUME_ALARM_NAME, {
          when: resumeTimestamp,
        });
        logger.info(
          `[RateLimiter] ⏰ Scheduled automatic resume alarm for: ${new Date(resumeTimestamp).toLocaleString()}`,
        );
      }
    } catch (err) {
      logger.warning('Failed to schedule chrome alarm:', err);
    }
  }
}
