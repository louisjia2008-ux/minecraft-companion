'use strict';
// Casting obsidian from buckets: the mold site and one step at a time,
// decided only from the blocks in the pit and beside its mouth.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const obsidian = require('../core/obsidian');
const skillsModule = require('../core/skills');
const actionsModule = require('../core/actions');
const { createBlacklist } = require('../core/blacklist');

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

test('the mold keeps away from pools its water would run into', () => {
  const { bot } = rig();
  const pool = new Vec3(4, 0, 0);
  bot.registry = { blocksByName: { lava: { id: 1 }, water: { id: 2 } } };
  bot.findBlocks = () => [pool];
  const mold = obsidian.findMold(bot);
  assert.ok(mold);
  assert.ok(Math.abs(mold.pit.x - pool.x) > 9 || Math.abs(mold.pit.z - pool.z) > 9);
});

function lavaBank() {
  const at = new Vec3(-73, 43, -102);
  const bank = new Vec3(-70, 41, -107);
  const accessible = new Vec3(-73, 40, -107);
  const blocked = new Vec3(-72, 40, -105);
  const bag = [{ name: 'bucket', count: 1 }];
  const open = new Map();
  const record = (p, name) => open.set(p.toString(), name);
  for (const feet of [at, bank]) {
    record(feet, 'cave_air');
    record(feet.offset(0, 1, 0), 'cave_air');
  }
  for (let x = -74; x <= -70; x += 1) for (let y = 41; y <= 43; y += 1) {
    record(new Vec3(x, y, -107), 'cave_air');
  }
  record(accessible, 'lava');
  record(blocked, 'lava');
  record(blocked.offset(0, 1, 0), 'cave_air');
  const read = (p) => {
    const position = p.floored();
    const name = open.get(position.toString()) || 'stone';
    return { name, position, type: name === 'lava' ? 1 : 0,
      shapes: name === 'stone' ? [[0, 0, 0, 1, 1, 1]] : [],
      boundingBox: name === 'stone' ? 'block' : 'empty', getProperties: () => name === 'lava' ? { level: 0 } : {} };
  };
  const neighbors = () => [bank, blocked, { x: -70, y: 41, z: -107, toBreak: [blocked] }];
  const movements = { canDig: true, getNeighbors: neighbors };
  const bot = { health: 20, entity: { position: at.offset(.5, 0, .5), eyeHeight: 1.62, onGround: true },
    blockAt: read, registry: { blocksByName: { lava: { id: 1 } } }, inventory: { items: () => bag },
    findBlocks: ({ useExtraInfo }) => [blocked, accessible].filter((p) => !useExtraInfo || useExtraInfo(read(p))),
    pathfinder: { movements }, equip: async (item) => { bot.heldItem = item; }, lookAt: async () => {},
    activateItem: () => { bag.splice(0, 1, { name: 'lava_bucket', count: 1 }); } };
  const records = [];
  const ctx = { signal: new AbortController().signal, record: (type, data) => records.push({ type, ...data }) };
  const blacklist = createBlacklist();
  const fill = () => skillsModule.fillBucket(bot, ctx, { liquid: 'lava', blacklist, guardLava: true });
  return { at, bank, accessible, blocked, bot, fill, movements, neighbors, record, records };
}

test('casting lava skips the nearest blocked source and fills from a confirmed grounded bank', async (t) => {
  const f = lavaBank();
  t.mock.method(actionsModule, 'goTo', async (_bot, _ctx, goal, options) => {
    assert.equal(f.movements.canDig, false);
    assert.equal(options.retryNoProgress, false);
    assert.ok(goal.isEnd(f.bank));
    assert.equal(goal.isEnd(f.blocked.offset(0, 1, 0)), false);
    f.bot.entity.position = f.bank.offset(.5, 0, .5);
    assert.equal(options.arrived(), true);
    return { ok: true };
  });
  assert.deepEqual(await f.fill(), { ok: true, filled: 'lava_bucket' });
  assert.ok(f.records.some((e) => e.type === 'target_selected' && e.position === '-73,40,-107' && e.stance === '-70,41,-107'));
  assert.equal(f.movements.getNeighbors, f.neighbors);
  assert.equal(f.movements.canDig, true);
});

