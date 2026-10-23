/* global module, require, setTimeout */
'use strict';
// Farm-device scenarios, first stage: the materials are handed over so only
// building and running the device is tested. Judged by the server: the liquid
// sources in their cells and cobblestone mined from the generator on the player.

const { FLAT_GENERATOR, GROUND, resetArea } = require('./collectLogs.cjs');
const { createCobbleGenerator } = require('../core/blueprints/cobbleGenerator');
const { createAutoSmelter } = require('../core/blueprints/autoSmelter');
const { createCaneFarm } = require('../core/blueprints/caneFarm');
const { createMobFarm } = require('../core/blueprints/mobFarm');
const { MOB_DROPS } = require('../core/goals/mobFarm');
const { createCarpetDuper } = require('../core/blueprints/carpetDuper');
const { createFishPond } = require('../core/blueprints/fishPond');
const { createRailDuper } = require('../core/blueprints/railDuper');
const { createIronFarm } = require('../core/blueprints/ironFarm');
const { fishingDataPacks, fishingSetup, installFishingEvidence } = require('./fishingEvidence.cjs');

const HARVEST = 8;

const commonSetup = (username, difficulty) => [
  `difficulty ${difficulty}`,
  'gamerule doDaylightCycle false', 'gamerule doWeatherCycle false', 'gamerule doMobSpawning false',
  'gamerule doImmediateRespawn true', 'gamerule doFireTick false', 'time set noon', 'weather clear',
  'kill @e[type=item]', 'kill @e[type=!player]',
  `clear ${username}`, `effect clear ${username}`, `gamemode survival ${username}`,
];

async function testBlock(server, p, predicate) {
  const match = await server.query(`execute if block ${p.x} ${p.y} ${p.z} ${predicate}`,
    /Test (passed|failed)|(not loaded)/, 5000);
  return match[1] === 'passed';
}

async function countOnPlayer(server, username, item) {
  const match = await server.query(`clear ${username} ${item} 0`,
    new RegExp(`(?:Found (\\d+) matching item(?:\\(s\\)|s)? on player ${username}|No items were found on player ${username})`));
  return match[1] ? Number(match[1]) : 0;
}

const cobbleGeneratorFlat = {
  name: 'cobblegen-flat',
  description: `Flat plains, handed a stone pickaxe, water and lava buckets and dirt; build a cobblestone generator and mine ${HARVEST} cobblestone from it.`,
  serverProperties: {
    'level-type': 'minecraft:flat', 'generator-settings': JSON.stringify(FLAT_GENERATOR),
    'level-seed': 20261022, difficulty: 'peaceful',
  },
  timeoutMs: 6 * 60 * 1000,
  setup({ username, rng, difficulty = 'peaceful' }) {
    // A different start spot and heading each run so the site search is exercised.
    const x = Math.round((rng() - 0.5) * 16);
    const z = Math.round((rng() - 0.5) * 16);
    const yaw = Math.round(rng() * 360) - 180;
    return {
      commands: [
        ...commonSetup(username, difficulty),
        ...resetArea(),
        `give ${username} stone_pickaxe`, `give ${username} stone_shovel`,
        `give ${username} water_bucket`, `give ${username} lava_bucket`, `give ${username} dirt 16`,
        `tp ${username} ${x + 0.5} ${GROUND} ${z + 0.5} ${yaw} 0`,
      ],
      details: { start: { x, z, yaw } },
    };
  },
  start: (companion) => companion.cobbleGenerator({ harvest: HARVEST }),
  async verify({ server, username, goal }) {
    const memory = goal?.memory;
    if (!memory?.device) return { pass: false, details: { reason: 'no_site' } };
    const d = createCobbleGenerator(memory.device.anchor, memory.device.facing);
    // A cobblestone mined just before the end needs a moment to come back.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const c = d.cells;
    const blocks = {
      lava: await testBlock(server, c.lava, 'minecraft:lava[level=0]'),
      water: await testBlock(server, c.water, 'minecraft:water[level=0]'),
      pit: await testBlock(server, c.pitBottom, 'minecraft:water'),
      cobble: await testBlock(server, c.cobble, 'minecraft:cobblestone'),
    };
    const cobblestone = await countOnPlayer(server, username, 'minecraft:cobblestone');
    const pass = Object.values(blocks).every(Boolean) && cobblestone >= HARVEST && memory.regenerated >= HARVEST;
    return { pass, details: { device: { anchor: d.anchor, facing: d.facing }, blocks, cobblestone,
      harvested: memory.harvested, regenerated: memory.regenerated } };
  },
};

