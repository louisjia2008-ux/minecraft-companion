/* global require, module, setTimeout, clearTimeout */
'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { createWaterVitalsGuard } = require('./houseWaterVitals');
function createDryBankAlignmentAPI(nativeSafety) {
  for (const name of ['inspectBody', 'stableSupport']) if (typeof nativeSafety?.[name] !== 'function') throw new TypeError(`Native bank safety ${name} required`);
  const { inspectBody, stableSupport } = nativeSafety;
  const contexts = new AsyncLocalStorage(), looks = new WeakMap();
  const fail = (code, message, facts = {}) => Object.assign(new Error(message), { code, ...facts });
  const point = p => ({ x: p.x, y: p.y, z: p.z });
  const integer = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]));
  const air = name => ['air', 'cave_air', 'void_air'].includes(name);
  function createDryBankAlignment(deps) {
    for (const name of ['getBot', 'getOwner', 'isOwnerCurrent']) if (typeof deps?.[name] !== 'function') throw new TypeError(`Dry bank alignment requires ${name}`);
    const { Vec3 } = deps;
    if (!Vec3) throw new TypeError('Original native Vec3 required');
    const bot = deps.getBot(), client = bot?._client, owner = deps.getOwner(), profile = bot?.pathfinder?.movements;
    if (!client?.write || !bot?.pathfinder || typeof bot.look !== 'function' || typeof bot.setControlState !== 'function') throw new TypeError('Original native player controls and pathfinder required');
    let active = false, holding = false, ownerLost = false, requested = null, currentBank = null, finishCurrent = null, holdListener = null;
    const record = (type, facts = {}) => deps.record?.(type, facts);
    const owned = () => {
      if (ownerLost) return false;
      const yes = deps.getBot() === bot && bot._client === client && client.state === 'play'
        && deps.isOwnerCurrent(owner) === true && bot.pathfinder.movements === profile
        && (!(active || holding) || (bot.pathfinder.goal === null && bot.pathfinder.isMoving?.() !== true));
      if (!yes) ownerLost = true;
      return yes;
    };
    const assertOwner = () => { if (!owned()) throw fail('dry_bank_alignment_foreign_owner', 'Exact captured physical actor/profile was replaced'); };
    const control = (name, value) => { assertOwner(); bot.setControlState(name, value); };
    const horizontalStop = () => { for (const name of ['forward', 'back', 'left', 'right', 'sprint', 'sneak']) control(name, false); };
    function dryFacts(bank) {
      const facts = inspectBody(bot, Vec3), p = bot.entity.position;
      if (!integer(bank) || facts.onGround !== true || facts.isInWater !== false || facts.isInLava !== false
        || Math.floor(p.x) !== bank.x || Math.floor(p.z) !== bank.z || Math.abs(p.y - bank.y) > .075
        || !facts.eyeAir || !facts.aboveEyeAir || facts.cells.some(c => !air(c.name))) {
        throw fail('dry_bank_alignment_not_dry', 'Actual same-cell grounded AIR body required', { bank, facts });
      }
      const support = stableSupport(bot, { ...bank, y: bank.y - 1 }, Vec3);
      return { ...facts, support, bank: point(bank) };
    }
    function safelyDry() { try { return currentBank && dryFacts(currentBank); } catch { return null; } }
    function stopDry() {
      assertOwner(); if (!safelyDry()) throw fail('dry_bank_alignment_not_dry', 'Cannot clear flotation without actual supported dry body');
      horizontalStop(); control('jump', false);
    }
    function hold() {
      assertOwner(); horizontalStop(); control('jump', true); holding = true;
      if (!holdListener) {
        holdListener = () => {
          if (!owned()) { bot.removeListener('physicsTick', holdListener); holdListener = null; return; }
          try { if (safelyDry()) stopDry(); else { horizontalStop(); control('jump', true); } } catch { /* Exact-owner HOLD retains flotation until safe dry release. */ }
        };
        bot.on('physicsTick', holdListener);
      }
    }
    function nativeLook(yaw) {
      const token = { closed: false }, previous = bot.look, frame = { previous, live: true };
      function guarded(...args) {
        if (frame.live && contexts.getStore() === token) { if (token.closed) throw fail('dry_bank_alignment_late_look', 'Closed bank look cannot write'); assertOwner(); }
        return previous.apply(this, args);
      }
      looks.set(guarded, frame); bot.look = guarded;
      const restore = () => {
        frame.live = false;
        if (bot.look === guarded) { let old = previous; while (looks.get(old)?.live === false) old = looks.get(old).previous; bot.look = old; }
      };
      const promise = contexts.run(token, () => Promise.resolve().then(() => {
        assertOwner(); if (token.closed) throw fail('dry_bank_alignment_late_look', 'Closed bank look');
        return deps.look ? deps.look(yaw, 0, { force: true, beforeSend: () => { assertOwner(); if (token.closed) throw fail('dry_bank_alignment_late_look', 'Closed bank look'); } }) : bot.look(yaw, 0, true);
      }));
      promise.then(restore, restore);
      return { promise, close: () => { token.closed = true; } };
    }
    function requestCancel(code = 'dry_bank_alignment_cancelled') {
      requested ||= fail(code, 'Requested controlled dry-bank stop');
      finishCurrent?.(requested);
    }
    async function align(bank) {
      assertOwner();
      if (requested) throw requested;
      if (active || holding) throw fail('dry_bank_alignment_busy', 'A bank alignment/HOLD remains active');
      if (!integer(bank)) throw fail('dry_bank_alignment_invalid_bank', 'Exact integer source bank required');
      if (bot.pathfinder.goal !== null || bot.pathfinder.isMoving?.() === true || bot.pathfinder.isMining?.() === true || bot.pathfinder.isBuilding?.() === true) {
        throw fail('dry_bank_alignment_native_goal_active', 'Original goto/native actions must settle before alignment');
      }
      const vitalsSafe = createWaterVitalsGuard(bot, deps.recoveryReturn === true);
      currentBank = point(bank); const initial = dryFacts(bank), started = Date.now(), deadline = started + 2000;
      if (!vitalsSafe()) throw fail('dry_bank_alignment_survival_limit', 'Actual health6/food6 required before ordinary bank motion');
      active = true; let ticks = 0, stableTicks = 0, distance = 0, previous = point(bot.entity.position), done = false, looking = false, lastYaw = null, axis = null, pendingLook = null, timer;
      const center = { x: bank.x + .5, z: bank.z + .5 };
      let resolve, reject;
      const result = new Promise((yes, no) => { resolve = yes; reject = no; }); result.catch(() => {});
      const outcome = error => {
        if (done) return; done = true; pendingLook?.close(); clearTimeout(timer); bot.removeListener('physicsTick', tick); finishCurrent = null;
        try {
          assertOwner();
          if (safelyDry()) { stopDry(); if (error) error.recoveredToDryBank = true; }
          else { hold(); error ||= fail('dry_bank_alignment_not_dry', 'Alignment cannot confirm unsupported or wet bank'); error.holding = true; }
        } catch (cleanupError) {
          if (!owned()) { error = fail('dry_bank_alignment_foreign_owner', 'Exact captured actor was replaced during cleanup', { cause: cleanupError }); record('dry_bank_alignment_owner_lost', { code: error.code }); }
          else {
            error ||= cleanupError; error.cleanupFailure = { code: cleanupError.code || null, message: cleanupError.message };
            try { hold(); error.holding = true; } catch (holdError) { error.holding = holding; error.nativeCleanup = 'UNKNOWN'; error.holdFailure = { code: holdError.code || null, message: holdError.message }; }
          }
        }
        active = false;
        if (error) { record(holding ? 'dry_bank_alignment_hold' : 'dry_bank_alignment_recovered', { code: error.code, holding, recoveredToDryBank: error.recoveredToDryBank === true, position: point(bot.entity.position) }); reject(error); }
        else { const actual = dryFacts(bank), out = { confirmed: true, bank: point(bank), initial, actual, ticks, stableTicks, horizontalDistance: distance, elapsedMs: Date.now() - started, profileUnchanged: bot.pathfinder.movements === profile }; record('dry_bank_alignment_confirmed', out); resolve(out); }
      };
      finishCurrent = outcome;
      function orient(yaw) {
        horizontalStop(); control('jump', false); looking = true; lastYaw = yaw; pendingLook = nativeLook(yaw);
        pendingLook.promise.then(() => { if (!done) { try { assertOwner(); looking = false; } catch (error) { outcome(error); } } }, error => { if (!done) outcome(error); });
      }
      function tick() {
        if (done) return;
        try {
          assertOwner(); ticks++; const facts = dryFacts(bank), p = bot.entity.position;
          distance += Math.hypot(p.x - previous.x, p.z - previous.z); previous = point(p);
          const dx = center.x - p.x, dz = center.z - p.z, error = Math.hypot(dx, dz), speed = Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z);
          record('dry_bank_alignment_tick', { ticks, stableTicks, horizontalDistance: distance, elapsedMs: Date.now() - started, offsetX: -dx, offsetZ: -dz, nativeControls: { forward: bot.getControlState?.('forward') ?? null, back: bot.getControlState?.('back') ?? null, sneak: bot.getControlState?.('sneak') ?? null, jump: bot.getControlState?.('jump') ?? null }, ...facts });
          if (requested) throw requested;
          if (!vitalsSafe()) throw fail('dry_bank_alignment_survival_limit', 'Actual health/food requires controlled dry stop');
          if (Date.now() >= deadline || ticks > 40) throw fail('dry_bank_alignment_timeout', 'Original two-second/40-native-tick budget expired');
          if (distance > 1 || Math.hypot(p.x - initial.position.x, p.z - initial.position.z) > 1) throw fail('dry_bank_alignment_distance', 'Original one-metre movement budget exceeded');
          if (Math.abs(dx) <= .08 && Math.abs(dz) <= .08) {
            horizontalStop(); control('jump', false);
            stableTicks = speed <= .015 && Math.abs(bot.entity.velocity.y) <= .09 ? stableTicks + 1 : 0;
            if (stableTicks >= 3) outcome();
            return;
          }
          stableTicks = 0;
          if (looking) { horizontalStop(); control('jump', false); return; }
          if (axis === null) axis = Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z';
          const offset = axis === 'x' ? dx : dz, velocity = bot.entity.velocity[axis];
          if (Math.abs(offset) <= .06 && Math.abs(velocity) <= .015) { axis = axis === 'x' ? 'z' : 'x'; lastYaw = null; horizontalStop(); control('jump', false); return; }
          const sign = Math.sign(offset) || 1, yaw = axis === 'x' ? Math.atan2(-sign, 0) : Math.atan2(0, -sign);
          const delta = lastYaw === null ? Infinity : Math.abs(Math.atan2(Math.sin(yaw - lastYaw), Math.cos(yaw - lastYaw)));
          if (delta > .06) { orient(yaw); return; }
          const toward = velocity * sign, coast = Math.max(0, toward) / (1 - .546);
          control('left', false); control('right', false); control('sprint', false); control('jump', false);
          // Native crouch modifies original forward/back input speed only;
          // no profile, physics, position or velocity is assigned. It avoids
          // ordinary keyboard pulse quantization at sub-block tolerances.
          control('sneak', true); control('back', false);
          control('forward', Math.abs(offset) > .06 && (toward <= 0 || coast < Math.abs(offset) - .025));
        } catch (error) { outcome(error); }
      }
      try {
        record('dry_bank_alignment_started', { bank: point(bank), initial, timeoutMs: 2000, maximumHorizontalDistance: 1, centerTolerance: .08, stableTicksRequired: 3 });
        if (!done) {
          assertOwner(); if (requested) throw requested;
          horizontalStop(); control('jump', false); bot.on('physicsTick', tick);
          timer = setTimeout(() => outcome(fail('dry_bank_alignment_timeout', 'Original two-second deadline expired')), 2000);
          tick();
        }
      } catch (error) { outcome(error); }
      return result;
    }
    function release() {
      if (!owned()) { if (holdListener) bot.removeListener('physicsTick', holdListener); holdListener = null; return { foreign: true }; }
      if (active) throw fail('dry_bank_alignment_busy', 'Cancel and await active alignment before release');
      if (!currentBank) return { released: true, neverStarted: true };
      if (!safelyDry()) throw fail('dry_bank_alignment_release_wet', 'Only actual supported dry source bank can release HOLD');
      stopDry(); if (holdListener) bot.removeListener('physicsTick', holdListener); holdListener = null; holding = false;
      return { released: true };
    }
    return { align, requestCancel, release, isActive: () => active, isHolding: () => holding };
  }
  return { createDryBankAlignment };
}
// Default safety is this runtime's unchanged native water/body implementation.
// Fixed-runtime callers may continue injecting through the factory.
const { inspectBody, stableSupport } = require('./houseShallowWaterTraversal');
const defaultAPI = createDryBankAlignmentAPI({ inspectBody, stableSupport });
module.exports = { createDryBankAlignmentAPI, ...defaultAPI };
