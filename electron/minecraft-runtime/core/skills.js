'use strict';
// Executors for planner steps. Same contract as actions.js: short, cancellable,
// confirmed by observed state, and returning { ok, reason } without retrying.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const actions = require('./actions');
const { waitUntil, runCancellable, sleep } = require('./confirm');
const { posKey } = require('./blacklist');
const { FUELS } = require('./knowledge');
const { ownedItems } = require('./perception');

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const isAbort = (error) => error?.code === 'aborted';
const v = (p) => new Vec3(p.x, p.y, p.z);
const AIR = new Set(['air', 'cave_air', 'void_air']);

function inventoryCounts(bot) {
  const counts = {};
  for (const item of ownedItems(bot)) counts[item.name] = (counts[item.name] || 0) + item.count;
  return counts;
}

/** Breaks one matching block (nearest, cheapest first) and collects its drop. */
async function gatherOne(bot, ctx, { blocks, dropMatch, blacklist, exclude = () => false, radius = 48 }) {
  const ids = Object.values(bot.registry.blocksByName).filter((b) => blocks(b.name)).map((b) => b.id);
  if (ids.length === 0) return fail('unknown_block');
  const here = bot.entity.position;
  const candidates = bot.findBlocks({ matching: ids, maxDistance: radius, count: 64 })
    .filter((p) => !blacklist.has(posKey(p)) && !exclude(p))
    .map((p) => bot.blockAt(p))
    .filter(Boolean)
    // Exposed blocks first: keeps mining inside one open pit instead of
    // digging a fresh hole through the soil for every single stone.
    .sort((a, b) => cost(here, a.position) + buried(bot, a.position) - cost(here, b.position) - buried(bot, b.position));
  if (candidates.length === 0) return fail('no_target_in_range');
  const block = candidates[0];
  const key = posKey(block.position);
  ctx.record('target_selected', { block: block.name, position: key, options: candidates.length });
  if (block.harvestTools && !bot.inventory.items().some((item) => block.harvestTools[item.type])) {
    blacklist.add(key, 'no_tool', 30000);
    return fail('no_tool');
  }
  const reach = await actions.goToDig(bot, ctx, block, { timeoutMs: 45000 });
  if (!reach.ok) {
    blacklist.add(key, reach.reason);
    return reach;
  }
  const dig = await actions.digBlock(bot, ctx, bot.blockAt(block.position) || block);
  if (!dig.ok) {
    blacklist.add(key, dig.reason);
    return dig;
  }
  return actions.collectDrops(bot, ctx, block.position.offset(0.5, 0.5, 0.5), dropMatch);
}

const SIDES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
function buried(bot, p) {
  for (const [dx, dy, dz] of SIDES) {
    const n = bot.blockAt(p.offset(dx, dy, dz));
    if (n && n.boundingBox === 'empty' && n.name !== 'water' && n.name !== 'lava') return 0;
  }
  return 12;
}

function cost(from, to) {
  const dy = to.y - from.y;
  return Math.hypot(to.x + 0.5 - from.x, to.z + 0.5 - from.z) + Math.max(0, dy) * 3 + Math.max(0, -dy) * 1.2;
}

async function goToBlock(bot, ctx, position, reach = 4) {
  if (actions.withinReach(bot, v(position), reach)) return { ok: true };
  const result = await actions.goNear(bot, ctx, v(position), 2, { timeoutMs: 45000 });
  if (actions.withinReach(bot, v(position), 4.5)) return { ok: true };
  return result.ok ? fail('station_out_of_reach') : result;
}

