/* global module, require */
'use strict';
// Gathering a machine's materials from an empty inventory into the home chest.
// The first list is the cobblestone generator's: a water bucket, a lava bucket
// and ten cobblestone, which takes trees, stone tools, coal, iron, a furnace,
// two buckets and two liquid sources. Judged by the chest contents on the server.

const { FLAT_GENERATOR, GROUND, plantTrees, resetArea } = require('./collectLogs.cjs');

const CHEST = { x: 0, y: GROUND, z: -3 };
const STATIONS = { crafting_table: { x: 1, y: GROUND, z: -3 }, furnace: { x: 2, y: GROUND, z: -3 } };
const COBBLEGEN = [{ key: 'water_bucket', count: 1 }, { key: 'lava_bucket', count: 1 }, { key: 'cobblestone', count: 10 }];

/** Item counts in a container, read with `data get block`. */
async function chestContents(server, p) {
  const match = await server.query(`data get block ${p.x} ${p.y} ${p.z} Items`,
    /(has the following block data: .*|Found no elements matching Items|is not a block entity)/, 5000);
  const counts = {};
  for (const entry of match[1].match(/\{[^{}]*\}/g) || []) {
    const id = /id: "minecraft:([a-z0-9_]+)"/.exec(entry)?.[1];
    const count = Number(/count: (\d+)/.exec(entry)?.[1] ?? 1);
    if (id) counts[id] = (counts[id] || 0) + count;
  }
  return counts;
}

const materialsCobblegenFlat = {
  name: 'materials-cobblegen-flat',
  description: 'Empty inventory, peaceful, flat plains with trees, surface iron and coal, one water and one lava source;'
    + ' store a water bucket, a lava bucket and 10 cobblestone in the home chest.',
  serverProperties: {
    'level-type': 'minecraft:flat', 'generator-settings': JSON.stringify(FLAT_GENERATOR),
    'level-seed': 20261019, difficulty: 'peaceful',
  },
  timeoutMs: 30 * 60 * 1000,
  setup({ username, rng, difficulty = 'peaceful' }) {
    const trees = plantTrees(rng);
    const commands = [
      `difficulty ${difficulty}`,
      'gamerule doDaylightCycle false', 'gamerule doWeatherCycle false', 'gamerule doMobSpawning false',
      'gamerule doImmediateRespawn true', 'gamerule doFireTick false', 'time set noon', 'weather clear',
      'kill @e[type=item]', 'kill @e[type=!player]',
      `clear ${username}`, `effect clear ${username}`, `gamemode survival ${username}`,
      ...resetArea(),
      ...trees.commands,
      // Home: an empty chest; the table and furnace spots next to it stay free.
      `setblock ${CHEST.x} ${CHEST.y} ${CHEST.z} chest`,
      // Ore lying on the surface, east of the trees: 9 iron, 6 coal.
      `fill 21 ${GROUND} -1 23 ${GROUND} 1 iron_ore`,
      `fill 21 ${GROUND} 3 23 ${GROUND} 4 coal_ore`,
      // One water source and one lava source, each in a stone-lined pit in the ground, west of the trees.
      `fill -22 ${GROUND - 2} -4 -20 ${GROUND - 1} -2 stone`, `setblock -21 ${GROUND - 1} -3 water`,
      `fill -22 ${GROUND - 2} 8 -20 ${GROUND - 1} 10 stone`, `setblock -21 ${GROUND - 1} 9 lava`,
      `tp ${username} 0.5 ${GROUND} 0.5 0 0`,
    ];
    return { commands, details: { trees: trees.trees.length } };
  },
  start: (companion) => companion.gatherMaterials({ chest: CHEST, stations: STATIONS, requirements: COBBLEGEN }),
  async verify({ server }) {
    const contents = await chestContents(server, CHEST);
    const have = {
      water_bucket: contents.water_bucket || 0,
      lava_bucket: contents.lava_bucket || 0,
      cobblestone: (contents.cobblestone || 0) + (contents.cobbled_deepslate || 0),
    };
    const pass = COBBLEGEN.every((r) => have[r.key] >= r.count);
    return { pass, details: { chest: contents, required: COBBLEGEN } };
  },
};

module.exports = { materialsCobblegenFlat, chestContents };
