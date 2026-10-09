import { Router } from 'express';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { hasAdminCredentials } from '../config/firebase-admin.js';
import { isRtdbAvailable, pingRtdb, RTDB_ROOT } from '../services/rtdb/client.js';

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
// Ready when Firebase Realtime Database answers a real read (bounded by a timeout).
const readinessHandler = async (_req: any, res: any) => {
  const uptimeSeconds = Math.floor(process.uptime());

  if (!isRtdbAvailable()) {
    sendError(res, 'Database dependency unavailable', 503, 'SERVICE_UNAVAILABLE', {
      database: { provider: 'firebase-rtdb', isConnected: false, state: 'not_configured' },
    });
    return;
  }

  const ping = await pingRtdb();
  const database = {
    provider: 'firebase-rtdb',
    namespace: RTDB_ROOT,
    isConnected: ping.ok,
    state: ping.ok ? 'connected' : 'unreachable',
    latencyMs: ping.latencyMs,
    hasServiceAccount: hasAdminCredentials(),
  };

  if (!ping.ok) {
    sendError(res, 'Database dependency unavailable', 503, 'SERVICE_UNAVAILABLE', { database });
    return;
  }

  sendSuccess(
    res,
    {
      status: 'ready',
      service: 'nanobrowser-backend',
      version: '0.1.0',
      uptime: `${uptimeSeconds}s`,
      database,
    },
    'Service ready',
    200,
  );
};

healthRouter.get('/ready', readinessHandler);
healthRouter.get('/health/ready', readinessHandler);
