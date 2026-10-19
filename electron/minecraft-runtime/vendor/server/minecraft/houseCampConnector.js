/* global require, module, setTimeout, clearTimeout */
'use strict';
const { Vec3 } = require('vec3');
const { Movements } = require('mineflayer-pathfinder');
const { naturalWalkingFoot: dryFoot, inspectSurfaceBody, hasGroundedBodySupport } = require('./houseSurfaceGraph');
const HAZARDS = new Set(['water', 'lava', 'bubble_column', 'magma_block', 'fire', 'soul_fire', 'cactus', 'powder_snow', 'campfire', 'soul_campfire', 'sweet_berry_bush']);
const frames = new WeakMap();
const fail = (code, message) => Object.assign(new Error(message), { code });
const copy = value => JSON.parse(JSON.stringify(value));
const finite = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]));
const plain = p => ({ x: p.x, y: p.y, z: p.z });
const cell = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const key = p => `${Math.floor(p.x)},${p.y.toFixed(4)},${Math.floor(p.z)}`;
const xz = p => `${Math.floor(p.x)},${Math.floor(p.z)}`;
const sameCell = (a, b) => Math.floor(a.x) === Math.floor(b.x) && Math.floor(a.z) === Math.floor(b.z);
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const safe = b => b && !HAZARDS.has(b.name) && ![true, 'true'].includes(b.getProperties?.().waterlogged);

