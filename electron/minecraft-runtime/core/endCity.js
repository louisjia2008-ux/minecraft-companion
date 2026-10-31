'use strict';
// Outer End: the gateway the dragon's death opens, the outer islands, end
// cities (purpur in the chunk data), their chests and the elytra on a ship.

const { Vec3 } = require('vec3');
const end = require('./end');

const AIR = new Set(['air', 'cave_air', 'void_air']);

function findGateway(bot, maxDistance = 128) {
  const id = bot.registry.blocksByName.end_gateway?.id;
  return bot.findBlocks({ matching: id, maxDistance, count: 8 }).map((p) => bot.blockAt(p)).filter(Boolean);
}

/**
 * Ground cells from which a thrown pearl flies into the gateway's side face
 * (bedrock caps it above and below). Nearest first.
 */
function pearlSpots(bot, gateway) {
  const target = gateway.position.offset(0.5, 0.5, 0.5);
  const isGateway = (b) => b.name === 'end_gateway';
  const spots = [];
  for (const r of [4, 6, 8, 10, 13, 16, 20, 24, 28, 32]) {
    for (let i = 0; i < 24; i += 1) {
      const a = (i / 24) * Math.PI * 2;
      const x = Math.round(target.x + Math.cos(a) * r - 0.5);
      const z = Math.round(target.z + Math.sin(a) * r - 0.5);
      const stand = end.surfaceAt(bot, x, z, { yMax: Math.floor(target.y) + 2, yMin: Math.floor(target.y) - 30 });
      if (!stand || end.overVoid(bot, x, stand.y, z)) continue;
      // Island ground only, not the gateway's bedrock or a bridge.
      if (bot.blockAt(stand.offset(0, -1, 0))?.name !== 'end_stone') continue;
      const origin = stand.offset(0.5, 1.52, 0.5);
      for (const high of [false, true]) {
        const shot = end.aim(origin, target, end.PEARL, { high });
        if (!shot) continue;
        const flight = end.flightInfo(bot, origin, shot, target, end.PEARL, { radius: 0.35, ignore: isGateway, size: 0.15 });
        // Only nearly level arrivals: a steep one clips the bedrock caps and
        // drops the bot beside the gateway, high over the ground.
        if (flight.hit && Math.abs(flight.slope) < 0.35) spots.push({ stand, high, slope: flight.slope });
      }
    }
  }
  const here = bot.entity.position.clone();
  // Flattest arrival first; distance to walk breaks ties.
  return spots.sort((a, b) => (Math.abs(a.slope) - Math.abs(b.slope)) * 40
    + (a.stand.distanceTo(here) - b.stand.distanceTo(here)) * 0.05);
}

const CITY_BLOCKS = ['purpur_block', 'purpur_pillar', 'end_stone_bricks', 'purpur_stairs', 'purpur_slab'];

/**
 * Nearest purpur in the loaded chunks: an end city (or its ship). `skip`
 * passes over cities already visited (one with no chests stays nearest).
 */
function findCity(bot, maxDistance = 160, { skip = () => false } = {}) {
  const ids = CITY_BLOCKS.map((n) => bot.registry.blocksByName[n]?.id).filter(Number.isInteger);
  const found = bot.findBlocks({ matching: ids, maxDistance, count: 2048 }).filter((p) => !skip(p));
  if (found.length === 0) return null;
  const here = bot.entity.position.clone();
  found.sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
  return found[0];
}

/**
 * The lowest city block near `p`: the door is at the bottom, and the first
 * purpur in sight is often a tower top forty blocks up, which no path
 * reaches (one run circled under a city for an hour).
 */
function cityBase(bot, p, radius = 48) {
  const ids = CITY_BLOCKS.map((n) => bot.registry.blocksByName[n]?.id).filter(Number.isInteger);
  const found = bot.findBlocks({ matching: ids, point: p, maxDistance: radius, count: 4096 });
  if (found.length === 0) return p;
  const flat = (q) => Math.hypot(q.x - p.x, q.z - p.z);
  found.sort((a, b) => a.y - b.y || flat(a) - flat(b));
  return found[0];
}

function cityChests(bot, maxDistance = 96) {
  const id = bot.registry.blocksByName.chest?.id;
  return bot.findBlocks({ matching: id, maxDistance, count: 32 })
    // City and ship chests stand among purpur; anything else is not loot.
    .filter((p) => nearPurpur(bot, p));
}

function nearPurpur(bot, p) {
  for (let dx = -3; dx <= 3; dx += 1) {
    for (let dy = -3; dy <= 3; dy += 1) {
      for (let dz = -3; dz <= 3; dz += 1) {
        if (/^(purpur|end_stone_bricks)/.test(bot.blockAt(p.offset(dx, dy, dz))?.name || '')) return true;
      }
    }
  }
  return false;
}

/** Item frames showing an elytra (end ships carry one). */
function elytraFrames(bot) {
  const index = bot.registry.entitiesByName.item_frame?.metadataKeys?.indexOf('item') ?? -1;
  return Object.values(bot.entities).filter((e) => {
    if (e.name !== 'item_frame' || !e.position) return false;
    const item = e.metadata?.[index];
    const id = item?.itemId ?? item?.blockId;
    return Number.isInteger(id) && bot.registry.items[id]?.name === 'elytra';
  });
}

/** Unit vector pointing away from the main island. */
function outward(bot) {
  const p = bot.entity.position;
  const n = Math.hypot(p.x, p.z) || 1;
  return new Vec3(p.x / n, 0, p.z / n);
}

const isAir = (b) => !b || AIR.has(b.name);

module.exports = { findGateway, pearlSpots, findCity, cityBase, cityChests, elytraFrames, outward, isAir, CITY_BLOCKS };
