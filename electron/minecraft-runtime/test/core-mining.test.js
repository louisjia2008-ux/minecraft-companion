'use strict';
// Branch-mining rules on a block grid: which tunnel steps are safe to dig,
// and how the main tunnel and its side branches advance.
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectStep, advance, BRANCH_EVERY, BRANCH_LENGTH } = require('../core/mining');

// Solid stone everywhere below y=10, air above; `put` overrides single cells.
function grid(put = {}) {
  return (x, y, z) => {
    const k = `${x},${y},${z}`;
    const name = k in put ? put[k] : y >= 10 ? 'air' : 'stone';
    if (name === null) return null;
    return { name, boundingBox: ['air', 'cave_air', 'water', 'lava', 'torch'].includes(name) ? 'empty' : 'block' };
  };
}
const EAST = 0;

test('a level step in solid rock digs head then feet cell', () => {
  const step = inspectStep(grid({ '0,5,0': 'air', '0,6,0': 'air' }), { x: 0, y: 5, z: 0 }, EAST, { surfaceY: 10 });
  assert.deepEqual(step, { ok: true, target: { x: 1, y: 5, z: 0 }, dig: [{ x: 1, y: 6, z: 0 }, { x: 1, y: 5, z: 0 }] });
});

test('a stair step down clears three cells so the head fits through', () => {
  const step = inspectStep(grid(), { x: 0, y: 5, z: 0 }, EAST, { descend: true, surfaceY: 10 });
  assert.equal(step.ok, true);
  assert.deepEqual(step.target, { x: 1, y: 4, z: 0 });
  assert.deepEqual(step.dig.map((p) => p.y), [6, 5, 4]);
});

test('the first stair step from the surface only digs the ground', () => {
  const step = inspectStep(grid(), { x: 0, y: 10, z: 0 }, EAST, { descend: true, surfaceY: 9 });
  assert.equal(step.ok, true);
  assert.deepEqual(step.dig, [{ x: 1, y: 9, z: 0 }]);
});

test('water or lava beside any dug cell turns the tunnel', () => {
  for (const liquid of ['water', 'lava']) {
    for (const cell of ['2,5,0', '1,7,0', '1,5,1', '1,4,0']) {
      const step = inspectStep(grid({ [cell]: liquid }), { x: 0, y: 5, z: 0 }, EAST, { surfaceY: 10 });
      assert.deepEqual([step.ok, step.reason], [false, 'liquid'], `${liquid} at ${cell}`);
    }
  }
});

test('breaking into a cave is refused; open air above the surface line is fine', () => {
  const cave = inspectStep(grid({ '1,5,1': 'cave_air' }), { x: 0, y: 5, z: 0 }, EAST, { surfaceY: 10 });
  assert.deepEqual([cave.ok, cave.reason], [false, 'cave']);
  const open = inspectStep(grid({ '1,5,0': 'cave_air' }), { x: 0, y: 5, z: 0 }, EAST, { surfaceY: 10 });
  assert.deepEqual([open.ok, open.reason], [false, 'cave']);
  const hole = inspectStep(grid({ '1,4,0': 'air' }), { x: 0, y: 5, z: 0 }, EAST, { surfaceY: 10 });
  assert.deepEqual([hole.ok, hole.reason], [false, 'cave']);
});

test('gravel overhead or underfoot, and unloaded chunks, stop the step', () => {
  assert.equal(inspectStep(grid({ '1,7,0': 'gravel' }), { x: 0, y: 5, z: 0 }, EAST, { surfaceY: 10 }).reason, 'gravity');
  assert.equal(inspectStep(grid({ '1,4,0': 'sand' }), { x: 0, y: 5, z: 0 }, EAST, { surfaceY: 10 }).reason, 'gravity');
  assert.equal(inspectStep(grid({ '2,5,0': null }), { x: 0, y: 5, z: 0 }, EAST, { surfaceY: 10 }).reason, 'unloaded');
});

