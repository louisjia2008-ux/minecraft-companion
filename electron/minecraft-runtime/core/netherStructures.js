'use strict';
// Nether structures and the mobs that live in them, read from loaded chunks.
//
// Fortresses are the only nether structure built from nether bricks; bastions
// are polished blackstone bricks (nether ruined portals use a few of those
// too, so a bastion needs many of them together). Only a fortress has blaze
// spawners near nether bricks; a bastion's spawners hold magma cubes.

const FORTRESS_BLOCKS = ['nether_bricks', 'nether_brick_fence', 'nether_brick_stairs', 'nether_brick_slab'];
const BASTION_BLOCKS = ['polished_blackstone_bricks', 'cracked_polished_blackstone_bricks', 'gilded_blackstone',
  'polished_blackstone_brick_stairs', 'polished_blackstone_brick_slab', 'polished_blackstone_brick_wall'];
// The fewest blocks of a kind, close together, that make it a structure.
const MIN_BLOCKS = { fortress: 24, bastion: 48 };
const CLUSTER = 24;

const ids = (bot, names) => names.map((n) => bot.registry.blocksByName[n]?.id).filter(Number.isInteger);

/**
 * The nearest structure of `kind` in loaded chunks: the position of its
 * nearest block plus how many of its blocks were seen around that one.
 */
function findStructure(bot, kind, { maxDistance = 128, count = 256 } = {}) {
  const matching = ids(bot, kind === 'fortress' ? FORTRESS_BLOCKS : BASTION_BLOCKS);
  if (!matching.length) return null;
  const found = bot.findBlocks({ matching, maxDistance, count });
  for (const p of found) {
    const around = found.filter((q) => q.distanceTo(p) <= CLUSTER).length;
    if (around >= MIN_BLOCKS[kind]) return { position: p, blocks: around };
  }
  return null;
}

/** Spawners within `radius` of `near`, nearest first. */
function findSpawners(bot, near, radius = 64) {
  const id = bot.registry.blocksByName.spawner?.id;
  if (!Number.isInteger(id)) return [];
  return bot.findBlocks({ matching: id, maxDistance: 128, count: 16 })
    .filter((p) => !near || p.distanceTo(near) <= radius)
    .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
}

/**
 * Nether-brick cells with room to stand on top, within `radius` of `near`: the
 * fortress floor, nearest first. Every brick in range is looked at: a bridge's
 * pillars hold thousands of bricks under its deck, all nearer than the floor.
 */
function fortressFloor(bot, near, radius = 48, count = 64) {
  const id = bot.registry.blocksByName.nether_bricks?.id;
  if (!Number.isInteger(id)) return [];
  const open = (p) => {
    const b = bot.blockAt(p);
    return b && b.boundingBox === 'empty' && !/lava|fire/.test(b.name);
  };
  return bot.findBlocks({ point: near, matching: id, maxDistance: radius, count: Number.MAX_SAFE_INTEGER })
    .filter((p) => p.distanceTo(near) <= radius && open(p.offset(0, 1, 0)) && open(p.offset(0, 2, 0)))
    .slice(0, count);
}

/**
 * Where to tower up to a fortress deck that no walk reaches: columns of open
 * air right beside a deck edge, with solid ground (not lava) under them.
 * Feet at `top` in such a column, the deck cell is one step sideways. Each
 * spot: `stand` (the cell above the ground), `deck` (the floor brick) and
 * `top`, nearest to `from` first.
 */
function towerSpots(bot, floor, from, { maxDrop = 48 } = {}) {
  const at = (p) => bot.blockAt(p);
  const open = (p) => { const b = at(p); return b && b.boundingBox === 'empty' && !/lava|fire/.test(b.name); };
  const seen = new Set();
  const spots = [];
  for (const deck of floor) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const side = deck.offset(dx, 0, dz);
      if (!open(side) || !open(side.offset(0, 1, 0)) || !open(side.offset(0, 2, 0))) continue;
      let ground = null;
      for (let y = side.y - 1; y >= side.y - maxDrop; y -= 1) {
        const p = side.offset(0, y - side.y, 0);
        const b = at(p);
        if (!b || /lava|fire|magma/.test(b.name)) break;
        if (b.boundingBox === 'block') { ground = p; break; }
      }
      if (!ground || ground.y >= side.y - 1) continue;
      const key = `${ground.x},${ground.y},${ground.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      spots.push({ stand: ground.offset(0, 1, 0), deck, top: deck.y + 1 });
    }
  }
  return spots.sort((a, b) => a.stand.distanceTo(from) - b.stand.distanceTo(from));
}

const metaIndex = (bot, entity, key) => bot.registry.entitiesByName?.[entity]?.metadataKeys?.indexOf(key) ?? -1;

/** Adult piglins barter; babies keep the gold. */
function isAdultPiglin(bot, entity) {
  if (entity?.name !== 'piglin') return false;
  const baby = metaIndex(bot, 'piglin', 'baby');
  return !(baby >= 0 && entity.metadata?.[baby] === true);
}

/** A piglin holding something in its off-hand is busy looking at gold. */
function piglinBusy(entity) {
  const offhand = entity?.equipment?.[1];
  return Boolean(offhand && offhand.name);
}

// Barter loot (Java 1.21). Anything else on the ground near a piglin is not ours.
const BARTER_LOOT = new Set(['enchanted_book', 'iron_boots', 'potion', 'splash_potion', 'iron_nugget', 'ender_pearl',
  'string', 'quartz', 'obsidian', 'crying_obsidian', 'fire_charge', 'leather', 'soul_sand', 'nether_brick',
  'spectral_arrow', 'gravel', 'blackstone']);

const POTION_IDS = { fire_resistance: 11, long_fire_resistance: 12 };

/** True for a drinkable potion of fire resistance (any duration). */
function isFireResistancePotion(item) {
  if (item?.name !== 'potion') return false;
  const contents = item.componentMap?.get?.('potion_contents')?.data
    || item.components?.find?.((c) => c.type === 'potion_contents')?.data;
  if (!contents) return false;
  const id = contents.potionId ?? contents.potion?.potionId ?? contents.potion;
  if (typeof id === 'number') return id === POTION_IDS.fire_resistance || id === POTION_IDS.long_fire_resistance;
  return /fire_resistance/.test(JSON.stringify(contents));
}

function hasEffect(bot, name) {
  const effect = Object.values(bot.registry.effects || {}).find((e) => e.name === name);
  if (!effect) return false;
  const active = bot.entity?.effects?.[effect.id];
  return Boolean(active);
}

module.exports = {
  findStructure, findSpawners, fortressFloor, towerSpots, isAdultPiglin, piglinBusy, isFireResistancePotion, hasEffect,
  FORTRESS_BLOCKS, BASTION_BLOCKS, BARTER_LOOT,
};
