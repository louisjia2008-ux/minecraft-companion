/* global module, require, setTimeout */
'use strict';
// The whole life of the companion from an empty inventory, with failures
// injected along the way:
//   1. the player asks for the starter house (companion.homestead()),
//   2. autonomy is switched on: once the house is done the director picks its
//      own goals, gathers materials into the house chest and builds a
//      cobblestone generator with a hopper collector, then the hopper-fed furnace,
//   3. meanwhile the harness kills the bot, fills its bag with junk and drops
//      it into a pit; each time it must recover by itself and carry on.
// Judged by the server: the house, both machines in the world and working,
// every injected failure recovered, and the bot alive with its iron gear.
//
// Every run starts a fresh world; `--seed` moves trees, animals, ore and the
// water and lava pools, so parallel sessions with different seeds see
// different layouts.

const { FLAT_GENERATOR, GROUND, plantTrees, resetArea } = require('./collectLogs.cjs');
const { verifyHomestead, testBlock, living } = require('./homestead.cjs');
const { createCobbleGenerator } = require('../core/blueprints/cobbleGenerator');
const { createAutoSmelter } = require('../core/blueprints/autoSmelter');
const { perceive } = require('../core/perception');
const { GENERATOR_HARVEST, SMELT_COUNT } = require('../core/goals/registry');

const MINUTE = 60 * 1000;
const MACHINE_CARDS = new Set(['cobble_generator', 'auto_smelter']);
const JUNK = ['gravel', 'andesite', 'rotten_flesh', 'diorite', 'granite', 'flint'];

// Failures injected in this order, each once. `ready` decides when it fires
// (after the previous one has been recovered), `fire` does it through server
// commands, `recovered` says when the bot has dealt with it.
const INJECTIONS = [
  {
    name: 'death_during_house',
    // Mid-way through the player's task, with tools and materials in the bag.
    ready: ({ elapsedMs, bot }) => elapsedMs > 12 * MINUTE && bot.health > 0,
    fire: ({ server, username }) => server.command(`kill ${username}`),
    // Back on its feet and the player's task still running or done, not dropped.
    recovered: ({ bot, companion, since }) => Date.now() - since > 20000 && bot.health > 0
      && (companion.status().goal?.name === 'homestead' || companion.director.memory.homestead?.memory?.house),
  },
  {
    name: 'bag_full',
    // A minute into the first machine, junk fills all but one slot.
    ready: ({ state }) => state.machineSince && Date.now() - state.machineSince > MINUTE,
    fire: ({ server, username, bot, state }) => {
      const free = bot.inventory.emptySlotCount();
      state.bagFreeBefore = free;
      for (let i = 0; i < free - 1; i += 1) server.command(`give ${username} ${JUNK[i % JUNK.length]} 64`);
    },
    recovered: ({ bot, since }) => Date.now() - since > 5000 && bot.inventory.emptySlotCount() >= 4,
  },
  {
    name: 'pit',
    // Standing on open ground away from the house: the floor gives way into a
    // 1x1 shaft six blocks deep.
    ready: ({ bot, state, previousAt }) => Date.now() - previousAt > 2 * MINUTE && onOpenGround(bot, state),
    fire: ({ server, username, bot, state }) => {
      const feet = bot.entity.position.floored();
      state.pit = { x: feet.x, y: feet.y, z: feet.z };
      server.command(`fill ${feet.x} ${feet.y - 6} ${feet.z} ${feet.x} ${feet.y - 1} ${feet.z} air`);
      server.command(`tp ${username} ${feet.x + 0.5} ${feet.y - 6} ${feet.z + 0.5}`);
    },
    // Counts only once the bot was seen at the bottom (a teleport can be
    // lost, e.g. while it gets into bed); then it has to get itself out.
    recovered: ({ server, username, bot, state, since }) => {
      const p = bot.entity.position;
      // Down there it may dig sideways at once: next to the shaft, below ground counts too.
      const down = Math.abs(p.x - (state.pit.x + 0.5)) < 2.5 && Math.abs(p.z - (state.pit.z + 0.5)) < 2.5
        && p.y < state.pit.y - 2;
      if (!state.pit.seen) {
        if (down) state.pit.seen = Date.now();
        else if (Date.now() - since > 10000 * ((state.pit.retries || 0) + 1) && (state.pit.retries || 0) < 5) {
          state.pit.retries = (state.pit.retries || 0) + 1;
          server.command(`tp ${username} ${state.pit.x + 0.5} ${state.pit.y - 6} ${state.pit.z + 0.5}`);
        }
        return false;
      }
      // Out means back up at ground level, not just a step aside underground.
      return bot.health > 0 && p.y >= state.pit.y - 1;
    },
  },
  {
    name: 'death_during_machines',
    // While working on the machines, carrying what it gathered.
    ready: ({ bot, state, previousAt }) => Date.now() - previousAt > 3 * MINUTE && state.machineSince && bot.health > 0,
    fire: ({ server, username }) => server.command(`kill ${username}`),
    recovered: ({ bot, companion, since }) => Date.now() - since > 20000 && bot.health > 0
      && Boolean(companion.status().goal),
  },
];

