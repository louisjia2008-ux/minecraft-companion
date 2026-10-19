/* global require, setTimeout */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'), { AsyncLocalStorage } = require('node:async_hooks');
const registry = require('prismarine-registry')('1.21.8'), Item = require('prismarine-item')(registry);
const Block = require('prismarine-block')(registry), windows = require('prismarine-windows')('1.21.8'), { Vec3 } = require('vec3');
const { createHouseXPFurnacePool, houseXPAtLevel } = require('../vendor/server/minecraft/houseXPFurnacePool');
const { createHouseNaturalXPProvider, isOwnedXPNativeCancel } = require('../vendor/server/minecraft/houseNaturalXPProvider');
const { withHouseNativeSourceGuard } = require('../vendor/server/minecraft/houseNativeSourceGuard');
const anchor = { x: 1, y: 64, z: 0 }, copy = value => JSON.parse(JSON.stringify(value));

// OFFLINE: installed inventory/furnace/experience plugins send native clicks to
// eight independent prismarine server windows. Their ACKs, cooking and XP are
// modeled protocol events, not Java/Vanilla performance or natural-XP evidence.
function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1791970000000 });
  const contexts = new AsyncLocalStorage(), owner = {}, foreign = {}, bot = new EventEmitter(), client = new EventEmitter();
  const state = { paused: false, foreign: false, cp: null, writes: [], saves: [], opens: [], playerXP: 0, current: null, clicks: 0, aborts: [], ensureCalls: [], gathered: [], preparations: [], firstOutputAt: null };
  const item = (name, count = 1) => count ? new Item(registry.itemsByName[name].id, count) : null;
  const clone = value => value ? Item.fromNotch(Item.toNotch(value)) : null;
  const player = Array(46).fill(null);
  const stations = [-2, 2].flatMap(z => [0, 1, 2, 3].map(x => ({ position: { x, y: 64, z }, items: [null, null, null], cooking: false, elapsed: 0, burned: 0 })));
  stations.forEach((station, n) => { station.id = n + 8; });
  const blockAt = raw => {
    const p = raw.floored(), station = stations.find(s => s.position.x === p.x && s.position.y === p.y && s.position.z === p.z);
    return Object.assign(Block.fromStateId(registry.blocksByName[station ? options.replaced ? 'stone' : 'furnace' : p.y < 64 ? 'sand' : 'air'].defaultState), { position: p });
  };
  Object.assign(bot, { registry, version: '1.21.8', username: 'EightXPUnit', _client: client, QUICK_BAR_START: 36,
    supportFeature: name => registry.supportFeature(name), health: 20, food: 20,
    game: { gameMode: 'survival', dimension: 'overworld', minY: -64, height: 384 },
    entity: { id: 1, position: new Vec3(1.5, 64, .5), velocity: new Vec3(0, 0, 0), onGround: true,
      isInWater: false, isInLava: false, eyeHeight: 1.62, height: 1.8, width: .6, effects: {} }, blockAt,
    lookAt: async () => {
      if (options.pauseLook) { await new Promise(resolve => setTimeout(resolve, 40)); state.paused = true; }
      if (options.slowLook) await new Promise(resolve => setTimeout(resolve, 500));
      if (options.holdLook) await new Promise(resolve => { state.releaseLook = resolve; });
    }, swingArm: () => {}, getEquipmentDestSlot: () => 5 });
  const stock = name => player.reduce((sum, value) => sum + (value?.name === name ? value.count : 0), 0);
  function commitStock(values) {
    player.fill(null); let slot = 9;
    for (const [name, amount] of Object.entries(values)) for (let left = amount; left > 0; left -= 64) player[slot++] = item(name, Math.min(64, left));
    if (slot > 45) throw new Error('server fixture inventory overflow');
    client.emit('window_items', { windowId: 0, stateId: state.clicks, items: player.map(Item.toNotch), carriedItem: Item.toNotch(null) });
  }
  const stocks = () => Object.fromEntries([...new Set(player.filter(Boolean).map(value => value.name))].map(name => [name, stock(name)]));
  function experience(points, levelOverride) {
    state.playerXP = points; let level = 0;
    while (level < 30 && points >= houseXPAtLevel(level + 1)) level++;
    const progress = level === 30 ? 0 : (points - houseXPAtLevel(level)) / (houseXPAtLevel(level + 1) - houseXPAtLevel(level));
    client.emit('experience', { level: levelOverride ?? level, totalExperience: points, experienceBar: progress });
  }
  function slot(station, index, value) {
    station.items[index] = clone(value); station.window?.updateSlot(index, clone(value));
    if (state.current === station && !options.noRawSlot) client.emit('set_slot', { windowId: station.id, stateId: state.clicks, slot: index, item: Item.toNotch(value) });
  }
  function cook(station) {
    if (station.cooking || !station.items[0] || !station.items[1] || options.noCooking) return;
    station.cooking = true; station.elapsed = 0; station.burned = 1;
    slot(station, 1, item('oak_planks', station.items[1].count - 1));
    const one = () => {
      if (!station.items[0]) { station.cooking = false; return; }
      station.elapsed += 10000;
      const used = Math.ceil(station.elapsed / 15000), newFuel = used - station.burned;
      if (newFuel) { slot(station, 1, item('oak_planks', (station.items[1]?.count || 0) - newFuel)); station.burned = used; }
      slot(station, 0, item('cactus', station.items[0].count - 1));
      slot(station, 2, item('green_dye', (station.items[2]?.count || 0) + 1));
      state.firstOutputAt ??= Date.now();
      if (station.items[0]) setTimeout(one, 10000); else station.cooking = false;
    };
    setTimeout(one, 10000);
  }
  function open(station) {
    if (state.current) throw new Error('server fixture observed concurrent native GUIs');
    const server = windows.createWindow(station.id, 'minecraft:furnace', 'Eight independent XP windows');
    station.window = server; state.current = station; state.opens.push({ position: station.position, at: Date.now() });
    for (let slot = 0; slot < 3; slot++) server.updateSlot(slot, clone(station.items[slot]));
    for (let slot = 9; slot < 45; slot++) server.updateSlot(slot - 6, clone(player[slot]));
    if (options.foreignFuel) slot(station, 1, item('coal'));
    client.emit('open_window', { windowId: station.id, inventoryType: 'minecraft:furnace', windowTitle: 'Eight independent XP windows' });
    client.emit('window_items', { windowId: station.id, stateId: state.clicks,
      items: (options.partialSnapshot ? server.slots.slice(0, -1) : server.slots).map(Item.toNotch), carriedItem: Item.toNotch(null) });
  }
  const originalWrite = function (name, data) {
    state.writes.push({ name, data: copy(data), at: Date.now(), context: contexts.getStore(), self: this });
    if (name === 'block_place') {
      const station = stations.find(s => s.position.x === data.location.x && s.position.y === data.location.y && s.position.z === data.location.z);
      if (station && !options.noOpenAck) setTimeout(() => open(station), 5);
    }
    if (name === 'window_click') {
      const station = stations.find(s => s.id === data.windowId); if (!station || state.current !== station) return;
      const server = station.window, output = data.slot === 2 && server.slots[2]?.name === 'green_dye', amount = server.slots[2]?.count || 0;
      if (options.rejectOutput && output) return;
      const changed = server.acceptClick({ slot: data.slot, mouseButton: data.mouseButton, mode: data.mode, item: server.slots[data.slot] });
      state.clicks++; for (let slot = 0; slot < 3; slot++) station.items[slot] = clone(server.slots[slot]);
      const ack = changed.map(slot => [slot, clone(server.slots[slot])]);
      if (data.slot === 0 && station.items[0]) station.inputAt ??= Date.now();
      setTimeout(() => {
        if (!options.noRawSlot) for (const [slot, value] of ack) client.emit('set_slot', { windowId: station.id, stateId: state.clicks, slot, item: Item.toNotch(value) });
        setTimeout(() => cook(station), 100);
        if (output && !options.noXP) experience(state.playerXP + amount);
      }, 5);
      if (options.pauseClick === state.clicks || options.pauseOutput && output) state.paused = true;
    }
    if (name === 'close_window') {
      const station = stations.find(s => s.id === data.windowId); if (station) {
        for (let slot = 9; slot < 45; slot++) player[slot] = clone(station.window.slots[slot - 6]);
        state.current = null;
        setTimeout(() => { for (let slot = 9; slot < 45; slot++) client.emit('set_slot', { windowId: 0, stateId: state.clicks, slot, item: Item.toNotch(player[slot]) }); }, 5);
        if (options.pauseClose) state.paused = true;
        if (options.foreignClose) state.foreign = true;
      }
    }
    return 'actual-native-writer-return';
  };
  client.write = originalWrite;
  require('mineflayer/lib/plugins/inventory')(bot, { hideErrors: true });
  require('mineflayer/lib/plugins/furnace')(bot); require('mineflayer/lib/plugins/experience')(bot);
  commitStock({ cactus: options.cactus ?? 16, oak_planks: options.planks ?? 16 }); experience(0);
  const active = () => { if (state.paused) throw Object.assign(new Error('paused'), { code: 'paused' }); if (state.foreign) throw Object.assign(new Error('foreign owner'), { code: 'movement_preempted' }); };
  const deps = { getBot: () => bot, assertActive: active, isOwnerContext: () => contexts.getStore() === owner,
    getCP: () => state.cp, saveCP: cp => { active(); state.cp = copy(cp); state.saves.push(copy(cp)); },
    ensureOwnedFurnaces: async (count, request) => { state.ensureCalls.push({ count, request }); },
    getOwnedFurnaces: async () => stations.map(s => ({ position: s.position, confirmedOwned: !options.unowned, purpose: options.foodStation ? 'food' : 'xp' })),
    reachDry: async () => {}, returnCamp: async () => { active(); },
    onOperationAbort: error => { state.aborts.push(error); },
    ensureFood: async () => {}, prepareCapacity: async () => { const values = stocks(); delete values.green_dye; commitStock(values); },
    gatherCactus: async amount => { state.gathered.push(amount); commitStock({ ...stocks(), cactus: stock('cactus') + amount }); },
    ensureMaterials: async (requirements, request) => { state.preparations.push({ requirements, request }); commitStock({ ...stocks(), ...requirements }); } };
  const api = limits => createHouseXPFurnacePool(deps, { inputsPerFurnace: 2, batchMs: 45000, nativeMs: 1000, readbackMs: 200, pollMs: 10, ...limits });
  const run = action => contexts.run(owner, () => withHouseNativeSourceGuard(bot, { assertActive: active, isOwnerContext: () => contexts.getStore() === owner, allowNativeCancel: isOwnedXPNativeCancel }, action));
  async function advance(ms, step = 10) {
    for (let n = 0; n < ms; n += step) { for (let k = 0; k < 15; k++) await Promise.resolve(); contexts.run(owner, () => t.mock.timers.tick(Math.min(step, ms - n))); }
    for (let k = 0; k < 15; k++) await Promise.resolve();
  }
  async function settle(promise, maximum = 70000, step = 10) {
    let done = false, value, error; promise.then(v => { done = true; value = v; }, e => { done = true; error = e; });
    for (let n = 0; !done && n < maximum; n += step) await advance(step, step);
    if (!done) throw new Error('installed XP fixture did not settle'); if (error) throw error; return value;
  }
  t.after(() => t.mock.timers.reset());
  return { bot, client, state, stations, player, contexts, owner, foreign, originalWrite, deps, api, run, advance, settle, commitStock, stocks, experience };
}

