'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Vec3 } = require('vec3');
const { advanceCaveRetreat, planRetreat } = require('../core/caveRetreat');
const { createSurvivalBehaviors } = require('../core/behaviors/survival');

const key = (p) => `${p.x},${p.y},${p.z}`;
const stone = { name: 'stone', diggable: true, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
const air = { name: 'air', boundingBox: 'empty', shapes: [] };
const water = { name: 'water', boundingBox: 'empty', shapes: [] };

function fixture() {
  const origin = new Vec3(0, 0, 0);
  const cells = new Map([['0,0,0', air], ['0,1,0', air]]);
  const bot = {
    entity: { position: origin.offset(.5, 0, .5), onGround: true },
    game: { dimension: 'overworld' },
    blockAt: (p) => ({ ...(cells.get(key(p.floored())) || stone), position: p.floored() }),
    canDigBlock: () => true,
    pathfinder: { movements: { getNeighbors: () => [], canDig: true } },
    inventory: { items: () => [] },
  };
  return { bot, cells, origin };
}

test('a liquid touching a proposed cut rules out that heading', () => {
  const { bot, cells, origin } = fixture();
  const home = new Vec3(15, 8, 0);
  assert.equal(planRetreat(bot, origin, home).target.x, 1);
  cells.set('2,1,0', water);
  const plan = planRetreat(bot, origin, home);
  assert.ok(plan);
  assert.notEqual(plan.target.x, 1);
});

test('an empty-handed bot clears one checked stair cell and then physically ascends', async () => {
  const { bot, cells, origin } = fixture();
  const logs = [];
  const ctx = { record: (...args) => logs.push(args) };
  const actions = {
    async digBlock(_bot, _ctx, block) {
      assert.ok(block.position.y >= origin.y + 1);
      cells.set(key(block.position), air);
      return { ok: true };
    },
    async goTo(_bot, _ctx, goal) {
      assert.equal(bot.pathfinder.movements.canDig, false);
      bot.entity.position = new Vec3(goal.x + .5, goal.y, goal.z + .5);
      return { ok: true };
    },
  };
  const home = new Vec3(15, 8, 0);
  for (let n = 0; n < 3; n += 1) {
    const cut = await advanceCaveRetreat(bot, ctx, actions, home);
    assert.equal(cut.dug, true);
    assert.equal(bot.entity.position.y, 0);
    assert.equal(logs.length, n + 1);
  }
  const step = await advanceCaveRetreat(bot, ctx, actions, home);
  assert.equal(step.ok, true);
  assert.deepEqual(step.to, new Vec3(1, 1, 0));
  assert.equal(bot.pathfinder.movements.canDig, true);
});

test('critical underground escape starts without a nearby threat and excludes the house roof', () => {
  const { bot } = fixture();
  const state = { health: 2, food: 0, position: bot.entity.position, inventory: {}, hostiles: [] };
  const behaviors = (home) => createSurvivalBehaviors({ bot, home: () => home, actions: { underground: () => true } });
  assert.ok(behaviors(new Vec3(15, 8, 0)).find((b) => b.name === 'cave_retreat').want(state));
  assert.equal(behaviors(new Vec3(0, 0, 0)).find((b) => b.name === 'cave_retreat').want(state), 0);
});