// The same generator with a hopper under C feeding a chest under S.
const cobbleGeneratorHopperFlat = {
  ...cobbleGeneratorFlat,
  name: 'cobblegen-hopper-flat',
  description: `As cobblegen-flat plus a hopper and a chest: the hopper under the cobblestone collects every drop; take ${HARVEST} cobblestone out of the chest.`,
  setup(options) {
    const base = cobbleGeneratorFlat.setup(options);
    const tp = base.commands.pop();
    base.commands.push(`give ${options.username} hopper`, `give ${options.username} chest`, tp);
    return base;
  },
  start: (companion) => companion.cobbleGenerator({ harvest: HARVEST, collector: true }),
  async verify(context) {
    const verdict = await cobbleGeneratorFlat.verify(context);
    const memory = context.goal?.memory;
    if (!memory?.device) return verdict;
    const d = createCobbleGenerator(memory.device.anchor, memory.device.facing, { collector: true });
    const parts = {};
    for (const part of d.parts) {
      parts[part.key] = await testBlock(context.server, part.position, `minecraft:${part.block}${part.facing ? `[facing=${part.facing}]` : ''}`);
    }
    return { pass: verdict.pass && Object.values(parts).every(Boolean), details: { ...verdict.details, parts } };
  },
};

const SMELT = 8;

const autoSmelterFlat = {
  name: 'smelter-flat',
  description: `Flat plains, handed chests, hoppers, a furnace, ${SMELT} raw iron and coal; build a hopper-fed furnace and take ${SMELT} iron ingots out of its output chest.`,
  serverProperties: cobbleGeneratorFlat.serverProperties,
  timeoutMs: 6 * 60 * 1000,
  setup({ username, rng, difficulty = 'peaceful' }) {
    const x = Math.round((rng() - 0.5) * 16);
    const z = Math.round((rng() - 0.5) * 16);
    const yaw = Math.round(rng() * 360) - 180;
    return {
      commands: [
        ...commonSetup(username, difficulty),
        ...resetArea(),
        `give ${username} stone_pickaxe`, `give ${username} stone_shovel`, `give ${username} chest 3`,
        `give ${username} hopper 3`, `give ${username} furnace`, `give ${username} raw_iron ${SMELT}`, `give ${username} coal 1`,
        `tp ${username} ${x + 0.5} ${GROUND} ${z + 0.5} ${yaw} 0`,
      ],
      details: { start: { x, z, yaw } },
    };
  },
  start: (companion) => companion.autoSmelter({ count: SMELT }),
  async verify({ server, username, goal }) {
    const memory = goal?.memory;
    if (!memory?.device) return { pass: false, details: { reason: 'no_site' } };
    const d = createAutoSmelter(memory.device.anchor, memory.device.facing);
    const parts = {};
    for (const part of d.parts) {
      let ok = false;
      for (const name of part.accept || [part.block]) {
        ok = ok || await testBlock(server, part.position, `minecraft:${name}${part.facing ? `[facing=${part.facing}]` : ''}`);
      }
      parts[part.key] = ok;
    }
    const ingots = await countOnPlayer(server, username, 'minecraft:iron_ingot');
    const pass = Object.values(parts).every(Boolean) && ingots >= SMELT;
    return { pass, details: { device: { anchor: d.anchor, facing: d.facing }, parts, ingots, taken: memory.taken } };
  },
};

const CANE = 4;

