const HOSTILE_MOB_NAMES = new Set([
  "zombie",
  "husk",
  "drowned",
  "phantom",
  "skeleton",
  "stray",
  "blaze",
  "creeper",
  "spider",
  "cave_spider",
  "enderman",
  "witch",
  "slime",
  "ender_dragon",
]);

const HOSTILE_PRIORITY = {
  phantom: 1,
  creeper: 0,
  blaze: 1,
  skeleton: 1,
  stray: 1,
  witch: 1,
  zombie: 2,
  husk: 2,
  drowned: 2,
  cave_spider: 2,
  spider: 3,
  slime: 4,
  enderman: 5,
  ender_dragon: 6,
};

const RESOURCE_ALIASES = {
  stone: {
    blocks: ["stone", "cobblestone"],
    items: ["cobblestone", "stone"],
  },
  cobblestone: {
    blocks: ["stone", "cobblestone"],
    items: ["cobblestone", "stone"],
  },
  wood: {
    blocks: [
      "oak_log",
      "birch_log",
      "spruce_log",
      "jungle_log",
      "acacia_log",
      "dark_oak_log",
      "mangrove_log",
      "cherry_log",
    ],
    items: [
      "oak_log",
      "birch_log",
      "spruce_log",
      "jungle_log",
      "acacia_log",
      "dark_oak_log",
      "mangrove_log",
      "cherry_log",
    ],
  },
  oak_planks: {
    blocks: ["oak_planks"],
    items: ["oak_planks"],
  },
  dirt: {
    blocks: ["dirt", "grass_block"],
    items: ["dirt"],
  },
  sand: {
    blocks: ["sand"],
    items: ["sand"],
  },
  diamond: {
    blocks: ["diamond_ore", "deepslate_diamond_ore"],
    items: ["diamond"],
  },
  coal: {
    blocks: ["coal_ore", "deepslate_coal_ore"],
    items: ["coal"],
  },
  flint: {
    blocks: ["gravel"],
    items: ["flint"],
  },
  gravel: {
    blocks: ["gravel"],
    items: ["gravel", "flint"],
  },
  iron_ore: {
    blocks: ["iron_ore", "deepslate_iron_ore"],
    items: ["raw_iron", "iron_ore"],
  },
  raw_iron: {
    blocks: ["iron_ore", "deepslate_iron_ore"],
    items: ["raw_iron", "iron_ore"],
  },
  obsidian: {
    blocks: ["obsidian"],
    items: ["obsidian"],
  },
};

const BUILD_MATERIAL_ALIASES = {
  wood: "oak_planks",
  oak: "oak_planks",
  plank: "oak_planks",
  planks: "oak_planks",
  cobblestone: "cobblestone",
  stone: "cobblestone",
};

const LOG_TO_PLANK = {
  oak_log: "oak_planks",
  birch_log: "birch_planks",
  spruce_log: "spruce_planks",
  jungle_log: "jungle_planks",
  acacia_log: "acacia_planks",
  dark_oak_log: "dark_oak_planks",
  mangrove_log: "mangrove_planks",
  cherry_log: "cherry_planks",
  pale_oak_log: "pale_oak_planks",
};

const PLANK_TO_LOG = Object.fromEntries(
  Object.entries(LOG_TO_PLANK).map(([logName, plankName]) => [plankName, logName])
);

