'use strict';
// Mineflayer's registry dimensions are the size-one slime/magma dimensions.
// Their named metadata `size` is the actual scale, not the NBT Size value
// (vanilla serializes NBT Size as metadata size - 1). Never infer an index.
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { RaycastIterator } = require('prismarine-world').iterators;
const SCALED = new Set(['slime', 'magma_cube']);
const finitePosition = (p) => [p?.x, p?.y, p?.z].every(Number.isFinite);
const validDimension = (n, max) => Number.isFinite(n) && n > 0 && n <= max;

function entitySizeEvidence(entity, registry) {
  const definition = registry?.entitiesByName?.[entity?.name];
  const index = definition?.metadataKeys?.indexOf('size') ?? -1;
  const version = registry?.version?.minecraftVersion ?? null;
  const sizePresent = index >= 0 && Object.hasOwn(entity?.metadata || {}, index);
  const raw = sizePresent ? entity.metadata[index] : undefined;
  const attributes = Object.hasOwn(entity || {}, 'attributes') ? entity.attributes : null;
  const entries = attributes && typeof attributes === 'object' && !Array.isArray(attributes) ? Object.values(attributes) : [];
  // Vanilla1.21.8 pairs spawn -> optional nondefault metadata -> nonempty
  // living sync attributes. Mineflayer processes those packets synchronously;
  // its Entity constructor has metadata=[] and no attributes property. A
  // preexisting nonempty native attributes map is also a completed barrier,
  // since the companion may be installed after the initial packets arrived.
  const initialSyncComplete = version === '1.21.8' && Array.isArray(entity?.metadata) && entries.length > 0
    && entries.every((a) => a && Number.isFinite(a.value) && Array.isArray(a.modifiers));
  const validSize = Number.isInteger(raw) && raw >= 1 && raw <= 127;
  const source = index < 0 ? 'missing_size_key' : sizePresent ? (validSize ? 'metadata' : 'invalid_metadata')
    : version !== '1.21.8' ? 'unsupported_default_version' : initialSyncComplete ? 'vanilla_default_after_sync_attributes' : 'awaiting_initial_sync';
  return { version, index, sizePresent, sizeValue: raw ?? null, sizeType: sizePresent ? typeof raw : null,
    attributeCount: entries.length, initialSyncComplete, source,
    size: validSize ? raw : !sizePresent && index >= 0 && initialSyncComplete ? 1 : null };
}

function entityDimensions(entity, registry) {
  const definition = registry?.entitiesByName?.[entity?.name];
  if (SCALED.has(entity?.name)) {
    const { size } = entitySizeEvidence(entity, registry);
    // A missing initial field is unknown until the proven pairing barrier.
    // Explicit malformed values can never be replaced by the vanilla default.
    if (!Number.isInteger(size) || size < 1 || size > 127
      || !validDimension(definition?.width, 4) || !validDimension(definition?.height, 12)) return null;
    return { width: definition.width * size, height: definition.height * size, size };
  }
  const width = entity?.width ?? definition?.width;
  const height = entity?.height ?? definition?.height;
  return validDimension(width, 16) && validDimension(height, 32) ? { width, height, size: null } : null;
}

function meleeGeometry(player, target, registry) {
  const dimensions = entityDimensions(target, registry);
  const p = player?.position, t = target?.position;
  const eyeHeight = player?.eyeHeight ?? 1.62;
  if (!dimensions || !finitePosition(p) || !finitePosition(t) || !validDimension(eyeHeight, 2.5)) return null;
  const eye = new Vec3(p.x, p.y + eyeHeight, p.z);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const point = new Vec3(clamp(eye.x, t.x - dimensions.width / 2, t.x + dimensions.width / 2),
    clamp(eye.y, t.y, t.y + dimensions.height), clamp(eye.z, t.z - dimensions.width / 2, t.z + dimensions.width / 2));
  return { ...dimensions, eye, point, distance: eye.distanceTo(point), feetDistance: p.distanceTo ? p.distanceTo(t) : Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) };
}

