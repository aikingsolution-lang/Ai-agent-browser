import { authStorage, llmProviderStore, agentModelStore, AgentNameEnum, type ProviderConfig } from '@extension/storage';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createChatModel } from './helper';
import { createLogger } from '../log';
import { BACKEND_LLM_URL } from '@extension/shared';

const logger = createLogger('ActiveModelHelper');

/**
 * Resolves active LLM (User-Configured Provider or Backend Bedrock Gateway).
 * Prioritizes active configured provider with valid API credentials,
 * falls back to cloud session token gateway if available.
 */
export async function getActiveChatModel(jobRunId?: string): Promise<BaseChatModel | undefined> {
  try {
    const rawProviders = await llmProviderStore.getAllProviders().catch(() => ({}));
    const providers: Record<string, ProviderConfig> = rawProviders || {};
    const agentModels = await agentModelStore.getAllAgentModels().catch(() => ({}) as any);
    const plannerAgentModel = agentModels[AgentNameEnum.Planner];

    // 1. Check if Planner agent model has an active provider with credentials
    if (plannerAgentModel && plannerAgentModel.provider && providers[plannerAgentModel.provider]) {
      const p = providers[plannerAgentModel.provider];
      if (p && (p.apiKey || p.baseUrl)) {
        return createChatModel(p, plannerAgentModel);
      }
    }

    // 2. Check any configured provider with apiKey or custom baseUrl (e.g. Ollama, Groq, OpenAI)
    for (const key of Object.keys(providers)) {
      const p = providers[key];
      if (p && (p.apiKey || p.baseUrl)) {
        return createChatModel(p, {
          provider: key,
          modelName: p.modelNames?.[0] || 'gpt-4o-mini',
        });
      }
    }

    // 3. Cloud Bedrock session token gateway (if backend server is reachable)
    const session = await authStorage.getSession().catch(() => null);
    if (session?.token) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${session.token}`,
      };
      if (jobRunId) {
        headers['x-run-id'] = jobRunId;
      }
      return new ChatOpenAI({
        modelName: 'amazon.nova-lite-v1:0',
        apiKey: session.token,
        configuration: {
          baseURL: BACKEND_LLM_URL,
          defaultHeaders: headers,
        },
        temperature: 0.2,
        maxTokens: 4096,
      });
    }
  } catch (err) {
    logger.warning('Could not resolve active chat model:', err);
  }
  return undefined;
}
