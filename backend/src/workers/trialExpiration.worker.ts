import cron, { ScheduledTask } from 'node-cron';
import { TrialService } from '../services/trial.service.js';
import { logger } from '../utils/logger.js';

export class TrialExpirationWorker {
  private static task: ScheduledTask | null = null;
  private static isProcessing = false;

  /**
   * Starts the background cron worker running every 15 minutes.
   */
  public static start(): void {
    if (this.task) {
      logger.warn('Trial expiration background worker is already running');
      return;
    }

    this.task = cron.schedule('*/15 * * * *', async () => {
      if (this.isProcessing) {
        logger.info('Previous trial expiration run still in progress, skipping overlap');
        return;
      }

      this.isProcessing = true;
      try {
        const count = await TrialService.reconcileExpiredTrials();
        if (count > 0) {
          logger.info(`Cron worker: Expired ${count} trial subscription(s)`);
        }
      } catch (error: any) {
        logger.error(`Error in trial expiration cron worker: ${error.message}`);
      } finally {
        this.isProcessing = false;
      }
    });

    logger.info('⏰ Trial expiration background cron worker initialized (schedule: every 15m)');
  }

  /**
   * Stops the background cron worker gracefully.
   */
  public static stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
      logger.info('Trial expiration background cron worker stopped');
    }
  }
}
