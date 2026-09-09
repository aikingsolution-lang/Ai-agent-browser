import { env } from '../../config/env.js';
import type { ILlmProvider } from './llmProvider.interface.js';
import { MockLlmProvider, type MockLlmOptions } from './mockLlmProvider.js';
import { OpenAiLlmProvider } from './openAiLlmProvider.js';

let mockProviderInstance: MockLlmProvider | null = null;
let overrideProvider: ILlmProvider | null = null;

export class LlmProviderFactory {
  public static getProvider(): ILlmProvider {
    if (overrideProvider) {
      return overrideProvider;
    }

    if (env.NODE_ENV === 'test' || !env.OPENAI_API_KEY || env.OPENAI_API_KEY.startsWith('mock')) {
      if (!mockProviderInstance) {
        mockProviderInstance = new MockLlmProvider();
      }
      return mockProviderInstance;
    }

    return new OpenAiLlmProvider(env.OPENAI_API_KEY);
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
