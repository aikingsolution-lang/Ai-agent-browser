import { z } from 'zod';
import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type { BaseStorage } from '../base/types';

export const queuedJobSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  addedAt: z.number().default(() => Date.now()),
});

export const completedJobSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  completedAt: z.number().default(() => Date.now()),
  status: z.string().default('APPLIED'),
});

export const failedJobSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  failedAt: z.number().default(() => Date.now()),
  error: z.string(),
});

export const jobQueueSchema = z.object({
  pendingJobs: z.array(queuedJobSchema).default([]),
  completedJobs: z.array(completedJobSchema).default([]),
  failedJobs: z.array(failedJobSchema).default([]),
  isProcessing: z.boolean().default(false),
  currentJobId: z.string().nullable().default(null),
  lastProcessedAt: z.number().nullable().default(null),
});

export type IQueuedJob = z.infer<typeof queuedJobSchema>;
export type ICompletedJob = z.infer<typeof completedJobSchema>;
export type IFailedJob = z.infer<typeof failedJobSchema>;
export type IJobQueue = z.infer<typeof jobQueueSchema>;

export const DEFAULT_JOB_QUEUE: IJobQueue = {
  pendingJobs: [],
  completedJobs: [],
  failedJobs: [],
  isProcessing: false,
  currentJobId: null,
  lastProcessedAt: null,
};

const storage = createStorage<IJobQueue>('linkedin_job_queue', DEFAULT_JOB_QUEUE, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export type JobQueueStorageType = BaseStorage<IJobQueue> & {
  getQueue: () => Promise<IJobQueue>;
  addJobs: (
    jobs: Array<{ id: string; url: string; title: string }>,
  ) => Promise<{ addedCount: number; totalPending: number }>;
  getNextPendingJob: () => Promise<IQueuedJob | null>;
  popNextJob: () => Promise<IQueuedJob | null>;
  markJobCompleted: (job: { id: string; url: string; title: string }, status?: string) => Promise<void>;
  markJobFailed: (job: { id: string; url: string; title: string }, error: string) => Promise<void>;
  setProcessing: (isProcessing: boolean, currentJobId?: string | null) => Promise<void>;
  clearQueue: () => Promise<void>;
  isJobInQueueOrProcessed: (jobId: string) => Promise<boolean>;
};

export const jobQueueStore: JobQueueStorageType = {
  ...storage,

  async getQueue(): Promise<IJobQueue> {
    const raw = await storage.get();
    if (!raw) return DEFAULT_JOB_QUEUE;
    const parsed = jobQueueSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data;
    }
    return DEFAULT_JOB_QUEUE;
  },

  async addJobs(
    jobs: Array<{ id: string; url: string; title: string }>,
  ): Promise<{ addedCount: number; totalPending: number }> {
    const queue = await this.getQueue();
    const existingIds = new Set([
      ...queue.pendingJobs.map(j => j.id),
      ...queue.completedJobs.map(j => j.id),
      ...queue.failedJobs.map(j => j.id),
    ]);

    const newJobs: IQueuedJob[] = [];
    for (const job of jobs) {
      if (!existingIds.has(job.id)) {
        existingIds.add(job.id);
        newJobs.push({
          id: job.id,
          url: job.url,
          title: job.title,
          addedAt: Date.now(),
        });
      }
    }

    const updatedQueue: IJobQueue = {
      ...queue,
      pendingJobs: [...queue.pendingJobs, ...newJobs],
    };

    await storage.set(updatedQueue);
    return {
      addedCount: newJobs.length,
      totalPending: updatedQueue.pendingJobs.length,
    };
  },

  async getNextPendingJob(): Promise<IQueuedJob | null> {
    const queue = await this.getQueue();
    return queue.pendingJobs.length > 0 ? queue.pendingJobs[0] : null;
  },

  async popNextJob(): Promise<IQueuedJob | null> {
    const queue = await this.getQueue();
    if (queue.pendingJobs.length === 0) return null;

    const [nextJob, ...remainingJobs] = queue.pendingJobs;
    const updatedQueue: IJobQueue = {
      ...queue,
      pendingJobs: remainingJobs,
      currentJobId: nextJob.id,
    };

    await storage.set(updatedQueue);
    return nextJob;
  },

  async markJobCompleted(job: { id: string; url: string; title: string }, status: string = 'APPLIED'): Promise<void> {
    const queue = await this.getQueue();
    const updatedQueue: IJobQueue = {
      ...queue,
      pendingJobs: queue.pendingJobs.filter(j => j.id !== job.id),
      completedJobs: [
        ...queue.completedJobs.filter(j => j.id !== job.id),
        {
          id: job.id,
          url: job.url,
          title: job.title,
          completedAt: Date.now(),
          status,
        },
      ],
      currentJobId: queue.currentJobId === job.id ? null : queue.currentJobId,
      lastProcessedAt: Date.now(),
    };

    await storage.set(updatedQueue);
  },

  async markJobFailed(job: { id: string; url: string; title: string }, error: string): Promise<void> {
    const queue = await this.getQueue();
    const updatedQueue: IJobQueue = {
      ...queue,
      pendingJobs: queue.pendingJobs.filter(j => j.id !== job.id),
      failedJobs: [
        ...queue.failedJobs.filter(j => j.id !== job.id),
        {
          id: job.id,
          url: job.url,
          title: job.title,
          failedAt: Date.now(),
          error,
        },
      ],
      currentJobId: queue.currentJobId === job.id ? null : queue.currentJobId,
      lastProcessedAt: Date.now(),
    };

    await storage.set(updatedQueue);
  },

  async setProcessing(isProcessing: boolean, currentJobId: string | null = null): Promise<void> {
    const queue = await this.getQueue();
    await storage.set({
      ...queue,
      isProcessing,
      currentJobId: isProcessing ? (currentJobId ?? queue.currentJobId) : null,
    });
  },

  async clearQueue(): Promise<void> {
    await storage.set(DEFAULT_JOB_QUEUE);
  },

  async isJobInQueueOrProcessed(jobId: string): Promise<boolean> {
    const queue = await this.getQueue();
    return (
      queue.pendingJobs.some(j => j.id === jobId) ||
      queue.completedJobs.some(j => j.id === jobId) ||
      queue.failedJobs.some(j => j.id === jobId)
    );
  },
};

export default jobQueueStore;
