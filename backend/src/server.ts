import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDatabase } from './config/database.js';
import { logger } from './utils/logger.js';
import { PlanSeedService } from './services/planSeed.service.js';
import { TrialService } from './services/trial.service.js';
import { TrialExpirationWorker } from './workers/trialExpiration.worker.js';

async function startServer(): Promise<void> {
  const app = createApp();

  const host = '0.0.0.0';
  const server = app.listen(env.PORT, host, async () => {
    logger.info(`🚀 NanoBrowser Backend running on ${host}:${env.PORT} [${env.NODE_ENV}]`);
    logger.info(`Health check available at http://localhost:${env.PORT}/api/v1/health`);

    // Connect DB and initialize trial engine
    const conn = await connectDatabase();
    if (conn) {
      try {
        await PlanSeedService.seedDefaultPlans();
        await TrialService.reconcileExpiredTrials();
        TrialExpirationWorker.start();
      } catch (err: any) {
        logger.error(`Error initializing trial engine startup tasks: ${err.message}`);
      }
    }
  });

  const handleShutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    TrialExpirationWorker.stop();
    server.close(async () => {
      logger.info('HTTP server closed.');
      try {
        const { default: mongoose } = await import('mongoose');
        await mongoose.connection.close();
        logger.info('MongoDB connection closed.');
      } catch (err: any) {
        logger.error(`Error closing database connection: ${err.message}`);
      }
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

startServer().catch(error => {
  logger.error(`Fatal error starting server: ${error.message}`);
  process.exit(1);
});
