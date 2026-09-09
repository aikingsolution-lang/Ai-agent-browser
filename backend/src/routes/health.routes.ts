import { Router } from 'express';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { checkDatabaseHealth } from '../config/database.js';

export const healthRouter: Router = Router();

// Liveness probe (GET /health and GET /health/live)
const livenessHandler = (_req: any, res: any) => {
  const uptimeSeconds = Math.floor(process.uptime());
  sendSuccess(
    res,
    {
      status: 'ok',
      service: 'nanobrowser-backend',
      version: '0.1.0',
      uptime: `${uptimeSeconds}s`,
    },
    'Service alive',
    200,
  );
};

healthRouter.get('/health', livenessHandler);
healthRouter.get('/health/live', livenessHandler);

// Readiness probe (GET /ready and GET /health/ready)
const readinessHandler = (_req: any, res: any) => {
  const dbHealth = checkDatabaseHealth();
  const uptimeSeconds = Math.floor(process.uptime());

  if (!dbHealth.isConnected) {
    sendError(res, 'Database dependency unavailable', 503, 'SERVICE_UNAVAILABLE', { database: dbHealth });
    return;
  }

  sendSuccess(
    res,
    {
      status: 'ready',
      service: 'nanobrowser-backend',
      version: '0.1.0',
      uptime: `${uptimeSeconds}s`,
      database: dbHealth,
    },
    'Service ready',
    200,
  );
};

healthRouter.get('/ready', readinessHandler);
healthRouter.get('/health/ready', readinessHandler);
