import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z
    .union([z.string(), z.number()])
    .transform(val => (typeof val === 'number' ? val : parseInt(val, 10)))
    .default(process.env.PORT || '5000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  CORS_ORIGIN: z.string().default('*'),
  MONGO_URI: z.string().default(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/nanobrowser_saas'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
  JWT_SECRET: z
    .string()
    .min(16, 'JWT_SECRET must be at least 16 characters')
    .default('super_secret_jwt_key_nanobrowser_prod_2026_min32chars'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(16, 'JWT_REFRESH_SECRET must be at least 16 characters')
    .default(process.env.JWT_SECRET || 'super_secret_jwt_refresh_key_nanobrowser_prod_2026_min32chars'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  RAZORPAY_KEY_ID: z.string().default('rzp_test_TZudy51Zrf7t8w'),
  RAZORPAY_KEY_SECRET: z.string().default('QAaFgUjFe390LpwrQfme2zyy'),
  RAZORPAY_WEBHOOK_SECRET: z.string().default('760c2bfa92c6f5c91d5033ff'),
  AWS_BEDROCK_API_KEY: z.string().default(''),
  AWS_BEDROCK_REGION: z.string().default('us-east-1'),
  OPENAI_API_KEY: z.string().optional(),
  LLM_DEFAULT_MODEL: z.string().default('amazon.nova-lite-v1:0'),
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
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.warn('⚠️ Environment variable configuration warnings:', parsedEnv.error.format());
}

export const env = parsedEnv.success
  ? parsedEnv.data
  : {
      PORT: parseInt(process.env.PORT || '8080', 10),
      NODE_ENV: (process.env.NODE_ENV as any) || 'production',
      CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
      MONGO_URI: process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/nanobrowser_saas',
      LOG_LEVEL: 'info' as const,
      JWT_SECRET: process.env.JWT_SECRET || 'super_secret_jwt_key_nanobrowser_prod_2026_min32chars',
      JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '15m',
      JWT_REFRESH_SECRET:
        process.env.JWT_REFRESH_SECRET ||
        process.env.JWT_SECRET ||
        'super_secret_jwt_refresh_key_nanobrowser_prod_2026_min32chars',
      JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
      RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || 'rzp_test_TZudy51Zrf7t8w',
      RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || 'QAaFgUjFe390LpwrQfme2zyy',
      RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || '760c2bfa92c6f5c91d5033ff',
      AWS_BEDROCK_API_KEY: process.env.AWS_BEDROCK_API_KEY || '',
      AWS_BEDROCK_REGION: process.env.AWS_BEDROCK_REGION || 'us-east-1',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      LLM_DEFAULT_MODEL: process.env.LLM_DEFAULT_MODEL || 'amazon.nova-lite-v1:0',
      GOOGLE_CLIENT_ID:
        process.env.GOOGLE_CLIENT_ID?.trim() ||
        '336340854879-i6hj15oe17se379u6k377slo7pvbvh3v.apps.googleusercontent.com',
    };
