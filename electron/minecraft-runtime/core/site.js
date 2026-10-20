'use strict';
// Picks a building site and derives the remaining site work from the world.
// Only small terrain fixes are accepted (one-block bumps and holes); sites with
// trees, water or steep ground are skipped rather than terraformed.

const { createStarterHouse, SIZE, WALL_HEIGHT } = require('./blueprints/starterHouse');

const GROUND = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium', 'stone',
  'andesite', 'diorite', 'granite', 'sand', 'red_sand', 'terracotta', 'snow_block', 'moss_block', 'mud', 'clay']);
const TREE = (name) => name.endsWith('_log') || name.endsWith('_leaves') || name.endsWith('_wood');
const LIQUID = new Set(['water', 'lava', 'bubble_column']);

const isAir = (block) => !block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
const isSoft = (block) => isAir(block) || (block.boundingBox === 'empty' && !LIQUID.has(block.name));
const isSolid = (block) => Boolean(block) && block.boundingBox === 'block' && !LIQUID.has(block.name);

/** Top solid ground at (x, z), searching downward from `top`. */
function groundAt(blockAt, x, z, top, bottom) {
  for (let y = top; y >= bottom; y -= 1) {
    const block = blockAt(x, y, z);
    if (!block || isSoft(block)) continue;
    if (LIQUID.has(block.name)) return { liquid: true };
    if (TREE(block.name)) return { tree: true };
    if (!GROUND.has(block.name)) return { other: block.name };
    return { y };
  }
  return { missing: true };
}

function evaluateSite(blockAt, corner, around) {
  const heights = [];
  for (let dx = -1; dx <= SIZE; dx += 1) {
    for (let dz = -1; dz <= SIZE; dz += 1) {
      const ground = groundAt(blockAt, corner.x + dx, corner.z + dz, around.y + 10, around.y - 12);
      const inside = dx >= 0 && dz >= 0 && dx < SIZE && dz < SIZE;
      if (ground.y === undefined) {
        if (inside || ground.liquid) return null; // water next to the walls floods the door
        continue;
      }
      if (inside) heights.push(ground.y);
    }
  }
  const counts = new Map();
  for (const h of heights) counts.set(h, (counts.get(h) || 0) + 1);
  const [mode] = [...counts].sort((a, b) => b[1] - a[1])[0];
  let fills = 0;
  let digs = 0;
  for (const h of heights) {
    if (h === mode - 1) fills += 1;
    else if (h === mode + 1) digs += 1;
    else if (h !== mode) return null;
  }
  const anchor = { x: corner.x, y: mode + 1, z: corner.z };
  const house = createStarterHouse(anchor);
  for (const p of house.clearance) {
    const block = blockAt(p.x, p.y, p.z);
    if (block && TREE(block.name)) return null;
    if (block && LIQUID.has(block.name)) return null;
  }
  const doorstep = blockAt(house.entrance.x, house.entrance.y - 1, house.entrance.z);
  if (!isSolid(doorstep) && !isSoft(blockAt(house.entrance.x, house.entrance.y - 2, house.entrance.z))) {
    // A missing doorstep is fine only if there is something to stand on below.
    return null;
  }
  const distance = Math.hypot(corner.x + SIZE / 2 - around.x, corner.z + SIZE / 2 - around.z);
  return { anchor, fills, digs, cost: digs + fills * 2 + distance * 0.1 };
}

/** Best nearby site within `radius` of `around`, or null. */
function chooseSite(blockAt, around, { radius = 32, step = 3, maxWork = 12 } = {}) {
  let best = null;
  const center = { x: Math.floor(around.x), y: Math.floor(around.y), z: Math.floor(around.z) };
  for (let dx = -radius; dx <= radius; dx += step) {
    for (let dz = -radius; dz <= radius; dz += step) {
      const corner = { x: center.x + dx - Math.floor(SIZE / 2), z: center.z + dz - Math.floor(SIZE / 2) };
      const site = evaluateSite(blockAt, corner, center);
      if (!site || site.fills + site.digs > maxWork) continue;
      if (!best || site.cost < best.cost) best = site;
    }
  }
  return best;
}

/**
 * Remaining site work, derived fresh from the world every time:
 *   digs  - non-air blocks inside the clearance that are not correct house blocks
 *   fills - foundation cells that are not solid
 */
function siteWork(blockAt, house, isCorrect) {
  const digs = [];
  for (const p of house.clearance) {
    const block = blockAt(p.x, p.y, p.z);
    // Plants are simply replaced when a block is placed into them.
    if (isSoft(block) || isCorrect(p, block)) continue;
    digs.push({ position: p, name: block.name });
  }
  const fills = [];
  for (const p of house.foundation) {
    if (!isSolid(blockAt(p.x, p.y, p.z))) fills.push({ position: p });
  }
  // Dig from the top down so nothing falls into a cleared cell.
  digs.sort((a, b) => b.position.y - a.position.y);
  return { digs, fills };
}

module.exports = { chooseSite, evaluateSite, siteWork, groundAt, isAir, isSoft, isSolid, WALL_HEIGHT };