async function craft(bot, ctx, { item, times = 1, tablePosition = null }) {
  const info = bot.registry.itemsByName[item];
  if (!info) return fail('unknown_item');
  let table = null;
  if (tablePosition) {
    const moved = await goToBlock(bot, ctx, tablePosition);
    if (!moved.ok) return moved;
    table = bot.blockAt(v(tablePosition));
    if (table?.name !== 'crafting_table') return fail('table_missing');
  }
  const before = actions.countItems(bot, (n) => n === item);
  let crafted = 0;
  for (let i = 0; i < times; i += 1) {
    const recipe = bot.recipesFor(info.id, null, 1, table)[0];
    if (!recipe) break;
    const count = actions.countItems(bot, (n) => n === item);
    try {
      await runCancellable(() => bot.craft(recipe, 1, table), { signal: ctx.signal, timeoutMs: 8000,
        timeoutCode: 'craft_timeout', cancel: () => bot.closeWindow?.(bot.currentWindow) });
    } catch (error) {
      if (isAbort(error)) throw error;
    }
    if (await waitUntil(() => actions.countItems(bot, (n) => n === item) > count, { timeoutMs: 1500, signal: ctx.signal })) {
      crafted += 1;
    } else break;
  }
  if (crafted === 0) {
    if (bot.recipesFor(info.id, null, 1, table).length) return fail('craft_unconfirmed');
    // Say exactly what is short (the bot's count can drift from the server's).
    const have = inventoryCounts(bot);
    const recipe = bot.recipesAll(info.id, null, table)
      .map((r) => r.delta.filter((d) => d.count < 0).map((d) => ({ name: bot.registry.items[d.id]?.name, need: -d.count })))
      .sort((a, b) => shortBy(a, have) - shortBy(b, have))[0] || [];
    const missing = recipe.filter((d) => (have[d.name] || 0) < d.need)
      .map((d) => ({ name: d.name, short: d.need - (have[d.name] || 0) }));
    return fail('missing_ingredients', { missing });
  }
  return { ok: true, crafted, gained: actions.countItems(bot, (n) => n === item) - before, usedTable: Boolean(table) };
}

function shortBy(ingredients, have) {
  return ingredients.reduce((sum, d) => sum + Math.max(0, d.need - (have[d.name] || 0)), 0);
}

/**
 * Places `itemMatch` at `position`. Options:
 *   faces  - allowed directions from the target to its supporting block
 *   stand  - exact cell to stand in (orientation-sensitive blocks like beds)
 *   verify - extra check after placing (e.g. both bed halves)
 */
async function placeAt(bot, ctx, position, itemMatch, { faces, stand, verify } = {}) {
  const target = v(position);
  const current = bot.blockAt(target);
  if (current && itemMatch(current.name)) return { ok: true, already: true };
  if (current && !AIR.has(current.name)) {
    if (current.boundingBox !== 'empty' || current.name === 'water' || current.name === 'lava') return fail('occupied');
    // Grass or flowers: break them first.
    const reach = await actions.goToDig(bot, ctx, current, { timeoutMs: 20000 });
    if (!reach.ok) return reach;
    const dug = await actions.digBlock(bot, ctx, current);
    if (!dug.ok) return dug;
  }
  const item = bot.inventory.items().find((i) => itemMatch(i.name));
  if (!item) return fail('no_material');

  let ref;
  let face;
  if (stand) {
    const moved = await actions.goNear(bot, ctx, v(stand).offset(0.5, 0, 0.5), 0, { timeoutMs: 30000 });
    if (!moved.ok && bot.entity.position.floored().distanceTo(v(stand)) > 0.5) return moved;
    ref = bot.blockAt(target.offset(0, -1, 0));
    face = new Vec3(0, 1, 0);
  } else {
    const goal = new goals.GoalPlaceBlock(target, bot.world, { range: 4.5, LOS: true, faces });
    // Same eye point the goal itself uses, so "arrived" agrees with the pathfinder.
    const head = () => bot.entity.position.floored().offset(0.5, 1.6, 0.5);
    const usable = () => goal.getFaceAndRef(head()) !== null && !overlaps(bot.entity, target);
    // Straddling the target cell's edge: step to the middle of our own cell first.
    if (overlaps(bot.entity, target) && !bot.entity.position.floored().equals(target)) await actions.recentre(bot, ctx);
    if (!usable()) {
      // Also taken when the bot itself stands in (or straddles) the target cell.
      const result = await goToGoal(bot, ctx, goal, usable);
      if (!result.ok) return result;
    }
    const found = goal.getFaceAndRef(head());
    if (!found) return fail('no_placement_face');
    ref = bot.blockAt(found.ref);
    face = found.face.scaled(-1);
  }
  if (!ref || ref.boundingBox !== 'block') return fail('no_support');
  if (entityInside(bot, target)) return fail('cell_occupied_by_entity');
  try {
    await bot.equip(item, 'hand');
    await runCancellable(() => bot.placeBlock(ref, face), { signal: ctx.signal, timeoutMs: 6000, timeoutCode: 'place_timeout' });
  } catch (error) {
    if (isAbort(error)) throw error;
  }
  const placed = await waitUntil(() => {
    const block = bot.blockAt(target);
    return block && itemMatch(block.name) && (!verify || verify());
  }, { timeoutMs: 1500, signal: ctx.signal });
  if (placed) return { ok: true };
  ctx.record('place_failed', { target: posKey(target), ref: posKey(ref.position), refBlock: ref.name,
    face: `${face.x},${face.y},${face.z}`, at: posKey(bot.entity.position), now: bot.blockAt(target)?.name || null,
    holding: bot.heldItem?.name || null });
  return fail('place_unconfirmed');
}

