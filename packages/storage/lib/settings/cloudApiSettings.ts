import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import type {
  CloudApiSettingsConfig,
  ApiMode,
  SubscriptionPlan,
  CloudConfig,
  TeamConfig,
  TeamMember,
  StripeConfig,
} from './types';
import { API_MODE_KEY } from './keys';

export type CloudApiSettingsStorage = BaseStorage<CloudApiSettingsConfig> & {
  getSettings: () => Promise<CloudApiSettingsConfig>;
  updateSettings: (settings: Partial<CloudApiSettingsConfig>) => Promise<void>;
  setApiMode: (mode: ApiMode) => Promise<void>;
  updateSubscription: (subscription: Partial<SubscriptionPlan>) => Promise<void>;
  updateCloudConfig: (cloudConfig: Partial<CloudConfig>) => Promise<void>;
  incrementUsage: () => Promise<{ allowed: boolean; remaining: number }>;
  checkUsageLimit: () => Promise<{ allowed: boolean; count: number; limit: number; remaining: number }>;
  resetMonthlyUsage: () => Promise<void>;
  updateTeamConfig: (teamConfig: Partial<TeamConfig>) => Promise<void>;
  inviteTeamMember: (email: string, role: 'admin' | 'member') => Promise<TeamMember>;
  removeTeamMember: (memberId: string) => Promise<void>;
  updateStripeConfig: (stripeConfig: Partial<StripeConfig>) => Promise<void>;
};

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export const DEFAULT_CLOUD_API_SETTINGS: CloudApiSettingsConfig = {
  apiMode: 'free',
  subscription: {
    planId: 'free',
    status: 'active',
    billingInterval: 'monthly',
    renewalDate: Date.now() + ONE_MONTH_MS,
  },
  cloudConfig: {
    provider: 'aws',
    region: 'us-east-1',
    awsSecretName: 'nanobrowser-llm-keys', // default secret name
    awsAccessKeyId: '', // UI se input hoga
    awsSecretAccessKey: '', // UI se input hoga
  },
  usage: {
    taskCount: 0,
    taskLimit: 1000,
    resetTimestamp: Date.now() + ONE_MONTH_MS,
  },
  team: {
    teamName: 'My Automation Team',
    maxSeats: 10,
    licenseKey: 'NANO-TEAM-ENT-9948-2026-X8',
    members: [
      {
        id: 'member-owner-1',
        email: 'alex.morgan@company.com',
        role: 'owner',
        status: 'active',
        addedAt: Date.now() - 30 * 24 * 3600 * 1000,
      },
      {
        id: 'member-dev-2',
        email: 'dev.lead@company.com',
        role: 'admin',
        status: 'active',
        addedAt: Date.now() - 15 * 24 * 3600 * 1000,
      },
    ],
  },
  stripeConfig: {
    environment: 'sandbox',
    publishableKey: 'pk_test_51NanoBrowserBuiltInSecretKeySample2026',
    webhookSecret: 'whsec_sampleStripeWebhookSigningSecretKey',
    customerPortalUrl: 'https://billing.stripe.com/p/session/test_session_nano',
  },
};

const storage = createStorage<CloudApiSettingsConfig>(API_MODE_KEY, DEFAULT_CLOUD_API_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const cloudApiSettingsStore: CloudApiSettingsStorage = {
  ...storage,

  async getSettings() {
    const settings = await storage.get();
    const current = {
      ...DEFAULT_CLOUD_API_SETTINGS,
      ...settings,
    };

    // Auto-reset usage count if current time exceeds resetTimestamp
    if (Date.now() > current.usage.resetTimestamp) {
      current.usage = {
        taskCount: 0,
        taskLimit: current.usage.taskLimit || 1000,
        resetTimestamp: Date.now() + ONE_MONTH_MS,
      };
      await storage.set(current);
    }

    return current;
  },

  async updateSettings(settings: Partial<CloudApiSettingsConfig>) {
    const current = await this.getSettings();
    const updated = {
      ...current,
      ...settings,
    };
    await storage.set(updated);
  },

  async setApiMode(mode: ApiMode) {
    await this.updateSettings({ apiMode: mode });
  },

  async updateSubscription(subscription: Partial<SubscriptionPlan>) {
    const current = await this.getSettings();
    await storage.set({
      ...current,
      subscription: {
        ...current.subscription,
        ...subscription,
      },
    });
  },

  async updateCloudConfig(cloudConfig: Partial<CloudConfig>) {
    const current = await this.getSettings();
    await storage.set({
      ...current,
      cloudConfig: {
        ...current.cloudConfig,
        ...cloudConfig,
      },
    });
  },

  async checkUsageLimit() {
    const current = await this.getSettings();
    if (current.apiMode === 'free') {
      return { allowed: true, count: current.usage.taskCount, limit: Infinity, remaining: Infinity };
    }

    const count = current.usage.taskCount;
    const limit = current.usage.taskLimit || 1000;
    const remaining = Math.max(0, limit - count);
    const allowed = count < limit;

    return { allowed, count, limit, remaining };
  },

  async incrementUsage() {
    const current = await this.getSettings();

    if (current.apiMode === 'free') {
      return { allowed: true, remaining: Infinity };
    }

    const { allowed, count, limit } = await this.checkUsageLimit();
    if (!allowed) {
      return { allowed: false, remaining: 0 };
    }

    const newCount = count + 1;
    const remaining = limit - newCount;

    await storage.set({
      ...current,
      usage: {
        ...current.usage,
        taskCount: newCount,
      },
    });

    return { allowed: true, remaining };
  },

  async resetMonthlyUsage() {
    const current = await this.getSettings();
    await storage.set({
      ...current,
      usage: {
        ...current.usage,
        taskCount: 0,
        resetTimestamp: Date.now() + ONE_MONTH_MS,
      },
    });
  },

  async updateTeamConfig(teamConfig: Partial<TeamConfig>) {
    const current = await this.getSettings();
    await storage.set({
      ...current,
      team: {
        ...current.team,
        ...teamConfig,
      },
    });
  },

  async inviteTeamMember(email: string, role: 'admin' | 'member') {
    const current = await this.getSettings();
    const newMember: TeamMember = {
      id: `member-${Date.now().toString(36)}`,
      email,
      role,
      status: 'invited',
      addedAt: Date.now(),
    };

    const updatedMembers = [...current.team.members, newMember];
    await storage.set({
      ...current,
      team: {
        ...current.team,
        members: updatedMembers,
      },
    });

    return newMember;
  },

  async removeTeamMember(memberId: string) {
    const current = await this.getSettings();
    const updatedMembers = current.team.members.filter(m => m.id !== memberId);
    await storage.set({
      ...current,
      team: {
        ...current.team,
        members: updatedMembers,
      },
    });
  },

  async updateStripeConfig(stripeConfig: Partial<StripeConfig>) {
    const current = await this.getSettings();
    await storage.set({
      ...current,
      stripeConfig: {
        ...current.stripeConfig,
        ...stripeConfig,
      },
    });
  },
};