function onOpenGround(bot, state) {
  const p = bot.entity?.position;
  if (!p || bot.health <= 10 || bot.entity.isInWater || bot.isSleeping) return false;
  // By day: at dusk the bot is on its way to bed.
  if (!(bot.time?.timeOfDay < 11500)) return false;
  if (Math.abs(p.y - GROUND) > 0.1) return false;
  const house = state.house;
  if (house && p.x >= house.x - 3 && p.x <= house.x + 10 && p.z >= house.z - 3 && p.z <= house.z + 10) return false;
  return true;
}

const machine = (companion, id) => companion.director.memory[id];

function finished(companion, bot) {
  const memory = companion.director.memory;
  if (!memory.homestead || !memory.cobbleGenerator || !memory.autoSmelter) return false;
  const state = perceive(bot);
  return memory.homestead.isDone(state) && memory.cobbleGenerator.isDone(state) && memory.autoSmelter.isDone(state);
}

/** Both machines in the world as built, judged by the server, and what they produced. */
async function verifyMachines({ server, companion }) {
  const forceload = (a) => server.query(`forceload add ${a.x - 4} ${a.z - 4} ${a.x + 4} ${a.z + 4}`,
    /(Marked|already|forceloaded|loaded)/i, 10000).catch(() => null);
  const partsOk = async (parts) => {
    const out = {};
    for (const part of parts) {
      out[part.key] = await testBlock(server, part.position, `minecraft:${part.block}${part.facing ? `[facing=${part.facing}]` : ''}`);
    }
    return out;
  };
  const details = { generatorOk: false, smelterOk: false };
  const gd = machine(companion, 'cobbleGenerator')?.memory.device.device;
  if (gd) {
    const d = createCobbleGenerator(gd.anchor, gd.facing, { collector: true });
    await forceload(d.anchor);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const c = d.cells;
    const blocks = {
      lava: await testBlock(server, c.lava, 'minecraft:lava[level=0]'),
      water: await testBlock(server, c.water, 'minecraft:water[level=0]'),
      cobble: await testBlock(server, c.cobble, 'minecraft:cobblestone'),
      ...await partsOk(d.parts),
    };
    const { harvested, regenerated } = machine(companion, 'cobbleGenerator').memory.device;
    details.generatorOk = Object.values(blocks).every(Boolean) && harvested >= GENERATOR_HARVEST;
    details.generator = { anchor: d.anchor, facing: d.facing, blocks, harvested, regenerated };
  }
  const sd = machine(companion, 'autoSmelter')?.memory.device.device;
  if (sd) {
    const d = createAutoSmelter(sd.anchor, sd.facing);
    await forceload(d.anchor);
    const parts = await partsOk(d.parts);
    const { taken } = machine(companion, 'autoSmelter').memory.device;
    details.smelterOk = Object.values(parts).every(Boolean) && taken >= SMELT_COUNT;
    details.smelter = { anchor: d.anchor, facing: d.facing, parts, taken };
  }
  return { pass: details.generatorOk && details.smelterOk, details };
}