function goToGoal(bot, ctx, goal, arrived) {
  return actions.goTo(bot, ctx, goal, { timeoutMs: 15000, arrived, targetY: goal.pos?.y });
}

function overlaps(entity, target) {
  if (!entity?.position) return false;
  const p = entity.position;
  const w = (entity.width || 0.6) / 2;
  return p.x + w > target.x && p.x - w < target.x + 1 && p.z + w > target.z && p.z - w < target.z + 1
    && p.y < target.y + 1 && p.y + (entity.height || 1.8) > target.y;
}

function entityInside(bot, target) {
  return Object.values(bot.entities).some((entity) => entity.name !== 'item' && entity.type !== 'orb'
    && overlaps(entity, target));
}

function pickFuel(bot, items) {
  const inventory = inventoryCounts(bot);
  for (const [name, rate] of FUELS) {
    if ((inventory[name] || 0) * rate >= items) return { name, count: Math.ceil(items / rate) };
  }
  for (const [name, rate] of FUELS) if (inventory[name]) return { name, count: Math.min(inventory[name], Math.ceil(items / rate)) };
  return null;
}

/**
 * Smelts at the home furnace. Collects any finished output first, tops up input
 * and fuel, then waits for output. `memory` tracks what was left inside so the
 * planner does not gather the same input twice after an interruption.
 */
async function smelt(bot, ctx, { input, count, furnacePosition, memory }) {
  const moved = await goToBlock(bot, ctx, furnacePosition);
  if (!moved.ok) return moved;
  const block = bot.blockAt(v(furnacePosition));
  if (block?.name !== 'furnace') return fail('furnace_missing');
  let furnace;
  try {
    furnace = await runCancellable(() => bot.openFurnace(block), { signal: ctx.signal, timeoutMs: 5000, timeoutCode: 'open_timeout' });
  } catch (error) {
    if (isAbort(error)) throw error;
    return fail('furnace_open_failed');
  }
  // bot.inventory is only resynced when the window closes, so what was taken
  // is measured against a snapshot from before opening.
  const before = inventoryCounts(bot);
  const outputs = new Set();
  let taken = 0;
  try {
    const takeAll = async () => {
      const out = furnace.outputItem();
      if (out) {
        outputs.add(out.name);
        await furnace.takeOutput();
      }
    };
    await takeAll();
    const inputInfo = bot.registry.itemsByName[input];
    const inside = furnace.inputItem()?.count || 0;
    const carried = actions.countItems(bot, (n) => n === input);
    const toAdd = Math.max(0, Math.min(carried, count - inside));
    if (toAdd > 0) await furnace.putInput(inputInfo.id, null, toAdd);
    const queued = (furnace.inputItem()?.count || 0);
    if (queued > 0 && !furnace.fuelItem() && furnace.fuel <= 0) {
      const fuel = pickFuel(bot, queued);
      if (!fuel) return fail('no_fuel');
      await furnace.putFuel(bot.registry.itemsByName[fuel.name].id, null, fuel.count);
    }
    memory.input = furnace.inputItem()?.count || 0;
    // About 10 s per item; wait for the batch, collecting as it completes.
    const deadline = Date.now() + queued * 10500 + 4000;
    while (Date.now() < deadline && (furnace.inputItem() || furnace.outputItem())) {
      await sleep(1000, ctx.signal);
      if ((furnace.outputItem()?.count || 0) >= Math.min(queued, 64) || !furnace.inputItem()) await takeAll();
      memory.input = furnace.inputItem()?.count || 0;
      memory.output = furnace.outputItem()?.count || 0;
      if (!furnace.inputItem() && !furnace.outputItem()) break;
    }
    await takeAll();
    memory.input = furnace.inputItem()?.count || 0;
    memory.output = furnace.outputItem()?.count || 0;
  } catch (error) {
    if (isAbort(error)) throw error;
    return fail('smelt_failed');
  } finally {
    try { furnace.close(); } catch (_) { /* ignore */ }
  }
  const gained = () => [...outputs].reduce((sum, name) => sum + Math.max(0,
    actions.countItems(bot, (n) => n === name) - (before[name] || 0)), 0);
  await waitUntil(() => gained() > 0, { timeoutMs: 2000, signal: ctx.signal });
  taken = gained();
  return taken > 0 ? { ok: true, taken } : fail('smelt_no_output');
}

