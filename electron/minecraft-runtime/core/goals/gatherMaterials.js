'use strict';
// Goal: a list of materials stored in one chest at home, gathered from an
// empty inventory if need be (everything a machine needs, before building it).
//
// Every run() looks at the world and does exactly one thing:
//   1. chest contents unknown        -> open it and look
//   2. everything still owed carried -> store it in the chest
//   3. planner has a step            -> gather / craft / smelt / fill a bucket / place a station
//      (ore with nothing in sight      -> one more block of branch mine, see mining.js)
//      (obsidian                       -> one step of casting it from buckets, see obsidian.js)
//      (ore of the Nether              -> one step of a Nether trip, see netherQuartz.js:
//                                         the portal's obsidian and flint and steel come first)
// By default only the chest counts as done: carried items die with the bot,
// stored ones do not. Outfit explicitly opts into carried/worn delivery.
// Items in the chest are never taken back out for crafting, so the
// planner only ever sees the inventory, asked for what the chest still lacks.
//
// The only memory kept across runs is the chest contents last seen there,
// what was left in the furnace, where the mine's front is, and short-lived blacklists.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { planNext } = require('../planner');
const { KNOWLEDGE, countKey, familyOf } = require('../knowledge');
const { materialsFor } = require('../materials');
const { createBlacklist, posKey } = require('../blacklist');
const { sleep } = require('../confirm');
const mining = require('../mining');
const { skyOpen, standable } = require('../caveRetreat');
const { createStoneQuarry } = require('./stoneQuarry');
const obsidian = require('../obsidian');
const nether = require('../nether');
const { quartzToolReserve } = require('../quartzTools');
const { createNetherQuartzGoal, QUARTZ_MIN_FOOD, quartzFoodMatch, quartzFoodCount, quartzProtection } = require('./netherQuartz');

const DOWN = [new Vec3(0, -1, 0)];
// Out on the surface only after dark: string waits for night, not for a cave.
const NIGHT_MOBS = new Set(['spider', 'enderman']);
// Armour and off-hand slots of the player window.
const WORN_SLOTS = [5, 6, 7, 8, 45];
// Main inventory slots (36): store what is owed before the bag overflows.
const FREE_SLOTS_TO_STORE = 3;
const NEAR_CHEST = 6;
const MINE_FROM_HOME = 8;
const MINE_RESTART_RINGS = [18, 26, 34, 42];
// Further below the chest than this, home is reached by going up first.
const HOME_BELOW = 8;
const SUPPLY_STONE_RADIUS = 24;
const SUPPLY_STONE_FALLBACK = new Set(['no_target_in_range', 'drops_not_collected', 'NoPath', 'Timeout', 'path_timeout',
  'not_arrived', 'no_progress', 'leg_blocked', 'no_dry_stand']);
const SUPPLY_CANOPY = /_(leaves|log|wood)$/;
const SUPPLY_HAZARD = /^(water|lava|bubble_column|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|powder_snow|sweet_berry_bush)$/;
const SUPPLY_STANCE_OFFSETS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
  [2, 0], [-2, 0], [0, 2], [0, -2]];
// Stone pickaxes taken down a mine: they wear out on the rock instead of the
// iron one (a deep staircase digs a few hundred blocks; one lasts 131).
const SPARE_PICKS = 5;
// A mine this deep gets a supply depot at the foot of its staircase: a chest
// stocked with stone pickaxes and a crafting table, so a worn-out pickaxe is
// replaced down there (from the chest, or crafted from the tunnel's
// cobblestone and carried sticks) instead of with a trip home.
const DEPOT_BELOW = 0;
const DEPOT_PICKS = 8;
const DEPOT_STICKS = 24;
const KEEP_PICKS = 3;
const DEPOT_CRAFT = 6;
const SIDES = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const SPARE_PICKAXES = 3;
// Casting obsidian floods the ground around the pit for a moment: not by the chest.
const MOLD_FROM_HOME = 5;
// A portal frame: ten obsidian, the four corners anything solid.
const FRAME_OBSIDIAN = 10;
const FRAME_CORNERS = 4;

