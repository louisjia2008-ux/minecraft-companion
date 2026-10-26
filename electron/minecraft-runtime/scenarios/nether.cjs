/* global module, require */
'use strict';
// Nether trip with the materials handed over: build a portal on flat ground,
// go through, mine nether quartz near the arrival portal and come back.
// Judged by the server: quartz on the player and the player's dimension.

const { FLAT_GENERATOR, GROUND } = require('./collectLogs.cjs');

const TARGET = 16;
const KIT = [
  ['obsidian', 10], ['cobblestone', 32], ['flint_and_steel', 1], ['iron_pickaxe', 1], ['iron_sword', 1],
  ['cooked_beef', 24], ['golden_helmet', 1],
];

async function countOnPlayer(server, username, item) {
  const match = await server.query(`clear ${username} ${item} 0`,
    new RegExp(`(?:Found (\\d+) matching item(?:\\(s\\)|s)? on player ${username}|No items were found on player ${username})`));
  return match[1] ? Number(match[1]) : 0;
}

async function playerDimension(server, username) {
  const match = await server.query(`data get entity ${username} Dimension`,
    /(?:has the following entity data: "minecraft:(\w+)"|(No entity was found))/, 5000);
  return match[1] || null;
}

const netherQuartzGiven = {
  name: 'nether-quartz-given',
  description: `Materials given (10 obsidian, flint and steel, iron tools, food, gold helmet); build a portal,
  mine ${TARGET} nether quartz in the nether and bring it back to the overworld.`,
  serverProperties: {
    'level-type': 'minecraft:flat', 'generator-settings': JSON.stringify(FLAT_GENERATOR),
    'level-seed': 20261022, difficulty: 'easy', 'allow-nether': true,
  },
  defaultDifficulty: 'easy',
  timeoutMs: 25 * 60 * 1000,
  setup({ username, run, rng, difficulty = 'easy' }) {
    // A fresh spot each run, far enough that the nether sides (1/8 scale) never share a portal.
    const angle = rng() * Math.PI * 2;
    const x = Math.round(Math.cos(angle) * 2500 * (run + 1));
    const z = Math.round(Math.sin(angle) * 2500 * (run + 1));
    return {
      commands: [
        `difficulty ${difficulty}`,
        'gamerule doDaylightCycle false', 'gamerule doWeatherCycle false', 'gamerule doMobSpawning true',
        'gamerule doImmediateRespawn true', 'gamerule keepInventory false', 'gamerule spawnRadius 0',
        'time set noon', 'weather clear',
        `execute in minecraft:overworld run tp ${username} ${x + 0.5} ${GROUND} ${z + 0.5}`,
        `execute in minecraft:overworld run setworldspawn ${x} ${GROUND} ${z + 10}`,
        `clear ${username}`, `effect clear ${username}`, `gamemode survival ${username}`,
        `effect give ${username} minecraft:instant_health 1 5`, `effect give ${username} minecraft:saturation 1 20`,
        ...KIT.map(([item, count]) => `give ${username} ${item} ${count}`),
      ],
      details: { start: { x, z } },
    };
  },
  start: (companion) => companion.netherQuartz({ count: TARGET }),
  async verify({ server, username, goal }) {
    const quartz = await countOnPlayer(server, username, 'quartz');
    const dimension = await playerDimension(server, username);
    const m = goal?.memory || {};
    const at = (p) => (p ? `${p.x},${p.y},${p.z}` : null);
    return {
      pass: quartz >= TARGET && dimension === 'overworld',
      details: { quartzOnServer: quartz, dimension, overworldPortal: at(m.overworldPortal), netherPortal: at(m.netherPortal) },
    };
  },
};

// ---- fortress and bastion ------------------------------------------------------

