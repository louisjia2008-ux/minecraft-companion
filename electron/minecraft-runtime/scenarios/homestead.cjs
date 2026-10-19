/* global module, require */
'use strict';
// The full chain from an empty inventory: gather, craft, mine, smelt, fight,
// hunt, build the starter house and use its furniture. Judged entirely by the
// server: blocks in the world, items on the player, chest contents and the
// player's respawn point.

const { FLAT_GENERATOR, plantTrees } = require('./collectLogs.cjs');
const { createStarterHouse } = require('../core/blueprints/starterHouse');

const GEAR = ['iron_sword', 'iron_pickaxe', 'shield'];

async function testBlock(server, p, predicate) {
  const match = await server.query(`execute if block ${p.x} ${p.y} ${p.z} ${predicate}`, /Test (passed|failed)/, 5000);
  return match[1] === 'passed';
}

async function countOnPlayer(server, username, item) {
  const match = await server.query(`clear ${username} ${item} 0`,
    new RegExp(`(?:Found (\\d+) matching items? on player ${username}|No items were found on player ${username})`));
  return match[1] ? Number(match[1]) : 0;
}

async function verifyHomestead({ server, username, goal }) {
  const anchor = goal?.memory?.house?.anchor;
  if (!anchor) return { pass: false, details: { reason: 'no_site' } };
  const house = createStarterHouse(anchor);
  const predicates = { cobblestone: '#minecraft:stone_crafting_materials', planks: '#minecraft:planks' };
  let placed = 0;
  for (const block of house.blocks) if (await testBlock(server, block.position, predicates[block.family])) placed += 1;
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
    /(has the following entity data: .*|Found no elements matching respawn\.pos)/, 5000);
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
      'fill -25 1 -25 25 12 25 air',
      'fill -25 -3 -25 25 -1 25 dirt', 'fill -25 0 -25 25 0 25 grass_block',
      ...trees.commands,
    ];
    // Buried ore a few blocks under the dirt: coal near the surface, iron deeper.
    for (const [x, z] of [[14, 14], [-16, 12]]) commands.push(`fill ${x} -6 ${z} ${x + 1} -5 ${z + 1} coal_ore`);
    for (const [x, z] of [[-14, -15], [16, -12], [0, 18]]) commands.push(`fill ${x} -12 ${z} ${x + 1} -11 ${z + 1} iron_ore`);
    for (let i = 0; i < 6; i += 1) commands.push(`summon sheep ${Math.round(rng() * 40 - 20)} 1 ${Math.round(rng() * 40 - 20)}`);
    for (let i = 0; i < 4; i += 1) commands.push(`summon cow ${Math.round(rng() * 40 - 20)} 1 ${Math.round(rng() * 40 - 20)}`);
    commands.push(`tp ${username} 0.5 1 0.5 0 0`);
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

module.exports = { homesteadFlat, homesteadNatural, verifyHomestead };
