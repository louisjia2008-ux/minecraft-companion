/* global require, process, setTimeout */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createMinecraftTaskAgent } = require('../vendor/server/minecraftTaskAgent');
const { createRuntime } = require('../runtime');

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Planning state transition timed out');
};

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-minecraft-planning-'));
  process.env.MC_AGENT_LEARNING_PATH = path.join(dataDir, 'learning.json');
  process.env.MC_AGENT_DIAGNOSTICS_DIR = path.join(dataDir, 'diagnostics');
  process.env.MC_AGENT_DISCONNECT_TRACE_PATH = path.join(dataDir, 'disconnect.jsonl');
  const pending = [];
  const messages = [];
  const agent = createMinecraftTaskAgent({
    appPaths: { appDataDir: dataDir },
    readConfig: () => ({ mcExecutorMode: 'experimental-autonomy', mcAgentAutoReconnect: false }),
    requestPlannerCompletion: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    parseJsonObjectFromText: JSON.parse,
    broadcast: (message) => messages.push(message),
    broadcastMinecraftError: () => {},
    allowAutonomousMaintenance: () => false,
  });
  const bot = new EventEmitter();
  Object.assign(bot, {
    entity: { position: new Vec3(0, 64, 0) },
    username: 'DeskPet', health: 20, food: 20,
    entities: {}, players: {}, registry: { blocksByName: {}, itemsByName: {} },
    inventory: { items: () => [] }, game: { dimension: 'overworld' },
    _client: { state: 'play', socket: { writable: true, destroyed: false } },
    player: { ping: 1 }, clearControlStates: () => {}, findBlock: () => null, findBlocks: () => [], blockAt: () => null,
  });
  t.after(() => { agent.detachBot('manual_disconnect'); agent.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  agent.attachBot(bot);
  const task = () => {
    let snapshot;
    agent.sendSnapshot({ send: (text) => {
      const value = JSON.parse(text);
      if (value.type === 'mc_task_status') snapshot = value;
    } });
    return snapshot.task;
  };
  return { agent, bot, pending, messages, task };
}

test('real migrated engine pauses planning, ignores cancelled old plan and replans on resume', async (t) => {
  const state = fixture(t);
  await state.agent.handleMessage({ type: 'mc_command_submit', command: '这是一条未注册的自定义任务', context: { playerName: 'Owner' }, source: 'deskpet' });
  await waitFor(() => state.pending.length === 1);
  const taskId = state.task().taskId;
  await state.agent.handleMessage({ type: 'mc_command_pause' });
  state.pending[0].reject(new Error('task paused'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.task().status, 'paused');
  assert.equal(state.task().taskId, taskId);
  assert.equal(state.messages.some((message) => message.type === 'mc_task_event' && message.event.eventType === 'failed'), false);
  await state.agent.handleMessage({ type: 'mc_command_resume' });
  await waitFor(() => state.pending.length === 2);
  assert.equal(state.task().status, 'planning');
  assert.equal(state.task().taskId, taskId);
  const cancelling = state.agent.handleMessage({ type: 'mc_command_cancel' });
  state.pending[1].reject(new Error('task cancelled'));
  await cancelling;
  assert.equal(state.task().status, 'cancelled');
});

test('real migrated engine cancellation during pending planning cannot overwrite cancelled with failed', async (t) => {
  const state = fixture(t);
  await state.agent.handleMessage({ type: 'mc_command_submit', command: '这是一条未注册的自定义任务', source: 'deskpet' });
  await waitFor(() => state.pending.length === 1);
  const cancelling = state.agent.handleMessage({ type: 'mc_command_cancel' });
  state.pending[0].reject(new Error('task cancelled'));
  await cancelling;
  assert.equal(state.task().status, 'cancelled');
  assert.equal(state.messages.some((message) => message.type === 'mc_task_event' && message.event.eventType === 'failed'), false);
});

test('Stop clears passive escort and physical movement after the foreground task has completed', async (t) => {
  const state = fixture(t);
  const movements = { goals: [], clears: 0, activeControls: new Set() };
  state.bot.pathfinder = {
    goal: null,
    setGoal: (goal) => { movements.goals.push(goal); state.bot.pathfinder.goal = goal; },
  };
  state.bot.clearControlStates = () => { movements.clears += 1; movements.activeControls.clear(); };
  assert.equal(state.agent.__testGetReconnectTask(), null);
  assert.equal(state.agent.__testActivatePassiveEscort({ playerName: 'Owner' }), true);
  assert.equal(state.agent.__testHasPassiveEscort(), true);
  const activeGoal = { x: 20, y: 64, z: 20 };
  state.bot.pathfinder.setGoal(activeGoal);
  movements.activeControls.add('forward');
  assert.equal(state.bot.pathfinder.goal, activeGoal);
  const clearsBeforeStop = movements.clears;
  await state.agent.handleMessage({ type: 'mc_command_cancel' });
  assert.equal(state.agent.__testHasPassiveEscort(), false);
  assert.equal(state.agent.getStatusFields().agentMode, 'idle');
  assert.equal(movements.goals.at(-1), null);
  assert.equal(state.bot.pathfinder.goal, null, 'Stop immediately clears an existing movement goal');
  assert.ok(movements.clears > clearsBeforeStop);
  assert.equal(movements.activeControls.size, 0, 'Stop releases an existing movement control');
  const writesAfterStop = movements.goals.length;
  await state.agent.tickIdleBehavior();
  assert.equal(state.agent.__testHasPassiveEscort(), false);
  assert.equal(movements.goals.length, writesAfterStop);
});

test('strict runtime with real migrated planner fails unknown local task without a host planner request', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-minecraft-strict-'));
  const messages = [];
  const bot = new EventEmitter();
  Object.assign(bot, {
    username: 'DeskPet', health: 20, food: 20,
    entities: {}, players: {}, registry: { blocksByName: {}, itemsByName: {} },
    inventory: { items: () => [] }, game: { dimension: 'overworld' },
    _client: { state: 'play', socket: { writable: true, destroyed: false } },
    player: { ping: 1 }, clearControlStates: () => {}, findBlock: () => null,
    findBlocks: () => [], blockAt: () => null, quit: () => {},
  });
  const runtime = createRuntime({
    dataDir, emit: (message) => messages.push(message), createBot: () => bot,
    createAgent: (deps) => {
      const agent = createMinecraftTaskAgent(deps);
      // The fake world has no physics; real planning and command lifecycle remain active.
      agent.initializeBotRuntime = () => true;
      return agent;
    },
  });
  t.after(() => { runtime.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await runtime.handle({ version: 1, id: 'connect', type: 'connect', config: { host: '127.0.0.1', username: 'DeskPet', executorMode: 'strict' } });
  bot.entity = { position: new Vec3(0, 64, 0) };
  bot.emit('spawn');
  await runtime.handle({ version: 1, id: 'task', type: 'command', command: { type: 'mc_command_submit', command: '这是一条未注册的自定义任务' } });
  await waitFor(() => messages.some((message) => message.event?.type === 'mc_task_status' && message.event.task?.status === 'failed'));
  assert.equal(messages.some((message) => message.type === 'planner_request'), false);
});
