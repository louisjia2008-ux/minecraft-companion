import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, cp, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import type {
  ChatMessage, ChatSession, DeskTask, ImportProgress, MemoryItem, MigrationPreview, MigrationResult,
  ProviderConfig, ProviderKind, RelationshipState, ScheduleDefinition,
} from '../../shared';
import type { CharacterService } from '../character-service';
import type { DomainRepository } from '../domain';
import { atomicWriteFile } from '../persistence';
import type { SafeStorageVault } from '../security';

const CATEGORY_IDS = [
  'conversations', 'memory', 'tasks', 'relationship', 'schedules', 'providers', 'appearance', 'live2d-model',
] as const;
type MigrationCategory = (typeof CATEGORY_IDS)[number];

const categorySchema = z.object({
  id: z.enum(CATEGORY_IDS), count: z.number().int().nonnegative(), containsSecrets: z.boolean(),
}).strict();
const helperResultSchema = z.object({
  version: z.literal(1), sourcePath: z.string().min(1), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  categories: z.array(categorySchema), requiresKeychainConfirmation: z.boolean(),
  warnings: z.array(z.string().max(2_048)), values: z.record(z.string(), z.unknown()),
}).strict();
const helperSecretsSchema = z.object({
  version: z.literal(1), secrets: z.record(z.string(), z.string().min(1).max(16_384)),
  warnings: z.array(z.string().max(2_048)),
}).strict();
type HelperResult = z.infer<typeof helperResultSchema>;
type HelperSecrets = z.infer<typeof helperSecretsSchema>;

export interface MigrationHelperRunner {
  run(command: 'preview' | 'export', sourcePath: string, includeSecrets: boolean, signal: AbortSignal): Promise<{
    result: HelperResult; secrets: HelperSecrets;
  }>;
}

