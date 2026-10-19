import type { MinecraftConnectionConfig, MinecraftControlAction, MinecraftSnapshot } from './minecraft';

export const API_VERSION = 1 as const;

export type ApiVersion = typeof API_VERSION;
export type Locale = 'system' | 'en' | 'zh-CN';
export type ResolvedLocale = Exclude<Locale, 'system'>;
export type Theme = 'system' | 'light' | 'dark';
export type WindowRole = 'console' | 'overlay';
export type CapabilityState = 'available' | 'degraded' | 'unavailable';
export type RiskLevel = 'low' | 'medium' | 'high';
export type SecretState = 'configured' | 'missing' | 'unavailable';
export type ProviderKind =
  | 'openai'
  | 'openai-compatible'
  | 'minimax'
  | 'glm'
  | 'deepseek'
  | 'ollama'
  | 'lm-studio';

export interface PlatformCapability {
  id:
    | 'overlay-position'
    | 'always-on-top'
    | 'precise-click-through'
    | 'global-shortcut'
    | 'tray'
    | 'notifications'
    | 'auto-launch'
    | 'secret-storage'
    | 'native-migration';
  state: CapabilityState;
  reasonCode: string;
  requiredPermission: string | null;
  canRequestPermission: boolean;
}

export interface AppState {
  version: string;
  platform: NodeJS.Platform;
  locale: Locale;
  resolvedLocale: ResolvedLocale;
  theme: Theme;
  hotkey: string;
  hotkeyRegistered: boolean;
  autoLaunch: boolean;
  dataDirectory: string;
  capabilities: PlatformCapability[];
}

export interface DiagnosticSnapshot {
  generatedAt: string;
  appVersion: string;
  electronVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  sessionType: string | null;
  windowRoles: WindowRole[];
  capabilities: PlatformCapability[];
  vault: { state: 'ready' | 'locked' | 'unavailable'; backend: string };
  core: { state: 'missing' | 'ready' | 'invalid'; hash: string | null };
  model: { state: 'missing' | 'ready' | 'invalid'; name: string | null };
  providerSecrets: Record<string, SecretState>;
}

export interface CharacterState {
  coreState: 'missing' | 'ready' | 'invalid';
  modelState: 'missing' | 'loading' | 'ready' | 'invalid';
  coreUrl: string | null;
  modelUrl: string | null;
  pendingImportId: string | null;
  modelName: string | null;
  scale: number;
  position: { displayId: string; x: number; y: number } | null;
  expression: string | null;
  action: string | null;
  bubble: string | null;
}

export interface ImportProgress {
  phase: 'validating' | 'copying' | 'extracting' | 'loading' | 'committing' | 'complete' | 'failed' | 'cancelled';
  completed: number;
  total: number;
  messageCode: string;
}

export interface ChatSession {
  id: string;
  title: string;
  kind: 'normal' | 'project';
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  createdAt: string;
  status: 'streaming' | 'complete' | 'cancelled' | 'failed';
  errorCode: string | null;
}

export type ChatEvent =
  | { type: 'started'; runId: string; sessionId: string; messageId: string }
  | { type: 'delta'; runId: string; messageId: string; text: string }
  | { type: 'tool'; runId: string; taskId: string; toolId: string; status: TaskRunStatus }
  | { type: 'finished'; runId: string; message: ChatMessage }
  | { type: 'failed'; runId: string; messageId: string; errorCode: string };

