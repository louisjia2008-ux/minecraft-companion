'use strict';
// The full chain: from an empty inventory to gear (stone, then iron tools and
// a shield) and a finished, furnished starter house whose furniture has been
// used for real (crafted at the table, smelted in the furnace, stored in the
// chest, slept in or set spawn at the bed).
//
// Every run() looks at the world and does exactly one thing:
//   1. no site yet          -> choose one (or explore)
//   2. site work left       -> dig an obstacle / fill a hole
//   3. planner has a step   -> gather / craft / smelt / hunt / place a station
//   4. house incomplete     -> place the next block or piece of furniture
//   5. furniture unverified -> use it
// The only memory kept across runs is the chosen site, what was left in the
// furnace, short-lived blacklists, and which furniture has been used.

const { Vec3 } = require('vec3');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { planNext } = require('../planner');
const { KNOWLEDGE, countKey, familyOf } = require('../knowledge');
const { createStarterHouse } = require('../blueprints/starterHouse');
const { chooseSite, siteWork } = require('../site');
const { createBlacklist, posKey } = require('../blacklist');
const { sleep } = require('../confirm');

const DEFAULT_GEAR = ['stone_sword', 'stone_tier_pickaxe', 'iron_sword', 'iron_pickaxe', 'shield'];
// Stone tools come before the house; iron waits until there is a bed to sleep in.
const EARLY_GEAR = new Set(['stone_sword', 'stone_tier_pickaxe', 'pickaxe', 'wooden_pickaxe']);
const DOWN = [new Vec3(0, -1, 0)];
const FILLERS = new Set(['dirt', 'cobblestone', 'cobbled_deepslate', 'coarse_dirt']);
const BATCH = 16;
const STORABLE = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stick', 'rotten_flesh', 'feather', 'leather'];

