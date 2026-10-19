/* global require */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEstateBlueprint } = require('../vendor/server/minecraft/estateBlueprints');
const { createEstateBuilder, matchesEstateBlock, getEstateDerivedBlocks, getEstateScaffoldCleanupOrder } = require('../vendor/server/minecraft/estateBuilder');
const key = p => `${p.x},${p.y},${p.z}`;
const error = code => Object.assign(new Error(code), { code });

// These are orchestration contract tests. Real collision, native windows,
// movement and server acknowledgements remain the live harness's job.
function fixture(profile = 'medieval_castle') {
  const anchor = { x: 0, y: 0, z: 0 };
  const blueprint = createEstateBlueprint(anchor, { profile });
  const cells = new Map(); const inventory = {}; const actions = []; const batches = [];
  let checkpoint = {}; let cancelled = false;
  const block = (name, props = {}, position = {}) => ({ name, position, boundingBox: ['air', 'water', 'wheat'].includes(name) ? 'empty' : 'block', getProperties: () => props });
  const at = p => {
    if (cells.has(key(p))) return cells.get(key(p));
    const river = blueprint.waterZones.some(zone => p.y === zone.bounds.minY && p.x >= zone.bounds.minX && p.x <= zone.bounds.maxX && p.z >= zone.bounds.minZ && p.z <= zone.bounds.maxZ);
    return block(river ? 'water' : p.y < anchor.y ? 'grass_block' : 'air', river ? { level: 0 } : {}, p);
  };
  const put = (position, item, props) => cells.set(key(position), block(item, props, position));
  const active = () => { if (cancelled) throw error('cancelled'); };
  const bot = { blockAt: at, registry: { itemsByName: { white_bed: { stackSize: 1 } } } };
  const deps = {
    getBot: () => bot, assertActive: active, getCheckpoint: () => checkpoint,
    setCheckpoint: next => { active(); checkpoint = next; }, report: () => {}, selectSite: () => anchor,
    getItemCount: item => inventory[item] || 0,
    prepareMaterials: async (requirements, context) => {
      active();
      assert.ok(Object.values(requirements).reduce((a, b) => a + b, 0) <= 96);
      assert.ok(Object.entries(requirements).reduce((n, [item, count]) => n + Math.ceil(count / (item === 'white_bed' ? 1 : 64)), 0) <= 12);
      batches.push({ requirements: { ...requirements }, ...context });
      for (const [item, count] of Object.entries(requirements)) inventory[item] = Math.max(inventory[item] || 0, count);
      if (!checkpoint.depots) checkpoint = { ...checkpoint, depots: [{ x: -20, y: 0, z: -20 }] };
    },
    recordOwnedBlock: (spec, scaffold) => {
      checkpoint = scaffold ? { ...checkpoint, ownedScaffold: [...(checkpoint.ownedScaffold || []).filter(s => s.id !== spec.id), spec] } :
        { ...checkpoint, ownedBlockIds: [...new Set([...(checkpoint.ownedBlockIds || []), spec.id])] };
    },
    placeBlock: async (spec, onConfirmed) => {
      active();
      assert.ok(inventory[spec.item] > 0, `real batch must cover ${spec.id}`);
      assert.equal(at(spec.position).name, 'air', 'No unowned occupied cell may be overwritten');
      if (spec.component === 'villa_dock' && spec.phase === 'floor') {
        assert.equal(at({ ...spec.position, y: spec.position.y - 1 }).name, 'water');
        assert.ok(blueprint.blocks.some(s => s.item === 'oak_planks' && s.phase === 'floor' && s.position.y === spec.position.y &&
          Math.abs(s.position.x - spec.position.x) + Math.abs(s.position.z - spec.position.z) === 1 && at(s.position).name === 'oak_planks'));
      }
      inventory[spec.item] -= 1;
      put(spec.position, spec.item, spec.properties);
      for (const derived of spec.derivedBlocks || []) put(derived.position, derived.item, derived.properties);
      actions.push({ kind: 'place', spec });
      onConfirmed?.();
    },
    breakBlock: async (position, options) => {
      active();
      assert.equal(options.maxFeetY, position.y, 'Digging retains the lower supported stance constraint');
      const previous = at(position);
      actions.push({ kind: 'break', position, options, previous: previous.name });
      put(position, 'air');
      const spec = blueprint.blocks.find(s => key(s.position) === key(position));
      if (spec && !spec.derived) for (const derived of getEstateDerivedBlocks(blueprint, spec)) put(derived.position, 'air');
    },
    moveTo: async position => { active(); actions.push({ kind: 'move', position }); },
    verifyRoutes: async bp => {
      active(); actions.push({ kind: 'verify_routes' });
      for (const door of bp.furniture.doors || [bp.furniture.door]) for (const p of [door.lower, door.upper]) {
        put(p, 'oak_door', { ...at(p).getProperties(), open: true });
      }
      return { confirmed: true, checks: bp.routes.map(route => ({ id: route.id, traversed: true })) };
    },
    verifyFurniture: async bp => {
      active(); actions.push({ kind: 'verify_furniture' });
      for (const door of bp.furniture.doors || [bp.furniture.door]) for (const p of [door.lower, door.upper]) {
        put(p, 'oak_door', { ...at(p).getProperties(), open: false });
      }
      const f = bp.furniture;
      return { craftingTable: { confirmed: true }, enchantingTable: { confirmed: true }, bookshelves: { confirmed: true, effectiveCount: 15 },
        chests: (f.chests || [f.chest]).map(() => ({ confirmed: true })), furnaces: (f.furnaces || [f.furnace]).map(() => ({ confirmed: true })),
        beds: (f.beds || [f.bed]).map(() => ({ confirmed: true })) };
    },
    buildFarm: async spec => {
      active(); assert.equal(spec.schema, 1); assert.equal(spec.plots.length, 2);
      actions.push({ kind: 'farm' });
      for (const plot of spec.plots) {
        put(plot.water, 'water', { level: 0 });
        for (const crop of plot.crops) { put(crop.soilPosition, 'farmland', { moisture: 7 }); put(crop.position, 'wheat', { age: 0 }); }
      }
      return { farmVerified: true, waterSourceCount: 2, soilCount: 48, plantedCount: 48 };
    },
  };
  return { anchor, blueprint, cells, inventory, actions, batches, deps, at, put,
    checkpoint: () => checkpoint, setCheckpoint: value => { checkpoint = value; }, cancel: () => { cancelled = true; }, resume: () => { cancelled = false; },
    run: args => createEstateBuilder(deps).run({ profile, ...args }) };
}

