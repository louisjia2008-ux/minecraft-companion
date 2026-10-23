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
const EXPEDITION_KIT = [
  ['obsidian', 10], ['cobblestone', 64], ['flint_and_steel', 1], ['diamond_pickaxe', 1],
  ['diamond_sword[enchantments={looting:3,sharpness:3}]', 1], ['shield', 1],
  ['golden_helmet', 1], ['diamond_chestplate', 1], ['diamond_leggings', 1], ['diamond_boots', 1],
  ['cooked_beef', 32], ['golden_apple', 8], ['gold_ingot', GOLD],
  ['potion[potion_contents={potion:"minecraft:long_fire_resistance"}]', 4],
];

/** Where the nearest structure of a kind is, asked of the server from a nether point. */
async function locate(server, structure, x, z) {
  const match = await server.query(`execute in minecraft:the_nether positioned ${x} 64 ${z} run locate structure minecraft:${structure}`,
    /(?:The nearest minecraft:\w+ is at \[(-?\d+), ~, (-?\d+)\]|(Could not find))/, 60000);
  return match[3] ? null : { x: Number(match[1]), z: Number(match[2]) };
}

/**
 * A nether start between a fortress and a bastion that lie close together, so a
 * real expedition (find both, walk between them) fits in an hour. The bot is
 * never told where they are: it has to see them from the loaded chunks.
 */
async function pickExpeditionStart(server, rng, run) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const angle = rng() * Math.PI * 2;
    const r = 400 + rng() * 2600 + run * 300;
    const px = Math.round(Math.cos(angle) * r);
    const pz = Math.round(Math.sin(angle) * r);
    const fortress = await locate(server, 'fortress', px, pz);
    if (!fortress) continue;
    const bastion = await locate(server, 'bastion_remnant', fortress.x, fortress.z);
    if (!bastion) continue;
    const apart = Math.hypot(fortress.x - bastion.x, fortress.z - bastion.z);
    if (apart < 64 || apart > 320) continue;
    const jitter = () => Math.round((rng() - 0.5) * 60);
    const nether = { x: Math.round((fortress.x + bastion.x) / 2) + jitter(), z: Math.round((fortress.z + bastion.z) / 2) + jitter() };
    return { fortress, bastion, nether, attempt };
  }
  throw new Error('no fortress and bastion close together');
}

const netherStructuresGiven = {
  name: 'nether-structures-given',
  description: `Expedition kit given (portal materials, diamond armour + gold helmet, looting sword, fire resistance, golden apples,
  ${GOLD} gold); find a fortress (${EXPEDITION.blazeRods} blaze rods, ${EXPEDITION.witherSkulls} wither skeleton skull) and a bastion
  (${EXPEDITION.trades} piglin trades), then come home. Structures are not told to the bot.`,
  serverProperties: {
    'level-type': 'minecraft:flat', 'generator-settings': JSON.stringify(FLAT_GENERATOR),
    'level-seed': 20261023, difficulty: 'easy', 'allow-nether': true,
  },
  defaultDifficulty: 'easy',
  timeoutMs: 75 * 60 * 1000,
  async setup({ username, run, rng, difficulty = 'easy', server }) {
    const pick = await pickExpeditionStart(server, rng, run);
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
      details: { start: { x, z }, netherStart: pick.nether, fortress: pick.fortress, bastion: pick.bastion },
    };
  },
  start: (companion) => companion.netherExpedition(EXPEDITION),
  async verify({ server, username, goal }) {
    const rods = await countOnPlayer(server, username, 'blaze_rod');
    const skulls = await countOnPlayer(server, username, 'wither_skeleton_skull');
    const gold = await countOnPlayer(server, username, 'gold_ingot');
    const dimension = await playerDimension(server, username);
    const m = goal?.memory || {};
    const at = (p) => (p ? `${p.x},${p.y},${p.z}` : null);
    const trades = m.trades || 0;
    return {
      pass: rods >= EXPEDITION.blazeRods && skulls >= EXPEDITION.witherSkulls && trades >= EXPEDITION.trades
        && gold <= GOLD - EXPEDITION.trades && dimension === 'overworld',
      details: { rodsOnServer: rods, skullsOnServer: skulls, goldOnServer: gold, trades, barter: m.barter, kills: m.kills,
        dimension, fortress: at(m.fortress), bastion: at(m.bastion), visited: m.visited, netherPortal: at(m.netherPortal) },
    };
  },
};

module.exports = { netherQuartzGiven, netherStructuresGiven };
