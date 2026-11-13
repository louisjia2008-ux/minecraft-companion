'use strict';
// Goal: carry at least `target` pieces of food. Expedition outfits can use
// their home's furnace, plots and bounded surface routes for this last step.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const farming = require('../farming');
const { isObservedSelfAggressor } = require('../../vendor/server/minecraft/entitySemantics');
const { KNOWLEDGE, countKey } = require('../knowledge');
const { createBlacklist, posKey } = require('../blacklist');
const { applyWalkOnlyMovements, dimension } = require('../nether');
const { advanceCaveRetreat, farmlandFooting, standable } = require('../caveRetreat');
const { abortError, sleep, waitUntil } = require('../confirm');

const FOOD_MOBS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];
const HOME_RADIUS = 48;
const HOME_FLOOR = 8;
const SEARCH_REST_MS = 60000;
const SCOUT_RINGS = [HOME_RADIUS, 96, 144, 192];
const SCOUT_LIMIT_MS = 180000;
const SCOUT_STEPS = 12;
const DIRECT_HOME_RADIUS = 28;
const RETREAT_CLEARANCE = 8;
const RETREAT_SPIDERS = new Set(['spider', 'cave_spider']);
const DUSK = 12542;
const FIELD_MARGIN = 5;
const MAX_RESERVE_PLOTS = 24;
const CARDINAL = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const WATER_BLOCK = /^(water|flowing_water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;
const SURFACE_HAZARD = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|powder_snow)$/;
const asVec = ({ x, y, z }) => new Vec3(x, y, z);
const foodMatch = (bot, kb, name) => !defaultActions.RISKY_FOODS.has(name)
  && (bot.registry?.foodsByName ? Boolean(bot.registry.foodsByName[name]) : kb.food.match(name));
const expeditionFoodCount = (bot, inventory, kb = KNOWLEDGE) => Object.entries(inventory)
  .reduce((sum, [name, amount]) => sum + (foodMatch(bot, kb, name) ? amount : 0), 0);

