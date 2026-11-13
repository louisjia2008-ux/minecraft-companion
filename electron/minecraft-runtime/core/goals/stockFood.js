'use strict';
// Goal: carry at least `target` pieces of food. Expedition outfits can use
// their home's furnace, plots and bounded surface routes for this last step.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const farming = require('../farming');
const { KNOWLEDGE, countKey } = require('../knowledge');
const { createBlacklist, posKey } = require('../blacklist');
const { applyWalkOnlyMovements, dimension } = require('../nether');
const { advanceCaveRetreat, standable } = require('../caveRetreat');
const { abortError, sleep, waitUntil } = require('../confirm');

const FOOD_MOBS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];
const HOME_RADIUS = 48;
const HOME_FLOOR = 8;
const SEARCH_REST_MS = 60000;
const SURFACE_HAZARD = /^(water|lava|bubble_column|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|powder_snow)$/;
const asVec = ({ x, y, z }) => new Vec3(x, y, z);
const foodMatch = (bot, kb, name) => !defaultActions.RISKY_FOODS.has(name)
  && (bot.registry?.foodsByName ? Boolean(bot.registry.foodsByName[name]) : kb.food.match(name));
const expeditionFoodCount = (bot, inventory, kb = KNOWLEDGE) => Object.entries(inventory)
  .reduce((sum, [name, amount]) => sum + (foodMatch(bot, kb, name) ? amount : 0), 0);

