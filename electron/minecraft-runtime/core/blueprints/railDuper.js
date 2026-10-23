'use strict';
// A button-driven rail (and carpet) duplicator on flat ground. Every part sits
// beside the slime it moves with, so each press yields one rail and one carpet
// and nothing is used up. Verified on a vanilla 1.21.8 server before building
// it here. Side view along `facing` (the push direction), g = the ground's top
// layer, front lane on the left, back lane (one block to the `lane` side) on the right:
//
//          front lane         back lane
//   g+4    .  .  R  .         .  .  c  .        R rail on B; c carpet on f
//   g+3    P  A  B  .         .  .  f  .        P sticky piston on two cobblestone, pushing A
//   g+2  b #  .  L  .         .  .  L  .        B slime pushed by A; L slime row under B and f
//   g+1    #  .  .  .         .  .  .  .        f dead coral wall fan hanging on B; b button
//   g      ground                               on the upper cobblestone
//
// A third column (one more block to the `lane` side) holds slime at g+2..g+4:
// the carpet hangs on it, and it ties the carpet into the slime structure.
//
// How it duplicates: A moves into B's cell, so the fan hanging on B loses its
// support and breaks; the carpet on the fan breaks with it, and that block
// update reaches the rail, whose support B is now moving too, so the rail
// drops as an item. Rail, fan and carpet were already on the list of moving
// blocks (each touches a slime block), so they also arrive one block on.
// Nothing touches the slime except the parts: the slime row is two blocks
// above the ground, so the ground never moves with it.
//
// Several parts go on top faces above the bot's eyes, so it first builds a
// cobblestone step and a two-high stand behind the side column (clear of the
// slime) and places those parts from the top of it. A last cobblestone bridges
// that stand to the piston's top, so drops landing on the machine can be fetched.

const { FACINGS, DIRECTION_NAMES } = require('./cobbleGenerator');

function createRailDuper(anchor, facing = 'east') {
  if (!anchor || ![anchor.x, anchor.y, anchor.z].every(Number.isInteger)) {
    throw new TypeError('anchor must have integer x, y, z (the ground block under the piston pillar)');
  }
  const along = FACINGS[facing];
  if (!along) throw new TypeError(`facing must be one of ${Object.keys(FACINGS).join(', ')}`);
  // The back lane is to the left of the push direction.
  const lane = { x: along.z, z: -along.x };
  const at = (a, dy, l = 0) => ({
    x: anchor.x + along.x * a + lane.x * l, y: anchor.y + dy, z: anchor.z + along.z * a + lane.z * l,
  });
  const name = (d) => DIRECTION_NAMES[`${d.x},${d.z}`];
  const cells = {
    pillarLow: at(0, 1), pillarHigh: at(0, 2), piston: at(0, 3), pusher: at(1, 3), base: at(2, 3),
    stepFoot: at(-1, 1, 2), stepLow: at(0, 1, 2), stepHigh: at(0, 2, 2), high: at(0, 3, 2),
    lowFront: at(2, 2), lowBack: at(2, 2, 1), lowSide: at(2, 2, 2), sideMid: at(2, 3, 2), sideTop: at(2, 4, 2),
    fan: at(2, 3, 1), rail: at(2, 4), carpet: at(2, 4, 1), button: at(-1, 2), stand: at(-2, 1),
    bridge: at(0, 3, 1),
  };
  const slime = (key, against) => ({ key, block: 'slime_block', position: cells[key], against });
  const parts = [
    { key: 'pillarLow', block: 'cobblestone', position: cells.pillarLow, against: at(0, 0) },
    { key: 'pillarHigh', block: 'cobblestone', position: cells.pillarHigh, against: cells.pillarLow },
    { key: 'stepFoot', block: 'cobblestone', position: cells.stepFoot, against: at(-1, 0, 2) },
    { key: 'stepLow', block: 'cobblestone', position: cells.stepLow, against: at(0, 0, 2) },
    { key: 'stepHigh', block: 'cobblestone', position: cells.stepHigh, against: cells.stepLow },
    // Head along `facing`: placed looking back at the pillar from in front of it.
    { key: 'piston', block: 'sticky_piston', position: cells.piston, facing, stand: at(3, 1), against: cells.pillarHigh },
    slime('pusher', cells.piston),
    slime('base', cells.pusher),
    // Before the slime row: with slime under its cell, the look could land on
    // the slime's top and stand the fan up there instead of hanging it on B.
    { key: 'fan', block: 'dead_tube_coral_wall_fan', item: 'dead_tube_coral_fan', position: cells.fan, against: cells.base,
      facing: name(lane), stand: at(1, 1, 1) },
    slime('lowFront', cells.base),
    slime('lowBack', cells.lowFront),
    slime('lowSide', cells.lowBack),
    { ...slime('sideMid', cells.lowSide), stand: cells.high },
    { ...slime('sideTop', cells.sideMid), stand: cells.high },
    // Before the rail, which would be in the way of the look from the front.
    { key: 'carpet', block: 'white_carpet', position: cells.carpet, against: cells.sideTop, stand: at(3, 1, 1) },
    { key: 'rail', block: 'rail', position: cells.rail, against: cells.base, stand: cells.high },
    { key: 'button', block: 'stone_button', position: cells.button, against: cells.pillarHigh,
      facing: name({ x: -along.x, z: -along.z }) },
    // Last, so it is never in the way while building: a step from the stand
    // onto the piston, so the bot can walk over the top and pick up the drops
    // that land there. It only touches the piston, never a slime block.
    { key: 'bridge', block: 'cobblestone', position: cells.bridge, against: cells.piston, stand: cells.high },
  ];
  const floor = [];
  const clear = [];
  const machine = new Set(parts.map((p) => `${p.position.x},${p.position.y},${p.position.z}`));
  for (let a = -2; a <= 4; a += 1) {
    for (let l = -1; l <= 3; l += 1) {
      floor.push(at(a, 0, l));
      for (let dy = 1; dy <= 5; dy += 1) {
        const c = at(a, dy, l);
        if (!machine.has(`${c.x},${c.y},${c.z}`)) clear.push(c);
      }
    }
  }
  // Wall button: aim at the middle of its cell, toward the cobblestone.
  const buttonAim = { x: cells.button.x + along.x * 0.3, y: cells.button.y + 0.5, z: cells.button.z + along.z * 0.3 };
  return {
    kind: 'rail_duper', anchor: { ...anchor }, facing, cells: { ...cells, buttonAim, drop: cells.rail },
    parts, floor, clear: [...clear, ...parts.map((p) => p.position)], hollow: [], noStep: [],
  };
}

module.exports = { createRailDuper };
