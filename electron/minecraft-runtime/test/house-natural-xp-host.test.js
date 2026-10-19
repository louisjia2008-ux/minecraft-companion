/* global require, setTimeout, __dirname */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const host = require('../vendor/server/minecraft/houseNaturalXPHost');
const { fixture, req, Item, Vec3 } = require('./fixtures/house-natural-xp-native');
const enchantFixture = require('./fixtures/house-natural-xp-enchant');
const poolFixture = require('./fixtures/house-natural-xp-pool');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const anchor = { x: 0, y: 64, z: 0 };
function bind(f, options = {}) {
  if (typeof f.bot.openFurnace !== 'function') req('mineflayer/lib/plugins/furnace')(f.bot);
  if (f.bot.entity.isInWater === undefined) f.bot.entity.isInWater = false;
  if (f.bot.entity.isInLava === undefined) f.bot.entity.isInLava = false;
  const saves = [], facts = [], ensures = [], foreign = {}, camp = options.anchor || anchor;
  const token = { throwIfRequested: f.deps.assertActive, cancelled: false, pauseRequested: false };
  const lease = {}, task = { taskId: 'original-natural-XP', executionGeneration: 1, cancellationToken: token, movementLease: lease,
    status: 'running', completionPlan: { intent: 'build_furnished_house', steps: [{ skill: 'build_furnished_house_phase', args: { profile: 'enchanting_library', materialSource: 'self_gathered' } }] },
    materialSupply: { camp: { anchor: camp, plankName: 'oak_planks', stations: {} }, surfaceGraphs: {} } };
  Object.assign(f.owner, { task, token, movementLease: lease, runGeneration: 1 });
  let cp = options.cp || null;
  const source = { getCamp: () => camp, resourceBounds: () => [{ minX: camp.x - 1, maxX: camp.x + 1, minY: camp.y - 1, maxY: camp.y + 3, minZ: camp.z - 1, maxZ: camp.z + 1 }],
    withContext: action => { f.owner.houseSelfSupply = source; return f.contexts.run(f.owner, action); }, stash: async () => {},
    // Source procurement/crafting below is explicitly MODELED raw ACKs. The
    // native placement/open/slot packet code is installed and unmodified.
    ensure: async needs => {
      ensures.push(needs);
      if (needs.cobblestone) f.updateSlot?.(9, needs.cobblestone, 'cobblestone');
      if (needs.furnace) { f.updateSlot?.(9, 0, 'cobblestone'); f.updateSlot?.(36, needs.furnace, 'furnace'); }
    } };
  const deps = { source, getBot: () => f.bot, getCurrentTask: () => f.state.foreign ? foreign : task,
    getExecutionContext: () => f.contexts.getStore(), isMovementLeaseActive: l => l === lease && !f.state.foreign,
    assertActive: f.deps.assertActive, getCP: () => cp, saveCP: value => { f.deps.assertActive(); cp = JSON.parse(JSON.stringify(value)); saves.push({ value: cp, cancelled: !!f.state.cancelled }); },
    recordConfirmedFact: value => facts.push(value), placeNative: f.nativePlace || (() => { throw new Error('unused fixture place'); }),
    reachDry: async () => {}, returnCamp: async () => {}, ensureFood: async () => {}, onOperationAbort: () => {},
    ownedEnchantmentTable: f.deps.ownedEnchantmentTable };
  const run = action => f.contexts.run(f.owner, action);
  const api = (extra, limits) => run(() => host.createNaturalHouseXPHost({ ...deps, ...extra }, { actionMs: 1000, readbackMs: 150, fieldColumns: 1, totalMs: 10000, ...limits }));
  return { task, token, lease, source, deps, saves, facts, ensures, api, run, getCP: () => cp };
}
function furnaceFixture(t, options = {}) {
  const f = fixture(t, { item: 'furnace', count: 0, spare: 0, ...options });
  req('mineflayer/lib/plugins/furnace')(f.bot); req('mineflayer/lib/plugins/experience')(f.bot);
  f.client.emit('experience', { level: 0, totalExperience: 0, experienceBar: 0 });
  let nextWindow = 10;
  const previous = f.client.write;
  f.client.write = function (name, packet, ...rest) {
    const result = previous.call(this, name, packet, ...rest);
    if (name === 'block_place' && f.bot.blockAt(new Vec3(packet.location.x, packet.location.y, packet.location.z)).name === 'furnace') {
      const id = nextWindow++;
      setTimeout(() => {
        f.client.emit('open_window', { windowId: id, inventoryType: 'minecraft:furnace', windowTitle: 'XP Native Fixture', slotCount: 3 });
        const items = [null, options.foreignContents ? new Item(f.bot.registry.itemsByName.coal.id, 1) : null, null,
          ...f.bot.inventory.slots.slice(9, 45)];
        f.client.emit('window_items', { windowId: id, stateId: 1, items: items.map(Item.toNotch), carriedItem: Item.toNotch(null) });
      }, 5);
    }
    return result;
  };
  return { ...f, ...bind(f), originalFixture: f };
}
test('relative native XP host exposes only guarded runtime APIs without private loaders', () => {
  assert.deepEqual(Object.keys(host).sort(), ['createNaturalHouseXPHost', 'getNaturalXPProtectedPositions', 'isOwnedNaturalHouseXPCancel'].sort());
  const fs = require('node:fs'), path = require('node:path');
  for (const name of ['houseNaturalXPHost', 'houseNaturalXPLevelProgressPool', 'houseNaturalXPStagePolicy', 'houseRenewableCactusProvider', 'houseNaturalEnchant']) {
    const source = fs.readFileSync(path.join(__dirname, '../vendor/server/minecraft', name + '.js'), 'utf8');
    assert.doesNotMatch(source, /Module\._compile|createRequire|\/private\/tmp|\/Volumes\//);
  }
});
test('eight dedicated native placements consume source-slot ACKs and must each open a fresh empty furnace', { timeout: 8000 }, async t => {
  const f = furnaceFixture(t), api = f.api(); const result = await f.run(() => api.ensureOwnedFurnaces());
  assert.equal(result.length, 8); assert.ok(result.every(s => s.purpose === 'xp' && s.confirmedOwned));
  assert.equal(f.facts.filter(x => x.kind === 'owned_xp_furnace_placement').length, 8);
  assert.equal(f.getCP().stations.every(s => s.emptyAuthorized && s.debitConfirmed), true);
  assert.equal(f.ensures[0].cobblestone, 64); assert.equal(f.ensures[1].furnace, 8);
  assert.equal(f.bot.inventory.items().some(i => i.name === 'furnace'), false);
  assert.equal(f.writes.filter(w => w.name === 'block_place').length, 16);
  assert.equal(f.writes.filter(w => w.name === 'close_window').length, 8);
  const before = f.writes.length; await f.run(() => api.ensureOwnedFurnaces()); assert.equal(f.writes.length, before, 'Restored exact-owned stations do not replace or consume material again');
});
test('delayed last-stack slot ACK cannot select a subsequent native furnace prematurely', { timeout: 8000 }, async t => {
  const f = furnaceFixture(t, { ackDelay: 100 }), api = f.api(); await f.run(() => api.ensureOwnedFurnaces());
  const places = f.writes.filter(w => w.name === 'block_place' && w.data.location.y === 63);
  assert.equal(places.length, 8);
  for (let i = 1; i < places.length; i++) assert.ok(places[i].at - places[i - 1].at >= 95);
});
test('missing native debit keeps an ownership fact but no authorized station or second placement', { timeout: 3000 }, async t => {
  const f = furnaceFixture(t, { noAck: true }), api = f.api();
  await assert.rejects(f.run(() => api.ensureOwnedFurnaces()), error => error.code === 'estate_placement_debit_unconfirmed');
  assert.equal(f.facts.length, 1); assert.equal(f.getCP().stations.some(s => s.confirmedOwned), false);
  assert.equal(f.writes.filter(w => w.name === 'block_place').length, 1);
});
test('a new furnace containing foreign fuel is preserved and never authorized as an XP station', { timeout: 3000 }, async t => {
  const f = furnaceFixture(t, { foreignContents: true });
  await assert.rejects(f.run(() => f.api().ensureOwnedFurnaces()), error => error.code === 'house_xp_foreign_furnace_contents');
  assert.equal(f.getCP().stations.filter(s => s.emptyAuthorized).length, 0); assert.equal(f.bot.currentWindow.slots[1].name, 'coal');
  assert.equal(f.writes.filter(w => w.name === 'window_click').length, 0);
});
test('pause immediately after actual placement records only ownership fact and sends no later furnace interaction', { timeout: 3000 }, async t => {
  const f = furnaceFixture(t, { cancelAfterWorld: true }), api = f.api();
  await assert.rejects(f.run(() => api.ensureOwnedFurnaces()), error => error.code === 'cancelled');
  const count = f.writes.length; await sleep(160); assert.equal(f.writes.length, count); assert.equal(f.facts.length, 1);
  assert.equal(f.saves.some(s => s.cancelled), false); assert.equal(f.writes.filter(w => w.name === 'block_place').length, 1);
});
test('same-task cancellation-token replacement revokes XP host before every new native action', t => {
  const f = furnaceFixture(t), api = f.api(); f.task.cancellationToken = { throwIfRequested() {} };
  assert.throws(() => api.assertActive(), error => error.code === 'house_xp_owner_changed'); assert.equal(f.writes.length, 0);
});
test('wrong original material contract cannot start pool or issue native packets', async t => {
  const f = furnaceFixture(t), api = f.api(); f.task.completionPlan.steps[0].args.materialSource = 'external_depots';
  await assert.rejects(f.run(() => api.finish()), error => error.code === 'house_xp_original_contract'); assert.equal(f.writes.length, 0);
});
test('renewable host without an actual natural upper seed adapter returns pending rather than supply success', async t => {
  const f = furnaceFixture(t), api = f.api();
  await assert.rejects(f.run(() => api.prepareRenewable()), error => error.code === 'house_xp_natural_seed_adapter_pending');
  assert.equal(f.writes.filter(w => w.name === 'block_place').length, 0);
});
test('actual installed seed dig removes natural flower then top only, requiring raw AIR and drop ACK while keeping bottom', { timeout: 8000 }, async t => {
  const f = furnaceFixture(t), api = f.api({
    digNative: block => f.bot.dig(block, true), collectDrops: async () => { await sleep(35); }, nextExploration: async () => ({ moved: false, exhausted: true }),
  });
  f.source.resourceBounds = () => [{ minX: 0, maxX: 0, minY: 63, maxY: 67, minZ: 0, maxZ: 0 }];
  f.put({ x: 0, y: 64, z: 1 }, 'cactus'); f.put({ x: 0, y: 65, z: 1 }, 'cactus'); f.put({ x: 0, y: 66, z: 1 }, 'cactus_flower');
  f.bot.findBlocks = options => [new Vec3(0, 64, 1), new Vec3(0, 65, 1)].filter(p => options.useExtraInfo(f.bot.blockAt(p)));
  const result = await f.run(() => api.acquireNaturalSeeds(1));
  assert.equal(result.actualAdditional, 1); assert.equal(f.bot.blockAt(new Vec3(0, 64, 1)).name, 'cactus');
  assert.deepEqual(f.writes.filter(w => w.name === 'block_dig' && w.data.status === 2).map(w => w.data.location.y), [66, 65]);
  assert.equal(f.getCP().seedHarvests.length, 2); assert.equal(f.getCP().pending, null);
});
test('paused native seed dig admits only exact same-owner installed status1 through both source guards and never a late finish', { timeout: 8000 }, async t => {
  const f = furnaceFixture(t), scoped = req('./vendor/server/minecraft/houseNativeDigSession');
  const session = scoped.createHouseNativeDigSession({ getBot: () => f.bot, captureOwner: () => f.owner,
    assertOwner: f.deps.assertActive, isOwnerCurrent: () => !f.state.cancelled && !f.state.foreign,
    isOwnerContext: () => f.contexts.getStore() === f.owner, abortOwner: () => {},
    runPhysicalAction: (_kind, _name, operation) => operation(() => {}) });
  const api = f.api({ allowNativeCancel: scoped.isOwnedHouseNativeDigCancel,
    digNative: block => session.dig(block, { assertActive: f.deps.assertActive, beforeSend: f.deps.assertActive, timeoutMs: 3000, forceLook: false }),
    collectDrops: async () => { await sleep(35); }, nextExploration: async () => ({ moved: false, exhausted: true }),
  });
  f.source.resourceBounds = () => [{ minX: 0, maxX: 0, minY: 63, maxY: 67, minZ: 0, maxZ: 0 }];
  f.put({ x: 0, y: 64, z: 1 }, 'cactus'); f.put({ x: 0, y: 65, z: 1 }, 'cactus');
  f.bot.findBlocks = options => [new Vec3(0, 65, 1)].filter(p => options.useExtraInfo(f.bot.blockAt(p)));
  const running = f.run(() => api.acquireNaturalSeeds(1)); running.catch(() => {});
  while (!f.writes.some(w => w.name === 'block_dig' && w.data.status === 0)) await sleep(2);
  f.state.cancelled = true;
  await assert.rejects(running, error => error.code === 'cancelled'); await sleep(800);
  assert.equal(f.writes.filter(w => w.name === 'block_dig' && w.data.status === 1).length, 1);
  assert.equal(f.writes.filter(w => w.name === 'block_dig' && w.data.status === 2).length, 0);
  assert.equal(f.getCP().seedHarvests.length, 0); assert.equal(f.getCP().pending.kind, 'natural_seed_harvest');
});
test('seed harvest accepts actual packed1.21.8 multi_block_change ACK without a single-block packet', { timeout: 8000 }, async t => {
  const f = furnaceFixture(t, { noRawWorld: true }), old = f.client.write;
  f.client.write = function (name, packet, ...rest) {
    const result = old.call(this, name, packet, ...rest);
    if (name === 'block_dig' && packet.status === 2) setTimeout(() => {
      const p = packet.location, air = f.bot.registry.blocksByName.air.defaultState;
      f.client.emit('multi_block_change', { chunkCoordinates: { x: Math.floor(p.x / 16), y: Math.floor(p.y / 16), z: Math.floor(p.z / 16) },
        records: [(air << 12) | ((p.x & 15) << 8) | ((p.z & 15) << 4) | (p.y & 15)] });
    }, 30);
    return result;
  };
  f.source.resourceBounds = () => [{ minX: 0, maxX: 0, minY: 63, maxY: 67, minZ: 0, maxZ: 0 }];
  f.put({ x: 0, y: 64, z: 1 }, 'cactus'); f.put({ x: 0, y: 65, z: 1 }, 'cactus');
  f.bot.findBlocks = options => [new Vec3(0, 65, 1)].filter(p => options.useExtraInfo(f.bot.blockAt(p)));
  const api = f.api({ digNative: b => f.bot.dig(b, true), collectDrops: async () => { await sleep(35); }, nextExploration: async () => ({ exhausted: true }) });
  assert.equal((await f.run(() => api.acquireNaturalSeeds(1))).actualAdditional, 1);
});
test('host-bound installed option2 proves actual enchanted component, lapis debit, level debit and return', async t => {
  const f = enchantFixture.fixture(t), b = bind(f), api = b.api({ ownedEnchantmentTable: f.deps.ownedEnchantmentTable });
  const previousBlock = f.bot.blockAt;
  f.bot.blockAt = p => p.y < 64 ? Object.assign(req('prismarine-block')(f.bot.registry).fromStateId(f.bot.registry.blocksByName.stone.defaultState), { position: p.floored() }) : previousBlock(p);
  b.source.ensure = async () => {}; // Materials already present as modeled raw native fixture ACKs.
  const result = await enchantFixture.settle(t, b.run(() => api.enchant30()));
  assert.equal(result.confirmed, true); assert.equal(result.beforeLevel, 30); assert.equal(result.afterLevel, 27);
  assert.equal(result.beforePlayerLapis - result.afterPlayerLapis, 3); assert.ok(result.enchanted.length);
  assert.deepEqual(f.writes.filter(w => w.name === 'enchant_item').map(w => w.data), [{ windowId: 7, enchantment: 2 }]);
  assert.equal(b.getCP().enchant.phase, 'enchant30_confirmed');
});
test('an original native delayed-ready enchant cannot send after host token or owner changes', async t => {
  const f = enchantFixture.fixture(t), b = bind(f), api = b.api({ ownedEnchantmentTable: f.deps.ownedEnchantmentTable });
  b.source.ensure = async () => {}; f.bot.openEnchantmentTable = ((old) => async block => {
    const window = await old(block); const nativeEnchant = window.enchant;
    window.enchant = function (index) { f.client.emit('craft_progress_bar', { windowId: this.id, property: 0, value: -1 }); setTimeout(() => { f.state.cancelled = true; }, 20); setTimeout(f.offers, 80); return nativeEnchant.call(this, index); };
    return window;
  })(f.bot.openEnchantmentTable);
  await assert.rejects(enchantFixture.settle(t, b.run(() => api.enchant30())), error => error.code === 'paused');
  await enchantFixture.advance(t, 150); assert.equal(f.writes.filter(w => w.name === 'enchant_item').length, 0);
});
test('host pool level target is confirmed only by installed furnace output clicks and actual experience packets', async t => {
  const f = poolFixture.fixture(t, { initialPoints: 1387 }), camp = poolFixture.anchor;
  // This restored component fixture has actual modeled sand on a stable stone
  // base; its prior infinite sand column was not a complete support proof.
  const Block = req('prismarine-block')(f.bot.registry), previous = f.bot.blockAt;
  f.bot.blockAt = p => p.y < 63 ? Object.assign(Block.fromStateId(f.bot.registry.blocksByName.stone.defaultState), { position: p.floored() }) : previous(p);
  const stations = f.stations.map(s => {
    const supportPosition = new Vec3(s.position.x, s.position.y - 1, s.position.z);
    const foundation = [supportPosition, supportPosition.offset(0, -1, 0)].map(p => {
      const actual = f.bot.blockAt(p); return { position: { x: p.x, y: p.y, z: p.z }, name: actual.name, stateId: actual.stateId };
    });
    return { position: s.position, purpose: 'xp', confirmedOwned: true, debitConfirmed: true, emptyAuthorized: true, support: foundation[0], foundation };
  });
  // Explicit modeled restored ownership, no claimed construction/self supply.
  const b = bind(f, { anchor: camp, cp: { schema: 1, kind: 'natural_house_xp_host', taskId: 'original-natural-XP', anchor: camp, stations, seedHarvests: [], pool: null, renewable: null, enchant: null } });
  b.source.ensure = async () => {};
  const api = b.api({}, { totalMs: 100000, actionMs: 5000, readbackMs: 1000 });
  const actual = await f.settle(b.run(() => api.ensureLevels(30)), 100000);
  assert.equal(actual.actual.level, 30); assert.equal(actual.actual.points, 1395); assert.equal(actual.before.points, 1387);
  assert.equal(b.getCP().pool.batches.length, 1); assert.equal(b.getCP().pool.batches[0].inputs, 8);
  assert.equal(b.getCP().pool.batches[0].packets.length, 8); assert.ok(f.state.writes.some(w => w.name === 'window_click' && w.data.slot === 2));
});
test('a prior confirmed or uncertain native enchant never starts another XP spending cycle on resume', async t => {
  for (const enchant of [{ schema: 1, phase: 'enchant30_confirmed' }, { schema: 1, enchantPending: { index: 2 } }]) {
    const f = furnaceFixture(t), cp = { schema: 1, kind: 'natural_house_xp_host', taskId: 'original-natural-XP', anchor, stations: [], seedHarvests: [], enchant };
    const b = bind(f, { cp }), api = b.api();
    await assert.rejects(b.run(() => api.finish()), error => /reconciliation/.test(error.code));
    assert.equal(f.writes.length, 0); assert.equal(b.saves.length, 0);
  }
});
test('captured stage deadline rejects an original late-ready enchant while the task remains otherwise active', async t => {
  const policy=require('../vendor/server/minecraft/houseNaturalXPStagePolicy');
  const registry=req('./vendor/server/action/actionRegistry').createMinecraftActionRegistry();
  const f=enchantFixture.fixture(t),b=bind(f);
  b.task.plan=registry.buildHeuristicTaskPlan('build_furnished_house',{profile:'enchanting_library',materialSource:'self_gathered'});
  b.task.completionPlan=JSON.parse(JSON.stringify(b.task.plan));
  b.task.currentStepIndex=b.task.plan.steps.findIndex(s=>s.args.phase==='finish');
  const captured={task:b.task,bot:f.bot,client:f.client,token:b.token,lease:b.lease,generation:1};
  const frame={...captured,step:b.task.plan.steps[b.task.currentStepIndex],stepIndex:b.task.currentStepIndex,
    startedAt:Date.now(),hardTimeoutMs:policy.XP_STAGE_MS,deadline:Date.now()+policy.XP_STAGE_MS};
  const api=b.api({assertActive:()=>{f.deps.assertActive();policy.readNaturalXPStageBudget(frame,captured);}});
  b.source.ensure=async()=>{};
  f.bot.openEnchantmentTable=((old)=>async block=>{
    const window=await old(block),nativeEnchant=window.enchant;
    window.enchant=function(index){
      // Modeled elapsed construction time leaves20ms at this original call.
      frame.startedAt=Date.now()-policy.XP_STAGE_MS+20;frame.deadline=frame.startedAt+policy.XP_STAGE_MS;
      f.client.emit('craft_progress_bar',{windowId:this.id,property:0,value:-1});setTimeout(f.offers,80);
      return nativeEnchant.call(this,index);
    };return window;
  })(f.bot.openEnchantmentTable);
  await assert.rejects(enchantFixture.settle(t,b.run(()=>api.enchant30())),e=>e.code==='step_timeout');
  await enchantFixture.advance(t,150);
  assert.equal(f.state.cancelled,false);assert.equal(f.writes.filter(w=>w.name==='enchant_item').length,0);
  assert.notEqual(b.getCP()?.enchant?.phase,'enchant30_confirmed');
});
