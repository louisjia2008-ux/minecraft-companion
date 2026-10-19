/* global require */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const WorldSync = require('prismarine-world/src/worldsync');
const { ESTATE_PROFILES, ESTATE_PHASES, createEstateBlueprint, getEstateMaterialBudget, getEstateFarmBudget } = require('../vendor/server/minecraft/estateBlueprints');

const key = (p) => `${p.x},${p.y},${p.z}`;
const anchor = { x: -7, y: 64, z: 13 };

// Collision-only geometry audit using the pinned game's actual block shapes.
// This does not replace native physics or live vanilla construction tests.
function geometry(blueprint, { temporary = false, stage } = {}) {
  const cells = new Map(blueprint.blocks.filter((s) => !stage || s.phase !== 'roof').map((s) => [key(s.position), s]));
  if (temporary) for (const spec of blueprint.scaffold) cells.set(key(spec.position), spec);
  const farmSoil = new Set(blueprint.farms.flatMap((f) => f.soil).map(key));
  const farmWater = new Set(blueprint.farms.map((f) => key(f.water)));
  const isRiver = (p) => blueprint.waterZones.some(({ bounds: b }) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY && p.z >= b.minZ && p.z <= b.maxZ);
  function blockAt(point) {
    const position = point.floored(); const id = key(position); const spec = cells.get(id);
    let name = spec?.item || (farmSoil.has(id) ? 'farmland' : farmWater.has(id) || isRiver(position) ? 'water' : position.y < blueprint.anchor.y ? 'grass_block' : 'air');
    let props = spec?.properties || {};
    if (name === 'farmland') props = { moisture: 7 };
    if (name === 'oak_door') props = { ...props, open: true };
    return Object.assign(Block.fromProperties(registry.blocksByName[name].id, props, 0), { position });
  }
  function safe(feet) {
    if (farmSoil.has(key(new Vec3(feet.x, blueprint.anchor.y, feet.z).floored()))) return false;
    let supported = false;
    for (let x = Math.floor(feet.x - .3); x <= Math.floor(feet.x + .3); x += 1) {
      for (let z = Math.floor(feet.z - .3); z <= Math.floor(feet.z + .3); z += 1) {
        for (let y = Math.floor(feet.y - .06); y <= Math.floor(feet.y + 1.8); y += 1) {
          const b = blockAt(new Vec3(x, y, z)); if (b.name === 'water') return false;
          for (const s of b.shapes) {
            if (feet.x + .3 <= x + s[0] || feet.x - .3 >= x + s[3] || feet.z + .3 <= z + s[2] || feet.z - .3 >= z + s[5]) continue;
            const top = y + s[4]; if (Math.abs(feet.y - top) < .07) supported = true;
            if (feet.y + .02 < top && feet.y + 1.8 > y + s[1] + .02) return false;
          }
        }
      }
    }
    return supported;
  }
  const feet = (p) => new Vec3(p.x + .5, p.y, p.z + .5);
  function reachable(start) {
    const bounds = blueprint.bounds; const standing = new Map();
    const options = (x, z) => {
      const id = `${x},${z}`; if (standing.has(id)) return standing.get(id);
      const heights = new Set();
      for (let y = blueprint.anchor.y - 1; y <= bounds.maxY; y += 1) {
        for (const shape of blockAt(new Vec3(x, y, z)).shapes) heights.add(y + shape[4]);
      }
      const values = [...heights].filter((y) => safe(new Vec3(x + .5, y, z + .5)));
      standing.set(id, values); return values;
    };
    const queue = [start]; const seen = new Set([key(start)]);
    for (let i = 0; i < queue.length; i += 1) {
      const current = queue[i];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = current.x + dx, z = current.z + dz;
        if (x < bounds.minX - 2 || x > bounds.maxX + 2 || z < bounds.minZ - 2 || z > bounds.maxZ + 2) continue;
        for (const y of options(x, z)) {
          const next = { x, y, z };
          if (Math.abs(y - current.y) > 1.01 || seen.has(key(next))) continue;
          seen.add(key(next)); queue.push(next);
        }
      }
    }
    return seen;
  }
  return { cells, blockAt, feet, safe, reachable };
}

