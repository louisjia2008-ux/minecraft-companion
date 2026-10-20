'use strict';
// Short, cancellable body actions. Each one:
//   - finishes within its own timeout (seconds, never minutes),
//   - stops the body when ctx.signal aborts,
//   - returns { ok, reason } and only reports ok once the server-side effect is
//     observed (block gone, item counted, hunger restored), not when a call returns.
// Recovery is not done here: the caller picks another target or gives up.

const { goals } = require('mineflayer-pathfinder');
const { waitUntil, runCancellable, sleep } = require('./confirm');
const { ownedItems } = require('./perception');

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const isAbort = (error) => error?.code === 'aborted';

function haltBody(bot) {
  try { bot.pathfinder?.setGoal(null); } catch (_) { /* ignore */ }
  try { bot.clearControlStates?.(); } catch (_) { /* ignore */ }
}

// Climbing out of a mine needs pillaring: allow it, with dirt or cobblestone,
// only while the destination lies well above the bot. Pillars left in a shaft
// are harmless; on the surface the bot never pillars.
const CLIMB_BLOCKS = ['dirt', 'cobblestone', 'cobbled_deepslate'];
async function withClimbing(bot, targetY, run) {
  const movements = bot.pathfinder?.movements;
  if (!movements || !Number.isFinite(targetY) || targetY - bot.entity.position.y <= 3 || !underground(bot)) return run();
  const saved = { towers: movements.allow1by1towers, scaffold: movements.scafoldingBlocks };
  movements.allow1by1towers = true;
  movements.scafoldingBlocks = CLIMB_BLOCKS.map((name) => bot.registry.itemsByName[name]?.id).filter(Number.isInteger);
  try {
    return await run();
  } finally {
    movements.allow1by1towers = saved.towers;
    movements.scafoldingBlocks = saved.scaffold;
  }
}

const solidGround = (block) => block && block.boundingBox === 'block' && !block.name.endsWith('_leaves')
  && !block.name.endsWith('_log');

/**
 * Below ground: rock or soil over the head, or standing in a pit whose sides
 * rise above head height. Under a tree canopy does not count.
 */
