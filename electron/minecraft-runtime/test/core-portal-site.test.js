'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createPortalTrip } = require('../core/netherTrip');
const nether = require('../core/nether');

test('when the local elevation has no portal site, scout one reachable dry slope before building', async () => {
  const from = new Vec3(0, 84, 0);
  const floor = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
  const air = { name: 'air', boundingBox: 'empty', shapes: [], skyLight: 15 };
  const heights = new Map();
  for (let z = 0; z <= 4; z += 1) heights.set(`0,${z}`, 83 - z);
  for (let x = -1; x <= 2; x += 1) {
    for (let z = 5; z <= 7; z += 1) heights.set(`${x},${z}`, 78);
  }
  const bot = {
    entity: { position: from.offset(.5, 0, .5), onGround: true }, game: { dimension: 'overworld', minY: 0, height: 96 },
    registry: { blocksByName: {} }, findBlocks: () => [],
    blockAt(p) {
      const cell = p.floored(), height = heights.get(`${cell.x},${cell.z}`);
      return height !== undefined && cell.y <= height ? floor : air;
    },
  };
  const native = function (node) {
    return [node.offset(0, -1, 1), node.offset(0, 0, 1), node.offset(1, 0, 0), node.offset(0, -2, 1)];
  };
  const movements = { getNeighbors: native, canDig: true, allowParkour: true, maxDropDown: 4 };
  bot.pathfinder = { movements };
  assert.equal(nether.findPortalSite(bot), null);
  const expected = { base: new Vec3(-1, 79, 5), axis: 'x' };
  assert.deepEqual(nether.scoutPortalSite(bot)?.site, expected);
  const paths = [], records = [];
  const trip = createPortalTrip({ bot, memory: {}, actions: {
    async goTo(_bot, _ctx, goal) {
      const current = bot.entity.position.floored(), target = new Vec3(goal.x, goal.y, goal.z);
      assert.deepEqual(movements.getNeighbors(current), [target]);
      assert.equal(movements.canDig, false);
      assert.equal(movements.allowParkour, false);
      paths.push(target);
      bot.entity.position = target.offset(.5, 0, .5);
      return { ok: true };
    },
  } });
  const ctx = { record: (type, data) => records.push({ type, ...data }), signal: new AbortController().signal };
  const state = { isDay: true, inventory: { obsidian: 10, flint_and_steel: 1 } };
  assert.equal((await trip.toNether(ctx, state)).ok, true);
  assert.equal(paths.length, 6);
  assert.deepEqual(bot.companionPortalSite, expected);
  assert.deepEqual(trip.memory.site, expected);
  assert.deepEqual(movements, { getNeighbors: native, canDig: true, allowParkour: true, maxDropDown: 4 });
  assert.equal(records.find((event) => event.type === 'portal_site').scouted, true);
});

test('a frame begun by an earlier goal is finished by the next one, not left for a new site', async () => {
  const base = new Vec3(-24, 70, -4);
  const frame = nether.portalFrame(base, 'z');
  // Six obsidian already placed; the corners stand on stone.
  const placed = new Set(frame.cells.filter((c) => !c.corner).slice(0, 6).map((c) => c.pos.toString()));
  const corners = new Set(frame.cells.filter((c) => c.corner).map((c) => c.pos.toString()));
  const bot = {
    entity: { position: base.offset(1, 0, 1) }, game: { dimension: 'overworld' },
    registry: { blocksByName: {} }, findBlocks: () => [],
    blockAt: (p) => {
      const key = new Vec3(p.x, p.y, p.z).floored().toString();
      if (placed.has(key)) return { name: 'obsidian', boundingBox: 'block' };
      if (corners.has(key)) return { name: 'stone', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
  };
  const first = createPortalTrip({ bot, memory: {} });
  first.memory.site = { base, axis: 'z' };
  bot.companionPortalSite = first.memory.site;
  // Asked again: a new goal, a new memory, four obsidian left in the bag.
  const again = createPortalTrip({ bot, memory: {} });
  const ctx = { record() {}, signal: new AbortController().signal };
  const result = await again.toNether(ctx, { inventory: { obsidian: 4 } });
  assert.equal(result.reason, 'missing_flint_and_steel');
  assert.equal(again.memory.site.base, base);
  assert.equal(again.framePlaced(), 6 + corners.size);
});

test('a portal builder walks into reach before clearing replaceable growth and rechecks that cell', async (t) => {
  const base = new Vec3(0, 64, 0);
  const frame = nether.portalFrame(base, 'x');
  const grass = { name: 'short_grass', boundingBox: 'empty', shapes: [], position: base };
  const air = { name: 'air', boundingBox: 'empty', position: base };
  const check = async (changed, expected) => {
    let cell = grass;
    let reachable = false;
    const steps = [];
    const bot = {
      entity: { position: base.offset(0, 0, 20) },
      blockAt(p) {
        if (p.equals(base)) return cell;
        if (p.equals(base.offset(0, -1, 0))) return { name: 'stone', boundingBox: 'block', position: p };
        return air;
      },
      inventory: { items: () => [{ name: 'cobblestone' }] },
      async equip() {},
      async lookAt() {},
      async placeBlock() { steps.push('place'); cell = { name: 'cobblestone', boundingBox: 'block', position: base }; },
    };
    const work = {
      withinReach: () => reachable,
      async goTo(_bot, _ctx, goal) {
        assert.deepEqual([goal.x, goal.y, goal.z], [frame.stand.x, frame.stand.y, frame.stand.z]);
        steps.push('approach');
        reachable = true;
        bot.entity.position = frame.stand.offset(.5, 0, .5);
        if (changed) cell = { name: 'bedrock', boundingBox: 'block', position: base };
        return { ok: true };
      },
      async digBlock(_bot, _ctx, block) {
        assert.equal(reachable, true);
        assert.equal(block, grass);
        steps.push('dig');
        cell = air;
        return { ok: true };
      },
    };
    const result = await nether.buildPortalStep(bot, { record() {} }, { base, axis: 'x' }, work);
    assert.deepEqual(steps, expected);
    assert.equal(result.ok, !changed);
  };
  await t.test('approaches, clears the observed grass and places the first corner', () => check(false, ['approach', 'dig', 'place']));
  await t.test('leaves a solid block that replaced the grass while approaching', () => check(true, ['approach']));
});
