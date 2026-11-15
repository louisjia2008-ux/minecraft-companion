'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createStoneQuarry } = require('../core/goals/stoneQuarry');
const { createBlacklist, posKey } = require('../core/blacklist');
const { standable } = require('../core/caveRetreat');

const stone = (name) => name === 'stone';
const cobble = (name) => name === 'cobblestone';

function fixture({ blocked = false, move = true, cover = 2 } = {}) {
  const origin = new Vec3(0, 64, 0);
  const world = new Map();
  const picked = [];
  const cuts = [];
  const path = [];
  const events = [];
  const pick = { name: 'wooden_pickaxe', type: 3 };
  const bot = {
    entity: { position: origin.offset(.5, 0, .5), onGround: true },
    inventory: { items: () => [pick] },
    blockAt(p) {
      const name = world.get(posKey(p)) || (p.y >= 64 ? 'air' : p.y >= 64 - cover ? 'dirt' : 'stone');
      if (name === 'unknown') return null;
      const empty = ['air', 'water', 'leaf_litter'].includes(name);
      return { name, position: p, boundingBox: empty ? 'empty' : 'block',
        shapes: empty ? [] : [[0, 0, 0, 1, 1, 1]], diggable: name !== 'air',
        ...(stone(name) ? { harvestTools: { [pick.type]: true } } : {}) };
    },
  };
  const actions = {
    async goTo(_bot, _ctx, goal) {
      const at = new Vec3(goal.x, goal.y, goal.z);
      path.push(at);
      if (move) bot.entity.position = at.offset(.5, 0, .5);
      return { ok: true };
    },
    async digBlock(_bot, _ctx, block, { tool }) {
      const at = bot.entity.position.floored();
      assert.equal(block.position.equals(at.offset(0, -1, 0)), false);
      if (stone(block.name)) assert.equal(tool, pick);
      cuts.push(block.position);
      world.set(posKey(block.position), 'air');
      return { ok: true };
    },
    async collectDrops(_bot, _ctx, position, match) {
      assert.ok(match('cobblestone'));
      assert.ok(bot.entity.position.distanceTo(position) <= 2);
      picked.push(position);
      return { ok: true, gained: 1 };
    },
  };
  const avoid = (p) => p.x < 0 || p.x > 7 || Math.abs(p.z) > 2;
  const surface = { floor: 48, isStand: (p) => p.equals(origin), walk: (run) => run() };
  const quarry = createStoneQuarry({ bot, actions, avoid, blacklist: createBlacklist() });
  const ctx = { record: (type, data) => events.push([type, data]) };
  if (blocked) world.set('1,62,1', 'water');
  return { bot, world, quarry, cuts, picked, path, events, surface, ctx, origin,
    run: () => quarry.run(ctx, surface, stone, cobble) };
}

test('a bounded quarry cuts two soil layers, mines multiple stone blocks and exits over intact stairs', async () => {
  const f = fixture();
  assert.equal(f.quarry.atWorksite(), false);
  assert.equal((await f.run()).ok, true);
  assert.equal(f.quarry.atWorksite(), true, 'the verified quarry entrance belongs to the route');
  for (let n = 0; n < 20 && f.picked.length < 2; n += 1) assert.equal((await f.run()).ok, true);
  assert.ok(f.picked.length >= 2);
  assert.deepEqual(f.path.slice(0, 2), [new Vec3(1, 63, 0), new Vec3(2, 62, 0)]);
  assert.equal(f.bot.blockAt(new Vec3(0, 63, 0)).name, 'dirt');
  assert.equal(f.bot.blockAt(new Vec3(1, 62, 0)).name, 'dirt');
  assert.equal(f.bot.blockAt(new Vec3(2, 61, 0)).name, 'stone');
  assert.ok(f.cuts.every((p) => p.y >= 60 && p.x > 0));
  assert.equal(f.events.filter(([type]) => type === 'quarry_start').length, 1);
  assert.equal(f.quarry.atWorksite(), true);
  f.bot.entity.onGround = false;
  assert.equal(f.quarry.atWorksite(), false);
  f.bot.entity.onGround = true;
  for (let n = 0; n < 8 && f.quarry.inside(); n += 1) assert.equal((await f.quarry.leave(f.ctx, f.surface)).ok, true);
  assert.ok(f.bot.entity.position.floored().equals(f.origin));
  assert.equal(await f.quarry.leave(f.ctx, f.surface), null);
});