// Random ticks are sped up (sugar cane otherwise grows one block every ~15 minutes).
const caneFarmFlat = {
  name: 'canefarm-flat',
  description: `Flat plains, handed a piston, an observer, redstone, one sugar cane, a water bucket and dirt; build an observer sugar cane column and collect ${CANE} cane it harvests by itself.`,
  serverProperties: cobbleGeneratorFlat.serverProperties,
  timeoutMs: 8 * 60 * 1000,
  setup({ username, rng, difficulty = 'peaceful' }) {
    const x = Math.round((rng() - 0.5) * 16);
    const z = Math.round((rng() - 0.5) * 16);
    const yaw = Math.round(rng() * 360) - 180;
    return {
      commands: [
        ...commonSetup(username, difficulty),
        'gamerule randomTickSpeed 200',
        ...resetArea(),
        `give ${username} stone_pickaxe`, `give ${username} stone_shovel`, `give ${username} piston`,
        `give ${username} observer`, `give ${username} redstone`, `give ${username} sugar_cane`,
        `give ${username} water_bucket`, `give ${username} dirt 4`,
        `tp ${username} ${x + 0.5} ${GROUND} ${z + 0.5} ${yaw} 0`,
      ],
      details: { start: { x, z, yaw } },
    };
  },
  start: (companion) => companion.caneFarm({ count: CANE }),
  async verify({ server, username, goal }) {
    server.command('gamerule randomTickSpeed 3');
    const memory = goal?.memory;
    if (!memory?.farm) return { pass: false, details: { reason: 'no_site' } };
    const f = createCaneFarm(memory.farm.anchor, memory.farm.facing);
    const parts = {};
    for (const part of f.parts) {
      let ok = false;
      for (const name of part.accept || [part.block]) {
        ok = ok || await testBlock(server, part.position, `minecraft:${name}${part.facing ? `[facing=${part.facing}]` : ''}`);
      }
      parts[part.key] = ok;
    }
    parts.water = await testBlock(server, f.cells.water, 'minecraft:water[level=0]');
    const cane = await countOnPlayer(server, username, 'minecraft:sugar_cane');
    const pass = Object.values(parts).every(Boolean) && cane >= CANE;
    return { pass, details: { farm: { anchor: f.anchor, facing: f.facing }, parts, cane,
      harvested: memory.harvested, harvests: memory.harvests } };
  },
};

const MOB_DROP_COUNT = 4;

// The farm reaches 39 blocks down and about 33 out from its start; refill the rock each run.
function resetUnderground() {
  const commands = [];
  for (let y = GROUND - 44; y < GROUND - 4; y += 3) commands.push(`fill -48 ${y} -48 48 ${Math.min(y + 2, GROUND - 5)} 48 stone`);
  commands.push(`fill -48 ${GROUND - 4} -48 48 ${GROUND - 2} 48 dirt`, `fill -48 ${GROUND - 1} -48 48 ${GROUND - 1} 48 grass_block`);
  for (let y = GROUND; y < GROUND + 9; y += 3) commands.push(`fill -48 ${y} -48 48 ${y + 2} 48 air`);
  return commands;
}

