'use strict';
// Short, cancellable body actions. Each one:
//   - finishes within its own timeout (seconds, never minutes),
//   - stops the body when ctx.signal aborts,
//   - returns { ok, reason } and only reports ok once the server-side effect is
//     observed (block gone, item counted, hunger restored), not when a call returns.
// Recovery is not done here: the caller picks another target or gives up.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { waitUntil, runCancellable, sleep, abortError } = require('./confirm');
const { ownedItems } = require('./perception');
const { dropReturnPosition } = require('./pathReturn');
const { meleeGeometry, meleeSight, MeleeFollowGoal, entitySizeEvidence } = require('./entityGeometry');
const { standable, walkDry } = require('./caveRetreat');

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const isAbort = (error) => error?.code === 'aborted';

function haltBody(bot) {
  try { bot.pathfinder?.setGoal(null); } catch { /* ignore */ }
  try { dropReturnPosition(bot); } catch { /* ignore */ }
  try { bot.clearControlStates?.(); } catch { /* ignore */ }
}

// Climbing out of a mine needs pillaring: allow it, with dirt or cobblestone,
// only while the destination lies well above the bot. Pillars left in a shaft
// are harmless; on the surface the bot never pillars.
const CLIMB_BLOCKS = ['dirt', 'cobblestone', 'cobbled_deepslate'];
async function withClimbing(bot, targetY, run) {
  const movements = bot.pathfinder?.movements;
  if (movements?.companionWalkOnly) return run();
  if (!movements || !Number.isFinite(targetY) || targetY - bot.entity.position.y <= 3 || !underground(bot)) return run();
  const saved = { towers: movements.allow1by1towers, scaffold: movements.scafoldingBlocks };
  movements.allow1by1towers = true;
  // In the nether, mostly netherrack: some cobblestone is kept for steps out of lava.
  movements.scafoldingBlocks = movements.companionNether ? require('./nether').netherScaffolding(bot)
    : CLIMB_BLOCKS.map((name) => bot.registry.itemsByName[name]?.id).filter(Number.isInteger);
  try {
    return await run();
  } finally {
    movements.allow1by1towers = saved.towers;
    movements.scafoldingBlocks = saved.scaffold;
  }
}

const solidGround = (block) => block && block.boundingBox === 'block' && !block.name.endsWith('_leaves')
  && !block.name.endsWith('_log');

function openSky(bot, feet) {
  for (let dy = 2; dy < 48; dy += 1) {
    const block = bot.blockAt(feet.offset(0, dy, 0));
    if (!block) return true;
    if (block.boundingBox === 'block' && !block.name.endsWith('_leaves')) return false;
  }
  return true;
}

/**
 * Below ground: rock or soil over the head, or standing in a pit whose sides
 * rise above head height. Under a tree canopy does not count.
 */
function underground(bot) {
  const feet = bot.entity.position.floored();
  // A goal that knows the local ground level (the house site) says so directly.
  for (let dy = 2; dy < 10; dy += 1) if (solidGround(bot.blockAt(feet.offset(0, dy, 0)))) return true;
  // Below the site's ground level only counts with something overhead: a
  // valley floor under open sky is just lower ground.
  if (Number.isFinite(bot.companionSurfaceY) && feet.y < bot.companionSurfaceY - 1 && !openSky(bot, feet)) return true;
  let walledSides = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const reach of [1, 2]) {
      if (solidGround(bot.blockAt(feet.offset(dx * reach, 2, dz * reach)))) { walledSides += 1; break; }
    }
  }
  return walledSides >= 3;
}

/**
 * Steps to the middle of the bot's own block. Off-centre, the bot's body can
 * snag on a wall corner during the pathfinder's first diagonal move, which
 * then replans the same move forever.
 */
async function recentre(bot, ctx, { accept = () => true } = {}) {
  if (ctx.signal?.aborted) throw abortError(ctx.signal);
  const feet = bot.entity.position.floored();
  const supported = () => bot.entity.onGround === true
    && bot.blockAt(feet.offset(0, -1, 0))?.boundingBox === 'block'
    && bot.entity.position.floored().equals(feet) && accept(feet, bot.entity.position);
  // Swimming, ladders and a body already falling are the native planner's.
  if (!supported()) return;
  const centre = feet.offset(0.5, 0, 0.5);
  const distance = () => Math.hypot(bot.entity.position.x - centre.x, bot.entity.position.z - centre.z);
  const previousSneak = Boolean(bot.controlState?.sneak);
  const previousCompanionSneaking = bot.companionSneaking;
  try {
    bot.setControlState('sprint', false);
    bot.companionSneaking = true;
    bot.setControlState('sneak', true);
    for (let i = 0; i < 30 && distance() > 0.15 && supported(); i += 1) {
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      await bot.lookAt(centre.offset(0, bot.entity.position.y - centre.y + 1.6, 0), true);
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      if (!supported()) break;
      bot.setControlState('forward', true);
      await sleep(50, ctx.signal);
      bot.setControlState('forward', false);
    }
  } finally {
    bot.setControlState('forward', false);
    bot.setControlState('sneak', previousSneak);
    if (previousCompanionSneaking === undefined) delete bot.companionSneaking;
    else bot.companionSneaking = previousCompanionSneaking;
  }
}

function offCentre(bot) {
  const p = bot.entity.position;
  return Math.hypot(p.x - (Math.floor(p.x) + 0.5), p.z - (Math.floor(p.z) + 0.5)) > 0.2;
}

async function goTo(bot, ctx, goal, options = {}) {
  const { targetY } = options;
  if (Number.isFinite(targetY) && targetY - bot.entity.position.y > 3 && underground(bot)) {
    return withClimbing(bot, targetY, () => goTo(bot, ctx, goal, { ...options, targetY: undefined }));
  }
  if (offCentre(bot) && !goal.isEnd(bot.entity.position.floored())) await recentre(bot, ctx);
  const first = await goToOnce(bot, ctx, goal, options);
  // A caller with its own shared recovery deadline can own the next attempt.
  if (first.reason !== 'no_progress' || options.retryNoProgress === false) return first;
  // Stuck at the start: step into an open neighbouring cell and try once more.
  await nudge(bot, ctx);
  return goToOnce(bot, ctx, goal, options);
}

