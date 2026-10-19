import { contextBridge, ipcRenderer } from 'electron';

import { API_VERSION } from '../shared';
import type {
  AppState,
  CharacterState,
  ChatEvent,
  DeskPetApi,
  ImportProgress,
  MemoryItem,
  MinecraftSnapshot,
  PermissionDescriptor,
  ProviderConfig,
  RelationshipState,
  ScheduleDefinition,
  Unsubscribe,
} from '../shared';
import type { EventChannel, InvokeChannel, InvokePayload } from '../shared';

const invoke = <T, C extends InvokeChannel>(channel: C, payload: InvokePayload<C>): Promise<T> =>
  ipcRenderer.invoke(channel, { version: API_VERSION, payload }) as Promise<T>;

const on = <T>(channel: EventChannel, listener: (value: T) => void): Unsubscribe => {
  const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => listener(value as T);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

const api: DeskPetApi = {
  minecraft: {
    getState: () => invoke('minecraft:get-state', {}),
    connect: (config) => invoke('minecraft:connect', config),
    disconnect: () => invoke('minecraft:disconnect', {}),
    submit: (command) => invoke('minecraft:submit', { command }),
    control: (action) => invoke('minecraft:control', { action }),
    sendChat: (message) => invoke('minecraft:chat', { message }),
    onChanged: (listener) => on<MinecraftSnapshot>('minecraft:changed', listener),
  },
  app: {
    getState: () => invoke('app:get-state', {}),
    setLocale: (locale) => invoke('app:set-locale', { locale }),
    setTheme: (theme) => invoke('app:set-theme', { theme }),
    setHotkey: (accelerator) => invoke('app:set-hotkey', { accelerator }),
    setAutoLaunch: (enabled) => invoke('app:set-auto-launch', { enabled }),
    showConsole: () => invoke('app:show-console', {}),
    setOverlayVisible: (visible) => invoke('app:set-overlay-visible', { visible }),
    getDiagnostics: () => invoke('app:get-diagnostics', {}),
    onChanged: (listener) => on<AppState>('app:changed', listener),
  },
  character: {
    getState: () => invoke('character:get-state', {}),
    importCore: () => invoke('character:import-core', {}),
    importModel: () => invoke('character:import-model', {}),
    cancelImport: () => invoke('character:cancel-import', {}),
    acknowledgeModelLoaded: (importId) => invoke('character:ack-model-loaded', { importId }),
    setScale: (scale) => invoke('character:set-scale', { scale }),
    setPosition: (position) => invoke('character:set-position', { position }),
    playAction: (action) => invoke('character:play-action', { action }),
    setExpression: (expression) => invoke('character:set-expression', { expression }),
    setBubble: (text) => invoke('character:set-bubble', { text }),
    setInteractive: (interactive) => invoke('character:set-interactive', { interactive }),
    onChanged: (listener) => on<CharacterState>('character:changed', listener),
    onImportProgress: (listener) => on<ImportProgress>('character:import-progress', listener),
  },
  chat: {
    listSessions: () => invoke('chat:list-sessions', {}),
    createSession: (input) => invoke('chat:create-session', input),
    listMessages: (sessionId) => invoke('chat:list-messages', { sessionId }),
    send: (input) => invoke('chat:send', input),
    cancel: (runId) => invoke('chat:cancel', { runId }),
    retry: (messageId) => invoke('chat:retry', { messageId }),
    onEvent: (listener) => on<ChatEvent>('chat:event', listener),
  },
  tasks: {
    list: () => invoke('tasks:list', {}),
    upsert: (input) => invoke('tasks:upsert', input),
    remove: (id) => invoke('tasks:remove', { id }),
    getFocus: () => invoke('tasks:get-focus', {}),
    startFocus: (input) => invoke('tasks:start-focus', input),
    pauseFocus: () => invoke('tasks:pause-focus', {}),
    resumeFocus: () => invoke('tasks:resume-focus', {}),
    stopFocus: (status) => invoke('tasks:stop-focus', { status }),
    listRunEvents: () => invoke('tasks:list-run-events', {}),
    onChanged: (listener) => on<null>('tasks:changed', listener),
  },
  memory: {
    list: () => invoke('memory:list', {}),
    upsert: (input) => invoke('memory:upsert', input),
    remove: (id) => invoke('memory:remove', { id }),
    onChanged: (listener) => on<MemoryItem[]>('memory:changed', listener),
  },
  relationship: {
    get: () => invoke('relationship:get', {}),
    setNickname: (nickname) => invoke('relationship:set-nickname', { nickname }),
    onChanged: (listener) => on<RelationshipState>('relationship:changed', listener),
  },
  schedule: {
    list: () => invoke('schedule:list', {}),
    upsert: (input) => invoke('schedule:upsert', input),
    remove: (id) => invoke('schedule:remove', { id }),
    runNow: (id) => invoke('schedule:run-now', { id }),
    onChanged: (listener) => on<ScheduleDefinition[]>('schedule:changed', listener),
  },
  providers: {
    list: () => invoke('providers:list', {}),
    upsert: (input) => invoke('providers:upsert', input),
    remove: (id) => invoke('providers:remove', { id }),
    clearSecret: (id) => invoke('providers:clear-secret', { id }),
    test: (id) => invoke('providers:test', { id }),
    listModels: (id) => invoke('providers:list-models', { id }),
    onChanged: (listener) => on<ProviderConfig[]>('providers:changed', listener),
  },
  permissions: {
    list: () => invoke('permissions:list', {}),
    request: (input) => invoke('permissions:request', input),
    revoke: (capabilityId) => invoke('permissions:revoke', { capabilityId }),
    onChanged: (listener) => on<PermissionDescriptor[]>('permissions:changed', listener),
  },
  migration: {
    preview: () => invoke('migration:preview', {}),
    start: (input) => invoke('migration:start', input),
    cancel: () => invoke('migration:cancel', {}),
    onProgress: (listener) => on<ImportProgress>('migration:progress', listener),
  },
};

contextBridge.exposeInMainWorld('deskpet', Object.freeze(api));
