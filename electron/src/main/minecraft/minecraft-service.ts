import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { MinecraftConnectionConfig, MinecraftControlAction, MinecraftSnapshot, MinecraftTask, ProviderConfig } from '../../shared';
import type { ProviderAdapter, ProviderChatMessage } from '../providers/types';
import { boundedText, record, sanitizeAuth, sanitizeInventory, sanitizeStatus, sanitizeTask } from './sanitize';

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_PLANNER_TEXT = 256 * 1024;
const MAX_LOGS = 160;
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'blocked', 'cancelled']);

interface ProviderAccess {
  list(): ProviderConfig[];
  adapter(id: string): Promise<ProviderAdapter>;
}

export interface MinecraftServiceOptions {
  runtimePath: string;
  dataDirectory: string;
  providers: ProviderAccess;
  onChanged?(snapshot: MinecraftSnapshot): void;
  onSpeech?(text: string): void;
  executablePath?: string;
  environment?: NodeJS.ProcessEnv;
  spawnRuntime?(executable: string, args: string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams;
  requestTimeoutMs?: number;
  readyTimeoutMs?: number;
  plannerTimeoutMs?: number;
}

interface PendingRequest {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Only operating-system essentials cross into the game helper. Provider credentials stay in the provider utility. */
export const minecraftWorkerEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'APPDATA', 'LOCALAPPDATA']);
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([key, value]) => allowed.has(key) && value !== undefined)),
    ELECTRON_RUN_AS_NODE: '1',
  };
};

