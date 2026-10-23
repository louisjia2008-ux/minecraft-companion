'use strict';
// Casting obsidian from buckets: the mold site and one step at a time,
// decided only from the blocks in the pit and beside its mouth.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const obsidian = require('../core/obsidian');
const skillsModule = require('../core/skills');

// Flat ground: grass at y=0, dirt below, air above.
function world() {
  const blocks = new Map();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const make = (name) => ({ name, boundingBox: ['air', 'water', 'lava'].includes(name) ? 'empty' : 'block',
    getProperties: () => ({ level: 0 }) });
  const blockAt = (p) => {
    const f = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    const name = blocks.get(key(f)) ?? (f.y > 0 ? 'air' : (f.y === 0 ? 'grass_block' : 'dirt'));
    return { ...make(name), position: f };
  };
  return { set: (p, name) => blocks.set(key(p), name), blockAt };
}

function rig(items = {}) {
  const w = world();
  const inventory = { ...items };
  const bot = {
    entity: { position: new Vec3(0.5, 1, 0.5) },
    blockAt: w.blockAt,
    inventory: { items: () => Object.entries(inventory).filter(([, n]) => n > 0).map(([name, count]) => ({ name, count })) },
  };
  const calls = [];
  const skills = {
    isFluidSource: skillsModule.isFluidSource,
    pourLiquid: async (_b, _c, pos, fluid) => { calls.push(['pour', fluid, `${pos.x},${pos.y},${pos.z}`]); return { ok: true }; },
    scoopLiquid: async (_b, _c, pos, fluid) => { calls.push(['scoop', fluid, `${pos.x},${pos.y},${pos.z}`]); return { ok: true }; },
  };
  const actions = {
    goToDig: async () => ({ ok: true }),
    digBlock: async (_b, _c, block, { tool } = {}) => { calls.push(['dig', block.name, tool?.name || null]); return { ok: true }; },
    collectDrops: async () => ({ ok: true, gained: 1 }),
  };
  const ctx = { record: () => {} };
  return { w, bot, inventory, calls, skills, actions, ctx };
}

test('the mold is a pit in solid ground with a dry cell beside its mouth, away from home', () => {
  const { bot } = rig();
  const mold = obsidian.findMold(bot);
  assert.ok(mold);
  assert.equal(mold.pit.y, 0);
  assert.equal(mold.water.y, 1);
  assert.equal(Math.abs(mold.water.x - mold.pit.x) + Math.abs(mold.water.z - mold.pit.z), 1);
  assert.ok(obsidian.moldOk(bot, mold));
  // Nothing near home qualifies: the site moves out.
  const far = obsidian.findMold(bot, { avoid: (p) => Math.hypot(p.x, p.z) < 5 });
  assert.ok(Math.hypot(far.pit.x, far.pit.z) >= 5);
});

test('a pit next to water or gravel is no mold', () => {
  const { bot, w } = rig();
  const mold = obsidian.findMold(bot);
  w.set(mold.pit.offset(0, 0, 1).equals(mold.water.offset(0, -1, 0)) ? mold.pit.offset(0, 0, -1) : mold.pit.offset(0, 0, 1), 'gravel');
  assert.equal(obsidian.moldOk(bot, mold), false);
});

test('one cast: dig the pit, pour lava, pour water, take the water back, mine the obsidian', async () => {
  const r = rig({ lava_bucket: 1, water_bucket: 1, diamond_pickaxe: 1 });
  const memory = { cast: null };
  const step = () => obsidian.castStep(r.bot, r.ctx, memory, { skills: r.skills, actions: r.actions });

  assert.ok((await step()).ok);
  const { pit, water } = memory.cast;
  const at = (p) => `${p.x},${p.y},${p.z}`;
  assert.deepEqual(r.calls.pop(), ['dig', 'grass_block', null]);
  r.w.set(pit, 'air');

  await step();
  assert.deepEqual(r.calls.pop(), ['pour', 'lava', at(pit)]);
  r.w.set(pit, 'lava');
  Object.assign(r.inventory, { lava_bucket: 0, bucket: 1 });
  assert.equal(obsidian.pending(r.bot, memory.cast), true);

  await step();
  assert.deepEqual(r.calls.pop(), ['pour', 'water', at(water)]);
  r.w.set(water, 'water');
  r.w.set(pit, 'obsidian');
  Object.assign(r.inventory, { water_bucket: 0, bucket: 2 });

  await step();
  assert.deepEqual(r.calls.pop(), ['scoop', 'water', at(water)]);
  r.w.set(water, 'air');
  Object.assign(r.inventory, { water_bucket: 1, bucket: 1 });

  await step();
  assert.deepEqual(r.calls.pop(), ['dig', 'obsidian', 'diamond_pickaxe']);
  r.w.set(pit, 'air');
  assert.equal(obsidian.pending(r.bot, memory.cast), false);

  // The same pit takes the next bucket of lava.
  r.inventory.lava_bucket = 1;
  await step();
  assert.deepEqual(r.calls.pop(), ['pour', 'lava', at(pit)]);
  assert.deepEqual(memory.cast.pit, pit);
});

test('obsidian with no diamond pickaxe is left in the pit', async () => {
  const r = rig({ iron_pickaxe: 1 });
  const memory = { cast: obsidian.findMold(rig().bot) };
  r.w.set(memory.cast.pit, 'obsidian');
  const result = await obsidian.castStep(r.bot, r.ctx, memory, { skills: r.skills, actions: r.actions });
  assert.equal(result.reason, 'no_diamond_pickaxe');
  assert.equal(r.calls.length, 0);
});
