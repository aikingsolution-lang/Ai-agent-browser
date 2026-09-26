import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type { BaseStorage } from '../base/types';

export interface ActiveJobRunnerState {
  runId: string;
  jobId: string;
  canonicalUrl: string;
  jobTitle?: string;
  company?: string;
  location?: string;
  dedicatedWindowId?: number;
  dedicatedTabId?: number;
  step: number;
  status: 'starting' | 'navigating' | 'waiting_login' | 'running' | 'completed' | 'failed' | 'interrupted' | 'skipped';
  startTime: number;
  lastUpdated: number;
  creditsDeducted?: number;
  errorReason?: string;
}

export interface RunnerStateData {
  activeRun: ActiveJobRunnerState | null;
}

const DEFAULT_RUNNER_STATE: RunnerStateData = {
  activeRun: null,
};

const storage = createStorage<RunnerStateData>('job_runner_state', DEFAULT_RUNNER_STATE, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export type RunnerStateStorageType = BaseStorage<RunnerStateData> & {
  getActiveRun: () => Promise<ActiveJobRunnerState | null>;
  setActiveRun: (run: ActiveJobRunnerState | null) => Promise<void>;
  updateRunStep: (step: number) => Promise<void>;
  updateRunStatus: (status: ActiveJobRunnerState['status'], extra?: Partial<ActiveJobRunnerState>) => Promise<void>;
  clearActiveRun: () => Promise<void>;
};

export const runnerStateStore: RunnerStateStorageType = {
  ...storage,

  async getActiveRun() {
    const data = (await storage.get()) || DEFAULT_RUNNER_STATE;
    return data.activeRun;
  },

  async setActiveRun(run) {
    await storage.set({ activeRun: run });
  },

  async updateRunStep(step) {
    const data = (await storage.get()) || DEFAULT_RUNNER_STATE;
    if (data.activeRun) {
      await storage.set({
        activeRun: {
          ...data.activeRun,
          step,
          lastUpdated: Date.now(),
        },
      });
    }
  },

  async updateRunStatus(status, extra) {
    const data = (await storage.get()) || DEFAULT_RUNNER_STATE;
    if (data.activeRun) {
      await storage.set({
        activeRun: {
          ...data.activeRun,
          status,
          ...(extra || {}),
          lastUpdated: Date.now(),
        },
      });
    }
  },

  async clearActiveRun() {
    await storage.set({ activeRun: null });
  },
};

export default runnerStateStore;
