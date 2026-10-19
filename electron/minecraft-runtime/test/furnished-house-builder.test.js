/* global require */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFurnishedHouseBlueprint, getFurnishedHouseMaterialBudget } = require('../vendor/server/minecraft/furnishedHouseBlueprints');
const { createFurnishedHouseBuilder, matchesFurnishedHouseBlock } = require('../vendor/server/minecraft/furnishedHouseBuilder');
const key = (p) => `${p.x},${p.y},${p.z}`;
function fixture(profile = 'cottage', options = {}) {
  const anchor = { x: 0, y: 0, z: 0 };
  const blueprint = createFurnishedHouseBlueprint(anchor, { profile });
  const cells = new Map();
  const inventory = { ...getFurnishedHouseMaterialBudget(blueprint) };
  const writes = [];
  let checkpoint = options.checkpoint || {};
  let cancelled = false;
  let prepared = 0;
  const at = (position) => cells.get(key(position)) || { name: position.y < 0 ? 'grass_block' : 'air',
    boundingBox: position.y < 0 ? 'block' : 'empty', getProperties: () => ({}) };
  const block = (name, properties = {}) => ({ name, boundingBox: name === 'air' ? 'empty' : 'block', getProperties: () => properties });
  const assertActive = () => { if (cancelled) throw Object.assign(new Error('cancelled'), { code: 'cancelled' }); };
  const deps = {
    getBot: () => ({ blockAt: at }), assertActive, getCheckpoint: () => checkpoint,
    setCheckpoint: (next) => { checkpoint = next; }, report: () => {}, getItemCount: (name) => inventory[name] || 0,
    chooseAnchor: () => anchor, getBlueprint: createFurnishedHouseBlueprint,
    prepareMaterials: async () => { prepared += 1; },
    placeBlock: async (spec) => {
      assertActive();
      const adjacent = [[0,-1,0], [1,0,0], [-1,0,0], [0,0,1], [0,0,-1], [0,1,0]]
        .some(([x,y,z]) => at({ x: spec.position.x+x, y: spec.position.y+y, z: spec.position.z+z }).boundingBox === 'block');
      if (!adjacent) throw Object.assign(new Error('no adjacent reference'), { code: 'house_no_anchor' });
      assert.ok(inventory[spec.item] > 0, `Actual material budget must cover ${spec.item}`);
      inventory[spec.item] -= 1;
      writes.push({ kind: 'place', spec });
      cells.set(key(spec.position), block(spec.item, spec.properties));
      if (spec.item === 'white_bed' || spec.item === 'oak_door') {
        const other = blueprint.blocks.find((entry) => entry.derived && entry.item === spec.item);
        cells.set(key(other.position), block(other.item, other.properties));
      }
    },
    breakBlock: async (position) => { assertActive(); writes.push({ kind: 'break', position }); cells.set(key(position), block('air')); },
    moveTo: async () => { assertActive(); },
    activateBlock: async (actual) => {
      assertActive();
      const open = !actual.getProperties().open;
      for (const spec of blueprint.blocks.filter((entry) => entry.item === 'oak_door')) cells.set(key(spec.position), block('oak_door', { ...spec.properties, open }));
    },
    openCraftingTable: async () => ({ close() {} }), openContainer: async () => ({ close() {} }),
    openFurnace: async () => ({ close() {} }), openEnchantmentTable: async () => ({ close() {} }),
  };
  return { blueprint, cells, inventory, writes, at, block, deps,
    checkpoint: () => checkpoint, cancel: () => { cancelled = true; }, prepared: () => prepared,
    builder: () => createFurnishedHouseBuilder(deps) };
}