async function goToOnce(bot, ctx, goal, { timeoutMs = 30000, arrived } = {}) {
  // Watchdog: the pathfinder can replan forever without taking a step from
  // some start cells. No movement for 12 s (longer than a full plan, 10 s) ends it early.
  let stalled = false;
  let last = bot.entity.position.clone();
  let lastMoveAt = Date.now();
  const watchdog = setInterval(() => {
    const now = bot.entity.position;
    if (now.distanceTo(last) > 0.5 || bot.targetDigBlock) { last = now.clone(); lastMoveAt = Date.now(); return; }
    if (Date.now() - lastMoveAt > 12000) { stalled = true; haltBody(bot); }
  }, 1000);
  try {
    await runCancellable(() => bot.pathfinder.goto(goal), {
      signal: ctx.signal, timeoutMs, timeoutCode: 'path_timeout', cancel: () => haltBody(bot),
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    haltBody(bot);
    if (stalled) return fail('no_progress');
    return fail(error?.code || error?.name || 'path_failed');
  } finally {
    clearInterval(watchdog);
  }
  // Pathfinder can "finish" with an empty path; arrival must be checked.
  const at = bot.entity.position;
  const reached = arrived ? arrived(at) : goal.isEnd(at.floored());
  return reached ? { ok: true } : fail('not_arrived');
}

async function goNear(bot, ctx, position, range = 2, options = {}) {
  if (ctx.signal?.aborted) throw abortError(ctx.signal);
  // One original action budget, including direct, waypoint and final approach.
  // A native path_timeout must not create a fresh budget for each fallback.
  const timeoutMs = options.timeoutMs ?? 30000;
  const deadline = Date.now() + timeoutMs;
  const expiry = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, expiry.signal]) : expiry.signal;
  const scoped = { ...ctx, signal };
  const timer = setTimeout(() => { expiry.abort('path_timeout'); haltBody(bot); }, timeoutMs);
  const remaining = () => Math.max(0, deadline - Date.now());
  const attempt = async (goal, options) => {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    const result = await goTo(bot, scoped, goal, options);
    // A native timeout can resolve as {ok:false} after cancellation as well
    // as reject. Respect the root owner in both completion paths.
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    return result;
  };
  const goal = new goals.GoalNear(position.x, position.y, position.z, range);
  const direct = (limit = remaining()) => remaining() <= 0 ? Promise.resolve(fail('path_timeout'))
    : attempt(goal, {
      targetY: position.y, ...options, timeoutMs: Math.min(limit, remaining()),
      arrived: (at) => at.distanceTo(position) <= range + 1.5,
    });
  try {
    // Reserve room for existing 16-block legs on a long trip; close trips keep
    // their full direct budget. 20s is the existing waypoint attempt cap.
    const far = Math.hypot(position.x - bot.entity.position.x, position.z - bot.entity.position.z) > 20;
    const result = await direct(far ? Math.min(20000, remaining()) : remaining());
    if (result.ok || !['Timeout', 'path_timeout', 'no_progress', 'NoPath'].includes(result.reason)) return result;
    for (let leg = 0; leg < 6 && remaining() > 0; leg += 1) {
      const here = bot.entity.position;
      const dx = position.x - here.x;
      const dz = position.z - here.z;
      const flat = Math.hypot(dx, dz);
      if (flat <= 20) return await direct();
      const step = 16 / flat;
      const waypoint = new goals.GoalNearXZ(here.x + dx * step, here.z + dz * step, 3);
      const before = here.clone();
      const moved = await attempt(waypoint, { timeoutMs: Math.min(20000, remaining()), arrived: () => true });
      if (bot.entity.position.distanceTo(before) < 4) return moved.ok ? fail('leg_blocked') : moved;
    }
    return await direct();
  } catch (error) {
    // Native cancellation can acknowledge after our own deadline. The root
    // owner still decides cancellation; never relabel it as our timeout.
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    if (expiry.signal.aborted) return fail('path_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Moves to any spot from which `block` can be seen and dug. */
async function goToDig(bot, ctx, block, { acceptStand, ...options } = {}) {
  const arrived = () => withinReach(bot, block.position)
    && (!acceptStand || bot.entity.onGround && acceptStand(bot.entity.position.floored()));
  // Plants have no collision shape, so a line-of-sight goal can never be met.
  const plant = block.boundingBox === 'empty';
  const goal = plant ? new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2)
    : new goals.GoalLookAtBlock(block.position, bot.world, { reach: 4 });
  if (acceptStand) {
    const reachesBlock = goal.isEnd.bind(goal);
    goal.isEnd = (node) => acceptStand(node) && reachesBlock(node);
  }
  const targetY = block.position.y - (plant ? 0 : 1);
  const result = await goTo(bot, ctx, goal, { targetY, ...options, arrived });
  // Native pathfinding can finish during the final fall to its stance.
  if (acceptStand && result.reason === 'not_arrived' && !bot.entity.onGround
    && await waitUntil(arrived, { timeoutMs: 600, signal: ctx.signal })) return { ok: true };
  return result;
}

function withinReach(bot, position, reach = 4.5) {
  const eye = bot.entity.position.offset(0, 1.62, 0);
  return eye.distanceTo(position.offset(0.5, 0.5, 0.5)) <= reach;
}

async function digBlock(bot, ctx, block, { timeoutMs = 12000, tool: chosen = null } = {}) {
  if (bot.companionProtectBlock?.(block)) return fail('protected_home');
  const position = block.position;
  const originalName = block.name;
  if (!withinReach(bot, position)) return fail('out_of_reach');
  // The fastest tool unless the caller picked one (to spare a better pickaxe).
  const tool = chosen || bot.pathfinder?.bestHarvestTool?.(block);
  if (tool) {
    try { await bot.equip(tool, 'hand'); } catch { /* digging by hand still works, slower */ }
  }
  const current = bot.blockAt(position);
  if (!current || current.name !== originalName) return fail('block_changed');
  if (!bot.canDigBlock(current)) return fail('cannot_dig');
  // Mid-air digging is five times slower on the server than the client's
  // timing assumes, and the break is rejected. Wait to land (not in water).
  if (!bot.entity.onGround && !bot.entity.isInWater) {
    await waitUntil(() => bot.entity.onGround, { timeoutMs: 1500, signal: ctx.signal });
  }
  if (bot.pathfinder?.movements?.companionWalkOnly) {
    const body = bot.entity.position;
    const supportsBody = position.y === Math.floor(body.y) - 1
      && position.x < body.x + 0.3 && position.x + 1 > body.x - 0.3
      && position.z < body.z + 0.3 && position.z + 1 > body.z - 0.3;
    if (supportsBody) {
      const below = bot.blockAt(position.offset(0, -1, 0));
      const fullShape = !below?.shapes || (below.shapes.length === 1 && below.shapes[0].length === 6
        && below.shapes[0].every((value, i) => value === [0, 0, 0, 1, 1, 1][i]));
      if (!below || below.boundingBox !== 'block' || !fullShape || /lava|water|fire|magma|campfire|cactus/.test(below.name)) {
        return fail('unsafe_support_dig');
      }
    }
  }
  try {
    await runCancellable(() => bot.dig(current, true), {
      signal: ctx.signal, timeoutMs, timeoutCode: 'dig_timeout', cancel: () => bot.stopDigging(),
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    // The server may still have broken it; trust only the block state below.
  }
  const gone = await waitUntil(() => bot.blockAt(position)?.name !== originalName,
    { timeoutMs: 1500, signal: ctx.signal });
  return gone ? { ok: true } : fail('dig_unconfirmed');
}

function droppedItemName(entity) {
  try { return entity.getDroppedItem?.()?.name || null; } catch { return null; }
}

function nearbyDrops(bot, origin, radius, matchName) {
  return Object.values(bot.entities).filter((entity) => {
    if (entity.name !== 'item' || !entity.position) return false;
    if (entity.position.distanceTo(origin) > radius) return false;
    const name = droppedItemName(entity);
    return name === null || matchName(name); // metadata may not have arrived yet
  });
}

function countItems(bot, matchName) {
  let total = 0;
  for (const item of ownedItems(bot)) if (matchName(item.name)) total += item.count;
  return total;
}

/** Walks over matching item drops near `origin`; ok once the inventory count rises. */
async function collectDrops(bot, ctx, origin, matchName, { radius = 6, timeoutMs = 10000 } = {}) {
  const before = countItems(bot, matchName);
  // Drops spawn a tick after the block breaks and then fall.
  await waitUntil(() => nearbyDrops(bot, origin, radius, matchName).length > 0,
    { timeoutMs: 1000, signal: ctx.signal });
  const deadline = Date.now() + timeoutMs;
  for (const drop of nearbyDrops(bot, origin, radius, matchName)) {
    if (Date.now() >= deadline) break;
    if (!bot.entities[drop.id]) continue;
    await goNear(bot, ctx, drop.position, 0.5, { timeoutMs: Math.max(1000, deadline - Date.now()) });
    await waitUntil(() => !bot.entities[drop.id], { timeoutMs: 800, signal: ctx.signal });
  }
  const gained = await waitUntil(() => countItems(bot, matchName) > before, { timeoutMs: 1500, signal: ctx.signal });
  const delta = countItems(bot, matchName) - before;
  return gained ? { ok: true, gained: delta } : fail('drops_not_collected', { gained: 0 });
}

// Foods worth eating at any hunger; risky foods only when starving.
const RISKY_FOODS = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'suspicious_stew']);

function pickFood(bot) {
  const foods = bot.registry.foodsByName || {};
  const candidates = bot.inventory.items().filter((item) => foods[item.name]);
  const safe = candidates.filter((item) => !RISKY_FOODS.has(item.name));
  const pool = safe.length ? safe : (bot.food <= 6 || bot.health <= 8 ? candidates : []);
  pool.sort((a, b) => (foods[b.name].foodPoints || 0) - (foods[a.name].foodPoints || 0));
  return pool[0] || null;
}

async function eat(bot, ctx, { timeoutMs = 5000 } = {}) {
  if (bot.food >= 20) return fail('not_hungry');
  const food = pickFood(bot);
  if (!food) return fail('no_food');
  const name = food.name;
  const countBefore = countItems(bot, (n) => n === name);
  const foodBefore = bot.food;
  try {
    await bot.equip(food, 'hand');
  } catch {
    return fail('equip_failed');
  }
  try {
    await runCancellable(() => bot.consume(), {
      signal: ctx.signal, timeoutMs, timeoutCode: 'eat_timeout', cancel: () => bot.deactivateItem(),
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    // consume() can reject although the server applied the meal; check below.
  }
  // Both facts must hold together: the item left the inventory AND hunger went up.
  const confirmed = await waitUntil(
    () => countItems(bot, (n) => n === name) < countBefore && (bot.food > foodBefore || bot.food >= 20),
    { timeoutMs: 2000, signal: ctx.signal });
  return confirmed ? { ok: true, ate: name } : fail('eat_unconfirmed', { ate: name });
}

const MATERIAL_RANK = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];
function weaponScore(name) {
  const [material, kind] = name.split('_');
  const rank = MATERIAL_RANK.indexOf(material);
  if (rank < 0) return -1;
  if (kind === 'sword') return 10 + rank * 2;
  if (kind === 'axe') return 9 + rank * 2;
  return -1;
}

function bestHandWeapon(bot) {
  return bot.inventory.items()
    .map((item) => ({ item, score: weaponScore(item.name) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)[0]?.item;
}

async function equipBestWeapon(bot) {
  const best = bestHandWeapon(bot);
  if (best && bot.heldItem?.name !== best.name) {
    try { await bot.equip(best, 'hand'); } catch { /* retry at melee reach */ }
  }
  const shield = bot.inventory.items().find((item) => item.name === 'shield');
  const offhand = bot.inventory.slots?.[45];
  if (shield && offhand?.name !== 'shield') {
    try { await bot.equip(shield, 'off-hand'); } catch { /* optional */ }
  }
  return best?.name;
}

// Mobs that a stray sweep turns on the bot, the whole pack at once.
const BYSTANDERS = new Set(['zombified_piglin', 'piglin', 'enderman', 'villager', 'iron_golem']);
const bystanderBeside = (bot, target) => Object.values(bot.entities).some((e) => e !== target && BYSTANDERS.has(e.name)
  && e.position && e.position.distanceTo(target.position) <= 2.5 && e.position.distanceTo(bot.entity.position) <= 4.5);
const MELEE_COOLDOWN_MS = 625;

/** Fights one entity until it is gone, the timeout passes, or the signal aborts. */
async function attack(bot, ctx, entityId, { timeoutMs = 15000, reach = 3, pursue = true } = {}) {
  const deadline = Date.now() + timeoutMs;
  try {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    const name = await equipBestWeapon(bot);
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    if (Date.now() >= deadline) return fail('combat_timeout');
    const weapon = { name, selectedAt: Date.now() };
    // Chasing something up on the surface from a pit needs the same climbing allowance.
    const first = bot.entities[entityId];
    if (pursue && first && first.position.y - bot.entity.position.y >= 1.5 && underground(bot)) {
      return await withClimbing(bot, first.position.y + 4, () => attackLoop(bot, ctx, entityId, deadline, reach, weapon, pursue));
    }
    return await attackLoop(bot, ctx, entityId, deadline, reach, weapon, pursue);
  } finally {
    haltBody(bot);
  }
}

async function attackLoop(bot, ctx, entityId, deadline, reach, weapon, pursue) {
  // A chase that has not closed in for 8 s is not going to (cliff, water, canopy).
  let closest = Infinity;
  let closestAt = Date.now();
  // Vanishing is not dying: an animal that wanders out of tracking range also
  // disappears. Only a seen death, or vanishing next to the bot after hits, counts.
  let died = false;
  let hits = 0;
  let lastDistance = Infinity;
  let lastSentAt = null;
  let decisionKey = null;
  const onDead = (entity) => { if (entity?.id === entityId) died = true; };
  bot.on?.('entityDead', onDead);
  try {
    while (Date.now() < deadline) {
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      if (died) return { ok: true, died, hits };
      const target = bot.entities[entityId];
      if (!target || !target.isValid) return died || (hits > 0 && lastDistance <= reach + 2) ? { ok: true, died, hits } : fail('target_lost');
      const geometry = meleeGeometry(bot.entity, target, bot.registry);
      if (!geometry) {
        ctx.record?.('combat_geometry_unknown', { targetId: entityId, mob: target.name, nativeWidth: target.width,
          nativeHeight: target.height, metadata: target.metadata ?? null, evidence: entitySizeEvidence(target, bot.registry) });
        return fail('unknown_target_geometry');
      }
      const distance = geometry.distance;
      const sight = distance <= reach ? meleeSight(bot, geometry) : 'out_of_reach';
      const canStrike = distance <= reach && sight === 'clear';
      lastDistance = distance;
      if (distance < closest - 0.5) { closest = distance; closestAt = Date.now(); }
      const key = `${geometry.size},${canStrike},${sight}`;
      if (key !== decisionKey) {
        decisionKey = key;
        ctx.record?.('combat_geometry', { targetId: entityId, mob: target.name, size: geometry.size,
          width: geometry.width, height: geometry.height, feetDistance: geometry.feetDistance, reachDistance: distance,
          sight, mode: canStrike ? 'strike' : pursue ? 'approach' : 'hold', reach });
      }
      if (!canStrike && !pursue) return fail('target_outside_stationary_reach');
      if (!canStrike && Date.now() - closestAt > 8000) {
        return fail(distance > reach ? 'chase_stuck' : sight === 'blocked' ? 'line_of_sight_blocked' : 'line_of_sight_unknown');
      }
      let sent = false;
      if (!canStrike) {
        // Set once: the observed hitbox goal tracks the target itself, and resetting it every
        // tick restarts path planning before any path is found.
        const current = bot.pathfinder.goal;
        if (!(current instanceof MeleeFollowGoal) || current.entity !== target || current.reach !== reach) {
          bot.pathfinder.setGoal(new MeleeFollowGoal(bot, target, reach), true);
        }
      } else {
        bot.pathfinder.setGoal(null);
        if (weapon.name && bot.heldItem?.name !== weapon.name) {
          // Pathfinder can leave the selected hand on a pickaxe, a building block
          // or an exhausted scaffold slot. The original weapon may also have broken.
          const item = bot.inventory.items().find((item) => item.name === weapon.name) || bestHandWeapon(bot);
          weapon.name = item?.name;
          if (item) {
            if (bot.heldItem?.name !== item.name) {
              try { await bot.equip(item, 'hand'); } catch { /* confirm the selected item below */ }
            }
            if (ctx.signal?.aborted) throw abortError(ctx.signal);
            if (died) return { ok: true, died, hits };
            if (bot.heldItem?.name !== item.name) return fail('weapon_equip_failed');
            weapon.selectedAt = Date.now();
            await sleep(Math.min(MELEE_COOLDOWN_MS, Math.max(0, deadline - weapon.selectedAt)), ctx.signal);
            // Let live reach and sight run again after the hand change and cooldown.
            continue;
          }
        }
        const aim = distance > 1e-6 ? geometry.point : target.position.offset(0, geometry.height * 0.5, 0);
        await bot.lookAt(aim, true);
        if (ctx.signal?.aborted) throw abortError(ctx.signal);
        if (died) return { ok: true, died, hits };
        // A sword's sweep from the ground also hits whatever stands beside the
        // target: one sweep at a wither skeleton angered a zombified piglin
        // pack, which beat the bot down into the lava. Hit mid-jump there, as
        // it falls: a critical hit, which never sweeps.
        if (bot.entity.onGround && bystanderBeside(bot, target)) {
          if (!pursue && bot.heldItem?.name.endsWith('_sword')) return fail('stationary_sweep_bystander');
          if (pursue) {
            bot.setControlState('jump', true);
            await waitUntil(() => !bot.entity.onGround && (bot.entity.velocity?.y ?? 0) < 0, { timeoutMs: 800, signal: ctx.signal }).catch(() => {});
            bot.setControlState('jump', false);
          }
        }
        if (ctx.signal?.aborted) throw abortError(ctx.signal);
        if (died) return { ok: true, died, hits };
        // Looking and the optional jump yield to packets. Recheck the same
        // live target and its sightline immediately before the attack packet.
        const fresh = bot.entities[entityId] === target && target.isValid && meleeGeometry(bot.entity, target, bot.registry);
        if (Date.now() < deadline && fresh && fresh.distance <= reach && meleeSight(bot, fresh) === 'clear'
          && (!weapon.name || bot.heldItem?.name === weapon.name)) {
          bot.attack(target);
          const sentAt = Date.now();
          ctx.record?.('combat_attack', { targetId: entityId, mob: target.name, size: fresh.size,
            width: fresh.width, height: fresh.height, feetDistance: fresh.feetDistance, reachDistance: fresh.distance,
            weapon: bot.heldItem?.name || null, sentAt, sinceWeaponSelectionMs: sentAt - weapon.selectedAt,
            sincePreviousAttackMs: lastSentAt === null ? null : sentAt - lastSentAt });
          lastSentAt = sentAt;
          lastDistance = fresh.distance;
          hits += 1;
          sent = true;
        }
      }
      await sleep(sent ? MELEE_COOLDOWN_MS : 150, ctx.signal);
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      if (died) return { ok: true, died, hits };
    }
    return fail('combat_timeout');
  } finally {
    bot.removeListener?.('entityDead', onDead);
    haltBody(bot);
  }
}

/** Runs away from `from` until at least `distance` blocks separate them. */
async function fleeFrom(bot, ctx, from, { distance = 16, timeoutMs = 8000 } = {}) {
  const goal = new goals.GoalInvert(new goals.GoalNear(from.x, from.y, from.z, distance));
  const result = await goTo(bot, ctx, goal, {
    timeoutMs, arrived: (at) => at.distanceTo(from) >= distance - 1,
  });
  return result;
}

/**
 * Gets the bot off a spot it cannot path away from (a tree top, a pit): first
 * walk out with a generous drop limit, then dig straight down. Restores the
 * movement settings afterwards.
 */
/**
 * Walks one block by hand toward any open neighbouring cell, sneaking and
 * stopping on its centre. A plain half-second walk carries the body about two
 * blocks: from the 3x2 obsidian ledge of a portal the server forced over a
 * Nether lava sea, that was one block past the ledge, nine times in one run.
 */
async function nudge(bot, ctx, { accept = () => true } = {}) {
  const start = bot.entity.position.clone();
  const feet = start.floored();
  const open = (b) => b && b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava';
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const cell = feet.offset(dx, 0, dz);
    if (!accept(cell) || !open(bot.blockAt(cell)) || !open(bot.blockAt(cell.offset(0, 1, 0)))) continue;
    if (bot.blockAt(cell.offset(0, -1, 0))?.boundingBox !== 'block') continue;
    const centre = cell.offset(0.5, 0, 0.5);
    try {
      bot.setControlState('sprint', false);
      bot.companionSneaking = true;
      bot.setControlState('sneak', true);
      for (let i = 0; i < 30; i += 1) {
        const p = bot.entity.position;
        if (Math.hypot(p.x - centre.x, p.z - centre.z) < 0.3) break;
        await bot.lookAt(centre.offset(0, 1.6, 0), true);
        bot.setControlState('forward', true);
        await sleep(50, ctx.signal);
      }
    } finally {
      bot.setControlState('forward', false);
      bot.setControlState('sneak', false);
      bot.companionSneaking = false;
    }
    if (bot.entity.position.distanceTo(start) > 0.7) return true;
  }
  return false;
}

/** On a tree canopy: break the leaves underfoot until standing on real ground. */
async function dropThroughLeaves(bot, ctx) {
  const start = bot.entity.position.clone();
  for (let i = 0; i < 10; i += 1) {
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!below) break;
    if (below.boundingBox === 'empty') {
      await waitUntil(() => bot.entity.onGround, { timeoutMs: 2000, signal: ctx.signal });
      continue;
    }
    if (!below.name.endsWith('_leaves')) break;
    const dug = await digBlock(bot, ctx, below, { timeoutMs: 4000 });
    if (!dug.ok) break;
    await waitUntil(() => bot.entity.onGround && bot.entity.position.y < below.position.y + 1.5, { timeoutMs: 2000, signal: ctx.signal });
  }
  return start.y - bot.entity.position.y >= 1;
}

/**
 * Shut in water under a ceiling (a flooded hole in a cave): scoop the water
 * up with an empty bucket so the bot can breathe and dig its way out. A bot
 * with no pickaxe spent hours in one, surfacing for air under the rock.
 */
async function drainPocket(bot, ctx) {
  if (!bot.entity?.isInWater || typeof bot.blockAt !== 'function' || typeof bot.inventory?.items !== 'function') return false;
  const feet = bot.entity.position.floored();
  const head = feet.offset(0, 1, 0);
  const ceiling = bot.blockAt(feet.offset(0, 2, 0));
  if (!ceiling || ceiling.boundingBox !== 'block') return false;
  const bucket = bot.inventory.items().find((i) => i.name === 'bucket');
  const sources = [];
  for (const base of [head, feet]) {
    for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const b = bot.blockAt(base.offset(dx, dy, dz));
      if (b?.name === 'water' && Number(b.getProperties?.().level) === 0) sources.push(b);
    }
  }
  if (!bucket || !sources.length) return blockInflow(bot, ctx, feet);
  try { await bot.equip(bucket, 'hand'); } catch (error) { if (error?.code === 'aborted') throw error; return false; }
  let drained = 0;
  for (const target of sources) {
    if (!bot.inventory.items().some((i) => i.name === 'bucket')) break;
    await bot.lookAt(target.position.offset(0.5, 0.5, 0.5), true);
    await sleep(100, ctx.signal);
    try { bot.activateItem(); } catch { /* checked below */ }
    if (await waitUntil(() => bot.blockAt(target.position)?.name !== 'water'
      || Number(bot.blockAt(target.position)?.getProperties?.().level) !== 0, { timeoutMs: 1000, signal: ctx.signal })) drained += 1;
  }
  if (drained) ctx.record?.('drain_pocket', { drained, at: `${feet.x},${feet.y},${feet.z}` });
  if (drained) return true;
  return blockInflow(bot, ctx, feet);
}

const FILLERS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone'];
/**
 * No source to scoop (the hole is fed by water running in from aside): wall
 * the inflow off with blocks, so the water drains away and the bot stands
 * dry under the lid, free to dig. True once its head is out of water.
 */
async function blockInflow(bot, ctx, feet) {
  const own = new Set([0, 1].map((dy) => `${feet.x},${feet.y + dy},${feet.z}`));
  const inflow = [];
  for (const dy of [1, 2]) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const b = bot.blockAt(feet.offset(dx, dy, dz));
      if (b?.name === 'water') inflow.push(b);
    }
  }
  if (!inflow.length || typeof bot.placeBlock !== 'function') return false;
  const filler = bot.inventory.items().find((i) => FILLERS.includes(i.name));
  if (!filler) return false;
  try { await bot.equip(filler, 'hand'); } catch (error) { if (error?.code === 'aborted') throw error; return false; }
  let walled = 0;
  for (const cell of inflow) {
    for (const [dx, dy, dz] of [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const ref = bot.blockAt(cell.position.offset(dx, dy, dz));
      if (!ref || ref.boundingBox !== 'block' || own.has(`${ref.position.x},${ref.position.y},${ref.position.z}`)) continue;
      try {
        await bot.lookAt(ref.position.offset(0.5 - dx * 0.5, 0.5 - dy * 0.5, 0.5 - dz * 0.5), true);
        await bot.placeBlock(ref, new Vec3(-dx, -dy, -dz));
        walled += 1;
      } catch (error) {
        if (error?.code === 'aborted') throw error;
        continue;
      }
      break;
    }
  }
  if (!walled) return false;
  ctx.record?.('block_inflow', { walled, at: `${feet.x},${feet.y},${feet.z}` });
  // Running water left behind drains in a few ticks.
  return waitUntil(() => bot.blockAt(feet.offset(0, 1, 0))?.name !== 'water', { timeoutMs: 4000, signal: ctx.signal });
}

async function unstick(bot, ctx) {
  const under = bot.blockAt(bot.entity.position.offset(0, -1, 0));
  if (under && under.name.endsWith('_leaves') && await dropThroughLeaves(bot, ctx)) return { ok: true, moved: 'off_canopy' };
  // Shut in by a closed door (shut for the night, never opened again by a
  // goal that is not the house's): the planner passes open doors only. An
  // hour of NoPath went by inside the house. Open it.
  if (await openNearDoor(bot, ctx)) return { ok: true, moved: 'opened_door' };
  // Afloat out at sea: the planner finds no path over open water. A bot sat
  // in a kelp bed far from land for over an hour. Swim for the nearest shore.
  if (await swimAshore(bot, ctx)) return { ok: true, moved: 'swam_ashore' };
  if (await stepOutOfPool(bot, ctx)) return { ok: true, moved: 'out_of_pool' };
  if (await drainPocket(bot, ctx)) return { ok: true, moved: 'drained_pocket' };
  if (await nudge(bot, ctx)) return { ok: true, moved: 'nudged' };
  const start = bot.entity.position.clone();
  const movements = bot.pathfinder.movements;
  // Down in a pit or a mine: pillar straight back up to ground level. With
  // nothing to pillar with, the pit walls supply it; failing that, dig a
  // staircase out.
  if (underground(bot)) {
    const surface = Number.isFinite(bot.companionSurfaceY) ? bot.companionSurfaceY : start.y + 6;
    if (countItems(bot, (n) => CLIMB_BLOCKS.includes(n)) < 4) await gatherClimbBlocks(bot, ctx);
    await withClimbing(bot, surface + 4, () => goTo(bot, ctx, new goals.GoalY(Math.floor(surface)), { timeoutMs: 30000,
      arrived: () => true }));
    if (bot.entity.position.y - start.y >= 2) return { ok: true, moved: 'climbed' };
    const stairs = await digStairsUp(bot, ctx, Number.isFinite(bot.companionSurfaceY) ? bot.companionSurfaceY : localSurfaceY(bot));
    if (stairs >= 2) return { ok: true, moved: 'stairs' };
  }
  const saved = movements.maxDropDown;
  // In the Nether a drop or a hole dug down may end in a lava sea: no deeper drops than the
  // Nether movements allow, and no digging down.
  const nether = String(bot.game?.dimension || '').endsWith('the_nether');
  try {
    // Fall damage is (height - 3); keep at least 5 health after any drop.
    if (!nether) movements.maxDropDown = Math.max(saved, Math.min(12, Math.floor(bot.health) - 2));
    const walkOut = async () => {
      for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        const goal = new goals.GoalNearXZ(start.x + Math.cos(angle) * 8, start.z + Math.sin(angle) * 8, 2);
        await goTo(bot, ctx, goal, { timeoutMs: 15000, arrived: () => true });
        if (bot.entity.position.distanceTo(start) > 3) return true;
      }
      return false;
    };
    if (await walkOut()) return { ok: true, moved: 'walked' };
    // Boxed in beside lava: try again with only the lava cells themselves shut.
    if (nether && await require('./nether').withLavaMarginsLifted(bot, walkOut)) return { ok: true, moved: 'walked_near_lava' };
    // Perched in a lattice of fences (a fortress balcony rail): the pathfinder
    // plans nothing from a fence top. An hour went by there. Break them away.
    if (await breakLattice(bot, ctx) && await walkOut()) return { ok: true, moved: 'broke_lattice' };
    // Afloat in a one-block hole of water under a low ceiling: the bot cannot
    // rise the step out, and nothing below is solid to dig. Half an hour went
    // by there. Open the headroom and try again.
    if (!nether && await openHeadroom(bot, ctx) && await walkOut()) return { ok: true, moved: 'opened_headroom' };
  } finally {
    movements.maxDropDown = saved;
  }
  for (let i = 0; i < (nether ? 0 : 8); i += 1) {
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!below || below.boundingBox !== 'block' || !bot.canDigBlock(below)) break;
    const dug = await digBlock(bot, ctx, below);
    if (!dug.ok) break;
    await waitUntil(() => bot.entity.onGround, { timeoutMs: 2000, signal: ctx.signal });
    if (start.y - bot.entity.position.y >= 2) return { ok: true, moved: 'dug_down' };
  }
  return bot.entity.position.distanceTo(start) > 2 ? { ok: true, moved: 'partial' } : fail('stuck');
}

