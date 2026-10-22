'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createGatherLogsGoal, isLog } = require('../core/goals/gatherBlocks');
const { createBrain } = require('../core/brain');

// Logs exist at fixed positions; some cannot be reached. The fake actions move
// items into the inventory the way the server would.
function makeForest(positions, unreachable = new Set()) {
  const blocks = new Map(positions.map((p) => [`${p.x},${p.y},${p.z}`, { name: 'oak_log', position: p }]));
  const inventory = {};
  const attempts = [];
  const actions = {
    async goToDig(bot, ctx, block) {
      attempts.push(`${block.position.x},${block.position.y},${block.position.z}`);
      return unreachable.has(attempts.at(-1)) ? { ok: false, reason: 'NoPath' } : { ok: true };
    },
    async digBlock(bot, ctx, block) {
      blocks.delete(`${block.position.x},${block.position.y},${block.position.z}`);
      return { ok: true };
    },
    async collectDrops() {
      inventory.oak_log = (inventory.oak_log || 0) + 1;
      return { ok: true, gained: 1 };
    },
  };
  const perceive = () => ({ alive: true, position: new Vec3(0, 64, 0), inventory: { ...inventory } });
  return { blocks, inventory, attempts, actions, perceive, findTargets: () => [...blocks.values()] };
}

async function drive(brain, done, limit = 200) {
  for (let i = 0; i < limit && !done(); i += 1) {
    await brain.tick();
    await brain.idle();
  }
}

test('isLog accepts natural logs only', () => {
  assert.ok(isLog('oak_log'));
  assert.ok(isLog('spruce_log'));
  assert.ok(!isLog('stripped_oak_log'));
  assert.ok(!isLog('oak_planks'));
});

test('gathers nearest low logs first and finishes at the target count', async () => {
  const forest = makeForest([new Vec3(5, 66, 0), new Vec3(5, 64, 0), new Vec3(5, 65, 0), new Vec3(30, 64, 0)]);
  const goal = createGatherLogsGoal({ bot: null, count: 3, baseline: 0, actions: forest.actions, findTargets: forest.findTargets });
  const events = [];
  const brain = createBrain({ perceive: forest.perceive, goalRetryDelayMs: 0, onEvent: (e) => events.push(e) });
  brain.setGoal(goal);
  await drive(brain, () => events.some((e) => e.type === 'goal_done'));
  assert.deepEqual(forest.attempts, ['5,64,0', '5,65,0', '5,66,0']);
  assert.equal(forest.inventory.oak_log, 3);
});

test('an unreachable log is blacklisted and another tree is chosen', async () => {
  const forest = makeForest([new Vec3(3, 64, 0), new Vec3(10, 64, 0), new Vec3(12, 64, 0)], new Set(['3,64,0']));
  const goal = createGatherLogsGoal({ bot: null, count: 2, baseline: 0, actions: forest.actions, findTargets: forest.findTargets });
  const events = [];
  const brain = createBrain({ perceive: forest.perceive, goalRetryDelayMs: 0, onEvent: (e) => events.push(e) });
  brain.setGoal(goal);
  await drive(brain, () => events.some((e) => e.type === 'goal_done'));
  assert.deepEqual(forest.attempts, ['3,64,0', '10,64,0', '12,64,0']);
});

test('no reachable logs ends in goal_failed, not an endless loop', async () => {
  const forest = makeForest([new Vec3(3, 64, 0)], new Set(['3,64,0']));
  const goal = createGatherLogsGoal({ bot: null, count: 2, baseline: 0, actions: forest.actions, findTargets: forest.findTargets });
  const events = [];
  const brain = createBrain({ perceive: forest.perceive, noProgressLimit: 4, goalRetryDelayMs: 0, onEvent: (e) => events.push(e) });
  brain.setGoal(goal);
  await drive(brain, () => events.some((e) => e.type === 'goal_failed'));
  const failed = events.find((e) => e.type === 'goal_failed');
  assert.deepEqual(failed.reasons, ['NoPath', 'no_target_in_range', 'no_target_in_range', 'no_target_in_range']);
  assert.equal(forest.attempts.length, 1);
});
