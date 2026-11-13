// src/app.ts
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

// src/config/env.ts
import dotenv from 'dotenv';
import { z as z2 } from 'zod';

// src/schemas/llm.schema.ts
import { z } from 'zod';
var ALLOWED_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gemini-flash-latest',
  'gemini-pro-latest',
  'anthropic.claude-3-5-sonnet-20240620-v1:0',
  'anthropic.claude-3-haiku-20240307-v1:0',
  'amazon.nova-micro-v1:0',
  'amazon.nova-lite-v1:0',
  'amazon.nova-pro-v1:0',
];
var llmChatMessageSchema = z.object({
  role: z.string({
    required_error: 'Message role is required',
  }),
  content: z
    .union([z.string(), z.array(z.any()), z.null()])
    .optional()
    .transform(val => {
      if (typeof val === 'string') return val;
      if (val === null || val === void 0) return '';
      return JSON.stringify(val);
    }),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
  function_call: z.any().optional(),
});
var llmChatCompletionSchema = z.object({
  model: z
    .string()
    .optional()
    .refine(val => !val || ALLOWED_MODELS.includes(val), {
      message: `Invalid model requested. Allowed models: ${ALLOWED_MODELS.join(', ')}`,
    }),
  messages: z.array(llmChatMessageSchema).min(1, 'At least one message is required'),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional().default(0.7),
  max_tokens: z.number().int().positive().optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
  idempotencyKey: z.string().optional(),
});

// src/config/env.ts
dotenv.config();
function normaliseFirebaseKey(val) {
  if (!val) return void 0;
  let k = val.trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim();
  }
  return k.replace(/\\n/g, '\n');
}
var DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
var DEFAULT_GEMINI_FALLBACK_MODEL = 'gemini-3.5-flash-lite';
var envSchema = z2.object({
  PORT: z2
    .union([z2.string(), z2.number()])
    .transform(val => (typeof val === 'number' ? val : parseInt(val, 10)))
    .default(process.env.PORT || '5000'),
  NODE_ENV: z2.enum(['development', 'production', 'test']).default('production'),
  CORS_ORIGIN: z2.string().default('*'),
  LOG_LEVEL: z2.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
  // ── Razorpay (server-only) ────────────────────────────────────────────────
  RAZORPAY_KEY_ID: z2.string().default('rzp_test_TZudy51Zrf7t8w'),
  RAZORPAY_KEY_SECRET: z2.string().default('QAaFgUjFe390LpwrQfme2zyy'),
  RAZORPAY_WEBHOOK_SECRET: z2.string().default('760c2bfa92c6f5c91d5033ff'),
  RAZORPAY_PLAN_ID_STARTER: z2.string().optional(),
  RAZORPAY_PLAN_ID_PRO: z2.string().optional(),
  RAZORPAY_PLAN_ID_POWER: z2.string().optional(),
  // ── LLM Providers (server-only) ───────────────────────────────────────────
  LLM_PROVIDER: z2.enum(['gemini', 'bedrock']).default('gemini'),
  GEMINI_API_KEY: z2.string().default(''),
  GEMINI_MODEL: z2
    .string()
    .default(DEFAULT_GEMINI_MODEL)
    .refine(val => ALLOWED_MODELS.includes(val), {
      message: `Invalid GEMINI_MODEL. Allowed models: ${ALLOWED_MODELS.join(', ')}`,
    }),
  GEMINI_FALLBACK_MODEL: z2
    .string()
    .default(DEFAULT_GEMINI_FALLBACK_MODEL)
    .refine(val => ALLOWED_MODELS.includes(val), {
      message: `Invalid GEMINI_FALLBACK_MODEL. Allowed models: ${ALLOWED_MODELS.join(', ')}`,
    }),
  GEMINI_THINKING_BUDGET: z2
    .union([z2.number(), z2.string()])
    .transform(val => (typeof val === 'number' ? val : parseInt(val, 10)))
    .optional(),
  GEMINI_REASONING_EFFORT: z2.enum(['none', 'low', 'medium', 'high']).optional(),
  AWS_BEDROCK_API_KEY: z2.string().default(''),
  AWS_BEDROCK_REGION: z2.string().default('us-east-1'),
  OPENAI_API_KEY: z2.string().optional(),
  LLM_DEFAULT_MODEL: z2
    .string()
    .optional()
    .transform(val => {
      if (val && val.trim() && ALLOWED_MODELS.includes(val.trim())) {
        return val.trim();
      }
      const provider = process.env.LLM_PROVIDER || 'gemini';
      const providerDefault =
        provider === 'bedrock' ? 'amazon.nova-lite-v1:0' : process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
      return providerDefault;
    })
    .default(DEFAULT_GEMINI_MODEL),
  // ── Google OAuth client ID (used by the extension — public) ───────────────
  GOOGLE_CLIENT_ID: z2
    .string()
    .optional()
    .transform(
      val =>
        (val && val.trim()) ||
        process.env.GOOGLE_CLIENT_ID?.trim() ||
        '336340854879-i6hj15oe17se379u6k377slo7pvbvh3v.apps.googleusercontent.com',
    )
    .default('336340854879-i6hj15oe17se379u6k377slo7pvbvh3v.apps.googleusercontent.com'),
  // ── Feature Flags & Limits ───────────────────────────────────────────────
  ENABLE_CREDITS_RECONCILE: z2
    .union([z2.boolean(), z2.string()])
    .transform(val => (typeof val === 'boolean' ? val : val === 'true' || val === '1'))
    .default(false),
  MAX_DAILY_REFUND_CAP: z2
    .union([z2.number(), z2.string()])
    .transform(val => (typeof val === 'number' ? val : parseInt(val || '50', 10)))
    .default(50),
  LLM_RATE_PER_USER_RPM: z2
    .union([z2.number(), z2.string()])
    .transform(val => (typeof val === 'number' ? val : parseInt(String(val || '60'), 10)))
    .default(60),
  LLM_RATE_GLOBAL_RPM: z2
    .union([z2.number(), z2.string()])
    .transform(val => (typeof val === 'number' ? val : parseInt(String(val || '600'), 10)))
    .default(600),
  /** AI tasks a month included with JobForm Automator Premium / Diamond (built-in Cloud API). */
  PREMIUM_MONTHLY_AI_TASK_LIMIT: z2
    .union([z2.number(), z2.string()])
    .transform(val => (typeof val === 'number' ? val : parseInt(val || '1000', 10)))
    .default(1e3),
});
var parsedEnv = envSchema.safeParse(process.env);
if (!parsedEnv.success) {
  console.warn('\u26A0\uFE0F Environment variable configuration warnings:', parsedEnv.error.format());
}
var baseEnv = parsedEnv.success
  ? parsedEnv.data
  : {
      PORT: parseInt(process.env.PORT || '8080', 10),
      NODE_ENV: process.env.NODE_ENV || 'production',
      CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
      LOG_LEVEL: 'info',
      RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || 'rzp_test_TZudy51Zrf7t8w',
      RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || 'QAaFgUjFe390LpwrQfme2zyy',
      RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || '760c2bfa92c6f5c91d5033ff',
      RAZORPAY_PLAN_ID_STARTER: process.env.RAZORPAY_PLAN_ID_STARTER,
      RAZORPAY_PLAN_ID_PRO: process.env.RAZORPAY_PLAN_ID_PRO,
      RAZORPAY_PLAN_ID_POWER: process.env.RAZORPAY_PLAN_ID_POWER,
      LLM_PROVIDER: process.env.LLM_PROVIDER || 'gemini',
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
      GEMINI_MODEL: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
      GEMINI_FALLBACK_MODEL: process.env.GEMINI_FALLBACK_MODEL || DEFAULT_GEMINI_FALLBACK_MODEL,
      GEMINI_THINKING_BUDGET: process.env.GEMINI_THINKING_BUDGET
        ? parseInt(process.env.GEMINI_THINKING_BUDGET, 10)
        : void 0,
      GEMINI_REASONING_EFFORT: process.env.GEMINI_REASONING_EFFORT,
      AWS_BEDROCK_API_KEY: process.env.AWS_BEDROCK_API_KEY || '',
      AWS_BEDROCK_REGION: process.env.AWS_BEDROCK_REGION || 'us-east-1',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      LLM_DEFAULT_MODEL:
        process.env.LLM_DEFAULT_MODEL && ALLOWED_MODELS.includes(process.env.LLM_DEFAULT_MODEL)
          ? process.env.LLM_DEFAULT_MODEL
          : process.env.LLM_PROVIDER === 'bedrock'
            ? 'amazon.nova-lite-v1:0'
            : process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
      GOOGLE_CLIENT_ID:
        process.env.GOOGLE_CLIENT_ID?.trim() ||
        '336340854879-i6hj15oe17se379u6k377slo7pvbvh3v.apps.googleusercontent.com',
      ENABLE_CREDITS_RECONCILE:
        process.env.ENABLE_CREDITS_RECONCILE === 'true' || process.env.ENABLE_CREDITS_RECONCILE === '1',
      MAX_DAILY_REFUND_CAP: parseInt(process.env.MAX_DAILY_REFUND_CAP || '50', 10),
      LLM_RATE_PER_USER_RPM: parseInt(process.env.LLM_RATE_PER_USER_RPM || '60', 10),
      LLM_RATE_GLOBAL_RPM: parseInt(process.env.LLM_RATE_GLOBAL_RPM || '600', 10),
      PREMIUM_MONTHLY_AI_TASK_LIMIT: parseInt(process.env.PREMIUM_MONTHLY_AI_TASK_LIMIT || '1000', 10),
    };
var firebaseEnv = {
  FIREBASE_PROJECT_ID:
    (process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID)?.trim() || void 0,
  FIREBASE_ADMIN_CLIENT_EMAIL: process.env.FIREBASE_ADMIN_CLIENT_EMAIL?.replace(/^"|"$/g, '').trim() || void 0,
  FIREBASE_ADMIN_PRIVATE_KEY: normaliseFirebaseKey(process.env.FIREBASE_ADMIN_PRIVATE_KEY),
  FIREBASE_DATABASE_URL:
    (process.env.FIREBASE_DATABASE_URL || process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL)?.trim() || void 0,
  FIREBASE_STORAGE_BUCKET:
    (process.env.FIREBASE_STORAGE_BUCKET || process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET)?.trim() || void 0,
  NANOBROWSER_RTDB_ROOT: process.env.NANOBROWSER_RTDB_ROOT?.trim() || 'nanobrowser',
};
var env = { ...baseEnv, ...firebaseEnv };

// src/routes/index.ts
import { Router as Router10 } from 'express';

// src/routes/health.routes.ts
import { Router } from 'express';

// src/utils/apiResponse.ts
function sendSuccess(res, data, message, statusCode = 200) {
  const payload = {
    success: true,
    message,
    data,
    timestamp: /* @__PURE__ */ new Date().toISOString(),
  };
  return res.status(statusCode).json(payload);
}
function sendError(res, message, statusCode = 500, code, details) {
  const payload = {
    success: false,
    message,
    error: {
      code,
      message,
      details,
    },
    timestamp: /* @__PURE__ */ new Date().toISOString(),
  };
  return res.status(statusCode).json(payload);
}

// src/config/firebase-admin.ts
import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';

// src/utils/logger.ts
import winston from 'winston';
var levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};
var colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white',
};
winston.addColors(colors);
var format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(info => `[${info.timestamp}] ${info.level}: ${info.message}`),
);
var transports = [new winston.transports.Console()];
var logger = winston.createLogger({
  level: env.LOG_LEVEL,
  levels,
  format,
  transports,
});

// src/config/firebase-admin.ts
function getOrCreateAdminApp() {
  const existingApps = getApps();
  if (existingApps.length > 0) {
    return existingApps[0];
  }
  const projectId = env.FIREBASE_PROJECT_ID;
  const clientEmail = env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = env.FIREBASE_ADMIN_PRIVATE_KEY;
  const databaseURL = env.FIREBASE_DATABASE_URL;
  if (!clientEmail || !privateKey) {
    if (env.NODE_ENV !== 'test') {
      logger.warn(
        '\u26A0\uFE0F  [Firebase Admin] FIREBASE_ADMIN_CLIENT_EMAIL / FIREBASE_ADMIN_PRIVATE_KEY not set. Initialisation deferred; database-backed routes will return 503 until credentials are provided.',
      );
    }
    return initializeApp({ projectId: projectId || 'demo-project', databaseURL });
  }
  try {
    const app2 = initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
      databaseURL,
      storageBucket: env.FIREBASE_STORAGE_BUCKET || `${projectId}.firebasestorage.app`,
    });
    logger.info('\u2705 [Firebase Admin] Initialised with service account credentials.');
    return app2;
  } catch (err) {
    logger.error(`\u274C [Firebase Admin] Failed to initialise with cert: ${err.message}`);
    return initializeApp({ projectId: projectId || 'demo-project', databaseURL });
  }
}
var adminApp = null;
var adminAuth = null;
var adminDb = null;
try {
  adminApp = getOrCreateAdminApp();
} catch (e) {
  logger.warn(`\u26A0\uFE0F  [Firebase Admin] App initialisation deferred: ${e.message}`);
}
if (adminApp) {
  try {
    adminAuth = getAuth(adminApp);
  } catch (e) {
    logger.warn(`\u26A0\uFE0F  [Firebase Admin] Auth initialisation deferred: ${e.message}`);
  }
  try {
    adminDb = getDatabase(adminApp);
  } catch (e) {
    if (env.NODE_ENV !== 'test') {
      logger.warn(`\u26A0\uFE0F  [Firebase Admin] Database initialisation deferred: ${e.message}`);
    }
  }
}
function hasAdminCredentials() {
  return Boolean(env.FIREBASE_ADMIN_CLIENT_EMAIL && env.FIREBASE_ADMIN_PRIVATE_KEY);
}
function getAdminAuthLazy() {
  if (adminAuth) return adminAuth;
  if (!adminApp) {
    try {
      adminApp = getOrCreateAdminApp();
    } catch (e) {
      logger.warn(`[Firebase Admin] Lazy app re-init failed: ${e.message}`);
      return null;
    }
  }
  try {
    adminAuth = getAuth(adminApp);
    logger.info('\u2705 [Firebase Admin] Auth lazy-initialised successfully on retry.');
    return adminAuth;
  } catch (e) {
    logger.warn(`[Firebase Admin] Lazy Auth init failed: ${e.message}`);
    return null;
  }
}