/** Digs the block over the bot's head and those beside its head. True if any went. */
const SEA = new Set(['water', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column']);
const OPEN_AIR = /^(air|cave_air|void_air)$/;
const SHORE_SAND = new Set(['sand', 'red_sand']);

function backedSand(read, feet) {
  const support = feet.offset(0, -1, 0);
  const sand = (block) => SHORE_SAND.has(block?.name) && block.shapes?.length === 1
    && block.shapes[0].length === 6 && block.shapes[0].every((value, i) => value === Number(i >= 3));
  if (!sand(read(support))) return false;
  for (let depth = 1; depth <= 4; depth += 1) {
    const backing = read(support.offset(0, -depth, 0));
    if (sand(backing)) continue;
    return standable((p) => p.equals(support) ? backing : read(p), feet);
  }
  return false;
}

// After surfacing for air, stay in control until a nearby observed bank is
// reached. Returning immediately can let the body sink between breath cycles.
async function swimToNearbyBank(bot, ctx) {
  const read = (p) => bot.blockAt(p, false);
  const clear = (p) => OPEN_AIR.test(read(p)?.name);
  const surface = (p) => {
    const below = read(p.offset(0, -1, 0));
    return below?.name === 'water' && Number(below.getProperties?.()?.level) === 0
      && clear(p) && clear(p.offset(0, 1, 0));
  };
  const dry = (p) => standable(read, p) && !read(p.offset(0, -1, 0)).name.endsWith('_leaves')
    && clear(p.offset(0, 2, 0));
  const sand = (p) => clear(p) && clear(p.offset(0, 1, 0)) && clear(p.offset(0, 2, 0)) && backedSand(read, p);
  const shoreSteps = (bank) => {
    const queue = [{ at: bank, steps: [] }];
    const seen = new Set([bank.toString()]);
    for (const { at, steps } of queue) {
      if (steps.length >= 3) continue;
      for (const [dx, dz] of SIDES) for (const dy of [0, 1, -1]) {
        const p = at.offset(dx, dy, dz);
        const key = p.toString();
        if (seen.has(key) || dy && !clear((dy > 0 ? at : p).offset(0, 2, 0))) continue;
        if (dry(p)) return [...steps, p];
        if (!sand(p)) continue;
        seen.add(key);
        queue.push({ at: p, steps: [...steps, p] });
      }
    }
    return null;
  };
  const feet = bot.entity.position.floored();
  const from = [feet, feet.offset(0, 1, 0), feet.offset(0, 2, 0), feet.offset(0, 3, 0)].find(surface);
  const nearSurface = () => {
    const position = bot.entity.position;
    return position.y >= from.y - 1.5 && clear(position.offset(0, bot.entity.eyeHeight ?? 1.62, 0).floored());
  };
  if (!from) return false;
  let route;
  let sandRoute;
  for (const [dx, dz] of SIDES) {
    const water = [from];
    for (let distance = 1; distance <= 6 && distance < (route?.water.length ?? Infinity); distance += 1) {
      const p = from.offset(dx * distance, 0, dz * distance);
      const bank = [p, p.offset(0, 1, 0)].find(dry);
      if (bank) { route = { water, bank }; break; }
      const beach = [p, p.offset(0, 1, 0)].find(sand);
      if (beach) {
        const steps = shoreSteps(beach);
        if (steps && water.length < (sandRoute?.water.length ?? Infinity)) sandRoute = { water, bank: beach, steps };
        break;
      }
      if (!surface(p)) break;
      water.push(p);
    }
  }
  route ||= sandRoute;
  if (!route) return false;
  const { bank, water, steps } = route;
  const nextToBank = water.at(-1);
  const target = nextToBank.offset(.5, 0, .5);
  const forward = bank.minus(nextToBank);
  const nearLane = (p) => Math.abs(forward.x ? p.z - target.z : p.x - target.x) <= .22;
  const laneOpen = (position) => {
    const p = position.floored();
    const radius = (bot.entity.width || .6) / 2;
    const skirt = forward.x
      ? [Math.floor(position.z - radius), Math.floor(position.z + radius)].map((z) => new Vec3(p.x, from.y, z))
      : [Math.floor(position.x - radius), Math.floor(position.x + radius)].map((x) => new Vec3(x, from.y, p.z));
    return skirt.every(surface);
  };
  const acceptingBank = steps ? sand : dry;
  const clearStep = (a, b) => a.y === b.y || clear((b.y > a.y ? a : b).offset(0, 2, 0));
  const acceptsStep = (p, i) => (i === steps.length - 1 ? dry(p) : sand(p)) && clearStep(i === 0 ? bank : steps[i - 1], p);
  const valid = () => acceptingBank(bank) && (!steps || steps.every(acceptsStep)) && water.every(surface)
    && !bot.entity.isInLava && laneOpen(bot.entity.position);
  if (!valid()) return false;
  ctx.record?.('breathe_bank_route', { from, bank, distance: water.length });
  try {
    for (let tick = 0; tick < 100 && valid(); tick += 1) {
      const position = bot.entity.position;
      const cell = position.floored();
      if (!water.some((p) => p.x === cell.x && p.z === cell.z)) return false;
      if (!nearSurface()) {
        bot.setControlState('forward', false);
        bot.setControlState('jump', true);
        await sleep(50, ctx.signal);
        continue;
      }
      const centered = Math.hypot(position.x - target.x, position.z - target.z) <= .35;
      const aligned = centered && nearLane(position);
      if (aligned && bank.y <= cell.y + 1) {
        const landed = await swimAshore(bot, ctx, { maxTicks: 50, bank,
          acceptBank: (p) => acceptingBank(p) && (!steps || steps.every(acceptsStep)), surfaceY: from.y });
        ctx.record?.('breathe_bank_result', { bank, landed });
        if (!landed || !steps) return landed;
        let previous = bank;
        for (const [i, p] of steps.entries()) {
          const accepts = i === steps.length - 1 ? dry : sand;
          if (!bot.entity.position.floored().equals(previous) || !sand(previous) || !acceptsStep(p, i)) return false;
          const arrived = (pos) => bot.entity.onGround === true && !bot.entity.isInWater && pos.floored().equals(p) && accepts(p);
          const moved = await walkDry(bot, ctx, { goTo }, new goals.GoalBlock(p.x, p.y, p.z), {
            adjacent: p, supports: (_read, point) => accepts(point), arrived, timeoutMs: 2500,
          });
          if (!(moved.ok || moved.reason === 'not_arrived') || !await waitUntil(() => arrived(bot.entity.position), {
            timeoutMs: 600, signal: ctx.signal,
          })) return false;
          ctx.record?.('breathe_sand_bank_step', { from: previous, to: p });
          previous = p;
        }
        return true;
      }
      if (!aligned) await bot.lookAt(new Vec3(target.x, position.y + (bot.entity.eyeHeight ?? 1.62), target.z), true);
      ctx.signal?.throwIfAborted();
      if (!valid()) return false;
      bot.setControlState('forward', !aligned);
      bot.setControlState('jump', true);
      await sleep(50, ctx.signal);
    }
  } finally {
    bot.setControlState('forward', false);
    bot.setControlState('jump', false);
  }
  return false;
}
/** Out on open water, swims along the surface to the nearest land within sight. True once ashore. */
async function swimAshore(bot, ctx, { maxTicks = 1200, bank, acceptBank, surfaceY } = {}) {
  const feet = bot.entity.position.floored();
  const wet = (p) => SEA.has(bot.blockAt(p)?.name);
  if (!wet(feet) && !wet(feet.offset(0, -1, 0))) return false;
  if (bank) {
    // A caller can supply a verified adjacent landing without asking the
    // general open-water search to choose a distant shore.
    const canLand = () => acceptBank?.(bank) && !wet(bank) && !wet(bank.offset(0, 1, 0));
    if (!canLand() || Math.abs(feet.x - bank.x) + Math.abs(feet.z - bank.z) !== 1
      || bank.y < feet.y || bank.y > feet.y + 1) return false;
    const landed = () => bot.entity.onGround === true && !bot.entity.isInWater
      && bot.entity.position.floored().equals(bank) && canLand();
    const centre = bank.offset(.5, 0, .5);
    try {
      bot.pathfinder?.setGoal(null);
      bot.setControlState('sprint', false);
      for (let i = 0; i < maxTicks && !landed(); i += 1) {
        const p = bot.entity.position;
        const column = p.floored();
        if (!canLand() || bot.entity.isInLava || (column.x !== feet.x || column.z !== feet.z)
          && (column.x !== bank.x || column.z !== bank.z)) break;
        const close = Math.hypot(p.x - centre.x, p.z - centre.z) < .18;
        if (!close) await bot.lookAt(new Vec3(centre.x, p.y + (bot.entity.eyeHeight ?? 1.62), centre.z), true);
        bot.setControlState('forward', !close);
        // At the surface Mineflayer briefly alternates the water flag during
        // each bounce. Continue jumping while crossing onto dry bank support.
        bot.setControlState('jump', bot.entity.isInWater === true || (surfaceY !== undefined && p.y >= surfaceY - 1));
        await sleep(50, ctx.signal);
      }
      return landed();
    } finally {
      bot.setControlState('forward', false);
      bot.setControlState('jump', false);
    }
  }
  // Not a puddle: open water all round.
  if (![[2, 0], [-2, 0], [0, 2], [0, -2]].every(([dx, dz]) => wet(feet.offset(dx, -1, dz)))) return false;
  // Solid ground about the water's level with open air over it.
  const shore = bot.findBlock({ maxDistance: 96, matching: (b) => b.boundingBox === 'block' && !SEA.has(b.name),
    useExtraInfo: (b) => b.position.y >= feet.y - 2 && b.position.y <= feet.y + 1
      && bot.blockAt(b.position.offset(0, 1, 0))?.boundingBox === 'empty' && !SEA.has(bot.blockAt(b.position.offset(0, 1, 0))?.name) });
  // No land in sight: swim a stretch towards home, the way back to land.
  const home = typeof bot.companionHomeAt === 'function' ? bot.companionHomeAt() : null;
  if (!shore && !home) return false;
  const start = bot.entity.position.clone();
  const leg = home && Math.min(64, Math.hypot(home.x - start.x, home.z - start.z));
  const heading = home && Math.atan2(home.z - start.z, home.x - start.x);
  const target = shore ? shore.position.offset(0.5, 1, 0.5)
    : new Vec3(start.x + Math.cos(heading) * leg, start.y, start.z + Math.sin(heading) * leg);
  ctx.record('swim_ashore', { to: shore ? shore.position : target.floored(), home: !shore,
    distance: Math.round(Math.hypot(target.x - start.x, target.z - start.z)) });
  try {
    for (let i = 0; i < maxTicks; i += 1) {
      const here = bot.entity.position;
      if (Math.hypot(here.x - target.x, here.z - target.z) < 1.2 || (bot.entity.onGround && !wet(here.floored()))) break;
      await bot.lookAt(target.offset(0, 0.6, 0), true);
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      await sleep(50, ctx.signal);
    }
  } finally {
    bot.setControlState('forward', false);
    bot.setControlState('jump', false);
  }
  // Out, or beside the shore with a step left for the planner; out at sea, a good stretch nearer home.
  const end = bot.entity.position;
  if (!shore) return Math.hypot(end.x - start.x, end.z - start.z) > 16;
  return !wet(end.floored()) || Math.hypot(end.x - target.x, end.z - target.z) < 1.5;
}

/**
 * In a pool walled higher than a jump out of water (a flooded pit whose rim
 * stands two over the surface): dig the rim down to a step one block over
 * the water and climb out onto it. A bot swam in a 4x4 pit for an hour.
 */
async function stepOutOfPool(bot, ctx, { maxTicks = 200 } = {}) {
  const feet = bot.entity.position.floored();
  const wet = (p) => SEA.has(bot.blockAt(p)?.name);
  if (!wet(feet) && !wet(feet.offset(0, -1, 0))) return false;
  let top = wet(feet) ? feet : feet.offset(0, -1, 0);
  while (wet(top.offset(0, 1, 0))) top = top.offset(0, 1, 0);
  const here = bot.entity.position;
  const ledges = [];
  for (let dx = -4; dx <= 4; dx += 1) {
    for (let dz = -4; dz <= 4; dz += 1) {
      const from = top.offset(dx, 0, dz);
      if (!wet(from) || bot.blockAt(from.offset(0, 1, 0))?.boundingBox !== 'empty') continue;
      for (const [sx, sz] of SIDES) {
        const ledge = from.offset(sx, 0, sz);
        const b = bot.blockAt(ledge);
        if (b?.boundingBox !== 'block' || wet(ledge)) continue;
        ledges.push({ ledge, from, d: Math.hypot(ledge.x + 0.5 - here.x, ledge.z + 0.5 - here.z) });
      }
    }
  }
  ledges.sort((a, b) => a.d - b.d);
  const swimTo = async (target, done) => {
    try {
      for (let i = 0; i < maxTicks && !done(); i += 1) {
        // Eyes level or up: looking down at the water swims the bot under.
        const p = bot.entity.position;
        await bot.lookAt(new Vec3(target.x, Math.max(target.y, p.y + 1.62), target.z), true);
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        await sleep(50, ctx.signal);
      }
    } finally {
      bot.setControlState('forward', false);
      bot.setControlState('jump', false);
    }
  };
  for (const { ledge, from } of ledges.slice(0, 4)) {
    const cells = [ledge.offset(0, 1, 0), ledge.offset(0, 2, 0)];
    if (cells.some((c) => { const b = bot.blockAt(c); return FLUID.test(b?.name || '') || (b?.boundingBox !== 'empty' && b?.diggable === false); })) continue;
    // Swim up against the ledge, then cut the rim above it away.
    const beside = from.offset(0.5, 0.5, 0.5);
    await swimTo(beside, () => Math.hypot(bot.entity.position.x - beside.x, bot.entity.position.z - beside.z) < 0.8);
    let open = true;
    for (const c of cells) {
      const b = bot.blockAt(c);
      if (!b || b.boundingBox === 'empty') continue;
      const dug = await digBlock(bot, ctx, b, { timeoutMs: Math.max(8000, (Number(bot.digTime?.(b)) || 0) + 3000) });
      if (!dug.ok) { open = false; break; }
    }
    if (!open) continue;
    const step = ledge.offset(0.5, 1, 0.5);
    ctx.record('step_out_of_pool', { ledge: `${ledge.x},${ledge.y},${ledge.z}` });
    await swimTo(step, () => bot.entity.onGround && !wet(bot.entity.position.floored()));
    if (!wet(bot.entity.position.floored()) && bot.entity.position.y >= ledge.y + 0.9) return true;
  }
  return false;
}

const WOODEN_DOOR = /^(?!iron_).*_door$/;
/** Opens the nearest closed wooden door within a few blocks. True if one opened. */
async function openNearDoor(bot, ctx) {
  const block = bot.findBlock({ maxDistance: 6, useExtraInfo: true, matching: (b) => WOODEN_DOOR.test(b.name)
    && b.getProperties?.().half === 'lower' && b.getProperties().open === false });
  if (!block) return false;
  if (!withinReach(bot, block.position)) await goNear(bot, ctx, block.position, 2, { timeoutMs: 15000 });
  if (!withinReach(bot, block.position)) return false;
  try { await bot.activateBlock(bot.blockAt(block.position)); } catch { return false; }
  return waitUntil(() => bot.blockAt(block.position)?.getProperties?.().open === true, { timeoutMs: 1500, signal: ctx.signal });
}

async function openHeadroom(bot, ctx) {
  const head = bot.entity.position.floored().offset(0, 1, 0);
  const cells = [head.offset(0, 1, 0), ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => head.offset(dx, 0, dz))];
  let dug = 0;
  for (const cell of cells) {
    const block = bot.blockAt(cell);
    if (!block || block.boundingBox !== 'block' || !bot.canDigBlock(block)) continue;
    // Never open a ceiling that holds back water or lava.
    if (['water', 'lava'].includes(bot.blockAt(cell.offset(0, 1, 0))?.name)) continue;
    const result = await digBlock(bot, ctx, block);
    if (result.ok) dug += 1;
  }
  return dug > 0;
}

const LATTICE = /(_fence|_wall|iron_bars|_pane)$/;
/** Digs fences, walls and bars in and around the bot's body. True if any went. */
async function breakLattice(bot, ctx) {
  const feet = bot.entity.position.floored();
  const cells = [];
  for (let dy = -1; dy <= 1; dy += 1) for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) cells.push(feet.offset(dx, dy, dz));
  let broke = 0;
  for (const cell of cells) {
    const block = bot.blockAt(cell);
    if (!block || !LATTICE.test(block.name) || !bot.canDigBlock?.(block)) continue;
    const dug = await digBlock(bot, ctx, block);
    if (dug.ok) broke += 1;
  }
  if (broke) ctx.record?.('unstick_lattice', { broke });
  return broke > 0;
}

