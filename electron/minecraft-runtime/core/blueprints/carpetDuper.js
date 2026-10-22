'use strict';
// A button-driven carpet duplicator on flat ground. Side view across `facing`
// (the piston pushes along `facing`), g = the ground's top layer:
//
//   g+2   .   S   c        S slime blocks, moved one block along `facing` and back
//   g+1   b P S   f        P sticky piston pushing along `facing`, b stone button on
//   g     # # _   #          the ground behind it; f a dead coral wall fan on the
//                            bottom slime's side, c the carpet standing on it;
//                            _ dug out: slime would drag the ground with it, and a
//                            flat ground row is far too long for the piston to push
//
// Each press, the slime drags the carpet along while its support (the fan,
// which slime cannot move) stays: the carpet pops off as an item and is also
// put back, so every press yields about one carpet. Verified on a vanilla
// 1.21.8 server before building it here.
//
// The bot presses the button from B, beside the fan on the carpet's side,
// close enough to pick the carpets up.

const { FACINGS, DIRECTION_NAMES } = require('./cobbleGenerator');

function createCarpetDuper(anchor, facing = 'east') {
  if (!anchor || ![anchor.x, anchor.y, anchor.z].every(Number.isInteger)) {
    throw new TypeError('anchor must have integer x, y, z (the ground block under the piston)');
  }
  const along = FACINGS[facing];
  if (!along) throw new TypeError(`facing must be one of ${Object.keys(FACINGS).join(', ')}`);
  const side = { x: -along.z, z: along.x };
  const at = (a, dy, s = 0) => ({
    x: anchor.x + along.x * a + side.x * s, y: anchor.y + dy, z: anchor.z + along.z * a + side.z * s,
  });
  const sideName = DIRECTION_NAMES[`${side.x},${side.z}`];
  const cells = {
    piston: at(0, 1), slimeLow: at(1, 1), slimeHigh: at(1, 2), fan: at(1, 1, 1), carpet: at(1, 2, 1),
    button: at(-1, 1), stand: at(0, 1, 1),
  };
  const parts = [
    // Head toward the slime: placed looking back along -facing from beyond the slime.
    { key: 'piston', block: 'sticky_piston', position: cells.piston, facing, stand: at(3, 1), against: at(0, 0) },
    { key: 'slimeLow', block: 'slime_block', position: cells.slimeLow, against: cells.piston },
    { key: 'slimeHigh', block: 'slime_block', position: cells.slimeHigh, against: cells.slimeLow },
    // Before the fan and carpet: the way round to the back is still open.
    { key: 'button', block: 'stone_button', position: cells.button, against: at(-1, 0) },
    // Hangs on the slime's side, so it never moves with it.
    { key: 'fan', block: 'dead_tube_coral_wall_fan', item: 'dead_tube_coral_fan', position: cells.fan,
      against: cells.slimeLow, facing: sideName },
    { key: 'carpet', block: 'white_carpet', position: cells.carpet, against: cells.slimeHigh },
  ];
  // Ground under every part and the standing cell; air where things move or stand.
  const floor = [at(0, 0), at(-1, 0), at(0, 0, 1), at(1, 0, 1), at(2, 0), at(3, 0), at(2, 0, 1)];
  // Nothing may touch the slime blocks except the piston, the fan and the carpet.
  const hollow = [at(1, 0)];
  const clear = [cells.piston, cells.slimeLow, cells.slimeHigh, cells.fan, cells.carpet, cells.button, cells.stand,
    at(0, 2, 1), at(2, 1), at(2, 2), at(2, 1, 1), at(2, 2, 1), at(3, 1), at(3, 2), at(1, 3), at(1, 3, 1),
    at(1, 1, -1), at(1, 2, -1), at(0, 2)];
  return { kind: 'carpet_duper', anchor: { ...anchor }, facing, cells, parts, floor, hollow, clear };
}

module.exports = { createCarpetDuper };
