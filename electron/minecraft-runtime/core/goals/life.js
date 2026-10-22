'use strict';
// Goal: live on your own. No end state: build and keep a home, then keep
// whichever project the world says matters most going: food (farm), a herd
// (ranch), ore (mine), room in the bag (store). Nights always belong to the
// homestead (home, bed, or a bunker).
//
// Each project is an ordinary goal kept for the whole life, so its memory
// (plots, pen, mine heading) carries over from one turn to the next. A
// project runs until it is done, stalls, or its time slice ends; then the
// scores are read again.

const { Vec3 } = require('vec3');
const defaultSkills = require('../skills');
const { createHomesteadGoal } = require('./homestead');
const { createFarmGoal } = require('./farm');
const { createRanchGoal } = require('./ranch');
const { createMineGoal } = require('./mine');
const { KNOWLEDGE, countKey } = require('../knowledge');
const { FOOD } = require('../husbandry');

const SLICE_MS = 10 * 60 * 1000;
const STALL_LIMIT = 12;
// What a full bag keeps: tools, armour, food, torches and building stock stay
// with the bot, everything else goes to the chest.
const KEEP = /(_pickaxe|_sword|_axe|_shovel|_hoe|shield|_helmet|_chestplate|_leggings|_boots|^torch$|^bread$|^cooked_|^wheat_seeds$|^wheat$|_bed$|^crafting_table$|_planks$|^stick$)/;
// Iron and coal stay in the bag while the homestead still needs its iron gear.
const GEAR_STOCK = /^(raw_iron|iron_ingot|coal|charcoal)$/;

