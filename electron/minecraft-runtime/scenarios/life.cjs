/* global module, require */
'use strict';
// Living alone on natural terrain from an empty inventory, with no task, for
// a fixed stretch of real time (about five game days). Judged by the server
// at the end: the furnished house and iron gear, a farm, a pen with animals,
// and ore put away in the chest.

const { verifyHomestead, testBlock, living } = require('./homestead.cjs');

const DURATION_MS = 100 * 60 * 1000;

async function countEntities(server, type, selector) {
  const match = await server.query(`execute if entity @e[type=minecraft:${type},${selector}]`, /Test passed, count: (\d+)|Test failed/, 5000);
  return match[1] ? Number(match[1]) : 0;
}

let started = 0;
const lifeNatural = {
  name: 'life-natural',
  description: 'Empty inventory, easy, day/night and mobs on, natural terrain, no task: live for ~5 game days.'
    + ' Expected: furnished house and iron gear, a farm, a pen with animals, ore stored in the chest.',
  serverProperties: { 'level-type': 'minecraft:normal', 'level-seed': 20261019, difficulty: 'easy' },
  defaultDifficulty: 'easy',
  timeoutMs: DURATION_MS + 10 * 60 * 1000,
  setup({ username, run, rng, difficulty = 'easy' }) {
    started = Date.now();
    const angle = rng() * Math.PI * 2;
    const x = Math.round(Math.cos(angle) * 500 * (run + 1));
    const z = Math.round(Math.sin(angle) * 500 * (run + 1));
    return { commands: [...living(username, difficulty), `spreadplayers ${x} ${z} 0 24 false ${username}`], details: { center: { x, z } } };
  },
  start: (companion) => companion.life(),
  finishWhen: () => Date.now() - started > DURATION_MS,
  async verify({ server, username, goal, deaths }) {
    const home = await verifyHomestead({ server, username, goal: goal.home });
    const plots = goal.memory.projects.farm?.memory.plots || [];
    let farmland = 0;
    for (const p of plots) if (await testBlock(server, p, 'minecraft:farmland')) farmland += 1;
    const ranch = goal.memory.projects.ranch;
    let herd = 0;
    if (ranch?.memory.pen) {
      const c = ranch.memory.pen.corner;
      herd = await countEntities(server, ranch.memory.kind || 'cow',
        `x=${c.x + 1},y=${c.y - 1},z=${c.z + 1},dx=${ranch.memory.pen.size - 3},dy=3,dz=${ranch.memory.pen.size - 3}`);
    }
    const chestPos = goal.home.memory.house?.furniture.chest.position;
    let stored = [];
    if (chestPos) {
      const data = await server.query(`data get block ${chestPos.x} ${chestPos.y} ${chestPos.z} Items`,
        /(has the following block data: .*|Found no elements matching Items|is not a block entity)/, 5000);
      stored = [...new Set((data[1].match(/minecraft:(raw_iron|iron_ingot|coal|raw_copper|raw_gold|diamond|redstone|lapis_lazuli)/g) || []))];
    }
    const pass = home.pass && farmland >= 8 && herd >= 2 && stored.length > 0;
    return { pass, details: { house: home.pass, houseDetails: home.details, farmland, plots: plots.length, herd,
      herdKind: ranch?.memory.kind, stored, deaths, projects: goal.memory.history.length } };
  },
};

module.exports = { lifeNatural };
