/* global module, require */
'use strict';
// The full chain from an empty inventory: gather, craft, mine, smelt, fight,
// hunt, build the starter house and use its furniture. Judged entirely by the
// server: blocks in the world, items on the player, chest contents and the
// player's respawn point.

const { FLAT_GENERATOR, GROUND, plantTrees, resetArea } = require('./collectLogs.cjs');
const { createStarterHouse } = require('../core/blueprints/starterHouse');
const { interactionSetup, score, worldTime, playerState } = require('./acceptance.cjs');
const { installFurnitureEvidence } = require('./furnitureEvidence.cjs');

const GEAR = ['iron_sword', 'iron_pickaxe', 'shield'];

async function testBlock(server, p, predicate) {
  // An unloaded chunk answers "That position is not loaded"; the verifier
  // force-loads the house area first, so this only guards against hangs.
  const match = await server.query(`execute if block ${p.x} ${p.y} ${p.z} ${predicate}`,
    /Test (passed|failed)|(not loaded)/, 5000);
  return match[1] === 'passed';
}

async function countOnPlayer(server, username, item) {
  const match = await server.query(`clear ${username} ${item} 0`,
    new RegExp(`(?:Found (\\d+) matching item(?:\\(s\\)|s)? on player ${username}|No items were found on player ${username})`));
  return match[1] ? Number(match[1]) : 0;
}

async function verifyHomestead({ server, username, goal, state }) {
  const anchor = goal?.memory?.house?.anchor;
  if (!anchor) return { pass: false, details: { reason: 'no_site' } };
  const house = createStarterHouse(anchor);
  // The bot may have wandered off: keep the house chunks loaded while checking.
  await server.query(`forceload add ${anchor.x - 2} ${anchor.z - 2} ${anchor.x + 9} ${anchor.z + 9}`,
    /(Marked|already|forceloaded|loaded)/i, 10000).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 2000));
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
  const tableInteractions = await score(server, username, 'table');
  const furnaceInteractions = await score(server, username, 'furnace');
  const usage = await state?.furnitureEvidence?.verify(f);
  const tableUsed = tableInteractions > 0 && usage?.tableUsed === true;
  const furnaceUsed = furnaceInteractions > 0 && usage?.furnaceUsed === true;
  const pass = placed === house.blocks.length && furniture.crafting_table && furniture.furnace && furniture.chest
    && furniture.bed && furniture.door && chestUsed && bedUsed && tableUsed && furnaceUsed
    && GEAR.every((item) => gear[item] > 0);
  return {
    pass,
    details: {
      anchor, placed, total: house.blocks.length, furniture, chestUsed, bedUsed, respawn: pos, tableUsed, furnaceUsed, tableInteractions, furnaceInteractions,
      furnitureEvidence: usage || null, gear,
    },
  };
}

const living = (username, difficulty) => [
  ...interactionSetup(username),
  `difficulty ${difficulty}`, 'gamerule doDaylightCycle true', 'gamerule doWeatherCycle false',
  'gamerule doMobSpawning true', 'gamerule doImmediateRespawn true', 'gamerule keepInventory false',
  'time set 0', 'weather clear', 'kill @e[type=item]',
  `clear ${username}`, `effect clear ${username}`, `gamemode survival ${username}`,
];

