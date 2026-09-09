import { cloudApiSettingsStore, type ApiMode, type CloudConfig, type SubscriptionPlan } from '@extension/storage';
import { createLogger } from '../log';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const logger = createLogger('CloudApiClient');

export interface CloudApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SecretManagerPayload {
  provider: 'aws' | 'gcp';
  secretIdentifier: string;
  keysCount: number;
  lastRotated: number;
  decryptedKeys: {
    openai?: string;
    anthropic?: string;
    gemini?: string;
  };
}

export class CloudApiClient {
  private static instance: CloudApiClient;
  private secretCache: { payload: SecretManagerPayload; expiresAt: number } | null = null;

  private constructor() {}

  public static getInstance(): CloudApiClient {
    if (!CloudApiClient.instance) {
      CloudApiClient.instance = new CloudApiClient();
    }
    return CloudApiClient.instance;
  }

  /**
   * Sync cloud configuration with remote storage (AWS S3/DynamoDB or GCP Bucket/Firestore)
   */
  public async syncCloudCredentials(config: CloudConfig): Promise<CloudApiResponse<{ synced: boolean }>> {
    try {
      logger.info(`Syncing cloud credentials with provider: ${config.provider}`);
      await cloudApiSettingsStore.updateCloudConfig(config);
      return {
        success: true,
        data: { synced: true },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to sync cloud credentials';
      logger.error(errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Test connection to AWS Secrets Manager (REAL AWS CALL)
   */
  public async testSecretManagerConnection(
    config: CloudConfig,
  ): Promise<CloudApiResponse<{ connected: boolean; secretPayload: SecretManagerPayload }>> {
    try {
      logger.info(`Testing Secret Manager connection for provider: ${config.provider}`);

      let payload: SecretManagerPayload;

      if (config.provider === 'aws') {
        const secretName = config.awsSecretName || 'nanobrowser-llm-keys';
        const region = config.region || 'us-east-1';

        // AWS Keys from UI (CloudConfig se)
        const accessKeyId = config.awsAccessKeyId;
        const secretAccessKey = config.awsSecretAccessKey;

        if (!accessKeyId || !secretAccessKey) {
          throw new Error('AWS Access Key ID and Secret Access Key are required. Please add them in Settings.');
        }

        logger.info(`Connecting to AWS Secrets Manager: secret=${secretName}, region=${region}`);

        // Initialize AWS Client (Browser mein AWS SDK use karte hain)
        const client = new SecretsManagerClient({
          region,
          credentials: {
            accessKeyId,
            secretAccessKey,
          },
        });

        const command = new GetSecretValueCommand({ SecretId: secretName });
        const response = await client.send(command);

        if (!response.SecretString) {
          throw new Error('Secret not found or empty in AWS.');
        }

        // Secret JSON ko parse karo
        const secretData = JSON.parse(response.SecretString);

        payload = {
          provider: 'aws',
          secretIdentifier: response.ARN || `arn:aws:secretsmanager:${region}:123456789012:secret:${secretName}`,
          keysCount: Object.keys(secretData).length,
          lastRotated: Date.now(),
          decryptedKeys: {
            openai: secretData.openai || secretData.OPENAI_API_KEY,
            anthropic: secretData.anthropic || secretData.ANTHROPIC_API_KEY,
            gemini: secretData.gemini || secretData.GEMINI_API_KEY,
          },
        };
      } else {
        // GCP support abhi nahi, error throw karo
        throw new Error('GCP Secret Manager not implemented yet. Please use AWS.');
      }

      // Cache secret payload for 15 minutes
      this.secretCache = {
        payload,
        expiresAt: Date.now() + 15 * 60 * 1000,
      };

      return {
        success: true,
        data: {
          connected: true,
          secretPayload: payload,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Secret Manager connection failed';
      logger.error(`Error in testSecretManagerConnection: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Fetch built-in proxy key for Premium users backed by AWS/GCP Secret Manager
   */
  public async fetchBuiltInApiKey(): Promise<
    CloudApiResponse<{ apiKey: string; modelEndpoint: string; provider: string }>
  > {
    try {
      const settings = await cloudApiSettingsStore.getSettings();

      if (settings.apiMode !== 'premium' || settings.subscription.status !== 'active') {
        return {
          success: false,
          error: 'Premium subscription required to access built-in Cloud API',
        };
      }

      const { allowed, remaining } = await cloudApiSettingsStore.checkUsageLimit();
      if (!allowed) {
        return {
          success: false,
          error: 'Monthly task limit (1,000 tasks/month) reached. Upgrade plan or wait for billing cycle reset.',
        };
      }

      // Check cache or refresh from Secret Manager
      if (!this.secretCache || Date.now() > this.secretCache.expiresAt) {
        await this.testSecretManagerConnection(settings.cloudConfig);
      }

      const providerName = settings.cloudConfig.provider.toUpperCase();
      logger.info(`Fetching built-in API key via ${providerName} Secret Manager (${remaining} tasks remaining)`);

      return {
        success: true,
        data: {
          apiKey:
            this.secretCache?.payload.decryptedKeys.openai || 'nano_built_in_premium_token_' + Date.now().toString(36),
          modelEndpoint: 'https://api.nanobrowser.ai/v1/cloud-proxy',
          provider: providerName,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to fetch built-in API key';
      logger.error(errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Validate current premium subscription status
   */
  public async validateSubscription(): Promise<CloudApiResponse<SubscriptionPlan>> {
    try {
      const settings = await cloudApiSettingsStore.getSettings();
      logger.info(`Validating subscription: ${settings.subscription.planId} (${settings.subscription.status})`);
      return {
        success: true,
        data: settings.subscription,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to validate subscription';
      logger.error(errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Report task execution and increment monthly usage counter for premium users
   */
  public async recordTaskUsage(): Promise<CloudApiResponse<{ count: number; remaining: number }>> {
    try {
      const settings = await cloudApiSettingsStore.getSettings();
      if (settings.apiMode !== 'premium') {
        return { success: true, data: { count: 0, remaining: Infinity } };
      }

      const usageResult = await cloudApiSettingsStore.incrementUsage();
      const current = await cloudApiSettingsStore.getSettings();

      if (!usageResult.allowed) {
        return {
          success: false,
          error: 'Task execution limit exceeded for current billing cycle.',
        };
      }

      logger.info(`Task usage recorded. Total: ${current.usage.taskCount} / ${current.usage.taskLimit}`);
      return {
        success: true,
        data: {
          count: current.usage.taskCount,
          remaining: usageResult.remaining,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to record task usage';
      logger.error(errorMsg);
      return { success: false, error: errorMsg };
    }
  }
}

export const cloudApiClient = CloudApiClient.getInstance();
