'use strict';
// Walking/body clearance only. This never grants clearing or placement rights.
const AIR = new Set(['air', 'cave_air', 'void_air']);
// Biome-independent body clearance. These names grant neither climb routes nor
// floor support, clearing or placement. Even vines require the caller's fresh
// grounded support / bounded native jump checks, and native physics is unchanged.
const NATURAL_BODY_PLANTS = Object.freeze(['short_grass', 'fern', 'tall_grass', 'large_fern',
  'dandelion', 'poppy', 'dead_bush', 'leaf_litter', 'sugar_cane', 'vine',
  'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'torchflower',
  'sunflower', 'lilac', 'rose_bush', 'peony', 'pitcher_plant', 'pink_petals', 'wildflowers',
  'brown_mushroom', 'red_mushroom', 'short_dry_grass', 'tall_dry_grass', 'bush', 'firefly_bush',
  'mangrove_propagule', 'cave_vines', 'cave_vines_plant', 'hanging_roots', 'pale_hanging_moss', 'cactus_flower', 'glow_lichen']);
const PLANTS = new Set(NATURAL_BODY_PLANTS);
// Lighting is passable body clearance, never support or placement authority.
// In particular a mined camp entrance may contain the bot's own floor torch.
const LIGHTS = new Set(['torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'redstone_torch', 'redstone_wall_torch']);
// Category only; a name never substitutes for the fresh evidence below.
const isNaturalWalkingBodyName = name => AIR.has(name) || PLANTS.has(name) || LIGHTS.has(name) || name === 'snow';
function isNaturalWalkingBodyFact(fact) {
  return Boolean(fact?.loaded === true && typeof fact.name === 'string' && isNaturalWalkingBodyName(fact.name)
    // Only the native non-colliding one-layer state. Higher layers need a
    // separate fractional-height stance contract, not a wider y tolerance.
    && (fact.name !== 'snow' || Number(fact.layers) === 1)
    && Number.isSafeInteger(fact.stateId) && fact.stateId >= 0 && fact.boundingBox === 'empty'
    && Array.isArray(fact.shapes) && fact.shapes.length === 0 && ![true, 'true'].includes(fact.waterlogged));
}
function isNaturalWalkingBodyBlock(block) {
  return isNaturalWalkingBodyFact({ loaded: Boolean(block), name: block?.name, stateId: block?.stateId,
    boundingBox: block?.boundingBox, shapes: block?.shapes, waterlogged: block?.getProperties?.().waterlogged,
    layers: block?.getProperties?.().layers });
}
module.exports = { isNaturalWalkingBodyBlock, isNaturalWalkingBodyFact, isNaturalWalkingBodyName, NATURAL_BODY_PLANTS };