function underground(bot) {
  const feet = bot.entity.position.floored();
  // A goal that knows the local ground level (the house site) says so directly.
  if (Number.isFinite(bot.companionSurfaceY) && feet.y < bot.companionSurfaceY - 1) return true;
  for (let dy = 2; dy < 10; dy += 1) if (solidGround(bot.blockAt(feet.offset(0, dy, 0)))) return true;
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
async function recentre(bot, ctx) {
  const centre = bot.entity.position.floored().offset(0.5, 0, 0.5);
  const distance = () => Math.hypot(bot.entity.position.x - centre.x, bot.entity.position.z - centre.z);
  try {
    for (let i = 0; i < 20 && distance() > 0.15; i += 1) {
      await bot.lookAt(centre.offset(0, bot.entity.position.y - centre.y + 1.6, 0), true);
      bot.setControlState('sprint', false);
      bot.setControlState('forward', true);
      await sleep(Math.min(150, distance() * 250), ctx.signal);
    }
  } finally {
    bot.setControlState('forward', false);
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
  if (first.reason !== 'no_progress') return first;
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

function goNear(bot, ctx, position, range = 2, options = {}) {
  const goal = new goals.GoalNear(position.x, position.y, position.z, range);
  return goTo(bot, ctx, goal, {
    targetY: position.y,
    ...options,
    arrived: (at) => at.distanceTo(position) <= range + 1.5,
  });
}

/** Moves to any spot from which `block` can be seen and dug. */
function goToDig(bot, ctx, block, options = {}) {
  // Plants have no collision shape, so a line-of-sight goal can never be met.
  if (block.boundingBox === 'empty') {
    return goTo(bot, ctx, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), {
      targetY: block.position.y, ...options, arrived: () => withinReach(bot, block.position),
    });
  }
  const goal = new goals.GoalLookAtBlock(block.position, bot.world, { reach: 4 });
  return goTo(bot, ctx, goal, {
    targetY: block.position.y - 1,
    ...options,
    arrived: () => withinReach(bot, block.position),
  });
}

function withinReach(bot, position, reach = 4.5) {
  const eye = bot.entity.position.offset(0, 1.62, 0);
  return eye.distanceTo(position.offset(0.5, 0.5, 0.5)) <= reach;
}

async function digBlock(bot, ctx, block, { timeoutMs = 12000 } = {}) {
  const position = block.position;
  const originalName = block.name;
  if (!withinReach(bot, position)) return fail('out_of_reach');
  const tool = bot.pathfinder?.bestHarvestTool?.(block);
  if (tool) {
    try { await bot.equip(tool, 'hand'); } catch (_) { /* digging by hand still works, slower */ }
  }
  const current = bot.blockAt(position);
  if (!current || current.name !== originalName) return fail('block_changed');
  if (!bot.canDigBlock(current)) return fail('cannot_dig');
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
  try { return entity.getDroppedItem?.()?.name || null; } catch (_) { return null; }
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
  const pool = safe.length ? safe : (bot.food <= 6 ? candidates : []);
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
  } catch (error) {
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

async function equipBestWeapon(bot) {
  const best = bot.inventory.items()
    .map((item) => ({ item, score: weaponScore(item.name) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)[0];
  if (best && bot.heldItem?.name !== best.item.name) {
    try { await bot.equip(best.item, 'hand'); } catch (_) { /* fight with whatever is held */ }
  }
  const shield = bot.inventory.items().find((item) => item.name === 'shield');
  const offhand = bot.inventory.slots?.[45];
  if (shield && offhand?.name !== 'shield') {
    try { await bot.equip(shield, 'off-hand'); } catch (_) { /* optional */ }
  }
}

/** Fights one entity until it is gone, the timeout passes, or the signal aborts. */
async function attack(bot, ctx, entityId, { timeoutMs = 15000, reach = 3 } = {}) {
  await equipBestWeapon(bot);
  const deadline = Date.now() + timeoutMs;
  // Chasing something up on the surface from a pit needs the same climbing allowance.
  const first = bot.entities[entityId];
  if (first && first.position.y - bot.entity.position.y >= 1.5 && underground(bot)) {
    return withClimbing(bot, first.position.y + 4, () => attackLoop(bot, ctx, entityId, deadline, reach));
  }
  return attackLoop(bot, ctx, entityId, deadline, reach);
}

async function attackLoop(bot, ctx, entityId, deadline, reach) {
  try {
    while (Date.now() < deadline) {
      const target = bot.entities[entityId];
      if (!target || !target.isValid) return { ok: true };
      const distance = target.position.distanceTo(bot.entity.position);
      if (distance > reach) {
        // Set once: GoalFollow tracks the target itself, and resetting it every
        // tick restarts path planning before any path is found.
        const current = bot.pathfinder.goal;
        if (!(current instanceof goals.GoalFollow) || current.entity !== target) {
          bot.pathfinder.setGoal(new goals.GoalFollow(target, 1.5), true);
        }
      } else {
        bot.pathfinder.setGoal(null);
        await bot.lookAt(target.position.offset(0, (target.height || 1.6) * 0.8, 0), true);
        bot.attack(target);
      }
      await sleep(distance > reach ? 150 : 625, ctx.signal); // sword attack cooldown
    }
    return fail('combat_timeout');
  } finally {
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
/** Walks one block by hand toward any open neighbouring cell. */
async function nudge(bot, ctx) {
  const start = bot.entity.position.clone();
  const feet = start.floored();
  const open = (b) => b && b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava';
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const cell = feet.offset(dx, 0, dz);
    if (!open(bot.blockAt(cell)) || !open(bot.blockAt(cell.offset(0, 1, 0)))) continue;
    if (bot.blockAt(cell.offset(0, -1, 0))?.boundingBox !== 'block') continue;
    await bot.lookAt(cell.offset(0.5, 1.6, 0.5), true);
    bot.setControlState('forward', true);
    try { await sleep(450, ctx.signal); } finally { bot.setControlState('forward', false); }
    if (bot.entity.position.distanceTo(start) > 0.7) return true;
  }
  return false;
}

async function unstick(bot, ctx) {
  if (await nudge(bot, ctx)) return { ok: true, moved: 'nudged' };
  const start = bot.entity.position.clone();
  const movements = bot.pathfinder.movements;
  // Down in a pit or a mine: pillar straight back up to ground level.
  if (underground(bot)) {
    const surface = Number.isFinite(bot.companionSurfaceY) ? bot.companionSurfaceY : start.y + 6;
    await withClimbing(bot, surface + 4, () => goTo(bot, ctx, new goals.GoalY(Math.floor(surface)), { timeoutMs: 30000,
      arrived: () => true }));
    if (bot.entity.position.y - start.y >= 2) return { ok: true, moved: 'climbed' };
  }
  const saved = movements.maxDropDown;
  try {
    if (bot.health > 8) movements.maxDropDown = 12;
    for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      const goal = new goals.GoalNearXZ(start.x + Math.cos(angle) * 8, start.z + Math.sin(angle) * 8, 2);
      await goTo(bot, ctx, goal, { timeoutMs: 15000, arrived: () => true });
      if (bot.entity.position.distanceTo(start) > 3) return { ok: true, moved: 'walked' };
    }
  } finally {
    movements.maxDropDown = saved;
  }
  for (let i = 0; i < 8; i += 1) {
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!below || below.boundingBox !== 'block' || !bot.canDigBlock(below)) break;
    const dug = await digBlock(bot, ctx, below);
    if (!dug.ok) break;
    await waitUntil(() => bot.entity.onGround, { timeoutMs: 2000, signal: ctx.signal });
    if (start.y - bot.entity.position.y >= 2) return { ok: true, moved: 'dug_down' };
  }
  return bot.entity.position.distanceTo(start) > 2 ? { ok: true, moved: 'partial' } : fail('stuck');
}

/** Climbs back to the surface reference level if the bot is below it. */
async function surface(bot, ctx) {
  if (!Number.isFinite(bot.companionSurfaceY) || bot.entity.position.y >= bot.companionSurfaceY - 1) return null;
  const target = Math.floor(bot.companionSurfaceY);
  await withClimbing(bot, target + 4, () => goTo(bot, ctx, new goals.GoalY(target), { timeoutMs: 30000, arrived: () => true }));
  return bot.entity.position.y >= target - 1 ? { ok: true, surfaced: true } : fail('still_below_surface');
}

module.exports = {
  recentre, surface, underground, unstick, goTo, goNear, goToDig, withinReach, digBlock, collectDrops, countItems, eat, pickFood, attack, fleeFrom,
  equipBestWeapon, haltBody, weaponScore, RISKY_FOODS,
};
