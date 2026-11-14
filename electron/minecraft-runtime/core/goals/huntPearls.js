'use strict';
// Goal: ender pearls from endermen, hunted around home at night.
//
// Endermen walk the overworld only in the dark, so this is a night's work:
// each run() hunts the nearest enderman in sight (struck in melee it does not
// teleport away; it fights back), and with none in sight walks a little to
// look further. The night rest leaves this goal alone (companion.js). It ends
// when the bag holds `count` pearls, or at dawn after hunting through a night:
// the caller sets it again the next evening.

const defaultSkills = require('../skills');
const { createBlacklist } = require('../blacklist');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultActions = require('../actions');
const { advanceCaveRetreat, skyOpen, standable, walkDry } = require('../caveRetreat');
const { meleeSight } = require('../entityGeometry');
const { applyWalkOnlyMovements } = require('../nether');
const { sleep, waitUntil } = require('../confirm');

const HOME_RANGE = 24;
const HOME_RETURN_RANGE = 55;
const HOME_RETURN_LEG = 7;
const HOME_RETURN_NEAR = 6;
// An enderman looked in the eyes turns on the player and teleports over.
const STARE_NEAR = 6;
const STARE_FAR = 48;
const STARE_MS = 12000;
const STARE_TURN_MS = 2200;
const STARE_AGAIN_MS = 30000;
const LURE_HOLD_MS = 8000;
const FIGHT_RADIUS = 3;
const ENDERMAN_EYES = 2.55;
const ENGAGE_HEALTH = 14;
const ENGAGE_FOOD = 15;
const SCOUT_RADIUS = 48;
const SCOUT_LEG = 10;
const SCOUT_NODES = 320;
const SCOUT_HISTORY = 64;
const SECTOR_DEPTH = 14;
const SECTOR_SEARCH_STEPS = 32;
const SECTOR_SEARCH_NODES = 1200;
const SECTOR_LEG = 7;
const NEAR_SCOUT_MIN = 6;
const NEAR_SCOUT_MAX = 18;
const NEAR_SCOUT_REPEAT_MS = 70000;
const NEAR_SCOUT_BUDGET_MS = 35000;
const NEAR_SCOUT_WATCH_MS = 6000;
const DOOR_DIRECTIONS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

const MOBS = ['enderman'];
const isPearl = (n) => n === 'ender_pearl';
const pointKey = (p) => `${p.x},${p.y},${p.z}`;
const flatDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function scoutSectorOf(position, centre) {
  const dx = position.x - centre.x, dz = position.z - centre.z;
  if (Math.hypot(dx, dz) < 8) return null;
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west';
  return dz > 0 ? 'south' : 'north';
}

function pearlCaveRecoveryNeeded(bot, house, position) {
  if (!house || !position || position.y >= house.y - 2 || flatDistance(position, house) > SCOUT_RADIUS) return false;
  const feet = new Vec3(position.x, position.y, position.z).floored();
  return position.y < house.y - 7 || !skyOpen(bot, feet);
}

function pearlTetherRecoveryNeeded(house, position) {
  if (!house || !position) return false;
  const distance = flatDistance(position, house);
  return Number.isFinite(distance) && distance > SCOUT_RADIUS && distance <= SCOUT_RADIUS + SCOUT_LEG;
}

function openScoutColumn(bot, feet) {
  const top = (bot.game?.minY ?? -64) + (bot.game?.height ?? 384);
  for (let y = feet.y + 1; y < top; y += 1) {
    const name = bot.blockAt(feet.offset(0, y - feet.y, 0), false)?.name;
    if (name !== 'air' && name !== 'cave_air' && name !== 'void_air') return false;
  }
  return true;
}

function scoutGround(bot, p) {
  const read = (at) => bot.blockAt(at, false);
  return standable(read, p) && !read(p.offset(0, -1, 0))?.name.endsWith('_leaves') && openScoutColumn(bot, p);
}

function pearlWaterBank(bot, house) {
  const entity = bot?.entity;
  if (!house || entity?.isInWater !== true || entity.isInLava || !entity.position?.floored) return null;
  const feet = entity.position.floored();
  const head = bot.blockAt(feet.offset(0, 1, 0), false);
  if (!head || !/^(air|cave_air|void_air)$/.test(head.name)) return null;
  return Object.values(DOOR_DIRECTIONS).map(([x, z]) => feet.offset(x, 1, z))
    .find((p) => flatDistance(p, house) <= SCOUT_RADIUS && scoutGround(bot, p)) || null;
}

const dryLeafCanopy = (bot, feet) => skyOpen(bot, feet, { allowLeafCanopy: true });

