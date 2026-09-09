import { z } from 'zod';

export const ALLOWED_MODELS = ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo', 'claude-3-5-sonnet', 'deepseek-chat'] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

export const llmChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant'], {
    required_error: 'Message role is required',
    invalid_type_error: "Role must be 'system', 'user', or 'assistant'",
  }),
  content: z
    .string()
    .min(1, 'Message content cannot be empty')
    .max(20000, 'Message content exceeds maximum character limit (20,000)'),
});

export const llmChatCompletionSchema = z.object({
  model: z.string().refine(val => ALLOWED_MODELS.includes(val as any), {
    message: `Invalid model requested. Allowed models: ${ALLOWED_MODELS.join(', ')}`,
  }),
  messages: z.array(llmChatMessageSchema).min(1, 'At least one message is required'),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional().default(0.7),
  max_tokens: z.number().int().positive().optional(),
  idempotencyKey: z.string().optional(),
});

export type LlmChatCompletionInput = z.infer<typeof llmChatCompletionSchema>;
