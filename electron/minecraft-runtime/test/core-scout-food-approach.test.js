'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { planScoutFoodApproach } = require('../core/goals/scoutFoodApproach');

function fixture() {
  const ids = { pig: 3, sheep: 4 };
  const entities = {
    3: { id: 3, name: 'pig', position: new Vec3(18.5, 64, .5), width: .9, height: .9, isValid: true },
    4: { id: 4, name: 'sheep', position: new Vec3(40.5, 64, .5), width: .9, height: 1.3, isValid: true },
  };
  const bot = {
    entity: { position: new Vec3(.5, 64, .5), onGround: true },
    entities, blockAt: () => ({ boundingBox: 'empty' }), world: { raycast: () => null },
  };
  const calls = [];
  const path = (from, to) => {
    const length = Math.abs(to - from);
    return Array.from({ length }, (_, i) => new Vec3(from + (i + 1) * Math.sign(to - from), 64, 0));
  };
  bot.pathfinder = {
    movements: {},
    *getPathFromTo(_movement, from, goal, options) {
      calls.push({ from, goal, options });
      const x = Math.floor(from.x);
      const to = x === 0 ? path(0, 16) : path(x, 0);
      assert.equal(goal.isEnd(to.at(-1)), true, 'native planner target under test');
      yield { result: { status: 'success', path: to } };
    },
  };
  const options = { mobs: ['pig', 'sheep'], accept: (e) => e.isValid, mayContinue: () => true, maxLegSteps: 12 };
  return { ids, bot, options, calls };
}

test('scout can approach an observed animal 12–24 blocks away only with both dry return paths', async () => {
  const { ids, bot, options, calls } = fixture();
  const result = await planScoutFoodApproach(bot, {}, options);
  assert.equal(result.entity.id, ids.pig);
  assert.equal(result.from.x, 0);
  assert.equal(result.to.x, 12, 'one existing-sized scout leg');
  assert.equal(result.approachSteps, 16);
  assert.deepEqual(calls.map(({ from }) => from.x), [.5, 16.5, 12.5], 'both full stance and real first leg can return');
  assert.ok(calls.every(({ options }) => options.optimizePath === false));
});

test('scout declines obscured, late, or one-way approaches and never uses native partial searches', async () => {
  const { bot, options, calls } = fixture();
  bot.world.raycast = () => ({ name: 'grass_block' });
  assert.equal(await planScoutFoodApproach(bot, {}, options), null);
  assert.equal(calls.length, 0, 'hidden entity never influences direction');
  bot.world.raycast = () => null;
  assert.equal(await planScoutFoodApproach(bot, {}, { ...options, mayContinue: () => false }), null);
  assert.equal(calls.length, 0);
  const original = bot.pathfinder.getPathFromTo;
  bot.pathfinder.getPathFromTo = function* (movement, from, ...rest) {
    const valid = original.call(this, movement, from, ...rest).next().value;
    yield from.x <= 1 ? valid : { result: { status: 'partial', path: valid.result.path } };
  };
  assert.equal(await planScoutFoodApproach(bot, {}, options), null);
});
