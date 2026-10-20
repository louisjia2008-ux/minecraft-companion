/* global module */
'use strict';
// Milestone 1 scenarios: gather 10 logs starting from an empty inventory.
// Success is judged by the server's own item count, not by the bot's view.

const TARGET = 10;

// Players stand at y=64 on grass, like ordinary terrain. A surface below
// y=40 would make every slime chunk spawn slimes day and night.
const GROUND = 64;
const FLAT_GENERATOR = {
  layers: [
    { block: 'minecraft:bedrock', height: 1 },
    { block: 'minecraft:stone', height: 123 },
    { block: 'minecraft:dirt', height: 3 },
    { block: 'minecraft:grass_block', height: 1 },
  ],
  biome: 'minecraft:plains',
  structures: {},
};

const commonSetup = (username, difficulty) => [
  `difficulty ${difficulty}`,
  'gamerule doDaylightCycle false', 'gamerule doWeatherCycle false', 'gamerule doMobSpawning false',
  'gamerule doImmediateRespawn true', 'time set noon', 'weather clear',
  'kill @e[type=item]', 'kill @e[type=!player]',
  `clear ${username}`, `effect clear ${username}`, `gamemode survival ${username}`,
];

/** Trees at random spots around the origin; some top logs are out of reach on purpose. */
function plantTrees(rng, count = 8) {
  const commands = [];
  const placed = [];
  let guard = 0;
  while (placed.length < count && guard++ < 500) {
    const angle = rng() * Math.PI * 2;
    const radius = 6 + rng() * 12;
    const x = Math.round(Math.cos(angle) * radius);
    const z = Math.round(Math.sin(angle) * radius);
    if (placed.some((p) => Math.abs(p.x - x) < 5 && Math.abs(p.z - z) < 5)) continue;
    const height = 4 + Math.floor(rng() * 3);
    placed.push({ x, z, height });
    const top = GROUND + height - 1;
    commands.push(`fill ${x - 2} ${top - 1} ${z - 2} ${x + 2} ${top} ${z + 2} oak_leaves[persistent=true] keep`);
    commands.push(`fill ${x - 1} ${top + 1} ${z - 1} ${x + 1} ${top + 1} ${z + 1} oak_leaves[persistent=true] keep`);
    commands.push(`fill ${x} ${GROUND} ${z} ${x} ${top} ${z} oak_log`);
  }
  return { commands, trees: placed };
}

/** Clears the 51x51 test area back to grass; each fill stays under the 32768-block limit. */
function resetArea() {
  return [
    `fill -25 ${GROUND} -25 25 ${GROUND + 11} 25 air`,
    `fill -25 ${GROUND - 4} -25 25 ${GROUND - 2} 25 dirt`,
    `fill -25 ${GROUND - 1} -25 25 ${GROUND - 1} 25 grass_block`,
    // Respawn on open ground, never on a tree top or inside the house site.
    'gamerule spawnRadius 0', `setworldspawn 0 ${GROUND} 23`,
  ];
}

async function countLogsOnServer(server, username) {
  const match = await server.query(`clear ${username} #minecraft:logs 0`,
    new RegExp(`(?:Found (\\d+) matching item(?:\\(s\\)|s)? on player ${username}|No items were found on player ${username})`));
  return match[1] ? Number(match[1]) : 0;
}

const collectLogsFlat = {
  name: 'collect-logs-flat',
  description: `Empty inventory, peaceful, flat plains with 8 small oak trees; gather ${TARGET} logs.`,
  serverProperties: {
    'level-type': 'minecraft:flat', 'generator-settings': JSON.stringify(FLAT_GENERATOR),
    'level-seed': 20261019, difficulty: 'peaceful',
  },
  timeoutMs: 5 * 60 * 1000,
  setup({ username, rng, difficulty = 'peaceful' }) {
    const trees = plantTrees(rng);
    return {
      commands: [
        ...commonSetup(username, difficulty),
        ...resetArea(),
        ...trees.commands,
        `tp ${username} 0.5 ${GROUND} 0.5 0 0`,
      ],
      details: { trees: trees.trees },
    };
  },
  start: (companion) => companion.gatherLogs(TARGET),
  async verify({ server, username }) {
    const logs = await countLogsOnServer(server, username);
    return { pass: logs >= TARGET, details: { logsOnServer: logs, target: TARGET } };
  },
};

const collectLogsNatural = {
  name: 'collect-logs-natural',
  description: `Empty inventory, peaceful, natural terrain at a different spot each run; gather ${TARGET} logs.`,
  serverProperties: { 'level-type': 'minecraft:normal', 'level-seed': 20261019, difficulty: 'peaceful' },
  timeoutMs: 8 * 60 * 1000,
  setup({ username, run, rng, difficulty = 'peaceful' }) {
    // Each run starts somewhere new so earlier runs do not strip the forest.
    const angle = rng() * Math.PI * 2;
    const x = Math.round(Math.cos(angle) * 300 * (run + 1));
    const z = Math.round(Math.sin(angle) * 300 * (run + 1));
    return {
      commands: [...commonSetup(username, difficulty), `spreadplayers ${x} ${z} 0 24 false ${username}`],
      details: { center: { x, z } },
    };
  },
  start: (companion) => companion.gatherLogs(TARGET),
  async verify({ server, username }) {
    const logs = await countLogsOnServer(server, username);
    return { pass: logs >= TARGET, details: { logsOnServer: logs, target: TARGET } };
  },
};

module.exports = { collectLogsFlat, collectLogsNatural, plantTrees, resetArea, FLAT_GENERATOR, GROUND };
