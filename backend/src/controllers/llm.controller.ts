import type { Request, Response, NextFunction } from 'express';
import { LlmService } from '../services/llm.service.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { env } from '../config/env.js';

export class LlmController {
  /**
   * POST /api/v1/llm/chat
   * Proxies LLM chat completion requests with credit enforcement and usage metering.
   */
  public static async chatCompletion(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?._id;
      if (!userId) {
        sendError(res, 'Authentication required', 401, 'UNAUTHORIZED');
        return;
      }

      const body = req.body;
      const model = body.model || env.LLM_DEFAULT_MODEL;
      const messages = body.messages;
      const temperature = body.temperature;
      const maxTokens = body.max_tokens;
      const stream = Boolean(body.stream);

      // Support header or body idempotency key
      const idempotencyKey = (req.headers['x-idempotency-key'] as string) || body.idempotencyKey;

      if (stream) {
        // SSE Header setup
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const abortController = new AbortController();
        req.on('close', () => {
          if (!res.writableEnded) {
            abortController.abort();
          }
        });

        try {
          const result = await LlmService.processStreamCompletion({
            userId,
            model,
            messages,
            temperature,
            maxTokens,
            idempotencyKey,
            onChunk: (chunk: string) => {
              if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
              }
            },
            signal: abortController.signal,
          });

          if (!res.writableEnded) {
            res.write(
              `data: ${JSON.stringify({ meta: { requestId: result.requestId, creditsDeducted: result.creditsDeducted, usage: result.usage } })}\n\n`,
            );
            res.write('data: [DONE]\n\n');
            res.end();
          }
        } catch (streamErr: any) {
          if (!res.headersSent) {
            next(streamErr);
          } else if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: streamErr.message || 'Stream error' })}\n\n`);
            res.end();
          }
        }
        return;
      }

      // Non-streaming completion
      const result = await LlmService.processChatCompletion({
        userId,
        model,
        messages,
        temperature,
        maxTokens,
        idempotencyKey,
      });

      sendSuccess(res, result, 'LLM chat completion successful', 200);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/llm/usage
   * Returns paginated LLM usage history for the authenticated user.
   */
  public static async getUsageHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?._id;
      if (!userId) {
        sendError(res, 'Authentication required', 401, 'UNAUTHORIZED');
        return;
      }

      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = parseInt(req.query.limit as string, 10) || 20;

      const history = await LlmService.getUsageHistory(userId, page, limit);

      sendSuccess(res, history, 'Usage history retrieved successfully', 200);
    } catch (error) {
      next(error);
    }
  }
}