function createLifeGoal({ bot, skills = defaultSkills, kb = KNOWLEDGE, now = Date.now, homestead = null } = {}) {
  const home = homestead || createHomesteadGoal({ bot });
  const memory = { project: null, since: 0, stalls: 0, steps: 0, projects: {}, history: [] };
  const house = () => home.memory.house;
  const nearHouse = (p) => {
    const a = house()?.anchor;
    return Boolean(a) && p.x >= a.x - 3 && p.x <= a.x + 9 && p.z >= a.z - 4 && p.z <= a.z + 9;
  };

  const food = (state) => countKey('food', state.inventory, kb);
  const ctx0 = () => ({ inventory: {} });
  const freeSlots = () => 36 - bot.inventory.items().length;
  const ironStock = (state) => (state.inventory.raw_iron || 0) + (state.inventory.iron_ingot || 0);

  function farm() {
    if (!memory.projects.farm) {
      const a = house().anchor;
      const pen = () => memory.projects.ranch?.memory.pen;
      memory.projects.farm = createFarmGoal({ bot, skills, center: { x: a.x + 3, y: a.y, z: a.z + 14 },
        exclude: (p) => nearHouse(p) || Boolean(pen()?.contains({ ...p, x: p.x + 0.5, z: p.z + 0.5 })),
        // Fixed per turn (set when the farm is chosen), so some wheat is left for the herd.
        bread: () => memory.breadGoal || 3,
        // Until there is a herd, four wheat stay unbaked to lead and breed it.
        reserveWheat: () => (memory.projects.ranch?.isDone(ctx0()) ? 0 : 4) });
    }
    return memory.projects.farm;
  }

  function herdKind(state) {
    const seen = {};
    for (const e of Object.values(bot.entities)) {
      if (FOOD[e.name] && e.position && e.position.distanceTo(bot.entity.position) < 64) seen[e.name] = (seen[e.name] || 0) + 1;
    }
    return ['cow', 'sheep', 'pig', 'chicken'].filter((k) => FOOD[k].some((n) => (state.inventory[n] || 0) >= 2))
      .sort((x, y) => (seen[y] || 0) - (seen[x] || 0))[0] || null;
  }

  function ranch(state) {
    if (!memory.projects.ranch) {
      const kind = herdKind(state);
      if (!kind) return null;
      const a = house().anchor;
      const plots = () => memory.projects.farm?.memory.plots || [];
      memory.projects.ranch = createRanchGoal({ bot, skills, kind, target: 4, center: { x: a.x - 12, y: a.y, z: a.z + 3 },
        exclude: (p) => nearHouse(p) || plots().some((q) => Math.abs(q.x - p.x) <= 1 && Math.abs(q.z - p.z) <= 1) });
    }
    return memory.projects.ranch;
  }

  function mine(state) {
    // A fresh trip each time: bring up eight more of each.
    if (!memory.projects.mine || memory.projects.mine.isDone(state)) {
      memory.projects.mine = createMineGoal({ bot, skills,
        want: { raw_iron: (state.inventory.raw_iron || 0) + 8, coal: (state.inventory.coal || 0) + 8 } });
    }
    return memory.projects.mine;
  }

  const store = {
    name: 'store',
    isDone: () => freeSlots() >= 12,
    progress: () => 36 - bot.inventory.items().length,
    async run(ctx) {
      const chest = house()?.furniture.chest.position;
      if (!chest) return { ok: false, reason: 'no_chest' };
      const homeNeedsIron = !home.isDone(ctx.perceive());
      // Cobblestone stays for building unless there is a lot of it.
      const cobble = bot.inventory.items().filter((i) => i.name === 'cobblestone').reduce((n, i) => n + i.count, 0);
      return skills.depositAll(bot, ctx, { position: chest,
        itemMatch: (n) => !KEEP.test(n) && !(homeNeedsIron && GEAR_STOCK.test(n)) && (n !== 'cobblestone' || cobble > 64) });
    },
  };

  /** Scores for each project from the world as it is now; the best goes next. */
  function choose(state) {
    const scores = [];
    if (freeSlots() < 6) scores.push(['store', 5]);
    if (!home.isDone(state)) scores.push(['home', 3]);
    const plotsReady = memory.projects.farm?.memory.plots?.length || 0;
    scores.push(['farm', food(state) < 12 ? 4 : plotsReady < 8 ? 2.5 : 1]);
    const herd = memory.projects.ranch;
    // A herd needs its pen once: ahead of mining when there is food to lead it with.
    if (!herd?.isDone(state) && herdKind(state)) scores.push(['ranch', herd?.memory.pen ? 2 : 2.6]);
    if (ironStock(state) < 24 || (state.inventory.coal || 0) < 16) scores.push(['mine', 2.2]);
    // Do not pick the same stalled project again straight away.
    const last = memory.history[memory.history.length - 1];
    return scores
      .map(([name, score]) => [name, last?.name === name && last.stalled ? score - 3 : score])
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'farm';
  }

  function goalFor(name, state) {
    if (name === 'farm') return farm();
    if (name === 'ranch') return ranch(state);
    if (name === 'mine') return mine(state);
    if (name === 'store') return store;
    if (name === 'home') return home;
    return null;
  }

  async function runOnce(ctx) {
    const state = ctx.perceive();
    const evening = Number.isFinite(state.timeOfDay) && state.timeOfDay >= 11800 && state.timeOfDay < 23400;
    // Home first, and every night at home. Once the house stands with its
    // bed, the rest of the homestead (iron gear, trying the furniture) is
    // one project among the others instead of blocking all of them.
    const livable = Boolean(home.memory.house) && home.memory.houseBuilt >= home.memory.house.blocks.length && home.memory.houseBed;
    if (evening || (!home.isDone(state) && !livable)) {
      const result = await home.run(ctx);
      if (!result.idle) return result;
    }
    const current = memory.project === 'store' ? store : memory.project === 'home' ? home : memory.projects[memory.project];
    const due = !memory.project || now() - memory.since > SLICE_MS || memory.stalls >= STALL_LIMIT
      || Boolean(current?.isDone(state));
    if (due) {
      if (memory.project) memory.history.push({ name: memory.project, stalled: memory.stalls >= STALL_LIMIT });
      memory.project = choose(state);
      if (memory.project === 'farm') memory.breadGoal = countKey('bread', state.inventory, kb) + 3;
      memory.since = now();
      memory.stalls = 0;
      ctx.record('life_project', { project: memory.project, food: food(state), iron: ironStock(state), free: freeSlots() });
    }
    const goal = goalFor(memory.project, state);
    if (!goal) { memory.stalls = STALL_LIMIT; return { ok: true, waited: true }; }
    const result = await goal.run(ctx);
    if (result.ok && !result.waited) memory.stalls = 0; else if (!result.ok) memory.stalls += 1;
    // A project that only waits (crops growing) gives way to the next.
    if (result.waited) memory.stalls += 1;
    return result;
  }

  return {
    name: 'life',
    noProgressLimit: 60,
    maxRecoveries: 1000,
    recover: () => { home.recover?.(); memory.stalls = STALL_LIMIT; },
    memory,
    home,
    isDone: () => false,
    progress: () => memory.steps,
    async run(ctx) {
      const result = await runOnce(ctx);
      if (result.ok && !result.waited && !result.idle) memory.steps += 1;
      return result;
    },
  };
}

module.exports = { createLifeGoal };