function createExpeditionFood({ bot, home, farmPlots, actions, skills, kb, blacklist }) {
  const centre = asVec(home.centre);
  const door = home.door && asVec(home.door);
  const floor = centre.y - HOME_FLOOR;
  const plots = [...new Map(farmPlots.map((p) => [posKey(p), asVec(p)])).values()];
  const visited = new Set();
  const triedSearch = new Set();
  const furnace = {};
  const edible = (name) => foodMatch(bot, kb, name);
  let checkedChest = false;
  let searchAgainAt = 0;
  let returning = false;
  let fuelNeeded = false;
  let returnLeg = 0;
  const distance = (p) => Math.hypot(p.x - centre.x, p.z - centre.z);
  const read = (p) => bot.blockAt(p);
  const dry = (block) => block && !SURFACE_HAZARD.test(block.name) && block.getProperties?.()?.waterlogged !== true;
  const inHouse = (p) => Math.abs(p.x - centre.x) <= 3 && Math.abs(p.z - centre.z) <= 3 && Math.abs(p.y - centre.y) <= 1
    || door && p.x === door.x && p.y === door.y && Math.abs(p.z - door.z) <= 1;
  const supported = (p) => p.y >= floor && !read(p.offset(0, -1, 0))?.name?.endsWith('_leaves') && standable(read, p);
  const exposed = (p) => {
    if (!supported(p)) return false;
    for (let dy = 2; dy <= Math.max(10, centre.y - p.y + 8); dy += 1) {
      const b = read(p.offset(0, dy, 0));
      if (!dry(b) || (b.boundingBox === 'block' && !b.name.endsWith('_leaves') && !b.name.endsWith('_log'))) return false;
    }
    return true;
  };
  const threatsNear = (state) => (state.hostiles || []).some(({ distance }) => distance <= 16);
  const wait = async (ctx, reason) => {
    await sleep(1000, ctx.signal);
    return { ok: true, waited: true, reason };
  };

  async function dryWalk(run, accept) {
    const restore = applyWalkOnlyMovements(bot);
    const movement = bot.pathfinder?.movements;
    const neighbors = movement?.getNeighbors;
    const own = movement && Object.hasOwn(movement, 'getNeighbors');
    const checked = new Map();
    let checkedAt = Date.now();
    if (typeof neighbors === 'function') movement.getNeighbors = function (node, ...args) {
      if (Date.now() - checkedAt >= 250) { checked.clear(); checkedAt = Date.now(); }
      return neighbors.call(this, node, ...args).filter((move) => {
        const p = new Vec3(move.x, move.y, move.z);
        const key = posKey(p);
        if (!checked.has(key)) checked.set(key, accept(p) && p.y >= floor
          && [-1, 0, 1].every((dy) => dry(read(p.offset(0, dy, 0)))) && (inHouse(p) || exposed(p)));
        return checked.get(key);
      });
    };
    try { return await run(); }
    finally {
      if (neighbors && own) movement.getNeighbors = neighbors;
      else if (neighbors) delete movement.getNeighbors;
      restore();
    }
  }

  function go(ctx, target, radius, timeoutMs = 14000) {
    const goal = new goals.GoalNear(target.x, target.y, target.z, radius);
    const near = goal.isEnd.bind(goal);
    goal.isEnd = (node) => {
      const p = new Vec3(node.x, node.y, node.z);
      return near(node) && (inHouse(p) || exposed(p));
    };
    return actions.goTo(bot, ctx, goal, { timeoutMs, retryNoProgress: false });
  }

  async function returnHome(ctx, here) {
    if (distance(here) > 28) {
      const from = here.floored();
      const bearing = Math.atan2(centre.z - from.z, centre.x - from.x);
      const headings = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];
      const heading = bearing + headings[returnLeg % headings.length];
      returnLeg += 1;
      const step = from.offset(Math.round(16 * Math.cos(heading)), 0, Math.round(16 * Math.sin(heading)));
      const goal = new goals.GoalNearXZ(step.x, step.z, 3);
      const near = goal.isEnd.bind(goal);
      goal.isEnd = (node) => near(node) && exposed(new Vec3(node.x, node.y, node.z));
      const result = await actions.goTo(bot, ctx, goal, { timeoutMs: 15000, retryNoProgress: false });
      if (distance(bot.entity.position) < distance(here) - 3) {
        returnLeg = 0;
        return { ok: true };
      }
      return result.ok ? { ok: false, reason: 'expedition_food_return_leg_blocked' } : result;
    }
    returnLeg = 0;
    const approach = door?.offset(0, 0, -1);
    const closedDoor = door && read(door);
    if (/_door$/.test(closedDoor?.name || '') && closedDoor.getProperties?.().open === false) {
      if (!actions.withinReach(bot, door)) return go(ctx, approach, 1);
      try { await bot.activateBlock(closedDoor); } catch (error) { if (error?.code === 'aborted') throw error; }
      return await waitUntil(() => read(door)?.getProperties?.().open === true, { timeoutMs: 1500, signal: ctx.signal })
        ? { ok: true } : { ok: false, reason: 'expedition_food_door_closed' };
    }
    return go(ctx, centre, 1, 15000);
  }

  async function search(ctx, here) {
    if (Date.now() < searchAgainAt) return wait(ctx, 'expedition_food_local_search_cooldown');
    for (let ring = 16; ring < HOME_RADIUS; ring += 14) {
      for (let heading = 0; heading < 8; heading += 1) {
        const id = `${ring}:${heading}`;
        if (triedSearch.has(id)) continue;
        triedSearch.add(id);
        const angle = heading * Math.PI / 4;
        const p = centre.offset(Math.round(ring * Math.cos(angle)), 0, Math.round(ring * Math.sin(angle)));
        const surface = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6].map((dy) => p.offset(0, dy, 0)).find(exposed);
        if (!surface || surface.distanceTo(here) < 6) continue;
        ctx.record('expedition_food_search', { position: surface });
        return go(ctx, surface, 2);
      }
    }
    triedSearch.clear();
    searchAgainAt = Date.now() + SEARCH_REST_MS;
    return { ok: false, reason: 'expedition_food_no_local_source' };
  }

  return async (ctx) => {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    const state = ctx.perceive();
    const here = bot.entity.position;
    const feet = here.floored();
    if (dimension(bot) !== 'overworld') return { ok: false, reason: 'expedition_food_wrong_dimension' };
    if (state.inWater || state.health <= 6 || threatsNear(state)) return wait(ctx, 'expedition_food_unsafe');
    if (!inHouse(feet) && !exposed(feet) && actions.underground?.(bot)) {
      const result = await advanceCaveRetreat(bot, ctx, actions, centre, { visited,
        avoid: (p) => inHouse(p) || (state.hostiles || []).some((h) => h.position?.distanceTo(p) <= 6) });
      if (result.ok && !result.dug) {
        visited.add(posKey(feet));
        if (visited.size > 64) visited.delete(visited.values().next().value);
      }
      return result;
    }
    visited.clear();
    const crafting = home.stations?.crafting_table;
    const oven = home.stations?.furnace;
    const cook = oven && (state.inventory.chicken > 0 || furnace.input > 0 || furnace.output > 0)
      && !blacklist.has('cook');
    const bake = crafting && state.inventory.wheat >= 3 && !blacklist.has('bake');
    const checkChest = !checkedChest || fuelNeeded;
    const homeTask = cook || bake || checkChest;
    returning ||= distance(feet) > HOME_RADIUS;
    const edge = Math.max(HOME_RADIUS, returning ? distance(feet) + 4 : 0);
    return dryWalk(async () => {
      if (homeTask || returning) {
        const inside = Math.abs(here.x - centre.x - .5) < 2.6 && Math.abs(here.z - centre.z - .5) < 2.6
          && Math.abs(here.y - centre.y) < .8;
        if (!inside) return returnHome(ctx, here);
        returning = false;
        if (cook) {
          const count = Math.min(8, (state.inventory.chicken || 0) + (furnace.input || 0));
          const result = await skills.smelt(bot, ctx, { input: 'chicken', count, furnacePosition: oven, memory: furnace });
          ctx.record('expedition_food_cook', { input: 'chicken', ok: result.ok, taken: result.taken });
          if (!result.ok) blacklist.add('cook', result.reason, 15000);
          if (result.reason === 'no_fuel' && !checkedChest) fuelNeeded = true;
          return result;
        }
        if (bake) {
          const result = await skills.craft(bot, ctx, { item: 'bread', times: Math.floor(state.inventory.wheat / 3), tablePosition: crafting });
          ctx.record('expedition_food_bake', { ok: result.ok, gained: result.gained });
          if (!result.ok) blacklist.add('bake', result.reason, 15000);
          return result;
        }
        if (checkChest) {
          const result = await skills.takeItems(bot, ctx, { position: home.chest,
            itemMatch: (name) => edible(name) || name === 'chicken' || name === 'wheat' || name === 'wheat_seeds'
              || fuelNeeded && (name === 'coal' || name === 'charcoal') });
          if (result.ok || result.reason === 'chest_empty' || result.reason === 'chest_missing') {
            checkedChest = true;
            fuelNeeded = false;
          }
          return result.reason === 'chest_empty' || result.reason === 'chest_missing' ? { ok: true } : result;
        }
      }
      if (state.isDay === false) return wait(ctx, 'expedition_food_waiting_for_daylight');
      const canTarget = (p) => distance(p) <= HOME_RADIUS && p.y >= floor;
      const accept = (entity) => entity.isValid !== false && !bot.companionSpare?.(entity)
        && canTarget(entity.position) && exposed(entity.position.floored());
      const huntGuard = new AbortController();
      const onAbort = () => huntGuard.abort(ctx.signal.reason);
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      const monitor = setInterval(() => {
        if (!canTarget(bot.entity.position) || bot.entity.isInWater || threatsNear(ctx.perceive())) {
          huntGuard.abort('expedition_food_hunt_unsafe');
        }
      }, 150);
      try {
        const animal = await skills.huntOne(bot, { ...ctx, signal: huntGuard.signal }, { mobs: FOOD_MOBS,
          dropMatch: (name) => edible(name) || name === 'chicken', radius: HOME_RADIUS, blacklist, accept });
        if (animal.ok && animal.gained > 0) return animal;
        if (!animal.ok && animal.reason !== 'no_mob_in_range') return animal;
      } catch (error) {
        if (ctx.signal?.aborted) throw abortError(ctx.signal);
        if (!huntGuard.signal.aborted) throw error;
        return { ok: false, reason: 'expedition_food_hunt_unsafe' };
      } finally {
        clearInterval(monitor);
        ctx.signal?.removeEventListener('abort', onAbort);
      }
      if (crafting) {
        const stage = (want) => plots.find((p) => canTarget(p) && !blacklist.has(posKey(p)) && farming.plotState(bot, p) === want);
        const empty = state.inventory.wheat_seeds > 0 && stage('empty');
        const ripe = stage('ripe');
        const plot = empty || ripe;
        if (plot) {
          const result = await (empty ? farming.plant(bot, ctx, plot) : farming.harvest(bot, ctx, plot));
          ctx.record('expedition_food_farm', { action: empty ? 'plant' : 'harvest', plot: posKey(plot), ok: result.ok, gained: result.gained });
          if (!result.ok || !empty && result.gained < 1) blacklist.add(posKey(plot), result.reason || 'wheat_not_collected');
          return result;
        }
      }
      const berries = bot.registry?.blocksByName?.sweet_berry_bush?.id;
      const bush = Number.isInteger(berries) && bot.findBlocks?.({ matching: berries, maxDistance: 24, count: 16,
        useExtraInfo: (block) => Number(block.getProperties?.().age) >= 2 })?.find((p) => canTarget(p) && !blacklist.has(`berry:${posKey(p)}`));
      if (bush) return skills.pickBerries(bot, ctx, { position: bush, blacklist });
      return search(ctx, here);
    }, (p) => distance(p) <= edge);
  };
}