test('a missing bed cannot block the actual shell, but still blocks furniture and final acceptance',async()=>{
 const f=fixture();f.inventory.white_bed=0;
 await f.builder().run({phase:'prepare_materials'});
 assert.equal(f.checkpoint().requirements.white_bed,undefined);
 for(const phase of ['clear_site','floor','frame','walls','windows','roof'])await f.builder().run({phase});
 assert.ok(f.blueprint.blocks.filter(s=>s.phase==='roof').every(s=>matchesFurnishedHouseBlock(f.at(s.position),s)));
 await assert.rejects(f.builder().run({phase:'furniture'}),{code:'house_materials_missing'});
 assert.notEqual(f.checkpoint().verificationSummary?.furnitureVerified,true);
 const placed=f.writes.filter(w=>w.kind==='place').length;
 f.inventory.white_bed=1;
 await f.builder().run({phase:'furniture'});await f.builder().run({phase:'finish'});
 const summary=await f.builder().run({phase:'verify'});assert.equal(summary.furnitureVerified,true);
 assert.ok(f.writes.filter(w=>w.kind==='place').length>placed);
});
test('one missing future roof plank cannot force a full resupply trip before floor and walls',async()=>{
 const f=fixture();f.inventory.oak_planks--;
 f.deps.prepareMaterials=async needed=>{assert.ok(!needed.white_bed);};
 await f.builder().run({phase:'prepare_materials'});
 for(const phase of ['clear_site','floor','frame','walls','windows'])await f.builder().run({phase});
 assert.ok(f.writes.filter(w=>w.kind==='place').length>100);
 await assert.rejects(f.builder().run({phase:'roof'}),{code:'house_materials_missing'});
 assert.notEqual(f.checkpoint().verificationSummary?.furnitureVerified,true);
});
test('complete cottage verifies every final state, real furniture requests, and removes only its scaffold', async () => {
  const f = fixture();
  const summary = await f.builder().run();
  assert.equal(summary.furnitureVerified, true);
  assert.equal(summary.missingBlocks, 0);
  assert.deepEqual(summary.stateMismatches, []);
  assert.equal(f.checkpoint().ownedScaffold.length, 0);
  assert.equal(f.writes.filter((entry) => entry.kind === 'place' && entry.spec.item === 'white_bed').length, 1);
  assert.equal(f.writes.filter((entry) => entry.kind === 'place' && entry.spec.item === 'oak_door').length, 1);
  assert.ok(f.writes.some((entry) => entry.kind === 'place' && entry.spec.position.z === -1 && entry.spec.phase === 'roof'));
  assert.ok(f.blueprint.blocks.every((spec) => matchesFurnishedHouseBlock(f.at(spec.position), spec)));
});

for (const profile of ['cottage', 'enchanting_library']) {
  test(`${profile} verification exits and re-enters through an opened door when construction ends inside`, async () => {
    const f = fixture(profile);
    await f.builder().run({ profile });
    let side = 'inside';
    const traversals = [];
    const door = () => f.at(f.blueprint.furniture.door.lower);
    f.deps.moveTo = async (position) => {
      for (const next of ['outside', 'inside']) {
        if (key(position) !== key(f.blueprint.entrance[next])) continue;
        if (side !== next) {
          assert.equal(door().getProperties().open, true, 'A closed physical door blocks crossing the front wall');
          traversals.push(`${side}->${next}`);
          side = next;
        }
      }
    };
    const summary = await f.builder().run({ phase: 'verify', profile });
    assert.equal(summary.furnitureVerified, true);
    assert.deepEqual(traversals, ['inside->outside', 'outside->inside', 'inside->outside']);
    assert.equal(door().getProperties().open, false, 'The completed house retains its closed front door');
  });
}

test('a door that refuses to open cannot authorize traversal or furniture completion', async () => {
  const f = fixture();
  await f.builder().run();
  let crossed = false;
  f.deps.activateBlock = async () => {};
  f.deps.moveTo = async (position) => {
    if (key(position) === key(f.blueprint.entrance.outside)) crossed = true;
  };
  await assert.rejects(f.builder().run({ phase: 'verify' }), { code: 'house_furniture_unusable' });
  assert.equal(crossed, false, 'Failed native opening must stop before crossing the front wall');
  assert.notEqual(f.checkpoint().verificationSummary?.furnitureVerified, true);
});