for (const profile of ['medieval_castle', 'riverside_villa']) {
  test(`${profile}: bounded component batches, associated derived furniture, deferred cleanup and final actual-state gates`, async () => {
    const f = fixture(profile);
    const summary = await f.run();
    assert.equal(summary.missingBlocks, 0); assert.deepEqual(summary.stateMismatches, []); assert.deepEqual(summary.clearanceViolations, []);
    assert.equal(summary.farmVerified, true); assert.equal(summary.furnitureVerified, true); assert.equal(summary.routeVerified, true);
    assert.equal(f.checkpoint().phase, 'complete'); assert.equal(f.checkpoint().ownedScaffold.length, 0);
    assert.deepEqual(f.checkpoint().depots, [{ x: -20, y: 0, z: -20 }], 'Supply-added depots survive subsequent saves');
    assert.ok(f.blueprint.blocks.every(s => matchesEstateBlock(f.at(s.position), s)));
    for (const spec of f.blueprint.blocks.filter(s => !s.derived && ['white_bed', 'oak_door'].includes(s.item))) {
      const calls = f.actions.filter(a => a.kind === 'place' && a.spec.id === spec.id);
      assert.equal(calls.length, 1); assert.equal(calls[0].spec.derivedBlocks.length, 1);
      assert.equal(key(calls[0].spec.derivedBlocks[0].position), key(getEstateDerivedBlocks(f.blueprint, spec)[0].position));
    }
    const firstFarm = f.actions.findIndex(a => a.kind === 'farm');
    assert.ok(firstFarm > f.actions.findLastIndex(a => a.kind === 'break'), 'Farming follows heavy construction and cleanup');
    if (profile === 'riverside_villa') {
      const rampBatches = f.batches.filter(b => b.component === 'villa_roof' && b.phase === 'scaffold_roof');
      assert.equal(rampBatches.length, 1, '13-high 91-block ramp is one bounded supply batch');
      assert.equal(rampBatches[0].requirements.dirt, 91);
      const lastRoof = f.actions.findLastIndex(a => a.kind === 'place' && a.spec.component === 'villa_roof');
      const firstDeferredCleanup = f.actions.findIndex(a => a.kind === 'break' && f.blueprint.scaffold.some(s => ['villa_ground', 'villa_upper_shell', 'villa_decks'].includes(s.component) && key(s.position) === key(a.position)));
      assert.ok(firstDeferredCleanup > lastRoof, 'Lower platforms remain owned until upper roofing is complete');
    }
  });
}

