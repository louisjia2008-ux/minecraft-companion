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
const { sleep, waitUntil } = require('../confirm');

const DEFAULT_GEAR = ['stone_sword', 'stone_tier_pickaxe', 'iron_sword', 'iron_pickaxe', 'shield'];
// Stone tools come before the house; iron waits until there is a bed to sleep in.
const EARLY_GEAR = new Set(['stone_sword', 'stone_tier_pickaxe', 'pickaxe', 'wooden_pickaxe']);
const DOWN = [new Vec3(0, -1, 0)];
const FOOD_MOBS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);
const FILLERS = new Set(['dirt', 'cobblestone', 'cobbled_deepslate', 'coarse_dirt']);
const BATCH = 16;
const RAW_MEATS = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit'];
const STORABLE = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stick', 'rotten_flesh', 'feather', 'leather'];

function createHomesteadGoal({ bot, anchor = null, gear = DEFAULT_GEAR, skills = defaultSkills, actions = defaultActions,
  kb = KNOWLEDGE, maxExploreStreak = 20 } = {}) {
  const memory = {
    house: anchor ? createStarterHouse(anchor) : null,
    furnace: { item: null, input: 0, output: 0 },
    explore: {},
    exploreStreak: 0,
    shortfall: {},
    verified: { crafting_table: false, furnace: false, chest: false, bed: false },
    established: false,
    steps: 0,
  };
  const blacklist = createBlacklist({ ttlMs: 120000 });
  const skipped = createBlacklist({ ttlMs: 300000 });

  const blockAt = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));
  const nameAt = (p) => blockAt(p)?.name || null;
  const matches = (family, name) => Boolean(name) && kb[family].match(name);

  function houseState() {
    const house = memory.house;
    const unknown = [];
    const check = (p, match) => {
      const block = blockAt(p);
      if (!block) { unknown.push(p); return null; }
      return match(block.name, block);
    };
    const missing = house.blocks.filter((b) => check(b.position, (name) => matches(b.family, name)) === false);
    const foundationMissing = house.foundation.filter((p) => check(p,
      (name, block) => block.boundingBox === 'block' && !['water', 'lava', 'bubble_column'].includes(name)) === false);
    const f = house.furniture;
    const both = (a, b) => a === false || b === false ? false : a === null || b === null ? null : true;
    const placed = {
      crafting_table: check(f.crafting_table.position, (n) => n === 'crafting_table'),
      furnace: check(f.furnace.position, (n) => n === 'furnace'),
      chest: check(f.chest.position, (n) => n === 'chest'),
      bed: both(check(f.bed.position, (n) => matches('bed', n)), check(f.bed.head, (n) => matches('bed', n))),
      door: both(check(f.door.position, (n) => matches('door', n)), check(f.door.upper, (n) => matches('door', n))),
      torches: f.torches.filter((p) => nameAt(p) === 'torch').length,
    };
    // A replacement is a new station/bed: its predecessor's successful use
    // cannot verify it. An unloaded cell does not erase that observation.
    for (const key of Object.keys(memory.verified)) if (placed[key] === false) memory.verified[key] = false;
    return { missing, placed, unknown, foundationMissing };
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
    // No door yet: at night the doorway is plugged with dirt or stone, dug out again by day.
    if (posKey(f.door.position) === key || posKey(f.door.upper) === key) {
      return (n) => (matches('door', n) && matches('door', nameAt(f.door.position)) && matches('door', nameAt(f.door.upper)))
        || (memory.doorPlug && FILLERS.has(n));
    }
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

  function protects(p) {
    if (!memory.house || !p || !insideHouse(p)) return false;
    const block = blockAt(p);
    if (!block) return false;
    if (memory.house.foundation.some((cell) => posKey(cell) === posKey(p))) {
      return block.boundingBox === 'block' && !['water', 'lava', 'bubble_column'].includes(block.name);
    }
    return expectedAt(p)(block.name);
  }

  // Only observed defects are repair requests. A distant unloaded house is
  // unknown, never a collection of missing walls to rebuild from a guess.
  function maintenance(state) {
    if (!memory.house) return { missing: [], unknown: [], gear: [], unverified: [] };
    const hs = houseState();
    const missing = hs.missing.map((b) => `${b.family}@${posKey(b.position)}`);
    missing.push(...hs.foundationMissing.map((p) => `foundation@${posKey(p)}`));
    for (const [key, placed] of Object.entries(hs.placed)) {
      if (placed === false) missing.push(key);
    }
    return { missing, unknown: hs.unknown.map(posKey),
      gear: gear.filter((key) => countKey(key, state.inventory, kb) <= 0),
      unverified: Object.keys(memory.verified).filter((key) => !memory.verified[key] && hs.placed[key] === true) };
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
    if (hs.unknown.length || hs.missing.length || hs.foundationMissing.length || !hs.placed.door || !hs.placed.bed || !hs.placed.chest
      || !hs.placed.crafting_table || !hs.placed.furnace) return false;
    if (!Object.values(memory.verified).every(Boolean)) return false;
    if (!gear.every((key) => countKey(key, state.inventory, kb) > 0)) return false;
    memory.established = true;
    return true;
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
      case 'place_station': {
        // A station needs its foundation; if that hole is still open, fill it first.
        const spot = house.furniture[step.station].position;
        const below = { x: spot.x, y: spot.y - 1, z: spot.z };
        if (blockAt(below)?.boundingBox !== 'block') {
          blacklist.delete(`site:${posKey(below)}`);
          ctx.record('station_needs_foundation', { station: step.station });
          return skills.placeAt(bot, ctx, below, (n) => FILLERS.has(n));
        }
        return skills.placeAt(bot, ctx, spot, (n) => n === step.station, { faces: DOWN });
      }
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
        // Nothing within the usual 48 blocks: look as far as the loaded world
        // reaches before walking off to explore (a felled plain, a treeless hill).
        let result = await skills.gatherOne(bot, ctx, { blocks: step.blocks, dropMatch: kb[step.key].match,
          blacklist, exclude: nearHouseColumn });
        if (result.reason === 'no_target_in_range') {
          result = await skills.gatherOne(bot, ctx, { blocks: step.blocks, dropMatch: kb[step.key].match,
            blacklist, exclude: nearHouseColumn, radius: 128 });
        }
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
        const result = await skills.huntOne(bot, ctx, { mobs: step.mobs, dropMatch: kb[step.key].match, blacklist, radius: 96,
          ...(step.key === 'wool' ? woolPreference(ctx.perceive().inventory) : {}) });
        // No sheep anywhere near: spiders drop string, four of which make wool.
        if (result.reason === 'no_mob_in_range' && step.key === 'wool') {
          const spider = await skills.huntOne(bot, ctx, { mobs: ['spider', 'cave_spider'], dropMatch: (n) => n === 'string', blacklist, radius: 48 });
          if (spider.reason !== 'no_mob_in_range') return spider;
        }
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

  // Finished structure and its supporting floor must survive other goals'
  // paths. Misplaced obstacles remain diggable so site repair can clear them.
  function protectSite() {
    const movements = bot.pathfinder?.movements;
    if (!memory.house) return;
    bot.companionSurfaceY = memory.house.anchor.y;
    if (!memory.protectBlock) memory.protectBlock = (block) => Boolean(block?.position && protects(block.position));
    bot.companionProtectBlock = memory.protectBlock;
    if (!movements) return;
    if (!memory.protect) memory.protect = (block) => protects(block.position) ? 100 : insideHouse(block.position) ? 90 : 0;
    if (!movements.exclusionAreasBreak.includes(memory.protect)) movements.exclusionAreasBreak.push(memory.protect);
  }

  async function siteStep(ctx) {
    const work = siteWork((x, y, z) => bot.blockAt(new Vec3(x, y, z)), memory.house, (p, block) => expectedAt(p)(block.name));
    work.digs = work.digs.filter((d) => !blacklist.has(`site:${posKey(d.position)}`));
    work.fills = work.fills.filter((d) => !blacklist.has(`site:${posKey(d.position)}`));
    // A site that keeps needing digging was misjudged; pick another while nothing stands on it yet.
    if (!memory.established && work.digs.length && memory.siteDigs > 40 && nameAt(memory.house.furniture.crafting_table.position) !== 'crafting_table') {
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
        { stand: f.bed.stand, verify: () => matches('bed', nameAt(f.bed.head)), alsoClear: [f.bed.head] });
    }
    if (!hs.placed.furnace) piece('furnace', f.furnace.position, 'furnace', (n) => n === 'furnace');
    const roof = hs.missing.filter((b) => b.phase === 'roof');
    if (!walls.length) {
      for (const b of roof) tasks.push({ what: 'roof', position: b.position, material: 'planks',
        match: (n) => matches('planks', n), batch: Math.min(roof.length, BATCH) });
    }
    if (!walls.length && !roof.length && !hs.placed.door) piece('door', f.door.position, 'door', (n) => matches('door', n),
      { faces: DOWN, verify: () => matches('door', nameAt(f.door.upper)), alsoClear: [f.door.upper] });
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

  // A bed takes three wool of one color: go for sheep of the color most within
  // reach (already owned plus visible), and never for sheared ones.
  function woolPreference(inventory) {
    if (typeof skills.sheepWool !== 'function') return {};
    const sheep = Object.values(bot.entities || {}).filter((e) => e.name === 'sheep' && e.position
      && e.position.distanceTo(bot.entity.position) <= 96);
    const fleece = new Map(sheep.map((e) => [e.id, skills.sheepWool(bot, e)]));
    const score = {};
    for (const wool of fleece.values()) if (wool && !wool.sheared) score[wool.color] = (score[wool.color] || 0) + 1;
    for (const [name, n] of Object.entries(inventory)) {
      const color = name.endsWith('_wool') ? name.slice(0, -5) : null;
      if (color && color in score) score[color] += n * 2;
    }
    const best = Object.keys(score).sort((a, b) => score[b] - score[a])[0];
    return {
      accept: (e) => !fleece.get(e.id)?.sheared,
      penalty: (e) => (best && fleece.get(e.id)?.color !== best ? 200 : 0),
    };
  }

  // Raiders (an outpost) seen near a spot: no house there.
  function nearDanger(p) {
    return (bot.companionDanger || []).some((d) => Math.hypot(d.x - p.x, d.z - p.z) < 80);
  }

  async function surfaceFirst(ctx) {
    if (typeof actions.surface !== 'function' || blacklist.has('surface')) return null;
    const result = await actions.surface(bot, ctx);
    if (result) ctx.record('surface', { ok: result.ok });
    // A climb that failed should not hold up every other step: carry on
    // where the bot is and try again later.
    if (result && !result.ok) blacklist.add('surface', result.reason, 60000);
    return result;
  }

  async function placeRecorded(ctx, position, match, what, options) {
    const up = await surfaceFirst(ctx);
    if (up) return up;
    ctx.record('build', { what, position: posKey(position) });
    // From far away (hunting, mining in the valley below a hilltop site) the
    // short placement path times out: walk back as one long trip first.
    if (bot.entity.position.distanceTo(new Vec3(position.x + 0.5, position.y, position.z + 0.5)) > 12) {
      ctx.record('return_home', { for: what });
      const back = await actions.goNear(bot, ctx, new Vec3(position.x, position.y, position.z), 4, { timeoutMs: 90000 });
      if (!back.ok) return back;
    }
    const result = await skills.placeAt(bot, ctx, position, match, options);
    // A mob in the way moves on quickly; other failures wait a little longer.
    if (!result.ok) blacklist.add(`build:${posKey(position)}`, result.reason, result.reason === 'cell_occupied_by_entity' ? 4000 : 15000);
    return result;
  }

  // The door stays open by day so paths walk straight through (the
  // pathfinder's own door opening is unreliable), and is shut at night once
  // the bot is inside.
  function doorOpen() {
    const door = blockAt(memory.house.furniture.door.position);
    if (!door || !matches('door', door.name) || typeof door.getProperties !== 'function') return null;
    const open = door.getProperties().open;
    return open === true || open === 'true';
  }

  function insideRoom(p) {
    const a = memory.house.anchor;
    return p.x >= a.x + 1 && p.x < a.x + 6 && p.z >= a.z + 1 && p.z < a.z + 6 && Math.abs(p.y - a.y) < 2;
  }

  async function setDoor(ctx, open) {
    const state = doorOpen();
    if (state === null || state === open) return null;
    const position = memory.house.furniture.door.position;
    const door = blockAt(position);
    if (!actions.withinReach(bot, door.position)) {
      const moved = await actions.goNear(bot, ctx, door.position, 2, { timeoutMs: 30000 });
      if (!moved.ok && !actions.withinReach(bot, door.position)) return moved;
    }
    ctx.record('door', { open });
    try { await bot.activateBlock(blockAt(position)); } catch { /* checked below */ }
    const done = await waitUntil(() => doorOpen() === open, { timeoutMs: 1500, signal: ctx.signal });
    return done ? { ok: true } : { ok: false, reason: 'door_unchanged' };
  }

  async function nightStep(ctx, hs, state) {
    const house = memory.house;
    if (memory.bunker) {
      bot.companionSheltered = true;
      await sleep(3000, ctx.signal);
      return { ok: true, waited: true };
    }
    // Walls and roof are enough to spend the night in: without a door yet, the doorway gets plugged.
    const shellDone = !hs.missing.length;
    // A bed still in the bag goes down at its spot before dark.
    if (!hs.placed.bed && countKey('bed', state.inventory, kb) > 0 && !blacklist.has('night:bed')) {
      const f = house.furniture;
      const placed = await placeRecorded(ctx, f.bed.position, (n) => matches('bed', n), 'bed',
        { stand: f.bed.stand, verify: () => matches('bed', nameAt(f.bed.head)) });
      if (!placed.ok) blacklist.add('night:bed', placed.reason, 60000);
      return placed;
    }
    // Already dark and far from home: the walk back is where nights kill.
    // Dig in where the bot is instead.
    const homeDistance = bot.entity.position.distanceTo(new Vec3(house.interiorCenter.x + 0.5, house.interiorCenter.y, house.interiorCenter.z + 0.5));
    const strandedFar = state.timeOfDay >= 12542 && homeDistance > 64;
    if (hs.placed.bed && !memory.bedRefusedAt && !strandedFar) {
      const bed = house.furniture.bed.position;
      const centre = new Vec3(bed.x + 0.5, bed.y, bed.z + 0.5);
      if (bot.entity.position.distanceTo(centre) > 4) {
        ctx.record('night', { action: 'go_home' });
        return actions.goNear(bot, ctx, centre, 2, { timeoutMs: 60000 });
      }
      if (state.timeOfDay < 12542) {
        await sleep(2000, ctx.signal); // sleeping becomes possible at dusk
        return { ok: true, waited: true };
      }
      ctx.record('night', { action: 'sleep' });
      const slept = await skills.useBed(bot, ctx, { position: bed });
      if (slept.ok) { memory.verified.bed = true; return slept; }
      // Monsters too close to sleep: do not keep trying all night.
      if (!shellDone) memory.bedRefusedAt = Date.now();
    }
    if (shellDone && !strandedFar) {
      const centre = new Vec3(house.interiorCenter.x + 0.5, house.interiorCenter.y, house.interiorCenter.z + 0.5);
      if (bot.entity.position.distanceTo(centre) > 2) {
        ctx.record('night', { action: 'shelter' });
        return actions.goNear(bot, ctx, centre, 1, { timeoutMs: 40000 });
      }
      if (insideRoom(bot.entity.position.floored())) {
        if (hs.placed.door) {
          const shut = await setDoor(ctx, false);
          if (shut) return shut;
        } else {
          const door = house.furniture.door;
          const open = [door.position, door.upper].find((p) => blockAt(p)?.boundingBox !== 'block');
          if (open && Object.keys(state.inventory).some((n) => FILLERS.has(n)) && !blacklist.has('plug')) {
            memory.doorPlug = true;
            ctx.record('night', { action: 'plug_doorway' });
            const plugged = await skills.placeAt(bot, ctx, open, (n) => FILLERS.has(n));
            if (!plugged.ok) blacklist.add('plug', plugged.reason, 20000);
            return plugged;
          }
        }
      }
      bot.companionSheltered = true;
      await sleep(3000, ctx.signal);
      return { ok: true, waited: true };
    }
    if (state.timeOfDay < 12542) return null; // still light enough to keep working
    ctx.record('night', { action: 'dig_in' });
    if (blacklist.has('bunker')) return null;
    const dug = await skills.digIn(bot, ctx, { sealMatch: (n) => FILLERS.has(n), avoid: nearHouseColumn });
    if (dug.ok) { memory.bunker = dug.bunker; bot.companionSheltered = true; }
    // Nowhere to dig in (sand, water): keep working through the night instead of retrying.
    else if (['no_bunker_spot', 'no_seal_block'].includes(dug.reason)) blacklist.add('bunker', dug.reason, 60000);
    return dug;
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
      // Monsters nearby refuse sleep but the respawn point is set all the same.
      if (result.ok || result.spawnSet) memory.verified.bed = true;
      if (result.spawnSet && !result.ok) return { ok: true, spawnSet: true };
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
    noProgressLimit: 40,
    // Out of budget: forget every failed target, get unstuck and walk home,
    // then start the budget over (deaths far away and pits are the usual cause).
    maxRecoveries: 6,
    recover() {
      blacklist.clear();
      skipped.clear();
      memory.recovery = true;
    },
    memory,
    maintenance,
    protects,
    isDone: (state) => complete(state),
    progress: () => memory.steps,
    async run(ctx) {
      if (memory.recovery) {
        memory.recovery = false;
        ctx.record('recovery', { at: bot.entity.position.floored() });
        await actions.unstick(bot, ctx);
        const entrance = memory.house?.entrance;
        if (entrance && bot.entity.position.distanceTo(new Vec3(entrance.x, entrance.y, entrance.z)) > 16) {
          return actions.goNear(bot, ctx, new Vec3(entrance.x, entrance.y, entrance.z), 3, { timeoutMs: 120000 });
        }
        return { ok: true };
      }
      const result = await runOnce(ctx);
      // Waiting (for dusk, out the night) is not progress: counting it would
      // refill the stall budget of a step that keeps failing every morning.
      if (result.ok && !result.waited) {
        memory.steps += 1;
        if (!result.moved) memory.exploreStreak = 0;
      }
      return result;
    },
  };

  async function runOnce(ctx) {
    const state = ctx.perceive();
    if (!memory.house) {
      const site = chooseSite((x, y, z) => bot.blockAt(new Vec3(x, y, z)), state.position, { avoid: nearDanger });
      if (!site) return explore(ctx, 'site');
      memory.house = createStarterHouse(site.anchor);
      ctx.record('site_chosen', { anchor: site.anchor, fills: site.fills, digs: site.digs });
      return { ok: true };
    }
    // Respawned far away from a site that barely stands and has no bed yet:
    // starting over here is cheaper than the long walk back.
    {
      const a = memory.house.anchor;
      const far = Math.hypot(bot.entity.position.x - a.x, bot.entity.position.z - a.z) > 150;
      if (!memory.established && (far || nearDanger(a)) && !memory.houseBed && (memory.houseBuilt || 0) < memory.house.blocks.length * 0.3) {
        ctx.record('site_abandoned', { anchor: a, reason: far ? 'far' : 'raiders', built: memory.houseBuilt || 0 });
        const movements = bot.pathfinder?.movements;
        if (movements && memory.protect) movements.exclusionAreasBreak = movements.exclusionAreasBreak.filter((f) => f !== memory.protect);
        memory.house = null;
        memory.protect = null;
        bot.companionChest = null;
        memory.siteDigs = 0;
        memory.houseBuilt = 0;
        memory.furnace = { item: null, input: 0, output: 0 }; // whatever is smelting stays behind
        return { ok: true, abandoned: true };
      }
    }
    // Unloaded chunks read as missing blocks; go home before judging the house.
    if ([...memory.house.clearance, ...memory.house.foundation].some((p) => !blockAt(p))) {
      ctx.record('return_home', {});
      return actions.goNear(bot, ctx, new Vec3(memory.house.entrance.x, memory.house.entrance.y, memory.house.entrance.z), 3,
        { timeoutMs: 60000 });
    }
    protectSite();
    {
      const hs0 = houseState();
      // The roof rests on faces above eye level from the floor, so the step
      // stands once the walls are up and until the roof is done.
      const dy = (b) => b.position.y - memory.house.anchor.y;
      // Once up it stays until the whole shell stands, even if a lower block
      // has to be put back meanwhile; otherwise it is torn down and rebuilt.
      const lowerRowsDone = !hs0.missing.some((b) => b.phase === 'walls' && dy(b) < 2);
      memory.scaffoldActive = (memory.scaffoldActive || lowerRowsDone) && hs0.missing.length > 0;
    }
    const site = await siteStep(ctx);
    if (site) return site;

    const hs = houseState();
    memory.houseBuilt = memory.house.blocks.length - hs.missing.length;
    memory.houseBed = hs.placed.bed;
    // A full bag is emptied into the house chest rather than onto the ground.
    bot.companionChest = hs.placed.chest ? memory.house.furniture.chest.position : null;
    const inventory = plannerInventory(state);
    const stations = { crafting_table: hs.placed.crafting_table, furnace: hs.placed.furnace };
    // Evenings: home before dark, into bed at dusk, else a sealed bunker.
    const evening = Number.isFinite(state.timeOfDay) && state.timeOfDay >= 11800 && state.timeOfDay < 23400;
    if (!evening) { memory.bedRefusedAt = null; memory.doorPlug = false; }
    bot.companionSheltered = false;
    // After a death the bot is no longer in its bunker: forget it.
    if (memory.bunker) {
      const top = memory.bunker.top;
      const at = bot.entity.position;
      if (Math.hypot(at.x - (top.x + 0.5), at.z - (top.z + 0.5)) > 1.5 || at.y > top.y + 0.5 || at.y < top.y - 5) memory.bunker = null;
    }
    if (memory.bunker && !evening) {
      ctx.record('night', { action: 'dig_out' });
      const out = await skills.digOut(bot, ctx, memory.bunker);
      if (out.ok) memory.bunker = null;
      return out;
    }
    if (evening) {
      const night = await nightStep(ctx, hs, state);
      if (night) return night;
    } else if (hs.placed.door && doorOpen() === false && !blacklist.has('door')) {
      const opened = await setDoor(ctx, true);
      if (opened && !opened.ok) blacklist.add('door', opened.reason, 30000);
      if (opened) return opened;
    }
    // Stone tools first, then a few pieces of food so lost health can be eaten back.
    const early = gear.filter((key) => EARLY_GEAR.has(key)).map((key) => ({ key, count: 1 }));
    if (!skipped.has('food')) early.push({ key: 'food', count: 4, optional: true });
    const earlyStep = planNext({ requirements: early, inventory, stations, kb });
    if (earlyStep) return runPlannerStep(ctx, earlyStep, early.find((r) => r.key === earlyStep.for));
    // Raw meat is worth two to three times as much cooked: once the furnace
    // stands, a few pieces in the bag go into it before anything else.
    if (hs.placed.furnace) {
      const raw = RAW_MEATS.map((name) => [name, state.inventory[name] || 0]).sort((x, y) => y[1] - x[1])[0];
      const fuel = Object.keys(state.inventory).some((n) => n === 'coal' || n === 'charcoal' || kb.planks.match(n) || kb.log.match(n));
      if (raw[1] >= 3 && fuel && !blacklist.has('cook')) {
        ctx.record('cook', { item: raw[0], count: raw[1] });
        const cooked = await skills.smelt(bot, ctx, { input: raw[0], count: Math.min(raw[1], 8),
          furnacePosition: memory.house.furniture.furnace.position, memory: memory.furnace });
        memory.furnace.item = raw[0];
        if (cooked.ok) memory.verified.furnace = true;
        else blacklist.add('cook', cooked.reason, 120000);
        return cooked;
      }
    }
    // Animals close by are food in the bag for later: on mountains and in
    // forests the next one may be a long, failing chase away once hunger hits.
    if (!evening && state.health >= 12 && countKey('food', state.inventory, kb) < 10 && !blacklist.has('stockpile')) {
      const near = Object.values(bot.entities || {}).some((e) => FOOD_MOBS.has(e.name) && e.position
        && e.position.distanceTo(bot.entity.position) <= 16 && !blacklist.has(`mob:${e.id}`));
      if (near) {
        ctx.record('stockpile_food', {});
        const hunted = await skills.huntOne(bot, ctx, { mobs: [...FOOD_MOBS], dropMatch: kb.food.match, blacklist, radius: 16 });
        if (!hunted.ok) blacklist.add('stockpile', hunted.reason, 60000);
        return hunted;
      }
    }
    // Then the bed, placed at its spot in the future house: from the first
    // night on, the bot sleeps through the dark and respawns at home.
    if (!hs.placed.bed && !skipped.has('wool') && !blacklist.has('early_bed')) {
      if (countKey('bed', state.inventory, kb) > 0) {
        const f = memory.house.furniture;
        const placed = await placeRecorded(ctx, f.bed.position, (n) => matches('bed', n), 'bed',
          { stand: f.bed.stand, verify: () => matches('bed', nameAt(f.bed.head)), alsoClear: [f.bed.head] });
        // An animal in the way or uneven ground: build on and come back to it.
        if (!placed.ok) blacklist.add('early_bed', placed.reason, 120000);
        return placed;
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
