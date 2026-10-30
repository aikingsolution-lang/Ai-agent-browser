import crypto from 'node:crypto';
import { CreditService } from './credit.service.js';
import { LlmProviderFactory } from './llm/llmProviderFactory.js';
import type { LlmMessage, LlmCompletionResponse } from './llm/llmProvider.interface.js';
import { LlmUsageRepository } from './rtdb/repositories.js';
import { newId } from './rtdb/rtdbUtils.js';
import { toLlmUsageDto, type LlmUsageDto } from './rtdb/serializers.js';
import type { LlmRequestStatus, LlmUsageRecord } from './rtdb/records.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

export interface ProcessLlmChatParams {
  userId: string;
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: any[];
  tool_choice?: any;
  idempotencyKey?: string;
  runId?: string;
  /** Covered by verified JobForm Automator Premium: usage is recorded but no credits are drawn. */
  premiumCovered?: boolean;
}

export interface ProcessLlmStreamParams extends ProcessLlmChatParams {
  onChunk: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface LlmChatResult {
  requestId: string;
  model: string;
  provider: string;
  content: string;
  toolCalls?: any[];
  finishReason?: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  creditsDeducted: number;
  isIdempotentRetry: boolean;
  latencyMs: number;
}

/** LLM usage log, stored at nanobrowser/llm_usage/{uid}/{usageId} (previously the Mongo LlmUsageLog collection). */
type UsageLogInput = Omit<LlmUsageRecord, 'usageId' | 'uid' | 'createdAt' | 'updatedAt'>;

async function recordUsage(userId: string, input: UsageLogInput): Promise<void> {
  const now = Date.now();
  await LlmUsageRepository.create(userId, {
    ...input,
    usageId: newId('llm'),
    uid: userId,
    createdAt: now,
    updatedAt: now,
  });
}

export class LlmService {
  /**
   * Helper to calculate credits based on model multiplier and total tokens.
   *
   * Pricing Assumptions:
   * - Pro / Reasoning models (claude-3-5-sonnet, nova-pro, gemini-2.5-pro, gemini-1.5-pro):
   *   2 credits per 1,000 tokens (minimum 2 credits).
   * - Standard / Flash models (gemini-2.5-flash, gemini-2.0-flash, gemini-1.5-flash, nova-lite, nova-micro, claude-3-haiku):
   *   1 credit per 1,000 tokens (minimum 1 credit).
   *
   * Token usage is derived directly from the LLM provider's response usage payload (totalTokens).
   * Failed or timed out requests incur 0 credits (refunded / not deducted).
   */
  public static calculateRequiredCredits(model: string, totalTokens: number): number {
    const isPremium =
      model.includes('claude-3-5-sonnet') ||
      model.includes('nova-pro') ||
      model.includes('gemini-2.5-pro') ||
      model.includes('gemini-1.5-pro');
    const ratePerThousand = isPremium ? 2 : 1;
    const minimumCredits = ratePerThousand;
    return Math.max(minimumCredits, Math.ceil((totalTokens / 1000) * ratePerThousand));
  }

  /**
   * Process a non-streaming LLM chat completion request.
   */
  public static async processChatCompletion(params: ProcessLlmChatParams): Promise<LlmChatResult> {
    const {
      userId,
      model,
      messages,
      temperature,
      maxTokens,
      tools,
      tool_choice,
      idempotencyKey,
      runId,
      premiumCovered = false,
    } = params;

    // 1. Idempotency Check
    if (idempotencyKey) {
      const existingLog = await LlmUsageRepository.findByIdempotencyKey(userId, idempotencyKey);
      if (existingLog) {
        logger.info(`Idempotent retry detected for LLM key '${idempotencyKey}'`);
        return {
          requestId: existingLog.requestId,
          model: existingLog.model,
          provider: existingLog.provider,
          content: (existingLog.metadata as any)?.content || '[Cached Response]',
          usage: {
            promptTokens: existingLog.promptTokens,
            completionTokens: existingLog.completionTokens,
            totalTokens: existingLog.totalTokens,
          },
          creditsDeducted: existingLog.creditsDeducted,
          isIdempotentRetry: true,
          latencyMs: existingLog.latencyMs,
        };
      }
    }

    // 2. Pre-check Credit Balance before calling provider
    const minRequiredCredits = this.calculateRequiredCredits(model, 100);
    const balance = await CreditService.getCreditBalance(userId);
    if (!premiumCovered && (!balance || balance.remainingCredits < minRequiredCredits)) {
      const available = balance ? balance.remainingCredits : 0;
      throw new AppError(
        `Insufficient credits for LLM request. Minimum required: ${minRequiredCredits}, Available: ${available}`,
        402,
        'INSUFFICIENT_CREDITS',
      );
    }

    const provider = LlmProviderFactory.getProvider();
    const requestId = `llm_req_${crypto.randomUUID()}`;
    const startTime = Date.now();

    try {
      // 3. Execute LLM Completion via Provider
      const completion: LlmCompletionResponse = await provider.generateCompletion({
        model,
        messages,
        temperature,
        maxTokens,
        tools,
        tool_choice,
      });

      const latencyMs = Date.now() - startTime;
      const creditsToDeduct = this.calculateRequiredCredits(model, completion.totalTokens);

      // 4. Atomically Deduct Credits
      const deductionIdempotencyKey = idempotencyKey ? `llm_deduct_${idempotencyKey}` : undefined;
      if (!premiumCovered)
        await CreditService.deductCredits({
          userId,
          amount: creditsToDeduct,
          description: `LLM Proxy usage (${model})`,
          idempotencyKey: deductionIdempotencyKey,
          metadata: {
            requestId,
            model,
            provider: provider.providerName,
            promptTokens: completion.promptTokens,
            completionTokens: completion.completionTokens,
            totalTokens: completion.totalTokens,
            runId,
          },
        });

      // 5. Record Usage Log
      await recordUsage(userId, {
        requestId,
        provider: provider.providerName,
        model,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        totalTokens: completion.totalTokens,
        creditsDeducted: premiumCovered ? 0 : creditsToDeduct,
        latencyMs,
        status: 'SUCCESS',
        idempotencyKey,
        runId,
        metadata: {
          content: completion.content,
          runId,
          ...(completion.toolCalls ? { toolCalls: completion.toolCalls } : {}),
          ...(premiumCovered ? { coveredBy: 'jobform-premium', creditsEquivalent: creditsToDeduct } : {}),
        },
      });

      return {
        requestId,
        model,
        provider: provider.providerName,
        content: completion.content,
        toolCalls: completion.toolCalls,
        finishReason: completion.finishReason,
        usage: {
          promptTokens: completion.promptTokens,
          completionTokens: completion.completionTokens,
          totalTokens: completion.totalTokens,
        },
        creditsDeducted: premiumCovered ? 0 : creditsToDeduct,
        isIdempotentRetry: false,
        latencyMs,
      };
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = error.message || 'LLM Provider processing failed';
      const status: LlmRequestStatus = error.code === 'PROVIDER_TIMEOUT' || error.status === 504 ? 'TIMEOUT' : 'FAILED';

      // Log FAILED or TIMEOUT status entry (0 credits deducted)
      await recordUsage(userId, {
        requestId,
        provider: provider.providerName,
        model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        creditsDeducted: 0,
        latencyMs,
        status,
        errorMessage,
        idempotencyKey,
        runId,
      }).catch(logErr => logger.error('Failed to save error LLM usage log:', logErr));

      throw error;
    }
  }