function createExpeditionFood({ bot, home, farmPlots, target, actions, skills, kb, blacklist }) {
  const centre = asVec(home.centre);
  const door = home.door && asVec(home.door);
  const floor = centre.y - HOME_FLOOR;
  const field = [...new Map(farmPlots.map((p) => [posKey(p), asVec(p)])).values()];
  const plots = field.slice();
  const banks = new Set();
  const visited = new Set();
  const triedSearch = new Set();
  const furnace = {};
  const edible = (name) => foodMatch(bot, kb, name);
  let checkedChest = false;
  let searchAgainAt = 0;
  let returning = false;
  let fuelNeeded = false;
  let returnLeg = 0;
  let scout = null;
  let scoutAgainAt = 0;
  let scoutHeading = 0;
  const distance = (p) => Math.hypot(p.x - centre.x, p.z - centre.z);
  const read = (p) => bot.blockAt(p);
  const watery = (block) => block && (WATER_BLOCK.test(block.name) || block.isWaterlogged
    || block.getProperties?.()?.waterlogged === true);
  const dry = (block) => block && !SURFACE_HAZARD.test(block.name) && !watery(block);
  const inHouse = (p) => Math.abs(p.x - centre.x) <= 3 && Math.abs(p.z - centre.z) <= 3 && Math.abs(p.y - centre.y) <= 1
    || door && p.x === door.x && p.y === door.y && Math.abs(p.z - door.z) <= 1;
  const supported = (p) => p.y >= floor && !read(p.offset(0, -1, 0))?.name?.endsWith('_leaves')
    && [-1, 0, 1].every((dy) => dry(read(p.offset(0, dy, 0)))) && standable(read, p);
  const skyClear = (p) => {
    for (let dy = 2; dy <= Math.max(10, centre.y - p.y + 8); dy += 1) {
      const b = read(p.offset(0, dy, 0));
      if (!dry(b) || (b.boundingBox === 'block' && !b.name.endsWith('_leaves') && !b.name.endsWith('_log'))) return false;
    }
    return true;
  };
  const exposed = (p) => supported(p) && skyClear(p);
  const bodyClear = (at, allowedWater = false) => {
    const radius = (bot.entity.width || .6) / 2 - .001;
    const height = bot.entity.height || 1.8;
    for (let x = Math.floor(at.x - radius); x <= Math.floor(at.x + radius); x += 1) {
      for (let z = Math.floor(at.z - radius); z <= Math.floor(at.z + radius); z += 1) {
        for (let y = Math.floor(at.y); y <= Math.floor(at.y + height - .001); y += 1) {
          const block = read(new Vec3(x, y, z));
          if (!dry(block) && !(allowedWater && watery(block))) return false;
        }
      }
    }
    return true;
  };
  const onDryGround = () => bot.entity.onGround === true && !bot.entity.isInWater && !bot.entity.isInLava
    && bodyClear(bot.entity.position);
  const threatsNear = (state) => (state.hostiles || []).some(({ distance }) => distance <= 16);
  const calmSpider = (h) => {
    const entity = bot.entities?.[h.id];
    if (!h.position || !RETREAT_SPIDERS.has(h.name) || !entity || entity.name !== h.name || entity.isValid === false
      || h.selfAggressor || isObservedSelfAggressor(entity)) return false;
    const keys = bot.registry?.entitiesByName?.[h.name]?.metadataKeys;
    const flagsIndex = keys?.indexOf('mob_flags') ?? -1;
    if (flagsIndex < 0 || !Array.isArray(entity.metadata)) return false;
    // Vanilla omits zero-value metadata on a newly observed spider. Require
    // initialized entity attributes before treating that omission as zero.
    const flags = entity.metadata[flagsIndex] ?? (Object.keys(entity.attributes || {}).length ? 0 : null);
    return Number.isInteger(flags) && (flags & 4) === 0;
  };
  const retreatThreats = (state) => (state.hostiles || []).filter(({ distance }) => distance <= 16);
  const canWithdraw = (state) => state.health >= 12 && retreatThreats(state).every((h) => h.distance > RETREAT_CLEARANCE && calmSpider(h));
  const awayFromThreats = (hostiles, from, to) => hostiles.every((h) => {
    if (!calmSpider(h) || to.distanceTo(h.position) <= RETREAT_CLEARANCE) return false;
    const start = from.offset(0, -from.y, 0);
    const end = to.offset(0, -to.y, 0);
    const threat = h.position.offset(0, -h.position.y, 0);
    return end.distanceTo(threat) >= start.distanceTo(threat) - .02
      && start.plus(end).scale(.5).distanceTo(threat) >= start.distanceTo(threat) - .02;
  });
  const wait = async (ctx, reason) => {
    await sleep(1000, ctx.signal);
    return { ok: true, waited: true, reason };
  };

  // A same-level bank enters the 15/16 crop surface without a trampling fall.
  const harvestBanks = (plot) => CARDINAL.map(([dx, dz]) => plot.offset(dx, 1, dz)).filter(exposed);

  function selectExpansion(state) {
    const short = target - expeditionFoodCount(bot, state.inventory, kb);
    const limit = Math.min(MAX_RESERVE_PLOTS, short * 3 - (state.inventory.wheat || 0));
    if (plots.length >= limit || !state.inventory.wheat_seeds || !countKey('hoe', state.inventory, kb)
      || !bot.registry?.blocksByName?.water || !bot.findBlocks) return null;
    const planted = new Set(plots.map(posKey));
    const excluded = (point) => {
      const p = asVec(point);
      const key = posKey(p);
      return distance(p) > HOME_RADIUS || p.y < floor || planted.has(key) || banks.has(key)
        || blacklist.has(key) || inHouse(p.offset(0, 1, 0))
        || bot.companionProtectBlock?.(read(p)) || !exposed(p.offset(0, 1, 0))
        || !field.some((original) => Math.max(Math.abs(original.x - p.x), Math.abs(original.z - p.z)) <= FIELD_MARGIN
          && Math.abs(original.y - p.y) <= 1)
        || !harvestBanks(p).some((bank) => !planted.has(posKey(bank.offset(0, -1, 0))));
    };
    const candidate = farming.choosePlots((point) => read(asVec(point)), centre, {
      count: MAX_RESERVE_PLOTS,
      exclude: excluded,
      findWater: (position, radius) => farming.findWater(bot, position, radius),
    }).find((p) => p.hydrated && farming.plotState(bot, p) === 'untilled');
    if (!candidate) return null;
    const plot = asVec(candidate);
    const bank = harvestBanks(plot).find((p) => !planted.has(posKey(p.offset(0, -1, 0))));
    return { plot, bank: bank.offset(0, -1, 0) };
  }

  async function dryWalk(run, accept, route) {
    const restore = applyWalkOnlyMovements(bot);
    const movement = bot.pathfinder?.movements;
    const sprint = movement?.sprintSetting ?? movement?.allowSprinting;
    if (movement && route.scouting) movement.allowSprinting = false;
    const neighbors = movement?.getNeighbors;
    const own = movement && Object.hasOwn(movement, 'getNeighbors');
    const checked = new Map();
    let checkedAt = Date.now();
    if (typeof neighbors === 'function') movement.getNeighbors = function (node, ...args) {
      if (Date.now() - checkedAt >= 250) { checked.clear(); checkedAt = Date.now(); }
      return neighbors.call(this, node, ...args).filter((move) => {
        const p = new Vec3(move.x, move.y, move.z);
        if (route.scouting) {
          const from = new Vec3(node.x, node.y, node.z);
          if (Math.abs(p.x - node.x) + Math.abs(p.z - node.z) !== 1) return false;
          // Check the swept edge at the lower foot height too, before either
          // a hop or a drop changes the actual player's vertical position.
          const edge = from.plus(p).scale(.5);
          edge.y = Math.min(from.y, p.y);
          if (!bodyClear(edge.offset(.5, 0, .5))) return false;
          if (route.withdraw && !awayFromThreats(route.withdraw(), from.offset(.5, 0, .5), p.offset(.5, 0, .5))) return false;
        }
        if (route.pickup?.equals(p)) {
          const from = new Vec3(node.x, node.y, node.z);
          return accept(p) && harvestBanks(p.offset(0, -1, 0)).some((bank) => bank.equals(from))
            && skyClear(p) && Boolean(farmlandFooting(read, { onGround: true, position: p.offset(.5, -1 / 16, .5) }));
        }
        const key = posKey(p);
        if (!checked.has(key)) checked.set(key, accept(p) && p.y >= floor
          && [-1, 0, 1].every((dy) => dry(read(p.offset(0, dy, 0)))) && (inHouse(p) || exposed(p)));
        return checked.get(key);
      });
    };
    try { return await run(); }
    finally {
      if (movement && route.scouting) movement.allowSprinting = sprint;
      if (neighbors && own) movement.getNeighbors = neighbors;
      else if (neighbors) delete movement.getNeighbors;
      restore();
    }
  }

  async function collectWheat(ctx, plot, route) {
    const target = plot.offset(0, 1, 0);
    const arrived = () => bot.entity.position.floored().equals(plot) && Boolean(farmlandFooting(read, bot.entity));
    if (!arrived()) {
      route.pickup = target;
      try {
        const goal = new goals.GoalBlock(target.x, target.y, target.z);
        const moved = await actions.goTo(bot, ctx, goal, { arrived, timeoutMs: 6000, retryNoProgress: false });
        if (moved.ok || moved.reason === 'not_arrived') await waitUntil(arrived, { timeoutMs: 550, signal: ctx.signal });
      } finally {
        route.pickup = null;
      }
    }
    // Vanilla adds a short item pickup delay after the wheat block disappears.
    if (arrived()) await sleep(550, ctx.signal);
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

  const daylightMs = (state) => Number.isFinite(state.timeOfDay) && state.isDay === true
    ? ((DUSK - state.timeOfDay + 24000) % 24000) * 50 : 0;
  const scoutFit = (state) => state.health >= 12 && state.food >= 14
    && expeditionFoodCount(bot, state.inventory, kb) >= 2;
  const scoutTimeLeft = (state) => {
    const elapsed = Date.now() - scout.started;
    return elapsed < SCOUT_LIMIT_MS && daylightMs(state) > Math.max(30000, elapsed + 20000);
  };
  const scoutDelay = () => ({ ok: true, waited: true });

  async function scoutWalk(ctx, to, label, validate = () => true) {
    const from = bot.entity.position.floored();
    if (!onDryGround() || !exposed(to)) return false;
    const arrived = () => onDryGround() && bot.entity.position.floored().equals(to) && exposed(to) && validate();
    const result = await actions.goTo(bot, ctx, new goals.GoalBlock(to.x, to.y, to.z),
      { arrived, timeoutMs: 6500, retryNoProgress: false });
    const landed = (result.ok || result.reason === 'not_arrived')
      && await waitUntil(arrived, { timeoutMs: 450, signal: ctx.signal });
    ctx.record(label, { from, to, arrived: landed, ring: SCOUT_RINGS[scout.ring], reason: result.reason });
    return landed;
  }

  async function scoutOut(ctx, here) {
    const from = here.floored();
    const planner = bot.pathfinder;
    const ring = SCOUT_RINGS[scout.ring];
    if (distance(from) >= ring - 6) {
      if (scout.ring === SCOUT_RINGS.length - 1) { returning = true; return scoutDelay(); }
      scout.ring += 1;
      return scoutDelay();
    }
    const closedDoor = door && read(door);
    if (inHouse(from) && /_door$/.test(closedDoor?.name || '') && closedDoor.getProperties?.().open === false) {
      if (!actions.withinReach(bot, door)) return go(ctx, door.offset(0, 0, 1), 1, 6000);
      try { await bot.activateBlock(closedDoor); } catch (error) { if (error?.code === 'aborted') throw error; }
      if (!await waitUntil(() => read(door)?.getProperties?.()?.open === true, { timeoutMs: 1000, signal: ctx.signal })
        && ++scout.misses >= 8) returning = true;
      return scoutDelay();
    }
    const angle = scout.heading * Math.PI / 4;
    const waypoint = centre.offset(Math.round(ring * Math.cos(angle)), 0, Math.round(ring * Math.sin(angle)));
    const goal = new goals.GoalNearXZ(waypoint.x, waypoint.z, 4);
    // Inspect one short native planning slice and follow only its loaded prefix.
    // A river can block the destination while still leaving a useful dry leg.
    const native = planner.getPathFromTo(planner.movements, here, goal,
      { timeout: 80, tickTimeout: 35, optimizePath: false, searchRadius: 48 }).next().value?.result;
    const to = native?.path?.slice(0, SCOUT_STEPS).reverse().find((p) => p.distanceTo(from) >= 3 && exposed(p)
      && !scout.trail.some((prior) => prior.distanceTo(p) < 2));
    const landed = to && await scoutWalk(ctx, to, 'expedition_food_scout');
    const at = bot.entity.position.floored();
    if (onDryGround() && exposed(at) && !scout.trail.some((prior) => prior.distanceTo(at) < 2)) scout.trail.push(at);
    if (landed) {
      scout.misses = 0;
    } else {
      scout.heading -= 1;
      if (++scout.misses >= 8) returning = true;
    }
    return scoutDelay();
  }

  async function scoutHome(ctx, here) {
    let from = here.floored();
    if (distance(here) <= DIRECT_HOME_RADIUS && !scout.failedHome?.has(posKey(from))) {
      const moved = await returnHome(ctx, here, { timeoutMs: 6500 });
      const at = bot.entity.position;
      const progress = moved.ok || onDryGround() && distance(at) + 1 < distance(here);
      ctx.record('expedition_food_scout_home', { from, to: at.floored(), ok: progress, reason: moved.reason });
      if (progress) return scoutDelay();
      (scout.failedHome ||= new Set()).add(posKey(from));
      here = at;
      from = at.floored();
    }
    while (scout.trail.at(-1)?.distanceTo(from) < 2) scout.trail.pop();
    const last = scout.trail.at(-1);
    if (!last) return returnHome(ctx, here);
    if (await scoutWalk(ctx, last, 'expedition_food_scout_return')) scout.trail.pop();
    else {
      const moved = await returnHome(ctx, here);
      if (moved.ok && distance(bot.entity.position) < distance(here) - 3) scout.trail.length = 0;
    }
    return scoutDelay();
  }

  async function withdrawFromMelee(ctx, from, route) {
    // Only use a previously reached landing while a threat is nearby.
    const to = scout.trail.findLast((p) => p.distanceTo(from) >= 2);
    if (!to || from.distanceTo(to) > SCOUT_STEPS + 2) return wait(ctx, 'expedition_food_unsafe');
    const centre = to.offset(.5, 0, .5);
    let snapshot = null, sampledAt = 0;
    const observe = (refresh = false) => {
      if (refresh || Date.now() >= sampledAt) {
        sampledAt = Date.now() + 75;
        snapshot = ctx.perceive();
      }
      return snapshot;
    };
    route.withdraw = () => retreatThreats(observe());
    const began = bot.entity.position.clone();
    if (!awayFromThreats(route.withdraw(), began, centre)) return wait(ctx, 'expedition_food_unsafe');
    const abort = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, abort.signal]) : abort.signal;
    let previous = began;
    const monitor = setInterval(() => {
      const live = observe(true);
      const at = bot.entity.position;
      if (live.inWater || bot.entity.isInLava || !bodyClear(at) || !canWithdraw(live)
        || !awayFromThreats(retreatThreats(live), previous, at)) abort.abort('expedition_food_unsafe');
      previous = at.clone();
    }, 100);
    try {
      if (await scoutWalk({ ...ctx, signal }, to, 'expedition_food_scout_withdraw', () => canWithdraw(observe(true)))) {
        scout.trail.length = scout.trail.indexOf(to);
      } else {
        return wait(ctx, 'expedition_food_unsafe');
      }
      return scoutDelay();
    } catch (error) {
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      if (!abort.signal.aborted) throw error;
      return wait(ctx, 'expedition_food_unsafe');
    } finally {
      clearInterval(monitor);
    }
  }

  async function scoutAshore(ctx, here) {
    returning = true;
    const start = here.clone();
    const from = here.floored();
    const candidates = [[0, 0], ...CARDINAL].flatMap(([x, z]) => [-1, 0, 1].map((y) => from.offset(x, y, z)));
    const shore = candidates.filter(exposed).sort((a, b) => a.offset(.5, 0, .5).distanceTo(here)
      - b.offset(.5, 0, .5).distanceTo(here)).find((p) => bodyClear(here.plus(p.offset(.5, 0, .5)).scale(.5), true));
    if (!shore || !bot.lookAt || !bot.setControlState) {
      await actions.swimAshore?.(bot, ctx, { maxTicks: 40 });
      return wait(ctx, 'expedition_food_scout_ashore');
    }
    const arrived = () => onDryGround() && bot.entity.position.floored().equals(shore) && exposed(shore);
    try {
      for (let tick = 0; tick < 24 && !arrived(); tick += 1) {
        if (ctx.signal?.aborted) throw abortError(ctx.signal);
        const at = bot.entity.position;
        const centre = shore.offset(.5, 0, .5);
        if (bot.entity.isInLava || !bodyClear(at, true) || !exposed(shore) || at.distanceTo(start) > 2
          || !bodyClear(at.plus(centre).scale(.5), true) || (tick % 4 === 0 && threatsNear(ctx.perceive()))) break;
        await bot.lookAt(centre.offset(0, 1.65, 0), true);
        bot.setControlState('forward', true);
        bot.setControlState('jump', shore.y > at.y + .1);
        await sleep(50, ctx.signal);
      }
    } finally {
      bot.setControlState('forward', false);
      bot.setControlState('jump', false);
    }
    ctx.record('expedition_food_scout_ashore', { from, to: shore, arrived: arrived() });
    return scoutDelay();
  }

  async function returnHome(ctx, here, { timeoutMs = 15000 } = {}) {
    if (distance(here) > DIRECT_HOME_RADIUS) {
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
      if (!actions.withinReach(bot, door)) return go(ctx, approach, 1, timeoutMs);
      try { await bot.activateBlock(closedDoor); } catch (error) { if (error?.code === 'aborted') throw error; }
      return await waitUntil(() => read(door)?.getProperties?.().open === true, { timeoutMs: 1500, signal: ctx.signal })
        ? { ok: true } : { ok: false, reason: 'expedition_food_door_closed' };
    }
    return go(ctx, centre, 1, timeoutMs);
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
    const hostile = threatsNear(state);
    if (state.health <= 6 || bot.entity.isInLava
      || hostile && (!scout || !onDryGround() || !exposed(feet) || !canWithdraw(state))) return wait(ctx, 'expedition_food_unsafe');
    if (state.inWater || bot.entity.isInWater) {
      return scout || distance(feet) <= SCOUT_RINGS.at(-1) ? scoutAshore(ctx, here) : wait(ctx, 'expedition_food_unsafe');
    }
    if (!scout && !inHouse(feet) && !exposed(feet) && !farmlandFooting(read, bot.entity) && actions.underground?.(bot)) {
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
    const scouting = typeof bot.pathfinder?.getPathFromTo === 'function';
    returning ||= scout ? hostile || homeTask || !scoutFit(state) || !scoutTimeLeft(state) : distance(feet) > HOME_RADIUS;
    const huntEdge = scout ? SCOUT_RINGS[scout.ring] : HOME_RADIUS;
    const edge = Math.max(huntEdge, returning ? distance(feet) + 4 : 0);
    const route = { pickup: null, scouting: Boolean(scout) };
    return dryWalk(async () => {
      if (hostile) return withdrawFromMelee(ctx, feet, route);
      if (homeTask || returning) {
        const inside = Math.abs(here.x - centre.x - .5) < 2.6 && Math.abs(here.z - centre.z - .5) < 2.6
          && Math.abs(here.y - centre.y) < .8;
        if (!inside) return scout ? scoutHome(ctx, here) : returnHome(ctx, here);
        if (scout) {
          scout = null;
          scoutAgainAt = Date.now() + SEARCH_REST_MS;
        }
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
      const canTarget = (p) => distance(p) <= huntEdge && p.y >= floor;
      const accept = (entity) => entity.isValid !== false && !bot.companionSpare?.(entity)
        && canTarget(entity.position) && exposed(entity.position.floored());
      const huntGuard = new AbortController();
      const onAbort = () => huntGuard.abort(ctx.signal.reason);
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      const monitor = setInterval(() => {
        const live = ctx.perceive();
        if (!canTarget(bot.entity.position) || bot.entity.isInWater || threatsNear(live)
          || scout && (!scoutFit(live) || !scoutTimeLeft(live))) {
          huntGuard.abort('expedition_food_hunt_unsafe');
        }
      }, 150);
      try {
        const animal = await skills.huntOne(bot, { ...ctx, signal: huntGuard.signal }, { mobs: FOOD_MOBS,
          dropMatch: (name) => edible(name) || name === 'chicken', radius: scout ? 12 : HOME_RADIUS, blacklist, accept });
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
      if (scout) {
        const now = ctx.perceive();
        if (threatsNear(now) || !scoutFit(now) || !scoutTimeLeft(now)) {
          returning = true;
          return scoutDelay();
        }
        return scoutOut(ctx, bot.entity.position);
      }
      const growing = crafting && plots.some((p) => canTarget(p) && farming.plotState(bot, p) === 'growing');
      if (crafting) {
        const stage = (want) => plots.find((p) => canTarget(p) && !blacklist.has(posKey(p)) && farming.plotState(bot, p) === want);
        const empty = state.inventory.wheat_seeds > 0 && stage('empty');
        const ripe = plots.find((p) => canTarget(p) && !blacklist.has(posKey(p))
          && farming.plotState(bot, p) === 'ripe' && harvestBanks(p).length);
        const plot = empty || ripe;
        if (plot) {
          const result = await (empty ? farming.plant(bot, ctx, plot) : farming.harvest(bot, ctx, plot,
            { collect: () => collectWheat(ctx, plot, route) }));
          ctx.record('expedition_food_farm', { action: empty ? 'plant' : 'harvest', plot: posKey(plot), ok: result.ok, gained: result.gained });
          if (!result.ok || !empty && result.gained < 1) blacklist.add(posKey(plot), result.reason || 'wheat_not_collected');
          return result;
        }
        const extension = growing && selectExpansion(state);
        if (extension) {
          const result = await farming.till(bot, ctx, extension.plot);
          ctx.record('expedition_food_farm', { action: 'till', plot: posKey(extension.plot), ok: result.ok });
          if (result.ok) {
            plots.push(extension.plot);
            banks.add(posKey(extension.bank));
          } else {
            blacklist.add(posKey(extension.plot), result.reason);
          }
          return result;
        }
      }
      const berries = bot.registry?.blocksByName?.sweet_berry_bush?.id;
      const bush = Number.isInteger(berries) && bot.findBlocks?.({ matching: berries, maxDistance: 24, count: 16,
        useExtraInfo: (block) => Number(block.getProperties?.().age) >= 2 })?.find((p) => canTarget(p) && !blacklist.has(`berry:${posKey(p)}`));
      if (bush) return skills.pickBerries(bot, ctx, { position: bush, blacklist });
      if (growing && plots.some((p) => canTarget(p) && farming.plotState(bot, p) === 'growing' && harvestBanks(p).length)) {
        if (scouting && scoutFit(state) && daylightMs(state) >= 120000 && Date.now() >= scoutAgainAt
          && onDryGround() && (exposed(feet) || inHouse(feet))) {
          scout = { started: Date.now(), heading: scoutHeading++, ring: 0, trail: exposed(feet) ? [feet] : [], misses: 0 };
          return scoutDelay();
        }
        return wait(ctx, 'expedition_food_waiting_for_wheat');
      }
      return search(ctx, here);
    }, (p) => distance(p) <= edge, route);
  };
}

function createStockFoodGoal({ bot, target = 16, skills = defaultSkills, actions = defaultActions, kb = KNOWLEDGE,
  radius = 96, expeditionHome, farmPlots = [] } = {}) {
  if (!Number.isSafeInteger(target) || target < 1) throw new TypeError('target must be a positive integer');
  const blacklist = createBlacklist({ ttlMs: 60000 });
  const exploreMemory = {};
  const count = (state) => expeditionHome ? expeditionFoodCount(bot, state.inventory, kb) : countKey('food', state.inventory, kb);
  const expedition = expeditionHome && createExpeditionFood({ bot, home: expeditionHome, farmPlots, target, actions, skills, kb, blacklist });

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