test('whole-site foreign block, outer scaffold fluid, dry-ground damage and undeclared river are rejected before any supply or write', async () => {
  for (const kind of ['foreign', 'fluid', 'ground', 'river']) {
    const f = fixture(kind === 'river' ? 'riverside_villa' : 'medieval_castle');
    if (kind === 'foreign') f.put({ x: f.blueprint.workBounds.maxX, y: 2, z: f.blueprint.workBounds.maxZ }, 'chest');
    if (kind === 'fluid') f.put(f.blueprint.scaffold.at(-1).position, 'lava');
    if (kind === 'ground') f.put(f.blueprint.siteRequirements.dryGroundCells.at(-1), 'air');
    if (kind === 'river') f.put({ x: 20, y: -1, z: 25 }, 'stone');
    await assert.rejects(f.run(), { code: { foreign: 'estate_site_occupied', fluid: 'estate_unsafe_site', ground: 'estate_unsafe_ground', river: 'estate_unsafe_river' }[kind] });
    assert.equal(f.actions.length, 0); assert.equal(f.batches.length, 0);
  }
});

test('material promises do not replace real inventory confirmation', async () => {
  const f = fixture();
  f.deps.prepareMaterials = async () => ({ confirmed: true });
  await assert.rejects(f.run(), { code: 'house_materials_missing' });
  assert.ok(f.checkpoint().missingMaterials.length > 0); assert.equal(f.actions.length, 0);
});

test('an actual reachable seed beyond the first 96 is rebudgeted without dropping deferred requirements or exceeding capacity', async () => {
  const f = fixture();
  for (const spec of f.blueprint.blocks.filter(s => s.component === 'keep' && s.phase !== 'floor')) f.put(spec.position, spec.item, spec.properties);
  const floors = f.blueprint.blocks.filter(s => s.component === 'keep' && s.phase === 'floor')
    .sort((a, b) => a.position.y - b.position.y || a.position.z - b.position.z || a.position.x - b.position.x);
  assert.ok(floors.length > 96);
  const seed = floors[96]; const nativePlace = f.deps.placeBlock; let seeded = false;
  f.deps.placeBlock = async (spec, confirm) => {
    if (spec.component === 'keep' && spec.phase === 'floor' && !seeded && spec.id !== seed.id) throw error('placement_no_safe_stance');
    await nativePlace(spec, confirm);
    if (spec.id === seed.id) seeded = true;
  };
  const summary = await f.run();
  assert.equal(summary.furnitureVerified, true); assert.equal(f.actions.find(a => a.kind === 'place').spec.id, seed.id);
  assert.ok(floors.every(spec => f.actions.some(a => a.kind === 'place' && a.spec.id === spec.id)), 'Every deferred floor requirement is eventually really placed');
});

