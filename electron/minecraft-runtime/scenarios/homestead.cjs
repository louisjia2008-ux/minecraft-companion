/* global module, require */
'use strict';
// The full chain from an empty inventory: gather, craft, mine, smelt, fight,
// hunt, build the starter house and use its furniture. Judged entirely by the
// server: blocks in the world, items on the player, chest contents and the
// player's respawn point.

const { FLAT_GENERATOR, GROUND, plantTrees, resetArea } = require('./collectLogs.cjs');
const { createStarterHouse } = require('../core/blueprints/starterHouse');

const GEAR = ['iron_sword', 'iron_pickaxe', 'shield'];

async function testBlock(server, p, predicate) {
  const match = await server.query(`execute if block ${p.x} ${p.y} ${p.z} ${predicate}`, /Test (passed|failed)/, 5000);
  return match[1] === 'passed';
}

async function countOnPlayer(server, username, item) {
  const match = await server.query(`clear ${username} ${item} 0`,
    new RegExp(`(?:Found (\\d+) matching item(?:\\(s\\)|s)? on player ${username}|No items were found on player ${username})`));
  return match[1] ? Number(match[1]) : 0;
}

async function verifyHomestead({ server, username, goal }) {
  const anchor = goal?.memory?.house?.anchor;
  if (!anchor) return { pass: false, details: { reason: 'no_site' } };
  const house = createStarterHouse(anchor);
  // Block tags only; cobbled deepslate also counts as wall stone.
  const accept = { cobblestone: ['minecraft:cobblestone', 'minecraft:cobbled_deepslate'], planks: ['#minecraft:planks'] };
  let placed = 0;
  for (const block of house.blocks) {
    for (const predicate of accept[block.family]) {
      if (await testBlock(server, block.position, predicate)) { placed += 1; break; }
    }
  }
  const f = house.furniture;
  const furniture = {
    crafting_table: await testBlock(server, f.crafting_table.position, 'minecraft:crafting_table'),
    furnace: await testBlock(server, f.furnace.position, 'minecraft:furnace'),
    chest: await testBlock(server, f.chest.position, 'minecraft:chest'),
    bed: await testBlock(server, f.bed.position, '#minecraft:beds') && await testBlock(server, f.bed.head, '#minecraft:beds'),
    door: await testBlock(server, f.door.position, '#minecraft:wooden_doors'),
    torches: (await Promise.all(f.torches.map((p) => testBlock(server, p, 'minecraft:torch')))).filter(Boolean).length,
  };
  const chestData = await server.query(`data get block ${f.chest.position.x} ${f.chest.position.y} ${f.chest.position.z} Items`,
    /(has the following block data: .*|Found no elements matching Items|is not a block entity)/, 5000);
  const chestUsed = /block data: \[\{/.test(chestData[1]);
  // Sleeping or using the bed sets the respawn point to the bed itself.
  const respawn = await server.query(`data get entity ${username} respawn.pos`,
    /(has the following entity data: .*|Found no elements matching respawn(?:\.pos)?|No entity was found)/, 5000);
  const pos = (respawn[1].match(/\[I;\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\]/) || []).slice(1).map(Number);
  const atBed = (p) => pos.length === 3 && pos[0] === p.x && pos[1] === p.y && pos[2] === p.z;
  const bedUsed = atBed(f.bed.position) || atBed(f.bed.head);
  const gear = {};
  for (const item of GEAR) gear[item] = await countOnPlayer(server, username, item);
  const tableUsed = goal.memory.verified.crafting_table;
  const furnaceUsed = goal.memory.verified.furnace;
  const pass = placed === house.blocks.length && furniture.crafting_table && furniture.furnace && furniture.chest
    && furniture.bed && furniture.door && chestUsed && bedUsed && tableUsed && furnaceUsed
    && GEAR.every((item) => gear[item] > 0);
  return {
    pass,
    details: {
      anchor, placed, total: house.blocks.length, furniture, chestUsed, bedUsed, respawn: pos, tableUsed, furnaceUsed, gear,
    },
  };
}

const living = (username, difficulty) => [
  `difficulty ${difficulty}`, 'gamerule doDaylightCycle true', 'gamerule doWeatherCycle false',
  'gamerule doMobSpawning true', 'gamerule doImmediateRespawn true', 'gamerule keepInventory false',
  'time set 0', 'weather clear', 'kill @e[type=item]',
  `clear ${username}`, `effect clear ${username}`, `gamemode survival ${username}`,
];

const homesteadFlat = {
  name: 'homestead-flat',
  description: 'Empty inventory, easy, day/night and mobs on; flat plains with trees, animals and buried ore.'
    + ' Gear up to iron, build and furnish the starter house, use every piece of furniture.',
  serverProperties: {
    'level-type': 'minecraft:flat', 'generator-settings': JSON.stringify(FLAT_GENERATOR),
    'level-seed': 20261019, difficulty: 'easy',
  },
  defaultDifficulty: 'easy',
  timeoutMs: 120 * 60 * 1000,
  setup({ username, rng, difficulty = 'easy' }) {
    const trees = plantTrees(rng, 14);
    const commands = [
      ...living(username, difficulty),
      ...resetArea(),
      ...trees.commands,
    ];
    // Buried ore a few blocks under the dirt: coal near the surface, iron deeper.
    for (const [x, z] of [[14, 14], [-16, 12]]) commands.push(`fill ${x} ${GROUND - 7} ${z} ${x + 1} ${GROUND - 6} ${z + 1} coal_ore`);
    for (const [x, z] of [[-14, -15], [16, -12], [0, 18]]) {
      commands.push(`fill ${x} ${GROUND - 13} ${z} ${x + 1} ${GROUND - 12} ${z + 1} iron_ore`);
    }
    const spot = () => `${Math.round(rng() * 40 - 20)} ${GROUND} ${Math.round(rng() * 40 - 20)}`;
    for (let i = 0; i < 6; i += 1) commands.push(`summon sheep ${spot()}`);
    for (let i = 0; i < 4; i += 1) commands.push(`summon cow ${spot()}`);
    commands.push(`tp ${username} 0.5 ${GROUND} 0.5 0 0`);
    return { commands, details: { trees: trees.trees.length } };
  },
  start: (companion) => companion.homestead(),
  verify: verifyHomestead,
};

const homesteadNatural = {
  name: 'homestead-natural',
  description: 'Empty inventory, easy, day/night and mobs on, natural terrain; the whole chain unassisted.',
  serverProperties: { 'level-type': 'minecraft:normal', 'level-seed': 20261019, difficulty: 'easy' },
  defaultDifficulty: 'easy',
  timeoutMs: 150 * 60 * 1000,
  setup({ username, run, rng, difficulty = 'easy' }) {
    const angle = rng() * Math.PI * 2;
    const x = Math.round(Math.cos(angle) * 400 * (run + 1));
    const z = Math.round(Math.sin(angle) * 400 * (run + 1));
    return {
      commands: [...living(username, difficulty), `spreadplayers ${x} ${z} 0 24 false ${username}`],
      details: { center: { x, z } },
    };
  },
  start: (companion) => companion.homestead(),
  verify: verifyHomestead,
};

// Starts at dusk with basic tools: the bot must get through one night (bed if it
// has one, otherwise a sealed bunker) and be back on the surface by morning.
function nightScenario({ name, withBed }) {
  return {
    name,
    description: `Dusk start, easy, mobs on, flat plains; ${withBed ? 'a bed in the inventory' : 'no bed'}.`
      + ' Survive the night without dying and be back on the surface after dawn.',
    serverProperties: homesteadFlat.serverProperties,
    defaultDifficulty: 'easy',
    timeoutMs: 15 * 60 * 1000,
    setup({ username, rng, difficulty = 'easy' }) {
      const trees = plantTrees(rng, 6);
      const commands = [...living(username, difficulty), ...resetArea(), ...trees.commands,
        `give ${username} stone_sword`, `give ${username} stone_pickaxe`, `give ${username} dirt 32`,
        `give ${username} cooked_beef 8`];
      if (withBed) commands.push(`give ${username} white_bed`);
      commands.push(`tp ${username} 0.5 ${GROUND} 0.5 0 0`, 'time set 11400');
      return { commands, details: { withBed } };
    },
    start: (companion) => companion.homestead(),
    finishWhen: ({ bot }) => Number.isFinite(bot.time?.timeOfDay) && bot.time.timeOfDay > 1500 && bot.time.timeOfDay < 11000,
    async verify({ bot, deaths }) {
      const surfaced = bot.entity.position.y >= GROUND - 1;
      return { pass: deaths === 0 && surfaced, details: { deaths, y: Math.floor(bot.entity.position.y),
        timeOfDay: bot.time?.timeOfDay } };
    },
  };
}

const nightBunkerFlat = nightScenario({ name: 'night-bunker-flat', withBed: false });
const nightBedFlat = nightScenario({ name: 'night-bed-flat', withBed: true });

module.exports = { homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat, verifyHomestead };