test('raised corner platforms exist before tall vertical logs and survive resumed site clearing', async () => {
  const f = fixture();
  await f.builder().run({ phase: 'floor' });
  const originalPlace = f.deps.placeBlock;
  f.deps.placeBlock = async (spec) => {
    if (spec.phase === 'frame' && spec.position.y === f.blueprint.anchor.y + 3) {
      const platform = f.blueprint.scaffold.find((entry) => entry.stage === 'frame' &&
        entry.position.y === f.blueprint.anchor.y + 2 && entry.position.x === spec.position.x &&
        Math.abs(entry.position.z - spec.position.z) === 1);
      assert.equal(f.at(platform.position).name, 'dirt', 'High logs need a real raised stance before placement');
    }
    return originalPlace(spec);
  };
  await f.builder().run({ phase: 'frame' });
  assert.equal(f.checkpoint().ownedScaffold.length, 24);
  await f.builder().run({ phase: 'clear_site' });
  assert.ok(f.blueprint.scaffold.filter((entry) => entry.stage === 'frame')
    .every((entry) => f.at(entry.position).name === 'dirt'));
  await f.builder().run();
  assert.equal(f.checkpoint().ownedScaffold.length, 0);
  assert.ok(f.blueprint.scaffold.every((entry) => f.at(entry.position).name === 'air'));
});

test('owned scaffold dirt that becomes grass is preserved on resume and actually removed at cleanup', async () => {
  const f = fixture();
  await f.builder().run({ phase: 'floor' });
  await f.builder().run({ phase: 'frame' });
  const turf = f.blueprint.scaffold.find((entry) => entry.stage === 'frame' && entry.position.y === f.blueprint.anchor.y);
  f.cells.set(key(turf.position), f.block('grass_block'));
  await f.builder().run({ phase: 'clear_site' });
  assert.equal(f.at(turf.position).name, 'grass_block');
  await f.builder().run();
  assert.equal(f.at(turf.position).name, 'air');
  assert.ok(f.writes.some((entry) => entry.kind === 'break' && key(entry.position) === key(turf.position)));
  assert.equal(f.checkpoint().ownedScaffold.length, 0);
});

test('foreign replacement of an owned scaffold block is never silently forgotten or dug', async () => {
  const f = fixture();
  await f.builder().run({ phase: 'floor' });
  await f.builder().run({ phase: 'frame' });
  const spec = f.blueprint.scaffold.find((entry) => entry.stage === 'frame');
  const move = f.deps.moveTo;
  f.deps.moveTo = async (position) => {
    await move(position);
    if (key(position) === key(f.blueprint.entrance.outside)) f.cells.set(key(spec.position), f.block('chest'));
  };
  await assert.rejects(f.builder().run({ phase: 'roof' }), { code: 'house_scaffold_changed' });
  assert.equal(f.at(spec.position).name, 'chest');
  assert.ok(f.checkpoint().ownedScaffold.some((entry) => key(entry.position) === key(spec.position)));
  assert.equal(f.writes.some((entry) => entry.kind === 'break' && key(entry.position) === key(spec.position)), false);
});

test('partial scaffold cleanup resumes without rebuilding removed dirt or budgeting new scaffolding', async () => {
  const f = fixture();
  for (const phase of ['floor', 'frame', 'walls', 'windows']) await f.builder().run({ phase });
  const originalBreak = f.deps.breakBlock;
  let removed = 0;
  f.deps.breakBlock = async (position, options) => {
    assert.equal(options.maxFeetY, position.y, 'Cleanup must request a lower, supported work stance');
    if (removed === 3) throw Object.assign(new Error('interrupted cleanup'), { code: 'placement_no_safe_stance' });
    await originalBreak(position);
    removed += 1;
  };
  await assert.rejects(f.builder().run({ phase: 'roof' }), { code: 'placement_no_safe_stance' });
  assert.equal(f.checkpoint().ownedScaffold.length, f.blueprint.scaffold.length - 3);
  assert.equal(f.checkpoint().scaffoldCleanupStarted, true);
  assert.equal(f.inventory.dirt, 0, 'No drops are magically collected by this fixture');
  const placements = f.writes.filter((entry) => entry.kind === 'place').length;
  await f.builder().run({ phase: 'prepare_materials' });
  assert.equal(f.checkpoint().requirements.dirt, undefined);
  f.deps.breakBlock = originalBreak;
  await f.builder().run({ phase: 'roof' });
  assert.equal(f.writes.filter((entry) => entry.kind === 'place').length, placements);
  assert.equal(f.checkpoint().ownedScaffold.length, 0);
  await f.builder().run();
  assert.equal(f.checkpoint().verificationSummary?.furnitureVerified, true);
});

