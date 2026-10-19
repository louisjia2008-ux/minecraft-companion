/* global require, module, setTimeout, clearTimeout */
'use strict';

const { Vec3 } = require('vec3');
const { Movements, goals } = require('mineflayer-pathfinder');
const { classifyMiningBlock } = require('./miningNavigation');
const { hasGroundedBodySupport } = require('./houseSurfaceGraph');
const SIDES = Object.freeze([{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }]);
const FACES = Object.freeze([...SIDES, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }]);
const clone = value => JSON.parse(JSON.stringify(value));
const vec = p => new Vec3(p.x, p.y, p.z);
const plain = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const offset = (p, d) => ({ x: p.x + d.x, y: p.y + d.y, z: p.z + d.z });
const key = p => `${p.x},${p.y},${p.z}`;
const same = (a, b) => a && b && ['x', 'y', 'z'].every(axis => a[axis] === b[axis]);
const integer = p => p && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(p[axis]));
const props = block => block?.getProperties?.() || {};
const source = (block, name) => block?.name === name && Number(props(block).level) === 0;
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const NATURAL_PLUGS = new Set(['stone', 'deepslate', 'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'dirt', 'grass_block']);
const AIR = new Set(['air', 'cave_air', 'void_air']);
const STATIC_GRAVITY_FLOORS = new Set(['sand', 'red_sand', 'gravel']);
const SKIPPABLE = new Set(['house_fluid_unsafe', 'house_fluid_unloaded', 'house_fluid_protected',
  'house_fluid_no_safe_stance', 'house_fluid_no_safe_route', 'house_fluid_raytrace_blocked', 'house_fluid_no_safe_conversion', 'NoPath', 'Timeout']);

// Pure standing/refill support is distinct from permission to excavate.
// Natural gravity floors need a fully loaded, bounded chain to a stable base;
// floating sand, unknown support and other gravity blocks never qualify.
function inspectFluidSurfaceSupport(blockAt, floor) {
  const positions = [];
  if (typeof blockAt !== 'function' || !integer(floor)) return { safe: false, reason: 'invalid_floor', positions };
  for (let down = 0; down <= 8; down++) {
    const p = { ...floor, y: floor.y - down }, block = blockAt(vec(p)), c = classifyMiningBlock(block);
    positions.push(p);
    const full = block?.shapes?.some(shape => shape.length === 6 && shape.every((n, i) => n === (i < 3 ? 0 : 1)));
    if (!c.loaded || !full || c.hazard) return { safe: false, reason: c.loaded ? 'unsafe_floor' : 'unloaded_floor', positions };
    if (c.support) return { safe: true, reason: 'loaded_stable_support', positions };
    if (!c.gravity || !STATIC_GRAVITY_FLOORS.has(c.name)) return { safe: false, reason: 'unstable_floor', positions };
  }
  return { safe: false, reason: 'gravity_support_limit', positions };
}

// Native callbacks MUST check context.beforeSend at their actual world-writing
// boundary, after any awaited look/equip. assertActive must capture task/token/
// generation ownership. Optional operation timeouts are installed only when
// onOperationTimeout synchronously aborts that captured owner before rejecting.
function createHouseFluidResources(deps) {
  for (const name of ['getBot', 'assertActive', 'getCP', 'saveCP', 'moveTo', 'returnToCamp',
    'equipItem', 'lookAt', 'waitForTicks', 'activateItem']) {
    if (typeof deps[name] !== 'function') throw fail('house_fluid_dependency_missing', `原生流体采集缺少依赖：${name}`);
  }
  const limit = (name, fallback, max) => {
    const n = deps.limits?.[name] ?? fallback;
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw fail('house_fluid_invalid_limit', '流体采集上限必须是有限正整数');
    return n;
  };
  const limits = { searchRadius: limit('searchRadius', 48, 64), candidates: limit('candidates', 32, 64),
    readbackMs: limit('readbackMs', 5000, 30000), flowMs: limit('flowMs', 20000, 120000),
    timeoutMs: limit('timeoutMs', 180000, 1800000), operationTimeoutMs: limit('operationTimeoutMs', 30000, 1800000),
    operations: limit('operations', 160, 512), pollMs: limit('pollMs', 100, 1000) };
  const wait = deps.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let state = null, activeBot = null, busy = false, deadline = 0, operations = 0, cleaning = false;
  function active() {
    deps.assertActive();
    if (activeBot && deps.getBot() !== activeBot) throw fail('house_fluid_owner_changed', '连接已更换，停止旧流体任务');
    if (deadline && Date.now() >= deadline) throw fail('house_fluid_timeout', '本轮原生流体采集达到有限时限');
  }
  const bot = () => { active(); return deps.getBot(); };
  const at = p => {
    const block = bot().blockAt(vec(p));
    if (!block) throw fail('house_fluid_unloaded', '流体采集位置尚未完整加载', { position: plain(p) });
    return block;
  };
  const count = name => {
    const amount = bot().inventory.items().filter(i => i.name === name).reduce((sum, i) => sum + i.count, 0);
    if (!Number.isSafeInteger(amount) || amount < 0) throw fail('house_fluid_inventory_invalid', '真实流体材料库存无效');
    return amount;
  };
  const save = patch => { active(); Object.assign(state, patch); deps.saveCP(clone(state)); };
  const report = message => { active(); deps.report?.(message, { anchor: state.anchor }); };
  function protectedPosition(p) {
    if (state.excludeBounds.some(b => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY && p.z >= b.minZ && p.z <= b.maxZ)) {
      throw fail('house_fluid_protected', '不能改变建筑或营地受保护区域的流体和方块', { position: plain(p) });
    }
  }
  function protectedDigPosition(point) {
    protectedPosition(point);
    const dynamic = deps.getProtectedPositions?.() || [];
    if (!Array.isArray(dynamic) || dynamic.length > 8192 || dynamic.some(p => !integer(p))) {
      throw fail('house_fluid_invalid_protection', '已知路线支撑保护必须是有限整数坐标');
    }
    if ([...(state.protectedPositions || []), ...dynamic].some(p => same(p, point))) {
      throw fail('house_fluid_protected', '不能采挖已知矿道或建筑路线的支撑', { position: { ...point } });
    }
  }
  function notPlayerCell(p) {
    const e = bot().entity, half = (e.width || 0.6) / 2;
    const overlapsXZ = e.position.x + half > p.x && e.position.x - half < p.x + 1
      && e.position.z + half > p.z && e.position.z - half < p.z + 1;
    if (overlapsXZ && (e.position.y + (e.height || 1.8) > p.y && e.position.y < p.y + 1
      || Math.abs(e.position.y - p.y - 1) < 0.12)) throw fail('house_fluid_unsafe', '禁止改变机器人身体或脚下支撑格');
  }
  function dry(p) {
    return inspectFluidSurfaceSupport(q => at(q), { ...p, y: p.y - 1 }).safe
      && classifyMiningBlock(at(p)).passable && classifyMiningBlock(at({ ...p, y: p.y + 1 })).passable;
  }
  function grounded(expected) {
    const e = bot().entity, p = plain(e.position);
    if (!hasGroundedBodySupport(bot()) || Math.abs(e.position.y - p.y) > 0.075 || !dry(p)
      || expected && !same(expected, p)) throw fail('house_fluid_unsafe', '流体操作前没有确认真实干燥落稳站位');
  }
  function protectStandingSupport() {
    const p = plain(bot().entity.position), proof = inspectFluidSurfaceSupport(q => at(q), { ...p, y: p.y - 1 });
    if (!proof.safe) throw fail('house_fluid_unsafe', '静态站位支撑链未确认稳定');
    const positions = [...new Map([...(state.protectedPositions || []), ...proof.positions].map(q => [key(q), { ...q }])).values()];
    if (positions.length > 8192) throw fail('house_fluid_invalid_protection', '已确认站位支撑保护达到有限上限');
    save({ protectedPositions: positions });
  }
  async function native(name, operation, finalGuard = () => {}) {
    active();
    if (++operations > limits.operations + (cleaning ? 24 : 0)) throw fail('house_fluid_operation_limit', '原生流体操作达到有限上限');
    let open = true, timer;
    const assert = () => { if (!open) throw fail('house_fluid_operation_closed', '旧原生操作已经结束，禁止迟到写入'); active(); };
    const context = { assertActive: assert, beforeSend: () => { assert(); finalGuard(); }, noDig: true, noParkour: true, noScaffold: true };
    try {
      const pending = Promise.resolve().then(() => { assert(); return operation(context); });
      if (typeof deps.onOperationTimeout !== 'function') { const value = await pending; assert(); return value; }
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = fail('house_fluid_operation_timeout', `原生 ${name} 超时，暂停原任务以阻止迟到写入`);
          try { deps.onOperationTimeout(error); } catch (abortError) { error.abortError = abortError; }
          open = false; reject(error);
        }, limits.operationTimeoutMs);
      });
      const value = await Promise.race([pending, timeout]); assert(); return value;
    } finally { open = false; clearTimeout(timer); }
  }
  function bodyClear(position) {
    const e = bot().entity, half = (e.width || 0.6) / 2, height = e.height || 1.8, epsilon = 1e-6;
    for (let x = Math.floor(position.x - half); x <= Math.floor(position.x + half); x += 1) {
      for (let z = Math.floor(position.z - half); z <= Math.floor(position.z + half); z += 1) {
        for (let y = Math.floor(position.y); y <= Math.floor(position.y + height); y += 1) {
          const block = at({ x, y, z }), classification = classifyMiningBlock(block);
          if (classification.hazard || classification.gravity) throw fail('house_fluid_unsafe', '原生干燥行走身体范围出现危险方块', { position: { x, y, z } });
          for (const shape of block.shapes || []) {
            if (position.x + half > x + shape[0] + epsilon && position.x - half < x + shape[3] - epsilon
              && position.y + height > y + shape[1] + epsilon && position.y < y + shape[4] - epsilon
              && position.z + half > z + shape[2] + epsilon && position.z - half < z + shape[5] - epsilon) {
              throw fail('house_fluid_unsafe', '原生干燥行走实际身体与实心方块相交', { position: { x, y, z }, name: block.name });
            }
          }
        }
      }
    }
  }
  function planDryRoute(target, avoidFloors = []) {
    grounded(); bodyClear(bot().entity.position);
    const origin = plain(bot().entity.position);
    if (avoidFloors.some(p => same(p, { ...origin, y: origin.y - 1 }))) throw fail('house_fluid_protected', '不能从将要移除的路线支撑上开挖');
    if (same(origin, target)) return [];
    if (!dry(target) || typeof bot().pathfinder?.getPathFromTo !== 'function') {
      throw fail('house_fluid_no_safe_route', '没有真实已加载干燥目标或原装寻路规划器', { target, position: origin });
    }
    const movements = new Movements(bot());
    movements.canDig = false; movements.allowParkour = false; movements.allowSprinting = false;
    movements.allow1by1towers = false; movements.scafoldingBlocks = []; movements.maxDropDown = 2; movements.maxWaterDist = 0;
    // Only this private movement profile disables diagonal neighbors. Native
    // cardinal moves, native A* and native physics remain unchanged.
    movements.getMoveDiagonal = () => {};
    movements.exclusionAreasStep.push(cell => {
      if (!cell?.position || typeof cell.position.offset !== 'function') return 100;
      if (avoidFloors.some(p => same(p, cell.position.offset(0, -1, 0)))) return 100;
      const below = bot().blockAt(cell.position.offset(0, -1, 0)), floor = classifyMiningBlock(below);
      // Native exclusionStep also inspects head/clearance AIR cells. Only a
      // gravity block below this cell needs the bounded static-floor exception;
      // actual route feet are independently checked by dry() and grounded().
      if (!below || floor.hazard || floor.gravity
        && !inspectFluidSurfaceSupport(q => bot().blockAt(vec(q)), plain(cell.position.offset(0, -1, 0))).safe) return 100;
      for (const dy of [0, 1]) {
        const block = bot().blockAt(cell.position.offset(0, dy, 0)), classification = classifyMiningBlock(block);
        if (!block || classification.hazard || classification.gravity) return 100;
      }
      return 0;
    });
    const generator = bot().pathfinder.getPathFromTo(movements, bot().entity.position,
      new goals.GoalBlock(target.x, target.y, target.z), { optimizePath: false, timeout: 1000, tickTimeout: 50, searchRadius: 64 });
    let result;
    for (let iteration = 0; iteration < 32; iteration += 1) {
      active(); const next = generator.next(); result = next.value?.result;
      if (!result || result.status !== 'partial') break;
    }
    if (result?.status !== 'success' || !Array.isArray(result.path) || result.path.length > 96) {
      throw fail('house_fluid_no_safe_route', '原装寻路器没有找到有限逐格干燥路线', { target, position: origin, pathStatus: result?.status || null });
    }
    let previous = origin;
    const route = result.path.map(node => {
      const point = { x: node.x, y: node.y, z: node.z };
      if (!integer(point) || Math.abs(point.x - previous.x) + Math.abs(point.z - previous.z) !== 1
        || Math.abs(point.y - previous.y) > 1 || node.toBreak?.length || node.toPlace?.length || !dry(point)
        || avoidFloors.some(p => same(p, { ...point, y: point.y - 1 }))
        || point.y > previous.y && !classifyMiningBlock(at({ ...previous, y: previous.y + 2 })).passable) {
        throw fail('house_fluid_no_safe_route', '原装路线包含非逐格直角、改造或非干燥路段', { target, position: point });
      }
      bodyClear(vec(point).offset(0.5, 0, 0.5)); previous = point; return point;
    });
    if (!same(previous, target)) throw fail('house_fluid_no_safe_route', '原装路线未到达完整干燥目标', { target, position: previous });
    return route;
  }
  async function walkDryTo(target, avoidFloors = []) {
    // A native diagonal path crossed the actual stone corner in fluid02; the
    // server corrected it while client-only physics thought it was passable.
    // Cardinal loaded dry waypoints avoid that corner without pushing the bot
    // or changing its position, velocity, physics, blocks or native pathfinder.
    const route=planDryRoute(target, avoidFloors); let previous=plain(bot().entity.position);
    for (const next of route) {
      active(); grounded(previous);
      try {
        await native('dryCardinalMove', ctx => deps.moveTo(next, { ...ctx, strictCardinal: true, avoidFloors: clone(avoidFloors),
          assertActive: () => { ctx.assertActive(); bodyClear(bot().entity.position); } }), () => {
          active(); if(!dry(next))throw fail('house_fluid_unsafe','干燥路段在原生移动前发生变化');
        });
      } catch(error) {
        if(error.code==='house_fluid_operation_timeout')throw error;
        active();throw fail('house_fluid_dry_movement_failed','原生逐格干燥移动没有完成',{target:next,position:plain(bot().entity.position),cause:{code:error.code,message:error.message}});
      }
      grounded(next); bodyClear(bot().entity.position); protectStandingSupport(); previous=next;
      const p=bot().entity.position;
      save({lastDryMove:{target:{...target},position:{x:p.x,y:p.y,z:p.z},onGround:true}});
    }
    grounded(target);
    return route.map(p => ({ ...p, y: p.y - 1 }));
  }
  async function returnHome() {
    await walkDryTo(state.anchor);
    await native('returnToCamp', ctx => deps.returnToCamp(state.anchor, { ...ctx, strictCardinal: true })); grounded(state.anchor); bodyClear(bot().entity.position);
  }
  async function waitFor(predicate, code, message, duration = limits.readbackMs, stable = 1) {
    const end = Date.now() + duration; let samples = 0;
    do {
      active();
      if (predicate()) { if (++samples >= stable) return; } else samples = 0;
      if (Date.now() >= end) break;
      await wait(limits.pollMs);
    } while (true);
    throw fail(code, message);
  }
  function eye() { const e = bot().entity; return e.position.offset(0, e.eyeHeight || 1.62, 0); }
  function raytrace(target, mode, actualAim = false, plannedEye = null) {
    const origin = plannedEye || eye(), delta = vec(target).minus(origin), distance = delta.norm();
    if (distance > 4.5 || !distance || typeof bot().world?.raycast !== 'function') throw fail('house_fluid_raytrace_blocked', '桶交互缺少4.5格以内的原生射线');
    const { yaw, pitch } = bot().entity;
    const direction = actualAim ? new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)) : delta.normalize();
    for (let d = 0; d <= distance; d += 0.2) at(origin.plus(direction.scaled(d)).floored());
    const matcher = mode === 'pickup' ? (block, iterator) => {
      if (source(block, 'water') || source(block, 'lava')) return true;
      return Boolean(iterator.intersect(block.shapes, block.position));
    } : null;
    return bot().world.raycast(origin, direction, actualAim ? 4.5 : Math.min(4.5, distance + 0.03), matcher);
  }
  function pickupGuard(p, stance, actualAim = false) {
    grounded(stance); protectedPosition(p); notPlayerCell(p);
    if (!source(at(p), 'water') || !same(raytrace({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 }, 'pickup', actualAim)?.position, p)) {
      throw fail('house_fluid_raytrace_blocked', '真实桶射线已不再命中指定静止水源');
    }
  }
  function stances(target) {
    const found = [], seen = new Set();
    for (let radius = 1; radius <= 3; radius += 1) for (let dx = -radius; dx <= radius; dx += 1) for (let dz = -radius; dz <= radius; dz += 1) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
      for (const dy of [0, 1, -1]) {
        const p = { x: target.x + dx, y: target.y + dy, z: target.z + dz };
        try {
          if (dry(p) && vec(p).offset(0.5, 1.62, 0.5).distanceTo(vec(target).offset(0.5, 0.5, 0.5)) <= 4.4 && !seen.has(key(p))) {
            seen.add(key(p)); found.push(p);
          }
        } catch (error) { if (!SKIPPABLE.has(error.code)) throw error; }
      }
    }
    return found.sort((a, b) => vec(a).distanceTo(bot().entity.position) - vec(b).distanceTo(bot().entity.position)).slice(0, 24);
  }
  async function reach(target, check, candidateCheck = () => {}) {
    const errors = [];
    for (const stance of stances(target)) {
      try {
        candidateCheck(stance);
        await walkDryTo(stance);
        grounded(stance); check(stance); return stance;
      } catch (error) { if (!SKIPPABLE.has(error.code)) throw error; active(); errors.push({ code: error.code || null, reason: error.message, position: { ...stance }, target: error.target || null, pathStatus: error.pathStatus || null, cause: error.cause || null }); }
    }
    throw fail('house_fluid_no_safe_stance', '没有确认可原生到达、可交互的干燥站位', { reasons: [...new Set(errors.map(error => error.reason))].slice(0, 8), rejected: errors });
  }
  async function equip(name) {
    if (count(name) < 1) throw fail('house_fluid_materials_missing', `缺少真实 ${name}`);
    await native('equipItem', ctx => deps.equipItem(name, ctx));
    if (bot().heldItem?.name !== name) throw fail('house_fluid_equip_failed', `没有确认手持 ${name}`);
  }
  async function use(point, guard) {
    await native('lookAt', ctx => deps.lookAt(point, ctx));
    await native('waitForTicks', ctx => deps.waitForTicks(1, ctx));
    guard();
    await native('activateItem', ctx => deps.activateItem(ctx), guard);
  }
  function sources(names) {
    if (typeof bot().findBlocks !== 'function') throw fail('house_fluid_search_unavailable', '缺少真实已加载方块搜索');
    const wanted = new Set(names);
    return bot().findBlocks({ point: vec(state.anchor), matching: b => wanted.has(b?.name),
      maxDistance: limits.searchRadius, count: limits.candidates, useExtraInfo: true }).map(plain);
  }
  function replenishable(p) {
    return inspectFluidSurfaceSupport(q => at(q), { ...p, y: p.y - 1 }).safe
      && SIDES.filter(d => source(at(offset(p, d)), 'water')).length >= 2;
  }
  async function pickup(p, { owned = false } = {}) {
    protectedPosition(p); notPlayerCell(p);
    if (!source(at(p), 'water')) throw fail('house_fluid_unsafe', '指定取水格已不再是静止水源');
    const stance = await reach(p, s => pickupGuard(p, s));
    await equip('bucket');
    const before = { bucket: count('bucket'), water: count('water_bucket') };
    const mayRefill = !owned && replenishable(p);
    await use({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 }, () => {
      pickupGuard(p, stance, true);
      if (mayRefill && !replenishable(p)) throw fail('house_fluid_unsafe', '取水前补满源的已加载支撑或邻源已改变');
    });
    await waitFor(() => count('bucket') === before.bucket - 1 && count('water_bucket') === before.water + 1
      && (!source(at(p), 'water') || mayRefill && replenishable(p)), 'house_fluid_water_unconfirmed', '没有同时确认原生取水与真实桶库存变化');
    return { source: { ...p }, sourceStillPresent: source(at(p), 'water'), mayRefill };
  }
  function noUnsafeDigNeighbor(p) { return FACES.every(d => { const c = classifyMiningBlock(at(offset(p, d))); return !c.hazard && !c.gravity; }); }
  function noNeighborFluid(p) { return FACES.every(d => !classifyMiningBlock(at(offset(p, d))).fluid); }
  function obsidianGuard(p, stance) {
    if (stance) grounded(stance);
    protectedDigPosition(p); notPlayerCell(p);
    if (at(p).name !== 'obsidian' || !noUnsafeDigNeighbor(p) || !classifyMiningBlock(at({ ...p, y: p.y - 1 })).support) {
      throw fail('house_fluid_unsafe', '黑曜石周围仍有流体、未知空间或不安全支撑');
    }
    const tool = bot().heldItem;
    const durability = bot().registry.items[tool?.type]?.maxDurability - Number(tool?.durabilityUsed || 0);
    if (!tool || tool.name !== 'diamond_pickaxe' || durability < 8 || !at(p).canHarvest(tool.type)) {
      throw fail('house_fluid_tool_required', '黑曜石需要真实足够耐久、可采出物品的钻石镐');
    }
    if (!stance) return;
    if (typeof bot().canDigBlock !== 'function' || !bot().canDigBlock(at(p))
      || !same(raytrace(vec(p).offset(0.5, 0.5, 0.5), 'dig')?.position, p)) {
      throw fail('house_fluid_raytrace_blocked', '黑曜石没有确认原生挖掘距离与视线');
    }
  }
  async function mineObsidian(p) {
    if (typeof deps.digBlock !== 'function' || typeof deps.collectDrops !== 'function') throw fail('house_fluid_dependency_missing', '缺少原生黑曜石挖掘或拾取回调');
    await equip('diamond_pickaxe');
    obsidianGuard(p);
    const stance = await reach(p, s => obsidianGuard(p, s));
    const before = count('obsidian');
    await native('digBlock', ctx => deps.digBlock(at(p), ctx), () => obsidianGuard(p, stance));
    await waitFor(() => classifyMiningBlock(at(p)).passable, 'house_fluid_dig_unconfirmed', '没有确认服务端黑曜石挖空');
    if (count('obsidian') <= before) {
      // Standing beside a floor ore can leave its drop one level below pickup
      // range. Enter only the newly confirmed dry cell with solid dry support.
      if (!dry(p) || !noUnsafeDigNeighbor(p)) throw fail('house_fluid_unsafe', '黑曜石掉落处不是确认干燥的安全立足点');
      await walkDryTo(p);
      grounded(p);
    }
    await native('collectDrops', ctx => deps.collectDrops({ position: { ...p }, allowMovement: false, ...ctx }));
    await waitFor(() => count('obsidian') >= before + 1, 'house_fluid_drop_unconfirmed', '实际背包没有新增黑曜石，不能用挖掘计数代替');
    save({ minedObsidian: [...new Set([...(state.minedObsidian || []), key(p)])] });
  }
  function conversionPlan(lava, water, closed = false) {
    protectedPosition(lava); protectedPosition(water); protectedPosition({ ...water, y: water.y - 1 });
    notPlayerCell(lava); notPlayerCell(water);
    if (!source(at(lava), 'lava') || !classifyMiningBlock(at({ ...lava, y: lava.y - 1 })).support
      || !classifyMiningBlock(at({ ...lava, y: lava.y + 1 })).passable
      || !(closed ? NATURAL_PLUGS.has(at(water).name) && classifyMiningBlock(at(water)).support : classifyMiningBlock(at(water)).passable)
      || !classifyMiningBlock(at({ ...water, y: water.y + 1 })).passable
      || !classifyMiningBlock(at({ ...water, y: water.y - 1 })).support) throw fail('house_fluid_no_safe_conversion', '熔岩不是已加载、浅层、带干燥实心底的可控水冷目标');
    if (FACES.some(d => classifyMiningBlock(at(offset(lava, d))).fluid)) throw fail('house_fluid_no_safe_conversion', '相邻仍有流体的深池或未知池形不能安全采黑曜石');
    // A three-sided dry solid bowl prevents the introduced source from flowing
    // into the standing route. Its fourth side is exactly the lava source.
    if (SIDES.some(d => !same(offset(water, d), lava) && !classifyMiningBlock(at(offset(water, d))).support)) {
      throw fail('house_fluid_no_safe_conversion', '倒水空格没有三面实心围挡，不能让水流侵入行走路线');
    }
    if (closed) {
      if (SIDES.some(d => !classifyMiningBlock(at(offset(lava, d))).support)) throw fail('house_fluid_no_safe_conversion', '天然源岩浆未被四面实心天然地形封住，不能安全开口');
      protectedDigPosition(water);
    }
    return { lava: { ...lava }, water: { ...water }, reference: { ...water, y: water.y - 1 } };
  }
  // Prospective planning is pure segment/AABB geometry over real loaded
  // shapes. Only the explicitly proposed plug is omitted from this analysis.
  // It never mutates world/raycast or authorizes a bucket packet: actual AIR
  // and the native actual-rotation ray are mandatory after the native dig.
  function segmentHit(origin, delta, block, shape) {
    let near = 0, far = 1, face = null;
    for (const [axis, lo, hi, lowFace, highFace] of [['x', 0, 3, 4, 5], ['y', 1, 4, 0, 1], ['z', 2, 5, 2, 3]]) {
      const min = block.position[axis] + shape[lo], max = block.position[axis] + shape[hi];
      if (Math.abs(delta[axis]) < 1e-9) { if (origin[axis] < min || origin[axis] > max) return null; continue; }
      let enter = (min - origin[axis]) / delta[axis], exit = (max - origin[axis]) / delta[axis], enterFace = lowFace;
      if (enter > exit) { [enter, exit] = [exit, enter]; enterFace = highFace; }
      if (enter > near) { near = enter; face = enterFace; }
      far = Math.min(far, exit); if (near > far + 1e-9) return null;
    }
    return near <= 1 && far >= 0 ? { distance: near, face, position: block.position } : null;
  }
  function prospectivePour(plan, origin) {
    const aim = vec(plan.water).offset(0.5, -0.001, 0.5), delta = aim.minus(origin);
    if (delta.norm() > 4.4) throw fail('house_fluid_raytrace_blocked', '天然封口挖开后的倒水射线超距');
    let first = null;
    for (let x = Math.floor(Math.min(origin.x, aim.x)); x <= Math.floor(Math.max(origin.x, aim.x)); x += 1) {
      for (let y = Math.floor(Math.min(origin.y, aim.y)); y <= Math.floor(Math.max(origin.y, aim.y)); y += 1) {
        for (let z = Math.floor(Math.min(origin.z, aim.z)); z <= Math.floor(Math.max(origin.z, aim.z)); z += 1) {
          const block = at({ x, y, z }); if (same(block.position, plan.water)) continue;
          for (const shape of block.shapes || []) {
            const hit = segmentHit(origin, delta, block, shape);
            if (hit && (!first || hit.distance < first.distance)) first = hit;
          }
        }
      }
    }
    if (!same(first?.position, plan.reference) || first.face !== 1) {
      throw fail('house_fluid_raytrace_blocked', '没有确认封口挖开后能从同一安全站位命中水槽底部上表面');
    }
  }
  function closedPlugGuard(plan, stance, approachFloors) {
    grounded(stance); conversionPlan(plan.lava, plan.water, true); protectedDigPosition(plan.water); notPlayerCell(plan.water);
    if (approachFloors.some(p => same(p, plan.water))) throw fail('house_fluid_protected', '不能挖掉本次进出水槽路线的支撑');
    const block = at(plan.water), tool = bot().heldItem;
    const durability = bot().registry.items[tool?.type]?.maxDurability - Number(tool?.durabilityUsed || 0);
    if (tool?.name !== 'diamond_pickaxe' || durability < 9 || !block.canHarvest(tool.type)) {
      throw fail('house_fluid_tool_required', '天然封口和黑曜石需要足够真实耐久的钻石镐');
    }
    if (!bot().canDigBlock?.(block) || !same(raytrace(vec(plan.water).offset(0.5, 0.5, 0.5), 'dig')?.position, plan.water)) {
      throw fail('house_fluid_raytrace_blocked', '天然封口没有实际挖掘距离与视线');
    }
    prospectivePour(plan, eye());
  }
  async function openClosedPocket(lava, water) {
    if (typeof deps.digBlock !== 'function' || typeof deps.collectDrops !== 'function') throw fail('house_fluid_dependency_missing', '缺少原生封口挖掘或真实拾取回调');
    const plan = conversionPlan(lava, water, true); await equip('diamond_pickaxe');
    const rejected = [];
    for (const stance of stances(water)) {
      try {
        conversionPlan(lava, water, true);
        if (same({ ...stance, y: stance.y - 1 }, water)) continue;
        prospectivePour(plan, vec(stance).offset(0.5, bot().entity.eyeHeight || 1.62, 0.5));
        const originFloor = { ...plain(bot().entity.position), y: plain(bot().entity.position).y - 1 };
        const approachFloors = [originFloor, ...await walkDryTo(stance, [water])];
        closedPlugGuard(plan, stance, approachFloors);
        const from = at(water).name;
        await native('digNaturalLavaPlug', ctx => deps.digBlock(at(water), { ...ctx, role: 'natural_lava_plug' }),
          () => closedPlugGuard(plan, stance, approachFloors));
        await waitFor(() => AIR.has(at(water).name), 'house_fluid_plug_unconfirmed', '天然封口没有确认挖空，或岩浆已经流入水槽');
        save({ openedNaturalPlugs: [...(state.openedNaturalPlugs || []), { position: { ...water }, from, dug: true }] });
        // No move or drop collection is inserted between opening the plug and
        // pouring from this same, already confirmed native stance.
        return { stance, plan };
      } catch (error) {
        if (!SKIPPABLE.has(error.code)) throw error;
        active(); rejected.push({ code: error.code, reason: error.message, position: stance });
      }
    }
    throw fail('house_fluid_no_safe_stance', '天然封闭浅岩浆没有同时可挖封口、可原地倒水的干燥站位', { rejected });
  }
  function pourRay(plan, actualAim = false, plannedEye = null) {
    const aim = { x: plan.water.x + 0.5, y: plan.water.y - 0.001, z: plan.water.z + 0.5 };
    const hit = raytrace(aim, 'pour', actualAim, plannedEye);
    if (!same(hit?.position, plan.reference) || hit.face !== 1) {
      throw fail('house_fluid_raytrace_blocked', '倒水射线没有命中已确认空格下方支撑的上表面');
    }
  }
  function pourGuard(plan, stance, actualAim = true) {
    grounded(stance); conversionPlan(plan.lava, plan.water); pourRay(plan, actualAim);
    if (bot().heldItem?.name !== 'water_bucket') throw fail('house_fluid_equip_failed', '倒水发送前手持物已改变');
  }
  async function clearPendingConversion() {
    const p = state.pendingConversion;
    if (!p) return null;
    if (source(at(p.water), 'water')) {
      const hasDebit = count('water_bucket') === p.waterBefore - 1 && count('bucket') === p.bucketBefore + 1;
      if (!p.ownedSourceConfirmed && (!p.sendAttempted || !hasDebit)) throw fail('house_fluid_conversion_unconfirmed', '不能认领未确认由本任务倒出的水源');
      await pickup(p.water, { owned: true });
    } else if (classifyMiningBlock(at(p.water)).fluid) throw fail('house_fluid_conversion_unconfirmed', '转换水源状态不明确，停止后续挖掘');
    else if (source(at(p.lava), 'lava') && count('water_bucket') === p.waterBefore && count('bucket') === p.bucketBefore) {
      save({ pendingConversion: null }); return null;
    } else if (!p.ownedSourceConfirmed && !(at(p.lava).name === 'obsidian' && p.sendAttempted
      && count('water_bucket') >= p.waterBefore && count('bucket') <= p.bucketBefore)) {
      throw fail('house_fluid_conversion_unconfirmed', '无法确认迟到水源的归属与回收结果');
    }
    await waitFor(() => noNeighborFluid(p.lava) && !classifyMiningBlock(at(p.water)).fluid,
      'house_fluid_flow_not_settled', '回收水源后真实水流仍未消退，禁止挖黑曜石', limits.flowMs, 3);
    const converted = at(p.lava).name === 'obsidian';
    save({ pendingConversion: null, conversions: [...(state.conversions || []),
      { lava: p.lava, water: p.water, converted, waterRecovered: true }] });
    return converted ? p.lava : null;
  }
  async function convert(lava, water, fixedStance = null) {
    const plan = conversionPlan(lava, water);
    await equip('water_bucket');
    const stance = fixedStance || await reach(water, s => pourGuard(plan, s, false),
      s => pourRay(plan, false, vec(s).offset(0.5, bot().entity.eyeHeight || 1.62, 0.5)));
    if (fixedStance) { if (!AIR.has(at(water).name)) throw fail('house_fluid_unsafe', '天然封口挖后已不再是实际空气格'); pourGuard(plan, stance, false); }
    const pending = { ...plan, waterBefore: count('water_bucket'), bucketBefore: count('bucket'), sendAttempted: false, ownedSourceConfirmed: false };
    save({ pendingConversion: pending });
    const guard = () => { pourGuard(plan, stance); pending.sendAttempted = true; save({ pendingConversion: pending }); };
    await use({ x: water.x + 0.5, y: water.y - 0.001, z: water.z + 0.5 }, guard);
    await waitFor(() => source(at(water), 'water') && count('water_bucket') === pending.waterBefore - 1
      && count('bucket') === pending.bucketBefore + 1, 'house_fluid_pour_unconfirmed', '没有同时确认原生水源放置与桶的真实消耗');
    pending.ownedSourceConfirmed = true; save({ pendingConversion: pending });
    let conversionError;
    try { await waitFor(() => at(lava).name === 'obsidian', 'house_fluid_conversion_failed', '自然水流没有确认把目标源熔岩转为黑曜石', limits.flowMs); }
    catch (error) { active(); conversionError = error; }
    const result = await clearPendingConversion();
    if (conversionError) throw conversionError;
    if (!result) throw fail('house_fluid_conversion_failed', '回收水后没有确认目标黑曜石');
    return result;
  }
  function initialize(anchor, excludeBounds, protectedPositions) {
    if (!Array.isArray(protectedPositions) || protectedPositions.length > 8192 || protectedPositions.some(p => !integer(p))) throw fail('house_fluid_invalid_protection', '路线支撑保护需要有限整数坐标');
    if (!integer(anchor) || !Array.isArray(excludeBounds) || excludeBounds.some(b => !b
      || !['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'].every(k => Number.isSafeInteger(b[k]))
      || b.minX > b.maxX || b.minY > b.maxY || b.minZ > b.maxZ)) throw fail('house_fluid_invalid_request', '流体资源需要整数营地和有限保护区域');
    const previous = deps.getCP();
    if (previous && (previous.schema !== 1 || !same(previous.anchor, anchor))) throw fail('house_fluid_checkpoint_mismatch', '流体恢复不得更换营地或checkpoint版本');
    state = previous ? clone(previous) : { schema: 1, anchor: { ...anchor }, confirmedWater: [], conversions: [], minedObsidian: [] };
    state.excludeBounds = [...new Map([...(state.excludeBounds || []), ...excludeBounds].map(b => [JSON.stringify(b), clone(b)])).values()];
    state.protectedPositions = [...new Map([...(state.protectedPositions || []), ...protectedPositions].map(p => [key(p), { ...p }])).values()];
    if (state.protectedPositions.length > 8192) throw fail('house_fluid_invalid_protection', '路线支撑保护达到有限上限');
    grounded(anchor); protectStandingSupport();
  }
  async function run(resource, additional, options, operation) {
    if (busy) throw fail('house_fluid_busy', '不能并发修改同一流体资源任务');
    if (!Number.isSafeInteger(additional) || additional < 1 || additional > (resource === 'water_bucket' ? 2 : 4)) throw fail('house_fluid_invalid_request', '水桶每批1至2、黑曜石每批1至4');
    busy = true; activeBot = deps.getBot(); deadline = Date.now() + limits.timeoutMs; operations = 0; cleaning = false;
    try {
      active(); initialize(options?.anchor, options?.excludeBounds || [], options?.protectedPositions || []);
      const before = count(resource), target = before + additional;
      await operation(target); active();
      await returnHome();
      const after = count(resource);
      if (after < target || state.pendingConversion) throw fail('house_fluid_inventory_unconfirmed', '回营后没有确认实际新增流体材料或仍有未回收水源');
      save({ lastGather: { resource, before, after, actualAdditional: after - before, returnedToCamp: true } });
      return { confirmed: true, resource, before, after, additional: after - before, anchor: clone(state.anchor) };
    } catch (error) {
      let mayAct = deps.getBot() === activeBot;
      try { deps.assertActive(); } catch { mayAct = false; }
      if (mayAct && state) {
        // Ordinary search/readback limits allow one bounded cleanup tail.
        // Paused/cancelled/replaced owners never issue cleanup world writes.
        cleaning = true; deadline = Date.now() + limits.flowMs + limits.readbackMs + 4 * limits.operationTimeoutMs;
        try { if (state.pendingConversion) await clearPendingConversion(); await returnHome(); }
        catch (cleanupError) { error.cleanupError = { code: cleanupError.code, message: cleanupError.message }; }
      }
      throw error;
    } finally { busy = false; activeBot = null; deadline = 0; cleaning = false; }
  }
  async function gatherWater(additional, options) {
    return run('water_bucket', additional, options, async target => {
      if (state.pendingConversion) throw fail('house_fluid_pending_conversion', '先恢复并回收本任务已有转换水源');
      if (typeof deps.ensureBucket !== 'function') throw fail('house_fluid_dependency_missing', '缺少原生合成空桶回调');
      const needed = target - count('water_bucket');
      await native('ensureBucket', ctx => deps.ensureBucket(needed, { ...ctx, anchor: state.anchor })); grounded(state.anchor);
      if (count('bucket') < needed) throw fail('house_fluid_materials_missing', '原生合成回调后没有确认足够空桶');
      const rejected = [];
      for (const p of sources(['water'])) {
        if (count('water_bucket') >= target) break;
        try {
          if (!source(at(p), 'water')) continue;
          const result = await pickup(p); save({ confirmedWater: [...state.confirmedWater, result] });
          report('已同时确认原生取水与真实水桶库存增长');
        } catch (error) { if (!SKIPPABLE.has(error.code)) throw error; active(); rejected.push({ code: error.code, reason: error.message, position: p, rejected: error.rejected || [], reasons: error.reasons || [], cause: error.cause || null }); }
      }
      if (count('water_bucket') < target) throw fail('house_fluid_source_not_found', '已加载有限范围内没有足够可安全取用的源水', { rejected });
    });
  }
  async function gatherObsidian(additional, options) {
    return run('obsidian', additional, options, async target => {
      if (typeof deps.ensureDiamondPickaxe !== 'function') throw fail('house_fluid_dependency_missing', '缺少真实钻石镐准备回调');
      const pending = await clearPendingConversion();
      if (pending) await returnHome();
      await native('ensureDiamondPickaxe', ctx => deps.ensureDiamondPickaxe({ ...ctx, minDurability: additional * 2 + 8, anchor: state.anchor }));
      if (pending) await mineObsidian(pending);
      const rejected = [];
      for (const p of sources(['obsidian'])) {
        if (count('obsidian') >= target) break;
        try { await mineObsidian(p); }
        catch (error) { if (!SKIPPABLE.has(error.code)) throw error; active(); rejected.push({ code: error.code, reason: error.message, position: p, rejected: error.rejected || [], reasons: error.reasons || [], cause: error.cause || null }); }
      }
      if (count('obsidian') < target && count('water_bucket') < 1) throw fail('house_fluid_materials_missing', '自然水冷黑曜石需要真实水桶');
      for (const lava of count('obsidian') < target ? sources(['lava']) : []) {
        if (count('obsidian') >= target) break;
        let converted = false;
        for (const d of SIDES) {
          try {
            const water = offset(lava, d);
            let fixedStance = null;
            if (!classifyMiningBlock(at(water)).passable) fixedStance = (await openClosedPocket(lava, water)).stance;
            const p = await convert(lava, water, fixedStance); await mineObsidian(p); converted = true; break;
          }
          catch (error) { if (!SKIPPABLE.has(error.code)) throw error; active(); rejected.push({ code: error.code, reason: error.message, position: lava, rejected: error.rejected || [], reasons: error.reasons || [], cause: error.cause || null }); }
        }
        if (converted) report('已确认自然源熔岩水冷、原水回收、流体消退及黑曜石真实拾取');
      }
      if (count('obsidian') < target) throw fail('house_fluid_no_safe_source', '没有足够已加载、可安全采掘或浅层水冷的黑曜石来源', { rejected });
    });
  }
  return { gatherWater, gatherObsidian, getState: () => state ? clone(state) : null };
}

module.exports = { createHouseFluidResources, inspectFluidSurfaceSupport };
