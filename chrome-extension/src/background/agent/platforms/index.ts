// chrome-extension/src/background/agent/platforms/index.ts
import { platformRegistry } from './platformRegistry';
import { linkedinAdapter } from './linkedin/linkedinAdapter';
import { naukriAdapter } from './naukri/naukriAdapter';

// Register built-in adapters
platformRegistry.register(linkedinAdapter);
platformRegistry.register(naukriAdapter);

export * from './types';
export * from './platformRegistry';
export * from './linkedin/linkedinAdapter';
export * from './naukri/naukriAdapter';
