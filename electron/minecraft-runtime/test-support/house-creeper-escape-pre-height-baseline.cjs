'use strict';
// Bounded dry escape through installed pathfinder and native physics.
// Actual server acceptance is recorded separately from offline regressions.
const { Vec3 } = require('vec3'), { goals } = require('mineflayer-pathfinder');
const { dryFoot, inspectSurfaceBody, hasGroundedBodySupport } = require('../vendor/server/minecraft/houseSurfaceGraph');
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const plain = p => ({ x: p.x, y: p.y, z: p.z });
const finite = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]));
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const center = p => ({ x: p.x + .5, y: p.y, z: p.z + .5 });
const key = p => `${p.x},${p.y},${p.z}`;
const gotoFrames = new WeakMap();

function createHouseCreeperEscape(deps, limits = {}) {
  for (const name of ['getBot', 'assertActive', 'isOwnerCurrent', 'getThreat']) if (typeof deps[name] !== 'function') throw new TypeError(`Captured creeper escape requires ${name}`);
  const bot = deps.getBot(), client = bot?._client, profile = bot?.pathfinder?.movements;
  const cfg = { safeDistance: 8.5, arrivalMargin: .25, maximumDistance: 12, maximumSteps: 16, timeoutMs: 4000, maximumProbes: 8, planningMs: 120, ...limits };
  if (!Number.isFinite(cfg.safeDistance) || cfg.safeDistance < 8.5 || cfg.safeDistance > 12 || !Number.isFinite(cfg.arrivalMargin) || cfg.arrivalMargin < 0 || cfg.arrivalMargin > .5
    || cfg.maximumDistance !== 12 || cfg.maximumSteps !== 16 || !Number.isInteger(cfg.timeoutMs) || cfg.timeoutMs < 50 || cfg.timeoutMs > 4000
    || !Number.isInteger(cfg.maximumProbes) || cfg.maximumProbes < 1 || cfg.maximumProbes > 8 || !Number.isInteger(cfg.planningMs) || cfg.planningMs < 20 || cfg.planningMs > 150) throw new TypeError('Creeper escape limits may not relax dry12m/16step/4s contract');
  const safeProfile = () => profile && profile.canDig === false && profile.scafoldingBlocks?.length === 0 && profile.allowParkour === false && profile.allow1by1towers === false
    && profile.allowSprinting === false && profile.allowFreeMotion === false && Number.isFinite(profile.maxDropDown) && profile.maxDropDown >= 0 && profile.maxDropDown <= 2 && profile.infiniteLiquidDropdownDistance === false && profile.exclusionAreasStep?.length;
  if (!safeProfile()) throw fail('house_creeper_escape_profile', '原移动profile必须已禁止挖掘、搭桥、跑酷、冲刺、路径shortcut和额外坠落');
  let closed = false, activeGoal = null, lastGround = null;
  const record = (kind, value) => deps.record?.(kind, value);
  const owner = () => deps.getBot() === bot && bot._client === client && deps.isOwnerCurrent() === true && bot.pathfinder.movements === profile;
  const active = () => { if (closed) throw fail('house_creeper_escape_closed', '本次避让能力已关闭'); deps.assertActive(); if (!owner()) throw fail('house_creeper_escape_preempted', '避让所有权、连接或原profile已改变'); if (!safeProfile()) throw fail('house_creeper_escape_profile', '原profile安全策略被改变'); };
  function threat() {
    const e = deps.getThreat();
    if (!e || e.name !== 'creeper' || e.isValid === false || !Number.isInteger(e.id) || !finite(e.position)) throw fail('house_creeper_escape_threat_lost', '原苦力怕没有可确认的实时实体');
    return e;
  }
  const threats = primary => {
    const others = typeof deps.getThreats === 'function' ? deps.getThreats() : Object.values(bot.entities || {});
    if (!Array.isArray(others) || others.length > 4096) throw fail('house_creeper_escape_threat_unknown', '威胁集合必须是有限实际实体');
    const actual = [...new Map([primary, ...others.filter(e => e?.name === 'creeper' && e.isValid !== false && Number.isInteger(e.id) && finite(e.position)
      && horizontal(bot.entity.position, e.position) <= 16)].map(e => [e.id, e])).values()];
    if (actual.length > 16) throw fail('house_creeper_escape_threat_limit', '附近实际苦力怕超过本次有限处理上限');
    return actual;
  };
  function supportedDry(tick = 0) {
    const entity = bot.entity, p = entity?.position;
    if (!finite(p) || !finite(entity.velocity) || !inspectSurfaceBody(bot).dry) throw fail('house_creeper_escape_hazard', '避让身体接触未知、水、岩浆或危险方块');
    const half = (entity.width || .6) / 2, height = entity.height || 1.8;
    for (let x = Math.floor(p.x - half + 1e-8); x <= Math.floor(p.x + half - 1e-8); x++) for (let z = Math.floor(p.z - half + 1e-8); z <= Math.floor(p.z + half - 1e-8); z++) {
      for (let y = Math.floor(p.y); y <= Math.floor(p.y + height - 1e-8); y++) {
        const b = bot.blockAt(new Vec3(x, y, z));
        for (const s of b?.shapes || []) if (p.x + half > x + s[0] && p.x - half < x + s[3] && p.z + half > z + s[2] && p.z - half < z + s[5]
          && p.y + .02 < y + s[4] && p.y + height - .02 > y + s[1]) throw fail('house_creeper_escape_hazard', '实际身体与实心方块碰撞');
      }
    }
    if (hasGroundedBodySupport(bot)) { lastGround = { position: plain(p), tick }; return; }
    const foot = p.floored(), near = [1, 2].some(dy => {
      const b = bot.blockAt(foot.offset(0, -dy, 0));
      return b && !['water', 'lava', 'bubble_column', 'magma_block', 'fire', 'soul_fire', 'cactus', 'powder_snow'].includes(b.name)
        && ![true, 'true'].includes(b.getProperties?.().waterlogged) && b.shapes?.some(s => s[4] === 1);
    });
    if (!near || entity.onGround === true || !lastGround || tick - lastGround.tick > 16 || horizontal(p, lastGround.position) > 1.75 || entity.velocity.y < -.9 || entity.velocity.y > .43) throw fail('house_creeper_escape_airshaft', '避让离开真实有限支撑或处于深坑');
  }
  function validatePath(path, origin, liveThreats) {
    if (!Array.isArray(path) || path.length < 1 || path.length > cfg.maximumSteps) return null;
    let previous = origin, length = 0;
    const distances = liveThreats.map(e => horizontal(origin, e.position)), checked = [];
    for (const step of path) {
      if (!step || !['x', 'y', 'z'].every(k => Number.isSafeInteger(step[k])) || step.toBreak?.length || step.toPlace?.length || !dryFoot(bot, step)) return null;
      const p = center(step), dx = Math.abs(step.x - Math.floor(previous.x)), dz = Math.abs(step.z - Math.floor(previous.z)), dy = Math.abs(step.y - Math.floor(previous.y));
      if (dx + dz > 1 || dy > 1) return null;
      length += Math.hypot(p.x - previous.x, p.y - previous.y, p.z - previous.z);
      if (length > cfg.maximumDistance + 1e-7) return null;
      for (let i = 0; i < liveThreats.length; i++) {
        const d = horizontal(p, liveThreats[i].position);
        if (d + .025 < distances[i]) return null;
        distances[i] = d;
      }
      checked.push({ x: step.x, y: step.y, z: step.z }); previous = p;
    }
    return { path: checked, length, end: checked.at(-1), endDistance: Math.min(...distances) };
  }
  function solve(primary) {
    active(); const origin = plain(bot.entity.position), foot = bot.entity.position.floored(), liveThreats = threats(primary);
    const dx = origin.x - primary.position.x, dz = origin.z - primary.position.z;
    const cardinal = [[Math.sign(dx) || 1, 0], [0, Math.sign(dz) || 1], [0, -(Math.sign(dz) || 1)], [-(Math.sign(dx) || 1), 0]]
      .sort((a, b) => b[0] * dx + b[1] * dz - (a[0] * dx + a[1] * dz));
    const candidates = [], seen = new Set();
    for (const length of [12, 8, 4, 2]) {
      for (const d of cardinal) {
        if (d[0] * dx + d[1] * dz < -1e-7) continue;
        const p = { x: foot.x + d[0] * length, y: foot.y, z: foot.z + d[1] * length };
        if (!seen.has(key(p)) && Math.min(...liveThreats.map(e => horizontal(center(p), e.position))) >= cfg.safeDistance + cfg.arrivalMargin) { seen.add(key(p)); candidates.push(p); }
      }
    }
    let probes = 0; const planningDeadline = Date.now() + cfg.planningMs;
    for (const target of candidates) {
      active(); if (probes >= cfg.maximumProbes || Date.now() >= planningDeadline) break;
      if (!dryFoot(bot, target)) continue;
      probes++;
      const iterator = bot.pathfinder.getPathFromTo(profile, bot.entity.position, new goals.GoalBlock(target.x, target.y, target.z), { optimizePath: false, timeout: Math.min(40, Math.max(1, planningDeadline - Date.now())), tickTimeout: 5, searchRadius: 16 });
      let result;
      for (let i = 0; i < 16; i++) { active(); if (Date.now() >= planningDeadline) break; const next = iterator.next(); result = next.value?.result; if (next.done || result?.status !== 'partial') break; }
      if (result?.status !== 'success') continue;
      const checked = validatePath(result.path, origin, liveThreats);
      if (checked) { record('creeper_escape_plan', { threatId: primary.id, origin, target, probes, ...checked, actualMovementConfirmed: false }); return { ...checked, probes, target }; }
    }
    throw fail('house_creeper_escape_no_path', '有限已加载干地中没有不靠近苦力怕的原生逃离路线', { probes, initialDistance: horizontal(origin, primary.position) });
  }
  async function escape() {
    active(); const began = Date.now(), primary = threat(), primaryId = primary.id;
    if (!Number.isFinite(bot.health) || bot.health < 16 || !Number.isFinite(bot.food) || bot.food < 14) throw fail('house_creeper_escape_survival_limit', '避让生命或饱食低于16/14');
    supportedDry();
    const initialDistance = Math.min(...threats(primary).map(e => horizontal(bot.entity.position, e.position))), origin = plain(bot.entity.position);
    if (initialDistance >= cfg.safeDistance + cfg.arrivalMargin && hasGroundedBodySupport(bot)) { closed = true; return { confirmed: true, alreadySafe: true, threatId: primaryId, initialDistance, finalDistance: initialDistance, traveled: 0, elapsedMs: 0, actual: origin }; }
    const plan = solve(primary); active();
    if (Date.now() - began >= cfg.timeoutMs) throw fail('house_creeper_escape_timeout', '原生探路已耗尽本次总避让时间');
    const goal = new goals.GoalBlock(plan.target.x, plan.target.y, plan.target.z); activeGoal = goal;
    let timer, rejectGuard, resolveGuard, guardError = null, safeStop = false, ticks = 0, traveled = 0, previous = plain(bot.entity.position);
    const guard = new Promise((resolve, reject) => { resolveGuard = resolve; rejectGuard = reject; });
    const stopOwn = () => { if (owner() && bot.pathfinder.goal === goal) { bot.pathfinder.setGoal(null); bot.clearControlStates(); } };
    const abort = error => {
      if (guardError || safeStop) return; guardError = error; closed = true;
      error.observedEscape = { threatId: primaryId, actual: plain(bot.entity.position), velocity: plain(bot.entity.velocity), onGround: bot.entity.onGround,
        health: bot.health, food: bot.food, traveled, ticks, elapsedMs: Date.now() - began, target: plan.target };
      stopOwn(); try { deps.onFailure?.(error); } catch {} rejectGuard(error);
    };
    const inspect = () => {
      if (safeStop || guardError) return;
      try {
        active(); const current = threat(); if (current.id !== primaryId || current !== primary) throw fail('house_creeper_escape_threat_changed', '原苦力怕实体已替换');
        if (bot.health < 16 || bot.food < 14 || !Number.isFinite(bot.health) || !Number.isFinite(bot.food)) throw fail('house_creeper_escape_survival_limit', '实际避让生命或饱食下降');
        ticks++; supportedDry(ticks);
        const actual = plain(bot.entity.position), liveThreats = threats(current), delta = Math.hypot(actual.x - previous.x, actual.y - previous.y, actual.z - previous.z); traveled += delta;
        if (traveled > cfg.maximumDistance + 1e-7) throw fail('house_creeper_escape_distance_limit', '本次实际避让达到12m上限');
        for (const e of liveThreats) if (horizontal(actual, e.position) + .075 < horizontal(previous, e.position)) throw fail('house_creeper_escape_approaching', '实际机器人移动正在靠近苦力怕');
        const distance = Math.min(...liveThreats.map(e => horizontal(actual, e.position)));
        record('creeper_escape_tick', { actual, threat: plain(current.position), distance, ownMotion: delta, traveled, ticks }); previous = actual;
        if (distance >= cfg.safeDistance + cfg.arrivalMargin && hasGroundedBodySupport(bot)) { safeStop = true; stopOwn(); resolveGuard({ safeStop: true }); }
      } catch (error) { abort(error); }
    };
    const checkActualPath = update => {
      if (safeStop || guardError || !Array.isArray(update?.path) || !update.path.length) return;
      try {
        active(); const p = threat();
        // Installed goto postProcessPath converts full-cube cells to x/z+.5.
        // Validate its actual cells; source exclusion areas disable shortcuts.
        const cells = update.path.map(step => ({ ...step, x: Math.floor(step.x), y: Math.floor(step.y), z: Math.floor(step.z) }));
        if (!validatePath(cells, plain(bot.entity.position), threats(p))) throw fail('house_creeper_escape_path_changed', '原生执行路径不再满足干地、有限、逐步远离条件');
      }
      catch (error) { abort(error); }
    };
    bot.prependListener('physicsTick', inspect); bot.on('path_update', checkActualPath);
    timer = setTimeout(() => abort(fail('house_creeper_escape_timeout', '本次原生避让总时间达到4秒以内限额')), Math.max(1, cfg.timeoutMs - (Date.now() - began)));
    let pending;
    const gotoFrame = { previous: bot.pathfinder.goto, active: true };
    function guardedGoto(candidate, ...args) {
      // Only this exact captured goal is guarded. A foreign actor's different
      // goal is untouched; a delayed old host callback cannot revive ours.
      if (gotoFrame.active && candidate === goal) active();
      return gotoFrame.previous.call(this, candidate, ...args);
    }
    const cleanupGoto = () => {
      gotoFrame.active = false;
      if (bot.pathfinder.goto === guardedGoto) { let previousGoto = gotoFrame.previous; while (gotoFrames.get(previousGoto)?.active === false) previousGoto = gotoFrames.get(previousGoto).previous; bot.pathfinder.goto = previousGoto; }
    };
    gotoFrames.set(guardedGoto, gotoFrame); bot.pathfinder.goto = guardedGoto;
    try {
      pending = Promise.resolve().then(() => { active(); return deps.actualNativeGoto ? deps.actualNativeGoto(goal, { timeoutMs: Math.max(1, cfg.timeoutMs - (Date.now() - began)), preserveMovements: true, isOwnerCurrent: () => !closed && owner(), assertActive: active }) : bot.pathfinder.goto(goal); }); pending.then(cleanupGoto, cleanupGoto);
      const nativeResult = await Promise.race([pending.then(value => ({ nativeResult: value })), guard]);
      if (!safeStop) { inspect(); if (guardError) throw guardError; if (!safeStop) throw fail('house_creeper_escape_unconfirmed', '原生goto返回但实际苦力怕距离仍不安全'); }
      active();
      let settleTimer;
      const settled = await Promise.race([pending.then(() => true, () => true), new Promise(resolve => { settleTimer = setTimeout(() => resolve(false), 250); })]); clearTimeout(settleTimer);
      active(); if (!settled) throw fail('house_creeper_escape_native_unsettled', '旧原生goto未确认停止', { nativeSettlement: 'UNKNOWN' });
      const current = threat(), finalDistance = Math.min(...threats(current).map(e => horizontal(bot.entity.position, e.position)));
      if (!hasGroundedBodySupport(bot) || finalDistance < cfg.safeDistance) throw fail('house_creeper_escape_unconfirmed', '停止后实际干地或8.5m间距没有保持');
      const result = { confirmed: true, threatId: primaryId, initialDistance, finalDistance, traveled, ticks, elapsedMs: Date.now() - began, actual: plain(bot.entity.position), nativeStoppedEarly: !!nativeResult.safeStop, plan };
      record('creeper_escape_confirmed', result); return result;
    } catch (error) {
      stopOwn(); if (guardError) throw guardError;
      deps.assertActive();
      if (!owner()) throw fail('house_creeper_escape_preempted', '旧避让原生goto因其他actor接管而结束', { cause: { code: error.code || error.name, message: error.message } });
      throw error;
    } finally {
      closed = true; activeGoal = null; clearTimeout(timer); bot.removeListener('physicsTick', inspect); bot.removeListener('path_update', checkActualPath);
      if (!pending) cleanupGoto();
    }
  }
  return { escape, getActiveGoal: () => activeGoal };
}
module.exports = { createHouseCreeperEscape };
