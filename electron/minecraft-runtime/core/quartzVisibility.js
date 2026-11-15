'use strict';

const { Vec3 } = require('vec3');
const { RaycastIterator } = require('prismarine-world').iterators;

const FACES = [[0, .5, .5], [1, .5, .5], [.5, 0, .5], [.5, 1, .5], [.5, .5, 0], [.5, .5, 1]];

function probeFaces(eye, target, trace) {
  let unknown = false;
  for (const [x, y, z] of FACES) {
    const delta = target.offset(x, y, z).minus(eye);
    const distance = delta.norm();
    if (distance <= 0 || distance > 4.5) continue;
    const seen = trace(delta.scaled(1 / distance), distance);
    if (seen === true) return true;
    if (seen === null) unknown = true;
  }
  return unknown ? null : false;
}

function quartzVisible(bot, feet, ore, actual = false) {
  if (!bot.world?.raycast) return false;
  const eyeHeight = actual ? bot.entity.eyeHeight ?? 1.62 : 1.62;
  if (!Number.isFinite(eyeHeight) || eyeHeight <= 0 || eyeHeight > 2.5) return false;
  const eye = actual ? feet.offset(0, eyeHeight, 0) : feet.offset(.5, eyeHeight, .5);
  return probeFaces(eye, ore.position, (direction, distance) => {
    const cells = new RaycastIterator(eye, direction, distance);
    for (let cell = eye; cell; cell = cells.next()) {
      if (!bot.blockAt(new Vec3(cell.x, cell.y, cell.z))) return null;
    }
    return bot.world.raycast(eye, direction, distance + .001)?.position?.equals(ore.position) === true;
  }) === true;
}

/** Test loaded shapes through projected air. A positive result only affects ranking. */
function projectedQuartzVisible(readBlock, stance, orePosition) {
  const eye = stance.offset(.5, 1.62, .5);
  return probeFaces(eye, orePosition, (direction, distance) => {
    const ray = new RaycastIterator(eye, direction, distance + .001);
    for (let cell = eye.floored(); cell; cell = ray.next()) {
      const position = new Vec3(cell.x, cell.y, cell.z);
      const block = readBlock(position);
      if (!Array.isArray(block?.shapes)) return null;
      if (ray.intersect(block.shapes, position)) return position.equals(orePosition);
    }
    return false;
  });
}

module.exports = { quartzVisible, projectedQuartzVisible };
