/* global require */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { createEstateBlueprint } = require('../vendor/server/minecraft/estateBlueprints');
const { planEstateDoorClosure } = require('../vendor/server/minecraft/estateDoorClosure');
const key = p => `${p.x},${p.y},${p.z}`;
const delta = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };

// Collision/connectivity contract using the installed game's true shapes.
// No packet, physics, pathfinder or live-server success is claimed here.
function geometry(blueprint) {
  const cells = new Map(blueprint.blocks.map(s => [key(s.position), { ...s, properties: { ...s.properties, ...(s.item === 'oak_door' ? { open: true } : {}) } }]));
  const cropSoil = new Set(blueprint.farms.flatMap(f => f.soil).map(key));
  const water = new Set(blueprint.farms.map(f => key(f.water)));
  let position = { ...blueprint.entrance.outside };
  function at(point) {
    const p = point.floored(); const spec = cells.get(key(p));
    const river = blueprint.waterZones.some(({ bounds: b }) => p.y === b.minY && p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ);
    const name = spec?.item || (cropSoil.has(key(p)) ? 'farmland' : river || water.has(key(p)) ? 'water' : p.y < blueprint.anchor.y ? 'grass_block' : 'air');
    return Object.assign(Block.fromProperties(registry.blocksByName[name].id, spec?.properties || (name === 'farmland' ? { moisture: 7 } : {}), 0), { position: p });
  }
  function safe(node) {
    const feet = new Vec3(node.x + .5, node.y, node.z + .5);
    if (cropSoil.has(key({ x: node.x, y: blueprint.anchor.y, z: node.z }))) return false;
    let supported = false;
    for (let y = Math.floor(feet.y - .06); y <= Math.floor(feet.y + 1.8); y += 1) {
      const block = at(new Vec3(node.x, y, node.z));
      if (block.name === 'water') return false;
      // A closed panel severs crossing between the two sides of its cell.
      // The cell center alone can miss that thin edge; exclude it explicitly.
      if (block.name === 'oak_door' && block.getProperties().open === false) return false;
      for (const s of block.shapes) {
        if (.8 <= s[0] || .2 >= s[3] || .8 <= s[2] || .2 >= s[5]) continue;
        const top = y + s[4];
        if (Math.abs(feet.y - top) < .07) supported = true;
        if (feet.y + .02 < top && feet.y + 1.8 > y + s[1] + .02) return false;
      }
    }
    return supported;
  }
  function graph() {
    const cache = new Map();
    const options = (x, z) => {
      const id = `${x},${z}`;
      if (cache.has(id)) return cache.get(id);
      const heights = new Set();
      for (let y = blueprint.anchor.y - 1; y <= blueprint.bounds.maxY; y += 1) for (const s of at(new Vec3(x, y, z)).shapes) heights.add(y + s[4]);
      const list = [...heights].filter(y => safe({ x, y, z })); cache.set(id, list); return list;
    };
    const queue = [position]; const seen = new Set([key(position)]);
    for (let i = 0; i < queue.length; i += 1) {
      const current = queue[i];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = current.x + dx, z = current.z + dz;
        if (x < blueprint.bounds.minX - 3 || x > blueprint.bounds.maxX + 3 || z < blueprint.bounds.minZ - 3 || z > blueprint.bounds.maxZ + 3) continue;
        for (const y of options(x, z)) {
          const next = { x, y, z };
          if (Math.abs(y - current.y) > 1.01 || seen.has(key(next))) continue;
          seen.add(key(next)); queue.push(next);
        }
      }
    }
    return queue;
  }
  async function moveTo(target, range = .8) {
    const goal = graph().find(p => Math.hypot(p.x - target.x, p.z - target.z) <= range && Math.abs(p.y - target.y) <= 1.1);
    if (!goal) throw Object.assign(new Error(`No collision-connected stance for ${key(target)}`), { code: 'placement_no_safe_stance' });
    position = goal;
  }
  function setOpen(door, open) {
    for (const p of [door.lower, door.upper]) {
      const spec = cells.get(key(p)); spec.properties = { ...spec.properties, open };
    }
  }
  return { at, graph, moveTo, safe, setOpen, position: () => position, cells };
}

test('villa closure explicitly retains the upper west exit and the main ground exit until their last safe crossing', () => {
  const b = createEstateBlueprint({ x: 0, y: 64, z: 0 }, { profile: 'riverside_villa' });
  const plan = planEstateDoorClosure(b);
  assert.equal(plan.length, 5);
  assert.deepEqual(plan.map(s => [s.door.facing, s.door.lower.y - 64, s.side]), [
    ['south', 5, 'inside'], ['west', 5, 'outside'], ['south', 1, 'inside'], ['east', 1, 'inside'], ['north', 1, 'outside'],
  ]);
  for (const s of plan) {
    const d = delta[s.door.facing];
    const side = (s.approach.x - s.door.lower.x) * d[0] + (s.approach.z - s.door.lower.z) * d[1];
    assert.equal(side, s.side === 'inside' ? -1 : 1); assert.equal(s.approach.y, s.door.lower.y);
    assert.ok(s.escapePurpose);
  }
});

