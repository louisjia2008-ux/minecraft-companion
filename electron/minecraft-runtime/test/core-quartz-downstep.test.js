'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { pathfinder, goals } = require('mineflayer-pathfinder');
const { configureMovements } = require('../core/companion');
const { applyNetherMovements, applyWalkOnlyMovements } = require('../core/nether');

function corridor(drop) {
  const bot = Object.assign(new EventEmitter(), { registry, entities: {}, game: { dimension: 'the_nether', minY: -64 },
    entity: { position: new Vec3(.5, 1, .5), onGround: true, effects: {} },
    inventory: { items: () => [], slots: [] }, clearControlStates() {},
    blockAt(p) {
      p = p.floored();
      const floor = p.x === 0 ? 0 : -drop;
      const wall = p.z !== 0 || p.x < 0 || p.x > 2;
      const b = Block.fromProperties(registry.blocksByName[wall || p.y <= floor ? 'basalt' : 'air'].id, {}, 0);
      b.position = p; return b;
    } });
  pathfinder(bot); const movements = configureMovements(bot); movements.allowEntityDetection = false;
  applyNetherMovements(bot);
  const original = movements.getNeighbors;
  const originalOwn = Object.hasOwn(movements, 'getNeighbors');
  const restore = applyWalkOnlyMovements(bot);
  return { bot, movements, original, originalOwn, restore };
}

test('quartz native support-depth adapter permits an actual one-block stair down without excavation', () => {
  const f = corridor(1);
  const plan = f.bot.pathfinder.getPathTo(f.movements, new goals.GoalBlock(2, 0, 0), 1000);
  assert.equal(plan.status, 'success');
  assert.equal(plan.path.at(-1).y, 0);
  let previousY = 1;
  for (const move of plan.path) {
    assert.ok(move.y >= previousY - 1);
    assert.equal(move.toBreak.length, 0); assert.equal(move.toPlace.length, 0);
    previousY = move.y;
  }
  f.restore();
  assert.equal(f.movements.getNeighbors, f.original);
  assert.equal(Object.hasOwn(f.movements, 'getNeighbors'), f.originalOwn);
});

test('the same native quartz profile refuses an actual two-block drop', () => {
  const f = corridor(2);
  const plan = f.bot.pathfinder.getPathTo(f.movements, new goals.GoalBlock(2, -1, 0), 1000);
  assert.equal(plan.status, 'noPath');
  f.restore();
});

test('actual Move guard blocks deeper, excavating and placing edges even if an upstream movement emits them', () => {
  const moves = [{ x: 1, y: 9, z: 0, toBreak: [], toPlace: [] },
    { x: 2, y: 8, z: 0, toBreak: [], toPlace: [] },
    { x: 3, y: 10, z: 0, toBreak: [{}], toPlace: [] },
    { x: 4, y: 10, z: 0, toBreak: [], toPlace: [{}] }];
  const original = function () { assert.equal(this, movements); return moves; };
  const movements = Object.assign(Object.create({ getNeighbors: original }), { maxDropDown: 4, infiniteLiquidDropdownDistance: true });
  const restore = applyWalkOnlyMovements({ pathfinder: { movements } });
  assert.deepEqual(movements.getNeighbors({ y: 10 }), [moves[0]]);
  assert.equal(movements.companionPhysicalDropLimit, 1);
  assert.equal(movements.companionPhysicalDropGuard, movements.getNeighbors);
  assert.equal(movements.infiniteLiquidDropdownDistance, false);
  restore();
  assert.equal(movements.getNeighbors, original);
  assert.equal(Object.hasOwn(movements, 'getNeighbors'), false);
  assert.equal(movements.maxDropDown, 4);
  assert.equal(movements.infiniteLiquidDropdownDistance, true);
  assert.equal(Object.hasOwn(movements, 'companionPhysicalDropGuard'), false);
  assert.equal(Object.hasOwn(movements, 'companionPhysicalDropLimit'), false);
});