// src/middleware/errorHandler.ts
var AppError = class extends Error {
  statusCode;
  code;
  isOperational;
  constructor(message, statusCode = 500, code, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
};
function errorHandler(err, _req, res, _next) {
  const statusCode = err instanceof AppError ? err.statusCode : 500;
  const code = err instanceof AppError ? err.code : 'INTERNAL_SERVER_ERROR';
  logger.error(`Error [${code}] ${err.message}`, {
    stack: err.stack,
    statusCode,
  });
  const message =
    env.NODE_ENV === 'production' && statusCode === 500
      ? 'An unexpected server error occurred. Please try again later.'
      : err.message;
  sendError(res, message, statusCode, code);
}

// src/services/rtdb/rtdbUtils.ts
import crypto from 'node:crypto';
var SAFE_UID = /^[A-Za-z0-9_-]{1,128}$/;
var UNSAFE_KEY_CHARS = /[.#$[\]/\u0000-\u001F\u007F]/;
function assertSafeUid(uid) {
  if (typeof uid !== 'string' || !SAFE_UID.test(uid)) {
    throw new Error('Unsafe uid for database path');
  }
}
function isSafeKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !UNSAFE_KEY_CHARS.test(value);
}
function assertSafeKey(value, label = 'key') {
  if (!isSafeKey(value)) {
    throw new Error(`Unsafe ${label} for database path`);
  }
}
function stripUndefined(value) {
  if (value === void 0) return null;
  return JSON.parse(JSON.stringify(value));
}
function hashKey(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 40);
}
function keyForExternalId(value) {
  return isSafeKey(value) && value.length <= 128 ? value : `h_${hashKey(value)}`;
}
function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
}
function toMs(value) {
  if (value === null || value === void 0 || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}
function toIso(value) {
  const ms = toMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}
function toArray(value) {
  if (value === null || value === void 0) return [];
  const items = Array.isArray(value) ? value : typeof value === 'object' ? Object.values(value) : [];
  return items.filter(item => item !== null && item !== void 0);
}
function todayString() {
  return /* @__PURE__ */ new Date().toISOString().split('T')[0];
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// src/services/rtdb/client.ts
function resolveRoot(value) {
  const segments = value.split('/').filter(Boolean);
  if (segments.length === 0) throw new Error('NANOBROWSER_RTDB_ROOT must not be empty');
  segments.forEach(segment => assertSafeKey(segment, 'NANOBROWSER_RTDB_ROOT segment'));
  return segments.join('/');
}
var RTDB_ROOT = resolveRoot(env.NANOBROWSER_RTDB_ROOT);
var uidSeg = uid => {
  assertSafeUid(uid);
  return uid;
};
var keySeg = (key, label) => {
  assertSafeKey(key, label);
  return key;
};
var paths = {
  root: () => RTDB_ROOT,
  health: () => `${RTDB_ROOT}/_health/ping`,
  userProfile: uid => `${RTDB_ROOT}/users/${uidSeg(uid)}/profile`,
  trialFlag: uid => `${RTDB_ROOT}/trial_flags/${uidSeg(uid)}`,
  plans: () => `${RTDB_ROOT}/subscription_plans`,
  plan: code => `${RTDB_ROOT}/subscription_plans/${keySeg(code, 'plan code')}`,
  subscriptions: () => `${RTDB_ROOT}/subscriptions`,
  subscription: uid => `${RTDB_ROOT}/subscriptions/${uidSeg(uid)}`,
  subscriptionHistory: uid => `${RTDB_ROOT}/subscription_history/${uidSeg(uid)}`,
  subscriptionHistoryEntry: (uid, subscriptionId) =>
    `${RTDB_ROOT}/subscription_history/${uidSeg(uid)}/${keySeg(subscriptionId, 'subscription id')}`,
  providerSubscription: key => `${RTDB_ROOT}/provider_subscriptions/${keySeg(key, 'provider subscription key')}`,
  checkoutSession: (uid, planCode) => `${RTDB_ROOT}/checkout_sessions/${uidSeg(uid)}/${keySeg(planCode, 'plan code')}`,
  creditBalance: uid => `${RTDB_ROOT}/credit_balances/${uidSeg(uid)}`,
  creditBalances: () => `${RTDB_ROOT}/credit_balances`,
  creditLedger: uid => `${RTDB_ROOT}/credit_ledger/${uidSeg(uid)}`,
  creditLedgerEntry: (uid, entryId) =>
    `${RTDB_ROOT}/credit_ledger/${uidSeg(uid)}/${keySeg(entryId, 'ledger entry id')}`,
  creditLedgerCount: uid => `${RTDB_ROOT}/credit_ledger_meta/${uidSeg(uid)}/count`,
  creditIdempotency: (uid, keyHash) =>
    `${RTDB_ROOT}/credit_idempotency/${uidSeg(uid)}/${keySeg(keyHash, 'idempotency key hash')}`,
  failedRefunds: uid => `${RTDB_ROOT}/failed_refunds/${uidSeg(uid)}`,
  failedRefund: (uid, runId) => `${RTDB_ROOT}/failed_refunds/${uidSeg(uid)}/${keySeg(runId, 'failed refund run id')}`,
  reconcileAuditLogs: uid => `${RTDB_ROOT}/reconcile_audit_logs/${uidSeg(uid)}`,
  reconcileAuditLogEntry: (uid, entryId) =>
    `${RTDB_ROOT}/reconcile_audit_logs/${uidSeg(uid)}/${keySeg(entryId, 'reconcile audit log id')}`,
  careerBrain: uid => `${RTDB_ROOT}/career_brains/${uidSeg(uid)}`,
  careerBrainField: (uid, field) => `${RTDB_ROOT}/career_brains/${uidSeg(uid)}/${field}`,
  applicationQuota: uid => `${RTDB_ROOT}/application_quota/${uidSeg(uid)}`,
  jobApplications: uid => `${RTDB_ROOT}/job_applications/${uidSeg(uid)}`,
  jobApplication: (uid, appId) => `${RTDB_ROOT}/job_applications/${uidSeg(uid)}/${keySeg(appId, 'application id')}`,
  jobApplicationKey: (uid, jobKey) => `${RTDB_ROOT}/job_application_keys/${uidSeg(uid)}/${keySeg(jobKey, 'job key')}`,
  jobApplicationCount: uid => `${RTDB_ROOT}/job_applications_meta/${uidSeg(uid)}/count`,
  llmUsage: uid => `${RTDB_ROOT}/llm_usage/${uidSeg(uid)}`,
  llmUsageEntry: (uid, usageId) => `${RTDB_ROOT}/llm_usage/${uidSeg(uid)}/${keySeg(usageId, 'usage id')}`,
  llmUsageCount: uid => `${RTDB_ROOT}/llm_usage_meta/${uidSeg(uid)}/count`,
  premiumAiTaskCount: (uid, month) => `${RTDB_ROOT}/premium_ai_tasks/${uidSeg(uid)}/${keySeg(month, 'month')}/count`,
  premiumAiTask: (uid, month, taskKey) =>
    `${RTDB_ROOT}/premium_ai_tasks/${uidSeg(uid)}/${keySeg(month, 'month')}/tasks/${keySeg(taskKey, 'task key')}`,
  webhook: eventKey => `${RTDB_ROOT}/processed_webhooks/${keySeg(eventKey, 'webhook event key')}`,
  migrationRun: runId => `${RTDB_ROOT}/_migrations/mongo_to_rtdb/runs/${keySeg(runId, 'migration run id')}`,
  migrationUser: uid => `${RTDB_ROOT}/_migrations/mongo_to_rtdb/users/${uidSeg(uid)}`,
};
function isRtdbAvailable() {
  return adminDb !== null;
}
function getRtdb() {
  if (!adminDb) {
    throw new AppError('Database temporarily unavailable', 503, 'SERVICE_UNAVAILABLE');
  }
  return adminDb;
}
function dbRef(path) {
  return getRtdb().ref(path);
}
function rootRef() {
  return getRtdb().ref();
}
async function pingRtdb(timeoutMs = 3e3) {
  const started = Date.now();
  if (!adminDb) {
    return { ok: false, latencyMs: 0, error: 'Firebase Admin database is not initialised' };
  }
  let timer;
  try {
    await Promise.race([
      adminDb.ref(paths.health()).get(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`RTDB ping timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err?.message || 'RTDB ping failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// src/routes/health.routes.ts
var healthRouter = Router();
var livenessHandler = (_req, res) => {
  const uptimeSeconds = Math.floor(process.uptime());
  sendSuccess(
    res,
    {
      status: 'ok',
      service: 'nanobrowser-backend',
      version: '0.1.0',
      uptime: `${uptimeSeconds}s`,
    },
    'Service alive',
    200,
  );
};
healthRouter.get('/health', livenessHandler);
healthRouter.get('/health/live', livenessHandler);
var readinessHandler = async (_req, res) => {
  const uptimeSeconds = Math.floor(process.uptime());
  if (!isRtdbAvailable()) {
    sendError(res, 'Database dependency unavailable', 503, 'SERVICE_UNAVAILABLE', {
      database: { provider: 'firebase-rtdb', isConnected: false, state: 'not_configured' },
    });
    return;
  }
  const ping = await pingRtdb();
  const database = {
    provider: 'firebase-rtdb',
    namespace: RTDB_ROOT,
    isConnected: ping.ok,
    state: ping.ok ? 'connected' : 'unreachable',
    latencyMs: ping.latencyMs,
    hasServiceAccount: hasAdminCredentials(),
  };
  if (!ping.ok) {
    sendError(res, 'Database dependency unavailable', 503, 'SERVICE_UNAVAILABLE', { database });
    return;
  }
  sendSuccess(
    res,
    {
      status: 'ready',
      service: 'nanobrowser-backend',
      version: '0.1.0',
      uptime: `${uptimeSeconds}s`,
      database,
    },
    'Service ready',
    200,
  );
};
healthRouter.get('/ready', readinessHandler);
healthRouter.get('/health/ready', readinessHandler);

// src/routes/auth.routes.ts
import { Router as Router2 } from 'express';

// src/services/rtdb/repositories.ts
import { ServerValue } from 'firebase-admin/database';
async function applyUpdates(updates) {
  const clean = {};
  for (const [path, value] of Object.entries(updates)) {
    if (value === void 0) continue;
    clean[path] = value === null || isServerValue(value) ? value : stripUndefined(value);
  }
  if (Object.keys(clean).length === 0) return;
  await rootRef().update(clean);
}
function isServerValue(value) {
  return typeof value === 'object' && value !== null && '.sv' in value;
}
function increment(delta) {
  return ServerValue.increment(delta);
}
async function readVal(path) {
  const snap = await dbRef(path).get();
  return snap.exists() ? snap.val() : null;
}
function childrenOf(snap) {
  const out = [];
  snap.forEach(child => {
    out.push(child.val());
    return false;
  });
  return out;
}
async function readCount(path) {
  const value = await readVal(path);
  return typeof value === 'number' ? value : null;
}
async function pageNewestFirst(listPath, orderField, page, limit) {
  const snap = await dbRef(listPath)
    .orderByChild(orderField)
    .limitToLast(page * limit)
    .get();
  const items = childrenOf(snap).reverse();
  return items.slice((page - 1) * limit, page * limit);
}
async function countChildren(listPath) {
  const snap = await dbRef(listPath).get();
  return snap.exists() ? snap.numChildren() : 0;
}
var UserProfileRepository = class {
  static get(uid) {
    return readVal(paths.userProfile(uid));
  }
  static async set(uid, record) {
    await dbRef(paths.userProfile(uid)).set(stripUndefined(record));
  }
  static async exists(uid) {
    const snap = await dbRef(`${paths.userProfile(uid)}/createdAt`).get();
    return snap.exists();
  }
};
var PlanRepository = class {
  static get(code) {
    return readVal(paths.plan(code));
  }
  static async list() {
    const all = await readVal(paths.plans());
    return all ? Object.values(all) : [];
  }
  /** Creates the plan only if no plan with that code exists. Returns true when it was created. */
  static async createIfMissing(plan) {
    const result = await dbRef(paths.plan(plan.code)).transaction(current =>
      current === null ? stripUndefined(plan) : void 0,
    );
    return result.committed;
  }
  static async update(code, patch) {
    await dbRef(paths.plan(code)).update(stripUndefined(patch));
  }
};
var SubscriptionRepository = class {
  static getTrialFlag(uid) {
    return readVal(paths.trialFlag(uid));
  }
  /**
   * Atomically claims the user's one free trial. Returns false when the trial was already used.
   * Replaces User.hasUsedTrial plus the Mongo partial unique index {userId, isTrial: true}.
   */
  static async claimTrialFlag(uid, now) {
    let alreadyUsed = false;
    const result = await dbRef(paths.trialFlag(uid)).transaction(current => {
      alreadyUsed = false;
      if (current && current.hasUsedTrial) {
        alreadyUsed = true;
        return current;
      }
      return { hasUsedTrial: true, trialUsedAt: now };
    });
    return result.committed && !alreadyUsed;
  }
  static async releaseTrialFlag(uid) {
    await dbRef(paths.trialFlag(uid)).remove();
  }
  static getCurrent(uid) {
    return readVal(paths.subscription(uid));
  }
  /** Writes the current subscription only if the user has none. Returns true when it was created. */
  static async createCurrentIfMissing(uid, record) {
    const result = await dbRef(paths.subscription(uid)).transaction(current =>
      current === null ? stripUndefined(record) : void 0,
    );
    return result.committed;
  }
  /**
   * Applies `mutate` to the user's current subscription atomically. `mutate` returns the new
   * record, or null for "no change". Returns the subscription after the transaction and whether
   * it changed.
   */
  static async transactCurrent(uid, mutate) {
    let changed = false;
    const result = await dbRef(paths.subscription(uid)).transaction(current => {
      changed = false;
      if (current === null) return null;
      const next = mutate(structuredClone(current));
      if (next === null) return current;
      changed = true;
      return stripUndefined(next);
    });
    return {
      changed: result.committed && changed,
      subscription: result.snapshot.val() ?? null,
    };
  }
  /** Subscriptions with a given status (needs `.indexOn: ["status"]` on subscriptions). */
  static async listByStatus(status) {
    const snap = await dbRef(paths.subscriptions()).orderByChild('status').equalTo(status).get();
    return childrenOf(snap);
  }
  static async listHistory(uid) {
    const all = await readVal(paths.subscriptionHistory(uid));
    return all ? Object.values(all) : [];
  }
  static getProviderLink(providerKey) {
    return readVal(paths.providerSubscription(providerKey));
  }
  /**
   * Links a Razorpay subscription id to one user (the Mongo unique index on
   * Subscription.providerSubscriptionId). Returns the owner after the claim.
   */
  static async claimProviderLink(providerKey, link) {
    const result = await dbRef(paths.providerSubscription(providerKey)).transaction(current =>
      current === null ? stripUndefined(link) : void 0,
    );
    if (result.committed) return { ownerUid: link.uid, claimedNow: true };
    const existing = result.snapshot.val();
    if (existing) return { ownerUid: existing.uid, claimedNow: false };
    const fresh = await this.getProviderLink(providerKey);
    return { ownerUid: fresh?.uid ?? link.uid, claimedNow: false };
  }
  static async updateProviderLink(providerKey, fields) {
    await dbRef(paths.providerSubscription(providerKey)).update(stripUndefined(fields));
  }
  static getCheckoutSession(uid, planCode) {
    return readVal(paths.checkoutSession(uid, planCode));
  }
  static async setCheckoutSession(uid, planCode, session) {
    await dbRef(paths.checkoutSession(uid, planCode)).set(session);
  }
  static async clearCheckoutSession(uid, planCode) {
    await dbRef(paths.checkoutSession(uid, planCode)).remove();
  }
};
var CreditRepository = class {
  static getBalance(uid) {
    return readVal(paths.creditBalance(uid));
  }
  /** Every user's balance — used only by admin scripts. */
  static async listBalances() {
    return (await readVal(paths.creditBalances())) ?? {};
  }
  /** Atomically subtracts `amount` if remainingCredits >= amount (the Mongo `$gte` + `$inc` guard). */
  static async deduct(uid, amount, now) {
    let outcome = 'NO_BALANCE';
    let balanceBefore = 0;
    let balanceAfter = 0;
    const result = await dbRef(paths.creditBalance(uid)).transaction(current => {
      outcome = 'NO_BALANCE';
      if (current === null) return null;
      balanceBefore = current.remainingCredits;
      balanceAfter = current.remainingCredits;
      if (current.remainingCredits < amount) {
        outcome = 'INSUFFICIENT';
        return current;
      }
      outcome = 'APPLIED';
      balanceAfter = current.remainingCredits - amount;
      return {
        ...current,
        usedCredits: (current.usedCredits || 0) + amount,
        remainingCredits: balanceAfter,
        updatedAt: now,
      };
    });
    return {
      outcome: result.committed ? outcome : 'NO_BALANCE',
      balanceBefore,
      balanceAfter,
      balance: result.snapshot.val() ?? null,
    };
  }
  /** Atomically adds `amount` back (usedCredits never goes below zero). */
  static async refund(uid, amount, now) {
    let outcome = 'NO_BALANCE';
    let balanceBefore = 0;
    let balanceAfter = 0;
    const result = await dbRef(paths.creditBalance(uid)).transaction(current => {
      outcome = 'NO_BALANCE';
      if (current === null) return null;
      outcome = 'APPLIED';
      balanceBefore = current.remainingCredits;
      balanceAfter = current.remainingCredits + amount;
      return {
        ...current,
        usedCredits: Math.max(0, (current.usedCredits || 0) - amount),
        remainingCredits: balanceAfter,
        updatedAt: now,
      };
    });
    return {
      outcome: result.committed ? outcome : 'NO_BALANCE',
      balanceBefore,
      balanceAfter,
      balance: result.snapshot.val() ?? null,
    };
  }
  /** Admin top-up: allocated = remaining = credits; creates the balance if missing. */
  static async setBalanceForAdmin(uid, credits, now, onPrevious) {
    const fallbackSubscriptionId = (await readVal(`${paths.subscription(uid)}/subscriptionId`)) ?? '';
    const result = await dbRef(paths.creditBalance(uid)).transaction(current => {
      onPrevious(current?.remainingCredits ?? 0);
      return {
        subscriptionId: current?.subscriptionId ?? fallbackSubscriptionId,
        allocatedCredits: credits,
        usedCredits: current?.usedCredits ?? 0,
        remainingCredits: credits,
        periodStart: current?.periodStart ?? now,
        periodEnd: current?.periodEnd ?? now + 30 * 24 * 60 * 60 * 1e3,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
    });
    return result.snapshot.val();
  }
  /** Update-map entries that append one ledger entry and bump the per-user counter. */
  static ledgerAppendUpdates(uid, entry) {
    return {
      [paths.creditLedgerEntry(uid, entry.entryId)]: entry,
      [paths.creditLedgerCount(uid)]: increment(1),
    };
  }
  static getLedgerEntry(uid, entryId) {
    return readVal(paths.creditLedgerEntry(uid, entryId));
  }
  /** Ledger entries for one agent run (needs `.indexOn: ["runId"]` on credit_ledger/$uid). */
  static async findLedgerByRunId(uid, runId) {
    try {
      const snap = await dbRef(paths.creditLedger(uid)).orderByChild('runId').equalTo(runId).get();
      return childrenOf(snap);
    } catch (err) {
      logger.warn(
        `[CreditRepository.findLedgerByRunId] Indexed query for runId "${runId}" on user ${uid} failed: ${err?.message}. Falling back to user ledger scan.`,
      );
      const snap = await dbRef(paths.creditLedger(uid)).get();
      const all = childrenOf(snap);
      return all.filter(entry => entry.runId === runId || entry.metadata?.runId === runId);
    }
  }
  /** All ledger entries matching runId exactly or starting with `<runId>_`. */
  static async findLedgerByRunIdPrefix(uid, runIdPrefix) {
    const all = await this.getAllLedger(uid);
    return all.filter(
      entry => entry.runId && (entry.runId === runIdPrefix || entry.runId.startsWith(`${runIdPrefix}_`)),
    );
  }
  /**
   * Finds deductions belonging to an interrupted agent run.
   * If runId has exact matches, returns those.
   * If runId is a loop prefix (e.g. `auto_loop_<timestamp>`), returns deductions for jobs under this
   * loop that were NOT successfully completed (i.e. not recorded as status === 'applied' in job_applications).
   */
  static async findInterruptedRunEntries(uid, runId) {
    const exact = await this.findLedgerByRunId(uid, runId);
    if (exact.length > 0) return exact;
    const prefixEntries = await this.findLedgerByRunIdPrefix(uid, runId);
    if (prefixEntries.length === 0) return [];
    const completedJobIds = /* @__PURE__ */ new Set();
    const appSnap = await dbRef(paths.jobApplications(uid)).get();
    if (appSnap.exists()) {
      const apps = childrenOf(appSnap);
      for (const app2 of apps) {
        const statusUpper = String(app2.status || '').toUpperCase();
        if (statusUpper === 'APPLIED' && app2.jobId) {
          completedJobIds.add(app2.jobId);
        }
      }
    }
    return prefixEntries.filter(entry => {
      if (!entry.runId) return false;
      if (entry.runId === runId) return true;
      const suffix = entry.runId.slice(runId.length + 1);
      if (completedJobIds.has(suffix)) return false;
      return true;
    });
  }
  static async listLedger(uid, page, limit) {
    const items = await pageNewestFirst(paths.creditLedger(uid), 'createdAt', page, limit);
    const total = (await readCount(paths.creditLedgerCount(uid))) ?? (await countChildren(paths.creditLedger(uid)));
    return { items, total };
  }
  static idempotencyKeyHash(key) {
    return hashKey(key);
  }
  static getIdempotencyClaim(uid, key) {
    return readVal(paths.creditIdempotency(uid, hashKey(key)));
  }
  /** Claims an idempotency key (create-if-absent). Returns the existing claim when it was taken. */
  static async claimIdempotency(uid, key, now) {
    const claim = { idempotencyKey: key, status: 'PENDING', createdAt: now };
    const result = await dbRef(paths.creditIdempotency(uid, hashKey(key))).transaction(current =>
      current === null ? claim : void 0,
    );
    if (result.committed) return { claimed: true, existing: null };
    return { claimed: false, existing: result.snapshot.val() ?? null };
  }
  /** Takes over a PENDING claim older than `staleBefore` (its owner crashed). */
  static async reclaimStaleIdempotency(uid, key, staleBefore, now) {
    let reclaimed = false;
    const result = await dbRef(paths.creditIdempotency(uid, hashKey(key))).transaction(current => {
      reclaimed = false;
      if (current === null) {
        reclaimed = true;
        return { idempotencyKey: key, status: 'PENDING', createdAt: now };
      }
      if (current.status === 'PENDING' && current.createdAt < staleBefore) {
        reclaimed = true;
        return { ...current, createdAt: now };
      }
      return current;
    });
    return result.committed && reclaimed;
  }
  static idempotencyCompleteUpdates(uid, key, entryId, now) {
    const base = paths.creditIdempotency(uid, hashKey(key));
    return {
      [`${base}/status`]: 'COMPLETED',
      [`${base}/entryId`]: entryId,
      [`${base}/completedAt`]: now,
    };
  }
  static async releaseIdempotency(uid, key) {
    await dbRef(paths.creditIdempotency(uid, hashKey(key))).remove();
  }
  static async recordFailedRefund(uid, record) {
    await dbRef(paths.failedRefund(uid, record.runId)).set(stripUndefined(record));
  }
  static async getAllLedger(uid) {
    const snap = await dbRef(paths.creditLedger(uid)).get();
    return childrenOf(snap);
  }
  static async recordReconcileAudit(uid, record) {
    await dbRef(paths.reconcileAuditLogEntry(uid, record.auditId)).set(stripUndefined(record));
  }
};
var CareerBrainRepository = class {
  static get(uid) {
    return readVal(paths.careerBrain(uid));
  }
  /** Cheap existence check (reads one small child, not the whole profile). */
  static async exists(uid) {
    const snap = await dbRef(paths.careerBrainField(uid, 'createdAt')).get();
    return snap.exists();
  }
  static async set(uid, record) {
    await dbRef(paths.careerBrain(uid)).set(stripUndefined(record));
  }
  /** Creates the profile only if none exists. Returns true when it was created. */
  static async createIfMissing(uid, record) {
    const result = await dbRef(paths.careerBrain(uid)).transaction(current =>
      current === null ? stripUndefined(record) : void 0,
    );
    return result.committed;
  }
  /** Partial update; keys may be nested paths such as "dailyQuota/dailyLimit". */
  static async update(uid, patch) {
    await dbRef(paths.careerBrain(uid)).update(stripUndefined(patch));
  }
  static getQuota(uid) {
    return readVal(paths.careerBrainField(uid, 'dailyQuota'));
  }
  static getTier(uid) {
    return readVal(paths.careerBrainField(uid, 'tier'));
  }
  /**
   * Atomic read-modify-write of the daily quota node. When the node is empty (or not cached yet)
   * `mutate` receives `seed` — the same `normalizeState(raw) ?? seed` approach as JobForm
   * Automator's consumeInterviewCredit: if the node really exists, RTDB rejects the seeded write
   * and re-runs `mutate` with the stored value. `mutate` must always return the quota to store.
   */
  static async transactQuota(uid, seed, mutate) {
    const result = await dbRef(paths.careerBrainField(uid, 'dailyQuota')).transaction(current =>
      mutate(current ? { ...current } : { ...seed }),
    );
    return result.snapshot.val() ?? seed;
  }
};
var JobApplicationRepository = class {
  /** LinkedIn (and calls without a platform) keep the original bare-jobId key. */
  static jobKey(jobId, platform) {
    return platform && platform !== 'linkedin' ? hashKey(`${platform}:${jobId}`) : hashKey(jobId);
  }
  /**
   * Claims the {uid, platform, jobId} triple (the Mongo unique index). Returns the application id
   * that owns it and whether this call created the claim.
   */
  static async claimJobKey(uid, jobId, platform, candidateAppId) {
    const keyPath = paths.jobApplicationKey(uid, this.jobKey(jobId, platform));
    const result = await dbRef(keyPath).transaction(current => (current === null ? candidateAppId : void 0));
    if (result.committed) return { appId: candidateAppId, isNew: true };
    const existing = result.snapshot.val();
    if (existing) return { appId: existing, isNew: false };
    const fresh = await readVal(keyPath);
    return { appId: fresh ?? candidateAppId, isNew: !fresh };
  }
  static getAppIdForJob(uid, jobId, platform) {
    return readVal(paths.jobApplicationKey(uid, this.jobKey(jobId, platform)));
  }
  static get(uid, appId) {
    return readVal(paths.jobApplication(uid, appId));
  }
  /** Writes the record; `countAsNew` bumps the per-user counter in the same atomic update. */
  static async save(uid, record, countAsNew) {
    const updates = { [paths.jobApplication(uid, record.appId)]: record };
    if (countAsNew) updates[paths.jobApplicationCount(uid)] = increment(1);
    await applyUpdates(updates);
  }
  /** Field-level update of an existing application (doesn't rewrite the other fields). */
  static async patch(uid, appId, fields) {
    await dbRef(paths.jobApplication(uid, appId)).update(stripUndefined(fields));
  }
  static async list(uid, page, limit) {
    const items = await pageNewestFirst(paths.jobApplications(uid), 'updatedAt', page, limit);
    const total =
      (await readCount(paths.jobApplicationCount(uid))) ?? (await countChildren(paths.jobApplications(uid)));
    return { items, total };
  }
  /** Status filter (needs `.indexOn: ["status"]`), newest first. */
  static async listByStatus(uid, status, page, limit) {
    const snap = await dbRef(paths.jobApplications(uid)).orderByChild('status').equalTo(status).get();
    const all = childrenOf(snap).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return { items: all.slice((page - 1) * limit, page * limit), total: all.length };
  }
};
var LlmUsageRepository = class {
  static async create(uid, record) {
    await applyUpdates({
      [paths.llmUsageEntry(uid, record.usageId)]: record,
      [paths.llmUsageCount(uid)]: increment(1),
    });
  }
  /** Needs `.indexOn: ["idempotencyKey"]` on llm_usage/$uid. */
  static async findByIdempotencyKey(uid, key) {
    const snap = await dbRef(paths.llmUsage(uid)).orderByChild('idempotencyKey').equalTo(key).limitToFirst(1).get();
    return childrenOf(snap)[0] ?? null;
  }
  static async list(uid, page, limit) {
    const items = await pageNewestFirst(paths.llmUsage(uid), 'createdAt', page, limit);
    const total = (await readCount(paths.llmUsageCount(uid))) ?? (await countChildren(paths.llmUsage(uid)));
    return { items, total };
  }
};
var WebhookRepository = class {
  static get(eventKey) {
    return readVal(paths.webhook(eventKey));
  }
  /**
   * Atomically claims a webhook event for processing (replaces the Mongo unique index on
   * WebhookLedger.eventId plus the "stuck PROCESSING > 2 minutes" reclaim).
   */
  static async claim(eventKey, init, now, stuckAfterMs) {
    let outcome = 'CLAIMED';
    await dbRef(paths.webhook(eventKey)).transaction(current => {
      if (current === null) {
        outcome = 'CLAIMED';
        return stripUndefined({ ...init, status: 'PROCESSING', createdAt: now, updatedAt: now });
      }
      if (current.status === 'PROCESSED') {
        outcome = 'ALREADY_PROCESSED';
        return void 0;
      }
      const startedAt = current.updatedAt ?? current.createdAt ?? 0;
      if (current.status === 'PROCESSING' && now - startedAt < stuckAfterMs) {
        outcome = 'IN_FLIGHT';
        return void 0;
      }
      outcome = 'RECLAIMED';
      const { errorMessage: _ignored, ...rest } = current;
      return stripUndefined({ ...rest, status: 'PROCESSING', updatedAt: now });
    });
    return outcome;
  }
  static async markProcessed(eventKey, now) {
    await dbRef(paths.webhook(eventKey)).update({
      status: 'PROCESSED',
      processedAt: now,
      updatedAt: now,
      errorMessage: null,
    });
  }
  static async markFailed(eventKey, message, now) {
    await dbRef(paths.webhook(eventKey)).update({
      status: 'FAILED',
      errorMessage: message.slice(0, 2e3),
      updatedAt: now,
    });
  }
};

// src/services/userProfile.service.ts
var UserProfileService = class {
  static getProfile(uid) {
    return UserProfileRepository.get(uid);
  }
  /** Writes the identity record for a newly created user. */
  static async writeProfile(uid, data) {
    await UserProfileRepository.set(uid, {
      name: data.name,
      email: data.email,
      role: 'user',
      status: 'active',
      googleLinked: data.googleLinked,
      picture: data.picture,
      createdAt: data.createdAt,
      updatedAt: data.createdAt,
    });
  }
  /** Writes the identity record only if the user doesn't have one yet. Returns true when it was created. */
  static async ensureProfile(uid, data) {
    if (await UserProfileRepository.exists(uid)) return false;
    await this.writeProfile(uid, data);
    return true;
  }
};

// src/services/rtdb/serializers.ts
function optionalIso(value) {
  return value === void 0 || value === null ? void 0 : (toIso(value) ?? void 0);
}
function toSubscriptionDto(record) {
  return {
    _id: record.subscriptionId,
    userId: record.uid,
    planId: record.planId,
    planCodeSnapshot: record.planCodeSnapshot,
    planNameSnapshot: record.planNameSnapshot,
    amountSnapshot: record.amountSnapshot,
    currencySnapshot: record.currencySnapshot,
    billingIntervalSnapshot: record.billingIntervalSnapshot,
    creditsSnapshot: record.creditsSnapshot,
    rateLimitSnapshot: record.rateLimitSnapshot,
    provider: record.provider,
    providerCustomerId: record.providerCustomerId,
    providerSubscriptionId: record.providerSubscriptionId,
    status: record.status,
    isTrial: Boolean(record.isTrial),
    trialStartDate: optionalIso(record.trialStartDate),
    trialEndDate: optionalIso(record.trialEndDate),
    currentPeriodStart: toIso(record.currentPeriodStart),
    currentPeriodEnd: toIso(record.currentPeriodEnd),
    cancelAtPeriodEnd: Boolean(record.cancelAtPeriodEnd),
    canceledAt: optionalIso(record.canceledAt),
    endedAt: optionalIso(record.endedAt),
    pastDueStartedAt: optionalIso(record.pastDueStartedAt),
    lastEventTimestamp: optionalIso(record.lastEventTimestamp),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}
function toPlanDto(record) {
  return {
    _id: record.legacyId || record.code,
    code: record.code,
    name: record.name,
    description: record.description,
    amount: record.amount,
    currency: record.currency,
    billingInterval: record.billingInterval,
    creditsPerBillingPeriod: record.creditsPerBillingPeriod,
    rateLimitPerMinute: record.rateLimitPerMinute,
    features: toArray(record.features),
    razorpayPlanId: record.razorpayPlanId,
    isActive: Boolean(record.isActive),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}
function toCreditBalanceDto(uid, record) {
  return {
    _id: uid,
    userId: uid,
    subscriptionId: record.subscriptionId,
    allocatedCredits: record.allocatedCredits,
    usedCredits: record.usedCredits,
    remainingCredits: record.remainingCredits,
    periodStart: toIso(record.periodStart),
    periodEnd: toIso(record.periodEnd),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}
function toCreditLedgerDto(record) {
  return {
    _id: record.entryId,
    userId: record.uid,
    subscriptionId: record.subscriptionId,
    amount: record.amount,
    balanceBefore: record.balanceBefore,
    balanceAfter: record.balanceAfter,
    type: record.type,
    description: record.description,
    idempotencyKey: record.idempotencyKey,
    metadata: record.metadata ?? {},
    createdAt: toIso(record.createdAt),
  };
}
function toJobApplicationDto(record) {
  return {
    _id: record.appId,
    userId: record.uid,
    jobId: record.jobId,
    title: record.title,
    company: record.company,
    location: record.location ?? '',
    salaryRange: record.salaryRange ?? '',
    fitScore: record.fitScore ?? 0,
    platform: record.platform ?? 'linkedin',
    applicationUrl: record.applicationUrl ?? '',
    jobDescription: record.jobDescription ?? '',
    companyWebsite: record.companyWebsite ?? '',
    failureReason: record.failureReason ?? '',
    status: record.status,
    appliedAt: toIso(record.appliedAt),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}
function toLlmUsageDto(record) {
  return {
    _id: record.usageId,
    requestId: record.requestId,
    userId: record.uid,
    provider: record.provider,
    model: record.model,
    promptTokens: record.promptTokens ?? 0,
    completionTokens: record.completionTokens ?? 0,
    totalTokens: record.totalTokens ?? 0,
    creditsDeducted: record.creditsDeducted ?? 0,
    latencyMs: record.latencyMs ?? 0,
    status: record.status,
    errorMessage: record.errorMessage,
    idempotencyKey: record.idempotencyKey,
    metadata: record.metadata,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}
function skillExperienceFromList(list) {
  const out = {};
  for (const entry of toArray(list)) {
    if (entry && typeof entry.skill === 'string' && entry.skill) out[entry.skill] = Number(entry.years) || 0;
  }
  return out;
}
function customAnswersFromList(list) {
  const out = {};
  for (const entry of toArray(list)) {
    if (entry && typeof entry.question === 'string' && entry.question) out[entry.question] = String(entry.answer ?? '');
  }
  return out;
}
function workExperienceItemDto(item) {
  return {
    id: item?.id ?? '',
    company: item?.company ?? '',
    title: item?.title ?? '',
    startMonth: item?.startMonth ?? '',
    startYear: item?.startYear ?? '',
    endMonth: item?.endMonth ?? null,
    endYear: item?.endYear ?? null,
    isCurrent: item?.isCurrent ?? false,
    description: item?.description ?? '',
    source: item?.source ?? 'manual',
  };
}
function workHistoryItemDto(item) {
  return {
    role: item?.role ?? '',
    company: item?.company ?? '',
    duration: item?.duration ?? '',
    highlights: toArray(item?.highlights),
  };
}
function goldenAnswerDto(item) {
  return {
    id: item?.id ?? '',
    question: item?.question ?? '',
    answer: item?.answer ?? '',
    category: item?.category ?? 'General',
    isDefault: item?.isDefault ?? false,
  };
}
function toCareerBrainDto(record) {
  return {
    _id: record.legacyId || record.uid,
    userId: record.uid,
    fullName: record.fullName ?? '',
    email: record.email ?? '',
    phoneNumber: record.phoneNumber ?? '',
    currentTitle: record.currentTitle ?? '',
    resumeText: record.resumeText ?? '',
    resumeFileName: record.resumeFileName ?? '',
    backgroundNarrative: record.backgroundNarrative ?? '',
    skills: toArray(record.skills),
    yearsOfExperience: record.yearsOfExperience ?? 0,
    hasWorkExperience: record.hasWorkExperience ?? true,
    workExperience: toArray(record.workExperience).map(workExperienceItemDto),
    education: record.education ?? '',
    college: record.college ?? '',
    cgpa: record.cgpa ?? '',
    workHistory: toArray(record.workHistory).map(workHistoryItemDto),
    noticePeriod: record.noticePeriod ?? 'Immediate',
    workAuthorization: record.workAuthorization ?? 'Authorized to work',
    skillExperience: skillExperienceFromList(record.skillExperienceList),
    salaryExpectation: record.salaryExpectation ?? '',
    currentLocation: record.currentLocation ?? '',
    preferredLocation: record.preferredLocation ?? '',
    preferredLocations: toArray(record.preferredLocations),
    portfolioUrl: record.portfolioUrl ?? '',
    githubUrl: record.githubUrl ?? '',
    linkedinUrl: record.linkedinUrl ?? '',
    goldenAnswers: toArray(record.goldenAnswers).map(goldenAnswerDto),
    customAnswers: customAnswersFromList(record.customAnswersList),
    tier: record.tier ?? 'free',
    dailyQuota: {
      appliedToday: record.dailyQuota?.appliedToday ?? 0,
      dailyLimit: record.dailyQuota?.dailyLimit ?? 15,
      lastResetDate: record.dailyQuota?.lastResetDate ?? '',
    },
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}

// src/services/rtdb/records.ts
var ENTITLED_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE'];
var JOB_APPLICATION_STATUSES = [
  'QUEUED',
  'APPLIED',
  'DRY_RUN_SUCCESS',
  'NEEDS_MANUAL_REVIEW',
  'FAILED_MISSING_DATA',
  'PENDING_RESUME_APPROVAL',
  'SKIPPED_JOB_REMOVED',
  'SKIPPED_MISSING_RESUME',
  /** The extension attempted the application but could not complete it. Retryable. */
  'FAILED',
];
var JOB_APPLICATION_PLATFORMS = ['linkedin', 'naukri', 'indeed'];

// src/services/credit.service.ts
var STALE_CLAIM_MS = 2 * 60 * 1e3;
var CLAIM_WAIT_STEPS_MS = [50, 100, 200, 300, 500, 700, 1e3];
function runIdOf(metadata) {
  const runId = metadata?.runId;
  return typeof runId === 'string' && runId.trim() ? runId.trim() : void 0;
}
var CreditService = class {
  /**
   * Builds the atomic update that resets a user's balance for a subscription period and records
   * the allocation in the ledger. Callers can merge it with other writes (e.g. the subscription
   * itself) so both land together.
   */
  static async buildAllocationUpdates(params) {
    const {
      userId,
      subscriptionId,
      allocatedCredits,
      periodStart,
      periodEnd,
      description = 'Initial subscription credit allocation',
      type = 'TRIAL_ALLOCATION',
    } = params;
    if (!Number.isInteger(allocatedCredits) || allocatedCredits < 0) {
      throw new AppError('Allocated credits must be a non-negative integer', 400, 'INVALID_AMOUNT');
    }
    const now = Date.now();
    const existing = await CreditRepository.getBalance(userId);
    const balance = {
      subscriptionId,
      allocatedCredits,
      usedCredits: 0,
      remainingCredits: allocatedCredits,
      periodStart: toMs(periodStart) ?? now,
      periodEnd: toMs(periodEnd) ?? now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const entry = {
      entryId: newId('cl'),
      uid: userId,
      subscriptionId,
      amount: allocatedCredits,
      balanceBefore: existing ? existing.remainingCredits : 0,
      balanceAfter: allocatedCredits,
      type,
      description,
      createdAt: now,
    };
    return {
      updates: { [paths.creditBalance(userId)]: balance, ...CreditRepository.ledgerAppendUpdates(userId, entry) },
      balance,
      entry,
    };
  }
  /**
   * Initializes or resets credits for a user subscription.
   * Atomically writes the balance and an allocation entry in the ledger.
   */
  static async initializeCreditsForSubscription(params) {
    const { updates, balance } = await this.buildAllocationUpdates(params);
    await applyUpdates(updates);
    logger.info(
      `Initialized ${params.allocatedCredits} credits (${params.type ?? 'TRIAL_ALLOCATION'}) for user ${params.userId} on subscription ${params.subscriptionId}`,
    );
    return toCreditBalanceDto(params.userId, balance);
  }
  /** Takes the idempotency claim for `key`, waiting briefly for a concurrent request using the same key. */
  static async acquireClaim(uid, key) {
    for (let attempt = 0; attempt <= CLAIM_WAIT_STEPS_MS.length; attempt++) {
      const now = Date.now();
      const { claimed, existing } = await CreditRepository.claimIdempotency(uid, key, now);
      if (claimed) return { kind: 'OWNED' };
      if (existing?.status === 'COMPLETED' && existing.entryId) {
        return { kind: 'COMPLETED', entryId: existing.entryId };
      }
      if (existing?.status === 'PENDING' && existing.createdAt < now - STALE_CLAIM_MS) {
        if (await CreditRepository.reclaimStaleIdempotency(uid, key, now - STALE_CLAIM_MS, now)) {
          logger.warn(`Reclaimed stale idempotency claim '${key}' for user ${uid}`);
          return { kind: 'OWNED' };
        }
      }
      if (attempt < CLAIM_WAIT_STEPS_MS.length) await sleep(CLAIM_WAIT_STEPS_MS[attempt]);
    }
    throw new AppError(
      'A request with this idempotency key is still being processed. Retry shortly.',
      409,
      'IDEMPOTENCY_KEY_IN_PROGRESS',
    );
  }
  static async idempotentResult(uid, entryId) {
    const [entry, balance] = await Promise.all([
      CreditRepository.getLedgerEntry(uid, entryId),
      CreditRepository.getBalance(uid),
    ]);
    if (!entry || !balance) {
      throw new AppError('Idempotent result is no longer available', 409, 'IDEMPOTENCY_RESULT_MISSING');
    }
    return {
      balance: toCreditBalanceDto(uid, balance),
      ledgerEntry: toCreditLedgerDto(entry),
      isIdempotentRetry: true,
    };
  }
  /**
   * Atomically deducts credits from a user's balance.
   * Never lets the balance go negative; a given idempotencyKey deducts at most once.
   */
  static async deductCredits(params) {
    const { userId, amount, description, idempotencyKey, metadata } = params;
    if (amount <= 0 || !Number.isInteger(amount)) {
      throw new AppError('Deduction amount must be a positive integer', 400, 'INVALID_AMOUNT');
    }
    if (idempotencyKey) {
      const claim = await this.acquireClaim(userId, idempotencyKey);
      if (claim.kind === 'COMPLETED') {
        logger.info(`Idempotent retry detected for key '${idempotencyKey}', returning existing result`);
        return this.idempotentResult(userId, claim.entryId);
      }
    }
    let deducted = false;
    try {
      const now = Date.now();
      const result = await CreditRepository.deduct(userId, amount, now);
      if (result.outcome === 'NO_BALANCE' || !result.balance) {
        throw new AppError('No credit balance found for user. Please contact support.', 402, 'INSUFFICIENT_CREDITS');
      }
      if (result.outcome === 'INSUFFICIENT') {
        throw new AppError(
          `Insufficient credit balance. Required: ${amount}, Available: ${result.balance.remainingCredits}`,
          402,
          'INSUFFICIENT_CREDITS',
        );
      }
      deducted = true;
      const entry = {
        entryId: newId('cl'),
        uid: userId,
        subscriptionId: result.balance.subscriptionId,
        amount: -amount,
        balanceBefore: result.balanceBefore,
        balanceAfter: result.balanceAfter,
        type: 'USAGE_DEDUCTION',
        description,
        idempotencyKey,
        runId: runIdOf(metadata),
        metadata: metadata || {},
        createdAt: now,
      };
      await applyUpdates({
        ...CreditRepository.ledgerAppendUpdates(userId, entry),
        ...(idempotencyKey
          ? CreditRepository.idempotencyCompleteUpdates(userId, idempotencyKey, entry.entryId, now)
          : {}),
      });
      return {
        balance: toCreditBalanceDto(userId, result.balance),
        ledgerEntry: toCreditLedgerDto(entry),
        isIdempotentRetry: false,
      };
    } catch (error) {
      if (deducted) {
        await CreditRepository.refund(userId, amount, Date.now()).catch(refundErr =>
          logger.error(`Compensating refund failed for user ${userId}: ${refundErr?.message}`),
        );
      }
      if (idempotencyKey) {
        await CreditRepository.releaseIdempotency(userId, idempotencyKey).catch(() => void 0);
      }
      throw error;
    }
  }
  /**
   * Atomically refunds credits back to a user's balance.
   */
  static async refundCredits(params) {
    const { userId, amount, description, idempotencyKey, metadata } = params;
    if (amount <= 0 || !Number.isInteger(amount)) {
      throw new AppError('Refund amount must be a positive integer', 400, 'INVALID_AMOUNT');
    }
    if (idempotencyKey) {
      const claim = await this.acquireClaim(userId, idempotencyKey);
      if (claim.kind === 'COMPLETED') {
        const { balance, ledgerEntry } = await this.idempotentResult(userId, claim.entryId);
        return { balance, ledgerEntry };
      }
    }
    return this.refundCreditsInternal({
      userId,
      amount,
      description,
      idempotencyKey,
      metadata,
    });
  }
  static async refundCreditsInternal(params) {
    const { userId, amount, description, idempotencyKey, metadata } = params;
    let refunded = false;
    try {
      const now = Date.now();
      const result = await CreditRepository.refund(userId, amount, now);
      if (result.outcome !== 'APPLIED' || !result.balance) {
        throw new AppError('Credit balance not found', 404, 'BALANCE_NOT_FOUND');
      }
      refunded = true;
      const entry = {
        entryId: newId('cl'),
        uid: userId,
        subscriptionId: result.balance.subscriptionId,
        amount,
        balanceBefore: result.balanceBefore,
        balanceAfter: result.balanceAfter,
        type: 'REFUND',
        description,
        idempotencyKey,
        runId: runIdOf(metadata),
        metadata: metadata || {},
        createdAt: now,
      };
      await applyUpdates({
        ...CreditRepository.ledgerAppendUpdates(userId, entry),
        ...(idempotencyKey
          ? CreditRepository.idempotencyCompleteUpdates(userId, idempotencyKey, entry.entryId, now)
          : {}),
      });
      return { balance: toCreditBalanceDto(userId, result.balance), ledgerEntry: toCreditLedgerDto(entry) };
    } catch (error) {
      if (refunded) {
        await CreditRepository.deduct(userId, amount, Date.now()).catch(err =>
          logger.error(`Compensating refund reversal failed for user ${userId}: ${err?.message}`),
        );
      }
      if (idempotencyKey) {
        await CreditRepository.releaseIdempotency(userId, idempotencyKey).catch(() => void 0);
      }
      throw error;
    }
  }
  /**
   * Securely and idempotently refunds credits incurred during a specific agent run.
   * Computes the exact amount deducted from the ledger for the given runId and userId.
   * Rejects duplicate refunds for the same runId.
   */
  static async refundRunCredits(params) {
    const { userId, runId } = params;
    if (!runId || typeof runId !== 'string' || runId.trim() === '') {
      throw new AppError('A valid runId is required for refund', 400, 'INVALID_RUN_ID');
    }
    const cleanRunId = runId.trim();
    const idempotencyKey = `refund_run_${cleanRunId}`;
    const claim = await this.acquireClaim(userId, idempotencyKey);
    if (claim.kind === 'COMPLETED') {
      logger.info(`Run ${cleanRunId} has already been refunded. Idempotent return.`);
      try {
        const { balance, ledgerEntry } = await this.idempotentResult(userId, claim.entryId);
        return {
          refundedAmount: ledgerEntry.amount,
          runId: cleanRunId,
          balance,
        };
      } catch (err) {
        const currentBalance = await CreditRepository.getBalance(userId);
        if (currentBalance) {
          return {
            refundedAmount: 0,
            runId: cleanRunId,
            balance: toCreditBalanceDto(userId, currentBalance),
          };
        }
        throw err;
      }
    }
    let refundSucceeded = false;
    try {
      const runEntries = await CreditRepository.findInterruptedRunEntries(userId, cleanRunId);
      const existingRefund = runEntries.find(entry => entry.type === 'REFUND');
      if (existingRefund) {
        logger.info(`Run ${cleanRunId} has already been refunded in ledger. Idempotent return.`);
        const currentBalance = await CreditRepository.getBalance(userId);
        if (!currentBalance) throw new AppError('Credit balance not found', 404, 'BALANCE_NOT_FOUND');
        refundSucceeded = true;
        await applyUpdates(
          CreditRepository.idempotencyCompleteUpdates(userId, idempotencyKey, existingRefund.entryId, Date.now()),
        ).catch(() => void 0);
        return {
          refundedAmount: existingRefund.amount,
          runId: cleanRunId,
          balance: toCreditBalanceDto(userId, currentBalance),
        };
      }
      const usageEntries = runEntries.filter(entry => entry.type === 'USAGE_DEDUCTION');
      if (usageEntries.length === 0) {
        throw new AppError(`No billable usage found for runId: ${cleanRunId}`, 404, 'RUN_NOT_FOUND');
      }
      const totalToRefund = usageEntries.reduce((sum, entry) => sum + Math.abs(entry.amount), 0);
      if (totalToRefund <= 0) {
        throw new AppError(
          `Nothing to refund: no credits were deducted for runId: ${cleanRunId}`,
          400,
          'NOTHING_TO_REFUND',
        );
      }
      const MAX_DAILY_CLIENT_REFUND_CAP = env.MAX_DAILY_REFUND_CAP ?? 50;
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1e3;
      const allUserLedger = await CreditRepository.getAllLedger(userId);
      const recentRefundsTotal = allUserLedger
        .filter(entry => entry.type === 'REFUND' && entry.createdAt >= oneDayAgo)
        .reduce((sum, entry) => sum + Math.abs(entry.amount), 0);
      if (recentRefundsTotal + totalToRefund > MAX_DAILY_CLIENT_REFUND_CAP) {
        logger.warn(
          `[CreditService] Daily refund cap exceeded for user ${userId}. Attempted: ${totalToRefund}, already refunded in 24h: ${recentRefundsTotal}, cap: ${MAX_DAILY_CLIENT_REFUND_CAP}`,
        );
        throw new AppError(
          `Daily refund limit exceeded (${MAX_DAILY_CLIENT_REFUND_CAP} credits/day). Please contact support.`,
          429,
          'DAILY_REFUND_LIMIT_EXCEEDED',
        );
      }
      logger.info(
        `[CreditService] Processing run refund for user ${userId}, runId: ${cleanRunId}, amount: ${totalToRefund}, deductionsCount: ${usageEntries.length}`,
      );
      const refundResult = await this.refundCreditsInternal({
        userId,
        amount: totalToRefund,
        description: `Automatic refund for failed agent run (${cleanRunId})`,
        idempotencyKey,
        metadata: {
          runId: cleanRunId,
          deductionEntriesCount: usageEntries.length,
          refundTimestamp: Date.now(),
          requestedBy: 'client_run_refund',
          originalDeductionsTotal: totalToRefund,
        },
      });
      logger.info(
        `[CreditService] Run refund finalized for user ${userId}, runId: ${cleanRunId}, refunded: ${refundResult.ledgerEntry.amount}, newRemaining: ${refundResult.balance.remainingCredits}`,
      );
      refundSucceeded = true;
      return {
        refundedAmount: refundResult.ledgerEntry.amount,
        runId: cleanRunId,
        balance: refundResult.balance,
      };
    } finally {
      if (!refundSucceeded) {
        await CreditRepository.releaseIdempotency(userId, idempotencyKey).catch(() => void 0);
      }
    }
  }
  /**
   * Admin top-up (scripts/topup_credits.ts): sets allocated and remaining credits to `credits`
   * (usedCredits untouched, as the old Mongo script did) and records an ADMIN_ADJUSTMENT entry.
   */
  static async adminSetBalance(userId, credits, reason) {
    if (!Number.isInteger(credits) || credits < 0) {
      throw new AppError('Credits must be a non-negative integer', 400, 'INVALID_AMOUNT');
    }
    const now = Date.now();
    let before = 0;
    const result = await CreditRepository.setBalanceForAdmin(userId, credits, now, previous => {
      before = previous;
    });
    const entry = {
      entryId: newId('cl'),
      uid: userId,
      subscriptionId: result.subscriptionId,
      amount: credits - before,
      balanceBefore: before,
      balanceAfter: credits,
      type: 'ADMIN_ADJUSTMENT',
      description: reason,
      createdAt: now,
    };
    await applyUpdates(CreditRepository.ledgerAppendUpdates(userId, entry));
    return toCreditBalanceDto(userId, result);
  }
  /**
   * Records a dropped refund report from the client for support audit and automatic reconciliation.
   */
  static async reportFailedRefund(params) {
    const { userId, runId, idempotencyKey, reason } = params;
    if (!runId || !idempotencyKey) {
      throw new AppError('runId and idempotencyKey are required', 400, 'INVALID_INPUT');
    }
    await CreditRepository.recordFailedRefund(userId, {
      runId,
      idempotencyKey,
      reason,
      reportedAt: Date.now(),
    });
    return { recorded: true };
  }
  /**
   * Server-side reconciliation: identifies runs that had credits deducted (USAGE_DEDUCTION)
   * but resulted in NO successful job application, and automatically refunds them.
   *
   * SAFEGUARDS:
   * 1. Only runs older than MIN_RUN_AGE_FOR_RECONCILE_MS (30 mins) to prevent racing active runs.
   * 2. Server-side verification only: reads CreditLedger and LlmUsage logs directly from RTDB.
   * 3. Requires explicit failed state or no successful completion (terminal status: FAILED/TIMEOUT/STOPPED).
   * 4. Enforces a per-user daily reconcile refund cap (MAX_DAILY_RECONCILE_REFUND_CREDITS = 50 credits/day).
   * 5. Persists an immutable audit log entry for every reconciled refund under nanobrowser/reconcile_audit_logs/{uid}.
   */
  static async reconcileUnappliedRuns(userId) {
    const MIN_RUN_AGE_MS = 30 * 60 * 1e3;
    const MAX_DAILY_RECONCILE_CAP = 50;
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1e3;
    const ledger = await CreditRepository.getAllLedger(userId);
    const recentReconcileRefunds = ledger
      .filter(e => e.type === 'REFUND' && e.createdAt >= oneDayAgo && e.description.includes('Automatic refund'))
      .reduce((sum, e) => sum + Math.abs(e.amount), 0);
    let remainingCap = Math.max(0, MAX_DAILY_RECONCILE_CAP - recentReconcileRefunds);
    if (remainingCap <= 0) {
      logger.warn(
        `[CreditService] User ${userId} has hit the daily reconciliation cap (${MAX_DAILY_RECONCILE_CAP} credits)`,
      );
      return { reconciledCount: 0, totalRefunded: 0, refundedRunIds: [], capped: true };
    }
    const runDeductions = {};
    for (const entry of ledger) {
      if (entry.type === 'USAGE_DEDUCTION' && entry.runId) {
        if (!runDeductions[entry.runId]) {
          runDeductions[entry.runId] = {
            totalAmount: 0,
            oldestCreatedAt: entry.createdAt,
            newestCreatedAt: entry.createdAt,
          };
        }
        const info = runDeductions[entry.runId];
        info.totalAmount += Math.abs(entry.amount);
        info.oldestCreatedAt = Math.min(info.oldestCreatedAt, entry.createdAt);
        info.newestCreatedAt = Math.max(info.newestCreatedAt, entry.createdAt);
      }
    }
    const refundedRuns = /* @__PURE__ */ new Set();
    for (const entry of ledger) {
      if (entry.type === 'REFUND' && entry.runId) {
        refundedRuns.add(entry.runId);
      }
    }
    let reconciledCount = 0;
    let totalRefunded = 0;
    const refundedRunIds = [];
    for (const [runId, info] of Object.entries(runDeductions)) {
      if (refundedRuns.has(runId)) continue;
      const age = now - info.newestCreatedAt;
      if (age < MIN_RUN_AGE_MS) {
        logger.info(
          `[CreditService] Run ${runId} is too recent (${Math.round(age / 1e3)}s old < ${MIN_RUN_AGE_MS / 1e3}s). Skipping.`,
        );
        continue;
      }
      if (info.totalAmount > remainingCap) {
        logger.warn(
          `[CreditService] Run ${runId} refund (${info.totalAmount}) would exceed remaining daily cap (${remainingCap}). Skipping.`,
        );
        continue;
      }
      try {
        const refundResult = await this.refundRunCredits({ userId, runId });
        reconciledCount++;
        totalRefunded += refundResult.refundedAmount;
        remainingCap -= refundResult.refundedAmount;
        refundedRunIds.push(runId);
        await CreditRepository.recordReconcileAudit(userId, {
          auditId: newId('recon'),
          runId,
          amount: refundResult.refundedAmount,
          timestamp: now,
          reason: 'unapplied_run_auto_reconciliation',
        });
      } catch (err) {
        logger.warn(`[CreditService] Reconcile skip or failure for run ${runId}:`, err);
      }
    }
    return {
      reconciledCount,
      totalRefunded,
      refundedRunIds,
      capped: remainingCap <= 0,
    };
  }
  /**
   * Retrieves current credit balance for a user.
   */
  static async getCreditBalance(userId) {
    const balance = await CreditRepository.getBalance(userId);
    return balance ? toCreditBalanceDto(userId, balance) : null;
  }
  /**
   * Retrieves paginated credit history for a user sorted by newest first.
   */
  static async getCreditHistory(userId, page = 1, limit = 20) {
    const { items, total } = await CreditRepository.listLedger(userId, page, limit);
    return { items: items.map(toCreditLedgerDto), total, page, limit };
  }
};

// src/services/planSeed.service.ts
function defaultPlans() {
  const starterRazorpayId = process.env.RAZORPAY_PLAN_ID_STARTER || 'plan_TZuBsK8wKLB8G6';
  const proRazorpayId = process.env.RAZORPAY_PLAN_ID_PRO || 'plan_rzp_mock_pro';
  const powerRazorpayId = process.env.RAZORPAY_PLAN_ID_POWER || 'plan_rzp_mock_power';
  return [
    {
      code: 'free-trial',
      name: '5-Day Free Trial',
      description: '5-day free trial with full feature access',
      amount: 0,
      currency: 'INR',
      billingInterval: 'none',
      creditsPerBillingPeriod: process.env.NODE_ENV === 'test' ? 100 : 1e3,
      rateLimitPerMinute: 60,
      features: ['full_browser_automation', 'all_models'],
      isActive: true,
    },
    {
      code: 'starter',
      name: 'Starter Plan',
      description: 'Ideal for small automation tasks',
      amount: 49900,
      // ₹499 in paise
      currency: 'INR',
      billingInterval: 'monthly',
      creditsPerBillingPeriod: 1e3,
      rateLimitPerMinute: 120,
      features: ['full_browser_automation', 'standard_support'],
      razorpayPlanId: starterRazorpayId,
      isActive: true,
    },
    {
      code: 'pro',
      name: 'Pro Automation Plan',
      description: 'For power users needing heavy browser automation',
      amount: 149900,
      // ₹1,499 in paise
      currency: 'INR',
      billingInterval: 'monthly',
      creditsPerBillingPeriod: 5e3,
      rateLimitPerMinute: 300,
      features: ['full_browser_automation', 'priority_support', 'all_models'],
      razorpayPlanId: proRazorpayId,
      isActive: true,
    },
    {
      code: 'power',
      name: 'Power Enterprise Plan',
      description: 'Maximum quota & rate limits for teams',
      amount: 499900,
      // ₹4,999 in paise
      currency: 'INR',
      billingInterval: 'monthly',
      creditsPerBillingPeriod: 25e3,
      rateLimitPerMinute: 600,
      features: ['full_browser_automation', 'dedicated_support', 'all_models', 'unlimited_agents'],
      razorpayPlanId: powerRazorpayId,
      isActive: true,
    },
  ];
}
var PlanSeedService = class {
  /**
   * Idempotently seeds the default plans. Existing plans are kept (manual edits survive) except
   * that a mock Razorpay plan id is replaced once a real one is configured.
   * Returns the free-trial plan, as before.
   */
  static async seedDefaultPlans() {
    const seeded = [];
    for (const planData of defaultPlans()) {
      const now = Date.now();
      const record = {
        ...planData,
        code: planData.code.trim().toLowerCase(),
        createdAt: now,
        updatedAt: now,
      };
      await PlanRepository.createIfMissing(record);
      const existing = (await PlanRepository.get(record.code)) ?? record;
      if (
        planData.razorpayPlanId &&
        !planData.razorpayPlanId.startsWith('plan_rzp_mock_') &&
        existing.razorpayPlanId !== planData.razorpayPlanId
      ) {
        await PlanRepository.update(record.code, { razorpayPlanId: planData.razorpayPlanId, updatedAt: now });
        existing.razorpayPlanId = planData.razorpayPlanId;
      }
      seeded.push(existing);
    }
    logger.info(`Idempotently verified/seeded ${seeded.length} default plans`);
    return toPlanDto(seeded[0]);
  }
};
var PlanService = class {
  /** Active plan by code, or null if missing/inactive. */
  static async getActivePlan(code) {
    const normalized = String(code || '')
      .trim()
      .toLowerCase();
    if (!normalized) return null;
    try {
      const plan = await PlanRepository.get(normalized);
      return plan && plan.isActive ? plan : null;
    } catch (error) {
      if (error?.message?.startsWith('Unsafe')) return null;
      throw error;
    }
  }
  /** Free-trial plan, seeding the defaults first if it doesn't exist yet. */
  static async getFreeTrialPlan() {
    let plan = await this.getActivePlan('free-trial');
    if (!plan) {
      await PlanSeedService.seedDefaultPlans();
      plan = await this.getActivePlan('free-trial');
    }
    return plan;
  }
  /** All active plans, ordered by price (free trial first). */
  static async getActivePlans() {
    const plans = await PlanRepository.list();
    return plans
      .filter(plan => plan.isActive)
      .sort((a, b) => a.amount - b.amount)
      .map(toPlanDto);
  }
};

// src/services/trial.service.ts
var FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1e3;
var PAST_DUE_GRACE_MS = 72 * 3600 * 1e3;
function shouldExpire(sub, now) {
  if (sub.status === 'TRIALING') return typeof sub.trialEndDate === 'number' && sub.trialEndDate <= now;
  if (sub.status === 'PAST_DUE') {
    return typeof sub.pastDueStartedAt === 'number' && sub.pastDueStartedAt <= now - PAST_DUE_GRACE_MS;
  }
  if (sub.status === 'ACTIVE') {
    return Boolean(sub.cancelAtPeriodEnd) && typeof sub.currentPeriodEnd === 'number' && sub.currentPeriodEnd <= now;
  }
  return false;
}
function trialSubscriptionRecord(uid, plan, trialStart, trialEnd, now) {
  const record = {
    subscriptionId: newId('sub'),
    uid,
    planId: plan.legacyId || plan.code,
    planCodeSnapshot: plan.code,
    planNameSnapshot: plan.name,
    amountSnapshot: plan.amount,
    currencySnapshot: plan.currency,
    billingIntervalSnapshot: plan.billingInterval,
    creditsSnapshot: plan.creditsPerBillingPeriod,
    rateLimitSnapshot: plan.rateLimitPerMinute,
    provider: 'manual',
    status: 'TRIALING',
    isTrial: true,
    trialStartDate: trialStart,
    trialEndDate: trialEnd,
    currentPeriodStart: trialStart,
    currentPeriodEnd: trialEnd,
    cancelAtPeriodEnd: false,
    createdAt: now,
    updatedAt: now,
  };
  return record;
}
var TrialService = class {
  /** The user's current subscription record (any status), or null. */
  static getCurrentSubscription(userId) {
    return SubscriptionRepository.getCurrent(userId);
  }
  /** The user's current subscription in API shape (any status), or null. */
  static async getCurrentSubscriptionDto(userId) {
    const subscription = await SubscriptionRepository.getCurrent(userId);
    return subscription ? toSubscriptionDto(subscription) : null;
  }
  /** Whether the user has ever consumed their one free trial. */
  static async hasUsedTrial(userId) {
    const flag = await SubscriptionRepository.getTrialFlag(userId);
    return Boolean(flag?.hasUsedTrial);
  }
  /**
   * Creates a 5-day free trial subscription for a user and allocates initial trial credits.
   * Enforces a single free trial per user via the permanent trial flag.
   */
  static async createFreeTrial(userId) {
    const current = await SubscriptionRepository.getCurrent(userId);
    if (current && ENTITLED_STATUSES.includes(current.status)) {
      throw new AppError(
        'User is not eligible for a free trial or already has an active subscription',
        409,
        'TRIAL_ALREADY_EXISTS',
      );
    }
    const plan = await PlanService.getFreeTrialPlan();
    if (!plan) {
      throw new AppError('Failed to initialize default free-trial plan', 500, 'INTERNAL_SERVER_ERROR');
    }
    const now = Date.now();
    const claimed = await SubscriptionRepository.claimTrialFlag(userId, now);
    if (!claimed) {
      throw new AppError(
        'User is not eligible for a free trial or already has an active subscription',
        409,
        'TRIAL_ALREADY_EXISTS',
      );
    }
    try {
      const trialEndDate = now + FIVE_DAYS_MS;
      const subscription = trialSubscriptionRecord(userId, plan, now, trialEndDate, now);
      const allocation = await CreditService.buildAllocationUpdates({
        userId,
        subscriptionId: subscription.subscriptionId,
        allocatedCredits: subscription.creditsSnapshot,
        periodStart: now,
        periodEnd: trialEndDate,
        description: `Initial ${subscription.planNameSnapshot} credit allocation`,
        type: 'TRIAL_ALLOCATION',
      });
      const updates = { [paths.subscription(userId)]: subscription, ...allocation.updates };
      if (current) {
        updates[paths.subscriptionHistoryEntry(userId, current.subscriptionId)] = current;
      }
      await applyUpdates(updates);
      logger.info(
        `Created 5-day free trial subscription ${subscription.subscriptionId} and allocated ${subscription.creditsSnapshot} credits for user ${userId}`,
      );
      return toSubscriptionDto(subscription);
    } catch (error) {
      await SubscriptionRepository.releaseTrialFlag(userId).catch(() => void 0);
      throw error;
    }
  }
  /**
   * On-demand real-time check that expires the user's subscription when its duration or grace
   * period has ended (see shouldExpire). Returns the expired subscription, or null.
   */
  static async expireTrialIfEnded(userId) {
    const now = Date.now();
    const current = await SubscriptionRepository.getCurrent(userId);
    if (!current || !shouldExpire(current, now)) return null;
    const { changed, subscription } = await SubscriptionRepository.transactCurrent(userId, sub =>
      shouldExpire(sub, now) ? { ...sub, status: 'EXPIRED', endedAt: now, updatedAt: now } : null,
    );
    if (changed && subscription) {
      logger.info(
        `On-demand subscription expiration executed for user ${userId} (Sub: ${subscription.subscriptionId}, Previous Status: ${current.status})`,
      );
      return toSubscriptionDto(subscription);
    }
    return null;
  }
  /** Alias for expireTrialIfEnded for general subscription lifecycle checks. */
  static async expireSubscriptionIfEnded(userId) {
    return this.expireTrialIfEnded(userId);
  }
  /**
   * Auto-heals / restores the free trial subscription and credit allocation if a user is within
   * their 5-day trial window (time is the ultimate source of truth).
   */
  static async healUserTrialSubscriptionIfEligible(userId) {
    const flag = await SubscriptionRepository.getTrialFlag(userId);
    if (!flag?.hasUsedTrial) {
      return null;
    }
    const now = Date.now();
    const trialStartDate = flag.trialUsedAt;
    const trialEndDate = trialStartDate + FIVE_DAYS_MS;
    if (now >= trialEndDate) {
      return null;
    }
    let subscription = await SubscriptionRepository.getCurrent(userId);
    if (subscription && subscription.isTrial) {
      const subStartDate = subscription.trialStartDate ?? trialStartDate;
      const expectedEndDate = subStartDate + FIVE_DAYS_MS;
      const wasCorrupt = !subscription.trialEndDate || subscription.trialEndDate <= subStartDate;
      if (wasCorrupt) {
        const healed = await SubscriptionRepository.transactCurrent(userId, sub => {
          if (!sub.isTrial || (sub.trialEndDate && sub.trialEndDate > subStartDate)) return null;
          const next = { ...sub, trialStartDate: subStartDate, trialEndDate: expectedEndDate };
          if (next.status === 'TRIALING') {
            next.currentPeriodStart = subStartDate;
            next.currentPeriodEnd = expectedEndDate;
          }
          if (now < expectedEndDate) {
            next.status = 'TRIALING';
            delete next.endedAt;
          }
          next.updatedAt = now;
          return next;
        });
        if (healed.changed) {
          logger.warn(
            `Fixed corrupted trial dates for user ${userId} (trialEndDate ${new Date(expectedEndDate).toISOString()})`,
          );
        }
        subscription = healed.subscription ?? subscription;
      }
    } else if (!subscription) {
      const plan = await PlanService.getFreeTrialPlan();
      if (plan) {
        const restored = trialSubscriptionRecord(userId, plan, trialStartDate, trialEndDate, now);
        if (await SubscriptionRepository.createCurrentIfMissing(userId, restored)) {
          logger.info(`Auto-restored missing trial subscription ${restored.subscriptionId} for user ${userId}`);
        }
        subscription = await SubscriptionRepository.getCurrent(userId);
      }
    }
    if (subscription) {
      const balance = await CreditRepository.getBalance(userId);
      if (!balance) {
        await CreditService.initializeCreditsForSubscription({
          userId,
          subscriptionId: subscription.subscriptionId,
          allocatedCredits: subscription.creditsSnapshot,
          periodStart: trialStartDate,
          periodEnd: trialEndDate,
          description: `Auto-restored ${subscription.planNameSnapshot} credit allocation`,
          type: 'TRIAL_ALLOCATION',
        });
      }
    }
    return subscription ? toSubscriptionDto(subscription) : null;
  }
  /**
   * Bulk reconciliation for server startup and the periodic cron worker: expires ended trials,
   * PAST_DUE subscriptions older than 72h and ended cancelled ACTIVE subscriptions.
   * Each user is expired in its own transaction, so a concurrent renewal can't be overwritten.
   */
  static async reconcileExpiredTrials() {
    const now = Date.now();
    const counts = { TRIALING: 0, PAST_DUE: 0, ACTIVE: 0 };
    for (const status of ['TRIALING', 'PAST_DUE', 'ACTIVE']) {
      const candidates = (await SubscriptionRepository.listByStatus(status)).filter(sub => shouldExpire(sub, now));
      for (const candidate of candidates) {
        const { changed } = await SubscriptionRepository.transactCurrent(candidate.uid, sub =>
          shouldExpire(sub, now) ? { ...sub, status: 'EXPIRED', endedAt: now, updatedAt: now } : null,
        );
        if (changed) counts[status]++;
      }
    }
    const totalModified = counts.TRIALING + counts.PAST_DUE + counts.ACTIVE;
    if (totalModified > 0) {
      logger.info(
        `Reconciled ${totalModified} expired subscription(s) (Trials: ${counts.TRIALING}, PastDue: ${counts.PAST_DUE}, Cancelled: ${counts.ACTIVE})`,
      );
    }
    return totalModified;
  }
  /**
   * Helper to calculate remaining trial duration.
   */
  static calculateTrialRemaining(trialEndDate) {
    const now = Date.now();
    const end = toMs(trialEndDate) ?? 0;
    const diff = end - now;
    if (diff <= 0) {
      return { isExpired: true, remainingMs: 0, remainingHours: 0, remainingDays: 0 };
    }
    return {
      isExpired: false,
      remainingMs: diff,
      remainingHours: Math.ceil(diff / (1e3 * 60 * 60)),
      remainingDays: Number((diff / (1e3 * 60 * 60 * 24)).toFixed(1)),
    };
  }
};

// src/services/auth.service.ts
function toApiUser(record) {
  const googleLinked = (record.providerData ?? []).some(p => p.providerId === 'google.com');
  return {
    _id: record.uid,
    uid: record.uid,
    name: record.displayName || record.email?.split('@')[0] || 'User',
    email: record.email || '',
    role: record.customClaims?.role === 'admin' ? 'admin' : 'user',
    status: record.disabled ? 'suspended' : 'active',
    googleLinked,
    picture: record.photoURL,
    createdAt: record.metadata?.creationTime || /* @__PURE__ */ new Date().toISOString(),
  };
}
async function writeUserProfile(uid, data) {
  if (!isRtdbAvailable()) return;
  try {
    await UserProfileService.writeProfile(uid, data);
  } catch (e) {
    logger.warn(`[AuthService] Failed to write user profile to RTDB for ${uid}: ${e.message}`);
  }
}
async function provisionFreeTrial(uid) {
  if (!isRtdbAvailable()) return void 0;
  try {
    return await TrialService.createFreeTrial(uid);
  } catch (e) {
    logger.warn(`[AuthService] Failed to create free trial for new user ${uid}: ${e.message}`);
    return void 0;
  }
}
var AuthService = class {
  /**
   * Registers a new user with email + password using Firebase Auth.
   * Also creates the free trial subscription (RTDB, Phase 5) and writes
   * the initial user profile to RTDB.
   */
  static async registerUser(input) {
    const auth = getAdminAuthLazy();
    if (!auth) {
      throw new AppError('Authentication service unavailable', 503, 'SERVICE_UNAVAILABLE');
    }
    const normalizedEmail = input.email.trim().toLowerCase();
    const displayName = input.name.trim();
    let userRecord;
    try {
      userRecord = await auth.createUser({
        email: normalizedEmail,
        password: input.password,
        displayName,
        emailVerified: false,
      });
    } catch (err) {
      const code = err?.code || '';
      if (code === 'auth/email-already-exists') {
        throw new AppError('Email address is already registered', 409, 'EMAIL_EXISTS');
      }
      if (code === 'auth/invalid-email') {
        throw new AppError('Invalid email address', 400, 'INVALID_EMAIL');
      }
      if (code === 'auth/weak-password') {
        throw new AppError('Password is too weak (minimum 6 characters)', 400, 'WEAK_PASSWORD');
      }
      logger.error(`[AuthService.register] Firebase error: ${err.message}`);
      throw new AppError('Registration failed. Please try again.', 500, 'REGISTRATION_FAILED');
    }
    const now = Date.now();
    await writeUserProfile(userRecord.uid, {
      name: displayName,
      email: normalizedEmail,
      createdAt: now,
    });
    const subscription = await provisionFreeTrial(userRecord.uid);
    const customToken = await auth.createCustomToken(userRecord.uid, { role: 'user' }).catch(() => '');
    const user = toApiUser(userRecord);
    logger.info(`[AuthService] Registered new user ${userRecord.uid} (${normalizedEmail})`);
    return {
      user,
      // During transition: return custom token as `token`.
      // Phase 11 moves token issuance to the Firebase client SDK in the extension.
      token: customToken,
      refreshToken: '',
      subscription,
    };
  }
  /**
   * Email/password login via Firebase Auth REST API.
   *
   * Firebase Admin SDK does not expose a "verify email+password" method.
   * The standard pattern is:
   *   1. Extension uses Firebase client SDK signInWithEmailAndPassword()
   *   2. Extension sends the resulting ID token to the backend.
   *
   * This endpoint is preserved for API shape compatibility during the transition.
   * It uses the Firebase Auth REST API (identity toolkit) to verify credentials
   * and get an ID token without requiring the client SDK.
   */
  static async loginUser(input) {
    const auth = getAdminAuthLazy();
    if (!auth) {
      throw new AppError('Authentication service unavailable', 503, 'SERVICE_UNAVAILABLE');
    }
    const apiKey = process.env.FIREBASE_WEB_API_KEY || '';
    if (!apiKey) {
      throw new AppError(
        'Firebase Web API Key not configured for server-side login. Please use client-side Firebase Auth in the extension.',
        501,
        'NOT_IMPLEMENTED',
      );
    }
    const normalizedEmail = input.email.trim().toLowerCase();
    const resp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: normalizedEmail,
        password: input.password,
        returnSecureToken: true,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      const code = data?.error?.message || '';
      if (
        code.includes('INVALID_PASSWORD') ||
        code.includes('EMAIL_NOT_FOUND') ||
        code.includes('INVALID_LOGIN_CREDENTIALS')
      ) {
        throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
      }
      if (code.includes('USER_DISABLED')) {
        throw new AppError('Your account has been suspended', 401, 'ACCOUNT_SUSPENDED');
      }
      throw new AppError('Login failed. Please try again.', 401, 'LOGIN_FAILED');
    }
    const idToken = data.idToken;
    const refreshToken = data.refreshToken || '';
    const userRecord = await auth.getUser(data.localId).catch(() => null);
    if (!userRecord) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }
    logger.info(`[AuthService] Login: ${userRecord.uid} (${normalizedEmail})`);
    return {
      user: toApiUser(userRecord),
      token: idToken,
      refreshToken,
    };
  }
  /**
   * Google Sign-In via Firebase Auth.
   *
   * The extension passes the Google ID token (obtained via chrome.identity)
   * to the backend.  We verify it with Firebase Admin and upsert the user.
   */
  static async loginWithGoogle(input) {
    const auth = getAdminAuthLazy();
    if (!auth) {
      throw new AppError('Authentication service unavailable', 503, 'SERVICE_UNAVAILABLE');
    }
    if (!input?.idToken) {
      throw new AppError('Google ID token is required', 400, 'GOOGLE_TOKEN_REQUIRED');
    }
    let decodedToken;
    try {
      decodedToken = await auth.verifyIdToken(input.idToken);
    } catch {
      throw new AppError('Invalid or expired Google token', 401, 'INVALID_GOOGLE_TOKEN');
    }
    if (!decodedToken.uid) {
      throw new AppError('Invalid Google token payload', 401, 'INVALID_GOOGLE_TOKEN');
    }
    let userRecord;
    try {
      userRecord = await auth.getUser(decodedToken.uid);
    } catch (err) {
      if (err?.code === 'auth/user-not-found') {
        throw new AppError('Google user not found in Firebase Auth', 404, 'USER_NOT_FOUND');
      }
      throw err;
    }
    let subscription = void 0;
    if (isRtdbAvailable()) {
      const created = await UserProfileService.ensureProfile(userRecord.uid, {
        name: userRecord.displayName || userRecord.email?.split('@')[0] || 'User',
        email: userRecord.email || '',
        createdAt: Date.now(),
      }).catch(e => {
        logger.warn(`[AuthService] Failed to write user profile to RTDB for ${userRecord.uid}: ${e.message}`);
        return false;
      });
      if (created) {
        subscription = await provisionFreeTrial(userRecord.uid);
      } else {
        const current = await TrialService.getCurrentSubscriptionDto(userRecord.uid).catch(() => null);
        if (current && ['TRIALING', 'ACTIVE'].includes(current.status)) subscription = current;
      }
    }
    const customToken = await auth.createCustomToken(userRecord.uid, { role: 'user' }).catch(() => '');
    logger.info(`[AuthService] Google login: ${userRecord.uid} (${userRecord.email})`);
    return {
      user: toApiUser(userRecord),
      token: customToken,
      refreshToken: input.idToken,
      // echo the Google ID token as refreshToken shim
      subscription,
    };
  }
  /**
   * Token refresh: exchanges a Firebase refresh token (from the extension's own sign-in or from the
   * JobForm Automator website session) for a new Firebase ID token through Firebase's Secure Token
   * API — the same exchange the JobForm Automator extension performs. The extension normally does
   * this itself with the public Web API key; this endpoint is its fallback.
   *
   * An invalid, expired or revoked refresh token, or a disabled account, is a 401 so the client
   * signs out instead of keeping a dead session.
   */
  static async refreshTokens(rawRefreshToken) {
    const apiKey = process.env.FIREBASE_WEB_API_KEY || '';
    if (!apiKey) {
      throw new AppError('Firebase Web API Key not configured for server-side token refresh.', 501, 'NOT_IMPLEMENTED');
    }
    let resp;
    try {
      resp = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rawRefreshToken }).toString(),
        signal: AbortSignal.timeout(1e4),
      });
    } catch (err) {
      logger.error(`[AuthService.refresh] Secure Token API unreachable: ${err?.message}`);
      throw new AppError('Token refresh is temporarily unavailable', 503, 'SERVICE_UNAVAILABLE');
    }
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 400) {
      throw new AppError('Session expired. Please sign in again.', 401, 'INVALID_REFRESH_TOKEN');
    }
    if (!resp.ok || !data.id_token || !data.user_id) {
      logger.error(
        `[AuthService.refresh] Secure Token API responded ${resp.status}: ${data?.error?.message || 'no id_token'}`,
      );
      throw new AppError('Token refresh is temporarily unavailable', 503, 'SERVICE_UNAVAILABLE');
    }
    return {
      token: data.id_token,
      refreshToken: data.refresh_token || rawRefreshToken,
      userId: data.user_id,
    };
  }
  /**
   * Logout — revokes all Firebase refresh tokens for the user.
   * Called when the extension sends the stored refreshToken on logout.
   */
  static async revokeRefreshToken(rawRefreshToken) {
    if (rawRefreshToken) {
      logger.info('[AuthService] Logout called \u2014 client should call Firebase signOut()');
    }
  }
  /** Fetches a Firebase user record by UID. */
  static async getUserById(uid) {
    const auth = getAdminAuthLazy();
    if (!auth) return null;
    try {
      const record = await auth.getUser(uid);
      return toApiUser(record);
    } catch {
      return null;
    }
  }
};

// src/controllers/auth.controller.ts
var AuthController = class {
  static async register(req, res, next) {
    try {
      const result = await AuthService.registerUser(req.body);
      sendSuccess(
        res,
        {
          token: result.token,
          refreshToken: result.refreshToken,
          user: result.user,
          subscription: result.subscription,
        },
        'User registered successfully',
        201,
      );
    } catch (error) {
      next(error);
    }
  }
  static async login(req, res, next) {
    try {
      const result = await AuthService.loginUser(req.body);
      sendSuccess(
        res,
        {
          token: result.token,
          refreshToken: result.refreshToken,
          user: result.user,
        },
        'Login successful',
      );
    } catch (error) {
      next(error);
    }
  }
  static async refresh(req, res, next) {
    try {
      const { refreshToken } = req.body;
      const result = await AuthService.refreshTokens(refreshToken);
      sendSuccess(res, result, 'Token refreshed successfully');
    } catch (error) {
      next(error);
    }
  }
  /**
   * GET /auth/me
   * Returns the current authenticated user profile.
   * req.user is populated by the Firebase authenticate middleware.
   */
  static async getMe(req, res, next) {
    try {
      const uid = req.user?.uid;
      if (!uid) {
        sendSuccess(res, { user: null }, 'No authenticated user');
        return;
      }
      let profileData = {};
      if (isRtdbAvailable()) {
        profileData = (await UserProfileService.getProfile(uid).catch(() => null)) ?? {};
      }
      const firebaseUser = req.user;
      const user = {
        _id: firebaseUser.uid,
        uid: firebaseUser.uid,
        name: profileData.name || firebaseUser.name || firebaseUser.email?.split('@')[0] || 'User',
        email: firebaseUser.email || profileData.email || '',
        role: firebaseUser.role,
        status: profileData.status || 'active',
        emailVerified: firebaseUser.emailVerified,
        picture: profileData.picture,
        googleLinked: (firebaseUser._firebaseToken?.firebase?.identities?.['google.com']?.length ?? 0) > 0,
        createdAt: profileData.createdAt || null,
      };
      sendSuccess(res, { user }, 'User profile retrieved');
    } catch (error) {
      next(error);
    }
  }
  static async logout(req, res, next) {
    try {
      const { refreshToken } = req.body || {};
      const uid = req.user?.uid;
      if (uid && adminAuth) {
        await adminAuth.revokeRefreshTokens(uid).catch(() => {});
      } else if (refreshToken) {
        await AuthService.revokeRefreshToken(refreshToken);
      }
      sendSuccess(res, null, 'Successfully logged out');
    } catch (error) {
      next(error);
    }
  }
  static async google(req, res, next) {
    try {
      const result = await AuthService.loginWithGoogle(req.body);
      sendSuccess(
        res,
        {
          token: result.token,
          refreshToken: result.refreshToken,
          user: result.user,
          subscription: result.subscription,
        },
        'Google authentication successful',
      );
    } catch (error) {
      next(error);
    }
  }
};

// src/middleware/validate.middleware.ts
function validate(schema) {
  return async (req, res, next) => {
    try {
      const parsed = await schema.parseAsync(req.body);
      req.body = parsed;
      next();
    } catch (error) {
      if (error.name === 'ZodError') {
        const issues = error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        sendError(res, 'Validation error', 400, 'VALIDATION_ERROR', issues);
        return;
      }
      next(error);
    }
  };
}

// src/middleware/auth.middleware.ts
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      sendError(res, 'Authorization header missing or malformed', 401, 'UNAUTHORIZED');
      return;
    }
    const token = authHeader.split(' ')[1];
    if (!token) {
      sendError(res, 'Authentication token missing', 401, 'UNAUTHORIZED');
      return;
    }
    const auth = getAdminAuthLazy();
    if (!auth) {
      sendError(res, 'Authentication service temporarily unavailable', 503, 'SERVICE_UNAVAILABLE');
      return;
    }
    let decoded;
    try {
      decoded = await auth.verifyIdToken(token);
    } catch (err) {
      const code = err?.code || 'UNKNOWN_CODE';
      const message = err?.message || 'No message';
      logger.warn(`[AuthMiddleware] ID token verification failed: ${code} - ${message}`);
      if (code.includes('expired')) {
        sendError(res, 'Authentication token has expired', 401, 'TOKEN_EXPIRED');
        return;
      }
      sendError(res, 'Invalid authentication token', 401, 'INVALID_TOKEN');
      return;
    }
    if (!decoded.uid) {
      sendError(res, 'Invalid token payload claims', 401, 'INVALID_TOKEN');
      return;
    }
    req.user = {
      uid: decoded.uid,
      _id: decoded.uid,
      email: decoded.email,
      name: decoded.name,
      role: decoded.role === 'admin' ? 'admin' : 'user',
      emailVerified: decoded.email_verified ?? false,
      _firebaseToken: decoded,
    };
    next();
  } catch (error) {
    next(error);
  }
}

// src/schemas/auth.schema.ts
import { z as z3 } from 'zod';
var registerSchema = z3
  .object({
    name: z3
      .string({ required_error: 'Name is required' })
      .trim()
      .min(2, 'Name must be at least 2 characters long')
      .max(50, 'Name cannot exceed 50 characters'),
    email: z3
      .string({ required_error: 'Email is required' })
      .trim()
      .email('Invalid email address format')
      .toLowerCase(),
    password: z3
      .string({ required_error: 'Password is required' })
      .min(8, 'Password must be at least 8 characters long')
      .max(72, 'Password cannot exceed 72 characters')
      .refine(val => Buffer.byteLength(val, 'utf8') <= 72, 'Password exceeds maximum allowed size of 72 bytes'),
  })
  .strict();
var loginSchema = z3
  .object({
    email: z3
      .string({ required_error: 'Email is required' })
      .trim()
      .email('Invalid email address format')
      .toLowerCase(),
    password: z3.string({ required_error: 'Password is required' }).min(1, 'Password is required'),
  })
  .strict();
var refreshTokenSchema = z3
  .object({
    refreshToken: z3.string({ required_error: 'Refresh token is required' }).min(1, 'Refresh token is required'),
  })
  .strict();
var logoutSchema = z3
  .object({
    refreshToken: z3.string().optional(),
  })
  .strict();
var googleAuthSchema = z3
  .object({
    idToken: z3.string({ required_error: 'ID token is required' }).min(1, 'ID token is required'),
    nonce: z3.string({ required_error: 'Nonce is required' }).min(1, 'Nonce is required'),
  })
  .strict();

// src/middleware/rateLimiter.ts
import rateLimit from 'express-rate-limit';
var isTest = () => env.NODE_ENV === 'test';
var baseRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  // 15 minutes
  max: 600,
  // Limit each IP to 600 general requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => {
    if (isTest()) return true;
    const path = req.path || '';
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
    timestamp: /* @__PURE__ */ new Date().toISOString(),
  },
});
var readApiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  // 15 minutes
  max: 1e3,
  // Limit each IP to 1000 lightweight read requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTest,
  message: {
    success: false,
    message: 'Too many read requests from this IP, please try again later.',
    error: {
      code: 'TOO_MANY_REQUESTS',
    },
    timestamp: /* @__PURE__ */ new Date().toISOString(),
  },
});
var authLoginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  // 15 minutes
  max: 10,
  // Limit each IP to 10 login attempts per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTest,
  message: {
    success: false,
    message: 'Too many failed login attempts from this IP. Please try again after 15 minutes.',
    error: {
      code: 'TOO_MANY_LOGIN_ATTEMPTS',
    },
    timestamp: /* @__PURE__ */ new Date().toISOString(),
  },
});
var authRegisterRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1e3,
  // 1 hour
  max: 10,
  // Limit each IP to 10 registration attempts per hour
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTest,
  message: {
    success: false,
    message: 'Too many account registrations from this IP. Please try again later.',
    error: {
      code: 'TOO_MANY_REGISTRATIONS',
    },
    timestamp: /* @__PURE__ */ new Date().toISOString(),
  },
});
var getLlmRateLimiterKey = req => req.user?.uid || req.user?._id || req.ip || 'anonymous';
var llmRateLimiter = rateLimit({
  windowMs: 60 * 1e3,
  // 1 minute
  max: env.LLM_RATE_PER_USER_RPM,
  // Configurable per-user RPM (default: 60)
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTest,
  keyGenerator: getLlmRateLimiterKey,
  handler: (req, res, _next, options) => {
    const retryAfter = Math.ceil(options.windowMs / 1e3);
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
      timestamp: /* @__PURE__ */ new Date().toISOString(),
    });
  },
});
var globalLlmRateLimiter = rateLimit({
  windowMs: 60 * 1e3,
  // 1 minute
  max: env.LLM_RATE_GLOBAL_RPM,
  // Configurable global gateway RPM (default: 600)
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTest,
  keyGenerator: () => 'global_llm_gateway',
  handler: (req, res, _next, options) => {
    const retryAfter = Math.ceil(options.windowMs / 1e3);
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
      timestamp: /* @__PURE__ */ new Date().toISOString(),
    });
  },
});
var refundRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  // 15 minutes
  max: 30,
  // Limit each IP to 30 refund requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTest,
  message: {
    success: false,
    message: 'Too many refund requests from this IP, please try again later.',
    error: {
      code: 'TOO_MANY_REQUESTS',
    },
    timestamp: /* @__PURE__ */ new Date().toISOString(),
  },
});

// src/routes/auth.routes.ts
var authRouter = Router2();
authRouter.post('/register', authRegisterRateLimiter, validate(registerSchema), AuthController.register);
authRouter.post('/login', authLoginRateLimiter, validate(loginSchema), AuthController.login);
authRouter.post('/google', authLoginRateLimiter, validate(googleAuthSchema), AuthController.google);
authRouter.post('/refresh', authLoginRateLimiter, validate(refreshTokenSchema), AuthController.refresh);
authRouter.get('/me', authenticate, AuthController.getMe);
authRouter.post('/logout', validate(logoutSchema), AuthController.logout);

// src/routes/subscription.routes.ts
import { Router as Router3 } from 'express';

// src/services/jobformPremium.service.ts
function parsePaymentDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.includes(' ') ? value.replace(' ', 'T') + 'Z' : value;
  const date = new Date(normalized);
  return isNaN(date.getTime()) ? null : date;
}
function getSubscriptionTier(payment, now = /* @__PURE__ */ new Date()) {
  if (!payment || typeof payment !== 'object') return 'Free';
  const isPaid = payment.Status === 'Premium' || payment.SubscriptionType === 'Premium';
  if (!isPaid) return 'Free';
  if (payment.End_Date) {
    const endDate = parsePaymentDate(payment.End_Date);
    if (endDate && endDate <= now) return 'Free';
  }
  return payment.SubscriptionType === 'Diamond' ? 'Diamond' : 'Premium';
}
function toJobformPremiumStatus(payment, now = /* @__PURE__ */ new Date()) {
  const record = payment && typeof payment === 'object' ? payment : null;
  const tier = getSubscriptionTier(record, now);
  const isPaidRecord = Boolean(record && (record.Status === 'Premium' || record.SubscriptionType === 'Premium'));
  const end = parsePaymentDate(record?.End_Date);
  const start = parsePaymentDate(record?.Start_Date);
  return {
    source: 'jobform-automator',
    tier,
    isPremium: tier !== 'Free',
    subscriptionType: typeof record?.SubscriptionType === 'string' ? record.SubscriptionType : null,
    startDate: start ? start.toISOString() : null,
    endDate: end ? end.toISOString() : null,
    expired: isPaidRecord && tier === 'Free',
    checkedAt: now.toISOString(),
  };
}
var JobformPremiumService = class {
  /** Reads user/{uid}/Payment (read-only) and applies JobForm Automator's premium rule. */
  static async getStatus(uid) {
    assertSafeUid(uid);
    const snapshot = await getRtdb().ref(`user/${uid}/Payment`).get();
    return toJobformPremiumStatus(snapshot.exists() ? snapshot.val() : null);
  }
};

// src/controllers/subscription.controller.ts
async function readJobformPremium(userId) {
  try {
    return await JobformPremiumService.getStatus(userId);
  } catch (error) {
    logger.warn(`[Subscription] Could not read JobForm Automator premium status for ${userId}: ${error?.message}`);
    return null;
  }
}
var SubscriptionController = class {
  /**
   * GET /api/v1/subscription/me
   * Returns authenticated user's current subscription details & trial status.
   * Public to authenticated users even if trial is expired!
   */
  static async getMySubscription(req, res, next) {
    try {
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }
      await TrialService.expireSubscriptionIfEnded(userId);
      await TrialService.healUserTrialSubscriptionIfEligible(userId);
      const hasUsedTrial = await TrialService.hasUsedTrial(userId);
      let subscription = await TrialService.getCurrentSubscriptionDto(userId);
      if (!subscription && !hasUsedTrial) {
        try {
          subscription = await TrialService.createFreeTrial(userId);
        } catch {
          subscription = await TrialService.getCurrentSubscriptionDto(userId);
        }
      }
      const premium = await readJobformPremium(userId);
      if (!subscription) {
        res.status(200).json({
          success: true,
          data: {
            subscription: null,
            status: hasUsedTrial ? 'EXPIRED' : 'NONE',
            hasActiveEntitlement: false,
            trialInfo: null,
            message: hasUsedTrial
              ? 'Your free trial has already been used. Please subscribe to a paid plan to continue.'
              : void 0,
            premium,
          },
        });
        return;
      }
      const hasActiveEntitlement = ['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(subscription.status);
      let trialInfo = null;
      if (subscription.isTrial && subscription.trialEndDate) {
        trialInfo = TrialService.calculateTrialRemaining(subscription.trialEndDate);
      }
      res.status(200).json({
        success: true,
        data: {
          subscription,
          status: subscription.status,
          hasActiveEntitlement,
          trialInfo,
          premium,
        },
      });
    } catch (error) {
      next(error);
    }
  }
  /**
   * GET /api/v1/subscription/plans
   * Public endpoint to list all available active plans.
   */
  static async getPlans(_req, res, next) {
    try {
      const plans = await PlanService.getActivePlans();
      res.status(200).json({
        success: true,
        data: { plans },
      });
    } catch (error) {
      next(error);
    }
  }
  /**
   * POST /api/v1/subscription/trial/activate
   * Manually activates/provisions 5-day free trial for users who registered without a trial.
   */
  static async activateFreeTrial(req, res, next) {
    try {
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }
      const subscription = await TrialService.createFreeTrial(userId);
      const trialInfo = TrialService.calculateTrialRemaining(subscription.trialEndDate);
      res.status(200).json({
        success: true,
        message: 'Free trial activated successfully',
        data: {
          subscription,
          status: subscription.status,
          hasActiveEntitlement: true,
          trialInfo,
        },
      });
    } catch (error) {
      next(error);
    }
  }
};

// src/services/razorpay.service.ts
import crypto2 from 'crypto';
var RazorpayService = class {
  /**
   * Verifies the HMAC SHA256 signature returned by Razorpay checkout on frontend/extension.
   * Signature string format: razorpay_payment_id + '|' + razorpay_subscription_id
   */
  static verifyCheckoutSignature(paymentId, subscriptionId, signature) {
    if (!paymentId || !subscriptionId || !signature) {
      return false;
    }
    try {
      const body = `${paymentId}|${subscriptionId}`;
      const expectedSignature = crypto2.createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(body).digest('hex');
      const expectedBuf = Buffer.from(expectedSignature, 'utf8');
      const receivedBuf = Buffer.from(signature, 'utf8');
      if (expectedBuf.length !== receivedBuf.length) {
        return false;
      }
      return crypto2.timingSafeEqual(expectedBuf, receivedBuf);
    } catch (error) {
      logger.error(`Error verifying checkout signature: ${error.message}`);
      return false;
    }
  }
  /**
   * Verifies the HMAC SHA256 signature on incoming Razorpay server-to-server webhook requests.
   * Computed over the EXACT raw HTTP request body Buffer.
   */
  static verifyWebhookSignature(rawBody, signatureHeader) {
    if (!rawBody || !signatureHeader) {
      return false;
    }
    try {
      const expectedSignature = crypto2.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
      const expectedBuf = Buffer.from(expectedSignature, 'utf8');
      const receivedBuf = Buffer.from(signatureHeader, 'utf8');
      if (expectedBuf.length !== receivedBuf.length) {
        return false;
      }
      return crypto2.timingSafeEqual(expectedBuf, receivedBuf);
    } catch (error) {
      logger.error(`Error verifying webhook signature: ${error.message}`);
      return false;
    }
  }
  /**
   * Creates a Razorpay Subscription session.
   * Calls real Razorpay API when valid keys are configured, or falls back to mock session for test runner.
   */
  static async createRazorpaySubscription(params) {
    const isMockKey =
      !env.RAZORPAY_KEY_ID ||
      !env.RAZORPAY_KEY_SECRET ||
      env.RAZORPAY_KEY_ID.includes('placeholder') ||
      env.RAZORPAY_KEY_ID.includes('mock') ||
      env.RAZORPAY_KEY_ID.includes('test_key_id') ||
      params.planId.startsWith('plan_rzp_mock_');
    if (isMockKey || env.NODE_ENV === 'test') {
      const randomHash = crypto2.randomBytes(8).toString('hex');
      const mockSubscriptionId = `sub_rzp_${randomHash}`;
      logger.info(`[Mock Mode] Created Razorpay Subscription session ${mockSubscriptionId} for plan ${params.planId}`);
      return {
        id: mockSubscriptionId,
        entity: 'subscription',
        plan_id: params.planId,
        status: 'created',
        notes: params.notes || {},
      };
    }
    try {
      const authHeader = `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;
      const payload = {
        plan_id: params.planId,
        total_count: params.totalCount || 12,
        quantity: 1,
        customer_notify: params.customerNotify !== void 0 ? params.customerNotify : 0,
        notes: params.notes || {},
      };
      if (params.notifyInfo && (params.notifyInfo.email || params.notifyInfo.phone)) {
        payload.notify_info = params.notifyInfo;
      }
      logger.info(
        `[Real Razorpay API Request Payload] ${JSON.stringify({ ...payload, keyId: `${env.RAZORPAY_KEY_ID.slice(0, 8)}...` })}`,
      );
      const response = await fetch('https://api.razorpay.com/v1/subscriptions', {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        const errorMsg = data?.error?.description || `Razorpay API returned HTTP ${response.status}`;
        logger.error(`Razorpay API subscription creation failed: ${errorMsg}`);
        if (env.NODE_ENV !== 'production') {
          const randomHash = crypto2.randomBytes(8).toString('hex');
          const mockSubscriptionId = `sub_rzp_${randomHash}`;
          logger.warn(
            `Fallback to mock subscription session ${mockSubscriptionId} due to Razorpay API error: ${errorMsg}. Create plan '${params.planId}' on Razorpay Dashboard to use real subscription links.`,
          );
          return {
            id: mockSubscriptionId,
            entity: 'subscription',
            plan_id: params.planId,
            status: 'created',
            notes: params.notes || {},
          };
        }
        throw new Error(errorMsg);
      }
      logger.info(
        `[Real Razorpay API] Created subscription ${data.id} (URL: ${data.short_url}) for plan ${params.planId}`,
      );
      return {
        id: data.id,
        entity: data.entity || 'subscription',
        plan_id: data.plan_id || params.planId,
        status: data.status || 'created',
        short_url: data.short_url,
        charge_at: data.charge_at,
        notes: data.notes || params.notes || {},
      };
    } catch (error) {
      logger.error(`Error invoking Razorpay API: ${error.message}`);
      if (env.NODE_ENV !== 'production') {
        const randomHash = crypto2.randomBytes(8).toString('hex');
        const mockSubscriptionId = `sub_rzp_${randomHash}`;
        logger.warn(`Fallback to mock subscription session ${mockSubscriptionId}`);
        return {
          id: mockSubscriptionId,
          entity: 'subscription',
          plan_id: params.planId,
          status: 'created',
          notes: params.notes || {},
        };
      }
      throw error;
    }
  }
  /**
   * Cancels a Razorpay subscription (e.g. the previous plan after an upgrade, so the user is not
   * billed for both). `atCycleEnd` keeps it running until the current billing cycle ends.
   * Mock subscriptions (tests, unconfigured keys) are cancelled locally only.
   */
  static async cancelRazorpaySubscription(subscriptionId, atCycleEnd = false) {
    const isMock =
      env.NODE_ENV === 'test' ||
      !env.RAZORPAY_KEY_ID ||
      !env.RAZORPAY_KEY_SECRET ||
      env.RAZORPAY_KEY_ID.includes('placeholder') ||
      env.RAZORPAY_KEY_ID.includes('mock') ||
      env.RAZORPAY_KEY_ID.includes('test_key_id') ||
      subscriptionId.startsWith('sub_rzp_');
    if (isMock) {
      logger.info(`[Mock Mode] Cancelled Razorpay Subscription ${subscriptionId}`);
      return;
    }
    const authHeader = `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;
    const response = await fetch(
      `https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
      {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancel_at_cycle_end: atCycleEnd ? 1 : 0 }),
      },
    );
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data?.error?.description || `Razorpay cancel returned HTTP ${response.status}`);
    }
    logger.info(`[Real Razorpay API] Cancelled subscription ${subscriptionId} (atCycleEnd=${atCycleEnd})`);
  }
};