// Easy difficulty at a fixed noon: the surface stays too bright to spawn
// anything, so every mob comes from the farm's dark spawning floor.
const mobFarmFlat = {
  name: 'mobfarm-flat',
  description: `Flat plains on solid stone, easy difficulty at noon, handed an iron pickaxe, 4 water buckets, a hopper and a chest; dig an underground dark-room mob farm and collect ${MOB_DROP_COUNT} mob drops from it.`,
  // A world of its own without mineshafts: mobs spawned in any other dark
  // tunnel fill the hostile mob cap, and one corridor ran past the alcove.
  serverProperties: {
    ...cobbleGeneratorFlat.serverProperties, 'level-name': 'mobfarm-solid',
    'generator-settings': JSON.stringify({ ...FLAT_GENERATOR, structure_overrides: [] }),
  },
  defaultDifficulty: 'easy',
  timeoutMs: 25 * 60 * 1000,
  setup({ username, rng, difficulty = 'easy' }) {
    const x = Math.round((rng() - 0.5) * 16);
    const z = Math.round((rng() - 0.5) * 16);
    const yaw = Math.round(rng() * 360) - 180;
    return {
      commands: [
        ...commonSetup(username, difficulty),
        ...resetUnderground(),
        // Nothing spawns within 24 blocks of the world spawn: keep it well away from the farm.
        'gamerule spawnRadius 0', `setworldspawn 0 ${GROUND} 120`,
        'kill @e[type=item]', 'gamerule doMobSpawning true',
        `give ${username} iron_pickaxe`, `give ${username} iron_shovel`, `give ${username} water_bucket 4`,
        `give ${username} hopper`, `give ${username} chest`, `give ${username} bread 16`,
        `tp ${username} ${x + 0.5} ${GROUND} ${z + 0.5} ${yaw} 0`,
      ],
      details: { start: { x, z, yaw } },
    };
  },
  start: (companion) => companion.mobFarm({ count: MOB_DROP_COUNT }),
  async verify({ server, username, goal }) {
    const memory = goal?.memory;
    if (!memory?.farm) return { pass: false, details: { reason: 'no_site' } };
    const f = createMobFarm(memory.farm.anchor, memory.farm.facing);
    // Where the monsters are: on the spawning floor, or anywhere else in the world.
    const count = async (selector) => {
      const match = await server.query(`execute if entity ${selector}`, /Test (passed|failed)(?:, count: (\d+))?/);
      return match[2] ? Number(match[2]) : 0;
    };
    const a = f.anchor;
    const monsters = {
      all: await count('@e[type=#minecraft:skeletons]') + await count('@e[type=zombie]') + await count('@e[type=creeper]') + await count('@e[type=spider]'),
      floor: await count(`@e[type=!player,type=!item,x=${a.x - 10},y=${f.levels.feet - 1},z=${a.z - 10},dx=20,dy=3,dz=20]`),
      shaft: await count(`@e[type=!player,type=!item,x=${a.x},y=${f.levels.bottom},z=${a.z},dx=0,dy=${f.levels.feet - f.levels.bottom - 2},dz=0]`),
    };
    server.command('gamerule doMobSpawning false');
    const parts = {};
    for (const part of f.parts) {
      parts[part.key] = await testBlock(server, part.position, `minecraft:${part.block}${part.facing ? `[facing=${part.facing}]` : ''}`);
    }
    for (const [i, w] of f.water.entries()) parts[`water${i}`] = await testBlock(server, w, 'minecraft:water[level=0]');
    const drops = {};
    for (const item of MOB_DROPS) drops[item] = await countOnPlayer(server, username, `minecraft:${item}`);
    const total = Object.values(drops).reduce((a, b) => a + b, 0);
    const pass = Object.values(parts).every(Boolean) && total >= MOB_DROP_COUNT;
    return { pass, details: { farm: { anchor: f.anchor, facing: f.facing }, parts, drops, total, taken: memory.taken, monsters } };
  },
};

const CARPETS = 8;

const carpetDuperFlat = {
  name: 'carpetdupe-flat',
  description: `Flat plains, handed a sticky piston, 2 slime blocks, a dead coral fan, one white carpet and a stone button; build a carpet duplicator and press it until ${CARPETS} new carpets are on the player.`,
  serverProperties: cobbleGeneratorFlat.serverProperties,
  timeoutMs: 6 * 60 * 1000,
  setup({ username, rng, difficulty = 'peaceful' }) {
    const x = Math.round((rng() - 0.5) * 16);
    const z = Math.round((rng() - 0.5) * 16);
    const yaw = Math.round(rng() * 360) - 180;
    return {
      commands: [
        ...commonSetup(username, difficulty),
        ...resetArea(),
        `give ${username} stone_pickaxe`, `give ${username} sticky_piston`, `give ${username} slime_block 2`,
        `give ${username} dead_tube_coral_fan`, `give ${username} white_carpet`, `give ${username} stone_button`,
        `tp ${username} ${x + 0.5} ${GROUND} ${z + 0.5} ${yaw} 0`,
      ],
      details: { start: { x, z, yaw } },
    };
  },
  start: (companion) => companion.carpetDuper({ count: CARPETS }),
  async verify({ server, username, goal }) {
    const memory = goal?.memory;
    if (!memory?.device) return { pass: false, details: { reason: 'no_site' } };
    const d = createCarpetDuper(memory.device.anchor, memory.device.facing);
    const parts = {};
    for (const part of d.parts) {
      parts[part.key] = await testBlock(server, part.position, `minecraft:${part.block}${part.facing ? `[facing=${part.facing}]` : ''}`);
    }
    const carpets = await countOnPlayer(server, username, 'minecraft:white_carpet');
    const pass = Object.values(parts).every(Boolean) && carpets >= CARPETS;
    return { pass, details: { device: { anchor: d.anchor, facing: d.facing }, parts, carpets, presses: memory.presses } };
  },
};

const CATCHES = 5;
const FISH = ['cod', 'salmon', 'tropical_fish', 'pufferfish'];

