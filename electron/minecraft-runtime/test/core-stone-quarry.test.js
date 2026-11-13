'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createStoneQuarry } = require('../core/goals/stoneQuarry');
const { createBlacklist, posKey } = require('../core/blacklist');

const stone = (name) => name === 'stone';
const cobble = (name) => name === 'cobblestone';

function fixture({ blocked = false, move = true } = {}) {
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
      const name = world.get(posKey(p)) || (p.y >= 64 ? 'air' : p.y >= 62 ? 'dirt' : 'stone');
      if (name === 'unknown') return null;
      const empty = ['air', 'water'].includes(name);
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
  for (let n = 0; n < 20 && f.picked.length < 2; n += 1) assert.equal((await f.run()).ok, true);
  assert.ok(f.picked.length >= 2);
  assert.deepEqual(f.path.slice(0, 2), [new Vec3(1, 63, 0), new Vec3(2, 62, 0)]);
  assert.equal(f.bot.blockAt(new Vec3(0, 63, 0)).name, 'dirt');
  assert.equal(f.bot.blockAt(new Vec3(1, 62, 0)).name, 'dirt');
  assert.equal(f.bot.blockAt(new Vec3(2, 61, 0)).name, 'stone');
  assert.ok(f.cuts.every((p) => p.y >= 60 && p.x > 0));
  assert.equal(f.events.filter(([type]) => type === 'quarry_start').length, 1);
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
