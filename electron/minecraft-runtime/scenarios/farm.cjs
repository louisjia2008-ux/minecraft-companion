/* global module, require */
'use strict';
// A wheat farm from an empty inventory: hoe, seeds from grass, tilled plots by
// a pond, harvest, replant and bake bread. Judged by the server: bread on the
// player and farmland with crops left standing (the farm keeps going).
//
// Crops take about half an hour of real time to ripen at the vanilla random
// tick speed; the scenario raises it tenfold so a run fits in minutes. Only
// growth is faster: everything the bot does is unchanged. Kept in daylight:
// this tests the farming skills; nights belong to the homestead.

const { GROUND, plantTrees, resetArea, FLAT_GENERATOR } = require('./collectLogs.cjs');
const { testBlock, countOnPlayer, living } = require('./homestead.cjs');

const farmFlat = {
  name: 'farm-flat',
  description: 'Empty inventory, easy, mobs on; flat plains with trees, tall grass and a pond.'
    + ' Make a hoe, till plots by the water, sow, harvest, replant and bake 3 bread (crop growth x10).',
  serverProperties: { 'level-type': 'minecraft:flat', 'generator-settings': JSON.stringify(FLAT_GENERATOR),
    'level-seed': 20261019, difficulty: 'easy' },
  defaultDifficulty: 'easy',
  timeoutMs: 60 * 60 * 1000,
  setup({ username, rng, difficulty = 'easy' }) {
    const trees = plantTrees(rng, 8);
    const commands = [...living(username, difficulty), ...resetArea(), ...trees.commands, 'gamerule randomTickSpeed 30', 'time set 1000', 'gamerule doDaylightCycle false',
      // A 3x3 pond at ground level, a stone ledge under it so it stays put.
      `fill 6 ${GROUND - 2} 6 8 ${GROUND - 2} 8 stone`, `fill 6 ${GROUND - 1} 6 8 ${GROUND - 1} 8 water`];
    // Grass tufts for seeds, away from the pond.
    // A flat world has no grass of its own; about one tuft in eight drops a seed.
    for (let i = 0; i < 200; i += 1) {
      const x = Math.round(rng() * 46 - 23);
      const z = Math.round(rng() * 46 - 23);
      if (Math.abs(x - 7) <= 5 && Math.abs(z - 7) <= 5) continue;
      commands.push(`setblock ${x} ${GROUND} ${z} short_grass keep`);
    }
    commands.push(`tp ${username} 0.5 ${GROUND} 0.5 0 0`);
    return { commands, details: { trees: trees.trees.length } };
  },
  start: (companion) => companion.farm({ bread: 3 }),
  async verify({ server, username, goal }) {
    const plots = goal?.memory?.plots || [];
    let farmland = 0;
    let crops = 0;
    for (const p of plots) {
      if (await testBlock(server, p, 'minecraft:farmland')) farmland += 1;
      if (await testBlock(server, { ...p, y: p.y + 1 }, 'minecraft:wheat')) crops += 1;
    }
    const bread = await countOnPlayer(server, username, 'bread');
    const hydrated = plots.filter((p) => p.hydrated).length;
    return { pass: bread >= 3 && farmland >= 8 && crops >= 4,
      details: { bread, farmland, crops, plots: plots.length, hydrated, harvested: goal?.memory?.harvested } };
  },
};

module.exports = { farmFlat };
