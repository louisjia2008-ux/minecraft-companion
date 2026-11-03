/* global module, require */
'use strict';
// Ender pearls: a flat night with endermen standing off in the open. The bot
// has a sword and armour and must bring two pearls home. Judged by the bag.

const { GROUND, resetArea, FLAT_GENERATOR } = require('./collectLogs.cjs');
const { living } = require('./homestead.cjs');

const pearlsFlat = {
  name: 'pearls-flat',
  description: 'Easy, flat open plain at midnight, eight endermen 18-40 blocks off; iron sword and armour, inventory kept (as in the playthrough).'
    + ' Hunt two ender pearls.',
  serverProperties: { 'level-type': 'minecraft:flat', 'generator-settings': JSON.stringify(FLAT_GENERATOR),
    'level-seed': 20261103, difficulty: 'easy', 'spawn-monsters': false },
  defaultDifficulty: 'easy',
  timeoutMs: 20 * 60 * 1000,
  setup({ username, difficulty = 'easy' }) {
    const commands = [...living(username, difficulty), ...resetArea(),
      'kill @e[type=!minecraft:player]', 'time set 18000', 'gamerule doDaylightCycle false',
      'gamerule doMobSpawning false', 'gamerule keepInventory true',
      `give ${username} iron_sword 1`, `give ${username} bread 16`,
      ...['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'].map((n) => `give ${username} ${n} 1`)];
    for (const [x, z] of [[18, 0], [-22, 8], [0, 30], [25, -25], [-30, -20], [12, -34], [-8, 40], [36, 14]]) {
      commands.push(`summon enderman ${x} ${GROUND} ${z} {PersistenceRequired:1b}`);
    }
    commands.push(`tp ${username} 0.5 ${GROUND} 0.5 0 0`);
    return { commands, details: {} };
  },
  start: (companion) => companion.huntPearls({ count: 2 }),
  async verify({ bot }) {
    const pearls = bot.inventory.items().filter((i) => i.name === 'ender_pearl').reduce((n, i) => n + i.count, 0);
    return { pass: pearls >= 2, details: { pearls } };
  },
};

module.exports = { pearlsFlat };
