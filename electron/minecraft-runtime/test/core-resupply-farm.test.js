'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Vec3 } = require('vec3');
const { createResupplyIrrigation } = require('../core/goals/resupplyFarm');

test('critical resupply can water actual dry planted wheat without pouring into an open edge', async () => {
  const plots = [new Vec3(-2, 70, 0), new Vec3(2, 70, 0)];
  const centre = new Vec3(0, 71, -4);
  const world = new Map();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const write = (p, name, properties = {}) => world.set(key(p), { name, position: p,
    boundingBox: name === 'dirt' || name === 'grass_block' ? 'block' : 'empty',
    shapes: name === 'dirt' || name === 'grass_block' ? [[0, 0, 0, 1, 1, 1]] : [], getProperties: () => properties });
  for (const p of plots) {
    write(p, 'farmland', { moisture: 0 });
    write(p.offset(0, 1, 0), 'wheat', { age: 2 });
  }
  const site = new Vec3(0, 70, -1);
  for (const p of [site, site.offset(0, -1, 0), site.offset(-1, 0, 0), site.offset(1, 0, 0), site.offset(0, 0, 1), site.offset(0, 0, -1)]) {
    write(p, 'grass_block');
  }
  const bot = {
    inventory: { items: () => [{ name: 'water_bucket' }] },
    entity: { position: centre, onGround: true },
    blockAt: (p) => world.get(key(p)) || { name: 'air', boundingBox: 'empty', shapes: [] },
  };
  const receipts = [];
  const actions = {
    goNear: async (_bot, _ctx, target) => { bot.entity.position = target; return { ok: true }; },
    digBlock: async (_bot, _ctx, block) => { write(block.position, 'air'); return { ok: true }; },
  };
  const skills = { pourLiquid: async (_bot, _ctx, p, fluid) => {
    assert.deepEqual(p, site);
    assert.equal(fluid, 'water');
    write(p, 'water');
    return { ok: true };
  } };
  const irrigation = createResupplyIrrigation({ bot, actions, skills, centre });
  const ctx = { record: (...event) => receipts.push(event) };
  assert.deepEqual(irrigation.plan(plots), site);
  const brokenSide = site.offset(1, 0, 0);
  write(brokenSide, 'air');
  assert.equal(irrigation.plan(plots), null);
  assert.equal((await irrigation.run(ctx, site)).reason, 'resupply_basin_changed');
  assert.deepEqual(receipts, []);
  write(brokenSide, 'grass_block');
  assert.ok((await irrigation.run(ctx, site)).ok);
  assert.deepEqual(receipts, [['resupply_farm_water', { position: site }]]);
  assert.deepEqual(plots.map((p) => bot.blockAt(p.offset(0, 1, 0)).name), ['wheat', 'wheat']);
});

test('a basin outside the house can add one approved rim before pouring its carried water', async () => {
  const centre = new Vec3(87, 71, 120);
  const anchor = new Vec3(84, 71, 117);
  const site = new Vec3(82, 70, 120);
  const gap = site.offset(0, 0, 1);
  const houseFloor = new Vec3(84, 70, 119);
  const crops = [new Vec3(80, 70, 119), new Vec3(80, 70, 120), new Vec3(79, 69, 122)];
  const cube = [[0, 0, 0, 1, 1, 1]];
  const world = new Map();
  const set = (p, name, shapes = [], properties = {}) => world.set(p.toString(),
    { name, position: p, boundingBox: shapes.length ? 'block' : 'empty', shapes, getProperties: () => properties });
  const grass = (p) => set(p, 'grass_block', cube);
  for (const p of crops) {
    set(p, 'farmland', [], { moisture: 0 });
    set(p.offset(0, 1, 0), 'wheat', [], { age: 5 });
  }
  for (const p of [site.offset(0, -1, 0), site.offset(1, 0, 0), site.offset(-1, 0, 0),
    site.offset(0, 0, -1), gap.offset(1, 0, 0), houseFloor, houseFloor.offset(0, -1, 0),
    houseFloor.offset(1, 0, 0), houseFloor.offset(-1, 0, 0), houseFloor.offset(0, 0, 1), houseFloor.offset(0, 0, -1)]) grass(p);
  let confirmRim = false;
  const receipts = [];
  const bot = { inventory: { items: () => [{ name: 'water_bucket' }, { name: 'cobblestone' }] },
    blockAt: (p) => world.get(p.toString()) || { name: 'air', shapes: [], boundingBox: 'empty', position: p } };
  const skills = {
    placeAt: async (_b, _c, p, match, { faces }) => {
      assert.ok(p.equals(gap) && faces.some((face) => face.equals(new Vec3(1, 0, 0))));
      assert.ok(match('cobblestone'));
      if (confirmRim) set(gap, 'cobblestone', cube);
      return { ok: true };
    },
    pourLiquid: async (_b, _c, p) => {
      assert.ok(p.equals(site));
      assert.equal(bot.blockAt(gap).name, 'cobblestone');
      set(site, 'water', [], { level: 0 });
      return { ok: true };
    },
  };
  const ctx = { record: (...event) => receipts.push(event) };
  const irrigation = () => createResupplyIrrigation({ bot, actions: {}, skills, anchor, centre });
  assert.equal((await irrigation().run(ctx, houseFloor)).reason, 'resupply_basin_changed');
  assert.ok(irrigation().plan(crops).equals(site));
  assert.equal((await irrigation().run(ctx, site)).reason, 'resupply_basin_not_sealed');
  assert.deepEqual(receipts, []);
  confirmRim = true;
  assert.equal((await irrigation().run(ctx, site)).ok, true);
  assert.deepEqual(receipts.map(([event]) => event), ['resupply_farm_rim', 'resupply_farm_water']);
  assert.equal(bot.blockAt(houseFloor).name, 'grass_block');
});