// src/services/applicationQuota.service.ts
import { randomUUID } from 'crypto';
var FREE_DAILY_APPLICATION_LIMIT = 10;
var JOBFORM_PREMIUM_DAILY_APPLICATION_LIMIT = 300;
var PAID_PLAN_DAILY_APPLICATION_LIMITS = {
  starter: 50,
  pro: 100,
  power: 500,
};
var UNKNOWN_PAID_PLAN_DAILY_LIMIT = 50;
var RESERVATION_TTL_MS = 20 * 60 * 1e3;
var utcDay = now => new Date(now).toISOString().slice(0, 10);
function nextUtcMidnight(now) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}
function normalize(stored, now) {
  const today = utcDay(now);
  if (!stored || stored.day !== today) return { day: today, applied: 0, committed: {}, reservations: {} };
  const reservations = {};
  for (const [key, expiresAt] of Object.entries(stored.reservations ?? {})) {
    if (typeof expiresAt === 'number' && expiresAt > now) reservations[key] = expiresAt;
  }
  return {
    day: today,
    applied: Math.max(0, Number(stored.applied) || 0),
    committed: { ...(stored.committed ?? {}) },
    reservations,
  };
}
function toStored(state) {
  const stored = { day: state.day, applied: state.applied };
  if (Object.keys(state.committed).length > 0) stored.committed = state.committed;
  if (Object.keys(state.reservations).length > 0) stored.reservations = state.reservations;
  return stored;
}
function toView(state, entitlement, now) {
  const reserved = Object.keys(state.reservations).length;
  const remaining = Math.max(0, entitlement.limit - state.applied - reserved);
  return {
    day: state.day,
    timezone: 'UTC',
    resetsAt: nextUtcMidnight(now),
    applied: state.applied,
    reserved,
    limit: entitlement.limit,
    remaining,
    plan: entitlement.plan,
    isPaid: entitlement.isPaid,
    allowed: remaining > 0,
    appliedToday: state.applied,
    dailyLimit: entitlement.limit,
    tier: entitlement.isPaid ? 'premium' : 'free',
    lastResetDate: state.day,
  };
}
var ApplicationQuotaService = class {
  /** Highest daily limit among the user's verified entitlements. */
  static async resolveEntitlement(uid) {
    const [subscription, jobformPremium] = await Promise.all([
      SubscriptionRepository.getCurrent(uid),
      JobformPremiumService.getStatus(uid),
    ]);
    let entitlement = { limit: FREE_DAILY_APPLICATION_LIMIT, plan: 'free', isPaid: false };
    if (jobformPremium.isPremium) {
      entitlement = {
        limit: JOBFORM_PREMIUM_DAILY_APPLICATION_LIMIT,
        plan: jobformPremium.tier === 'Diamond' ? 'diamond' : 'premium',
        isPaid: true,
      };
    }
    if (subscription?.status === 'ACTIVE') {
      const code = subscription.planCodeSnapshot;
      const planLimit = PAID_PLAN_DAILY_APPLICATION_LIMITS[code] ?? UNKNOWN_PAID_PLAN_DAILY_LIMIT;
      if (planLimit > entitlement.limit) entitlement = { limit: planLimit, plan: code || 'paid', isPaid: true };
    }
    return entitlement;
  }
  static async getStatus(uid, now = Date.now()) {
    const entitlement = await this.resolveEntitlement(uid);
    const stored = (await dbRef(paths.applicationQuota(uid)).get()).val();
    return toView(normalize(stored, now), entitlement, now);
  }
  /** Holds a slot for `jobKey`. A job already counted today is granted without using a slot. */
  static async reserve(uid, jobKey, now = Date.now()) {
    const entitlement = await this.resolveEntitlement(uid);
    const key = hashKey(jobKey);
    let granted = false;
    let alreadyCounted = false;
    const state = await this.transact(uid, now, current => {
      granted = false;
      alreadyCounted = false;
      if (current.committed[key]) {
        granted = true;
        alreadyCounted = true;
        return;
      }
      const held = Object.keys(current.reservations).length;
      if (current.reservations[key] || current.applied + held < entitlement.limit) {
        current.reservations[key] = now + RESERVATION_TTL_MS;
        granted = true;
      }
    });
    return { granted, alreadyCounted, quota: toView(state, entitlement, now) };
  }
  /** Records a successful submission once per job and day, and frees its held slot. */
  static async commit(uid, jobKey, now = Date.now()) {
    const entitlement = await this.resolveEntitlement(uid);
    const key = hashKey(jobKey);
    let counted = false;
    const state = await this.transact(uid, now, current => {
      counted = false;
      delete current.reservations[key];
      if (current.committed[key]) return;
      current.committed[key] = now;
      current.applied += 1;
      counted = true;
    });
    return { counted, quota: toView(state, entitlement, now) };
  }
  /** Frees the slot held for a submission that did not happen. Already-counted jobs are unaffected. */
  static async release(uid, jobKey, now = Date.now()) {
    const entitlement = await this.resolveEntitlement(uid);
    const key = hashKey(jobKey);
    const state = await this.transact(uid, now, current => {
      delete current.reservations[key];
    });
    return toView(state, entitlement, now);
  }
  /** Legacy one-shot check-and-increment (no job key): counts a new application if a slot is free. */
  static async checkAndIncrement(uid, now = Date.now()) {
    const jobKey = `legacy:${randomUUID()}`;
    const reservation = await this.reserve(uid, jobKey, now);
    if (!reservation.granted) return { allowed: false, quota: reservation.quota };
    const { quota } = await this.commit(uid, jobKey, now);
    return { allowed: true, quota };
  }
  static async transact(uid, now, mutate) {
    const result = await dbRef(paths.applicationQuota(uid)).transaction(stored => {
      const state = normalize(stored, now);
      mutate(state);
      return toStored(state);
    });
    return normalize(result.snapshot.val(), now);
  }
};

