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

// No ore in sight anywhere: iron only in veins around y=16, under the plain to
// the east where the staircase from home comes down. The bot must branch mine.
const IRON = [{ key: 'raw_iron', count: 12 }];
const branchMineIronFlat = {
  name: 'branch-mine-iron-flat',
  description: 'Empty inventory, peaceful, flat plains with trees; iron only in buried veins at y=15-16;'
    + ' store 12 raw iron in the home chest (staircase down, branch mine, back up).',
  serverProperties: materialsCobblegenFlat.serverProperties,
  timeoutMs: 45 * 60 * 1000,
  setup({ username, rng, difficulty = 'peaceful' }) {
    const trees = plantTrees(rng);
    const commands = [
      `difficulty ${difficulty}`,
      'gamerule doDaylightCycle false', 'gamerule doWeatherCycle false', 'gamerule doMobSpawning false',
      'gamerule doImmediateRespawn true', 'time set noon', 'weather clear',
      'kill @e[type=item]', 'kill @e[type=!player]',
      `clear ${username}`, `effect clear ${username}`, `gamemode survival ${username}`,
      ...resetArea(),
      ...trees.commands,
      `setblock ${CHEST.x} ${CHEST.y} ${CHEST.z} chest`,
      // Fill in the staircase, veins and tunnels of earlier runs.
      `fill 9 15 -8 60 59 2 stone`,
      `fill 40 14 -40 72 19 -8 stone`, `fill 40 14 -7 72 19 25 stone`,
      `fill 73 14 -40 105 19 -8 stone`, `fill 73 14 -7 105 19 25 stone`,
    ];
    const veins = [];
    for (let i = 0; i < 40; i += 1) {
      const x = 44 + Math.floor(rng() * 58);
      const z = -36 + Math.floor(rng() * 58);
      veins.push({ x, z });
      commands.push(`fill ${x} 15 ${z} ${x + 1} 16 ${z + 1} iron_ore`);
    }
    commands.push(`tp ${username} 0.5 ${GROUND} 0.5 0 0`);
    return { commands, details: { trees: trees.trees.length, veins: veins.length } };
  },
  start: (companion) => companion.gatherMaterials({ chest: CHEST, stations: STATIONS, requirements: IRON }),
  async verify({ server }) {
    const contents = await chestContents(server, CHEST);
    const rawIron = contents.raw_iron || 0;
    return { pass: rawIron >= 12, details: { chest: contents, required: IRON } };
  },
};

// `fill` takes at most 32768 blocks: a box split into 32-block cubes.
function fillBox(from, to, block) {
  const out = [];
  for (let x = from.x; x <= to.x; x += 32) {
    for (let y = from.y; y <= to.y; y += 32) {
      for (let z = from.z; z <= to.z; z += 32) {
        out.push(`fill ${x} ${y} ${z} ${Math.min(x + 31, to.x)} ${Math.min(y + 31, to.y)} ${Math.min(z + 31, to.z)} ${block}`);
      }
    }
  }
  return out;
}