function meleeSight(bot, geometry) {
  if (!geometry || typeof bot.blockAt !== 'function' || typeof bot.world?.raycast !== 'function') return 'unknown';
  const { eye, point, distance } = geometry;
  if (!finitePosition(eye) || !finitePosition(point) || !Number.isFinite(distance) || distance < 0) return 'unknown';
  const delta = point.minus(eye);
  try {
    if (distance < 1e-6) {
      const atEye = bot.blockAt(eye);
      return !atEye ? 'unknown' : atEye.boundingBox === 'empty' ? 'clear' : 'blocked';
    }
    const direction = delta.scaled(1 / distance);
    // Native shapes raycast skips missing chunks. Walk its exact voxel DDA
    // first: fixed-distance samples can miss a short chunk-corner crossing.
    const cells = new RaycastIterator(eye, direction, distance);
    for (let p = eye; p; p = cells.next()) {
      if (!bot.blockAt(new Vec3(p.x, p.y, p.z))) return 'unknown';
    }
    const hit = bot.world.raycast(eye, direction, distance);
    if (hit && typeof hit.then === 'function') return 'unknown';
    return hit ? 'blocked' : 'clear';
  } catch { return 'unknown'; }
}

function bodiesOverlap(player, target, dimensions) {
  const p = player.position, t = target.position;
  const radius = (validDimension(player.width, 2) ? player.width : 0.6) / 2 + 0.15;
  const height = validDimension(player.height, 3) ? player.height : 1.8;
  return p.y < t.y + dimensions.height && p.y + height > t.y
    && Math.abs(p.x - t.x) < dimensions.width / 2 + radius && Math.abs(p.z - t.z) < dimensions.width / 2 + radius;
}

// Reachable, visible standing points outside the observed body, rather than
// a fixed 1.5m chase that can ask the pathfinder to enter a large cube.
class MeleeFollowGoal extends goals.GoalFollow {
  constructor(bot, target, reach) {
    const dimensions = entityDimensions(target, bot.registry);
    super(target, Math.max(1.5, (dimensions?.width || 0.6) / 2 + 0.45));
    this.bot = bot;
    this.reach = reach;
    this.geometryKey = dimensions ? `${dimensions.width},${dimensions.height}` : null;
  }

  isEnd(node) {
    const player = { ...this.bot.entity, position: new Vec3(node.x + 0.5, node.y, node.z + 0.5) };
    const geometry = meleeGeometry(player, this.entity, this.bot.registry);
    return Boolean(geometry && geometry.distance <= this.reach - 0.1 && !bodiesOverlap(player, this.entity, geometry)
      && meleeSight(this.bot, geometry) === 'clear');
  }

  hasChanged() {
    const dimensions = entityDimensions(this.entity, this.bot.registry);
    const key = dimensions ? `${dimensions.width},${dimensions.height}` : null;
    const p = this.entity.position.floored();
    if (key !== this.geometryKey || Math.hypot(this.x - p.x, this.y - p.y, this.z - p.z) > 1.5) {
      this.x = p.x; this.y = p.y; this.z = p.z; this.geometryKey = key;
      return true;
    }
    return false;
  }

  isValid() {
    return this.entity?.isValid !== false && this.bot.entities?.[this.entity?.id] === this.entity
      && Boolean(entityDimensions(this.entity, this.bot.registry));
  }
}

function installEntityGeometry(bot) {
  let active = true;
  const update = (entity) => {
    if (!active || !SCALED.has(entity?.name)) return;
    const dimensions = entityDimensions(entity, bot.registry);
    if (!dimensions) return;
    entity.width = dimensions.width;
    entity.height = dimensions.height;
  };
  for (const entity of Object.values(bot.entities || {})) update(entity);
  bot.on?.('entitySpawn', update);
  bot.on?.('entityUpdate', update);
  bot.on?.('entityAttributes', update);
  return () => {
    active = false;
    bot.removeListener?.('entitySpawn', update);
    bot.removeListener?.('entityUpdate', update);
    bot.removeListener?.('entityAttributes', update);
    // Observed dimensions are facts, not temporary movement settings. Leave
    // their last values intact; a new companion reads the latest metadata.
  };
}

module.exports = { entityDimensions, entitySizeEvidence, meleeGeometry, meleeSight, MeleeFollowGoal, installEntityGeometry };
