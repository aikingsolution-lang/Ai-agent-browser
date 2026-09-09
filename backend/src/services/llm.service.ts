import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { LlmUsageLog, type ILlmUsageLog, type LlmRequestStatus } from '../models/llmUsageLog.model.js';
import { CreditService } from './credit.service.js';
import { LlmProviderFactory } from './llm/llmProviderFactory.js';
import type { LlmMessage, LlmCompletionResponse } from './llm/llmProvider.interface.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

export interface ProcessLlmChatParams {
  userId: string | mongoose.Types.ObjectId;
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  idempotencyKey?: string;
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
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  creditsDeducted: number;
  isIdempotentRetry: boolean;
  latencyMs: number;
}

export class LlmService {
  /**
   * Helper to calculate credits based on model multiplier and total tokens.
   */
  public static calculateRequiredCredits(model: string, totalTokens: number): number {
    const isPremium = model === 'gpt-4o' || model === 'claude-3-5-sonnet';
    const ratePerThousand = isPremium ? 2 : 1;
    const minimumCredits = ratePerThousand;
    return Math.max(minimumCredits, Math.ceil((totalTokens / 1000) * ratePerThousand));
  }

  /**
   * Process a non-streaming LLM chat completion request.
   */
  public static async processChatCompletion(params: ProcessLlmChatParams): Promise<LlmChatResult> {
    const { userId, model, messages, temperature, maxTokens, idempotencyKey } = params;

    // 1. Idempotency Check
    if (idempotencyKey) {
      const existingLog = await LlmUsageLog.findOne({ idempotencyKey, userId });
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
    if (!balance || balance.remainingCredits < minRequiredCredits) {
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
      });

      const latencyMs = Date.now() - startTime;
      const creditsToDeduct = this.calculateRequiredCredits(model, completion.totalTokens);

      // 4. Atomically Deduct Credits
      const deductionIdempotencyKey = idempotencyKey ? `llm_deduct_${idempotencyKey}` : undefined;
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
        },
      });

      // 5. Record Usage Log
      await LlmUsageLog.create({
        requestId,
        userId,
        provider: provider.providerName,
        model,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        totalTokens: completion.totalTokens,
        creditsDeducted: creditsToDeduct,
        latencyMs,
        status: 'SUCCESS',
        idempotencyKey,
        metadata: {
          content: completion.content,
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
        creditsDeducted: creditsToDeduct,
        isIdempotentRetry: false,
        latencyMs,
      };
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = error.message || 'LLM Provider processing failed';
      const status: LlmRequestStatus = error.code === 'PROVIDER_TIMEOUT' || error.status === 504 ? 'TIMEOUT' : 'FAILED';

      // Log FAILED or TIMEOUT status document (0 credits deducted)
      await LlmUsageLog.create({
        requestId,
        userId,
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
      }).catch(logErr => logger.error('Failed to save error LlmUsageLog:', logErr));

      throw error;
    }
  }

  /**
   * Process a streaming LLM chat completion request.
   */
  public static async processStreamCompletion(params: ProcessLlmStreamParams): Promise<LlmChatResult> {
    const { userId, model, messages, temperature, maxTokens, idempotencyKey, onChunk, signal } = params;

    // 1. Pre-check Credit Balance
    const minRequiredCredits = this.calculateRequiredCredits(model, 100);
    const balance = await CreditService.getCreditBalance(userId);
    if (!balance || balance.remainingCredits < minRequiredCredits) {
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

      if (creditsToDeduct > 0) {
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
          },
        });
      }

      await LlmUsageLog.create({
        requestId,
        userId,
        provider: provider.providerName,
        model,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        totalTokens: completion.totalTokens,
        creditsDeducted: creditsToDeduct,
        latencyMs,
        status,
        idempotencyKey,
        metadata: {
          content: completion.content,
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
        creditsDeducted: creditsToDeduct,
        isIdempotentRetry: false,
        latencyMs,
      };
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = error.message || 'LLM Streaming failed';
      const status: LlmRequestStatus = error.code === 'PROVIDER_TIMEOUT' || error.status === 504 ? 'TIMEOUT' : 'FAILED';

      await LlmUsageLog.create({
        requestId,
        userId,
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
      }).catch(logErr => logger.error('Failed to save error LlmUsageLog:', logErr));

      throw error;
    }
  }

  /**
   * Retrieves paginated LLM usage history for an authenticated user.
   */
  public static async getUsageHistory(
    userId: string | mongoose.Types.ObjectId,
    page = 1,
    limit = 20,
  ): Promise<{ items: ILlmUsageLog[]; total: number; page: number; limit: number }> {
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      LlmUsageLog.find({ userId }).sort({ createdAt: -1 }).skip(skip).limit(limit),
      LlmUsageLog.countDocuments({ userId }),
    ]);

    return {
      items,
      total,
      page,
      limit,
    };
  }
}
