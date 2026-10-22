'use strict';
// One column of an observer sugar cane farm, sunk one block into flat ground
// so the observer's support face is below eye level. Side view along
// `facing`, g = the ground's top layer:
//
//   g+2   .   3   O   r        O observer, face toward the cane (watches its 3rd block)
//   g+1   .   2   P   B        P piston, head toward the cane (pushes its 2nd block)
//   g     c   1   #   #        r redstone dust on B: the observer's back powers it,
//   g-1   W   D   #   #        B is then powered and fires the piston beside it
//                              W water source (covered by c), D dirt, 1-3 the cane
//
// The bot waits in S, a one-deep cell beside the cane's first block, so the
// dropped cane (it falls to the bottom of the cane's cell) is within pickup range.
//
// Piston and observer facing comes from the direction the bot looks while
// placing: a piston's head points back at the player, an observer's face
// points where the player looks. Each part names the cell to stand in (`stand`,
// three blocks away on the right side) so the look is nearly level.

const { FACINGS, DIRECTION_NAMES } = require('./cobbleGenerator');

function createCaneFarm(anchor, facing = 'east') {
  if (!anchor || ![anchor.x, anchor.y, anchor.z].every(Number.isInteger)) {
    throw new TypeError('anchor must have integer x, y, z (the cane\'s first cell, in the ground\'s top layer)');
  }
  const along = FACINGS[facing];
  if (!along) throw new TypeError(`facing must be one of ${Object.keys(FACINGS).join(', ')}`);
  const side = { x: -along.z, z: along.x };
  const at = (a, dy, s = 0) => ({
    x: anchor.x + along.x * a + side.x * s, y: anchor.y + dy, z: anchor.z + along.z * a + side.z * s,
  });
  const back = DIRECTION_NAMES[`${-along.x},${-along.z}`]; // from the piston toward the cane
  // Dirt turns into grass next to grass: either is a finished filler block.
  const soil = ['dirt', 'grass_block'];

  const cells = {
    cane1: at(0, 0), cane2: at(0, 1), cane3: at(0, 2), dirt: at(0, -1),
    water: at(-1, -1), cover: at(-1, 0), stand: at(0, 0, 1), standHead: at(0, 1, 1),
    piston: at(1, 1), observer: at(1, 2), block: at(2, 1), dust: at(2, 2),
  };
  // Dug out first (the water cell and its cover cell, the cane's first cell, S).
  const dig = [cells.stand, cells.cane1, cells.cover, cells.water];
  const parts = [
    { key: 'cover', block: 'dirt', accept: soil, position: cells.cover },
    { key: 'cane', block: 'sugar_cane', position: cells.cane1 },
    // Head toward the cane: placed from the cane's side, looking along `facing`.
    { key: 'piston', block: 'piston', position: cells.piston, facing: back, stand: at(-2, 1) },
    // Face toward the cane: placed from beyond the dust, looking back at the cane.
    { key: 'observer', block: 'observer', position: cells.observer, facing: back, stand: at(4, 1) },
    { key: 'block', block: 'dirt', accept: soil, position: cells.block },
    { key: 'dust', block: 'redstone_wire', item: 'redstone', position: cells.dust },
  ];
  // Must stay solid: the dirt the cane grows on, the water's floor and sides,
  // the piston's and B's supports, S's floor.
  const solid = [cells.dirt, at(-1, -2), at(-2, -1), at(-1, -1, 1), at(-1, -1, -1), at(1, 0), at(2, 0), at(0, -1, 1)];
  // Air: the cane's column, the device's upper cells, the two places to stand and their heads.
  const clear = [cells.cane2, cells.cane3, at(0, 3), cells.piston, cells.observer, cells.block, cells.dust, at(1, 3),
    cells.standHead, at(-2, 1), at(-2, 2), at(4, 1), at(4, 2), at(-1, 1)];
  const standFloors = [at(-2, 0), at(4, 0)];

  return { kind: 'cane_farm', anchor: { ...anchor }, facing, cells, dig, parts, solid, clear, standFloors };
}

module.exports = { createCaneFarm };