test('official planning cost is1395 but eight native furnaces credit only actual output ACK and experience packets', async t => {
  assert.equal(houseXPAtLevel(30), 1395);
  const f = fixture(t), result = await f.settle(f.run(() => f.api().earnBatch({ anchor })));
  assert.equal(result.confirmed, true); assert.equal(result.inputs, 16); assert.equal(result.after.points, 16);
  assert.equal(result.after.level, 2); assert.ok(result.packets.length >= 8);
  assert.equal(result.stations.filter(s => s.status === 'extracted').length, 8);
  assert.ok(f.stations.every(s => s.inputAt < f.state.firstOutputAt), 'all eight server furnaces are cooking before the first output');
  assert.ok(result.elapsedMs < 30000, 'eight20s streams overlap; GUI remains sequential');
  assert.ok(f.stations.every(s => s.items.every(item => !item))); assert.equal(f.bot.currentWindow, null);
  assert.equal(f.bot.inventory.items().find(item => item.name === 'green_dye').count, 16);
  assert.equal(f.state.cp.pending, null); assert.equal(f.client.write, f.originalWrite);
});

test('actual dye without an XP packet leaves a pending ledger and cannot replay or claim theoretical XP', async t => {
  const f = fixture(t, { noXP: true }); await assert.rejects(f.settle(f.run(() => f.api().earnBatch({ anchor }))), error => error.code === 'house_xp_no_progress');
  assert.equal(f.bot.experience.points, 0); assert.equal(f.state.cp.batches.length, 0); assert.ok(f.state.cp.pending);
  const count = f.state.writes.length;
  await assert.rejects(f.settle(f.run(() => f.api().earnBatch({ anchor }))), error => error.code === 'house_xp_reconciliation_required');
  assert.equal(f.state.writes.length, count);
});

