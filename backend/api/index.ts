import { createApp } from '../src/app.js';
import { PlanSeedService } from '../src/services/planSeed.service.js';
import { isRtdbAvailable } from '../src/services/rtdb/client.js';

const app = createApp();

// Lazy startup tasks (seed default plans if RTDB configured)
if (isRtdbAvailable()) {
  PlanSeedService.seedDefaultPlans().catch(() => {});
}

export default app;
