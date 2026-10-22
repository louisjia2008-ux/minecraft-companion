'use strict';
// The simplest cobblestone generator, dug into flat ground: no redstone, one
// water bucket, one lava bucket. Side view along the device (`facing`):
//
//   y+1   .   .   .   .        . air (the bot works from the surface or S)
//   y     L   C   P   W        L lava source, C cobblestone forms here
//   y-1   #   #   P   #        P two-deep pit, W water source, # sealed
//
// Water from W falls into the pit and never reaches C; lava from L flows into
// C, touches the water in the pit and turns into cobblestone. Every mined
// cobblestone is replaced about 1.5 s later.
//
// The bot mines from S, a one-deep standing cell beside C on the `side`, so the
// drop lands within pickup range instead of burning in the next lava flow.
// Every other neighbour of the open cells must be a solid, non-falling block.
//
// With `collector`, C's floor is a hopper pointing sideways into a chest that
// forms S's floor. The hopper takes the drop the tick it lands, long before it
// can drift into the lava, and the bot empties the chest under its feet.

const FACINGS = {
  east: { x: 1, z: 0 }, south: { x: 0, z: 1 }, west: { x: -1, z: 0 }, north: { x: 0, z: -1 },
};
const DIRECTION_NAMES = { '1,0': 'east', '-1,0': 'west', '0,1': 'south', '0,-1': 'north' };

function createCobbleGenerator(anchor, facing = 'east', { collector = false } = {}) {
  if (!anchor || ![anchor.x, anchor.y, anchor.z].every(Number.isInteger)) {
    throw new TypeError('anchor must have integer x, y, z (the lava cell)');
  }
  const along = FACINGS[facing];
  if (!along) throw new TypeError(`facing must be one of ${Object.keys(FACINGS).join(', ')}`);
  // The standing cell is to the right of the direction of travel.
  const side = { x: -along.z, z: along.x };
  const at = (a, dy, s = 0) => ({
    x: anchor.x + along.x * a + side.x * s,
    y: anchor.y + dy,
    z: anchor.z + along.z * a + side.z * s,
  });

  const cells = {
    lava: at(0, 0),
    cobble: at(1, 0),
    pitTop: at(2, 0),
    pitBottom: at(2, -1),
    water: at(3, 0),
    stand: at(1, 0, 1),
    head: at(1, 1, 1),
  };
  // Dug out in this order: the standing cell first, so the bot can work from it.
  const open = [cells.stand, cells.cobble, cells.lava, cells.pitTop, cells.pitBottom, cells.water];
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const below = (p) => ({ x: p.x, y: p.y - 1, z: p.z });
  // Built after digging, before any liquid: each part's `against` block exists by then.
  const parts = [];
  if (collector) {
    cells.collectorChest = below(cells.stand);
    cells.collectorHopper = below(cells.cobble);
    parts.push(
      { key: 'collectorChest', block: 'chest', position: cells.collectorChest, against: below(cells.collectorChest) },
      { key: 'collectorHopper', block: 'hopper', position: cells.collectorHopper, against: cells.collectorChest,
        sneak: true, facing: DIRECTION_NAMES[`${side.x},${side.z}`] },
    );
  }
  const openKeys = new Set([...open, ...parts.map((part) => part.position)].map(key));
  const sealKeys = new Set();
  const seal = [];
  const addSeal = (p) => {
    const k = key(p);
    if (openKeys.has(k) || sealKeys.has(k)) return;
    sealKeys.add(k);
    seal.push(p);
  };
  // Liquid-holding cells are sealed on every side but the top; the standing
  // cell only needs a floor.
  const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
  for (const p of [cells.lava, cells.cobble, cells.pitTop, cells.pitBottom, cells.water]) {
    for (const [dx, dy, dz] of NEIGHBOURS) addSeal({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
  }
  for (const p of collector ? [below(cells.collectorChest), below(cells.collectorHopper)] : [below(cells.stand)]) addSeal(p);
  // Kept clear so buckets can be poured and the bot can reach the device.
  const clearAbove = [cells.lava, cells.cobble, cells.pitTop, cells.water, cells.head]
    .map((p) => (p === cells.head ? p : { x: p.x, y: p.y + 1, z: p.z }));

  return { kind: 'cobble_generator', anchor: { ...anchor }, facing, collector, cells, open, parts, seal, clearAbove };
}

module.exports = { createCobbleGenerator, FACINGS, DIRECTION_NAMES };
