import { env } from '../../config/env.js';
import { AppError } from '../../middleware/errorHandler.js';
import type { ILlmProvider } from './llmProvider.interface.js';
import { MockLlmProvider, type MockLlmOptions } from './mockLlmProvider.js';
import { BedrockLlmProvider } from './bedrockLlmProvider.js';
import { GeminiLlmProvider } from './geminiLlmProvider.js';

let mockProviderInstance: MockLlmProvider | null = null;
let overrideProvider: ILlmProvider | null = null;

export class LlmProviderFactory {
  /**
   * Validates provider configuration at startup or prior to instantiation.
   * Throws an AppError if required API keys are missing in production or development.
   */
  public static validateConfiguration(): void {
    if (env.NODE_ENV === 'test') {
      return;
    }

    const providerType = env.LLM_PROVIDER;

    if (providerType === 'gemini') {
      const key = env.GEMINI_API_KEY?.trim();
      if (!key) {
        throw new AppError(
          'GEMINI_API_KEY is missing or empty. When LLM_PROVIDER=gemini, GEMINI_API_KEY must be provided via environment or Secret Manager.',
          500,
          'CONFIGURATION_ERROR',
        );
      }
    } else if (providerType === 'bedrock') {
      const key = env.AWS_BEDROCK_API_KEY?.trim();
      if (!key) {
        throw new AppError(
          'AWS_BEDROCK_API_KEY is missing or empty. When LLM_PROVIDER=bedrock, AWS_BEDROCK_API_KEY must be provided via environment or Secret Manager.',
          500,
          'CONFIGURATION_ERROR',
        );
      }
    }
  }

  public static getProvider(): ILlmProvider {
    if (overrideProvider) {
      return overrideProvider;
    }

    // Mock provider is strictly restricted to test environments
    if (env.NODE_ENV === 'test') {
      if (!mockProviderInstance) {
        mockProviderInstance = new MockLlmProvider();
      }
      return mockProviderInstance;
    }

    this.validateConfiguration();

    const providerType = env.LLM_PROVIDER;

    if (providerType === 'bedrock') {
      return new BedrockLlmProvider(env.AWS_BEDROCK_API_KEY, env.AWS_BEDROCK_REGION);
    }

    // Default provider: gemini
    return new GeminiLlmProvider(
      env.GEMINI_API_KEY,
      env.GEMINI_MODEL,
      undefined,
      env.GEMINI_THINKING_BUDGET,
      env.GEMINI_REASONING_EFFORT,
    );
  }

  public static setMockOptions(options: MockLlmOptions): MockLlmProvider {
    if (!mockProviderInstance) {
      mockProviderInstance = new MockLlmProvider(options);
    } else {
      mockProviderInstance.setOptions(options);
    }
    overrideProvider = mockProviderInstance;
    return mockProviderInstance;
  }

  public static setOverrideProvider(provider: ILlmProvider | null): void {
    overrideProvider = provider;
  }

  public static reset(): void {
    mockProviderInstance = null;
    overrideProvider = null;
  }
}