const fishingFlat = {
  name: 'fishing-flat',
  description: `Flat plains, handed a fishing rod, a shovel and 2 water buckets; dig a 2x2 pond, fill it and fish until ${CATCHES} catches are on the player.`,
  serverProperties: cobbleGeneratorFlat.serverProperties,
  timeoutMs: 8 * 60 * 1000,
  serverDataPacks: fishingDataPacks,
  initialize({ bot, server, username, state, write }) {
    state.fishingEvidence = installFishingEvidence({ bot, server, username, write });
  },
  async dispose({ state }) { await state.fishingEvidence?.dispose(); },
  setup({ username, rng, difficulty = 'peaceful' }) {
    const x = Math.round((rng() - 0.5) * 16);
    const z = Math.round((rng() - 0.5) * 16);
    const yaw = Math.round(rng() * 360) - 180;
    return {
      commands: [
        ...commonSetup(username, difficulty),
        ...fishingSetup(username),
        ...resetArea(),
        `give ${username} fishing_rod`, `give ${username} stone_shovel`, `give ${username} water_bucket 2`,
        `tp ${username} ${x + 0.5} ${GROUND} ${z + 0.5} ${yaw} 0`,
      ],
      details: { start: { x, z, yaw } },
    };
  },
  start: (companion) => companion.fishing({ count: CATCHES }),
  async verify({ server, username, goal, state }) {
    const memory = goal?.memory;
    if (!memory?.pond) return { pass: false, details: { reason: 'no_site' } };
    const p = createFishPond(memory.pond.anchor, memory.pond.facing);
    const water = {};
    for (const [i, c] of p.pond.entries()) water[`pond${i}`] = await testBlock(server, c, 'minecraft:water[level=0]');
    const fish = {};
    for (const item of FISH) fish[item] = await countOnPlayer(server, username, `minecraft:${item}`);
    const production = await state?.fishingEvidence?.verify(memory.catches, CATCHES);
    const pass = Object.values(water).every(Boolean) && production?.pass === true;
    return { pass, details: { pond: { anchor: p.anchor, facing: p.facing }, water, fish, catches: memory.catches,
      casts: memory.casts, caught: memory.caught, production: production || null } };
  },
};

const RAILS = 8;

const railDuperFlat = {
  name: 'raildupe-flat',
  description: `Flat plains, handed a sticky piston, 7 slime blocks, 6 cobblestone, a dead coral fan, a carpet, one rail and a stone button; build a rail duplicator and press it until ${RAILS} new rails are on the player.`,
  serverProperties: cobbleGeneratorFlat.serverProperties,
  timeoutMs: 8 * 60 * 1000,
  setup({ username, rng, difficulty = 'peaceful' }) {
    const x = Math.round((rng() - 0.5) * 16);
    const z = Math.round((rng() - 0.5) * 16);
    const yaw = Math.round(rng() * 360) - 180;
    return {
      commands: [
        ...commonSetup(username, difficulty),
        ...resetArea(),
        `give ${username} stone_pickaxe`, `give ${username} sticky_piston`, `give ${username} slime_block 7`,
        `give ${username} cobblestone 6`, `give ${username} dead_tube_coral_fan`, `give ${username} white_carpet`,
        `give ${username} rail`, `give ${username} stone_button`,
        `tp ${username} ${x + 0.5} ${GROUND} ${z + 0.5} ${yaw} 0`,
      ],
      details: { start: { x, z, yaw } },
    };
  },
  start: (companion) => companion.railDuper({ count: RAILS }),
  async verify({ server, username, goal }) {
    const memory = goal?.memory;
    if (!memory?.device) return { pass: false, details: { reason: 'no_site' } };
    const d = createRailDuper(memory.device.anchor, memory.device.facing);
    const parts = {};
    for (const part of d.parts) {
      parts[part.key] = await testBlock(server, part.position, `minecraft:${part.block}${part.facing ? `[facing=${part.facing}]` : ''}`);
    }
    const rails = await countOnPlayer(server, username, 'minecraft:rail');
    const carpets = await countOnPlayer(server, username, 'minecraft:white_carpet');
    const pass = Object.values(parts).every(Boolean) && rails >= RAILS;
    return { pass, details: { device: { anchor: d.anchor, facing: d.facing }, parts, rails, carpets, presses: memory.presses } };
  },
};

const IRON = 3;
const NIGHT_MS = 120000;