test('casting lava never uses the bucket if the bank becomes wet or its ray changes after aiming', async (t) => {
  for (const change of ['wet', 'blocked']) {
    const f = lavaBank();
    f.bot.entity.position = f.bank.offset(.5, 0, .5);
    f.bot.activateItem = () => assert.fail('an invalidated bank cannot send a bucket interaction');
    f.bot.lookAt = async () => {
      if (change === 'wet') f.bot.entity.isInWater = true;
      else f.record(new Vec3(-71, 42, -107), 'stone');
    };
    assert.equal((await f.fill()).reason, 'lava_bank_changed');
    assert.equal(f.bot.inventory.items()[0].name, 'bucket');
  }
});

test('casting lava keeps approaching a dry bank after a timeout that moved closer', async (t) => {
  const f = lavaBank();
  f.record(new Vec3(-73, 43, -100), 'cave_air');
  f.record(new Vec3(-73, 44, -100), 'cave_air');
  f.record(new Vec3(-73, 43, -104), 'cave_air');
  f.record(new Vec3(-73, 44, -104), 'cave_air');
  f.bot.entity.position = new Vec3(-72.5, 43, -99.5);
  let calls = 0;
  t.mock.method(actionsModule, 'goTo', async (_bot, _ctx, goal, options) => {
    assert.ok(goal.isEnd(f.bank));
    if (++calls === 1) {
      f.bot.entity.position = new Vec3(-72.5, 43, -103.5);
      return { ok: false, reason: 'path_timeout' };
    }
    f.bot.entity.position = f.bank.offset(.5, 0, .5);
    assert.ok(options.arrived());
    return { ok: true };
  });
  const leg = await f.fill();
  assert.equal(leg.ok, true);
  assert.equal(leg.progress, false);
  assert.equal(f.bot.inventory.items()[0].name, 'bucket');
  assert.deepEqual(await f.fill(), { ok: true, filled: 'lava_bucket' });
  assert.equal(calls, 2);
});

test('casting lava can use the guarded approach to a bank close by but five blocks higher', async (t) => {
  const f = lavaBank();
  f.bot.entity.position = f.bank.offset(0.5, -5, 0.5);
  let calls = 0;
  t.mock.method(actionsModule, 'goTo', async (_bot, _ctx, goal) => {
    calls += 1;
    if (calls === 1) {
      assert.ok(goal.isEnd(f.bank));
      return { ok: false, reason: 'not_arrived' };
    }
    assert.deepEqual([goal.x, goal.y, goal.z], [f.bank.x, f.bank.y, f.bank.z]);
    assert.equal(goal.isEnd(f.bot.entity.position.floored()), false);
    f.bot.entity.position = f.bank.offset(0.5, 0, 0.5);
    return { ok: false, reason: 'path_timeout' };
  });
  assert.deepEqual(await f.fill(), { ok: true, filled: 'lava_bucket' });
  assert.equal(calls, 2);
});

test('a distant lava bank can use a guarded dry approach without breaking its liquid containment', async (t) => {
  const f = lavaBank();
  const entry = new Vec3(-66, 41, -107);
  const dryCut = { x: -66, y: 41, z: -107, toBreak: [new Vec3(-66, 42, -107)] };
  const opensLava = { x: -67, y: 41, z: -107, toBreak: [f.accessible.offset(0, 0, 1)] };
  f.record(entry, 'cave_air');
  f.record(entry.offset(0, 1, 0), 'cave_air');
  f.bot.entity.position = new Vec3(-51.5, 45, -105.5);
  const neighbors = () => [dryCut, opensLava];
  f.movements.getNeighbors = neighbors;
  let calls = 0;
  t.mock.method(actionsModule, 'goTo', async (_bot, _ctx, goal, options) => {
    calls += 1;
    if (calls === 1) return { ok: false, reason: 'NoPath' };
    if (calls === 2) {
      assert.ok(goal.isEnd(entry));
      assert.deepEqual(f.movements.getNeighbors(entry), [dryCut]);
      f.bot.entity.position = entry.offset(.5, 0, .5);
      return { ok: true };
    }
    assert.equal(f.movements.canDig, false);
    f.bot.entity.position = f.bank.offset(.5, 0, .5);
    assert.ok(options.arrived());
    return { ok: true };
  });
  assert.equal((await f.fill()).ok, true);
  assert.equal(calls, 3);
  assert.equal(f.movements.getNeighbors, neighbors);
});
