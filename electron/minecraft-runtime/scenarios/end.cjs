/* global module, require, setTimeout */
'use strict';
// The End. Each run gets a fresh server and world: a world has one dragon.
// The bot reaches the End the vanilla way, through an end portal block (which
// also makes the server build the obsidian arrival platform), so the fight
// starts exactly as after a real stronghold portal. Judged by the server:
// the kill_dragon advancement and the player's dimension.

const { FLAT_GENERATOR, GROUND } = require('./collectLogs.cjs');

const FIGHT_KIT = [
  ['iron_chestplate', 1], ['iron_leggings', 1], ['iron_boots', 1], ['carved_pumpkin', 1],
  ['iron_sword', 1], ['iron_pickaxe', 1], ['bow', 1], ['arrow', 192], ['cooked_beef', 32], ['cobblestone', 128],
  ['water_bucket', 1],
];

async function advancement(server, username, id) {
  const match = await server.query(`execute if entity @a[name=${username},advancements={minecraft:${id}=true}]`,
    /(Test passed|Test failed)/, 5000);
  return match[1] === 'Test passed';
}

async function playerDimension(server, username) {
  const match = await server.query(`data get entity ${username} Dimension`,
    /(?:has the following entity data: "minecraft:(\w+)"|(No entity was found))/, 5000);
  return match[1] || null;
}

async function countOnPlayer(server, username, item) {
  const match = await server.query(`clear ${username} ${item} 0`,
    new RegExp(`(?:Found (\\d+) matching item(?:\\(s\\)|s)? on player ${username}|No items were found on player ${username})`));
  return match[1] ? Number(match[1]) : 0;
}

const baseCommands = (username, difficulty) => [
  `difficulty ${difficulty}`,
  'gamerule doDaylightCycle false', 'gamerule doWeatherCycle false', 'gamerule doMobSpawning true',
  'gamerule doImmediateRespawn true', 'gamerule keepInventory false', 'gamerule spawnRadius 0',
  'time set noon', 'weather clear',
  `clear ${username}`, `effect clear ${username}`, `gamemode survival ${username}`,
  `effect give ${username} minecraft:instant_health 1 5`, `effect give ${username} minecraft:saturation 1 20`,
];

const endDragonGiven = {
  name: 'end-dragon-given',
  description: `Fight kit given (iron armor, carved pumpkin, bow and 192 arrows, food, blocks); step into an end
  portal, cross from the arrival platform to the main island, destroy the crystals and kill the ender dragon.`,
  serverProperties: {
    'level-type': 'minecraft:flat', 'generator-settings': JSON.stringify(FLAT_GENERATOR),
    difficulty: 'easy', 'view-distance': 10,
  },
  serverPerRun: (run, seed) => ({ 'level-seed': seed + run * 101 }),
  defaultDifficulty: 'easy',
  timeoutMs: 40 * 60 * 1000,
  setup({ username, difficulty = 'easy' }) {
    return {
      commands: [
        ...baseCommands(username, difficulty),
        ...FIGHT_KIT.map(([item, count]) => `give ${username} ${item} ${count}`),
        `setworldspawn 0 ${GROUND} 0`,
        // A lone portal block a few blocks away; the bot is put straight into it.
        `setblock 8 ${GROUND} 8 minecraft:end_portal`,
        `tp ${username} 8.5 ${GROUND} 8.5`,
      ],
      details: {},
    };
  },
  start: (companion) => companion.endDragon(),
  async verify({ server, username, goal }) {
    const killed = await advancement(server, username, 'end/kill_dragon');
    const dimension = await playerDimension(server, username);
    const arrowsLeft = await countOnPlayer(server, username, 'arrow');
    const m = goal?.memory || {};
    return {
      pass: killed,
      details: { killed, dimension, arrowsLeft, arrowsShot: m.arrows, crystalsGone: m.crystalsGone,
        damage: Math.round(m.damage || 0), summary: `killed=${killed} dim=${dimension} arrows=${m.arrows} crystals=${m.crystalsGone} dmg=${Math.round(m.damage || 0)}` },
    };
  },
};

module.exports = { endDragonGiven, advancement, playerDimension, countOnPlayer, baseCommands, FIGHT_KIT };

// ---- stronghold ------------------------------------------------------------

const PORTAL_KIT = [
  ['ender_eye', 20], ['iron_helmet', 1], ['iron_chestplate', 1], ['iron_leggings', 1], ['iron_boots', 1],
  ['iron_sword', 1], ['iron_pickaxe', 1], ['cooked_beef', 32], ['cobblestone', 64], ['torch', 32],
];

/** Nearest stronghold to the world spawn, as the server's own `locate` reports it. */
async function locateStronghold(server) {
  const match = await server.query('locate structure minecraft:stronghold',
    /(?:The nearest minecraft:stronghold is at \[(-?\d+), [^,]+, (-?\d+)\]|(Could not find))/, 120000);
  if (match[3]) throw new Error('no stronghold');
  return { x: Number(match[1]), z: Number(match[2]) };
}