/** Kills the nearest matching animal and collects its drops. */
async function huntOne(bot, ctx, { mobs, dropMatch, radius = 48, blacklist }) {
  const here = bot.entity.position;
  const target = Object.values(bot.entities)
    .filter((e) => mobs.includes(e.name) && e.position && e.position.distanceTo(here) <= radius
      && !blacklist?.has(`mob:${e.id}`))
    .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0];
  if (!target) return fail('no_mob_in_range');
  ctx.record('hunt_target', { mob: target.name, distance: Math.round(target.position.distanceTo(here)) });
  let last = target.position.clone();
  const tracker = setInterval(() => { if (bot.entities[target.id]) last = bot.entities[target.id].position.clone(); }, 100);
  let result;
  try {
    result = await actions.attack(bot, ctx, target.id, { timeoutMs: 25000 });
  } finally {
    clearInterval(tracker);
  }
  if (!result.ok) {
    blacklist?.add(`mob:${target.id}`, result.reason, 60000);
    return result;
  }
  // Pick up everything it dropped: a sheep killed for mutton also gives the wool a bed needs.
  const before = actions.countItems(bot, dropMatch);
  const picked = await actions.collectDrops(bot, ctx, last, () => true, { radius: 8 });
  const wanted = actions.countItems(bot, dropMatch) - before;
  return picked.ok ? { ok: true, gained: wanted } : picked;
}

/** Picks a ripe sweet berry bush (taiga food when no animals are around). */
async function pickBerries(bot, ctx, { radius = 32, blacklist } = {}) {
  const bush = bot.registry.blocksByName.sweet_berry_bush;
  if (!bush) return fail('no_berries');
  const ripe = bot.findBlocks({ matching: bush.id, maxDistance: radius, count: 16,
    useExtraInfo: (b) => Number(b.getProperties?.().age) >= 2 })
    .filter((p) => !blacklist?.has(`berry:${posKey(p)}`))
    .map((p) => bot.blockAt(p)).filter(Boolean);
  if (!ripe.length) return fail('no_berries');
  const block = ripe[0];
  const before = actions.countItems(bot, (n) => n === 'sweet_berries');
  const moved = await actions.goToDig(bot, ctx, block, { timeoutMs: 30000 });
  if (!moved.ok) { blacklist?.add(`berry:${posKey(block.position)}`, moved.reason); return moved; }
  try {
    await bot.activateBlock(bot.blockAt(block.position));
  } catch (error) {
    if (isAbort(error)) throw error;
  }
  await actions.collectDrops(bot, ctx, block.position.offset(0.5, 0.5, 0.5), (n) => n === 'sweet_berries', { radius: 4, timeoutMs: 4000 });
  const gained = actions.countItems(bot, (n) => n === 'sweet_berries') - before;
  blacklist?.add(`berry:${posKey(block.position)}`, 'picked', 120000);
  return gained > 0 ? { ok: true, gained } : fail('berries_unconfirmed');
}

/** Walks ~32 blocks in a direction not tried recently. */
async function explore(bot, ctx, memory) {
  memory.tried = memory.tried || [];
  const here = bot.entity.position;
  const directions = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4);
  const fresh = directions.filter((a) => !memory.tried.slice(-4).includes(a));
  const angle = (fresh.length ? fresh : directions)[Math.floor(Math.random() * (fresh.length || directions.length))];
  memory.tried.push(angle);
  const distance = 32;
  const x = Math.round(here.x + Math.cos(angle) * distance);
  const z = Math.round(here.z + Math.sin(angle) * distance);
  ctx.record('explore', { x, z });
  const goal = new goals.GoalNearXZ(x, z, 4);
  const result = await actions.goTo(bot, ctx, goal, { timeoutMs: 40000, arrived: () => true });
  const moved = bot.entity.position.distanceTo(here);
  return moved >= 10 ? { ok: true, moved: Math.round(moved) } : fail(result.ok ? 'explore_blocked' : result.reason);
}

/** Opens the chest and stores one item; confirmed by the container contents. */
async function useChest(bot, ctx, { position, itemMatch }) {
  const moved = await goToBlock(bot, ctx, position);
  if (!moved.ok) return moved;
  const block = bot.blockAt(v(position));
  if (block?.name !== 'chest') return fail('chest_missing');
  const item = bot.inventory.items().find((i) => itemMatch(i.name));
  if (!item) return fail('nothing_to_store');
  let chest;
  try {
    chest = await runCancellable(() => bot.openContainer(block), { signal: ctx.signal, timeoutMs: 5000, timeoutCode: 'open_timeout' });
    const before = chest.containerItems().filter((i) => i.name === item.name).reduce((s, i) => s + i.count, 0);
    await chest.deposit(item.type, null, 1);
    const stored = await waitUntil(() => chest.containerItems().filter((i) => i.name === item.name)
      .reduce((s, i) => s + i.count, 0) > before, { timeoutMs: 2000, signal: ctx.signal });
    return stored ? { ok: true, stored: item.name } : fail('chest_unconfirmed');
  } catch (error) {
    if (isAbort(error)) throw error;
    return fail('chest_failed');
  } finally {
    try { chest?.close(); } catch (_) { /* ignore */ }
  }
}