  /**
   * Process a streaming LLM chat completion request.
   */
  public static async processStreamCompletion(params: ProcessLlmStreamParams): Promise<LlmChatResult> {
    const {
      userId,
      model,
      messages,
      temperature,
      maxTokens,
      idempotencyKey,
      onChunk,
      signal,
      runId,
      premiumCovered = false,
    } = params;

    // 1. Pre-check Credit Balance
    const minRequiredCredits = this.calculateRequiredCredits(model, 100);
    const balance = await CreditService.getCreditBalance(userId);
    if (!premiumCovered && (!balance || balance.remainingCredits < minRequiredCredits)) {
      const available = balance ? balance.remainingCredits : 0;
      throw new AppError(
        `Insufficient credits for LLM stream request. Minimum required: ${minRequiredCredits}, Available: ${available}`,
        402,
        'INSUFFICIENT_CREDITS',
      );
    }

    const provider = LlmProviderFactory.getProvider();
    const requestId = `llm_req_${crypto.randomUUID()}`;
    const startTime = Date.now();

    try {
      const completion = await provider.streamCompletion(
        {
          model,
          messages,
          temperature,
          maxTokens,
        },
        onChunk,
        signal,
      );

      const latencyMs = Date.now() - startTime;
      const isAborted = signal?.aborted;
      const status: LlmRequestStatus = isAborted ? 'PARTIAL' : 'SUCCESS';

      const creditsToDeduct = this.calculateRequiredCredits(model, completion.totalTokens);

      if (creditsToDeduct > 0 && !premiumCovered) {
        const deductionIdempotencyKey = idempotencyKey ? `llm_deduct_${idempotencyKey}` : undefined;
        await CreditService.deductCredits({
          userId,
          amount: creditsToDeduct,
          description: `LLM Proxy streaming usage (${model})`,
          idempotencyKey: deductionIdempotencyKey,
          metadata: {
            requestId,
            model,
            provider: provider.providerName,
            status,
            runId,
          },
        });
      }

      await recordUsage(userId, {
        requestId,
        provider: provider.providerName,
        model,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        totalTokens: completion.totalTokens,
        creditsDeducted: premiumCovered ? 0 : creditsToDeduct,
        latencyMs,
        status,
        idempotencyKey,
        runId,
        metadata: {
          content: completion.content,
          runId,
          ...(premiumCovered ? { coveredBy: 'jobform-premium', creditsEquivalent: creditsToDeduct } : {}),
        },
      });

      return {
        requestId,
        model,
        provider: provider.providerName,
        content: completion.content,
        usage: {
          promptTokens: completion.promptTokens,
          completionTokens: completion.completionTokens,
          totalTokens: completion.totalTokens,
        },
        creditsDeducted: premiumCovered ? 0 : creditsToDeduct,
        isIdempotentRetry: false,
        latencyMs,
      };
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = error.message || 'LLM Streaming failed';
      const status: LlmRequestStatus = error.code === 'PROVIDER_TIMEOUT' || error.status === 504 ? 'TIMEOUT' : 'FAILED';

      await recordUsage(userId, {
        requestId,
        provider: provider.providerName,
        model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        creditsDeducted: 0,
        latencyMs,
        status,
        errorMessage,
        idempotencyKey,
        runId,
      }).catch(logErr => logger.error('Failed to save error LLM usage log:', logErr));

      throw error;
    }
  }

  /**
   * Retrieves paginated LLM usage history for an authenticated user (newest first).
   */
  public static async getUsageHistory(
    userId: string,
    page = 1,
    limit = 20,
  ): Promise<{ items: LlmUsageDto[]; total: number; page: number; limit: number }> {
    const { items, total } = await LlmUsageRepository.list(userId, page, limit);

    return {
      items: items.map(toLlmUsageDto),
      total,
      page,
      limit,
    };
  }
}
