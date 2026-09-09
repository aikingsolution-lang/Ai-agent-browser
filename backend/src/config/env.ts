import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z
  .object({
    PORT: z
      .string()
      .transform(val => parseInt(val, 10))
      .default('5000'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    CORS_ORIGIN: z.string().default('*'),
    MONGO_URI: z.string().default('mongodb://127.0.0.1:27017/nanobrowser_saas'),
    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
    JWT_SECRET: z
      .string()
      .min(16, 'JWT_SECRET must be at least 16 characters')
      .default('super_secret_jwt_key_must_be_changed_in_production_min_32_chars'),
    JWT_EXPIRES_IN: z.string().default('15m'),
    RAZORPAY_KEY_ID: z.string().default('rzp_test_mock_key_id_12345'),
    RAZORPAY_KEY_SECRET: z.string().default('rzp_test_mock_key_secret_67890'),
    RAZORPAY_WEBHOOK_SECRET: z.string().default('rzp_test_mock_webhook_secret_abcde'),
    AWS_BEDROCK_API_KEY: z.string().default('mock_bedrock_api_key'),
    AWS_BEDROCK_REGION: z.string().default('us-east-1'),
    OPENAI_API_KEY: z.string().optional(),
    LLM_DEFAULT_MODEL: z.string().default('anthropic.claude-3-5-sonnet-20240620-v1:0'),
  })
  .refine(
    data => {
      if (data.NODE_ENV === 'production') {
        const isMockRazorpay =
          data.RAZORPAY_KEY_ID.includes('mock') ||
          data.RAZORPAY_KEY_SECRET.includes('mock') ||
          data.RAZORPAY_WEBHOOK_SECRET.includes('mock');
        const isMockBedrock = !data.AWS_BEDROCK_API_KEY || data.AWS_BEDROCK_API_KEY.includes('mock');
        const isDefaultJwt = data.JWT_SECRET.includes('must_be_changed_in_production');

        return !isMockRazorpay && !isMockBedrock && !isDefaultJwt;
      }
      return true;
    },
    {
      message:
        'In production mode, real non-mock Razorpay secrets, real AWS_BEDROCK_API_KEY, and secure JWT_SECRET must be configured',
    },
  );

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variable configuration:', parsedEnv.error.format());
  throw new Error('Environment variable validation failed');
}

export const env = parsedEnv.data;
