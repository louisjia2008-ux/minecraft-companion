'use strict';
// A plain, serializable snapshot of what the bot can observe right now.
// Behaviors decide from this snapshot only; they never cache "what happened".

const HOSTILE_NAMES = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'spider', 'cave_spider',
  'creeper', 'witch', 'slime', 'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'vex',
  'silverfish', 'endermite', 'guardian', 'elder_guardian', 'blaze', 'ghast', 'magma_cube',
  'wither_skeleton', 'piglin_brute', 'hoglin', 'zoglin', 'breeze', 'warden',
]);

function isHostile(entity) {
  if (!entity || entity.type === 'player') return false;
  return entity.type === 'hostile' || HOSTILE_NAMES.has(entity.name);
}

/** Main inventory plus armor and off-hand, which inventory.items() leaves out. */
function ownedItems(bot) {
  const items = [...(bot?.inventory?.items?.() || [])];
  const slots = bot?.inventory?.slots || [];
  for (const slot of [5, 6, 7, 8, 45]) if (slots[slot]) items.push(slots[slot]);
  return items;
}

function countInventory(items) {
  const counts = {};
  for (const item of items || []) {
    if (!item || !item.name) continue;
    counts[item.name] = (counts[item.name] || 0) + item.count;
  }
  return counts;
}

function perceive(bot, { hostileRange = 16, now = Date.now } = {}) {
  const self = bot?.entity;
  if (!self || !self.position || !Number.isFinite(bot.health)) return { alive: false, at: now() };
  const position = self.position;
  const hostiles = [];
  for (const entity of Object.values(bot.entities || {})) {
    if (entity === self || !isHostile(entity) || !entity.position) continue;
    const distance = entity.position.distanceTo(position);
    if (distance <= hostileRange) {
      hostiles.push({ id: entity.id, name: entity.name, distance, position: entity.position.clone() });
    }
  }
  hostiles.sort((a, b) => a.distance - b.distance);
  return {
    at: now(),
    alive: bot.health > 0,
    health: bot.health,
    food: bot.food,
    position: position.clone(),
    onGround: self.onGround === true,
    inWater: self.isInWater === true,
    oxygen: Number.isFinite(bot.oxygenLevel) ? bot.oxygenLevel : null,
    isDay: Number.isFinite(bot.time?.timeOfDay) ? bot.time.timeOfDay < 12542 || bot.time.timeOfDay > 23460 : null,
    timeOfDay: Number.isFinite(bot.time?.timeOfDay) ? bot.time.timeOfDay : null,
    // Set by a goal while the bot waits out the night in a sealed bunker or the finished house.
    sheltered: bot.companionSheltered === true,
    inventory: countInventory(ownedItems(bot)),
    // Free main-inventory slots; drops cannot be picked up once this hits 0.
    freeSlots: typeof bot.inventory?.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : null,
    hostiles,
  };
}

/** Sums inventory counts of every item whose name passes `match`. */
function countMatching(inventory, match) {
  let total = 0;
  for (const [name, count] of Object.entries(inventory || {})) if (match(name)) total += count;
  return total;
}

module.exports = { perceive, isHostile, ownedItems, countInventory, countMatching, HOSTILE_NAMES };
