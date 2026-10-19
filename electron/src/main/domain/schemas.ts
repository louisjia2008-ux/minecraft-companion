import { z } from 'zod';

const id = z.string().uuid();
const timestamp = z.iso.datetime();

export const chatSessionSchema = z
  .object({ id, title: z.string().max(240), kind: z.enum(['normal', 'project']), createdAt: timestamp, updatedAt: timestamp })
  .strict();
export const chatMessageSchema = z
  .object({
    id,
    sessionId: id,
    role: z.enum(['user', 'assistant', 'tool', 'system']),
    content: z.string().max(256_000),
    createdAt: timestamp,
    status: z.enum(['streaming', 'complete', 'cancelled', 'failed']),
    errorCode: z.string().max(240).nullable(),
  })
  .strict();
export const taskSchema = z
  .object({
    id,
    title: z.string().max(240),
    notes: z.string().max(16_000),
    status: z.enum(['todo', 'doing', 'done', 'cancelled']),
    dueAt: timestamp.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export const focusSchema = z
  .object({
    id,
    taskId: id.nullable(),
    startedAt: timestamp,
    lastResumedAt: timestamp.nullable(),
    plannedSeconds: z.number().int().positive(),
    elapsedSeconds: z.number().int().nonnegative(),
    status: z.enum(['running', 'paused', 'completed', 'cancelled']),
  })
  .strict();
export const memorySchema = z
  .object({
    id,
    text: z.string().max(32_000),
    tags: z.array(z.string().max(64)).max(32),
    source: z.enum(['user', 'assistant', 'migration']),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export const relationshipSchema = z
  .object({
    affinity: z.number().min(0).max(100),
    level: z.number().int().min(1).max(100),
    streakDays: z.number().int().nonnegative(),
    lastInteractionAt: timestamp.nullable(),
    nickname: z.string().max(80),
  })
  .strict();
export const scheduleSchema = z
  .object({
    id,
    title: z.string().max(240),
    enabled: z.boolean(),
    kind: z.enum(['reminder', 'focus', 'agent']),
    rrule: z.string().max(2_048),
    timezone: z.string().max(128),
    payload: z.record(z.string(), z.unknown()),
    nextRunAt: timestamp.nullable(),
    lastRunStatus: z.enum(['never', 'succeeded', 'failed', 'missed']),
  })
  .strict();
export const providerSchema = z
  .object({
    id,
    kind: z.enum(['openai', 'openai-compatible', 'minimax', 'glm', 'deepseek', 'ollama', 'lm-studio']),
    name: z.string().max(240),
    baseUrl: z.url().max(2_048),
    model: z.string().max(240),
    enabled: z.boolean(),
    supportsTools: z.boolean(),
    secretState: z.enum(['configured', 'missing', 'unavailable']),
  })
  .strict();
export const permissionGrantSchema = z
  .object({
    capabilityId: z.string().min(1).max(128),
    scope: z.enum(['once', 'session', 'always']),
    grantedAt: timestamp,
    expiresAt: timestamp.nullable(),
    remainingUses: z.number().int().min(0).max(1).nullable(),
  })
  .strict();
export const sideEffectSchema = z
  .object({
    key: z.string().min(1).max(512),
    runId: id,
    toolId: z.string().min(1).max(128),
    completedAt: timestamp,
    output: z.unknown(),
  })
  .strict();

export const persistentStateSchema = z
  .object({
    version: z.literal(1),
    chatSessions: z.array(chatSessionSchema),
    chatMessages: z.array(chatMessageSchema),
    tasks: z.array(taskSchema),
    focus: focusSchema.nullable(),
    memories: z.array(memorySchema),
    relationship: relationshipSchema,
    schedules: z.array(scheduleSchema),
    providers: z.array(providerSchema),
    persistentPermissionGrants: z.array(permissionGrantSchema),
    sideEffects: z.array(sideEffectSchema),
  })
  .strict();

export type PersistentState = z.infer<typeof persistentStateSchema>;
export type PersistentFocus = z.infer<typeof focusSchema>;
export type PermissionGrant = z.infer<typeof permissionGrantSchema>;
export type SideEffectRecord = z.infer<typeof sideEffectSchema>;

export const createDefaultState = (): PersistentState => ({
  version: 1,
  chatSessions: [],
  chatMessages: [],
  tasks: [],
  focus: null,
  memories: [],
  relationship: { affinity: 0, level: 1, streakDays: 0, lastInteractionAt: null, nickname: '' },
  schedules: [],
  providers: [],
  persistentPermissionGrants: [],
  sideEffects: [],
});
