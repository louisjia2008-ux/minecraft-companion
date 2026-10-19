/* global require, process, setTimeout */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const goto = require('mineflayer-pathfinder/lib/goto');
const registry = require('prismarine-registry')('1.20.4');
const { createMinecraftTaskAgent } = require('../vendor/server/minecraftTaskAgent');

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error('Running task transition timed out');
};

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-minecraft-pause-run-'));
  const paths = {
    MC_AGENT_LEARNING_PATH: path.join(dataDir, 'learning.json'),
    MC_AGENT_DIAGNOSTICS_DIR: path.join(dataDir, 'diagnostics'),
    MC_AGENT_DISCONNECT_TRACE_PATH: path.join(dataDir, 'disconnect.jsonl'),
  };
  const previousEnvironment = Object.fromEntries(Object.keys(paths).map((key) => [key, process.env[key]]));
  Object.assign(process.env, paths);
  const messages = [];
  const calls = [];
  let plannerRequests = 0;
  const plan = {
    mode: 'task', intent: 'go_to_position', goal: '按顺序走过三个标记点',
    requiresConfirmation: false, missingResources: [], safetyRisk: '',
    replyText: '我会依次走过三个标记点。',
    steps: [3, 20, 30].map((x) => ({ skill: 'go_to_position', args: { x, y: 64, z: 0 } })),
  };
  const bot = new EventEmitter();
  Object.assign(bot, {
    entity: { position: new Vec3(0, 64, 0) }, username: 'DeskPet', health: 20, food: 20,
    entities: {}, players: {}, registry, inventory: { items: () => [] },
    game: { dimension: 'overworld' }, player: { ping: 1 },
    _client: { state: 'play', socket: { writable: true, destroyed: false } },
    clearControlStates: () => {}, findBlock: () => null, findBlocks: () => [], blockAt: () => null,
  });
  bot.pathfinder = {
    setMovements: () => {},
    setGoal: (goal) => { bot.emit('goal_updated', goal); },
    stop: () => { bot.emit('path_stop'); },
    goto: (goal) => {
      calls.push({ x: goal.x, y: goal.y, z: goal.z });
      const running = goto(bot, goal);
      if (goal.x !== 20) {
        bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        bot.emit('goal_reached');
      }
      return running;
    },
  };
  const agent = createMinecraftTaskAgent({
    appPaths: { appDataDir: dataDir },
    readConfig: () => ({ mcExecutorMode: 'experimental-autonomy', mcAgentAutoReconnect: false }),
    requestPlannerCompletion: async () => { plannerRequests += 1; return JSON.stringify(plan); },
    parseJsonObjectFromText: JSON.parse,
    broadcast: (message) => messages.push(message), broadcastMinecraftError: () => {},
    allowAutonomousMaintenance: () => false,
  });
  const snapshot = () => {
    let result;
    agent.sendSnapshot({ send: (text) => {
      const value = JSON.parse(text);
      if (value.type === 'mc_task_status') result = value.task;
    } });
    return result;
  };
  t.after(async () => {
    agent.detachBot('manual_disconnect');
    agent.dispose();
    await sleep(240);
    for (const key of Object.keys(paths)) {
      if (previousEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnvironment[key];
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  agent.attachBot(bot);
  const start = async () => {
    await agent.handleMessage({ type: 'mc_command_submit', command: '执行自定义三点标记任务', source: 'deskpet' });
    await waitFor(() => calls.length === 2);
    assert.deepEqual(calls.map((goal) => goal.x), [3, 20]);
    assert.equal(agent.__testGetReconnectTask().currentStepIndex, 1);
  };
  const finish = async () => {
    bot.entity.position = new Vec3(20, 64, 0);
    bot.emit('goal_reached');
    await waitFor(() => snapshot()?.status === 'completed');
    assert.deepEqual(calls.map((goal) => goal.x), [3, 20, 20, 30], 'resume must preserve the completed prefix');
    assert.equal(plannerRequests, 1, 'manual pause must not trigger an AI revision');
  };
  return { agent, calls, messages, snapshot, start, finish, plannerRequests: () => plannerRequests };
}

test('running pause keeps the real goto stopped and resumes the original unfinished suffix', { timeout: 3_000 }, async (t) => {
  const state = fixture(t);
  await state.start();
  const task = state.agent.__testGetReconnectTask();
  const originalSteps = JSON.parse(JSON.stringify(task.plan.steps));
  await state.agent.handleMessage({ type: 'mc_command_pause' });
  await sleep(450);
  assert.equal(state.snapshot()?.status, 'paused');
  assert.deepEqual(state.calls.map((goal) => goal.x), [3, 20], 'paused task must not dispatch another goto');
  assert.deepEqual(task.plan.steps, originalSteps);
  assert.equal(task.recoveryCount, 0, 'user pause is not an execution failure');
  assert.equal(state.messages.some((message) => message.type === 'mc_task_event' && message.event?.eventType === 'replanned'), false);
  await state.agent.handleMessage({ type: 'mc_command_resume' });
  await waitFor(() => state.calls.length === 3);
  await state.finish();
});

test('immediate resume isolates the old goto rejection from the new execution generation', { timeout: 3_000 }, async (t) => {
  const state = fixture(t);
  await state.start();
  const task = state.agent.__testGetReconnectTask();
  const originalSteps = JSON.parse(JSON.stringify(task.plan.steps));
  await state.agent.handleMessage({ type: 'mc_command_pause' });
  await state.agent.handleMessage({ type: 'mc_command_resume' });
  await waitFor(() => state.calls.length >= 3);
  await sleep(450);
  assert.equal(state.agent.__testGetReconnectTask(), task, 'old execution cannot finish or replace the resumed task');
  assert.equal(state.snapshot()?.status, 'running');
  assert.deepEqual(state.calls.map((goal) => goal.x), [3, 20, 20], 'only the resumed suffix can dispatch movement');
  assert.deepEqual(task.plan.steps, originalSteps);
  assert.equal(task.recoveryCount, 0);
  assert.equal(state.plannerRequests(), 1);
  await state.finish();
});
