import { z } from 'zod';

export const createPlanSchema = z
  .object({
    code: z
      .string({ required_error: 'Plan code is required' })
      .trim()
      .toLowerCase()
      .min(2, 'Plan code must be at least 2 characters long')
      .max(30, 'Plan code cannot exceed 30 characters'),
    name: z
      .string({ required_error: 'Plan name is required' })
      .trim()
      .min(2, 'Plan name must be at least 2 characters long')
      .max(50, 'Plan name cannot exceed 50 characters'),
    description: z
      .string({ required_error: 'Plan description is required' })
      .trim()
      .min(5, 'Plan description must be at least 5 characters long'),
    amount: z
      .number({ required_error: 'Plan amount is required' })
      .int('Plan amount must be an integer in the smallest currency unit (e.g. paise)')
      .min(0, 'Plan amount must be a non-negative number'),
    currency: z
      .string({ required_error: 'Currency is required' })
      .trim()
      .toUpperCase()
      .length(3, 'Currency must be a 3-letter ISO code'),
    billingInterval: z.enum(['none', 'monthly', 'yearly'], {
      required_error: 'Billing interval is required',
    }),
    creditsPerBillingPeriod: z
      .number({ required_error: 'Credits per billing period is required' })
      .int('Credits must be an integer')
      .min(1, 'Credits per billing period must be at least 1'),
    rateLimitPerMinute: z
      .number({ required_error: 'Rate limit per minute is required' })
      .int('Rate limit must be an integer')
      .min(1, 'Rate limit per minute must be at least 1'),
    features: z.array(z.string().trim()).default([]),
    razorpayPlanId: z.string().trim().optional(),
    isActive: z.boolean().default(true),
  })
  .strict();

export type CreatePlanInput = z.infer<typeof createPlanSchema>;
