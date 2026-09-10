import { z } from 'zod';

export const ALLOWED_MODELS = [
  'anthropic.claude-3-5-sonnet-20240620-v1:0',
  'anthropic.claude-3-haiku-20240307-v1:0',
  'amazon.nova-micro-v1:0',
  'amazon.nova-lite-v1:0',
  'amazon.nova-pro-v1:0',
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

export const llmChatMessageSchema = z.object({
  role: z.string({
    required_error: 'Message role is required',
  }),
  content: z
    .union([z.string(), z.array(z.any()), z.null()])
    .optional()
    .transform(val => {
      if (typeof val === 'string') return val;
      if (val === null || val === undefined) return '';
      return JSON.stringify(val);
    }),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
  function_call: z.any().optional(),
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