// src/services/rtdb/mappers.ts
function skillExperienceToList(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([skill, years]) => skill && years !== void 0 && years !== null && !Number.isNaN(Number(years)))
    .map(([skill, years]) => ({ skill, years: Number(years) }));
}
function customAnswersToList(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([question, answer]) => question && answer !== void 0 && answer !== null)
    .map(([question, answer]) => ({ question, answer: String(answer) }));
}

// src/services/profile.service.ts
var SYNC_UPDATE_FIELDS = [
  'fullName',
  'email',
  'phoneNumber',
  'currentTitle',
  'resumeText',
  'backgroundNarrative',
  'skills',
  'yearsOfExperience',
  'education',
  'noticePeriod',
  'workAuthorization',
  'salaryExpectation',
  'currentLocation',
  'preferredLocation',
  'preferredLocations',
  'portfolioUrl',
  'githubUrl',
  'linkedinUrl',
  'goldenAnswers',
  'customAnswers',
  'skillExperience',
];
var CREATE_FIELDS = [
  ...SYNC_UPDATE_FIELDS,
  'resumeFileName',
  'hasWorkExperience',
  'workExperience',
  'college',
  'cgpa',
  'workHistory',
];
var REQUIRED_ON_CREATE = ['fullName', 'email', 'currentTitle', 'resumeText'];
function trimString(value) {
  if (value === null || value === void 0) return '';
  return String(value).trim();
}
function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => item !== null && item !== void 0).map(item => String(item));
}
function objectList(value) {
  if (!Array.isArray(value)) return [];
  return stripUndefined(value.filter(item => item !== null && typeof item === 'object'));
}
function toStoredField(field, value) {
  switch (field) {
    case 'email':
      return ['email', trimString(value).toLowerCase()];
    case 'skills':
    case 'preferredLocations':
      return [field, stringList(value)];
    case 'yearsOfExperience':
      return [field, Math.max(0, Number(value) || 0)];
    case 'hasWorkExperience':
      return [field, Boolean(value)];
    case 'workExperience':
    case 'workHistory':
    case 'goldenAnswers':
      return [field, objectList(value)];
    case 'skillExperience':
      return ['skillExperienceList', skillExperienceToList(value)];
    case 'customAnswers':
      return ['customAnswersList', customAnswersToList(value)];
    default:
      return [field, trimString(value)];
  }
}
function defaultQuota(dailyLimit, today) {
  return { appliedToday: 0, dailyLimit, lastResetDate: today };
}
function newProfileRecord(uid, today, now) {
  return {
    uid,
    fullName: '',
    email: '',
    phoneNumber: '',
    currentTitle: '',
    resumeText: '',
    resumeFileName: '',
    backgroundNarrative: '',
    skills: [],
    yearsOfExperience: 0,
    hasWorkExperience: true,
    workExperience: [],
    education: '',
    college: '',
    cgpa: '',
    workHistory: [],
    noticePeriod: 'Immediate',
    workAuthorization: 'Authorized to work',
    skillExperienceList: [],
    salaryExpectation: '',
    currentLocation: '',
    preferredLocation: '',
    preferredLocations: [],
    portfolioUrl: '',
    githubUrl: '',
    linkedinUrl: '',
    goldenAnswers: [],
    customAnswersList: [],
    tier: 'free',
    dailyQuota: defaultQuota(15, today),
    createdAt: now,
    updatedAt: now,
  };
}
var ProfileService = class {
  static getTodayString() {
    return todayString();
  }
  /**
   * Retrieves user's Career Brain profile by userId.
   */
  static async getProfile(userId) {
    const record = await CareerBrainRepository.get(userId);
    return record ? toCareerBrainDto(record) : null;
  }
  /**
   * Upserts the user's Career Brain profile from extension sync.
   * Tier and daily quota are never taken from the client.
   */
  static async syncProfile(userId, profileData) {
    const data = profileData && typeof profileData === 'object' ? profileData : {};
    const today = this.getTodayString();
    const now = Date.now();
    if (!(await CareerBrainRepository.exists(userId))) {
      const record = newProfileRecord(userId, today, now);
      for (const field of CREATE_FIELDS) {
        if (data[field] === void 0 || data[field] === null) continue;
        const [storedField, storedValue] = toStoredField(field, data[field]);
        record[storedField] = storedValue;
      }
      const missing = REQUIRED_ON_CREATE.filter(field => !record[field]);
      if (missing.length > 0) {
        throw new AppError(`Career Brain validation failed: ${missing.join(', ')} required`, 400, 'VALIDATION_ERROR');
      }
      if (await CareerBrainRepository.createIfMissing(userId, record)) {
        return toCareerBrainDto(record);
      }
    }
    const patch = {};
    for (const field of SYNC_UPDATE_FIELDS) {
      if (data[field] === void 0 || data[field] === null) continue;
      const [storedField, storedValue] = toStoredField(field, data[field]);
      patch[storedField] = storedValue;
    }
    patch.updatedAt = now;
    await CareerBrainRepository.update(userId, patch);
    const updated = await CareerBrainRepository.get(userId);
    if (!updated) {
      throw new AppError('Failed to update Career Brain profile', 500, 'UPDATE_FAILED');
    }
    return toCareerBrainDto(updated);
  }
  /**
   * Upserts the Career Brain profile from parsed resume data (overwrites the resume-derived
   * fields with the newly parsed values, as before).
   */
  static async createOrUpdateFromResume(userId, parsed, rawResumeText, fileName) {
    const today = this.getTodayString();
    const now = Date.now();
    const existing = await CareerBrainRepository.get(userId);
    const cleanSkillExp = {};
    if (parsed.skillExperience) {
      for (const [skill, yrs] of Object.entries(parsed.skillExperience)) {
        if (!skill || yrs === void 0 || isNaN(Number(yrs))) continue;
        cleanSkillExp[skill] = Number(yrs);
      }
    }
    const updatePayload = {
      fullName: parsed.fullName?.trim() || existing?.fullName || 'Candidate',
      email: parsed.email?.trim() || existing?.email || '',
      phoneNumber: parsed.phoneNumber?.trim() || '',
      currentTitle: parsed.currentTitle?.trim() || 'Software Professional',
      resumeText: rawResumeText || parsed.backgroundNarrative || '',
      resumeFileName: fileName,
      backgroundNarrative: parsed.backgroundNarrative || '',
      skills: parsed.skills && parsed.skills.length > 0 ? parsed.skills : Object.keys(cleanSkillExp),
      yearsOfExperience: parsed.yearsOfExperience !== void 0 ? parsed.yearsOfExperience : 0,
      education: parsed.education || '',
      college: parsed.college || '',
      cgpa: parsed.cgpa || '',
      noticePeriod: parsed.noticePeriod || 'Immediate',
      workHistory: parsed.workHistory || [],
      currentLocation: parsed.currentLocation || '',
      preferredLocation: parsed.preferredLocation || '',
      preferredLocations: parsed.preferredLocations || [],
      workAuthorization: parsed.workAuthorization || 'Authorized to work without sponsorship',
      skillExperience: cleanSkillExp,
      salaryExpectation: parsed.salaryExpectation || '',
      goldenAnswers: parsed.goldenAnswers && parsed.goldenAnswers.length > 0 ? parsed.goldenAnswers : [],
      portfolioUrl: parsed.portfolioUrl || '',
      githubUrl: parsed.githubUrl || '',
      linkedinUrl: parsed.linkedinUrl || '',
    };
    const stored = {};
    for (const [field, value] of Object.entries(updatePayload)) {
      const [storedField, storedValue] = toStoredField(field, value);
      stored[storedField] = storedValue;
    }
    if (!existing) {
      const record = { ...newProfileRecord(userId, today, now), ...stored };
      if (await CareerBrainRepository.createIfMissing(userId, record)) {
        return toCareerBrainDto(record);
      }
    }
    await CareerBrainRepository.update(userId, { ...stored, updatedAt: now });
    const updated = await CareerBrainRepository.get(userId);
    if (!updated) {
      throw new AppError('Failed to update Career Brain profile from resume', 500, 'UPDATE_FAILED');
    }
    return toCareerBrainDto(updated);
  }
  /**
   * Daily application limit for the user's verified plan (see ApplicationQuotaService, the single
   * source of truth for the quota).
   */
  static async getDailyLimitForUser(userId) {
    return (await ApplicationQuotaService.resolveEntitlement(userId)).limit;
  }
  /**
   * Upgrades user tier to Premium and sets the plan-based quota (called by payment flows / webhooks).
   * Like the Mongo version, does nothing when the user has no Career Brain profile yet.
   */
  static async upgradeToPremium(userId, targetLimit) {
    const limit = targetLimit || (await this.getDailyLimitForUser(userId));
    if (!(await CareerBrainRepository.exists(userId))) {
      return null;
    }
    await CareerBrainRepository.update(userId, {
      tier: 'premium',
      'dailyQuota/dailyLimit': limit,
      updatedAt: Date.now(),
    });
    return this.getProfile(userId);
  }
};

