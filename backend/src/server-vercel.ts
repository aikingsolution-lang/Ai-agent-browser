import { createApp } from './app.js';
import { PlanSeedService } from './services/planSeed.service.js';
import { isRtdbAvailable } from './services/rtdb/client.js';

const app = createApp();

if (isRtdbAvailable()) {
  PlanSeedService.seedDefaultPlans().catch(() => {});
}

export default function handler(req: any, res: any) {
  const matchedPath = req.headers && (req.headers['x-matched-path'] || req.headers['x-forwarded-url']);
  if (matchedPath && (req.url === '/api/index' || req.url === '/api/index.js' || req.url === '/api')) {
    req.url = matchedPath;
  }
  return app(req, res);
}