const FLUID = /water|lava/;
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const fluidNext = (bot, p) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  .some(([dx, dy, dz]) => FLUID.test(bot.blockAt(p.offset(dx, dy, dz))?.name || ''));
// Blocks whose drop can be pillared with: soil by hand, rock with a pickaxe.
const SOIL = /^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mycelium)$/;
const ROCK = /^(stone|cobblestone|deepslate|cobbled_deepslate)$/;

/** Digs a few pit-wall blocks at or above foot level for their dirt or cobblestone. */
async function gatherClimbBlocks(bot, ctx, { want = 6 } = {}) {
  const pickaxe = bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'));
  const feet = bot.entity.position.floored();
  const walls = [];
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      for (let dy = 0; dy <= 2; dy += 1) {
        if (dx === 0 && dz === 0) continue;
        const block = bot.blockAt(feet.offset(dx, dy, dz));
        if (!block || !(SOIL.test(block.name) || (pickaxe && ROCK.test(block.name)))) continue;
        if (fluidNext(bot, block.position) || !withinReach(bot, block.position)) continue;
        walls.push(block);
      }
    }
  }
  walls.sort((a, b) => Number(ROCK.test(a.name)) - Number(ROCK.test(b.name)));
  let gained = 0;
  for (const block of walls) {
    if (gained >= want) break;
    const before = countItems(bot, (n) => CLIMB_BLOCKS.includes(n));
    const dug = await digBlock(bot, ctx, block, { timeoutMs: 8000 });
    if (!dug.ok) continue;
    await collectDrops(bot, ctx, block.position.offset(0.5, 0.5, 0.5), (n) => CLIMB_BLOCKS.includes(n), { radius: 4, timeoutMs: 3000 });
    gained += Math.max(0, countItems(bot, (n) => CLIMB_BLOCKS.includes(n)) - before);
  }
  return gained;
}