test('the main tunnel opens a branch to each side every few blocks, then carries on', () => {
  const mine = { phase: 'main', dir: EAST, mainSteps: 0, front: { x: 0, y: 5, z: 0 }, branch: null };
  for (let i = 0; i < BRANCH_EVERY; i += 1) advance(mine);
  assert.equal(mine.phase, 'branch');
  assert.equal(mine.branch.side, 1);
  const junction = mine.branch.origin;
  for (let i = 0; i < BRANCH_LENGTH; i += 1) advance(mine);
  assert.deepEqual([mine.phase, mine.branch.side, mine.front], ['branch', -1, junction]);
  for (let i = 0; i < BRANCH_LENGTH; i += 1) advance(mine);
  assert.deepEqual([mine.phase, mine.branch, mine.front], ['main', null, junction]);
});

test('the way out and back follows the tunnel the bot dug, a few blocks per leg', async () => {
  const { walkTunnel } = require('../core/mining');
  const { Vec3 } = require('vec3');
  // Staircase east from (0,10,0) down to y=2, then a branch north from (8,2,0).
  const cells = { '0,10,0': null };
  let prev = '0,10,0';
  for (let i = 1; i <= 8; i += 1) { const k = `${i},${10 - i},0`; cells[k] = prev; prev = k; }
  for (let i = 1; i <= 5; i += 1) { const k = `8,2,${-i}`; cells[k] = prev; prev = k; }
  const mine = { entrance: { x: 0, y: 10, z: 0 }, front: { x: 8, y: 2, z: 0 }, cells, walkFailures: 0 };
  const walked = [];
  const bot = { entity: { position: new Vec3(8.5, 2, -5.5) } };
  const actions = { goTo: async (_bot, _ctx, goal) => {
    walked.push(`${goal.x},${goal.y},${goal.z}`);
    bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
    return { ok: true };
  } };
  const ctx = {};
  // From the end of the branch to the front (the junction): back along the branch.
  while (await walkTunnel(bot, ctx, mine, 'front', actions));
  assert.deepEqual(walked, ['8,2,0']);
  // Out to the entrance in legs of at most six blocks.
  walked.length = 0;
  while (await walkTunnel(bot, ctx, mine, 'out', actions));
  assert.deepEqual(walked, ['2,8,0', '0,10,0']);
  // From home back down to the front: entrance, then down the stairs.
  bot.entity.position = new Vec3(30, 10, 30);
  walked.length = 0;
  while (await walkTunnel(bot, ctx, mine, 'front', actions));
  assert.deepEqual(walked, ['0,10,0', '6,4,0', '8,2,0']);
});

test('a front that every leg falls short of is given up instead of walked at forever', async () => {
  const { mineStep } = require('../core/mining');
  const { Vec3 } = require('vec3');
  const cells = { '0,10,0': null, '1,9,0': '0,10,0', '2,8,0': '1,9,0' };
  const memory = { mine: { entrance: { x: 0, y: 10, z: 0 }, front: { x: 2, y: 8, z: 0 }, surfaceY: 10, dir: 0, phase: 'main',
    mainSteps: 0, steps: 2, turns: 0, branch: null, cells, walkFailures: 0 } };
  // Each leg "arrives" one cell short: the bot never stands at the front.
  const bot = { entity: { position: new Vec3(1.5, 9, 0.5) }, registry: { blocksByName: {} },
    inventory: { emptySlotCount: () => 20 } };
  const actions = { goTo: async () => ({ ok: true }) };
  const events = [];
  const ctx = { record: (type) => events.push(type) };
  const blacklist = { has: () => false };
  for (let i = 0; i < 60 && memory.mine; i += 1) {
    await mineStep(bot, ctx, memory, { blocks: () => false, dropMatch: () => false, y: 8, blacklist, actions });
  }
  assert.equal(memory.mine, null);
  assert.ok(events.includes('mine_abandoned'));
  assert.equal(memory.mineDir, 1);
});
