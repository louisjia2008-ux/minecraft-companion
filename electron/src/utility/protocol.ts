import { z } from 'zod';

export const utilityRequestSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string().uuid(),
    runId: z.string().uuid(),
    taskId: z.string().uuid(),
    capabilityId: z.string().min(1).max(128),
    toolId: z.string().min(1).max(128),
    input: z.unknown(),
  })
  .strict();

export const utilityResponseSchema = z.discriminatedUnion('ok', [
  z.object({ version: z.literal(1), requestId: z.string().uuid(), ok: z.literal(true), output: z.unknown() }).strict(),
  z.object({ version: z.literal(1), requestId: z.string().uuid(), ok: z.literal(false), errorCode: z.string().max(128) }).strict(),
]);

export type UtilityRequest = z.infer<typeof utilityRequestSchema>;
export type UtilityResponse = z.infer<typeof utilityResponseSchema>;
