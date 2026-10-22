'use strict';
// Executors for planner steps. Same contract as actions.js: short, cancellable,
// confirmed by observed state, and returning { ok, reason } without retrying.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const actions = require('./actions');
const { waitUntil, runCancellable, sleep, abortError } = require('./confirm');
const { posKey } = require('./blacklist');
const { FUELS, COLORS } = require('./knowledge');
const { ownedItems } = require('./perception');
const { withCursorConfirmation } = require('./inventory');

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
    // Digging next to water or lava floods the pit the bot is standing in.
    .filter((b) => b && !touchesLiquid(bot, b.position))
    // Exposed blocks first: keeps mining inside one open pit instead of
    // digging a fresh hole through the soil for every single stone.
    // Logs left hanging in a tall canopy need climbing: try anything else first.
    .map((b) => ({ b, score: cost(here, b.position) + buried(bot, b.position) + (aboveGround(bot, b.position) > 4 ? 40 : 0) }))
    .sort((a, b) => a.score - b.score)
    .map(({ b }) => b);
  if (candidates.length === 0) return fail('no_target_in_range');
  const block = candidates[0];
  const key = posKey(block.position);
  ctx.record('target_selected', { block: block.name, position: key, options: candidates.length });
  if (block.harvestTools && !bot.inventory.items().some((item) => block.harvestTools[item.type])) {
    blacklist.add(key, 'no_tool', 30000);
    return fail('no_tool');
  }
  // Far targets: walk most of the way in legs first, then the precise approach.
  if (block.position.distanceTo(here) > 32) {
    const near = await actions.goNear(bot, ctx, block.position.offset(0.5, 0, 0.5), 6, { timeoutMs: 90000 });
    if (!near.ok && block.position.distanceTo(bot.entity.position) > 24) {
      blacklist.add(key, near.reason);
      return near;
    }
  }
  const reach = await actions.goToDig(bot, ctx, block, { timeoutMs: 45000 });
  if (!reach.ok) {
    // The rest of the same tree or vein is almost always just as unreachable.
    for (const other of candidates) {
      if (other.name === block.name && other.position.distanceTo(block.position) <= 4) blacklist.add(posKey(other.position), reach.reason);
    }
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

/** Height of a block over the first solid ground below it (logs and leaves are not ground). */
function aboveGround(bot, p) {
  for (let dy = 1; dy <= 12; dy += 1) {
    const b = bot.blockAt(p.offset(0, -dy, 0));
    if (!b) return 0;
    if (b.boundingBox === 'block' && !b.name.endsWith('_log') && !b.name.endsWith('_leaves')) return dy - 1;
  }
  return 12;
}

function touchesLiquid(bot, p) {
  return SIDES.some(([dx, dy, dz]) => /^(water|lava)$/.test(bot.blockAt(p.offset(dx, dy, dz))?.name || ''));
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

/**
 * Items left in the 2x2 crafting grid or on the cursor are invisible to
 * inventory.items() and get mixed into the next recipe (two leftover planks
 * plus new ones made a pressure plate). Closing the inventory makes the
 * server hand them back.
 */
async function clearCraftingLeftovers(bot, ctx) {
  const grid = bot.inventory.slots.slice(0, 5).some(Boolean);
  const cursor = bot.inventory.selectedItem;
  if (!grid && !cursor && !bot.currentWindow) return true;
  return withCursorConfirmation(bot, async () => {
    try { bot.closeWindow(bot.currentWindow || bot.inventory); } catch (_) { /* ignore */ }
    return waitUntil(() => !bot.inventory.slots.slice(0, 5).some(Boolean) && !bot.inventory.selectedItem,
      { timeoutMs: 1500, signal: ctx.signal });
  });
}

async function craftInWindow(bot, ctx, recipe, table) {
  const click = bot.clickWindow;
  const close = bot.closeWindow;
  let window = table ? null : bot.inventory;
  let cancelled = false;
  // The native recipe executor chooses bot.currentWindow again on every
  // click. Keep its window alive until it settles; closing it on preemption
  // sent later clicks into the player's 2x2 grid/armor slots instead.
  bot.clickWindow = function (...args) {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    if (cancelled) throw Object.assign(new Error('craft_timeout'), { code: 'craft_timeout' });
    const current = bot.currentWindow || bot.inventory;
    if (!window) window = current;
    if (current !== window || (table && !current.type.startsWith('minecraft:crafting'))) {
      throw Object.assign(new Error('craft_window_changed'), { code: 'craft_window_changed' });
    }
    return click.apply(bot, args);
  };
  bot.closeWindow = function (target) {
    // A second close copies the old window's stale main inventory over newer
    // server updates. The native executor still closes after a server close.
    if (target && (target === bot.inventory || target === bot.currentWindow)) return close.call(bot, target);
  };
  try {
    await runCancellable(() => bot.craft(recipe, 1, table), { signal: ctx.signal, timeoutMs: 8000,
      timeoutCode: 'craft_timeout', cancel: () => { cancelled = true; } });
  } finally {
    if (window && window !== bot.inventory && bot.currentWindow === window) bot.closeWindow(window);
    bot.clickWindow = click;
    bot.closeWindow = close;
  }
}

async function craft(bot, ctx, { item, times = 1, tablePosition = null }) {
  const info = bot.registry.itemsByName[item];
  if (!info) return fail('unknown_item');
  if (!await clearCraftingLeftovers(bot, ctx)) return fail('crafting_grid_unconfirmed');
  let table = null;
  if (tablePosition) {
    const moved = await goToBlock(bot, ctx, tablePosition);
    if (!moved.ok) return moved;
    table = bot.blockAt(v(tablePosition));
    if (table?.name !== 'crafting_table') return fail('table_missing');
  }
  const before = actions.countItems(bot, (n) => n === item);
  let crafted = 0;
  let cleared;
  try {
    for (let i = 0; i < times; i += 1) {
      const recipe = bot.recipesFor(info.id, null, 1, table)[0];
      if (!recipe) break;
      const count = actions.countItems(bot, (n) => n === item);
      try {
        await craftInWindow(bot, ctx, recipe, table);
      } catch (error) {
        if (isAbort(error)) throw error;
      }
      if (await waitUntil(() => actions.countItems(bot, (n) => n === item) > count, { timeoutMs: 1500, signal: ctx.signal })) {
        crafted += 1;
      } else break;
      // Let the window's slot updates settle before the next set of clicks;
      // back-to-back crafts under server load put ingredients in the wrong slots.
      await sleep(250, ctx.signal);
    }
  } finally {
    // Return cursor/grid contents even when preempted, before the next behavior
    // can read inventory. This bounded cleanup must survive the aborted signal.
    cleared = await clearCraftingLeftovers(bot, { signal: undefined });
  }
  if (!cleared) return fail('crafting_grid_unconfirmed');
  if (crafted === 0) {
    if (bot.recipesFor(info.id, null, 1, table).length) return fail('craft_unconfirmed');
    // Say exactly what is short (the bot's count can drift from the server's).
    const have = {};
    for (const stack of bot.inventory.items()) have[stack.name] = (have[stack.name] || 0) + stack.count;
    const recipe = bot.recipesAll(info.id, null, table)
      .map((r) => r.delta.filter((d) => d.count < 0).map((d) => ({ name: bot.registry.items[d.id]?.name, need: -d.count })))
      .sort((a, b) => shortBy(a, have) - shortBy(b, have))[0] || [];
    const missing = recipe.filter((d) => (have[d.name] || 0) < d.need)
      .map((d) => ({ name: d.name, short: d.need - (have[d.name] || 0) }));
    ctx.record?.('craft_missing', { item, missing, inventory: have });
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
const INTERACTIVE = /(_door|_trapdoor|_fence_gate|_bed|_button|chest|barrel|crafting_table|furnace|smoker|anvil|lever|hopper|dispenser|dropper|lectern|loom|_table|enchanting|shulker_box|stonecutter|grindstone|cartography|brewing|beacon|bell|_sign|note_block|jukebox|composter|cauldron)$/;

async function placeAt(bot, ctx, position, itemMatch, { faces, stand, verify, alsoClear = [] } = {}) {
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
  // Standing in the very cell to fill (a foundation hole): climb out first.
  if (bot.entity.position.floored().equals(target) || bot.entity.position.floored().offset(0, 1, 0).equals(target)) {
    const away = new goals.GoalInvert(new goals.GoalNear(target.x, target.y, target.z, 1));
    await actions.goTo(bot, ctx, away, { timeoutMs: 10000, arrived: () => !overlaps(bot.entity, target) });
  }

  let ref;
  let face;
  if (stand) {
    const moved = await actions.goNear(bot, ctx, v(stand).offset(0.5, 0, 0.5), 0, { timeoutMs: 30000 });
    if (!moved.ok && bot.entity.position.floored().distanceTo(v(stand)) > 0.5) return moved;
    ref = bot.blockAt(target.offset(0, -1, 0));
    face = new Vec3(0, 1, 0);
  } else {
    // Clicking a door, chest or bed uses it instead of placing against it.
    const allFaces = faces || [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)];
    const usableFaces = allFaces.filter((f) => !INTERACTIVE.test(bot.blockAt(target.plus(f))?.name || ''));
    const goal = new goals.GoalPlaceBlock(target, bot.world, { range: 4.5, LOS: true, faces: usableFaces });
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
  // Multi-block items (a bed's head) need their other cells free of creatures too.
  if (entityInside(bot, target) || alsoClear.some((p) => entityInside(bot, v(p)))) return fail('cell_occupied_by_entity');
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
    // A different item left in the input slot (meat from an earlier cooking
    // run) blocks putInput; take it back first.
    const leftover = furnace.inputItem();
    if (leftover && leftover.name !== input) {
      await furnace.takeInput();
      await sleep(250, ctx.signal);
    }
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
/** A sheep's fleece from its metadata: color name and whether it has been sheared. */
function sheepWool(bot, entity) {
  const index = bot.registry.entitiesByName?.sheep?.metadataKeys?.indexOf('wool') ?? -1;
  if (index < 0) return null;
  // The server leaves out default values: no entry means a white, unsheared sheep.
  const value = typeof entity.metadata?.[index] === 'number' ? entity.metadata[index] : 0;
  return { color: COLORS[value & 15], sheared: Boolean(value & 16) };
}

async function huntOne(bot, ctx, { mobs, dropMatch, radius = 48, blacklist, accept = () => true, penalty = () => 0 }) {
  const here = bot.entity.position;
  const score = (e) => e.position.distanceTo(here) + penalty(e);
  const target = Object.values(bot.entities)
    .filter((e) => mobs.includes(e.name) && e.position && e.position.distanceTo(here) <= radius
      && !blacklist?.has(`mob:${e.id}`) && accept(e))
    .sort((a, b) => score(a) - score(b))[0];
  if (!target) return fail('no_mob_in_range');
  ctx.record('hunt_target', { mob: target.name, distance: Math.round(target.position.distanceTo(here)) });
  // Far animals: walk over first; the fight itself has a short timeout.
  if (target.position.distanceTo(here) > 12) {
    const near = await actions.goNear(bot, ctx, target.position.clone(), 4, { timeoutMs: 60000 });
    if (!bot.entities[target.id]) return near.ok ? fail('mob_gone') : near;
    // Could not get close: report the path failure instead of flailing in the fight loop.
    if (!near.ok && bot.entities[target.id].position.distanceTo(bot.entity.position) > 8) {
      blacklist?.add(`mob:${target.id}`, near.reason, 60000);
      return near;
    }
  }
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
  // Keep one heading while it works: random legs wander in circles around the
  // same treeless hilltop. Turn only after a blocked leg.
  if (memory.heading === undefined || memory.blocked) {
    const fresh = directions.filter((a) => !memory.tried.slice(-4).includes(a));
    memory.heading = (fresh.length ? fresh : directions)[Math.floor(Math.random() * (fresh.length || directions.length))];
    memory.blocked = false;
  }
  const angle = memory.heading;
  memory.tried.push(angle);
  const distance = 32;
  const x = Math.round(here.x + Math.cos(angle) * distance);
  const z = Math.round(here.z + Math.sin(angle) * distance);
  ctx.record('explore', { x, z });
  const goal = new goals.GoalNearXZ(x, z, 4);
  const result = await actions.goTo(bot, ctx, goal, { timeoutMs: 40000, arrived: () => true });
  const moved = bot.entity.position.distanceTo(here);
  if (moved < 10) memory.blocked = true;
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
const SOLID = (b) => b && b.boundingBox === 'block' && !/water|lava|gravel|sand/.test(b.name);
const SIDES4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** A spot where a sealed shaft can be dug: solid soil or rock all around, nothing that falls or flows. */
function bunkerSpot(bot, top) {
  if (bot.blockAt(top)?.boundingBox !== 'empty' || bot.blockAt(top.offset(0, 1, 0))?.boundingBox !== 'empty') return false;
  for (let dy = 1; dy <= 3; dy += 1) {
    const b = bot.blockAt(top.offset(0, -dy, 0));
    if (!SOLID(b) || !b.diggable) return false;
    for (const [dx, dz] of SIDES4) if (!SOLID(bot.blockAt(top.offset(dx, -dy, dz)))) return false;
  }
  return SOLID(bot.blockAt(top.offset(0, -4, 0)));
}

async function digIn(bot, ctx, { sealMatch, avoid = () => false }) {
  const hasSeal = () => bot.inventory.items().some((i) => sealMatch(i.name));
  // With nothing to seal with (just respawned), the shaft itself supplies it:
  // its dirt drops by hand, its stone with a pickaxe.
  const yieldsSeal = (b) => b && (/^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mycelium)$/.test(b.name)
    || (/^(stone|cobblestone|deepslate|cobbled_deepslate)$/.test(b.name) && bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'))));
  let top = bot.entity.position.floored();
  const shaftYieldsSeal = (p) => [1, 2, 3].some((dy) => yieldsSeal(bot.blockAt(p.offset(0, -dy, 0))));
  if (!bunkerSpot(bot, top) || avoid(top) || (!hasSeal() && !shaftYieldsSeal(top))) {
    // Look for a suitable spot close by and walk there first.
    let best = null;
    for (let dx = -8; dx <= 8; dx += 1) {
      for (let dz = -8; dz <= 8; dz += 1) {
        for (let dy = -2; dy <= 2; dy += 1) {
          const p = top.offset(dx, dy, dz);
          if (avoid(p) || !bunkerSpot(bot, p) || (!hasSeal() && !shaftYieldsSeal(p))) continue;
          const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy) * 2;
          if (!best || d < best.d) best = { p, d };
        }
      }
    }
    if (!best) return fail(hasSeal() ? 'no_bunker_spot' : 'no_seal_block');
    const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(best.p.x, best.p.y, best.p.z), { timeoutMs: 20000 });
    if (!moved.ok) return moved;
    top = bot.entity.position.floored();
    if (!bunkerSpot(bot, top)) return fail('bunker_spot_changed');
    await actions.recentre(bot, ctx);
  }
  for (let dy = 1; dy <= 3; dy += 1) {
    const below = bot.blockAt(top.offset(0, -dy, 0));
    const dug = await actions.digBlock(bot, ctx, below);
    if (!dug.ok) return dug;
    await waitUntil(() => bot.entity.position.y <= top.y - dy + 0.1 && bot.entity.onGround, { timeoutMs: 2000, signal: ctx.signal });
  }
  if (!hasSeal()) await waitUntil(hasSeal, { timeoutMs: 2000, signal: ctx.signal });
  if (!hasSeal()) return fail('no_seal_block');
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
  // Outside the overworld a bed explodes when used.
  if (String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '') !== 'overworld') return fail('bed_explodes_here');
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

module.exports = { gatherOne, craft, placeAt, smelt, huntOne, sheepWool, pickBerries, explore, useChest, useBed, digIn, digOut, inventoryCounts, entityInside };
