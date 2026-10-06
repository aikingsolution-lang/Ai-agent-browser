# Backend Architecture & Services Documentation

## 1. Overview
The backend application located in `backend/` is a production-ready RESTful SaaS backend built with **Node.js (>= 20)**, **Express 4.21**, **TypeScript 5.5**, and **Mongoose 8.7 (MongoDB)**. It handles identity management, multi-tier subscriptions with Razorpay, metered credit ledgering, managed LLM proxying, resume extraction, and job application auditing.

---

## 2. Server Bootstrapping & Lifecycle
- **Entry File**: `backend/src/server.ts`
- **Application Factory**: `backend/src/app.ts` (`createApp()`)
- **Lifecycle Sequence**:
  1. `env` schema validated via Zod (`backend/src/config/env.ts`). If invalid, process terminates immediately with validation error.
  2. `connectToDatabase()` establishes connection with MongoDB (`backend/src/config/database.ts`).
  3. `PlanSeedService.seedDefaultPlans()` ensures default plans (`free-trial`, `pro-monthly`, `enterprise-monthly`) exist in DB.
  4. `TrialExpirationWorker.start()` starts the 15-minute cron job.
  5. HTTP server listens on configured `PORT` (default `5000`).
  6. Graceful shutdown listeners handle `SIGTERM` and `SIGINT`.

---

## 3. Middleware Pipeline
The middleware in `backend/src/middleware/` executes in the following strict order on every request:
1. **Helmet** (`helmet()`) - Sets secure HTTP headers (X-Frame-Options, Content-Security-Policy, HSTS).
2. **Correlation ID** (`correlationId.middleware.ts`) - Generates or extracts `x-correlation-id` header and attaches it to request and response.
3. **CORS** (`cors()`) - Validates Origin against `CORS_ORIGIN`, allows `chrome-extension://*` requests and curl/no-origin calls.
4. **Morgan** - Request logging (`dev` format, suppressed in test environment).
5. **Top-Level Health Probe** - Mounts `/health`, `/health/live`, `/ready`, `/health/ready`.
6. **Body Parsing** - `express.json({ limit: '10mb' })` (captures `req.rawBody` for webhook signature verification) and `express.urlencoded`.
7. **Global Rate Limiter** (`baseRateLimiter` in `rateLimiter.ts`) - 100 requests per 15 minutes window.
8. **Route Dispatcher** - Dispatches to `/api/v1` router (`backend/src/routes/index.ts`).
9. **404 Handler** (`notFoundHandler` in `notFound.ts`) - Catches unrouted requests, returns JSON 404.
10. **Global Error Handler** (`errorHandler` in `errorHandler.ts`) - Centralizes error formatting, maps `AppError`, handles Zod validation errors and Mongoose duplicate keys.

---

## 4. Specialized Route Middlewares
- **`authenticate`** (`auth.middleware.ts`): Verifies JWT Bearer token against `JWT_SECRET`. Populates `req.user = { userId, role }`.
- **`checkEntitlement`** (`entitlement.middleware.ts`): Checks whether user has an active paid subscription or unexpired trial.
- **`checkCredits(amount)`** (`credit.middleware.ts`): Verifies user has `remainingCredits >= amount` before executing metered operations.
- **`validate(schema)`** (`validate.middleware.ts`): Zod validation for `body`, `query`, and `params`.
- **`authLoginRateLimiter` / `authRegisterRateLimiter`**: Strict rate limiting (10 attempts / 15m) on sensitive auth endpoints.
