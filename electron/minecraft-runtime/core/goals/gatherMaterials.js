'use strict';
// Goal: a list of materials stored in one chest at home, gathered from an
// empty inventory if need be (everything a machine needs, before building it).
//
// Every run() looks at the world and does exactly one thing:
//   1. chest contents unknown        -> open it and look
//   2. everything still owed carried -> store it in the chest
//   3. planner has a step            -> gather / craft / smelt / fill a bucket / place a station
//      (ore with nothing in sight      -> one more block of branch mine, see mining.js)
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
const { createBlacklist } = require('../blacklist');
const mining = require('../mining');

const DOWN = [new Vec3(0, -1, 0)];
// Main inventory slots (36): store what is owed before the bag overflows.
const FREE_SLOTS_TO_STORE = 3;
const NEAR_CHEST = 6;
const MINE_FROM_HOME = 8;
const SPARE_PICKAXES = 3;

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

  async function store(ctx, wants) {
    ctx.record('store', { items: wants.map((w) => `${w.key}x${w.count}`) });
    const result = await skills.storeInChest(bot, ctx, { position: chest,
      wants: wants.map((w) => ({ match: kb[w.key].match, count: w.count })) });
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
    return mining.mineStep(bot, ctx, memory, { blocks: step.blocks, dropMatch, y: step.mineY, blacklist, start, actions });
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
    // Everything but ore deep down is found on the surface: climb out of the mine first.
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
      case 'gather': {
        const dimension = String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '');
        if (step.dimension && step.dimension !== dimension) return { ok: false, reason: `needs_dimension:${step.dimension}` };
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

  async function runOnce(ctx) {
    if (nameAt(chest) === null) {
      ctx.record('return_home', {});
      return actions.goNear(bot, ctx, new Vec3(chest.x, chest.y, chest.z), 3, { timeoutMs: 90000 });
    }
    if (nameAt(chest) !== 'chest') return { ok: false, reason: 'chest_missing' };
    if (memory.chest === null) {
      ctx.record('check_chest', {});
      return store(ctx, []);
    }
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
    const step = planNext({ requirements: reqs, inventory, stations: placedStations(), kb });
    const freeSlots = typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : Infinity;
    // Passing by the chest (crafting and smelting happen next to it) with a
    // whole item of the list in the bag: store it now, a death would lose it.
    const whole = carried.some((w) => w.count >= debts.find((r) => r.key === w.key).count);
    const nearChest = bot.entity.position.distanceTo(new Vec3(chest.x + 0.5, chest.y, chest.z + 0.5)) <= NEAR_CHEST;
    if (carried.length && (!step || freeSlots <= FREE_SLOTS_TO_STORE || (whole && nearChest))) {
      return (await climbOut(ctx)) || store(ctx, carried);
    }
    if (step) return runStep(ctx, step);
    // Nothing left to plan and nothing to store, yet the chest still lacks something.
    return { ok: false, reason: 'nothing_to_do' };
  }

  return {
    name: 'gather_materials',
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
        memory.steps += 1;
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