/**
 * Night bunker: dig three blocks straight down and seal the opening above the
 * head with a block. Nothing can reach the bot in a sealed 1x1 shaft. Returns
 * the bunker so digOut can undo it exactly.
 */
async function digIn(bot, ctx, { sealMatch }) {
  const top = bot.entity.position.floored();
  for (let dy = 1; dy <= 4; dy += 1) {
    const b = bot.blockAt(top.offset(0, -dy, 0));
    if (!b || b.boundingBox !== 'block' || !bot.canDigBlock(b) || /water|lava/.test(b.name)) return fail('cannot_dig_in');
  }
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (let dy = 1; dy <= 3; dy += 1) {
      const side = bot.blockAt(top.offset(dx, -dy, dz));
      if (!side || side.boundingBox !== 'block') return fail('bunker_walls_open');
    }
  }
  if (!bot.inventory.items().some((i) => sealMatch(i.name))) return fail('no_seal_block');
  for (let dy = 1; dy <= 3; dy += 1) {
    const below = bot.blockAt(top.offset(0, -dy, 0));
    const dug = await actions.digBlock(bot, ctx, below);
    if (!dug.ok) return dug;
    await waitUntil(() => bot.entity.position.y <= top.y - dy + 0.1 && bot.entity.onGround, { timeoutMs: 2000, signal: ctx.signal });
  }
  // Seal the old ground block above the head, resting on the shaft wall beside it.
  const seal = top.offset(0, -1, 0);
  const sealed = await placeAt(bot, ctx, seal, sealMatch,
    { faces: [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)] });
  if (!sealed.ok) return sealed;
  return { ok: true, bunker: { top: { x: top.x, y: top.y, z: top.z } } };
}

/** Opens the seal and climbs back up, filling the shaft behind the bot. */
async function digOut(bot, ctx, bunker) {
  const top = new Vec3(bunker.top.x, bunker.top.y, bunker.top.z);
  const seal = bot.blockAt(top.offset(0, -1, 0));
  if (seal && seal.boundingBox === 'block' && bot.entity.position.y < top.y - 1) {
    const dug = await actions.digBlock(bot, ctx, seal);
    if (!dug.ok) return dug;
  }
  const saved = bot.companionSurfaceY;
  bot.companionSurfaceY = top.y;
  try {
    const up = await actions.surface(bot, ctx);
    return up || { ok: true };
  } finally {
    bot.companionSurfaceY = saved;
  }
}

/** Uses the bed: sleeps at night, otherwise sets the respawn point by interacting. */
async function useBed(bot, ctx, { position }) {
  const moved = await goToBlock(bot, ctx, position);
  if (!moved.ok) return moved;
  const block = bot.blockAt(v(position));
  if (!block?.name.endsWith('_bed')) return fail('bed_missing');
  const messages = [];
  const onMessage = (message) => { messages.push(message?.translate || String(message)); };
  bot.on('message', onMessage);
  try {
    try {
      await runCancellable(() => bot.sleep(block), { signal: ctx.signal, timeoutMs: 5000, timeoutCode: 'sleep_timeout' });
    } catch (error) {
      if (isAbort(error)) throw error;
    }
    await waitUntil(() => bot.isSleeping || messages.some((m) => /set_spawn|no_sleep|not_safe|too_far/.test(m)),
      { timeoutMs: 2500, signal: ctx.signal });
    if (bot.isSleeping) {
      // Sleep through the night; the server wakes us at dawn.
      await waitUntil(() => !bot.isSleeping, { timeoutMs: 20000, signal: ctx.signal });
      return { ok: true, slept: true, messages };
    }
    if (messages.some((m) => /set_spawn/.test(m))) return { ok: true, spawnSet: true, messages };
    return fail(messages.find((m) => /not_safe|too_far|obstructed/.test(m)) ? 'bed_blocked' : 'bed_not_used', { messages });
  } finally {
    bot.removeListener('message', onMessage);
    if (bot.isSleeping) bot.wake().catch(() => {});
  }
}

module.exports = { gatherOne, craft, placeAt, smelt, huntOne, pickBerries, explore, useChest, useBed, digIn, digOut, inventoryCounts, entityInside };