export class MinecraftService {
  readonly #options: MinecraftServiceOptions;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #planners = new Map<string, AbortController>();
  #worker: ChildProcessWithoutNullStreams | null = null;
  #buffer = Buffer.alloc(0);
  #generation = 0;
  #plannerGeneration = 0;
  #disposed = false;
  #connecting = false;
  #readyResolve: (() => void) | null = null;
  #readyReject: ((error: Error) => void) | null = null;
  #readyTimer: ReturnType<typeof setTimeout> | null = null;
  #lastSpokenTask = '';
  #state: MinecraftSnapshot = {
    runtimeState: 'stopped', connectionState: 'idle', config: null, status: null,
    task: null, history: [], inventory: [], logs: [], auth: null, lastError: null,
  };

  constructor(options: MinecraftServiceOptions) { this.#options = options; }

  getState(): MinecraftSnapshot { return structuredClone(this.#state); }

  async connect(config: MinecraftConnectionConfig): Promise<MinecraftSnapshot> {
    if (this.#disposed) throw new Error('Minecraft service is closed.');
    if (this.#connecting) throw new Error('Minecraft is already connecting.');
    if (config.executorMode === 'hybrid') this.#selectedProvider(config);
    this.#connecting = true;
    this.#stopWorker();
    const generation = this.#generation;
    this.#lastSpokenTask = '';
    this.#state = { ...this.#state, runtimeState: 'starting', connectionState: 'connecting', config: structuredClone(config), status: null, task: null, inventory: [], auth: null, lastError: null };
    this.#publish();
    try {
      await mkdir(this.#options.dataDirectory, { recursive: true, mode: 0o700 });
      if (generation !== this.#generation || this.#disposed) throw new Error('Minecraft connection cancelled.');
      await this.#startWorker(generation);
      // The runtime acknowledges starting the connection; only world telemetry proves the bot spawned.
      const { providerId: _providerId, ...workerConfig } = config;
      void _providerId;
      await this.#request({ type: 'connect', config: workerConfig });
      if (generation !== this.#generation || this.#disposed) throw new Error('Minecraft connection cancelled.');
      return this.getState();
    } catch (error) {
      if (generation === this.#generation && !this.#disposed) this.#fail(error instanceof Error ? error.message : 'Minecraft runtime could not start.');
      throw error;
    } finally { this.#connecting = false; }
  }

  async disconnect(): Promise<MinecraftSnapshot> {
    this.#state.connectionState = 'disconnecting';
    this.#publish();
    this.#stopWorker();
    this.#state.runtimeState = 'stopped';
    this.#state.connectionState = 'disconnected';
    if (this.#state.task !== null && !TERMINAL_TASK_STATES.has(this.#state.task.status)) {
      this.#state.task = { ...this.#state.task, status: 'cancelled', summary: 'Minecraft 连接已结束。' };
    }
    this.#worldUnavailable();
    this.#publish();
    return this.getState();
  }

  async submit(command: string): Promise<MinecraftSnapshot> {
    this.#requireWorld();
    if (!command.trim() || command.length > 4_000) throw new Error('Minecraft task must contain 1–4000 characters.');
    await this.#request({ type: 'command', command: { type: 'mc_command_submit', command: command.trim(), context: { playerName: this.#state.config?.ownerName ?? '' }, source: 'deskpet' } });
    return this.getState();
  }

  async control(action: MinecraftControlAction): Promise<MinecraftSnapshot> {
    const types: Record<MinecraftControlAction, string> = {
      pause: 'mc_command_pause', resume: 'mc_command_resume', cancel: 'mc_command_cancel', stop: 'mc_command_cancel', refresh: 'mc_command_query',
    };
    // Source task status must move to paused/cancelled before its planning promise rejects.
    const request = this.#request({ type: 'command', command: { type: types[action], source: 'deskpet' } });
    if (action === 'cancel' || action === 'stop' || action === 'pause') this.#cancelPlanners();
    await request;
    return this.getState();
  }

  async sendChat(message: string): Promise<MinecraftSnapshot> {
    this.#requireWorld();
    const content = message.trim();
    if (!content || content.length > 256 || content.startsWith('/') || /[\r\n]/.test(content)) {
      throw new Error('Minecraft chat must be a single message of up to 256 characters.');
    }
    await this.#request({ type: 'command', command: { type: 'chat', message: content, source: 'deskpet' } });
    return this.getState();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopWorker();
    this.#state.runtimeState = 'stopped';
    this.#state.connectionState = 'disconnected';
    this.#state.auth = null;
  }

  #requireWorld(): void {
    if (this.#state.status?.connected !== true || this.#worker === null) throw new Error('Minecraft 尚未进入世界。');
  }

  #selectedProvider(config: MinecraftConnectionConfig | null = this.#state.config): ProviderConfig {
    if (config === null || config.executorMode !== 'hybrid' || config.providerId === null) throw new Error('AI 陪玩需要明确选择一个 AI 服务。');
    const provider = this.#options.providers.list().find((item) => item.id === config.providerId && item.enabled);
    if (provider === undefined) throw new Error('所选 AI 服务不可用，请在 AI 设置中启用它。');
    return provider;
  }

  #startWorker(generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
      this.#readyTimer = setTimeout(() => this.#fail('Minecraft runtime startup timed out.'), this.#options.readyTimeoutMs ?? 15_000);
      try {
        const create = this.#options.spawnRuntime ?? ((executable, args, options) => spawn(executable, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }));
        const worker = create(this.#options.executablePath ?? process.execPath,
          [this.#options.runtimePath, '--data-dir', this.#options.dataDirectory],
          { cwd: dirname(this.#options.runtimePath), env: minecraftWorkerEnvironment(this.#options.environment ?? process.env), windowsHide: true });
        this.#worker = worker;
        worker.stdout.on('data', (chunk: Buffer | string) => { if (generation === this.#generation) this.#ingest(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
        worker.stderr.on('data', (chunk: Buffer | string) => {
          if (generation !== this.#generation) return;
          const message = boundedText(String(chunk), 1_000).trim();
          if (message) { this.#log('runtime', message); this.#publish(); }
        });
        worker.stdin.on('error', () => { if (generation === this.#generation) this.#fail('Minecraft runtime transport closed.'); });
        worker.on('error', () => { if (generation === this.#generation) this.#fail('Minecraft runtime could not start. Reinstall its dependencies.'); });
        worker.on('exit', () => { if (generation === this.#generation) this.#fail('Minecraft runtime exited. Please reconnect.'); });
      } catch { this.#fail('Minecraft runtime could not start.'); }
    });
  }

  #request(message: Record<string, unknown>): Promise<void> {
    if (this.#worker === null || this.#state.runtimeState !== 'ready') return Promise.reject(new Error('Minecraft runtime is not running.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('Minecraft request timed out.'));
        this.#fail('Minecraft request timed out. The connection was stopped.');
      }, this.#options.requestTimeoutMs ?? 100_000);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#write({ ...message, version: 1, id }); } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error('Minecraft request failed.'));
      }
    });
  }

  #write(message: Record<string, unknown>): void {
    if (this.#worker === null || this.#worker.stdin.destroyed) throw new Error('Minecraft runtime transport is unavailable.');
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error('Minecraft message exceeds the size limit.');
    this.#worker.stdin.write(line);
  }

  #ingest(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let end: number;
    while ((end = this.#buffer.indexOf(10)) !== -1) {
      if (end > MAX_LINE_BYTES) { this.#fail('Minecraft runtime emitted an oversized message.'); return; }
      const line = this.#buffer.subarray(0, end);
      this.#buffer = this.#buffer.subarray(end + 1);
      if (line.length === 0) continue;
      let message: Record<string, unknown> | null;
      try { message = record(JSON.parse(line.toString('utf8'))); } catch { continue; }
      if (message === null || message.version !== 1) continue;
      if (message.type === 'ready') {
        this.#state.runtimeState = 'ready';
        if (this.#readyTimer !== null) clearTimeout(this.#readyTimer);
        this.#readyTimer = null;
        this.#readyResolve?.(); this.#readyResolve = null; this.#readyReject = null;
        this.#publish();
      } else if (message.type === 'reply') {
        const pending = typeof message.id === 'string' ? this.#pending.get(message.id) : undefined;
        if (pending !== undefined) {
          clearTimeout(pending.timer); this.#pending.delete(message.id as string);
          if (message.ok === true) pending.resolve();
          else pending.reject(new Error(boundedText(message.error, 2_000) || 'Minecraft request failed.'));
        } else if (message.ok === false && this.#state.runtimeState === 'starting') {
          this.#fail(boundedText(message.error, 2_000) || 'Minecraft runtime could not start.'); return;
        }
      } else if (message.type === 'event') {
        const event = record(message.event);
        if (event !== null) this.#receiveEvent(event);
      } else if (message.type === 'planner_request') {
        void this.#plan(message, this.#generation, this.#plannerGeneration);
      }
    }
    if (this.#buffer.length > MAX_LINE_BYTES) this.#fail('Minecraft runtime emitted an oversized message.');
  }

  #receiveEvent(event: Record<string, unknown>): void {
    if (event.type === 'mc_status') {
      const wasConnected = this.#state.status?.connected === true;
      this.#state.status = sanitizeStatus(event.status);
      if (this.#state.status?.connected) { this.#state.connectionState = 'connected'; this.#state.auth = null; }
      else if (wasConnected) this.#worldUnavailable();
    } else if (event.type === 'mc_control_state') {
      const control = record(event.control);
      const connection = control?.connectionState;
      const disconnected = connection === 'idle' && Boolean(control?.lastDisconnectReason || control?.lastDisconnectPath);
      if (disconnected) this.#state.connectionState = 'disconnected';
      else if (typeof connection === 'string' && ['idle', 'connecting', 'disconnecting', 'disconnected', 'error'].includes(connection)) {
        this.#state.connectionState = connection as MinecraftSnapshot['connectionState'];
      } else if (connection === 'connected' && this.#state.status?.connected) this.#state.connectionState = 'connected';
      const error = boundedText(control?.lastError || control?.disconnectReasonText, 2_000);
      if (error) this.#state.lastError = error;
      if (disconnected || connection === 'disconnected' || connection === 'error') this.#worldUnavailable();
    } else if (event.type === 'mc_task_status') {
      this.#state.task = sanitizeTask(event.foregroundTask ?? event.task);
      if (Array.isArray(event.history)) this.#state.history = event.history.slice(0, 30).map(sanitizeTask).filter((task): task is MinecraftTask => task !== null);
      const task = this.#state.task;
      if (task !== null && TERMINAL_TASK_STATES.has(task.status) && task.id !== this.#lastSpokenTask) {
        this.#lastSpokenTask = task.id;
        const rawTask = record(event.foregroundTask ?? event.task);
        const speech = boundedText(rawTask?.replyText || rawTask?.progressText || rawTask?.error || task.summary, 400);
        if (speech) this.#options.onSpeech?.(speech);
      }
    } else if (event.type === 'mc_inventory_snapshot') this.#state.inventory = sanitizeInventory(event.inventory);
    else if (event.type === 'mc_auth_device_code') this.#state.auth = sanitizeAuth(event);
    else if (event.type === 'mc_error') {
      const message = boundedText(event.message, 2_000) || 'Minecraft runtime reported an error.';
      this.#state.lastError = message;
      this.#log('error', message);
    } else if (event.type === 'mc_task_log') {
      const log = record(event.log);
      this.#log(boundedText(log?.level, 40) || 'task', boundedText(log?.message, 2_000));
    } else if (event.type === 'mc_event' || event.type === 'mc_task_event') {
      const detail = record(event.event);
      const kind = boundedText(detail?.eventType, 80) || 'event';
      const message = [boundedText(detail?.playerName, 80), boundedText(detail?.message ?? detail?.reason, 1_500)].filter(Boolean).join(': ');
      this.#log(kind, message || kind);
    }
    this.#publish();
  }

  async #plan(message: Record<string, unknown>, generation: number, plannerGeneration: number): Promise<void> {
    const requestId = typeof message.requestId === 'string' && message.requestId.length <= 128 ? message.requestId : null;
    if (requestId === null || this.#planners.has(requestId)) return;
    const controller = new AbortController();
    if (this.#planners.size >= 4) { this.#plannerReply(requestId, null, 'AI 规划请求过多。', generation, plannerGeneration); return; }
    this.#planners.set(requestId, controller);
    const timer = setTimeout(() => controller.abort(), this.#options.plannerTimeoutMs ?? 80_000);
    let rejectOnAbort: (() => void) | null = null;
    try {
      const provider = this.#selectedProvider();
      if (!Array.isArray(message.messages) || message.messages.length < 1 || message.messages.length > 128) throw new Error('AI planning input was rejected.');
      const messages: ProviderChatMessage[] = message.messages.map((value) => {
        const entry = record(value);
        if (entry === null || !['system', 'user', 'assistant'].includes(String(entry.role)) || typeof entry.content !== 'string' || entry.content.length > MAX_PLANNER_TEXT) throw new Error('AI planning input was rejected.');
        return { role: entry.role as ProviderChatMessage['role'], content: entry.content };
      });
      if (messages.reduce((total, entry) => total + entry.content.length, 0) > MAX_PLANNER_TEXT) throw new Error('AI planning input is too large.');
      const completion = async (): Promise<string> => {
        const adapter = await this.#options.providers.adapter(provider.id);
        if (controller.signal.aborted) throw new Error('AI 规划已取消。');
        let text = '';
        for await (const event of adapter.streamChat({ model: provider.model, messages, temperature: typeof message.temperature === 'number' ? Math.max(0, Math.min(2, message.temperature)) : 0.2 }, controller.signal)) {
          if (controller.signal.aborted) throw new Error('AI 规划已取消。');
          if (event.type === 'text') text += event.text;
          else if (event.type === 'tool-call') throw new Error('Minecraft planner returned an unsupported tool call.');
          if (text.length > MAX_PLANNER_TEXT) throw new Error('AI planning output is too large.');
        }
        if (!text.trim()) throw new Error('AI planner returned an empty response.');
        return text;
      };
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = () => reject(new Error('AI 规划已取消或超时。'));
        controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
      });
      const text = await Promise.race([completion(), aborted]);
      this.#plannerReply(requestId, text, null, generation, plannerGeneration);
    } catch (error) {
      // Provider errors can contain request details. Return a stable message across the game boundary.
      const detail = controller.signal.aborted ? 'AI 规划已取消或超时。' : 'DeskPet AI 规划失败，请检查所选 AI 服务。';
      void error;
      this.#plannerReply(requestId, null, detail, generation, plannerGeneration);
      if (generation === this.#generation && plannerGeneration === this.#plannerGeneration) { this.#log('planner', detail); this.#publish(); }
    } finally {
      clearTimeout(timer);
      if (rejectOnAbort !== null) controller.signal.removeEventListener('abort', rejectOnAbort);
      controller.abort();
      this.#planners.delete(requestId);
    }
  }

  #plannerReply(requestId: string, text: string | null, error: string | null, generation: number, plannerGeneration: number): void {
    if (generation !== this.#generation || plannerGeneration !== this.#plannerGeneration || this.#disposed || this.#worker === null) return;
    try { this.#write({ version: 1, id: randomUUID(), type: 'planner_result', requestId, ...(error === null ? { text } : { error }) }); } catch { /* Worker teardown already handles transport failure. */ }
  }

  #cancelPlanners(): void {
    for (const requestId of this.#planners.keys()) {
      try { this.#write({ version: 1, id: randomUUID(), type: 'planner_result', requestId, error: 'Minecraft 任务已暂停或取消。' }); } catch { /* The worker may already have stopped. */ }
    }
    this.#plannerGeneration += 1;
    for (const controller of this.#planners.values()) controller.abort();
    this.#planners.clear();
  }

  #worldUnavailable(): void {
    this.#cancelPlanners();
    this.#state.auth = null;
    this.#state.inventory = [];
    this.#state.status = this.#state.status === null ? null : {
      connected: false, health: null, food: null, dimension: null, position: null, mode: null,
    };
    if (this.#state.task !== null && !TERMINAL_TASK_STATES.has(this.#state.task.status)) {
      this.#state.task = { ...this.#state.task, status: 'unknown', summary: 'Minecraft 连接已结束，任务结果尚未确认。' };
    }
  }

  #stopWorker(): void {
    this.#generation += 1;
    this.#cancelPlanners();
    if (this.#readyTimer !== null) clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
    this.#readyReject?.(new Error('Minecraft connection cancelled.'));
    this.#readyReject = null; this.#readyResolve = null;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Minecraft connection cancelled.')); }
    this.#pending.clear();
    const worker = this.#worker;
    this.#worker = null;
    this.#buffer = Buffer.alloc(0);
    if (worker === null) return;
    worker.stdout.removeAllListeners('data');
    worker.stderr.removeAllListeners('data');
    try {
      worker.stdin.end(`${JSON.stringify({ version: 1, id: randomUUID(), type: 'shutdown' })}\n`);
      worker.kill('SIGTERM');
      const killTimer = setTimeout(() => { try { worker.kill('SIGKILL'); } catch { /* Already exited. */ } }, 1_000);
      killTimer.unref?.();
      worker.once('exit', () => clearTimeout(killTimer));
    } catch { try { worker.kill('SIGKILL'); } catch { /* Already exited. */ } }
  }

  #fail(message: string): void {
    const safe = boundedText(message, 2_000);
    this.#stopWorker();
    this.#state.runtimeState = 'error'; this.#state.connectionState = 'error'; this.#state.auth = null;
    this.#worldUnavailable();
    this.#state.lastError = safe;
    this.#log('error', safe);
    this.#publish();
  }

  #log(kind: string, message: string): void {
    if (!message) return;
    this.#state.logs.push({ id: randomUUID(), timestamp: new Date().toISOString(), kind, message });
    if (this.#state.logs.length > MAX_LOGS) this.#state.logs.splice(0, this.#state.logs.length - MAX_LOGS);
  }

  #publish(): void { if (!this.#disposed) this.#options.onChanged?.(this.getState()); }
}