const e2eFlat = {
  name: 'e2e-flat',
  description: 'Empty inventory, easy, day/night and mobs on, a fresh flat world: the player asks for the house, then'
    + ' the bot works on its own until it has built a cobblestone generator with a hopper and a hopper-fed furnace.'
    + ' The harness kills it twice, fills its bag and drops it into a pit along the way.',
  serverProperties: {
    'level-type': 'minecraft:flat', 'generator-settings': JSON.stringify(FLAT_GENERATOR),
    'level-seed': 20261022, difficulty: 'easy',
  },
  defaultDifficulty: 'easy',
  autonomous: true,
  timeoutMs: 300 * MINUTE,
  setup({ username, rng, difficulty = 'easy' }) {
    const trees = plantTrees(rng, 14);
    const commands = [...living(username, difficulty), ...resetArea(), ...trees.commands];
    const spot = (radius) => {
      const angle = rng() * Math.PI * 2;
      const r = radius * (0.4 + 0.6 * rng());
      return [Math.round(Math.cos(angle) * r), Math.round(Math.sin(angle) * r)];
    };
    // Shallow ore a few blocks under the dirt, as in homestead-flat.
    for (let i = 0; i < 2; i += 1) {
      const [x, z] = spot(18);
      commands.push(`fill ${x} ${GROUND - 7} ${z} ${x + 1} ${GROUND - 6} ${z + 1} coal_ore`);
    }
    for (let i = 0; i < 3; i += 1) {
      const [x, z] = spot(18);
      commands.push(`fill ${x} ${GROUND - 13} ${z} ${x + 1} ${GROUND - 12} ${z + 1} iron_ore`);
    }
    // Deeper veins at y=15-16 all around, about as dense as vanilla iron at
    // that height: what a branch mine finds. Iron, a quarter of it coal.
    for (let i = 0; i < 400; i += 1) {
      const [x, z] = spot(80);
      commands.push(`fill ${x} 15 ${z} ${x + 1} 16 ${z + 1} ${i % 4 === 3 ? 'coal_ore' : 'iron_ore'}`);
    }
    // One small pond and one lava pool, each lined with stone, away from the trees.
    const [wx, wz] = spot(40).map((n) => n + Math.sign(n || 1) * 20);
    commands.push(`fill ${wx - 2} ${GROUND - 3} ${wz - 2} ${wx + 2} ${GROUND - 1} ${wz + 2} stone`,
      `fill ${wx - 1} ${GROUND - 1} ${wz - 1} ${wx + 1} ${GROUND - 1} ${wz + 1} water`);
    let [lx, lz] = spot(40).map((n) => n + Math.sign(n || 1) * 22);
    if (Math.hypot(lx - wx, lz - wz) < 12) [lx, lz] = [-wx, -wz];
    commands.push(`fill ${lx - 2} ${GROUND - 3} ${lz - 2} ${lx + 2} ${GROUND - 1} ${lz + 2} stone`,
      `fill ${lx - 1} ${GROUND} ${lz - 1} ${lx + 1} ${GROUND} ${lz + 1} air`,
      `setblock ${lx} ${GROUND - 1} ${lz} lava`, `setblock ${lx + 1} ${GROUND - 1} ${lz} lava`);
    // A grove farther out: a long run cuts the trees near home down, as in a real world.
    const grove = [];
    for (let guard = 0; grove.length < 24 && guard < 500; guard += 1) {
      const angle = rng() * Math.PI * 2;
      const radius = 30 + rng() * 30;
      const x = Math.round(Math.cos(angle) * radius);
      const z = Math.round(Math.sin(angle) * radius);
      if ([...grove, { x: wx, z: wz }, { x: lx, z: lz }].some((p) => Math.abs(p.x - x) < 6 && Math.abs(p.z - z) < 6)) continue;
      grove.push({ x, z });
      const top = GROUND + 3 + Math.floor(rng() * 3);
      commands.push(`fill ${x - 2} ${top - 1} ${z - 2} ${x + 2} ${top} ${z + 2} oak_leaves[persistent=true] keep`,
        `fill ${x - 1} ${top + 1} ${z - 1} ${x + 1} ${top + 1} ${z + 1} oak_leaves[persistent=true] keep`,
        `fill ${x} ${GROUND} ${z} ${x} ${top} ${z} oak_log`);
    }
    // Animals for wool, food and a long day of work.
    for (let i = 0; i < 12; i += 1) commands.push(`summon sheep ${spot(23).join(` ${GROUND} `)} {Color:0b}`);
    for (let i = 0; i < 14; i += 1) commands.push(`summon cow ${spot(45).join(` ${GROUND} `)}`);
    for (let i = 0; i < 10; i += 1) commands.push(`summon pig ${spot(45).join(` ${GROUND} `)}`);
    for (let i = 0; i < 8; i += 1) commands.push(`summon chicken ${spot(45).join(` ${GROUND} `)}`);
    commands.push(`tp ${username} 0.5 ${GROUND} 0.5 0 0`);
    return { commands, details: { trees: trees.trees.length, grove: grove.length, water: { x: wx, z: wz }, lava: { x: lx, z: lz } } };
  },
  async start(companion, state) {
    state.injections = INJECTIONS.map((i) => ({ name: i.name, firedAt: null, recoveredAt: null }));
    // The player's one instruction: build the house. Then the bot is on its own.
    const goal = await companion.homestead();
    await companion.setAutonomy(true);
    return goal;
  },
  async onTick(context) {
    const { companion, state, write } = context;
    const house = companion.director.memory.homestead?.memory?.house;
    if (house) state.house = house.anchor;
    const current = companion.director.status().current;
    if (!state.machineSince && MACHINE_CARDS.has(current)) state.machineSince = Date.now();
    const index = state.injections.findIndex((i) => !i.recoveredAt);
    if (index < 0) return;
    const entry = state.injections[index];
    const spec = INJECTIONS[index];
    const previousAt = index ? state.injections[index - 1].recoveredAt : 0;
    if (!entry.firedAt) {
      if (!spec.ready({ ...context, previousAt })) return;
      entry.firedAt = Date.now();
      await spec.fire(context);
      write('inject', { name: entry.name, at: context.bot.entity?.position?.floored?.(), freeSlots: context.bot.inventory.emptySlotCount() });
      console.log(`    inject ${entry.name}`);
      return;
    }
    if (spec.recovered({ ...context, since: entry.firedAt })) {
      entry.recoveredAt = Date.now();
      entry.seconds = Math.round((entry.recoveredAt - entry.firedAt) / 1000);
      write('inject_recovered', { name: entry.name, seconds: entry.seconds });
      console.log(`    recovered ${entry.name} in ${entry.seconds}s`);
    }
  },
  finishWhen: ({ companion, bot, state }) => state.injections.every((i) => i.recoveredAt) && finished(companion, bot),
  async verify(context) {
    const { companion, bot, state } = context;
    const homestead = await verifyHomestead({ ...context, goal: companion.director.memory.homestead });
    const machines = await verifyMachines(context);
    const injected = state.injections.every((i) => i.recoveredAt);
    const alive = bot.health > 0;
    const pass = homestead.pass && machines.pass && injected && alive;
    const h = homestead.details;
    // placed..bedUsed are shown on the run line.
    return { pass, details: { homestead: h, ...machines.details, injections: state.injections, injected, alive,
      placed: h.placed, total: h.total, furniture: h.furniture, gear: h.gear, chestUsed: h.chestUsed, bedUsed: h.bedUsed } };
  },
};

