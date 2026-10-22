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
