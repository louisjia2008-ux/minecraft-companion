'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { penLayout, choosePenSite } = require('../core/husbandry');
const { createRanchGoal } = require('../core/goals/ranch');

test('a 6x6 pen has 19 fence posts and the gate in the middle of the north side', () => {
  const pen = penLayout({ x: 10, y: 64, z: 20 }, 6);
  assert.equal(pen.fences.length, 19);
  assert.deepEqual(pen.gate, { x: 13, y: 64, z: 20 });
  assert.ok(!pen.fences.some((f) => f.x === pen.gate.x && f.z === pen.gate.z));
  assert.ok(pen.contains({ x: 12.5, y: 64, z: 22.5 }));
  assert.ok(!pen.contains({ x: 13.5, y: 64, z: 18.5 }), 'the spot outside the gate is outside');
  assert.ok(!pen.contains({ x: 10.1, y: 64, z: 22 }), 'the fence line itself is not inside');
  assert.ok(!pen.contains({ x: 13.5, y: 64, z: 20.6 }), 'the gate cell is not inside');
});

test('the pen site is flat open ground, clear of trees', () => {
  const blockAt = (p) => {
    if (p.x >= -3 && p.x <= 3 && p.z >= -3 && p.z <= 3 && p.y >= 1 && p.y <= 5) return { name: 'oak_log', boundingBox: 'block' };
    return p.y <= 0 ? { name: 'grass_block', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
  };
  const corner = choosePenSite(blockAt, { x: 0, y: 1, z: 0 }, { size: 6, radius: 16 });
  assert.ok(corner);
  assert.equal(corner.y, 1);
  const overlaps = corner.x <= 3 && corner.x + 6 >= -3 && corner.z - 2 <= 3 && corner.z + 6 >= -3;
  assert.ok(!overlaps, `pen at ${JSON.stringify(corner)} overlaps the tree`);
});

// The ranch goal one decision at a time, on a pen whose fences and gate stand.
function ranchWorld({ botAt = new Vec3(3.5, 64, -3.5), inventory = { wheat: 16 }, food = 20, loaded = () => true, cows = [] } = {}) {
  const pen = penLayout({ x: 0, y: 64, z: 0 }, 6);
  const fenceKeys = new Set(pen.fences.map((f) => `${f.x},${f.z}`));
  const calls = [];
  const bot = {
    entity: { position: botAt },
    entities: Object.fromEntries(cows.map((c, i) => [i + 1, { id: i + 1, name: 'cow', position: c, metadata: [] }])),
    registry: { entitiesByName: { cow: { metadataKeys: [] } }, foodsByName: { bread: {}, cooked_beef: {} } },
    blockAt: (p) => {
      if (!loaded(p)) return null;
      if (p.x === pen.gate.x && p.z === pen.gate.z && p.y === 64) {
        return { name: 'oak_fence_gate', position: new Vec3(p.x, p.y, p.z), getProperties: () => ({ facing: 'north', open: false }) };
      }
      const table = p.x === 10 && p.y === 64 && p.z === 10;
      const name = table ? 'crafting_table' : p.y === 64 && fenceKeys.has(`${p.x},${p.z}`) ? 'oak_fence' : p.y < 64 ? 'grass_block' : 'air';
      return { name, position: new Vec3(p.x, p.y, p.z), boundingBox: name === 'air' ? 'empty' : 'block' };
    },
  };
  const skills = {
    explore: async () => { calls.push('explore'); return { ok: true }; },
    craft: async (_b, _c, { item }) => { calls.push(`craft:${item}`); return { ok: true }; },
    placeAt: async () => { calls.push('place'); return { ok: true }; },
    gatherOne: async () => { calls.push('gather'); return { ok: true }; },
  };
  const actions = { goNear: async () => { calls.push('return'); return { ok: true }; } };
  const husbandry = { ...require('../core/husbandry'), lure: async () => { calls.push('lure'); return { ok: false, reason: 'animal_not_inside' }; } };
  const goal = createRanchGoal({ bot, kind: 'cow', target: 3, skills, actions, husbandry, waitMs: 0 });
  goal.memory.pen = pen;
  goal.memory.table = { x: 10, y: 64, z: 10 };
  const ctx = { perceive: () => ({ inventory: { ...inventory }, food }), record: () => {}, signal: undefined };
  return { goal, ctx, calls, bot };
}

test('out of sight of its pen the ranch walks back instead of rebuilding fences or exploring further', async () => {
  const { goal, ctx, calls } = ranchWorld({ botAt: new Vec3(3.5, 64, 300), loaded: (p) => p.z > 100 });
  await goal.run(ctx);
  assert.deepEqual(calls, ['return']);
});

test('a cow that slipped away while being led in is waited for, not abandoned for exploring', async () => {
  const { goal, ctx, calls } = ranchWorld({ cows: [new Vec3(20, 64, 20)] });
  await goal.run(ctx); // lure fails and blacklists the cow
  await goal.run(ctx); // the same cow is still in sight
  assert.deepEqual(calls, ['lure']);
});

test('hungry with spare wheat the ranch bakes bread, keeping wheat for breeding', async () => {
  const hungry = ranchWorld({ food: 14, inventory: { wheat: 16 }, cows: [new Vec3(20, 64, 20)] });
  await hungry.goal.run(hungry.ctx);
  assert.deepEqual(hungry.calls, ['craft:bread']);
  const lean = ranchWorld({ food: 14, inventory: { wheat: 6 }, cows: [new Vec3(20, 64, 20)] });
  await lean.goal.run(lean.ctx);
  assert.deepEqual(lean.calls, ['lure'], 'no bread from the wheat the cows need');
});

test('the herd being kept is spared from hunting', () => {
  const { goal } = ranchWorld();
  assert.ok(goal.spares({ name: 'cow' }));
  assert.ok(!goal.spares({ name: 'pig' }));
});
