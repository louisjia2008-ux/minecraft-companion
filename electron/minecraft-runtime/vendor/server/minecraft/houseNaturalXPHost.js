/* global require, module, setTimeout, clearTimeout, setInterval, clearInterval */
'use strict';
// Relative native XP host. All world actions retain captured source ownership.
// Natural XP and whole-building acceptance require independent actual evidence.
const native = require;
const { Vec3 } = require('vec3'), { Movements, goals } = require('mineflayer-pathfinder');
const { naturalWalkingFoot: dryFoot, getSurfaceGraphProtectedPositions } = require('./houseSurfaceGraph');
const { createEstatePlacement } = require('./estatePlacement');
const { withHouseNativeSourceGuard } = require('./houseNativeSourceGuard');
const { inspectRecordedNaturalXPFoundation } = require('./houseNaturalXPSupport');
const dependencies = Object.freeze({
  provider: require('./houseNaturalXPProvider'),
  pool: require('./houseNaturalXPLevelProgressPool'),
  renewable: require('./houseRenewableCactusProvider'),
  enchant: require('./houseNaturalEnchant'),
});
function loadFrozen(label) {
  if (!Object.prototype.hasOwnProperty.call(dependencies, label)) throw new TypeError('Unknown native XP dependency');
  return dependencies[label];
}
const AIR = new Set(['air', 'cave_air', 'void_air']);
const HAZARDS = new Set(['water', 'lava', 'bubble_column', 'magma_block', 'fire', 'soul_fire', 'campfire', 'soul_campfire', 'cactus', 'powder_snow']);
const frames = new WeakMap(), activeHosts = new WeakMap(), cancelScopes = new WeakMap();
const point = p => ({ x: p.x, y: p.y, z: p.z }), copy = v => JSON.parse(JSON.stringify(v));
const integer = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]));
const key = p => `${p.x},${p.y},${p.z}`, same = (a, b) => integer(a) && integer(b) && key(a) === key(b);
const fail = (code, message, facts = {}) => Object.assign(new Error(message), { code, ...facts });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function getNaturalXPProtectedPositions(value) {
  if (value?.schema !== 1 || value.kind !== 'natural_house_xp_host') return [];
  const positions = (value.stations || []).flatMap(s => [s.position, s.support?.position, ...(s.foundation || []).map(f => f.position)]);
  positions.push(...(value.renewable?.columns || []).flatMap(c => [c.position, c.support?.position, ...(c.foundation || []).map(f => f.position)]));
  return [...new Map(positions.filter(integer).map(p => [key(p), point(p)])).values()];
}
function isOwnedNaturalHouseXPCancel(bot, name, packet) {
  const host = activeHosts.get(bot?._client), session = cancelScopes.get(bot?._client);
  if (!host?.isPhysicalOwner() || name !== 'block_dig' || packet?.status !== 1) return false;
  if (session?.cancelling && session.bot === bot && session.client === bot._client && bot.targetDigBlock === session.block
    && bot.stopDigging === session.stop && same(packet.location, session.block.position)) return true;
  return host.allowBaseNativeCancel?.(bot, name, packet) === true || loadFrozen('renewable').isOwnedRenewableCactusCancel(bot, name, packet);
}
function createNaturalHouseXPHost(deps, limits = {}) {
  for (const name of ['getBot', 'getCurrentTask', 'getExecutionContext', 'isMovementLeaseActive', 'assertActive', 'getCP', 'saveCP',
    'recordConfirmedFact', 'placeNative', 'reachDry', 'returnCamp', 'ensureFood', 'onOperationAbort']) {
    if (typeof deps[name] !== 'function') throw new TypeError(`Natural XP host needs native adapter ${name}`);
  }
  const bot = deps.getBot(), client = bot?._client, task = deps.getCurrentTask(), context = deps.getExecutionContext();
  const source = deps.source, generation = task?.executionGeneration, token = context?.token, lease = context?.movementLease;
  if (!task || !token || !lease || context.task !== task || context.runGeneration !== generation || !source?.withContext || !source.ensure || !source.stash) {
    throw fail('house_xp_source_context_pending', 'XP finishing requires the original self-gathered source/ALS task/token/generation/lease');
  }
  const cfg = { actionMs: 30000, readbackMs: 5000, seedMs: 1200000, totalMs: 14400000, fieldColumns: 128, ...limits };
  if (Object.values(cfg).some(n => !Number.isSafeInteger(n) || n < 1) || cfg.totalMs > 14400000 || cfg.fieldColumns > 128) throw new TypeError('Finite XP host limits required');
  const { dryBody } = loadFrozen('provider'), { createHouseXPFurnacePool } = loadFrozen('pool');
  const { createRenewableCactusProvider, findMatureNaturalColumns, column } = loadFrozen('renewable');
  const { createHouseNaturalEnchant } = loadFrozen('enchant');
  const Item = native('prismarine-item')(bot.registry), Block = native('prismarine-block')(bot.registry);
  let state, terminal = null, anchor, running = false, mainReturned = false;
  const stationWindows = new WeakMap(), stationWindowIds = new Map(); let pendingStationOpen = null;
  const pendingNative = new Set();
  const physical = () => deps.getBot() === bot && bot._client === client && deps.getCurrentTask() === task
    && task.executionGeneration === generation && task.cancellationToken === token && task.movementLease === lease && deps.isMovementLeaseActive(lease) === true;
  const active = () => {
    if (terminal) throw terminal;
    token.throwIfRequested?.(); deps.assertActive();
    if (!physical()) throw fail('house_xp_owner_changed', 'Captured XP bot/client/task/generation/token/lease changed');
  };
  const ownContext = () => {
    const value = deps.getExecutionContext();
    return value?.task === task && value.token === token && value.runGeneration === generation && value.movementLease === lease && value.houseSelfSupply === source;
  };
  const at = p => bot.blockAt(new Vec3(p.x, p.y, p.z));
  const count = name => bot.inventory.items().reduce((n, item) => n + (item.name === name ? item.count : 0), 0);
  const safety = () => { active(); if (bot.health < 16 || bot.food < 14 || !Number.isFinite(bot.health) || !Number.isFinite(bot.food)) throw fail('house_xp_survival_limit', 'Actual health16/food14 required'); };
  const save = patch => { active(); state = { ...state, ...copy(patch) }; deps.saveCP(copy(state)); };
  const foundation = entry => {
    const proof = inspectRecordedNaturalXPFoundation({ ...entry, blockAt: at, assertActive: active });
    if (!proof.safe) throw fail('house_xp_foundation_pending', 'Recorded XP support needs fresh loaded full stable foundation', { foundationReason: proof.reason, position: proof.position });
  };
  const stationFoundations = () => { for (const entry of state?.stations || []) foundation(entry); };
  const stationPacket = (name, packet) => {
    if (['window_click', 'use_item', 'use_entity'].includes(name)) {
      const window = bot.currentWindow, entry = window && stationWindows.get(window);
      if (entry) {
        if (!same(window.xpPosition, entry.position) || name === 'window_click' && packet?.windowId !== window.id) throw fail('house_xp_window_pending', 'Captured XP station window changed');
        foundation(entry);
      } else if (window?.xpPosition && state?.stations?.some(s => same(s.position, window.xpPosition))) throw fail('house_xp_window_pending', 'No captured native open for this XP station window');
      return;
    }
    if (name !== 'block_place') return;
    pendingStationOpen = null;
    for (const entry of state?.stations || []) if (same(packet?.location, entry.position) || same(packet?.location, entry.support.position)) {
      foundation(entry);
      if (same(packet.location, entry.position) && entry.confirmedOwned === true && entry.debitConfirmed === true && at(entry.position)?.name === 'furnace') pendingStationOpen = entry;
    }
  };
  const observeStationWindow = window => {
    const entry = pendingStationOpen; pendingStationOpen = null;
    if (!entry || bot.currentWindow !== window || window?.type !== 'minecraft:furnace') return;
    try { active(); stationWindows.set(window, entry); stationWindowIds.set(window.id, window); } catch { /* A revoked event cannot authorize a window. */ }
  };
  const reachDry = async (...args) => {
    await deps.reachDry(...args); active();
    const entry = state?.stations?.find(s => same(s.position, args[0])); if (entry) foundation(entry);
  };
  const facts = fact => deps.recordConfirmedFact({ ...copy(fact), ownerTaskId: task.taskId, generation, anchor: point(anchor) });
  const pointBounds = p => ({ minX: p.x, maxX: p.x, minY: p.y - 1, maxY: p.y + 4, minZ: p.z, maxZ: p.z });
  const protectedPosition = p => (deps.isProtectedPosition?.(p) === true) || Object.values(task.materialSupply?.surfaceGraphs || {})
    .some(graph => getSurfaceGraphProtectedPositions(graph).some(q => same(p, q)))
    || (state?.stations || []).some(s => same(p, s.position) || same(p, s.support.position) || s.foundation?.some(f => same(p, f.position)))
    || (state?.renewable?.columns || []).some(c => same(p, c.support.position) || same(p, c.position) || c.foundation?.some(f => same(p, f.position)));
  const bounds = () => [...source.resourceBounds(), ...(state?.stations || []).map(s => pointBounds(s.position))];
  const excluded = p => bounds().some(b => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY && p.z >= b.minZ && p.z <= b.maxZ);
  const abort = error => {
    terminal ||= error;
    if (physical()) { try { deps.onOperationAbort(error); } catch (cleanupError) { error.cleanupOwnerFailure = { code: cleanupError.code, message: cleanupError.message }; } }
  };
  async function nativeAction(action, label, beforeSend = () => {}, timeoutMs = cfg.actionMs) {
    active(); const frame = { previous: client.write, active: true, closed: false }; let timer, poll, rejectDetached;
    const activation = { previous: bot.activateBlock, active: true }, activated = [];
    const detached = new Promise((_resolve, reject) => { rejectDetached = reject; });
    function activate(...args) {
      const result = activation.previous.apply(this, args);
      if (activation.active && ownContext()) { const actual = Promise.resolve(result); activated.push(actual); actual.catch(rejectDetached); }
      return result;
    }
    function write(name, payload, ...rest) {
      if (isOwnedNaturalHouseXPCancel(bot, name, payload)) return frame.previous.call(this, name, payload, ...rest);
      if (frame.active && ownContext() && ['block_place', 'use_item', 'held_item_slot', 'window_click', 'enchant_item', 'block_dig', 'close_window'].includes(name)) {
        if (frame.closed) throw terminal || fail('house_xp_host_native_closed', 'Old native host capability is closed');
        active(); beforeSend(name, payload);
      }
      return frame.previous.call(this, name, payload, ...rest);
    }
    frames.set(write, frame); client.write = write;
    if (typeof activation.previous === 'function') { frames.set(activate, activation); bot.activateBlock = activate; }
    const restore = () => {
      frame.active = false; activation.active = false;
      if (client.write === write) { let p = frame.previous; while (frames.get(p)?.active === false) p = frames.get(p).previous; client.write = p; }
      if (bot.activateBlock === activate) { let p = activation.previous; while (frames.get(p)?.active === false) p = frames.get(p).previous; bot.activateBlock = p; }
    };
    const operation = Promise.resolve().then(() => { active(); return action(); });
    const pending = operation.then(async value => { await Promise.allSettled(activated); return value; }, async error => { await Promise.allSettled(activated); throw error; });
    pendingNative.add(pending);
    const settled = () => { restore(); pendingNative.delete(pending); if (mainReturned && !pendingNative.size && activeHosts.get(client) === api) activeHosts.delete(client); };
    pending.then(settled, settled);
    const stopped = new Promise((_resolve, reject) => {
      const stop = error => { if (frame.closed) return; frame.closed = true; abort(error); reject(error); };
      timer = setTimeout(() => stop(fail('house_xp_host_timeout', `${label} exceeded native bound`)), timeoutMs);
      poll = setInterval(() => { try { active(); beforeSend(null, null); } catch (error) { stop(error); } }, 25);
    });
    try { const result = await Promise.race([pending, stopped, detached]); active(); return result; }
    catch (error) { frame.closed = true; throw error; }
    finally { clearTimeout(timer); clearInterval(poll); }
  }
  async function wait(check, code, message) {
    const end = Date.now() + cfg.readbackMs;
    while (!check()) { active(); if (Date.now() >= end) throw fail(code, message); await sleep(25); }
    active();
  }
  function initialize() {
    active(); anchor = source.getCamp();
    if (!integer(anchor)) throw fail('house_xp_camp_pending', 'Self material runtime has no fixed original camp');
    const prior = deps.getCP();
    if (prior && (prior.schema !== 1 || prior.kind !== 'natural_house_xp_host' || prior.taskId !== task.taskId || !same(prior.anchor, anchor)
      || !Array.isArray(prior.stations) || prior.stations.length > 8 || !Array.isArray(prior.seedHarvests) || prior.seedHarvests.length > 4096)) throw fail('house_xp_host_checkpoint_changed', 'Original task/camp XP host changed');
    state = prior ? copy(prior) : { schema: 1, kind: 'natural_house_xp_host', taskId: task.taskId, anchor: point(anchor), stations: [], pool: null, renewable: null, enchant: null, seedHarvests: [] };
    if (state.pending) throw fail('house_xp_host_reconciliation_required', 'Native host operation remains uncertain; never replay');
  }
  async function camp(options = {}) {
    await nativeAction(() => deps.returnCamp(anchor, { resource: 'cactus', ...options }), 'typed native XP return', () => {}, 180000);
    if (!same(bot.entity.position.floored(), anchor) || !dryBody(bot) || bot.entity.onGround !== true) throw fail('house_xp_camp_unconfirmed', 'Actual fixed dry camp not reached');
  }
  async function food() { await nativeAction(() => deps.ensureFood({ anchor, source, purpose: 'xp', preserve: { cactus: count('cactus') } }), 'native owned-food preparation', () => {}, 1800000); safety(); }
  async function prepareCapacity({ cactus = 0, green_dye = 0 } = {}) {
    active(); await camp(); await source.stash({ cactus: Math.max(cactus, count('cactus')), lapis_lazuli: 3, diamond_sword: 1 }); active();
    for (const [name, required] of Object.entries({ cactus, green_dye })) {
      const capacity = bot.inventory.slots.slice(9, 45).reduce((n, item) => n + (!item ? 64 : item.name === name ? 64 - item.count : 0), 0);
      if (capacity < required) throw fail('house_xp_inventory_full', `Actual owned-storage capacity for ${name} is insufficient`);
    }
  }
  function stationSites(amount) {
    active(); const profile = new Movements(bot); profile.canDig = false; profile.scafoldingBlocks = [];
    profile.allowParkour = false; profile.allow1by1towers = false; profile.allowSprinting = false; profile.allowFreeMotion = false; profile.maxDropDown = 2; profile.getMoveDiagonal = () => {};
    for (const name of HAZARDS) if (bot.registry.blocksByName[name]) profile.blocksToAvoid.add(bot.registry.blocksByName[name].id);
    profile.exclusionAreasStep.push(b => b?.position && [-1, 0, 1].every(dy => {
      const q = at({ x: b.position.x, y: b.position.y + dy, z: b.position.z });
      return q && !HAZARDS.has(q.name) && ![true, 'true'].includes(q.getProperties?.().waterlogged);
    }) ? 0 : Infinity);
    const result = [], began = Date.now(); let reads = 0, probes = 0;
    const read = p => { if (++reads > 8192 || Date.now() - began > 1000) throw fail('house_xp_site_budget', 'Finite loaded XP station site budget'); return at(p); };
    for (let radius = 2; radius <= 16 && result.length < amount; radius += 2) for (const [dx, dz] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius], [radius, radius], [-radius, radius]]) {
      if (result.length >= amount) break;
      const p = { x: anchor.x + dx, y: anchor.y, z: anchor.z + dz }, support = { ...p, y: p.y - 1 };
      active(); if (excluded(p) || protectedPosition(support) || !AIR.has(read(p)?.name) || !AIR.has(read({ ...p, y: p.y + 1 })?.name)) continue;
      const floor = read(support), foundation = []; let stable = false;
      for (let down = 0; down < 16; down++) {
        const q = { ...support, y: support.y - down }, block = read(q);
        if (!block || HAZARDS.has(block.name) || [true, 'true'].includes(block.getProperties?.().waterlogged) || !block.shapes?.some(s => s.length === 6 && s.every((v, i) => v === (i < 3 ? 0 : 1)))) break;
        foundation.push({ position: q, name: block.name, stateId: block.stateId });
        if (!['sand', 'red_sand', 'gravel'].includes(block.name)) { stable = true; break; }
      }
      if (!stable) continue;
      if (!inspectRecordedNaturalXPFoundation({ support: { position: support, name: floor.name, stateId: floor.stateId }, foundation, blockAt: read, assertActive: active }).safe) continue;
      const access = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => ({ x: p.x + x, y: p.y, z: p.z + z })).find(q => dryFoot(bot, q));
      if (!access || ++probes > 32) continue;
      const iterator = bot.pathfinder.getPathFromTo(profile, bot.entity.position, new goals.GoalBlock(access.x, access.y, access.z), { optimizePath: false, timeout: 50, tickTimeout: 5, searchRadius: 32 });
      let out; for (let n = 0; n < 16; n++) { const item = iterator.next(); out = item.value?.result; if (item.done || out?.status !== 'partial') break; }
      if (out?.status !== 'success' || out.path?.some(n => !integer(n) || n.toBreak?.length || n.toPlace?.length || !dryFoot(bot, n))) continue;
      result.push({ position: p, support: { position: support, name: floor.name, stateId: floor.stateId }, foundation, access, purpose: 'xp', plannedNativeApproach: true, confirmedOwned: false });
    }
    if (result.length !== amount) throw fail('house_xp_sites_pending', `Only ${result.length}/${amount} loaded dry native sites for dedicated XP furnaces`);
    return result;
  }
  async function emptyFurnace(entry) {
    await nativeAction(() => reachDry(entry.position, { range: 4.5, canDig: false }), 'reach new XP furnace'); foundation(entry);
    let window, raw; const onItems = p => { if (window ? p.windowId === window.id : true) raw = p; };
    client.on('window_items', onItems);
    try {
      window = await nativeAction(() => bot.openFurnace(at(entry.position)), 'open new owned XP furnace', (name, data) => {
        foundation(entry);
        if (name === 'block_place' && !same(data.location, entry.position)) throw fail('house_xp_foreign_furnace', 'Native open changed target');
      });
      await wait(() => raw?.windowId === window.id && bot.currentWindow === window && raw.items.length === window.slots.length, 'house_xp_empty_snapshot_pending', 'No complete fresh raw XP furnace window');
      if ([0, 1, 2].some(slot => Item.fromNotch(raw.items[slot]))) throw fail('house_xp_foreign_furnace_contents', 'New XP furnace contains unowned stock');
      await nativeAction(() => window.close(), 'close empty owned XP furnace');
      await wait(() => !bot.currentWindow, 'house_xp_window_unconfirmed', 'XP furnace did not close');
    } finally { client.removeListener('window_items', onItems); }
  }
  async function ensureOwnedFurnaces(amount = 8) {
    if (!state) initialize(); safety(); if (amount !== 8) throw fail('house_xp_invalid_pool', 'Exactly eight separate XP furnaces required');
    await camp();
    if (!state.stations.length) save({ stations: stationSites(8) });
    for (const entry of state.stations) {
      foundation(entry);
      const block = at(entry.position);
      if (entry.confirmedOwned) { if (block?.name !== 'furnace' || entry.debitConfirmed !== true || entry.emptyAuthorized !== true) throw fail('house_xp_station_reconciliation_required', 'Owned station changed or its native debit/empty proof is pending'); }
      else if (!AIR.has(block?.name)) throw fail('house_xp_foreign_furnace', 'Never adopt an existing furnace');
    }
    const remaining = state.stations.filter(s => !s.confirmedOwned);
    if (!remaining.length) return getOwnedFurnaces();
    const cobbleBefore = count('cobblestone'), furnaceBefore = count('furnace');
    await source.ensure({ cobblestone: Math.max(64, remaining.length * 8, cobbleBefore) }); active(); stationFoundations();
    const beforeCraft = count('cobblestone');
    await source.ensure({ furnace: furnaceBefore + remaining.length }); active(); stationFoundations();
    if (count('furnace') !== furnaceBefore + remaining.length || count('cobblestone') !== beforeCraft - remaining.length * 8) throw fail('house_xp_furnace_craft_unconfirmed', 'Real eight-to-one cobblestone craft debit/output missing');
    save({ craftEvidence: { cobblestoneBefore: beforeCraft, cobblestoneAfter: count('cobblestone'), furnaceBefore, furnaceAfter: count('furnace'), produced: remaining.length } });
    for (const entry of remaining) {
      foundation(entry);
      active(); if (!AIR.has(at(entry.position)?.name) || at(entry.support.position)?.stateId !== entry.support.stateId) throw fail('house_xp_station_changed', 'Reserved original XP support changed');
      let worldACK = false; const onBlock = p => { if (same(p.location, entry.position) && Block.fromStateId(p.type)?.name === 'furnace') worldACK = true; };
      const onMulti = packet => {
        const packed = bot.supportFeature('usesMultiblockSingleLong'), base = bot.supportFeature('usesMultiblock3DChunkCoords') ? packet.chunkCoordinates : { x: packet.chunkX, y: 0, z: packet.chunkZ };
        for (const r of packet.records || []) onBlock({ location: { x: base.x * 16 + (packed ? (r >> 8) & 15 : r.horizontalPos >> 4), y: base.y * 16 + (packed ? r & 15 : r.y), z: base.z * 16 + (packed ? (r >> 4) & 15 : r.horizontalPos & 15) }, type: packed ? r >> 12 : r.blockId });
      };
      client.on('block_change', onBlock); client.on('multi_block_change', onMulti);
      try {
        const placement = createEstatePlacement({ getBot: () => bot, assertActive: active, isOwnerContext: ownContext, timeoutMs: cfg.readbackMs, placeNative: deps.placeNative });
        await nativeAction(() => placement.place({ id: `xp:${key(entry.position)}`, item: 'furnace', position: entry.position, properties: { facing: 'north', lit: false } }, () => {
          if (at(entry.position)?.name === 'furnace') facts({ kind: 'owned_xp_furnace_placement', position: entry.position, support: entry.support, debitConfirmed: false });
        }), 'native dedicated XP furnace placement', () => foundation(entry)); foundation(entry);
        await wait(() => worldACK && at(entry.position)?.name === 'furnace', 'house_xp_station_world_ack_pending', 'XP furnace lacks actual raw world confirmation');
        save({ stations: state.stations.map(s => same(s.position, entry.position) ? { ...s, confirmedOwned: true, debitConfirmed: true } : s) });
        await emptyFurnace(entry);
        save({ stations: state.stations.map(s => same(s.position, entry.position) ? { ...s, emptyAuthorized: true } : s) });
      } finally { client.removeListener('block_change', onBlock); client.removeListener('multi_block_change', onMulti); }
    }
    await camp(); return getOwnedFurnaces();
  }
  function getOwnedFurnaces() {
    active(); stationFoundations(); return (state?.stations || []).map(s => ({ position: s.position, purpose: 'xp', confirmedOwned: s.confirmedOwned === true && s.debitConfirmed === true && s.emptyAuthorized === true }));
  }
  // New private seed bridge calls the existing captured HouseNativeDigSession
  // host primitive. It does not bind frozen XP stopOwn to a new lifetime.
  async function acquireNaturalSeedUpper(amount, options) {
    active(); if (typeof deps.digNative !== 'function' || typeof deps.collectDrops !== 'function' || typeof deps.nextExploration !== 'function') throw fail('house_xp_natural_seed_adapter_pending', 'Missing captured native upper/flower dig/pickup/typed-exploration adapter');
    if (!Number.isInteger(amount) || amount < 1 || amount > 128) throw fail('house_xp_seed_request', 'Natural initial seed need must be finite1..128');
    const before = count('cactus'), goal = before + amount, end = Date.now() + cfg.seedMs; let explored = 0;
    const seen = new Set();
    while (count('cactus') < goal) {
      await food(); active(); if (Date.now() >= end || explored >= 256) throw fail('house_xp_natural_seed_unavailable', 'Finite loaded natural upper search did not obtain initial seed stock');
      const selected = findMatureNaturalColumns(bot, { maximum: 128, excludeBounds: options.excludeBounds, isProtectedPosition: protectedPosition });
      for (const original of selected.columns) {
        if (seen.has(key(original.bottom))) continue; seen.add(key(original.bottom));
        const targets = [...(original.flower ? [{ ...original.flower, item: 'cactus_flower' }] : []), ...original.targets.map(t => ({ ...t, item: 'cactus' }))];
        for (const target of targets) {
          if (count('cactus') >= goal) break;
          active(); const position = target.position, bottomFloor = { ...original.bottom, y: original.bottom.y - 1 }, floorState = at(bottomFloor)?.stateId;
          await nativeAction(() => deps.reachDry(position, { range: 1.5, canDig: false, canPlace: false }), 'natural seed dry approach', () => {}, Math.min(180000, end - Date.now()));
          const safeTarget = () => {
            safety(); const current = column(bot, original.bottom), block = at(position), p = bot.entity.position;
            if (!current || at(bottomFloor)?.stateId !== floorState || protectedPosition(position) || excluded(position) || position.y <= original.bottom.y
              || (target.item === 'cactus_flower' ? !same(current.flower?.position, position) : current.flower || !same(current.targets[0]?.position, position))
              || block?.name !== target.item || bot.entity.onGround !== true || !dryBody(bot) || Math.hypot(p.x - position.x - .5, p.z - position.z - .5) > 1.5
              || p.offset(0, bot.entity.eyeHeight || 1.62, 0).distanceTo(new Vec3(position.x + .5, position.y + .5, position.z + .5)) > 4.5
              || !bot.canDigBlock?.(block) || typeof bot.canSeeBlock === 'function' && !bot.canSeeBlock(block)) throw fail('house_xp_seed_target_changed', 'Natural top/flower/bottom/actual dry stance changed');
            return block;
          };
          const block = safeTarget(), itemBefore = count(target.item); let airACK = false, inventoryACK = false, nativeFinishSent = false;
          const onBlock = packet => { if (same(packet.location, position) && AIR.has(Block.fromStateId(packet.type).name)) airACK = true; };
          const onMulti = packet => {
            const packed = bot.supportFeature('usesMultiblockSingleLong'), base = bot.supportFeature('usesMultiblock3DChunkCoords') ? packet.chunkCoordinates : { x: packet.chunkX, y: 0, z: packet.chunkZ };
            for (const r of packet.records || []) onBlock({ location: { x: base.x * 16 + (packed ? (r >> 8) & 15 : r.horizontalPos >> 4), y: base.y * 16 + (packed ? r & 15 : r.y), z: base.z * 16 + (packed ? (r >> 4) & 15 : r.horizontalPos & 15) }, type: packed ? r >> 12 : r.blockId });
          };
          const onInventory = packet => { if (packet.windowId === 0 && count(target.item) > itemBefore) inventoryACK = true; };
          client.on('block_change', onBlock); client.on('multi_block_change', onMulti); client.on('set_slot', onInventory); client.on('window_items', onInventory);
          try {
            save({ pending: { kind: 'natural_seed_harvest', position, bottom: original.bottom, item: target.item, before: itemBefore } });
            await nativeAction(() => deps.digNative(block), 'actual natural upper/flower dig', (name, packet) => {
              if (!nativeFinishSent) safeTarget();
              if (name === 'block_dig' && [0, 2].includes(packet?.status)) {
                if (!same(packet.location, position)) throw fail('house_xp_seed_target_changed', 'Native natural seed packet changed exact target');
                if (packet.status === 2) nativeFinishSent = true;
              }
            });
            await wait(() => airACK && AIR.has(at(position)?.name), 'house_xp_seed_air_ack_pending', 'No actual raw AIR after natural upper dig');
            await nativeAction(() => deps.collectDrops({ position, items: [target.item], radius: 1.5, allowMovement: false, timeoutMs: 4500 }), 'passive actual natural seed pickup');
            await wait(() => inventoryACK && count(target.item) > itemBefore, 'house_xp_seed_pickup_pending', 'Natural upper drop lost/unconfirmed');
            if (at(original.bottom)?.name !== 'cactus' || at(bottomFloor)?.stateId !== floorState) throw fail('house_xp_seed_bottom_changed', 'Natural bottom/foundation must remain untouched');
            const receipt = { kind: 'natural_cactus_upper_seed', position, bottom: original.bottom, item: target.item, before: itemBefore, after: count(target.item) };
            facts(receipt); save({ pending: null, seedHarvests: [...state.seedHarvests, receipt].slice(-4096) });
          } finally { client.removeListener('block_change', onBlock); client.removeListener('multi_block_change', onMulti); client.removeListener('set_slot', onInventory); client.removeListener('window_items', onInventory); }
        }
      }
      if (count('cactus') >= goal) break;
      const next = await nativeAction(() => deps.nextExploration({ anchor, resource: 'cactus', excludeBounds: options.excludeBounds }), 'native typed natural seed exploration', () => {}, Math.min(180000, end - Date.now()));
      explored++; if (next === false || next?.exhausted === true) throw fail('house_xp_natural_seed_unavailable', 'Confirmed finite natural seed frontier exhausted');
    }
    await camp(); return { confirmed: true, actualAdditional: count('cactus') - before, before, after: count('cactus'), explored };
  }
  const renewable = createRenewableCactusProvider({ ownerId: task.taskId, getBot: () => bot, assertActive: active, isOwnerContext: ownContext,
    getCP: () => state?.renewable, saveCP: value => save({ renewable: value }), recordConfirmedFact: facts,
    ensureFood: food, returnCamp: () => camp(), reachDry: deps.reachDry, placeNative: deps.placeNative, digNative: block => bot.dig(block, true),
    collectDrops: options => { active(); if (typeof deps.collectDrops !== 'function') throw fail('house_xp_drop_adapter_pending', 'No real native field pickup/ACK adapter'); return deps.collectDrops(options); },
    onOperationAbort: abort, sourceGuardSupportsOwnedCancel: true, isNativeCancelOwnerCurrent: physical,
    isProtectedPosition: protectedPosition, acquireNaturalSeedUpper, report: deps.report,
  }, { totalMs: cfg.totalMs });
  async function prepareRenewable() {
    initialize(); await prepareCapacity({ cactus: cfg.fieldColumns });
    if (state.renewable?.columns?.length) {
      if (state.renewable.columns.length !== cfg.fieldColumns) throw fail('house_xp_field_reconciliation_pending', 'Partly planted original field needs native reconciliation; do not plan a second replacement field');
      for (const entry of state.renewable.columns) {
        foundation(entry);
        if (!entry.confirmedOwned || at(entry.position)?.name !== 'cactus' || at(entry.support.position)?.stateId !== entry.support.stateId) throw fail('house_xp_owned_field_changed', 'Original owned field changed');
      }
      return { confirmed: true, actualOwnedColumns: state.renewable.columns.length, reusedOwnedField: true, naturalGrowthTimingProven: false };
    }
    const plan = renewable.plan({ anchor, targetColumns: cfg.fieldColumns, excludeBounds: bounds() });
    if (plan.sites.length !== cfg.fieldColumns) throw fail('house_xp_renewable_site_pending', `Actual loaded renewable field has ${plan.sites.length}/${cfg.fieldColumns} sites`, { plan });
    return renewable.provision({ anchor, plan, targetColumns: cfg.fieldColumns, excludeBounds: bounds() });
  }
  const pool = createHouseXPFurnacePool({ getBot: () => bot, assertActive: active, isOwnerContext: ownContext, getCP: () => state?.pool, saveCP: value => save({ pool: value }),
    ensureOwnedFurnaces, getOwnedFurnaces, getSharedStationPositions: () => [...Object.values(task.materialSupply?.ownedStations || {}).map(s => s.position), ...deps.getFurniturePositions?.() || []],
    reachDry, returnCamp: () => camp(), onOperationAbort: abort, allowNativeCancel: isOwnedNaturalHouseXPCancel,
    ensureFood: food, prepareCapacity, ensureMaterials: needs => source.ensure(needs),
    gatherCactus: async n => { if (!state?.renewable?.columns?.length) await prepareRenewable(); return renewable.gather(n, { anchor, maxDurationMs: cfg.totalMs }); }, report: deps.report,
  });
  const enchanting = createHouseNaturalEnchant({ getBot: () => bot, assertActive: active, isOwnerContext: ownContext,
    getCP: () => state?.enchant, saveCP: value => save({ enchant: value }), ensureMaterials: options => options.requirements ? source.ensure(options.requirements) : undefined,
    ownedEnchantmentTable: async () => {
      active(); if (typeof deps.ownedEnchantmentTable !== 'function') throw fail('house_xp_owned_table_adapter_pending', 'No exact original-task furniture ownership table');
      return deps.ownedEnchantmentTable();
    }, reach: deps.reachDry, returncamp: () => camp(), onOperationTimeout: abort,
  }, { materialsTimeoutMs: 1800000, nativeTimeoutMs: cfg.actionMs });
  async function runSource(action) {
    active(); if (pendingNative.size) throw fail('house_xp_host_native_cleanup_pending', 'Previous native host promises remain unsettled');
    if (running) throw fail('house_xp_host_busy', 'Only one original XP finishing stage at a time'); running = true; mainReturned = false;
    const previous = activeHosts.get(client); if (previous && previous !== api && previous.isPhysicalOwner()) { running = false; throw fail('house_xp_host_busy', 'Another captured XP host owns this client'); }
    activeHosts.set(client, api);
    const closeFrame = { previous: client.write, active: true };
    function closeWrite(name, packet, ...rest) {
      if (closeFrame.active && name === 'close_window' && ownContext() && stationWindowIds.has(packet?.windowId)) {
        active();
        if (bot.currentWindow !== null && bot.currentWindow !== stationWindowIds.get(packet.windowId)) throw fail('house_xp_window_pending', 'Old XP cleanup cannot close a different current native window object');
      }
      return closeFrame.previous.call(this, name, packet, ...rest);
    }
    frames.set(closeWrite, closeFrame); client.write = closeWrite;
    bot.on('windowOpen', observeStationWindow);
    try { return await source.withContext(() => withHouseNativeSourceGuard(bot, { assertActive: active, isOwnerContext: ownContext, allowNativeCancel: isOwnedNaturalHouseXPCancel,
      beforeSend: (_bot, name, packet) => stationPacket(name, packet) }, async () => { initialize(); return action(); })); }
    finally {
      bot.removeListener('windowOpen', observeStationWindow); pendingStationOpen = null; closeFrame.active = false;
      if (client.write === closeWrite) { let previous = closeFrame.previous; while (frames.get(previous)?.active === false) previous = frames.get(previous).previous; client.write = previous; }
      running = false; mainReturned = true; if (!pendingNative.size && activeHosts.get(client) === api) activeHosts.delete(client);
    }
  }
  const api = { ensureOwnedFurnaces: () => runSource(() => ensureOwnedFurnaces()), prepareRenewable: () => runSource(prepareRenewable),
    acquireNaturalSeeds: n => runSource(() => acquireNaturalSeedUpper(n, { anchor, excludeBounds: bounds() })),
    ensureLevels: (level = 30) => runSource(async () => { await ensureOwnedFurnaces(); return pool.ensureLevels(level, { anchor, fuelName: task.materialSupply?.camp?.plankName || 'oak_planks', maxDurationMs: cfg.totalMs }); }),
    enchant30: options => runSource(() => enchanting.enchant30({ anchor, ...options })),
    finish: () => runSource(async () => {
      const original = task.completionPlan || task.plan, step = original.steps?.find(s => ['build_furnished_house_phase', 'build_estate'].includes(s.skill));
      if (step?.args?.materialSource !== 'self_gathered' || step.args.useNearbySupplyChests === true || !['enchanting_library', 'medieval_castle', 'riverside_villa'].includes(step.args.profile)) throw fail('house_xp_original_contract', 'Natural XP is only the original self-gathered advanced house finishing stage');
      if (state.enchant?.enchantPending) throw fail('house_enchant_reconciliation_required', 'Prior native enchant may already have spent3levels/lapis; do not gain or enchant again');
      if (state.enchant?.phase === 'enchant30_confirmed' || state.phase === 'native_enchant_return_confirmed') throw fail('house_xp_finished_reconciliation_pending', 'Prior finished native result needs a fresh saved inventory/camp receipt, never repeat it');
      await ensureOwnedFurnaces();
      const actual = await pool.ensureLevels(30, { anchor, fuelName: task.materialSupply?.camp?.plankName || 'oak_planks', maxDurationMs: cfg.totalMs });
      active(); const result = await enchanting.enchant30({ anchor }); active(); await camp();
      save({ phase: 'native_enchant_return_confirmed', actualLevels: actual, result });
      return { confirmed: true, nativeNaturalXPWholeAcceptance: 'NOT_RUN', actualLevels: actual, enchant: result };
    }), getState: () => state && copy(state), isPhysicalOwner: physical, assertActive: active,
    allowBaseNativeCancel: deps.allowNativeCancel };
  return api;
}
module.exports = { createNaturalHouseXPHost, isOwnedNaturalHouseXPCancel, getNaturalXPProtectedPositions };
