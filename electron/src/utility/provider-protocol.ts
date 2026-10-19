import { z } from 'zod';

const providerConfig = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['openai', 'openai-compatible', 'minimax', 'glm', 'deepseek', 'ollama', 'lm-studio']),
    name: z.string().max(240),
    baseUrl: z.url().max(2_048),
    model: z.string().max(240),
    enabled: z.boolean(),
    supportsTools: z.boolean(),
    secretState: z.enum(['configured', 'missing', 'unavailable']),
  })
  .strict();

const credentials = z.object({ config: providerConfig, apiKey: z.string().max(16_384).nullable() }).strict();
const message = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().max(256_000),
    toolCallId: z.string().max(240).optional(),
    toolCalls: z.array(z.object({
      id: z.string().min(1).max(240),
      name: z.string().min(1).max(128),
      argumentsJson: z.string().max(1024 * 1024),
    }).strict()).max(128).optional(),
  })
  .strict();
const request = z
  .object({
    model: z.string().min(1).max(240),
    messages: z.array(message).min(1).max(512),
    tools: z
      .array(
        z.object({ name: z.string().min(1).max(128), description: z.string().max(2_048), parameters: z.record(z.string(), z.unknown()) }).strict(),
      )
      .max(128)
      .optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict();

export const providerUtilityCommandSchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('provider:chat'), requestId: z.string().uuid(), credentials, request }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('provider:models'), requestId: z.string().uuid(), credentials }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('provider:cancel'), requestId: z.string().uuid() }).strict(),
]);

const streamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('tool-call'), id: z.string(), name: z.string(), argumentsJson: z.string() }).strict(),
  z.object({ type: z.literal('usage'), inputTokens: z.number().int().nullable(), outputTokens: z.number().int().nullable() }).strict(),
  z.object({ type: z.literal('done'), finishReason: z.string().nullable() }).strict(),
]);

export const providerUtilityResponseSchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('provider:event'), requestId: z.string().uuid(), event: streamEvent }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('provider:models-result'), requestId: z.string().uuid(), models: z.array(z.object({ id: z.string(), displayName: z.string(), contextWindow: z.number().int().nullable(), supportsTools: z.boolean() }).strict()) }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('provider:complete'), requestId: z.string().uuid() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('provider:error'), requestId: z.string().uuid(), errorCode: z.string().max(128) }).strict(),
]);

export type ProviderUtilityCommand = z.infer<typeof providerUtilityCommandSchema>;
export type ProviderUtilityResponse = z.infer<typeof providerUtilityResponseSchema>;
