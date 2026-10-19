'use strict';
// A small, fully self-gatherable starter house: 7x7 outside, 5x5 inside,
// cobblestone walls three high, a flat plank roof, a door, two torches, and a
// bed, chest, crafting table and furnace inside. No glass or stairs, so no
// smelting of sand and no orientation-sensitive blocks besides bed and door.
//
// Layout (looking down, z grows south, door on the north wall at x=3):
//
//   z=0  W W W D W W W
//   z=1  W t . . . B W      t torch, B bed (head z=1, foot z=2)
//   z=2  W . . . . B W
//   z=3  W . . . . . W
//   z=4  W . . . . . W
//   z=5  W C F . H t W      C crafting table, F furnace, H chest
//   z=6  W W W W W W W

const SIZE = 7;
const WALL_HEIGHT = 3;

function createStarterHouse(anchor) {
  if (!anchor || ![anchor.x, anchor.y, anchor.z].every(Number.isInteger)) {
    throw new TypeError('anchor must have integer x, y, z (floor level, north-west corner)');
  }
  const at = (dx, dy, dz) => ({ x: anchor.x + dx, y: anchor.y + dy, z: anchor.z + dz });
  const blocks = [];
  const add = (dx, dy, dz, family, phase, extra = {}) => blocks.push({ position: at(dx, dy, dz), family, phase, ...extra });

  const door = { dx: 3, dz: 0 };
  for (let dy = 0; dy < WALL_HEIGHT; dy += 1) {
    for (let dx = 0; dx < SIZE; dx += 1) {
      for (let dz = 0; dz < SIZE; dz += 1) {
        const edge = dx === 0 || dz === 0 || dx === SIZE - 1 || dz === SIZE - 1;
        if (!edge) continue;
        if (dx === door.dx && dz === door.dz && dy < 2) continue;
        add(dx, dy, dz, 'cobblestone', 'walls');
      }
    }
  }
  // Roof: the ring over the walls first (supported from below), then inwards.
  const ring = (dx, dz) => Math.min(dx, dz, SIZE - 1 - dx, SIZE - 1 - dz);
  const roof = [];
  for (let dx = 0; dx < SIZE; dx += 1) for (let dz = 0; dz < SIZE; dz += 1) roof.push({ dx, dz, ring: ring(dx, dz) });
  roof.sort((a, b) => a.ring - b.ring);
  for (const cell of roof) add(cell.dx, WALL_HEIGHT, cell.dz, 'planks', 'roof');

  const furniture = {
    crafting_table: { position: at(1, 0, 5), family: 'crafting_table' },
    furnace: { position: at(2, 0, 5), family: 'furnace' },
    chest: { position: at(4, 0, 5), family: 'chest' },
    // The bed is placed by standing south of the foot and facing north.
    bed: { position: at(5, 0, 2), head: at(5, 0, 1), stand: at(5, 0, 4), family: 'bed' },
    torches: [at(1, 0, 1), at(5, 0, 5)],
    door: { position: at(door.dx, 0, door.dz), upper: at(door.dx, 1, door.dz), family: 'door' },
  };

  // Everything inside the shell and one block of headroom above the roof must be clear.
  const clearance = [];
  for (let dx = 0; dx < SIZE; dx += 1) {
    for (let dz = 0; dz < SIZE; dz += 1) {
      for (let dy = 0; dy <= WALL_HEIGHT + 1; dy += 1) clearance.push(at(dx, dy, dz));
    }
  }
  const foundation = [];
  for (let dx = 0; dx < SIZE; dx += 1) for (let dz = 0; dz < SIZE; dz += 1) foundation.push(at(dx, -1, dz));

  return {
    anchor: { ...anchor },
    size: SIZE,
    blocks,
    furniture,
    clearance,
    foundation,
    // Doorstep outside the door; the bot must be able to reach it.
    entrance: at(door.dx, 0, -1),
    interiorCenter: at(3, 0, 3),
    materials() {
      const totals = {};
      for (const block of blocks) totals[block.family] = (totals[block.family] || 0) + 1;
      totals.torch = furniture.torches.length;
      return totals;
    },
  };
}

module.exports = { createStarterHouse, SIZE, WALL_HEIGHT };