/** The highest standing level among the columns a few blocks around the bot. */
function localSurfaceY(bot, { radius = 3, above = 10 } = {}) {
  const feet = bot.entity.position.floored();
  let best = feet.y;
  for (let i = 0; i < 8; i += 1) {
    const angle = (i * Math.PI) / 4;
    const column = feet.offset(Math.round(Math.cos(angle) * radius), 0, Math.round(Math.sin(angle) * radius));
    for (let dy = above; dy >= 0; dy -= 1) {
      if (solidGround(bot.blockAt(column.offset(0, dy, 0)))) { best = Math.max(best, feet.y + dy + 1); break; }
    }
  }
  return best;
}

/**
 * Digs a staircase up toward targetY: each step clears headroom above the bot
 * and two cells ahead one level up, then steps onto the block ahead. Never digs
 * next to water or lava. Returns how many steps were climbed.
 */
async function digStairsUp(bot, ctx, targetY, { maxSteps = 24 } = {}) {
  const clearable = (p) => {
    const b = bot.blockAt(p);
    if (!b || FLUID.test(b.name)) return false;
    if (b.boundingBox === 'empty') return true;
    return bot.canDigBlock(b) && b.diggable !== false && !fluidNext(bot, p);
  };
  let direction = null;
  let climbed = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    const feet = bot.entity.position.floored();
    if (feet.y >= Math.floor(targetY)) break;
    const sides = direction ? [direction, ...SIDES.filter((d) => d !== direction)] : SIDES;
    const next = sides.find(([dx, dz]) => {
      const ahead = feet.offset(dx, 0, dz);
      return bot.blockAt(ahead)?.boundingBox === 'block' && !FLUID.test(bot.blockAt(ahead).name)
        && clearable(feet.offset(0, 2, 0)) && clearable(ahead.offset(0, 1, 0)) && clearable(ahead.offset(0, 2, 0));
    });
    if (!next) break;
    direction = next;
    const ahead = feet.offset(next[0], 0, next[1]);
    for (const p of [feet.offset(0, 2, 0), ahead.offset(0, 2, 0), ahead.offset(0, 1, 0)]) {
      const b = bot.blockAt(p);
      if (b && b.boundingBox !== 'empty') {
        // Deepslate by hand takes 15 seconds a block: the timeout follows the dig.
        const digMs = typeof bot.digTime === 'function' ? bot.digTime(b) : 0;
        const dug = await digBlock(bot, ctx, b, { timeoutMs: Math.max(8000, (Number(digMs) || 0) + 3000) });
        if (!dug.ok) return climbed;
      }
    }
    const up = ahead.offset(0, 1, 0);
    const moved = await goToOnce(bot, ctx, new goals.GoalBlock(up.x, up.y, up.z), { timeoutMs: 5000 });
    if (!moved.ok || bot.entity.position.y < feet.y + 0.9) return climbed;
    climbed += 1;
  }
  return climbed;
}