const readStream = async (stream: NodeJS.ReadableStream | null, limit: number): Promise<Buffer> => {
  if (stream === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value)
      ? value
      : typeof value === 'string' ? Buffer.from(value) : Buffer.from(value as unknown as Uint8Array);
    bytes += chunk.byteLength;
    if (bytes > limit) throw new Error('Migration helper output exceeded its size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

export class ProcessMigrationHelperRunner implements MigrationHelperRunner {
  constructor(private readonly executablePath: string) {}

  async run(command: 'preview' | 'export', sourcePath: string, includeSecrets: boolean, signal: AbortSignal): Promise<{
    result: HelperResult; secrets: HelperSecrets;
  }> {
    await access(this.executablePath);
    const args = [command, '--source', sourcePath];
    if (includeSecrets) args.push('--include-secrets', '--secrets-fd', '3');
    const child = spawn(this.executablePath, args, {
      stdio: ['ignore', 'pipe', 'pipe', includeSecrets ? 'pipe' : 'ignore'], windowsHide: true,
    });
    const abort = (): void => { child.kill('SIGTERM'); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const [stdout, stderr, secretOutput, exit] = await Promise.all([
        readStream(child.stdout, 32 * 1024 * 1024), readStream(child.stderr, 16 * 1024),
        readStream(includeSecrets ? child.stdio[3] as NodeJS.ReadableStream | null : null, 2 * 1024 * 1024),
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, closeSignal) => resolve({ code, signal: closeSignal }));
        }),
      ]);
      if (signal.aborted) throw new DOMException('Migration cancelled.', 'AbortError');
      if (exit.code !== 0) {
        throw new Error(`Native migration helper failed (${exit.code ?? exit.signal ?? 'unknown'}): ${stderr.toString('utf8').trim()}`);
      }
      return {
        result: helperResultSchema.parse(JSON.parse(stdout.toString('utf8'))),
        secrets: includeSecrets
          ? helperSecretsSchema.parse(JSON.parse(secretOutput.toString('utf8')))
          : { version: 1, secrets: {}, warnings: [] },
      };
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
const bool = (value: unknown, fallback = false): boolean => typeof value === 'boolean' ? value : fallback;
const number = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const uuid = (value: unknown): string => {
  const candidate = string(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate.toLowerCase() : randomUUID();
};
const iso = (value: unknown, fallback = new Date(0).toISOString()): string => {
  const candidate = string(value);
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
};
const bounded = (value: string, maximum: number): string => value.slice(0, maximum);

interface TransformedImport {
  sessions: ChatSession[];
  messages: ChatMessage[];
  tasks: DeskTask[];
  memories: MemoryItem[];
  relationship: RelationshipState | null;
  schedules: ScheduleDefinition[];
  providers: ProviderConfig[];
  providerSecretIDs: Map<string, string>;
  appearanceScale: number | null;
  nativeModelArchive: string | null;
  imported: Record<string, number>;
  skipped: Record<string, number>;
  warnings: string[];
}
const emptyTransform = (): TransformedImport => ({
  sessions: [], messages: [], tasks: [], memories: [], relationship: null, schedules: [], providers: [],
  providerSecretIDs: new Map(), appearanceScale: null, nativeModelArchive: null,
  imported: {}, skipped: {}, warnings: [],
});

const transformConversations = (value: unknown, transformed: TransformedImport): void => {
  for (const entry of array(value)) {
    const conversation = object(entry);
    if (conversation === null) continue;
    const kind = string(conversation.kind, 'normal');
    if (kind !== 'normal' && kind !== 'project') {
      transformed.skipped.conversations = (transformed.skipped.conversations ?? 0) + 1;
      continue;
    }
    const sessionId = uuid(conversation.id);
    const nativeMessages = array(conversation.messages);
    const timestamps = nativeMessages.map((item) => iso(object(item)?.timestamp, '')).filter((item) => item.length > 0);
    const updatedAt = iso(conversation.updatedAt, timestamps.at(-1) ?? new Date(0).toISOString());
    transformed.sessions.push({
      id: sessionId, title: bounded(string(conversation.title, 'Imported conversation'), 240), kind,
      createdAt: timestamps[0] ?? updatedAt, updatedAt,
    });
    for (const rawMessage of nativeMessages) {
      const message = object(rawMessage);
      if (message === null || string(message.role) === 'activity') continue;
      const role = string(message.role) === 'pet' ? 'assistant' : 'user';
      const nativeStatus = string(message.status, 'completed');
      const status: ChatMessage['status'] = nativeStatus === 'cancelled' || nativeStatus === 'failed'
        ? nativeStatus : nativeStatus === 'interrupted' ? 'failed' : 'complete';
      transformed.messages.push({
        id: uuid(message.id), sessionId, role, content: bounded(string(message.text), 256_000),
        createdAt: iso(message.timestamp, updatedAt), status,
        errorCode: nativeStatus === 'interrupted' ? 'migration.interrupted' : null,
      });
    }
    transformed.imported.conversations = (transformed.imported.conversations ?? 0) + 1;
  }
};

const transformTasks = (value: unknown, transformed: TransformedImport): void => {
  const now = new Date().toISOString();
  for (const entry of array(value)) {
    const task = object(entry);
    if (task === null || string(task.title).trim().length === 0) continue;
    const notes = [string(task.notes), string(task.subject)].filter((item) => item.length > 0).join('\n');
    transformed.tasks.push({
      id: uuid(task.id), title: bounded(string(task.title), 240), notes: bounded(notes, 16_000),
      status: bool(task.done) ? 'done' : 'todo', dueAt: task.due === null || task.due === undefined ? null : iso(task.due),
      createdAt: iso(task.createdAt, now), updatedAt: iso(task.createdAt, now),
    });
  }
  transformed.imported.tasks = transformed.tasks.length;
};

const transformMemories = (value: unknown, transformed: TransformedImport): void => {
  const now = new Date().toISOString();
  for (const entry of array(value)) {
    const memory = object(entry);
    if (memory === null || string(memory.text).trim().length === 0) continue;
    const tags = [string(memory.category), string(memory.scope)].filter((item) => item.length > 0).slice(0, 32);
    transformed.memories.push({
      id: uuid(memory.id), text: bounded(string(memory.text), 32_000), tags, source: 'migration',
      createdAt: iso(memory.createdAt, now), updatedAt: iso(memory.updatedAt, iso(memory.createdAt, now)),
    });
  }
  transformed.imported.memory = transformed.memories.length;
};

const transformRelationship = (value: unknown, transformed: TransformedImport): void => {
  const snapshot = object(value);
  const state = object(snapshot?.state);
  if (snapshot === null || state === null) return;
  const score = Math.max(0, number(state.score));
  transformed.relationship = {
    affinity: Math.min(100, score), level: Math.max(1, Math.min(100, 1 + Math.floor(score / 100))),
    streakDays: 0, lastInteractionAt: null, nickname: '',
  };
  transformed.imported.relationship = 1;
};

const nativeRule = (schedule: unknown): { rrule: string; supported: boolean } => {
  const value = object(schedule);
  if (value === null) return { rrule: 'FREQ=DAILY;INTERVAL=1', supported: false };
  if ('dailyAt' in value) return { rrule: 'FREQ=DAILY;INTERVAL=1', supported: true };
  if ('everySeconds' in value) {
    const raw = value.everySeconds;
    const seconds = typeof raw === 'number' ? raw : number(object(raw)?._0, 60);
    return seconds >= 60 && seconds % 60 === 0
      ? { rrule: `FREQ=MINUTELY;INTERVAL=${Math.min(10_000, Math.max(1, seconds / 60))}`, supported: true }
      : { rrule: 'FREQ=MINUTELY;INTERVAL=1', supported: false };
  }
  return { rrule: 'FREQ=DAILY;INTERVAL=1', supported: false };
};

const transformSchedules = (value: unknown, transformed: TransformedImport): void => {
  for (const entry of array(value)) {
    const schedule = object(entry);
    if (schedule === null || string(schedule.title).trim().length === 0) continue;
    const rule = nativeRule(schedule.schedule);
    if (!rule.supported) transformed.warnings.push(`schedule-disabled:${string(schedule.id)}`);
    transformed.schedules.push({
      id: uuid(schedule.id), title: bounded(string(schedule.title), 240),
      enabled: bool(schedule.enabled) && rule.supported, kind: string(schedule.source) === 'agent' ? 'agent' : 'reminder',
      rrule: rule.rrule, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      payload: { prompt: bounded(string(schedule.prompt), 32_000), migratedNativeSchedule: schedule.schedule ?? null },
      nextRunAt: schedule.nextFireAt === null || schedule.nextFireAt === undefined ? null : iso(schedule.nextFireAt),
      lastRunStatus: 'never',
    });
  }
  transformed.imported.schedules = transformed.schedules.length;
};

const providerKind = (provider: Record<string, unknown>): ProviderKind | null => {
  const nativeType = string(provider.type);
  if (nativeType === 'ollama') return 'ollama';
  if (nativeType === 'lmStudio') return 'lm-studio';
  if (nativeType !== 'openAICompatible') return null;
  const fingerprint = `${string(provider.displayName)} ${string(provider.baseURL)}`.toLowerCase();
  if (fingerprint.includes('deepseek')) return 'deepseek';
  if (fingerprint.includes('minimax')) return 'minimax';
  if (fingerprint.includes('bigmodel') || fingerprint.includes('zhipu') || fingerprint.includes('glm')) return 'glm';
  if (fingerprint.includes('api.openai.com')) return 'openai';
  return 'openai-compatible';
};

const transformProviders = (value: unknown, transformed: TransformedImport): void => {
  const root = object(value);
  for (const entry of array(root?.providers)) {
    const provider = object(entry);
    if (provider === null) continue;
    const kind = providerKind(provider);
    if (kind === null) {
      transformed.skipped.providers = (transformed.skipped.providers ?? 0) + 1;
      transformed.warnings.push(`unsupported-provider:${string(provider.type, 'unknown')}`);
      continue;
    }
    const baseUrl = string(provider.baseURL);
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
    } catch {
      transformed.skipped.providers = (transformed.skipped.providers ?? 0) + 1;
      transformed.warnings.push(`invalid-provider-url:${string(provider.id, 'unknown')}`);
      continue;
    }
    const id = uuid(provider.id);
    transformed.providers.push({
      id, kind, name: bounded(string(provider.displayName, kind), 240), baseUrl,
      model: bounded(string(provider.defaultModelID, 'not-selected'), 240), enabled: bool(provider.enabled),
      supportsTools: array(provider.capabilities).includes('toolCalling'), secretState: 'missing',
    });
    const nativeSecretID = string(provider.apiKeySecretID);
    if (nativeSecretID.length > 0) transformed.providerSecretIDs.set(id, nativeSecretID);
  }
  transformed.imported.providers = transformed.providers.length;
};

const transformAppearance = (value: unknown, transformed: TransformedImport): void => {
  const appearance = object(object(value)?.appearance);
  if (appearance === null) return;
  const height = number(
    appearance.characterHeight,
    string(appearance.petSize) === 'small' ? 160 : string(appearance.petSize) === 'large' ? 360 : 240,
  );
  transformed.appearanceScale = Math.max(0.2, Math.min(3, height / 240));
  transformed.imported.appearance = 1;
};

const transformModel = (value: unknown, sourceRoot: string, transformed: TransformedImport): void => {
  const selection = object(object(value)?.character);
  const relativePath = string(selection?.relativePath);
  if (relativePath.toLowerCase().endsWith('.zip') && !relativePath.startsWith('/') && !relativePath.split('/').includes('..')) {
    transformed.nativeModelArchive = join(sourceRoot, 'Characters', 'Live2D', relativePath);
  } else if (selection !== null) {
    transformed.warnings.push('live2d-model-selection-needs-zip-reimport');
    transformed.skipped['live2d-model'] = 1;
  }
};

const transform = (result: HelperResult, selected: Set<MigrationCategory>): TransformedImport => {
  const transformed = emptyTransform();
  if (selected.has('conversations')) transformConversations(result.values.conversations, transformed);
  if (selected.has('tasks')) transformTasks(result.values.tasks, transformed);
  if (selected.has('memory')) transformMemories(result.values.memory, transformed);
  if (selected.has('relationship')) transformRelationship(result.values.relationship, transformed);
  if (selected.has('schedules')) transformSchedules(result.values.schedules, transformed);
  if (selected.has('providers')) transformProviders(result.values.providers, transformed);
  if (selected.has('appearance')) transformAppearance(result.values.appearance, transformed);
  if (selected.has('live2d-model')) transformModel(result.values['live2d-model'], result.sourcePath, transformed);
  return transformed;
};

const isEmptyProfile = (repository: DomainRepository): boolean => {
  const state = repository.snapshot();
  return state.chatSessions.length === 0 && state.chatMessages.length === 0 && state.tasks.length === 0 &&
    state.focus === null && state.memories.length === 0 && state.schedules.length === 0 && state.providers.length === 0 &&
    state.persistentPermissionGrants.length === 0 && state.sideEffects.length === 0 && state.relationship.affinity === 0 &&
    state.relationship.level === 1 && state.relationship.streakDays === 0 && state.relationship.nickname.length === 0;
};

export interface NativeMigrationServiceOptions {
  platform?: NodeJS.Platform;
  runner: MigrationHelperRunner;
  sourcePath: string;
  dataRoot: string;
  repository: DomainRepository;
  vault: SafeStorageVault;
  character: CharacterService;
  onProgress?: (progress: ImportProgress) => void;
}

export class NativeMigrationService {
  readonly #platform: NodeJS.Platform;
  readonly #markerPath: string;
  #abort: AbortController | null = null;

  constructor(private readonly options: NativeMigrationServiceOptions) {
    this.#platform = options.platform ?? process.platform;
    this.#markerPath = join(options.dataRoot, 'migration', 'native-import.json');
  }

  async #markerExists(): Promise<boolean> {
    try { await access(this.#markerPath); return true; } catch { return false; }
  }

  async preview(): Promise<MigrationPreview> {
    if (this.#platform !== 'darwin') {
      return { available: false, sourcePath: null, sourceDigest: null, requiresKeychainConfirmation: false, categories: [], warnings: ['macos-only'] };
    }
    if (await this.#markerExists()) {
      return { available: false, sourcePath: this.options.sourcePath, sourceDigest: null, requiresKeychainConfirmation: false, categories: [], warnings: ['already-imported'] };
    }
    try { await access(this.options.sourcePath); } catch {
      return { available: false, sourcePath: this.options.sourcePath, sourceDigest: null, requiresKeychainConfirmation: false, categories: [], warnings: ['native-profile-not-found'] };
    }
    const { result } = await this.options.runner.run('preview', this.options.sourcePath, false, new AbortController().signal);
    const empty = isEmptyProfile(this.options.repository);
    return {
      available: empty, sourcePath: result.sourcePath, sourceDigest: result.sourceDigest,
      requiresKeychainConfirmation: result.requiresKeychainConfirmation, categories: result.categories,
      warnings: [...result.warnings, ...(empty ? [] : ['electron-profile-not-empty'])],
    };
  }

  cancel(): void { this.#abort?.abort(); }

  async start(categoryValues: string[], confirmProviderSecrets: boolean): Promise<MigrationResult> {
    if (this.#platform !== 'darwin') throw new Error('Native migration is available on macOS only.');
    if (this.#abort !== null) throw new Error('A native migration is already running.');
    if (await this.#markerExists()) throw new Error('Native data has already been imported into this profile.');
    if (!isEmptyProfile(this.options.repository)) throw new Error('Native migration requires an empty Electron profile.');
    const selected = new Set(categoryValues.map((value) => z.enum(CATEGORY_IDS).parse(value)));
    if (selected.size === 0) throw new Error('Select at least one migration category.');
    const controller = new AbortController();
    this.#abort = controller;
    const originalState = this.options.repository.snapshot();
    const originalScale = (await this.options.character.getState()).scale;
    const emit = (phase: ImportProgress['phase'], completed: number, total: number, messageCode: string): void =>
      this.options.onProgress?.({ phase, completed, total, messageCode });
    const importedSecretProviderIDs: string[] = [];
    let repositoryCommitted = false;
    let modelStaged = false;
    try {
      emit('validating', 0, 5, 'migration.validating');
      const before = await this.options.runner.run('preview', this.options.sourcePath, false, controller.signal);
      emit('copying', 1, 5, 'migration.backup');
      const backupPath = join(dirname(this.options.dataRoot), `DeskPet Electron.migration-backup-${Date.now()}`);
      await cp(this.options.dataRoot, backupPath, { recursive: true, force: false, errorOnExist: true });
      emit('extracting', 2, 5, 'migration.decrypting');
      const exported = await this.options.runner.run(
        'export', this.options.sourcePath, confirmProviderSecrets && selected.has('providers'), controller.signal,
      );
      if (exported.result.sourceDigest !== before.result.sourceDigest) throw new Error('Native data changed during migration; retry from a stable source.');
      if (controller.signal.aborted) throw new DOMException('Migration cancelled.', 'AbortError');
      const transformed = transform(exported.result, selected);
      emit('loading', 3, 5, 'migration.importing');
      for (const [providerID, nativeSecretID] of transformed.providerSecretIDs) {
        const secret = exported.secrets.secrets[nativeSecretID];
        if (confirmProviderSecrets && secret !== undefined) {
          await this.options.vault.setSecret(providerID, secret);
          importedSecretProviderIDs.push(providerID);
          const provider = transformed.providers.find((item) => item.id === providerID);
          if (provider !== undefined) provider.secretState = 'configured';
        }
      }
      if (transformed.appearanceScale !== null) await this.options.character.setScale(transformed.appearanceScale);
      if (transformed.nativeModelArchive !== null) {
        try {
          await access(transformed.nativeModelArchive);
          await this.options.character.stageModelArchive(transformed.nativeModelArchive);
          modelStaged = true;
          transformed.imported['live2d-model'] = 1;
        } catch {
          transformed.skipped['live2d-model'] = 1;
          transformed.warnings.push('live2d-model-archive-unavailable');
        }
      }
      await this.options.repository.transaction((state) => {
        state.chatSessions = transformed.sessions;
        state.chatMessages = transformed.messages;
        state.tasks = transformed.tasks;
        state.memories = transformed.memories;
        if (transformed.relationship !== null) state.relationship = transformed.relationship;
        state.schedules = transformed.schedules;
        state.providers = transformed.providers;
      });
      repositoryCommitted = true;
      transformed.warnings.push(...exported.result.warnings, ...exported.secrets.warnings);
      emit('committing', 4, 5, 'migration.committing');
      const result: MigrationResult = {
        markerId: randomUUID(), imported: transformed.imported, skipped: transformed.skipped,
        warnings: transformed.warnings, sourceDigest: exported.result.sourceDigest, completedAt: new Date().toISOString(),
      };
      await atomicWriteFile(this.#markerPath, `${JSON.stringify({ version: 1, ...result })}\n`);
      emit('complete', 5, 5, 'migration.complete');
      return result;
    } catch (error) {
      for (const providerID of importedSecretProviderIDs) await this.options.vault.deleteSecret(providerID).catch(() => undefined);
      if (repositoryCommitted) {
        await this.options.repository.transaction((state) => { Object.assign(state, originalState); }).catch(() => undefined);
      }
      await this.options.character.setScale(originalScale).catch(() => undefined);
      if (modelStaged) await this.options.character.cancelImport().catch(() => undefined);
      emit(controller.signal.aborted ? 'cancelled' : 'failed', 0, 5, controller.signal.aborted ? 'migration.cancelled' : 'migration.failed');
      throw error;
    } finally {
      this.#abort = null;
    }
  }

  async readMarker(): Promise<unknown | null> {
    try { return JSON.parse(await readFile(this.#markerPath, 'utf8')) as unknown; } catch { return null; }
  }
}