test('a changed roof reintroduces real scaffold requirements despite a saved cleanup flag', async () => {
  const f = fixture();
  await f.builder().run();
  const roof = f.blueprint.blocks.find((spec) => spec.phase === 'roof');
  f.cells.set(key(roof.position), f.block('air'));
  assert.equal(f.checkpoint().scaffoldCleanupStarted, true);
  await assert.rejects(f.builder().run({ phase: 'prepare_materials' }), { code: 'house_materials_missing' });
  assert.equal(f.checkpoint().requirements.dirt, f.blueprint.scaffold.length);
  assert.ok(f.checkpoint().missingMaterials.some((entry) => entry.item === 'dirt'));
});

test('cancellation on entering scaffold cleanup issues no late dig or completion', async () => {
  const f = fixture();
  for (const phase of ['floor', 'frame', 'walls', 'windows']) await f.builder().run({ phase });
  const move = f.deps.moveTo;
  f.deps.moveTo = async (position) => { await move(position); f.cancel(); };
  await assert.rejects(f.builder().run({ phase: 'roof' }), { code: 'cancelled' });
  assert.equal(f.writes.filter((entry) => entry.kind === 'break').length, 0);
  assert.equal(f.checkpoint().ownedScaffold.length, f.blueprint.scaffold.length);
  assert.notEqual(f.checkpoint().phase, 'complete');
});

test('an existing door lower half still requests confirmation of its missing upper half without consuming another door', async () => {
  const f = fixture();
  await f.builder().run();
  const upper = f.blueprint.blocks.find((entry) => entry.item === 'oak_door' && entry.derived);
  f.cells.set(key(upper.position), f.block('air'));
  assert.equal(f.inventory.oak_door, 0);
  const placesBefore = f.writes.filter((entry) => entry.kind === 'place').length;
  let confirmations = 0;
  f.deps.placeBlock = async (spec, confirmed) => {
    assert.equal(spec.item, 'oak_door');
    assert.deepEqual(spec.derivedBlocks, [upper]);
    assert.equal(f.at(spec.position).name, 'oak_door');
    confirmations += 1;
    await Promise.resolve();
    f.cells.set(key(upper.position), f.block(upper.item, upper.properties));
    confirmed();
  };
  await f.builder().run({ phase: 'finish' });
  assert.equal(confirmations, 1);
  assert.equal(f.inventory.oak_door, 0);
  assert.equal(f.writes.filter((entry) => entry.kind === 'place').length, placesBefore);
  await f.builder().run({ phase: 'verify' });
  assert.equal(f.checkpoint().verificationSummary?.furnitureVerified, true);
});

test('placing a primary door without its server-confirmed upper half cannot complete the finish phase', async () => {
  const f = fixture();
  const originalPlace = f.deps.placeBlock;
  f.deps.placeBlock = async (spec) => {
    await originalPlace(spec);
    if (spec.item === 'oak_door') {
      assert.equal(spec.derivedBlocks.length, 1);
      f.cells.set(key(spec.derivedBlocks[0].position), f.block('air'));
    }
  };
  await assert.rejects(f.builder().run(), { code: 'house_state_mismatch' });
  assert.notEqual(f.checkpoint().phase, 'complete');
  assert.notEqual(f.checkpoint().verificationSummary?.furnitureVerified, true);
});

