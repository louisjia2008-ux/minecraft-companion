'use strict';
// The underground iron farm's blueprint and site choice. Digging it, moving
// the mobs in and collecting iron is covered by the ironfarm-flat scenario.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createIronFarm, DEPTH } = require('../core/blueprints/ironFarm');
const { FACINGS } = require('../core/blueprints/cobbleGenerator');
const { chooseIronFarmSite } = require('../core/goals/ironFarm');

const key = (p) => `${p.x},${p.y},${p.z}`;

// What the vanilla 1.21.8 golem spawn checks need to know about each block:
// legacy "solid", a full top face to stand on, a full collision box.
const KINDS = {
  air: { solid: false, stand: false, full: false, empty: true },
  lava: { solid: false, stand: false, full: false, empty: false, liquid: true },
  stone: { solid: true, stand: true, full: true, empty: false },
  cobblestone: { solid: true, stand: true, full: true, empty: false },
  white_bed: { solid: true, stand: false, full: false, empty: true },
  stone_slab: { solid: true, stand: false, full: false, empty: true },
  ladder: { solid: true, stand: false, full: false, empty: true },
  wall_torch: { solid: false, stand: false, full: false, empty: true },
};

function world(f) {
  const blocks = new Map();
  for (const c of f.digOrder) blocks.set(key(c), 'air');
  for (const c of f.lava) blocks.set(key(c), 'lava');
  for (const p of f.parts) {
    blocks.set(key(p.position), p.block);
    if (p.head) blocks.set(key(p.head), p.block);
  }
  blocks.set(key(f.cells.seal), 'cobblestone');
  return (p) => KINDS[blocks.get(key(p)) || (p.y > f.levels.ground ? 'air' : 'stone')];
}

// SpawnUtil.trySpawnMob with the LEGACY_IRON_GOLEM strategy, then
// IronGolem.checkSpawnObstruction: every cell a villager standing at `v` could
// put a golem in.
function golemSpots(at, v) {
  const spots = [];
  for (let dx = -8; dx <= 8; dx += 1) {
    for (let dz = -8; dz <= 8; dz += 1) {
      let above = at({ x: v.x + dx, y: v.y + 6, z: v.z + dz });
      for (let y = v.y + 5; y >= v.y - 7; y -= 1) {
        const below = at({ x: v.x + dx, y, z: v.z + dz });
        if ((above.empty && !above.full && (above === KINDS.air || above.liquid)) && below.solid) {
          const pos = { x: v.x + dx, y: y + 1, z: v.z + dz };
          const room = [0, 1, 2].every((i) => at({ ...pos, y: pos.y + i }).empty);
          if (below.stand && room) spots.push(pos);
          break;
        }
        above = below;
      }
    }
  }
  return spots;
}

test('golems fit only in the shafts, and every shaft is within reach of the villagers', () => {
  for (const facing of Object.keys(FACINGS)) {
    const f = createIronFarm({ x: 3, y: 63, z: -7 }, facing);
    const at = world(f);
    const beds = f.parts.filter((p) => p.head).flatMap((p) => [p.position, p.head]);
    const found = new Set();
    for (const v of [...f.cells.corridor, ...beds]) for (const s of golemSpots(at, v)) found.add(key(s));
    assert.deepEqual([...found].sort(), f.cells.shafts.map(key).sort(), facing);
  }
});

test('the room is closed: two high everywhere, sealed, the zombie behind a slab', () => {
  for (const facing of Object.keys(FACINGS)) {
    const f = createIronFarm({ x: 0, y: 63, z: 0 }, facing);
    const Y = f.levels.feet;
    assert.equal(f.levels.ground - Y, DEPTH);
    const dug = new Set(f.digOrder.map(key));
    // A villager on a sunk bed fits under the ceiling: 0.5625 + 1.95 < 3.
    for (const p of f.pits) assert.ok(!dug.has(key({ ...p, y: Y + 2 })));
    // Nothing above the corridor or the beds, and the seal shuts the corridor's only way out.
    for (const c of f.room) assert.ok(c.y <= Y + 1);
    // The seal goes into the tunnel's first cell; the gap left above it is one high.
    assert.ok(dug.has(key(f.cells.seal)) && dug.has(key({ ...f.cells.seal, y: Y + 1 })) && !dug.has(key({ ...f.cells.seal, y: Y + 2 })));
    assert.ok(!dug.has(key({ ...f.cells.zombie, y: Y - 1 })));
    // The slab's gap is above the zombie's cell floor plus one: a zombie can't step up into it.
    const slit = f.parts.find((p) => p.key === 'slit');
    assert.equal(slit.position.y, Y + 1);
    assert.ok(!dug.has(key({ ...slit.position, y: Y })));
    // Lava only touches its ladder cell, rock and the shaft's ceiling.
    const solid = new Set(f.solid.map(key));
    for (const l of f.lava) {
      const ladder = f.parts.find((p) => p.block === 'ladder' && Math.abs(p.position.x - l.x) + Math.abs(p.position.z - l.z) === 1 && p.position.y === l.y);
      assert.ok(ladder, facing);
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const n = { x: l.x + dx, y: l.y + dy, z: l.z + dz };
        if (key(n) === key(ladder.position)) continue;
        assert.ok(solid.has(key(n)), `${facing}: lava next to ${key(n)}`);
      }
    }
    // The stairs are out of every villager's golem search (±8 across).
    for (const s of f.stairs) {
      const far = f.cells.corridor.every((c) => Math.max(Math.abs(s.x - c.x), Math.abs(s.z - c.z)) > 8);
      assert.ok(far, `${facing}: stair ${key(s)}`);
    }
  }
});

test('site choice needs solid rock for the whole farm', () => {
  const caves = new Set();
  const block = (x, y, z) => {
    const name = caves.has(`${x},${y},${z}`) ? 'air' : y < 60 ? 'stone' : y < 63 ? 'dirt' : y === 63 ? 'grass_block' : 'air';
    return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' };
  };
  const farm = chooseIronFarmSite(block, { x: 0.5, y: 64, z: 0.5 });
  assert.ok(farm);
  assert.equal(farm.anchor.y, 63);
  // A cave at the villagers' level everywhere within reach.
  for (let x = -40; x <= 40; x += 1) for (let z = -40; z <= 40; z += 1) caves.add(`${x},${63 - DEPTH},${z}`);
  assert.equal(chooseIronFarmSite(block, { x: 0.5, y: 64, z: 0.5 }, { radius: 2 }), null);
});
