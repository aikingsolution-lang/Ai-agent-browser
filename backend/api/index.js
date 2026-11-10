import { createApp } from '../dist/app.js';
import { PlanSeedService } from '../dist/services/planSeed.service.js';
import { isRtdbAvailable } from '../dist/services/rtdb/client.js';

const app = createApp();

if (isRtdbAvailable()) {
  PlanSeedService.seedDefaultPlans().catch(() => {});
}

export default function handler(req, res) {
  const matchedPath = req.headers && (req.headers['x-matched-path'] || req.headers['x-forwarded-url']);
  if (matchedPath && (req.url === '/api/index' || req.url === '/api/index.js' || req.url === '/api')) {
    req.url = matchedPath;
  }
  return app(req, res);
}
