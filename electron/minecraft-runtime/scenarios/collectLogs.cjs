/* global module */
'use strict';
// Milestone 1 scenarios: gather 10 logs starting from an empty inventory.
// Success is judged by the server's own item count, not by the bot's view.

const TARGET = 10;

// bedrock y=-64, stone to y=-4, dirt to y=-1, grass at y=0; players stand at y=1.
const FLAT_GENERATOR = {
  layers: [
    { block: 'minecraft:bedrock', height: 1 },
    { block: 'minecraft:stone', height: 60 },
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
    commands.push(`fill ${x - 2} ${height - 1} ${z - 2} ${x + 2} ${height} ${z + 2} oak_leaves[persistent=true] keep`);
    commands.push(`fill ${x - 1} ${height + 1} ${z - 1} ${x + 1} ${height + 1} ${z + 1} oak_leaves[persistent=true] keep`);
    commands.push(`fill ${x} 1 ${z} ${x} ${height} ${z} oak_log`);
  }
  return { commands, trees: placed };
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
        'fill -25 1 -25 25 12 25 air', // stays under the 32768-block fill limit
        'fill -25 -3 -25 25 -1 25 dirt', 'fill -25 0 -25 25 0 25 grass_block',
        ...trees.commands,
        `tp ${username} 0.5 1 0.5 0 0`,
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

module.exports = { collectLogsFlat, collectLogsNatural, plantTrees, FLAT_GENERATOR };
