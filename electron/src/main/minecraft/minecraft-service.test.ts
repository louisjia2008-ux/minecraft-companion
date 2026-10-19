// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MinecraftConnectionConfig, ProviderConfig } from '../../shared';
import type { ProviderAdapter, ProviderStreamEvent } from '../providers/types';
import { MinecraftService, minecraftWorkerEnvironment } from './minecraft-service';

class FakeWorker extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: Array<Record<string, unknown>> = [];
  readonly signals: string[] = [];
  acknowledge = true;
  bridge: ((message: Record<string, unknown>) => void) | null = null;
  shutdown: (() => void) | null = null;
  readonly stdin = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      for (const line of chunk.toString('utf8').trim().split('\n')) {
        const message = JSON.parse(line) as Record<string, unknown>;
        this.writes.push(message);
        if (this.bridge !== null) this.bridge(message);
        else if (this.acknowledge && message.type !== 'shutdown') this.send({ version: 1, type: 'reply', id: message.id, ok: true });
      }
      callback();
    },
  });

  send(message: unknown): void { this.stdout.write(`${JSON.stringify(message)}\n`); }
  event(event: unknown): void { this.send({ version: 1, type: 'event', event }); }
  kill(signal = 'SIGTERM'): boolean { this.shutdown?.(); this.signals.push(signal); this.emit('exit', 0); return true; }
  asProcess(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
}

const config: MinecraftConnectionConfig = {
  host: '127.0.0.1', port: 25565, username: 'DeskPet', auth: 'offline', version: 'auto',
  ownerName: 'Owner', executorMode: 'strict', providerId: null,
};
const provider: ProviderConfig = {
  id: 'provider-id', kind: 'openai-compatible', name: 'Existing provider', baseUrl: 'https://example.invalid/v1',
  model: 'configured-model', enabled: true, supportsTools: false, secretState: 'configured',
};
const services: MinecraftService[] = [];
const directories: string[] = [];

const fixture = async (options: { ready?: boolean; adapter?: ProviderAdapter; plannerTimeoutMs?: number; requestTimeoutMs?: number } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-minecraft-'));
  directories.push(root);
  const workers: FakeWorker[] = [];
  const captured: Array<{ executable: string; args: string[]; options: SpawnOptionsWithoutStdio }> = [];
  const defaultAdapter: ProviderAdapter = {
    async *streamChat() { yield { type: 'text', text: '{"goal":"follow"}' }; },
    async listModels() { return []; },
  };
  const adapter = vi.fn(async () => options.adapter ?? defaultAdapter);
  const speech = vi.fn();
  const service = new MinecraftService({
    runtimePath: join(root, 'bridge.js'), dataDirectory: join(root, 'profile'), executablePath: '/electron-executable',
    environment: { HOME: '/user', PATH: '/bin', OPENAI_API_KEY: 'sk-do-not-export-this-key', NODE_OPTIONS: '--require=evil.js', MC_AGENT_DATA_DIR: '/original-private-profile' },
    providers: { list: () => [provider], adapter }, onSpeech: speech,
    requestTimeoutMs: options.requestTimeoutMs ?? 1_000, readyTimeoutMs: 1_000,
    plannerTimeoutMs: options.plannerTimeoutMs ?? 1_000,
    spawnRuntime: (executable, args, spawnOptions) => {
      captured.push({ executable, args, options: spawnOptions });
      const worker = new FakeWorker(); workers.push(worker);
      if (options.ready !== false) void Promise.resolve().then(() => worker.send({ version: 1, type: 'ready' }));
      return worker.asProcess();
    },
  });
  services.push(service);
  return { service, workers, captured, adapter, speech };
};

