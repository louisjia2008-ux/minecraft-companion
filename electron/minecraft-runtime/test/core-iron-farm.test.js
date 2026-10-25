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
  rail: { solid: false, stand: false, full: false, empty: true },
  activator_rail: { solid: false, stand: false, full: false, empty: true },
  redstone_block: { solid: true, stand: true, full: true, empty: false },
};

function world(f, rails = false) {
  const blocks = new Map();
  for (const c of f.digOrder) blocks.set(key(c), 'air');
  for (const c of f.lava) blocks.set(key(c), 'lava');
  for (const p of f.parts) {
    blocks.set(key(p.position), p.block);
    if (p.head) blocks.set(key(p.head), p.block);
  }
  blocks.set(key(f.cells.seal), 'cobblestone');
  // The minecart variant: rails on the way in, the redstone block under the corridor.
  if (rails) {
    for (const r of f.rails) blocks.set(key(r.position), r.block);
    blocks.set(key(f.cells.power), 'redstone_block');
  }
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
    for (const rails of [false, true]) {
      const at = world(f, rails);
      const beds = f.parts.filter((p) => p.head).flatMap((p) => [p.position, p.head]);
      const found = new Set();
      for (const v of [...f.cells.corridor, ...beds]) for (const s of golemSpots(at, v)) found.add(key(s));
      assert.deepEqual([...found].sort(), f.cells.shafts.map(key).sort(), `${facing}${rails ? ' with rails' : ''}`);
    }
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
    // The seal goes into the top of the tunnel's first cell; the gap left under it
    // is one high: a minecart rolls through, a villager (1.95 high) can't walk out.
    assert.equal(f.cells.seal.y, Y + 1);
    assert.ok(dug.has(key(f.cells.seal)) && dug.has(key({ ...f.cells.seal, y: Y })) && !dug.has(key({ ...f.cells.seal, y: Y + 2 })));
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

test('the rails run from the corridor up the stairs, one connected line', () => {
  for (const facing of Object.keys(FACINGS)) {
    const f = createIronFarm({ x: 0, y: 63, z: 0 }, facing);
    const Y = f.levels.feet;
    const dug = new Set(f.digOrder.map(key));
    const r = f.rails.map((x) => x.position);
    // The corridor's rails drop villagers off; the redstone block under the last one powers all three.
    assert.deepEqual(f.rails.slice(0, 3).map((x) => x.block), ['activator_rail', 'activator_rail', 'activator_rail']);
    assert.deepEqual(r.slice(0, 3).map(key), [...f.cells.corridor].reverse().map(key));
    assert.equal(key(f.cells.power), key({ ...r[0], y: Y - 1 }));
    assert.ok(f.rails.slice(3).every((x) => x.block === 'rail'));
    // Every rail sits in a dug cell on solid ground, and the line ends at the stairs' top.
    for (const p of r.slice(0, -1)) assert.ok(dug.has(key(p)) && !dug.has(key({ ...p, y: p.y - 1 })), `${facing}: ${key(p)}`);
    assert.equal(key(r[r.length - 1]), key(f.cells.stairsTop));
    // The corner (the tunnel's far end) and the rail after it are level: a
    // curve can't slope, so the slope starts one block past it.
    const corner = r.findIndex((p) => p.x === f.tunnel[2].x && p.z === f.tunnel[2].z && p.y === Y);
    assert.ok(corner > 0);
    assert.equal(r[corner + 1].y, Y);
    assert.equal(r[corner + 2].y, Y + 1);
    // Each rail joins the one before it: one step across, at most one up.
    for (let i = 1; i < r.length; i += 1) {
      const d = [r[i].x - r[i - 1].x, r[i].y - r[i - 1].y, r[i].z - r[i - 1].z];
      assert.equal(Math.abs(d[0]) + Math.abs(d[2]), 1, `${facing}: ${key(r[i])}`);
      assert.ok(d[1] === 0 || d[1] === 1);
    }
    // Room for a cart with a villager in it: a dug cell over every rail below ground
    // (the seal's, one high, is the only one blocked once the farm is closed).
    for (const p of r) assert.ok(p.y >= f.levels.ground || dug.has(key({ ...p, y: p.y + 1 })), `${facing}: over ${key(p)}`);
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