/**
 * Digs a staircase down toward `target` (a position): each step clears the
 * two cells ahead and the one below them, then steps down onto solid floor.
 * Never digs a block touching water or lava, and never steps onto a floor
 * with lava under it; a blocked heading turns. Returns how many steps went down.
 */
/** Walks onto the cell `into` (one block over and one down), by hand. */
async function stepInto(bot, ctx, into) {
  const centre = into.offset(0.5, 0, 0.5);
  try {
    for (let i = 0; i < 40; i += 1) {
      const p = bot.entity.position;
      if (p.floored().y <= into.y && Math.hypot(p.x - centre.x, p.z - centre.z) < 0.4) break;
      await bot.lookAt(centre.offset(0, 1.6, 0), true);
      bot.setControlState('forward', Math.hypot(p.x - centre.x, p.z - centre.z) > 0.25);
      await new Promise((r) => setTimeout(r, 75));
      if (ctx.signal?.aborted) break;
    }
  } finally {
    bot.setControlState('forward', false);
  }
}

async function digStairsDown(bot, ctx, target, { maxSteps = 16 } = {}) {
  const clearable = (p) => {
    const b = bot.blockAt(p);
    if (!b || FLUID.test(b.name)) return false;
    if (b.boundingBox === 'empty') return !fluidNext(bot, p);
    return bot.canDigBlock(b) && b.diggable !== false && !fluidNext(bot, p);
  };
  const floorOk = (p) => {
    const b = bot.blockAt(p);
    return b && b.boundingBox === 'block' && !FLUID.test(b.name) && !/magma/.test(b.name)
      && !FLUID.test(bot.blockAt(p.offset(0, -1, 0))?.name || '');
  };
  let down = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    const feet = bot.entity.position.floored();
    if (feet.y <= target.y) break;
    const dx = target.x - feet.x;
    const dz = target.z - feet.z;
    const toward = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dz) || 1];
    const order = [toward, ...SIDES.filter(([x, z]) => x !== toward[0] || z !== toward[1])];
    const next = order.find(([x, z]) => {
      const ahead = feet.offset(x, 0, z);
      return clearable(ahead.offset(0, 1, 0)) && clearable(ahead) && clearable(ahead.offset(0, -1, 0)) && floorOk(ahead.offset(0, -2, 0));
    });
    if (!next) {
      ctx.record?.('stairs_blocked', { at: `${feet.x},${feet.y},${feet.z}`, sides: order.map(([x, z]) => {
        const a = feet.offset(x, 0, z);
        return [clearable(a.offset(0, 1, 0)), clearable(a), clearable(a.offset(0, -1, 0)), floorOk(a.offset(0, -2, 0))].map(Number).join('');
      }) });
      break;
    }
    const ahead = feet.offset(next[0], 0, next[1]);
    for (const p of [ahead.offset(0, 1, 0), ahead, ahead.offset(0, -1, 0)]) {
      // Sand or gravel overhead falls into the cell again: dig until it stays open.
      for (let tries = 0; tries < 8; tries += 1) {
        const b = bot.blockAt(p);
        if (!b || b.boundingBox === 'empty') break;
        if (tries === 0) haltBody(bot);
        const dug = await digBlock(bot, ctx, b, { timeoutMs: 8000 });
        // Unconfirmed: sand fell back in, or the server dropped the break; dig again.
        if (dug.ok || (dug.reason === 'dig_unconfirmed' && tries < 7)) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        ctx.record?.('stairs_dig_failed', { block: b.name, at: `${p.x},${p.y},${p.z}`, reason: dug.reason || null });
        return down;
      }
    }
    const into = ahead.offset(0, -1, 0);
    const moved = await goToOnce(bot, ctx, new goals.GoalBlock(into.x, into.y, into.z), { timeoutMs: 5000 });
    // The pathfinder can call a one-block step down done before the body
    // drops; walk it by hand.
    if (bot.entity.position.floored().y >= feet.y) await stepInto(bot, ctx, into);
    if (bot.entity.position.floored().y >= feet.y) {
      ctx.record?.('stairs_step_failed', { reason: moved.reason || null, into: `${into.x},${into.y},${into.z}` });
      return down;
    }
    down += 1;
  }
  return down;
}

