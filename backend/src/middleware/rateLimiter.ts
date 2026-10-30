import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const isTest = () => env.NODE_ENV === 'test';

export const baseRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 600, // Limit each IP to 600 general requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => {
    if (isTest()) return true;
    const path = req.path || '';
    // Exclude LLM completions, profile quota, credits balance/history, and refund endpoints
    // from global IP limiter since they have dedicated user-keyed or route-specific limiters.
    // req.path excludes query parameters, preventing query string bypasses.
    if (
      path.startsWith('/api/v1/llm') ||
      path.startsWith('/api/v1/profile/quota') ||
      path.startsWith('/api/v1/credits')
    ) {
      return true;
    }
    return false;
  },
  keyGenerator: req => req.ip || 'anonymous',
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.',
    error: {
      code: 'TOO_MANY_REQUESTS',
    },
    timestamp: new Date().toISOString(),
  },
});

export const readApiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 lightweight read requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTest,
  message: {
    success: false,
    message: 'Too many read requests from this IP, please try again later.',
    error: {
      code: 'TOO_MANY_REQUESTS',
    },
    timestamp: new Date().toISOString(),
  },
});

export const authLoginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 login attempts per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTest,
  message: {
    success: false,
    message: 'Too many failed login attempts from this IP. Please try again after 15 minutes.',
    error: {
      code: 'TOO_MANY_LOGIN_ATTEMPTS',
    },
    timestamp: new Date().toISOString(),
  },
});

export const authRegisterRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // Limit each IP to 10 registration attempts per hour
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTest,
  message: {
    success: false,
    message: 'Too many account registrations from this IP. Please try again later.',
    error: {
      code: 'TOO_MANY_REGISTRATIONS',
    },
    timestamp: new Date().toISOString(),
  },
});

export const getLlmRateLimiterKey = (req: any): string => req.user?.uid || req.user?._id || req.ip || 'anonymous';

export const llmRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: env.LLM_RATE_PER_USER_RPM, // Configurable per-user RPM (default: 60)
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTest,
  keyGenerator: getLlmRateLimiterKey,
  handler: (req, res, _next, options) => {
    const retryAfter = Math.ceil(options.windowMs / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    logger.warn('[RateLimiter] User rate limit exceeded on LLM gateway', {
      userId: getLlmRateLimiterKey(req),
      limit: options.max,
      retryAfter,
    });
    res.status(429).json({
      success: false,
      message: `Too many LLM requests. Rate limit is ${options.max} requests per minute. Please try again after ${retryAfter} seconds.`,
      error: {
        code: 'PROVIDER_RATE_LIMIT',
        retryAfter,
      },
      timestamp: new Date().toISOString(),
    });
  },
});

export const globalLlmRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: env.LLM_RATE_GLOBAL_RPM, // Configurable global gateway RPM (default: 600)
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTest,
  keyGenerator: () => 'global_llm_gateway',
  handler: (req, res, _next, options) => {
    const retryAfter = Math.ceil(options.windowMs / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    logger.warn('[RateLimiter] Global capacity limit reached on LLM gateway', {
      globalLimit: options.max,
      retryAfter,
    });
    res.status(429).json({
      success: false,
      message: 'Global LLM gateway capacity reached. Please try again shortly.',
      error: {
        code: 'PROVIDER_RATE_LIMIT',
        retryAfter,
      },
      timestamp: new Date().toISOString(),
    });
  },
});

export const refundRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Limit each IP to 30 refund requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTest,
  message: {
    success: false,
    message: 'Too many refund requests from this IP, please try again later.',
    error: {
      code: 'TOO_MANY_REQUESTS',
    },
    timestamp: new Date().toISOString(),
  },
});