function createStockFoodGoal({ bot, target = 16, skills = defaultSkills, actions = defaultActions, kb = KNOWLEDGE,
  radius = 96, expeditionHome, farmPlots = [] } = {}) {
  if (!Number.isSafeInteger(target) || target < 1) throw new TypeError('target must be a positive integer');
  const blacklist = createBlacklist({ ttlMs: 60000 });
  const exploreMemory = {};
  const count = (state) => expeditionHome ? expeditionFoodCount(bot, state.inventory, kb) : countKey('food', state.inventory, kb);
  const expedition = expeditionHome && createExpeditionFood({ bot, home: expeditionHome, farmPlots, actions, skills, kb, blacklist });

  return {
    name: 'stock_food',
    target,
    isDone: (state) => count(state) >= target,
    progress: (state) => count(state),
    async run(ctx) {
      if (expedition) return expedition(ctx);
      const hunted = await skills.huntOne(bot, ctx, { mobs: FOOD_MOBS, dropMatch: kb.food.match, blacklist, radius });
      if (hunted.ok || hunted.reason !== 'no_mob_in_range') return hunted;
      ctx.record('explore_for', { why: 'food' });
      return skills.explore(bot, ctx, exploreMemory);
    },
  };
}

module.exports = { createStockFoodGoal, expeditionFoodCount, FOOD_MOBS };