// Easy difficulty (the zombie needs it) at a fixed noon. The villagers and the
// zombie come from spawn eggs; the night they must sleep through is skipped
// with /time once the goal has moved them in, as a player sleeping would.
const ironFarmFlat = {
  name: 'ironfarm-flat',
  description: `Flat plains on solid stone, easy difficulty, handed an iron pickaxe, 3 beds, a torch, a stone slab, 2 ladders, 2 lava buckets, a zombie spawn egg and 3 villager spawn eggs; dig an underground iron farm, move in the zombie and the villagers, and pick up ${IRON} iron ingots from it.`,
  serverProperties: mobFarmFlat.serverProperties,
  defaultDifficulty: 'easy',
  timeoutMs: 20 * 60 * 1000,
  setup({ username, rng, difficulty = 'easy' }) {
    const x = Math.round((rng() - 0.5) * 16);
    const z = Math.round((rng() - 0.5) * 16);
    const yaw = Math.round(rng() * 360) - 180;
    return {
      commands: [
        ...commonSetup(username, difficulty),
        ...resetUnderground(),
        `give ${username} iron_pickaxe`, `give ${username} white_bed 3`, `give ${username} torch 2`,
        `give ${username} stone_slab`, `give ${username} ladder 2`, `give ${username} lava_bucket 2`,
        `give ${username} zombie_spawn_egg`, `give ${username} villager_spawn_egg 3`, `give ${username} bread 16`,
        `tp ${username} ${x + 0.5} ${GROUND} ${z + 0.5} ${yaw} 0`,
      ],
      details: { start: { x, z, yaw } },
    };
  },
  start: (companion) => companion.ironFarm({ count: IRON }),
  // Night falls once the villagers are in, and lasts until all three have
  // slept (a freshly spawned villager first has to claim its bed).
  async during({ server, goal, write }) {
    const memory = goal?.memory;
    if (!memory?.ready || memory.night === 'done' || memory.nightBusy) return;
    memory.nightBusy = true;
    try {
      if (!memory.night) {
        memory.night = Date.now();
        server.command('time set 13000');
        write('night', { phase: 'dusk' });
        return;
      }
      const match = await server.query('execute if entity @e[type=villager,nbt={Brain:{memories:{"minecraft:last_slept":{}}}}]',
        /Test (passed|failed)(?:, count: (\d+))?/);
      const slept = match[2] ? Number(match[2]) : 0;
      if (slept >= 3 || Date.now() - memory.night > NIGHT_MS) {
        memory.night = 'done';
        server.command('time set 1000');
        write('night', { phase: 'morning', slept });
      }
    } finally {
      memory.nightBusy = false;
    }
  },
  async verify({ server, username, goal }) {
    const memory = goal?.memory;
    if (!memory?.farm) return { pass: false, details: { reason: 'no_site' } };
    const f = createIronFarm(memory.farm.anchor, memory.farm.facing);
    const parts = {};
    for (const part of f.parts) {
      parts[part.key] = await testBlock(server, part.position, `minecraft:${part.block}${part.facing ? `[facing=${part.facing}]` : ''}`);
    }
    for (const [i, p] of f.lava.entries()) parts[`lava${i}`] = await testBlock(server, p, 'minecraft:lava[level=0]');
    parts.seal = await testBlock(server, f.cells.seal, 'minecraft:cobblestone');
    const count = async (selector) => {
      const match = await server.query(`execute if entity ${selector}`, /Test (passed|failed)(?:, count: (\d+))?/);
      return match[2] ? Number(match[2]) : 0;
    };
    const a = f.anchor;
    const villagers = await count(`@e[type=villager,x=${a.x - 4},y=${f.levels.feet - 2},z=${a.z - 4},dx=8,dy=4,dz=8]`);
    const zombies = await count(`@e[type=zombie,x=${a.x - 4},y=${f.levels.feet - 1},z=${a.z - 4},dx=8,dy=3,dz=8]`);
    const iron = await countOnPlayer(server, username, 'minecraft:iron_ingot');
    const pass = Object.values(parts).every(Boolean) && villagers >= 3 && zombies >= 1 && iron >= IRON;
    return { pass, details: { device: { anchor: f.anchor, facing: f.facing }, parts, villagers, zombies, iron, eggs: memory.eggs } };
  },
};

module.exports = { cobbleGeneratorFlat, cobbleGeneratorHopperFlat, autoSmelterFlat, caneFarmFlat, mobFarmFlat, carpetDuperFlat, fishingFlat, railDuperFlat, ironFarmFlat };
