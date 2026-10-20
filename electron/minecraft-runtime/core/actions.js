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

async function goTo(bot, ctx, goal, { timeoutMs = 30000, arrived } = {}) {
  try {
    await runCancellable(() => bot.pathfinder.goto(goal), {
      signal: ctx.signal, timeoutMs, timeoutCode: 'path_timeout', cancel: () => haltBody(bot),
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    haltBody(bot);
    return fail(error?.code || error?.name || 'path_failed');
  }
  // Pathfinder can "finish" with an empty path; arrival must be checked.
  const at = bot.entity.position;
  const reached = arrived ? arrived(at) : goal.isEnd(at.floored());
  return reached ? { ok: true } : fail('not_arrived');
}

function goNear(bot, ctx, position, range = 2, options = {}) {
  const goal = new goals.GoalNear(position.x, position.y, position.z, range);
  return goTo(bot, ctx, goal, {
    ...options,
    arrived: (at) => at.distanceTo(position) <= range + 1.5,
  });
}

/** Moves to any spot from which `block` can be seen and dug. */
function goToDig(bot, ctx, block, options = {}) {
  const goal = new goals.GoalLookAtBlock(block.position, bot.world, { reach: 4 });
  return goTo(bot, ctx, goal, {
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
  try {
    while (Date.now() < deadline) {
      const target = bot.entities[entityId];
      if (!target || !target.isValid) return { ok: true };
      const distance = target.position.distanceTo(bot.entity.position);
      if (distance > reach) {
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 1.5), true);
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
async function unstick(bot, ctx) {
  const start = bot.entity.position.clone();
  const movements = bot.pathfinder.movements;
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

module.exports = {
  unstick, goTo, goNear, goToDig, withinReach, digBlock, collectDrops, countItems, eat, pickFood, attack, fleeFrom,
  equipBestWeapon, haltBody, weaponScore, RISKY_FOODS,
};
