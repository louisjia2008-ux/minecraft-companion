/* global module, require */
'use strict';
// Animal husbandry: fence a pen, lead the two cows of the area into it with
// wheat and breed them. Only two cows exist, so three cows in the pen means
// a calf was born there. Judged by the server's entity counts. Kept in
// daylight: this tests the ranching skills; nights belong to the homestead.

const { GROUND, plantTrees, resetArea, FLAT_GENERATOR } = require('./collectLogs.cjs');
const { living } = require('./homestead.cjs');

async function countCows(server, selector) {
  const match = await server.query(`execute if entity @e[type=minecraft:cow,${selector}]`,
    /Test passed, count: (\d+)|Test failed/, 5000);
  return match[1] ? Number(match[1]) : 0;
}

const ranchFlat = {
  name: 'ranch-flat',
  description: 'Easy, mobs on, flat plains with trees and exactly two cows; 16 wheat in the bag.'
    + ' Build a fenced pen with a gate, lead both cows in and breed a calf.',
  serverProperties: { 'level-type': 'minecraft:flat', 'generator-settings': JSON.stringify(FLAT_GENERATOR),
    'level-seed': 20261019, difficulty: 'easy' },
  defaultDifficulty: 'easy',
  timeoutMs: 45 * 60 * 1000,
  setup({ username, rng, difficulty = 'easy' }) {
    const trees = plantTrees(rng, 8);
    const commands = [...living(username, difficulty), ...resetArea(), ...trees.commands,
      'kill @e[type=minecraft:cow]', 'time set 1000', 'gamerule doDaylightCycle false', `give ${username} wheat 16`];
    for (const [x, z] of [[-16, 14], [15, -15]]) commands.push(`summon cow ${x} ${GROUND} ${z}`);
    commands.push(`tp ${username} 0.5 ${GROUND} 0.5 0 0`);
    return { commands, details: { trees: trees.trees.length } };
  },
  start: (companion) => companion.ranch({ kind: 'cow', target: 3 }),
  async verify({ server, goal }) {
    const pen = goal?.memory?.pen;
    if (!pen) return { pass: false, details: { reason: 'no_pen' } };
    const c = pen.corner;
    const inPen = await countCows(server, `x=${c.x + 1},y=${c.y - 1},z=${c.z + 1},dx=${pen.size - 3},dy=3,dz=${pen.size - 3}`);
    const total = await countCows(server, `x=0,y=${GROUND},z=0,distance=..96`);
    return { pass: inPen >= 3 && total >= 3, details: { inPen, total, born: goal.memory.born, corner: c } };
  },
};

module.exports = { ranchFlat };