test('unowned, sharedfood, replaced, duplicate or fewer than eight stations reject before native open', async t => {
  for (const mode of ['unowned', 'foodStation', 'replaced', 'duplicate', 'seven', 'shared']) {
    const f = fixture(t, { [mode]: true });
    if (mode === 'duplicate') f.deps.getOwnedFurnaces = async () => Array(8).fill({ position: f.stations[0].position, confirmedOwned: true, purpose: 'xp' });
    if (mode === 'seven') f.deps.getOwnedFurnaces = async () => f.stations.slice(0, 7).map(s => ({ position: s.position, confirmedOwned: true, purpose: 'xp' }));
    if (mode === 'shared') f.deps.getSharedStationPositions = () => [f.stations[0].position];
    await assert.rejects(f.settle(f.run(() => f.api().earnBatch({ anchor }))), error => ['house_xp_pool_ownership_unconfirmed', 'house_xp_foreign_furnace'].includes(error.code));
    assert.equal(f.state.writes.filter(w => ['block_place', 'window_click'].includes(w.name)).length, 0); t.mock.timers.reset();
  }
});

test('foreign fuel, incomplete raw snapshots, missing raw input ACK and optimistic output cannot be adopted', async t => {
  for (const mode of ['foreignFuel', 'partialSnapshot', 'noRawSlot', 'rejectOutput']) {
    const f = fixture(t, { [mode]: true });
    await assert.rejects(f.settle(f.run(() => f.api().earnBatch({ anchor }))), error => ['house_xp_furnace_not_empty', 'house_xp_furnace_snapshot_unconfirmed', 'house_xp_input_unconfirmed', 'house_xp_output_unconfirmed'].includes(error.code));
    assert.equal(f.state.cp.batches.length, 0); t.mock.timers.reset();
  }
});

