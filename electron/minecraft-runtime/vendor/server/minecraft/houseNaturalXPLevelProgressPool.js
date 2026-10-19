/* global require, module, setTimeout, clearTimeout, setInterval, clearInterval */
'use strict';
// Level/progress successor; preserves the older production pool.
const runtimeRequire = require;
const { Vec3 } = require('vec3');
const { dryBody, isOwnedXPNativeCancel } = require('./houseNaturalXPProvider');
const frames = new WeakMap(), activations = new WeakMap();
const copy = value => JSON.parse(JSON.stringify(value));
const integer = value => value && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(value[axis]));
const point = value => ({ x: value.x, y: value.y, z: value.z });
const key = value => `${value.x},${value.y},${value.z}`;
const same = (a, b) => integer(a) && integer(b) && key(a) === key(b);
const failure = (code, message, facts = {}) => Object.assign(new Error(message), { code, ...facts });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mutations = new Set(['block_place', 'use_item', 'block_dig', 'window_click', 'close_window', 'held_item_slot']);

// Official 1.21.8 Player.getXpNeededForNextLevel, for planning only. Actual
// level/totalExperience packets and native output ACKs determine completion.
function houseXPAtLevel(level) {
  if (!Number.isInteger(level) || level < 0 || level > 30) throw failure('house_xp_invalid_target', '经验目标只能为0到30级');
  let points = 0;
  for (let n = 0; n < level; n++) points += n < 16 ? 7 + n * 2 : 42 + (n - 16) * 5;
  return points;
}
// PRIVATE successor: totalExperience is a lifetime counter across legitimate
// enchantments, not spendable level balance. This estimate only sizes inputs;
// actual experience packets, level/progress and native output ACKs still gate.
function houseXPRemainingForPlanning(targetLevel, experience) {
  const target = houseXPAtLevel(targetLevel);
  if (!Number.isSafeInteger(experience?.level) || experience.level < 0
    || !Number.isFinite(experience?.progress) || experience.progress < 0 || experience.progress > 1) {
    throw failure('house_xp_state_unconfirmed', '没有实际等级和经验条可规划下一批');
  }
  if (experience.level >= targetLevel) return 0;
  const base = houseXPAtLevel(experience.level);
  const next = houseXPAtLevel(experience.level + 1) - base;
  return Math.max(1, Math.ceil(target - base - experience.progress * next));
}
function unwrap(map, previous) {
  while (map.get(previous)?.active === false) previous = map.get(previous).previous;
  return previous;
}
function createHouseXPFurnacePool(deps, limits = {}) {
  for (const name of ['getBot', 'assertActive', 'isOwnerContext', 'getCP', 'saveCP', 'ensureOwnedFurnaces', 'getOwnedFurnaces', 'reachDry', 'returnCamp', 'onOperationAbort']) {
    if (typeof deps?.[name] !== 'function') throw new TypeError(`XP炉池缺少captured-owner依赖 ${name}`);
  }
  const bot = deps.getBot(), client = bot?._client;
  if (!client?.write || typeof bot.openFurnace !== 'function') throw new TypeError('XP炉池需要原装Mineflayer炉子插件及真实连接');
  const Item = runtimeRequire('prismarine-item')(bot.registry);
  const cfg = { inputsPerFurnace: 32, nativeMs: 30000, readbackMs: 5000, pollMs: 50,
    batchMs: 600000, materialsMs: 1800000, campMs: 180000, totalMs: 14400000,
    maxRounds: 64, maxGatherBatches: 128, settlementMs: 5000, ...limits };
  for (const [name, value] of Object.entries(cfg)) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`XP炉池需要有限正整数 ${name}`);
  if (cfg.inputsPerFurnace > 32 || cfg.pollMs > 1000 || cfg.totalMs > 43200000 || cfg.totalMs < cfg.batchMs
    || cfg.maxRounds > 256 || cfg.maxGatherBatches > 256 || cfg.settlementMs > 5000) throw new TypeError('XP炉池有限预算超出边界');
  let checkpoint, terminal = null, running = false, abortNotified = false;
  const active = () => {
    if (terminal) throw terminal;
    deps.assertActive();
    if (deps.getBot() !== bot || bot._client !== client) throw failure('house_xp_bot_changed', '原XP任务机器人或连接已更换');
  };
  const count = name => bot.inventory.items().reduce((sum, item) => sum + (item.name === name ? item.count : 0), 0);
  const xp = () => {
    const value = bot.experience;
    if (!Number.isSafeInteger(value?.level) || value.level < 0 || !Number.isSafeInteger(value?.points) || value.points < 0
      || !Number.isFinite(value?.progress) || value.progress < 0 || value.progress > 1) throw failure('house_xp_state_unconfirmed', '没有完整真实经验状态');
    return { level: value.level, points: value.points, progress: value.progress };
  };
  const grew = (before, after) => after.points > before.points && (after.level > before.level || after.progress > before.progress || after.level === before.level);
  const survival = () => {
    active();
    if (!Number.isFinite(bot.health) || bot.health < 16 || !Number.isFinite(bot.food) || bot.food < 14) throw failure('house_xp_survival_limit', '经验任务生命或饱食不足，保留现场');
  };
  const initialize = anchor => {
    active();
    if (!integer(anchor)) throw failure('house_xp_invalid_anchor', 'XP炉池需要固定整数营地');
    const old = deps.getCP();
    if (old && (old.schema !== 1 || old.kind !== 'owned_eight_house_xp_furnaces' || !same(old.anchor, anchor))) throw failure('house_xp_checkpoint_changed', 'XP炉池营地或schema改变');
    checkpoint = old ? copy(old) : { schema: 1, kind: 'owned_eight_house_xp_furnaces', anchor: point(anchor), stations: [], batches: [], pending: null };
    if (!Array.isArray(checkpoint.batches) || checkpoint.batches.length > 256) throw failure('house_xp_checkpoint_changed', 'XP炉池批次记录无效');
    if (checkpoint.pending) throw failure('house_xp_reconciliation_required', '原批次可能已投料或取出，必须先读取原炉/背包/经验核对，禁止重放');
  };
  const save = patch => {
    active(); const latest = deps.getCP();
    if (latest && (latest.schema !== 1 || latest.kind !== checkpoint.kind || !same(latest.anchor, checkpoint.anchor))) throw failure('house_xp_checkpoint_changed', '嵌套准备改变了原XP营地合同');
    checkpoint = { ...checkpoint, ...copy(latest || {}), ...copy(patch) }; deps.saveCP(copy(checkpoint));
  };
  const abort = error => {
    terminal ||= error;
    if (abortNotified) return;
    abortNotified = true;
    try { deps.onOperationAbort(terminal); } catch (cleanupError) {
      terminal.abortOwnerFailure = { code: cleanupError.code || null, message: cleanupError.message };
    }
  };
  const budget = (deadline, limit) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw failure('house_xp_timeout', 'XP任务总时限已到，拒绝启动下一原生动作');
    return Math.min(remaining, limit);
  };

  // Each GUI/native callback retains both its raw operation promise and the
  // detached activateBlock promise used by installed openBlock. A timeout must
  // not uninstall the write guard while either chain can still resume.
  async function native(operation, label, timeout = cfg.nativeMs, beforeSend = () => {}) {
    active();
    const frame = { active: true, closed: false, previous: client.write }, activated = [];
    const lookFrame = { active: true, previous: bot.lookAt };
    const activationFrame = { active: true, previous: bot.activateBlock };
    let rejectDetached, timer, monitor, disposed = false;
    const detached = new Promise((_resolve, reject) => { rejectDetached = reject; });
    function write(name, data, ...rest) {
      if (isOwnedXPNativeCancel(bot, name, data) || deps.allowNativeCancel?.(bot, name, data) === true) return frame.previous.call(this, name, data, ...rest);
      if (frame.active && mutations.has(name) && deps.isOwnerContext() === true) {
        if (frame.closed) throw terminal || failure('house_xp_native_closed', '已关闭XP动作拒绝迟发原生交互');
        active(); beforeSend(name, data);
      }
      return frame.previous.call(this, name, data, ...rest);
    }
    function look(...args) {
      if (!lookFrame.active || deps.isOwnerContext() !== true) return lookFrame.previous.apply(this, args);
      active();
      return Promise.resolve(lookFrame.previous.apply(this, args)).then(value => {
        if (frame.closed) throw terminal || failure('house_xp_native_closed', '旧XP转向已关闭');
        active(); return value;
      });
    }
    function activate(...args) {
      const promise = activationFrame.previous.apply(this, args);
      if (activationFrame.active && deps.isOwnerContext() === true) {
        const actual = Promise.resolve(promise); activated.push(actual); actual.catch(rejectDetached);
      }
      return promise;
    }
    frames.set(write, frame); client.write = write;
    if (typeof lookFrame.previous === 'function') { frames.set(look, lookFrame); bot.lookAt = look; }
    if (typeof activationFrame.previous === 'function') { activations.set(activate, activationFrame); bot.activateBlock = activate; }
    function dispose() {
      if (disposed) return; disposed = true;
      frame.active = false; lookFrame.active = false; activationFrame.active = false;
      if (client.write === write) client.write = unwrap(frames, frame.previous);
      if (bot.lookAt === look) bot.lookAt = unwrap(frames, lookFrame.previous);
      if (bot.activateBlock === activate) bot.activateBlock = unwrap(activations, activationFrame.previous);
    }
    const operationPromise = Promise.resolve().then(() => { active(); return operation(); });
    const pending = operationPromise.then(async value => { await Promise.allSettled(activated); return value; }, async error => { await Promise.allSettled(activated); throw error; });
    pending.then(dispose, dispose);
    const stopped = new Promise((_resolve, reject) => {
      timer = setTimeout(() => { const error = failure('house_xp_timeout', `${label}超出有限时间`); frame.closed = true; abort(error); reject(error); }, timeout);
      monitor = setInterval(() => { try { active(); } catch (error) { frame.closed = true; abort(error); reject(error); } }, cfg.pollMs);
    });
    try { const value = await Promise.race([pending, detached, stopped]); active(); return value; }
    catch (error) {
      frame.closed = true; abort(error);
      let settlementTimer;
      const done = await Promise.race([pending.then(() => true, () => true), new Promise(resolve => { settlementTimer = setTimeout(() => resolve(false), cfg.settlementMs); })]);
      clearTimeout(settlementTimer);
      if (!done) {
        const unknown = failure('house_xp_native_cleanup_pending', `${label}的原生Promise尚未结束，保留关闭守卫`, { nativeSettlement: 'UNKNOWN', cause: error });
        try { deps.onOperationAbort(unknown); } catch (cleanupError) { unknown.abortOwnerFailure = { code: cleanupError.code || null, message: cleanupError.message }; }
        throw unknown;
      }
      throw error;
    } finally { clearTimeout(timer); clearInterval(monitor); }
  }
  async function wait(predicate, code, message, deadline, budget = cfg.readbackMs) {
    const end = Math.min(deadline, Date.now() + budget);
    while (true) { active(); if (predicate()) return; if (Date.now() >= end) throw failure(code, message); await sleep(Math.min(cfg.pollMs, Math.max(1, end - Date.now()))); }
  }
  const stance = position => {
    survival();
    if (bot.entity.onGround !== true || !dryBody(bot) || bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
      .distanceTo(new Vec3(position.x + .5, position.y + .5, position.z + .5)) > 4.5) throw failure('house_xp_furnace_unsafe_stance', 'XP炉交互没有真实干燥落稳近身站位');
    if (bot.blockAt(new Vec3(position.x, position.y, position.z))?.name !== 'furnace') throw failure('house_xp_foreign_furnace', '已归属XP炉被替换');
  };
  async function camp(anchor, deadline) {
    await native(() => deps.returnCamp(anchor, { resource: 'cactus', purpose: 'xp' }), 'XP原路返营', budget(deadline, cfg.campMs));
    survival();
    if (!same(bot.entity?.position?.floored?.(), anchor) || bot.entity.onGround !== true || !dryBody(bot)) throw failure('house_xp_camp_unconfirmed', '没有在原固定营地真实干燥落稳');
  }
  async function ownedStations(anchor, excludeBounds, deadline) {
    await native(() => deps.ensureOwnedFurnaces(8, { anchor: point(anchor), excludeBounds, purpose: 'xp' }), '真实自建八台独立XP炉', budget(deadline, cfg.materialsMs));
    const stations = await native(() => deps.getOwnedFurnaces(), '读取独立XP炉归属', budget(deadline, cfg.nativeMs));
    const reserved = deps.getSharedStationPositions?.() || [];
    if (!Array.isArray(stations) || stations.length !== 8 || new Set(stations.map(s => key(s.position || {}))).size !== 8
      || stations.some(s => s.confirmedOwned !== true || s.purpose !== 'xp' || !integer(s.position)
        || reserved.some(p => same(p, s.position)))) throw failure('house_xp_pool_ownership_unconfirmed', '必须有八台唯一、自建且不与食品/建材共享的XP炉');
    for (const station of stations) if (bot.blockAt(new Vec3(station.position.x, station.position.y, station.position.z))?.name !== 'furnace') throw failure('house_xp_foreign_furnace', '自建XP炉实际方块不符');
    if (checkpoint.stations.length && (checkpoint.stations.length !== 8 || checkpoint.stations.some((p, n) => !same(p, stations[n].position)))) throw failure('house_xp_checkpoint_changed', '不能更换原八台XP炉');
    save({ stations: stations.map(s => point(s.position)) }); return stations;
  }

  async function batch({ anchor, inputs = 8 * cfg.inputsPerFurnace, fuelName = 'oak_planks', maxDurationMs = cfg.batchMs, excludeBounds = [] } = {}) {
    initialize(anchor); survival();
    if (!Number.isSafeInteger(inputs) || inputs < 1 || inputs > cfg.inputsPerFurnace * 8 || !fuelName.endsWith('_planks') || !bot.registry.itemsByName[fuelName]
      || !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1) throw failure('house_xp_invalid_batch', 'XP炉批次最多八炉各32件、实际木板燃料及有限时限');
    const deadline = Date.now() + Math.min(maxDurationMs, cfg.batchMs);
    const stations = await ownedStations(anchor, excludeBounds, deadline), before = xp(), beforeGreen = count('green_dye');
    const split = stations.map((_s, n) => Math.floor(inputs / 8) + (n < inputs % 8 ? 1 : 0));
    const fuel = split.map(n => Math.ceil(n / 1.5)), totalFuel = fuel.reduce((n, amount) => n + amount, 0);
    if (count('cactus') < inputs || count(fuelName) < totalFuel) throw failure('house_xp_materials_missing', 'XP炉池仅接受自采链实际备好的仙人掌和燃料');
    const outputCapacity = bot.inventory.slots.slice(9, 45).reduce((sum, item) => sum + (!item ? 64 : item.name === 'green_dye' ? 64 - item.count : 0), 0);
    if (outputCapacity < inputs) throw failure('house_xp_inventory_full', '投料前须先在自建仓库腾出真实染料容量');
    if (bot.currentWindow) throw failure('house_xp_window_busy', '不能抢占已有原生窗口');
    const snapshots = new Map(), packets = [];
    let sequence = 0, xpSequence = 0, current = null;
    const onItems = packet => { snapshots.set(packet.windowId, { sequence: ++sequence, slots: new Map(packet.items.map((item, slot) => [slot, Item.fromNotch(item)])) }); };
    const onSlot = packet => { const snapshot = snapshots.get(packet.windowId); if (snapshot) snapshot.slots.set(packet.slot, Item.fromNotch(packet.item)); };
    const onXP = packet => { try { packets.push({ sequence: ++xpSequence, packet: copy(packet), actual: xp() }); if (packets.length > 128) packets.shift(); } catch { /* invalid native state cannot satisfy XP */ } };
    client.on('window_items', onItems); client.on('set_slot', onSlot); client.on('experience', onXP);
    const pending = { startedAt: Date.now(), before, inputs, fuelName, stations: stations.map((s, n) => ({ position: point(s.position), inputCount: split[n], fuelCount: fuel[n], status: split[n] ? 'not_filled' : 'unused' })) };
    const slots = window => snapshots.get(window.id)?.slots;
    const playerCount = (window, name) => [...slots(window)].reduce((sum, [slot, item]) => sum + (slot >= window.inventoryStart && slot < window.inventoryEnd && item?.name === name ? item.count : 0), 0);
    const remaining = () => budget(deadline, cfg.nativeMs);
    const windowSend = window => () => { stance(window.xpPosition);
      if (bot.currentWindow !== window) throw failure('house_xp_window_changed', 'XP窗口归属已改变'); };
    async function open(station) {
      active(); if (bot.currentWindow) throw failure('house_xp_window_busy', '不能同时打开多个GUI');
      await native(() => deps.reachDry(station.position, { action: 'open_furnace', range: 4.5, canDig: false }), '走到自建XP炉', remaining()); stance(station.position);
      const version = sequence; let sent = false;
      const window = await native(() => bot.openFurnace(bot.blockAt(new Vec3(station.position.x, station.position.y, station.position.z))), '打开自建XP炉', remaining(), (name, data) => {
        stance(station.position);
        if (name === 'block_place') { if (!same(data?.location, station.position)) throw failure('house_xp_furnace_open_unconfirmed', '打开包不是本台自建XP炉'); sent = true; }
      });
      current = window; window.xpPosition = station.position;
      if (!sent) throw failure('house_xp_furnace_open_unconfirmed', '没有本台XP炉的实际原生打开包');
      await wait(() => bot.currentWindow === window && window.type === 'minecraft:furnace' && snapshots.get(window.id)?.sequence > version
        && slots(window)?.size === window.slots.length, 'house_xp_furnace_snapshot_unconfirmed', '没有本次打开后的完整真实炉子快照', deadline);
      return window;
    }
    async function close(window, expected = {}) {
      await native(() => window.close(), '关闭XP炉', remaining(), windowSend(window)); current = null;
      await wait(() => bot.currentWindow === null && Object.entries(expected).every(([name, amount]) => count(name) === amount),
        'house_xp_closed_inventory_unconfirmed', '关闭后实际玩家背包与原始窗口ACK不符', deadline);
    }
    try {
      save({ pending });
      for (const station of pending.stations.filter(s => s.inputCount)) {
        survival(); if (Date.now() >= deadline) throw failure('house_xp_timeout', 'XP投料总时限已到');
        const window = await open(station), raw = slots(window);
        if ([0, 1, 2].some(slot => raw.get(slot))) throw failure('house_xp_furnace_not_empty', '专用XP炉包含未核对的原料、燃料或产物');
        const cactusBefore = playerCount(window, 'cactus'), fuelBefore = playerCount(window, fuelName);
        station.status = 'input_requested'; save({ pending });
        await native(() => window.putInput(bot.registry.itemsByName.cactus.id, null, station.inputCount), '真实投放仙人掌', remaining(), windowSend(window));
        await wait(() => slots(window).get(0)?.name === 'cactus' && slots(window).get(0).count === station.inputCount && playerCount(window, 'cactus') === cactusBefore - station.inputCount,
          'house_xp_input_unconfirmed', '没有实际原始投料及背包扣除ACK', deadline);
        station.status = 'fuel_requested'; save({ pending });
        await native(() => window.putFuel(bot.registry.itemsByName[fuelName].id, null, station.fuelCount), '真实投放木板', remaining(), windowSend(window));
        await wait(() => playerCount(window, fuelName) === fuelBefore - station.fuelCount,
          'house_xp_fuel_unconfirmed', '没有实际燃料背包净扣除', deadline);
        station.status = 'cooking'; save({ pending });
        await close(window, { cactus: cactusBefore - station.inputCount, [fuelName]: fuelBefore - station.fuelCount });
      }
      while (pending.stations.some(s => s.status !== 'extracted' && s.status !== 'unused')) {
        survival(); if (Date.now() >= deadline) throw failure('house_xp_timeout', '八炉真实烧炼等待超时');
        let extracted = false;
        for (const station of pending.stations.filter(s => s.status === 'cooking')) {
          const window = await open(station), raw = slots(window), input = raw.get(0), output = raw.get(2), fuelItem = raw.get(1);
          if (input && input.name !== 'cactus' || output && output.name !== 'green_dye' || fuelItem && (fuelItem.name !== fuelName || fuelItem.count > station.fuelCount)
            || (input?.count || 0) + (output?.count || 0) !== station.inputCount) throw failure('house_xp_furnace_contents_changed', '本批炉子原料产物守恒或燃料归属不符');
          if (input || (output?.count || 0) !== station.inputCount) { await close(window); continue; }
          const greenBefore = playerCount(window, 'green_dye'), fuelBefore = playerCount(window, fuelName), extractBefore = xp(), extractSequence = xpSequence;
          station.status = 'output_requested'; save({ pending });
          await native(() => window.takeOutput(), '真实取出染料和经验', remaining(), windowSend(window));
          await wait(() => !slots(window).get(2) && playerCount(window, 'green_dye') === greenBefore + station.inputCount,
            'house_xp_output_unconfirmed', '原生输出取回没有真实槽位ACK', deadline);
          await wait(() => packets.some(p => p.sequence > extractSequence && grew(extractBefore, p.actual)) && grew(extractBefore, xp()),
            'house_xp_no_progress', '本次输出取回后没有真实经验包增长', deadline);
          const residual = slots(window).get(1), residualCount = residual?.count || 0;
          if (residual) {
            if (residual.name !== fuelName || residualCount > station.fuelCount) throw failure('house_xp_furnace_contents_changed', '余燃料不属于本批');
            await native(() => window.takeFuel(), '回收本批实际余燃料', remaining(), windowSend(window));
            await wait(() => !slots(window).get(1) && playerCount(window, fuelName) === fuelBefore + residualCount,
              'house_xp_fuel_return_unconfirmed', '真实余燃料回收没有槽位ACK', deadline);
          }
          await close(window, { green_dye: greenBefore + station.inputCount, [fuelName]: fuelBefore + residualCount });
          station.status = 'extracted'; station.beforeXP = extractBefore; station.afterXP = xp(); station.residualFuelRecovered = residualCount;
          save({ pending }); extracted = true;
        }
        if (!extracted) { deps.report?.('八台自建经验炉正在真实烧炼'); await sleep(Math.min(1000, Math.max(1, deadline - Date.now()))); }
      }
      await camp(anchor, deadline);
      if (count('green_dye') !== beforeGreen + inputs || !grew(before, xp()) || !packets.length) throw failure('house_xp_no_progress', '返营后实际产物或经验未确认');
      const result = { confirmed: true, source: 'eight_owned_native_xp_furnaces', before, after: xp(), inputs,
        greenDyeBefore: beforeGreen, greenDyeAfter: count('green_dye'), packets, stations: copy(pending.stations), elapsedMs: Date.now() - pending.startedAt };
      save({ pending: null, batches: [...checkpoint.batches, result] }); return result;
    } finally {
      client.removeListener('window_items', onItems); client.removeListener('set_slot', onSlot); client.removeListener('experience', onXP);
      if (current) try { active(); await native(() => current.close(), '关闭本次未完成XP窗口', cfg.nativeMs); } catch { /* Revoked/closed owner must never issue recovery writes. */ }
    }
  }
  async function levels(targetLevel = 30, { anchor, excludeBounds = [], fuelName = 'oak_planks', maxDurationMs = cfg.totalMs } = {}) {
    initialize(anchor); survival();
    if (!Number.isInteger(targetLevel) || targetLevel < 1 || targetLevel > 30 || !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1) throw failure('house_xp_invalid_target', 'XP目标必须为1到30级并有有限总时限');
    for (const name of ['gatherCactus', 'ensureMaterials', 'prepareCapacity', 'ensureFood']) if (typeof deps[name] !== 'function') throw failure('house_xp_provider_pending', `自然XP仍缺 ${name}`);
    const before = xp(), deadline = Date.now() + Math.min(maxDurationMs, cfg.totalMs), targetPoints = houseXPAtLevel(targetLevel);
    let rounds = 0;
    while (xp().level < targetLevel || xp().points < targetPoints) {
      survival(); if (Date.now() >= deadline || rounds >= cfg.maxRounds) throw failure('house_xp_limit', '自然XP采集达到有限总时限或批次上限');
      await native(() => deps.ensureFood({ anchor, resource: 'cactus', purpose: 'xp' }), '经验任务真实口粮', budget(deadline, cfg.materialsMs)); survival();
      // Provision the owned64-cobblestone/eight-furnace chain inside the long
      // materials budget, before the first cooking round's shorter deadline.
      if (rounds === 0) await ownedStations(anchor, excludeBounds, deadline);
      if (xp().level >= targetLevel && xp().points >= targetPoints) break;
      const inputs = Math.min(cfg.inputsPerFurnace * 8, Math.max(1, houseXPRemainingForPlanning(targetLevel, xp())));
      await native(() => deps.prepareCapacity({ anchor, cactus: inputs, green_dye: inputs, preserveFood: true, preserveTools: true }), '自建仓库整理XP容量', budget(deadline, cfg.materialsMs));
      let gathered = 0;
      while (count('cactus') < inputs) {
        survival(); if (gathered++ >= cfg.maxGatherBatches || Date.now() >= deadline) throw failure('house_xp_cactus_unavailable', '天然仙人掌有限采集仍不足');
        const amount = Math.min(32, inputs - count('cactus')), quantity = count('cactus');
        await native(() => deps.gatherCactus(amount, { anchor, excludeBounds }), '真实采集天然仙人掌上部', budget(deadline, cfg.materialsMs));
        if (count('cactus') < quantity + amount) throw failure('house_xp_cactus_pickup_unconfirmed', '天然仙人掌提供者未确认真实库存净增长');
      }
      const portions = Array.from({ length: 8 }, (_v, n) => Math.floor(inputs / 8) + (n < inputs % 8 ? 1 : 0));
      const fuelCount = portions.reduce((sum, amount) => sum + Math.ceil(amount / 1.5), 0);
      await native(() => deps.ensureMaterials({ [fuelName]: fuelCount }, { anchor, preserve: { cactus: inputs }, preserveFood: true, preserveTools: true, purpose: 'xp' }),
        '自采合成XP木板燃料', budget(deadline, cfg.materialsMs)); survival();
      if (count('cactus') < inputs || count(fuelName) < fuelCount) throw failure('house_xp_materials_missing', '备燃料后没有同时保留真实仙人掌与燃料');
      if (xp().level >= targetLevel && xp().points >= targetPoints) break;
      await batch({ anchor, inputs, fuelName, excludeBounds, maxDurationMs: budget(deadline, cfg.batchMs) }); rounds++;
    }
    await camp(anchor, deadline);
    const actual = xp();
    if (actual.level < targetLevel || actual.points < targetPoints) throw failure('house_xp_level_unconfirmed', '返营后没有真实目标经验');
    const result = { confirmed: true, targetLevel, planningTargetPoints: targetPoints, before, actual, rounds, anchor: point(anchor) };
    save({ levelEvidence: result }); return result;
  }
  async function exclusive(action) {
    if (running) throw failure('house_xp_native_busy', '不能并行执行两个XP炉GUI任务');
    running = true;
    try { return await action(); } finally { running = false; }
  }
  return { earnBatch: options => exclusive(() => batch(options)), ensureLevels: (level, options) => exclusive(() => levels(level, options)),
    getState: () => checkpoint && copy(checkpoint) };
}
module.exports = { createHouseXPFurnacePool, houseXPAtLevel, houseXPRemainingForPlanning };
