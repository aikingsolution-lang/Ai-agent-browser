import { z } from 'zod';

export const createSubscriptionSchema = z
  .object({
    userId: z.string({ required_error: 'User ID is required' }).trim(),
    planId: z.string({ required_error: 'Plan ID is required' }).trim(),
    planCodeSnapshot: z.string({ required_error: 'Plan code snapshot is required' }).trim(),
    planNameSnapshot: z.string({ required_error: 'Plan name snapshot is required' }).trim(),
    amountSnapshot: z
      .number({ required_error: 'Amount snapshot is required' })
      .int('Amount snapshot must be an integer in the smallest currency unit (e.g. paise)')
      .min(0, 'Amount snapshot must be non-negative'),
    currencySnapshot: z.string({ required_error: 'Currency snapshot is required' }).trim().toUpperCase(),
    billingIntervalSnapshot: z.enum(['none', 'monthly', 'yearly'], {
      required_error: 'Billing interval snapshot is required',
    }),
    creditsSnapshot: z
      .number({ required_error: 'Credits snapshot is required' })
      .int('Credits snapshot must be an integer')
      .min(1, 'Credits snapshot must be at least 1'),
    rateLimitSnapshot: z
      .number({ required_error: 'Rate limit snapshot is required' })
      .int('Rate limit snapshot must be an integer')
      .min(1, 'Rate limit snapshot must be at least 1'),
    provider: z.enum(['manual', 'razorpay']).default('manual'),
    providerCustomerId: z.string().trim().optional(),
    providerSubscriptionId: z.string().trim().optional(),
    status: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED']).default('TRIALING'),
    isTrial: z.boolean().default(false),
    trialStartDate: z.string().datetime().optional(),
    trialEndDate: z.string().datetime().optional(),
    currentPeriodStart: z.string({ required_error: 'Current period start date is required' }).datetime(),
    currentPeriodEnd: z.string({ required_error: 'Current period end date is required' }).datetime(),
    cancelAtPeriodEnd: z.boolean().default(false),
    canceledAt: z.string().datetime().optional(),
    endedAt: z.string().datetime().optional(),
  })
  .strict();

export const checkoutInputSchema = z
  .object({
    planCode: z.string({ required_error: 'Plan code is required' }).trim().min(1),
    idempotencyKey: z.string().trim().optional(),
  })
  .strict();

export const verifyPaymentInputSchema = z
  .object({
    razorpayPaymentId: z.string({ required_error: 'Razorpay payment ID is required' }).trim().min(1),
    razorpaySubscriptionId: z.string({ required_error: 'Razorpay subscription ID is required' }).trim().min(1),
    razorpaySignature: z.string({ required_error: 'Razorpay signature is required' }).trim().min(1),
  })
  .strict();

export const cancelSubscriptionSchema = z
  .object({
    reason: z.string().trim().max(255).optional(),
  })
  .strict();

export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;
export type CheckoutInput = z.infer<typeof checkoutInputSchema>;
export type VerifyPaymentInput = z.infer<typeof verifyPaymentInputSchema>;
export type CancelSubscriptionInput = z.infer<typeof cancelSubscriptionSchema>;
