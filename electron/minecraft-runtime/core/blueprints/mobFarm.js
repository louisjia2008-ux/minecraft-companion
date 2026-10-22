'use strict';
// An underground dark-room mob farm, dug into solid stone: nothing to build
// but four water sources, a hopper and a chest. Top view of the spawning
// floor (L = the mobs' feet level, nine blocks under the ground's top layer g):
//
//               . ~ .                 ~ water channel, one block lower (L-1);
//               . ~ .                   the source W at its outer end flows
//                ...                    exactly seven blocks and stops at the hole
//        . . . . . ~ . . . . .        . ledge, 2 high: mobs spawn here in the dark,
//        ~ ~ ~ ~ ~ O ~ ~ ~ ~ W          wander off into a channel and are washed
//        . . . . . ~ . . . . . s s s    into O
//                ...                  O the drop hole: a 1x1 shaft 30 blocks deep,
//               . ~ .                   enough for the fall to kill zombies,
//               . ~ .                   skeletons and creepers (20 hp)
//                                     s the stairs down from the surface (along `facing`)
//
// Side view at the shaft's bottom B, along `facing` (d):
//
//   B+2   #   |   a        | shaft, a the bot's alcove (it waits in A)
//   B+1   p   |   A        p air above the chest so it opens
//   B     C   H   #        H hopper (drops land on it), pointing into the chest C
//
// The 1-wide channels and the 2-high ceiling keep spiders and endermen out.
// Mobs never spawn within 24 blocks of a player, so the bot is ~29 blocks below.

const { FACINGS, DIRECTION_NAMES } = require('./cobbleGenerator');

const ARM = 8; // channel cells from the hole to the water source
const ROOM_DEPTH = 9; // the ground's top layer to the mobs' feet
const SHAFT = 30; // the mobs' feet to the hopper

function createMobFarm(anchor, facing = 'east') {
  if (!anchor || ![anchor.x, anchor.y, anchor.z].every(Number.isInteger)) {
    throw new TypeError('anchor must have integer x, y, z (the ground\'s top block above the drop hole)');
  }
  const d = FACINGS[facing];
  if (!d) throw new TypeError(`facing must be one of ${Object.keys(FACINGS).join(', ')}`);
  const g = anchor.y;
  const L = g - ROOM_DEPTH;
  const B = L - SHAFT;
  const p = { x: -d.z, z: d.x };
  const cell = (x, y, z) => ({ x: anchor.x + x, y, z: anchor.z + z });
  const key = (c) => `${c.x},${c.y},${c.z}`;

  // Stairs from the surface down to the ledge beside the `facing` arm's water
  // source; each step is three high so the bot can walk up and down them.
  const stairs = [];
  for (let i = ROOM_DEPTH + 1; i >= 0; i -= 1) {
    const at = (y) => cell(d.x * (ARM + 1 + i) + p.x, y, d.z * (ARM + 1 + i) + p.z);
    const feet = L + i;
    for (const y of [feet + 2, feet + 1, feet]) if (y <= g) stairs.push(at(y));
  }
  const stairsTop = cell(d.x * (ARM + 1 + ROOM_DEPTH + 1) + p.x, g + 1, d.z * (ARM + 1 + ROOM_DEPTH + 1) + p.z);

  const room = new Map();
  const add = (c) => room.set(key(c), c);
  const water = [];
  const channels = [];
  const ledgeFloors = new Map();
  for (const u of Object.values(FACINGS)) {
    const q = { x: -u.z, z: u.x };
    for (let k = 1; k <= ARM; k += 1) {
      const c = (s, y) => cell(u.x * k + q.x * s, y, u.z * k + q.z * s);
      for (const y of [L + 1, L]) add(c(0, y));
      channels.push(c(0, L - 1));
      for (const s of [1, -1]) {
        for (const y of [L + 1, L]) add(c(s, y));
        ledgeFloors.set(key(c(s, L - 1)), c(s, L - 1));
      }
    }
    water.push(cell(u.x * ARM, L - 1, u.z * ARM));
  }
  add(cell(0, L + 1, 0));
  add(cell(0, L, 0));
  // Ledges and the air above the channels first, nearest the stairs first;
  // the channels last, from the ledges beside them.
  const stairsFoot = cell(d.x * ARM + p.x, L, d.z * ARM + p.z);
  const dist = (c) => Math.abs(c.x - stairsFoot.x) + Math.abs(c.z - stairsFoot.z);
  const roomCells = [...room.values()].sort((a, b) => dist(a) - dist(b) || b.y - a.y);
  channels.sort((a, b) => dist(a) - dist(b));

  const hole = cell(0, L - 1, 0);
  const shaft = [];
  for (let y = L - 1; y > B; y -= 1) shaft.push(cell(0, y, 0));
  const cells = {
    hole, stairsFoot, stairsTop,
    hopper: cell(0, B, 0),
    chest: cell(-d.x, B, -d.z),
    pocket: cell(-d.x, B + 1, -d.z),
    stand: cell(d.x, B + 1, d.z),
    alcoveHead: cell(d.x, B + 2, d.z),
  };
  const parts = [
    { key: 'chest', block: 'chest', position: cells.chest, against: cell(-d.x, B - 1, -d.z) },
    // Points at the chest it is placed against.
    { key: 'hopper', block: 'hopper', position: cells.hopper, against: cells.chest, sneak: true,
      facing: DIRECTION_NAMES[`${-d.x},${-d.z}`] },
  ];
  // Must stay solid so the water and the mobs stay where they belong.
  const solid = [...ledgeFloors.values(), ...channels.map((c) => ({ ...c, y: c.y - 1 })),
    ...shaft.filter((c) => c.y < L - 1) // at L-1 the hole's sides are the channels
      .flatMap((c) => Object.values(FACINGS).map((u) => ({ x: c.x + u.x, y: c.y, z: c.z + u.z })))
      .filter((c) => ![cells.stand, cells.alcoveHead, cells.pocket].some((b) => key(b) === key(c)))];

  // Sealed all round the bottom, so nothing but the drop reaches the bot.
  const open = new Set([...shaft, cells.alcoveHead, cells.stand, cells.pocket].map(key));
  const taken = new Set(solid.map(key));
  for (const c of [cells.alcoveHead, cells.stand, cells.pocket, cells.chest, cells.hopper]) {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
      if (open.has(key(n)) || taken.has(key(n)) || key(n) === key(cells.chest) || key(n) === key(cells.hopper)) continue;
      taken.add(key(n));
      solid.push(n);
    }
  }
  // The roof over the spawning floor: two blocks of headroom keep endermen out.
  const ceiling = roomCells.filter((c) => c.y === L + 1).map((c) => ({ ...c, y: L + 2 }));
  // ...and the rock beyond each water source, so the water flows only inward.
  const beyond = Object.values(FACINGS).map((u) => cell(u.x * (ARM + 1), L - 1, u.z * (ARM + 1)));
  solid.push(...ceiling, ...beyond);

  return {
    kind: 'mob_farm', anchor: { ...anchor }, facing, levels: { ground: g, feet: L, bottom: B },
    cells, stairs, room: roomCells, channels, water, shaft,
    bottom: [cells.alcoveHead, cells.stand, cells.pocket, cells.chest, cells.hopper],
    parts, solid,
  };
}

module.exports = { createMobFarm, ARM, ROOM_DEPTH, SHAFT };