test('quarry will not open a wet cut or a route that moved under the protected house', async () => {
  const f = fixture({ blocked: true });
  for (const p of [new Vec3(0, 63, 1), new Vec3(0, 63, -1), new Vec3(1, 63, 0)]) f.world.set(posKey(p), 'unknown');
  assert.deepEqual(await f.run(), { ok: false, reason: 'quarry_no_site' });
  assert.deepEqual(f.cuts, []);
  assert.deepEqual(f.path, []);
});

test('quarry preserves the completed route when native path reports arrival from the old cell', async () => {
  const f = fixture({ move: false });
  assert.equal((await f.run()).ok, true);
  const miss = await f.run();
  assert.deepEqual(miss, { ok: false, reason: 'quarry_arrival_unconfirmed' });
  assert.ok(f.bot.entity.position.floored().equals(f.origin));
  assert.equal(f.bot.blockAt(new Vec3(0, 63, 0)).name, 'dirt');
});


test('standard flat cover is opened from top to bottom in at most five one-block descents', async () => {
  const f = fixture({ cover: 4 });
  for (let n = 0; n < 30 && f.picked.length < 3; n += 1) assert.equal((await f.run()).ok, true);
  assert.equal(f.picked.length, 3);
  assert.deepEqual(f.path.slice(0, 5).map((p) => p.y), [63, 62, 61, 60, 59]);
  const lastStair = f.path[4];
  assert.deepEqual(f.cuts.filter((p) => p.x === lastStair.x && p.z === lastStair.z).map((p) => p.y), [63, 62, 61, 60, 59]);
  assert.equal(f.bot.blockAt(lastStair.offset(0, -1, 0)).name, 'stone');
  assert.ok(f.cuts.every((p) => p.y >= 59));
  for (let n = 0; n < 8 && f.quarry.inside(); n += 1) assert.equal((await f.quarry.leave(f.ctx, f.surface)).ok, true);
  assert.ok(f.bot.entity.position.floored().equals(f.origin));
});

test('quarry keeps previous entrance, stair, and pickup support protected after closing', async () => {
  const f = fixture({ cover: 2 });
  for (let n = 0; n < 18 && f.picked.length < 3; n += 1) assert.equal((await f.run()).ok, true);
  assert.equal(f.picked.length, 3);
  const entryFloor = f.origin.offset(0, -1, 0);
  const stairFloor = f.path[0].offset(0, -1, 0);
  const pocketFloor = f.picked[2].floored().offset(0, -1, 0);
  assert.equal(f.quarry.protectsFloor(entryFloor), true);
  assert.equal(f.quarry.protectsFloor(stairFloor), true);
  assert.equal(f.quarry.protectsFloor(pocketFloor), true);
  assert.equal(f.quarry.protectsFloor(entryFloor.offset(0, -1, 0)), false);

  // Break the next cut only, so the retained return stair is still sound.
  const feet = f.bot.entity.position.floored();
  const blocked = feet.offset(1, 0, 0);
  for (const side of [1, -1]) f.world.set(posKey(feet.offset(0, 0, side)), 'water');
  f.world.set(posKey(blocked), 'water');
  assert.equal((await f.run()).reason, 'quarry_exhausted');
  assert.equal(f.quarry.active(), false);
  assert.equal(f.quarry.protectsFloor(entryFloor), true);
  for (let n = 0; n < 8 && f.quarry.inside(); n += 1) assert.equal((await f.quarry.leave(f.ctx, f.surface)).ok, true);
  assert.ok(f.bot.entity.position.floored().equals(f.origin));
  // Later surfacing can pillar in the old entrance. A new exposed cut can
  // bring us to the old stair, which must no longer own a blocked exit.
  f.world.set(posKey(f.origin), 'dirt');
  f.world.set(posKey(f.origin.offset(0, 1, 0)), 'dirt');
  f.bot.entity.position = f.path[0].offset(.5, 0, .5);
  assert.equal(f.quarry.inside(), false);
  assert.equal(await f.quarry.leave(f.ctx, f.surface), null);
  assert.equal(f.quarry.protectsFloor(stairFloor), true);
  assert.equal(f.quarry.protectsFloor(pocketFloor), true);
  f.quarry.reset();
  assert.equal(f.quarry.protectsFloor(entryFloor), false);
});

