'use strict';
// Exactly the harmless aquatic plant types in the installed native Physics
// waterLike set. Bubble columns remain hazardous. This grants body clearance
// only: never AIR, dry support, water-source/bucket evidence or route geometry.
const AQUATIC_BODY_PLANTS = Object.freeze(['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant']);
const plants = new Set(AQUATIC_BODY_PLANTS);
function isAquaticBodyBlock(block) {
  return Boolean(block && plants.has(block.name) && Number.isSafeInteger(block.stateId) && block.stateId >= 0
    && block.boundingBox === 'empty' && Array.isArray(block.shapes) && block.shapes.length === 0
    && ![true, 'true'].includes(block.getProperties?.().waterlogged));
}
module.exports = { AQUATIC_BODY_PLANTS, isAquaticBodyBlock };
