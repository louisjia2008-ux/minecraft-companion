'use strict';
// The cobblestone generator's blueprint, site choice and goal loop, against a
// simulated world. Liquid physics are faked; the real ones are covered by the
// cobblegen-flat scenario on a vanilla server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createCobbleGenerator, FACINGS } = require('../core/blueprints/cobbleGenerator');
const { createCobbleGeneratorGoal, chooseGeneratorSite } = require('../core/goals/cobbleGenerator');
const { isFluidSource } = require('../core/skills');

const key = (p) => `${p.x},${p.y},${p.z}`;

function flatWorld(overrides = {}) {
  const world = new Map(Object.entries(overrides));
  const nameAt = (x, y, z) => world.get(`${x},${y},${z}`) ?? (y < 0 ? 'dirt' : y === 0 ? 'grass_block' : 'air');
  const block = (x, y, z) => {
    const name = nameAt(x, y, z);
    return { name, position: new Vec3(x, y, z), getProperties: () => ({ level: 0 }),
      boundingBox: ['air', 'water', 'lava', 'short_grass'].includes(name) ? 'empty' : 'block' };
  };
  return { world, block, set: (p, name) => world.set(key(p), name) };
}

test('every liquid cell is sealed on all sides but the top, for every facing', () => {
  for (const facing of Object.keys(FACINGS)) {
    const d = createCobbleGenerator({ x: 10, y: 64, z: -5 }, facing);
    const open = new Set(d.open.map(key));
    const seal = new Set(d.seal.map(key));
    for (const p of d.seal) assert.ok(!open.has(key(p)), `${facing}: seal overlaps open cell ${key(p)}`);
    const c = d.cells;
    for (const p of [c.lava, c.cobble, c.pitTop, c.pitBottom, c.water]) {
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
        const n = key({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
        assert.ok(open.has(n) || seal.has(n), `${facing}: ${n} next to ${key(p)} is neither open nor sealed`);
      }
    }
    // C touches L and the pit; S is beside C, not beside the liquids' ends.
    const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
    assert.equal(dist(c.lava, c.cobble), 1);
    assert.equal(dist(c.cobble, c.pitTop), 1);
    assert.equal(dist(c.stand, c.cobble), 1);
    assert.equal(c.pitBottom.y, c.pitTop.y - 1);
  }
});

test('site choice takes plain ground and refuses water, sand and blocked tops', () => {
  const { block } = flatWorld();
  const device = chooseGeneratorSite(block, { x: 0.5, y: 1, z: 0.5 });
  assert.ok(device);
  assert.equal(device.anchor.y, 0);

  // Water everywhere next to the surface layer: nothing can be sealed.
  const wet = {};
  for (let x = -12; x <= 12; x += 1) for (let z = -12; z <= 12; z += 1) if ((x + z) % 2 === 0) wet[`${x},-1,${z}`] = 'water';
  assert.equal(chooseGeneratorSite(flatWorld(wet).block, { x: 0.5, y: 1, z: 0.5 }, { radius: 4 }), null);

  // Sand would fall into the cells.
  const sandy = {};
  for (let x = -12; x <= 12; x += 1) for (let z = -12; z <= 12; z += 1) sandy[`${x},-1,${z}`] = 'sand';
  assert.equal(chooseGeneratorSite(flatWorld(sandy).block, { x: 0.5, y: 1, z: 0.5 }, { radius: 4 }), null);
});

test('the goal builds the generator and harvests only regenerated cobblestone', async () => {
  const { block, set } = flatWorld();
  const inventory = { dirt: 4, water_bucket: 1, lava_bucket: 1 };
  const bot = {
    entity: { position: new Vec3(0.5, 1, 0.5) },
    blockAt: (p) => block(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    inventory: { items: () => Object.entries(inventory).map(([name, count]) => ({ name, count })) },
    setControlState() {},
  };
  const log = { placed: 0, poured: [], dug: 0, mined: 0 };
  let goal = null;
  const dev = () => goal.memory.device;
  const nameAt = (p) => block(p.x, p.y, p.z).name;
  const countItems = (_bot, match) => Object.entries(inventory).filter(([n]) => match(n)).reduce((s, [, c]) => s + c, 0);
  const skills = {
    isFluidSource,
    async placeAt(_bot, _ctx, p) { set(p, 'dirt'); inventory.dirt -= 1; log.placed += 1; return { ok: true }; },
    async pourLiquid(_bot, _ctx, p, fluid) {
      assert.ok(inventory[`${fluid}_bucket`], `no ${fluid} bucket`);
      if (fluid === 'lava') assert.equal(nameAt(dev().cells.pitBottom), 'water', 'lava poured before the pit held water');
      delete inventory[`${fluid}_bucket`];
      set(p, fluid);
      if (fluid === 'water') { set(dev().cells.pitTop, 'water'); set(dev().cells.pitBottom, 'water'); }
      if (fluid === 'lava') set(dev().cells.cobble, 'cobblestone');
      log.poured.push(fluid);
      return { ok: true };
    },
  };
  const actions = {
    countItems,
    async goToDig() { return { ok: true }; },
    async goTo(_bot, _ctx, goal) {
      bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
      return { ok: true };
    },
    async unstick() { return { ok: true, moved: 'test' }; },
    async digBlock(_bot, _ctx, b) {
      const p = b.position;
      if (key(p) === key(dev().cells.cobble) && b.name === 'cobblestone') {
        inventory.cobblestone = (inventory.cobblestone || 0) + 1;
        log.mined += 1;
        set(p, 'air');
        setTimeout(() => set(p, 'cobblestone'), 5); // lava flows back
      } else {
        set(p, 'air');
        log.dug += 1;
      }
      return { ok: true };
    },
  };
  goal = createCobbleGeneratorGoal({ bot, harvest: 3, skills, actions });
  const ctx = { record() {}, signal: new AbortController().signal, perceive: () => ({ position: bot.entity.position }) };
  for (let step = 0; step < 40 && !goal.isDone({}); step += 1) {
    const result = await goal.run(ctx);
    assert.ok(result.ok, `step ${step} failed: ${result.reason}`);
  }
  assert.ok(goal.isDone({}), 'goal not done');
  assert.deepEqual(log.poured, ['water', 'lava']);
  assert.equal(log.dug, 6); // S, C, L, P (two), W
  assert.equal(log.placed, 0); // flat dirt seals itself
  assert.equal(log.mined, 3);
  assert.equal(goal.memory.harvested, 3);
  assert.equal(key(bot.entity.position.floored()), key(dev().cells.stand));
});