const endPortalNatural = {
  name: 'end-portal-natural',
  description: `Eyes of ender and iron gear given; start 250-400 blocks from a stronghold in a natural world,
  follow thrown eyes to it, dig down to the portal room, fill the frames and go through to the End.`,
  serverProperties: { difficulty: 'easy', 'view-distance': 10 },
  serverPerRun: (run, seed) => ({ 'level-seed': seed + run * 101 }),
  defaultDifficulty: 'easy',
  timeoutMs: 60 * 60 * 1000,
  // Spreading the player generates terrain far from spawn.
  setupTimeoutMs: 180000,
  async prepare({ server, username, rng, difficulty = 'easy' }) {
    const sh = await locateStronghold(server);
    const angle = rng() * Math.PI * 2;
    const distance = 250 + rng() * 150;
    const x = Math.round(sh.x + Math.cos(angle) * distance);
    const z = Math.round(sh.z + Math.sin(angle) * distance);
    // spreadplayers only finds ground in loaded chunks: bring the player over first.
    server.command(`effect give ${username} minecraft:slow_falling 30 0`);
    server.command(`tp ${username} ${x} 300 ${z}`);
    await new Promise((resolve) => setTimeout(resolve, 10000));
    return {
      commands: [
        ...baseCommands(username, difficulty),
        ...PORTAL_KIT.map(([item, count]) => `give ${username} ${item} ${count}`),
        `spreadplayers ${x} ${z} 0 24 false ${username}`,
        `execute at ${username} run setworldspawn ~ ~ ~`,
      ],
      details: { stronghold: sh, start: { x, z }, distance: Math.round(distance) },
    };
  },
  start: (companion) => companion.enterEnd(),
  async verify({ server, username, goal }) {
    const dimension = await playerDimension(server, username);
    const m = goal?.memory || {};
    return {
      pass: dimension === 'the_end',
      details: { dimension, thrown: m.thrown, broken: m.broken, walked: Math.round(m.walked || 0),
        ring: m.ring ? `${m.ring.center.x},${m.ring.center.y},${m.ring.center.z}` : null,
        summary: `dim=${dimension} eyes_thrown=${m.thrown} broken=${m.broken} walked=${Math.round(m.walked || 0)}` },
    };
  },
};

module.exports.endPortalNatural = endPortalNatural;
module.exports.locateStronghold = locateStronghold;
module.exports.PORTAL_KIT = PORTAL_KIT;

// ---- end city --------------------------------------------------------------

const CITY_KIT = [
  ['iron_chestplate', 1], ['iron_leggings', 1], ['iron_boots', 1], ['carved_pumpkin', 1],
  ['iron_sword', 1], ['iron_pickaxe', 1], ['bow', 1], ['arrow', 64], ['ender_pearl', 16],
  ['cooked_beef', 48], ['cobblestone', 512], ['water_bucket', 1],
];
// What the bot brings or digs on the way; anything else on it came from a chest or the ship.
const NOT_LOOT = new Set([...CITY_KIT.map(([n]) => n), 'end_stone', 'purpur_block', 'purpur_pillar', 'purpur_stairs',
  'purpur_slab', 'end_stone_bricks', 'end_rod', 'chorus_fruit', 'chorus_flower', 'obsidian', 'ender_pearl', 'dirt', 'bucket']);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends the player through a real end portal and waits for the End. */
async function enterEndByPortal(server, username) {
  server.command(`setblock 8 ${GROUND} 8 minecraft:end_portal`);
  server.command(`tp ${username} 8.5 ${GROUND} 8.5`);
  for (let i = 0; i < 30; i += 1) {
    await wait(2000);
    const dimension = await playerDimension(server, username).catch(() => null);
    if (dimension === 'the_end') return true;
  }
  return false;
}

async function lootOnPlayer(server, username) {
  const match = await server.query(`data get entity ${username} Inventory`, /(has the following entity data: .*|No entity was found)/, 5000);
  const ids = [...match[1].matchAll(/id: "minecraft:(\w+)"/g)].map((m) => m[1]);
  return [...new Set(ids.filter((id) => !NOT_LOOT.has(id)))];
}

