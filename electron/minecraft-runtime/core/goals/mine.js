'use strict';
// Goal: bring back `want` ore (e.g. { raw_iron: 8, coal: 8 }) from a mining
// trip. Staircase down to `layer`, then a tunnel along it, mining ore that
// shows in the walls on the way. One step or one ore per run(); the position
// in the mine is the bot's own position, so an interruption needs nothing.

const defaultSkills = require('../skills');
const defaultMining = require('../mining');
const { planNext } = require('../planner');
const { KNOWLEDGE, countKey } = require('../knowledge');
const { createBlacklist, posKey } = require('../blacklist');
const { createPlannerRunner } = require('./common');

// Where each ore is most common in 1.18+ worlds (a tunnel at this y).
const LAYER = { raw_iron: 16, coal: 40, raw_copper: 48, raw_gold: -16, redstone: -50, diamond: -54, lapis_lazuli: 0 };
const ORE_OF = {
  raw_iron: /iron_ore$/, coal: /coal_ore$/, raw_copper: /copper_ore$/, raw_gold: /gold_ore$/,
  redstone: /redstone_ore$/, diamond: /diamond_ore$/, lapis_lazuli: /lapis_ore$/, emerald: /emerald_ore$/,
};
// Tool needed for each ore (wooden is enough for coal).
const TOOL_OF = { coal: 'pickaxe', raw_copper: 'stone_tier_pickaxe', raw_iron: 'stone_tier_pickaxe', lapis_lazuli: 'stone_tier_pickaxe' };

function createMineGoal({ bot, want = { raw_iron: 8, coal: 8 }, layer = null,
  skills = defaultSkills, mining = defaultMining, kb = KNOWLEDGE } = {}) {
  const blacklist = createBlacklist({ ttlMs: 120000 });
  const memory = { tunnel: mining.HEADINGS[Math.floor(Math.random() * 4)], length: 0, steps: 0, table: null };
  const { step: plannerStep, inventoryFor, tableHere } = createPlannerRunner({ bot, skills, kb, memory, blacklist });
  const targetY = layer ?? Math.min(...Object.keys(want).map((k) => LAYER[k] ?? 16));
  const have = (state, item) => state.inventory[item] || 0;
  const missing = (state) => Object.entries(want).filter(([item, n]) => have(state, item) < n).map(([item]) => item);

  async function runOnce(ctx) {
    const state = ctx.perceive();
    const inventory = inventoryFor(state);
    const stations = { crafting_table: tableHere() };
    // Tools for the hardest ore wanted, and torches while there is coal.
    const tools = [...new Set(missing(state).map((item) => TOOL_OF[item] || 'stone_tier_pickaxe'))]
      .map((key) => ({ key, count: 1 }));
    // A worn pickaxe gets a spare made while there is still stone to make it
    // from; a crafting table travels along so that can happen underground.
    const pickaxes = bot.inventory.items().filter((i) => i.name.endsWith('_pickaxe'));
    const worn = pickaxes.length === 1 && (pickaxes[0].maxDurability || 0) - (pickaxes[0].durabilityUsed || 0) < 15;
    if (worn && pickaxes[0].name !== 'wooden_pickaxe') tools.push({ key: 'stone_pickaxe', count: 2 });
    // Packed before going down, where there is wood to make one.
    if (memory.length === 0 && !(state.inventory.crafting_table > 0)) tools.push({ key: 'crafting_table', count: 1 });
    const toolStep = planNext({ requirements: tools, inventory, stations, kb });
    if (toolStep) return plannerStep(ctx, { ...toolStep, for: 'pickaxe' });
    if (have(state, 'torch') < 4 && have(state, 'coal') >= 1 && (have(state, 'stick') >= 1 || countKey('planks', inventory, kb) >= 2)) {
      const torchStep = planNext({ requirements: [{ key: 'torch', count: have(state, 'torch') + 4 }], inventory, stations, kb });
      if (torchStep && torchStep.kind === 'craft') return plannerStep(ctx, { ...torchStep, for: 'torch' });
    }
    // Ore in view: mine it first.
    const wanted = missing(state).map((item) => ORE_OF[item]).filter(Boolean);
    const ore = mining.visibleOre(bot, (name) => wanted.some((re) => re.test(name)))
      .find((p) => !blacklist.has(posKey(p)));
    if (ore) {
      ctx.record('mine', { action: 'ore', block: bot.blockAt(ore)?.name, position: posKey(ore) });
      const result = await skills.gatherOne(bot, ctx, { blocks: (n) => n === bot.blockAt(ore)?.name,
        dropMatch: (n) => Object.keys(want).includes(n), blacklist, radius: 6 });
      if (!result.ok) blacklist.add(posKey(ore), result.reason);
      return result;
    }
    // Down to the layer, then along it.
    const y = Math.floor(bot.entity.position.y);
    let kind = y > targetY ? 'down' : 'level';
    // Moving away from water below before going down again.
    if (kind === 'down' && memory.levelSteps > 0) { memory.levelSteps -= 1; kind = 'level'; }
    ctx.record('mine', { action: kind, y, heading: memory.tunnel });
    const stepped = await mining.step(bot, ctx, skills, memory, kind);
    // Water on every side (a beach, a swamp, an aquifer): move off and start
    // again somewhere drier.
    if (stepped.reason === 'liquid_all_around' || stepped.reason === 'stuck_here') return skills.explore(bot, ctx, memory);
    return stepped;
  }

  return {
    name: 'mine',
    noProgressLimit: 30,
    memory,
    isDone: (state) => missing(state).length === 0,
    progress: (state) => memory.steps + Object.keys(want).reduce((sum, item) => sum + have(state, item), 0),
    async run(ctx) {
      const result = await runOnce(ctx);
      if (result.ok) memory.steps += 1;
      return result;
    },
  };
}

module.exports = { createMineGoal, LAYER };
