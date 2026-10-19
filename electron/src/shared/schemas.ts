import { z } from 'zod';

import { API_VERSION } from './contracts';

const idSchema = z.string().uuid();
const textSchema = z.string().trim().min(1).max(32_000);
const shortTextSchema = z.string().trim().min(1).max(240);
const nullableShortTextSchema = z.string().trim().max(240).nullable();
const emptySchema = z.object({}).strict();
const hasControlCharacters = (value: string): boolean => [...value].some((character) => character.charCodeAt(0) < 32);

export const localeSchema = z.enum(['system', 'en', 'zh-CN']);
export const themeSchema = z.enum(['system', 'light', 'dark']);
export const providerKindSchema = z.enum([
  'openai',
  'openai-compatible',
  'minimax',
  'glm',
  'deepseek',
  'ollama',
  'lm-studio',
]);

export const providerInputSchema = z
  .object({
    id: idSchema,
    kind: providerKindSchema,
    name: shortTextSchema,
    baseUrl: z.url().max(2_048),
    model: shortTextSchema,
    enabled: z.boolean(),
    supportsTools: z.boolean(),
    apiKey: z.string().max(16_384).optional(),
  })
  .strict();

export const taskInputSchema = z
  .object({
    id: idSchema,
    title: shortTextSchema,
    notes: z.string().max(16_000),
    status: z.enum(['todo', 'doing', 'done', 'cancelled']),
    dueAt: z.iso.datetime().nullable(),
  })
  .strict();

export const memoryInputSchema = z
  .object({
    id: idSchema,
    text: textSchema,
    tags: z.array(z.string().trim().min(1).max(64)).max(32),
  })
  .strict();