test('cancel immediately after native confirmation records ownership but cannot place another block; resume preserves original anchor and built cells', async () => {
  const f = fixture(); const nativePlace = f.deps.placeBlock;
  f.deps.placeBlock = async (spec, confirm) => { await nativePlace(spec, confirm); f.cancel(); };
  await assert.rejects(f.run(), { code: 'cancelled' });
  assert.equal(f.actions.filter(a => a.kind === 'place').length, 1);
  const originalId = f.actions[0].spec.id;
  assert.ok(f.checkpoint().ownedBlockIds.includes(originalId)); assert.notEqual(f.checkpoint().verified, true);
  f.resume(); f.deps.placeBlock = nativePlace;
  await assert.rejects(f.run({ anchor: { x: 100, y: 0, z: 100 } }), { code: 'estate_checkpoint_mismatch' });
  const summary = await f.run();
  assert.equal(summary.furnitureVerified, true);
  assert.equal(f.actions.filter(a => a.kind === 'place' && a.spec.id === originalId).length, 1);
});

test('cancelled scaffold confirmation retains complete route metadata; a foreign replacement is never dug on resume', async () => {
  const f = fixture(); const nativePlace = f.deps.placeBlock;
  f.deps.placeBlock = async (spec, confirm) => { await nativePlace(spec, confirm); if (spec.routeId) f.cancel(); };
  await assert.rejects(f.run(), { code: 'cancelled' });
  const owned = f.checkpoint().ownedScaffold[0];
  assert.ok(owned.id && owned.component && owned.routeId); assert.ok(Number.isFinite(owned.cleanupRank));
  f.resume(); f.put(owned.position, 'chest');
  const before = f.actions.length;
  await assert.rejects(f.run(), { code: 'estate_site_occupied' });
  assert.equal(f.actions.length, before); assert.equal(f.at(owned.position).name, 'chest');
});

test('restored scaffold ownership cannot change its declared cleanup rank, stage or approach direction', async () => {
  const f = fixture(); const nativePlace = f.deps.placeBlock;
  f.deps.placeBlock = async (spec, confirm) => { await nativePlace(spec, confirm); if (spec.routeId) f.cancel(); };
  await assert.rejects(f.run(), { code: 'cancelled' });
  const old = f.checkpoint(); const before = f.actions.length;
  f.resume();
  for (const [field, value] of [['cleanupRank', 999], ['stage', 'foreign'], ['approachDirection', 'foreign']]) {
    f.setCheckpoint({ ...old, ownedScaffold: old.ownedScaffold.map((s, i) => i === 0 ? { ...s, [field]: value } : s) });
    await assert.rejects(f.run(), { code: 'estate_checkpoint_mismatch' });
    assert.equal(f.actions.length, before, 'Corrupt resume metadata must fail before any world action');
  }
});

test('a missing native bed head cannot pass as a placed primary or completed furniture', async () => {
  const f = fixture('riverside_villa'); const nativePlace = f.deps.placeBlock;
  f.deps.placeBlock = async (spec, confirm) => {
    await nativePlace(spec, confirm);
    if (spec.item === 'white_bed') f.put(spec.derivedBlocks[0].position, 'air');
  };
  await assert.rejects(f.run(), { code: 'house_state_mismatch' });
  assert.notEqual(f.checkpoint().verified, true); assert.equal(f.actions.some(a => a.kind === 'farm'), false);
});

test('resume after cancellation during native route checking keeps opened real doors and rechecks all gates without consuming replacement material', async () => {
  const f = fixture('riverside_villa'); const nativeRoutes = f.deps.verifyRoutes;
  f.deps.verifyRoutes = async bp => { const result = await nativeRoutes(bp); f.cancel(); return result; };
  await assert.rejects(f.run(), { code: 'cancelled' });
  const places = f.actions.filter(a => a.kind === 'place').length;
  assert.equal(f.at(f.blueprint.furniture.door.lower).getProperties().open, true);
  f.resume(); f.deps.verifyRoutes = nativeRoutes;
  const summary = await f.run();
  assert.equal(summary.furnitureVerified, true); assert.equal(f.actions.filter(a => a.kind === 'place').length, places);
  assert.equal(f.at(f.blueprint.furniture.door.lower).getProperties().open, false);
});

