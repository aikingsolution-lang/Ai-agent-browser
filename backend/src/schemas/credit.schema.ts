import { z } from 'zod';

export const creditHistoryQuerySchema = z
  .object({
    page: z
      .string()
      .optional()
      .transform(val => (val ? parseInt(val, 10) : 1))
      .pipe(z.number().int().min(1, 'Page must be at least 1')),
    limit: z
      .string()
      .optional()
      .transform(val => (val ? parseInt(val, 10) : 20))
      .pipe(z.number().int().min(1, 'Limit must be at least 1').max(100, 'Limit cannot exceed 100')),
  })
  .strict();

export const creditDeductInputSchema = z
  .object({
    amount: z
      .number()
      .int('Deduction amount must be an integer')
      .min(1, 'Deduction amount must be at least 1 credit')
      .max(1000, 'Deduction amount cannot exceed 1000 credits'),
    description: z.string().min(1, 'Description is required').max(255),
    idempotencyKey: z.string().min(1).max(128).optional(),
    metadata: z.record(z.any()).optional(),
  })
  .strict();

export type CreditHistoryQuery = z.infer<typeof creditHistoryQuerySchema>;
export type CreditDeductInput = z.infer<typeof creditDeductInputSchema>;