test('pause after first furnace starts cooking forbids a second open and any late checkpoint write', async t => {
  const f = fixture(t, { pauseClose: true }); await assert.rejects(f.settle(f.run(() => f.api().earnBatch({ anchor }))), error => error.code === 'paused');
  const saved = f.state.saves.length; await f.advance(25000);
  assert.equal(f.state.opens.length, 1); assert.equal(f.state.saves.length, saved); assert.ok(f.state.cp.pending); assert.equal(f.state.cp.batches.length, 0);
});

test('pause during native open look preserves raw ready UNKNOWN until its actual20s rejection', async t => {
  const f = fixture(t, { pauseLook: true }), pool = f.api();
  await assert.rejects(f.settle(f.run(() => pool.earnBatch({ anchor }))), error => error.code === 'house_xp_native_cleanup_pending' && error.nativeSettlement === 'UNKNOWN' && error.cause.code === 'paused');
  const guard = f.client.write; assert.notEqual(guard, f.originalWrite);
  assert.equal(f.state.writes.filter(w => w.name === 'block_place').length, 0);
  await f.advance(22000); assert.notEqual(f.client.write, guard, 'only after native ready rejection may this session guard be removed');
  assert.equal(f.state.cp.batches.length, 0);
});

test('owner-active timeout blocks deferred native open and keeps foreign context and writer replacement untouched', async t => {
  const f = fixture(t, { slowLook: true }), pending = f.run(() => f.api({ nativeMs: 100 }).earnBatch({ anchor })); pending.catch(() => {});
  await f.advance(120); const previous = f.client.write, foreignWriter = function (...args) { return previous.apply(this, args); }; f.client.write = foreignWriter;
  f.contexts.run(f.foreign, () => f.client.write('window_click', { windowId: 99, slot: 0 }));
  await assert.rejects(f.settle(pending), error => error.code === 'house_xp_native_cleanup_pending' && error.nativeSettlement === 'UNKNOWN' && error.cause.code === 'house_xp_timeout');
  await f.advance(22000); assert.equal(f.client.write, foreignWriter);
  assert.equal(f.state.writes.filter(w => w.name === 'block_place').length, 0);
  assert.equal(f.state.writes.filter(w => w.context === f.foreign).length, 1);
});