function createGatherMaterialsGoal({ bot, chest, requirements = null, blueprint = null, stations = {},
  skills = defaultSkills, actions = defaultActions, kb = KNOWLEDGE, maxExploreStreak = 20, carry = () => false, reserved = {},
  countWorn = false, surfaceOnly = false } = {}) {
  if (!chest || ![chest.x, chest.y, chest.z].every(Number.isInteger)) throw new TypeError('chest must have integer x, y, z');
  if (!requirements === !blueprint) throw new TypeError('give either requirements or a blueprint');
  for (const r of requirements || []) {
    if (!kb[r.key] || !Number.isSafeInteger(r.count) || r.count < 1) throw new TypeError(`bad requirement ${JSON.stringify(r)}`);
  }
  const memory = {
    chest: null,
    furnace: { item: null, input: 0, output: 0 },
    explore: {},
    exploreStreak: 0,
    pathFailures: 0,
    shortfall: {},
    mine: null,
    mineRestart: null,
    cast: null,
    trip: null,
    steps: 0,
  };
  const blacklist = createBlacklist({ ttlMs: 120000 });
  const blockAt = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));
  const nameAt = (p) => blockAt(p)?.name || null;
  const homeStations = [chest, ...Object.values(stations)].filter(Boolean);
  const withinStoneRange = (p) => Math.hypot(p.x - chest.x, p.z - chest.z) <= SUPPLY_STONE_RADIUS;
  const quarry = surfaceOnly ? createStoneQuarry({ bot, actions, blacklist,
    avoid: (p) => !withinStoneRange(p) || bot.companionHomeSite?.(p)
      || homeStations.some((s) => Math.hypot(p.x - s.x, p.z - s.z) < 4) }) : null;
  let quarryNeeded = false;
  let stoneRouteOwnsRecovery = false;

  const wanted = () => requirements || materialsFor(blueprint.blocks, nameAt, kb);
  const stored = (key) => countKey(key, memory.chest || {}, kb);
  // `carry(key)`: kept in the bag, never stored (a sword is no use in the
  // chest while the bot fights its way through hours of mining); what the
  // bag holds of it counts as delivered.
  const bagged = (key, inventory) => (inventory && carry(key) ? countKey(key, unreserved(inventory), kb) : 0);
  const equippedInventory = () => {
    const slots = bot.inventory?.slots || [];
    const on = {};
    for (const i of WORN_SLOTS) if (slots[i]?.name) on[slots[i].name] = (on[slots[i].name] || 0) + slots[i].count;
    return on;
  };
  // Only outfit opts in: newly made armour may already have been equipped
  // by wear_armor. Ordinary collection still requires delivery to the chest.
  // Perception includes equipment, so carry already credits it once. The
  // caller's reserved equipment was counted before asking for this shortfall.
  const worn = (key) => (countWorn && !carry(key) ? countKey(key, unreserved(equippedInventory()), kb) : 0);
  // What the chest still lacks, in the caller's order.
  const owed = (inventory) => wanted().map((r) => ({ key: r.key, count: r.count - stored(r.key) - bagged(r.key, inventory) - worn(r.key) }))
    .filter((r) => r.count > 0);

  // `reserved`: { item: count } already in the bag and counted by the caller,
  // who asks only for the rest. Left out of what the bag offers: stored as
  // delivered, it was taken back out and the caller was short again, 150000
  // times over for seven cobblestones.
  function unreserved(inventory) {
    const out = { ...inventory };
    for (const [name, n] of Object.entries(reserved)) if (out[name]) out[name] = Math.max(0, out[name] - n);
    return out;
  }

  function spareInventory(inventory) {
    const out = { ...inventory };
    const equipped = equippedInventory();
    // Reserved and worn overlap: remove their union, not both amounts.
    // What is on the body is unavailable for depositing or crafting even
    // when it does not count toward this goal's completion.
    for (const name of new Set([...Object.keys(reserved), ...Object.keys(equipped)])) {
      if (out[name]) out[name] = Math.max(0, out[name] - Math.max(reserved[name] || 0, equipped[name] || 0));
    }
    return out;
  }

  function plannerInventory(state) {
    const inventory = spareInventory(state.inventory);
    // Items left in the furnace still count; otherwise they would be gathered twice.
    if (memory.furnace.item === 'raw_iron') {
      inventory.raw_iron = (inventory.raw_iron || 0) + memory.furnace.input;
      inventory.iron_ingot = (inventory.iron_ingot || 0) + memory.furnace.output;
    }
    return inventory;
  }

  const placedStations = () => ({
    crafting_table: Boolean(stations.crafting_table) && nameAt(stations.crafting_table) === 'crafting_table',
    furnace: Boolean(stations.furnace) && nameAt(stations.furnace) === 'furnace',
  });

  function surfaceSupplyRoute(key) {
    const floor = chest.y - HOME_BELOW;
    const minimumY = Math.max(floor, Math.floor(bot.entity.position.y) - 4);
    const stone = key === 'cobblestone';
    const cache = new Map();
    const exposedStand = (feet) => {
      if (feet.y < floor || (stone && !withinStoneRange(feet))) return false;
      const id = posKey(feet);
      if (cache.has(id)) return cache.get(id);
      const dryStand = standable(blockAt, feet) && !SUPPLY_CANOPY.test(nameAt(feet.offset(0, -1, 0)));
      const openAbove = (p) => {
        const block = blockAt(p);
        return block && !SUPPLY_HAZARD.test(block.name) && block.getProperties?.()?.waterlogged !== true
          && (block.boundingBox === 'empty' || SUPPLY_CANOPY.test(block.name));
      };
      let safe = dryStand;
      for (let y = feet.y + 2; safe && y <= Math.max(chest.y, feet.y) + 12; y += 1) {
        safe = openAbove(new Vec3(feet.x, y, feet.z));
      }
      cache.set(id, safe);
      return safe;
    };
    const walk = async (run, accept = () => true) => {
      const restore = nether.applyWalkOnlyMovements(bot);
      const movements = bot.pathfinder?.movements;
      const neighbors = movements?.getNeighbors;
      const owned = movements && Object.hasOwn(movements, 'getNeighbors');
      if (neighbors) movements.getNeighbors = function (node, ...args) {
        return neighbors.call(this, node, ...args).filter((move) => {
          const feet = new Vec3(move.x, move.y, move.z);
          return feet.y >= floor && withinStoneRange(feet) && accept(feet) && [-1, 0, 1].every((dy) => {
            const block = blockAt(feet.offset(0, dy, 0));
            return block && !SUPPLY_HAZARD.test(block.name) && block.getProperties?.()?.waterlogged !== true;
          });
        });
      };
      try { return await run(); }
      finally {
        if (neighbors && owned) movements.getNeighbors = neighbors;
        else if (neighbors) delete movements.getNeighbors;
        restore();
      }
    };
    const guarded = stone || key === 'log';
    const acceptStand = (feet, target) => feet.y >= floor && !feet.offset(0, -1, 0).equals(target) && exposedStand(feet);
    const targetFilter = (target) => {
      if (target.y < minimumY || (stone && !withinStoneRange(target)) || !mining.exposed(bot, target)) return false;
      if (!guarded) return true;
      const block = blockAt(target);
      if (!block || bot.companionProtectBlock?.(block) || bot.companionHomeSite?.(target)) return false;
      const sight = bot.world?.raycast && new goals.GoalLookAtBlock(target, bot.world, { reach: 4 });
      const heights = key === 'log' ? [0, -1, -2, -3, 1] : [0, 1, -1];
      return SUPPLY_STANCE_OFFSETS.some(([x, z]) => heights.some((y) => {
        const feet = target.offset(x, y, z);
        return acceptStand(feet, target) && (!sight || sight.isEnd(feet));
      }));
    };
    return { floor, isStand: exposedStand, walk, gather: { targetFilter, ...(guarded ? { acceptStand } : {}) } };
  }

  const quarryRouteOutcome = (result) => SUPPLY_STONE_FALLBACK.has(result?.reason)
    ? { ok: false, reason: 'surface_stone_unreachable' } : result;
  const leaveSurfaceQuarry = async (ctx) => quarry?.inside()
    ? quarryRouteOutcome(await quarry.leave(ctx, surfaceSupplyRoute('cobblestone'))) : null;

  async function gatherSurfaceStone(ctx, step, dropMatch) {
    const surface = surfaceSupplyRoute(step.key);
    if (!withinStoneRange(bot.entity.position)) return { ok: false, reason: 'surface_stone_outside_home_range' };
    const state = ctx.perceive();
    if (state.isDay === false) {
      const exited = await leaveSurfaceQuarry(ctx);
      if (exited) return exited;
      await sleep(1000, ctx.signal);
      return { ok: true, waited: true, reason: 'surface_stone_wait_for_daylight' };
    }
    if (!quarryNeeded) {
      const result = await surface.walk(() => skills.gatherOne(bot, ctx, { blocks: step.blocks, dropMatch,
        blacklist, exclude: quarry.protectsFloor, radius: SUPPLY_STONE_RADIUS, ...surface.gather }));
      if (!SUPPLY_STONE_FALLBACK.has(result.reason)) return result;
      quarryNeeded = true;
      ctx.record('surface_stone_quarry', { reason: result.reason, at: posKey(bot.entity.position.floored()) });
    }
    if (typeof actions.goTo !== 'function' || typeof actions.digBlock !== 'function' || typeof actions.collectDrops !== 'function') {
      return { ok: false, reason: 'surface_quarry_actions_unavailable' };
    }
    const result = await quarry.run(ctx, surface, step.blocks, dropMatch);
    if (result.reason === 'quarry_no_site') quarryNeeded = false;
    return quarryRouteOutcome(result);
  }

  async function explore(ctx, why) {
    memory.exploreStreak += 1;
    if (memory.exploreStreak > maxExploreStreak) return { ok: false, reason: `exhausted:${why}` };
    ctx.record('explore_for', { why, streak: memory.exploreStreak });
    return skills.explore(bot, ctx, memory.explore);
  }

  // `loot`: also put away ore picked up on the way (diamonds, coal, ...).
  async function store(ctx, wants, { loot = false } = {}) {
    const extra = loot ? [...new Set(bot.inventory.items().map((i) => i.name).filter(mining.isLoot))] : [];
    ctx.record('store', { items: wants.map((w) => `${w.key}x${w.count}`), loot: extra });
    const result = await skills.storeInChest(bot, ctx, { position: chest,
      wants: [...wants.map((w) => ({ match: kb[w.key].match, count: w.count })),
        ...extra.map((name) => ({ match: (n) => n === name, count: Infinity }))] });
    if (result.contents) memory.chest = result.contents;
    return result;
  }

  const horizontalDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

  async function relocateMine(ctx) {
    const restart = memory.mineRestart;
    const state = ctx.perceive();
    if ((actions.underground || defaultActions.underground)(bot)) {
      // The permanent critical-health retreat owns the route out. A normal
      // mine restart may surface, but must not open another shaft down here.
      if (state.health <= 6) return { ok: false, reason: 'mine_restart_waiting_for_retreat' };
      const out = await actions.surface?.(bot, ctx);
      if (out?.ok) return { ...out, progress: false };
      // The height-based surface helper can stop below an overhang. A
      // connected walk to a verified open site can still get out from here.
    }
    const awayFromOld = (p) => restart.avoid.every((old) => horizontalDistance(p, old) >= MINE_FROM_HOME);
    const safe = (p) => horizontalDistance(p, chest) >= MINE_FROM_HOME && awayFromOld(p)
      && standable((at) => bot.blockAt(at), p) && skyOpen(bot, p);
    const site = () => {
      // Rotate sides as well as widening the search. The furthest candidate
      // stays inside a bounded ring around the established home.
      const direction = ((memory.mineDir ?? 0) + restart.attempt) % SIDES.length;
      const reach = MINE_RESTART_RINGS[Math.min(MINE_RESTART_RINGS.length - 1,
        restart.barren - 1 + Math.floor(restart.attempt / SIDES.length))];
      const [dx, dz] = SIDES[direction];
      return new Vec3(chest.x + dx * reach, chest.y, chest.z + dz * reach);
    };
    let base = site();
    for (let n = 0; n < SIDES.length && !awayFromOld(base); n += 1) {
      restart.attempt += 1;
      base = site();
    }
    if (!awayFromOld(base)) return { ok: false, reason: 'mine_restart_no_fresh_sector' };
    let target = base;
    for (const dy of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5]) {
      const candidate = base.offset(0, dy, 0);
      if (safe(candidate)) { target = candidate; break; }
    }
    ctx.record('mine_relocate', { from: posKey(bot.entity.position.floored()), target: posKey(target), attempt: restart.attempt + 1 });
    const restore = nether.applyWalkOnlyMovements(bot);
    let moved;
    try { moved = await actions.goNear(bot, ctx, target, 1, { timeoutMs: 30000 }); }
    finally { restore(); }
    const landed = bot.entity.position.floored();
    if (moved.ok && bot.entity.onGround && horizontalDistance(landed, target) <= 2.5 && safe(landed)) {
      restart.arrived = landed;
      return { ok: true, progress: false };
    }
    restart.attempt += 1;
    return { ok: false, reason: moved.ok ? 'mine_restart_site_unconfirmed' : moved.reason };
  }

  // A staircase starts at least this far from the chest, so home is never undermined.
  async function mine(ctx, step, dropMatch) {
    let start = null;
    if (!memory.mine) {
      const at = bot.entity.position.floored();
      if (memory.mineRestart) {
        if (!memory.mineRestart.arrived?.equals(at) || !bot.entity.onGround
          || !standable((p) => bot.blockAt(p), at) || !skyOpen(bot, at)) return relocateMine(ctx);
        memory.mineRestart = null;
      } else if (horizontalDistance(at, chest) < MINE_FROM_HOME) {
        const [sx, sz] = SIDES[(memory.mineDir ?? 0) % 4];
        const reach = MINE_FROM_HOME + 2;
        const away = new Vec3(chest.x + sx * reach, chest.y, chest.z + sz * reach);
        const moved = await actions.goNear(bot, ctx, away, 1, { timeoutMs: 30000 });
        if (!moved.ok) return moved;
      }
      start = bot.entity.position.floored();
    }
    // An unlit tunnel fills with monsters: carry torches while there is coal for them.
    const have = (n) => countKey(n, ctx.perceive().inventory, kb);
    if (have('torch') === 0 && have('coal') > 0 && have('stick') > 0 && !blacklist.has('torch')) {
      const made = await skills.craft(bot, ctx, { item: 'torch', times: Math.min(2, have('coal'), have('stick')) });
      if (!made.ok) blacklist.add('torch', made.reason, 60000);
    }
    const m = memory.mine;
    if (m?.junction && !m.depot && m.y === step.mineY && step.mineY <= DEPOT_BELOW) return buildDepot(ctx);
    const result = await mining.mineStep(bot, ctx, memory, { blocks: step.blocks, dropMatch, y: step.mineY, blacklist, start, actions, skills });
    if (!memory.mine && (m || result.reason === 'mine_exhausted')) {
      const old = m || { entrance: start, front: bot.entity.position.floored() };
      memory.barrenMines = (memory.barrenMines || 0) + 1;
      memory.mineRestart = { barren: memory.barrenMines, attempt: 0, avoid: [old.entrance, old.front].filter(Boolean) };
    }
    return result;
  }

  const carrying = (name) => bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);

  // Chest on one side of the staircase's foot, crafting table on the other.
  // A depot that will not come together after a few tries is done without.
  async function buildDepot(ctx) {
    const m = memory.mine;
    const result = await buildDepotOnce(ctx, m);
    if (!result.ok && (m.depotTries = (m.depotTries || 0) + 1) >= 3) {
      m.depot = { failed: result.reason };
      ctx.record('depot_failed', { reason: result.reason });
    }
    return result;
  }

  async function buildDepotOnce(ctx, m) {
    const J = m.junction;
    const [dx, dz] = SIDES[(J.dir + 1) % 4];
    const spots = { chest: { x: J.x + dx, y: J.y, z: J.z + dz }, crafting_table: { x: J.x - dx, y: J.y, z: J.z - dz } };
    // A part placed on an earlier try is not needed in the bag any more.
    if (Object.entries(spots).some(([item, spot]) => nameAt(spot) !== item && !carrying(item))) {
      m.depot = { failed: 'no_kit' };
      return { ok: true, depot: 'skipped' };
    }
    const there = await mining.walkToCell(bot, ctx, m, J, actions);
    if (there) return there;
    for (const [item, spot] of Object.entries(spots)) {
      if (nameAt(spot) === item) continue;
      const wet = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]
        .some(([x, y, z]) => mining.LIQUID.test(nameAt({ x: spot.x + x, y: spot.y + y, z: spot.z + z }) || ''));
      if (wet) { m.depot = { failed: 'liquid' }; return { ok: true, depot: 'skipped' }; }
      // A chest only opens with room above its lid: that cell is dug out too.
      const cells = item === 'chest' ? [{ ...spot, y: spot.y + 1 }, spot] : [spot];
      for (const cell of cells) {
        const block = blockAt(cell);
        if (!block || block.boundingBox === 'empty') continue;
        const dug = await actions.digBlock(bot, ctx, block, { tool: mining.pickFor(bot, block) });
        if (!dug.ok) return dug;
        m.open = { ...m.open, [posKey(cell)]: true };
      }
      const placed = await skills.placeAt(bot, ctx, spot, (n) => n === item, { faces: DOWN });
      if (!placed.ok) return placed;
    }
    const spare = carrying('stone_pickaxe') - KEEP_PICKS;
    const stocked = await skills.storeInChest(bot, ctx, { position: spots.chest,
      wants: spare > 0 ? [{ match: (n) => n === 'stone_pickaxe', count: spare }] : [] });
    if (!stocked.ok) return stocked;
    m.depot = { chest: spots.chest, table: spots.crafting_table };
    ctx.record('depot_built', { chest: posKey(spots.chest), picks: stocked.stored?.stone_pickaxe || 0 });
    return { ok: true, depot: 'built' };
  }

  // Out of stone pickaxes down the mine: take one from the depot, or craft
  // some there. Null when the depot cannot help (none, or nothing left to make them from).
  async function restock(ctx) {
    const m = memory.mine;
    const depot = m?.depot;
    if (!depot?.chest || depot.dry) return null;
    const there = await mining.walkToCell(bot, ctx, m, m.junction, actions);
    if (there) { ctx.record('depot_walk', { ok: there.ok }); return there; }
    // Take what the chest holds, and make more on the spot: every walk back
    // here from a far front should last a good while.
    const taken = await skills.takeItems(bot, ctx, { position: depot.chest, itemMatch: (n) => n === 'stone_pickaxe' });
    ctx.record('depot_take', { ok: taken.ok, reason: taken.reason, taken: taken.taken });
    const cobble = carrying('cobblestone') + carrying('cobbled_deepslate');
    const times = Math.min(DEPOT_CRAFT, Math.floor(carrying('stick') / 2), Math.floor(cobble / 3));
    if (times < 1) {
      if (taken.ok) return taken;
      depot.dry = true;
      return null;
    }
    const made = await skills.craft(bot, ctx, { item: 'stone_pickaxe', times, tablePosition: depot.table });
    ctx.record('depot_craft', { ok: made.ok, reason: made.reason, times });
    if (!made.ok) depot.dry = true;
    return !made.ok && taken.ok ? taken : made;
  }

  // What to carry down a mine: spare stone pickaxes; for a deep one, sticks
  // to make more at the depot, and the depot itself until it is built.
  function supplies(step) {
    const m = memory.mine;
    const deepMine = step.mineY <= DEPOT_BELOW;
    const needsDepot = deepMine && !(m?.depot && m.y <= step.mineY);
    return [
      { key: 'stone_pickaxe', count: needsDepot ? DEPOT_PICKS : SPARE_PICKS },
      ...(deepMine ? [{ key: 'stick', count: DEPOT_STICKS }] : []),
      ...(needsDepot ? [{ key: 'chest', count: 1 }, { key: 'crafting_table', count: 1 }] : []),
    ];
  }

  // Everything but mining happens up top: out of the mine along its own tunnel, a leg at a time.
  async function climbOut(ctx) {
    const leg = await mining.leaveMine(bot, ctx, memory, actions);
    if (leg) return leg;
    return surfaceFirst(ctx);
  }

  async function surfaceFirst(ctx) {
    if (typeof actions.surface !== 'function' || blacklist.has('surface')) return null;
    const result = await actions.surface(bot, ctx);
    if (result) ctx.record('surface', { ok: result.ok });
    if (result && !result.ok) blacklist.add('surface', result.reason, 60000);
    return result;
  }

  async function runStep(ctx, step) {
    ctx.record('plan_step', { kind: step.kind, key: step.key, for: step.for, item: step.item, count: step.count ?? step.times });
    // Night rest stays out of the way while a night mob is hunted (companion.js).
    bot.companionNightHunt = step.kind === 'hunt' && (step.mobs || []).some((m) => NIGHT_MOBS.has(m))
      ? { key: step.key, at: Date.now() } : null;
    // Ore that needs a mine is the only thing done down there; anything else
    // (a tree for sticks, a station, a craft) walks out along the tunnel first
    // rather than letting the pathfinder dig straight up to it.
    const surfaceStone = surfaceOnly && step.kind === 'gather' && step.key === 'cobblestone';
    if (!surfaceStone && (step.kind !== 'gather' || !Number.isFinite(step.mineY))) {
      const up = await climbOut(ctx);
      if (up) return up;
    }
    switch (step.kind) {
      case 'place_station': {
        const spot = stations[step.station];
        if (!spot) return { ok: false, reason: `no_spot:${step.station}` };
        return skills.placeAt(bot, ctx, spot, (n) => n === step.station, { faces: DOWN });
      }
      case 'craft': {
        const craft = (times) => skills.craft(bot, ctx, { item: step.item, times,
          tablePosition: step.table ? stations.crafting_table : null });
        // A stone pickaxe lasts about 60 blocks of tunnel, and the table is
        // at home: make spares while here if the bag has enough for them.
        let result = step.item === 'stone_pickaxe' && step.times < SPARE_PICKAXES ? await craft(SPARE_PICKAXES) : null;
        if (!result?.ok) result = await craft(step.times);
        // Short of something the plan thought was there: plan for it explicitly for a while.
        for (const m of result.missing || []) {
          const family = familyOf(m.name, kb);
          if (family) memory.shortfall[family] = { extra: m.short, until: Date.now() + 120000 };
        }
        return result;
      }
      case 'cast':
        return obsidian.castStep(bot, ctx, memory, { skills, actions, avoid: nearHome });
      case 'gather': {
        if (surfaceOnly && (Number.isFinite(step.mineY) || step.dimension === 'the_nether')) {
          return { ok: false, reason: 'surface_supply_requires_mine' };
        }
        if (step.dimension === 'the_nether' && step.key === 'quartz') return netherTrip(ctx, step.count);
        if (step.dimension && step.dimension !== nether.dimension(bot)) return { ok: false, reason: `needs_dimension:${step.dimension}` };
        const dropMatch = kb[step.key].match;
        if (surfaceStone) return gatherSurfaceStone(ctx, step, dropMatch);
        const deep = Number.isFinite(step.mineY);
        // Ore that needs a mine is mined from the tunnel once there is one.
        if (deep && memory.mine) return mine(ctx, step, dropMatch);
        // Elsewhere only ore in the open (surface, cave mouths): never a
        // pathfinder tunnel straight down to buried ore.
        const route = surfaceOnly ? surfaceSupplyRoute(step.key).gather
          : { exclude: deep ? (p) => !mining.exposed(bot, p) : undefined };
        const gatherOptions = { blocks: step.blocks, dropMatch, blacklist, ...route };
        let result = await skills.gatherOne(bot, ctx, gatherOptions);
        if (result.reason === 'no_target_in_range') {
          result = await skills.gatherOne(bot, ctx, { ...gatherOptions, radius: surfaceOnly ? 64 : 128 });
        }
        if (result.reason === 'no_target_in_range') return deep ? mine(ctx, step, dropMatch) : explore(ctx, step.key);
        // Gravel gives flint one time in ten: the gravel is the progress.
        if (step.rare && result.reason === 'drops_not_collected') return { ok: true, drop: 'missed' };
        return result;
      }
      case 'smelt': {
        if (!stations.furnace) return { ok: false, reason: 'no_spot:furnace' };
        const result = await skills.smelt(bot, ctx, { input: step.input, count: step.count,
          furnacePosition: stations.furnace, memory: memory.furnace });
        memory.furnace.item = step.input;
        return result;
      }
      case 'fill': {
        let result = await skills.fillBucket(bot, ctx, { liquid: step.liquid, blacklist });
        if (result.reason === 'no_target_in_range') result = await skills.fillBucket(bot, ctx, { liquid: step.liquid, blacklist, radius: 128 });
        if (result.reason === 'no_target_in_range') return explore(ctx, step.key);
        return result;
      }
      case 'hunt': {
        const supplyFood = step.quartzSupply && step.key === 'food';
        const result = await skills.huntOne(bot, ctx, { mobs: supplyFood ? step.mobs.filter((m) => m !== 'chicken') : step.mobs,
          dropMatch: supplyFood ? (n) => quartzFoodMatch(bot, n) : kb[step.key].match, blacklist, radius: 96 });
        if (result.reason === 'no_mob_in_range') {
          if (supplyFood) {
            ctx.record('needs_supplies', { missing: ['food'], food: quartzFoodCount(bot), requiredFood: QUARTZ_MIN_FOOD,
              dimension: 'overworld', source: 'no_mob_in_range', ...quartzProtection(bot) });
            if (typeof skills.pickBerries === 'function') {
              const berries = await skills.pickBerries(bot, ctx, { blacklist });
              if (berries.ok || berries.reason !== 'no_berries') return berries;
            }
          }
          const moved = await explore(ctx, step.key);
          return supplyFood && !moved.ok ? { ...moved, reason: 'needs_supplies', missing: ['food'], cause: moved.reason } : moved;
        }
        return result;
      }
      default:
        return { ok: false, reason: `unplannable:${step.key}:${step.reason}` };
    }
  }

  const nearHome = (p) => [chest, ...Object.values(stations)].some((s) => s && Math.hypot(p.x - s.x, p.z - s.z) < MOLD_FROM_HOME);

  // A Nether trip is one goal of its own (portal, quartz, back), run a step
  // at a time from here. `more`: quartz still to bring, on top of what is carried.
  function netherTrip(ctx, more) {
    const want = countKey('quartz', ctx.perceive().inventory, kb) + Math.max(1, more);
    if (!memory.trip || (!nether.inNether(bot) && memory.trip.target !== want)) {
      const old = memory.trip;
      old?.dispose?.();
      memory.trip = createNetherQuartzGoal({ bot, count: want, skills, actions });
      // The portals already found or built stay known.
      if (old) Object.assign(memory.trip.memory, old.memory, { explore: {} });
    }
    return memory.trip.run(ctx);
  }

  // A portal to use: one remembered (or out of sight, so not known gone), or one nearby.
  function portalKnown() {
    const p = memory.trip?.memory.overworldPortal;
    if (p && ['nether_portal', null].includes(nameAt(p))) return true;
    return Boolean(nether.findPortal(bot, 48));
  }

  // Before a first Nether trip: the frame's obsidian (less any already
  // placed), its corners, and flint and steel to light it.
  function portalKit(inventory) {
    // A sword for the Nether's monsters, on every trip (a death there loses it).
    const sword = [{ key: 'stone_sword', count: 1 }];
    // Recheck actual edible inventory on every departure, including after a
    // death. This is carried for survival, never a request to store food.
    // Include food the planner recognizes but cannot safely eat in the
    // target count, so e.g. raw chicken cannot discharge the safe reserve.
    const shortFood = Math.max(0, QUARTZ_MIN_FOOD - quartzFoodCount(bot));
    const food = shortFood ? [{ key: 'food', count: countKey('food', inventory, kb) + shortFood }] : [];
    // Building the protected bridge may exhaust the first trip's cheap
    // tools. A worn stone still counts as an item to the planner, so add
    // the observed shortfall to that actual count instead of asking for
    // three items that might already all be nearly broken.
    const reserve = quartzToolReserve(bot);
    const tools = memory.trip?.memory.ledgeSeen && reserve.short
      ? [{ key: 'stone_pickaxe', count: countKey('stone_pickaxe', inventory, kb) + reserve.short }] : [];
    if (portalKnown()) return [...sword, ...food, ...tools];
    const site = memory.trip?.memory.site;
    const cells = site ? nether.portalFrame(site.base, site.axis).cells : [];
    const placed = (corner) => cells.filter((c) => Boolean(c.corner) === corner
      && (corner ? blockAt(c.pos)?.boundingBox === 'block' : nameAt(c.pos) === 'obsidian')).length;
    const corners = FRAME_CORNERS - placed(true);
    return [
      { key: 'obsidian', count: FRAME_OBSIDIAN - placed(false) },
      // Any solid block makes a corner: cobblestone if there is enough, else dirt (no tool needed).
      { key: countKey('cobblestone', inventory, kb) >= corners ? 'cobblestone' : 'dirt', count: corners },
      { key: 'flint_and_steel', count: 1 },
      ...sword,
      ...food,
      ...tools,
    ].filter((r) => r.count > 0);
  }

  async function runOnce(ctx) {
    if (surfaceOnly && nether.dimension(bot) !== 'overworld') {
      return { ok: false, reason: 'surface_supply_wrong_dimension' };
    }
    if (surfaceOnly && bot.entity.position.y < chest.y - HOME_BELOW) {
      return { ok: false, reason: 'surface_supply_below_home' };
    }
    if (quarry?.inside() && (memory.chest === null || nameAt(chest) !== 'chest')) return leaveSurfaceQuarry(ctx);
    // In the Nether there is nothing to do but the trip: quartz, then home.
    if (nether.inNether(bot)) {
      const quartz = owed().find((r) => r.key === 'quartz')?.count || 0;
      return netherTrip(ctx, quartz - countKey('quartz', ctx.perceive().inventory, kb));
    }
    // Out of picks deep in a mine, a walk home dug by hand through deepslate
    // timed out every 20 seconds for two hours: out of the mine first.
    const homeward = nameAt(chest) === null || memory.chest === null;
    if (homeward && bot.entity.position.y < chest.y - HOME_BELOW) {
      const up = await climbOut(ctx);
      if (up) return up;
    }
    if (nameAt(chest) === null) {
      ctx.record('return_home', {});
      return actions.goNear(bot, ctx, new Vec3(chest.x, chest.y, chest.z), 3, { timeoutMs: 90000 });
    }
    // Blown up (a creeper by the house): make another and put it back where it stood.
    if (nameAt(chest) !== 'chest') {
      if (!['air', 'cave_air'].includes(nameAt(chest))) return { ok: false, reason: 'chest_missing' };
      const state = ctx.perceive();
      if (countKey('chest', state.inventory, kb) < 1) {
        const step = planNext({ requirements: [{ key: 'chest', count: 1 }], inventory: plannerInventory(state), stations: placedStations(), kb });
        return step ? runStep(ctx, step) : { ok: false, reason: 'chest_missing' };
      }
      ctx.record('chest_replaced', { position: posKey(chest) });
      const placed = await skills.placeAt(bot, ctx, chest, (n) => n === 'chest', { faces: DOWN });
      if (placed.ok) memory.chest = null;
      return placed;
    }
    if (memory.chest === null) {
      ctx.record('check_chest', {});
      return store(ctx, []);
    }
    // Lava in the mold, or the water still out: finish the cast before anything else.
    if (obsidian.pending(bot, memory.cast)) return obsidian.castStep(bot, ctx, memory, { skills, actions, avoid: nearHome });
    const state = ctx.perceive();
    const debts = owed(state.inventory);
    // Everything owed that is already carried, up to what the chest lacks.
    const spare = spareInventory(state.inventory);
    const carried = debts.filter((r) => !carry(r.key)).map((r) => ({ key: r.key, count: Math.min(r.count, countKey(r.key, spare, kb)) }))
      .filter((w) => w.count > 0);
    const inventory = plannerInventory(state);
    // A carry target has already credited its unreserved possessions in
    // owed(). Ask the planner for that same bag amount plus the remaining
    // debt, so one sword cannot satisfy both credits when two are requested.
    // Keep it visible as a tool for planning other materials.
    const reqs = debts.map((r) => ({ ...r, count: r.count + (carry(r.key) ? countKey(r.key, inventory, kb) : 0) }));
    for (const [key, entry] of Object.entries(memory.shortfall)) {
      if (entry.until < Date.now()) { delete memory.shortfall[key]; continue; }
      reqs.unshift({ key, count: countKey(key, inventory, kb) + entry.extra });
    }
    let step = planNext({ requirements: reqs, inventory, stations: placedStations(), kb });
    // About to go (back) down a mine from up top: take its supplies along.
    // Down there, running out of stone pickaxes sends the bot to the depot,
    // and only up for more when the depot cannot help.
    const belowSurface = memory.mine && bot.entity.position.y < memory.mine.surfaceY - 1;
    if (!surfaceOnly && step?.kind === 'gather' && Number.isFinite(step.mineY)) {
      if (!belowSurface && memory.mine?.depot) memory.mine.depot.dry = false;
      const outOfPicks = countKey('stone_pickaxe', inventory, kb) < 1;
      if (belowSurface && outOfPicks) {
        const restocked = await restock(ctx);
        if (restocked) return restocked;
      }
      if (!belowSurface || outOfPicks) {
        const kit = belowSurface ? [{ key: 'stone_pickaxe', count: SPARE_PICKS }] : supplies(step);
        step = planNext({ requirements: [...kit, ...reqs], inventory, stations: placedStations(), kb }) || step;
      }
    }
    if (!surfaceOnly && step?.kind === 'gather' && step.dimension === 'the_nether') {
      const kit = portalKit(inventory);
      if (kit.length) {
        const prepared = planNext({ requirements: [...kit, ...reqs], inventory, stations: placedStations(), kb });
        if (prepared) step = { ...prepared, quartzSupply: prepared.for === 'food' };
      }
    }
    const freeSlots = typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : Infinity;
    // Passing by the chest (crafting and smelting happen next to it) with a
    // whole item of the list in the bag: store it now, a death would lose it.
    const whole = carried.some((w) => w.count >= debts.find((r) => r.key === w.key).count);
    const nearChest = bot.entity.position.distanceTo(new Vec3(chest.x + 0.5, chest.y, chest.z + 0.5)) <= NEAR_CHEST;
    const shouldStore = carried.length && (!step || freeSlots <= FREE_SLOTS_TO_STORE || (whole && nearChest));
    const surfaceStone = surfaceOnly && step?.kind === 'gather' && step.key === 'cobblestone';
    stoneRouteOwnsRecovery = surfaceStone || quarry?.inside() === true;
    if (quarry?.inside() && (shouldStore || !surfaceStone)) return leaveSurfaceQuarry(ctx);
    if (!surfaceStone) quarryNeeded = false;
    if (shouldStore) {
      // The last trip home also empties the bag of ore found on the way.
      return (await climbOut(ctx)) || store(ctx, carried, { loot: !step });
    }
    if (step) return runStep(ctx, step);
    // Nothing left to plan and nothing to store, yet the chest still lacks something.
    return { ok: false, reason: 'nothing_to_do' };
  }

  return {
    name: 'gather_materials',
    // The trip owns temporary movement overrides, even when its parent stops
    // before the bot returns through the portal. Keep its remembered portals.
    dispose() { return memory.trip?.dispose?.(); },
    noProgressLimit: 40,
    maxRecoveries: 6,
    recover() {
      blacklist.clear();
      memory.pathFailures = 0;
      memory.recovery = !stoneRouteOwnsRecovery;
    },
    memory,
    owed,
    ownsRouteRecovery: () => stoneRouteOwnsRecovery || quarry?.inside() === true,
    leaveSurfaceQuarry,
    isDone: (state) => memory.chest !== null && !quarry?.inside() && owed(state?.inventory).length === 0,
    progress: () => memory.steps,
    async run(ctx) {
      // Home coordinates belong to the overworld. A failed Nether approach
      // must stay with the trip's remembered portal and protected routes;
      // generic unstick/home recovery can neither interpret that position
      // nor safely bypass the trip's movement constraints.
      if (nether.inNether(bot) && (memory.recovery || memory.pathFailures >= 2)) {
        memory.recovery = false;
        memory.pathFailures = 0;
        ctx.record('recovery', { at: bot.entity.position.floored(), dimension: 'the_nether', delegate: 'nether_trip' });
        return runOnce(ctx);
      }
      if (memory.pathFailures >= 2 && !stoneRouteOwnsRecovery) {
        memory.pathFailures = 0;
        ctx.record('unstick', { at: bot.entity.position.floored() });
        return actions.unstick(bot, ctx);
      }
      if (memory.recovery) {
        memory.recovery = false;
        ctx.record('recovery', { at: bot.entity.position.floored() });
        await actions.unstick(bot, ctx);
        // The chest is home: everything else is decided from there.
        if (bot.entity.position.distanceTo(new Vec3(chest.x, chest.y, chest.z)) > 16) {
          return actions.goNear(bot, ctx, new Vec3(chest.x, chest.y, chest.z), 3, { timeoutMs: 120000 });
        }
        return { ok: true };
      }
      const result = await runOnce(ctx);
      if (result.ok) {
        if (result.progress !== false) memory.steps += 1;
        memory.pathFailures = 0;
        if (!result.moved) memory.exploreStreak = 0;
      } else if (['NoPath', 'Timeout', 'path_timeout', 'not_arrived', 'no_progress', 'chase_stuck'].includes(result.reason)) {
        memory.pathFailures += 1;
      }
      return result;
    },
  };
}

module.exports = { createGatherMaterialsGoal };