// The machine half alone, for quick iteration: a finished house is stood in
// by commands (a chest, table, furnace and bed) and the director starts from
// there with iron tools, peaceful and in daylight; no failures injected.
const HOUSE = { x: -3, y: GROUND, z: -3 };
const machinesFlat = {
  name: 'machines-flat',
  description: 'Peaceful, daylight, iron tools and a stand-in house (chest, table, furnace, bed); the director gathers'
    + ' materials and builds the cobblestone generator with a hopper and the hopper-fed furnace on its own.',
  serverProperties: e2eFlat.serverProperties,
  autonomous: true,
  timeoutMs: 120 * MINUTE,
  setup(options) {
    const base = e2eFlat.setup({ ...options, difficulty: 'peaceful' });
    const { username } = options;
    const a = HOUSE;
    const tp = base.commands.pop();
    base.commands.push('gamerule doDaylightCycle false', 'gamerule doMobSpawning false', 'time set 1000',
      `fill ${a.x} ${a.y} ${a.z} ${a.x + 6} ${a.y + 3} ${a.z + 6} air`,
      `setblock ${a.x + 4} ${a.y} ${a.z + 5} chest`, `setblock ${a.x + 1} ${a.y} ${a.z + 5} crafting_table`,
      `setblock ${a.x + 2} ${a.y} ${a.z + 5} furnace`,
      `setblock ${a.x + 5} ${a.y} ${a.z + 1} white_bed[facing=north,part=head]`,
      `setblock ${a.x + 5} ${a.y} ${a.z + 2} white_bed[facing=north,part=foot]`,
      `give ${username} iron_pickaxe`, `give ${username} iron_sword`, `give ${username} shield`,
      `give ${username} cooked_beef 32`, tp);
    return base;
  },
  async start(companion, state, bot) {
    const a = HOUSE;
    const at = (dx, dz) => ({ x: a.x + dx, y: a.y, z: a.z + dz });
    const house = { anchor: { ...a }, interiorCenter: at(3, 3),
      furniture: { chest: { position: at(4, 5) }, crafting_table: { position: at(1, 5) }, furnace: { position: at(2, 5) },
        bed: { position: at(5, 1) } } };
    // The homestead goal tells movement where the ground is; the stand-in does the same.
    bot.companionSurfaceY = a.y;
    companion.director.memory.homestead = { name: 'homestead', memory: { house }, isDone: () => true, progress: () => 0,
      run: async () => ({ ok: true }) };
    await companion.setAutonomy(true);
    return null;
  },
  finishWhen: ({ companion, bot }) => finished(companion, bot),
  async verify(context) {
    const machines = await verifyMachines(context);
    return { pass: machines.pass && context.bot.health > 0, details: machines.details };
  },
};

module.exports = { e2eFlat, machinesFlat, INJECTIONS };
