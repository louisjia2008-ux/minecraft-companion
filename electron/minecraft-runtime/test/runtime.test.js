/* global require, process, __dirname, setTimeout, clearTimeout */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { createRuntime } = require('../runtime');
const { MAX_LINE_BYTES, validateEnvelope } = require('../protocol');

const connectConfig = { host: '127.0.0.1', port: 25565, username: 'DeskPet', auth: 'offline', ownerName: 'Owner', executorMode: 'strict' };
const envelope = (id, type, payload = {}) => ({ version: 1, id, type, ...payload });

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-minecraft-test-'));
  const output = [];
  const bots = [];
  const botConfigs = [];
  const commands = [];
  const agentCalls = [];
  let deps;
  const agent = {
    getStatusFields: () => ({ agentMode: 'idle' }),
    attachBot: () => { agentCalls.push('attach'); }, detachBot: (reason) => { agentCalls.push(reason); }, dispose: () => {}, setRuntimeOptions: () => {},
    initializeBotRuntime: () => { agentCalls.push('initialize'); }, sendSnapshot: () => {},
    broadcastContextSnapshot: () => {}, tickIdleBehavior: async () => {},
    isBotConnectionWritable: () => true,
    handleMessage: async (command) => commands.push(command),
  };
  const runtime = createRuntime({
    dataDir, emit: (message) => output.push(message),
    createAgent: (nextDeps) => { deps = nextDeps; return agent; },
    createBot: (config) => {
      botConfigs.push(config);
      const nextBot = new EventEmitter();
      nextBot.health = 20; nextBot.food = 20;
      nextBot.quit = () => { nextBot.quitCalls = (nextBot.quitCalls || 0) + 1; };
      nextBot.chat = (message) => { nextBot.lastChat = message; };
      bots.push(nextBot); return nextBot;
    },
  });
  t.after(() => { runtime.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { runtime, output, bots, botConfigs, commands, dataDir, deps, agent, agentCalls };
}

function spawnBot(bot) {
  bot.entity = { position: { x: 1, y: 64, z: 2 } };
  bot.game = { dimension: 'overworld' };
  bot.emit('spawn');
}

test('startup stays disconnected and stores no source credentials or armed state', (t) => {
  const state = fixture(t);
  assert.equal(state.bots.length, 0);
  assert.equal(state.output[0].type, 'ready');
  assert.equal(state.output[0].capabilities.autonomousMaintenance, false);
  assert.equal(state.deps.allowAutonomousMaintenance(), false);
  assert.equal(state.deps.readConfig().mcAgentAutoReconnect, false);
  assert.deepEqual(fs.readdirSync(state.dataDir), []);
  assert.equal(process.env.MC_AGENT_LEARNING_PATH, path.join(state.dataDir, 'minecraft-agent-learning.json'));
});

test('offline validation rejects malformed port, name, command, protocol and key injection', () => {
  for (const change of [{ port: 0 }, { port: 65536 }, { port: 1.5 }, { username: 'bad name' }, { host: 'https://example.com' }, { version: '26.x' }]) {
    assert.throws(() => validateEnvelope(envelope('1', 'connect', { config: { ...connectConfig, ...change } })));
  }
  assert.throws(() => validateEnvelope({ version: 2, id: '1', type: 'disconnect' }));
  assert.throws(() => validateEnvelope(envelope('1', 'command', { command: { type: 'mc_runtime_ai_config' } })));
  for (const message of ['/op player', 'hello\n/op player']) {
    assert.throws(() => validateEnvelope(envelope('1', 'command', { command: { type: 'chat', message } })));
  }
  const result = validateEnvelope(envelope('1', 'command', { command: {
    type: 'mc_command_submit', command: ' 跟着我 ', aiConfig: { apiKey: 'untrusted' }, context: { playerName: 'Owner', secret: 'untrusted' },
  } }));
  assert.equal(result.command.aiConfig, undefined);
  assert.deepEqual(result.command.context, { playerName: 'Owner' });
});

test('connect ACK precedes world readiness; tasks require spawn and inherit owner context', async (t) => {
  const state = fixture(t);
  await state.runtime.handle(envelope('1', 'connect', { config: connectConfig }));
  assert.equal(state.output.at(-1).ok, true);
  assert.equal(state.botConfigs[0].version, false);
  state.bots[0].entity = { position: { x: 1, y: 64, z: 2 } };
  state.bots[0].emit('login');
  assert.equal(state.output.filter((msg) => msg.event?.type === 'mc_status').at(-1).event.status.connected, false);
  assert.equal(state.output.filter((msg) => msg.event?.type === 'mc_control_state').at(-1).event.control.connectionState, 'connecting');
  await state.runtime.handle(envelope('2', 'command', { command: { type: 'mc_command_submit', command: '跟着我' } }));
  assert.equal(state.output.at(-1).ok, false);
  spawnBot(state.bots[0]);
  assert.equal(state.output.some((msg) => msg.event?.type === 'mc_status' && msg.event.status.connected), true);
  await state.runtime.handle(envelope('3', 'command', { command: { type: 'mc_command_submit', command: '跟着我' } }));
  assert.equal(state.commands[0].context.playerName, 'Owner');
  await state.runtime.handle(envelope('4', 'command', { command: { type: 'chat', message: 'hello' } }));
  assert.equal(state.bots[0].lastChat, 'hello');
});

test('modern player-loaded acknowledgement waits for chunks before exposing command readiness', async (t) => {
  const state = fixture(t);
  await state.runtime.handle(envelope('connect', 'connect', { config: connectConfig }));
  const bot = state.bots[0];
  const packets = [];
  let chunksReady;
  bot.registry = require('prismarine-registry')('1.21.8');
  bot._client = { state: 'play', write: (name, payload) => packets.push({ name, payload }) };
  bot.waitForChunksToLoad = () => new Promise((resolve) => { chunksReady = resolve; });
  spawnBot(bot);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(packets, []);
  await state.runtime.handle(envelope('early-task', 'command', { command: { type: 'mc_command_submit', command: '挖钻石' } }));
  assert.equal(state.output.at(-1).ok, false);
  assert.equal(state.commands.length, 0);
  chunksReady();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(packets, [{ name: 'player_loaded', payload: {} }]);
  assert.equal(state.output.filter((message) => message.event?.type === 'mc_status').at(-1).event.status.connected, true);
  await state.runtime.handle(envelope('ready-task', 'command', { command: { type: 'mc_command_submit', command: '挖钻石' } }));
  assert.equal(state.output.at(-1).ok, true);
});

test('player-loaded packet is gated by installed resolved protocol, including legacy and first supported versions', async (t) => {
  for (const version of ['1.16.5', '1.20.4', '1.21.3', '1.21.4', '1.21.8', '1.21.11']) {
    await t.test(version, async (subtest) => {
      const state = fixture(subtest);
      await state.runtime.handle(envelope('connect', 'connect', { config: connectConfig }));
      const bot = state.bots[0];
      bot.registry = require('prismarine-registry')(version);
      const supported = Boolean(bot.registry.protocol.play.toServer.types.packet_player_loaded);
      let chunkWaits = 0;
      const packets = [];
      bot.waitForChunksToLoad = async () => { chunkWaits += 1; };
      bot._client = { state: 'play', write: (name, payload) => {
        assert.ok(supported, 'A legacy protocol must never serialize player_loaded');
        packets.push({ name, payload });
      } };
      spawnBot(bot);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(chunkWaits, supported ? 1 : 0);
      assert.deepEqual(packets, supported ? [{ name: 'player_loaded', payload: {} }] : []);
      assert.equal(state.output.filter((message) => message.event?.type === 'mc_status').at(-1).event.status.connected, true);
    });
  }
});

test('late chunk completion cannot acknowledge an old connection or world', async (t) => {
  const state = fixture(t);
  const packets = [];
  const configure = (bot, label) => {
    bot.registry = require('prismarine-registry')('1.21.8');
    bot._client = { state: 'play', write: () => packets.push(label) };
    const waits = [];
    bot.waitForChunksToLoad = () => new Promise((resolve) => waits.push(resolve));
    return waits;
  };
  await state.runtime.handle(envelope('first-connect', 'connect', { config: connectConfig }));
  const oldWaits = configure(state.bots[0], 'old-connection');
  spawnBot(state.bots[0]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await state.runtime.handle(envelope('new-connect', 'connect', { config: connectConfig }));
  oldWaits[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(packets, []);
  const bot = state.bots[1];
  const waits = configure(bot, 'current-world');
  spawnBot(bot);
  await new Promise((resolve) => setTimeout(resolve, 0));
  bot.emit('respawn');
  spawnBot(bot);
  await new Promise((resolve) => setTimeout(resolve, 0));
  waits[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(packets, []);
  assert.equal(state.output.filter((message) => message.event?.type === 'mc_status').at(-1).event.status.connected, false);
  waits[1]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(packets, ['current-world']);
  assert.equal(state.output.filter((message) => message.event?.type === 'mc_status').at(-1).event.status.connected, true);
});

test('failed modern chunk loading disconnects without acknowledgement or false readiness', async (t) => {
  const state = fixture(t);
  await state.runtime.handle(envelope('connect', 'connect', { config: connectConfig }));
  const bot = state.bots[0];
  bot.registry = require('prismarine-registry')('1.21.8');
  let packets = 0;
  bot._client = { state: 'play', write: () => { packets += 1; } };
  bot.waitForChunksToLoad = async () => { throw new Error('test chunk timeout'); };
  spawnBot(bot);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(packets, 0);
  assert.equal(bot.quitCalls, 1);
  assert.equal(state.output.some((message) => message.event?.type === 'mc_error' && /test chunk timeout/.test(message.event.message)), true);
  assert.equal(state.output.some((message) => message.event?.type === 'mc_status' && message.event.status.connected), false);
});

test('strict local mode never sends a planner request to the host provider', async (t) => {
  const state = fixture(t);
  await state.runtime.handle(envelope('1', 'connect', { config: connectConfig }));
  await assert.rejects(state.deps.requestPlannerCompletion({ promptMessages: [] }), /本地指令模式未启用 AI/);
  assert.equal(state.output.some((message) => message.type === 'planner_request'), false);
});

test('disconnect clears transport and stale socket events cannot corrupt new connection', async (t) => {
  const state = fixture(t);
  await state.runtime.handle(envelope('1', 'connect', { config: connectConfig }));
  const old = state.bots[0];
  await state.runtime.handle(envelope('2', 'connect', { config: { ...connectConfig, port: 25566 } }));
  assert.equal(old.quitCalls, 1);
  const count = state.output.length;
  old.emit('error', new Error('stale error'));
  old.emit('end', 'stale end');
  assert.equal(state.output.length, count);
  spawnBot(state.bots[1]);
  state.bots[1].emit('error', new Error('socket failure'));
  assert.equal(state.bots[1].quitCalls, 1);
  assert.equal(state.output.some((msg) => msg.event?.type === 'mc_error' && msg.event.message === 'socket failure'), true);
  const status = state.output.filter((msg) => msg.event?.type === 'mc_status').at(-1).event.status;
  assert.equal(status.connected, false);
});

test('planner results are correlated and pending requests reject on disconnect', async (t) => {
  const state = fixture(t);
  await state.runtime.handle(envelope('1', 'connect', { config: { ...connectConfig, executorMode: 'hybrid' } }));
  spawnBot(state.bots[0]);
  const first = state.deps.requestPlannerCompletion({ promptMessages: [{ role: 'user', content: 'task' }], temperature: 0.1 });
  const request = state.output.at(-1);
  assert.equal(request.type, 'planner_request');
  assert.equal(request.temperature, 0.1);
  await state.runtime.handle(envelope('2', 'planner_result', { requestId: request.requestId, text: '{"mode":"task"}' }));
  assert.equal(await first, '{"mode":"task"}');
  const second = state.deps.requestPlannerCompletion({ promptMessages: [] });
  const rejection = assert.rejects(second, /连接已结束/);
  await state.runtime.handle(envelope('3', 'disconnect'));
  await rejection;
  await state.runtime.handle(envelope('4', 'planner_result', { requestId: request.requestId, text: '{}' }));
  assert.equal(state.output.at(-1).ok, false);
});

test('pause and cancel immediately reject outstanding host planner promises', async (t) => {
  const state = fixture(t);
  await state.runtime.handle(envelope('1', 'connect', { config: { ...connectConfig, executorMode: 'hybrid' } }));
  spawnBot(state.bots[0]);
  for (const action of ['mc_command_pause', 'mc_command_cancel']) {
    const planning = state.deps.requestPlannerCompletion({ promptMessages: [] });
    const rejection = assert.rejects(planning, /旧规划已取消/);
    await state.runtime.handle(envelope(action, 'command', { command: { type: action } }));
    await rejection;
    assert.equal(state.commands.at(-1).type, action);
  }
});

test('death and dimension respawn suspend the playable world, cancel old planning and require a fresh spawn', async (t) => {
  const state = fixture(t);
  await state.runtime.handle(envelope('connect', 'connect', { config: { ...connectConfig, executorMode: 'hybrid' } }));
  const bot = state.bots[0];
  spawnBot(bot);
  for (const [transition, reason] of [['death', 'bot_death'], ['respawn', 'world_transition']]) {
    const pending = state.deps.requestPlannerCompletion({ promptMessages: [{ role: 'user', content: 'old world task' }] });
    const oldRequest = state.output.at(-1);
    const rejection = assert.rejects(pending, /世界|角色|旧规划|连接已结束/);
    bot.emit(transition);
    assert.equal(bot.quitCalls || 0, 0, 'world transition must keep the Minecraft transport open');
    const status = state.output.filter((message) => message.event?.type === 'mc_status').at(-1).event.status;
    assert.equal(status.connected, false);
    await rejection;
    assert.equal(state.agentCalls.includes(reason), true);
    assert.equal(status.health, null);
    assert.equal(status.position, null);
    const control = state.output.filter((message) => message.event?.type === 'mc_control_state').at(-1).event.control;
    assert.equal(control.connectionState, 'connecting');
    await assert.rejects(state.deps.requestPlannerCompletion({ promptMessages: [] }), /世界|角色/);
    for (const command of [{ type: 'mc_command_submit', command: '跟着我' }, { type: 'chat', message: 'not yet' }]) {
      await state.runtime.handle(envelope(`${transition}-${command.type}`, 'command', { command }));
      assert.equal(state.output.at(-1).ok, false);
    }
    const deliveredCommands = state.commands.length;
    await state.runtime.handle(envelope(`${transition}-late-plan`, 'planner_result', { requestId: oldRequest.requestId, text: '{}' }));
    assert.equal(state.output.at(-1).ok, false);
    assert.equal(state.commands.length, deliveredCommands);
    spawnBot(bot);
    assert.deepEqual(state.agentCalls.slice(-2), ['attach', 'initialize']);
    assert.equal(state.output.filter((message) => message.event?.type === 'mc_status').at(-1).event.status.connected, true);
    await state.runtime.handle(envelope(`${transition}-new-task`, 'command', { command: { type: 'mc_command_submit', command: '跟着我' } }));
    assert.equal(state.output.at(-1).ok, true);
  }
});

test('real engine cannot dispatch a late AI plan from a world left by death or dimension change', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-minecraft-transition-'));
  const output = [];
  const goals = [];
  const { Vec3 } = require('vec3');
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 64, 0) }, username: 'DeskPet', health: 20, food: 20,
    entities: {}, players: {}, registry: require('prismarine-registry')('1.20.4'),
    inventory: { items: () => [] }, game: { dimension: 'overworld' },
    _client: { state: 'play', socket: { writable: true, destroyed: false } },
    player: { ping: 1 }, clearControlStates: () => {}, findBlock: () => null,
    findBlocks: () => [], blockAt: () => null, quit: () => {},
    pathfinder: {
      setMovements: () => {}, setGoal: () => {}, stop: () => {},
      goto: async (goal) => { goals.push(goal); },
    },
  });
  const runtime = createRuntime({ dataDir, emit: (message) => output.push(message), createBot: () => bot });
  t.after(() => { runtime.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await runtime.handle(envelope('connect', 'connect', { config: { ...connectConfig, executorMode: 'hybrid' } }));
  const waitForRequest = async (count) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const requests = output.filter((message) => message.type === 'planner_request');
      if (requests.length === count) return requests.at(-1);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('The real engine did not request an AI plan');
  };
  const plan = JSON.stringify({ mode: 'task', intent: 'go_to_position', goal: '旧世界标记', requiresConfirmation: false,
    steps: [{ skill: 'go_to_position', args: { x: 3, y: 64, z: 0 } }], missingResources: [], safetyRisk: '', replyText: '前往旧世界标记。' });
  let requestCount = 0;
  for (const transition of ['death', 'respawn']) {
    bot.emit('spawn');
    await runtime.handle(envelope(`${transition}-task`, 'command', { command: { type: 'mc_command_submit', command: '执行自定义标记点任务' } }));
    const request = await waitForRequest(++requestCount);
    bot.emit(transition);
    await runtime.handle(envelope(`${transition}-late-result`, 'planner_result', { requestId: request.requestId, text: plan }));
    assert.equal(output.at(-1).ok, false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(goals, []);
    const snapshot = output.filter((message) => message.event?.type === 'mc_task_status').at(-1).event;
    assert.equal(snapshot.foregroundTask.status, 'failed');
    assert.equal(snapshot.history.at(-1).status, 'failed');
  }
});

test('Microsoft device login is scoped to this runtime profile and ignores stale device codes', async (t) => {
  const state = fixture(t);
  await state.runtime.handle(envelope('1', 'connect', { config: { ...connectConfig, auth: 'microsoft', username: 'user@example.com' } }));
  const options = state.botConfigs[0];
  assert.equal(options.auth, 'microsoft');
  assert.equal(options.profilesFolder, path.join(state.dataDir, 'microsoft-profiles'));
  options.onMsaCode({ user_code: '1234', verification_uri: 'https://microsoft.com/link', expires_in: 900 });
  assert.equal(state.output.at(-1).event.type, 'mc_auth_device_code');
  await state.runtime.handle(envelope('2', 'disconnect'));
  const count = state.output.length;
  options.onMsaCode({ user_code: 'stale' });
  assert.equal(state.output.length, count);
});

test('actual JSONL process starts, rejects malformed/versioned messages, bounds lines and exits on EOF', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-minecraft-process-'));
  try {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../index.js'), '--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.write('not json\n');
    child.stdin.write(JSON.stringify({ version: 2, id: 'wrong', type: 'connect' }) + '\n');
    child.stdin.write('x'.repeat(MAX_LINE_BYTES + 1));
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('JSONL process shutdown timed out')); }, 10000);
      child.on('error', reject);
      child.on('close', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    assert.equal(code, 0, stderr);
    const messages = stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(messages.some((message) => message.type === 'ready'), true);
    assert.equal(messages.some((message) => message.id === 'wrong' && message.ok === false), true);
    assert.equal(messages.some((message) => message.error?.includes('大小限制')), true);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