const endCityGiven = {
  name: 'end-city-given',
  description: `Dragon already dead (killed by command), outer-End kit given (16 pearls, 512 cobblestone, iron gear);
  pearl through the gateway, find an end city on the outer islands and loot its chests (elytra if a ship is in sight).`,
  serverProperties: {
    'level-type': 'minecraft:flat', 'generator-settings': JSON.stringify(FLAT_GENERATOR),
    difficulty: 'easy', 'view-distance': 16,
  },
  serverPerRun: (run, seed) => ({ 'level-seed': seed + run * 101 }),
  // Cities are found by what is in view: a player's usual 16 chunks.
  viewDistance: 16,
  defaultDifficulty: 'easy',
  timeoutMs: 60 * 60 * 1000,
  setupTimeoutMs: 60000,
  async prepare({ server, username, difficulty = 'easy' }) {
    for (const command of baseCommands(username, difficulty)) server.command(command);
    server.command(`setworldspawn 0 ${GROUND} 0`);
    if (!(await enterEndByPortal(server, username))) throw new Error('not in the End');
    await wait(8000);
    server.command('execute in minecraft:the_end run kill @e[type=minecraft:ender_dragon]');
    await wait(15000);
    // For reading the log only (the bot is never told): the cities nearest the outer ring.
    const cities = [];
    for (const [x, z] of [[1000, 0], [-1000, 0], [0, 1000], [0, -1000], [-700, -700]]) {
      const m = await server.query(`execute in minecraft:the_end positioned ${x} 60 ${z} run locate structure minecraft:end_city`,
        /(nearest minecraft:end_city is at \[[^\]]*\][^)]*\)|Could not find)/, 20000).catch(() => null);
      cities.push(`${x},${z}: ${m ? (Array.isArray(m) ? m[0] : String(m)).slice(0, 80) : '?'}`);
    }
    return {
      commands: [
        ...CITY_KIT.map(([item, count]) => `give ${username} ${item} ${count}`),
        `execute in minecraft:the_end positioned 0 0 30 run spreadplayers ~ ~ 0 8 under 75 false ${username}`,
      ],
      details: { cities },
    };
  },
  start: (companion) => companion.endCity(),
  // Where the bot is every two seconds: falls and void deaths need the path.
  during({ bot, write }) {
    const p = bot.entity?.position;
    if (p) write('trace', { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10, hp: bot.health });
  },
  async verify({ server, username, goal }) {
    const enteredCity = await advancement(server, username, 'end/find_end_city');
    const elytra = await advancement(server, username, 'end/elytra');
    const loot = await lootOnPlayer(server, username);
    const m = goal?.memory || {};
    const looted = m.looted ? m.looted.size : 0;
    return {
      pass: enteredCity && (elytra || (looted >= 1 && loot.length >= 1)),
      details: { enteredCity, elytra, loot, looted, pearls: m.pearls, bridged: m.bridged,
        summary: `city=${enteredCity} elytra=${elytra} chests=${looted} loot=${loot.join('/') || '-'} pearls=${m.pearls} bridged=${m.bridged}` },
    };
  },
};

module.exports.endCityGiven = endCityGiven;

// ---- the whole trip --------------------------------------------------------

const JOURNEY_KIT = [
  ['ender_eye', 20], ['iron_chestplate', 1], ['iron_leggings', 1], ['iron_boots', 1], ['carved_pumpkin', 1],
  ['iron_helmet', 1], ['iron_sword', 1], ['iron_pickaxe', 1], ['bow', 1], ['arrow', 192], ['ender_pearl', 16],
  ['cooked_beef', 64], ['cobblestone', 512], ['water_bucket', 1], ['torch', 16],
];

const endFullNatural = {
  name: 'end-full-natural',
  description: `Kit given (eyes of ender, iron gear, bow, pearls, water bucket, blocks); start 250-400 blocks from a
  stronghold in a natural world: find it, enter the End, kill the dragon, pearl through the gateway and loot an end city.`,
  serverProperties: { difficulty: 'easy', 'view-distance': 16 },
  serverPerRun: (run, seed) => ({ 'level-seed': seed + run * 101 }),
  viewDistance: 16,
  defaultDifficulty: 'easy',
  timeoutMs: 150 * 60 * 1000,
  setupTimeoutMs: 180000,
  async prepare(args) {
    const setup = await endPortalNatural.prepare(args);
    const commands = setup.commands.filter((c) => !/^give /.test(c));
    commands.splice(commands.length - 2, 0, ...JOURNEY_KIT.map(([item, count]) => `give ${args.username} ${item} ${count}`));
    return { ...setup, commands };
  },
  start: (companion) => companion.endJourney(),
  during: endCityGiven.during,
  async verify({ server, username, goal }) {
    const killed = await advancement(server, username, 'end/kill_dragon');
    const enteredCity = await advancement(server, username, 'end/find_end_city');
    const elytra = await advancement(server, username, 'end/elytra');
    const loot = await lootOnPlayer(server, username);
    const city = goal?.memory?.stages?.city?.memory || {};
    const looted = city.looted ? city.looted.size : 0;
    return {
      pass: killed && enteredCity && (elytra || (looted >= 1 && loot.length >= 1)),
      details: { killed, enteredCity, elytra, loot, looted,
        summary: `dragon=${killed} city=${enteredCity} elytra=${elytra} chests=${looted} loot=${loot.join('/') || '-'}` },
    };
  },
};

module.exports.endFullNatural = endFullNatural;
