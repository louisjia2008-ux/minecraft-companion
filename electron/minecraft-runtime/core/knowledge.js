'use strict';
// What the companion knows about obtaining things. Pure data: keys are
// resource families (any log counts as "log"), each with ordered sources.
//
// Source kinds:
//   craft  { yields, needs: { key: count }, table, pick(inventory) -> concrete item name }
//   gather { blocks(name) -> bool, tool?: key }      break a block, collect the drop
//   smelt  { input: key, fuel: true }                 at the home furnace
//   hunt   { mobs: [names] }                          kill, collect drops
//   fill   { liquid, bucket: key }                     use an empty bucket on a source block
//   station                                           a placed crafting table / furnace

const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak'];
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray',
  'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];

const isLog = (n) => n.endsWith('_log') && !n.startsWith('stripped_') && WOODS.some((w) => n === `${w}_log`);
const isPlanks = (n) => n.endsWith('_planks') && WOODS.some((w) => n === `${w}_planks`);
const exact = (...names) => { const set = new Set(names); return (n) => set.has(n); };

// Raw meats are fine early; risky foods are handled by the eat action itself.
const MEATS = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cooked_beef', 'cooked_porkchop',
  'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'bread', 'apple', 'baked_potato', 'carrot', 'sweet_berries'];

function byMost(inventory, names) {
  let best = null;
  for (const name of names) if ((inventory[name] || 0) > (inventory[best] || 0)) best = name;
  return best;
}

/** Wood type with the most planks (or logs, if no planks yet). */
function dominantWood(inventory) {
  const planks = byMost(inventory, WOODS.map((w) => `${w}_planks`));
  if (planks) return planks.replace(/_planks$/, '');
  const log = byMost(inventory, WOODS.map((w) => `${w}_log`));
  return log ? log.replace(/_log$/, '') : 'oak';
}

