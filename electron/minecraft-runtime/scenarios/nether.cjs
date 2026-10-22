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

module.exports = { netherQuartzGiven };