test('still-unresolved native look stays guarded after UNKNOWN and never starts after release', async t => {
  const f = fixture(t, { holdLook: true }), pending = f.run(() => f.api({ nativeMs: 100 }).earnBatch({ anchor })); pending.catch(() => {});
  await f.advance(120); assert.equal(typeof f.state.releaseLook, 'function');
  await assert.rejects(f.settle(pending), error => error.code === 'house_xp_native_cleanup_pending');
  const retained = f.client.write; f.state.releaseLook(); await f.advance(21000);
  assert.notEqual(f.client.write, retained); assert.equal(f.state.writes.filter(w => w.name === 'block_place').length, 0);
});

test('cancellation during output extraction does not open another GUI or mark any uncertain batch complete', async t => {
  const f = fixture(t, { pauseOutput: true }); await assert.rejects(f.settle(f.run(() => f.api().earnBatch({ anchor }))), error => error.code === 'paused');
  const saved = f.state.saves.length, opened = f.state.opens.length; await f.advance(25000);
  assert.equal(f.state.saves.length, saved); assert.equal(f.state.opens.length, opened); assert.equal(f.state.cp.batches.length, 0);
  assert.ok(f.state.cp.pending.stations.some(s => s.status === 'output_requested'));
});

test('an expired cooking batch reports timeout or its genuinely pending raw ready chain, preserving all eight ledgers', async t => {
  const f = fixture(t, { noCooking: true }); await assert.rejects(f.settle(f.run(() => f.api({ batchMs: 1500 }).earnBatch({ anchor }))), error => error.code === 'house_xp_timeout'
    || error.code === 'house_xp_native_cleanup_pending' && error.nativeSettlement === 'UNKNOWN' && error.cause.code === 'house_xp_timeout');
  assert.equal(f.state.cp.pending.stations.length, 8); assert.equal(f.state.cp.batches.length, 0); assert.equal(f.bot.experience.points, 0);
  const written = f.state.writes.length; await f.advance(25000); assert.equal(f.state.writes.length, written);
});