test('library requires fifteen unobstructed bookshelf transmitters and an actual enchantment window', async () => {
  const f = fixture('enchanting_library');
  let opened = 0;
  f.deps.openEnchantmentTable = async () => { opened += 1; return { close() {} }; };
  const summary = await f.builder().run({ profile: 'enchanting_library' });
  assert.equal(opened, 1);
  assert.equal(summary.furnitureChecks.bookshelves.effectiveCount, 15);
  const gap = f.blueprint.clearance.find((entry) => entry.purpose === 'enchantment_transmitter_air');
  f.cells.set(key(gap.position), f.block('torch'));
  await assert.rejects(f.builder().run({ phase: 'verify', profile: 'enchanting_library' }), { code: 'house_verification_failed' });
  assert.equal(f.checkpoint().verificationSummary.furnitureVerified, undefined);
});

test('same-name stairs with the wrong facing never pass final state verification', async () => {
  const f = fixture();
  await f.builder().run();
  const stair = f.blueprint.blocks.find((spec) => spec.item === 'oak_stairs' && spec.phase === 'roof');
  f.cells.set(key(stair.position), f.block('oak_stairs', { ...stair.properties, facing: stair.properties.facing === 'east' ? 'west' : 'east' }));
  await assert.rejects(f.builder().run({ phase: 'verify' }), { code: 'house_materials_missing' });
  assert.notEqual(f.checkpoint().verificationSummary?.furnitureVerified,true);
  f.inventory.oak_stairs=1;
  const result=await f.builder().run({phase:'verify'});
  assert.equal(result.stateMismatches.length,0);
  assert.ok(matchesFurnishedHouseBlock(f.at(stair.position),stair));
});

test('ramp hazards outside the final house bounds are rejected before any site digging', async () => {
  const f = fixture();
  const position = f.blueprint.scaffold[0].position;
  assert.ok(position.z > f.blueprint.bounds.maxZ);
  f.cells.set(key(position), f.block('magma_block'));
  await assert.rejects(f.builder().run({ phase: 'clear_site' }), { code: 'house_unsafe_site' });
  assert.equal(f.writes.length, 0);
});

test('pre-existing scaffold-shaped dirt is not claimed or removed', async () => {
  const f = fixture();
  const position = f.blueprint.scaffold[0].position;
  f.cells.set(key(position), f.block('dirt'));
  await f.builder().run();
  assert.equal(f.at(position).name, 'dirt');
  assert.equal(f.writes.some((entry) => entry.kind === 'break' && key(entry.position) === key(position)), false);
});

test('pause or cancellation during movement prevents a late furniture window and success checkpoint', async () => {
  const f = fixture();
  await f.builder().run();
  let opens = 0;
  f.deps.moveTo = async () => { f.cancel(); };
  f.deps.openCraftingTable = async () => { opens += 1; return { close() {} }; };
  await assert.rejects(f.builder().run({ phase: 'verify' }), { code: 'cancelled' });
  assert.equal(opens, 0);
  assert.notEqual(f.checkpoint().verificationSummary?.furnitureVerified, true);
});

test('a missing scarce finished furnishing stops preparation before construction', async () => {
  const f = fixture('enchanting_library');
  delete f.inventory.enchanting_table;
  await assert.rejects(f.builder().run({ phase: 'prepare_materials', profile: 'enchanting_library' }), { code: 'house_materials_missing' });
  assert.equal(f.prepared(), 1);
  assert.equal(f.writes.length, 0);
  assert.ok(f.checkpoint().missingMaterials.some((entry) => entry.item === 'enchanting_table'));
});

for (const location of ['cell', 'support']) {
  test(`scaffold ${location} rejects a player chest before site changes`, async () => {
    const f = fixture();
    const position = { ...f.blueprint.scaffold[0].position };
    if (location === 'support') position.y -= 1;
    f.cells.set(key(position), f.block('chest'));
    await assert.rejects(f.builder().run({ phase: 'clear_site' }), { code: 'house_unsafe_site' });
    assert.equal(f.writes.length, 0);
  });
}

