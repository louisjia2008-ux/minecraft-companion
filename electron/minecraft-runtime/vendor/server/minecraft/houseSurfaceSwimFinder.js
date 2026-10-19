/* global require, module */
'use strict';
const { isNaturalWalkingBodyBlock } = require('./houseNaturalWalkingBody');
// Reads only this client's currently loaded blocks. No MCA, file,
// network, resource coordinates, controls, goal or movement profile writes.
function createSurfaceSwimFinderAPI(nativeSafety) {
  for (const name of ['dryFoot', 'hasGroundedBodySupport', 'stableSupport', 'inspectBody', 'readHouseBotOxygen', 'NativeMove', 'validateSurfaceRoute', 'routeFrame']) {
    if (typeof nativeSafety?.[name] !== 'function') throw new TypeError(`Immutable native finder safety ${name} is required`);
  }
  const { dryFoot, hasGroundedBodySupport, stableSupport, inspectBody, readHouseBotOxygen, NativeMove, validateSurfaceRoute, routeFrame } = nativeSafety;
const fail = (code, message, facts = {}) => Object.assign(new Error(message), { code, ...facts });
const point = p => ({ x: p.x, y: p.y, z: p.z });
const integer = p => p && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(p[axis]));
const air = b => b && ['air', 'cave_air', 'void_air'].includes(b.name);
const source = b => b?.name === 'water' && [0, '0'].includes(b.getProperties?.().level);
const hazards = new Set(['lava', 'bubble_column', 'magma_block', 'fire', 'soul_fire', 'cactus', 'powder_snow', 'campfire', 'soul_campfire', 'sweet_berry_bush']);
const safeSide = b => b && !hazards.has(b.name) && ![true, 'true'].includes(b.getProperties?.().waterlogged) && (b.name !== 'water' || source(b));
const directions = [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }];
function routeIdentity(route) {
  const frame = routeFrame(route);
  return `source_water_surface:${route.surfaceY}:${[`${route.from.x},${route.from.z}`, `${route.to.x},${route.to.z}`].sort().join('|')}:${route.width}:${frame.d.x ? 'x' : 'z'}`;
}
function limit(options, name, fallback, minimum, maximum) {
  const value = options[name] ?? fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw fail('surface_swim_discovery_invalid_limit', `${name}必须在${minimum}..${maximum}有限范围`);
  return value;
}
function createLoadedSurfaceSwimFinder(deps) {
  const { Vec3, Movements, GoalBlock } = deps;
  if (!Vec3 || !Movements || !GoalBlock || typeof deps.getBot !== 'function' || typeof deps.assertActive !== 'function') throw new TypeError('Surface finder needs original native pathfinder dependencies and captured owner');
  function find(options = {}) {
    deps.assertActive();
    const bot = deps.getBot(), client = bot?._client, origin = options.origin;
    if (!bot?.entity?.position || !integer(origin) || bot.entity.onGround !== true || bot.entity.isInWater !== false || bot.entity.isInLava !== false) throw fail('surface_swim_discovery_origin_unknown', '必须从当前实际落稳干燥整数图节点发现');
    const actualOrigin = () => Math.floor(bot.entity.position.x) === origin.x && Math.floor(bot.entity.position.z) === origin.z
      && Math.abs(bot.entity.position.y - origin.y) <= .075;
    if (!actualOrigin()) throw fail('surface_swim_discovery_origin_not_actual', '不能从旧坐标或远处节点发现游泳路线');
    const readLimit = limit(options, 'readLimit', 16384, 1, 65536), probeLimit = limit(options, 'probeLimit', 8, 1, 16);
    const resultLimit = limit(options, 'resultLimit', 4, 1, 8), maximumWidth = limit(options, 'maximumWidth', 64, 1, 64);
    const horizontalRadius = limit(options, 'horizontalRadius', 16, 1, 16), verticalRadius = limit(options, 'verticalRadius', 4, 0, 8);
    const scanTimeoutMs = limit(options, 'scanTimeoutMs', 750, 1, 2000), deadline = Date.now() + scanTimeoutMs;
    const cache = new Map(), routes = [], rejections = {}, seen = new Set(options.seenRouteIds || []);
    let reads = 0, probes = 0, candidates = 0, stopped = null;
    const budgetCodes = ['surface_swim_discovery_read_budget', 'surface_swim_discovery_probe_budget', 'surface_swim_discovery_deadline'];
    const check = () => {
      deps.assertActive();
      if (deps.getBot() !== bot || bot._client !== client) throw fail('surface_swim_discovery_owner_changed', '当前机器人或连接在发现期间更换');
      if (Date.now() >= deadline) throw fail('surface_swim_discovery_deadline', '有限客户端加载几何扫描时间已到');
    };
    const read = raw => {
      check();
      if (!integer(raw)) throw fail('surface_swim_discovery_position_invalid', '扫描只能读取实际整数格');
      const position = new Vec3(raw.x, raw.y, raw.z), key = `${position.x},${position.y},${position.z}`;
      if (cache.has(key)) return cache.get(key);
      if (reads >= readLimit) throw fail('surface_swim_discovery_read_budget', '客户端块读取预算已用完');
      reads++; const block = bot.blockAt(position); cache.set(key, block); return block;
    };
    const loaded = Object.create(bot); loaded.blockAt = read;
    const reject = code => { rejections[code] = (rejections[code] || 0) + 1; };
    const oxygen = () => {
      const own = readHouseBotOxygen(bot);
      if (own.oxygenLevel !== null && own.oxygenLevel < 18) throw fail('surface_swim_discovery_oxygen_low', '本玩家原生metadata确认氧气不足18；全局动物氧气不能覆盖', own);
      return own;
    };
    function nearBank(bank, direction) {
      const tangent = { x: -direction.z, z: direction.x };
      try {
        stableSupport(loaded, { ...bank, y: bank.y - 1 }, Vec3);
        for (let j = -1; j <= 1; j++) {
          const p = { x: bank.x + tangent.x * j, y: bank.y, z: bank.z + tangent.z * j };
          if (j && !safeSide(read(new Vec3(p.x, p.y - 1, p.z)))) return false;
          for (let up = 0; up < 4; up++) if (!air(read(new Vec3(p.x, p.y + up, p.z)))) return false;
        }
        return true;
      } catch (error) { if (budgetCodes.includes(error.code)) throw error; return false; }
    }
    const profile = new Movements(loaded);
    profile.canDig = false; profile.scafoldingBlocks = []; profile.allowParkour = false; profile.allow1by1towers = false;
    profile.allowSprinting = false; profile.allowFreeMotion = false; profile.infiniteLiquidDropdownDistance = false;
    // Installed getLandingBlock counts the support floor:2 means an actual
    // one-block downward dry step, not permission to fall two foot levels.
    profile.maxDropDown = 2; profile.maxWaterDist = 0; profile.getMoveDiagonal = () => {};
    for (const name of [...hazards, 'water']) { const id = bot.registry.blocksByName[name]?.id; if (id !== undefined) profile.blocksToAvoid.add(id); }
    // Native safeOrBreak queries both feet and head cells; only final path
    // nodes are feet. Fresh safe natural body clearance applies to the dry
    // approach; the bank and water corridor still require strict AIR.
    profile.exclusionAreasStep.push(block => block?.position && integer(block.position)
      && (air(read(block.position)) || isNaturalWalkingBodyBlock(read(block.position))) ? 0 : Infinity);
    function nativeProbe(bank) {
      check(); if (probes >= probeLimit) throw fail('surface_swim_discovery_probe_budget', '原生干地接近路径探查预算已用完'); probes++;
      const startMove = new NativeMove(origin.x, origin.y, origin.z, profile.countScaffoldingItems(), 0);
      const iterator = bot.pathfinder.getPathFromTo(profile, bot.entity.position, new GoalBlock(bank.x, bank.y, bank.z), {
        startMove, optimizePath: false, timeout: Math.min(120, Math.max(1, deadline - Date.now())), tickTimeout: 10, searchRadius: 18,
      });
      let result;
      for (let iteration = 0; iteration < 16; iteration++) {
        check(); const next = iterator.next(); result = next.value?.result;
        if (next.done || !result || result.status !== 'partial') break;
      }
      if (result?.status !== 'success') throw fail('surface_swim_discovery_approach_unreachable', '原装pathfinder没有发现到岸边的干地路', { nativeStatus: result?.status || null });
      let previous = origin, length = Math.hypot(bot.entity.position.x - origin.x - .5, bot.entity.position.y - origin.y, bot.entity.position.z - origin.z - .5);
      const plannedPath = [];
      if (!dryFoot(loaded, origin)) throw fail('surface_swim_discovery_origin_unsafe', '实际起点在扫描期间不再干燥');
      for (const step of result.path || []) {
        if (!integer(step) || step.toBreak?.length || step.toPlace?.length || !dryFoot(loaded, step)) throw fail('surface_swim_discovery_path_unsafe', '原生接近路包含未知、液体、挖掘或放置');
        const dx = Math.abs(step.x - previous.x), dz = Math.abs(step.z - previous.z), dy = Math.abs(step.y - previous.y);
        if (dx + dz > 1 || dy > 1) throw fail('surface_swim_discovery_path_noncardinal', '干地接近只允许原生一格cardinal路径');
        length += Math.hypot(dx, dy, dz);
        if (length > 16 + 1e-8) throw fail('surface_swim_discovery_approach_over16', '实际原生计划干路超过16米');
        plannedPath.push(point(step)); previous = step;
      }
      if (!['x', 'y', 'z'].every(axis => previous[axis] === bank[axis])) throw fail('surface_swim_discovery_path_incomplete', '原生接近终点不是声明的岸格');
      return { from: point(origin), to: point(bank), plannedPath, plannedLength: length, nativeStatus: 'success', optimizePath: false,
        actualConfirmed: false, actualMovementPerformed: false, requiredCenteredBankTolerance: .15,
        profile: { canDig: false, canPlace: false, parkour: false, sprint: false, diagonal: false, maxDropDown: 2 } };
    }
    const offsets = [];
    for (let dx = -horizontalRadius; dx <= horizontalRadius; dx++) for (let dz = -horizontalRadius; dz <= horizontalRadius; dz++) for (let dy = -verticalRadius; dy <= verticalRadius; dy++) {
      const distance = Math.hypot(dx, dy, dz); if (distance <= 16) offsets.push({ dx, dy, dz, distance });
    }
    offsets.sort((a, b) => a.distance - b.distance || Math.abs(a.dy) - Math.abs(b.dy) || a.dx - b.dx || a.dz - b.dz);
    try {
      inspectBody(loaded, Vec3); oxygen();
      if (!dryFoot(loaded, origin) || !hasGroundedBodySupport(loaded)) throw fail('surface_swim_discovery_origin_unsafe', '当前干地起点没有真实身体支撑');
      for (const offset of offsets) {
        check(); const bank = { x: origin.x + offset.dx, y: origin.y + offset.dy, z: origin.z + offset.dz };
        for (const direction of directions) {
          const waterStart = { x: bank.x + direction.x, z: bank.z + direction.z };
          if (!source(read(new Vec3(waterStart.x, bank.y - 1, waterStart.z)))) continue;
          if (!nearBank(bank, direction)) { reject('surface_swim_discovery_near_bank_unsafe'); continue; }
          let width = 0;
          for (; width <= maximumWidth; width++) if (!source(read(new Vec3(waterStart.x + direction.x * width, bank.y - 1, waterStart.z + direction.z * width)))) break;
          if (width < 1 || width > maximumWidth) { reject('surface_swim_discovery_width_unsupported'); continue; }
          const route = { schema: 1, kind: 'loaded_surface_swim', depth: 'surface_only', from: point(bank),
            to: { x: waterStart.x + direction.x * width, y: bank.y, z: waterStart.z + direction.z * width },
            waterStart, surfaceY: bank.y, direction: { ...direction }, width };
          const id = routeIdentity(route); if (seen.has(id)) continue; candidates++;
          let geometry, approach;
          try { geometry = validateSurfaceRoute(loaded, route, Vec3); approach = nativeProbe(bank); }
          catch (error) { if (budgetCodes.includes(error.code)) throw error; reject(error.code || 'surface_swim_discovery_probe_failed'); continue; }
          check(); oxygen(); if (!actualOrigin()) throw fail('surface_swim_discovery_origin_not_actual', '扫描不能把已变化的站位信用为原起点');
          seen.add(id); routes.push({ id, route, geometry, approach, nativeApproachProbeConfirmed: true,
            actualTraversalConfirmed: false, actualMovementPerformed: false, riverBottomObserved: false });
          if (routes.length >= resultLimit) break;
        }
        if (routes.length >= resultLimit) break;
      }
    } catch (error) { if (budgetCodes.includes(error.code)) stopped = error.code; else throw error; }
    deps.assertActive(); if (deps.getBot() !== bot || bot._client !== client) throw fail('surface_swim_discovery_owner_changed', '旧连接不得返回新路线');
    const result = { schema: 1, source: 'actual_loaded_client_world_only', origin: point(origin), routes,
      actualMovementPerformed: false, riverBottomObserved: false, originOxygen: readHouseBotOxygen(bot),
      diagnostics: { reads, readLimit, probes, probeLimit, candidates, rejections, stopReason: stopped, scanTimeoutMs,
        maximumWidth, horizontalRadius, verticalRadius, scanCompleteWithinDeclaredEnvelope: stopped === null, unseenWorld: 'UNKNOWN' } };
    deps.record?.('surface_swim_loaded_discovery', result); return result;
  }
  return { find };
}
return { createLoadedSurfaceSwimFinder, routeIdentity };
}
// Default bindings share the exact surface contract used by native traversal.
const { naturalWalkingFoot: dryFoot, hasGroundedBodySupport } = require('./houseSurfaceGraph');
const { stableSupport, inspectBody } = require('./houseShallowWaterTraversal');
const { readHouseBotOxygen } = require('./houseBotOxygen');
const NativeMove = require('mineflayer-pathfinder/lib/move');
const { validateSurfaceRoute, routeFrame } = require('./houseSurfaceSwim');
const defaultAPI = createSurfaceSwimFinderAPI({ dryFoot, hasGroundedBodySupport,
  stableSupport, inspectBody, readHouseBotOxygen, NativeMove, validateSurfaceRoute, routeFrame });
module.exports = { createSurfaceSwimFinderAPI, ...defaultAPI };