// src/services/subscriptionLifecycle.service.ts
var WEBHOOK_STUCK_AFTER_MS = 12e4;
var DAY_MS = 24 * 60 * 60 * 1e3;
var CHECKOUT_REUSE_MS = 12 * 60 * 60 * 1e3;
function isEntitled(sub) {
  return Boolean(sub && ENTITLED_STATUSES.includes(sub.status));
}
function withoutField(record, key) {
  const copy = { ...record };
  delete copy[key];
  return copy;
}
async function upgradeToPremiumSafely(userId) {
  try {
    await ProfileService.upgradeToPremium(userId);
  } catch (e) {
    logger.warn(`Failed to upgrade Career Brain tier for user ${userId}: ${e.message}`);
  }
}
var SubscriptionLifecycleService = class {
  /**
   * Creates (or reuses) a Razorpay subscription checkout for a paid plan.
   *
   * The Razorpay subscription is linked to the authenticated user and to the plan being bought
   * before anything is paid, whatever the user's current subscription is (trial, expired trial or
   * another paid plan), so every payment event resolves to this user and this plan. Nothing is
   * granted here: the plan starts only when Razorpay confirms the payment (webhook or the signed
   * checkout callback).
   */
  static async createCheckoutSession(userId, planCode, _idempotencyKey) {
    const plan = await PlanService.getActivePlan(planCode);
    if (!plan) {
      throw new AppError(`Plan with code '${planCode}' not found or inactive`, 404, 'PLAN_NOT_FOUND');
    }
    if (plan.billingInterval === 'none' || plan.code === 'free-trial') {
      throw new AppError('Cannot create a paid checkout session for a free trial plan', 400, 'INVALID_PLAN');
    }
    const razorpayPlanId = plan.razorpayPlanId || `plan_rzp_mock_${plan.code}`;
    const sessionFor = (providerSubscriptionId, shortUrl) => ({
      subscriptionId: providerSubscriptionId,
      razorpayPlanId,
      planCode: plan.code,
      planName: plan.name,
      amount: plan.amount,
      currency: plan.currency,
      keyId: env.RAZORPAY_KEY_ID,
      ...(shortUrl ? { shortUrl } : {}),
    });
    const current = await SubscriptionRepository.getCurrent(userId);
    if (current && current.status === 'ACTIVE' && !current.isTrial && current.planCodeSnapshot === plan.code) {
      throw new AppError(`You are already subscribed to the ${plan.name}`, 409, 'ALREADY_SUBSCRIBED');
    }
    const pending = await SubscriptionRepository.getCheckoutSession(userId, plan.code);
    if (pending && Date.now() - pending.createdAt < CHECKOUT_REUSE_MS) {
      const link = await SubscriptionRepository.getProviderLink(keyForExternalId(pending.providerSubscriptionId));
      if (link && link.uid === userId && (link.status === 'PENDING' || link.status === 'AUTHENTICATED')) {
        return sessionFor(pending.providerSubscriptionId, link.shortUrl);
      }
    }
    const profile = await UserProfileRepository.get(userId);
    const rzpSub = await RazorpayService.createRazorpaySubscription({
      planId: razorpayPlanId,
      totalCount: plan.billingInterval === 'yearly' ? 10 : 12,
      customerNotify: 0,
      notifyInfo: profile?.email ? { email: profile.email } : void 0,
      notes: { userId, planCode: plan.code },
    });
    const now = Date.now();
    const claim = await SubscriptionRepository.claimProviderLink(keyForExternalId(rzpSub.id), {
      uid: userId,
      subscriptionId: '',
      providerSubscriptionId: rzpSub.id,
      linkedAt: now,
      planCode: plan.code,
      status: 'PENDING',
      shortUrl: rzpSub.short_url,
      updatedAt: now,
    });
    if (claim.ownerUid !== userId) {
      throw new AppError(
        'Razorpay subscription ID is already linked to another user account',
        409,
        'SUBSCRIPTION_ALREADY_LINKED',
      );
    }
    await SubscriptionRepository.setCheckoutSession(userId, plan.code, {
      providerSubscriptionId: rzpSub.id,
      createdAt: now,
    });
    return sessionFor(rzpSub.id, rzpSub.short_url);
  }
  /**
   * Verifies the signed Razorpay checkout callback and starts the plan bought in that checkout.
   * The checkout must belong to the caller; a repeated callback is idempotent.
   */
  static async verifyPayment(params) {
    const { userId, paymentId, subscriptionId, signature } = params;
    const isValidSignature = RazorpayService.verifyCheckoutSignature(paymentId, subscriptionId, signature);
    if (!isValidSignature) {
      throw new AppError('Invalid payment verification signature', 401, 'INVALID_SIGNATURE');
    }
    const link = await SubscriptionRepository.getProviderLink(keyForExternalId(subscriptionId));
    if (link && link.uid !== userId) {
      throw new AppError('Razorpay subscription ID belongs to another user account', 403, 'FORBIDDEN');
    }
    const current = await SubscriptionRepository.getCurrent(userId);
    if (
      current &&
      current.status === 'ACTIVE' &&
      !current.isTrial &&
      current.providerSubscriptionId === subscriptionId
    ) {
      return { subscription: toSubscriptionDto(current), hasActiveEntitlement: true, isIdempotentRetry: true };
    }
    if (!link?.planCode) {
      throw new AppError('No checkout found for this payment', 404, 'CHECKOUT_NOT_FOUND');
    }
    const plan = await PlanService.getActivePlan(link.planCode);
    if (!plan) {
      throw new AppError(`Plan '${link.planCode}' not found or inactive`, 404, 'PLAN_NOT_FOUND');
    }
    const activated = await this.startPaidSubscription({
      uid: userId,
      plan,
      providerSubscriptionId: subscriptionId,
      current,
      hasLink: true,
      eventTimestamp: Date.now(),
      paymentId,
    });
    logger.info(`Verified payment ${paymentId} for ${subscriptionId}: ${plan.code} is now ACTIVE for user ${userId}`);
    return { subscription: toSubscriptionDto(activated), hasActiveEntitlement: true, isIdempotentRetry: false };
  }
  /**
   * Makes `plan` the user's active paid subscription after a confirmed payment, replacing the
   * current record (trial, expired, or another plan — kept in subscription history) and allocating
   * the plan's credits, all in one atomic update. A replaced paid plan is cancelled at Razorpay so
   * the user is not billed twice. The record id is derived from the Razorpay subscription, so
   * concurrent events for the same purchase write the same record.
   */
  static async startPaidSubscription(params) {
    const { uid, plan, providerSubscriptionId, current, hasLink, eventTimestamp, paidCount, paymentId } = params;
    const now = Date.now();
    const periodEnd = now + (plan.billingInterval === 'yearly' ? 365 : 30) * DAY_MS;
    const subscriptionId = `sub_rzp_${hashKey(providerSubscriptionId).slice(0, 24)}`;
    const record = stripUndefined({
      subscriptionId,
      uid,
      planId: plan.legacyId || plan.code,
      planCodeSnapshot: plan.code,
      planNameSnapshot: plan.name,
      amountSnapshot: plan.amount,
      currencySnapshot: plan.currency,
      billingIntervalSnapshot: plan.billingInterval,
      creditsSnapshot: plan.creditsPerBillingPeriod,
      rateLimitSnapshot: plan.rateLimitPerMinute,
      provider: 'razorpay',
      providerSubscriptionId,
      status: 'ACTIVE',
      isTrial: false,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      lastEventTimestamp: eventTimestamp,
      providerPaidCount: paidCount,
      lastProviderPaymentId: paymentId,
      createdAt: now,
      updatedAt: now,
    });
    const allocation = await CreditService.buildAllocationUpdates({
      userId: uid,
      subscriptionId,
      allocatedCredits: plan.creditsPerBillingPeriod,
      periodStart: now,
      periodEnd,
      description: `${plan.name} activation (${plan.creditsPerBillingPeriod} credits)`,
      type: 'SUBSCRIPTION_RENEWAL',
    });
    const providerKey = keyForExternalId(providerSubscriptionId);
    const updates = {
      [paths.subscription(uid)]: record,
      ...allocation.updates,
      [paths.checkoutSession(uid, plan.code)]: null,
    };
    if (hasLink) {
      updates[`${paths.providerSubscription(providerKey)}/status`] = 'ACTIVE';
      updates[`${paths.providerSubscription(providerKey)}/subscriptionId`] = subscriptionId;
      updates[`${paths.providerSubscription(providerKey)}/updatedAt`] = now;
    } else {
      updates[paths.providerSubscription(providerKey)] = {
        uid,
        subscriptionId,
        providerSubscriptionId,
        linkedAt: now,
        planCode: plan.code,
        status: 'ACTIVE',
        updatedAt: now,
      };
    }
    let replacedProviderId;
    if (current && current.subscriptionId !== subscriptionId) {
      updates[paths.subscriptionHistoryEntry(uid, current.subscriptionId)] = stripUndefined({
        ...current,
        status: ENTITLED_STATUSES.includes(current.status) ? 'CANCELLED' : current.status,
        endedAt: current.endedAt ?? now,
        updatedAt: now,
      });
      if (
        !current.isTrial &&
        current.providerSubscriptionId &&
        current.providerSubscriptionId !== providerSubscriptionId
      ) {
        replacedProviderId = current.providerSubscriptionId;
        updates[`${paths.providerSubscription(keyForExternalId(replacedProviderId))}/status`] = 'SUPERSEDED';
      }
    }
    await applyUpdates(updates);
    if (replacedProviderId) {
      await RazorpayService.cancelRazorpaySubscription(replacedProviderId).catch(error =>
        logger.error(
          `Plan change for user ${uid}: could not cancel replaced Razorpay subscription ${replacedProviderId} \u2014 cancel it manually to stop billing: ${error.message}`,
        ),
      );
    }
    await upgradeToPremiumSafely(uid);
    logger.info(
      `Started ${plan.code} for user ${uid} (Razorpay ${providerSubscriptionId}) until ${new Date(periodEnd).toISOString()}`,
    );
    return record;
  }
  /** A renewal charge on the user's current paid plan: new period and a fresh credit allocation. */
  static async renewPaidSubscription(subscription, eventTimestamp, paymentRef, paidCount, paymentId) {
    const now = Date.now();
    const durationDays = subscription.billingIntervalSnapshot === 'yearly' ? 365 : 30;
    const newEnd = now + durationDays * DAY_MS;
    const next = withoutField(
      stripUndefined({
        ...subscription,
        status: 'ACTIVE',
        currentPeriodStart: now,
        currentPeriodEnd: newEnd,
        lastEventTimestamp: eventTimestamp,
        providerPaidCount: paidCount ?? subscription.providerPaidCount,
        lastProviderPaymentId: paymentId ?? subscription.lastProviderPaymentId,
        updatedAt: now,
      }),
      'pastDueStartedAt',
    );
    const allocation = await CreditService.buildAllocationUpdates({
      userId: subscription.uid,
      subscriptionId: subscription.subscriptionId,
      allocatedCredits: subscription.creditsSnapshot,
      periodStart: now,
      periodEnd: newEnd,
      description: `Renewal credit top-up (${paymentRef})`,
      type: 'SUBSCRIPTION_RENEWAL',
    });
    await applyUpdates({ [paths.subscription(subscription.uid)]: next, ...allocation.updates });
    await upgradeToPremiumSafely(subscription.uid);
  }
  /**
   * Admin activation of a plan (scripts/activate_pro_user.ts): makes `planCode` the user's ACTIVE
   * subscription for `durationDays`, allocates the plan credits and upgrades the Career Brain tier.
   * An existing subscription record is updated in place (same id), as the old Mongo script did.
   */
  static async activatePlanManually(userId, planCode, durationDays = 30) {
    const plan = await PlanService.getActivePlan(planCode);
    if (!plan) {
      throw new AppError(`Plan '${planCode}' not found or inactive`, 404, 'PLAN_NOT_FOUND');
    }
    const now = Date.now();
    const periodEnd = now + durationDays * DAY_MS;
    const previous = await SubscriptionRepository.getCurrent(userId);
    const subscriptionId = previous?.subscriptionId ?? `sub_manual_${plan.code}_${now.toString(36)}`;
    const activated = {
      subscriptionId,
      uid: userId,
      planId: plan.legacyId || plan.code,
      planCodeSnapshot: plan.code,
      planNameSnapshot: plan.name,
      amountSnapshot: plan.amount,
      currencySnapshot: plan.currency,
      billingIntervalSnapshot: plan.billingInterval,
      creditsSnapshot: plan.creditsPerBillingPeriod,
      rateLimitSnapshot: plan.rateLimitPerMinute,
      provider: previous?.provider ?? 'manual',
      providerSubscriptionId: previous?.providerSubscriptionId,
      status: 'ACTIVE',
      isTrial: false,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      lastEventTimestamp: now,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    const allocation = await CreditService.buildAllocationUpdates({
      userId,
      subscriptionId,
      allocatedCredits: plan.creditsPerBillingPeriod,
      periodStart: now,
      periodEnd,
      description: `Manual ${plan.name} activation (${plan.creditsPerBillingPeriod} credits)`,
      type: 'SUBSCRIPTION_RENEWAL',
    });
    await applyUpdates({ [paths.subscription(userId)]: activated, ...allocation.updates });
    await upgradeToPremiumSafely(userId);
    logger.info(`Manually activated plan ${plan.code} for user ${userId} until ${new Date(periodEnd).toISOString()}`);
    return toSubscriptionDto(activated);
  }
  /**
   * User-initiated cancellation. Sets cancelAtPeriodEnd = true.
   * User retains full access until currentPeriodEnd.
   */
  static async cancelSubscription(userId) {
    const now = Date.now();
    const { changed, subscription } = await SubscriptionRepository.transactCurrent(userId, sub =>
      isEntitled(sub) ? { ...sub, cancelAtPeriodEnd: true, canceledAt: now, updatedAt: now } : null,
    );
    if (!changed || !subscription) {
      throw new AppError('No active or trialing subscription found to cancel', 404, 'SUBSCRIPTION_NOT_FOUND');
    }
    logger.info(
      `User ${userId} requested cancellation at period end (${new Date(subscription.currentPeriodEnd).toISOString()})`,
    );
    return toSubscriptionDto(subscription);
  }
  /**
   * Processes incoming Razorpay server-to-server webhooks with atomic deduplication,
   * HMAC verification, stale event detection, stuck processing reclaim, and credit reset handling.
   */
  static async processWebhook(params) {
    const { eventId, eventType, providerPaymentId, payload, rawBody, signatureHeader, eventCreatedAt } = params;
    const isValidSignature = RazorpayService.verifyWebhookSignature(rawBody, signatureHeader);
    if (!isValidSignature) {
      throw new AppError('Invalid webhook signature', 401, 'INVALID_SIGNATURE');
    }
    const eventKey = keyForExternalId(String(eventId));
    const claimOutcome = await WebhookRepository.claim(
      eventKey,
      {
        eventId: String(eventId),
        eventType,
        providerPaymentId,
        payloadJson: JSON.stringify(payload ?? {}),
      },
      Date.now(),
      WEBHOOK_STUCK_AFTER_MS,
    );
    if (claimOutcome === 'ALREADY_PROCESSED') {
      return { success: true, message: 'Event already processed', isDuplicate: true };
    }
    if (claimOutcome === 'IN_FLIGHT') {
      return { success: true, message: 'Event currently processing', isDuplicate: true };
    }
    if (claimOutcome === 'RECLAIMED') {
      logger.warn(`Reclaiming stuck PROCESSING webhook event ${eventId}`);
    }
    try {
      const subEntity = payload.subscription?.entity || payload.entity;
      const rzpSubId = typeof subEntity?.id === 'string' ? subEntity.id : void 0;
      const paymentId = providerPaymentId || payload.payment?.entity?.id || `evt_pay_${eventId}`;
      if (rzpSubId) {
        const providerKey = keyForExternalId(rzpSubId);
        const link = await SubscriptionRepository.getProviderLink(providerKey);
        const notes = subEntity?.notes ?? {};
        const uid = link?.uid ?? (typeof notes.userId === 'string' && isSafeKey(notes.userId) ? notes.userId : null);
        const current = uid ? await SubscriptionRepository.getCurrent(uid) : null;
        const isCurrentPaid = Boolean(current && current.providerSubscriptionId === rzpSubId && !current.isTrial);
        const now = Date.now();
        const timestamp = toMs(eventCreatedAt) ?? now;
        if (
          current &&
          current.providerSubscriptionId === rzpSubId &&
          current.lastEventTimestamp &&
          timestamp < current.lastEventTimestamp
        ) {
          logger.info(`Ignored stale webhook event '${eventType}' for subscription ${current.subscriptionId}`);
          await WebhookRepository.markProcessed(eventKey, now);
          return { success: true, message: 'Stale event ignored', isDuplicate: true };
        }
        if (uid && (eventType === 'subscription.activated' || eventType === 'subscription.charged')) {
          const planCode =
            link?.planCode ??
            (typeof notes.planCode === 'string' ? notes.planCode : void 0) ??
            (isCurrentPaid ? current.planCodeSnapshot : void 0);
          const plan = planCode ? await PlanService.getActivePlan(planCode) : null;
          const paidCount = typeof subEntity?.paid_count === 'number' ? subEntity.paid_count : void 0;
          const chargePaymentId = payload.payment?.entity?.id;
          if (!plan) {
            logger.error(`Paid event '${eventType}' for ${rzpSubId}: plan '${planCode}' unknown, not applied`);
          } else if (isCurrentPaid && current.planCodeSnapshot === plan.code) {
            const alreadyApplied =
              (chargePaymentId !== void 0 && current.lastProviderPaymentId === chargePaymentId) ||
              (paidCount !== void 0 && current.providerPaidCount !== void 0 && paidCount <= current.providerPaidCount);
            if (eventType === 'subscription.charged' && !alreadyApplied) {
              await this.renewPaidSubscription(current, timestamp, paymentId, paidCount, chargePaymentId);
            } else if (current.status !== 'ACTIVE') {
              await applyUpdates({
                [paths.subscription(uid)]: withoutField(
                  { ...current, status: 'ACTIVE', lastEventTimestamp: timestamp, updatedAt: now },
                  'pastDueStartedAt',
                ),
              });
            }
          } else if (link?.status === 'SUPERSEDED' || link?.status === 'CANCELLED') {
            logger.error(
              `Paid event '${eventType}' for ${link.status} Razorpay subscription ${rzpSubId} (user ${uid}): not applied, review manually`,
            );
          } else {
            await this.startPaidSubscription({
              uid,
              plan,
              providerSubscriptionId: rzpSubId,
              current,
              hasLink: Boolean(link),
              eventTimestamp: timestamp,
              paidCount,
              paymentId: chargePaymentId,
            });
          }
        } else if (eventType === 'subscription.authenticated') {
          if (link && !isCurrentPaid) {
            await SubscriptionRepository.updateProviderLink(providerKey, { status: 'AUTHENTICATED', updatedAt: now });
          }
        } else if (eventType === 'subscription.halted' || eventType === 'payment.failed') {
          if (isCurrentPaid) {
            await applyUpdates({
              [paths.subscription(uid)]: {
                ...current,
                status: 'PAST_DUE',
                pastDueStartedAt: now,
                lastEventTimestamp: timestamp,
                updatedAt: now,
              },
            });
          } else if (link) {
            await SubscriptionRepository.updateProviderLink(providerKey, { status: 'FAILED', updatedAt: now });
          }
        } else if (eventType === 'subscription.cancelled') {
          if (isCurrentPaid) {
            const subscription = current;
            const next = payload.immediate
              ? { ...subscription, status: 'CANCELLED', endedAt: now, lastEventTimestamp: timestamp, updatedAt: now }
              : {
                  ...subscription,
                  cancelAtPeriodEnd: true,
                  canceledAt: now,
                  lastEventTimestamp: timestamp,
                  updatedAt: now,
                };
            await applyUpdates({ [paths.subscription(uid)]: next });
          } else if (link && link.status !== 'SUPERSEDED') {
            await SubscriptionRepository.updateProviderLink(providerKey, { status: 'CANCELLED', updatedAt: now });
            if (link.planCode) await SubscriptionRepository.clearCheckoutSession(link.uid, link.planCode);
          }
        }
      }
      if (eventType === 'payment.captured') {
        const paymentEntity = payload.payment?.entity || payload.entity;
        const capturedSubId = paymentEntity?.subscription_id || rzpSubId;
        let targetUserId = paymentEntity?.notes?.userId || payload.order?.entity?.notes?.userId;
        if (!targetUserId && typeof capturedSubId === 'string') {
          const link = await SubscriptionRepository.getProviderLink(keyForExternalId(capturedSubId));
          if (link) {
            targetUserId = link.uid;
          }
        }
        if (typeof targetUserId === 'string' && isSafeKey(targetUserId)) {
          await upgradeToPremiumSafely(targetUserId);
          logger.info(`Upgraded Career Brain to Premium for user ${targetUserId} via payment.captured`);
        }
      }
      await WebhookRepository.markProcessed(eventKey, Date.now());
      return { success: true, message: 'Webhook processed successfully' };
    } catch (error) {
      await WebhookRepository.markFailed(eventKey, error?.message || 'Webhook processing failed', Date.now()).catch(
        () => void 0,
      );
      throw error;
    }
  }
};

// src/schemas/subscription.schema.ts
import { z as z4 } from 'zod';
var createSubscriptionSchema = z4
  .object({
    userId: z4.string({ required_error: 'User ID is required' }).trim(),
    planId: z4.string({ required_error: 'Plan ID is required' }).trim(),
    planCodeSnapshot: z4.string({ required_error: 'Plan code snapshot is required' }).trim(),
    planNameSnapshot: z4.string({ required_error: 'Plan name snapshot is required' }).trim(),
    amountSnapshot: z4
      .number({ required_error: 'Amount snapshot is required' })
      .int('Amount snapshot must be an integer in the smallest currency unit (e.g. paise)')
      .min(0, 'Amount snapshot must be non-negative'),
    currencySnapshot: z4.string({ required_error: 'Currency snapshot is required' }).trim().toUpperCase(),
    billingIntervalSnapshot: z4.enum(['none', 'monthly', 'yearly'], {
      required_error: 'Billing interval snapshot is required',
    }),
    creditsSnapshot: z4
      .number({ required_error: 'Credits snapshot is required' })
      .int('Credits snapshot must be an integer')
      .min(1, 'Credits snapshot must be at least 1'),
    rateLimitSnapshot: z4
      .number({ required_error: 'Rate limit snapshot is required' })
      .int('Rate limit snapshot must be an integer')
      .min(1, 'Rate limit snapshot must be at least 1'),
    provider: z4.enum(['manual', 'razorpay']).default('manual'),
    providerCustomerId: z4.string().trim().optional(),
    providerSubscriptionId: z4.string().trim().optional(),
    status: z4.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED']).default('TRIALING'),
    isTrial: z4.boolean().default(false),
    trialStartDate: z4.string().datetime().optional(),
    trialEndDate: z4.string().datetime().optional(),
    currentPeriodStart: z4.string({ required_error: 'Current period start date is required' }).datetime(),
    currentPeriodEnd: z4.string({ required_error: 'Current period end date is required' }).datetime(),
    cancelAtPeriodEnd: z4.boolean().default(false),
    canceledAt: z4.string().datetime().optional(),
    endedAt: z4.string().datetime().optional(),
  })
  .strict();
var checkoutInputSchema = z4
  .object({
    planCode: z4.string({ required_error: 'Plan code is required' }).trim().min(1),
    idempotencyKey: z4.string().trim().optional(),
  })
  .strict();
var verifyPaymentInputSchema = z4
  .object({
    razorpayPaymentId: z4.string({ required_error: 'Razorpay payment ID is required' }).trim().min(1),
    razorpaySubscriptionId: z4.string({ required_error: 'Razorpay subscription ID is required' }).trim().min(1),
    razorpaySignature: z4.string({ required_error: 'Razorpay signature is required' }).trim().min(1),
  })
  .strict();
var cancelSubscriptionSchema = z4
  .object({
    reason: z4.string().trim().max(255).optional(),
  })
  .strict();

// src/controllers/checkout.controller.ts
var CheckoutController = class {
  /**
   * POST /api/v1/subscription/checkout
   * Creates a Razorpay checkout session for a selected paid plan.
   */
  static async checkout(req, res, next) {
    try {
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }
      const input = checkoutInputSchema.parse(req.body);
      const result = await SubscriptionLifecycleService.createCheckoutSession(
        userId,
        input.planCode,
        input.idempotencyKey,
      );
      sendSuccess(res, result, 'Checkout session created successfully');
    } catch (error) {
      next(error);
    }
  }
  /**
   * POST /api/v1/subscription/verify-payment
   * Verifies Razorpay payment signature and activates paid subscription.
   */
  static async verifyPayment(req, res, next) {
    try {
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }
      const input = verifyPaymentInputSchema.parse(req.body);
      const result = await SubscriptionLifecycleService.verifyPayment({
        userId,
        paymentId: input.razorpayPaymentId,
        subscriptionId: input.razorpaySubscriptionId,
        signature: input.razorpaySignature,
      });
      sendSuccess(
        res,
        {
          subscription: result.subscription,
          hasActiveEntitlement: result.hasActiveEntitlement,
          isIdempotentRetry: result.isIdempotentRetry,
        },
        result.isIdempotentRetry ? 'Payment already verified' : 'Payment verified and subscription activated',
        200,
      );
    } catch (error) {
      next(error);
    }
  }
  /**
   * POST /api/v1/subscription/cancel
   * Requests cancellation at period end.
   */
  static async cancel(req, res, next) {
    try {
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }
      cancelSubscriptionSchema.parse(req.body || {});
      const subscription = await SubscriptionLifecycleService.cancelSubscription(userId);
      sendSuccess(
        res,
        {
          subscription,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          currentPeriodEnd: subscription.currentPeriodEnd,
        },
        'Subscription scheduled for cancellation at current period end',
      );
    } catch (error) {
      next(error);
    }
  }
};

// src/routes/subscription.routes.ts
var subscriptionRouter = Router3();
subscriptionRouter.get('/me', authenticate, SubscriptionController.getMySubscription);
subscriptionRouter.get('/plans', SubscriptionController.getPlans);
subscriptionRouter.post('/checkout', authenticate, CheckoutController.checkout);
subscriptionRouter.post('/verify-payment', authenticate, CheckoutController.verifyPayment);
subscriptionRouter.post('/trial/activate', authenticate, SubscriptionController.activateFreeTrial);
subscriptionRouter.post('/cancel', authenticate, CheckoutController.cancel);

// src/routes/credit.routes.ts
import { Router as Router4 } from 'express';

// src/controllers/credit.controller.ts
import crypto3 from 'node:crypto';

