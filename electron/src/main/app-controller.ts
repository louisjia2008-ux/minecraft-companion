import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app, globalShortcut, nativeTheme, Notification, safeStorage, screen, session } from 'electron';

import type {
  AppState,
  ChatEvent,
  DiagnosticSnapshot,
  PermissionDescriptor,
  ProviderConfig,
  ResolvedLocale,
  ScheduleDefinition,
} from '../shared';
import { resolveLocale, resolvePlatformCapabilities } from '../shared';
import { AppSettingsService } from './app-settings';
import { MinecraftService } from './minecraft';
import { CharacterService } from './character-service';
import { ChatService, DomainRepository, MemoryService, RelationshipService, ScheduleService, TaskService } from './domain';
import { IpcRouter } from './ipc-router';
import { NativeMigrationService, ProcessMigrationHelperRunner } from './migration';
import { SafeStorageVault } from './security';
import { ProviderService, ProviderUtilityClient } from './providers';
import type { ModelDecision, ModelDriver, ModelTurnMessage } from './runtime';
import { AgentRuntime, EffectLedger, PermissionGate, RuntimeScheduler, TaskEventStream, ToolRegistry } from './runtime';
import { registerBuiltinTools, SecureWebReader, WorkspaceAccess } from './tools';
import type { WindowManager } from './window-manager';

const PERMISSION_DESCRIPTORS: ReadonlyArray<Omit<PermissionDescriptor, 'state' | 'expiresAt'>> = [
  { capabilityId: 'time.read', titleCode: 'permission.time', detailCode: 'permission.time.detail', risk: 'low' },
  { capabilityId: 'system.read', titleCode: 'permission.system', detailCode: 'permission.system.detail', risk: 'low' },
  { capabilityId: 'timer.write', titleCode: 'permission.timer', detailCode: 'permission.timer.detail', risk: 'medium' },
  { capabilityId: 'notification.write', titleCode: 'permission.notification', detailCode: 'permission.notification.detail', risk: 'medium' },
  { capabilityId: 'workspace.read', titleCode: 'permission.workspaceRead', detailCode: 'permission.workspaceRead.detail', risk: 'medium' },
  { capabilityId: 'workspace.write', titleCode: 'permission.workspaceWrite', detailCode: 'permission.workspaceWrite.detail', risk: 'high' },
  { capabilityId: 'web.read', titleCode: 'permission.web', detailCode: 'permission.web.detail', risk: 'medium' },
];

export class AppController {
  readonly #dataRoot: string;
  readonly #managedRoot: string;
  readonly #settings: AppSettingsService;
  readonly #character: CharacterService;
  readonly #vault: SafeStorageVault;
  readonly #repository: DomainRepository;
  readonly #chat: ChatService;
  readonly #tasks: TaskService;
  readonly #memory: MemoryService;
  readonly #relationship: RelationshipService;
  readonly #schedules: ScheduleService;
  readonly #permissions: PermissionGate;
  readonly #events: TaskEventStream;
  readonly #tools = new ToolRegistry();
  readonly #utility: ProviderUtilityClient;
  readonly #providers: ProviderService;
  readonly #migration: NativeMigrationService;
  readonly #minecraft: MinecraftService;
  readonly #agent: AgentRuntime;
  readonly #scheduler: RuntimeScheduler;
  readonly #ipc: IpcRouter;
  #hotkeyRegistered = false;
  #windowTrackingAttached = false;
  #schedulerTimer: NodeJS.Timeout | null = null;
  #schedulerTicking = false;

