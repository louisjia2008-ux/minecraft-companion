'use strict';
// A 2×2 fishing pond dug one block into flat ground, with the bot's standing
// cell on its edge. Top view (`facing` points right, g = the ground's top layer):
//
//        .  r  r  .          W/w the pond at layer g: water is poured into the two W
//        r  W  w  r          cells and the two w cells become sources between them
//     B  r  w  W  r          B where the bot stands (on the ground at g, facing the pond)
//        .  r  r  .          r rim at layer g that must stay solid so the water stays in
//
// The bot casts over the pond; the open sky above it keeps the catch rate up.

const { FACINGS } = require('./cobbleGenerator');

function createFishPond(anchor, facing = 'east') {
  if (!anchor || ![anchor.x, anchor.y, anchor.z].every(Number.isInteger)) {
    throw new TypeError('anchor must have integer x, y, z (the ground block under the standing cell)');
  }
  const along = FACINGS[facing];
  if (!along) throw new TypeError(`facing must be one of ${Object.keys(FACINGS).join(', ')}`);
  const side = { x: -along.z, z: along.x };
  const at = (a, dy, s = 0) => ({
    x: anchor.x + along.x * a + side.x * s, y: anchor.y + dy, z: anchor.z + along.z * a + side.z * s,
  });
  const pond = [at(1, 0), at(2, 0), at(1, 0, 1), at(2, 0, 1)];
  const water = [at(1, 0), at(2, 0, 1)];
  const rim = [at(0, 0), at(0, 0, 1), at(3, 0), at(3, 0, 1), at(1, 0, -1), at(2, 0, -1), at(1, 0, 2), at(2, 0, 2)];
  const floor = pond.map((p) => ({ ...p, y: p.y - 1 }));
  const stand = at(0, 1);
  const clear = [stand, at(0, 2), ...pond.flatMap((p) => [1, 2, 3].map((dy) => ({ ...p, y: p.y + dy })))];
  // The bobber aims at the middle of the pond's far half.
  const target = { x: anchor.x + 0.5 + along.x * 2 + side.x * 0.5, y: anchor.y + 0.9, z: anchor.z + 0.5 + along.z * 2 + side.z * 0.5 };
  return { kind: 'fish_pond', anchor: { ...anchor }, facing, cells: { stand }, pond, water, rim, floor, clear, target };
}

module.exports = { createFishPond };