test('actual health, food, wet body and output capacity gate native interaction', async t => {
  for (const mode of ['health', 'food', 'wet', 'capacity']) {
    const f = fixture(t); if (mode === 'health') f.bot.health = 15; if (mode === 'food') f.bot.food = 13; if (mode === 'wet') f.bot.entity.isInWater = true;
    if (mode === 'capacity') for (let slot = 11; slot < 45; slot++) f.client.emit('set_slot', { windowId: 0, stateId: 0, slot, item: Item.toNotch(new Item(registry.itemsByName.cobblestone.id, 64)) });
    await assert.rejects(f.settle(f.run(() => f.api().earnBatch({ anchor }))), error => ['house_xp_survival_limit', 'house_xp_furnace_unsafe_stance', 'house_xp_inventory_full'].includes(error.code));
    assert.equal(f.state.writes.filter(w => ['block_place', 'window_click'].includes(w.name)).length, 0); t.mock.timers.reset();
  }
});

test('from zero to30 requires1395 actual packet points across eight native furnace batches; procurement is modeled', async t => {
  const f = fixture(t, { cactus: 0, planks: 0 }), pool = f.api({ inputsPerFurnace: 32, batchMs: 600000 });
  const result = await f.settle(f.run(() => pool.ensureLevels(30, { anchor })), 4000000, 25);
  assert.equal(result.confirmed, true); assert.equal(result.before.points, 0); assert.equal(result.actual.points, 1395); assert.equal(result.actual.level, 30); assert.equal(result.rounds, 6);
  assert.equal(f.state.cp.batches.reduce((n, b) => n + b.inputs, 0), 1395);
  assert.equal(f.state.cp.batches.reduce((n, b) => n + b.packets.length, 0), 48);
  assert.ok(f.state.gathered.every(amount => amount >= 1 && amount <= 32)); assert.equal(f.state.gathered.reduce((n, amount) => n + amount, 0), 1395);
  assert.ok(f.state.ensureCalls.every(call => call.count === 8 && call.request.purpose === 'xp'));
  assert.ok(f.state.preparations.every(p => p.request.preserve.cactus > 0 && p.request.preserveFood && p.request.preserveTools));
  assert.equal(f.state.writes.some(w => w.name === 'use_item'), false, 'no bonemeal or fabricated growth');
  assert.equal(f.state.cp.pending, null); assert.equal(f.bot.currentWindow, null); assert.ok(f.bot.entity.position.floored().equals(new Vec3(anchor.x, anchor.y, anchor.z)));
});

test('labels from resource callbacks cannot replace actual cactus inventory, fuel coexistence or XP', async t => {
  for (const mode of ['cactus', 'fuel']) {
    const f = fixture(t, { cactus: 0, planks: 0 });
    if (mode === 'cactus') f.deps.gatherCactus = async () => ({ confirmed: true, actualAdditional: 32 });
    else f.deps.ensureMaterials = async () => ({ confirmed: true });
    await assert.rejects(f.settle(f.run(() => f.api().ensureLevels(1, { anchor }))), error => ['house_xp_cactus_pickup_unconfirmed', 'house_xp_materials_missing'].includes(error.code));
    assert.equal(f.state.cp?.batches?.length || 0, 0); assert.equal(f.bot.experience.points, 0); t.mock.timers.reset();
  }
});

test('a foreign owner after first cooking GUI prevents every subsequent old-owner interaction or checkpoint', async t => {
  const f = fixture(t, { foreignClose: true });
  await assert.rejects(f.settle(f.run(() => f.api().earnBatch({ anchor }))), error => error.code === 'movement_preempted');
  const writes = f.state.writes.length, saved = f.state.saves.length;
  await f.advance(25000);
  assert.equal(f.state.writes.length, writes); assert.equal(f.state.saves.length, saved); assert.equal(f.state.opens.length, 1);
  assert.equal(f.state.cp.batches.length, 0); assert.ok(f.state.cp.pending);
});

