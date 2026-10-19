/* global require */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Vec3 } = require('vec3'), registry = require('prismarine-registry')('1.21.8'), Block = require('prismarine-block')(registry);
const { createFurnishedHouseBuilder } = require('../vendor/server/minecraft/furnishedHouseBuilder');
const { createFurnishedHouseBlueprint, getFurnishedHouseMaterialBudget } = require('../vendor/server/minecraft/furnishedHouseBlueprints');
const { inspectNaturalHouseSite } = require('../vendor/server/minecraft/naturalHouseSites');
const key = p => `${p.x},${p.y},${p.z}`;
// Actual installed registry/Block shapes with explicit dependency-modeled
// dig/place/material replies. No live harvesting, walking or world acceptance.
function fixture(anchor, surface = 'grass_block') {
  const edits = new Map(), writes = []; let checkpoint = {}, materialWait = async () => {};
  const blueprint = createFurnishedHouseBlueprint(anchor, { profile: 'cottage' });
  const budget = { ...getFurnishedHouseMaterialBudget(blueprint), cobblestone: 1000 };
  const put = (p, name, properties = {}) => edits.set(key(p), { name, properties });
  const blockAt = p => {
    const edit = edits.get(key(p)); if (edit === null) return null;
    const name = edit?.name || (p.y === anchor.y - 1 ? surface : p.y < anchor.y - 1 ? 'stone' : 'air');
    const defaults = Block.fromStateId(registry.blocksByName[name].defaultState).getProperties();
    const b = Block.fromProperties(registry.blocksByName[name].id, { ...defaults, ...edit?.properties }, 0); b.position = new Vec3(p.x, p.y, p.z); return b;
  };
  const deps = { getBot: () => ({ blockAt }), assertActive: () => {}, getCheckpoint: () => checkpoint,
    setCheckpoint: value => { checkpoint = value; }, report: () => {}, getItemCount: name => budget[name] || 0,
    chooseAnchor: () => { const site = inspectNaturalHouseSite({ anchor, blockAt }); if (!site.valid) throw Object.assign(new Error(site.reason), { code: 'house_no_safe_site' }); return anchor; },
    getBlueprint: createFurnishedHouseBlueprint, prepareMaterials: async () => { await materialWait(); }, moveTo: async () => {},
    breakBlock: async p => { writes.push({ kind: 'dig', position: { ...p } }); put(p, 'air'); },
    placeBlock: async spec => { writes.push({ kind: 'place', position: spec.position }); put(spec.position, spec.item, spec.properties); },
  };
  const builder = createFurnishedHouseBuilder(deps);
  return { anchor, blueprint, edits, writes, blockAt, put, builder, checkpoint: () => checkpoint,
    materialWait: fn => { materialWait = fn; }, initialSite: () => inspectNaturalHouseSite({ anchor, blockAt }) };
}
const origins = [{ x: -907, y: 67, z: 1203 }, { x: 403, y: 117, z: -733 }, { x: -3, y: 18, z: -41 }];
for (const surface of ['red_sand', 'snow_block']) for (const anchor of origins) {
  test(`${surface} complete native floor and clearance at ${key(anchor)} agree between initial selector and clearing`, async () => {
    const f = fixture(anchor, surface), p = { x: anchor.x + 2, y: anchor.y + 1, z: anchor.z + 2 }; f.put(p, surface);
    assert.equal(f.initialSite().valid, true); assert.deepEqual(f.blockAt({ ...anchor, y: anchor.y - 1 }).shapes, [[0, 0, 0, 1, 1, 1]]);
    await f.builder.run({ phase: 'clear_site' });
    assert.deepEqual(f.writes, [{ kind: 'dig', position: p }]); assert.equal(f.blockAt(p).name, 'air');
    assert.equal(f.blockAt({ ...anchor, y: anchor.y - 1 }).name, surface);
  });
}

