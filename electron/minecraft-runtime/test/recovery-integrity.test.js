/* global require, process, setTimeout */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createMinecraftActionRegistry } = require('../vendor/server/action/actionRegistry');
const { createMinecraftTaskAgent } = require('../vendor/server/minecraftTaskAgent');
const { CancellationToken } = require('../vendor/server/minecraft/agentControl');
const { buildRecoveryPlan } = require('../vendor/server/minecraft/taskRecovery');

const registry = createMinecraftActionRegistry();
const step = (skill, args) => registry.createActionStep(skill, args);
const taskFor = (steps, intent = 'custom_route', currentStepIndex = 0) => ({
  source: 'deskpet', intent, currentStepIndex, recoveryCount: 0, maxRecoveryAttempts: 5,
  plan: { mode: 'task', intent, goal: '保留用户的最终目标', steps, postTaskMode: null },
});
const identity = (steps) => steps.map((value) => [value.skill, value.args.item || value.args.block || value.args.x]);

test('stage recovery retains the failed objective and every unfinished later step', () => {
  const task = taskFor([step('go_to_position', { x: 3, y: 64, z: 0 }), step('go_to_position', { x: 20, y: 64, z: 0 }), step('go_to_position', { x: 30, y: 64, z: 0 })], 'custom_route', 1);
  const repaired = registry.buildStageRevisionPlan(task, { code: 'no_path' });
  assert.deepEqual(identity(repaired.steps), [['go_to_position', 20], ['go_to_position', 30]]);
  assert.equal(repaired.goal, task.plan.goal);
  assert.equal(repaired.intent, task.intent);
});

test('craft recovery repairs its current tool then continues the original diamond goal and return step', () => {
  const task = taskFor([step('craft_item', { item: 'stone_pickaxe', count: 2 }), step('mine_resource', { block: 'diamond', count: 3 }), step('follow_player', { playerName: 'Owner', once: true })], 'mine_diamond_resource');
  const repaired = registry.buildRecoveryPlan(task, { code: 'insufficient_material' }, { buildCraftRecoveryPlan: (item) => registry.buildCraftRecoveryPlan(item) });
  assert.deepEqual(identity(repaired.steps).slice(-3), [['craft_item', 'stone_pickaxe'], ['mine_resource', 'diamond'], ['follow_player', undefined]]);
  assert.equal(repaired.steps.at(-3).args.count, 2);
  assert.equal(repaired.goal, task.plan.goal);
  assert.equal(repaired.intent, task.intent);
});

test('diamond recovery selects the diamond objective after ore prerequisites and preserves the return suffix', () => {
  const task = taskFor([step('mine_resource', { block: 'coal', count: 2 }), step('mine_resource', { block: 'iron_ore', count: 3 }), step('craft_item', { item: 'iron_pickaxe' }), step('mine_resource', { block: 'deepslate_diamond_ore', count: 3 }), step('follow_player', { playerName: 'Owner', once: true })], 'mine_diamond_resource', 3);
  const repaired = registry.buildRecoveryPlan(task, { code: 'no_path' }, { hasDiamondMiningPickaxe: () => true, buildToolProgressionPlan: () => [], getLearnedSearchRadius: () => 80 });
  assert.deepEqual(identity(repaired.steps), [['mine_resource', 'deepslate_diamond_ore'], ['follow_player', undefined]]);
  assert.equal(repaired.steps[0].args.count, 3);
  assert.equal(repaired.goal, task.plan.goal);
});

test('learned task plans cannot replace a fresh resource or append an old objective', () => {
  const old = { mode: 'task', intent: 'mine_resource', goal: '旧铁矿目标', steps: [step('mine_resource', { block: 'iron_ore', count: 8 }), step('go_to_position', { x: 90, y: 64, z: 0 })] };
  const fresh = { mode: 'task', intent: 'mine_resource', goal: '新金矿目标', steps: [step('mine_resource', { block: 'gold_ore', count: 2 })] };
  const merged = registry.mergeTaskScriptPlan(old, fresh, { getTaskScriptStepSignature: registry.getTaskScriptStepSignature, pickTaskScriptDynamicArgs: registry.pickTaskScriptDynamicArgs });
  assert.deepEqual(identity(merged.steps), [['mine_resource', 'gold_ore']]);
  assert.equal(merged.steps[0].args.count, 2);
  assert.equal(merged.goal, fresh.goal);
});