// src/middleware/entitlement.middleware.ts
async function hasVerifiedJobformPremium(userId) {
  try {
    return (await JobformPremiumService.getStatus(userId)).isPremium;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[Entitlement] Could not read JobForm Automator premium status for ${userId}: ${message}`);
    return false;
  }
}
async function checkEntitlement(req, _res, next) {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) {
      throw new AppError('Authentication required to access this resource', 401, 'UNAUTHORIZED');
    }
    if (!isRtdbAvailable()) {
      throw new AppError('Service temporarily unavailable, cannot verify entitlement', 503, 'SERVICE_UNAVAILABLE');
    }
    await TrialService.expireSubscriptionIfEnded(userId);
    await TrialService.healUserTrialSubscriptionIfEligible(userId);
    const subscription = await TrialService.getCurrentSubscriptionDto(userId);
    const hasSubscription = Boolean(subscription && ['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(subscription.status));
    const premiumCovered = await hasVerifiedJobformPremium(userId);
    if (!hasSubscription && !premiumCovered) {
      throw new AppError(
        'Your free trial has expired or you do not have an active subscription. Please upgrade to a paid plan.',
        403,
        'SUBSCRIPTION_EXPIRED',
      );
    }
    if (subscription) req.subscription = subscription;
    req.premiumCovered = premiumCovered;
    next();
  } catch (error) {
    next(error);
  }
}

// src/schemas/credit.schema.ts
import { z as z5 } from 'zod';
var creditHistoryQuerySchema = z5
  .object({
    page: z5
      .string()
      .optional()
      .transform(val => (val ? parseInt(val, 10) : 1))
      .pipe(z5.number().int().min(1, 'Page must be at least 1')),
    limit: z5
      .string()
      .optional()
      .transform(val => (val ? parseInt(val, 10) : 20))
      .pipe(z5.number().int().min(1, 'Limit must be at least 1').max(100, 'Limit cannot exceed 100')),
  })
  .strict();
var creditDeductInputSchema = z5
  .object({
    amount: z5
      .number()
      .int('Deduction amount must be an integer')
      .min(1, 'Deduction amount must be at least 1 credit')
      .max(1e3, 'Deduction amount cannot exceed 1000 credits'),
    description: z5.string().min(1, 'Description is required').max(255),
    idempotencyKey: z5.string().min(1).max(128).optional(),
    metadata: z5.record(z5.any()).optional(),
  })
  .strict();

// src/controllers/credit.controller.ts
var ALLOWED_FAILED_REFUND_REASONS = ['max_attempts_exceeded', 'max_age_exceeded', 'client_dropped', 'network_failure'];
var CreditController = class {
  /**
   * GET /api/v1/credits/balance
   * Returns current credit balance for authenticated user.
   */
  static async getBalance(req, res, next) {
    try {
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }
      const balance = await CreditService.getCreditBalance(userId);
      const premiumCovered = await hasVerifiedJobformPremium(userId);
      if (!balance) {
        sendSuccess(
          res,
          {
            allocatedCredits: 0,
            usedCredits: 0,
            remainingCredits: 0,
            periodStart: null,
            periodEnd: null,
            isLowBalance: !premiumCovered,
            premiumCovered,
          },
          'User credit balance retrieved',
        );
        return;
      }
      const isLowBalance = balance.remainingCredits <= Math.ceil(balance.allocatedCredits * 0.1);
      sendSuccess(
        res,
        {
          allocatedCredits: balance.allocatedCredits,
          usedCredits: balance.usedCredits,
          remainingCredits: balance.remainingCredits,
          periodStart: balance.periodStart,
          periodEnd: balance.periodEnd,
          isLowBalance: isLowBalance && !premiumCovered,
          premiumCovered,
        },
        'User credit balance retrieved',
      );
    } catch (error) {
      next(error);
    }
  }
  /**
   * GET /api/v1/credits/history
   * Returns paginated credit audit ledger for authenticated user.
   */
  static async getHistory(req, res, next) {
    try {
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }
      const { page, limit } = creditHistoryQuerySchema.parse(req.query);
      const result = await CreditService.getCreditHistory(userId, page, limit);
      sendSuccess(
        res,
        {
          items: result.items,
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
            totalPages: Math.ceil(result.total / result.limit),
          },
        },
        'Credit history retrieved',
      );
    } catch (error) {
      next(error);
    }
  }
  /**
   * POST /api/v1/credits/refund
   * Refunds credits back to user for a specific agent run.
   * Server calculates the refund amount from the CreditLedger for the given runId.
   */
  static async refundCredits(req, res, next) {
    const requestId = req.headers['x-request-id'] || req.headers['x-correlation-id'] || crypto3.randomUUID();
    const userId = req.user?._id?.toString() || req.user?.uid;
    const rawRunId = req.body?.runId;
    const runId = typeof rawRunId === 'string' ? rawRunId.trim() : void 0;
    try {
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }
      if (!runId || typeof rawRunId !== 'string' || runId === '') {
        throw new AppError('runId is required for refund', 400, 'INVALID_RUN_ID');
      }
      const result = await CreditService.refundRunCredits({
        userId,
        runId,
      });
      logger.info('[CreditController.refundCredits] Refund processed', {
        requestId,
        userId,
        runId,
        outcome: 'SUCCESS',
        refundedAmount: result.refundedAmount,
        remainingCredits: result.balance.remainingCredits,
      });
      sendSuccess(
        res,
        {
          remainingCredits: result.balance.remainingCredits,
          usedCredits: result.balance.usedCredits,
          allocatedCredits: result.balance.allocatedCredits,
          refundedAmount: result.refundedAmount,
          runId: result.runId,
        },
        'Credits refunded successfully',
      );
    } catch (error) {
      const statusCode = error instanceof AppError ? error.statusCode : 500;
      const errorCode = error instanceof AppError ? error.code : 'INTERNAL_SERVER_ERROR';
      logger.error('[CreditController.refundCredits] Refund failed', {
        requestId,
        userId: userId || 'anonymous',
        runId: runId || (typeof rawRunId === 'string' ? rawRunId : 'invalid'),
        outcome: 'FAILED',
        statusCode,
        errorCode,
        errorMessage: error?.message || 'Unknown error',
        stack: statusCode === 500 ? error?.stack : void 0,
      });
      next(error);
    }
  }
  /**
   * POST /api/v1/credits/refund/report-failed
   * Reports dropped client refund attempts for support inspection and auditing.
   */
  static async reportFailedRefund(req, res, next) {
    try {
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }
      const { runId, idempotencyKey, reason } = req.body;
      if (!runId || !idempotencyKey || typeof runId !== 'string' || typeof idempotencyKey !== 'string') {
        throw new AppError('runId and idempotencyKey are required', 400, 'INVALID_INPUT');
      }
      const rawReason = String(reason || '')
        .trim()
        .toLowerCase();
      if (!ALLOWED_FAILED_REFUND_REASONS.includes(rawReason)) {
        throw new AppError(
          `Invalid refund failure reason. Must be one of: ${ALLOWED_FAILED_REFUND_REASONS.join(', ')}`,
          400,
          'INVALID_REASON',
        );
      }
      const result = await CreditService.reportFailedRefund({
        userId,
        runId: runId.trim(),
        idempotencyKey: idempotencyKey.trim(),
        reason: rawReason,
      });
      sendSuccess(res, result, 'Failed refund reported successfully');
    } catch (error) {
      next(error);
    }
  }
  /**
   * POST /api/v1/credits/reconcile
   * Scans unapplied runs that were charged and automatically refunds them.
   * Gated behind ENABLE_CREDITS_RECONCILE feature flag (default false).
   */
  static async reconcileUnapplied(req, res, next) {
    try {
      if (!env.ENABLE_CREDITS_RECONCILE) {
        throw new AppError('Credits reconciliation feature is currently disabled', 403, 'FEATURE_DISABLED');
      }
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }
      const result = await CreditService.reconcileUnappliedRuns(userId);
      sendSuccess(res, result, 'Reconciliation completed');
    } catch (error) {
      next(error);
    }
  }
};

// src/routes/credit.routes.ts
var creditRouter = Router4();
creditRouter.use(authenticate);
creditRouter.use(readApiRateLimiter);
creditRouter.get('/balance', CreditController.getBalance);
creditRouter.get('/history', CreditController.getHistory);
creditRouter.post('/refund', refundRateLimiter, CreditController.refundCredits);
creditRouter.post('/refund/report-failed', refundRateLimiter, CreditController.reportFailedRefund);
creditRouter.post('/reconcile', refundRateLimiter, CreditController.reconcileUnapplied);

// src/routes/webhook.routes.ts
import { Router as Router5, raw } from 'express';

// src/controllers/webhook.controller.ts
var WebhookController = class {
  /**
   * POST /api/v1/webhooks/razorpay
   * Handles incoming Razorpay server-to-server webhook events.
   * Expects raw request body Buffer for HMAC SHA256 signature verification.
   */
  static async handleRazorpayWebhook(req, res, next) {
    try {
      const signatureHeader = req.headers['x-razorpay-signature'];
      if (!signatureHeader) {
        throw new AppError('Missing x-razorpay-signature header', 401, 'INVALID_SIGNATURE');
      }
      const rawBody = req.rawBody || req.body;
      if (!rawBody || (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string')) {
        throw new AppError('Invalid raw request body for webhook verification', 400, 'BAD_REQUEST');
      }
      let payload;
      try {
        const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
        payload = JSON.parse(bodyStr);
      } catch {
        throw new AppError('Invalid JSON payload in webhook body', 400, 'INVALID_PAYLOAD');
      }
      const eventId = payload.event_id || req.headers['x-razorpay-event-id'] || `evt_mock_${Date.now()}`;
      const eventType = payload.event || 'unknown';
      let providerPaymentId;
      if (payload.payload?.payment?.entity?.id) {
        providerPaymentId = payload.payload.payment.entity.id;
      } else if (payload.payload?.subscription?.entity?.payment_id) {
        providerPaymentId = payload.payload.subscription.entity.payment_id;
      }
      const eventCreatedAt = payload.created_at ? new Date(payload.created_at * 1e3) : /* @__PURE__ */ new Date();
      const result = await SubscriptionLifecycleService.processWebhook({
        eventId,
        eventType,
        providerPaymentId,
        payload: payload.payload || payload,
        rawBody,
        signatureHeader,
        eventCreatedAt,
      });
      sendSuccess(res, null, result.message, 200);
    } catch (error) {
      next(error);
    }
  }
};

// src/routes/webhook.routes.ts
var webhookRouter = Router5();
webhookRouter.post(
  '/razorpay',
  raw({ type: 'application/json', limit: '1mb' }),
  WebhookController.handleRazorpayWebhook,
);

// src/routes/llm.routes.ts
import { Router as Router6 } from 'express';

// src/services/llm.service.ts
import crypto4 from 'node:crypto';

// src/services/llm/mockLlmProvider.ts
var MockLlmProvider = class {
  providerName = 'mock';
  options;
  constructor(options = {}) {
    this.options = options;
  }
  setOptions(options) {
    this.options = { ...this.options, ...options };
  }
  async generateCompletion(request) {
    const timeoutMs = request.timeoutMs ?? 1e4;
    if (this.options.shouldTimeout) {
      await new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs, 200)));
      throw new AppError('LLM Provider request timed out', 504, 'PROVIDER_TIMEOUT');
    }
    if (this.options.shouldFail) {
      const status = this.options.failStatus ?? 502;
      const message = this.options.failMessage ?? 'LLM Provider service error';
      const code = status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_ERROR';
      throw new AppError(message, status, code);
    }
    const promptText = request.messages.map(m => m.content).join(' ');
    const promptTokens = Math.max(1, Math.ceil(promptText.length / 4));
    const content =
      this.options.mockResponseText ??
      `Mock response for model '${request.model}': I have processed your request with ${request.messages.length} messages.`;
    const completionTokens = Math.max(1, Math.ceil(content.length / 4));
    const totalTokens = promptTokens + completionTokens;
    return {
      content,
      promptTokens,
      completionTokens,
      totalTokens,
      finishReason: 'stop',
    };
  }
  async streamCompletion(request, onChunk, signal) {
    if (this.options.shouldTimeout) {
      throw new AppError('LLM Provider request timed out during stream', 504, 'PROVIDER_TIMEOUT');
    }
    if (this.options.shouldFail) {
      const status = this.options.failStatus ?? 502;
      const message = this.options.failMessage ?? 'LLM Provider service error during stream';
      const code = status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_ERROR';
      throw new AppError(message, status, code);
    }
    const promptText = request.messages.map(m => m.content).join(' ');
    const promptTokens = Math.max(1, Math.ceil(promptText.length / 4));
    const content = this.options.mockResponseText ?? `Mock streaming response for model '${request.model}'.`;
    const chunks = content.split(' ');
    let emittedContent = '';
    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) {
        break;
      }
      const chunkText = (i > 0 ? ' ' : '') + chunks[i];
      emittedContent += chunkText;
      onChunk(chunkText);
    }
    const completionTokens = Math.max(1, Math.ceil(emittedContent.length / 4));
    const totalTokens = promptTokens + completionTokens;
    return {
      content: emittedContent,
      promptTokens,
      completionTokens,
      totalTokens,
      finishReason: signal?.aborted ? 'length' : 'stop',
    };
  }
};

// src/services/llm/bedrockLlmProvider.ts
var BedrockLlmProvider = class {
  providerName = 'bedrock';
  apiKey;
  region;
  baseUrl;
  constructor(apiKey, region = 'us-east-1', baseUrl) {
    this.apiKey = apiKey;
    this.region = region;
    this.baseUrl = baseUrl || `https://bedrock-runtime.${region}.amazonaws.com`;
  }
  formatBedrockMessages(messages) {
    const systemMessages = [];
    const rawBedrockMessages = [];
    for (const msg of messages) {
      const rawContent = msg.content;
      const textContent =
        typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent || msg.tool_calls || '');
      if (msg.role === 'system') {
        systemMessages.push({ text: textContent || 'System Prompt' });
      } else if (msg.role === 'tool') {
        rawBedrockMessages.push({
          role: 'user',
          content: [{ text: `Observation (${msg.name || msg.tool_call_id || 'tool'}): ${textContent || 'Success'}` }],
        });
      } else {
        const text2 = textContent?.trim();
        if (text2) {
          rawBedrockMessages.push({
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: [{ text: text2 }],
          });
        } else if (msg.role !== 'assistant') {
          rawBedrockMessages.push({
            role: 'user',
            content: [{ text: 'Continue.' }],
          });
        }
      }
    }
    const bedrockMessages = [];
    for (const item of rawBedrockMessages) {
      const cleanedContent = item.content.filter(b => b.text?.trim());
      if (cleanedContent.length === 0) {
        continue;
      }
      const cleanedItem = { role: item.role, content: cleanedContent };
      if (bedrockMessages.length === 0) {
        if (cleanedItem.role === 'assistant') {
          bedrockMessages.push({ role: 'user', content: [{ text: 'Begin task' }] });
        }
        bedrockMessages.push(cleanedItem);
      } else {
        const last = bedrockMessages[bedrockMessages.length - 1];
        if (last.role === cleanedItem.role) {
          last.content.push(...cleanedItem.content);
        } else {
          bedrockMessages.push(cleanedItem);
        }
      }
    }
    if (bedrockMessages.length > 0 && bedrockMessages[bedrockMessages.length - 1].role === 'assistant') {
      bedrockMessages.push({ role: 'user', content: [{ text: 'Please provide the next step.' }] });
    }
    return { systemMessages, bedrockMessages };
  }
  cleanJsonMarkdown(text2) {
    if (!text2 || typeof text2 !== 'string') return '';
    let cleaned = text2.trim();
    cleaned = cleaned.replace(/<(?:think|thought)>[\s\S]*?<\/(?:think|thought)>/gi, '').trim();
    cleaned = cleaned
      .replace(/^<[a-z0-9_-]+>\s*/i, '')
      .replace(/\s*<\/[a-z0-9_-]+>$/i, '')
      .trim();
    if (cleaned.includes('```')) {
      const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (match && match[1]) {
        cleaned = match[1].trim();
      } else {
        const parts = cleaned.split('```');
        if (parts.length >= 2) {
          cleaned = parts[1].replace(/^json\s*/i, '').trim();
        }
      }
    }
    cleaned = cleaned
      .replace(/^\[(?:Tool\s+Output|Tool\s+Use|Tool|Action|Observation|Result|Call|Response)[^\]]*\]:?\s*/i, '')
      .trim();
    try {
      JSON.parse(cleaned);
      return cleaned;
    } catch {}
    const candidates = [];
    for (let i = 0; i < cleaned.length; i++) {
      const char = cleaned[i];
      if (char === '{' || char === '[') {
        const openChar = char;
        const closeChar = char === '{' ? '}' : ']';
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let j = i; j < cleaned.length; j++) {
          const c = cleaned[j];
          if (inString) {
            if (escape) {
              escape = false;
            } else if (c === '\\') {
              escape = true;
            } else if (c === '"') {
              inString = false;
            }
          } else {
            if (c === '"') {
              inString = true;
            } else if (c === openChar) {
              depth++;
            } else if (c === closeChar) {
              depth--;
              if (depth === 0) {
                candidates.push(cleaned.substring(i, j + 1));
                break;
              }
            }
          }
        }
      }
    }
    for (const cand of candidates) {
      try {
        const parsed = JSON.parse(cand);
        if (parsed && typeof parsed === 'object') {
          return cand;
        }
      } catch {
        try {
          const fixed = cand.replace(/,\s*([}\]])/g, '$1');
          JSON.parse(fixed);
          return fixed;
        } catch {}
      }
    }
    const objCandidates = candidates.filter(c => c.startsWith('{') && c.endsWith('}'));
    if (objCandidates.length > 0) {
      objCandidates.sort((a, b) => b.length - a.length);
      return objCandidates[0].trim();
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.length - a.length);
      return candidates[0].trim();
    }
    return cleaned.trim();
  }
  async generateCompletion(request) {
    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? 3e4;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const { systemMessages, bedrockMessages } = this.formatBedrockMessages(request.messages);
    const endpoint = `${this.baseUrl}/model/${encodeURIComponent(request.model)}/converse`;
    const effectiveMaxTokens = request.maxTokens || 4096;
    const requestPayload = {
      messages: bedrockMessages,
      ...(systemMessages.length > 0 ? { system: systemMessages } : {}),
      inferenceConfig: {
        temperature: request.temperature ?? 0.7,
        maxTokens: effectiveMaxTokens,
      },
    };
    logger.info(
      `[BedrockLlmProvider] === BEDROCK CONVERSE REQUEST ===
` +
        JSON.stringify(
          {
            model: request.model,
            endpoint,
            inferenceConfig: requestPayload.inferenceConfig,
            systemCount: systemMessages.length,
            turnCount: bedrockMessages.length,
            turns: bedrockMessages.map((m, idx) => ({
              turn: idx + 1,
              role: m.role,
              blocks: m.content?.length,
              preview: m.content?.map(c =>
                typeof c.text === 'string'
                  ? c.text.length > 80
                    ? c.text.substring(0, 80) + '...'
                    : c.text
                  : Object.keys(c),
              ),
            })),
          },
          null,
          2,
        ),
    );
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        let errorData = {};
        try {
          errorData = await response.json();
        } catch {}
        const errMsg =
          errorData.message || errorData.error || `AWS Bedrock provider returned HTTP status ${response.status}`;
        if (response.status === 429) {
          throw new AppError('AWS Bedrock rate limit exceeded. Please try again later.', 429, 'PROVIDER_RATE_LIMIT');
        }
        if (response.status >= 500) {
          throw new AppError('AWS Bedrock service error. Please try again later.', 502, 'PROVIDER_ERROR');
        }
        throw new AppError(errMsg, 400, 'PROVIDER_BAD_REQUEST');
      }
      const data = await response.json();
      let rawMessageContent = '';
      if (Array.isArray(data.output?.message?.content)) {
        for (const block of data.output.message.content) {
          if (typeof block.text === 'string') {
            rawMessageContent += block.text;
          } else if (block.toolUse?.input) {
            rawMessageContent += JSON.stringify(block.toolUse.input);
          } else if (typeof block.reasoningContent?.text === 'string') {
            rawMessageContent += block.reasoningContent.text;
          } else {
            rawMessageContent += JSON.stringify(block);
          }
        }
      }
      logger.info(
        `[BedrockLlmProvider] === BEDROCK CONVERSE RESPONSE ===
Model: ${request.model}
StopReason: ${data.stopReason || 'none'}
Usage: ${JSON.stringify(data.usage || {})}
ContentBlocksCount: ${data.output?.message?.content?.length || 0}
RawLength: ${rawMessageContent.length}`,
      );
      if (rawMessageContent) {
        logger.info(`[BedrockLlmProvider] Raw output:
${rawMessageContent}`);
      } else {
        logger.warn(
          `[BedrockLlmProvider] EMPTY raw output from ${request.model}! Full Bedrock response:
${JSON.stringify(data, null, 2)}`,
        );
      }
      if (data.stopReason === 'content_filtered') {
        throw new AppError('AWS Bedrock safety filter blocked the web page content.', 400, 'PROVIDER_CONTENT_FILTERED');
      }
      if (!rawMessageContent.trim()) {
        throw new AppError(
          `AWS Bedrock provider returned an empty completion (stopReason: ${data.stopReason || 'unknown'})`,
          502,
          'PROVIDER_EMPTY_RESPONSE',
        );
      }
      const messageContent = this.cleanJsonMarkdown(rawMessageContent);
      if (messageContent !== rawMessageContent) {
        logger.info(`[BedrockLlmProvider] Cleaned JSON output (length: ${messageContent.length}):
${messageContent}`);
      }
      const usage = data.usage || {};
      const promptTokens = usage.inputTokens || 0;
      const completionTokens = usage.outputTokens || 0;
      const totalTokens = usage.totalTokens || promptTokens + completionTokens;
      return {
        content: messageContent,
        promptTokens,
        completionTokens,
        totalTokens,
        finishReason: data.stopReason || 'stop',
      };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof AppError) {
        throw err;
      }
      if (err.name === 'AbortError') {
        throw new AppError('LLM Provider request timed out', 504, 'PROVIDER_TIMEOUT');
      }
      logger.error('AWS Bedrock Provider Request Error:', err);
      throw new AppError('Failed to communicate with AWS Bedrock provider', 502, 'PROVIDER_ERROR');
    }
  }
  async streamCompletion(request, onChunk, signal) {
    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? 3e4;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      signal.addEventListener('abort', onAbort);
    }
    const { systemMessages, bedrockMessages } = this.formatBedrockMessages(request.messages);
    const endpoint = `${this.baseUrl}/model/${encodeURIComponent(request.model)}/converse-stream`;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          messages: bedrockMessages,
          ...(systemMessages.length > 0 ? { system: systemMessages } : {}),
          inferenceConfig: {
            temperature: request.temperature ?? 0.7,
            maxTokens: request.maxTokens || 4096,
          },
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        if (response.status === 429) {
          throw new AppError('AWS Bedrock rate limit exceeded during stream.', 429, 'PROVIDER_RATE_LIMIT');
        }
        if (response.status >= 500) {
          throw new AppError('AWS Bedrock service error during stream.', 502, 'PROVIDER_ERROR');
        }
        throw new AppError(`AWS Bedrock streaming failed with HTTP ${response.status}`, 400, 'PROVIDER_BAD_REQUEST');
      }
      if (!response.body) {
        throw new AppError('No stream body returned by AWS Bedrock', 502, 'PROVIDER_INVALID_RESPONSE');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let jsonStr = trimmed;
          if (trimmed.startsWith('data: ')) {
            jsonStr = trimmed.slice(6);
          }
          try {
            const json = JSON.parse(jsonStr);
            const textDelta = json.contentBlockDelta?.delta?.text || json.delta?.text || json.bytes || '';
            if (textDelta) {
              fullContent += textDelta;
              onChunk(textDelta);
            }
          } catch {
            const match = trimmed.match(/"text"\s*:\s*"([^"]+)"/);
            if (match && match[1]) {
              const textDelta = match[1];
              fullContent += textDelta;
              onChunk(textDelta);
            }
          }
        }
      }
      const promptText = request.messages
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')))
        .join(' ');
      const promptTokens = Math.max(1, Math.ceil(promptText.length / 4));
      const completionTokens = Math.max(1, Math.ceil(fullContent.length / 4));
      const totalTokens = promptTokens + completionTokens;
      return {
        content: fullContent,
        promptTokens,
        completionTokens,
        totalTokens,
        finishReason: 'stop',
      };
    } catch (err) {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      if (err instanceof AppError) {
        throw err;
      }
      if (err.name === 'AbortError') {
        throw new AppError('LLM Provider request timed out during stream', 504, 'PROVIDER_TIMEOUT');
      }
      logger.error('AWS Bedrock Provider Streaming Error:', err);
      throw new AppError('Failed during AWS Bedrock stream generation', 502, 'PROVIDER_ERROR');
    }
  }
};

// src/services/llm/geminiLlmProvider.ts
var GeminiLlmProvider = class {
  providerName = 'gemini';
  apiKey;
  defaultModel;
  fallbackModel;
  baseUrl;
  thinkingBudget;
  reasoningEffort;
  constructor(
    apiKey,
    defaultModel = 'gemini-3.5-flash',
    fallbackModelOrBaseUrl,
    baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai',
    thinkingBudget,
    reasoningEffort,
  ) {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
    if (
      fallbackModelOrBaseUrl &&
      (fallbackModelOrBaseUrl.startsWith('http://') || fallbackModelOrBaseUrl.startsWith('https://'))
    ) {
      this.baseUrl = fallbackModelOrBaseUrl.replace(/\/+$/, '');
      this.fallbackModel = void 0;
    } else {
      this.fallbackModel = fallbackModelOrBaseUrl;
      this.baseUrl = baseUrl.replace(/\/+$/, '');
    }
    this.thinkingBudget = thinkingBudget;
    this.reasoningEffort = reasoningEffort;
  }
  isFallbackEligible(err) {
    const status = err?.statusCode || err?.status;
    const msg = String(err?.message || '').toLowerCase();
    const code = String(err?.code || '').toLowerCase();
    if (status === 404 || code === 'provider_model_not_found') return true;
    if (
      status === 503 ||
      code === 'provider_unavailable' ||
      msg.includes('503') ||
      msg.includes('high demand') ||
      msg.includes('spikes in demand')
    ) {
      return true;
    }
    if (msg.includes('not found') || msg.includes('no longer available') || msg.includes('retired')) return true;
    return false;
  }
  async generateCompletion(request) {
    const isGeminiModel = request.model && (request.model.startsWith('gemini-') || request.model.startsWith('models/'));
    const primaryModel = isGeminiModel ? request.model : this.defaultModel;
    try {
      return await this.executeChatCompletion(primaryModel, request);
    } catch (err) {
      if (this.fallbackModel && this.fallbackModel !== primaryModel && this.isFallbackEligible(err)) {
        logger.warn(
          `[GeminiLlmProvider] Primary model '${primaryModel}' failed (${err?.message || 'model unavailable or high demand'}). Falling back to '${this.fallbackModel}'...`,
        );
        return await this.executeChatCompletion(this.fallbackModel, request);
      }
      throw err;
    }
  }
  async executeChatCompletion(effectiveModel, request) {
    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? 3e4;
    const startTime = Date.now();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const endpoint = `${this.baseUrl}/chat/completions`;
    const requestPayload = {
      model: effectiveModel,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
    };
    if (request.maxTokens !== void 0) {
      requestPayload.max_tokens = request.maxTokens;
    }
    if (request.tools && Array.isArray(request.tools) && request.tools.length > 0) {
      requestPayload.tools = request.tools;
    }
    if (request.tool_choice !== void 0) {
      requestPayload.tool_choice = request.tool_choice;
    }
    if (this.reasoningEffort) {
      requestPayload.reasoning_effort = this.reasoningEffort;
    }
    const maxRetries = 2;
    let attempt = 0;
    let lastError = null;
    try {
      while (attempt <= maxRetries) {
        const elapsed = Date.now() - startTime;
        if (elapsed >= timeoutMs - 1e3) {
          throw new AppError('LLM Provider request timed out', 504, 'PROVIDER_TIMEOUT');
        }
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(requestPayload),
            signal: controller.signal,
          });
          if (!response.ok) {
            let errorData = {};
            try {
              errorData = await response.json();
            } catch {}
            const realErrorMessage =
              errorData?.error?.message ||
              errorData?.message ||
              `Gemini provider returned HTTP status ${response.status}`;
            logger.error('[GeminiLlmProvider] HTTP error from Gemini API:', {
              status: response.status,
              model: effectiveModel,
              attempt: attempt + 1,
              error: realErrorMessage,
            });
            const isRetryable = response.status === 429 || response.status >= 500;
            if (isRetryable && attempt < maxRetries) {
              attempt++;
              const backoffMs = Math.min(1e3 * Math.pow(2, attempt - 1), 3e3);
              logger.warn(
                `[GeminiLlmProvider] Retryable status HTTP ${response.status}. Retrying in ${backoffMs}ms (attempt ${attempt}/${maxRetries})...`,
              );
              await new Promise(resolve => setTimeout(resolve, backoffMs));
              continue;
            }
            if (response.status === 429) {
              throw new AppError('Gemini rate limit exceeded. Please try again later.', 429, 'PROVIDER_RATE_LIMIT');
            }
            if (response.status === 401 || response.status === 403) {
              throw new AppError(
                'Gemini authentication failed. Please verify API key configuration.',
                403,
                'PROVIDER_AUTH_ERROR',
              );
            }
            if (response.status === 404) {
              throw new AppError(
                realErrorMessage || 'Gemini model not found or retired.',
                404,
                'PROVIDER_MODEL_NOT_FOUND',
              );
            }
            if (response.status === 503) {
              throw new AppError(
                realErrorMessage || 'Gemini service unavailable or experiencing high demand.',
                503,
                'PROVIDER_UNAVAILABLE',
              );
            }
            if (response.status >= 500) {
              throw new AppError('Gemini service error. Please try again later.', 502, 'PROVIDER_ERROR');
            }
            if (response.status === 400) {
              throw new AppError('Bad request sent to Gemini provider.', 400, 'PROVIDER_BAD_REQUEST');
            }
            throw new AppError('Failed to communicate with Gemini provider', 502, 'PROVIDER_ERROR');
          }
          let data;
          try {
            data = await response.json();
          } catch (parseErr) {
            logger.error('[GeminiLlmProvider] Failed to parse JSON response from Gemini:', parseErr);
            throw new AppError('Invalid response payload from Gemini', 502, 'PROVIDER_INVALID_RESPONSE');
          }
          const choice = data?.choices?.[0];
          if (!choice || typeof choice !== 'object') {
            logger.error('[GeminiLlmProvider] Malformed response: choices array is missing or empty.');
            throw new AppError('Invalid response payload from Gemini', 502, 'PROVIDER_INVALID_RESPONSE');
          }
          const message = choice.message || {};
          const content = typeof message.content === 'string' ? message.content : '';
          const toolCalls =
            Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? message.tool_calls : void 0;
          const finishReason = choice.finish_reason || (toolCalls ? 'tool_calls' : 'stop');
          if (!content.trim() && (!toolCalls || toolCalls.length === 0)) {
            logger.warn(
              `[GeminiLlmProvider] Empty content returned from Gemini with finishReason='${finishReason}'. Full choice:`,
              choice,
            );
            throw new AppError(
              `Gemini provider returned an empty completion (finishReason: ${finishReason}). The model may have exhausted max_tokens on internal reasoning or produced no output.`,
              502,
              'PROVIDER_EMPTY_RESPONSE',
            );
          }
          const usage = data.usage || {};
          const promptTokens = usage.prompt_tokens || 0;
          const completionTokens = usage.completion_tokens || 0;
          const totalTokens = usage.total_tokens || promptTokens + completionTokens;
          clearTimeout(timer);
          const servedBy = effectiveModel === this.defaultModel ? 'primary' : 'fallback';
          logger.info(`[GeminiLlmProvider] Completion served by ${servedBy} model: '${effectiveModel}'`);
          return {
            content,
            promptTokens,
            completionTokens,
            totalTokens,
            finishReason,
            model: effectiveModel,
            servedBy,
            ...(toolCalls ? { toolCalls } : {}),
          };
        } catch (fetchErr) {
          if (fetchErr instanceof AppError) {
            throw fetchErr;
          }
          if (fetchErr.name === 'AbortError') {
            throw new AppError('LLM Provider request timed out', 504, 'PROVIDER_TIMEOUT');
          }
          lastError = fetchErr;
          if (attempt < maxRetries) {
            attempt++;
            const backoffMs = Math.min(1e3 * Math.pow(2, attempt - 1), 3e3);
            logger.warn(
              `[GeminiLlmProvider] Network error communicating with Gemini. Retrying in ${backoffMs}ms (attempt ${attempt}/${maxRetries})...`,
            );
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue;
          }
          break;
        }
      }
      clearTimeout(timer);
      logger.error('[GeminiLlmProvider] Request failed after retries:', lastError);
      throw new AppError('Failed to communicate with Gemini provider', 502, 'PROVIDER_ERROR');
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof AppError) {
        throw err;
      }
      if (err.name === 'AbortError') {
        throw new AppError('LLM Provider request timed out', 504, 'PROVIDER_TIMEOUT');
      }
      logger.error('[GeminiLlmProvider] Request failed:', {
        name: err?.name,
        message: err?.message,
      });
      throw new AppError('Failed to communicate with Gemini provider', 502, 'PROVIDER_ERROR');
    }
  }
  async streamCompletion(request, onChunk, signal) {
    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? 3e4;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      signal.addEventListener('abort', onAbort);
    }
    const isGeminiModel = request.model && (request.model.startsWith('gemini-') || request.model.startsWith('models/'));
    const effectiveModel = isGeminiModel ? request.model : this.defaultModel;
    const endpoint = `${this.baseUrl}/chat/completions`;
    const requestPayload = {
      model: effectiveModel,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      stream: true,
    };
    if (request.maxTokens !== void 0) {
      requestPayload.max_tokens = request.maxTokens;
    }
    if (request.tools && Array.isArray(request.tools) && request.tools.length > 0) {
      requestPayload.tools = request.tools;
    }
    if (request.tool_choice !== void 0) {
      requestPayload.tool_choice = request.tool_choice;
    }
    if (this.reasoningEffort) {
      requestPayload.reasoning_effort = this.reasoningEffort;
    }
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        let errorData = {};
        try {
          errorData = await response.json();
        } catch {}
        const realErrorMessage =
          errorData?.error?.message || errorData?.message || `Gemini streaming failed with HTTP ${response.status}`;
        logger.error('[GeminiLlmProvider] Streaming HTTP error from Gemini API:', {
          status: response.status,
          model: effectiveModel,
          error: realErrorMessage,
        });
        if (response.status === 429) {
          throw new AppError('Gemini rate limit exceeded during stream.', 429, 'PROVIDER_RATE_LIMIT');
        }
        if (response.status === 401 || response.status === 403) {
          throw new AppError('Gemini authentication failed during stream.', 403, 'PROVIDER_AUTH_ERROR');
        }
        if (response.status >= 500) {
          throw new AppError('Gemini service error during stream.', 502, 'PROVIDER_ERROR');
        }
        if (response.status === 400) {
          throw new AppError('Bad request sent to Gemini streaming provider.', 400, 'PROVIDER_BAD_REQUEST');
        }
        throw new AppError(`Gemini streaming failed with HTTP ${response.status}`, 502, 'PROVIDER_ERROR');
      }
      if (!response.body) {
        throw new AppError('No stream body returned by Gemini', 502, 'PROVIDER_INVALID_RESPONSE');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') break;
          if (trimmed.startsWith('data: ')) {
            try {
              const json = JSON.parse(trimmed.slice(6));
              const deltaContent = json.choices?.[0]?.delta?.content;
              if (deltaContent) {
                fullContent += deltaContent;
                onChunk(deltaContent);
              }
            } catch {}
          }
        }
      }
      const promptText = request.messages
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')))
        .join(' ');
      const promptTokens = Math.max(1, Math.ceil(promptText.length / 4));
      const completionTokens = Math.max(1, Math.ceil(fullContent.length / 4));
      const totalTokens = promptTokens + completionTokens;
      return {
        content: fullContent,
        promptTokens,
        completionTokens,
        totalTokens,
        finishReason: 'stop',
      };
    } catch (err) {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      if (err instanceof AppError) {
        throw err;
      }
      if (err.name === 'AbortError') {
        throw new AppError('LLM Provider request timed out during stream', 504, 'PROVIDER_TIMEOUT');
      }
      logger.error('[GeminiLlmProvider] Streaming error:', {
        name: err?.name,
        message: err?.message,
      });
      throw new AppError('Failed during Gemini stream generation', 502, 'PROVIDER_ERROR');
    }
  }
};

// src/services/llm/llmProviderFactory.ts
var mockProviderInstance = null;
var overrideProvider = null;
var LlmProviderFactory = class {
  /**
   * Validates provider configuration at startup or prior to instantiation.
   * Throws an AppError if required API keys are missing in production or development.
   */
  static validateConfiguration() {
    if (env.NODE_ENV === 'test') {
      return;
    }
    const providerType = env.LLM_PROVIDER;
    if (providerType === 'gemini') {
      const key = env.GEMINI_API_KEY?.trim();
      if (!key) {
        throw new AppError(
          'GEMINI_API_KEY is missing or empty. When LLM_PROVIDER=gemini, GEMINI_API_KEY must be provided via environment or Secret Manager.',
          500,
          'CONFIGURATION_ERROR',
        );
      }
    } else if (providerType === 'bedrock') {
      const key = env.AWS_BEDROCK_API_KEY?.trim();
      if (!key) {
        throw new AppError(
          'AWS_BEDROCK_API_KEY is missing or empty. When LLM_PROVIDER=bedrock, AWS_BEDROCK_API_KEY must be provided via environment or Secret Manager.',
          500,
          'CONFIGURATION_ERROR',
        );
      }
    }
  }
  static getProvider() {
    if (overrideProvider) {
      return overrideProvider;
    }
    if (env.NODE_ENV === 'test') {
      if (!mockProviderInstance) {
        mockProviderInstance = new MockLlmProvider();
      }
      return mockProviderInstance;
    }
    this.validateConfiguration();
    const providerType = env.LLM_PROVIDER;
    if (providerType === 'bedrock') {
      return new BedrockLlmProvider(env.AWS_BEDROCK_API_KEY, env.AWS_BEDROCK_REGION);
    }
    return new GeminiLlmProvider(
      env.GEMINI_API_KEY,
      env.GEMINI_MODEL,
      env.GEMINI_FALLBACK_MODEL,
      void 0,
      env.GEMINI_THINKING_BUDGET,
      env.GEMINI_REASONING_EFFORT,
    );
  }
  static setMockOptions(options) {
    if (!mockProviderInstance) {
      mockProviderInstance = new MockLlmProvider(options);
    } else {
      mockProviderInstance.setOptions(options);
    }
    overrideProvider = mockProviderInstance;
    return mockProviderInstance;
  }
  static setOverrideProvider(provider) {
    overrideProvider = provider;
  }
  static reset() {
    mockProviderInstance = null;
    overrideProvider = null;
  }
};