export interface DeskTask {
  id: string;
  title: string;
  notes: string;
  status: 'todo' | 'doing' | 'done' | 'cancelled';
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FocusSession {
  id: string;
  taskId: string | null;
  startedAt: string;
  plannedSeconds: number;
  elapsedSeconds: number;
  status: 'running' | 'paused' | 'completed' | 'cancelled';
}

export interface MemoryItem {
  id: string;
  text: string;
  tags: string[];
  source: 'user' | 'assistant' | 'migration';
  createdAt: string;
  updatedAt: string;
}

export interface RelationshipState {
  affinity: number;
  level: number;
  streakDays: number;
  lastInteractionAt: string | null;
  nickname: string;
}

export interface ScheduleDefinition {
  id: string;
  title: string;
  enabled: boolean;
  kind: 'reminder' | 'focus' | 'agent';
  rrule: string;
  timezone: string;
  payload: Record<string, unknown>;
  nextRunAt: string | null;
  lastRunStatus: 'never' | 'succeeded' | 'failed' | 'missed';
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  supportsTools: boolean;
  secretState: SecretState;
}

export interface ProviderModel {
  id: string;
  displayName: string;
  contextWindow: number | null;
  supportsTools: boolean;
}

export interface PermissionDescriptor {
  capabilityId: string;
  titleCode: string;
  detailCode: string;
  risk: RiskLevel;
  state: 'not-requested' | 'session' | 'always' | 'denied';
  expiresAt: string | null;
}

export type TaskRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting-approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'missed';

export interface TaskRunEvent {
  id: string;
  runId: string;
  sequence: number;
  createdAt: string;
  type: 'state' | 'model' | 'tool' | 'approval' | 'effect' | 'error';
  status: TaskRunStatus;
  summary: string;
  metadata: Record<string, unknown>;
}

export interface MigrationPreview {
  available: boolean;
  sourcePath: string | null;
  sourceDigest: string | null;
  requiresKeychainConfirmation: boolean;
  categories: Array<{
    id: 'conversations' | 'memory' | 'tasks' | 'relationship' | 'schedules' | 'providers' | 'appearance' | 'live2d-model';
    count: number;
    containsSecrets: boolean;
  }>;
  warnings: string[];
}

export interface MigrationResult {
  markerId: string;
  imported: Record<string, number>;
  skipped: Record<string, number>;
  warnings: string[];
  sourceDigest: string;
  completedAt: string;
}

export type Unsubscribe = () => void;

export interface DeskPetApi {
  minecraft: {
    getState(): Promise<MinecraftSnapshot>;
    connect(config: MinecraftConnectionConfig): Promise<MinecraftSnapshot>;
    disconnect(): Promise<MinecraftSnapshot>;
    submit(command: string): Promise<MinecraftSnapshot>;
    control(action: MinecraftControlAction): Promise<MinecraftSnapshot>;
    sendChat(message: string): Promise<MinecraftSnapshot>;
    onChanged(listener: (state: MinecraftSnapshot) => void): Unsubscribe;
  };
  app: {
    getState(): Promise<AppState>;
    setLocale(locale: Locale): Promise<AppState>;
    setTheme(theme: Theme): Promise<AppState>;
    setHotkey(accelerator: string): Promise<AppState>;
    setAutoLaunch(enabled: boolean): Promise<AppState>;
    showConsole(): Promise<void>;
    setOverlayVisible(visible: boolean): Promise<void>;
    getDiagnostics(): Promise<DiagnosticSnapshot>;
    onChanged(listener: (state: AppState) => void): Unsubscribe;
  };
  character: {
    getState(): Promise<CharacterState>;
    importCore(): Promise<CharacterState>;
    importModel(): Promise<CharacterState>;
    cancelImport(): Promise<void>;
    acknowledgeModelLoaded(importId: string): Promise<CharacterState>;
    setScale(scale: number): Promise<CharacterState>;
    setPosition(position: CharacterState['position']): Promise<CharacterState>;
    playAction(action: string): Promise<void>;
    setExpression(expression: string | null): Promise<void>;
    setBubble(text: string | null): Promise<void>;
    setInteractive(interactive: boolean): Promise<void>;
    onChanged(listener: (state: CharacterState) => void): Unsubscribe;
    onImportProgress(listener: (progress: ImportProgress) => void): Unsubscribe;
  };
  chat: {
    listSessions(): Promise<ChatSession[]>;
    createSession(input: { title: string; kind: ChatSession['kind'] }): Promise<ChatSession>;
    listMessages(sessionId: string): Promise<ChatMessage[]>;
    send(input: { sessionId: string; content: string; providerId: string }): Promise<{ runId: string }>;
    cancel(runId: string): Promise<void>;
    retry(messageId: string): Promise<{ runId: string }>;
    onEvent(listener: (event: ChatEvent) => void): Unsubscribe;
  };
  tasks: {
    list(): Promise<DeskTask[]>;
    upsert(input: Pick<DeskTask, 'id' | 'title' | 'notes' | 'status' | 'dueAt'>): Promise<DeskTask>;
    remove(id: string): Promise<void>;
    getFocus(): Promise<FocusSession | null>;
    startFocus(input: { taskId: string | null; plannedSeconds: number }): Promise<FocusSession>;
    pauseFocus(): Promise<FocusSession>;
    resumeFocus(): Promise<FocusSession>;
    stopFocus(status: 'completed' | 'cancelled'): Promise<FocusSession>;
    listRunEvents(): Promise<TaskRunEvent[]>;
    onChanged(listener: () => void): Unsubscribe;
  };
  memory: {
    list(): Promise<MemoryItem[]>;
    upsert(input: Pick<MemoryItem, 'id' | 'text' | 'tags'>): Promise<MemoryItem>;
    remove(id: string): Promise<void>;
    onChanged(listener: (items: MemoryItem[]) => void): Unsubscribe;
  };
  relationship: {
    get(): Promise<RelationshipState>;
    setNickname(nickname: string): Promise<RelationshipState>;
    onChanged(listener: (state: RelationshipState) => void): Unsubscribe;
  };
  schedule: {
    list(): Promise<ScheduleDefinition[]>;
    upsert(input: Omit<ScheduleDefinition, 'nextRunAt' | 'lastRunStatus'>): Promise<ScheduleDefinition>;
    remove(id: string): Promise<void>;
    runNow(id: string): Promise<{ runId: string }>;
    onChanged(listener: (items: ScheduleDefinition[]) => void): Unsubscribe;
  };
  providers: {
    list(): Promise<ProviderConfig[]>;
    upsert(input: Omit<ProviderConfig, 'secretState'> & { apiKey?: string }): Promise<ProviderConfig>;
    remove(id: string): Promise<void>;
    clearSecret(id: string): Promise<ProviderConfig>;
    test(id: string): Promise<{ ok: boolean; messageCode: string; latencyMs: number | null }>;
    listModels(id: string): Promise<ProviderModel[]>;
    onChanged(listener: (items: ProviderConfig[]) => void): Unsubscribe;
  };
  permissions: {
    list(): Promise<PermissionDescriptor[]>;
    request(input: { capabilityId: string; duration: 'once' | 'session' | 'always' }): Promise<PermissionDescriptor>;
    revoke(capabilityId: string): Promise<PermissionDescriptor>;
    onChanged(listener: (items: PermissionDescriptor[]) => void): Unsubscribe;
  };
  migration: {
    preview(): Promise<MigrationPreview>;
    start(input: { categories: string[]; confirmProviderSecrets: boolean }): Promise<MigrationResult>;
    cancel(): Promise<void>;
    onProgress(listener: (progress: ImportProgress) => void): Unsubscribe;
  };
}