test('learned stage templates cannot substitute another item or self-maintenance action', () => {
  for (const [oldStep, freshStep] of [[step('craft_item', { item: 'wooden_pickaxe' }), step('craft_item', { item: 'iron_pickaxe' })], [step('maintain_self', { action: 'attack_ender_dragon' }), step('maintain_self', { action: 'ensure_food', minFood: 16 })]]) {
    const plan = { mode: 'task', intent: 'custom_task', goal: '新目标', steps: [freshStep] };
    const applied = registry.applyLearnedStageScripts(plan, {}, { findBestLearnedStageScript: () => ({ key: 'old', score: 99, bucket: { templateStep: oldStep, success: 5 } }) });
    assert.deepEqual(applied.steps[0].args, freshStep.args);
  }
});

test('the declared recovery budget is bounded without silently reducing a twelve-attempt budget to eight', () => {
  const task = { ...taskFor([step('go_to_position', { x: 20, y: 64, z: 0 })]), maxRecoveryAttempts: 12, recoveryCount: 8 };
  const context = { actionRegistry: registry, buildStageRevisionPlan: (value, failure) => registry.buildStageRevisionPlan(value, failure) };
  assert.ok(buildRecoveryPlan(task, { code: 'no_path' }, context));
  assert.equal(buildRecoveryPlan({ ...task, recoveryCount: 12 }, { code: 'no_path' }, context), null);
});