const EXPEDITION = { blazeRods: 6, witherSkulls: 1, trades: 10 };
const GOLD = 24;
// Gold helmets wear out in a fortress fight (77 durability): two spares keep piglins calm afterwards.
// Armour as a player takes it to a fortress: Protection IV, and Feather Falling
// on the boots. Without it a wither skeleton's swing or a hoglin's toss off a
// bridge, or a zombified piglin pack while swimming in lava, ended runs.
const PROTECTED = '[enchantments={protection:4,unbreaking:3}]';
const EXPEDITION_KIT = [
  ['obsidian', 10], ['cobblestone', 64], ['flint_and_steel', 1], ['diamond_pickaxe', 1],
  ['diamond_sword[enchantments={looting:3,sharpness:3}]', 1], ['shield', 1],
  [`golden_helmet${PROTECTED}`, 3], [`diamond_chestplate${PROTECTED}`, 1], [`diamond_leggings${PROTECTED}`, 1],
  ['diamond_boots[enchantments={protection:4,feather_falling:4,unbreaking:3}]', 1],
  ['cooked_beef', 32], ['golden_apple', 8], ['gold_ingot', GOLD],
  // Eight minutes each: four ran out half way through a 90-minute fortress hunt,
  // and eight ran out 84 minutes into the full chain.
  ['potion[potion_contents={potion:"minecraft:long_fire_resistance"}]', 12],
];

/** Where the nearest structure of a kind is, asked of the server from a nether point. */
async function locate(server, structure, x, z) {
  const match = await server.query(`execute in minecraft:the_nether positioned ${x} 64 ${z} run locate structure minecraft:${structure}`,
    /(?:The nearest minecraft:\w+ is at \[(-?\d+), ~, (-?\d+)\]|(Could not find))/, 60000);
  return match[3] ? null : { x: Number(match[1]), z: Number(match[2]) };
}

/**
 * Where the bot starts in the nether. `both`: between a fortress and a bastion
 * that lie close together, so the whole expedition fits in the time limit.
 * `fortress` / `bastion`: 60-110 blocks from one of them, in a random
 * direction. The bot is never told where they are: it has to see them in the
 * loaded chunks.
 */
async function pickExpeditionStart(server, rng, run, near) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const angle = rng() * Math.PI * 2;
    const r = 400 + rng() * 2600 + run * 300;
    const px = Math.round(Math.cos(angle) * r);
    const pz = Math.round(Math.sin(angle) * r);
    if (near !== 'both') {
      const target = await locate(server, near === 'fortress' ? 'fortress' : 'bastion_remnant', px, pz);
      if (!target) continue;
      const a = rng() * Math.PI * 2;
      const d = 60 + rng() * 50;
      return { [near]: target, nether: { x: Math.round(target.x + Math.cos(a) * d), z: Math.round(target.z + Math.sin(a) * d) }, attempt };
    }
    const fortress = await locate(server, 'fortress', px, pz);
    if (!fortress) continue;
    const bastion = await locate(server, 'bastion_remnant', fortress.x, fortress.z);
    if (!bastion) continue;
    const apart = Math.hypot(fortress.x - bastion.x, fortress.z - bastion.z);
    if (apart < 64 || apart > 400) continue;
    const jitter = () => Math.round((rng() - 0.5) * 60);
    const nether = { x: Math.round((fortress.x + bastion.x) / 2) + jitter(), z: Math.round((fortress.z + bastion.z) / 2) + jitter() };
    return { fortress, bastion, nether, attempt };
  }
  throw new Error(`no ${near === 'both' ? 'fortress and bastion close together' : near} found`);
}