const enterWorld = (worker: FakeWorker): void => worker.event({ type: 'mc_status', status: {
  connected: true, health: 20, food: 18, dimension: 'overworld', position: { x: 1, y: 64, z: 2 }, mode: 'mineflayer',
} });

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Minecraft companion host', () => {
  it('stays stopped until connect and starts a secret-free isolated helper', async () => {
    const { service, workers, captured } = await fixture();
    expect(service.getState().runtimeState).toBe('stopped');
    expect(captured).toHaveLength(0);
    const accepted = await service.connect(config);
    expect(accepted.runtimeState).toBe('ready');
    expect(accepted.connectionState).toBe('connecting');
    expect(captured[0]?.executable).toBe('/electron-executable');
    expect(captured[0]?.args).toEqual([expect.stringContaining('bridge.js'), '--data-dir', expect.stringContaining('/profile')]);
    expect(captured[0]?.options.env).toEqual({ HOME: '/user', PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' });
    expect(captured[0]?.options).not.toHaveProperty('shell');
    const worker = workers[0] as FakeWorker;
    expect(worker.writes[0]).toMatchObject({ version: 1, type: 'connect', config: { host: config.host } });
    expect(worker.writes[0]?.config).not.toHaveProperty('providerId');
    await expect(service.submit('跟着我')).rejects.toThrow('尚未进入世界');
    enterWorld(worker);
    await service.submit('跟着我');
    expect(worker.writes.at(-1)).toMatchObject({ type: 'command', command: { type: 'mc_command_submit', command: '跟着我', context: { playerName: 'Owner' } } });
  });

  it('cancels startup and ignores old worker events after reconnect', async () => {
    const { service, workers } = await fixture({ ready: false });
    const first = service.connect(config);
    const rejected = expect(first).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    await service.disconnect();
    await rejected;
    expect(workers[0]?.signals).toContain('SIGTERM');
    const second = service.connect(config);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    const current = workers[1] as FakeWorker;
    current.send({ version: 1, type: 'ready' });
    await second;
    enterWorld(current);
    workers[0]?.event({ type: 'mc_error', message: 'old error' });
    workers[0]?.emit('exit', 1);
    expect(service.getState().connectionState).toBe('connected');
    expect(service.getState().lastError).toBeNull();
  });

  it('projects bounded telemetry and speech without raw task scripts or secrets', async () => {
    const { service, workers, speech } = await fixture();
    await service.connect(config);
    const worker = workers[0] as FakeWorker;
    enterWorld(worker);
    worker.event({ type: 'mc_task_status', task: { taskId: 'task-1', userCommand: '采矿', status: 'completed', replyText: '完成了', plan: { apiKey: 'raw-secret', script: 'private' } }, history: Array.from({ length: 100 }, (_, index) => ({ taskId: `history-${index}`, status: 'completed', userCommand: '任务' })) });
    worker.event({ type: 'mc_inventory_snapshot', inventory: [{ name: 'stone', count: 12, displayName: 'Stone', privateField: 'private' }, { name: 'invalid', count: -2 }] });
    for (let index = 0; index < 180; index += 1) worker.event({ type: 'mc_task_log', log: { level: 'info', message: 'Bearer sensitive-token api_key=another-secret sk-abcdefghijk' } });
    worker.event({ type: 'mc_auth_device_code', userCode: '123', verificationURI: 'https://evil.invalid/login', message: 'fake', expiresIn: 900 });
    const snapshot = service.getState();
    expect(snapshot.task).toEqual({ id: 'task-1', goal: '采矿', status: 'completed', summary: '完成了' });
    expect(snapshot.history).toHaveLength(30);
    expect(snapshot.inventory).toEqual([{ name: 'stone', count: 12, displayName: 'Stone' }]);
    expect(snapshot.logs).toHaveLength(160);
    expect(JSON.stringify(snapshot)).not.toContain('sensitive-token');
    expect(JSON.stringify(snapshot)).not.toContain('another-secret');
    expect(JSON.stringify(snapshot)).not.toContain('raw-secret');
    expect(snapshot.auth).toBeNull();
    expect(speech).toHaveBeenCalledWith('完成了');
  });

  it('only uses the explicitly selected enabled provider in hybrid mode', async () => {
    const { service, workers, adapter } = await fixture();
    await service.connect(config);
    const strict = workers[0] as FakeWorker;
    strict.send({ version: 1, type: 'planner_request', requestId: 'strict-plan', messages: [{ role: 'user', content: 'plan' }] });
    await vi.waitFor(() => expect(strict.writes.find((message) => message.requestId === 'strict-plan')).toHaveProperty('error'));
    expect(adapter).not.toHaveBeenCalled();
    await service.connect({ ...config, executorMode: 'hybrid', providerId: provider.id });
    const hybrid = workers[1] as FakeWorker;
    hybrid.send({ version: 1, type: 'planner_request', requestId: 'hybrid-plan', messages: [{ role: 'system', content: 'Return a plan' }, { role: 'user', content: 'follow' }] });
    await vi.waitFor(() => expect(hybrid.writes.find((message) => message.requestId === 'hybrid-plan')).toMatchObject({ type: 'planner_result', text: '{"goal":"follow"}' }));
    expect(adapter).toHaveBeenCalledWith(provider.id);
    expect(JSON.stringify(hybrid.writes)).not.toContain('sk-');
    await expect(service.connect({ ...config, executorMode: 'hybrid', providerId: 'unknown' })).rejects.toThrow('所选 AI 服务不可用');
  });

  it('settles planner timeouts even when a provider does not honor abort', async () => {
    const hanging: ProviderAdapter = {
      async *streamChat(): AsyncGenerator<ProviderStreamEvent> { await new Promise<void>(() => undefined); yield { type: 'done', finishReason: null }; },
      async listModels() { return []; },
    };
    const { service, workers } = await fixture({ adapter: hanging, plannerTimeoutMs: 20 });
    await service.connect({ ...config, executorMode: 'hybrid', providerId: provider.id });
    const worker = workers[0] as FakeWorker;
    worker.send({ version: 1, type: 'planner_request', requestId: 'slow', messages: [{ role: 'user', content: 'plan' }] });
    await vi.waitFor(() => expect(worker.writes.find((message) => message.requestId === 'slow')).toMatchObject({ type: 'planner_result', error: 'AI 规划已取消或超时。' }));
  });

  it('rejects helper planners on pause before abort and suppresses their late result', async () => {
    let release: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    const hanging: ProviderAdapter = {
      async *streamChat(_request, currentSignal): AsyncGenerator<ProviderStreamEvent> {
        signal = currentSignal;
        await new Promise<void>((resolve) => { release = resolve; });
        yield { type: 'text', text: 'late-plan' };
      },
      async listModels() { return []; },
    };
    const { service, workers } = await fixture({ adapter: hanging });
    await service.connect({ ...config, executorMode: 'hybrid', providerId: provider.id });
    const worker = workers[0] as FakeWorker;
    worker.send({ version: 1, type: 'planner_request', requestId: 'cancel-me', messages: [{ role: 'user', content: 'plan' }] });
    await vi.waitFor(() => expect(release).toBeDefined());
    await service.control('pause');
    expect(signal?.aborted).toBe(true);
    expect(worker.writes.find((message) => message.requestId === 'cancel-me')).toHaveProperty('error');
    expect(worker.writes.findIndex((message) => (message.command as Record<string, unknown> | undefined)?.type === 'mc_command_pause'))
      .toBeLessThan(worker.writes.findIndex((message) => message.requestId === 'cancel-me'));
    release?.();
    await Promise.resolve(); await Promise.resolve();
    expect(worker.writes.filter((message) => message.requestId === 'cancel-me')).toHaveLength(1);
    await service.disconnect();
    expect(service.getState().runtimeState).toBe('stopped');
    expect(worker.signals).toContain('SIGTERM');
  });

  it('stops on oversized output and request timeout and never sends slash chat', async () => {
    const { service, workers } = await fixture({ requestTimeoutMs: 20 });
    await service.connect(config);
    const worker = workers[0] as FakeWorker;
    enterWorld(worker);
    await expect(service.sendChat('/op someone')).rejects.toThrow('single message');
    worker.acknowledge = false;
    await expect(service.submit('跟着我')).rejects.toThrow('timed out');
    expect(worker.signals).toContain('SIGTERM');
    expect(service.getState().runtimeState).toBe('error');
    await service.connect(config);
    const second = workers[1] as FakeWorker;
    second.stdout.write(Buffer.alloc(1024 * 1024 + 1, 97));
    expect(service.getState().lastError).toContain('oversized');
    expect(second.signals).toContain('SIGTERM');
  });

  it('exports only OS environment values needed by the worker', () => {
    expect(minecraftWorkerEnvironment({ HOME: '/home', PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'secret', HTTP_PROXY: 'https://secret@proxy', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '0' })).toEqual({ HOME: '/home', PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' });
  });

  it('maps the migrated idle disconnect state and clears unconfirmed live data', async () => {
    const { service, workers } = await fixture();
    await service.connect(config);
    const worker = workers[0] as FakeWorker;
    enterWorld(worker);
    worker.event({ type: 'mc_inventory_snapshot', inventory: [{ name: 'diamond', count: 5 }] });
    worker.event({ type: 'mc_task_status', task: { taskId: 'running', userCommand: '采矿', status: 'running' } });
    worker.event({ type: 'mc_control_state', control: { connectionState: 'idle', lastDisconnectReason: 'server disconnected', lastDisconnectPath: 'server_disconnected', disconnectReasonText: '服务器断开' } });
    expect(service.getState()).toMatchObject({ connectionState: 'disconnected', auth: null, inventory: [], status: { connected: false, position: null }, task: { status: 'unknown' } });
    expect(service.getState().task?.summary).toContain('尚未确认');
  });

  it('clears live observations on explicit disconnect and speaks repeated source IDs after reconnect', async () => {
    const { service, workers, speech } = await fixture();
    for (let connection = 0; connection < 2; connection += 1) {
      await service.connect(config);
      const worker = workers[connection] as FakeWorker;
      enterWorld(worker);
      worker.event({ type: 'mc_inventory_snapshot', inventory: [{ name: 'diamond', count: 5 }] });
      // The isolated engine starts its task counter over for each helper process.
      worker.event({ type: 'mc_task_status', task: { taskId: 'task-1', userCommand: '任务', status: 'completed', replyText: `完成 ${connection}` } });
      await service.disconnect();
      expect(service.getState()).toMatchObject({ inventory: [], status: { connected: false, health: null, food: null, dimension: null, position: null, mode: null } });
    }
    expect(speech.mock.calls.map(([text]) => text)).toEqual(['完成 0', '完成 1']);
  });

  it('executes a complete JSON plan through the host and real migrated runtime with a simulated world', async () => {
    const load = createRequire(join(process.cwd(), 'minecraft-runtime', 'runtime.js'));
    interface Position { x: number; y: number; z: number }
    const { Vec3 } = load('vec3') as { Vec3: new (x: number, y: number, z: number) => Position };
    interface Runtime { handle(message: unknown): Promise<boolean>; close(): void }
    const { createRuntime } = load('./runtime') as { createRuntime(options: { dataDir: string; emit(message: unknown): void; createBot(): EventEmitter }): Runtime };
    const dataDir = await mkdtemp(join(tmpdir(), 'deskpet-minecraft-full-plan-'));
    directories.push(dataDir);
    const savedEnvironment = Object.fromEntries(['MC_AGENT_DATA_DIR', 'MC_AGENT_LEARNING_PATH', 'MC_AGENT_DIAGNOSTICS_DIR', 'MC_AGENT_DISCONNECT_TRACE_PATH'].map((name) => [name, process.env[name]]));
    const goals: Position[] = [];
    const bot = Object.assign(new EventEmitter(), {
      entity: { position: new Vec3(0, 64, 0) }, username: 'DeskPet', health: 20, food: 20,
      entities: {}, players: {}, registry: (load('prismarine-registry') as (version: string) => unknown)('1.20.4'),
      inventory: { items: () => [] }, game: { dimension: 'overworld' },
      _client: Object.assign(new EventEmitter(), { state: 'play', socket: Object.assign(new EventEmitter(), { writable: true, destroyed: false }) }),
      player: { ping: 1 }, clearControlStates: () => undefined, findBlock: () => null,
      findBlocks: () => [], blockAt: () => null, quit: () => undefined,
      pathfinder: {
        setMovements: () => undefined, setGoal: () => undefined, stop: () => undefined,
        goto: async (goal: Position) => { goals.push({ x: goal.x, y: goal.y, z: goal.z }); bot.entity.position = new Vec3(goal.x, goal.y, goal.z); },
      },
    });
    const plan = { mode: 'task', intent: 'go_to_position', goal: '走到标记处', requiresConfirmation: false,
      steps: [{ skill: 'go_to_position', args: { x: 3, y: 64, z: 0 } }], missingResources: [], safetyRisk: '', replyText: '我会走到标记处。' };
    const requests: Array<{ model: string; tools?: unknown; messages: Array<{ role: string; content: string }> }> = [];
    const adapter: ProviderAdapter = {
      async *streamChat(request) { requests.push(request); yield { type: 'text', text: JSON.stringify(plan) }; },
      async listModels() { return []; },
    };
    let runtime: Runtime | null = null;
    let worker: FakeWorker | null = null;
    const service = new MinecraftService({
      runtimePath: join(process.cwd(), 'minecraft-runtime', 'bridge.js'), dataDirectory: dataDir,
      providers: { list: () => [provider], adapter: async () => adapter },
      spawnRuntime: () => {
        const next = new FakeWorker(); worker = next;
        next.acknowledge = false;
        next.bridge = (message) => { if (runtime !== null) void runtime.handle(message); };
        next.shutdown = () => runtime?.close();
        void Promise.resolve().then(() => {
          runtime = createRuntime({ dataDir, emit: (message) => next.send(message), createBot: () => bot });
        });
        return next.asProcess();
      },
    });
    services.push(service);
    try {
      await service.connect({ ...config, executorMode: 'hybrid', providerId: provider.id });
      bot.emit('spawn');
      expect(service.getState().status?.connected).toBe(true);
      // This text deliberately has no local heuristic so the completion must cross the planner bridge.
      await service.submit('执行自定义标记点任务');
      await vi.waitFor(() => expect(goals).toEqual([{ x: 3, y: 64, z: 0 }]), { timeout: 3_000 });
      await vi.waitFor(() => expect(service.getState().task?.status).toBe('completed'), { timeout: 3_000 });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.model).toBe(provider.model);
      expect(requests[0]?.tools).toBeUndefined();
      expect(requests[0]?.messages[0]?.content).toContain('严格 JSON');
      expect(service.getState().task?.goal).toBe('执行自定义标记点任务');
      expect((worker as FakeWorker | null)?.writes.some((message) => message.type === 'planner_result' && message.text === JSON.stringify(plan))).toBe(true);
    } finally {
      service.dispose();
      for (const [name, value] of Object.entries(savedEnvironment)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
});