export const scheduleInputSchema = z
  .object({
    id: idSchema,
    title: shortTextSchema,
    enabled: z.boolean(),
    kind: z.enum(['reminder', 'focus', 'agent']),
    rrule: z.string().trim().min(1).max(2_048),
    timezone: z.string().trim().min(1).max(128),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export const minecraftConnectionSchema = z.object({
  host: z.string().trim().min(1).max(253).refine((value) => !/[\s/\\?#@]/u.test(value) && !hasControlCharacters(value), 'Use a server hostname or IP address.'),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(254).refine((value) => !hasControlCharacters(value)),
  auth: z.enum(['offline', 'microsoft']),
  version: z.string().trim().max(32).regex(/^(auto|1\.\d+(?:\.\d+)?)$/u),
  ownerName: z.string().trim().max(16).regex(/^[A-Za-z0-9_]*$/u),
  executorMode: z.enum(['strict', 'hybrid']),
  providerId: idSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.auth === 'offline' && !/^[A-Za-z0-9_]{1,16}$/u.test(value.username)) {
    context.addIssue({ code: 'custom', path: ['username'], message: 'Offline player names use 1–16 letters, numbers or underscores.' });
  }
  if (value.executorMode === 'hybrid' && value.providerId === null) {
    context.addIssue({ code: 'custom', path: ['providerId'], message: 'Select an AI provider for hybrid mode.' });
  }
});

export const invokePayloadSchemas = {
  'minecraft:get-state': emptySchema,
  'minecraft:connect': minecraftConnectionSchema,
  'minecraft:disconnect': emptySchema,
  'minecraft:submit': z.object({ command: z.string().trim().min(1).max(2000) }).strict(),
  'minecraft:control': z.object({ action: z.enum(['pause', 'resume', 'cancel', 'stop', 'refresh']) }).strict(),
  'minecraft:chat': z.object({ message: z.string().trim().min(1).max(240).refine((value) => !value.startsWith('/') && !hasControlCharacters(value), 'Enter a chat message, without server commands.') }).strict(),
  'app:get-state': emptySchema,
  'app:set-locale': z.object({ locale: localeSchema }).strict(),
  'app:set-theme': z.object({ theme: themeSchema }).strict(),
  'app:set-hotkey': z.object({ accelerator: z.string().trim().min(1).max(128) }).strict(),
  'app:set-auto-launch': z.object({ enabled: z.boolean() }).strict(),
  'app:show-console': emptySchema,
  'app:set-overlay-visible': z.object({ visible: z.boolean() }).strict(),
  'app:get-diagnostics': emptySchema,
  'character:get-state': emptySchema,
  'character:import-core': emptySchema,
  'character:import-model': emptySchema,
  'character:cancel-import': emptySchema,
  'character:ack-model-loaded': z.object({ importId: idSchema }).strict(),
  'character:set-scale': z.object({ scale: z.number().min(0.2).max(3) }).strict(),
  'character:set-position': z
    .object({
      position: z
        .object({ displayId: z.string().min(1).max(128), x: z.number().finite(), y: z.number().finite() })
        .strict()
        .nullable(),
    })
    .strict(),
  'character:play-action': z.object({ action: shortTextSchema }).strict(),
  'character:set-expression': z.object({ expression: nullableShortTextSchema }).strict(),
  'character:set-bubble': z.object({ text: z.string().max(2_000).nullable() }).strict(),
  'character:set-interactive': z.object({ interactive: z.boolean() }).strict(),
  'chat:list-sessions': emptySchema,
  'chat:create-session': z.object({ title: shortTextSchema, kind: z.enum(['normal', 'project']) }).strict(),
  'chat:list-messages': z.object({ sessionId: idSchema }).strict(),
  'chat:send': z.object({ sessionId: idSchema, content: textSchema, providerId: idSchema }).strict(),
  'chat:cancel': z.object({ runId: idSchema }).strict(),
  'chat:retry': z.object({ messageId: idSchema }).strict(),
  'tasks:list': emptySchema,
  'tasks:upsert': taskInputSchema,
  'tasks:remove': z.object({ id: idSchema }).strict(),
  'tasks:get-focus': emptySchema,
  'tasks:start-focus': z.object({ taskId: idSchema.nullable(), plannedSeconds: z.number().int().min(60).max(86_400) }).strict(),
  'tasks:pause-focus': emptySchema,
  'tasks:resume-focus': emptySchema,
  'tasks:stop-focus': z.object({ status: z.enum(['completed', 'cancelled']) }).strict(),
  'tasks:list-run-events': emptySchema,
  'memory:list': emptySchema,
  'memory:upsert': memoryInputSchema,
  'memory:remove': z.object({ id: idSchema }).strict(),
  'relationship:get': emptySchema,
  'relationship:set-nickname': z.object({ nickname: z.string().trim().max(80) }).strict(),
  'schedule:list': emptySchema,
  'schedule:upsert': scheduleInputSchema,
  'schedule:remove': z.object({ id: idSchema }).strict(),
  'schedule:run-now': z.object({ id: idSchema }).strict(),
  'providers:list': emptySchema,
  'providers:upsert': providerInputSchema,
  'providers:remove': z.object({ id: idSchema }).strict(),
  'providers:clear-secret': z.object({ id: idSchema }).strict(),
  'providers:test': z.object({ id: idSchema }).strict(),
  'providers:list-models': z.object({ id: idSchema }).strict(),
  'permissions:list': emptySchema,
  'permissions:request': z
    .object({ capabilityId: z.string().min(1).max(128), duration: z.enum(['once', 'session', 'always']) })
    .strict(),
  'permissions:revoke': z.object({ capabilityId: z.string().min(1).max(128) }).strict(),
  'migration:preview': emptySchema,
  'migration:start': z
    .object({ categories: z.array(z.string().min(1).max(128)).max(16), confirmProviderSecrets: z.boolean() })
    .strict(),
  'migration:cancel': emptySchema,
} as const;

export type InvokeChannel = keyof typeof invokePayloadSchemas;
export type InvokePayload<C extends InvokeChannel> = z.infer<(typeof invokePayloadSchemas)[C]>;

export const eventChannels = [
  'minecraft:changed',
  'app:changed',
  'character:changed',
  'character:import-progress',
  'chat:event',
  'tasks:changed',
  'memory:changed',
  'relationship:changed',
  'schedule:changed',
  'providers:changed',
  'permissions:changed',
  'migration:progress',
] as const;

export type EventChannel = (typeof eventChannels)[number];

export const requestEnvelopeSchema = <T extends z.ZodType>(payload: T) =>
  z
    .object({
      version: z.literal(API_VERSION),
      payload,
    })
    .strict();

export const MAX_IPC_BYTES = 256 * 1024;

export const parseInvokeRequest = <C extends InvokeChannel>(channel: C, value: unknown): InvokePayload<C> => {
  const envelope = requestEnvelopeSchema(invokePayloadSchemas[channel]).parse(value);
  return envelope.payload as InvokePayload<C>;
};