test('a closed quarry is released when another behavior moves outside it', async () => {
  const f = fixture();
  for (let n = 0; n < 18 && f.picked.length < 3; n += 1) assert.equal((await f.run()).ok, true);
  const feet = f.bot.entity.position.floored();
  for (const p of [feet.offset(1, 0, 0), feet.offset(0, 0, 1), feet.offset(0, 0, -1)]) {
    f.world.set(posKey(p), 'water');
  }
  assert.equal((await f.run()).reason, 'quarry_exhausted');
  assert.equal(f.quarry.inside(), true);
  f.bot.entity.position = f.origin.offset(.5, 0, -1.5);
  assert.equal(f.quarry.inside(), false);
  f.bot.entity.position = feet.offset(.5, 0, .5);
  assert.equal(f.quarry.inside(), false);
  assert.equal(f.quarry.protectsFloor(feet.offset(0, -1, 0)), true);
});

for (const footing of ['leaf_litter', 'water']) {
  test(`closed quarry final-edge alternate with ${footing} ${footing === 'water' ? 'is rejected' : 'can exit'}`, async () => {
    const f = fixture();
    for (let n = 0; n < 18 && f.picked.length < 3; n += 1) assert.equal((await f.run()).ok, true);
    const feet = f.bot.entity.position.floored();
    for (const p of [feet.offset(1, 0, 0), feet.offset(0, 0, 1), feet.offset(0, 0, -1)]) {
      f.world.set(posKey(p), 'water');
    }
    assert.equal((await f.run()).reason, 'quarry_exhausted');
    const lastStair = f.path[0];
    for (let n = 0; n < 6 && !f.bot.entity.position.floored().equals(lastStair); n += 1) {
      assert.equal((await f.quarry.leave(f.ctx, f.surface)).ok, true);
    }
    assert.ok(f.bot.entity.position.floored().equals(lastStair));
    // Same final geometry as the native replay: old entrance filled two high
    // with dirt, north rises by one onto existing grass with leaf litter.
    f.world.set(posKey(f.origin), 'dirt');
    f.world.set(posKey(f.origin.offset(0, 1, 0)), 'dirt');
    const north = lastStair.offset(0, 1, -1);
    f.world.set(posKey(north.offset(0, -1, 0)), 'grass_block');
    f.world.set(posKey(north), footing);
    f.world.set(posKey(lastStair.offset(0, 1, 1)), 'water');
    f.world.set(posKey(lastStair.offset(0, 0, 1)), 'dirt');
    const surface = { ...f.surface, isStand: (p) => standable(f.bot.blockAt, p) };
    const originalCuts = f.cuts.length;
    const originalPath = f.path.length;
    const result = await f.quarry.leave(f.ctx, surface);
    assert.equal(f.cuts.length, originalCuts);
    if (footing === 'water') {
      assert.deepEqual(result, { ok: false, reason: 'quarry_route_changed' });
      assert.equal(f.path.length, originalPath);
      assert.equal(f.quarry.inside(), true);
    } else {
      assert.deepEqual(result, { ok: true });
      assert.deepEqual(f.path.slice(originalPath), [north]);
      assert.deepEqual(f.events.at(-1), ['quarry_exit', { position: north, alternate: true }]);
      assert.equal(f.quarry.inside(), false);
      assert.equal(f.quarry.protectsFloor(f.origin.offset(0, -1, 0)), true);
    }
  });
}
