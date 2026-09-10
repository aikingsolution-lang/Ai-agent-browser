import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

const isTest = () => env.NODE_ENV === 'test';

export const baseRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 600, // Limit each IP to 600 general requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTest,
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

export const llmRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // Limit each IP to 60 LLM requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTest,
  message: {
    success: false,
    message: 'Too many LLM requests from this IP. Please try again after 1 minute.',
    error: {
      code: 'TOO_MANY_REQUESTS',
    },
    timestamp: new Date().toISOString(),
  },
});
