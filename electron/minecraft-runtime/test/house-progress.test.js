/* global require, process */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const { createMinecraftTaskAgent } = require('../vendor/server/minecraftTaskAgent');
const { createMinecraftActionRegistry } = require('../vendor/server/action/actionRegistry');
const { createSmallHousePlaybookBlueprint } = require('../vendor/server/minecraft/buildingBlueprints');

const anchor = { x: 0, y: 64, z: 0 };
const key = (position) => `${position.x}:${position.y}:${position.z}`;
const stepFor = (phase) => ({ skill: 'build_small_house_phase', args: { phase, anchor, material: 'any_planks' } });

function fixture(t, items = []) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-minecraft-house-'));
  process.env.MC_AGENT_LEARNING_PATH = path.join(dataDir, 'learning.json');
  process.env.MC_AGENT_DIAGNOSTICS_DIR = path.join(dataDir, 'diagnostics');
  process.env.MC_AGENT_DISCONNECT_TRACE_PATH = path.join(dataDir, 'disconnect.jsonl');
  const agent = createMinecraftTaskAgent({
    appPaths: { appDataDir: dataDir },
    readConfig: () => ({ mcExecutorMode: 'strict-executor', mcAgentAutoReconnect: false }),
    requestPlannerCompletion: async () => { throw new Error('Unexpected planner request'); },
    parseJsonObjectFromText: JSON.parse, broadcast: () => {}, broadcastMinecraftError: () => {},
    allowAutonomousMaintenance: () => false,
  });
  const world = new Map();
  const bot = new EventEmitter();
  Object.assign(bot, {
    entity: { position: new Vec3(1.5, 64, 1.5), width: 0.6, height: 1.8, eyeHeight: 1.62, onGround: true }, username: 'DeskPet', health: 20, food: 20,
    entities: {}, players: {}, registry, inventory: { items: () => items },
    game: { dimension: 'overworld' }, _client: { state: 'play', socket: { writable: true, destroyed: false } },
    player: { ping: 1 }, clearControlStates: () => {}, findBlock: () => null, findBlocks: () => [],
    blockAt: (position) => {
      const name = world.get(key(position)) || 'air';
      return { name, position: new Vec3(position.x, position.y, position.z), boundingBox: name === 'air' ? 'empty' : 'block' };
    },
    canDigBlock: () => { throw new Error('Completed house must never be dug'); },
    equip: async (item) => { bot.heldItem = item; }, lookAt: async () => {},
    placeBlock: async (block, face) => {
      const target = block.position.plus(face);
      const feet = bot.entity.position;
      assert.equal(feet.x + 0.3 > target.x && feet.x - 0.3 < target.x + 1 &&
        feet.z + 0.3 > target.z && feet.z - 0.3 < target.z + 1 &&
        feet.y + 1.8 > target.y && feet.y < target.y + 1, false,
      'The controlled placement fixture must not accept a block inside the player body');
      world.set(key(target), bot.heldItem.name);
      bot.heldItem.count -= 1;
    },
    pathfinder: { setMovements: () => {}, stop: () => {}, setGoal: () => {}, goto: async (goal) => {
      if (goal.isEnd?.(bot.entity.position.floored())) return;
      bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
    } },
  });
  agent.attachBot(bot);
  const task = { taskId: 'house', source: 'autonomous', status: 'running', intent: 'build_small_house', logs: [], plan: { steps: [] } };
  agent.__testSetReconnectTask(task);
  const support = () => {
    for (let x = 0; x < 3; x += 1) for (let z = 0; z < 3; z += 1) world.set(`${x}:63:${z}`, 'stone');
  };
  t.after(() => {
    agent.__testSetReconnectTask(null); agent.detachBot('manual_disconnect'); agent.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const standInsideCompletedHouse = () => {
    // A completed floor occupies Y=64. The player's feet belong on its top,
    // at Y=65 and in the centre of the open interior, not inside that floor.
    bot.entity.position = new Vec3(1.5, 65, 1.5);
    assert.equal(world.get('1:64:1'), 'oak_planks');
    assert.equal(world.has('1:65:1'), false);
    assert.equal(world.has('1:66:1'), false);
  };
  return { agent, bot, world, task, support, standInsideCompletedHouse };
}

test('house material budget includes all eight missing supports on an accepted site', async (t) => {
  const { agent, world, task } = fixture(t, [{ name: 'oak_planks', count: 39 }]);
  world.set('0:63:0', 'stone');
  assert.deepEqual(agent.__testGetSmallHouseRemainingMaterials(anchor, stepFor('prepare_materials')), {
    missingStructureBlocks: 31, missingSupportBlocks: 8, requiredBlocks: 39,
  });
  await agent.__testExecuteBuildSmallHousePhase(stepFor('prepare_materials'));
  assert.equal(task.stepCheckpoint.materialSummary.requiredBlocks, 39);
});

test('material recovery only budgets the unbuilt roof and retains completed floor and walls', async (t) => {
  const { agent, world, support, task } = fixture(t, [{ name: 'oak_planks', count: 9 }]);
  support();
  for (const block of createSmallHousePlaybookBlueprint(anchor, {})) {
    if (block.position.y < 67) world.set(key(block.position), 'spruce_planks');
  }
  await agent.__testExecuteBuildSmallHousePhase(stepFor('prepare_materials'));
  assert.equal(task.stepCheckpoint.materialSummary.requiredBlocks, 9);
  assert.equal(task.stepCheckpoint.materialSummary.missingStructureBlocks, 9);
});

test('resuming clear_site preserves all 31 blocks of the existing blueprint', async (t) => {
  const { agent, world, support } = fixture(t);
  support();
  const blueprint = createSmallHousePlaybookBlueprint(anchor, {});
  for (const block of blueprint) world.set(key(block.position), 'oak_planks');
  const before = [...world.entries()];
  await agent.__testExecuteBuildSmallHousePhase(stepFor('prepare_materials'));
  await agent.__testExecuteBuildSmallHousePhase(stepFor('clear_site'));
  assert.deepEqual([...world.entries()], before);
  await agent.__testExecuteBuildSmallHousePhase(stepFor('verify'));
});

test('another player filling a scheduled block before placement does not require extra inventory', async (t) => {
  const { agent, bot } = fixture(t);
  let reads = 0;
  bot.blockAt = (position) => ({ name: ++reads === 1 ? 'air' : 'oak_planks', position, boundingBox: 'block' });
  await agent.__testExecuteBlueprintPhase(anchor, '墙体', [{ position: anchor, item: 'any_planks' }]);
  assert.ok(reads >= 3);
});

test('clear_site removes terrain at floor height while preserving existing wooden structure', async (t) => {
  const { agent, bot, world, support, standInsideCompletedHouse } = fixture(t, [{ name: 'oak_planks', count: 1, type: registry.itemsByName.oak_planks.id }]);
  support();
  const blueprint = createSmallHousePlaybookBlueprint(anchor, {});
  for (const block of blueprint) world.set(key(block.position), 'oak_planks');
  standInsideCompletedHouse();
  world.set(key(anchor), 'dirt');
  const digs = [];
  bot.dig = async (block) => { digs.push(key(block.position)); world.delete(key(block.position)); };
  await agent.__testExecuteBuildSmallHousePhase(stepFor('clear_site'));
  assert.deepEqual(digs, [key(anchor)]);
  assert.equal(world.has(key(anchor)), false);
  await agent.__testExecuteBuildSmallHousePhase(stepFor('place_floor'));
  await agent.__testExecuteBuildSmallHousePhase(stepFor('verify'));
  assert.equal(world.get(key(anchor)), 'oak_planks');
});

test('a real failed house verification resumes, places its one missing roof block, and passes', async (t) => {
  const { agent, world, support, task, standInsideCompletedHouse } = fixture(t, [{ name: 'oak_planks', count: 1, type: registry.itemsByName.oak_planks.id }]);
  support();
  const blueprint = createSmallHousePlaybookBlueprint(anchor, {});
  for (const block of blueprint) world.set(key(block.position), 'oak_planks');
  standInsideCompletedHouse();
  const missing = blueprint.at(-1);
  world.delete(key(missing.position));
  const actions = createMinecraftActionRegistry();
  task.plan = actions.buildHeuristicTaskPlan('build_small_house', {});
  task.currentStepIndex = task.plan.steps.length - 1;
  task.stepCheckpoint = { anchor };
  await assert.rejects(agent.__testExecuteBuildSmallHousePhase(stepFor('verify')), /还缺 1/);
  const recovery = actions.buildRecoveryPlan(task, { code: 'generic_failure' });
  for (const step of recovery.steps) await agent.__testExecuteBuildSmallHousePhase(step);
  assert.equal(world.get(key(missing.position)), 'oak_planks');
  assert.equal(task.stepCheckpoint.verificationSummary.missingBlocks, 0);
});

for (const code of ['generic_failure', 'insufficient_material']) {
  test(`house verify recovery repairs missing blocks and retains the following return step (${code})`, () => {
    const actions = createMinecraftActionRegistry();
    const plan = actions.buildHeuristicTaskPlan('build_small_house', {});
    const lastIndex = plan.steps.length - 1;
    const returnStep = { skill: 'go_to_position', args: { x: 20, y: 64, z: 0 } };
    plan.steps.push(returnStep);
    const recovery = actions.buildRecoveryPlan({ intent: 'build_small_house', currentStepIndex: lastIndex, plan, stepCheckpoint: { anchor } }, { code });
    assert.deepEqual(recovery.steps.slice(0, -1).map((step) => step.args.phase), [
      'prepare_materials', 'clear_site', 'place_floor', 'place_walls', 'place_roof', 'verify',
    ]);
    assert.equal(recovery.steps.at(-1), returnStep);
    assert.equal(recovery.goal, plan.goal);
    assert.deepEqual(recovery.steps[0].args.anchor, anchor);
  });
}

test('house clear-site revision keeps the selected anchor instead of pretending to select a new site', () => {
  const actions = createMinecraftActionRegistry();
  const plan = actions.buildHeuristicTaskPlan('build_small_house', {});
  const currentStepIndex = plan.steps.findIndex((step) => step.args.phase === 'clear_site');
  plan.steps[currentStepIndex].args.anchor = anchor;
  const recovery = actions.buildRecoveryPlan({ intent: 'build_small_house', currentStepIndex, plan }, { code: 'no_path' });
  assert.deepEqual(recovery.steps[0].args.anchor, anchor);
});

test('non-playbook house recovery keeps the requested dimensions, anchor, and unfinished suffix', () => {
  const actions = createMinecraftActionRegistry();
  const returnStep = { skill: 'go_to_position', args: { x: 20, y: 64, z: 0 } };
  const plan = { intent: 'build_small_house', goal: 'build a stone house and return', steps: [
    { skill: 'build_structure', args: { material: 'cobblestone', width: 4, depth: 4, height: 2 } }, returnStep,
  ] };
  const recovery = actions.buildRecoveryPlan({ intent: plan.intent, currentStepIndex: 0, plan, stepCheckpoint: { anchor } }, { code: 'insufficient_material' });
  assert.equal(recovery.goal, plan.goal);
  assert.equal(recovery.steps[0].args.width, 4);
  assert.equal(recovery.steps[0].args.depth, 4);
  assert.deepEqual(recovery.steps[0].args.position, anchor);
  assert.equal(recovery.steps.at(-1), returnStep);
});

test('a return step after house construction can still recover without rebuilding the house', () => {
  const actions = createMinecraftActionRegistry();
  const plan = actions.buildHeuristicTaskPlan('build_small_house', {});
  const currentStepIndex = plan.steps.length;
  plan.steps.push({ skill: 'go_to_position', args: { x: 20, y: 64, z: 0 } });
  plan.steps.push({ skill: 'go_to_position', args: { x: 30, y: 64, z: 0 } });
  const recovery = actions.buildStageRevisionPlan({ intent: plan.intent, currentStepIndex, plan }, { code: 'no_path' });
  assert.ok(recovery);
  assert.deepEqual(recovery.steps.map((step) => step.args.x), [20, 30]);
  assert.equal(recovery.goal, plan.goal);
});

test('completion after a return-only recovery uses the original house objective and its verified checkpoint', async (t) => {
  const { agent, task } = fixture(t);
  const actions = createMinecraftActionRegistry();
  task.completionPlan = actions.buildHeuristicTaskPlan('build_small_house', {});
  task.plan = { intent: 'build_small_house', steps: [{ skill: 'go_to_position', args: { x: 20, y: 64, z: 0 } }] };
  task.stepCheckpoint = { anchor, verificationSummary: { totalBlocks: 31, missingBlocks: 0 } };
  assert.equal(await agent.__testVerifyTaskCompletion(task), true);
  task.stepCheckpoint.verificationSummary.missingBlocks = 1;
  await assert.rejects(agent.__testVerifyTaskCompletion(task), /最终校验没有通过/);
});
