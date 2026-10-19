/* global process, console */
'use strict';

// Read-only, independent verification of a normally stopped controlled house
// world. Visualizations contain saved Anvil blocks, never planned blocks.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { readRegionChunk, decodeSectionBlock, blockLocation, readLevelMetadata } = require('./natural-world-audit.cjs');

const key = (p) => `${p.x},${p.y},${p.z}`;
const bare = (name) => String(name || '').replace(/^minecraft:/, '');
const air = (block) => ['air', 'cave_air', 'void_air'].includes(bare(block?.name));
const json = (value, indent = 2) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, indent);
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function matches(block, name, properties = {}) {
  return bare(block?.name) === name && Object.entries(properties)
    .every(([property, value]) => String(block.properties?.[property]) === String(value));
}
function effectiveBookshelves(getBlock, table) {
  const candidates = [];
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue;
      for (const dy of [0, 1]) {
        const position = { x: table.x + dx, y: table.y + dy, z: table.z + dz };
        const gap = { x: table.x + Math.trunc(dx / 2), y: table.y + dy, z: table.z + Math.trunc(dz / 2) };
        // Vanilla's provider tag is ordinary bookshelf. Its transmitter tag
        // accepts replaceable blocks; this fixture intentionally requires air.
        if (matches(getBlock(position), 'bookshelf')) candidates.push({ position, gap, transmitterAir: air(getBlock(gap)) });
      }
    }
  }
  return { candidates, effectiveCount: candidates.filter((cell) => cell.transmitterAir).length };
}
function geometryEvidence(getBlock, blueprint) {
  const a = blueprint.anchor;
  const width = blueprint.profile === 'cottage' ? 7 : 9;
  const depth = blueprint.profile === 'cottage' ? 9 : 11;
  const middle = Math.floor(width / 2);
  const at = (x, y, z) => ({ x: a.x + x, y: a.y + y, z: a.z + z });
  const check = (x, y, z, name, properties) => matches(getBlock(at(x, y, z)), name, properties);
  const floorHoles = [];
  const roofHoles = [];
  const wallHoles = [];
  const expectedRoofTop = 3 + (width + 1) / 2;
  for (let x = 0; x < width; x += 1) {
    for (let z = 0; z < depth; z += 1) {
      const perimeter = x === 0 || x === width - 1 || z === 0 || z === depth - 1;
      if (!check(x, 0, z, perimeter ? 'cobblestone' : 'oak_planks')) floorHoles.push(at(x, 0, z));
      if (!perimeter) {
        const top = 3 + Math.min(x + 1, width - x);
        const roof = getBlock(at(x, top, z));
        const expectedName = x === middle ? 'oak_slab' : 'oak_stairs';
        const expectedProperties = x === middle ? { type: 'bottom' }
          : { facing: x < middle ? 'east' : 'west', half: 'bottom', shape: 'straight' };
        if (!matches(roof, expectedName, expectedProperties)) roofHoles.push({ position: at(x, top, z), actual: roof });
      }
      if (perimeter) {
        for (let y = 1; y <= 3; y += 1) {
          if (z === 0 && x === middle && y <= 2) continue;
          if (air(getBlock(at(x, y, z)))) wallHoles.push(at(x, y, z));
        }
      }
    }
  }
  const bedFoot = getBlock(at(1, 1, 3));
  const bedHead = getBlock(at(1, 1, 2));
  const lower = getBlock(at(middle, 1, 0));
  const upper = getBlock(at(middle, 2, 0));
  const chest = getBlock(at(width - 2, 1, 3));
  const furnace = getBlock(at(width - 2, 1, 4));
  const crafting = getBlock(at(width - 2, 1, 2));
  const lights = [[1, 1], [width - 2, 1], [1, depth - 2], [width - 2, depth - 2]]
    .map(([x, z]) => ({ position: at(x, 1, z), actual: getBlock(at(x, 1, z)) }));
  const route = [];
  for (let z = -1; z <= (blueprint.profile === 'cottage' ? depth - 2 : 6); z += 1) {
    if (z === 0) continue;
    for (const y of [1, 2]) route.push({ position: at(middle, y, z), clear: air(getBlock(at(middle, y, z))) });
  }
  const windows = blueprint.blocks.filter((cell) => cell.item === 'glass')
    .map((cell) => ({ position: cell.position, actual: getBlock(cell.position) }));
  const enchanting = blueprint.profile === 'enchanting_library'
    ? { table: getBlock(at(4, 1, 7)), ...effectiveBookshelves(getBlock, at(4, 1, 7)) } : null;
  return { width, depth, expectedRoofTop, floorHoles, roofHoles, wallHoles,
    bed: { foot: bedFoot, head: bedHead, confirmed: matches(bedFoot, 'white_bed', { part: 'foot', facing: 'north' })
      && matches(bedHead, 'white_bed', { part: 'head', facing: 'north' }) },
    door: { lower, upper, confirmed: matches(lower, 'oak_door', { half: 'lower', facing: 'north', open: false })
      && matches(upper, 'oak_door', { half: 'upper', facing: 'north', open: false })
      && ['left', 'right'].includes(lower?.properties.hinge) && lower.properties.hinge === upper?.properties.hinge },
    chest: { actual: chest, clearAbove: air(getBlock(at(width - 2, 2, 3))),
      confirmed: matches(chest, 'chest', { facing: 'west', type: 'single' }) && air(getBlock(at(width - 2, 2, 3))) },
    furnace: { actual: furnace, confirmed: matches(furnace, 'furnace', { facing: 'west' }) },
    craftingTable: { actual: crafting, confirmed: matches(crafting, 'crafting_table') },
    lights, windows, route, enchanting };
}
function compareManifest(getBlock, blueprint) {
  return blueprint.blocks.flatMap((expected) => {
    const actual = getBlock(expected.position);
    // The subsequent independent use phase can light a furnace and occupy a
    // bed. Persistent direction/type/half/shape remain mandatory on disk.
    const properties = Object.fromEntries(Object.entries(expected.properties || {})
      .filter(([property]) => !['lit', 'occupied'].includes(property)));
    return matches(actual, expected.item, properties) ? [] : [{ expected, actual }];
  });
}
function shapesFor(cell) {
  const name = bare(cell.name);
  const p = cell.properties || {};
  if (name === 'torch') return [[0.42, 0, 0.42, 0.58, 0.65, 0.58]];
  if (name.endsWith('_bed')) return [[0, 0, 0, 1, 0.56, 1]];
  if (name === 'chest') return [[0.06, 0, 0.06, 0.94, 0.88, 0.94]];
  if (name === 'enchanting_table') return [[0, 0, 0, 1, 0.75, 1]];
  if (name.endsWith('_slab')) return p.type === 'top' ? [[0, 0.5, 0, 1, 1, 1]] : [[0, 0, 0, 1, p.type === 'double' ? 1 : 0.5, 1]];
  if (name.endsWith('_stairs')) {
    const top = p.half === 'top';
    const base = [0, top ? 0.5 : 0, 0, 1, top ? 1 : 0.5, 1];
    const rise = { east: [0.5, 0, 1, 1], west: [0, 0, 0.5, 1], south: [0, 0.5, 1, 1], north: [0, 0, 1, 0.5] }[p.facing] || [0, 0, 1, 1];
    return [base, [rise[0], top ? 0 : 0.5, rise[1], rise[2], top ? 0.5 : 1, rise[3]]];
  }
  if (name.endsWith('_door')) return ['north', 'south'].includes(p.facing)
    ? [[0, 0, p.facing === 'north' ? 0.81 : 0, 1, 1, p.facing === 'north' ? 1 : 0.19]]
    : [[p.facing === 'west' ? 0.81 : 0, 0, 0, p.facing === 'west' ? 1 : 0.19, 1, 1]];
  return [[0, 0, 0, 1, 1, 1]];
}
function renderSavedBlocks(cells, blueprint, { cutaway = false, front = false } = {}) {
  const colors = { cobblestone: '#8e9298', oak_planks: '#bd925b', oak_log: '#765533', glass: '#a4d8de',
    oak_stairs: '#a47742', oak_slab: '#b8894e', white_bed: '#eee9df', chest: '#b27631', furnace: '#737981',
    crafting_table: '#915c30', torch: '#ffc64c', oak_door: '#b17d41', enchanting_table: '#583b66', bookshelf: '#9c7849' };
  const a = blueprint.anchor;
  const points = [];
  const project = (x, y, z) => front ? [300 + (x + z) * 25, 720 + (x - z) * 12.5 - y * 27]
    : [600 + (x - z) * 25, 660 + (x + z) * 12.5 - y * 27];
  const selected = cells.filter((cell) => !air(cell) && cell.position.y >= a.y
    && (!cutaway || cell.position.y <= a.y + 2));
  selected.sort((u, v) => (u.position.x + (front ? -u.position.z : u.position.z) - v.position.x - (front ? -v.position.z : v.position.z))
    || u.position.y - v.position.y || u.position.x - v.position.x);
  for (const cell of selected) {
    const color = colors[bare(cell.name)] || '#8c9b7a';
    const x = cell.position.x - a.x;
    const y = cell.position.y - a.y;
    const z = cell.position.z - a.z;
    for (const s of shapesFor(cell)) {
      const faces = [
        [[s[0], s[4], s[2]], [s[3], s[4], s[2]], [s[3], s[4], s[5]], [s[0], s[4], s[5]]],
        [[s[3], s[1], s[2]], [s[3], s[4], s[2]], [s[3], s[4], s[5]], [s[3], s[1], s[5]]],
        [[s[0], s[1], front ? s[2] : s[5]], [s[0], s[4], front ? s[2] : s[5]],
          [s[3], s[4], front ? s[2] : s[5]], [s[3], s[1], front ? s[2] : s[5]]],
      ];
      faces.forEach((face, index) => points.push(`<polygon points="${face.map(([dx, dy, dz]) => project(x + dx, y + dy, z + dz).join(',')).join(' ')}" fill="${color}" fill-opacity="${bare(cell.name) === 'glass' ? 0.48 : 1}" stroke="#3c3831" stroke-width="0.65"/><polygon points="${face.map(([dx, dy, dz]) => project(x + dx, y + dy, z + dz).join(',')).join(' ')}" fill="#000" fill-opacity="${[0, 0.12, 0.25][index]}"/>`));
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1050" viewBox="0 0 1200 1050"><rect width="1200" height="1050" fill="#f2efe7"/><text x="45" y="55" font-family="sans-serif" font-size="24" fill="#333">Saved vanilla world — ${blueprint.profile}${cutaway ? ' — roof cutaway' : ''}</text><text x="45" y="84" font-family="sans-serif" font-size="15" fill="#555">Actual Anvil blocks and persistent states; illustrative shapes/colors. No planned blocks rendered.</text>${points.join('')}</svg>\n`;
}
async function auditHouse(runDir) {
  const result = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'));
  const lifecycle = JSON.parse(fs.readFileSync(path.join(runDir, 'server-lifecycle.json'), 'utf8'));
  assert.ok(lifecycle.serverStopped && lifecycle.serverExitCode === 0 && !lifecycle.serverExitSignal, 'Normal saved stop is mandatory');
  assert.ok(result.blueprint?.anchor, 'Actual selected construction anchor is missing; cannot infer a house');
  const world = path.join(runDir, 'world');
  const blueprint = result.blueprint;
  const chunks = new Map();
  const cells = new Map();
  const regions = new Map();
  const bounds = blueprint.bounds;
  async function load(position) {
    const loc = blockLocation(position);
    const chunkKey = `${loc.chunkX},${loc.chunkZ}`;
    if (!chunks.has(chunkKey)) {
      const saved = await readRegionChunk(world, position);
      chunks.set(chunkKey, saved);
      if (!regions.has(saved.regionFile)) regions.set(saved.regionFile, hash(saved.regionFile));
    }
    const saved = chunks.get(chunkKey);
    const section = saved.chunk.sections.find((entry) => entry.Y === loc.sectionY);
    const cell = section ? decodeSectionBlock(section, position) : { name: 'minecraft:air', properties: {}, absentAirSection: true };
    cells.set(key(position), { position, name: cell.name, properties: cell.properties });
  }
  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
      for (let y = bounds.minY; y <= bounds.maxY + 1; y += 1) {
        const position = { x, y, z };
        await load(position);
      }
    }
  }
  for (const spec of blueprint.scaffold || []) if (!cells.has(key(spec.position))) await load(spec.position);
  const getBlock = (position) => cells.get(key(position));
  const geometry = geometryEvidence(getBlock, blueprint);
  const mismatches = compareManifest(getBlock, blueprint);
  const use = result.furnitureUse || {};
  const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const taskConsole = events.filter((event) => event.type === 'server_command'
    && event.elapsedMs >= result.taskSubmittedAt && event.elapsedMs < result.taskEndedAt);
  const blockEntities = [...chunks.values()].flatMap((saved) => saved.chunk.block_entities || []);
  const chestEntity = blockEntities.find((entry) => entry.x === blueprint.furniture.chest.x
    && entry.y === blueprint.furniture.chest.y && entry.z === blueprint.furniture.chest.z);
  const scaffoldRemaining = (blueprint.scaffold || []).filter((spec) => !air(getBlock(spec.position)));
  const clearanceViolations = (blueprint.clearance || []).filter((spec) => !air(getBlock(spec.position)));
  const metadata = await readLevelMetadata(world);
  const requiredHashKeys = ['../runtime.js', '../protocolCompatibility.js', '../vendor/server/minecraftTaskAgent.js',
    '../vendor/server/minecraft/furnishedHouseBlueprints.js', '../vendor/server/minecraft/furnishedHouseBuilder.js',
    './real-furnished-house-server.cjs', './furnished-house-audit.cjs'];
  const validFrozenSources = requiredHashKeys.every((name) => /^[a-f0-9]{64}$/.test(result.sourceHashes?.started?.[name] || '')
    && result.sourceHashes.started[name] === result.sourceHashes?.ended?.[name]);
  const criteria = {
    harnessFinishedWithoutError: !result.harnessFailure,
    noHarnessInterruption: !result.interruptionRequested,
    authoritativeInventoriesConfirmed: result.constructionInventory?.confirmed === true && result.finalInventory?.confirmed === true,
    controlledSurvivalTask: result.mode === 'controlled-real-furnished-house' && result.initialGameMode === 'survival',
    savedNormalSurvivalWorld: metadata.gameType === 0 && metadata.difficulty === 2 && !metadata.hardcore,
    completedPublicTask: result.task?.status === 'completed' && result.task?.intent === 'build_furnished_house',
    exactConstructionStatesBeforeUse: result.constructionMismatches?.length === 0,
    savedManifestAndPersistentStates: mismatches.length === 0,
    completeFloorAndClosedRoof: geometry.floorHoles.length === 0 && geometry.roofHoles.length === 0 && geometry.wallHoles.length === 0,
    twoPartBed: geometry.bed.confirmed, twoPartDoor: geometry.door.confirmed,
    usableChest: geometry.chest.confirmed, furnaceFacing: geometry.furnace.confirmed, actualCraftingTable: geometry.craftingTable.confirmed,
    glassWindows: geometry.windows.length >= 8 && geometry.windows.every((cell) => matches(cell.actual, 'glass')),
    standingLights: geometry.lights.length === 4 && geometry.lights.every((cell) => matches(cell.actual, 'torch')),
    clearInteriorWalkway: geometry.route.every((cell) => cell.clear),
    allDeclaredClearanceAir: clearanceViolations.length === 0,
    temporaryScaffoldRemoved: scaffoldRemaining.length === 0,
    actualDoorTraversalAndClosure: use.door?.confirmed === true && use.doorClosure?.confirmed === true,
    actualCraft: use.crafting?.confirmed === true,
    actualChestDepositAndWithdrawal: use.chest?.confirmed === true,
    chestRetainsServerSavedMarker: use.chest?.confirmed === true && (chestEntity?.Items || [])
      .some((item) => item.id === 'minecraft:gold_ingot' && item.count === 1),
    actualFurnaceSmelt: use.furnace?.confirmed === true,
    actualBedSleepAndWake: use.bed?.confirmed === true,
    effectiveBookshelves: !geometry.enchanting || (matches(geometry.enchanting.table, 'enchanting_table') && geometry.enchanting.effectiveCount === 15),
    actualLevel30Enchant: !geometry.enchanting || use.enchanting?.confirmed === true,
    zeroConsoleInterventionsDuringConstruction: taskConsole.length === 0,
    noDeaths: result.deaths === 0,
    sourceHashesUnchanged: validFrozenSources && json(result.sourceHashes?.started) === json(result.sourceHashes?.ended),
    normallyStopped: lifecycle.serverExitCode === 0 && !lifecycle.serverExitSignal,
  };
  const actualCells = [...cells.values()];
  const report = { auditedAt: new Date().toISOString(), runDir, criteria,
    acceptancePassed: Object.values(criteria).every(Boolean), unmetCriteria: Object.entries(criteria).filter(([, ok]) => !ok).map(([name]) => name),
    fixtureLimits: result.fixtureLimits, blueprintAnchor: blueprint.anchor, profile: blueprint.profile, geometry, mismatches,
    scaffoldRemaining, clearanceViolations,
    chestBlockEntity: chestEntity || null, furnitureUse: use, lifecycle, worldMetadata: metadata,
    regionHashes: Object.fromEntries(regions), actualBlockCount: actualCells.filter((cell) => !air(cell)).length,
    limitations: ['All finished construction materials were deliberately granted before submission; no from-zero wool, obsidian or enchanting material acquisition is claimed.',
      'Post-construction grants/time/XP are separate recorded furniture-use fixtures.',
      'Visualizations use actual saved blocks; colors and simple cuboid meshes illustrate their states and are not in-game screenshots.'] };
  fs.writeFileSync(path.join(runDir, 'actual-house-blocks.json'), json({ source: 'Normally stopped vanilla Anvil world', anchor: blueprint.anchor, cells: actualCells }) + '\n', { flag: 'wx' });
  fs.writeFileSync(path.join(runDir, 'house-saved-isometric.svg'), renderSavedBlocks(actualCells, blueprint), { flag: 'wx' });
  fs.writeFileSync(path.join(runDir, 'house-saved-front.svg'), renderSavedBlocks(actualCells, blueprint, { front: true }), { flag: 'wx' });
  fs.writeFileSync(path.join(runDir, 'house-saved-cutaway.svg'), renderSavedBlocks(actualCells, blueprint, { cutaway: true, front: true }), { flag: 'wx' });
  fs.writeFileSync(path.join(runDir, 'house-independent-audit.json'), json(report) + '\n', { flag: 'wx' });
  for (const [file, before] of regions) assert.equal(hash(file), before, 'Read-only audit must not change a region file');
  assert.equal(hash(metadata.levelFile), metadata.sha256, 'Read-only audit must not change level.dat');
  return report;
}
if (require.main === module) auditHouse(path.resolve(process.argv[2] || '.')).then((report) => {
  console.log(json({ acceptancePassed: report.acceptancePassed, unmetCriteria: report.unmetCriteria }));
  if (!report.acceptancePassed) process.exitCode = 1;
}).catch((error) => { console.error(error.stack); process.exitCode = 1; });
module.exports = { matches, effectiveBookshelves, geometryEvidence, compareManifest, renderSavedBlocks, auditHouse };
