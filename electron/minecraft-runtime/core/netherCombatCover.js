'use strict';

const { Vec3 } = require('vec3');
const { RaycastIterator } = require('prismarine-world').iterators;
const { posKey } = require('./blacklist');
const { standable } = require('./caveRetreat');
const { entityDimensions } = require('./entityGeometry');
const { inNether, lavaRisk, lookoutCardinalMoves } = require('./nether');

const SHOOTERS = new Set(['blaze', 'ghast']);
const PORTAL = /^(nether_portal|end_portal|end_gateway)$/;
const MAX_DISTANCE = 12;
const MAX_STEPS = 16;
const MAX_CELLS = 450;
const empty = (block) => block?.boundingBox === 'empty' && !PORTAL.test(block.name);
const full = (block) => block?.boundingBox === 'block' && block.shapes?.length === 1
  && block.shapes[0].length === 6 && block.shapes[0].every((value, i) => value === (i < 3 ? 0 : 1));
const hasFeet = (p) => [p?.x, p?.y, p?.z].every(Number.isFinite);
const cellCentre = (p) => p.offset(.5, 0, .5);

function shooterRays(bot, threats) {
  const shooters = new Map();
  for (const threat of threats || []) {
    if (!SHOOTERS.has(threat?.name)) continue;
    const native = bot.entities?.[threat.id];
    if (!native || native.isValid === false || native.name !== threat.name || !hasFeet(native.position)) return null;
    const height = entityDimensions(native, bot.registry)?.height;
    if (!height) return null;
    const p = new Vec3(native.position.x, native.position.y, native.position.z);
    const eye = native.eyeHeight ?? height * .85;
    // Projectiles come from near the body's centre rather than precisely
    // from the line the mob uses to see a player.
    shooters.set(native.id, [p.offset(0, eye, 0), p.offset(0, height / 2 + .5, 0)]);
  }
  return shooters.size ? [...shooters.values()].flat() : null;
}

function solidCover(read, from, to) {
  const delta = to.minus(from);
  const distance = delta.norm();
  if (distance < .25 || distance > 32 || !read(from)) return false;
  const ray = new RaycastIterator(from, delta.scaled(1 / distance), distance);
  for (let p = ray.next(); p; p = ray.next()) {
    const cell = new Vec3(p.x, p.y, p.z);
    const block = read(cell);
    if (!block) return false;
    if (full(block) && ray.intersect(block.shapes, cell)) return true;
  }
  return false;
}

const dry = (read, p) => standable(read, p) && empty(read(p)) && empty(read(p.offset(0, 1, 0)));
const sheltered = (read, origins, at) => origins.every((ray) =>
  [1.62, .85].every((y) => solidCover(read, ray, at.offset(0, y, 0))));

function hasNetherCombatCover({ bot, threats, position = bot.entity?.position }) {
  if (!inNether(bot) || !hasFeet(position)) return false;
  const origins = shooterRays(bot, threats);
  if (!origins) return false;
  const p = new Vec3(position.x, position.y, position.z);
  const cell = p.floored();
  const read = (at) => bot.blockAt(at);
  return dry(read, cell) && sheltered(read, origins, p.equals(cell) ? cellCentre(cell) : p);
}

/** Finds a short route to solid observed cover. Movement still needs the live combat guard. */
function findNetherCombatCover({ bot, threats }) {
  if (!inNether(bot) || !bot.entity?.onGround || bot.entity.isInLava || bot.entity.isInWater
    || !hasFeet(bot.entity.position)) return null;
  const origins = shooterRays(bot, threats);
  if (!origins) return null;
  const at = bot.entity.position;
  const start = at.floored();
  const cache = new Map();
  const read = (p) => {
    const point = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    const key = posKey(point);
    if (!cache.has(key)) cache.set(key, bot.blockAt(point));
    return cache.get(key);
  };
  if (!dry(read, start)) return null;
  if (sheltered(read, origins, at)) return { position: start, waypoints: [] };
  const world = { blockAt: read };
  const queue = [{ point: start, previous: null, depth: 0 }];
  const seen = new Set([posKey(start)]);
  let firstShelter = null;
  const result = (node) => {
    const waypoints = [];
    for (let next = node; next.previous; next = next.previous) waypoints.push(next.point);
    return { position: node.point, waypoints: waypoints.reverse() };
  };
  for (let i = 0; i < queue.length; i += 1) {
    const node = queue[i];
    const { point, depth } = node;
    if (firstShelter && depth > firstShelter.depth + 2) break;
    if (depth && sheltered(read, origins, cellCentre(point))) {
      if (full(read(point.offset(0, 2, 0)))) return result(node);
      firstShelter ||= node;
    }
    if (depth >= MAX_STEPS || (firstShelter && depth >= firstShelter.depth + 2)) continue;
    for (const neighbor of lookoutCardinalMoves(bot, point, read)) {
      const step = new Vec3(neighbor.x, neighbor.y, neighbor.z);
      const key = posKey(step);
      if (queue.length >= MAX_CELLS || seen.has(key) || neighbor.toBreak.length || !dry(read, step)
        || at.distanceTo(cellCentre(step)) > MAX_DISTANCE || lavaRisk(world, step) !== 0) continue;
      queue.push({ point: step, previous: node, depth: depth + 1 });
      seen.add(key);
    }
  }
  return firstShelter ? result(firstShelter) : null;
}

module.exports = { findNetherCombatCover, hasNetherCombatCover };