for (const phase of ['floor', 'roof']) {
  test(`confirmed ${phase} ownership survives cancellation before the awaited placement returns`, async () => {
    const f = fixture();
    const place = f.deps.placeBlock;
    f.deps.placeBlock = async (spec, confirmed) => {
      await place(spec);
      confirmed();
      f.cancel();
    };
    await assert.rejects(f.builder().run({ phase }), { code: 'cancelled' });
    const checkpoint = f.checkpoint();
    if (phase === 'floor') assert.deepEqual(checkpoint.ownedBlockIds, [f.writes[0].spec.id]);
    else assert.equal(checkpoint.ownedScaffold.length, 1);
    assert.equal(checkpoint.verificationSummary, null);
    assert.equal(f.writes.length, 1);
  });
}

test('scaffold construction rechecks foreign structures introduced after site preflight', async () => {
  const f = fixture();
  await f.builder().run({ phase: 'clear_site' });
  f.cells.set(key(f.blueprint.scaffold[0].position), f.block('chest'));
  await assert.rejects(f.builder().run({ phase: 'roof' }), { code: 'house_unsafe_site' });
  assert.equal(f.writes.length, 0);
});

test('final acceptance repairs a raised exterior edge with actual soil and reconnect does not place it twice',async()=>{
 const f=fixture();
 for(const phase of ['clear_site','floor','frame','walls','windows','roof','furniture','finish'])await f.builder().run({phase});
 for(let z=-1;z<=9;z++)for(const y of [0,1])f.cells.set(key({x:-2,y,z}),f.block('grass_block'));
 f.inventory.dirt=64;
 const place=f.deps.placeBlock;let outsidePlacements=0;
 f.deps.placeBlock=async spec=>{if(spec.item==='dirt'){assert.equal(f.at(f.blueprint.furniture.door.lower).getProperties().open,true);outsidePlacements++;}return place(spec);};
 const result=await f.builder().run({phase:'verify'});
 assert.ok(outsidePlacements>0);assert.equal(f.at(f.blueprint.furniture.door.lower).getProperties().open,false);
 assert.equal(result.exteriorGrade.confirmed,true);assert.ok(result.exteriorGrade.soilBlocks>0);
 const placed=f.writes.length;
 await f.builder().run({phase:'verify'});assert.equal(f.writes.length,placed);
});
test('exterior repair retains its plan on missing soil and refuses a changed foreign target',async()=>{
 const f=fixture();
 for(const phase of ['clear_site','floor','frame','walls','windows','roof','furniture','finish'])await f.builder().run({phase});
 f.cells.set('-2,0,2',f.block('grass_block'));f.inventory.dirt=0;
 await assert.rejects(f.builder().run({phase:'verify'}),{code:'house_materials_missing'});
 const spec=f.checkpoint().exteriorGradePlan[0];assert.ok(spec);
 f.cells.set(key(spec.position),f.block('chest'));f.inventory.dirt=64;
 await assert.rejects(f.builder().run({phase:'verify'}),{code:'house_exterior_changed'});
 assert.equal(f.at(spec.position).name,'chest');
});

test('previously placed floor holes need real repair materials and reconnect cannot duplicate repairs',async()=>{
 const f=fixture();await f.builder().run();
 const broken=['cobblestone','oak_planks'].map(item=>f.blueprint.blocks.find(s=>s.phase==='floor'&&s.item===item));
 for(const s of broken)f.cells.set(key(s.position),f.block('air'));
 await assert.rejects(f.builder().run({phase:'verify'}),{code:'house_materials_missing'});
 for(const s of broken)f.inventory[s.item]=1;
 const before=f.writes.length;await f.builder().run({phase:'verify'});
 assert.equal(f.writes.length,before+2);assert.ok(broken.every(s=>matchesFurnishedHouseBlock(f.at(s.position),s)));
 const done=f.writes.length;await f.builder().run({phase:'verify'});assert.equal(f.writes.length,done);
});
test('a foreign chest replacing a formerly owned floor is preserved by repair',async()=>{
 const f=fixture();await f.builder().run();const s=f.blueprint.blocks.find(s=>s.phase==='floor');
 f.cells.set(key(s.position),f.block('chest'));const before=f.writes.length;
 await assert.rejects(f.builder().run({phase:'verify'}),{code:'house_structure_repair_blocked'});
 assert.equal(f.at(s.position).name,'chest');assert.equal(f.writes.length,before);
});