function engineFixture(t, plan, failFirst = false) {
  const options = typeof failFirst === 'object' ? failFirst : { failFirst };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-recovery-integrity-'));
  const names = ['MC_AGENT_LEARNING_PATH', 'MC_AGENT_DIAGNOSTICS_DIR', 'MC_AGENT_DISCONNECT_TRACE_PATH'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { MC_AGENT_LEARNING_PATH: path.join(dataDir, 'learning.json'), MC_AGENT_DIAGNOSTICS_DIR: path.join(dataDir, 'diagnostics'), MC_AGENT_DISCONNECT_TRACE_PATH: path.join(dataDir, 'disconnect.jsonl') });
  const messages = [];
  const goals = [];
  let attempts = 0;
  let plannerRequests = 0;
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 64, 0) }, username: 'DeskPet', health: 20, food: 20,
    entities: {}, players: {}, registry: require('prismarine-registry')('1.20.4'), inventory: { items: () => [] }, game: { dimension: 'overworld' },
    _client: { state: 'play', socket: { writable: true, destroyed: false } }, player: { ping: 1 },
    clearControlStates: () => {}, findBlock: () => null, findBlocks: () => [], blockAt: () => null,
    pathfinder: { setMovements: () => {}, setGoal: () => {}, stop: () => {}, goto: async (goal) => {
      goals.push(goal.x);
      if ((options.failFirst || goal.x === options.failAtX) && ++attempts === 1) throw Object.assign(new Error(options.failureMessage || 'No path to the goal'), { code: 'no_path' });
      bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
    } },
  });
  const agent = createMinecraftTaskAgent({ appPaths: { appDataDir: dataDir }, readConfig: () => ({ mcExecutorMode: 'experimental-autonomy', mcTaskMaxRecoveryAttempts: 5, mcAgentAutoReconnect: false, mcAiMidTaskRevision: Boolean(options.revisedPlan), mcAiMidTaskRevisionMaxPerTask: 1 }), requestPlannerCompletion: async () => JSON.stringify(++plannerRequests === 1 ? plan : options.revisedPlan), parseJsonObjectFromText: JSON.parse, broadcast: (message) => messages.push(message), broadcastMinecraftError: () => {}, allowAutonomousMaintenance: () => false });
  agent.attachBot(bot);
  agent.initializeBotRuntime();
  t.after(() => { agent.detachBot('manual_disconnect'); agent.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const snapshot = () => { let task; agent.sendSnapshot({ send: (text) => { const value = JSON.parse(text); if (value.type === 'mc_task_status') task = value.task; } }); return task; };
  const settled = async () => { for (let attempt = 0; attempt < 400; attempt += 1) { const task = snapshot(); if (['completed', 'blocked', 'failed'].includes(task?.status)) return task; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error('Real engine did not settle'); };
  return { agent, bot, messages, goals, snapshot, settled };
}

test('real engine completes the whole two-point route after a recoverable failure at its first point', async (t) => {
  const plan = { mode: 'task', intent: 'custom_route', goal: '先到10再到20', steps: [step('go_to_position', { x: 10, y: 64, z: 0 }), step('go_to_position', { x: 20, y: 64, z: 0 })] };
  const state = engineFixture(t, plan, true);
  await state.agent.handleMessage({ type: 'mc_command_submit', command: '执行自定义双标记路线', source: 'deskpet' });
  const result = await state.settled();
  assert.equal(result.status, 'completed');
  assert.deepEqual(state.goals, [10, 10, 20]);
  assert.equal(result.recoveryCount, 1, 'one physical failure consumes one task-plan recovery, not two');
  assert.equal(result.plan.goal, plan.goal);
  assert.equal(result.plan.intent, plan.intent);
  assert.deepEqual(result.plan.steps[1].args, plan.steps[1].args, 'a recovery must not revise the untouched suffix');
});

test('real AI revision runs its repair prefix from zero and retains the original coordinate target, goal and suffix', async (t) => {
  const plan = { mode: 'task', intent: 'custom_route', goal: '先到3，再到10，最后到20', steps: [step('go_to_position', { x: 3, y: 64, z: 0 }), step('go_to_position', { x: 10, y: 64, z: 0 }), step('go_to_position', { x: 20, y: 64, z: 0 })] };
  const revisedPlan = { mode: 'task', intent: 'changed_route', goal: '改为去99', steps: [step('go_to_position', { x: 7, y: 64, z: 0 }), step('go_to_position', { x: 10, y: 64, z: 0 }), step('go_to_position', { x: 99, y: 64, z: 0 })] };
  const state = engineFixture(t, plan, { failAtX: 10, failureMessage: 'Synthetic execution failure', revisedPlan });
  await state.agent.handleMessage({ type: 'mc_command_submit', command: '执行自定义多标记路线', source: 'deskpet' });
  const result = await state.settled();
  assert.equal(result.status, 'completed');
  assert.equal(result.aiMidTaskRevisionCount, 1);
  assert.deepEqual(state.goals, [3, 10, 7, 10, 20]);
  assert.equal(result.plan.goal, plan.goal);
  assert.equal(result.plan.intent, plan.intent);
  assert.equal(result.recoveryCount, 1);
});

test('real AI revision that removes the failed coordinate objective is rejected without executing its replacement', async (t) => {
  const plan = { mode: 'task', intent: 'custom_route', goal: '到10再到20', steps: [step('go_to_position', { x: 10, y: 64, z: 0 }), step('go_to_position', { x: 20, y: 64, z: 0 })] };
  const revisedPlan = { mode: 'task', intent: 'changed_route', goal: '只去99', steps: [step('go_to_position', { x: 99, y: 64, z: 0 })] };
  const state = engineFixture(t, plan, { failFirst: true, failureMessage: 'Synthetic execution failure', revisedPlan });
  await state.agent.handleMessage({ type: 'mc_command_submit', command: '执行自定义多标记路线', source: 'deskpet' });
  const result = await state.settled();
  assert.equal(result.status, 'blocked');
  assert.deepEqual(state.goals, [10]);
  assert.equal(result.aiMidTaskRevisionCount, 0);
  assert.equal(result.plan.goal, plan.goal);
});

test('real completion verification rejects a repaired diamond task with no diamond inventory', async (t) => {
  const state = engineFixture(t, {});
  const original = { mode: 'task', intent: 'mine_diamond_resource', goal: '挖到3个钻石', steps: [step('mine_resource', { block: 'diamond', count: 3 })] };
  const task = { ...taskFor([step('go_to_position', { x: 10, y: 64, z: 0 })], 'mine_diamond_resource'), taskId: 'diamond-test', userCommand: '挖3个钻石', status: 'paused', currentStepIndex: 0, logs: [], createdAt: Date.now(), planApproval: { required: false }, cancellationToken: new CancellationToken(), completionPlan: original };
  state.agent.__testSetReconnectTask(task);
  await state.agent.handleMessage({ type: 'mc_command_resume' });
  const result = await state.settled();
  assert.equal(result.status, 'failed');
  assert.match(result.error, /钻石目标尚未完成/);
  assert.equal(state.messages.some((message) => message.type === 'mc_task_event' && message.event.eventType === 'completed'), false);
});
