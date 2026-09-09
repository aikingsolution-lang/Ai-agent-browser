import rateLimit from 'express-rate-limit';

export const baseRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.',
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
  message: {
    success: false,
    message: 'Too many LLM requests from this IP. Please try again after 1 minute.',
    error: {
      code: 'TOO_MANY_REQUESTS',
    },
    timestamp: new Date().toISOString(),
  },
});