test('interrupted highest-first cleanup resumes without recreating or rebudgeting removed dirt', async () => {
  const f = fixture('riverside_villa'); const nativeBreak = f.deps.breakBlock;
  let removed = 0;
  f.deps.breakBlock = async (position, options) => {
    if (removed === 4) throw error('placement_no_safe_stance');
    await nativeBreak(position, options); removed += 1;
  };
  await assert.rejects(f.run(), { code: 'placement_no_safe_stance' });
  const priorPlaces = f.actions.filter(a => a.kind === 'place' && a.spec.routeId).length;
  const firstCleanup = f.actions.findIndex(a => a.kind === 'break');
  assert.equal(f.actions[firstCleanup - 1].kind, 'move', 'Exit to a permanent approach before any cleanup');
  const priorBatches = f.batches.length;
  f.deps.breakBlock = nativeBreak;
  await f.run();
  assert.equal(f.actions.filter(a => a.kind === 'place' && a.spec.routeId).length, priorPlaces);
  assert.equal(f.batches.slice(priorBatches).some(b => b.phase.startsWith('scaffold')), false);
});

test('cleanup per route descends Y and removes the occluding approach-side block first, retaining the next lower layer', () => {
  for (const profile of ['medieval_castle', 'riverside_villa']) {
    const bp = createEstateBlueprint({ x: 0, y: 0, z: 0 }, { profile });
    for (const route of bp.scaffoldRoutes.filter(r => r.stage === 'roof')) {
      const ordered = getEstateScaffoldCleanupOrder(bp.scaffold.filter(s => s.routeId === route.id));
      for (let i = 1; i < ordered.length; i += 1) {
        assert.ok(ordered[i - 1].position.y >= ordered[i].position.y);
        if (ordered[i - 1].position.y === ordered[i].position.y) assert.ok(ordered[i - 1].cleanupRank <= ordered[i].cleanupRank);
      }
      for (let i = 0; i < ordered.length; i += 1) {
        const s = ordered[i];
        const below = ordered.findIndex(other => other.position.x === s.position.x && other.position.z === s.position.z && other.position.y === s.position.y - 1);
        if (below !== -1) assert.ok(below > i, 'Lower supporting block remains while the upper cell is dug');
      }
    }
  }
});

test('unreachable placement has a finite attempt boundary and cannot complete from stale verification', async () => {
  const f = fixture(); let attempted = 0;
  f.setCheckpoint({ schema: 1, sourceProfile: 'medieval_castle', anchor: f.anchor, verified: true, verificationSummary: { furnitureVerified: true } });
  f.deps.placeBlock = async () => { attempted += 1; throw error('placement_no_safe_stance'); };
  await assert.rejects(f.run(), { code: 'placement_no_safe_stance' });
  assert.ok(attempted > 0 && attempted <= f.blueprint.blocks.filter(s => s.component === 'keep' && s.phase === 'floor').length);
  assert.equal(f.checkpoint().verified, false); assert.equal(f.checkpoint().verificationSummary, null);
});

test('matching structures and old verified checkpoint cannot substitute for native routes, furniture or hydrated farms', async () => {
  for (const kind of ['route', 'furniture', 'farm', 'changed_final']) {
    const f = fixture();
    if (kind === 'route') f.deps.verifyRoutes = async () => ({ confirmed: true, checks: [] });
    if (kind === 'furniture') f.deps.verifyFurniture = async () => ({ confirmed: true });
    if (kind === 'farm') {
      const farm = f.deps.buildFarm;
      f.deps.buildFarm = async spec => { const result = await farm(spec); f.put(spec.plots[0].soil[0], 'farmland', { moisture: 0 }); return result; };
    }
    if (kind === 'changed_final') {
      const verify = f.deps.verifyFurniture;
      f.deps.verifyFurniture = async bp => { const result = await verify(bp); f.put(bp.blocks[0].position, 'air'); return result; };
    }
    await assert.rejects(f.run(), { code: { route: 'estate_routes_unconfirmed', furniture: 'estate_furniture_unconfirmed', farm: 'estate_farms_unconfirmed', changed_final: 'estate_verification_failed' }[kind] });
    assert.notEqual(f.checkpoint().verified, true); assert.notEqual(f.checkpoint().phase, 'complete');
  }
});
