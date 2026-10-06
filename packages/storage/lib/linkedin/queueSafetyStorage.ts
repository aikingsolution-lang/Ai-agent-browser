import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type { BaseStorage } from '../base/types';

export interface PlatformPauseRecord {
  pausedUntilDate: string; // YYYY-MM-DD
  reason: string;
  timestamp: number;
}

export interface QueueSafetyData {
  /** Unlocks the queue only after at least one verified successful single-job application run */
  singleApplyVerified: boolean;
  /** Hard cap limit of applications processed per queue batch (default: 5, configurable) */
  maxQueueBatchSize: number;
  /** Platform-specific daily safety pauses (e.g. Indeed paused for the day due to Cloudflare verification) */
  platformPauses?: Record<string, PlatformPauseRecord>;
}

export const DEFAULT_QUEUE_SAFETY: QueueSafetyData = {
  singleApplyVerified: true,
  maxQueueBatchSize: 5,
  platformPauses: {},
};

const storage = createStorage<QueueSafetyData>('linkedin_queue_safety', DEFAULT_QUEUE_SAFETY, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export type QueueSafetyStorageType = BaseStorage<QueueSafetyData> & {
  isSingleApplyVerified: () => Promise<boolean>;
  setSingleApplyVerified: (verified: boolean) => Promise<void>;
  getMaxQueueBatchSize: () => Promise<number>;
  setMaxQueueBatchSize: (size: number) => Promise<void>;
  pausePlatformForToday: (platform: string, reason: string) => Promise<void>;
  getPlatformPause: (platform: string) => Promise<{ isPaused: boolean; reason?: string }>;
  clearPlatformPause: (platform: string) => Promise<void>;
};

export const queueSafetyStore: QueueSafetyStorageType = {
  ...storage,

  async isSingleApplyVerified(): Promise<boolean> {
    const data = await storage.get();
    return Boolean(data?.singleApplyVerified);
  },

  async setSingleApplyVerified(verified: boolean): Promise<void> {
    const data = (await storage.get()) || DEFAULT_QUEUE_SAFETY;
    await storage.set({
      ...data,
      singleApplyVerified: verified,
    });
  },

  async getMaxQueueBatchSize(): Promise<number> {
    const data = await storage.get();
    return data?.maxQueueBatchSize || 5;
  },

  async setMaxQueueBatchSize(size: number): Promise<void> {
    const data = (await storage.get()) || DEFAULT_QUEUE_SAFETY;
    await storage.set({
      ...data,
      maxQueueBatchSize: Math.max(1, size),
    });
  },

  async pausePlatformForToday(platform: string, reason: string): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    const data = (await storage.get()) || DEFAULT_QUEUE_SAFETY;
    const currentPauses = data.platformPauses || {};
    const existing = currentPauses[platform.toLowerCase()];
    if (existing && existing.pausedUntilDate === today) {
      return; // Already paused for today; preserve original record and timestamp
    }
    await storage.set({
      ...data,
      platformPauses: {
        ...currentPauses,
        [platform.toLowerCase()]: {
          pausedUntilDate: today,
          reason,
          timestamp: Date.now(),
        },
      },
    });
  },

  async getPlatformPause(platform: string): Promise<{ isPaused: boolean; reason?: string }> {
    const today = new Date().toISOString().split('T')[0];
    const data = (await storage.get()) || DEFAULT_QUEUE_SAFETY;
    const pauseInfo = data.platformPauses?.[platform.toLowerCase()];
    if (pauseInfo && pauseInfo.pausedUntilDate === today) {
      return { isPaused: true, reason: pauseInfo.reason };
    }
    return { isPaused: false };
  },

  async clearPlatformPause(platform: string): Promise<void> {
    const data = (await storage.get()) || DEFAULT_QUEUE_SAFETY;
    if (data.platformPauses && data.platformPauses[platform.toLowerCase()]) {
      const copy = { ...data.platformPauses };
      delete copy[platform.toLowerCase()];
      await storage.set({
        ...data,
        platformPauses: copy,
      });
    }
  },
};

export default queueSafetyStore;
