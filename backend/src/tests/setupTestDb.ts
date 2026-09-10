import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PlanSeedService } from '../services/planSeed.service.js';
import { User } from '../models/user.model.js';
import { Subscription } from '../models/subscription.model.js';
import { UserCreditBalance } from '../models/userCreditBalance.model.js';
import { CreditLedger } from '../models/creditLedger.model.js';
import { LlmUsageLog } from '../models/llmUsageLog.model.js';
import { WebhookLedger } from '../models/webhookLedger.model.js';
import { Plan } from '../models/plan.model.js';

export interface TestDbInstance {
  mongoServer: MongoMemoryServer;
  stop: () => Promise<void>;
  clearCollections: () => Promise<void>;
}

export function assertSafeTestDbUri(uri: string): void {
  const isAtlas = uri.includes('mongodb.net') || uri.includes('mongodb+srv://');
  if (isAtlas) {
    throw new Error(
      `FATAL SAFETY VIOLATION: Test runner attempted to connect to real Atlas/Production database URI: "${uri}". Tests MUST run isolated against MongoMemoryServer!`,
    );
  }
}

export async function setupTestDatabase(): Promise<TestDbInstance> {
  const mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();

  // Safety Assertion: Hard-fail if URI points to real Atlas database
  assertSafeTestDbUri(uri);

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  await mongoose.connect(uri);
  await PlanSeedService.seedDefaultPlans();

  const clearCollections = async () => {
    if (mongoose.connection.readyState !== 0) {
      await Promise.all([
        User.deleteMany({}),
        Subscription.deleteMany({}),
        UserCreditBalance.deleteMany({}),
        CreditLedger.deleteMany({}),
        LlmUsageLog.deleteMany({}),
        WebhookLedger.deleteMany({}),
      ]);
    }
  };

  const stop = async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoServer.stop();
  };

  return {
    mongoServer,
    stop,
    clearCollections,
  };
}