test('previously observed structural damage remains in the preparation budget when its chunk unloads',async()=>{
 const f=fixture();await f.builder().run();const s=f.blueprint.blocks.find(s=>s.phase==='floor'&&s.item==='cobblestone');
 f.cells.set(key(s.position),f.block('air'));
 await assert.rejects(f.builder().run({phase:'furniture'}),{code:'house_materials_missing'});
 assert.ok(f.checkpoint().observedStructureDamageIds.includes(s.id));
 f.deps.getBot=()=>({blockAt:()=>null});let requested;
 f.deps.prepareMaterials=async req=>{requested=req;};
 await assert.rejects(f.builder().run({phase:'furniture'}),{code:'house_materials_missing'});
 assert.equal(requested.cobblestone,1);assert.ok(f.checkpoint().observedStructureDamageIds.includes(s.id));
 assert.notEqual(f.checkpoint().verificationSummary?.furnitureVerified,true);
});

test('retrying furniture cannot accumulate the same exterior soil budget',async()=>{
 const f=fixture();
 for(const phase of ['clear_site','floor','frame','walls','windows','roof'])await f.builder().run({phase});
 f.cells.set('-2,0,2',f.block('grass_block'));f.inventory.dirt=0;
 const bed=f.blueprint.blocks.find(s=>s.item==='white_bed'&&!s.derived);f.inventory.white_bed=0;
 await assert.rejects(f.builder().run({phase:'furniture'}),{code:'house_materials_missing'});
 const count=f.checkpoint().exteriorGradePlan.length;assert.ok(count>0);
 f.checkpoint().requirements.dirt=count*11;
 for(let i=0;i<3;i++){
  await assert.rejects(f.builder().run({phase:'furniture'}),{code:'house_materials_missing'});
  assert.equal(f.checkpoint().requirements.dirt,count);
 }
 assert.ok(bed);
});

test('final survival equipment preparation cannot be omitted by completing the shelter first',async()=>{
 const f=fixture();let called=0;f.deps.prepareFinalEquipment=async()=>{called++;throw Object.assign(Error('kit missing'),{code:'house_defense_equipment_missing'});};
 await assert.rejects(f.builder().run(),{code:'house_defense_equipment_missing'});assert.equal(called,1);
 assert.equal(f.checkpoint().phase,'verify');assert.equal(f.checkpoint().verificationSummary,null);
});

test('natural grass spread on confirmed exterior soil does not create fake missing materials or duplicate repairs',async()=>{
 const f=fixture();for(const phase of ['clear_site','floor','frame','walls','windows','roof','furniture','finish'])await f.builder().run({phase});
 for(let z=-1;z<=9;z++)for(const y of [0,1])f.cells.set(key({x:-2,y,z}),f.block('grass_block'));
 f.inventory.dirt=64;await f.builder().run({phase:'verify'});
 const plan=f.checkpoint().exteriorGradePlan;assert.ok(plan.length);
 for(const spec of plan)f.cells.set(key(spec.position),f.block('grass_block'));
 f.inventory.dirt=0;const before=f.writes.length,prepared=f.prepared();
 const result=await f.builder().run({phase:'verify'});assert.equal(result.exteriorGrade.confirmed,true);
 assert.equal(f.writes.length,before);assert.equal(f.prepared(),prepared);
});