// A deep mine from nothing: iron veins at y=15-16 for the iron pickaxe, and at
// the mine level (y=-54..-52, deepslate below y=0 like a real world) a mix of
// redstone, lapis, gold, coal and a few diamond veins on every side of home,
// with sealed lava pockets the tunnel must not open.
const DEEP = { minX: -100, maxX: 220, minZ: -100, maxZ: 100 };
// Like the plain flat world, but deepslate below y=0 as in a real one.
const DEEP_GENERATOR = { ...FLAT_GENERATOR, layers: [
  { block: 'minecraft:bedrock', height: 1 },
  { block: 'minecraft:deepslate', height: 64 },
  { block: 'minecraft:stone', height: 59 },
  { block: 'minecraft:dirt', height: 3 },
  { block: 'minecraft:grass_block', height: 1 },
] };
const DEEP_PROPERTIES = { ...materialsCobblegenFlat.serverProperties, 'generator-settings': JSON.stringify(DEEP_GENERATOR) };
// Only what earlier runs dug out is filled back in (a fresh world has nothing
// to fill, so setup stays light however wide the mining area is). Ore and
// depots an earlier run left behind stay: more of the same does no harm.
const REFILL = { from: { x: -110, z: -110 }, to: { x: 230, z: 110 } };
function deepWorld({ username, rng, difficulty, diamonds }) {
  const trees = plantTrees(rng);
  const commands = [
    `difficulty ${difficulty}`,
    'gamerule doDaylightCycle false', 'gamerule doWeatherCycle false', 'gamerule doMobSpawning false',
    'gamerule doImmediateRespawn true', 'gamerule doFireTick false', 'time set noon', 'weather clear',
    'kill @e[type=item]', 'kill @e[type=!player]',
    `clear ${username}`, `effect clear ${username}`, `gamemode survival ${username}`,
    ...resetArea(),
    ...trees.commands,
    `setblock ${CHEST.x} ${CHEST.y} ${CHEST.z} chest`,
    // Fill in the staircases, depots, veins and tunnels of earlier runs.
    ...fillBox({ ...REFILL.from, y: 0 }, { ...REFILL.to, y: 59 }, 'stone replace air'),
    ...fillBox({ ...REFILL.from, y: -60 }, { ...REFILL.to, y: -1 }, 'deepslate replace air'),
  ];
  const at = () => ({ x: DEEP.minX + Math.floor(rng() * (DEEP.maxX - DEEP.minX)),
    z: DEEP.minZ + Math.floor(rng() * (DEEP.maxZ - DEEP.minZ)) });
  const counts = { iron: 0, lava: 0 };
  for (let i = 0; i < 40; i += 1, counts.iron += 1) {
    const x = 44 + Math.floor(rng() * 58);
    const z = -36 + Math.floor(rng() * 58);
    commands.push(`fill ${x} 15 ${z} ${x + 1} 16 ${z + 1} iron_ore`);
  }
  for (let i = 0; i < 160; i += 1, counts.lava += 1) {
    const p = at();
    commands.push(`setblock ${p.x} -53 ${p.z} lava`);
  }
  const veins = [['deepslate_redstone_ore', 600], ['deepslate_lapis_ore', 240], ['deepslate_gold_ore', 240],
    ['deepslate_coal_ore', 120], ['deepslate_diamond_ore', diamonds]];
  for (const [ore, n] of veins) {
    counts[ore] = n;
    for (let i = 0; i < n; i += 1) {
      const p = at();
      commands.push(`fill ${p.x} -54 ${p.z} ${p.x + 1} -53 ${p.z + 1} ${ore} replace deepslate`);
    }
  }
  commands.push(`tp ${username} 0.5 ${GROUND} 0.5 0 0`);
  // The mine runs past view distance: its chunks are kept loaded so the fills land.
  // Forceloading takes at most 256 chunks a command: two strips.
  return { prepare: [`forceload add ${REFILL.from.x} ${REFILL.from.z} ${REFILL.to.x} 0`,
    `forceload add ${REFILL.from.x} 1 ${REFILL.to.x} ${REFILL.to.z}`], prepareMs: 15000, commands, details: { trees: trees.trees.length, ...counts } };
}

const LOOT = ['redstone', 'lapis_lazuli', 'raw_gold', 'coal', 'raw_iron'];

const REDSTONE = [{ key: 'redstone', count: 16 }];
const branchMineRedstoneFlat = {
  name: 'branch-mine-redstone-flat',
  description: 'Empty inventory, peaceful, flat plains with trees; iron only in veins at y=15-16, redstone and other'
    + ' ore only in deepslate veins at y=-54..-53 among sealed lava pockets; store 16 redstone in the home chest'
    + ' (stone tools, iron at y=16, iron pickaxe, staircase on down to y=-53, back up).',
  serverProperties: DEEP_PROPERTIES,
  timeoutMs: 75 * 60 * 1000,
  setup: ({ username, rng, difficulty = 'peaceful' }) => deepWorld({ username, rng, difficulty, diamonds: 60 }),
  start: (companion) => companion.gatherMaterials({ chest: CHEST, stations: STATIONS, requirements: REDSTONE }),
  async verify({ server }) {
    const contents = await chestContents(server, CHEST);
    return { pass: (contents.redstone || 0) >= 16, details: { chest: contents, required: REDSTONE } };
  },
};

// Mining for diamonds the way a player does: whatever other ore shows in the
// tunnel walls comes home too. Passes with the diamonds and some other ore in the chest.
const DIAMONDS = [{ key: 'diamond', count: 3 }];
const branchMineDiamondFlat = {
  name: 'branch-mine-diamond-flat',
  description: 'Empty inventory, peaceful, same deep world; store 3 diamonds in the home chest, and bring home'
    + ' the other ore met on the way (redstone, lapis, gold, coal).',
  serverProperties: DEEP_PROPERTIES,
  timeoutMs: 90 * 60 * 1000,
  setup: ({ username, rng, difficulty = 'peaceful' }) => deepWorld({ username, rng, difficulty, diamonds: 240 }),
  start: (companion) => companion.gatherMaterials({ chest: CHEST, stations: STATIONS, requirements: DIAMONDS }),
  async verify({ server }) {
    const contents = await chestContents(server, CHEST);
    const loot = LOOT.filter((name) => (contents[name] || 0) > 0);
    return { pass: (contents.diamond || 0) >= 3 && loot.length > 0, details: { chest: contents, loot, required: DIAMONDS } };
  },
};

module.exports = { materialsCobblegenFlat, branchMineIronFlat, branchMineRedstoneFlat, branchMineDiamondFlat, chestContents };
