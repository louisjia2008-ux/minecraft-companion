'use strict';
// A hopper-fed furnace, sunk two blocks into flat ground so every part can be
// placed while standing on the surface (a top face is only clickable from
// above it). Side view along `facing`, g = the ground's top layer:
//
//   g+2   .   I   .        I input chest
//   g+1   F   H   .        H hopper facing down into the furnace (input slot)
//   g     h   U   .        F fuel chest, h hopper facing along into U's side (fuel slot)
//   g-1   #   O   C        U furnace, O hopper under it facing along into C
//                          C output chest; the cell above C stays open so it opens
//
// Parts are listed in build order: every part's `against` cell already holds
// a block when the part is placed. A hopper points at the block it was placed
// against, so its facing comes from that click. Chests, hoppers and furnaces
// open when clicked, so parts placed against them are placed sneaking.

const { FACINGS, DIRECTION_NAMES } = require('./cobbleGenerator');

function createAutoSmelter(anchor, facing = 'east') {
  if (!anchor || ![anchor.x, anchor.y, anchor.z].every(Number.isInteger)) {
    throw new TypeError('anchor must have integer x, y, z (the furnace cell, in the ground\'s top layer)');
  }
  const along = FACINGS[facing];
  if (!along) throw new TypeError(`facing must be one of ${Object.keys(FACINGS).join(', ')}`);
  const at = (a, dy) => ({ x: anchor.x + along.x * a, y: anchor.y + dy, z: anchor.z + along.z * a });
  const forward = DIRECTION_NAMES[`${along.x},${along.z}`];

  const cells = {
    outHopper: at(0, -1), outChest: at(1, -1), furnace: at(0, 0), fuelHopper: at(-1, 0),
    inHopper: at(0, 1), fuelChest: at(-1, 1), inChest: at(0, 2), chestAir: at(1, 0),
  };
  const below = (p) => ({ x: p.x, y: p.y - 1, z: p.z });
  const parts = [
    { key: 'outChest', block: 'chest', position: cells.outChest, against: below(cells.outChest) },
    { key: 'outHopper', block: 'hopper', position: cells.outHopper, against: cells.outChest, sneak: true, facing: forward },
    { key: 'furnace', block: 'furnace', position: cells.furnace, against: cells.outHopper, sneak: true },
    { key: 'fuelHopper', block: 'hopper', position: cells.fuelHopper, against: cells.furnace, sneak: true, facing: forward },
    { key: 'inHopper', block: 'hopper', position: cells.inHopper, against: cells.furnace, sneak: true, facing: 'down' },
    { key: 'fuelChest', block: 'chest', position: cells.fuelChest, against: cells.fuelHopper, sneak: true },
    { key: 'inChest', block: 'chest', position: cells.inChest, against: cells.inHopper, sneak: true },
  ];
  // Ground dug out before building: the sunk parts and the opening above C.
  const dig = [cells.outChest, cells.outHopper, cells.furnace, cells.fuelHopper, cells.chestAir];
  // Must stay solid: the floors the sunk parts rest on.
  const floor = [below(cells.outChest), below(cells.outHopper), below(cells.fuelHopper)];
  // Air above ground for the upper parts and for opening the chests.
  const clearAbove = [cells.inHopper, cells.fuelChest, cells.inChest, at(0, 3), at(-1, 2), at(1, 1)];

  return { kind: 'auto_smelter', anchor: { ...anchor }, facing, cells, parts, dig, floor, clearAbove };
}

module.exports = { createAutoSmelter };
