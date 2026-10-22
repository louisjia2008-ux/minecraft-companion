'use strict';
// What a blueprint still needs, as planner requirements. Pure: reads the world
// through `nameAt` and counts every block that is not in place yet, so a
// half-built machine only asks for what is missing.
//
// A blueprint block is { position, family } where family is a knowledge key
// (cobblestone, hopper, water_bucket...). Liquids are placed from buckets, so
// a water_bucket block counts as placed when the cell holds water.

const { KNOWLEDGE } = require('./knowledge');

const PLACED_AS = { water_bucket: 'water', lava_bucket: 'lava' };

function isPlaced(block, name, kb) {
  if (!name) return false;
  if (typeof block.placed === 'function') return block.placed(name);
  if (PLACED_AS[block.family]) return name === PLACED_AS[block.family];
  return kb[block.family].match(name);
}

/** Requirements ({ key, count }) for every blueprint block not yet in place, in blueprint order. */
function materialsFor(blocks, nameAt, kb = KNOWLEDGE) {
  const totals = new Map();
  for (const block of blocks) {
    if (!kb[block.family]) throw new Error(`Unknown material ${block.family}`);
    if (isPlaced(block, nameAt(block.position), kb)) continue;
    totals.set(block.family, (totals.get(block.family) || 0) + 1);
  }
  return [...totals].map(([key, count]) => ({ key, count }));
}

module.exports = { materialsFor };