async function initializeFurniture(context) {
  context.state.furnitureEvidence = await installFurnitureEvidence(context);
}
const disposeFurniture = ({ state }) => state.furnitureEvidence?.dispose();

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
  initialize: initializeFurniture,
  dispose: disposeFurniture,
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
    // Roughly the livestock of a plains area: enough wool for one bed (white
    // sheep, as most natural sheep are) and food for about an hour of work.
    const spot = () => `${Math.round(rng() * 46 - 23)} ${GROUND} ${Math.round(rng() * 46 - 23)}`;
    for (let i = 0; i < 12; i += 1) commands.push(`summon sheep ${spot()} {Color:0b}`);
    for (let i = 0; i < 8; i += 1) commands.push(`summon cow ${spot()}`);
    for (let i = 0; i < 6; i += 1) commands.push(`summon pig ${spot()}`);
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
  initialize: initializeFurniture,
  dispose: disposeFurniture,
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
    finishOnGoalDone: false,
    setup({ username, rng, difficulty = 'easy' }) {
      const trees = plantTrees(rng, 6);
      const commands = [...living(username, difficulty), ...resetArea(), ...trees.commands,
        `give ${username} stone_sword`, `give ${username} stone_pickaxe`, `give ${username} dirt 32`,
        `give ${username} cooked_beef 8`];
      if (withBed) commands.push(`give ${username} white_bed`);
      commands.push(`tp ${username} 0.5 ${GROUND} 0.5 0 0`, 'time set 11400');
      return { commands, details: { withBed } };
    },
    async initialize({ server, state }) {
      state.night = { initial: await worldTime(server), sawNight: false, bunkerConfirmed: false };
    },
    start: (companion) => companion.homestead(),
    async onTick({ server, username, goal, state, write }) {
      const night = state.night;
      if (!night) throw new Error('Night evidence was not initialized');
      night.latest = await worldTime(server);
      night.sawNight ||= night.latest.daytime >= 12542 && night.latest.daytime < 23400;
      // A goal flag alone cannot prove shelter: independently check the seal
      // and the player's server position while that bunker is occupied.
      const top = goal?.memory?.bunker?.top;
      if (!withBed && top && night.sawNight && !night.bunkerConfirmed) {
        const player = await playerState(server, username);
        const seal = await testBlock(server, { x: top.x, y: top.y - 1, z: top.z }, '#minecraft:dirt')
          || await testBlock(server, { x: top.x, y: top.y - 1, z: top.z }, 'minecraft:cobblestone')
          || await testBlock(server, { x: top.x, y: top.y - 1, z: top.z }, 'minecraft:cobbled_deepslate');
        night.bunkerConfirmed = seal && player.health > 0 && player.position.y <= top.y - 2
          && Math.hypot(player.position.x - top.x - 0.5, player.position.z - top.z - 0.5) < 1;
        if (night.bunkerConfirmed) write('night_server_bunker', { top, player, time: night.latest });
      }
    },
    finishWhen: ({ bot, goal, state }) => Boolean(state.night?.latest
      && state.night.latest.day > state.night.initial.day
      && state.night.latest.daytime > 1500 && state.night.latest.daytime < 11000
      && !goal?.memory?.bunker && bot.entity.position.y >= GROUND - 0.5),
    async verify({ server, username, bot, deaths, goal, state }) {
      if (!server || !state?.night) return { pass: false, details: { reason: 'missing_night_server_evidence' } };
      const time = await worldTime(server);
      const player = await playerState(server, username);
      const slept = await score(server, username, 'sleep');
      const stillInBunker = Boolean(goal?.memory?.bunker);
      const dawn = time.day > state.night.initial.day && time.daytime > 1500 && time.daytime < 11000;
      const nightCompleted = withBed ? slept > 0 : state.night.sawNight && state.night.bunkerConfirmed;
      const alive = player.health > 0 && bot.health > 0;
      const surface = player.position.y >= GROUND - 0.5;
      return { pass: deaths === 0 && alive && dawn && surface && nightCompleted && !stillInBunker,
        details: { deaths, alive, dawn, surface, stillInBunker, slept, nightCompleted,
          nightEvidence: state.night, serverPlayer: player, serverTime: time } };
    },
  };
}

const nightBunkerFlat = nightScenario({ name: 'night-bunker-flat', withBed: false });
const nightBedFlat = nightScenario({ name: 'night-bed-flat', withBed: true });

module.exports = { homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat, verifyHomestead, testBlock, countOnPlayer, living };
