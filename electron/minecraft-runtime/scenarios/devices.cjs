/* global module, require, setTimeout */
'use strict';
// Farm-device scenarios, first stage: the materials are handed over so only
// building and running the device is tested. Judged by the server: the liquid
// sources in their cells and cobblestone mined from the generator on the player.

const { FLAT_GENERATOR, GROUND, resetArea } = require('./collectLogs.cjs');
const { createCobbleGenerator } = require('../core/blueprints/cobbleGenerator');

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

module.exports = { cobbleGeneratorFlat };
