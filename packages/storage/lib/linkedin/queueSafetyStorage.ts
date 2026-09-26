import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type { BaseStorage } from '../base/types';

export interface QueueSafetyData {
  /** Unlocks the queue only after at least one verified successful single-job application run */
  singleApplyVerified: boolean;
  /** Hard cap limit of applications processed per queue batch (default: 5, configurable) */
  maxQueueBatchSize: number;
}

export const DEFAULT_QUEUE_SAFETY: QueueSafetyData = {
  singleApplyVerified: true,
  maxQueueBatchSize: 5,
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
};

export default queueSafetyStore;