test('a level30 label with zero actual total experience cannot bypass actual acquisition', async t => {
  const f = fixture(t, { cactus: 0, planks: 0 }); f.experience(0, 30);
  f.deps.gatherCactus = async () => ({ confirmed: true, level: 30 });
  await assert.rejects(f.settle(f.run(() => f.api().ensureLevels(30, { anchor }))), error => error.code === 'house_xp_cactus_pickup_unconfirmed');
  assert.equal(f.state.cp?.levelEvidence, undefined); assert.equal(f.bot.experience.points, 0);
});

test('station provisioning consumes the original batch deadline and denies any deferred native placement after it', async t => {
  const f = fixture(t);
  f.deps.ensureOwnedFurnaces = async () => {
    await new Promise(resolve => setTimeout(resolve, 400));
    await f.bot.activateBlock(f.bot.blockAt(new Vec3(0, 64, -2)));
  };
  await assert.rejects(f.settle(f.run(() => f.api().earnBatch({ anchor, maxDurationMs: 100 }))), error => error.code === 'house_xp_timeout');
  await f.advance(25000);
  assert.equal(f.state.writes.filter(w => ['block_place', 'window_click'].includes(w.name)).length, 0);
  assert.equal(f.state.cp?.batches?.length || 0, 0);
});

test('the outer pool capability admits only the v2 exact native cactus cancel through every paused parent guard', async t => {
  const f = fixture(t, { cactus: 0, planks: 0 }), previous = f.bot.blockAt, cells = new Map();
  for (const y of [64, 65]) cells.set(`0,${y},0`, 'cactus');
  f.bot.blockAt = position => {
    const p = position.floored(), name = cells.get(`${p.x},${p.y},${p.z}`);
    return name ? Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position: p }) : previous(position);
  };
  f.bot.canSeeBlock = () => true;
  f.bot._updateBlockState = (position, id) => {
    const before = f.bot.blockAt(position); cells.set(`${position.x},${position.y},${position.z}`, Block.fromStateId(id).name);
    f.bot.emit(`blockUpdate:${position}`, before, f.bot.blockAt(position));
  };
  require('mineflayer/lib/plugins/digging')(f.bot);
  let providerCP;
  const provider = createHouseNaturalXPProvider({ getBot: () => f.bot, assertActive: f.deps.assertActive,
    isOwnerContext: f.deps.isOwnerContext, sourceGuardSupportsOwnedCancel: true, getCP: () => providerCP, saveCP: value => { f.deps.assertActive(); providerCP = value; },
    ensureFood: async () => {}, reachDry: async () => {}, findCactus: () => [new Vec3(0, 64, 0)], nativeDig: block => f.bot.dig(block),
    collectDrops: async () => {}, returnCamp: async () => {}, onOperationAbort: () => {},
  }, { nativeMs: 3000, gatherMs: 5000, pollMs: 10 });
  f.deps.gatherCactus = provider.gatherCactus;
  let earlyError;
  const pending = f.run(() => f.api().ensureLevels(1, { anchor })); pending.catch(error => { earlyError = error; });
  for (let n = 0; n < 200 && !f.state.writes.some(w => w.name === 'block_dig' && w.data.status === 0); n += 10) await f.advance(10);
  assert.ok(f.state.writes.some(w => w.name === 'block_dig' && w.data.status === 0), earlyError?.stack || 'native cactus dig must actually start');
  f.state.paused = true;
  f.contexts.run(f.owner, () => assert.throws(() => f.bot.stopDigging(), error => error.code === 'paused'));
  await assert.rejects(f.settle(pending), error => error.code === 'paused'); await f.advance(2000);
  assert.deepEqual(f.state.writes.filter(w => w.name === 'block_dig').map(w => w.data.status), [0, 1]);
  assert.equal(f.bot.targetDigBlock, null); assert.equal(f.state.cp.batches.length, 0); assert.equal(providerCP?.cactusHarvests?.length || 0, 0);
});