// Observation facts and construction transport are separate from the resource
// graph. Fractional feet never become an integer dry-graph waypoint.
// Host contract:
// - Observe only actual construction physics ticks, beginning at exact camp.
// - isOwnerCurrent checks physical bot/client/task/generation/lease identity;
//   assertActive additionally enforces human pause/cancel. isOwnerContext is
//   exact captured ALS identity, so foreign native calls remain unchanged.
// - saveCheckpoint merges only this captured task's trail namespace.
// - withMovements installs the supplied strict profile in the host's movement
//   context and restores only while the same physical actor still owns it.
// - moveTo reuses house reach with options.canAct (pure shape geometry), then
//   waits for real grounded support. The connector independently confirms it.
// - returnDry uses the existing guarded graph return; via contains only actual
//   integer natural-ground observations. A changed/occupied trail is refused.
function createHouseCampConnector(deps, options = {}) {
  for (const name of ['getBot', 'assertActive', 'isOwnerCurrent', 'isOwnerContext', 'getCheckpoint', 'saveCheckpoint',
    'isOwnedConstructionSupport', 'withMovements', 'moveTo', 'returnDry']) {
    if (typeof deps[name] !== 'function') throw new TypeError(`Construction connector requires ${name}`);
  }
  const { anchor, taskId, maximumPoints = 4096, timeoutMs = 120000, legTimeoutMs = 12000 } = options;
  if (!anchor || !['x', 'y', 'z'].every(k => Number.isSafeInteger(anchor[k])) || typeof taskId !== 'string' || !taskId
    || !Number.isInteger(maximumPoints) || maximumPoints < 2 || maximumPoints > 4096
    || !Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 120000
    || !Number.isInteger(legTimeoutMs) || legTimeoutMs < 50 || legTimeoutMs > 12000) throw new TypeError('Invalid finite construction connector contract');
  const bot = deps.getBot(), client = bot?._client;
  let released = false, returning = false, state = deps.getCheckpoint() ? copy(deps.getCheckpoint()) : null;
  const owner = () => !released && deps.getBot() === bot && bot._client === client && deps.isOwnerCurrent() === true;
  const active = () => { deps.assertActive(); if (!owner()) throw fail('house_camp_connector_preempted', '施工返营已失去原任务、连接或移动租约'); };
  const save = value => { active(); deps.saveCheckpoint(copy(value)); state = value; };
  function validateState() {
    if (!state) return;
    if (state.schema !== 1 || state.kind !== 'actual_house_construction_trail' || state.taskId !== taskId
      || !['x', 'y', 'z'].every(k => state.anchor?.[k] === anchor[k]) || !Array.isArray(state.points)
      || !state.points.length || state.points.length > maximumPoints || state.points.some(p => !finite(p.position)
        || typeof p.graphCompatible !== 'boolean' || !Array.isArray(p.supports) || !p.supports.length
        || p.supports.length > 8 || p.supports.some(s => !finite(s.position) || !Number.isInteger(s.stateId)
          || typeof s.name !== 'string' || typeof s.owned !== 'boolean'))) {
      throw fail('house_camp_connector_checkpoint', '施工返营事实与原任务不符');
    }
    if (!state.points[0].graphCompatible || !sameCell(state.points[0].position, anchor)
      || Math.abs(state.points[0].position.y - anchor.y) > .075) throw fail('house_camp_connector_checkpoint', '施工轨迹没有真实固定营地起点');
  }
  validateState();
  function supportFacts(p = bot.entity?.position, actual = true) {
    const e = bot.entity;
    if (!finite(p) || !finite(e.velocity) || actual && !inspectSurfaceBody(bot).dry) throw fail('house_camp_connector_hazard', '施工返营身体接触未知、液体或危险方块');
    const half = (e.width || .6) / 2, height = e.height || 1.8, supports = [];
    for (let x = Math.floor(p.x - half + 1e-8); x <= Math.floor(p.x + half - 1e-8); x++) for (let z = Math.floor(p.z - half + 1e-8); z <= Math.floor(p.z + half - 1e-8); z++) {
      for (let y = Math.floor(p.y - .075) - 1; y <= Math.floor(p.y + height - 1e-8); y++) {
        const position = new Vec3(x, y, z), block = bot.blockAt(position);
        if (!safe(block)) throw fail('house_camp_connector_hazard', '实际施工身体或支撑列未加载、不安全');
        for (const shape of block.shapes || []) {
          if (p.x + half <= x + shape[0] || p.x - half >= x + shape[3] || p.z + half <= z + shape[2] || p.z - half >= z + shape[5]) continue;
          const top = y + shape[4];
          if (p.y + .02 < top && p.y + height - .02 > y + shape[1]) throw fail('house_camp_connector_hazard', '实际施工身体与固体形状重叠');
          if (Math.abs(p.y - top) <= .075) supports.push({ position: plain(position), name: block.name, stateId: block.stateId,
            owned: deps.isOwnedConstructionSupport(plain(position), block) === true });
        }
      }
    }
    if (!supports.length || actual && (e.onGround !== true || !hasGroundedBodySupport(bot))) return null;
    const graphCompatible = Math.abs(p.y - Math.round(p.y)) <= .075 && dryFoot(bot, p.floored())
      && supports.every(s => !s.owned);
    if (!graphCompatible && !supports.every(s => s.owned)) throw fail('house_camp_connector_foreign_support', '分数高度或建筑支撑必须全部属于本施工任务');
    return { position: plain(p), graphCompatible, supports };
  }
  function observe() {
    active(); if (returning) return false;
    let point;
    try { point = supportFacts(); } catch (error) {
      if (state) save({ ...state, invalidReason: error.code });
      return false;
    }
    if (!point) return false;
    if (sameCell(point.position, anchor) && Math.abs(point.position.y - anchor.y) <= .075 && point.graphCompatible) {
      save({ schema: 1, kind: 'actual_house_construction_trail', taskId, anchor: { ...anchor }, points: [point] }); return true;
    }
    if (!state || state.invalidReason) return false;
    const previous = state.points.at(-1);
    if (horizontal(point.position, previous.position) > 1.75 || Math.abs(point.position.y - previous.position.y) > 1.01) {
      save({ ...state, invalidReason: 'house_camp_connector_observation_gap' }); return false;
    }
    const at = state.points.findLastIndex(p => key(p.position) === key(point.position));
    const points = at < 0 ? [...state.points, point] : [...state.points.slice(0, at), point];
    if (points.length > maximumPoints) { save({ ...state, invalidReason: 'house_camp_connector_trail_limit' }); return false; }
    save({ ...state, points }); return true;
  }
  function validateSupport(point) {
    for (const proof of point.supports) {
      const block = bot.blockAt(new Vec3(proof.position.x, proof.position.y, proof.position.z));
      if (!safe(block) || block.name !== proof.name || block.stateId !== proof.stateId
        || (deps.isOwnedConstructionSupport(proof.position, block) === true) !== proof.owned) {
        throw fail('house_camp_connector_route_changed', '实际施工轨迹的原支撑已改变或失去归属');
      }
    }
  }
  function profileFor(points) {
    let movements = new Movements(bot);
    if (deps.configureMovements) movements = deps.configureMovements(movements);
    movements.canDig = false; movements.scafoldingBlocks = []; movements.allowParkour = false; movements.allow1by1towers = false;
    movements.allowSprinting = false; movements.allowFreeMotion = false; movements.maxDropDown = 2; movements.infiniteLiquidDropdownDistance = false;
    movements.getMoveDiagonal = () => {};
    for (const name of HAZARDS) { const id = bot.registry.blocksByName[name]?.id; if (id !== undefined) movements.blocksToAvoid.add(id); }
    const cells = new Map();
    for (const p of points) {
      for (const position of [p.position, ...p.supports.map(s => ({ ...s.position, y: p.position.y }))]) {
        const heights = cells.get(xz(position)) || []; heights.push(p.position.y);
        const block = bot.blockAt(new Vec3(Math.floor(position.x), Math.floor(position.y - .01), Math.floor(position.z)));
        for (const shape of block?.shapes || []) heights.push(block.position.y + shape[4]);
        cells.set(xz(position), heights);
      }
    }
    movements.exclusionAreasStep.push(block => block?.position && cells.get(xz(block.position))?.some(y => Math.abs(block.position.y - Math.ceil(y - 1e-6)) <= 1)
      && safe(bot.blockAt(block.position)) ? 0 : Infinity);
    return { movements, cells };
  }
  function installLateMoveGuard(frame) {
    const pf = bot.pathfinder;
    const owned = new Map();
    for (const name of ['goto', 'setGoal']) {
      const previous = pf[name];
      function guarded(...args) {
        if (frame.live && deps.isOwnerContext() === true) {
          if (frame.closed) throw frame.error || fail('house_camp_connector_closed', '已关闭的施工移动不可迟到写入');
          active();
          if (frame.strictProfile !== false && bot.pathfinder.movements !== frame.movements) throw fail('house_camp_connector_preempted', '施工移动 profile 已被接管');
          if (args[0]) { frame.goal = args[0]; if (frame.strictProfile === false) frame.movements = bot.pathfinder.movements; }
        }
        return previous.apply(this, args);
      }
      const entry = { previous, live: true };
      frames.set(guarded, entry); pf[name] = guarded; owned.set(name, { guarded, entry });
    }
    return () => {
      frame.live = false;
      for (const [name, { guarded, entry }] of owned) {
        entry.live = false;
        if (pf[name] !== guarded) continue;
        let previous = entry.previous;
        while (frames.get(previous)?.live === false) previous = frames.get(previous).previous;
        pf[name] = previous;
      }
    };
  }
  function stopOwn(frame) {
    if (!owner() || bot.pathfinder.movements !== frame.movements || frame.goal && bot.pathfinder.goal !== frame.goal) return;
    // Cleanup uses the captured original setter; a closed capability must not
    // block cancellation of its own exact native goal.
    const entry = frames.get(bot.pathfinder.setGoal);
    let setter = entry?.previous || bot.pathfinder.setGoal;
    while (frames.has(setter)) setter = frames.get(setter).previous;
    setter.call(bot.pathfinder, null); bot.clearControlStates();
  }
  async function move(point, profile, cells, remaining) {
    active(); validateSupport(point);
    const frame = { live: true, closed: false, goal: null, movements: profile, error: null };
    const restore = installLateMoveGuard(frame);
    let tick = 0, lastGround = null, guardError, rejectGuard;
    const guardPromise = new Promise((_, reject) => { rejectGuard = reject; });
    guardPromise.catch(() => {});
    const proofs = state.points.flatMap(p => p.supports);
    const proofMatches = support => proofs.some(proof => proof.name === support.name && proof.stateId === support.stateId
      && proof.owned === support.owned && ['x', 'y', 'z'].every(k => proof.position[k] === support.position[k]));
    const nearObservedSupport = () => {
      const p = bot.entity.position, half = (bot.entity.width || .6) / 2;
      return proofs.some(proof => {
        const b = bot.blockAt(new Vec3(proof.position.x, proof.position.y, proof.position.z));
        if (!safe(b) || b.name !== proof.name || b.stateId !== proof.stateId
          || (deps.isOwnedConstructionSupport(proof.position, b) === true) !== proof.owned) return false;
        return b.shapes.some(s => { const top = proof.position.y + s[4];
          return top <= p.y + 1e-6 && p.y - top <= 2 && p.x + half > proof.position.x + s[0]
            && p.x - half < proof.position.x + s[3] && p.z + half > proof.position.z + s[2] && p.z - half < proof.position.z + s[5]; });
      });
    };
    const reject = error => { if (frame.closed) return;
      error.observedMovement = { position: plain(bot.entity.position), velocity: plain(bot.entity.velocity),
        onGround: bot.entity.onGround, isInWater: bot.entity.isInWater, isInLava: bot.entity.isInLava, tick, lastGround };
      frame.error = guardError = error; frame.closed = true; stopOwn(frame); rejectGuard(error); };
    const guard = () => {
      try {
        active(); tick++;
        if (bot.pathfinder.movements !== profile) throw fail('house_camp_connector_preempted', '施工返营 profile 已改变');
        if (!inspectSurfaceBody(bot).dry || !cells.has(xz(bot.entity.position))) throw fail('house_camp_connector_hazard', '返营离开实际观察过的干燥施工走廊');
        if (Number.isFinite(bot.health) && bot.health < 12) throw fail('house_camp_connector_low_health', '施工返营生命过低');
        const grounded = supportFacts();
        if (grounded) {
          if (!grounded.supports.every(proofMatches) || !cells.get(xz(grounded.position)).some(y => Math.abs(y - grounded.position.y) <= .075)) {
            throw fail('house_camp_connector_route_changed', '原生返程落脚点不是实际记录的支撑和高度');
          }
          lastGround = { position: plain(bot.entity.position), tick };
        // Physics can retain onGround for one tick after leaving a slab. This
        // is only a bounded transition with a still-real observed lower shape,
        // never grounded arrival or new trail credit.
        } else if (!lastGround || !nearObservedSupport() || tick - lastGround.tick > 16 || horizontal(bot.entity.position, lastGround.position) > 1.75
          || !finite(bot.entity.velocity) || bot.entity.velocity.y < -.9 || bot.entity.velocity.y > .43) {
          throw fail('house_camp_connector_airshaft', '返营超出原生一阶跳跃或真实支撑范围');
        }
      } catch (error) { reject(error); }
    };
    bot.on('physicsTick', guard); guard();
    const timer = setTimeout(() => reject(fail('house_camp_connector_timeout', '施工连接段原生移动超时，未确认返营')), Math.min(legTimeoutMs, remaining));
    const target = { ...point.position };
    const canAct = position => {
      if (horizontal(position, point.position) > 1 || Math.abs(position.y - point.position.y) > .075
        || point.graphCompatible && !sameCell(position, point.position)) return false;
      let actual; try { actual = supportFacts(position, false); } catch { return false; }
      return actual?.supports.some(support => point.supports.some(proof => proof.name === support.name && proof.stateId === support.stateId
        && proof.owned === support.owned && ['x', 'y', 'z'].every(k => proof.position[k] === support.position[k]))) === true;
    };
    let underlying;
    try {
      if (frame.closed) throw guardError;
      underlying = Promise.resolve().then(() => { active(); if (frame.closed) throw frame.error;
        return deps.moveTo(target, { targetFeet: copy(point.position), canAct, timeoutMs: Math.min(legTimeoutMs, remaining),
          assertActive: () => { active(); if (frame.closed) throw frame.error; }, isOwnerCurrent: owner }); });
      // Keep the native boundary guard until a late host promise really settles.
      underlying.then(restore, restore);
      await Promise.race([underlying, guardPromise]); active();
      validateSupport(point);
      if (!hasGroundedBodySupport(bot) || !canAct(bot.entity.position)) throw fail('house_camp_connector_unconfirmed', '原生 promise 未到达原分数高度支撑站位');
    } catch (error) {
      frame.error = guardError || error; frame.closed = true; stopOwn(frame);
      try { active(); } catch (ownerError) { throw ownerError; }
      throw frame.error;
    } finally { clearTimeout(timer); bot.removeListener('physicsTick', guard); if (!underlying) restore(); }
  }
  async function returnDryBounded(via, remaining) {
    active();
    if (remaining <= 0) throw fail('house_camp_connector_timeout', '施工返营总预算已到，不能开始干地接续');
    const frame = { live: true, closed: false, goal: null, movements: bot.pathfinder.movements, strictProfile: false, error: null };
    const restore = installLateMoveGuard(frame);
    let rejectGuard;
    const rejected = new Promise((_, reject) => { rejectGuard = reject; }); rejected.catch(() => {});
    const stop = error => { if (frame.closed) return; frame.closed = true; frame.error = error; stopOwn(frame); rejectGuard(error); };
    const guard = () => { try { active(); } catch (error) { stop(error); } };
    bot.on('physicsTick', guard);
    const timer = setTimeout(() => stop(fail('house_camp_connector_timeout', '干地接续超过本次施工返营总预算')), remaining);
    const promise = Promise.resolve().then(() => { active(); if (frame.closed) throw frame.error;
      return deps.returnDry(via.map(p => ({ ...p })), { assertActive: () => { active(); if (frame.closed) throw frame.error; }, isOwnerCurrent: owner }); });
    promise.then(restore, restore);
    try { await Promise.race([promise, rejected]); active(); }
    catch (error) { frame.error = error; frame.closed = true; stopOwn(frame);
      try { active(); } catch (ownerError) { throw ownerError; } throw error; }
    finally { clearTimeout(timer); bot.removeListener('physicsTick', guard); }
  }
  async function returnToCamp() {
    active(); validateState();
    if (returning) throw fail('house_camp_connector_busy', '施工返营连接段仍在执行');
    if (!state || state.invalidReason) throw fail('house_camp_connector_trail_missing', '没有本任务从营地实际走出的完整施工轨迹');
    const actual = supportFacts(), points = copy(state.points), last = points.at(-1);
    if (!actual || !sameCell(actual.position, last.position) || Math.abs(actual.position.y - last.position.y) > .075) {
      throw fail('house_camp_connector_trail_stale', '当前实际站位不是已观察施工轨迹的末点');
    }
    for (const point of points) validateSupport(point);
    let connector = 0;
    while (connector + 1 < points.length && points[connector + 1].graphCompatible) connector++;
    const via = points.slice(0, connector + 1).map(p => cell(p.position));
    if (via.some(p => !dryFoot(bot, new Vec3(p.x, p.y, p.z)))) throw fail('house_camp_connector_route_changed', '交给地表图的前缀已不是原干燥整数站位');
    const began = Date.now(), { movements, cells } = profileFor(points.slice(connector));
    returning = true;
    try {
      if (connector < points.length - 1) await deps.withMovements(movements, async () => {
        for (let i = points.length - 2; i >= connector; i--) {
          active(); const remaining = timeoutMs - (Date.now() - began);
          if (remaining <= 0) throw fail('house_camp_connector_timeout', '施工返营总预算已到，保留原轨迹');
          await move(points[i], movements, cells, remaining);
        }
      });
      active();
      if (!sameCell(bot.entity.position, via.at(-1)) || Math.abs(bot.entity.position.y - points[connector].position.y) > .075
        || !hasGroundedBodySupport(bot)) throw fail('house_camp_connector_unconfirmed', '没有实际到达原整数干燥接点');
      await returnDryBounded(via, timeoutMs - (Date.now() - began)); active();
      if (!sameCell(bot.entity.position, anchor) || Math.abs(bot.entity.position.y - anchor.y) > .075 || !hasGroundedBodySupport(bot)) {
        throw fail('house_camp_connector_unconfirmed', '实际地表返程没有回到固定营地');
      }
      const camp = supportFacts();
      save({ schema: 1, kind: 'actual_house_construction_trail', taskId, anchor: { ...anchor }, points: [camp] });
      return { confirmed: true, actual: plain(bot.entity.position), fractionalSegments: points.length - connector - 1, dryVia: via };
    } finally { returning = false; }
  }
  return { observe, returnToCamp, getState: () => copy(state), release: () => { released = true; } };
}
module.exports = { createHouseCampConnector };