function pearlHomeReturnNeeded(house, position, bot) {
  if (!house || !position) return false;
  const radius = flatDistance(position, house);
  if (radius <= HOME_RANGE || radius > HOME_RETURN_RANGE || !Number.isFinite(radius)) return false;
  if (!bot?.blockAt) return false;
  const feet = new Vec3(position.x, position.y, position.z).floored();
  const read = (at) => bot.blockAt(at, false);
  return bot.entity?.onGround === true && !bot.entity.isInWater && !bot.entity.isInLava
    && (scoutGround(bot, feet) || standable(read, feet) && dryLeafCanopy(bot, feet));
}

function createHuntPearlsGoal({ bot, count = 12, radius = 64, scoutSector, skills = defaultSkills, actions = defaultActions } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  if (scoutSector !== undefined && (typeof scoutSector !== 'string' || !Object.hasOwn(DOOR_DIRECTIONS, scoutSector))) {
    throw new TypeError('invalid pearl scout sector');
  }
  const blacklist = createBlacklist({ ttlMs: 60000 });
  const memory = { centre: null, scoutPositions: [], scoutCoverage: {}, nights: 0, hunted: 0, sawNight: false, ascending: false };
  const landedScoutCells = new Set();
  let sectorRoute;
  let recoveringTether = false;
  let tetherFailures = 0;
  let homeward = false;
  let homeRoute = [];
  let homeFailures = 0;
  let waterFailures = 0;
  let recoveringWater = false;
  const nearCamps = [];
  let nextNearScout = 0;
  let nearScout;
  const caveVisited = new Set();
  const pearls = (state) => state.inventory.ender_pearl || 0;

  const creepyIndex = () => bot.registry?.entitiesByName?.enderman?.metadataKeys?.indexOf('creepy') ?? -1;
  const angry = (e) => { const i = creepyIndex(); return i >= 0 && e.metadata?.[i] === true; };
  const endermen = () => Object.values(bot.entities || {}).filter((e) => e?.name === 'enderman' && e.position);
  const read = (p) => bot.blockAt(p, false);
  const outdoors = (p) => standable(read, p) && skyOpen(bot, p);
  const clearColumn = (feet) => openScoutColumn(bot, feet);
  const leafFloor = (p) => read(p.offset(0, -1, 0))?.name.endsWith('_leaves');
  const scoutGroundAt = (p) => scoutGround(bot, p);
  const targetOutdoors = (p) => standable(read, p) && skyOpen(bot, p, { allowLeafCanopy: true });
  const restingAtHome = (p, centre) => centre && p.distanceTo(centre) <= HOME_RETURN_NEAR;
  const readyToHunt = (state) => state.health >= ENGAGE_HEALTH && state.food >= ENGAGE_FOOD
    && Object.keys(state.inventory).some((name) => name.endsWith('_sword') || name.endsWith('_axe'));
  const visible = (entity, from = bot.entity.position) => {
    const eye = from.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
    const point = entity.position.offset(0, ENDERMAN_EYES, 0);
    return meleeSight(bot, { eye, point, distance: eye.distanceTo(point) }) === 'clear';
  };
  const wait = async (ctx, reason) => {
    await sleep(750, ctx.signal);
    return { ok: true, waited: true, reason };
  };

  function fightFooting(feet) {
    const firm = (p) => standable(read, p) && !leafFloor(p);
    if (!firm(feet)) return false;
    // An Enderman can teleport around the hunter, so leave room to absorb
    // knockback in any direction with a drop of at most one block.
    for (let x = -FIGHT_RADIUS; x <= FIGHT_RADIUS; x += 1) {
      for (let z = -FIGHT_RADIUS; z <= FIGHT_RADIUS; z += 1) {
        if (x * x + z * z > FIGHT_RADIUS * FIGHT_RADIUS) continue;
        if (![0, -1, 1].some((y) => firm(feet.offset(x, y, z)))) return false;
      }
    }
    return true;
  }

  // Stared at, an enderman turns on the player; but one that is angry and
  // still looked at stands frozen (within 16 blocks it waits out the stare).
  // So: look one in the eyes until it turns, then look at the ground and let
  // it come. One at a time: two at once killed a bot in iron in ten seconds.
  async function stare(ctx, targets) {
    const here = bot.entity.position;
    // One already angry and close is the fight (defend): none turned meanwhile.
    if (endermen().some((e) => angry(e) && e.position.distanceTo(here) <= STARE_NEAR)) return null;
    const near = targets.map((e) => ({ e, d: e.position.distanceTo(here) }))
      .filter(({ d }) => d > STARE_NEAR && d <= STARE_FAR);
    const turned = near.filter(({ e }) => angry(e)).sort((a, b) => a.d - b.d)[0];
    const target = turned || near.filter(({ e }) => !blacklist.has(`stare:${e.id}`)).sort((a, b) => a.d - b.d)[0];
    if (!target) return null;
    const { e } = target;
    blacklist.add(`stare:${e.id}`, 'stared', STARE_AGAIN_MS);
    ctx.record('enderman_stare', { id: e.id, distance: Math.round(target.d), angry: angry(e) });
    actions.haltBody?.(bot);
    const started = Date.now();
    const until = started + STARE_MS;
    let turnedAt = angry(e) ? started : null;
    while (Date.now() < until && bot.entities?.[e.id]) {
      if (e.position.distanceTo(bot.entity.position) <= STARE_NEAR) break;
      if (!turnedAt && angry(e)) turnedAt = Date.now();
      if (!turnedAt && (Date.now() - started >= STARE_TURN_MS || !readyToHunt(ctx.perceive()) || !visible(e))) break;
      if (turnedAt) await bot.look(bot.entity.yaw, -Math.PI / 2, true);
      else await bot.lookAt(e.position.offset(0, ENDERMAN_EYES, 0), true);
      await sleep(100, ctx.signal);
    }
    const came = Boolean(bot.entities?.[e.id]) && e.position.distanceTo(bot.entity.position) <= STARE_NEAR;
    if (turnedAt) memory.lured = { id: e.id, until: Date.now() + LURE_HOLD_MS };
    ctx.record('enderman_stare_result', { id: e.id, came, angry: angry(e), turnedMs: turnedAt ? turnedAt - started : null,
      gone: !bot.entities?.[e.id], distance: Math.round(e.position.distanceTo(bot.entity.position)) });
    return { ok: true, progress: came, waited: !came };
  }

  function home() {
    const at = bot.companionHomeAt?.();
    return at ? new Vec3(at.x, at.y, at.z) : null;
  }

  async function regainSurface(ctx, state, house) {
    const from = bot.entity.position.floored();
    if (!bot.entity.onGround || state.inWater || bot.entity.isInLava) return wait(ctx, 'pearl_wait_for_dry_ground');
    const avoid = (p) => bot.companionHomeSite?.(p) || flatDistance(p, house) > SCOUT_RADIUS
      || (ctx.perceive().hostiles || []).some((h) => h.position?.distanceTo(p.offset(.5, 0, .5)) <= 5);
    const result = await advanceCaveRetreat(bot, ctx, actions, house, {
      visited: caveVisited, avoid, bridgeGap: true, surfaceFloor: house.y - 2,
    });
    if (!result.ok) return wait(ctx, result.reason);
    if (!result.dug) {
      caveVisited.add(pointKey(from));
      if (caveVisited.size > 80) caveVisited.delete(caveVisited.values().next().value);
      ctx.record('pearl_cave_ascent', { from, to: result.to });
    }
    return { ...result, waited: true };
  }

  async function leaveHouse(ctx, from, centre) {
    if (!restingAtHome(from, centre) || !standable(read, from)) return false;
    const door = bot.findBlock?.({ maxDistance: 6, matching: (block) => /_door$/.test(block?.name),
      useExtraInfo: (block) => block.getProperties?.()?.half === 'lower' });
    if (!door || door.position.distanceTo(centre) > 5 || !actions.withinReach?.(bot, door.position)) return false;
    const { facing, open } = door.getProperties();
    if (!DOOR_DIRECTIONS[facing]) return false;
    const [dx, dz] = DOOR_DIRECTIONS[facing];
    const exits = [1, -1].flatMap((direction) => [0, -1, 1].map((y) => door.position.offset(dx * direction, y, dz * direction)));
    const exit = exits.find((p) => scoutGroundAt(p) && p.distanceTo(centre) > from.distanceTo(centre));
    if (!exit) return false;
    if (!open) {
      try { await bot.activateBlock(door); } catch (error) { if (error?.code === 'aborted') throw error; }
      if (!await waitUntil(() => read(door.position)?.getProperties()?.open === true, { timeoutMs: 1000, signal: ctx.signal })) return false;
    }
    const restore = applyWalkOnlyMovements(bot);
    try {
      const result = await actions.goTo(bot, ctx, new goals.GoalBlock(exit.x, exit.y, exit.z),
        { timeoutMs: 5000, retryNoProgress: false });
      if (result.ok && bot.entity.position.floored().equals(exit)) {
        ctx.record('pearl_house_exit', { from, door: door.position, to: exit });
        return true;
      }
      return false;
    } finally { restore(); }
  }

  function dryScoutMovements() {
    const movements = bot.pathfinder?.movements;
    if (typeof movements?.getNeighbors !== 'function') return null;
    return Object.assign(Object.create(movements), { canDig: false, allowParkour: false,
      allow1by1towers: false, scafoldingBlocks: [], maxDropDown: 2, infiniteLiquidDropdownDistance: false });
  }

  function safeScoutMoves(dry, point) {
    return dry.getNeighbors(Object.assign(point.clone(), { remainingBlocks: 0 })).filter((move) => !move.parkour
      && !move.toBreak?.length && !move.toPlace?.length && Math.abs(move.y - point.y) <= 1 && flatDistance(point, move) <= Math.SQRT2);
  }

  const tetheredOutside = (centre, feet) => tetherFailures < 2
    && (pearlTetherRecoveryNeeded(centre, feet) || pearlTetherRecoveryNeeded(centre, bot.entity.position))
    && bot.entity.onGround === true && !bot.entity.isInWater && !bot.entity.isInLava && scoutGroundAt(feet);

  function tetherEntry(from, centre) {
    const dry = dryScoutMovements();
    if (!dry) return null;
    const distance = flatDistance(from, centre);
    const nodes = [{ point: from, steps: 0 }];
    const seen = new Set([pointKey(from)]);
    let better = null;
    let nearest = distance - 2;
    for (const { point, steps } of nodes) {
      if (steps >= SCOUT_LEG) continue;
      for (const move of safeScoutMoves(dry, point)) {
        if (nodes.length >= SCOUT_NODES) return better;
        const key = pointKey(move);
        const d = flatDistance(move, centre);
        if (seen.has(key) || d > distance + 1) continue;
        seen.add(key);
        const p = new Vec3(move.x, move.y, move.z);
        if (!scoutGroundAt(p)) continue;
        // The pathfinder can stop anywhere inside the block. Rejoin with
        // both the physical body centre and the floor cell inside the tether.
        if (d <= SCOUT_RADIUS && [p.offset(1, 0, 0), p.offset(0, 0, 1), p.offset(1, 0, 1)]
          .every((corner) => flatDistance(corner, centre) <= SCOUT_RADIUS)) return p;
        nodes.push({ point: p, steps: steps + 1 });
        if (d < nearest) { better = p; nearest = d; }
      }
    }
    return better;
  }

  async function recoverScoutTether(ctx, from, centre) {
    recoveringTether = true;
    const target = tetherEntry(from, centre);
    if (target) {
      const limit = flatDistance(from, centre) + 1;
      const arrived = (p) => bot.entity.onGround === true && p.floored().equals(target) && scoutGroundAt(target);
      const surface = new Map();
      const avoid = (p) => {
        if (flatDistance(p, centre) > limit || flatDistance(p, from) > SCOUT_LEG + 3) return true;
        const key = pointKey(p);
        if (!surface.has(key)) surface.set(key, scoutGroundAt(p));
        return !surface.get(key);
      };
      await walkDry(bot, ctx, actions, new goals.GoalBlock(target.x, target.y, target.z), { avoid, arrived });
      const landed = () => arrived(bot.entity.position);
      if (bot.entity.position.floored().equals(target)
        && (landed() || await waitUntil(landed, { timeoutMs: 500, signal: ctx.signal }))) {
        tetherFailures = 0;
        ctx.record('pearl_scout_tether_return', { from, to: target, centre });
        return { ok: true, waited: true };
      }
    }
    tetherFailures += 1;
    return wait(ctx, 'pearl_scout_tether_blocked');
  }

  function wantsHome(state, house) {
    return state.isDay === true && !state.inWater && homeFailures < 2 && house
      && (homeward ? !restingAtHome(bot.entity.position.floored(), house)
        : pearlHomeReturnNeeded(house, bot.entity.position, bot));
  }

  async function planDryRoute(ctx, centre, goal, radius = HOME_RETURN_RANGE + 1) {
    const dry = dryScoutMovements();
    if (!dry || typeof bot.pathfinder.getPathFromTo !== 'function') return [];
    const safe = new Map();
    const accepted = (p) => {
      if (flatDistance(p, centre) > radius) return false;
      const key = pointKey(p);
      if (!safe.has(key)) safe.set(key, scoutGroundAt(p));
      return safe.get(key);
    };
    const native = Object.create(dry);
    native.getNeighbors = (p) => safeScoutMoves(dry, p).filter(accepted);
    const route = bot.pathfinder.getPathFromTo(native, bot.entity.position, goal,
      { timeout: 1100, tickTimeout: 25, searchRadius: 96, optimizePath: false });
    for (const { result } of route) {
      if (result.status === 'success') return result.path.map((p) => new Vec3(p.x, p.y, p.z));
      if (result.status !== 'partial') break;
      await sleep(15, ctx.signal);
    }
    return [];
  }

  async function walkRouteLeg(ctx, from, route) {
    const leg = route.slice(0, HOME_RETURN_LEG);
    const next = leg.at(-1);
    if (!next) return null;
    const allowed = new Set([pointKey(from), ...leg.map(pointKey)]);
    const arrived = (p) => bot.entity.onGround === true && p.floored().equals(next) && scoutGroundAt(next);
    await walkDry(bot, ctx, actions, new goals.GoalBlock(next.x, next.y, next.z), {
      avoid: (p) => !allowed.has(pointKey(p)) || !scoutGroundAt(p), arrived,
    });
    const landed = () => arrived(bot.entity.position);
    if (!bot.entity.position.floored().equals(next)
      || !(landed() || await waitUntil(landed, { timeoutMs: 500, signal: ctx.signal }))) return null;
    route.splice(0, leg.length);
    return next;
  }

  async function returnInDaylight(ctx, from, centre) {
    homeward = true;
    if (bot.entity.onGround && !bot.entity.isInLava && !bot.entity.isInWater && needsGroundBank(from)) {
      const bank = await stepToGroundBank(ctx, from, centre);
      if (bank) return bank;
    }
    if (bot.entity.onGround && !bot.entity.isInLava && !bot.entity.isInWater && scoutGroundAt(from)) {
      if (!homeRoute.length) {
        const homeBank = new goals.GoalNear(centre.x, centre.y, centre.z, HOME_RETURN_NEAR);
        homeRoute = await planDryRoute(ctx, centre, homeBank);
      }
      const next = await walkRouteLeg(ctx, from, homeRoute);
      if (next) {
        homeFailures = 0;
        ctx.record('pearl_daylight_home_leg', { from, to: next, centre, remaining: homeRoute.length });
        return { ok: true, waited: true };
      }
      homeRoute = [];
    }
    homeFailures += 1;
    if (homeFailures >= 2) {
      const { day, timeOfDay } = bot.time || {};
      memory.homeReturnBlockedDay = Number.isFinite(day) ? day + (timeOfDay > 23460 ? 1 : 0) : null;
    }
    return wait(ctx, 'pearl_daylight_home_blocked');
  }

  function planSectorRoute(from) {
    const dry = dryScoutMovements();
    if (!dry) return [];
    const centre = memory.centre;
    const inSector = (p) => scoutSectorOf(p, centre) === scoutSector && flatDistance(p, centre) >= SECTOR_DEPTH;
    if (inSector(from)) return [];
    const nodes = [{ point: from, steps: 0, previous: null }];
    const seen = new Set([pointKey(from)]);
    for (const node of nodes) {
      if (inSector(node.point)) {
        const route = [];
        for (let n = node; n.previous; n = n.previous) if (n === node || n.steps % SECTOR_LEG === 0) route.unshift(n.point);
        return route;
      }
      if (node.steps >= SECTOR_SEARCH_STEPS || nodes.length >= SECTOR_SEARCH_NODES) continue;
      for (const move of safeScoutMoves(dry, node.point)) {
        if (nodes.length >= SECTOR_SEARCH_NODES) break;
        const key = pointKey(move);
        if (seen.has(key) || flatDistance(move, centre) > SCOUT_RADIUS) continue;
        seen.add(key);
        const p = new Vec3(move.x, move.y, move.z);
        if (scoutGroundAt(p)) nodes.push({ point: p, steps: node.steps + 1, previous: node });
      }
    }
    return [];
  }

  function scoutTarget(from, accept, focus) {
    const dry = dryScoutMovements();
    if (!dry) return null;
    const visited = memory.scoutPositions;
    const visitedAt = new Map(visited.map((p, i) => [pointKey(p), i]));
    const aim = focus?.position;
    const nodes = [{ point: from, steps: 0 }];
    const seen = new Set([pointKey(from)]);
    let best = null;
    let highest = -Infinity;
    let transfer = null;
    let leastRecent = visited.length;
    for (const { point, steps } of nodes) {
      if (steps >= SCOUT_LEG) continue;
      for (const move of safeScoutMoves(dry, point)) {
        if (nodes.length >= SCOUT_NODES) return best || transfer;
        const key = pointKey(move);
        if (seen.has(key) || !accept(move)) continue;
        seen.add(key);
        const next = new Vec3(move.x, move.y, move.z);
        nodes.push({ point: next, steps: steps + 1 });
        if (blacklist.has(`scout:${key}`)) continue;
        const previous = visitedAt.get(key);
        if (!aim && previous !== undefined) {
          // Leave an exhausted patch via the least recently used dry stop.
          if (previous < leastRecent) { transfer = next; leastRecent = previous; }
          continue;
        }
        // Prefer broader sight coverage when a straight compass ray can lie
        // across water or underneath a dense canopy.
        const rank = aim ? -(steps + 1) - next.distanceTo(aim) * .1
          : Math.min(...visited.map((p) => flatDistance(p, next))) + flatDistance(next, memory.centre) * .85 - (steps + 1) * .1;
        if (rank > highest && (!aim || next.distanceTo(aim) <= STARE_FAR && fightFooting(next)
          && visible(focus, next.offset(.5, 0, .5)))) { best = next; highest = rank; }
      }
    }
    return best || transfer;
  }

  const needsGroundBank = (from) => standable(read, from) && !scoutGroundAt(from) && dryLeafCanopy(bot, from);

  // A hunter pushed under dry leaves can take one supported step into the open.
  async function stepToGroundBank(ctx, from, centre) {
    const dry = dryScoutMovements();
    const adjacent = dry ? safeScoutMoves(dry, from) : [];
    const step = adjacent.filter((p) => flatDistance(from, p) === 1 && scoutGroundAt(p))
      .sort((a, b) => centre ? flatDistance(a, centre) - flatDistance(b, centre) : 0)[0];
    const bank = step && new Vec3(step.x, step.y, step.z);
    if (!bank) return null;
    const arrived = (p) => bot.entity.onGround && p.floored().equals(bank) && scoutGroundAt(bank);
    const moved = await walkDry(bot, ctx, actions, new goals.GoalBlock(bank.x, bank.y, bank.z),
      { adjacent: bank, timeoutMs: 2000, arrived });
    if (moved.ok && arrived(bot.entity.position)) {
      ctx.record('pearl_scout_ground_bank', { from, to: bank });
      return { ok: true, waited: true };
    }
    return null;
  }

  function rememberNearCamp(centre, p) {
    if (!centre || flatDistance(p, centre) < NEAR_SCOUT_MIN || flatDistance(p, centre) > NEAR_SCOUT_MAX
      || nearCamps.length >= 6 || nearCamps.some((camp) => flatDistance(p, camp) < 5) || !fightFooting(p)) return;
    nearCamps.push(p);
  }

  async function revisitNearCamps(ctx, from, centre) {
    const now = Date.now();
    if (!nearScout) {
      if (!centre || now < nextNearScout || !nearCamps.length) return null;
      nextNearScout = now + NEAR_SCOUT_REPEAT_MS;
      const camp = nearCamps.shift();
      nearCamps.push(camp);
      if (!fightFooting(camp) || !scoutGroundAt(camp)) return null;
      const route = from.equals(camp) ? [] : await planDryRoute(ctx, centre,
        new goals.GoalBlock(camp.x, camp.y, camp.z), SCOUT_RADIUS);
      if (!route.length && !from.equals(camp)) return null;
      nearScout = { camp, route, until: now + NEAR_SCOUT_BUDGET_MS, watchUntil: 0 };
    }
    if (Date.now() >= nearScout.until) { nearScout = null; return null; }
    if (nearScout.route.length) {
      const next = await walkRouteLeg(ctx, from, nearScout.route);
      if (!next) { nearScout = null; return null; }
      ctx.record('pearl_near_scout_leg', { from, to: next, camp: nearScout.camp, remaining: nearScout.route.length });
      return { ok: true, waited: true };
    }
    if (!from.equals(nearScout.camp) || !fightFooting(from)) { nearScout = null; return null; }
    if (!nearScout.watchUntil) {
      nearScout.watchUntil = now + NEAR_SCOUT_WATCH_MS;
      ctx.record('pearl_near_scout_watch', { at: from });
    }
    if (now < nearScout.watchUntil) return wait(ctx, 'pearl_near_scout_watch');
    nearScout = null;
    return null;
  }

  async function scout(ctx, state, focus) {
    const from = bot.entity.position.floored();
    const house = home();
    if (state.inWater || bot.entity.onGround === false) return wait(ctx, 'pearl_wait_for_dry_ground');
    if (needsGroundBank(from)) {
      return await stepToGroundBank(ctx, from, house) || wait(ctx, 'pearl_wait_for_ground_bank');
    }
    if (!scoutGroundAt(from)) {
      // On a natural lip the grounded collision box can overlap the support
      // while the centre has crossed into the next, lower column.
      if (bot.entity.onGround && clearColumn(from)) {
        const here = bot.entity.position;
        const bodyRadius = (bot.entity.width || 0.6) / 2;
        const support = Object.values(DOOR_DIRECTIONS).map(([x, z]) => from.offset(x, 0, z)).find((p) =>
          here.x + bodyRadius > p.x && here.x - bodyRadius < p.x + 1
          && here.z + bodyRadius > p.z && here.z - bodyRadius < p.z + 1 && scoutGroundAt(p));
        if (support) {
          const arrived = (at) => bot.entity.onGround && at.floored().equals(support) && scoutGroundAt(support);
          const result = await walkDry(bot, ctx, actions, new goals.GoalBlock(support.x, support.y, support.z),
            { adjacent: support, timeoutMs: 2000, arrived });
          if (result.ok && arrived(bot.entity.position)) {
            ctx.record('pearl_scout_regained_footing', { from, to: support });
            return { ok: true, waited: true };
          }
        }
      }
      if (await leaveHouse(ctx, from, house)) return { ok: true, waited: true };
      return wait(ctx, 'pearl_wait_for_surface');
    }
    if (!memory.centre) memory.centre = house && flatDistance(from, house) <= SCOUT_RADIUS ? house : from;
    const centre = memory.centre;
    const hasHomeCentre = house && centre.equals(house);
    if (hasHomeCentre && bot.entity.onGround === true) {
      rememberNearCamp(house, from);
      if (!focus) {
        const revisit = await revisitNearCamps(ctx, from, house);
        if (revisit) return revisit;
      } else {
        nearScout = null;
      }
    }
    if (!memory.scoutPositions.at(-1)?.equals(from)) {
      memory.scoutPositions.push(from);
      if (memory.scoutPositions.length > SCOUT_HISTORY) memory.scoutPositions.shift();
    }
    const surface = new Map();
    const accept = (p) => {
      if (flatDistance(p, centre) > SCOUT_RADIUS || flatDistance(p, from) > SCOUT_LEG + 3) return false;
      const key = pointKey(p);
      if (!surface.has(key)) surface.set(key, scoutGroundAt(p));
      return surface.get(key);
    };
    let target = focus && scoutTarget(from, accept, focus);
    if (focus && !target) {
      blacklist.add(`approach:${focus.id}`, 'pearl_approach_blocked', 15000);
      focus = null;
    }
    if (!focus && scoutSector && sectorRoute === undefined) sectorRoute = planSectorRoute(from);
    const sectorHop = !focus && sectorRoute?.[0];
    if (!target) target = sectorHop || scoutTarget(from, accept);
    if (!target) return wait(ctx, 'pearl_scout_no_dry_route');
    const goal = new goals.GoalBlock(target.x, target.y, target.z);
    ctx.record('pearl_surface_scout', { from, target, centre, towardEnderman: Boolean(focus), ...(sectorHop ? { scoutSector } : {}) });
    surface.clear();
    const result = await walkDry(bot, ctx, actions, goal, { timeoutMs: 5000, avoid: (p) => !accept(p) });
    const at = bot.entity.position.floored();
    const landed = () => bot.entity.onGround === true && !bot.entity.isInWater
      && bot.entity.position.floored().equals(target) && scoutGroundAt(target);
    if (at.equals(target) && (landed() || await waitUntil(landed, { timeoutMs: 500, signal: ctx.signal }))) {
      const key = pointKey(target);
      if (!landedScoutCells.has(key)) {
        const sector = scoutSectorOf(target, centre);
        landedScoutCells.add(key);
        if (sector) memory.scoutCoverage[sector] = (memory.scoutCoverage[sector] || 0) + 1;
      }
      if (sectorHop) sectorRoute.shift();
      return { ok: true, waited: true };
    }
    if (sectorHop) sectorRoute = [];
    blacklist.add(`scout:${pointKey(target)}`, result.reason || 'pearl_scout_not_arrived', 15000);
    if (flatDistance(at, from) >= 2) return { ok: true, waited: true };
    if (focus) blacklist.add(`approach:${focus.id}`, result.reason || 'pearl_approach_blocked', 15000);
    return wait(ctx, result.reason || 'pearl_scout_no_progress');
  }

  const pendingWaterBank = (house) => waterFailures < 2 && typeof actions.swimAshore === 'function' && pearlWaterBank(bot, house);

  async function regainDryBank(ctx, house, bank, from) {
    recoveringWater = true;
    const acceptBank = (p) => flatDistance(p, house) <= SCOUT_RADIUS && scoutGroundAt(p);
    if (await actions.swimAshore(bot, ctx, { bank, acceptBank, maxTicks: 45 })
      && !bot.entity.isInWater && bot.entity.onGround === true && bot.entity.position.floored().equals(bank)) {
      waterFailures = 0;
      ctx.record('pearl_swim_dry_bank', { from, to: bank });
      return { ok: true, waited: true };
    }
    waterFailures += 1;
    if (waterFailures >= 2) memory.waterReturnBlocked = pointKey(from);
    return wait(ctx, 'pearl_swim_dry_bank_blocked');
  }

  function startNight() {
    if (memory.sawNight) return;
    memory.sawNight = true;
    memory.nights += 1;
    nextNearScout = Date.now() + NEAR_SCOUT_REPEAT_MS;
  }

  return {
    name: 'hunt_pearls',
    memory,
    ownsRouteRecovery: () => memory.sawNight || memory.ascending || recoveringTether || homeward
      || recoveringWater || Boolean(pendingWaterBank(home())),
    // Endermen appear and vanish: a quiet stretch is normal, not a stall.
    noProgressLimit: 40,
    isDone: (state) => !memory.ascending && !pearlCaveRecoveryNeeded(bot, home(), state.position)
      && (pearls(state) >= count || ((memory.sawNight || recoveringTether || homeward || recoveringWater) && state.isDay !== false
        && !tetheredOutside(home(), bot.entity.position.floored()) && !wantsHome(state, home())
        && !pendingWaterBank(home()))),
    progress: (state) => pearls(state) * 10 + memory.hunted,
    async run(ctx) {
      const state = ctx.perceive();
      const house = home();
      const feet = bot.entity.position.floored();
      const bank = pendingWaterBank(house);
      if (bank) return regainDryBank(ctx, house, bank, feet);
      if (!bot.entity.isInWater) waterFailures = 0;
      if (memory.ascending && (!house || flatDistance(feet, house) > SCOUT_RADIUS
        || (feet.y >= house.y - 2 && bot.entity.onGround && outdoors(feet) && !state.inWater && !bot.entity.isInLava))) {
        memory.ascending = false;
        caveVisited.clear();
      }
      if (house && (memory.ascending || pearlCaveRecoveryNeeded(bot, house, state.position))) {
        memory.ascending = true;
        return regainSurface(ctx, state, house);
      }
      if (!state.inWater && !homeward && tetheredOutside(house, feet)) {
        memory.centre = house;
        sectorRoute = undefined;
        if (state.isDay === false) startNight();
        return recoverScoutTether(ctx, feet, house);
      }
      if (state.isDay === false && tetherFailures >= 2 && pearlTetherRecoveryNeeded(house, feet)) {
        return wait(ctx, 'pearl_scout_tether_blocked');
      }
      if (wantsHome(state, house)) return returnInDaylight(ctx, feet, house);
      if (state.isDay !== false) {
        // Set during the day: wait for dusk at home. Where the night's hunt
        // ended was once a flooded cave thirty blocks down, and the bot
        // waited the day out there, coming up for air every few seconds.
        if (house && (state.inWater || state.position.distanceTo(house) > HOME_RANGE)) {
          ctx.record('pearl_wait', { where: 'home' });
          const back = await actions.goNear(bot, ctx, house, 4, { timeoutMs: 120000 });
          if (!back.ok) return actions.unstick(bot, ctx);
          return back;
        }
        await sleep(5000, ctx.signal);
        return { ok: true, waited: true };
      }
      homeward = false;
      homeRoute = [];
      homeFailures = 0;
      startNight();
      // Let survival eat and heal before starting a new fight. An already
      // angry Enderman in reach is still handled by defense.
      if (!readyToHunt(state)) return wait(ctx, 'pearl_wait_for_combat_readiness');
      const lured = bot.entities?.[memory.lured?.id];
      if (lured && angry(lured) && Date.now() < memory.lured.until && lured.position.distanceTo(bot.entity.position) <= STARE_FAR) {
        return wait(ctx, 'pearl_wait_for_lured_enderman');
      }
      memory.lured = null;
      // One in sight but far: stare at its head and let it come. Chased,
      // it teleported off: fourteen nights of chasing brought one pearl.
      // Angry, it comes to the bot, where defend fights it and keeps the pearl.
      const targets = endermen().filter((e) => e.position.distanceTo(state.position) <= Math.min(radius, STARE_FAR)
        && visible(e) && targetOutdoors(e.position.floored()));
      const camp = !state.inWater && bot.entity.onGround !== false && fightFooting(bot.entity.position.floored());
      const stared = camp ? await stare(ctx, targets) : null;
      if (stared) {
        if (stared.progress) {
          nearScout = null;
          nextNearScout = Date.now() + NEAR_SCOUT_REPEAT_MS;
        }
        return stared;
      }
      const close = camp ? targets.filter((e) => e.position.distanceTo(state.position) <= STARE_NEAR) : [];
      if (close.length) {
        const restore = applyWalkOnlyMovements(bot);
        try {
          const hunted = await skills.huntOne(bot, ctx, { mobs: MOBS, dropMatch: isPearl, blacklist,
            radius: Math.min(radius, STARE_NEAR), accept: (e) => close.includes(e) });
          if (hunted.ok) { memory.hunted += 1; return hunted; }
          if (hunted.reason !== 'no_mob_in_range') return hunted;
        } finally { restore(); }
      }
      const focus = targets.filter((e) => !angry(e) && !blacklist.has(`mob:${e.id}`) && !blacklist.has(`approach:${e.id}`)
        && flatDistance(e.position, memory.centre || state.position) <= SCOUT_RADIUS)
        .sort((a, b) => a.position.distanceTo(state.position) - b.position.distanceTo(state.position))[0];
      return scout(ctx, state, focus);
    },
  };
}

module.exports = { createHuntPearlsGoal, pearlCaveRecoveryNeeded, pearlTetherRecoveryNeeded, pearlHomeReturnNeeded, pearlWaterBank, scoutSectorOf };
