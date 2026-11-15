'use strict';
// Goal: carry at least `target` pieces of food. Expedition outfits can use
// their home's furnace, plots and bounded surface routes for this last step.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const farming = require('../farming');
const { isObservedSelfAggressor, isThreateningMobEntity } = require('../../vendor/server/minecraft/entitySemantics');
const { entityDimensions } = require('../entityGeometry');
const { perceive } = require('../perception');
const { KNOWLEDGE, countKey } = require('../knowledge');
const { createBlacklist, posKey } = require('../blacklist');
const { applyWalkOnlyMovements, dimension } = require('../nether');
const { advanceCaveRetreat, farmlandFooting, standable, walkDry } = require('../caveRetreat');
const { abortError, sleep, waitUntil } = require('../confirm');
const { createExpeditionReturnDetour } = require('./expeditionReturnDetour');
const { NEAR_HUNT, planScoutFoodApproach } = require('./scoutFoodApproach');
const { createStockWaterReturn } = require('./stockWaterReturn');

const FOOD_MOBS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];
const HOME_RADIUS = 48;
const HOME_FLOOR = 8;
const SEARCH_REST_MS = 60000;
const SCOUT_RINGS = [HOME_RADIUS, 96, 144, 192];
const SCOUT_LIMIT_MS = 180000;
const SCOUT_STEPS = 12;
const SCOUT_HUNT_MARGIN_MS = 30000;
const SCOUT_RETURN_MARGIN = 4;
const DIRECT_HOME_RADIUS = 28;
const RETREAT_CLEARANCE = 8;
const ZOMBIE_RETREAT_CLEARANCE = 10;
const RETREAT_SPIDERS = new Set(['spider', 'cave_spider']);
const SPIDER_COVER = /^(stone|deepslate|tuff|andesite|granite|diorite|dirt|grass_block|coarse_dirt|rooted_dirt)$/;
const DUSK = 12542;
const FIELD_MARGIN = 5;
const MAX_RESERVE_PLOTS = 24;
const MAX_FIELD_WALK = 5;
const HOME_EXIT_RADIUS = 15;
const HOME_EXIT_STEPS = 15;
const CARDINAL = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const WATER_BLOCK = /^(water|flowing_water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;
const SURFACE_HAZARD = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|powder_snow)$/;
const PORTAL = /^(nether_portal|end_portal)$/;
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
  let fieldExit = null;
  let screenedHomeTrail = null;
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
  const isThreat = (h) => {
    if (h.name !== 'enderman' || h.selfAggressor) return true;
    const entity = bot.entities?.[h.id];
    if (entity?.name !== h.name || !entity.position || !Array.isArray(entity.metadata)) return true;
    const keys = bot.registry?.entitiesByName?.enderman?.metadataKeys;
    const flags = ['creepy', 'stared_at'].map((key) => keys?.indexOf(key) ?? -1);
    if (flags.some((index) => index < 0) || isThreateningMobEntity(entity, bot.registry)) return true;
    const values = flags.map((index) => entity.metadata[index]);
    // Vanilla omits neutral defaults once the living entity has synced.
    const synced = Object.keys(entity.attributes || {}).length > 0;
    return !values.every((value) => value === false || value === 0 || value === undefined && synced);
  };
  const nearbyThreats = (state) => (state.hostiles || []).filter((h) => h.distance <= 16 && isThreat(h));
  const retreatThreats = (state) => {
    const threats = nearbyThreats(state);
    return safeFarReturn(state) && (returning || !scout || !scoutFit(state))
      && onDryGround() && exposed(bot.entity.position.floored())
      ? threats.filter((h) => !spiderBelowCover(h)) : threats;
  };
  const threatsNear = (state) => retreatThreats(state).length > 0;
  const detour = createExpeditionReturnDetour({ bot, centre, floor, exposed, actions,
    safe: (state, starting) => state.health >= 12 && state.food >= 12 && (!starting || state.isDay === true)
      && !state.inWater && !bot.entity.isInWater && !bot.entity.isInLava && !threatsNear(state)
      && Object.keys(state.inventory).some((name) => name.endsWith('_sword') || name.endsWith('_axe')) });
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
  const retreatClearance = (h) => h.name === 'zombie' && h.position && bot.entities?.[h.id]?.name === h.name
    && bot.entities[h.id].isValid !== false ? ZOMBIE_RETREAT_CLEARANCE : calmSpider(h) ? RETREAT_CLEARANCE : Infinity;
  const canWithdraw = (state) => state.health >= 12 && retreatThreats(state).every((h) =>
    h.distance > retreatClearance(h) && (h.name !== 'zombie' || state.isDay === true));
  const awayFromThreats = (hostiles, from, to) => hostiles.every((h) => {
    const clearance = retreatClearance(h);
    if (!h.position || to.distanceTo(h.position) <= clearance) return false;
    if (h.name === 'zombie' && to.distanceTo(h.position) < from.distanceTo(h.position) - .02) return false;
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
  const farmDry = (point) => {
    const block = read(point);
    return dry(block) && !PORTAL.test(block.name);
  };
  const fieldClear = (p) => [-1, 0, 1].every((dy) => farmDry(p.offset(0, dy, 0)));
  const fullCube = (block) => block?.boundingBox === 'block' && block.shapes?.length === 1
    && block.shapes[0].every((value, i) => value === (i < 3 ? 0 : 1));
  const centreFeet = (p) => p.offset(.5, 0, .5);
  const openDoorStance = (p) => {
    const [lower, upper] = [read(p), read(p.offset(0, 1, 0))];
    if (!lower || !/^(?!iron_).*_door$/.test(lower.name) || upper?.name !== lower.name) return false;
    const lo = lower.getProperties?.(), hi = upper.getProperties?.();
    return lo?.half === 'lower' && hi?.half === 'upper' && lo.open === true && hi.open === true
      && ['north', 'south'].includes(lo.facing) && lo.facing === hi.facing && lo.hinge === hi.hinge
      && standable((cell) => cell.equals(p) || cell.equals(p.offset(0, 1, 0))
        ? { name: 'air', boundingBox: 'empty', shapes: [] } : read(cell), p);
  };
  const homeExitStance = (p) => p.y >= centre.y - 1 && p.y <= centre.y + 1 && distance(p) <= HOME_EXIT_RADIUS
    && (p.equals(door) ? openDoorStance(p) : fieldClear(p) && (inHouse(p) ? supported(p) : exposed(p)));
  const homeExitReady = (state) => state.isDay === true && state.health >= 16 && state.food >= 16 && !state.inWater
    && !bot.entity.isInLava && Object.keys(state.inventory).some((name) => name.endsWith('_sword'));
  const homeExitThreats = () => perceive(bot, { hostileRange: 2 * HOME_EXIT_RADIUS + 17 }).hostiles.filter(isThreat);
  const screenedFrom = (hostile, at) => {
    if (at.distanceTo(hostile.position) > 17) return true;
    const mob = bot.entities?.[hostile.id];
    const size = entityDimensions(mob, bot.registry);
    if (hostile.name !== 'creeper' || hostile.selfAggressor || mob?.isValid === false || !size
      || at.y - hostile.position.y < Math.max(2.6, size.height + .85)
      || Math.hypot(at.x - hostile.position.x, at.z - hostile.position.z) < 8) return false;
    const eye = hostile.position.offset(0, size.height * .85, 0);
    const beside = new Vec3(eye.z - at.z, 0, at.x - eye.x).normalize().scaled(.28);
    return [.35, 1.05, 1.65].every((y) => [-1, 1].every((side) => {
      const ray = at.offset(0, y, 0).plus(beside.scaled(side)).minus(eye);
      const hit = bot.world.raycast(eye, ray.normalize(), ray.norm());
      return dry(hit) && fullCube(hit);
    }));
  };
  const checkReserveChest = async (ctx, stationary = false) => {
    const result = await skills.takeItems(bot, ctx, { position: home.chest, ...(stationary && { stationary: true }),
      itemMatch: (name) => edible(name) || name === 'chicken' || name === 'wheat' || name === 'wheat_seeds'
        || fuelNeeded && (name === 'coal' || name === 'charcoal') });
    if (result.ok || result.reason === 'chest_empty' || result.reason === 'chest_missing') {
      checkedChest = true;
      fuelNeeded = false;
    }
    return result.reason === 'chest_empty' || result.reason === 'chest_missing' ? { ok: true } : result;
  };
  const bakeReserve = async (ctx, count, position) => {
    const result = await skills.craft(bot, ctx, { item: 'bread', times: count, tablePosition: position });
    ctx.record('expedition_food_bake', { ok: result.ok, gained: result.gained });
    if (!result.ok) blacklist.add('bake', result.reason, 15000);
    return result;
  };
  async function screenedHomeStation(ctx, here, activity) {
    const feet = here.floored();
    if (!activity || !inHouse(feet) || !onDryGround() || !bot.world?.raycast) return null;
    const { position, block, run } = activity;
    const station = asVec(position);
    const stillSafe = () => {
      const seen = read(station);
      return seen?.name === block && fullCube(read(feet.offset(0, 2, 0)))
        && bot.canSeeBlock?.(seen) === true && defaultActions.withinReach(bot, station, 4)
        && bot.entity.position.distanceTo(here) < .15 && onDryGround() && homeExitReady(ctx.perceive())
        && homeExitThreats().every((h) => screenedFrom(h, here));
    };
    if (!stillSafe()) return null;
    const guard = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, guard.signal]) : guard.signal;
    const monitor = setInterval(() => { if (!stillSafe()) guard.abort('expedition_food_unsafe'); }, 100);
    try {
      const result = await run({ ...ctx, signal });
      ctx.record('expedition_food_screened_home_station', { block, position: station, ok: result.ok, reason: result.reason });
      return result;
    } catch (error) {
      if (ctx.signal?.aborted || !guard.signal.aborted) throw error;
      return wait(ctx, 'expedition_food_unsafe');
    } finally {
      clearInterval(monitor);
    }
  }

  async function screenedHomeExit(ctx, here) {
    if (!onDryGround() || !bot.world?.raycast || typeof bot.pathfinder?.movements?.getNeighbors !== 'function') return null;
    const from = here.floored();
    if (!homeExitStance(from)) return null;
    const snapshot = homeExitThreats();
    const clears = (p, hostiles) => hostiles.every((h) => screenedFrom(h, p));
    if (!snapshot.some((h) => h.name === 'creeper' && h.distance <= 16) || !clears(here, snapshot)) return null;
    const swept = (a, b) => {
      const middle = a.plus(b).scale(.5);
      middle.y = Math.min(a.y, b.y);
      return middle;
    };
    const safeLeg = (a, b, hostiles) => {
      const mid = swept(a, b);
      return bodyClear(mid) && clears(a, hostiles) && clears(mid, hostiles) && clears(b, hostiles);
    };
    const position = (p) => p.equals(from) ? here : centreFeet(p);
    const usable = (at, p) => homeExitStance(p) && safeLeg(position(at), centreFeet(p), snapshot)
      && (!at.equals(from) || !blacklist.has(`screened-home:${posKey(from)}>${posKey(p)}`));
    const route = () => {
      const seen = new Set([posKey(from)]);
      const queue = [{ at: from, path: [from] }];
      for (let i = 0; i < queue.length && i < 360; i++) {
        const { at, path } = queue[i];
        if (path.length > 1 && snapshot.every((h) => centreFeet(at).distanceTo(h.position) > 17)) return path;
        if (path.length > HOME_EXIT_STEPS) continue;
        for (const [x, z] of CARDINAL) for (const dy of [0, 1, -1]) {
          const p = at.offset(x, dy, z);
          const key = posKey(p);
          if (seen.has(key) || !usable(at, p)) continue;
          seen.add(key);
          queue.push({ at: p, path: [...path, p] });
        }
      }
      return null;
    };
    const previous = screenedHomeTrail?.findIndex((p) => p.equals(from)) ?? -1;
    if (previous < 0) screenedHomeTrail = null;
    else screenedHomeTrail = screenedHomeTrail.slice(previous);
    if (!screenedHomeTrail?.[1] || !usable(from, screenedHomeTrail[1])) {
      // Keep a proven corridor while its next edge still holds. A creeper
      // wandering beneath a later edge must be checked again on approach.
      const alternate = route();
      if (alternate) screenedHomeTrail = alternate;
    }
    const next = screenedHomeTrail?.[1];
    if (!next || !usable(from, next)) return null;
    const stillSafe = () => {
      const at = bot.entity.position;
      const cell = at.floored();
      return homeExitReady(ctx.perceive()) && homeExitStance(from) && homeExitStance(next)
        && [from, next].some((p) => p.x === cell.x && p.z === cell.z) && at.y >= Math.min(from.y, next.y) - .05
        && bodyClear(at) && safeLeg(at, centreFeet(next), homeExitThreats());
    };
    if (!stillSafe()) return null;
    const guard = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, guard.signal]) : guard.signal;
    const monitor = setInterval(() => { if (!stillSafe()) guard.abort('expedition_food_unsafe'); }, 100);
    const movement = bot.pathfinder.movements;
    const sprint = movement.sprintSetting ?? movement.allowSprinting;
    movement.allowSprinting = false;
    const arrived = () => onDryGround() && bot.entity.position.floored().equals(next) && stillSafe();
    try {
      const result = await walkDry(bot, { ...ctx, signal }, actions, new goals.GoalBlock(next.x, next.y, next.z),
        { adjacent: next, avoid: () => !stillSafe(), supports: (_read, p) => homeExitStance(p), arrived, timeoutMs: 3500 });
      if ((result.ok || result.reason === 'not_arrived') && await waitUntil(arrived, { timeoutMs: 450, signal })) {
        ctx.record('expedition_food_screened_home_step', { from, to: next, creepers: snapshot.filter((h) => h.name === 'creeper')
          .map(({ id, position }) => ({ id, position })) });
        return { ok: true };
      }
      if (bot.entity.position.floored().equals(from)) blacklist.add(`screened-home:${posKey(from)}>${posKey(next)}`, result.reason, 10000);
    } catch (error) {
      if (ctx.signal?.aborted || !guard.signal.aborted) throw error;
    } finally {
      clearInterval(monitor);
      movement.allowSprinting = sprint;
    }
    return wait(ctx, 'expedition_food_unsafe');
  }
  function spiderBelowCover(threat) {
    const here = bot.entity.position;
    const live = bot.entities?.[threat.id];
    if (!RETREAT_SPIDERS.has(threat.name) || !live?.position || live.name !== threat.name || live.isValid === false
      || threat.selfAggressor || isObservedSelfAggressor(live) || here.y - live.position.y < 5) return false;
    const from = live.position.offset(0, .45, 0);
    // Require loaded full terrain at two different heights on both sight
    // lines. An open gallery, thin barrier or missing chunk stays a threat.
    return [.5, 1.62].every((height) => {
      const ray = here.offset(0, height, 0).minus(from);
      const limit = Math.ceil(ray.norm() * 4);
      const covered = new Set();
      for (let step = 1; step < limit; step += 1) {
        const p = from.plus(ray.scaled(step / limit)).floored();
        const block = read(p);
        if (!block) return false;
        if (fullCube(block) && dry(block) && SPIDER_COVER.test(block.name)) covered.add(p.y);
      }
      return covered.size >= 2;
    });
  }
  const backedSand = (p) => {
    const soil = read(p.offset(0, -1, 0));
    const backing = read(p.offset(0, -2, 0));
    // Only the local farm route may use a full sand block resting directly
    // on full non-falling dry terrain.
    return /^(red_)?sand$/.test(soil?.name || '') && fullCube(soil)
      && fullCube(backing) && !/(sand|gravel|concrete_powder|leaves|magma_block)$/.test(backing.name)
      && farmDry(p.offset(0, -2, 0)) && fieldClear(p) && [0, 1, 2].every((dy) => {
        const b = read(p.offset(0, dy, 0));
        return b?.boundingBox === 'empty' && !b.shapes?.length;
      }) && skyClear(p);
  };
  const fieldBank = (p) => exposed(p) && fieldClear(p) || backedSand(p);
  const farmStance = (p) => fieldClear(p) && skyClear(p)
    && farmlandFooting(read, { onGround: true, position: p.offset(.5, -1 / 16, .5) });
  const fieldStance = (p) => Boolean(farmStance(p) || fieldBank(p));
  const adjacent = (p) => CARDINAL.map(([dx, dz]) => p.offset(dx, 0, dz));

  // Walk backwards from the crop to the closest verified full bank. Each
  // intermediate node is an already known crop at the same walking height.
  function fieldPath(plot) {
    const target = plot.offset(0, 1, 0);
    if (!farmStance(target)) return null;
    const known = new Set(plots.map((p) => posKey(p.offset(0, 1, 0))));
    const seen = new Set([posKey(target)]);
    const pending = [[target]];
    for (const [head, ...trail] of pending) {
      const bank = adjacent(head).find(fieldBank);
      if (bank) return [bank, head, ...trail];
      if (trail.length + 1 >= MAX_FIELD_WALK) continue;
      for (const next of adjacent(head)) {
        const key = posKey(next);
        if (!known.has(key) || seen.has(key) || !farmStance(next)) continue;
        seen.add(key);
        pending.push([next, head, ...trail]);
      }
    }
    return null;
  }

  function preservesFarmAccess(plot, bank, route) {
    const planner = bot.pathfinder;
    if (!door || typeof planner?.getPathFromTo !== 'function') return true;
    const entrance = door.offset(0, 0, -1);
    if (!exposed(entrance)) return false;
    const path = (from, to) => from.equals(to) || planner.getPathFromTo(planner.movements, from,
      new goals.GoalBlock(to.x, to.y, to.z), { timeout: 80, tickTimeout: 35, optimizePath: false, searchRadius: 32 })
      .next().value?.result?.status === 'success';
    const connected = (p) => path(entrance, p) && path(p, entrance);
    route.expansionPlot = plot;
    try {
      return connected(bank) && plots.every((p) => harvestBanks(p)
        .some((existing) => !existing.offset(0, -1, 0).equals(plot) && connected(existing)));
    } finally {
      route.expansionPlot = null;
    }
  }

  function selectExpansion(state, route) {
    const short = target - expeditionFoodCount(bot, state.inventory, kb);
    const limit = Math.min(MAX_RESERVE_PLOTS, short * 3 - (state.inventory.wheat || 0));
    if (plots.length >= limit || !state.inventory.wheat_seeds || !bot.registry?.blocksByName?.water || !bot.findBlocks) return null;
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
    const candidates = farming.choosePlots((point) => read(asVec(point)), centre, {
      count: MAX_RESERVE_PLOTS,
      exclude: excluded,
      findWater: (position, radius) => farming.findWater(bot, position, radius),
    });
    for (const candidate of candidates) {
      if (!candidate.hydrated || farming.plotState(bot, candidate) !== 'untilled') continue;
      const plot = asVec(candidate);
      const bank = harvestBanks(plot).find((p) => !planted.has(posKey(p.offset(0, -1, 0))) && preservesFarmAccess(plot, p, route));
      if (bank) return { plot, bank: bank.offset(0, -1, 0) };
    }
    return null;
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
        if (route.expansionPlot?.equals(p.offset(0, -1, 0))) return false;
        if (route.fieldStep) {
          const from = new Vec3(node.x, node.y, node.z);
          return route.fieldStep.from.equals(from) && route.fieldStep.to.equals(p)
            && accept(p) && fieldStance(from) && fieldStance(p);
        }
        if (route.fieldApproach && !fieldClear(p)) return false;
        if (route.fieldApproach && p.distanceTo(route.fieldApproach) <= 1 && backedSand(p)) {
          const from = new Vec3(node.x, node.y, node.z);
          return accept(p) && (exposed(from) || from.distanceTo(route.fieldApproach) <= 1 && backedSand(from))
            && Math.abs(from.x - p.x) + Math.abs(from.z - p.z) === 1;
        }
        if (route.scouting) {
          const from = new Vec3(node.x, node.y, node.z);
          if (Math.abs(p.x - node.x) + Math.abs(p.z - node.z) !== 1) return false;
          if (route.escapeCells && !route.escapeCells.get(posKey(from))?.equals(p)) return false;
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

  async function walkField(ctx, route, from, to) {
    const arrived = () => bot.entity.onGround && !bot.entity.isInWater && !bot.entity.isInLava
      && (farmStance(to) ? bot.entity.position.floored().equals(to.offset(0, -1, 0)) && farmlandFooting(read, bot.entity)
        : bot.entity.position.floored().equals(to) && fieldBank(to));
    if (!fieldStance(from) || !fieldStance(to)) return false;
    const movement = bot.pathfinder.movements;
    const sprint = movement.sprintSetting ?? movement.allowSprinting;
    movement.allowSprinting = false;
    route.fieldStep = { from, to };
    const guard = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, guard.signal]) : guard.signal;
    const monitor = setInterval(() => {
      if (!fieldStance(from) || !fieldStance(to) || bot.entity.isInWater || bot.entity.isInLava
        || threatsNear(ctx.perceive())) guard.abort('expedition_food_field_unsafe');
    }, 100);
    try {
      const result = await actions.goTo(bot, { ...ctx, signal }, new goals.GoalBlock(to.x, to.y, to.z),
        { arrived, timeoutMs: 2400, retryNoProgress: false });
      return (result.ok || result.reason === 'not_arrived') && await waitUntil(arrived, { timeoutMs: 450, signal });
    } catch (error) {
      if (!guard.signal.aborted || ctx.signal?.aborted) throw error;
      return false;
    } finally {
      clearInterval(monitor);
      route.fieldStep = null;
      movement.allowSprinting = sprint;
    }
  }

  const fieldFailure = () => ({ ok: false, reason: 'expedition_food_field_unreachable' });
  const fieldActive = (ctx) => !ctx.signal?.aborted && onDryGround() && !threatsNear(ctx.perceive());
  async function leaveField(ctx, route) {
    const feet = bot.entity.position.floored();
    const at = farmlandFooting(read, bot.entity) ? feet.offset(0, 1, 0) : feet;
    const index = fieldExit?.findIndex((p) => p.equals(at));
    if (index >= 0 && bot.entity.onGround) fieldExit.length = index + 1;
    else if (onDryGround() && fieldBank(at)) fieldExit = null;
    else return fieldFailure();
    while (fieldExit?.length > 1) {
      const last = fieldExit.at(-1);
      if (!fieldActive(ctx) || !bot.entity.position.floored().equals(last.offset(0, -1, 0))
        || !await walkField(ctx, route, last, fieldExit.at(-2))) return fieldFailure();
      fieldExit.pop();
    }
    fieldExit = null;
    return { ok: true };
  }

  async function harvestField(ctx, plot, path, route) {
    const [bank, ...steps] = path;
    const atBank = () => onDryGround() && bot.entity.position.floored().equals(bank) && fieldBank(bank);
    if (!atBank()) {
      route.fieldApproach = bank;
      try {
        const approach = await actions.goTo(bot, ctx, new goals.GoalBlock(bank.x, bank.y, bank.z),
          { arrived: atBank, timeoutMs: 8000, retryNoProgress: false });
        if (!(approach.ok || approach.reason === 'not_arrived')
          || !await waitUntil(atBank, { timeoutMs: 450, signal: ctx.signal })) return fieldFailure();
      } finally {
        route.fieldApproach = false;
      }
    }
    fieldExit = [bank];
    let result = fieldFailure();
    for (const next of steps) {
      if (!fieldActive(ctx)) break;
      const previous = fieldExit.at(-1);
      fieldExit.push(next);
      if (!await walkField(ctx, route, previous, next)) break;
    }
    let replanted = null;
    if (fieldActive(ctx) && farmlandFooting(read, bot.entity) && bot.entity.position.floored().equals(plot)
      && farming.plotState(bot, plot) === 'ripe') {
      result = await farming.harvest(bot, ctx, plot, { collect: () => sleep(550, ctx.signal) });
      if (result.ok && fieldActive(ctx) && ctx.perceive().inventory.wheat_seeds > 0 && farming.plotState(bot, plot) === 'empty') {
        replanted = (await farming.plant(bot, ctx, plot)).ok;
      }
    }
    const left = await leaveField(ctx, route);
    if (result.ok) return { ...result, replanted };
    return left.ok ? result : left;
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
  const travelFit = (state, reserve) => state.health >= 12 && state.food >= 14
    && expeditionFoodCount(bot, state.inventory, kb) >= reserve;
  const scoutFit = (state) => travelFit(state, 2);
  function safeFarReturn(state) {
    const range = distance(bot.entity.position.floored());
    return state.isDay === true && range > HOME_RADIUS && range <= SCOUT_RINGS.at(-1) + SCOUT_RETURN_MARGIN
      && travelFit(state, 1) && Object.keys(state.inventory).some((name) => name.endsWith('_sword') || name.endsWith('_axe'));
  }
  const waterReturn = createStockWaterReturn({ bot, centre, exposed, actions,
    safe: (state) => state.health >= 16 && scoutFit(state) && !threatsNear(state)
      && Object.keys(state.inventory).some((name) => name.endsWith('_sword') || name.endsWith('_axe')) });
  const scoutTimeLeft = (state, spareMs = 0) => {
    const elapsed = Date.now() - scout.started;
    return elapsed + spareMs < SCOUT_LIMIT_MS && daylightMs(state) > Math.max(30000, elapsed + 20000) + spareMs;
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
    ctx.record(label, { from, to, arrived: landed, ...(scout && { ring: SCOUT_RINGS[scout.ring] }), reason: result.reason });
    return landed;
  }

  async function scoutTowardFood(ctx, accept) {
    const mayContinue = () => {
      const live = ctx.perceive();
      return scoutFit(live) && scoutTimeLeft(live, SCOUT_HUNT_MARGIN_MS) && !threatsNear(live)
        && !bot.entity.isInWater && !bot.entity.isInLava;
    };
    if (!onDryGround() || !exposed(bot.entity.position.floored())) return false;
    const farAccept = (entity) => accept(entity) && !blacklist.has(`mob:${entity.id}`);
    const plan = await planScoutFoodApproach(bot, ctx, { mobs: FOOD_MOBS, accept: farAccept,
      mayContinue, maxLegSteps: SCOUT_STEPS });
    if (!plan || !mayContinue()) return false;
    const guard = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, guard.signal]) : guard.signal;
    const monitor = setInterval(() => {
      if (!mayContinue() || !bodyClear(bot.entity.position)) guard.abort('expedition_food_scout_hunt_unsafe');
    }, 100);
    try {
      ctx.record('expedition_food_scout_hunt_approach', { mob: plan.entity.name, id: plan.entity.id,
        from: plan.from, to: plan.to, approachSteps: plan.approachSteps, returnSteps: plan.returnSteps });
      if (!await scoutWalk({ ...ctx, signal }, plan.to, 'expedition_food_scout_hunt_step', mayContinue)) {
        blacklist.add(`mob:${plan.entity.id}`, 'expedition_food_scout_hunt_blocked', 10000);
      }
    } catch (error) {
      if (ctx.signal?.aborted || !guard.signal.aborted) throw error;
    } finally {
      clearInterval(monitor);
    }
    const at = bot.entity.position.floored();
    if (onDryGround() && exposed(at) && !at.equals(plan.from) && !scout.trail.at(-1)?.equals(at)) {
      if (!scout.trail.at(-1)?.equals(plan.from)) scout.trail.push(plan.from);
      scout.trail.push(at);
    }
    return true;
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

  function savedStartEscape(from, hostiles) {
    const towardsHome = (a, b) => distance(a) - distance(b);
    const clearance = (p) => Math.min(...hostiles.map((h) => p.offset(.5, 0, .5).distanceTo(h.position)));
    const queue = [{ at: from, previous: null, steps: 0 }];
    const seen = new Set([posKey(from)]);
    for (let i = 0; i < queue.length && i < 140; i++) {
      const node = queue[i];
      if (node.steps && clearance(node.at) > 17) {
        const cells = new Map();
        for (let n = node; n.previous; n = n.previous) cells.set(posKey(n.previous.at), n.at);
        return { to: node.at, cells };
      }
      if (node.steps >= 7) continue;
      const next = [];
      for (const [x, z] of CARDINAL) for (const y of [0, -1, 1]) {
        const p = node.at.offset(x, y, z);
        const key = posKey(p);
        if (seen.has(key) || !exposed(p)) continue;
        const edge = node.at.plus(p).scale(.5).offset(.5, 0, .5);
        edge.y = Math.min(node.at.y, p.y);
        if (!bodyClear(edge) || !awayFromThreats(hostiles, node.at.offset(.5, 0, .5), p.offset(.5, 0, .5))) continue;
        seen.add(key);
        next.push(p);
      }
      next.sort(towardsHome);
      for (const at of next) queue.push({ at, previous: node, steps: node.steps + 1 });
    }
    return null;
  }

  async function withdrawFromMelee(ctx, from, route, escape) {
    const to = escape?.to || scout?.trail.findLast((p) => p.distanceTo(from) >= 2);
    if (!to || from.distanceTo(to) > SCOUT_STEPS + 2) return wait(ctx, 'expedition_food_unsafe');
    if (escape) route.escapeCells = escape.cells;
    const centre = to.offset(.5, 0, .5);
    const directZombieWithdrawal = escape && route.zombieWithdrawal;
    let snapshot = null, sampledAt = 0;
    const observe = (refresh = false) => {
      if (refresh || Date.now() >= sampledAt) {
        sampledAt = Date.now() + 75;
        snapshot = ctx.perceive();
      }
      return snapshot;
    };
    const mayMove = (state) => canWithdraw(state) && (!escape || state.isDay === true);
    route.withdraw = () => retreatThreats(observe());
    const began = bot.entity.position.clone();
    if (!awayFromThreats(route.withdraw(), began, centre)) return wait(ctx, 'expedition_food_unsafe');
    const abort = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, abort.signal]) : abort.signal;
    const pathfinder = directZombieWithdrawal && bot.pathfinder;
    const shortcut = pathfinder && pathfinder.enablePathShortcut;
    if (pathfinder) pathfinder.enablePathShortcut = false;
    let previous = began;
    const monitor = setInterval(() => {
      const live = observe(true);
      const at = bot.entity.position;
      if (live.inWater || bot.entity.isInLava || !bodyClear(at) || !mayMove(live)
        || !awayFromThreats(retreatThreats(live), previous, at)) abort.abort('expedition_food_unsafe');
      previous = at.clone();
    }, 100);
    try {
      const label = escape ? 'expedition_food_return_withdraw' : 'expedition_food_scout_withdraw';
      if (await scoutWalk({ ...ctx, signal }, to, label, () => mayMove(observe(true)))) {
        if (scout && !escape) scout.trail.length = scout.trail.indexOf(to);
        if (scout && escape && scout.trail.at(-1)?.distanceTo(from) < 2) scout.trail.pop();
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
      if (pathfinder) pathfinder.enablePathShortcut = shortcut;
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
      if (!scout && returnLeg % headings.length === 0
        && (await detour.plan(ctx) || await waterReturn.plan(ctx))) return { ok: true };
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

  async function returnBehindCover(ctx, here) {
    const guard = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, guard.signal]) : guard.signal;
    const monitor = setInterval(() => {
      const live = ctx.perceive();
      if (live.inWater || bot.entity.isInLava || !travelFit(live, 1) || live.isDay !== true
        || !bodyClear(bot.entity.position) || nearbyThreats(live).some((threat) => !spiderBelowCover(threat))) {
        guard.abort('expedition_food_unsafe');
      }
    }, 100);
    try {
      const result = await (scout ? scoutHome({ ...ctx, signal }, here) : returnHome({ ...ctx, signal }, here));
      ctx.record('expedition_food_covered_return', { from: here.floored(), to: bot.entity.position.floored(), ok: result.ok });
      return result;
    } catch (error) {
      if (!guard.signal.aborted || ctx.signal?.aborted) throw error;
      return wait(ctx, 'expedition_food_unsafe');
    } finally {
      clearInterval(monitor);
    }
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
    if (waterReturn.pending()) {
      const outcome = await waterReturn.advance(ctx);
      if (!waterReturn.pending()) returnLeg = 0;
      return outcome;
    }
    const threats = retreatThreats(state);
    const hostile = threats.length > 0;
    const crafting = home.stations?.crafting_table;
    const oven = home.stations?.furnace;
    const bake = crafting && state.inventory.wheat >= 3 && !blacklist.has('bake');
    const bakeCount = Math.floor((state.inventory.wheat || 0) / 3);
    const checkChest = !checkedChest || fuelNeeded;
    if (hostile && !scout && door && field.length && homeExitReady(state)
      && threats.some((h) => h.name === 'creeper')) {
      const activity = bake ? { position: crafting, block: 'crafting_table', run: (scoped) => bakeReserve(scoped, bakeCount, crafting) }
        : checkChest && { position: home.chest, block: 'chest', run: (scoped) => checkReserveChest(scoped, true) };
      const supplied = await screenedHomeStation(ctx, here.clone(), activity);
      if (supplied) return supplied;
      const left = await screenedHomeExit(ctx, here);
      if (left) return left;
    }
    const fromOutside = !scout && safeFarReturn(state);
    const behindCover = !hostile && nearbyThreats(state).length > 0;
    if (state.health <= 6 || bot.entity.isInLava
      || hostile && ((!scout && !fromOutside) || !onDryGround() || !exposed(feet) || !canWithdraw(state))) return wait(ctx, 'expedition_food_unsafe');
    if (state.inWater || bot.entity.isInWater) {
      return scout || distance(feet) <= SCOUT_RINGS.at(-1) ? scoutAshore(ctx, here) : wait(ctx, 'expedition_food_unsafe');
    }
    if (detour.pending()) {
      const outcome = await detour.advance(ctx);
      if (!detour.pending()) returnLeg = 0;
      return outcome;
    }
    if (!scout && !inHouse(feet) && !exposed(feet) && !farmlandFooting(read, bot.entity) && actions.underground?.(bot)) {
      const result = await advanceCaveRetreat(bot, ctx, actions, centre, { visited,
        bridgeGap: true,
        avoid: (p) => inHouse(p) || (state.hostiles || []).some((h) => h.position?.distanceTo(p) <= 6 && isThreat(h)) });
      if (result.ok && !result.dug) {
        visited.add(posKey(feet));
        if (visited.size > 64) visited.delete(visited.values().next().value);
      }
      return result;
    }
    visited.clear();
    const cook = oven && (state.inventory.chicken > 0 || furnace.input > 0 || furnace.output > 0)
      && !blacklist.has('cook');
    const homeTask = cook || bake || checkChest;
    const scouting = typeof bot.pathfinder?.getPathFromTo === 'function';
    returning ||= scout ? hostile || homeTask || !scoutFit(state) || !scoutTimeLeft(state) : distance(feet) > HOME_RADIUS;
    const huntEdge = scout ? SCOUT_RINGS[scout.ring] : HOME_RADIUS;
    const edge = Math.max(huntEdge, returning ? distance(feet) + 4 : 0);
    const route = { pickup: null, scouting: Boolean(scout || hostile || behindCover) };
    return dryWalk(async () => {
      if (hostile) {
        // A distant zombie is still hostile. Allow only the short connected
        // withdrawal, never a scout hunt or an approach toward the mob.
        route.zombieWithdrawal = threats.some((h) => h.name === 'zombie');
        const verifiedEscape = fromOutside || route.zombieWithdrawal;
        const escape = verifiedEscape && savedStartEscape(feet, threats);
        if (verifiedEscape && !escape) return wait(ctx, 'expedition_food_unsafe');
        return withdrawFromMelee(ctx, feet, route, escape);
      }
      if (fieldExit) return leaveField(ctx, route);
      if (homeTask || returning) {
        const inside = Math.abs(here.x - centre.x - .5) < 2.6 && Math.abs(here.z - centre.z - .5) < 2.6
          && Math.abs(here.y - centre.y) < .8;
        if (!inside) {
          if (behindCover) return returnBehindCover(ctx, here);
          return scout ? scoutHome(ctx, here) : returnHome(ctx, here);
        }
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
        if (bake) return bakeReserve(ctx, bakeCount, crafting);
        if (checkChest) return checkReserveChest(ctx);
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
          dropMatch: (name) => edible(name) || name === 'chicken', radius: scout ? NEAR_HUNT : HOME_RADIUS, blacklist, accept });
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
        if (await scoutTowardFood(ctx, accept)) return scoutDelay();
        return scoutOut(ctx, bot.entity.position);
      }
      const growing = crafting && plots.some((p) => canTarget(p) && farming.plotState(bot, p) === 'growing');
      if (crafting) {
        const stage = (want) => plots.find((p) => canTarget(p) && !blacklist.has(posKey(p)) && farming.plotState(bot, p) === want);
        const empty = state.inventory.wheat_seeds > 0 && stage('empty');
        const ripe = plots.find((p) => canTarget(p) && !blacklist.has(posKey(p))
          && farming.plotState(bot, p) === 'ripe' && harvestBanks(p).length);
        let path = null;
        const indirect = !empty && !ripe && typeof bot.pathfinder?.movements?.getNeighbors === 'function'
          && plots.find((p) => canTarget(p) && !blacklist.has(posKey(p)) && farming.plotState(bot, p) === 'ripe'
            && (path = fieldPath(p)));
        const plot = empty || ripe || indirect;
        if (plot) {
          const result = await (empty ? farming.plant(bot, ctx, plot) : indirect ? harvestField(ctx, plot, path, route) : farming.harvest(bot, ctx, plot,
            { collect: () => collectWheat(ctx, plot, route) }));
          ctx.record('expedition_food_farm', { action: empty ? 'plant' : 'harvest', plot: posKey(plot), ok: result.ok, gained: result.gained });
          if (result.replanted !== null && result.replanted !== undefined) {
            ctx.record('expedition_food_farm', { action: 'plant', plot: posKey(plot), ok: result.replanted });
          }
          if (!result.ok || !empty && result.gained < 1) blacklist.add(posKey(plot), result.reason || 'wheat_not_collected');
          return result;
        }
        const hasHoe = countKey('hoe', state.inventory, kb) > 0;
        const canCraftHoe = (state.inventory.cobblestone || 0) >= 2 && (state.inventory.stick || 0) >= 2
          && !blacklist.has('farm_hoe');
        const extension = growing && (hasHoe || canCraftHoe) && selectExpansion(state, route);
        if (extension) {
          if (!hasHoe) {
            if (!inHouse(feet)) return returnHome(ctx, here);
            const crafted = await skills.craft(bot, ctx, { item: 'stone_hoe', tablePosition: crafting });
            ctx.record('expedition_food_hoe', { ok: crafted.ok, reason: crafted.reason });
            if (!crafted.ok) blacklist.add('farm_hoe', crafted.reason, SEARCH_REST_MS);
            return crafted;
          }
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
