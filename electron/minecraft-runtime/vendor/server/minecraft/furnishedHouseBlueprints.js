const FURNISHED_HOUSE_PHASES = Object.freeze([
  'inspect_inventory', 'select_site', 'prepare_materials', 'clear_site',
  'floor', 'frame', 'walls', 'windows', 'roof', 'furniture', 'finish', 'verify',
]);

function normalizeFurnishedHouseProfile(profile = 'cottage') {
  if (profile === 'cottage' || profile === 'enchanting_library') return profile;
  throw new Error(`不支持的房屋款式：${profile}`);
}

function createFurnishedHouseBlueprint(anchor, options = {}) {
  const profile = normalizeFurnishedHouseProfile(options.profile || 'cottage');
  if (!anchor || !['x', 'y', 'z'].every((key) => Number.isInteger(anchor[key]))) {
    throw new Error('房屋地板锚点必须包含整数 x/y/z');
  }
  const width = profile === 'cottage' ? 7 : 9;
  const depth = profile === 'cottage' ? 9 : 11;
  const middle = Math.floor(width / 2);
  const roofTop = 3 + (width + 1) / 2;
  const position = (x, y, z) => ({ x: anchor.x + x, y: anchor.y + y, z: anchor.z + z });
  const keyed = new Map();
  const clearanceMap = new Map();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  function add(x, y, z, item, phase, properties = {}, derived = false) {
    const p = position(x, y, z);
    if (keyed.has(key(p))) throw new Error(`重复房屋方块 ${key(p)}`);
    keyed.set(key(p), { id: `${phase}:${x},${y},${z}`, position: p, item, phase,
      ...(Object.keys(properties).length ? { properties } : {}), ...(derived ? { derived: true } : {}) });
  }
  function air(x, y, z, purpose) {
    const p = position(x, y, z);
    clearanceMap.set(key(p), { position: p, purpose });
  }
  const corner = (x, z) => (x === 0 || x === width - 1) && (z === 0 || z === depth - 1);
  const perimeter = (x, z) => x === 0 || x === width - 1 || z === 0 || z === depth - 1;
  const window = (x, y, z) => y === 2 && (
    (z === 0 && [1, 2, width - 3, width - 2].includes(x)) ||
    (z === depth - 1 && [middle - 1, middle, middle + 1].includes(x)) ||
    ((x === 0 || x === width - 1) && [2, 3, depth - 4, depth - 3].includes(z))
  );

  for (let x = 0; x < width; x += 1) {
    for (let z = 0; z < depth; z += 1) {
      add(x, 0, z, perimeter(x, z) ? 'cobblestone' : 'oak_planks', 'floor');
      for (let y = 1; y <= 3; y += 1) {
        if (!perimeter(x, z) || (z === 0 && x === middle && y <= 2)) continue;
        if (corner(x, z)) add(x, y, z, 'oak_log', 'frame', { axis: 'y' });
        else if (window(x, y, z)) add(x, y, z, 'glass', 'windows');
        else add(x, y, z, y === 1 ? 'cobblestone' : 'oak_planks', 'walls');
      }
    }
  }
  for (const x of [middle - 1, middle, middle + 1]) {
    add(x, 0, -1, 'oak_stairs', 'floor', { facing: 'south', half: 'bottom', shape: 'straight', waterlogged: false });
  }

  // The front and back gables close every cell below the pitched roof.
  for (let x = 0; x < width; x += 1) {
    const top = 3 + Math.min(x + 1, width - x);
    for (let y = 4; y < top; y += 1) {
      for (const z of [0, depth - 1]) add(x, y, z, 'oak_planks', 'roof');
    }
  }
  for (let x = -1; x <= width; x += 1) {
    const y = 3 + Math.min(x + 1, width - x);
    for (let z = -1; z <= depth; z += 1) {
      if (x === middle) add(x, y, z, 'oak_slab', 'roof', { type: 'bottom', waterlogged: false });
      else add(x, y, z, 'oak_stairs', 'roof', {
        facing: x < middle ? 'east' : 'west', half: 'bottom', shape: 'straight', waterlogged: false,
      });
    }
  }

  const furniture = {
    bed: { foot: position(1, 1, 3), head: position(1, 1, 2), facing: 'north' },
    door: { lower: position(middle, 1, 0), upper: position(middle, 2, 0), facing: 'north' },
    craftingTable: position(width - 2, 1, 2), chest: position(width - 2, 1, 3),
    furnace: position(width - 2, 1, 4),
    lights: [[1, 1], [width - 2, 1], [1, depth - 2], [width - 2, depth - 2]]
      .map(([x, z]) => position(x, 1, z)),
  };
  add(1, 1, 3, 'white_bed', 'furniture', { part: 'foot', facing: 'north', occupied: false });
  add(1, 1, 2, 'white_bed', 'furniture', { part: 'head', facing: 'north', occupied: false }, true);
  add(width - 2, 1, 2, 'crafting_table', 'furniture');
  add(width - 2, 1, 3, 'chest', 'furniture', { facing: 'west', type: 'single', waterlogged: false });
  add(width - 2, 1, 4, 'furnace', 'furniture', { facing: 'west', lit: false });
  for (const p of furniture.lights) add(p.x - anchor.x, 1, p.z - anchor.z, 'torch', 'finish');
  add(middle, 1, 0, 'oak_door', 'finish', { half: 'lower', facing: 'north', open: false, powered: false });
  add(middle, 2, 0, 'oak_door', 'finish', { half: 'upper', facing: 'north', open: false, powered: false }, true);

  for (let z = -1; z <= (profile === 'cottage' ? depth - 2 : 6); z += 1) {
    if (z === 0) continue;
    for (const y of [1, 2]) air(middle, y, z, 'entrance_and_interior_walkway');
  }
  for (const p of [furniture.bed.foot, furniture.bed.head, furniture.craftingTable, furniture.chest, furniture.furnace]) {
    air(p.x - anchor.x, 2, p.z - anchor.z, 'furniture_headroom');
  }
  if (profile === 'enchanting_library') {
    furniture.enchantingTable = position(4, 1, 7);
    furniture.bookshelves = [];
    add(4, 1, 7, 'enchanting_table', 'furniture');
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dz = -2; dz <= 2; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2 || (dx === 0 && dz === -2)) continue;
        add(4 + dx, 1, 7 + dz, 'bookshelf', 'furniture');
        furniture.bookshelves.push(position(4 + dx, 1, 7 + dz));
        const gapX = 4 + Math.trunc(dx / 2);
        const gapZ = 7 + Math.trunc(dz / 2);
        for (const y of [1, 2]) air(gapX, y, gapZ, 'enchantment_transmitter_air');
      }
    }
    air(4, 2, 7, 'enchanting_table_headroom');
  }

  const scaffold = [];
  const scaffoldRoute = [];
  for (let level = 0; level < roofTop; level += 1) {
    const z = depth + roofTop - level;
    for (let y = 0; y <= level; y += 1) scaffold.push({ position: position(middle, y, z), item: 'dirt' });
    scaffoldRoute.push(position(middle, level + 1, z));
  }
  // The third vertical log must be placed on the lower log's top face.
  // Ground-level eyes sit below that face. Three external steps at each
  // corner provide a raised work stance and a continuous one-block descent
  // from the completed wall top. Their nearest columns sit below the eaves,
  // without occupying any finished building block.
  for (const x of [0, width - 1]) {
    for (const [firstZ, direction] of [[-3, 1], [depth + 2, -1]]) {
      for (let step = 0; step < 3; step += 1) {
        for (let y = 0; y <= step; y += 1) {
          scaffold.push({ position: position(x, y, firstZ + direction * step), item: 'dirt', stage: 'frame' });
        }
      }
    }
  }
  const blocks = [...keyed.values()];
  const clearance = [...clearanceMap.values()];
  for (const cell of clearance) {
    if (keyed.has(key(cell.position))) throw new Error(`家具通路与结构冲突 ${key(cell.position)}`);
  }
  return {
    schema: 2, profile, anchor: { ...anchor },
    dimensions: { width, depth, wallHeight: 3, maxY: roofTop },
    bounds: { minX: anchor.x - 1, maxX: anchor.x + width, minY: anchor.y,
      maxY: anchor.y + roofTop, minZ: anchor.z - 1, maxZ: anchor.z + depth },
    blocks, clearance, furniture,
    entrance: { outside: position(middle, 0, -2), inside: position(middle, 1, 1) },
    scaffold, scaffoldRoute,
  };
}

function getFurnishedHouseMaterialBudget(blueprint, { includeScaffold = true } = {}) {
  const result = {};
  for (const block of blueprint.blocks) {
    if (!block.derived) result[block.item] = (result[block.item] || 0) + 1;
  }
  if (includeScaffold) {
    for (const block of blueprint.scaffold) result[block.item] = (result[block.item] || 0) + 1;
  }
  return result;
}

module.exports = { FURNISHED_HOUSE_PHASES, normalizeFurnishedHouseProfile,
  createFurnishedHouseBlueprint, getFurnishedHouseMaterialBudget };