// src/services/llm.service.ts
async function recordUsage(userId, input) {
  const now = Date.now();
  await LlmUsageRepository.create(userId, {
    ...input,
    usageId: newId('llm'),
    uid: userId,
    createdAt: now,
    updatedAt: now,
  });
}
var LlmService = class {
  /**
   * Helper to calculate credits based on model multiplier and total tokens.
   *
   * Pricing Assumptions:
   * - Pro / Reasoning models (claude-3-5-sonnet, nova-pro, gemini-pro-latest):
   *   2 credits per 1,000 tokens (minimum 2 credits).
   * - Standard / Flash models (gemini-3.5-flash, gemini-3.8-flash, nova-lite, nova-micro, claude-3-haiku):
   *   1 credit per 1,000 tokens (minimum 1 credit).
   *
   * Token usage is derived directly from the LLM provider's response usage payload (totalTokens).
   * Failed or timed out requests incur 0 credits (refunded / not deducted).
   */
  static calculateRequiredCredits(model, totalTokens) {
    const isPremium =
      model.includes('claude-3-5-sonnet') ||
      model.includes('nova-pro') ||
      model.includes('gemini-pro') ||
      model.includes('pro');
    const ratePerThousand = isPremium ? 2 : 1;
    const minimumCredits = ratePerThousand;
    return Math.max(minimumCredits, Math.ceil((totalTokens / 1e3) * ratePerThousand));
  }
  /**
   * Process a non-streaming LLM chat completion request.
   */
  static async processChatCompletion(params) {
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
    if (idempotencyKey) {
      const existingLog = await LlmUsageRepository.findByIdempotencyKey(userId, idempotencyKey);
      if (existingLog) {
        logger.info(`Idempotent retry detected for LLM key '${idempotencyKey}'`);
        return {
          requestId: existingLog.requestId,
          model: existingLog.model,
          provider: existingLog.provider,
          content: existingLog.metadata?.content || '[Cached Response]',
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
    const requestId = `llm_req_${crypto4.randomUUID()}`;
    const startTime = Date.now();
    try {
      const completion = await provider.generateCompletion({
        model,
        messages,
        temperature,
        maxTokens,
        tools,
        tool_choice,
      });
      const latencyMs = Date.now() - startTime;
      const creditsToDeduct = this.calculateRequiredCredits(model, completion.totalTokens);
      const deductionIdempotencyKey = idempotencyKey ? `llm_deduct_${idempotencyKey}` : void 0;
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
          servedModel: completion.model || model,
          servedBy: completion.servedBy || 'primary',
          ...(completion.toolCalls ? { toolCalls: completion.toolCalls } : {}),
          ...(premiumCovered ? { coveredBy: 'jobform-premium', creditsEquivalent: creditsToDeduct } : {}),
        },
      });
      logger.info('[LLM Gateway] Completion served', {
        requestId,
        userId,
        provider: provider.providerName,
        model: completion.model || model,
        servedBy: completion.servedBy || 'primary',
        totalTokens: completion.totalTokens,
        latencyMs,
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
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = error.message || 'LLM Provider processing failed';
      const status = error.code === 'PROVIDER_TIMEOUT' || error.status === 504 ? 'TIMEOUT' : 'FAILED';
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
  static async processStreamCompletion(params) {
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
    const requestId = `llm_req_${crypto4.randomUUID()}`;
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
      const status = isAborted ? 'PARTIAL' : 'SUCCESS';
      const creditsToDeduct = this.calculateRequiredCredits(model, completion.totalTokens);
      if (creditsToDeduct > 0 && !premiumCovered) {
        const deductionIdempotencyKey = idempotencyKey ? `llm_deduct_${idempotencyKey}` : void 0;
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
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = error.message || 'LLM Streaming failed';
      const status = error.code === 'PROVIDER_TIMEOUT' || error.status === 504 ? 'TIMEOUT' : 'FAILED';
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
  static async getUsageHistory(userId, page = 1, limit = 20) {
    const { items, total } = await LlmUsageRepository.list(userId, page, limit);
    return {
      items: items.map(toLlmUsageDto),
      total,
      page,
      limit,
    };
  }
};

// src/services/premiumAiAllowance.service.ts
import { randomUUID as randomUUID2 } from 'crypto';
var premiumMonthlyAiTaskLimit = () => {
  const configured = Number(env.PREMIUM_MONTHLY_AI_TASK_LIMIT);
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : 1e3;
};
var PREMIUM_COVERED_MODELS = ['amazon.nova-lite-v1:0', 'amazon.nova-micro-v1:0'];
var AUTO_APPLY_RUN = /^(easy_apply|auto_loop)_/;
var MAX_RUN_ID_LENGTH = 200;
var ENTITLED_SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE'];
var utcMonth = now => new Date(now).toISOString().slice(0, 7);
function nextUtcMonthStart(now) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}
function premiumTaskFor(runId) {
  const id = typeof runId === 'string' ? runId.trim() : '';
  if (id && id.length <= MAX_RUN_ID_LENGTH) {
    if (AUTO_APPLY_RUN.test(id)) return { counted: false };
    return { counted: true, key: `run_${hashKey(id)}` };
  }
  return { counted: true, key: `req_${randomUUID2().replace(/-/g, '')}` };
}
var PremiumAiAllowanceService = class {
  static async getUsed(uid, now = Date.now()) {
    const value = (await dbRef(paths.premiumAiTaskCount(uid, utcMonth(now))).get()).val();
    return Math.max(0, Number(value) || 0);
  }
  static async getView(uid, now = Date.now()) {
    const [premium, used] = await Promise.all([JobformPremiumService.getStatus(uid), this.getUsed(uid, now)]);
    const limit = premiumMonthlyAiTaskLimit();
    return {
      tier: premium.tier,
      included: premium.isPremium,
      month: utcMonth(now),
      limit,
      used,
      remaining: Math.max(0, limit - used),
      resetsAt: nextUtcMonthStart(now),
      coveredModels: PREMIUM_COVERED_MODELS,
    };
  }
  /**
   * Counts `charge` against this month's allowance. A task already counted this month is free;
   * a new one is refused once the month's tasks are used up.
   */
  static async chargeTask(uid, charge, now = Date.now()) {
    if (!charge.counted) return true;
    const month = utcMonth(now);
    const taskRef = dbRef(paths.premiumAiTask(uid, month, charge.key));
    const claim = await taskRef.transaction(current => (current === null ? now : void 0));
    if (!claim.committed) return true;
    const limit = premiumMonthlyAiTaskLimit();
    const count = await dbRef(paths.premiumAiTaskCount(uid, month)).transaction(current => {
      const used = Math.max(0, Number(current) || 0);
      return used >= limit ? void 0 : used + 1;
    });
    if (count.committed) return true;
    await taskRef.remove();
    return false;
  }
  /**
   * Whether this gateway request is covered by the account's Premium / Diamond plan (no credits
   * drawn). Throws PREMIUM_AI_TASK_LIMIT_REACHED when the month's tasks are used up and the account
   * has no credit plan to fall back to.
   */
  static async coverRequest(params) {
    const { uid, premiumCovered, subscriptionStatus, model, runId, now = Date.now() } = params;
    if (!premiumCovered) return false;
    if (!PREMIUM_COVERED_MODELS.includes(model)) return false;
    if (await this.chargeTask(uid, premiumTaskFor(runId), now)) return true;
    if (subscriptionStatus && ENTITLED_SUBSCRIPTION_STATUSES.includes(subscriptionStatus)) return false;
    const resets = new Date(nextUtcMonthStart(now)).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
    throw new AppError(
      `Your JobForm Automator plan includes ${premiumMonthlyAiTaskLimit().toLocaleString('en-US')} AI tasks a month and this month's are used up. They renew on ${resets}.`,
      402,
      'PREMIUM_AI_TASK_LIMIT_REACHED',
    );
  }
};

// src/controllers/llm.controller.ts
var LlmController = class {
  /**
   * POST /api/v1/llm/chat
   * Proxies LLM chat completion requests with credit enforcement and usage metering.
   */
  static async chatCompletion(req, res, next) {
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
      const tools = body.tools;
      const tool_choice = body.tool_choice;
      const stream = Boolean(body.stream);
      const idempotencyKey = req.headers['x-idempotency-key'] || body.idempotencyKey;
      const runId = req.headers['x-run-id'] || body.runId;
      const premiumCovered = await PremiumAiAllowanceService.coverRequest({
        uid: String(userId),
        premiumCovered: req.premiumCovered === true,
        subscriptionStatus: req.subscription?.status,
        model,
        runId,
      });
      if (stream) {
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
          const result2 = await LlmService.processStreamCompletion({
            userId,
            model,
            messages,
            temperature,
            maxTokens,
            idempotencyKey,
            runId,
            premiumCovered,
            onChunk: chunk => {
              if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ chunk })}

`);
              }
            },
            signal: abortController.signal,
          });
          if (!res.writableEnded) {
            res.write(
              `data: ${JSON.stringify({ meta: { requestId: result2.requestId, creditsDeducted: result2.creditsDeducted, usage: result2.usage } })}

`,
            );
            res.write('data: [DONE]\n\n');
            res.end();
          }
        } catch (streamErr) {
          if (!res.headersSent) {
            next(streamErr);
          } else if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: streamErr.message || 'Stream error' })}

`);
            res.end();
          }
        }
        return;
      }
      const result = await LlmService.processChatCompletion({
        userId,
        model,
        messages,
        temperature,
        maxTokens,
        tools,
        tool_choice,
        idempotencyKey,
        runId,
        premiumCovered,
      });
      if (req.path.endsWith('/completions')) {
        const assistantMessage = {
          role: 'assistant',
          content: result.content,
        };
        if (result.toolCalls && result.toolCalls.length > 0) {
          assistantMessage.tool_calls = result.toolCalls;
        }
        res.status(200).json({
          id: result.requestId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1e3),
          model: result.model,
          choices: [
            {
              index: 0,
              message: assistantMessage,
              finish_reason:
                result.finishReason || (result.toolCalls && result.toolCalls.length > 0 ? 'tool_calls' : 'stop'),
            },
          ],
          usage: {
            prompt_tokens: result.usage.promptTokens,
            completion_tokens: result.usage.completionTokens,
            total_tokens: result.usage.totalTokens,
          },
        });
        return;
      }
      sendSuccess(res, result, 'LLM chat completion successful', 200);
    } catch (error) {
      next(error);
    }
  }
  /**
   * GET /api/v1/llm/premium-allowance
   * The built-in Cloud API allowance of the authenticated user's JobForm Automator plan this month.
   */
  static async getPremiumAllowance(req, res, next) {
    try {
      const userId = req.user?._id;
      if (!userId) {
        sendError(res, 'Authentication required', 401, 'UNAUTHORIZED');
        return;
      }
      sendSuccess(res, await PremiumAiAllowanceService.getView(String(userId)), 'Premium AI allowance', 200);
    } catch (error) {
      next(error);
    }
  }
  /**
   * GET /api/v1/llm/usage
   * Returns paginated LLM usage history for the authenticated user.
   */
  static async getUsageHistory(req, res, next) {
    try {
      const userId = req.user?._id;
      if (!userId) {
        sendError(res, 'Authentication required', 401, 'UNAUTHORIZED');
        return;
      }
      const page = parseInt(req.query.page, 10) || 1;
      const limit = parseInt(req.query.limit, 10) || 20;
      const history = await LlmService.getUsageHistory(userId, page, limit);
      sendSuccess(res, history, 'Usage history retrieved successfully', 200);
    } catch (error) {
      next(error);
    }
  }
};

// src/routes/llm.routes.ts
var llmRouter = Router6();
var chatHandlers = [
  authenticate,
  checkEntitlement,
  globalLlmRateLimiter,
  llmRateLimiter,
  validate(llmChatCompletionSchema),
  LlmController.chatCompletion,
];
llmRouter.post('/chat', ...chatHandlers);
llmRouter.post('/chat/completions', ...chatHandlers);
llmRouter.get('/usage', authenticate, LlmController.getUsageHistory);
llmRouter.get('/premium-allowance', authenticate, LlmController.getPremiumAllowance);

// src/routes/resume.routes.ts
import { Router as Router7 } from 'express';

// src/middleware/upload.middleware.ts
import multer from 'multer';
var storage = multer.memoryStorage();
var allowedMimeTypes = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream',
  // Some browsers send binary stream for docs
];
var allowedExtensions = ['.pdf', '.doc', '.docx'];
var uploadResume = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
    // 10MB limit
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const ext = '.' + (file.originalname.split('.').pop() || '').toLowerCase();
    const isAllowedExt = allowedExtensions.includes(ext);
    const isAllowedMime = allowedMimeTypes.includes(file.mimetype);
    if (isAllowedExt || isAllowedMime) {
      cb(null, true);
    } else {
      cb(
        new AppError(
          'Invalid file format. Only PDF (.pdf) and Word documents (.doc, .docx) are supported.',
          400,
          'INVALID_FILE_FORMAT',
        ),
      );
    }
  },
});

// src/schemas/resume.schema.ts
import { z as z6 } from 'zod';
var generateResumeSchema = z6.object({
  body: z6.object({
    candidateName: z6.string().min(1, 'Candidate name is required'),
    candidateEmail: z6.string().email('Valid email is required'),
    candidatePhone: z6.string().optional(),
    currentTitle: z6.string().optional(),
    skills: z6.array(z6.string()).default([]),
    targetKeywords: z6.array(z6.string()).default([]),
    jobTitle: z6.string().min(1, 'Job title is required'),
    company: z6.string().min(1, 'Company name is required'),
    backgroundNarrative: z6.string().optional(),
  }),
});
var workExperienceItemSchema = z6.object({
  id: z6.string().default(() => Math.random().toString(36).substring(2, 9)),
  company: z6.string().default(''),
  title: z6.string().default(''),
  startMonth: z6.string().default(''),
  startYear: z6.string().default(''),
  endMonth: z6.string().nullable().default(null),
  endYear: z6.string().nullable().default(null),
  isCurrent: z6.boolean().default(false),
  description: z6.string().default(''),
  source: z6.enum(['manual', 'resume']).default('resume'),
});
var parsedResumeSchema = z6.object({
  fullName: z6.string().default('Candidate'),
  email: z6.string().default(''),
  phoneNumber: z6.string().default(''),
  currentTitle: z6.string().default('Software Professional'),
  skills: z6.array(z6.string()).default([]),
  yearsOfExperience: z6.number().default(0),
  hasWorkExperience: z6.boolean().default(true),
  workExperience: z6.array(workExperienceItemSchema).default([]),
  education: z6.string().default(''),
  college: z6.string().default(''),
  cgpa: z6.string().default(''),
  noticePeriod: z6.string().default(''),
  workHistory: z6
    .array(
      z6.object({
        role: z6.string().default(''),
        company: z6.string().default(''),
        duration: z6.string().default(''),
        highlights: z6.array(z6.string()).default([]),
      }),
    )
    .default([]),
  backgroundNarrative: z6.string().default(''),
  currentLocation: z6.string().default(''),
  preferredLocation: z6.string().default(''),
  preferredLocations: z6.array(z6.string()).default([]),
  workAuthorization: z6.string().default('Authorized to work without sponsorship'),
  skillExperience: z6.record(z6.string(), z6.number()).default({}),
  goldenAnswers: z6
    .array(
      z6.object({
        id: z6.string(),
        question: z6.string(),
        answer: z6.string(),
        category: z6.string().default('Eligibility / Legal'),
        isDefault: z6.boolean().default(true),
      }),
    )
    .default([]),
  salaryExpectation: z6.string().default(''),
  portfolioUrl: z6.string().default(''),
  githubUrl: z6.string().default(''),
  linkedinUrl: z6.string().default(''),
});

// src/services/resumeGenerator.service.ts
function buildPdfDocument(contentLines) {
  const sanitizedLines = contentLines.map(line => line.replace(/[^\x20-\x7E]/g, ' ').replace(/[()\\]/g, '\\$&'));
  let textStream = 'BT\n/F1 11 Tf\n14 TL\n50 750 Td\n';
  for (const line of sanitizedLines) {
    if (line.startsWith('### ')) {
      textStream += `/F2 16 Tf
(${line.substring(4)}) Tj
/F1 11 Tf
T*
`;
    } else if (line.startsWith('## ')) {
      textStream += `/F2 13 Tf
(${line.substring(3)}) Tj
/F1 11 Tf
T*
`;
    } else if (line.startsWith('- ')) {
      textStream += `  (${line}) Tj
T*
`;
    } else if (line.trim() === '') {
      textStream += 'T*\n';
    } else {
      textStream += `(${line}) Tj
T*
`;
    }
  }
  textStream += 'ET';
  const streamLength = Buffer.byteLength(textStream, 'utf8');
  const pdfObjects = [
    '%PDF-1.4\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>\nendobj\n',
    `4 0 obj
<< /Length ${streamLength} >>
stream
${textStream}
endstream
endobj
`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    '6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n',
  ];
  let currentOffset = 0;
  const xrefOffsets = [];
  for (let i = 0; i < pdfObjects.length; i++) {
    if (i > 0) {
      xrefOffsets.push(currentOffset);
    }
    currentOffset += Buffer.byteLength(pdfObjects[i], 'utf8');
  }
  const xrefStart = currentOffset;
  let xref = `xref
0 ${pdfObjects.length}
0000000000 65535 f 
`;
  for (const offset of xrefOffsets) {
    xref += `${offset.toString().padStart(10, '0')} 00000 n 
`;
  }
  const trailer = `trailer
<< /Size ${pdfObjects.length} /Root 1 0 R >>
startxref
${xrefStart}
%%EOF
`;
  const fullPdfString = pdfObjects.join('') + xref + trailer;
  return Buffer.from(fullPdfString, 'binary');
}
var ResumeGeneratorService = class {
  /**
   * Generates a targeted PDF resume aligning candidate profile with target job keywords.
   */
  static async generateTailoredResume(params) {
    const {
      candidateName,
      candidateEmail,
      candidatePhone,
      currentTitle,
      skills,
      targetKeywords,
      jobTitle,
      company,
      backgroundNarrative,
    } = params;
    const highlightedKeywords = skills.filter(skill =>
      targetKeywords.some(
        kw => kw.toLowerCase().includes(skill.toLowerCase()) || skill.toLowerCase().includes(kw.toLowerCase()),
      ),
    );
    const docLines = [
      `### ${candidateName || 'Candidate Name'}`,
      `${currentTitle ? currentTitle + ' | ' : ''}${candidateEmail || ''}${candidatePhone ? ' | ' + candidatePhone : ''}`,
      '',
      `## Professional Summary (Tailored for ${jobTitle} at ${company})`,
      backgroundNarrative ||
        `Experienced professional with strong expertise in ${skills.slice(0, 5).join(', ')}. Proven track record delivering high-impact solutions.`,
      '',
      '## Core Competencies & Key Skills',
      `- Key Skills: ${skills.join(', ')}`,
      `- Highlighted Alignments: ${highlightedKeywords.length > 0 ? highlightedKeywords.join(', ') : skills.slice(0, 4).join(', ')}`,
      '',
      '## Relevant Experience',
      `- Role: ${currentTitle || 'Professional'} (${jobTitle} Focus)`,
      `- Spearheaded technical and operational tasks aligned with modern industry standards.`,
      `- Successfully leveraged ${highlightedKeywords.slice(0, 3).join(' and ') || 'modern methodologies'} to drive efficiency.`,
      '',
      '## Target Role Alignment',
      `- Position: ${jobTitle}`,
      `- Target Company: ${company}`,
    ];
    const pdfBuffer = buildPdfDocument(docLines);
    const base64Pdf = pdfBuffer.toString('base64');
    const sanitizedName = (candidateName || 'Resume').replace(/\s+/g, '_');
    const sanitizedCompany = (company || 'Job').replace(/\s+/g, '_');
    const fileName = `${sanitizedName}_${sanitizedCompany}_Resume.pdf`;
    return {
      pdfBuffer,
      base64Pdf,
      fileName,
      fileSize: pdfBuffer.length,
      highlightedKeywords,
    };
  }
};

