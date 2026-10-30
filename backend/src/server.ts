import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { PlanSeedService } from './services/planSeed.service.js';
import { TrialService } from './services/trial.service.js';
import { TrialExpirationWorker } from './workers/trialExpiration.worker.js';
import { isRtdbAvailable, RTDB_ROOT } from './services/rtdb/client.js';
import { LlmProviderFactory } from './services/llm/llmProviderFactory.js';

async function startServer(): Promise<void> {
  // Validate LLM provider configuration at startup
  try {
    LlmProviderFactory.validateConfiguration();
    logger.info(`LLM Provider configured: ${env.LLM_PROVIDER} (default model: ${env.LLM_DEFAULT_MODEL})`);
  } catch (err: any) {
    logger.error(`Fatal LLM configuration error at startup: ${err.message}`);
    process.exit(1);
  }

  const app = createApp();

  const host = '0.0.0.0';
  const server = app.listen(env.PORT, host, async () => {
    logger.info(`🚀 NanoBrowser Backend running on ${host}:${env.PORT} [${env.NODE_ENV}]`);
    logger.info(`Health check available at http://localhost:${env.PORT}/api/v1/health`);

    // Firebase Admin connects lazily on first use; there is no connection to open here.
    if (isRtdbAvailable()) {
      logger.info(`Firebase Realtime Database namespace: /${RTDB_ROOT}`);
      try {
        await PlanSeedService.seedDefaultPlans();
        await TrialService.reconcileExpiredTrials();
        TrialExpirationWorker.start();
      } catch (err: any) {
        logger.error(`Error initializing trial engine startup tasks: ${err.message}`);
      }
    } else {
      logger.warn(
        '⚠️  Firebase Realtime Database not configured — startup tasks skipped. Set FIREBASE_PROJECT_ID, ' +
          'FIREBASE_ADMIN_CLIENT_EMAIL, FIREBASE_ADMIN_PRIVATE_KEY and FIREBASE_DATABASE_URL.',
      );
    }
  });

  const handleShutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    TrialExpirationWorker.stop();
    server.close(() => {
      logger.info('HTTP server closed.');
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
