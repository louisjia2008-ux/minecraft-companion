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
// Only the chest counts as done: carried items die with the bot, stored ones
// do not. Items in the chest are never taken back out for crafting, so the
// planner only ever sees the inventory, asked for what the chest still lacks.
//
// The only memory kept across runs is the chest contents last seen there,
// what was left in the furnace, where the mine's front is, and short-lived blacklists.

const { Vec3 } = require('vec3');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { planNext } = require('../planner');
const { KNOWLEDGE, countKey, familyOf } = require('../knowledge');
const { materialsFor } = require('../materials');
const { createBlacklist, posKey } = require('../blacklist');
const mining = require('../mining');
const obsidian = require('../obsidian');
const nether = require('../nether');
const { createNetherQuartzGoal } = require('./netherQuartz');

const DOWN = [new Vec3(0, -1, 0)];
// Out on the surface only after dark: string waits for night, not for a cave.
const NIGHT_MOBS = new Set(['spider', 'enderman']);
// Main inventory slots (36): store what is owed before the bag overflows.
const FREE_SLOTS_TO_STORE = 3;
const NEAR_CHEST = 6;
const MINE_FROM_HOME = 8;
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
  skills = defaultSkills, actions = defaultActions, kb = KNOWLEDGE, maxExploreStreak = 20 } = {}) {
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
    cast: null,
    trip: null,
    steps: 0,
  };
  const blacklist = createBlacklist({ ttlMs: 120000 });
  const blockAt = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));
  const nameAt = (p) => blockAt(p)?.name || null;

  const wanted = () => requirements || materialsFor(blueprint.blocks, nameAt, kb);
  const stored = (key) => countKey(key, memory.chest || {}, kb);
  // What the chest still lacks, in the caller's order.
  const owed = () => wanted().map((r) => ({ key: r.key, count: r.count - stored(r.key) })).filter((r) => r.count > 0);

  function plannerInventory(state) {
    const inventory = { ...state.inventory };
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

  // A staircase starts at least this far from the chest, so home is never undermined.
  async function mine(ctx, step, dropMatch) {
    let start = null;
    if (!memory.mine) {
      const at = bot.entity.position.floored();
      if (Math.hypot(at.x - chest.x, at.z - chest.z) < MINE_FROM_HOME) {
        const away = new Vec3(chest.x + MINE_FROM_HOME + 2, chest.y, chest.z);
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
    return mining.mineStep(bot, ctx, memory, { blocks: step.blocks, dropMatch, y: step.mineY, blacklist, start, actions, skills });
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
    if (step.kind !== 'gather' || !Number.isFinite(step.mineY)) {
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
        if (step.dimension === 'the_nether' && step.key === 'quartz') return netherTrip(ctx, step.count);
        if (step.dimension && step.dimension !== nether.dimension(bot)) return { ok: false, reason: `needs_dimension:${step.dimension}` };
        const dropMatch = kb[step.key].match;
        const deep = Number.isFinite(step.mineY);
        // Ore that needs a mine is mined from the tunnel once there is one.
        if (deep && memory.mine) return mine(ctx, step, dropMatch);
        // Elsewhere only ore in the open (surface, cave mouths): never a
        // pathfinder tunnel straight down to buried ore.
        const exclude = deep ? (p) => !mining.exposed(bot, p) : undefined;
        let result = await skills.gatherOne(bot, ctx, { blocks: step.blocks, dropMatch, blacklist, exclude });
        if (result.reason === 'no_target_in_range') {
          result = await skills.gatherOne(bot, ctx, { blocks: step.blocks, dropMatch, blacklist, exclude, radius: 128 });
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
        const result = await skills.huntOne(bot, ctx, { mobs: step.mobs, dropMatch: kb[step.key].match, blacklist, radius: 96 });
        if (result.reason === 'no_mob_in_range') return explore(ctx, step.key);
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
    if (portalKnown()) return sword;
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
    ].filter((r) => r.count > 0);
  }

  async function runOnce(ctx) {
    // In the Nether there is nothing to do but the trip: quartz, then home.
    if (nether.inNether(bot)) {
      const quartz = owed().find((r) => r.key === 'quartz')?.count || 0;
      return netherTrip(ctx, quartz - countKey('quartz', ctx.perceive().inventory, kb));
    }
    if (nameAt(chest) === null) {
      ctx.record('return_home', {});
      return actions.goNear(bot, ctx, new Vec3(chest.x, chest.y, chest.z), 3, { timeoutMs: 90000 });
    }
    if (nameAt(chest) !== 'chest') return { ok: false, reason: 'chest_missing' };
    if (memory.chest === null) {
      ctx.record('check_chest', {});
      return store(ctx, []);
    }
    // Lava in the mold, or the water still out: finish the cast before anything else.
    if (obsidian.pending(bot, memory.cast)) return obsidian.castStep(bot, ctx, memory, { skills, actions, avoid: nearHome });
    const state = ctx.perceive();
    const debts = owed();
    // Everything owed that is already carried, up to what the chest lacks.
    const carried = debts.map((r) => ({ key: r.key, count: Math.min(r.count, countKey(r.key, state.inventory, kb)) }))
      .filter((w) => w.count > 0);
    const inventory = plannerInventory(state);
    const reqs = [...debts];
    for (const [key, entry] of Object.entries(memory.shortfall)) {
      if (entry.until < Date.now()) { delete memory.shortfall[key]; continue; }
      reqs.unshift({ key, count: countKey(key, inventory, kb) + entry.extra });
    }
    let step = planNext({ requirements: reqs, inventory, stations: placedStations(), kb });
    // About to go (back) down a mine from up top: take its supplies along.
    // Down there, running out of stone pickaxes sends the bot to the depot,
    // and only up for more when the depot cannot help.
    const belowSurface = memory.mine && bot.entity.position.y < memory.mine.surfaceY - 1;
    if (step?.kind === 'gather' && Number.isFinite(step.mineY)) {
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
    if (step?.kind === 'gather' && step.dimension === 'the_nether') {
      const kit = portalKit(inventory);
      if (kit.length) step = planNext({ requirements: [...kit, ...reqs], inventory, stations: placedStations(), kb }) || step;
    }
    const freeSlots = typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : Infinity;
    // Passing by the chest (crafting and smelting happen next to it) with a
    // whole item of the list in the bag: store it now, a death would lose it.
    const whole = carried.some((w) => w.count >= debts.find((r) => r.key === w.key).count);
    const nearChest = bot.entity.position.distanceTo(new Vec3(chest.x + 0.5, chest.y, chest.z + 0.5)) <= NEAR_CHEST;
    if (carried.length && (!step || freeSlots <= FREE_SLOTS_TO_STORE || (whole && nearChest))) {
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
      memory.recovery = true;
    },
    memory,
    owed,
    isDone: () => memory.chest !== null && owed().length === 0,
    progress: () => memory.steps,
    async run(ctx) {
      if (memory.pathFailures >= 2) {
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
