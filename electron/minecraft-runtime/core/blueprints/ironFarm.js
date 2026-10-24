'use strict';
// An underground iron farm, dug into solid stone. Three villagers live in a
// sealed room with three beds, watch a zombie through a slit, panic, and call
// iron golems; the only cells around them where a golem fits (three high, on
// a full block) are two shafts beside the bot's tunnel, where lava kills the
// golem as soon as it appears. Top view at the villagers' feet level Y (eight
// blocks under the ground's top layer g), `facing` pointing right, the `lane`
// direction pointing up:
//
//        Z w C B B                C corridor (villagers), B beds, sunk one block
//            C B B                  so a villager can stand on one under the ceiling
//            C B B                w the slit: a bottom slab at Y+1 (0.5 high gap);
//            s                      Z the zombie's cell behind it
//            T                    s sealed with a block once the villagers are in
//            T J                  T the bot's tunnel; J a golem shaft, three high,
//            T                      open to the tunnel; at Y+2 a ladder holds back
//            T J                    the lava beside it (L, one block on along
//            T                      `facing`), which the golem's head touches
//            T
//            T
//            T                    the tunnel's far end turns into stairs going up
//      S S S T                      against `facing`, eleven blocks from the
//                                   villagers: no stair cell is within their reach
//
// A golem spawns where a villager's search (±8 across, ±6 up and down) finds
// a full block with three cells of room above it. Every other dug cell is at
// most two high, so only the shafts qualify. Hoppers and slabs are not full
// blocks (golems never spawn on them), so the drops stay on the shaft's stone
// floor and the bot picks them up from the tunnel.
//
// Verified with commands on a vanilla 1.21.8 server first: glass or iron bars
// in the slit block the villagers' view of the zombie; a bottom slab does not,
// and keeps even a baby zombie out.

const { FACINGS, DIRECTION_NAMES } = require('./cobbleGenerator');

const DEPTH = 8; // the ground's top layer to the villagers' feet
const TUNNEL = 10; // tunnel cells from the corridor; the stairs start beyond
const SHAFTS = [-3, -5]; // lane offsets of the golem shafts beside the tunnel

function createIronFarm(anchor, facing = 'east') {
  if (!anchor || ![anchor.x, anchor.y, anchor.z].every(Number.isInteger)) {
    throw new TypeError('anchor must have integer x, y, z (the ground\'s top block above the corridor\'s first cell)');
  }
  const along = FACINGS[facing];
  if (!along) throw new TypeError(`facing must be one of ${Object.keys(FACINGS).join(', ')}`);
  const lane = { x: -along.z, z: along.x };
  const g = anchor.y;
  const Y = g - DEPTH;
  const at = (a, y, l) => ({ x: anchor.x + along.x * a + lane.x * l, y, z: anchor.z + along.z * a + lane.z * l });
  const name = (d) => DIRECTION_NAMES[`${d.x},${d.z}`];

  // Stairs: from the surface down to the tunnel's far end, each step three high.
  const stairs = [];
  const treads = [];
  const far = -(TUNNEL + 1);
  for (let i = DEPTH; i >= 1; i -= 1) {
    for (const y of [Y + i + 2, Y + i + 1, Y + i]) if (y <= g) stairs.push(at(-i, y, far));
    treads.push(at(-i, Y + i - 1, far));
  }
  const tunnel = [];
  // The far end is three high too: the first step up starts from it.
  tunnel.push(at(0, Y + 2, far), at(0, Y + 1, far), at(0, Y, far));
  for (let l = far + 1; l <= -1; l += 1) tunnel.push(at(0, Y + 1, l), at(0, Y, l));

  const room = [];
  for (let l = 0; l <= 2; l += 1) for (let a = 0; a <= 2; a += 1) room.push(at(a, Y + 1, l), at(a, Y, l));
  const pits = [];
  for (let l = 0; l <= 2; l += 1) pits.push(at(1, Y - 1, l), at(2, Y - 1, l));
  // From the corridor through the slit: the slit, then the zombie's cell top down.
  const zombie = [at(-1, Y + 1, 1), at(-2, Y + 1, 1), at(-2, Y, 1)];
  const shafts = [];
  const lava = [];
  for (const l of SHAFTS) {
    shafts.push(at(1, Y, l), at(1, Y + 1, l), at(1, Y + 2, l));
    lava.push(at(2, Y + 2, l));
  }

  const cells = {
    corridor: [at(0, Y, 0), at(0, Y, 1), at(0, Y, 2)],
    seal: at(0, Y, -1),
    slit: at(-1, Y + 1, 1),
    zombie: at(-2, Y, 1),
    zombieWall: at(-3, Y + 1, 1), // clicked with the spawn egg, through the slit
    eggStand: at(0, Y, 1),
    villagerStand: at(0, Y, -2), // over the seal, looking down the corridor
    wait: at(0, Y, -8),
    stairsTop: at(-(DEPTH + 1), g + 1, far),
    shafts: SHAFTS.map((l) => at(1, Y, l)),
  };
  const facingName = name(along);
  const parts = [];
  for (let l = 0; l <= 2; l += 1) {
    parts.push({ key: `bed${l}`, block: 'white_bed', position: at(1, Y - 1, l), against: at(1, Y - 2, l),
      facing: facingName, head: at(2, Y - 1, l), stand: at(0, Y, l) });
  }
  parts.push(
    { key: 'torch', block: 'wall_torch', item: 'torch', position: at(2, Y + 1, 1), against: at(3, Y + 1, 1), facing: name({ x: -along.x, z: -along.z }) },
    { key: 'slit', block: 'stone_slab', position: cells.slit, against: at(-1, Y, 1) },
  );
  SHAFTS.forEach((l, i) => {
    // On the shaft's wall away from the corridor; facing away from that wall.
    parts.push({ key: `ladder${i}`, block: 'ladder', position: at(1, Y + 2, l), against: at(1, Y + 2, l - 1), facing: name(lane) });
  });

  // Must stay solid: what holds the lava, what keeps every other dug cell two
  // high, and the treads.
  const key = (c) => `${c.x},${c.y},${c.z}`;
  const dug = new Set([...stairs, ...tunnel, ...room, ...pits, ...zombie, ...shafts, ...lava].map(key));
  const solid = [...treads];
  const around = (c) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    .map(([dx, dy, dz]) => ({ x: c.x + dx, y: c.y + dy, z: c.z + dz }));
  const taken = new Set(solid.map(key));
  const parted = new Set(parts.map((p) => key(p.position)));
  for (const c of [...lava, ...room, ...pits, ...zombie, ...shafts, ...tunnel]) {
    for (const n of around(c)) {
      if (dug.has(key(n)) || taken.has(key(n)) || parted.has(key(n)) || key(n) === key(cells.seal)) continue;
      // The ground above the stairs' top is open sky.
      if (n.y > g) continue;
      taken.add(key(n));
      solid.push(n);
    }
  }

  return {
    kind: 'iron_farm', anchor: { ...anchor }, facing, levels: { ground: g, feet: Y },
    cells, stairs, tunnel, room, pits, zombie, shafts, lava, parts, solid,
    // Dug in this order: down the stairs, along the tunnel, into the room.
    digOrder: [...stairs, ...tunnel, ...room, ...pits, ...zombie, ...shafts, ...lava],
  };
}

module.exports = { createIronFarm, DEPTH, TUNNEL, SHAFTS };
