'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const AStar = require('mineflayer-pathfinder/lib/astar');
const Move = require('mineflayer-pathfinder/lib/move');
const { createExpeditionReturnDetour } = require('../core/goals/expeditionReturnDetour');

function fixture(drop = 3) {
  const start = new Vec3(0, 70, 0);
  const stone = new Map();
  const target = new Vec3(1, 70 - drop, 0);
  stone.set(start.offset(0, -1, 0).toString(), 'stone');
  for (let x = 1; x < 12; x += 1) stone.set(new Vec3(x, target.y - 1, 0).toString(), 'stone');

  const events = [];
  const before = {};
  const pathfinder = {
    movements: before,
    setMovements(movement) { this.movements = movement; },
    *getPathFromTo(movement, position, goal, { timeout, tickTimeout, searchRadius }) {
      const p = position.floored();
      // Exercise a partial first slice regardless of host load. The native
      // iterator resumes the same search on every subsequent partial result.
      const search = new AStar(new Move(p.x, p.y, p.z, 0, 0), movement, goal, timeout, -1, searchRadius);
      let result = search.compute();
      assert.equal(result.status, 'partial');
      yield { result };
      search.tickTimeout = tickTimeout;
      while (result.status === 'partial') {
        result = search.compute();
        yield { result };
      }
    },
  };
  const bot = {
    registry, entities: {}, inventory: { items: () => [] }, game: { minY: -64 },
    entity: { position: start.offset(.5, 0, .5), onGround: true }, pathfinder,
    blockAt(p) {
      const name = stone.get(p.toString()) || 'air';
      return Object.assign(Block.fromProperties(name, {}), { position: p });
    },
  };
  const actions = {
    async goTo(_bot, _ctx, goal, options) {
      const p = bot.entity.position.floored();
      const planned = pathfinder.movements.getNeighbors(new Move(p.x, p.y, p.z, 0, 0));
      assert.ok(planned.length === 1 && goal.isEnd(planned[0]));
      assert.equal(pathfinder.movements.allowSprinting, false);
      assert.equal(pathfinder.movements.allowParkour, false);
      bot.entity.position = planned[0].offset(.5, 0, .5);
      assert.equal(options.arrived(), true);
      return { ok: true };
    },
  };
  const state = { safe: true };
  const ctx = { record: (type, data) => events.push({ type, ...data }), perceive: () => state };
  const detour = createExpeditionReturnDetour({
    bot, centre: new Vec3(20, 67, 0), floor: 60, exposed: (p) => p.equals(start) || p.x >= 8,
    actions, safe: (live) => live.safe,
  });
  return { stone, target, before, detour, ctx, state, events, bot };
}

test('stock return reaches a witnessed open step via a full dry three-block landing', async () => {
  const { detour, ctx, bot, before, target, events } = fixture();
  assert.equal(await detour.plan(ctx), true);
  assert.equal(detour.pending(), true);
  assert.equal(events[0].steps, 8);
  assert.deepEqual(await detour.advance(ctx), { ok: true });
  assert.ok(bot.entity.position.floored().equals(target));
  assert.equal(bot.pathfinder.movements, before);
  assert.equal(events[1].covered, true);
  while (detour.pending()) assert.deepEqual(await detour.advance(ctx), { ok: true });
  assert.equal(bot.entity.position.x, 8.5);
});

test('stock return refuses four-block drops, portal shafts and stale terrain', async () => {
  const deep = fixture(4);
  assert.equal(await deep.detour.plan(deep.ctx), false);

  const portal = fixture();
  portal.stone.set(portal.target.offset(0, 2, 0).toString(), 'nether_portal');
  assert.equal(await portal.detour.plan(portal.ctx), false);

  const changed = fixture();
  assert.equal(await changed.detour.plan(changed.ctx), true);
  changed.state.safe = false;
  assert.equal((await changed.detour.advance(changed.ctx)).reason, 'expedition_food_detour_unsafe');
  assert.equal(changed.detour.pending(), true);
  changed.state.safe = true;
  changed.stone.set(changed.target.offset(0, -1, 0).toString(), 'water');
  assert.equal((await changed.detour.advance(changed.ctx)).reason, 'expedition_food_detour_changed');
  assert.equal(changed.detour.pending(), false);
  assert.equal(changed.bot.pathfinder.movements, changed.before);
});