test('pale oak leaves are legal natural clearance but initial native floor leaves never select a house', async () => {
  const f = fixture(origins[0]), p = { x: f.anchor.x + 2, y: f.anchor.y + 2, z: f.anchor.z + 2 }; f.put(p, 'pale_oak_leaves');
  assert.equal(f.initialSite().valid, true); await f.builder.run({ phase: 'clear_site' }); assert.deepEqual(f.writes, [{ kind: 'dig', position: p }]);
  const g = fixture(origins[1]); g.put({ ...g.anchor, y: g.anchor.y - 1 }, 'pale_oak_leaves');
  assert.equal(g.initialSite().valid, false); await assert.rejects(g.builder.run({ phase: 'clear_site' }), { code: 'house_no_safe_site' }); assert.equal(g.writes.length, 0);
});

for (const leaf of ['oak_leaves', 'pale_oak_leaves']) for (const role of ['floor', 'scaffold_base', 'scaffold_cell']) {
  test(`material wait changes an initially valid ${role} to native ${leaf}: refuse before clearing, placement or scaffold skipping`, async () => {
    const f = fixture(origins[2]), clearable = { x: f.anchor.x + 2, y: f.anchor.y + 1, z: f.anchor.z + 2 };
    f.put(clearable, 'short_grass'); assert.equal(f.initialSite().valid, true);
    const scaffold = f.blueprint.scaffold[0].position;
    const p = role === 'floor' ? { x: f.anchor.x + 4, y: f.anchor.y - 1, z: f.anchor.z + 4 }
      : role === 'scaffold_base' ? { ...scaffold, y: scaffold.y - 1 } : scaffold;
    f.materialWait(async () => { await Promise.resolve(); f.put(p, leaf); });
    await f.builder.run({ phase: 'prepare_materials' });
    await assert.rejects(f.builder.run({ phase: role === 'scaffold_cell' ? 'roof' : 'clear_site' }), { code: 'house_unsafe_site' });
    assert.equal(f.writes.length, 0); assert.equal(f.blockAt(p).name, leaf); assert.equal(f.blockAt(clearable).name, 'short_grass');
    assert.equal(f.checkpoint().ownedScaffold?.length || 0, 0);
  });
}

test('a late native leaf base cannot authorize the first scaffold placement through the build entry', async () => {
  const f = fixture(origins[0]), first = f.blueprint.scaffold[0].position; assert.equal(f.initialSite().valid, true);
  f.materialWait(async () => { await Promise.resolve(); f.put({ ...first, y: first.y - 1 }, 'pale_oak_leaves'); });
  await f.builder.run({ phase: 'prepare_materials' });
  await assert.rejects(f.builder.run({ phase: 'roof' }), { code: 'house_unsafe_site' }); assert.equal(f.writes.length, 0);
});

for (const leaf of ['oak_leaves', 'pale_oak_leaves']) {
  test(`a late ${leaf} floor is refused at the floor build entry before any modeled placement`, async () => {
    const f = fixture(origins[0]), p = { x: f.anchor.x + 4, y: f.anchor.y - 1, z: f.anchor.z + 4 }; assert.equal(f.initialSite().valid, true);
    f.materialWait(async () => { await Promise.resolve(); f.put(p, leaf); }); await f.builder.run({ phase: 'prepare_materials' });
    await assert.rejects(f.builder.run({ phase: 'floor' }), { code: 'house_unsafe_site' }); assert.equal(f.writes.length, 0); assert.equal(f.blockAt(p).name, leaf);
  });
}

for (const kind of ['unknown', 'foreign', 'high_gravity', 'water', 'powder_snow']) {
  test(`shared natural terrain preserves original ${kind} rejection before any writes`, async () => {
    const f = fixture(origins[1]); const p = { x: f.anchor.x + 2, y: kind === 'high_gravity' ? f.blueprint.bounds.maxY + 1 : f.anchor.y + 1, z: f.anchor.z + 2 };
    if (kind === 'unknown') f.edits.set(key(p), null);
    else f.put(p, kind === 'foreign' ? 'chest' : kind === 'high_gravity' ? 'red_sand' : kind);
    assert.equal(f.initialSite().valid, false); await assert.rejects(f.builder.run({ phase: 'clear_site' }), { code: 'house_no_safe_site' }); assert.equal(f.writes.length, 0);
  });
}
