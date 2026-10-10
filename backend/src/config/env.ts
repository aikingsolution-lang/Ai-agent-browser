import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Normalises a Firebase private key string from environment variables.
 * Handles: JSON-escaped newlines (\n), surrounding quotes, and raw PEM blocks.
 * Mirrors parsePrivateKey() in JobForm Automator's lib/firebase-admin.ts.
 */
function normaliseFirebaseKey(val: string | undefined): string | undefined {
  if (!val) return undefined;
  let k = val.trim();
  // Strip surrounding quotes if the whole value was quoted in the env file
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim();
  }
  // Replace literal \n sequences (JSON-escaped) with real newlines
  return k.replace(/\\n/g, '\n');
}

const envSchema = z.object({
  PORT: z
    .union([z.string(), z.number()])
    .transform(val => (typeof val === 'number' ? val : parseInt(val, 10)))
    .default(process.env.PORT || '5000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  CORS_ORIGIN: z.string().default('*'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),

  // ── Razorpay (server-only) ────────────────────────────────────────────────
  RAZORPAY_KEY_ID: z.string().default('rzp_test_TZudy51Zrf7t8w'),
  RAZORPAY_KEY_SECRET: z.string().default('QAaFgUjFe390LpwrQfme2zyy'),
  RAZORPAY_WEBHOOK_SECRET: z.string().default('760c2bfa92c6f5c91d5033ff'),
  RAZORPAY_PLAN_ID_STARTER: z.string().optional(),
  RAZORPAY_PLAN_ID_PRO: z.string().optional(),
  RAZORPAY_PLAN_ID_POWER: z.string().optional(),

  // ── LLM Providers (server-only) ───────────────────────────────────────────
  AWS_BEDROCK_API_KEY: z.string().default(''),
  AWS_BEDROCK_REGION: z.string().default('us-east-1'),
  OPENAI_API_KEY: z.string().optional(),
  LLM_DEFAULT_MODEL: z.string().default('amazon.nova-lite-v1:0'),

  // ── Google OAuth client ID (used by the extension — public) ───────────────
  GOOGLE_CLIENT_ID: z
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
  ENABLE_CREDITS_RECONCILE: z
    .union([z.boolean(), z.string()])
    .transform(val => (typeof val === 'boolean' ? val : val === 'true' || val === '1'))
    .default(false),
  MAX_DAILY_REFUND_CAP: z
    .union([z.number(), z.string()])
    .transform(val => (typeof val === 'number' ? val : parseInt(val || '50', 10)))
    .default(50),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.warn('⚠️ Environment variable configuration warnings:', parsedEnv.error.format());
}

const baseEnv = parsedEnv.success
  ? parsedEnv.data
  : {
      PORT: parseInt(process.env.PORT || '8080', 10),
      NODE_ENV: (process.env.NODE_ENV as any) || 'production',
      CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
      LOG_LEVEL: 'info' as const,
      RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || 'rzp_test_TZudy51Zrf7t8w',
      RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || 'QAaFgUjFe390LpwrQfme2zyy',
      RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || '760c2bfa92c6f5c91d5033ff',
      RAZORPAY_PLAN_ID_STARTER: process.env.RAZORPAY_PLAN_ID_STARTER,
      RAZORPAY_PLAN_ID_PRO: process.env.RAZORPAY_PLAN_ID_PRO,
      RAZORPAY_PLAN_ID_POWER: process.env.RAZORPAY_PLAN_ID_POWER,
      AWS_BEDROCK_API_KEY: process.env.AWS_BEDROCK_API_KEY || '',
      AWS_BEDROCK_REGION: process.env.AWS_BEDROCK_REGION || 'us-east-1',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      LLM_DEFAULT_MODEL: process.env.LLM_DEFAULT_MODEL || 'amazon.nova-lite-v1:0',
      GOOGLE_CLIENT_ID:
        process.env.GOOGLE_CLIENT_ID?.trim() ||
        '336340854879-i6hj15oe17se379u6k377slo7pvbvh3v.apps.googleusercontent.com',
      ENABLE_CREDITS_RECONCILE:
        process.env.ENABLE_CREDITS_RECONCILE === 'true' || process.env.ENABLE_CREDITS_RECONCILE === '1',
      MAX_DAILY_REFUND_CAP: parseInt(process.env.MAX_DAILY_REFUND_CAP || '50', 10),
    };

/**
 * Firebase Admin configuration (SERVER-ONLY — never expose to the extension build).
 *
 * Uses the same variable names as JobForm Automator (lib/firebase-admin.ts), so the
 * automator's service-account values can be reused as-is:
 *   FIREBASE_ADMIN_CLIENT_EMAIL, FIREBASE_ADMIN_PRIVATE_KEY,
 *   FIREBASE_PROJECT_ID        (automator also accepts NEXT_PUBLIC_FIREBASE_PROJECT_ID),
 *   FIREBASE_DATABASE_URL      (automator reads NEXT_PUBLIC_FIREBASE_DATABASE_URL; accepted as a fallback).
 *
 * NANOBROWSER_RTDB_ROOT is the namespace every Ai-agent-browser RTDB path lives under,
 * so this backend can share the automator database without touching its paths.
 */
const firebaseEnv = {
  FIREBASE_PROJECT_ID:
    (process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID)?.trim() || undefined,
  FIREBASE_ADMIN_CLIENT_EMAIL: process.env.FIREBASE_ADMIN_CLIENT_EMAIL?.replace(/^"|"$/g, '').trim() || undefined,
  FIREBASE_ADMIN_PRIVATE_KEY: normaliseFirebaseKey(process.env.FIREBASE_ADMIN_PRIVATE_KEY),
  FIREBASE_DATABASE_URL:
    (process.env.FIREBASE_DATABASE_URL || process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL)?.trim() || undefined,
  FIREBASE_STORAGE_BUCKET:
    (process.env.FIREBASE_STORAGE_BUCKET || process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET)?.trim() || undefined,
  NANOBROWSER_RTDB_ROOT: process.env.NANOBROWSER_RTDB_ROOT?.trim() || 'nanobrowser',
};

export const env = { ...baseEnv, ...firebaseEnv };
