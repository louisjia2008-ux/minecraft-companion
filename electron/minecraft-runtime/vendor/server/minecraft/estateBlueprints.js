/* global require, module */
'use strict';

const { createFurnishedHouseBlueprint } = require('./furnishedHouseBlueprints');

const ESTATE_PROFILES = Object.freeze(['medieval_castle', 'riverside_villa']);
const ESTATE_PHASES = Object.freeze(['floor', 'stairs', 'upper_floor', 'frame', 'walls', 'windows', 'roof', 'furniture', 'finish', 'landscape']);
const key = (p) => `${p.x},${p.y},${p.z}`;
const copy = (value) => JSON.parse(JSON.stringify(value));

function createEstateBlueprint(anchor, { profile = 'medieval_castle' } = {}) {
  if (!anchor || !['x', 'y', 'z'].every((axis) => Number.isSafeInteger(anchor[axis]))) {
    throw new Error('庄园锚点必须是安全整数坐标');
  }
  if (!['x', 'y', 'z'].every((axis) => Number.isSafeInteger(anchor[axis] - 64) && Number.isSafeInteger(anchor[axis] + 64))) {
    throw new Error('庄园坐标平移超过安全整数范围');
  }
  if (!ESTATE_PROFILES.includes(profile)) throw new Error(`不支持的庄园款式：${profile}`);
  const blocks = new Map();
  const empty = new Map();
  const components = [];
  const scaffolds = new Map();
  const scaffoldRoutes = [];
  const routes = [];
  const farms = [];
  const waterZones = [];
  const p = (x, y, z) => ({ x: anchor.x + x, y: anchor.y + y, z: anchor.z + z });
  const local = (at) => ({ x: at.x - anchor.x, y: at.y - anchor.y, z: at.z - anchor.z });
  function component(id, label, dependencies = [], kind = 'building') {
    components.push({ id, label, kind, dependencies: [...dependencies] });
    return id;
  }
  function add(owner, x, y, z, item, phase, properties = {}, derived = false) {
    const position = p(x, y, z);
    if (blocks.has(key(position))) throw new Error(`庄园结构重复 ${key(position)} (${owner})`);
    const spec = { id: `${owner}:${phase}:${x},${y},${z}`, item, position, component: owner, phase,
      ...(Object.keys(properties).length ? { properties: { ...properties } } : {}), ...(derived ? { derived: true } : {}) };
    blocks.set(key(position), spec);
    return spec;
  }
  function air(x, y, z, purpose) {
    const position = p(x, y, z);
    const old = empty.get(key(position));
    empty.set(key(position), { position, purpose: old ? `${old.purpose}|${purpose}` : purpose });
  }
  function route(id, waypoints, purpose, doors = []) {
    routes.push({ id, purpose, waypoints: waypoints.map(([x, y, z]) => p(x, y, z)), doors: doors.map(copy) });
  }
  function scaffold(owner, x, y, z, routeId, approachDirection, cleanupRank, stage = 'roof') {
    const position = p(x, y, z);
    if (scaffolds.has(key(position))) throw new Error(`临时脚手架重复 ${key(position)}`);
    scaffolds.set(key(position), { id: `${owner}:scaffold:${x},${y},${z}`, item: 'dirt', position,
      component: owner, routeId, approachDirection, cleanupRank, stage });
  }
  // Direction is the horizontal vector from the roof to the dry approach.
  // Within each layer remove the farthest approach-side block first; the
  // next lower intact layer remains the walking/support surface.
  function roofRamp(owner, x, roofZ, height, direction, dryApproach) {
    const id = `${owner}:roof_ramp`;
    const steps = [];
    for (let level = 0; level < height; level += 1) {
      const z = roofZ + direction * (height - level);
      for (let y = 0; y <= level; y += 1) {
        const distance = Math.abs(z - roofZ);
        scaffold(owner, x, y, z, id, direction === 1 ? 'north' : 'south', (height - 1 - y) * (height + 1) + height - distance);
      }
      steps.push(p(x, level + 1, z));
    }
    const approach = dryApproach ? p(...dryApproach) : p(x, 0, roofZ + direction * (height + 1));
    scaffoldRoutes.push({ id, component: owner, stage: 'roof', approachDirection: direction === 1 ? 'north' : 'south',
      approach, waypoints: steps,
      roofLanding: p(x, height + 0.5, roofZ), cleanupStart: { ...approach },
      exitBeforeCleanup: true, cleanupPolicy: 'descending_y_then_approach_side_first' });
  }
  function platform(owner, x, floorY, z, approachX, approachZ, stage = 'frame', height = 1) {
    const id = `${owner}:${stage}_platform:${x},${floorY},${z}`;
    scaffold(owner, x, floorY + 1, z, id, 'from_permanent_floor', -floorY, stage);
    const steps = [];
    if (height === 2) {
      scaffold(owner, approachX, floorY + 1, approachZ, id, 'from_permanent_floor', -floorY - 1, stage);
      scaffold(owner, x, floorY + 2, z, id, 'from_permanent_floor', -floorY - 2, stage);
      steps.push(p(approachX, floorY + 2, approachZ));
      approachX += approachX - x; approachZ += approachZ - z;
    }
    steps.push(p(x, floorY + height + 1, z));
    scaffoldRoutes.push({ id, component: owner, stage, approach: p(approachX, floorY + 1, approachZ),
      waypoints: steps, cleanupStart: p(approachX, floorY + 1, approachZ),
      exitBeforeCleanup: true, cleanupPolicy: 'stand_on_permanent_floor' });
  }
  function addDoor(owner, x, y, z, facing) {
    const door = { lower: p(x, y, z), upper: p(x, y + 1, z), facing };
    add(owner, x, y, z, 'oak_door', 'finish', { half: 'lower', facing, hinge: 'left', open: false, powered: false });
    add(owner, x, y + 1, z, 'oak_door', 'finish', { half: 'upper', facing, hinge: 'left', open: false, powered: false }, true);
    return door;
  }
  function addBed(owner, x, y, z) {
    add(owner, x, y, z, 'white_bed', 'furniture', { part: 'foot', facing: 'north', occupied: false });
    add(owner, x, y, z - 1, 'white_bed', 'furniture', { part: 'head', facing: 'north', occupied: false }, true);
    air(x, y + 1, z, 'bed_headroom'); air(x, y + 1, z - 1, 'bed_headroom');
    return { foot: p(x, y, z), head: p(x, y, z - 1), facing: 'north' };
  }
  function library(owner, x, y, z) {
    add(owner, x, y, z, 'enchanting_table', 'furniture');
    const bookshelves = [];
    for (let dx = -2; dx <= 2; dx += 1) for (let dz = -2; dz <= 2; dz += 1) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2 || (dx === 0 && dz === -2)) continue;
      add(owner, x + dx, y, z + dz, 'bookshelf', 'furniture');
      bookshelves.push(p(x + dx, y, z + dz));
      for (const dy of [0, 1]) air(x + Math.trunc(dx / 2), y + dy, z + Math.trunc(dz / 2), 'enchantment_transmitter');
    }
    air(x, y + 1, z, 'enchantment_headroom');
    return { enchantingTable: p(x, y, z), bookshelves };
  }
  function pitchedRoof(owner, x0, z0, width, depth, wallTop) {
    const middle = Math.floor(width / 2);
    for (let x = 0; x < width; x += 1) {
      const top = wallTop + Math.min(x + 1, width - x);
      for (let y = wallTop + 1; y < top; y += 1) {
        for (const z of [0, depth - 1]) add(owner, x0 + x, y, z0 + z, 'oak_planks', 'roof');
      }
    }
    for (let x = -1; x <= width; x += 1) for (let z = -1; z <= depth; z += 1) {
      const y = wallTop + Math.min(x + 1, width - x);
      add(owner, x0 + x, y, z0 + z, x === middle ? 'oak_slab' : 'oak_stairs', 'roof', x === middle
        ? { type: 'bottom', waterlogged: false }
        : { facing: x < middle ? 'east' : 'west', half: 'bottom', shape: 'straight', waterlogged: false });
    }
    return wallTop + middle + 1;
  }
  function farm(id, x0, z0, dependencies) {
    component(id, '灌溉小麦田', dependencies, 'farm');
    const water = p(x0 + 2, 0, z0 + 2);
    const soil = []; const crops = []; const access = [];
    for (let x = -1; x <= 5; x += 1) for (let z = -1; z <= 5; z += 1) {
      if (x >= 0 && x < 5 && z >= 0 && z < 5) {
        if (x === 2 && z === 2) continue;
        soil.push(p(x0 + x, 0, z0 + z));
        crops.push({ position: p(x0 + x, 1, z0 + z), soilPosition: p(x0 + x, 0, z0 + z), item: 'wheat_seeds', block: 'wheat' });
        air(x0 + x, 2, z0 + z, 'crop_light');
      } else {
        add(id, x0 + x, 0, z0 + z, 'cobblestone', 'landscape');
        access.push(p(x0 + x, 1, z0 + z));
        air(x0 + x, 1, z0 + z, 'dry_farm_access'); air(x0 + x, 2, z0 + z, 'dry_farm_headroom');
      }
    }
    farms.push({ schema: 1, id, component: id, bounds: { minX: anchor.x + x0, maxX: anchor.x + x0 + 4,
      minY: anchor.y, maxY: anchor.y + 2, minZ: anchor.z + z0, maxZ: anchor.z + z0 + 4 },
    soil, water, crops, access, crop: 'wheat', hydration: 7,
    operations: ['place_soil', 'pour_water_bucket', 'hoe', 'plant', 'observe_hydration', 'harvest_and_replant_sample'] });
  }

  let furniture; let entrance; let dimensions; let siteRequirements;
  if (profile === 'medieval_castle') {
    dimensions = { width: 27, depth: 27, maxY: 9, keep: { width: 9, depth: 11 } };
    component('keep', '附魔主堡');
    const keep = createFurnishedHouseBlueprint(p(9, 0, 6), { profile: 'enchanting_library' });
    for (const spec of keep.blocks) {
      const q = local(spec.position); add('keep', q.x, q.y, q.z, spec.item, spec.phase, spec.properties || {}, spec.derived);
    }
    for (const cell of keep.clearance) { const q = local(cell.position); air(q.x, q.y, q.z, cell.purpose); }
    // The accepted library keep has a dry rear ramp entirely inside the
    // curtain line. Corner platforms retain the proven three-step descent.
    roofRamp('keep', 13, 17, 8, 1, [14, 0, 25]);
    for (const x of [9, 17]) for (const [firstZ, direction] of [[3, 1], [19, -1]]) {
      const id = `keep:corner:${x},${firstZ}`; const points = [];
      for (let level = 0; level < 3; level += 1) {
        for (let y = 0; y <= level; y += 1) scaffold('keep', x, y, firstZ + direction * level, id,
          direction === 1 ? 'south' : 'north', (2 - y) * 4 + level, 'frame');
        points.push(p(x, level + 1, firstZ + direction * level));
      }
      scaffoldRoutes.push({ id, component: 'keep', stage: 'frame', usableBeforePhase: 'roof', approach: p(x, 0, firstZ - direction),
        waypoints: points, cleanupStart: p(x, 0, firstZ - direction), exitBeforeCleanup: true,
        cleanupPolicy: 'descending_y_then_approach_side_first' });
    }
    furniture = copy(keep.furniture); furniture.doors = [copy(furniture.door)];
    furniture.beds = [copy(furniture.bed)]; furniture.chests = [copy(furniture.chest)]; furniture.furnaces = [copy(furniture.furnace)];
    entrance = { outside: p(13, 0, -2), inside: copy(keep.entrance.inside), construction: copy(keep.entrance.outside) };
    route('main_entry', [[13, 0, -2], [13, 1, 0], [13, 1, 4], [13, 1, 7]], '正门至主堡', [furniture.door]);
    const towerIds = [];
    for (const [name, x0, z0, direction] of [['nw', 0, 0, -1], ['ne', 22, 0, -1], ['sw', 0, 22, 1], ['se', 22, 22, 1]]) {
      const id = component(`tower_${name}`, '城角望楼', ['keep']); towerIds.push(id);
      for (let x = 0; x < 5; x += 1) for (let z = 0; z < 5; z += 1) add(id, x0 + x, 0, z0 + z, 'cobblestone', 'floor');
      for (let step = 0; step < 3; step += 1) {
        for (let y = 1; y < step + 1; y += 1) add(id, x0 + 2, y, z0 + 1 + step, 'cobblestone', 'stairs');
        add(id, x0 + 2, step + 1, z0 + 1 + step, 'oak_stairs', 'stairs', { facing: 'south', half: 'bottom', shape: 'straight', waterlogged: false });
      }
      const innerX = x0 === 0 ? 4 : 0; const innerZ = z0 === 0 ? 4 : 0;
      const upperOpen = (x, z) => (x === innerX && z === (z0 === 0 ? 1 : 3)) || (z === innerZ && x === (x0 === 0 ? 1 : 3));
      const groundOpen = (x, z) => x === innerX && z === 3;
      for (let x = 0; x < 5; x += 1) for (let z = 0; z < 5; z += 1) {
        if (x !== 0 && x !== 4 && z !== 0 && z !== 4) continue;
        for (let y = 1; y <= 6; y += 1) {
          if (groundOpen(x, z) && y <= 2 || upperOpen(x, z) && (y === 4 || y === 5)) continue;
          const window = y === 5 && (x === 2 && (z === 0 || z === 4) || z === 2 && (x === 0 || x === 4));
          add(id, x0 + x, y, z0 + z, window ? 'glass' : 'cobblestone', window ? 'windows' : 'walls');
        }
      }
      for (let x = 1; x <= 3; x += 1) for (let z = 1; z <= 3; z += 1) {
        if (x === 2) continue; // Full-height stairwell, including top stair.
        add(id, x0 + x, 3, z0 + z, 'oak_planks', 'upper_floor');
      }
      // Back landing joins the two sides without filling the stairwell.
      // Top stair itself connects x=1 and x=3 at z=3.
      pitchedRoof(id, x0, z0, 5, 5, 6);
      roofRamp(id, x0 + 2, direction === -1 ? z0 - 1 : z0 + 5, 9, direction);
      platform(id, x0 + 3, 3, z0 + 1, x0 + 3, z0 + 2, 'frame', 2);
      add(id, x0 + 3, 4, z0 + 3, 'torch', 'finish');
      route(`${id}:stairs`, [[x0 + innerX + (innerX === 4 ? 1 : -1), 0, z0 + 3],
        [x0 + 3, 1, z0 + 3], [x0 + 3, 1, z0 + 1], [x0 + 2, 2, z0 + 1],
        [x0 + 2, 3, z0 + 2], [x0 + 2, 4, z0 + 3], [x0 + 1, 4, z0 + 3]], '庭院至望楼平台');
    }
    component('wall_stairs', '永久双宽城墙梯', ['keep'], 'stairs');
    for (const x of [6, 7]) for (let level = 0; level < 4; level += 1) {
      const z = 5 - level;
      for (let y = 0; y < level; y += 1) add('wall_stairs', x, y, z, 'cobblestone', 'floor');
      add('wall_stairs', x, level, z, 'oak_stairs', 'stairs', { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: false });
    }
    route('wall_stairs', [[6, 0, 6], [6, 1, 5], [6, 2, 4], [6, 3, 3], [6, 4, 2], [6, 4, 1]], '庭院至城墙步道');
    const curtainIds = [];
    for (const side of ['north', 'east', 'south', 'west']) {
      const id = component(`curtain_${side}`, '连通城墙步道', [...towerIds, 'wall_stairs'], 'wall'); curtainIds.push(id);
      for (let along = 5; along <= 21; along += 1) {
        if (side === 'north' && along >= 10 && along <= 16) continue;
        const x = side === 'west' ? 0 : side === 'east' ? 26 : along;
        const z = side === 'north' ? 0 : side === 'south' ? 26 : along;
        for (let y = 0; y <= 3; y += 1) add(id, x, y, z, 'cobblestone', y === 3 ? 'upper_floor' : 'walls');
        add(id, x + (side === 'west' ? 1 : side === 'east' ? -1 : 0), 3,
          z + (side === 'north' ? 1 : side === 'south' ? -1 : 0), 'cobblestone', 'upper_floor');
        if (along % 2) add(id, x, 4, z, 'cobblestone', 'finish');
      }
    }
    component('gatehouse', '石拱门楼与顶台', ['curtain_north'], 'building');
    for (let x = 10; x <= 16; x += 1) for (let z = 0; z <= 2; z += 1) {
      add('gatehouse', x, 0, z, 'cobblestone', 'floor');
      add('gatehouse', x, 3, z, 'cobblestone', 'upper_floor');
      if (x === 10 || x === 16 || (z === 0 || z === 2) && (x === 11 || x === 15)) {
        for (let y = 1; y <= 2; y += 1) add('gatehouse', x, y, z, 'cobblestone', 'walls');
      }
      if ((z === 0 || z === 2) && x % 2 === 0) add('gatehouse', x, 4, z, 'cobblestone', 'finish');
    }
    route('wallwalk_north', [[3, 4, 1], [6, 4, 1], [13, 4, 1], [20, 4, 1], [23, 4, 1]], '北侧城墙与门楼');
    route('wallwalk_south', [[3, 4, 25], [6, 4, 25], [13, 4, 25], [20, 4, 25], [23, 4, 25]], '南侧城墙');
    route('wallwalk_west', [[1, 4, 3], [1, 4, 8], [1, 4, 20], [1, 4, 23]], '西侧城墙');
    route('wallwalk_east', [[25, 4, 3], [25, 4, 8], [25, 4, 20], [25, 4, 23]], '东侧城墙');
    component('courtyard', '石路与庭院照明', ['gatehouse', ...curtainIds, 'keep'], 'landscape');
    for (const x of [12, 13, 14]) for (const z of [3, 4]) add('courtyard', x, 0, z, 'cobblestone', 'landscape');
    for (const [x, z] of [[11, 4], [15, 4], [2, 7], [24, 7], [2, 20], [24, 20]]) add('courtyard', x, 0, z, 'torch', 'finish');
    farm('farm_west', 3, 9, ['courtyard']); farm('farm_east', 19, 9, ['courtyard']);
    siteRequirements = { dryGroundY: anchor.y - 1, river: false, preserveNaturalCourtyard: true,
      constructionOrderReason: 'Keep and external tower ramps are cleaned before enclosed curtain access is needed; permanent stairs remain.',
      constructionEntrance: copy(keep.entrance.outside) };
  } else {
    dimensions = { width: 11, depth: 13, floors: 2, upperFloorY: 4, maxY: 13,
      terrace: { width: 11, depth: 4 }, dock: { width: 3, depth: 7 } };
    component('villa_ground', '石基原木一层');
    for (let x = 0; x < 11; x += 1) for (let z = 0; z < 13; z += 1) {
      add('villa_ground', x, 0, z, x === 0 || x === 10 || z === 0 || z === 12 ? 'cobblestone' : 'oak_planks', 'floor');
    }
    const doorCells = [[5, 1, 0, 'north'], [5, 1, 12, 'south'], [10, 1, 7, 'east'], [0, 5, 4, 'west'], [5, 5, 12, 'south']];
    const wall = (owner, bottom) => {
      for (let x = 0; x < 11; x += 1) for (let z = 0; z < 13; z += 1) {
        if (x !== 0 && x !== 10 && z !== 0 && z !== 12) continue;
        for (let y = bottom; y < bottom + 3; y += 1) {
          if (doorCells.some(([dx, dy, dz]) => dx === x && dz === z && (dy === y || dy + 1 === y))) continue;
          const corner = (x === 0 || x === 10) && (z === 0 || z === 12);
          const window = y === bottom + 1 && ((z === 0 || z === 12) && [1, 2, 3, 7, 8, 9].includes(x)
            || (x === 0 || x === 10) && [2, 3, 9, 10].includes(z));
          add(owner, x, y, z, corner ? 'oak_log' : window ? 'glass' : 'oak_planks', corner ? 'frame' : window ? 'windows' : 'walls', corner ? { axis: 'y' } : {});
        }
      }
    };
    wall('villa_ground', 1);
    for (const [x, z] of [[2, 1], [8, 1], [2, 11], [8, 11]]) platform('villa_ground', x, 0, z, x, z === 1 ? 2 : 10);
    for (const x of [4, 5, 6]) add('villa_ground', x, 0, -1, 'oak_stairs', 'floor',
      { facing: 'south', half: 'bottom', shape: 'straight', waterlogged: false });
    component('villa_stairs', '外侧双宽永久楼梯', ['villa_ground'], 'stairs');
    for (const x of [-3, -2]) for (let level = 0; level < 5; level += 1) {
      for (let y = 0; y < level; y += 1) add('villa_stairs', x, y, level, 'cobblestone', 'floor');
      add('villa_stairs', x, level, level, 'oak_stairs', 'stairs', { facing: 'south', half: 'bottom', shape: 'straight', waterlogged: false });
    }
    for (let z = 0; z <= 4; z += 1) {
      for (let y = 0; y <= z; y += 1) add('villa_stairs', -4, y, z, 'cobblestone', 'floor');
      add('villa_stairs', -4, z + 1, z, 'oak_fence', 'finish');
      if (z < 3) {
        for (let y = 0; y <= z; y += 1) add('villa_stairs', -1, y, z, 'cobblestone', 'floor');
        add('villa_stairs', -1, z + 1, z, 'oak_fence', 'finish');
      }
    }
    for (const z of [3, 5]) {
      for (let y = 0; y < 4; y += 1) add('villa_stairs', -1, y, z, 'oak_log', 'frame', { axis: 'y' });
    }
    for (const z of [3, 4, 5]) add('villa_stairs', -1, 4, z, 'oak_planks', 'upper_floor');
    for (const z of [3, 5]) add('villa_stairs', -1, 5, z, 'oak_fence', 'finish');
    component('villa_upper_floor', '二层完整楼板', ['villa_stairs'], 'building');
    for (let x = 0; x < 11; x += 1) for (let z = 0; z < 13; z += 1) add('villa_upper_floor', x, 4, z, 'oak_planks', 'upper_floor');
    component('villa_upper_shell', '二层卧室与书房', ['villa_upper_floor']);
    wall('villa_upper_shell', 5);
    for (const [x, z] of [[2, 1], [8, 1], [1, 11], [9, 11]]) platform('villa_upper_shell', x, 4, z, x, z === 1 ? 2 : 10, 'frame', 2);
    component('villa_decks', '河景露台与上层阳台', ['villa_upper_floor'], 'building');
    for (let x = 0; x <= 10; x += 1) for (let z = 13; z <= 16; z += 1) add('villa_decks', x, 0, z, 'oak_planks', 'floor');
    for (const x of [0, 10]) for (let y = 1; y <= 3; y += 1) add('villa_decks', x, y, 15, 'oak_log', 'frame', { axis: 'y' });
    for (const x of [1, 9]) platform('villa_decks', x, 0, 14, x, 13);
    for (let x = 0; x <= 10; x += 1) for (let z = 13; z <= 15; z += 1) add('villa_decks', x, 4, z, 'oak_planks', 'upper_floor');
    for (let x = 0; x <= 10; x += 1) for (let z = 13; z <= 16; z += 1) {
      if ((x === 0 || x === 10 || z === 16) && !(z === 16 && x >= 4 && x <= 6)
          && !(z === 15 && (x === 0 || x === 10))) add('villa_decks', x, 1, z, 'oak_fence', 'finish');
      if (z <= 15 && (x === 0 || x === 10 || z === 15)) add('villa_decks', x, 5, z, 'oak_fence', 'finish');
    }
    component('villa_roof', '连续双坡橡木屋顶', ['villa_upper_shell', 'villa_decks']);
    pitchedRoof('villa_roof', 0, 0, 11, 13, 7);
    // A rear ramp would cross the river. The front dry ramp is independent
    // of the permanent west stair and east construction entrance.
    roofRamp('villa_roof', 5, -1, 13, -1);
    component('villa_dock', '三格宽岸上延伸码头', ['villa_decks', 'villa_roof'], 'dock');
    for (let x = 4; x <= 6; x += 1) for (let z = 17; z <= 23; z += 1) {
      add('villa_dock', x, 0, z, 'oak_planks', 'floor');
      if (x !== 5) add('villa_dock', x, 1, z, 'oak_fence', 'finish');
    }
    waterZones.push({ id: 'river_surface', bounds: { minX: anchor.x - 1, maxX: anchor.x + 20,
      minY: anchor.y - 1, maxY: anchor.y - 1, minZ: anchor.z + 17, maxZ: anchor.z + 25 },
    expectedBlock: 'water', placementPolicy: 'dock_targets_are_air_above_water; do_not_enter_water' });
    component('villa_furniture', '全层生活设施与附魔书房', ['villa_roof', 'villa_dock']);
    const doors = doorCells.map(([x, y, z, facing]) => addDoor('villa_furniture', x, y, z, facing));
    const beds = [addBed('villa_furniture', 2, 5, 10), addBed('villa_furniture', 7, 5, 10)];
    const chestPositions = [[9, 1, 4], [9, 1, 6], [1, 1, 8], [1, 1, 10]];
    const furnacePositions = [[1, 1, 2], [1, 1, 4]];
    add('villa_furniture', 9, 1, 2, 'crafting_table', 'furniture');
    for (const [x, y, z] of chestPositions) add('villa_furniture', x, y, z, 'chest', 'furniture', { facing: x === 1 ? 'east' : 'west', type: 'single', waterlogged: false });
    for (const [x, y, z] of furnacePositions) add('villa_furniture', x, y, z, 'furnace', 'furniture', { facing: 'east', lit: false });
    const lightPositions = [[1, 1, 1], [9, 1, 1], [1, 1, 11], [9, 1, 11], [1, 5, 1], [9, 5, 1], [3, 5, 8], [9, 5, 8]];
    for (const [x, y, z] of lightPositions) add('villa_furniture', x, y, z, 'torch', 'finish');
    furniture = { door: doors[0], doors, bed: beds[0], beds, craftingTable: p(9, 1, 2),
      chest: p(...chestPositions[0]), chests: chestPositions.map((v) => p(...v)),
      furnace: p(...furnacePositions[0]), furnaces: furnacePositions.map((v) => p(...v)),
      lights: lightPositions.map((v) => p(...v)), ...library('villa_furniture', 5, 5, 4) };
    for (const [x, y, z] of [[9, 1, 2], ...chestPositions, ...furnacePositions]) air(x, y + 1, z, 'furniture_headroom');
    for (let z = 1; z <= 11; z += 1) for (const y of [1, 2]) air(5, y, z, 'ground_floor_walkway');
    for (let z = 4; z <= 11; z += 1) for (const y of [5, 6]) air(1, y, z, 'upper_floor_side_aisle');
    for (let z = 7; z <= 11; z += 1) for (const y of [5, 6]) air(5, y, z, 'upper_floor_rear_aisle');
    for (const y of [5, 6]) air(-1, y, 4, 'upper_door_landing');
    entrance = { outside: p(5, 0, -2), inside: p(5, 1, 1), construction: p(11, 0, 7), upper: p(1, 5, 4) };
    route('main_entry', [[5, 0, -2], [5, 1, -1], [5, 1, 1], [5, 1, 11]], '前门及厨房', [doors[0]]);
    route('upper_entry', [[-2, 0, -1], [-2, 1, 0], [-2, 2, 1], [-2, 3, 2], [-2, 4, 3], [-2, 5, 4], [-1, 5, 4], [1, 5, 4]], '双宽直梯至二层', [doors[3]]);
    route('upper_terrace', [[1, 5, 4], [1, 5, 7], [5, 5, 7], [5, 5, 11], [5, 5, 13], [5, 5, 14]], '卧室至河景阳台', [doors[4]]);
    route('dock_access', [[5, 1, 11], [5, 1, 13], [5, 1, 16], [5, 1, 20], [5, 1, 23]], '厨房至露台码头', [doors[1]]);
    route('construction_supply', [[12, 0, 0], [12, 0, 7], [11, 0, 7], [9, 1, 7]], '前坡存在时从东门取料', [doors[2]]);
    farm('farm_north', 14, 0, ['villa_furniture']); farm('farm_south', 14, 7, ['villa_furniture']);
    siteRequirements = { dryGroundY: anchor.y - 1, river: true, waterY: anchor.y - 1,
      constructionEntrance: copy(entrance.construction), mainEntranceBlockedDuringRoofRamp: true,
      riverLimits: 'Require the declared water surface and dry building/garden/front-ramp zones; arbitrary natural riverbanks are not assumed.',
      dock: { targetsY: anchor.y, targetBlock: 'air', firstAnchor: p(5, 0, 16), requiresConfirmedAdjacentAnchor: true,
        buildOrder: 'extend each column from the terrace using adjacent already confirmed planks; walk only on confirmed dry decking' } };
    for (const id of ['villa_ground', 'villa_upper_shell', 'villa_decks']) {
      components.find((c) => c.id === id).cleanupAfterComponent = 'villa_roof';
    }
  }

  for (const cell of empty.values()) {
    if (blocks.has(key(cell.position))) throw new Error(`净空与结构冲突 ${key(cell.position)} (${cell.purpose})`);
  }
  for (const spec of scaffolds.values()) {
    if (blocks.has(key(spec.position))) throw new Error(`临时与永久结构冲突 ${key(spec.position)}`);
  }
  const boundsFor = (positions) => ({ minX: Math.min(...positions.map((v) => v.x)), maxX: Math.max(...positions.map((v) => v.x)),
    minY: Math.min(...positions.map((v) => v.y)), maxY: Math.max(...positions.map((v) => v.y)),
    minZ: Math.min(...positions.map((v) => v.z)), maxZ: Math.max(...positions.map((v) => v.z)) });
  const structure = [...blocks.values()]; const temporary = [...scaffolds.values()];
  const dryGround = new Map();
  for (const spec of [...structure.filter((s) => s.component !== 'villa_dock'), ...temporary]) {
    if (spec.position.y === anchor.y) {
      const below = { ...spec.position, y: anchor.y - 1 }; dryGround.set(key(below), below);
    }
  }
  for (const plot of farms) for (const at of [...plot.soil, plot.water]) {
    const below = { ...at, y: anchor.y - 1 }; dryGround.set(key(below), below);
  }
  for (const r of scaffoldRoutes) if (r.approach.y === anchor.y) {
    const below = { ...r.approach, y: anchor.y - 1 }; dryGround.set(key(below), below);
  }
  siteRequirements.dryGroundCells = [...dryGround.values()];
  siteRequirements.dryGroundPolicy = 'Read-only solid dry support check; never clear these support cells.';
  const componentBounds = {};
  for (const c of components) {
    const own = structure.filter((s) => s.component === c.id); const work = temporary.filter((s) => s.component === c.id);
    const plot = farms.find((f) => f.component === c.id);
    c.blockIds = own.map((s) => s.id); c.scaffoldIds = work.map((s) => s.id);
    c.phases = ESTATE_PHASES.filter((phase) => own.some((s) => s.phase === phase));
    c.bounds = boundsFor([...own.map((s) => s.position), ...(plot ? [...plot.soil, ...plot.crops.map((v) => v.position)] : [])]);
    const approaches = scaffoldRoutes.filter((r) => r.component === c.id).flatMap((r) => [r.approach, r.cleanupStart]);
    c.workBounds = boundsFor([...own.map((s) => s.position), ...work.map((s) => s.position), ...approaches, ...(plot ? plot.soil : [])]);
    componentBounds[c.id] = copy(c.bounds);
  }
  return { schema: 1, profile, anchor: { ...anchor }, dimensions,
    coordinateConvention: 'Block cells; route/access y is standing feet height, x/z center is cell + 0.5.',
    bounds: boundsFor(structure.map((s) => s.position)),
    workBounds: boundsFor([...structure, ...temporary].map((s) => s.position).concat(scaffoldRoutes.flatMap((r) => [r.approach, r.cleanupStart]))),
    blocks: structure, components, componentBounds, scaffold: temporary, scaffoldRoutes,
    clearance: [...empty.values()], routes, farms, waterZones, furniture, entrance, siteRequirements };
}

function getEstateMaterialBudget(blueprint, { includeScaffold = true, component } = {}) {
  const result = {};
  for (const spec of blueprint.blocks) {
    if (!spec.derived && (!component || spec.component === component)) result[spec.item] = (result[spec.item] || 0) + 1;
  }
  if (includeScaffold) for (const spec of blueprint.scaffold) {
    if (!component || spec.component === component) result[spec.item] = (result[spec.item] || 0) + 1;
  }
  return result;
}

function getEstateFarmBudget(blueprint) {
  return { dirt: blueprint.farms.reduce((n, f) => n + f.soil.length, 0), wheat_seeds: blueprint.farms.reduce((n, f) => n + f.crops.length + 4, 0),
    water_bucket: blueprint.farms.length, bone_meal: blueprint.farms.length * 32 };
}

module.exports = { ESTATE_PROFILES, ESTATE_PHASES, createEstateBlueprint, getEstateMaterialBudget, getEstateFarmBudget };