function createHomesteadGoal({ bot, anchor = null, gear = DEFAULT_GEAR, skills = defaultSkills, actions = defaultActions,
  kb = KNOWLEDGE, maxExploreStreak = 20 } = {}) {
  const memory = {
    house: anchor ? createStarterHouse(anchor) : null,
    furnace: { item: null, input: 0, output: 0 },
    explore: {},
    exploreStreak: 0,
    pathFailures: 0,
    shortfall: {},
    verified: { crafting_table: false, furnace: false, chest: false, bed: false },
    steps: 0,
  };
  const blacklist = createBlacklist({ ttlMs: 120000 });
  const skipped = createBlacklist({ ttlMs: 300000 });

  const blockAt = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));
  const nameAt = (p) => blockAt(p)?.name || null;
  const matches = (family, name) => Boolean(name) && kb[family].match(name);

  function houseState() {
    const house = memory.house;
    const missing = house.blocks.filter((b) => !matches(b.family, nameAt(b.position)));
    const f = house.furniture;
    const placed = {
      crafting_table: nameAt(f.crafting_table.position) === 'crafting_table',
      furnace: nameAt(f.furnace.position) === 'furnace',
      chest: nameAt(f.chest.position) === 'chest',
      bed: matches('bed', nameAt(f.bed.position)) && matches('bed', nameAt(f.bed.head)),
      door: matches('door', nameAt(f.door.position)),
      torches: f.torches.filter((p) => nameAt(p) === 'torch').length,
    };
    return { missing, placed };
  }

  function expectedAt(p) {
    const house = memory.house;
    const key = posKey(p);
    const block = house.blocks.find((b) => posKey(b.position) === key);
    if (block) return (name) => matches(block.family, name);
    const f = house.furniture;
    if (posKey(f.crafting_table.position) === key) return (n) => n === 'crafting_table';
    if (posKey(f.furnace.position) === key) return (n) => n === 'furnace';
    if (posKey(f.chest.position) === key) return (n) => n === 'chest';
    // A bed only counts when both halves stand where planned; otherwise it is dug up and re-placed.
    if (posKey(f.bed.position) === key || posKey(f.bed.head) === key) {
      return (n) => matches('bed', n) && matches('bed', nameAt(f.bed.position)) && matches('bed', nameAt(f.bed.head));
    }
    if (posKey(f.door.position) === key || posKey(f.door.upper) === key) return (n) => matches('door', n);
    if (f.torches.some((t) => posKey(t) === key)) return (n) => n === 'torch';
    if (house.scaffold.some((p2) => posKey(p2) === key)) return (n) => memory.scaffoldActive && FILLERS.has(n);
    return () => false;
  }

  // Nothing is mined under the house at any depth: a pit there ends up below
  // the protected foundation with no way back up.
  function nearHouseColumn(p) {
    const a = memory.house?.anchor;
    if (!a) return false;
    return p.x >= a.x - 2 && p.x <= a.x + 8 && p.z >= a.z - 2 && p.z <= a.z + 8 && p.y <= a.y + 5;
  }

  function insideHouse(p) {
    const a = memory.house?.anchor;
    if (!a) return false;
    return p.x >= a.x - 1 && p.x <= a.x + 7 && p.z >= a.z - 1 && p.z <= a.z + 7 && p.y >= a.y - 3 && p.y <= a.y + 5;
  }

  // House materials only; gear is planned separately before and after the house.
  function requirements(state, hs) {
    const reqs = [];
    for (const [key, entry] of Object.entries(memory.shortfall)) {
      if (entry.until < Date.now()) { delete memory.shortfall[key]; continue; }
      reqs.push({ key, count: countKey(key, state.inventory, kb) + entry.extra });
    }
    const work = siteWork((x, y, z) => bot.blockAt(new Vec3(x, y, z)), memory.house, (p, block) => expectedAt(p)(block.name));
    const stair = memory.scaffoldActive ? memory.house.scaffold.filter((p) => !FILLERS.has(nameAt(p))).length : 0;
    if (work.fills.length + stair) reqs.push({ key: 'dirt', count: work.fills.length + stair });
    const remaining = {};
    for (const block of hs.missing) remaining[block.family] = (remaining[block.family] || 0) + 1;
    for (const [family, count] of Object.entries(remaining)) reqs.push({ key: family, count });
    const torches = memory.house.furniture.torches.length - hs.placed.torches;
    if (torches > 0 && !skipped.has('torch')) reqs.push({ key: 'torch', count: torches, optional: true });
    for (const piece of ['bed', 'chest', 'door']) if (!hs.placed[piece]) reqs.push({ key: piece, count: 1 });
    if (!hs.placed.furnace) reqs.push({ key: 'furnace', count: 1 });
    if (!hs.placed.crafting_table) reqs.push({ key: 'crafting_table', count: 1 });
    return reqs;
  }

  function plannerInventory(state) {
    const inventory = { ...state.inventory };
    // Items left in the furnace still count; otherwise they would be gathered twice.
    if (memory.furnace.item === 'raw_iron') {
      inventory.raw_iron = (inventory.raw_iron || 0) + memory.furnace.input;
      inventory.iron_ingot = (inventory.iron_ingot || 0) + memory.furnace.output;
    }
    return inventory;
  }

  function complete(state) {
    if (!memory.house) return false;
    const hs = houseState();
    if (hs.missing.length || !hs.placed.door || !hs.placed.bed || !hs.placed.chest
      || !hs.placed.crafting_table || !hs.placed.furnace) return false;
    if (!Object.values(memory.verified).every(Boolean)) return false;
    return gear.every((key) => countKey(key, state.inventory, kb) > 0);
  }

  async function explore(ctx, why) {
    memory.exploreStreak += 1;
    if (memory.exploreStreak > maxExploreStreak) return { ok: false, reason: `exhausted:${why}` };
    ctx.record('explore_for', { why, streak: memory.exploreStreak });
    return skills.explore(bot, ctx, memory.explore);
  }

  async function runPlannerStep(ctx, step, requirement) {
    ctx.record('plan_step', { kind: step.kind, key: step.key, for: step.for, item: step.item, count: step.count ?? step.times });
    // Everything except mining happens up top: climb out of the pit first.
    if (step.kind !== 'gather') {
      const up = await surfaceFirst(ctx);
      if (up) return up;
    }
    const house = memory.house;
    switch (step.kind) {
      case 'place_station':
        return skills.placeAt(bot, ctx, house.furniture[step.station].position, (n) => n === step.station, { faces: DOWN });
      case 'craft': {
        const result = await skills.craft(bot, ctx, { item: step.item, times: step.times,
          tablePosition: step.table ? house.furniture.crafting_table.position : null });
        if (result.ok && result.usedTable) memory.verified.crafting_table = true;
        // Short of something the plan thought was there: plan for it explicitly for a while.
        for (const m of result.missing || []) {
          const family = familyOf(m.name, kb);
          if (family) memory.shortfall[family] = { extra: m.short, until: Date.now() + 120000 };
        }
        return result;
      }
      case 'gather': {
        const result = await skills.gatherOne(bot, ctx, { blocks: step.blocks, dropMatch: kb[step.key].match,
          blacklist, exclude: nearHouseColumn });
        if (result.reason === 'no_target_in_range') {
          if (requirement?.optional) { skipped.add(requirement.key, 'unavailable'); return { ok: true, skipped: requirement.key }; }
          return explore(ctx, step.key);
        }
        return result;
      }
      case 'smelt': {
        const result = await skills.smelt(bot, ctx, { input: step.input, count: step.count,
          furnacePosition: house.furniture.furnace.position, memory: memory.furnace });
        memory.furnace.item = step.input;
        if (result.ok) memory.verified.furnace = true;
        return result;
      }
      case 'hunt': {
        // Optional food runs wait until the bot is healthy again.
        if (requirement?.optional && ctx.perceive().health < 12) {
          skipped.add(requirement.key, 'low_health', 60000);
          return { ok: true, skipped: requirement.key };
        }
        const result = await skills.huntOne(bot, ctx, { mobs: step.mobs, dropMatch: kb[step.key].match, blacklist });
        if (result.reason === 'no_mob_in_range') {
          if (requirement?.optional) { skipped.add(requirement.key, 'unavailable'); return { ok: true, skipped: requirement.key }; }
          return explore(ctx, step.key);
        }
        return result;
      }
      default:
        return { ok: false, reason: `unplannable:${step.key}:${step.reason}` };
    }
  }

  // Paths should not tunnel through the site. A hard ban can wall the bot into
  // a pit next to it, so digging there is only made expensive; anything that
  // does get dug shows up as missing foundation or wall and is rebuilt.
  function protectSite() {
    const movements = bot.pathfinder?.movements;
    if (!movements || !memory.house) return;
    bot.companionSurfaceY = memory.house.anchor.y;
    if (!memory.protect) memory.protect = (block) => (insideHouse(block.position) ? 40 : 0);
    if (!movements.exclusionAreasBreak.includes(memory.protect)) movements.exclusionAreasBreak.push(memory.protect);
  }

  async function siteStep(ctx) {
    const work = siteWork((x, y, z) => bot.blockAt(new Vec3(x, y, z)), memory.house, (p, block) => expectedAt(p)(block.name));
    work.digs = work.digs.filter((d) => !blacklist.has(`site:${posKey(d.position)}`));
    work.fills = work.fills.filter((d) => !blacklist.has(`site:${posKey(d.position)}`));
    // A site that keeps needing digging was misjudged; pick another while nothing stands on it yet.
    if (work.digs.length && memory.siteDigs > 40 && nameAt(memory.house.furniture.crafting_table.position) !== 'crafting_table') {
      ctx.record('site_abandoned', { anchor: memory.house.anchor, digs: memory.siteDigs });
      const movements = bot.pathfinder?.movements;
      if (movements && memory.protect) movements.exclusionAreasBreak = movements.exclusionAreasBreak.filter((f) => f !== memory.protect);
      memory.house = null;
      memory.protect = null;
      memory.siteDigs = 0;
      return { ok: true, abandoned: true };
    }
    if (work.digs.length) {
      memory.siteDigs = (memory.siteDigs || 0) + 1;
      const target = work.digs[0];
      const block = blockAt(target.position);
      ctx.record('site_dig', { position: posKey(target.position), block: target.name });
      const reach = await actions.goToDig(bot, ctx, block, { timeoutMs: 30000 });
      if (!reach.ok) { blacklist.add(`site:${posKey(target.position)}`, reach.reason, 20000); return reach; }
      const dug = await actions.digBlock(bot, ctx, block);
      if (!dug.ok) blacklist.add(`site:${posKey(target.position)}`, dug.reason, 20000);
      // Pick up whatever it dropped: dirt for filling, or a misplaced bed or door.
      if (dug.ok) await actions.collectDrops(bot, ctx, block.position.offset(0.5, 0.5, 0.5), () => true, { timeoutMs: 3000 });
      return dug;
    }
    if (work.fills.length && Object.keys(ctx.perceive().inventory).some((n) => FILLERS.has(n))) {
      ctx.record('site_fill', { position: posKey(work.fills[0].position) });
      const filled = await skills.placeAt(bot, ctx, work.fills[0].position, (n) => FILLERS.has(n));
      if (!filled.ok) blacklist.add(`site:${posKey(work.fills[0].position)}`, filled.reason, 20000);
      return filled;
    }
    return null;
  }

  // Ordered build tasks. Walls and roof are placed in batches so that one
  // gathered block does not mean one trip home.
  function buildTasks(hs) {
    const f = memory.house.furniture;
    const tasks = [];
    const piece = (what, position, material, match, options = { faces: DOWN }) =>
      tasks.push({ what, position, material, match, options, batch: 1 });
    if (!hs.placed.crafting_table) piece('crafting_table', f.crafting_table.position, 'crafting_table', (n) => n === 'crafting_table');
    // The top wall row and the roof are laid from the stair.
    if (memory.scaffoldActive) {
      for (const p of memory.house.scaffold) {
        if (!FILLERS.has(nameAt(p))) tasks.push({ what: 'scaffold', position: p, material: 'dirt',
          match: (n) => FILLERS.has(n), options: { faces: DOWN }, batch: 1 });
      }
    }
    const walls = hs.missing.filter((b) => b.phase === 'walls');
    for (const b of walls) tasks.push({ what: 'wall', position: b.position, material: 'cobblestone',
      match: (n) => matches('cobblestone', n), batch: Math.min(walls.length, BATCH) });
    for (const torch of f.torches) if (nameAt(torch) !== 'torch') piece('torch', torch, 'torch', (n) => n === 'torch');
    if (!hs.placed.chest) piece('chest', f.chest.position, 'chest', (n) => n === 'chest');
    if (!hs.placed.bed) {
      piece('bed', f.bed.position, 'bed', (n) => matches('bed', n),
        { stand: f.bed.stand, verify: () => matches('bed', nameAt(f.bed.head)) });
    }
    if (!hs.placed.furnace) piece('furnace', f.furnace.position, 'furnace', (n) => n === 'furnace');
    const roof = hs.missing.filter((b) => b.phase === 'roof');
    if (!walls.length) {
      for (const b of roof) tasks.push({ what: 'roof', position: b.position, material: 'planks',
        match: (n) => matches('planks', n), batch: Math.min(roof.length, BATCH) });
    }
    if (!walls.length && !roof.length && !hs.placed.door) piece('door', f.door.position, 'door', (n) => matches('door', n));
    return tasks;
  }

  async function buildStep(ctx, hs, inventory, { whenBatchReady }) {
    const waiting = {};
    for (const task of buildTasks(hs)) {
      if (blacklist.has(`build:${posKey(task.position)}`)) {
        (waiting.blacklisted = waiting.blacklisted || []).push(`${task.what}@${posKey(task.position)}`);
        continue;
      }
      const have = countKey(task.material, inventory, kb);
      // Once a batch is started it continues until that material runs out.
      const continuing = memory.batch === task.material;
      if (have <= 0 || (whenBatchReady && !continuing && have < task.batch)) {
        waiting[task.material] = (waiting[task.material] || 0) + 1;
        continue;
      }
      memory.batch = task.batch > 1 ? task.material : null;
      return placeRecorded(ctx, task.position, task.match, task.what, task.options);
    }
    memory.batch = null;
    if (!whenBatchReady && Object.keys(waiting).length) ctx.record('build_waiting', waiting);
    // The blacklist only defers a failed placement while other work exists.
    // With nothing else to do, retry the earliest one that has material.
    if (!whenBatchReady) {
      const retry = buildTasks(hs).find((task) => countKey(task.material, inventory, kb) > 0);
      if (retry) return placeRecorded(ctx, retry.position, retry.match, retry.what, retry.options);
    }
    return null;
  }

  async function surfaceFirst(ctx) {
    if (typeof actions.surface !== 'function') return null;
    const result = await actions.surface(bot, ctx);
    if (result) ctx.record('surface', { ok: result.ok });
    return result;
  }

  async function placeRecorded(ctx, position, match, what, options) {
    const up = await surfaceFirst(ctx);
    if (up) return up;
    ctx.record('build', { what, position: posKey(position) });
    const result = await skills.placeAt(bot, ctx, position, match, options);
    // A mob in the way moves on quickly; other failures wait a little longer.
    if (!result.ok) blacklist.add(`build:${posKey(position)}`, result.reason, result.reason === 'cell_occupied_by_entity' ? 4000 : 15000);
    return result;
  }

  async function nightStep(ctx, hs) {
    const house = memory.house;
    if (hs.placed.bed) {
      ctx.record('night', { action: 'sleep' });
      const slept = await skills.useBed(bot, ctx, { position: house.furniture.bed.position });
      if (slept.ok) { memory.verified.bed = true; return slept; }
    }
    // Without a usable bed, a finished shell is still the safest place to be.
    const shellDone = !hs.missing.length && hs.placed.door;
    if (!shellDone) return null;
    const centre = new Vec3(house.interiorCenter.x + 0.5, house.interiorCenter.y, house.interiorCenter.z + 0.5);
    if (bot.entity.position.distanceTo(centre) > 2) {
      ctx.record('night', { action: 'shelter' });
      return actions.goNear(bot, ctx, centre, 1, { timeoutMs: 40000 });
    }
    ctx.record('night', { action: 'wait' });
    await sleep(3000, ctx.signal);
    return { ok: true, waited: true };
  }

  async function verifyStep(ctx) {
    const f = memory.house.furniture;
    if (!memory.verified.chest) {
      const store = STORABLE.find((n) => (ctx.perceive().inventory[n] || 0) > 0);
      ctx.record('verify', { furniture: 'chest', item: store || null });
      const result = await skills.useChest(bot, ctx, { position: f.chest.position,
        itemMatch: (n) => (store ? n === store : !n.endsWith('_sword') && !n.endsWith('_pickaxe') && n !== 'shield') });
      if (result.ok) memory.verified.chest = true;
      return result;
    }
    if (!memory.verified.bed) {
      ctx.record('verify', { furniture: 'bed' });
      const result = await skills.useBed(bot, ctx, { position: f.bed.position });
      if (result.ok) memory.verified.bed = true;
      return result;
    }
    if (!memory.verified.crafting_table) {
      ctx.record('verify', { furniture: 'crafting_table' });
      const result = await skills.craft(bot, ctx, { item: 'stick', times: 1, tablePosition: f.crafting_table.position });
      if (result.ok && result.usedTable) memory.verified.crafting_table = true;
      return result;
    }
    if (!memory.verified.furnace) {
      // Charcoal from one log proves the furnace works without needing ore.
      const log = Object.keys(ctx.perceive().inventory).find((n) => kb.log.match(n));
      if (!log) return runPlannerStep(ctx, planNext({ requirements: [{ key: 'log', count: 1 }], inventory: {} }));
      ctx.record('verify', { furniture: 'furnace' });
      const result = await skills.smelt(bot, ctx, { input: log, count: 1, furnacePosition: f.furnace.position, memory: memory.furnace });
      memory.furnace.item = log;
      if (result.ok) memory.verified.furnace = true;
      return result;
    }
    return null;
  }

  return {
    name: 'homestead',
    noProgressLimit: 25,
    memory,
    isDone: (state) => complete(state),
    progress: () => memory.steps,
    async run(ctx) {
      // Several "no path" results in a row usually mean the bot itself is stuck.
      if (memory.pathFailures >= 2) {
        memory.pathFailures = 0;
        ctx.record('unstick', { at: bot.entity.position.floored() });
        return actions.unstick(bot, ctx);
      }
      const result = await runOnce(ctx);
      if (result.ok) {
        memory.steps += 1;
        memory.pathFailures = 0;
        if (!result.moved) memory.exploreStreak = 0;
      } else if (['NoPath', 'Timeout', 'path_timeout', 'not_arrived', 'no_progress'].includes(result.reason)) {
        memory.pathFailures += 1;
      }
      return result;
    },
  };

  async function runOnce(ctx) {
    const state = ctx.perceive();
    if (!memory.house) {
      const site = chooseSite((x, y, z) => bot.blockAt(new Vec3(x, y, z)), state.position);
      if (!site) return explore(ctx, 'site');
      memory.house = createStarterHouse(site.anchor);
      ctx.record('site_chosen', { anchor: site.anchor, fills: site.fills, digs: site.digs });
      return { ok: true };
    }
    // Unloaded chunks read as missing blocks; go home before judging the house.
    if (!blockAt(memory.house.anchor) || !blockAt(memory.house.furniture.chest.position)) {
      ctx.record('return_home', {});
      return actions.goNear(bot, ctx, new Vec3(memory.house.entrance.x, memory.house.entrance.y, memory.house.entrance.z), 3,
        { timeoutMs: 60000 });
    }
    protectSite();
    {
      const hs0 = houseState();
      // The top wall row and the roof both rest on faces above eye level from
      // the floor, so the stair stands from the third row until the roof is done.
      const dy = (b) => b.position.y - memory.house.anchor.y;
      // Once up it stays until the whole shell stands, even if a lower block
      // has to be put back meanwhile; otherwise it is torn down and rebuilt.
      const lowerRowsDone = !hs0.missing.some((b) => b.phase === 'walls' && dy(b) < 2);
      memory.scaffoldActive = (memory.scaffoldActive || lowerRowsDone) && hs0.missing.length > 0;
    }
    const site = await siteStep(ctx);
    if (site) return site;

    const hs = houseState();
    const inventory = plannerInventory(state);
    const stations = { crafting_table: hs.placed.crafting_table, furnace: hs.placed.furnace };
    // Nights are slept through in the bed, or waited out inside the house.
    if (state.isDay === false) {
      const night = await nightStep(ctx, hs);
      if (night) return night;
    }
    // Stone tools first, then a few pieces of food so lost health can be eaten back.
    const early = gear.filter((key) => EARLY_GEAR.has(key)).map((key) => ({ key, count: 1 }));
    if (!skipped.has('food')) early.push({ key: 'food', count: 4, optional: true });
    const earlyStep = planNext({ requirements: early, inventory, stations, kb });
    if (earlyStep) return runPlannerStep(ctx, earlyStep, early.find((r) => r.key === earlyStep.for));
    // Then the bed, placed at its spot in the future house: from the first
    // night on, the bot sleeps through the dark and respawns at home.
    if (!hs.placed.bed && !skipped.has('wool')) {
      if (countKey('bed', state.inventory, kb) > 0) {
        const f = memory.house.furniture;
        return placeRecorded(ctx, f.bed.position, (n) => matches('bed', n), 'bed',
          { stand: f.bed.stand, verify: () => matches('bed', nameAt(f.bed.head)) });
      }
      const bedReq = [{ key: 'bed', count: 1, optional: true }];
      const bedStep = planNext({ requirements: bedReq, inventory, stations, kb });
      if (bedStep) {
        // Wool needs sheep; if none can be found, build on and try again later.
        const result = await runPlannerStep(ctx, bedStep, bedStep.key === 'wool' ? { key: 'wool', optional: true } : null);
        return result;
      }
    }
    // Then the house: build whatever a full batch of carried material allows.
    const ready = await buildStep(ctx, hs, state.inventory, { whenBatchReady: true });
    if (ready) return ready;
    const reqs = requirements(state, hs);
    const step = planNext({ requirements: reqs, inventory, stations, kb });
    if (step) return runPlannerStep(ctx, step, reqs.find((r) => r.key === step.for));
    const build = await buildStep(ctx, hs, state.inventory, { whenBatchReady: false });
    if (build) return build;
    // Furniture is only tried out once the whole house stands.
    if (buildTasks(hs).length) return { ok: false, reason: 'build_blocked' };
    // Iron gear once the house is up.
    const late = gear.filter((key) => !EARLY_GEAR.has(key)).map((key) => ({ key, count: 1 }));
    const lateStep = planNext({ requirements: late, inventory, stations, kb });
    if (lateStep) return runPlannerStep(ctx, lateStep, null);
    const verify = await verifyStep(ctx);
    if (verify) return verify;
    return { ok: true, idle: true };
  }
}

module.exports = { createHomesteadGoal, DEFAULT_GEAR };