function expeditionScenario({ name, near, targets, timeoutMs, experimental = false }) {
  const wants = [targets.blazeRods && `${targets.blazeRods} blaze rods`, targets.witherSkulls && `${targets.witherSkulls} wither skeleton skull`,
    targets.trades && `${targets.trades} piglin trades`].filter(Boolean).join(', ');
  return {
    name,
    description: `Expedition kit given (portal materials, Protection IV diamond armour + gold helmet, Feather Falling boots, looting sword, fire resistance, golden apples,
  ${GOLD} gold); start near ${near === 'both' ? 'a fortress and a bastion' : `a ${near}`} (not told to the bot); ${wants}; then come home.`,
    serverProperties: {
      'level-type': 'minecraft:flat', 'generator-settings': JSON.stringify(FLAT_GENERATOR),
      'level-seed': 20261023, difficulty: 'easy', 'allow-nether': true,
    },
    defaultDifficulty: 'easy',
    timeoutMs,
    ...(experimental ? { experimental: true } : {}),
    async prepare({ username, run, rng, difficulty = 'easy', server }) {
      const pick = await pickExpeditionStart(server, rng, run, near);
      const x = pick.nether.x * 8;
      const z = pick.nether.z * 8;
      return {
        commands: [
          `difficulty ${difficulty}`,
          'gamerule doDaylightCycle false', 'gamerule doWeatherCycle false', 'gamerule doMobSpawning true',
          'gamerule doImmediateRespawn true', 'gamerule keepInventory false', 'gamerule spawnRadius 0',
          'time set noon', 'weather clear',
          `execute in minecraft:overworld run tp ${username} ${x + 0.5} ${GROUND} ${z + 0.5}`,
          `execute in minecraft:overworld run setworldspawn ${x} ${GROUND} ${z + 10}`,
          `clear ${username}`, `effect clear ${username}`, `gamemode survival ${username}`,
          `effect give ${username} minecraft:instant_health 1 5`, `effect give ${username} minecraft:saturation 1 20`,
          ...EXPEDITION_KIT.map(([item, count]) => `give ${username} ${item} ${count}`),
        ],
        details: { start: { x, z }, netherStart: pick.nether, fortress: pick.fortress || null, bastion: pick.bastion || null },
      };
    },
    start: (companion) => companion.netherExpedition(targets),
    async verify({ server, username, goal }) {
      const rods = await countOnPlayer(server, username, 'blaze_rod');
      const skulls = await countOnPlayer(server, username, 'wither_skeleton_skull');
      const gold = await countOnPlayer(server, username, 'gold_ingot');
      const dimension = await playerDimension(server, username);
      const m = goal?.memory || {};
      const at = (p) => (p ? `${p.x},${p.y},${p.z}` : null);
      const trades = m.trades || 0;
      return {
        pass: rods >= targets.blazeRods && skulls >= targets.witherSkulls && trades >= targets.trades
          && gold <= GOLD - targets.trades && dimension === 'overworld',
        details: { rodsOnServer: rods, skullsOnServer: skulls, goldOnServer: gold, trades, barter: m.barter, kills: m.kills,
          dimension, fortress: at(m.fortress), bastion: at(m.bastion), visited: m.visited, netherPortal: at(m.netherPortal) },
      };
    },
  };
}

// A wither skeleton drops its skull 5.5% of the time with Looting III: about 18
// kills for one skull, and a fortress yields one every two or three minutes.
// 45 minutes ended runs that played well but rolled no skull (13 kills, none).
// Experimental (left out of the full regression run): both still pass only some
// runs. The fortress hunt passed 3 of the last 5 (skull luck, wither skeleton
// knockback off bridges); the full chain has not passed yet on seed 3.
const netherStructuresGiven = expeditionScenario({ name: 'nether-structures-given', near: 'both', targets: EXPEDITION,
  timeoutMs: 120 * 60 * 1000, experimental: true });
const netherFortressGiven = expeditionScenario({ name: 'nether-fortress-given', near: 'fortress',
  targets: { blazeRods: EXPEDITION.blazeRods, witherSkulls: EXPEDITION.witherSkulls, trades: 0 }, timeoutMs: 90 * 60 * 1000,
  experimental: true });
const netherBastionGiven = expeditionScenario({ name: 'nether-bastion-given', near: 'bastion',
  targets: { blazeRods: 0, witherSkulls: 0, trades: EXPEDITION.trades }, timeoutMs: 30 * 60 * 1000 });

module.exports = { netherQuartzGiven, netherStructuresGiven, netherFortressGiven, netherBastionGiven };