// src/utils/skillValidator.ts
var KNOWN_SHORT_SKILLS = /* @__PURE__ */ new Set(['c', 'r', 'go', 'c#', 'f#']);
var SKILL_STOPWORDS = /* @__PURE__ */ new Set([
  // Short acronyms & stopwords
  'ai',
  'ml',
  'ui',
  'ux',
  'qa',
  'it',
  'db',
  'os',
  'and',
  'the',
  'or',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'an',
  'as',
  'is',
  'are',
  'was',
  'were',
  'it',
  'this',
  'that',
  'be',
  'all',
  'any',
  'can',
  'had',
  'has',
  'have',
  'not',
  'but',
  'etc',
  'etc.',
  // Generic job / resume vocabulary with no specific tech stack meaning
  'developer',
  'engineer',
  'engineering',
  'development',
  'programming',
  'programmer',
  'software',
  'hardware',
  'tech',
  'technology',
  'technologies',
  'skill',
  'skills',
  'experience',
  'years',
  'year',
  'month',
  'months',
  'project',
  'projects',
  'team',
  'work',
  'working',
  'role',
  'roles',
  'job',
  'jobs',
  'company',
  'client',
  'customer',
  'management',
  'lead',
  'leader',
  'leadership',
  'communication',
  'problem solving',
  'analytical',
  'general',
  'various',
  'other',
  'others',
  'tool',
  'tools',
  'framework',
  'frameworks',
  'methodology',
  'methodologies',
  'code',
  'coding',
  'testing',
  'tester',
  'design',
  'designing',
  'designer',
  'system',
  'systems',
  'application',
  'applications',
  'solution',
  'solutions',
  'architecture',
  'architect',
  'support',
  'maintenance',
  'database',
  'databases',
  'web',
  'frontend',
  'backend',
  'fullstack',
  'full stack',
]);
function cleanSkillName(skill) {
  if (!skill || typeof skill !== 'string') return '';
  return skill
    .trim()
    .replace(/^[.,;:!?'"()[\]{}<>/\\|`~*#&^%$@+=]+|[.,;:!?'"()[\]{}<>/\\|`~*#&^%$@+=]+$/g, '')
    .trim();
}
function isValidSkillName(skill) {
  if (!skill || typeof skill !== 'string') return false;
  const cleaned = cleanSkillName(skill);
  if (!cleaned) return false;
  if (cleaned.length > 35) return false;
  if (cleaned.split(/\s+/).length > 4) return false;
  if (!/[a-zA-Z]/.test(cleaned)) return false;
  if (/https?:\/\/|www\.|\.com|\.org|\.net|@/i.test(cleaned)) return false;
  const lower = cleaned.toLowerCase();
  if (SKILL_STOPWORDS.has(lower)) return false;
  if (cleaned.length < 3) {
    return KNOWN_SHORT_SKILLS.has(lower);
  }
  return true;
}
function validateAndSanitizeSkillExperience(rawSkillExp, workExp, rawText, overallYoe) {
  if (!rawSkillExp || typeof rawSkillExp !== 'object') return {};
  const cleanExp = {};
  const currentYear = /* @__PURE__ */ new Date().getFullYear();
  let maxVerifiableTenure = 0;
  const validWorkExp = Array.isArray(workExp) ? workExp : [];
  for (const role of validWorkExp) {
    if (!role) continue;
    const startYr = parseInt(String(role.startYear || ''), 10);
    if (!isNaN(startYr) && startYr >= 1970 && startYr <= currentYear + 1) {
      const endYr = role.isCurrent || !role.endYear ? currentYear : parseInt(String(role.endYear), 10);
      const tenure = Math.max(0, (!isNaN(endYr) ? endYr : currentYear) - startYr);
      if (tenure > maxVerifiableTenure) {
        maxVerifiableTenure = tenure;
      }
    }
  }
  if (overallYoe !== void 0 && overallYoe !== null) {
    const numYoe = parseInt(String(overallYoe), 10);
    if (!isNaN(numYoe) && numYoe >= 0) {
      if (validWorkExp.length === 0) {
        maxVerifiableTenure = numYoe;
      } else {
        maxVerifiableTenure = Math.max(maxVerifiableTenure, numYoe);
      }
    }
  }
  const entries = Object.entries(rawSkillExp);
  const valueCounts = /* @__PURE__ */ new Map();
  for (const [_, val] of entries) {
    if (typeof val === 'number' && !isNaN(val) && val > 0) {
      valueCounts.set(val, (valueCounts.get(val) || 0) + 1);
    }
  }
  const suspectedFabricatedValues = /* @__PURE__ */ new Set();
  for (const [val, count] of valueCounts.entries()) {
    if (count >= 4 && val > Math.max(1, maxVerifiableTenure)) {
      suspectedFabricatedValues.add(val);
    }
  }
  for (const [skill, claimedYears] of entries) {
    if (!skill || typeof claimedYears !== 'number' || isNaN(claimedYears) || claimedYears <= 0) {
      continue;
    }
    const clean = cleanSkillName(skill);
    if (!isValidSkillName(clean)) continue;
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const explicitRegex = new RegExp(
      `(?:\\b${escaped}\\b[^\\n\\r,]{0,35}?\\(?(\\d+(?:\\.\\d+)?)\\s*(?:\\+)?\\s*(?:years?|yrs?)\\)?)|(?:(?:for|with)?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:\\+)?\\s*(?:years?|yrs?)[^\\n\\r,]{0,35}?\\b${escaped}\\b)`,
      'i',
    );
    const textMatch = rawText ? rawText.match(explicitRegex) : null;
    if (textMatch) {
      const explicitNum = parseFloat(textMatch[1] || textMatch[2]);
      if (!isNaN(explicitNum) && explicitNum > 0) {
        cleanExp[clean] = Math.round(explicitNum);
        continue;
      }
    }
    const isFabricatedValue = suspectedFabricatedValues.has(claimedYears);
    let skillRoleTenure = null;
    const lowerSkill = clean.toLowerCase();
    for (const role of validWorkExp) {
      const roleText = `${role.title || ''} ${role.company || ''} ${role.description || ''}`.toLowerCase();
      if (roleText.includes(lowerSkill)) {
        const sYr = parseInt(String(role.startYear || ''), 10);
        if (!isNaN(sYr)) {
          const eYr = role.isCurrent || !role.endYear ? currentYear : parseInt(String(role.endYear), 10);
          const rTenure = Math.max(0, (!isNaN(eYr) ? eYr : currentYear) - sYr);
          skillRoleTenure = Math.max(skillRoleTenure ?? 0, rTenure);
        }
      }
    }
    const effectiveMaxTenure = Math.max(1, maxVerifiableTenure);
    if (skillRoleTenure !== null) {
      const verifiedYears = Math.min(claimedYears, Math.max(1, skillRoleTenure), effectiveMaxTenure);
      cleanExp[clean] = verifiedYears;
    } else {
      if (isFabricatedValue || claimedYears > effectiveMaxTenure) {
        continue;
      }
      if (claimedYears <= effectiveMaxTenure) {
        cleanExp[clean] = claimedYears;
      }
    }
  }
  return cleanExp;
}
function cleanLocationForCityField(rawLocation) {
  if (!rawLocation || typeof rawLocation !== 'string') return '';
  let loc = rawLocation.trim();
  loc = loc
    .replace(/(?:(?:\b(?:or|and)\b)|[/\\])\s*remote\b/gi, '')
    .replace(/\bremote\s*(?:(?:\b(?:or|and)\b)|[/\\])/gi, '')
    .replace(/\(remote\)/gi, '')
    .replace(/\[remote\]/gi, '')
    .replace(/(?:(?:\b(?:or|and)\b)|[/\\])\s*hybrid\b/gi, '')
    .replace(/\bhybrid\s*(?:(?:\b(?:or|and)\b)|[/\\])/gi, '')
    .replace(/\(hybrid\)/gi, '')
    .replace(/\[hybrid\]/gi, '')
    .replace(/\s*,\s*remote\b/gi, '')
    .replace(/\bremote\s*,\s*/gi, '')
    .replace(/\bremote\b/gi, '')
    .replace(/^[,\-\s/\\|]+|[,\-\s/\\|]+$/g, '')
    .trim();
  return loc;
}

// src/services/resumeParser.service.ts
var ResumeParserService = class {
  /**
   * Extracts raw text from in-memory file buffer (PDF, DOCX, DOC).
   */
  static async extractRawText(buffer, originalName, mimeType) {
    const ext = (originalName.split('.').pop() || '').toLowerCase();
    try {
      if (ext === 'pdf' || mimeType.includes('pdf')) {
        await import('pdf-parse/worker');
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        const textResult = await parser.getText();
        const text2 = textResult.text || '';
        await parser.destroy();
        return this.cleanExtractedText(text2);
      }
      if (ext === 'docx' || ext === 'doc' || mimeType.includes('word')) {
        try {
          const { default: mammoth } = await import('mammoth');
          const mammothResult = await mammoth.extractRawText({ buffer });
          if (mammothResult.value && mammothResult.value.trim()) {
            return this.cleanExtractedText(mammothResult.value);
          }
        } catch (docxErr) {
          logger.warn('[ResumeParserService] Mammoth extraction failed, falling back to raw buffer text:', docxErr);
        }
        const raw3 = buffer.toString('utf-8');
        return this.cleanExtractedText(raw3);
      }
      const raw2 = buffer.toString('utf-8');
      return this.cleanExtractedText(raw2);
    } catch (err) {
      logger.error(`[ResumeParserService] Failed to extract raw text from ${originalName}:`, err);
      throw new AppError(
        `Unable to extract text from ${originalName}. Please ensure the file is not password protected.`,
        422,
        'TEXT_EXTRACTION_FAILED',
      );
    }
  }
  /**
   * Cleans extracted raw text (strips null characters, control characters, excess whitespace).
   */
  static cleanExtractedText(text2) {
    return text2
      .replace(/\u0000/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .trim();
  }
  /**
   * Invokes AWS Bedrock (or configured LLM provider) with a strict zero-hallucination prompt
   * and parses structured candidate attributes matching ParsedResumeData.
   */
  static async extractStructuredData(rawText) {
    if (!rawText || rawText.length < 30) {
      logger.warn('[ResumeParserService] Raw resume text is too short for AI extraction.');
      return this.fallbackHeuristicExtract(rawText);
    }
    const truncatedText = rawText.length > 16e3 ? rawText.substring(0, 16e3) + '...[truncated]' : rawText;
    const systemPrompt = `You are an elite, zero-hallucination AI resume intelligence engine.
Your mission is to accurately parse the provided raw resume text into structured JSON format.

RULES:
1. ZERO HALLUCINATION & ZERO FABRICATION: Extract only factual information present in the resume. If a field is not found, leave it as an empty string, empty array, or 0. NEVER invent or default to arbitrary numbers.
2. EXPERIENCE CALCULATION:
   - Calculate total integer years of professional software/work experience (e.g. 0, 1, 3, 5) strictly based on verifiable employment history dates.
   - DO NOT count college or university degree duration (e.g. a 2020\u20132024 B.Tech is education, NOT 4 years of work experience).
   - If the candidate is a fresher or intern with under 1 year of work history, yearsOfExperience MUST be 0 (or 1 if at least 1 full year).
3. SKILLS & SKILL EXPERIENCE (skillExperience):
   - For every primary skill identified in "skills", include it in "skillExperience" with its estimated or verified years of experience.
   - If the resume explicitly states a duration for that skill (e.g. "React (3 years)", "4+ yrs Python experience"), use that duration.
   - If the skill was used in a dated work experience role, compute the years from that role's date range.
   - For other skills listed on the resume without explicit duration, set years to candidate's verifiable yearsOfExperience (minimum 1 year, e.g. fresher/intern = 1 year of project/academic experience).
   - NEVER assign random inflated numbers (e.g. NEVER assign 5+ years for a 1-year junior). Cap all skills at verifiable yearsOfExperience (minimum 1).
   - CONCRETE TECHNICAL TOOLS ONLY: Extract specific technologies, frameworks, libraries, databases, and languages (e.g. TypeScript, React, Python, PostgreSQL, Docker, AWS).
   - REJECT GENERIC TERMS & STOPWORDS: Never extract generic buzzwords or grammatical words (e.g. "ai", "ml", "ui", "ux", "and", "the", "developer", "engineering", "programming", "software", "tech", "skills").
   - LENGTH RULE: Reject any skill name under 3 characters unless it is a standard short programming language ("Go", "R", "C#", "C").
4. SCREENING FIELDS:
   - workAuthorization: If mentioned (e.g. US Citizen, Green Card, Authorized to work, H1B, Indian Citizen), extract it. Otherwise empty string.
   - noticePeriod: If mentioned in summary, header, or availability (e.g. "Immediate", "30 days", "2 weeks"), extract it. Otherwise empty string.
   - college: Extract university or college name if mentioned.
   - education: Degree name and details (e.g. "B.Tech in Computer Science").
5. WORK EXPERIENCE (STRUCTURED):
   - Extract factual work history positions present in the resume.
   - For each role:
     {
       "company": "Company Name",
       "title": "Job Title",
       "startMonth": "Month or empty string",
       "startYear": "Year (e.g. 2023) or empty string",
       "endMonth": "Month or null if current",
       "endYear": "Year or null if current",
       "isCurrent": true/false (true if currently working here / present),
       "description": "Brief summary of responsibilities & accomplishments"
     }
    - hasWorkExperience: true if one or more legitimate work/internship positions are found, false if candidate is a fresher with no work experience.
6. WORK HISTORY: Extract all distinct past/present roles with company, title, duration, and key highlights.
7. CANDIDATE BACKGROUND NARRATIVE:
   - Synthesize a comprehensive, high-impact 2-3 paragraph professional narrative grounded strictly in the resume.
   - Paragraph 1: Professional identity, core specialization (e.g. Full Stack, Python, Frontend, MERN), total verifiable experience, and primary tech stack.
   - Paragraph 2: Key real-world projects or systems engineered, architectural decisions, databases, APIs, performance optimizations, and business impact.
   - Paragraph 3: Problem solving philosophy, engineering best practices (testing, CI/CD, clean code), and collaboration strengths.
8. GOLDEN SCREENING ANSWERS (goldenAnswers):
   - Generate calibrated baseline gatekeeper screening answers based on the candidate's factual location, legal eligibility, work authorization, visa sponsorship, and age from the resume:
     [
       {
         "id": "work_auth",
         "question": "Are you legally authorized to work in India / your resident country?",
         "answer": "Yes",
         "category": "Eligibility / Legal",
         "isDefault": true
       },
       {
         "id": "visa_sponsorship",
         "question": "Will you now or in the future require visa sponsorship?",
         "answer": "No",
         "category": "Eligibility / Legal",
         "isDefault": true
       },
       {
         "id": "age_requirement",
         "question": "Are you at least 18 years of age or older?",
         "answer": "Yes",
         "category": "Eligibility / Legal",
         "isDefault": true
       }
     ]
9. CLEAN OUTPUT: Output ONLY a valid JSON object matching the requested schema. Do NOT include markdown code blocks, backticks, XML tags, or conversational preamble.`;
    const userPrompt = `Parse the following raw resume into a valid JSON object matching this schema:
{
  "fullName": "Candidate Name",
  "email": "candidate@example.com",
  "phoneNumber": "+1234567890",
  "currentTitle": "Software Engineer",
  "skills": ["TypeScript", "React", "Node.js", "MongoDB", "AWS"],
  "yearsOfExperience": 3,
  "hasWorkExperience": true,
  "workExperience": [
    {
      "company": "ABC Corp",
      "title": "Frontend Developer",
      "startMonth": "Jan",
      "startYear": "2023",
      "endMonth": null,
      "endYear": null,
      "isCurrent": true,
      "description": "Built responsive dashboards with React and Redux."
    }
  ],
  "education": "B.Tech in Computer Science, XYZ University, 2023",
  "college": "XYZ University",
  "noticePeriod": "Immediate",
  "workAuthorization": "Authorized to work without sponsorship",
  "skillExperience": {
    "React": 3,
    "Node.js": 2
  },
  "workHistory": [
    {
      "role": "Frontend Developer",
      "company": "ABC Corp",
      "duration": "2023 - Present",
      "highlights": ["Built dashboard", "Improved performance"]
    }
  ],
  "backgroundNarrative": "A rich, comprehensive 2-3 paragraph professional narrative describing technical background, key projects built, technologies mastered, architecture & problem solving approach, and work style, grounded strictly in the resume.",
  "goldenAnswers": [
    {
      "id": "work_auth",
      "question": "Are you legally authorized to work in India / your resident country?",
      "answer": "Yes",
      "category": "Eligibility / Legal",
      "isDefault": true
    },
    {
      "id": "visa_sponsorship",
      "question": "Will you now or in the future require visa sponsorship?",
      "answer": "No",
      "category": "Eligibility / Legal",
      "isDefault": true
    },
    {
      "id": "age_requirement",
      "question": "Are you at least 18 years of age or older?",
      "answer": "Yes",
      "category": "Eligibility / Legal",
      "isDefault": true
    }
  ],
  "currentLocation": "City, State, Country (e.g. Bengaluru, Karnataka, India or San Francisco, California, United States. Standard LinkedIn/Indeed/Naukri format)",
  "preferredLocation": "City, State, Country (e.g. Bengaluru, Karnataka, India. Do NOT append 'or Remote')",
  "salaryExpectation": "",
  "portfolioUrl": "",
  "githubUrl": "",
  "linkedinUrl": ""
}

=== RAW RESUME TEXT ===
${truncatedText}`;
    try {
      const llm = LlmProviderFactory.getProvider();
      const model = env.LLM_DEFAULT_MODEL || 'anthropic.claude-3-5-sonnet-20240620-v1:0';
      const response = await llm.generateCompletion({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        maxTokens: 3e3,
      });
      let cleaned = (response.content || '').trim();
      cleaned = cleaned.replace(/<(?:think|thought)>[\s\S]*?<\/(?:think|thought)>/gi, '').trim();
      cleaned = cleaned
        .replace(/```(?:json)?/gi, '')
        .replace(/```/g, '')
        .trim();
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
      }
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed.workExperience)) {
        parsed.workExperience = parsed.workExperience
          .filter(item => item && (item.company || item.title))
          .map(item => ({
            id: item.id || `we_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            company: String(item.company || '').trim(),
            title: String(item.title || '').trim(),
            startMonth: String(item.startMonth || '').trim(),
            startYear: String(item.startYear || '').trim(),
            endMonth: item.isCurrent ? null : item.endMonth ? String(item.endMonth).trim() : null,
            endYear: item.isCurrent ? null : item.endYear ? String(item.endYear).trim() : null,
            isCurrent: Boolean(item.isCurrent),
            description: String(item.description || '').trim(),
            source: 'resume',
          }));
        if (parsed.workExperience.length > 0) {
          parsed.hasWorkExperience = true;
        }
      }
      if (Array.isArray(parsed.skills)) {
        parsed.skills = parsed.skills.map(cleanSkillName).filter(isValidSkillName);
      }
      if (parsed.skillExperience && typeof parsed.skillExperience === 'object') {
        parsed.skillExperience = validateAndSanitizeSkillExperience(
          parsed.skillExperience,
          parsed.workExperience,
          rawText,
          parsed.yearsOfExperience,
        );
      } else {
        parsed.skillExperience = {};
      }
      const candidateTenure = Math.max(1, Math.min(parsed.yearsOfExperience || 1, 99));
      if (Array.isArray(parsed.skills)) {
        for (const skill of parsed.skills) {
          const clean = cleanSkillName(skill);
          if (isValidSkillName(clean) && (!parsed.skillExperience[clean] || parsed.skillExperience[clean] <= 0)) {
            parsed.skillExperience[clean] = candidateTenure;
          }
        }
      }
      if (parsed.currentLocation) {
        parsed.currentLocation = cleanLocationForCityField(parsed.currentLocation) || parsed.currentLocation;
      }
      if (parsed.preferredLocation) {
        parsed.preferredLocation = cleanLocationForCityField(parsed.preferredLocation) || parsed.preferredLocation;
      }
      if (Array.isArray(parsed.goldenAnswers)) {
        parsed.goldenAnswers = parsed.goldenAnswers
          .filter(item => item && item.question && item.answer)
          .map(item => ({
            id: String(item.id || `ga_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`),
            question: String(item.question).trim(),
            answer: String(item.answer).trim(),
            category: item.category || 'Eligibility / Legal',
            isDefault: Boolean(item.isDefault ?? true),
          }));
      }
      if (parsed.currentTitle) {
        const cleanTitle = String(parsed.currentTitle).trim();
        const cleanFull = String(parsed.fullName || '')
          .trim()
          .toLowerCase();
        const titleLo = cleanTitle.toLowerCase();
        const isName =
          cleanFull && (titleLo === cleanFull || titleLo.includes(cleanFull) || cleanFull.includes(titleLo));
        const isGeneric =
          /^(candidate|user|applicant|n\/a|developer|engineer|title|job title|software professional)$/i.test(titleLo);
        if (isName || isGeneric) {
          logger.warn(
            `[ResumeParserService] currentTitle "${cleanTitle}" matched candidate name or generic placeholder. Sanitized to "Full Stack Developer".`,
          );
          parsed.currentTitle = 'Full Stack Developer';
        }
      }
      const validated = parsedResumeSchema.safeParse(parsed);
      if (validated.success) {
        logger.info(
          `[ResumeParserService] Successfully parsed resume for "${validated.data.fullName}" with ${validated.data.skills.length} skills.`,
        );
        return validated.data;
      }
      logger.warn(
        '[ResumeParserService] Schema validation warning, returning safe defaults with raw object:',
        validated.error.format(),
      );
      return parsedResumeSchema.parse(parsed);
    } catch (error) {
      logger.warn(
        '[ResumeParserService] LLM JSON parsing failed or Bedrock unavailable, falling back to heuristic parsing:',
        error,
      );
      return this.fallbackHeuristicExtract(rawText);
    }
  }
  /**
   * Fast regex and heuristic extraction fallback if LLM inference is unreachable or returns malformed text.
   */
  static fallbackHeuristicExtract(rawText) {
    const lines = rawText
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    let fullName = 'Candidate';
    for (const line of lines.slice(0, 5)) {
      if (line.length > 2 && line.length < 50 && !line.includes('@') && !line.includes('http')) {
        fullName = line;
        break;
      }
    }
    const emailMatch = rawText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const email = emailMatch ? emailMatch[0] : '';
    const phoneMatch = rawText.match(/(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/);
    const phoneNumber = phoneMatch ? phoneMatch[0] : '';
    const linkedinMatch = rawText.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+/i);
    const githubMatch = rawText.match(/https?:\/\/(?:www\.)?github\.com\/[a-zA-Z0-9_-]+/i);
    const portfolioMatch = rawText.match(
      /https?:\/\/(?!www\.linkedin|www\.github)[a-zA-Z0-9_.-]+\.[a-zA-Z]{2,}[^\s]*/i,
    );
    const commonSkills = [
      'JavaScript',
      'TypeScript',
      'React',
      'Node.js',
      'Python',
      'Java',
      'C++',
      'Go',
      'HTML',
      'CSS',
      'SQL',
      'MongoDB',
      'PostgreSQL',
      'AWS',
      'Docker',
      'Kubernetes',
      'Git',
      'REST API',
      'GraphQL',
      'Express',
      'Next.js',
      'Redux',
      'Tailwind CSS',
    ];
    const detectedSkills = [];
    const lowerText = rawText.toLowerCase();
    for (const skill of commonSkills) {
      if (lowerText.includes(skill.toLowerCase())) {
        detectedSkills.push(skill);
      }
    }
    const collegeMatch = rawText.match(
      /(?:(?:bachelor|master|b\.?tech|m\.?tech|bca|mca|b\.?s|m\.?s|degree)\s+(?:in|of)\s+[^\n,]+,\s*|at\s+|from\s+)?([A-Za-z\s]+(?:University|College|Institute|Academy|Polytechnic)[A-Za-z\s,]*)/i,
    );
    const college = collegeMatch ? collegeMatch[1].trim().slice(0, 80) : '';
    let noticePeriod = '';
    const noticeMatch = rawText.match(
      /(?:notice\s*period|immediate\s*joiner|serving\s*notice|availability)\s*[:\-]?\s*([a-zA-Z0-9\s]+?)(?:\.|\n|$)/i,
    );
    if (noticeMatch) {
      noticePeriod = noticeMatch[1].trim();
    } else if (/\bimmediate\s*(?:joiner|availability)\b/i.test(rawText)) {
      noticePeriod = 'Immediate';
    }
    let workAuth = 'Authorized to work without sponsorship';
    if (/us\s*citizen|green\s*card/i.test(rawText)) {
      workAuth = 'US Citizen / Green Card (No sponsorship required)';
    } else if (/citizen\s*of\s*india|indian\s*citizen/i.test(rawText)) {
      workAuth = 'Citizen of India / Authorized to work without sponsorship';
    }
    const skillExperience = {};
    for (const skill of detectedSkills) {
      const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const yrsMatch =
        rawText.match(
          new RegExp(`\\b${escaped}\\b[^\\n\\r,]{0,25}?\\(?(\\d+(?:\\.\\d+)?)\\s*(?:\\+)?\\s*(?:years?|yrs?)\\)?`, 'i'),
        ) ||
        rawText.match(
          new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:\\+)?\\s*(?:years?|yrs?)[^\\n\\r,]{0,25}?\\b${escaped}\\b`, 'i'),
        );
      if (yrsMatch && yrsMatch[1]) {
        skillExperience[skill] = Math.round(parseFloat(yrsMatch[1]));
      } else {
        skillExperience[skill] = 2;
      }
    }
    return {
      fullName,
      email,
      phoneNumber,
      currentTitle: 'Software Developer',
      skills: detectedSkills,
      yearsOfExperience: 2,
      hasWorkExperience: false,
      workExperience: [],
      education: '',
      college,
      cgpa: '',
      noticePeriod,
      workHistory: [],
      backgroundNarrative: lines.slice(0, 10).join(' '),
      currentLocation: '',
      preferredLocation: '',
      preferredLocations: [],
      workAuthorization: workAuth,
      skillExperience,
      goldenAnswers: [
        {
          id: 'work_auth',
          question: 'Are you legally authorized to work in India / your resident country?',
          answer: 'Yes',
          category: 'Eligibility / Legal',
          isDefault: true,
        },
        {
          id: 'visa_sponsorship',
          question: 'Will you now or in the future require visa sponsorship?',
          answer: 'No',
          category: 'Eligibility / Legal',
          isDefault: true,
        },
        {
          id: 'age_requirement',
          question: 'Are you at least 18 years of age or older?',
          answer: 'Yes',
          category: 'Eligibility / Legal',
          isDefault: true,
        },
      ],
      salaryExpectation: '',
      portfolioUrl: portfolioMatch ? portfolioMatch[0] : '',
      githubUrl: githubMatch ? githubMatch[0] : '',
      linkedinUrl: linkedinMatch ? linkedinMatch[0] : '',
    };
  }
  /**
   * End-to-end handler: Extracts text, runs AI parsing, and returns complete structured payload.
   */
  static async parseResume(buffer, originalName, mimeType) {
    const rawText = await this.extractRawText(buffer, originalName, mimeType);
    const parsedData = await this.extractStructuredData(rawText);
    return {
      rawText,
      parsedData,
      fileName: originalName,
      fileSize: buffer.length,
    };
  }
};

// src/controllers/resume.controller.ts
var ResumeController = class {
  /**
   * Generates a tailored PDF resume.
   * POST /api/v1/resume/generate
   */
  static async generateResume(req, res, next) {
    try {
      const result = await ResumeGeneratorService.generateTailoredResume(req.body);
      res.status(200).json({
        success: true,
        message: 'Tailored resume generated successfully.',
        data: {
          fileName: result.fileName,
          fileSize: result.fileSize,
          base64Pdf: result.base64Pdf,
          highlightedKeywords: result.highlightedKeywords,
        },
      });
    } catch (error) {
      next(error);
    }
  }
  /**
   * Uploads and parses raw PDF/DOCX resume, then syncs structured data to the CareerBrain profile (RTDB).
   * POST /api/v1/resume/upload-and-parse
   */
  static async uploadAndParseResume(req, res, next) {
    try {
      if (!req.file) {
        throw new AppError('No resume file uploaded. Please attach a PDF or Word document.', 400, 'FILE_REQUIRED');
      }
      const userId = req.user?.uid;
      if (!userId) {
        throw new AppError('Authentication required to associate parsed resume with Career Brain', 401, 'UNAUTHORIZED');
      }
      const parseResult = await ResumeParserService.parseResume(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
      );
      const updatedCareerBrain = await ProfileService.createOrUpdateFromResume(
        userId,
        parseResult.parsedData,
        parseResult.rawText,
        parseResult.fileName,
      );
      res.status(200).json({
        success: true,
        message: 'Resume parsed and Career Brain profile updated successfully.',
        data: {
          fileName: parseResult.fileName,
          fileSize: parseResult.fileSize,
          parsedData: parseResult.parsedData,
          careerBrain: updatedCareerBrain,
          rawText: parseResult.rawText,
        },
      });
    } catch (error) {
      next(error);
    }
  }
};

// src/routes/resume.routes.ts
var resumeRouter = Router7();
resumeRouter.post('/generate', validate(generateResumeSchema), ResumeController.generateResume);
resumeRouter.post(
  '/upload-and-parse',
  authenticate,
  uploadResume.single('resume'),
  ResumeController.uploadAndParseResume,
);

// src/routes/jobApplication.routes.ts
import { Router as Router8 } from 'express';

// src/services/jobApplication.service.ts
var keep = (incoming, previous) => incoming || previous || '';
var JobApplicationService = class {
  /** Upserts the application for {uid, platform, jobId} (Mongo: findOneAndUpdate with upsert). */
  static async recordApplication(uid, input) {
    const now = Date.now();
    const unscopedAppId = await this.findUnscopedAppId(uid, input.jobId, input.platform);
    const { appId, isNew } = unscopedAppId
      ? { appId: unscopedAppId, isNew: false }
      : await JobApplicationRepository.claimJobKey(uid, input.jobId, input.platform, newId('ja'));
    const existing = isNew ? null : await JobApplicationRepository.get(uid, appId);
    if (existing?.status === 'APPLIED' && input.status !== 'APPLIED') {
      return toJobApplicationDto(existing);
    }
    const resync = existing?.status === 'APPLIED';
    const record = {
      appId,
      uid,
      jobId: input.jobId,
      title: keep(input.title, existing?.title) || 'Unknown Title',
      company: keep(input.company, existing?.company) || 'Unknown Company',
      location: keep(input.location, existing?.location),
      salaryRange: keep(input.salaryRange, existing?.salaryRange),
      fitScore: Math.min(100, Math.max(0, input.fitScore || existing?.fitScore || 0)),
      platform: input.platform,
      applicationUrl: keep(input.applicationUrl, existing?.applicationUrl),
      status: input.status,
      appliedAt: resync ? (existing?.appliedAt ?? input.appliedAt) : input.appliedAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const jobDescription = keep(input.jobDescription, existing?.jobDescription);
    if (jobDescription) record.jobDescription = jobDescription;
    const companyWebsite = keep(input.companyWebsite, existing?.companyWebsite);
    if (companyWebsite) record.companyWebsite = companyWebsite;
    if (input.status !== 'APPLIED' && input.failureReason) record.failureReason = input.failureReason;
    await JobApplicationRepository.save(uid, record, isNew || !existing);
    return toJobApplicationDto(record);
  }
  /** The user's application for a jobId on a platform (LinkedIn when not given), or null. */
  static async findByJobId(uid, jobId, platform) {
    if (!jobId) return null;
    const appId =
      (await JobApplicationRepository.getAppIdForJob(uid, jobId, platform)) ??
      (platform ? await this.findUnscopedAppId(uid, jobId, platform) : null);
    if (!appId) return null;
    const record = await JobApplicationRepository.get(uid, appId);
    return record ? toJobApplicationDto(record) : null;
  }
  /**
   * Records written before job keys were scoped by platform (and every record the Mongo migration
   * imported) are keyed by the bare job id. Such a record still owns its job when it belongs to the
   * same non-LinkedIn platform, so recording that job again updates it instead of adding a duplicate.
   */
  static async findUnscopedAppId(uid, jobId, platform) {
    if (platform === 'linkedin') return null;
    const appId = await JobApplicationRepository.getAppIdForJob(uid, jobId);
    if (!appId) return null;
    const record = await JobApplicationRepository.get(uid, appId);
    return record?.platform === platform ? appId : null;
  }
  /** Newest-updated first, optionally filtered by exact status. */
  static async listApplications(uid, options) {
    const { status, page, limit } = options;
    const result = status
      ? await JobApplicationRepository.listByStatus(uid, status, page, limit)
      : await JobApplicationRepository.list(uid, page, limit);
    return { items: result.items.map(toJobApplicationDto), total: result.total };
  }
  /** Updates the status of one of the user's applications. Returns null if it doesn't exist. */
  static async updateStatus(uid, appId, status) {
    if (!isSafeKey(appId)) return null;
    const existing = await JobApplicationRepository.get(uid, appId);
    if (!existing) return null;
    const fields = { status, updatedAt: Date.now() };
    await JobApplicationRepository.patch(uid, appId, fields);
    return toJobApplicationDto({ ...existing, ...fields });
  }
};

// src/controllers/jobApplication.controller.ts
function text(value, max) {
  if (value === null || value === void 0) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}
function httpUrl(value, max) {
  const raw2 = text(value, max);
  try {
    return /^https?:$/.test(new URL(raw2).protocol) ? raw2 : '';
  } catch {
    return '';
  }
}
function normalizePlatform(platform, applicationUrl) {
  const posted = text(platform, 64).toLowerCase();
  if (posted) return /^[a-z0-9_-]{1,32}$/.test(posted) ? posted : 'other';
  let host = '';
  try {
    host = new URL(applicationUrl).hostname.toLowerCase();
  } catch {}
  if (host.endsWith('naukri.com')) return 'naukri';
  if (/(^|\.)indeed\./.test(host)) return 'indeed';
  return JOB_APPLICATION_PLATFORMS[0];
}
var JobApplicationController = class {
  /**
   * Records or updates a job application attempt.
   * POST /api/v1/job-applications
   */
  static async recordApplication(req, res, next) {
    try {
      const userId = req.user._id;
      const {
        jobId,
        title,
        jobTitle,
        company,
        location,
        salaryRange,
        fitScore,
        status,
        appliedAt,
        platform,
        applicationUrl,
        jobDescription,
        companyWebsite,
        failureReason,
      } = req.body;
      const finalTitle = text(jobTitle || title, 300);
      const finalCompany = text(company, 300);
      const finalUrl = text(applicationUrl, 2e3);
      const finalJobId = text(
        jobId || finalUrl || `${finalCompany || 'Unknown Company'}-${finalTitle || 'Unknown Title'}`,
        500,
      );
      let finalStatus = 'APPLIED';
      if (status) {
        const upper = String(status).toUpperCase();
        if (JOB_APPLICATION_STATUSES.includes(upper)) {
          finalStatus = upper;
        }
      }
      const parsedAppliedAt = appliedAt ? new Date(appliedAt).getTime() : Date.now();
      const application = await JobApplicationService.recordApplication(userId, {
        jobId: finalJobId,
        title: finalTitle,
        company: finalCompany,
        location: text(location, 300),
        salaryRange: text(salaryRange, 200),
        fitScore: typeof fitScore === 'number' && Number.isFinite(fitScore) ? fitScore : 0,
        platform: normalizePlatform(platform, finalUrl),
        applicationUrl: finalUrl,
        status: finalStatus,
        appliedAt: Number.isFinite(parsedAppliedAt) ? parsedAppliedAt : Date.now(),
        jobDescription: text(jobDescription, 2e3),
        companyWebsite: httpUrl(companyWebsite, 500),
        failureReason: text(failureReason, 300),
      });
      res.status(200).json({
        success: true,
        data: application,
      });
    } catch (error) {
      next(error);
    }
  }
  /**
   * Checks if a user has already applied to a specific job.
   * GET /api/v1/job-applications/check/:jobId[?platform=naukri|indeed] (LinkedIn when omitted)
   * A FAILED attempt is not an application, so it never blocks a retry.
   */
  static async checkDuplicate(req, res, next) {
    try {
      const userId = req.user._id;
      const jobId = req.params.jobId || req.params.userId;
      const platform = req.query.platform ? normalizePlatform(req.query.platform, '') : void 0;
      const existing = await JobApplicationService.findByJobId(userId, jobId, platform);
      res.status(200).json({
        success: true,
        exists: existing !== null && existing.status !== 'FAILED',
        application: existing || null,
      });
    } catch (error) {
      next(error);
    }
  }
  /**
   * Lists job applications for a user.
   * GET /api/v1/job-applications
   */
  static async listApplications(req, res, next) {
    try {
      const userId = req.user._id;
      const { status, limit = '50', page = '1' } = req.query;
      const pageNum = parseInt(page, 10) || 1;
      const limitNum = parseInt(limit, 10) || 50;
      const { items: applications, total } = await JobApplicationService.listApplications(userId, {
        status: status ? String(status) : void 0,
        page: pageNum,
        limit: limitNum,
      });
      res.status(200).json({
        success: true,
        data: applications,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      next(error);
    }
  }
  /**
   * Updates application status.
   * PATCH /api/v1/job-applications/:id/status
   */
  static async updateStatus(req, res, next) {
    try {
      const userId = req.user._id;
      const { id } = req.params;
      const { status } = req.body;
      const validStatus = String(status || '').toUpperCase();
      if (!JOB_APPLICATION_STATUSES.includes(validStatus)) {
        res.status(400).json({ success: false, message: `Invalid status: ${status}` });
        return;
      }
      const application = await JobApplicationService.updateStatus(userId, id, validStatus);
      if (!application) {
        res.status(404).json({ success: false, message: 'Application not found.' });
        return;
      }
      res.status(200).json({
        success: true,
        data: application,
      });
    } catch (error) {
      next(error);
    }
  }
};

// src/routes/jobApplication.routes.ts
var jobApplicationRouter = Router8();
jobApplicationRouter.use(authenticate);
jobApplicationRouter.post('/', JobApplicationController.recordApplication);
jobApplicationRouter.get('/check/:jobId', JobApplicationController.checkDuplicate);
jobApplicationRouter.get('/check/:userId/:jobId', JobApplicationController.checkDuplicate);
jobApplicationRouter.get('/', JobApplicationController.listApplications);
jobApplicationRouter.get('/:userId', JobApplicationController.listApplications);
jobApplicationRouter.patch('/:id/status', JobApplicationController.updateStatus);

// src/routes/profile.routes.ts
import { Router as Router9 } from 'express';

// src/controllers/profile.controller.ts
var ProfileController = class {
  /**
   * GET /api/v1/profile
   * Retrieves stored Career Brain profile for authenticated user.
   */
  static async getProfile(req, res, next) {
    try {
      const userId = req.user._id.toString();
      const profile = await ProfileService.getProfile(userId);
      sendSuccess(res, profile, 'Profile retrieved successfully', 200);
    } catch (error) {
      next(error);
    }
  }
  /**
   * PUT /api/v1/profile
   * Upserts Career Brain profile from Chrome extension.
   */
  static async syncProfile(req, res, next) {
    try {
      const userId = req.user._id.toString();
      const profileData = req.body;
      if (!profileData) {
        sendError(res, 'Profile payload is required', 400, 'MISSING_PAYLOAD');
        return;
      }
      const updated = await ProfileService.syncProfile(userId, profileData);
      sendSuccess(res, updated, 'Profile synced successfully', 200);
    } catch (error) {
      next(error);
    }
  }
  /**
   * GET /api/v1/profile/quota
   * Today's application quota (UTC day): applied, held slots, limit for the verified plan, reset time.
   */
  static async getQuota(req, res, next) {
    try {
      const quota = await ApplicationQuotaService.getStatus(req.user._id.toString());
      sendSuccess(res, quota, 'Quota status retrieved', 200);
    } catch (error) {
      next(error);
    }
  }
  /**
   * POST /api/v1/profile/quota/reserve { jobKey }
   * Holds a slot before a submission. 429 QUOTA_EXCEEDED when the daily limit is reached.
   */
  static async reserveApplication(req, res, next) {
    try {
      const result = await ApplicationQuotaService.reserve(req.user._id.toString(), req.body.jobKey);
      if (!result.granted) {
        sendError(res, dailyLimitMessage(result.quota), 429, 'QUOTA_EXCEEDED', result.quota);
        return;
      }
      sendSuccess(res, result, 'Application slot reserved', 200);
    } catch (error) {
      next(error);
    }
  }
  /**
   * POST /api/v1/profile/quota/commit { jobKey }
   * Records a successful submission (once per job and day).
   */
  static async commitApplication(req, res, next) {
    try {
      const result = await ApplicationQuotaService.commit(req.user._id.toString(), req.body.jobKey);
      sendSuccess(res, result, result.counted ? 'Application counted' : 'Application already counted', 200);
    } catch (error) {
      next(error);
    }
  }
  /**
   * POST /api/v1/profile/quota/release { jobKey }
   * Frees the slot of a submission that did not happen.
   */
  static async releaseApplication(req, res, next) {
    try {
      const quota = await ApplicationQuotaService.release(req.user._id.toString(), req.body.jobKey);
      sendSuccess(res, { quota }, 'Application slot released', 200);
    } catch (error) {
      next(error);
    }
  }
  /**
   * POST /api/v1/profile/quota/check-and-increment (legacy, no job key)
   * Counts one application if a slot is free.
   */
  static async checkAndIncrementQuota(req, res, next) {
    try {
      const { allowed, quota } = await ApplicationQuotaService.checkAndIncrement(req.user._id.toString());
      if (!allowed) {
        sendError(res, dailyLimitMessage(quota), 429, 'QUOTA_EXCEEDED', quota);
        return;
      }
      sendSuccess(res, quota, 'Quota validated and incremented successfully', 200);
    } catch (error) {
      next(error);
    }
  }
};
function dailyLimitMessage(quota) {
  const upgrade = quota.isPaid ? '' : ' Upgrade to Premium for up to 300 applications a day.';
  return `Daily application limit reached (${quota.applied}/${quota.limit}). It resets at ${quota.resetsAt}.${upgrade}`;
}

// src/schemas/quota.schema.ts
import { z as z7 } from 'zod';
var applicationSlotSchema = z7
  .object({
    jobKey: z7.string().trim().min(1, 'jobKey is required').max(512, 'jobKey is too long'),
  })
  .strict();

// src/routes/profile.routes.ts
var profileRouter = Router9();
profileRouter.use(authenticate);
profileRouter.get('/', ProfileController.getProfile);
profileRouter.put('/', ProfileController.syncProfile);
profileRouter.get('/quota', ProfileController.getQuota);
profileRouter.post('/quota/check-and-increment', ProfileController.checkAndIncrementQuota);
profileRouter.post('/quota/reserve', validate(applicationSlotSchema), ProfileController.reserveApplication);
profileRouter.post('/quota/commit', validate(applicationSlotSchema), ProfileController.commitApplication);
profileRouter.post('/quota/release', validate(applicationSlotSchema), ProfileController.releaseApplication);

// src/middleware/credit.middleware.ts
function checkCredits(requiredCredits = 1) {
  return async (req, _res, next) => {
    try {
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required to access this resource', 401, 'UNAUTHORIZED');
      }
      if (!isRtdbAvailable()) {
        throw new AppError('Service temporarily unavailable, cannot verify credits', 503, 'SERVICE_UNAVAILABLE');
      }
      const balance = await CreditService.getCreditBalance(userId);
      if (!balance || balance.remainingCredits < requiredCredits) {
        const available = balance ? balance.remainingCredits : 0;
        throw new AppError(
          `Insufficient credit balance. Required: ${requiredCredits}, Available: ${available}. Please upgrade your subscription.`,
          402,
          'INSUFFICIENT_CREDITS',
        );
      }
      req.creditBalance = balance;
      next();
    } catch (error) {
      next(error);
    }
  };
}

// src/routes/index.ts
var v1Router = Router10();
v1Router.use('/', healthRouter);
v1Router.use('/auth', authRouter);
v1Router.use('/subscription', subscriptionRouter);
v1Router.use('/credits', creditRouter);
v1Router.use('/webhooks', webhookRouter);
v1Router.use('/llm', llmRouter);
v1Router.use('/resume', resumeRouter);
v1Router.use('/job-applications', jobApplicationRouter);
v1Router.use('/profile', profileRouter);
if (env.NODE_ENV === 'test') {
  v1Router.get('/test-protected-feature', authenticate, checkEntitlement, (_req, res) => {
    res.status(200).json({ success: true, message: 'Access granted to premium feature' });
  });
  v1Router.get('/test-entitled-feature', authenticate, checkEntitlement, (_req, res) => {
    res.status(200).json({ success: true, message: 'Access granted' });
  });
  v1Router.get('/test-metered-feature', authenticate, checkCredits(5), (_req, res) => {
    res.status(200).json({ success: true, message: 'Access granted to metered feature' });
  });
}

// src/middleware/correlationId.middleware.ts
import crypto5 from 'node:crypto';
function correlationId(req, res, next) {
  const existingId = req.headers['x-request-id'];
  const requestId = existingId || `req_${crypto5.randomUUID()}`;
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
}

// src/middleware/notFound.ts
function notFoundHandler(req, res) {
  sendError(res, `Route not found: ${req.method} ${req.originalUrl}`, 404, 'NOT_FOUND');
}

// src/app.ts
function createApp() {
  const app2 = express();
  app2.set('trust proxy', 1);
  app2.use(helmet());
  app2.use(correlationId);
  const allowedOrigins = env.CORS_ORIGIN.split(',').map(o => o.trim());
  const originRegexes = allowedOrigins.map(pattern => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
  });
  app2.use(
    cors({
      origin: (origin, callback) => {
        if (
          !origin ||
          allowedOrigins.includes('*') ||
          origin.startsWith('chrome-extension://') ||
          allowedOrigins.includes(origin) ||
          originRegexes.some(regex => regex.test(origin))
        ) {
          callback(null, true);
        } else {
          callback(new Error(`Origin ${origin} not allowed by CORS`));
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'x-run-id',
        'x-idempotency-key',
        'x-correlation-id',
        'Origin',
        'Accept',
      ],
      optionsSuccessStatus: 204,
    }),
  );
  app2.options('*', cors());
  if (env.NODE_ENV !== 'test') {
    app2.use(morgan('dev'));
  }
  app2.use('/', healthRouter);
  app2.use(
    express.json({
      limit: '10mb',
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app2.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app2.use(baseRateLimiter);
  app2.use('/api/v1', v1Router);
  app2.use(notFoundHandler);
  app2.use(errorHandler);
  return app2;
}

// src/server-vercel.ts
var app = createApp();
if (isRtdbAvailable()) {
  PlanSeedService.seedDefaultPlans().catch(() => {});
}
function handler(req, res) {
  const matchedPath = req.headers && (req.headers['x-matched-path'] || req.headers['x-forwarded-url']);
  if (matchedPath && (req.url === '/api/index' || req.url === '/api/index.js' || req.url === '/api')) {
    req.url = matchedPath;
  }
  return app(req, res);
}
export { handler as default };
