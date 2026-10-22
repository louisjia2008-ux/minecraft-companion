/* global module, require */
'use strict';
// A mining trip on natural terrain: staircase down to the iron layer and a
// tunnel along it until 8 raw iron and 8 coal are in the bag. Starts with a
// stone pickaxe and sword, torches and bread (what the bot carries down by
// the time it mines in a full game); judged by the server's item counts.

const { countOnPlayer, living } = require('./homestead.cjs');

const mineNatural = {
  name: 'mine-natural',
  description: 'Easy, mobs on, natural terrain; stone pickaxe, 16 torches and bread to start.'
    + ' Dig down to the iron layer and bring up 8 raw iron and 8 coal.',
  serverProperties: { 'level-type': 'minecraft:normal', 'level-seed': 20261019, difficulty: 'easy' },
  defaultDifficulty: 'easy',
  timeoutMs: 45 * 60 * 1000,
  setup({ username, run, rng, difficulty = 'easy' }) {
    const angle = rng() * Math.PI * 2;
    const x = Math.round(Math.cos(angle) * 300 * (run + 1));
    const z = Math.round(Math.sin(angle) * 300 * (run + 1));
    return {
      commands: [...living(username, difficulty), `spreadplayers ${x} ${z} 0 16 false ${username}`,
        `give ${username} stone_pickaxe`, `give ${username} stone_sword`, `give ${username} torch 16`, `give ${username} bread 12`, `give ${username} stick 4`],
      details: { center: { x, z } },
    };
  },
  start: (companion) => companion.mine({ want: { raw_iron: 8, coal: 8 } }),
  async verify({ server, username }) {
    const iron = await countOnPlayer(server, username, 'raw_iron');
    const coal = await countOnPlayer(server, username, 'coal');
    return { pass: iron >= 8 && coal >= 8, details: { iron, coal } };
  },
};

module.exports = { mineNatural };