  constructor(private readonly windows: WindowManager) {
    this.#dataRoot = app.getPath('userData');
    this.#managedRoot = join(this.#dataRoot, 'managed');
    this.#settings = new AppSettingsService(join(this.#dataRoot, 'settings.json'));
    this.#character = new CharacterService(this.#managedRoot);
    this.#vault = new SafeStorageVault(join(this.#dataRoot, 'vault'), safeStorage);
    this.#repository = new DomainRepository(join(this.#dataRoot, 'profile.enc.json'), this.#vault);
    this.#chat = new ChatService(this.#repository);
    this.#tasks = new TaskService(this.#repository);
    this.#memory = new MemoryService(this.#repository);
    this.#relationship = new RelationshipService(this.#repository);
    this.#schedules = new ScheduleService(this.#repository);
    this.#events = new TaskEventStream(join(this.#dataRoot, 'events', 'tasks.jsonl'));
    this.#permissions = new PermissionGate(this.#repository, (audit) => {
      void this.#events.emit(randomUUID(), 'approval', 'succeeded', `Permission ${audit.action}.`, {
        capabilityId: audit.capabilityId,
        action: audit.action,
        scope: audit.scope,
        createdAt: audit.createdAt,
      });
    });
    this.#utility = new ProviderUtilityClient();
    this.#providers = new ProviderService(this.#repository, this.#vault, this.#utility);
    const runtimePaths = app.isPackaged
      ? [join(process.resourcesPath, 'minecraft-runtime', 'bridge.js')]
      : [app.getAppPath(), __dirname].flatMap((base) => [0, 1, 2, 3, 4].map((depth) =>
        join(base, ...Array<string>(depth).fill('..'), 'minecraft-runtime', 'bridge.js')));
    this.#minecraft = new MinecraftService({
      runtimePath: runtimePaths.find((path) => existsSync(path)) ?? runtimePaths[0] as string,
      dataDirectory: join(this.#dataRoot, 'minecraft'),
      providers: this.#providers,
      onChanged: (state) => this.windows.send('console', 'minecraft:changed', state),
      onSpeech: (text) => { this.#character.setBubble(text); void this.#emitCharacter(); },
    });
    const helperPath = app.isPackaged
      ? join(process.resourcesPath, 'DeskPetMigrationHelper')
      : join(app.getAppPath(), 'migration', 'bin', 'DeskPetMigrationHelper');
    this.#migration = new NativeMigrationService({
      runner: new ProcessMigrationHelperRunner(helperPath),
      sourcePath: join(app.getPath('appData'), 'DeskPet'),
      dataRoot: this.#dataRoot,
      repository: this.#repository,
      vault: this.#vault,
      character: this.#character,
      onProgress: (progress) => this.windows.send('console', 'migration:progress', progress),
    });
    this.#agent = new AgentRuntime(this.#tools, this.#permissions, new EffectLedger(this.#repository), this.#events);
    this.#scheduler = new RuntimeScheduler(
      this.#schedules,
      this.#events,
      (schedule, runId) => this.#executeSchedule(schedule, runId),
    );
    this.#ipc = new IpcRouter(windows);
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.#dataRoot, 'workspace'), { recursive: true, mode: 0o700 });
    await Promise.all([this.#settings.initialize(), this.#character.initialize(), this.#repository.initialize(), this.#events.initialize()]);
    registerBuiltinTools(this.#tools, {
      workspace: new WorkspaceAccess(join(this.#dataRoot, 'workspace')),
      web: new SecureWebReader(),
      notify: async (title, body) => new Notification({ title, body }).show(),
      createTimer: async (seconds, label) => {
        const timerId = randomUUID();
        setTimeout(() => new Notification({ title: label || 'DeskPet timer', body: 'Timer complete.' }).show(), seconds * 1_000);
        return { timerId };
      },
    });
    this.#configureSession();
    this.#registerIpc();
    this.#applyAppearance();
    this.#registerHotkey(this.#settings.get().hotkey);
    app.setLoginItemSettings({ openAtLogin: this.#settings.get().autoLaunch });
    await this.#scheduler.markStartupMisses();
    this.#schedulerTimer = setInterval(() => { void this.#tickScheduler(); }, 30_000);
  }

  async attachWindows(): Promise<void> {
    if (this.#windowTrackingAttached) return;
    const overlay = this.windows.overlayWindow();
    if (overlay === null) return;
    this.#windowTrackingAttached = true;
    const character = await this.#character.getState();
    if (character.position !== null) {
      const display = screen.getAllDisplays().find((item) => String(item.id) === character.position?.displayId);
      if (display !== undefined) {
        const bounds = overlay.getBounds();
        const area = display.workArea;
        overlay.setPosition(
          Math.max(area.x, Math.min(character.position.x, area.x + area.width - bounds.width)),
          Math.max(area.y, Math.min(character.position.y, area.y + area.height - bounds.height)),
          false,
        );
      }
    }
    overlay.on('moved', () => {
      const bounds = overlay.getBounds();
      const display = screen.getDisplayMatching(bounds);
      void this.#character.setPosition({ displayId: String(display.id), x: bounds.x, y: bounds.y });
    });
  }

  #configureSession(): void {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'",
          ],
          'X-Content-Type-Options': ['nosniff'],
        },
      });
    });
  }

  #resolvedLocale(): ResolvedLocale {
    const locale = this.#settings.get().locale;
    return locale === 'system' ? resolveLocale(app.getLocale()) : locale;
  }

  #capabilities() {
    return resolvePlatformCapabilities({
      platform: process.platform,
      sessionType: process.env.XDG_SESSION_TYPE ?? null,
      secretStorageAvailable: this.#vault.isAvailable(),
      globalShortcutsPortalEnabled: app.commandLine.hasSwitch('enable-features') && app.commandLine.getSwitchValue('enable-features').includes('GlobalShortcutsPortal'),
    });
  }

  #appState(): AppState {
    const settings = this.#settings.get();
    return {
      version: app.getVersion(),
      platform: process.platform,
      locale: settings.locale,
      resolvedLocale: this.#resolvedLocale(),
      theme: settings.theme,
      hotkey: settings.hotkey,
      hotkeyRegistered: this.#hotkeyRegistered,
      autoLaunch: settings.autoLaunch,
      dataDirectory: this.#dataRoot,
      capabilities: this.#capabilities(),
    };
  }

  #applyAppearance(): void {
    nativeTheme.themeSource = this.#settings.get().theme;
  }

  #registerHotkey(accelerator: string): void {
    globalShortcut.unregisterAll();
    this.#hotkeyRegistered = globalShortcut.register(accelerator, () => this.windows.showConsole());
  }

  #emitApp(): void { this.windows.broadcast('app:changed', this.#appState()); }
  async #emitCharacter(): Promise<void> { this.windows.broadcast('character:changed', await this.#character.getState()); }
  #emitPermissions(): void { this.windows.send('console', 'permissions:changed', this.#permissions.list(PERMISSION_DESCRIPTORS)); }

  #registerIpc(): void {
    const consoleOnly = ['console'] as const;
    const both = ['console', 'overlay'] as const;

    this.#ipc.register('minecraft:get-state', consoleOnly, () => this.#minecraft.getState());
    this.#ipc.register('minecraft:connect', consoleOnly, (config) => this.#minecraft.connect(config));
    this.#ipc.register('minecraft:disconnect', consoleOnly, () => this.#minecraft.disconnect());
    this.#ipc.register('minecraft:submit', consoleOnly, ({ command }) => this.#minecraft.submit(command));
    this.#ipc.register('minecraft:control', consoleOnly, ({ action }) => this.#minecraft.control(action));
    this.#ipc.register('minecraft:chat', consoleOnly, ({ message }) => this.#minecraft.sendChat(message));
    this.#ipc.register('app:get-state', both, () => this.#appState());
    this.#ipc.register('app:set-locale', consoleOnly, async ({ locale }) => { await this.#settings.update({ locale }); this.#emitApp(); return this.#appState(); });
    this.#ipc.register('app:set-theme', consoleOnly, async ({ theme }) => { await this.#settings.update({ theme }); this.#applyAppearance(); this.#emitApp(); return this.#appState(); });
    this.#ipc.register('app:set-hotkey', consoleOnly, async ({ accelerator }) => { await this.#settings.update({ hotkey: accelerator }); this.#registerHotkey(accelerator); this.#emitApp(); return this.#appState(); });
    this.#ipc.register('app:set-auto-launch', consoleOnly, async ({ enabled }) => { app.setLoginItemSettings({ openAtLogin: enabled }); await this.#settings.update({ autoLaunch: enabled }); this.#emitApp(); return this.#appState(); });
    this.#ipc.register('app:show-console', both, () => this.windows.showConsole());
    this.#ipc.register('app:set-overlay-visible', consoleOnly, async ({ visible }) => { this.windows.setOverlayVisible(visible); await this.#settings.update({ overlayVisible: visible }); });
    this.#ipc.register('app:get-diagnostics', consoleOnly, async (): Promise<DiagnosticSnapshot> => {
      const character = await this.#character.getState();
      return {
        generatedAt: new Date().toISOString(), appVersion: app.getVersion(), electronVersion: process.versions.electron,
        platform: process.platform, architecture: process.arch, sessionType: process.env.XDG_SESSION_TYPE ?? null,
        windowRoles: ['console', 'overlay'], capabilities: this.#capabilities(),
        vault: { state: this.#vault.isAvailable() ? 'ready' : 'unavailable', backend: this.#vault.getBackend() },
        core: { state: character.coreState, hash: null }, model: { state: character.modelState === 'loading' ? 'missing' : character.modelState, name: character.modelName },
        providerSecrets: Object.fromEntries(this.#providers.list().map((provider) => [provider.id, provider.secretState])),
      };
    });

    this.#ipc.register('character:get-state', both, () => this.#character.getState());
    this.#ipc.register('character:import-core', consoleOnly, async () => { const state = await this.#character.importCore(this.windows.consoleWindow()); await this.#emitCharacter(); return state; });
    this.#ipc.register('character:import-model', consoleOnly, async () => { const state = await this.#character.importModel(this.windows.consoleWindow()); await this.#emitCharacter(); return state; });
    this.#ipc.register('character:cancel-import', consoleOnly, async () => { await this.#character.cancelImport(); await this.#emitCharacter(); });
    this.#ipc.register('character:ack-model-loaded', ['overlay'], async ({ importId }) => { const state = await this.#character.acknowledgeModelLoaded(importId); await this.#emitCharacter(); return state; });
    this.#ipc.register('character:set-scale', both, async ({ scale }) => { const state = await this.#character.setScale(scale); await this.#emitCharacter(); return state; });
    this.#ipc.register('character:set-position', ['overlay'], async ({ position }) => this.#character.setPosition(position));
    this.#ipc.register('character:play-action', consoleOnly, async ({ action }) => { this.#character.setAction(action); await this.#emitCharacter(); });
    this.#ipc.register('character:set-expression', consoleOnly, async ({ expression }) => { this.#character.setExpression(expression); await this.#emitCharacter(); });
    this.#ipc.register('character:set-bubble', both, async ({ text }) => { this.#character.setBubble(text); await this.#emitCharacter(); });
    this.#ipc.register('character:set-interactive', ['overlay'], ({ interactive }) => this.windows.setOverlayInteractive(interactive));

    this.#ipc.register('chat:list-sessions', consoleOnly, () => this.#chat.listSessions());
    this.#ipc.register('chat:create-session', consoleOnly, ({ title, kind }) => this.#chat.createSession(title, kind));
    this.#ipc.register('chat:list-messages', consoleOnly, ({ sessionId }) => this.#chat.listMessages(sessionId));
    this.#ipc.register('chat:send', consoleOnly, async (payload) => this.#startChat(payload.sessionId, payload.content, payload.providerId));
    this.#ipc.register('chat:cancel', consoleOnly, ({ runId }) => { this.#agent.cancel(runId); });
    this.#ipc.register('chat:retry', consoleOnly, async ({ messageId }) => {
      const failed = this.#repository.snapshot().chatMessages.find((item) => item.id === messageId);
      const provider = this.#providers.list().find((item) => item.enabled);
      if (failed === undefined || provider === undefined) throw new Error('Retry requires a failed message and enabled provider.');
      return this.#startChat(failed.sessionId, failed.content, provider.id);
    });

    this.#ipc.register('tasks:list', consoleOnly, () => this.#tasks.list());
    this.#ipc.register('tasks:upsert', consoleOnly, async (payload) => { const result = await this.#tasks.upsert(payload); this.windows.send('console', 'tasks:changed', null); return result; });
    this.#ipc.register('tasks:remove', consoleOnly, async ({ id }) => { await this.#tasks.remove(id); this.windows.send('console', 'tasks:changed', null); });
    this.#ipc.register('tasks:get-focus', consoleOnly, () => this.#tasks.getFocus());
    this.#ipc.register('tasks:start-focus', consoleOnly, (payload) => this.#tasks.startFocus(payload.taskId, payload.plannedSeconds));
    this.#ipc.register('tasks:pause-focus', consoleOnly, () => this.#tasks.pauseFocus());
    this.#ipc.register('tasks:resume-focus', consoleOnly, () => this.#tasks.resumeFocus());
    this.#ipc.register('tasks:stop-focus', consoleOnly, ({ status }) => this.#tasks.stopFocus(status));
    this.#ipc.register('tasks:list-run-events', consoleOnly, () => this.#events.readAll());

    this.#ipc.register('memory:list', consoleOnly, () => this.#memory.list());
    this.#ipc.register('memory:upsert', consoleOnly, async (payload) => { const result = await this.#memory.upsert(payload); this.windows.send('console', 'memory:changed', this.#memory.list()); return result; });
    this.#ipc.register('memory:remove', consoleOnly, async ({ id }) => { await this.#memory.remove(id); this.windows.send('console', 'memory:changed', this.#memory.list()); });
    this.#ipc.register('relationship:get', consoleOnly, () => this.#relationship.get());
    this.#ipc.register('relationship:set-nickname', consoleOnly, async ({ nickname }) => { const result = await this.#relationship.setNickname(nickname); this.windows.send('console', 'relationship:changed', result); return result; });

    this.#ipc.register('schedule:list', consoleOnly, () => this.#schedules.list());
    this.#ipc.register('schedule:upsert', consoleOnly, async (payload) => { const result = await this.#schedules.upsert(payload); this.windows.send('console', 'schedule:changed', this.#schedules.list()); return result; });
    this.#ipc.register('schedule:remove', consoleOnly, async ({ id }) => { await this.#schedules.remove(id); this.windows.send('console', 'schedule:changed', this.#schedules.list()); });
    this.#ipc.register('schedule:run-now', consoleOnly, async ({ id }) => {
      const result = await this.#scheduler.runNow(id);
      this.windows.send('console', 'schedule:changed', this.#schedules.list());
      return result;
    });

    this.#ipc.register('providers:list', consoleOnly, () => this.#providers.list());
    this.#ipc.register('providers:upsert', consoleOnly, async ({ apiKey, ...config }) => { const result = await this.#providers.upsert(config, apiKey); this.windows.send('console', 'providers:changed', this.#providers.list()); return result; });
    this.#ipc.register('providers:remove', consoleOnly, async ({ id }) => { await this.#providers.remove(id); this.windows.send('console', 'providers:changed', this.#providers.list()); });
    this.#ipc.register('providers:clear-secret', consoleOnly, ({ id }) => this.#providers.clearSecret(id));
    this.#ipc.register('providers:test', consoleOnly, async ({ id }) => { const started = Date.now(); try { await (await this.#providers.adapter(id)).listModels(); return { ok: true, messageCode: 'provider.test.ok', latencyMs: Date.now() - started }; } catch { return { ok: false, messageCode: 'provider.test.failed', latencyMs: null }; } });
    this.#ipc.register('providers:list-models', consoleOnly, async ({ id }) => (await this.#providers.adapter(id)).listModels());

    this.#ipc.register('permissions:list', consoleOnly, () => this.#permissions.list(PERMISSION_DESCRIPTORS));
    this.#ipc.register('permissions:request', consoleOnly, async ({ capabilityId, duration }) => { const grant = await this.#permissions.grant(capabilityId, duration === 'always' ? 'always' : duration === 'once' ? 'once' : 'session'); this.#emitPermissions(); return this.#permissions.list(PERMISSION_DESCRIPTORS).find((item) => item.capabilityId === grant.capabilityId); });
    this.#ipc.register('permissions:revoke', consoleOnly, async ({ capabilityId }) => { await this.#permissions.revoke(capabilityId); this.#emitPermissions(); return this.#permissions.list(PERMISSION_DESCRIPTORS).find((item) => item.capabilityId === capabilityId); });

    this.#ipc.register('migration:preview', consoleOnly, () => this.#migration.preview());
    this.#ipc.register('migration:start', consoleOnly, async ({ categories, confirmProviderSecrets }) => {
      const result = await this.#migration.start(categories, confirmProviderSecrets);
      this.windows.send('console', 'tasks:changed', null);
      this.windows.send('console', 'memory:changed', this.#memory.list());
      this.windows.send('console', 'relationship:changed', this.#relationship.get());
      this.windows.send('console', 'schedule:changed', this.#schedules.list());
      this.windows.send('console', 'providers:changed', this.#providers.list());
      await this.#emitCharacter();
      return result;
    });
    this.#ipc.register('migration:cancel', consoleOnly, () => { this.#migration.cancel(); });
  }

  async #startChat(
    sessionId: string,
    content: string,
    providerId: string,
    runId: string = randomUUID(),
    waitForCompletion = false,
  ): Promise<{ runId: string }> {
    const provider = this.#providers.list().find((item) => item.id === providerId) as ProviderConfig | undefined;
    if (provider === undefined) throw new Error('Provider does not exist.');
    const adapter = await this.#providers.adapter(providerId);
    await this.#chat.addMessage({ sessionId, role: 'user', content, status: 'complete', errorCode: null });
    const assistant = await this.#chat.addMessage({ sessionId, role: 'assistant', content: '', status: 'streaming', errorCode: null });
    this.windows.send('console', 'chat:event', { type: 'started', runId, sessionId, messageId: assistant.id } satisfies ChatEvent);
    let streamed = '';
    const driver: ModelDriver = {
      next: async ({ messages, tools, signal }): Promise<ModelDecision> => {
        const calls: Array<{ id: string; toolId: string; input: unknown; effectKey?: string }> = [];
        let text = '';
        for await (const event of adapter.streamChat({
          model: provider.model,
          messages: this.#providerMessages(messages),
          ...(provider.supportsTools
            ? {
                tools: tools.map((tool) => ({
                  name: tool.id,
                  description: `${tool.title}. Capability: ${tool.capabilityId}. Risk: ${tool.risk}.`,
                  parameters: tool.parameters,
                })),
              }
            : {}),
        }, signal)) {
          if (event.type === 'text') {
            text += event.text;
            streamed += event.text;
            const chatEvent: ChatEvent = { type: 'delta', runId, messageId: assistant.id, text: event.text };
            this.windows.send('console', 'chat:event', chatEvent);
          } else if (event.type === 'tool-call') {
            calls.push({
              id: event.id || randomUUID(),
              toolId: event.name,
              input: JSON.parse(event.argumentsJson || '{}') as unknown,
              ...(event.id.length === 0 ? {} : { effectKey: event.id }),
            });
          }
        }
        return calls.length > 0 ? { type: 'tools', calls } : { type: 'final', content: text };
      },
    };
    const completion = this.#agent.run(content, driver, runId).then(async (result) => {
      const message = await this.#chat.updateMessage(assistant.id, { content: streamed || result.content, status: result.status === 'cancelled' ? 'cancelled' : 'complete', errorCode: null });
      this.windows.send('console', 'chat:event', { type: 'finished', runId, message } satisfies ChatEvent);
      return result.status;
    }, async (error: unknown) => {
      const message = await this.#chat.updateMessage(assistant.id, { content: streamed, status: 'failed', errorCode: 'chat.runFailed' });
      this.windows.send('console', 'chat:event', { type: 'failed', runId, messageId: message.id, errorCode: 'chat.runFailed' } satisfies ChatEvent);
      throw error;
    });
    if (waitForCompletion) {
      const status = await completion;
      if (status !== 'succeeded') throw new Error(`Scheduled agent run ended with status ${status}.`);
    } else {
      void completion.catch(() => undefined);
    }
    return { runId };
  }

  async #executeSchedule(schedule: ScheduleDefinition, runId: string): Promise<void> {
    if (schedule.kind === 'reminder') {
      const prompt = typeof schedule.payload.prompt === 'string' ? schedule.payload.prompt.slice(0, 1_024) : '';
      new Notification({ title: schedule.title, body: prompt || schedule.title }).show();
      return;
    }
    if (schedule.kind === 'focus') {
      const rawSeconds = schedule.payload.plannedSeconds;
      const plannedSeconds = typeof rawSeconds === 'number' && Number.isInteger(rawSeconds)
        ? Math.max(60, Math.min(86_400, rawSeconds))
        : 25 * 60;
      await this.#tasks.startFocus(null, plannedSeconds);
      this.windows.send('console', 'tasks:changed', null);
      return;
    }
    const prompt = typeof schedule.payload.prompt === 'string' ? schedule.payload.prompt.trim() : '';
    if (prompt.length === 0) throw new Error('Scheduled agent task requires a prompt.');
    const provider = this.#providers.list().find((item) => item.enabled);
    if (provider === undefined) throw new Error('Scheduled agent task requires an enabled provider.');
    const session = await this.#chat.createSession(schedule.title, 'normal');
    await this.#startChat(session.id, prompt.slice(0, 32_000), provider.id, runId, true);
  }

  async #tickScheduler(): Promise<void> {
    if (this.#schedulerTicking) return;
    this.#schedulerTicking = true;
    try {
      const executed = await this.#scheduler.tick();
      if (executed > 0) this.windows.send('console', 'schedule:changed', this.#schedules.list());
    } catch (error) {
      await this.#events.emit(
        randomUUID(),
        'error',
        'failed',
        error instanceof Error ? error.message : 'Scheduler tick failed.',
      ).catch(() => undefined);
    } finally {
      this.#schedulerTicking = false;
    }
  }

  #providerMessages(messages: ModelTurnMessage[]) {
    return messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
      ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
    }));
  }

  dispose(): void {
    if (this.#schedulerTimer !== null) clearInterval(this.#schedulerTimer);
    this.#schedulerTimer = null;
    this.#ipc.dispose();
    this.#minecraft.dispose();
    this.#utility.dispose();
    globalShortcut.unregisterAll();
  }
}