const ANY_PLANKS = Object.values(LOG_TO_PLANK);
const PICKAXE_ITEM_NAMES = [
  "diamond_pickaxe",
  "netherite_pickaxe",
  "iron_pickaxe",
  "stone_pickaxe",
  "golden_pickaxe",
  "wooden_pickaxe",
];
const AXE_ITEM_PRIORITY = [
  "netherite_axe",
  "diamond_axe",
  "iron_axe",
  "stone_axe",
  "wooden_axe",
];
const SWORD_ITEM_PRIORITY = [
  "netherite_sword",
  "diamond_sword",
  "iron_sword",
  "stone_sword",
  "wooden_sword",
];
const FOOD_ITEM_PRIORITY = [
  "cooked_beef",
  "cooked_porkchop",
  "baked_potato",
  "bread",
  "cooked_chicken",
  "cooked_mutton",
  "cooked_rabbit",
  "cooked_cod",
  "cooked_salmon",
  "beef",
  "porkchop",
  "potato",
  "apple",
  "carrot",
  "melon_slice",
];
const REPLACEABLE_BLOCK_KEYWORDS = [
  "grass",
  "fern",
  "flower",
  "bush",
  "sapling",
  "vine",
  "roots",
  "fungus",
  "mushroom",
  "seagrass",
  "kelp",
  "snow",
  "candle",
  "torch",
  "button",
  "rail",
  "tripwire",
  "carpet",
  "dead_bush",
];
const CONTAINER_BLOCK_NAMES = ["chest", "trapped_chest", "barrel"];
const FURNACE_BLOCK_NAMES = ["furnace", "blast_furnace"];
const TORCH_BLOCK_NAMES = ["torch", "wall_torch", "soul_torch", "soul_wall_torch"];
const NETHER_PORTAL_BLOCK_NAMES = ["nether_portal"];
const NETHER_FORTRESS_BLOCK_NAMES = [
  "nether_bricks",
  "cracked_nether_bricks",
  "nether_brick_fence",
  "nether_brick_stairs",
];
const STRONGHOLD_BLOCK_NAMES = [
  "stone_bricks",
  "mossy_stone_bricks",
  "cracked_stone_bricks",
  "infested_stone_bricks",
  "stone_brick_stairs",
  "iron_bars",
];
const END_PORTAL_FRAME_BLOCK_NAMES = ["end_portal_frame"];
const END_PORTAL_BLOCK_NAMES = ["end_portal"];
const END_SAFE_SURFACE_BLOCK_NAMES = ["end_stone", "obsidian", "bedrock"];
const END_VICTORY_BLOCK_NAMES = ["dragon_egg", "end_portal", "bedrock"];
const BED_ITEM_NAMES = [
  "white_bed",
  "orange_bed",
  "magenta_bed",
  "light_blue_bed",
  "yellow_bed",
  "lime_bed",
  "pink_bed",
  "gray_bed",
  "light_gray_bed",
  "cyan_bed",
  "purple_bed",
  "blue_bed",
  "brown_bed",
  "green_bed",
  "red_bed",
  "black_bed",
];
const WOOL_ITEM_NAMES = [
  "white_wool",
  "orange_wool",
  "magenta_wool",
  "light_blue_wool",
  "yellow_wool",
  "lime_wool",
  "pink_wool",
  "gray_wool",
  "light_gray_wool",
  "cyan_wool",
  "purple_wool",
  "blue_wool",
  "brown_wool",
  "green_wool",
  "red_wool",
  "black_wool",
];
const WEAPON_ITEM_PRIORITY = [
  ...SWORD_ITEM_PRIORITY,
  ...AXE_ITEM_PRIORITY,
];
const SMELT_FUEL_ITEM_PRIORITY = ["coal", "charcoal", "coal_block"];
const TORCH_FUEL_ITEM_NAMES = ["coal", "charcoal"];
const DEFAULT_FOOD_RESERVE_COUNT = 6;
const IRON_ORE_ITEM_NAMES = ["raw_iron", "iron_ore"];
const CROP_HARVEST_CONFIG = {
  wheat: {
    maxAge: 7,
    replantItem: "wheat_seeds",
  },
  carrots: {
    maxAge: 7,
    replantItem: "carrot",
  },
  potatoes: {
    maxAge: 7,
    replantItem: "potato",
  },
  beetroots: {
    maxAge: 3,
    replantItem: "beetroot_seeds",
  },
};
const CROP_ITEM_TO_BLOCK = {
  wheat_seeds: "wheat",
  carrot: "carrots",
  potato: "potatoes",
  beetroot_seeds: "beetroots",
};

module.exports = {
  ANY_PLANKS,
  AXE_ITEM_PRIORITY,
  BED_ITEM_NAMES,
  BUILD_MATERIAL_ALIASES,
  CONTAINER_BLOCK_NAMES,
  CROP_HARVEST_CONFIG,
  CROP_ITEM_TO_BLOCK,
  DEFAULT_FOOD_RESERVE_COUNT,
  END_PORTAL_BLOCK_NAMES,
  END_PORTAL_FRAME_BLOCK_NAMES,
  END_SAFE_SURFACE_BLOCK_NAMES,
  END_VICTORY_BLOCK_NAMES,
  FOOD_ITEM_PRIORITY,
  FURNACE_BLOCK_NAMES,
  HOSTILE_MOB_NAMES,
  HOSTILE_PRIORITY,
  IRON_ORE_ITEM_NAMES,
  LOG_TO_PLANK,
  NETHER_FORTRESS_BLOCK_NAMES,
  NETHER_PORTAL_BLOCK_NAMES,
  PICKAXE_ITEM_NAMES,
  PLANK_TO_LOG,
  REPLACEABLE_BLOCK_KEYWORDS,
  RESOURCE_ALIASES,
  SMELT_FUEL_ITEM_PRIORITY,
  STRONGHOLD_BLOCK_NAMES,
  SWORD_ITEM_PRIORITY,
  TORCH_BLOCK_NAMES,
  TORCH_FUEL_ITEM_NAMES,
  WEAPON_ITEM_PRIORITY,
  WOOL_ITEM_NAMES,
};