/** Climbs back to the surface reference level if the bot is below it. */
async function surface(bot, ctx) {
  if (!Number.isFinite(bot.companionSurfaceY) || bot.entity.position.y >= bot.companionSurfaceY - 1) return null;
  if (!underground(bot)) return null;
  const target = Math.floor(bot.companionSurfaceY);
  await withClimbing(bot, target + 4, () => goTo(bot, ctx, new goals.GoalY(target), { timeoutMs: 30000, arrived: () => true }));
  // The pathfinder found no way up in time: dig a staircase the rest of the way.
  if (bot.entity.position.y < target - 1) {
    await digStairsUp(bot, ctx, target, { maxSteps: target - Math.floor(bot.entity.position.y) + 4 });
  }
  return bot.entity.position.y >= target - 1 ? { ok: true, surfaced: true } : fail('still_below_surface');
}

module.exports = {
  backedSand,
  drainPocket,
  recentre, surface, underground, unstick, nudge, breakLattice, openHeadroom, openNearDoor, swimAshore, swimToNearbyBank, stepOutOfPool, gatherClimbBlocks, digStairsUp, digStairsDown, goTo, goNear, goToDig, withinReach, digBlock, collectDrops, countItems, eat, pickFood, attack, fleeFrom,
  equipBestWeapon, haltBody, weaponScore, droppedItemName, RISKY_FOODS,
};