for (const profile of ['medieval_castle', 'riverside_villa']) {
  test(`${profile}: every planned close remains collision-connected to its next safe approach and final outside`, async () => {
    const b = createEstateBlueprint({ x: -7, y: 64, z: 13 }, { profile }); const g = geometry(b);
    for (const s of planEstateDoorClosure(b)) {
      await g.moveTo(s.approach, .3);
      assert.equal(g.safe(g.position()), true);
      const d = delta[s.door.facing];
      const side = (g.position().x - s.door.lower.x) * d[0] + (g.position().z - s.door.lower.z) * d[1];
      assert.ok(s.side === 'outside' ? side > .35 : side < -.35);
      g.setOpen(s.door, false);
      for (const p of [s.door.lower, s.door.upper]) assert.equal(g.at(new Vec3(p.x, p.y, p.z)).getProperties().open, false);
    }
    await g.moveTo(b.entrance.outside, .3);
    assert.ok(b.furniture.doors.every(d => g.at(new Vec3(d.lower.x, d.lower.y, d.lower.z)).getProperties().open === false));
  });
}

test('historical arbitrary-side close order can strand the bot inside after closing all ground exits', async () => {
  const b = createEstateBlueprint({ x: 0, y: 64, z: 0 }, { profile: 'riverside_villa' }); const g = geometry(b);
  const closed = [];
  // Preserve the pre-fix sequence as a counterexample, rather than expecting
  // the corrected production adapter to continue reproducing the old bug.
  async function historical() {
    for (const d of b.furniture.doors) await g.moveTo(d.lower, 2);
    for (const p of [b.furniture.craftingTable, ...b.furniture.chests, ...b.furniture.furnaces,
      ...b.furniture.beds.map(bed => bed.foot), b.furniture.enchantingTable]) await g.moveTo(p, 2);
    await g.moveTo(b.entrance.outside);
    for (const door of b.furniture.doors) {
      await g.moveTo(door.lower, 2); g.setOpen(door, false);
      closed.push({ facing: door.facing, y: door.lower.y, at: { ...g.position() } });
    }
  }
  await assert.rejects(historical(), { code: 'placement_no_safe_stance' });
  assert.deepEqual(closed.map(d => d.facing), ['north', 'south', 'east']);
  assert.ok(closed.at(-1).at.x < 10, 'Last ground exit was closed from the interior');
  assert.equal(g.graph().some(p => key(p) === key(b.entrance.outside)), false, 'No ground or upper route remains to the outside');
});

test('closing the upper west exit from its exterior before the upper rear leaf severs every later upper-rear approach', async () => {
  const b = createEstateBlueprint({ x: 0, y: 64, z: 0 }, { profile: 'riverside_villa' }); const g = geometry(b);
  const exit = planEstateDoorClosure(b)[1]; const rear = planEstateDoorClosure(b)[0].door;
  await g.moveTo(exit.approach, .3); g.setOpen(exit.door, false);
  await assert.rejects(g.moveTo(rear.lower, 2), { code: 'placement_no_safe_stance' });
  assert.ok(b.furniture.doors.filter(d => d.lower.y === 65).every(d => g.at(new Vec3(d.lower.x, d.lower.y, d.lower.z)).getProperties().open), 'Even open ground exits provide no second upper stair');
});

test('unknown profiles, wrong door pairs, duplicate doors and changed upper exit cannot create a closure plan', () => {
  for (const change of [b => { b.profile = 'foreign'; }, b => { b.furniture.doors[0].upper.y += 1; },
    b => { b.furniture.doors[1] = b.furniture.doors[0]; }, b => { b.furniture.doors.find(d => d.facing === 'west').facing = 'east'; }]) {
    const b = createEstateBlueprint({ x: 0, y: 64, z: 0 }, { profile: 'riverside_villa' }); change(b);
    assert.throws(() => planEstateDoorClosure(b), { code: 'estate_invalid_door_closure' });
  }
});

test('closure plan copies coordinate ownership and cannot mutate the blueprint through returned steps', () => {
  const b = createEstateBlueprint({ x: 0, y: 64, z: 0 }, { profile: 'riverside_villa' });
  const original = JSON.stringify(b);
  const plan = planEstateDoorClosure(b); plan[0].door.lower.x = 999; plan[0].approach.z = 999;
  assert.equal(JSON.stringify(b), original);
});
