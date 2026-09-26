/**
 * LinkedIn Easy Apply — QueueManager
 *
 * Orchestrates the autonomous job application pipeline:
 * 1. Collects harvested job URLs from Content Script (jobHarvester.ts).
 * 2. Persists & deduplicates jobs in Job Queue (packages/storage/lib/linkedin/jobQueue.ts).
 * 3. Execution Loop:
 *    - Pops jobs sequentially from pendingQueue.
 *    - Enforces Daily Quota (DailyQuotaManager).
 *    - Opens dedicated tab via BrowserContext.
 *    - Scans & applies via ApplicationEngine.
 *    - Closes tab upon completion.
 *    - Enforces anti-ban randomized delay (120s – 180s) between applications.
 * 4. Provides controls to Start, Stop, and Query queue status.
 */

import { createLogger } from '@src/background/log';
import type BrowserContext from '@src/background/browser/context';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { backendApiClient } from '@extension/shared';
import {
  jobQueueStore,
  type IQueuedJob,
  type IJobQueue,
  linkedInConfigStore,
  careerBrainStore,
  queueSafetyStore,
} from '@extension/storage';
import { ApplicationEngine } from './applicationEngine';
import { DailyQuotaManager } from './rateLimiter';
import type { IJobData } from './types';

const logger = createLogger('LinkedInQueueManager');

export interface QueueManagerOptions {
  /** Anti-ban delay range in ms [min, max]. Defaults to [5000, 10000] (5s - 10s) */
  delayRangeMs?: [number, number];
}

export class LinkedInQueueManager {
  private static instance: LinkedInQueueManager | null = null;
  private browserContext: BrowserContext | null = null;
  private engine: ApplicationEngine;
  private isProcessing: boolean = false;
  private abortController: AbortController | null = null;
  private delayRangeMs: [number, number] = [5_000, 10_000]; // 5s to 10s anti-ban delay
  private jobsProcessedThisRun: number = 0;

  private progressCallback: ((message: string, isError?: boolean) => void) | null = null;
  private agentApplyRunner: ((job: IQueuedJob) => Promise<{ status: string; message: string }>) | null = null;

  constructor(options?: QueueManagerOptions) {
    if (options?.delayRangeMs) {
      this.delayRangeMs = options.delayRangeMs;
    }
    this.engine = new ApplicationEngine();
  }

  public setAgentApplyRunner(runner: (job: IQueuedJob) => Promise<{ status: string; message: string }>): void {
    this.agentApplyRunner = runner;
  }

  public setProgressCallback(cb: (message: string, isError?: boolean) => void): void {
    this.progressCallback = cb;
  }

  private notifyProgress(message: string, isError: boolean = false): void {
    logger.info(`[QueueManager Progress] ${message}`);
    if (this.progressCallback) {
      try {
        this.progressCallback(message, isError);
      } catch {}
    }
  }

  public static getInstance(): LinkedInQueueManager {
    if (!LinkedInQueueManager.instance) {
      LinkedInQueueManager.instance = new LinkedInQueueManager();
    }
    return LinkedInQueueManager.instance;
  }

  public setBrowserContext(context: BrowserContext): void {
    this.browserContext = context;
  }

  public setModels(models: { llm?: BaseChatModel; visionLLM?: BaseChatModel }): void {
    this.engine.setModels(models);
  }

  public async enqueueHarvestedJobs(
    jobs: Array<{ id: string; url: string; title: string }>,
  ): Promise<{ addedCount: number; totalPending: number }> {
    logger.info(`[QueueManager] Receiving ${jobs.length} harvested jobs...`);
    const result = await jobQueueStore.addJobs(jobs);
    logger.info(`[QueueManager] Added ${result.addedCount} new jobs to queue. Total pending: ${result.totalPending}`);
    return result;
  }

  public async getQueueStatus(): Promise<IJobQueue> {
    return jobQueueStore.getQueue();
  }

  public async clearQueue(): Promise<void> {
    logger.info('[QueueManager] Clearing job queue...');
    if (this.isProcessing) {
      await this.stopQueue();
    }
    await jobQueueStore.clearQueue();
  }

  public async stopQueue(): Promise<void> {
    logger.info('[QueueManager] Stopping queue processing...');
    this.isProcessing = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    await jobQueueStore.setProcessing(false);
  }