test('resumed verification reaches the house before treating unloaded cells as damaged exterior',async()=>{
 const f=fixture();for(const phase of ['clear_site','floor','frame','walls','windows','roof','furniture','finish'])await f.builder().run({phase});
 let loaded=false,arrivals=0;f.deps.getBot=()=>({blockAt:p=>loaded?f.at(p):null});
 f.deps.moveTo=async p=>{if(key(p)===key(f.blueprint.entrance.outside)){loaded=true;arrivals++;}};
 const writes=f.writes.length;await f.builder().run({phase:'verify'});
 assert.ok(arrivals>=1);assert.equal(f.writes.length,writes);
 assert.equal(f.checkpoint().verificationSummary.missingBlocks,0);
});


test('roof resume resupplies only missing scaffold cells after carried dirt was spent',async()=>{
 const f=fixture();
 for(const phase of ['clear_site','floor','frame','walls','windows'])await f.builder().run({phase});
 const pending=f.blueprint.scaffold.filter(s=>f.at(s.position).boundingBox!=='block');
 assert.ok(pending.length>0);
 f.inventory.dirt=0;
 const requested=[];
 f.deps.prepareMaterials=async needed=>{
   requested.push({...needed});
   for(const [item,count] of Object.entries(needed))f.inventory[item]=Math.max(f.inventory[item]||0,count);
 };
 await f.builder().run({phase:'roof'});
 assert.equal(requested.length,1);
 assert.equal(requested[0].dirt,pending.length,'Existing native scaffold support must not be budgeted twice');
 assert.ok(f.blueprint.blocks.filter(s=>s.phase==='roof').every(s=>matchesFurnishedHouseBlock(f.at(s.position),s)));
 assert.equal(f.checkpoint().ownedScaffold.length,0,'Actually completed roof removes its own scaffold');
});

test('functional use belongs to the original final verify and an incomplete use cannot complete construction', async () => {
  const f = fixture(); await f.builder().run();
  f.deps.verifyActualFurnitureUse = async blueprint => { assert.equal(blueprint.anchor.x, f.blueprint.anchor.x); return { confirmed: false }; };
  await assert.rejects(f.builder().run({ phase: 'verify' }), { code: 'house_furniture_use_unconfirmed' });
  assert.notEqual(f.checkpoint().phase, 'complete');
  f.deps.verifyActualFurnitureUse = async () => ({ confirmed: true, originalTaskId: 'original' });
  const summary = await f.builder().run({ phase: 'verify' }); assert.equal(summary.actualFurnitureUse.confirmed, true);
  assert.equal(f.checkpoint().actualFurnitureUse.originalTaskId, 'original'); assert.equal(f.checkpoint().phase, 'complete');
});

test('unloaded saved foundation supplies only a material estimate; clearing still requires fresh loaded support',async()=>{
 const f=fixture(),p={x:0,y:-1,z:0},read=f.deps.getBot;
 f.deps.getBot=()=>({blockAt:q=>key(q)===key(p)?null:read().blockAt(q)});
 f.deps.planFoundation=()=>({valid:false,reason:'unsafe_floor_support',position:p});f.deps.getFoundationEstimate=()=>12;
 f.deps.prepareMaterials=async items=>{for(const [name,n]of Object.entries(items))f.inventory[name]=Math.max(f.inventory[name]||0,n);};
 await f.builder().run({phase:'prepare_materials'});assert.equal(f.checkpoint().foundationMaterialEstimate.observation,'UNLOADED');
 assert.equal(f.checkpoint().foundationMaterialEstimate.actualPrepared,false);assert.equal(f.writes.length,0);
 await assert.rejects(f.builder().run({phase:'clear_site'}),{code:'house_unsafe_site'});assert.equal(f.writes.length,0);
});
test('a known unsafe foundation cannot borrow the unloaded material estimate',async()=>{
 const f=fixture();f.deps.planFoundation=()=>({valid:false,reason:'unsafe_floor_support',position:{x:0,y:-1,z:0}});f.deps.getFoundationEstimate=()=>12;
 await assert.rejects(f.builder().run({phase:'prepare_materials'}),{code:'house_unsafe_site'});assert.equal(f.prepared(),0);assert.equal(f.writes.length,0);
});