const KNOWLEDGE = {
  log: { match: isLog, sources: [{ kind: 'gather', blocks: isLog }] },
  planks: {
    match: isPlanks,
    // Every recipe takes one kind of planks (3 birch + 1 oak make no chest),
    // so only the most plentiful kind counts.
    count: (inv) => Math.max(0, ...WOODS.map((w) => inv[`${w}_planks`] || 0)),
    sources: [{
      kind: 'craft', yields: 4, needs: { log: 1 }, table: false,
      // Craft planks from whatever log is most plentiful.
      pick: (inv) => `${(byMost(inv, WOODS.map((w) => `${w}_log`)) || 'oak_log').replace(/_log$/, '')}_planks`,
    }],
  },
  stick: { match: exact('stick'), sources: [{ kind: 'craft', yields: 4, needs: { planks: 2 }, table: false, pick: () => 'stick' }] },
  crafting_table: {
    match: exact('crafting_table'),
    sources: [{ kind: 'craft', yields: 1, needs: { planks: 4 }, table: false, pick: () => 'crafting_table' }],
  },
  wooden_pickaxe: {
    match: exact('wooden_pickaxe'),
    tool: true,
    sources: [{ kind: 'craft', yields: 1, needs: { planks: 3, stick: 2 }, table: true, pick: () => 'wooden_pickaxe' }],
  },
  // Tool tiers: a better tool satisfies a lower requirement.
  pickaxe: {
    match: exact('wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'),
    tool: true,
    sources: [{ kind: 'alias', key: 'wooden_pickaxe' }],
  },
  iron_tier_pickaxe: {
    match: exact('iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'),
    tool: true,
    sources: [{ kind: 'alias', key: 'iron_pickaxe' }],
  },
  stone_tier_pickaxe: {
    match: exact('stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'),
    tool: true,
    sources: [{ kind: 'alias', key: 'stone_pickaxe' }],
  },
  cobblestone: {
    match: exact('cobblestone', 'cobbled_deepslate'),
    sources: [{ kind: 'gather', blocks: exact('stone', 'cobblestone', 'deepslate', 'cobbled_deepslate'), tool: 'pickaxe' }],
  },
  stone_pickaxe: {
    match: exact('stone_pickaxe'),
    tool: true,
    sources: [{ kind: 'craft', yields: 1, needs: { cobblestone: 3, stick: 2 }, table: true, pick: () => 'stone_pickaxe' }],
  },
  stone_sword: {
    match: exact('stone_sword', 'iron_sword', 'diamond_sword', 'netherite_sword'),
    tool: true,
    sources: [{ kind: 'craft', yields: 1, needs: { cobblestone: 2, stick: 1 }, table: true, pick: () => 'stone_sword' }],
  },
  furnace: {
    match: exact('furnace'),
    sources: [{ kind: 'craft', yields: 1, needs: { cobblestone: 8 }, table: true, pick: () => 'furnace' }],
  },
  coal: {
    match: exact('coal', 'charcoal'),
    sources: [{ kind: 'gather', blocks: exact('coal_ore', 'deepslate_coal_ore'), tool: 'pickaxe' }],
  },
  raw_iron: {
    match: exact('raw_iron'),
    sources: [{ kind: 'gather', blocks: exact('iron_ore', 'deepslate_iron_ore'), tool: 'stone_tier_pickaxe' }],
  },
  iron_ingot: { match: exact('iron_ingot'), sources: [{ kind: 'smelt', input: 'raw_iron', inputItem: 'raw_iron' }] },
  iron_sword: {
    match: exact('iron_sword', 'diamond_sword', 'netherite_sword'),
    tool: true,
    sources: [{ kind: 'craft', yields: 1, needs: { iron_ingot: 2, stick: 1 }, table: true, pick: () => 'iron_sword' }],
  },
  iron_pickaxe: {
    match: exact('iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'),
    tool: true,
    sources: [{ kind: 'craft', yields: 1, needs: { iron_ingot: 3, stick: 2 }, table: true, pick: () => 'iron_pickaxe' }],
  },
  shield: {
    match: exact('shield'),
    tool: true,
    sources: [{ kind: 'craft', yields: 1, needs: { iron_ingot: 1, planks: 6 }, table: true, pick: () => 'shield' }],
  },
  torch: {
    match: exact('torch'),
    sources: [{ kind: 'craft', yields: 4, needs: { coal: 1, stick: 1 }, table: false, pick: () => 'torch' }],
  },
  wool: {
    match: (n) => n.endsWith('_wool') && COLORS.some((c) => n === `${c}_wool`),
    // A bed needs three wool of one color, so only the most common color counts.
    count: (inv) => Math.max(0, ...COLORS.map((c) => inv[`${c}_wool`] || 0)),
    // Four string make a white wool: where there are no sheep, spiders still are.
    sources: [
      { kind: 'craft', yields: 1, needs: { string: 4 }, table: false, pick: () => 'white_wool', when: (inv) => (inv.string || 0) >= 4 },
      { kind: 'hunt', mobs: ['sheep'] },
    ],
  },
  string: { match: exact('string'), sources: [{ kind: 'hunt', mobs: ['spider', 'cave_spider'] }] },
  bed: {
    match: (n) => n.endsWith('_bed'),
    sources: [{
      kind: 'craft', yields: 1, needs: { wool: 3, planks: 3 }, table: true,
      pick: (inv) => `${(byMost(inv, COLORS.map((c) => `${c}_wool`)) || 'white_wool').replace(/_wool$/, '')}_bed`,
    }],
  },
  chest: { match: exact('chest'), sources: [{ kind: 'craft', yields: 1, needs: { planks: 8 }, table: true, pick: () => 'chest' }] },
  door: {
    match: (n) => n.endsWith('_door') && WOODS.some((w) => n === `${w}_door`),
    sources: [{ kind: 'craft', yields: 3, needs: { planks: 6 }, table: true, pick: (inv) => `${dominantWood(inv)}_door` }],
  },
  // Redstone machine parts. Natural redstone and quartz ore are mined where
  // they are seen; deep branch mining and the Nether are separate steps.
  bucket: { match: exact('bucket'), sources: [{ kind: 'craft', yields: 1, needs: { iron_ingot: 3 }, table: true, pick: () => 'bucket' }] },
  water_bucket: { match: exact('water_bucket'), sources: [{ kind: 'fill', liquid: 'water', bucket: 'bucket' }] },
  lava_bucket: { match: exact('lava_bucket'), sources: [{ kind: 'fill', liquid: 'lava', bucket: 'bucket' }] },
  hopper: {
    match: exact('hopper'),
    sources: [{ kind: 'craft', yields: 1, needs: { iron_ingot: 5, chest: 1 }, table: true, pick: () => 'hopper' }],
  },
  redstone: {
    match: exact('redstone'),
    sources: [{ kind: 'gather', blocks: exact('redstone_ore', 'deepslate_redstone_ore'), tool: 'iron_tier_pickaxe' }],
  },
  quartz: {
    match: exact('quartz'),
    sources: [{ kind: 'gather', blocks: exact('nether_quartz_ore'), tool: 'pickaxe', dimension: 'the_nether' }],
  },
  // Smooth stone for repeaters: cobblestone smelted once.
  stone: { match: exact('stone'), sources: [{ kind: 'smelt', input: 'cobblestone', inputItem: 'cobblestone' }] },
  sand: { match: exact('sand'), sources: [{ kind: 'gather', blocks: exact('sand') }] },
  glass: { match: exact('glass'), sources: [{ kind: 'smelt', input: 'sand', inputItem: 'sand' }] },
  sugar_cane: { match: exact('sugar_cane'), sources: [{ kind: 'gather', blocks: exact('sugar_cane') }] },
  redstone_torch: {
    match: exact('redstone_torch'),
    sources: [{ kind: 'craft', yields: 1, needs: { redstone: 1, stick: 1 }, table: false, pick: () => 'redstone_torch' }],
  },
  repeater: {
    match: exact('repeater'),
    sources: [{ kind: 'craft', yields: 1, needs: { redstone_torch: 2, redstone: 1, stone: 3 }, table: true, pick: () => 'repeater' }],
  },
  piston: {
    match: exact('piston'),
    sources: [{ kind: 'craft', yields: 1, needs: { planks: 3, cobblestone: 4, iron_ingot: 1, redstone: 1 }, table: true, pick: () => 'piston' }],
  },
  observer: {
    match: exact('observer'),
    sources: [{ kind: 'craft', yields: 1, needs: { cobblestone: 6, redstone: 2, quartz: 1 }, table: true, pick: () => 'observer' }],
  },
  bow: {
    match: exact('bow'),
    sources: [{ kind: 'craft', yields: 1, needs: { stick: 3, string: 3 }, table: true, pick: () => 'bow' }],
  },
  dispenser: {
    match: exact('dispenser'),
    sources: [{ kind: 'craft', yields: 1, needs: { cobblestone: 7, bow: 1, redstone: 1 }, table: true, pick: () => 'dispenser' }],
  },
  food: { match: exact(...MEATS), sources: [{ kind: 'hunt', mobs: ['cow', 'pig', 'sheep', 'chicken', 'rabbit'] }] },
  dirt: { match: exact('dirt'), sources: [{ kind: 'gather', blocks: exact('dirt', 'grass_block', 'coarse_dirt') }] },
};

// Fuel accepted by the furnace, in preference order, with items smelted per unit.
const FUELS = [['coal', 8], ['charcoal', 8], ['oak_log', 1.5], ['spruce_log', 1.5], ['birch_log', 1.5],
  ['jungle_log', 1.5], ['acacia_log', 1.5], ['dark_oak_log', 1.5], ['mangrove_log', 1.5], ['cherry_log', 1.5],
  ...WOODS.map((w) => [`${w}_planks`, 1.5])];

function countKey(key, inventory, kb = KNOWLEDGE) {
  const entry = kb[key];
  if (!entry) throw new Error(`Unknown resource ${key}`);
  if (entry.count) return entry.count(inventory);
  let total = 0;
  for (const [name, n] of Object.entries(inventory)) if (n > 0 && entry.match(name)) total += n;
  return total;
}

/** Which family a concrete item belongs to, for block placement material checks. */
function familyOf(name, kb = KNOWLEDGE) {
  for (const [key, entry] of Object.entries(kb)) if (!entry.tool && entry.match(name)) return key;
  return null;
}

module.exports = { KNOWLEDGE, FUELS, WOODS, COLORS, MEATS, isLog, isPlanks, countKey, familyOf, dominantWood, byMost };