for (const profile of ESTATE_PROFILES) {
  test(`${profile}: unique immutable cells, dependency order and exact staged budgets`, () => {
    const b = createEstateBlueprint(anchor, { profile });
    assert.equal(b.schema, 1); assert.equal(b.profile, profile);
    assert.equal(new Set(b.blocks.map((s) => key(s.position))).size, b.blocks.length);
    assert.equal(new Set(b.scaffold.map((s) => key(s.position))).size, b.scaffold.length);
    const blocks = new Map(b.blocks.map((s) => [key(s.position), s]));
    for (const s of b.scaffold) assert.equal(blocks.has(key(s.position)), false);
    for (const c of b.clearance) assert.equal(blocks.has(key(c.position)), false, c.purpose);
    const earlier = new Set(); const budget = {};
    for (const c of b.components) {
      assert.ok(c.dependencies.every((id) => earlier.has(id)), `${c.id} follows its declared dependencies`);
      assert.ok(c.phases.every((phase) => ESTATE_PHASES.includes(phase)));
      earlier.add(c.id);
      const partial = getEstateMaterialBudget(b, { component: c.id });
      for (const [item, n] of Object.entries(partial)) budget[item] = (budget[item] || 0) + n;
      assert.ok(c.blockIds.every((id) => b.blocks.some((s) => s.id === id && s.component === c.id)));
    }
    assert.deepEqual(budget, getEstateMaterialBudget(b));
    assert.equal(Object.values(budget).reduce((n, v) => n + v, 0), b.blocks.filter((s) => !s.derived).length + b.scaffold.length);
    assert.equal(budget.bookshelf, 15); assert.equal(budget.water, undefined); assert.equal(budget.farmland, undefined);
    assert.equal(budget.wheat, undefined); assert.equal(budget.white_bed, b.furniture.beds.length);
    assert.equal(budget.oak_door, b.furniture.doors.length);
    assert.deepEqual(getEstateFarmBudget(b), { dirt: 48, wheat_seeds: 56, water_bucket: 2, bone_meal: 64 });
    const changed = createEstateBlueprint(anchor, { profile }); changed.blocks[0].position.x = 1000;
    assert.notEqual(createEstateBlueprint(anchor, { profile }).blocks[0].position.x, 1000);
  });

  test(`${profile}: actual registry collision shapes leave all permanent routes reachable`, () => {
    const b = createEstateBlueprint(anchor, { profile }); const g = geometry(b);
    const seen = g.reachable(b.entrance.outside);
    for (const r of b.routes) for (const point of r.waypoints) {
      assert.ok(g.safe(g.feet(point)), `${r.id}: safe standing ${key(point)}`);
      assert.ok(seen.has(key(point)), `${r.id}: connected standing ${key(point)}`);
    }
    for (const f of b.farms) for (const point of f.access) assert.ok(seen.has(key(point)), `${f.id}: reachable dry edge`);
  });

  test(`${profile}: declared module/phase order admits native adjacent placement without unowned supports`, () => {
    const b = createEstateBlueprint(anchor, { profile }); const placed = new Map(); const temporary = new Map();
    function anchorExists(position) {
      if (position.y === anchor.y - 1) return !b.waterZones.some(({ bounds: r }) => position.x >= r.minX && position.x <= r.maxX && position.z >= r.minZ && position.z <= r.maxZ);
      const spec = placed.get(key(position)) || temporary.get(key(position));
      if (!spec) return false;
      const actual = Block.fromProperties(registry.blocksByName[spec.item].id, spec.properties || {}, 0);
      return actual.boundingBox === 'block' && actual.shapes.length > 0;
    }
    function placeQueue(input, targetMap) {
      let pending = [...input].sort((a, c) => a.position.y - c.position.y);
      while (pending.length) {
        const next = []; let count = 0;
        for (const spec of pending) {
          if (placed.has(key(spec.position)) || temporary.has(key(spec.position))) continue;
          const vertical = ['white_bed', 'oak_door', 'torch', 'oak_log'].includes(spec.item);
          const directions = vertical ? [[0, -1, 0]] : [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
          if (!directions.some(([dx, dy, dz]) => anchorExists({ x: spec.position.x + dx, y: spec.position.y + dy, z: spec.position.z + dz }))) { next.push(spec); continue; }
          targetMap.set(key(spec.position), spec); count += 1;
          if (spec.item === 'white_bed' || spec.item === 'oak_door') {
            const other = b.blocks.find((s) => s.derived && s.component === spec.component && s.item === spec.item
              && s.position.x === spec.position.x && (spec.item === 'white_bed' ? s.position.y === spec.position.y && s.position.z === spec.position.z - 1
                : s.position.z === spec.position.z && s.position.y === spec.position.y + 1));
            assert.ok(other); placed.set(key(other.position), other);
          }
        }
        assert.ok(count || !next.length, `Cannot seed native placement: ${next.slice(0, 3).map((s) => s.id).join(', ')}`);
        pending = next;
      }
    }
    for (const c of b.components) {
      for (const phase of c.phases) {
        if (phase === 'frame' || phase === 'roof') placeQueue(b.scaffold.filter((s) => s.component === c.id && s.stage === phase), temporary);
        placeQueue(b.blocks.filter((s) => s.component === c.id && s.phase === phase && !s.derived), placed);
      }
      for (const prior of b.components.filter((v) => v.id === c.id && !v.cleanupAfterComponent || v.cleanupAfterComponent === c.id)) {
        for (const spec of b.scaffold.filter((s) => s.component === prior.id)) temporary.delete(key(spec.position));
      }
    }
    assert.equal(placed.size, b.blocks.length); assert.equal(temporary.size, 0);
  });

  test(`${profile}: fifteen real bookshelves preserve both transmitter layers and furniture standing access`, () => {
    const b = createEstateBlueprint(anchor, { profile }); const g = geometry(b); const seen = g.reachable(b.entrance.outside);
    const table = b.furniture.enchantingTable;
    assert.equal(b.furniture.bookshelves.length, 15);
    for (const shelf of b.furniture.bookshelves) {
      const dx = shelf.x - table.x, dz = shelf.z - table.z;
      assert.equal(Math.max(Math.abs(dx), Math.abs(dz)), 2);
      assert.equal(g.cells.get(key(shelf)).item, 'bookshelf');
      for (const dy of [0, 1]) assert.equal(g.cells.has(key({ x: table.x + Math.trunc(dx / 2), y: table.y + dy, z: table.z + Math.trunc(dz / 2) })), false);
    }
    for (const target of [b.furniture.craftingTable, ...b.furniture.chests, ...b.furniture.furnaces, ...b.furniture.beds.map((v) => v.foot), table]) {
      assert.ok([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => seen.has(key({ ...target, x: target.x + dx, z: target.z + dz }))), `Reachable furniture ${key(target)}`);
    }
  });

  test(`${profile}: two 24-crop fields can be operated entirely from connected dry edges`, () => {
    const b = createEstateBlueprint(anchor, { profile });
    for (const f of b.farms) {
      assert.equal(f.soil.length, 24); assert.equal(f.crops.length, 24); assert.equal(f.access.length, 24);
      const soil = new Set(f.soil.map(key)); assert.equal(soil.has(key(f.water)), false);
      assert.equal(f.water.y, anchor.y);
      for (const c of f.crops) {
        assert.ok(soil.has(key(c.soilPosition))); assert.equal(c.position.y, c.soilPosition.y + 1);
        assert.ok(f.access.some((p) => Math.hypot(p.x - c.position.x, p.z - c.position.z, p.y + 1.62 - c.position.y - .5) <= 4.5));
      }
      assert.ok(f.access.every((p) => !soil.has(key({ ...p, y: anchor.y }))));
      assert.ok(!b.clearance.some((c) => f.crops.some((plant) => key(plant.position) === key(c.position))), 'Final crops are not incorrectly required to remain air');
    }
  });

  test(`${profile}: owned temporary supports have finite dry approaches and connected one-step climbs`, () => {
    const b = createEstateBlueprint(anchor, { profile }); const g = geometry(b, { temporary: true, stage: 'frame' });
    const scaff = new Map(b.scaffold.map((s) => [key(s.position), s]));
    for (const s of b.scaffold) {
      const below = { ...s.position, y: s.position.y - 1 };
      assert.ok(scaff.has(key(below)) || g.blockAt(new Vec3(below.x, below.y, below.z)).shapes.some((shape) => shape[4] === 1), `Supported scaffold ${key(s.position)}`);
      assert.ok(Number.isFinite(s.cleanupRank)); assert.ok(s.routeId && s.approachDirection);
    }
    for (const r of b.scaffoldRoutes) {
      const rg = geometry(b, { temporary: true, stage: r.stage === 'frame' ? 'frame' : undefined });
      let previous = r.approach;
      assert.ok(rg.safe(rg.feet(previous)), `${r.id}: safe dry approach`);
      for (const point of r.waypoints) {
        assert.ok(rg.safe(rg.feet(point)), `${r.id}: standing headroom ${key(point)}`);
        assert.ok(Math.abs(point.y - previous.y) <= 1.01 && Math.abs(point.x - previous.x) + Math.abs(point.z - previous.z) <= 1.01, `${r.id}: one-step adjacency`);
        previous = point;
      }
      assert.equal(r.exitBeforeCleanup, true);
      assert.ok(r.cleanupStart && r.cleanupPolicy);
      if (r.roofLanding) {
        const completed = geometry(b, { temporary: true });
        assert.ok(completed.safe(completed.feet(r.roofLanding)), `${r.id}: native half-slab roof landing`);
        const last = r.waypoints.at(-1);
        assert.equal(r.roofLanding.y - last.y, .5);
        assert.equal(Math.abs(r.roofLanding.z - last.z), 1);
      }
    }
  });

  test(`${profile}: approach-side-first ramp cleanup preserves support and native line of sight`, () => {
    const b = createEstateBlueprint(anchor, { profile }); const g = geometry(b, { temporary: true });
    const world = { getBlock: g.blockAt, raycast: WorldSync.prototype.raycast };
    for (const r of b.scaffoldRoutes.filter((v) => v.stage === 'roof')) {
      const owned = b.scaffold.filter((s) => s.routeId === r.id).sort((a, c) => a.cleanupRank - c.cleanupRank);
      let standing;
      for (const spec of owned) {
        const q = spec.position;
        const stepDirection = r.approachDirection === 'north' ? 1 : -1;
        if (!standing || standing.y !== q.y) {
          const sameLayer = owned.filter((s) => s.position.y === q.y);
          const outside = [...sameLayer].sort((a, c) => stepDirection * (c.position.z - a.position.z))[0].position;
          standing = q.y === anchor.y ? r.cleanupStart : { x: outside.x, y: q.y, z: outside.z + stepDirection };
        }
        assert.ok(g.safe(g.feet(standing)), `${r.id}: lower-layer support before ${key(q)}`);
        assert.ok(standing.y <= q.y, 'No target can be the standing surface under the player');
        assert.notEqual(key({ ...standing, y: standing.y - 1 }), key(q));
        const eye = g.feet(standing).offset(0, 1.62, 0); const delta = new Vec3(q.x + .5, q.y + .5, q.z + .5).minus(eye);
        assert.ok(delta.norm() <= 4.5, `${r.id}: native dig reach`);
        const hit = world.raycast(eye, delta.normalize(), 4.5);
        assert.ok(hit?.position.equals(new Vec3(q.x, q.y, q.z)), `${r.id}: outer layer must not occlude ${key(q)}`);
        g.cells.delete(key(q)); standing = { ...q };
        assert.ok(g.safe(g.feet(standing)), `${r.id}: next lower layer remains after removal`);
      }
    }
  });

  test(`${profile}: frame work platforms can be removed from their permanent or ground approach after roofing`, () => {
    const b = createEstateBlueprint(anchor, { profile }); const g = geometry(b, { temporary: true });
    const world = { getBlock: g.blockAt, raycast: WorldSync.prototype.raycast };
    for (const r of b.scaffoldRoutes.filter((v) => v.stage === 'frame')) {
      const owned = b.scaffold.filter((s) => s.routeId === r.id).sort((a, c) => a.cleanupRank - c.cleanupRank);
      const standing = r.cleanupStart;
      assert.ok(g.safe(g.feet(standing)), `${r.id}: completed-roof cleanup approach`);
      for (const spec of owned) {
        const q = spec.position; const eye = g.feet(standing).offset(0, 1.62, 0);
        assert.ok(standing.y <= q.y);
        const delta = new Vec3(q.x + .5, q.y + .5, q.z + .5).minus(eye);
        assert.ok(delta.norm() <= 4.5);
        const hit = world.raycast(eye, delta.normalize(), 4.5);
        assert.ok(hit?.position.equals(new Vec3(q.x, q.y, q.z)), `${r.id}: actual cleanup LOS ${key(q)}`);
        g.cells.delete(key(q)); assert.ok(g.safe(g.feet(standing)));
      }
    }
  });
}

test('castle curtain circuits actually connect all four tower platforms without climbing a sealed roof', () => {
  const b = createEstateBlueprint({ x: 0, y: 0, z: 0 }, { profile: 'medieval_castle' }); const g = geometry(b);
  const seen = g.reachable(b.entrance.outside);
  for (const [x, z] of [[1, 3], [25, 3], [1, 23], [25, 23]]) assert.ok(seen.has(key({ x, y: 4, z })));
  assert.equal(b.components.filter((c) => c.id.startsWith('tower_')).length, 4);
  assert.equal(b.components.filter((c) => c.id.startsWith('curtain_')).length, 4);
});

test('villa has a full second floor, two-wide external staircase, air dock targets, and no river ramp', () => {
  const b = createEstateBlueprint({ x: 0, y: 0, z: 0 }, { profile: 'riverside_villa' });
  const cells = new Map(b.blocks.map((s) => [key(s.position), s]));
  for (let x = 0; x < 11; x += 1) for (let z = 0; z < 13; z += 1) assert.equal(cells.get(`${x},4,${z}`).item, 'oak_planks');
  for (let z = 0; z < 5; z += 1) for (const x of [-3, -2]) assert.equal(cells.get(`${x},${z},${z}`).item, 'oak_stairs');
  const dock = b.blocks.filter((s) => s.component === 'villa_dock' && s.phase === 'floor');
  assert.equal(dock.length, 21); assert.ok(dock.every((s) => s.position.y === 0 && s.position.z >= 17));
  assert.ok(b.scaffold.every((s) => s.position.z < 17));
  assert.equal(b.siteRequirements.waterY, -1); assert.equal(b.siteRequirements.dock.targetBlock, 'air');
  assert.ok(b.components.find((c) => c.id === 'villa_upper_floor').dependencies.includes('villa_stairs'));
});

test('both pitched-roof designs close every room column with the intended native stair/slab states', () => {
  for (const profile of ESTATE_PROFILES) {
    const b = createEstateBlueprint({ x: 0, y: 0, z: 0 }, { profile });
    const rooms = profile === 'riverside_villa' ? [[0, 0, 11, 13, 7, 'villa_roof']] :
      [[9, 6, 9, 11, 3, 'keep'], [0, 0, 5, 5, 6, 'tower_nw'], [22, 0, 5, 5, 6, 'tower_ne'], [0, 22, 5, 5, 6, 'tower_sw'], [22, 22, 5, 5, 6, 'tower_se']];
    for (const [x0, z0, width, depth, wallTop, component] of rooms) {
      for (let x = -1; x <= width; x += 1) for (let z = -1; z <= depth; z += 1) {
        const y = wallTop + Math.min(x + 1, width - x);
        const actual = b.blocks.find((s) => s.position.x === x0 + x && s.position.y === y && s.position.z === z0 + z);
        assert.equal(actual?.component, component, 'No open roof column or foreign overlap');
        if (x === Math.floor(width / 2)) { assert.equal(actual.item, 'oak_slab'); assert.equal(actual.properties.type, 'bottom'); }
        else { assert.equal(actual.item, 'oak_stairs'); assert.equal(actual.properties.facing, x < width / 2 ? 'east' : 'west'); assert.equal(actual.properties.half, 'bottom'); }
      }
    }
  }
});

test('anchors translate every geometric coordinate exactly and invalid inputs fail explicitly', () => {
  for (const profile of ESTATE_PROFILES) {
    const a = createEstateBlueprint({ x: 0, y: 0, z: 0 }, { profile }); const b = createEstateBlueprint(anchor, { profile });
    assert.deepEqual(b.blocks.map((s) => ({ ...s.position, x: s.position.x - anchor.x, y: s.position.y - anchor.y, z: s.position.z - anchor.z })), a.blocks.map((s) => s.position));
    assert.deepEqual(getEstateMaterialBudget(a), getEstateMaterialBudget(b));
  }
  assert.throws(() => createEstateBlueprint({ x: .5, y: 0, z: 0 }));
  assert.throws(() => createEstateBlueprint({ x: Infinity, y: 0, z: 0 }));
  assert.throws(() => createEstateBlueprint({ x: Number.MAX_SAFE_INTEGER, y: 0, z: 0 }));
  assert.throws(() => createEstateBlueprint(anchor, { profile: 'unknown' }));
});
