/* global require */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { createFurnishedHouseBlueprint } = require('../vendor/server/minecraft/furnishedHouseBlueprints');
const { inspectNaturalHouseSite, chooseLoadedNaturalHouseSite } = require('../vendor/server/minecraft/naturalHouseSites');
const key = p => `${p.x},${p.y},${p.z}`;
const anchor = { x: 0, y: 64, z: 0 };
function fixture(height = 63) {
  const edits = new Map();
  const blockAt = p => {
    const name = edits.get(key(p));
    if (name === null) return null;
    const block = Block.fromStateId(registry.blocksByName[name || (p.y <= height ? 'sand' : 'air')].defaultState);
    block.position = new Vec3(p.x, p.y, p.z);
    return block;
  };
  return { edits, blockAt };
}
test('loaded flat desert has full clearance and preserves the actual cottage material budget', () => {
  const f = fixture(); const before = [...f.edits];
  const result = inspectNaturalHouseSite({ anchor, blockAt: f.blockAt });
  assert.equal(result.valid, true); assert.equal(result.foundationCount, 0);
  assert.equal(result.nativePlacements, 274); assert.equal(result.scaffoldBlocks, 52);
  assert.equal(result.floorSupportCells, 66); assert.equal(result.scaffoldBaseCells, 19);
  assert.equal(result.materialBudget.dirt, 52); assert.deepEqual([...f.edits], before);
});
test('site selection preserves raised ground instead of excavating a low house platform', () => {
  for (const name of ['grass_block', 'dirt', 'stone', 'sand', 'snow_block']) {
    const f = fixture();
    f.edits.set('2,65,2', name);
    const result = inspectNaturalHouseSite({ anchor, blockAt: f.blockAt });
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'terrain_excavation_required');
    assert.equal(f.edits.get('2,65,2'), name);
  }
  const raised = fixture(65);
  const result = chooseLoadedNaturalHouseSite({ origin: anchor, blockAt: raised.blockAt });
  assert.equal(result.valid, true);
  assert.equal(result.anchor.y, 66);
  assert.equal(result.clearingCount, 0);
});
test('nearby natural terraces at other observed heights are found without changing any terrain', () => {
  for (const height of [62, 64]) {
    const f = fixture(height);
    const selected = chooseLoadedNaturalHouseSite({ origin: anchor, blockAt: f.blockAt });
    assert.equal(selected.valid, true); assert.equal(selected.anchor.y, height + 1);
    assert.equal(f.edits.size, 0);
  }
});
test('cactus and foreign containers reject before material acquisition, including foundation containers', () => {
  for (const [p, name] of [['3,64,3', 'cactus'], ['1,64,1', 'chest'], ['2,63,2', 'chest'], ['2,63,2', 'oak_leaves']]) {
    const f = fixture(); f.edits.set(p, name);
    assert.equal(inspectNaturalHouseSite({ anchor, blockAt: f.blockAt }).valid, false);
    assert.equal(f.edits.get(p), name);
  }
});
test('door outside and complete rear roof ramp headroom are checked beyond the body clear bounds', () => {
  for (const p of [{ x: 3, y: 64, z: -2 }, { x: 3, y: 66, z: 16 }]) {
    const f = fixture(); f.edits.set(key(p), 'sand');
    assert.equal(inspectNaturalHouseSite({ anchor, blockAt: f.blockAt }).reason, 'outside_route_obstructed');
  }
});
test('a still taller gravity column and any unloaded body clearance reject', () => {
  const f = fixture(); f.edits.set('2,72,2', 'sand');
  assert.equal(inspectNaturalHouseSite({ anchor, blockAt: f.blockAt }).reason, 'gravity_above_clearance');
  f.edits.clear(); f.edits.set('2,68,2', null);
  assert.equal(inspectNaturalHouseSite({ anchor, blockAt: f.blockAt }).reason, 'unsafe_clearance');
});
test('optional one-layer foundation is budgeted; unsupported or underwater holes cannot be selected', () => {
  const f = fixture(); f.edits.set('2,63,2', 'air');
  assert.equal(inspectNaturalHouseSite({ anchor, blockAt: f.blockAt }).valid, false);
  const repaired = inspectNaturalHouseSite({ anchor, blockAt: f.blockAt, allowSingleLayerFoundation: true });
  assert.equal(repaired.valid, true); assert.equal(repaired.foundationCount, 1); assert.equal(repaired.materialBudget.cobblestone, 52);
  f.edits.set('2,62,2', 'air');
  assert.equal(inspectNaturalHouseSite({ anchor, blockAt: f.blockAt, allowSingleLayerFoundation: true }).valid, false);
  f.edits.set('2,63,2', 'water');
  assert.equal(inspectNaturalHouseSite({ anchor, blockAt: f.blockAt, allowSingleLayerFoundation: true }).valid, false);
});
test('advanced library checks its own full scaffold and furniture footprint', () => {
  const f = fixture();
  const selected = inspectNaturalHouseSite({ anchor, profile: 'enchanting_library', blockAt: f.blockAt });
  assert.equal(selected.valid, true); assert.equal(selected.nativePlacements, 408);
  assert.equal(selected.scaffoldBlocks, 60); assert.equal(selected.floorSupportCells, 102);
});
test('bounded loaded-site search stops without turning unknown cells into air', () => {
  let reads = 0;
  const result = chooseLoadedNaturalHouseSite({ origin: anchor, limit: 12, blockAt: () => { reads += 1; return null; } });
  assert.equal(result.valid, false); assert.equal(result.inspected, 12); assert.equal(reads, 12);
  assert.equal(result.rejected.length, 12);
});
test('the finite default search reaches a fully supported terrace after the first 128 rejected anchors', () => {
  // Same failure shape as the stopped natural cottage run: the first safe site
  // is candidate193 in ring12 at dy=-1. This constructed terrain contains no
  // seed/world coordinates and requires all original exterior ramp checks.
  const origin = { x: 0, y: 64, z: 0 }, desired = { x: -4, y: 63, z: -12 };
  const blueprint = createFurnishedHouseBlueprint(desired, { profile: 'cottage' });
  const supportCells = [
    ...blueprint.blocks.filter(spec => spec.phase === 'floor').map(spec => ({ ...spec.position, y: spec.position.y - 1 })),
    ...blueprint.scaffold.filter(spec => spec.position.y === desired.y).map(spec => ({ ...spec.position, y: spec.position.y - 1 })),
    { ...blueprint.entrance.outside, y: blueprint.entrance.outside.y - 1 },
  ];
  const bounds = { minX: Math.min(...supportCells.map(p => p.x)), maxX: Math.max(...supportCells.map(p => p.x)),
    minZ: Math.min(...supportCells.map(p => p.z)), maxZ: Math.max(...supportCells.map(p => p.z)) };
  const edits = new Map(); let reads = 0;
  const blockAt = p => {
    reads += 1;
    if (edits.has(key(p)) && edits.get(key(p)) === null) return null;
    const onTerrace = p.x >= bounds.minX && p.x <= bounds.maxX && p.z >= bounds.minZ && p.z <= bounds.maxZ;
    const top = onTerrace ? 62 : 60;
    const name = edits.get(key(p)) || (p.y > top ? 'air' : p.y === top ? 'grass_block' : 'dirt');
    return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position: new Vec3(p.x, p.y, p.z) });
  };
  const limited = chooseLoadedNaturalHouseSite({ origin, blockAt, limit: 128 });
  assert.equal(limited.valid, false); assert.equal(limited.reason, 'finite_site_search_exhausted');
  assert.equal(limited.inspected, 128); assert.equal(limited.rejected.length, 128);
  const result = chooseLoadedNaturalHouseSite({ origin, blockAt });
  assert.equal(result.valid, true); assert.equal(result.inspected, 193); assert.deepEqual(result.anchor, desired);
  assert.equal(result.foundationCount, 0); assert.equal(result.scaffoldBlocks, blueprint.scaffold.length);
  assert.ok(reads < 10000, 'Finite candidate search reads a bounded fixture footprint'); assert.equal(edits.size, 0);
  for (const [position, name, reason] of [
    [{ x: desired.x + 3, y: desired.y, z: desired.z + 3 }, 'lava', 'unsafe_clearance'],
    [{ x: desired.x + 3, y: desired.y, z: desired.z + 3 }, 'chest', 'foreign_site_block'],
    [{ x: desired.x + 3, y: desired.y + 2, z: desired.z + 3 }, null, 'unsafe_clearance'],
    [blueprint.entrance.outside, 'cactus', 'outside_route_obstructed'],
  ]) {
    edits.set(key(position), name);
    assert.equal(inspectNaturalHouseSite({ anchor: result.anchor, blockAt }).reason, reason);
    assert.equal(edits.get(key(position)), name); edits.clear();
  }
});
