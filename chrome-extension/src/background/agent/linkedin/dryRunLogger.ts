/**
 * LinkedIn Easy Apply — Dry-Run Logger
 *
 * Provides persistent logging infrastructure for Dry-Run mode.
 * Records all jobs that "would have been applied to", along with their
 * extracted details, screening questions/answers, fit scores, and timestamps,
 * without submitting real applications.
 */

import { createStorage } from '@extension/storage/lib/base/base';
import { StorageEnum } from '@extension/storage/lib/base/enums';
import { createLogger } from '@src/background/log';
import type { IJobData, IScreeningQuestion } from './types';

const logger = createLogger('LinkedInDryRunLogger');

export interface IDryRunRecord {
  id: string;
  jobData: IJobData;
  timestamp: number;
  wouldHaveApplied: boolean;
  fitScore?: number;
  screeningAnswers?: IScreeningQuestion[];
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

// Setup local storage wrapper with liveUpdate support
const dryRunStorage = createStorage<IDryRunRecord[]>(DRY_RUN_STORAGE_KEY, [], {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export class DryRunLogger {
  /**
   * Records a simulated / dry-run job application action.
   */
  async logDryRun(record: Omit<IDryRunRecord, 'id' | 'timestamp'>): Promise<IDryRunRecord> {
    const fullRecord: IDryRunRecord = {
      ...record,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };

    logger.info(
      `[DRY-RUN] Recording simulated application for "${record.jobData.title}" at "${record.jobData.company}". Would apply: ${record.wouldHaveApplied}`,
    );

    await dryRunStorage.set(prevRecords => [fullRecord, ...(prevRecords || [])]);
    return fullRecord;
  }

  /**
   * Retrieves all logged dry-run records.
   */
  async getDryRunHistory(): Promise<IDryRunRecord[]> {
    const records = await dryRunStorage.get();
    return records || [];
  }

  /**
   * Clears the dry-run application history.
   */
  async clearDryRunHistory(): Promise<void> {
    logger.info('[DRY-RUN] Clearing dry-run records.');
    await dryRunStorage.set([]);
  }

  /**
   * Generates summary statistics from all recorded dry-run attempts.
   */
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
  }
}

export const dryRunLogger = new DryRunLogger();