  /** Alias for startQueue to provide semantic compatibility with autonomous engine triggers */
  public async startQueueProcessing(): Promise<void> {
    return this.startQueue();
  }

  public async startQueue(): Promise<void> {
    if (this.isProcessing) {
      logger.warning('[QueueManager] Queue is already actively processing.');
      return;
    }

    // Unlock Gate Enforcement: single application must be verified first
    const isVerified = await queueSafetyStore.isSingleApplyVerified();
    if (!isVerified) {
      const lockMsg = 'Complete one successful single application first to unlock the queue.';
      logger.warning(`[QueueManager] ${lockMsg}`);
      this.notifyProgress(`🛑 Queue locked: ${lockMsg}`, true);
      throw new Error(lockMsg);
    }

    if (!this.browserContext) {
      logger.error('[QueueManager] BrowserContext is not configured.');
      throw new Error('BrowserContext is required for QueueManager');
    }

    this.jobsProcessedThisRun = 0;
    this.isProcessing = true;
    this.abortController = new AbortController();
    await jobQueueStore.setProcessing(true);

    logger.info('[QueueManager] Starting LinkedIn Easy Apply Queue loop...');

    // Run processing loop asynchronously
    this.processQueueLoop().catch(err => {
      logger.error('[QueueManager] Fatal error in processQueueLoop:', err);
      this.stopQueue();
    });
  }

  private async processQueueLoop(): Promise<void> {
    while (this.isProcessing) {
      // 1. Hard Cap Enforcement (default 5 jobs per queue run, configurable)
      const maxBatch = await queueSafetyStore.getMaxQueueBatchSize();
      if (this.jobsProcessedThisRun >= maxBatch) {
        this.notifyProgress(
          `🛑 Queue batch cap reached (${this.jobsProcessedThisRun}/${maxBatch} jobs processed this run). Halting queue.`,
        );
        await this.stopQueue();
        break;
      }

      // 2. Daily Quota Enforcement (15 max per day)
      const quota = await DailyQuotaManager.canApplyToday();
      if (!quota.allowed) {
        this.notifyProgress(
          `🛑 Daily application quota reached (${quota.currentCount} applications today). Halting queue.`,
          true,
        );
        await this.stopQueue();
        break;
      }

      // 3. Credits Guard: check user has minimum 2 credits before attempting each job
      try {
        const balanceRes = await backendApiClient.getCreditsBalance().catch(() => null);
        if (balanceRes?.data?.remainingCredits !== undefined && balanceRes.data.remainingCredits < 2) {
          this.notifyProgress(
            `🛑 Insufficient credits: You have ${balanceRes.data.remainingCredits} credits remaining, but at least 2 credits are required to apply. Halting queue.`,
            true,
          );
          await this.stopQueue();
          break;
        }
      } catch (creditErr) {
        logger.warning('[QueueManager] Error verifying credit balance:', creditErr);
      }

      // 4. Fetch next pending job
      const job = await jobQueueStore.popNextJob();
      if (!job) {
        this.notifyProgress('🏁 All pending applications processed! Queue complete.');
        await this.stopQueue();
        break;
      }

      // 5. Process the job
      this.jobsProcessedThisRun++;
      this.notifyProgress(`📄 [Job ${this.jobsProcessedThisRun}/${maxBatch}] Opening & applying: "${job.title}"...`);
      const success = await this.processSingleJob(job);

      // 6. Stop on Failure: If any application in the queue fails, STOP whole queue immediately
      if (!success) {
        logger.info(`[QueueManager] Job "${job.title}" was not successful. Stopping entire queue immediately.`);
        await this.stopQueue();
        break;
      }

      // 7. Check if we should continue
      if (!this.isProcessing) break;
      const nextPending = await jobQueueStore.getNextPendingJob();
      if (!nextPending) {
        this.notifyProgress('🏁 All queued applications processed!');
        await this.stopQueue();
        break;
      }

      // 8. Anti-Ban Randomized Delay (30s - 90s)
      const minDelay = this.delayRangeMs[0];
      const maxDelay = this.delayRangeMs[1];
      const waitTime = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      const waitSeconds = Math.round(waitTime / 1000);

      this.notifyProgress(`⏳ Anti-Ban pacing: Pausing for ${waitSeconds}s before opening next job...`);
      const aborted = await this.interruptibleSleep(waitTime);
      if (aborted || !this.isProcessing) {
        logger.info('[QueueManager] Pacing delay aborted. Halting queue.');
        break;
      }
    }
  }

