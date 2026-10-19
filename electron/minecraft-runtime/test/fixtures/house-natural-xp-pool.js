/* global require, setTimeout */
'use strict';
const runtimeRequire = require('node:module').createRequire(require.resolve('../../package.json'));
const { EventEmitter } = require('node:events'), { AsyncLocalStorage } = require('node:async_hooks');
const registry = runtimeRequire('prismarine-registry')('1.21.8'), Item = runtimeRequire('prismarine-item')(registry);
const Block = runtimeRequire('prismarine-block')(registry), windows = runtimeRequire('prismarine-windows')('1.21.8'), { Vec3 } = runtimeRequire('vec3');
const { createHouseXPFurnacePool, houseXPAtLevel } = runtimeRequire('./vendor/server/minecraft/houseNaturalXPLevelProgressPool');
const { createHouseXPFurnacePool: originalCreatePool } = runtimeRequire('./vendor/server/minecraft/houseNaturalXPLevelProgressPool');
const { isOwnedXPNativeCancel } = runtimeRequire('./vendor/server/minecraft/houseNaturalXPProvider');
const { withHouseNativeSourceGuard } = runtimeRequire('./vendor/server/minecraft/houseNativeSourceGuard');
const anchor = { x: 1, y: 64, z: 0 }, copy = value => JSON.parse(JSON.stringify(value));

// OFFLINE: installed inventory/furnace/experience plugins send native clicks to
// eight independent prismarine server windows. Their ACKs, cooking and XP are
// modeled protocol events, not Java/Vanilla performance or natural-XP evidence.
function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1791970000000 });
  const contexts = new AsyncLocalStorage(), owner = {}, foreign = {}, bot = new EventEmitter(), client = new EventEmitter();
  const state = { paused: false, foreign: false, cp: null, writes: [], saves: [], opens: [], playerXP: 0, spentXP: options.spentXP || 0, current: null, clicks: 0, aborts: [], ensureCalls: [], gathered: [], preparations: [], firstOutputAt: null };
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
    state.playerXP = points; const balance = points - state.spentXP; let level = 0;
    while (level < 30 && balance >= houseXPAtLevel(level + 1)) level++;
    const progress = level === 30 ? 0 : (balance - houseXPAtLevel(level)) / (houseXPAtLevel(level + 1) - houseXPAtLevel(level));
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
  runtimeRequire('mineflayer/lib/plugins/inventory')(bot, { hideErrors: true });
  runtimeRequire('mineflayer/lib/plugins/furnace')(bot); runtimeRequire('mineflayer/lib/plugins/experience')(bot);
  commitStock({ cactus: options.cactus ?? 16, oak_planks: options.planks ?? 16 }); experience(options.initialPoints || 0);
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
  const api = limits => (options.originalPool ? originalCreatePool : createHouseXPFurnacePool)(deps, { inputsPerFurnace: 2, batchMs: 45000, nativeMs: 1000, readbackMs: 200, pollMs: 10, ...limits });
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


module.exports={fixture,anchor};
