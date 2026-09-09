import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import { v1Router } from './routes/index.js';
import { correlationId } from './middleware/correlationId.middleware.js';
import { baseRateLimiter } from './middleware/rateLimiter.js';
import { notFoundHandler } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';

import { healthRouter } from './routes/health.routes.js';

export function createApp(): express.Application {
  const app = express();

  // Security Headers
  app.use(helmet());

  // Correlation ID Tracking
  app.use(correlationId);

  // CORS Configuration
  const allowedOrigins = env.CORS_ORIGIN.split(',').map(o => o.trim());
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (e.g. mobile apps, curl, extension background worker)
        if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error(`Origin ${origin} not allowed by CORS`));
        }
      },
      credentials: true,
    }),
  );

  // Request Logging
  if (env.NODE_ENV !== 'test') {
    app.use(morgan('dev'));
  }

  // Top-level Health & Readiness Probes
  app.use('/', healthRouter);

  // Body Parsing Middleware
  app.use(
    express.json({
      limit: '10mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Global Rate Limiting
  app.use(baseRateLimiter);

  // API Version 1 Mounting
  app.use('/api/v1', v1Router);

  // 404 Route Handler
  app.use(notFoundHandler);

  // Central Error Handling Middleware
  app.use(errorHandler);

  return app;
}