  private async processSingleJob(job: IQueuedJob): Promise<boolean> {
    logger.info(`[QueueManager] Processing Job: "${job.title}" [ID: ${job.id}] -> ${job.url}`);

    let tabId: number | null = null;

    try {
      this.notifyProgress(`🌐 Opening job page: "${job.title}"...`);

      // 1. Create dedicated tab for this job
      const tab = await chrome.tabs.create({ url: job.url, active: true });
      tabId = tab.id || null;

      if (!tabId) throw new Error('Failed to create tab for job.');

      // 2. Wait for page load completion (with 10s timeout)
      await new Promise<void>(resolve => {
        const listener = (tid: number, changeInfo: chrome.tabs.TabChangeInfo) => {
          if (tid === tabId && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 10000);
      });

      // 3. Inject content script
      await chrome.scripting
        .executeScript({
          target: { tabId },
          files: ['content/index.iife.js'],
        })
        .catch(() => {});

      // Wait 1.5s for dynamic SPA hydration
      await new Promise(r => setTimeout(r, 1500));

      // 4. Retrieve candidate profile from storage
      const careerBrain = await careerBrainStore.getCareerBrain();

      this.notifyProgress(`🔍 Running Easy Apply on "${job.title}"...`);

      // 5. Send direct application command to content script or invoke agent apply runner
      let result: { success: boolean; message: string; title: string };
      if (this.agentApplyRunner) {
        const agentRes = await this.agentApplyRunner(job);
        result = {
          success: agentRes.status === 'success',
          message: agentRes.message,
          title: job.title,
        };
      } else {
        result = await new Promise<{ success: boolean; message: string; title: string }>((resolve, reject) => {
          chrome.tabs.sendMessage(
            tabId!,
            {
              type: 'APPLY_CURRENT_JOB_DIRECT',
              profile: careerBrain,
            },
            response => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                resolve(response || { success: false, message: 'NO_RESPONSE', title: job.title });
              }
            },
          );
        });
      }

      // 6. Record status in JobQueue and handle outcome
      if (result.success) {
        // If agentApplyRunner was not used, increment daily quota here (agent runner already does so)
        if (!this.agentApplyRunner) {
          await DailyQuotaManager.incrementAppliedCount();
        }
        await jobQueueStore.markJobCompleted(job, 'APPLIED');
        this.notifyProgress(`🎉 Successfully applied to "${result.title || job.title}"!`);
        return true;
      } else if (result.message === 'SKIPPED_EXTERNAL_SITE') {
        await jobQueueStore.markJobCompleted(job, 'SKIPPED_EXTERNAL_SITE');
        this.notifyProgress(`⏩ Skipped "${job.title}" (External site or already applied)`);
        return true;
      } else {
        await jobQueueStore.markJobFailed(job, result.message);
        this.notifyProgress(`🛑 Queue stopped: Application failed for "${job.title}": ${result.message}`, true);
        return false;
      }
    } catch (err) {
      const errStr = err instanceof Error ? err.message : String(err);
      logger.error(`[QueueManager] Error while processing job ${job.id}:`, errStr);
      await jobQueueStore.markJobFailed(job, errStr);
      this.notifyProgress(`🛑 Queue stopped: Error processing "${job.title}": ${errStr}`, true);
      return false;
    } finally {
      // Close tab cleanly to prevent clutter and memory buildup
      if (tabId !== null) {
        try {
          await chrome.tabs.remove(tabId);
          logger.info(`[QueueManager] Tab ${tabId} closed successfully.`);
        } catch (e) {
          logger.warning(`[QueueManager] Could not close tab ${tabId}:`, e);
        }
      }
    }
  }

  private interruptibleSleep(ms: number): Promise<boolean> {
    return new Promise(resolve => {
      if (!this.abortController || this.abortController.signal.aborted) {
        resolve(true);
        return;
      }

      const timer = setTimeout(() => {
        resolve(false);
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        resolve(true);
      };

      this.abortController.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export const queueManager = LinkedInQueueManager.getInstance();
export default queueManager;
