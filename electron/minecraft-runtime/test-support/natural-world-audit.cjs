/* global process, console, __filename */
'use strict';

// Independent, read-only audit of a normally stopped vanilla acceptance world.
// Region files and level.dat are never opened for writing. The original
// harness result is retained; this tool writes a separate audit document.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const nbt = require('prismarine-nbt');

function json(value, indent) {
  return JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, indent);
}
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function longToBigInt(value) {
  if (typeof value === 'bigint') return BigInt.asIntN(64, value);
  if (Array.isArray(value) && value.length === 2 && value.every(Number.isInteger)) {
    return BigInt.asIntN(64, (BigInt(value[0] >>> 0) << 32n) | BigInt(value[1] >>> 0));
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError('Unsupported or imprecise NBT long representation');
}
function positiveModulo(number, divisor) { return ((number % divisor) + divisor) % divisor; }
function blockLocation(position) {
  for (const axis of ['x', 'y', 'z']) assert.ok(Number.isSafeInteger(position[axis]), `Block ${axis} must be an exact integer`);
  assert.ok(position.y >= -64 && position.y <= 319, 'Audit supports the vanilla 1.18+ overworld height -64..319');
  const chunkX = Math.floor(position.x / 16);
  const chunkZ = Math.floor(position.z / 16);
  return { chunkX, chunkZ, regionX: Math.floor(chunkX / 32), regionZ: Math.floor(chunkZ / 32),
    regionIndex: positiveModulo(chunkX, 32) + positiveModulo(chunkZ, 32) * 32,
    sectionY: Math.floor(position.y / 16), localX: positiveModulo(position.x, 16),
    localY: positiveModulo(position.y, 16), localZ: positiveModulo(position.z, 16) };
}
function decodeSectionBlock(section, position) {
  const location = blockLocation(position);
  assert.equal(section.Y, location.sectionY, 'Section Y does not contain the requested block');
  const states = section.block_states;
  // Vanilla's absent block-state container defaults to air. This is separate
  // from a missing chunk/region, for which readRegionChunk throws UNKNOWN.
  if (!states) return { name: 'minecraft:air', properties: {}, paletteIndex: 0, bitsPerEntry: 0, defaultAir: true };
  const palette = states.palette;
  assert.ok(Array.isArray(palette) && palette.length > 0 && palette.length <= 4096, 'Missing or invalid modern block-state palette');
  if (palette.length === 1) return { name: palette[0].Name, properties: palette[0].Properties || {}, paletteIndex: 0, bitsPerEntry: 0 };
  const bitsPerEntry = Math.max(4, Math.ceil(Math.log2(palette.length)));
  const entriesPerLong = Math.floor(64 / bitsPerEntry);
  const index = location.localX + location.localZ * 16 + location.localY * 256;
  // Minecraft 1.16+ disk block states pad each word rather than splitting a
  // value across two words, especially visible with 5/6/7 bits per entry.
  const wordIndex = Math.floor(index / entriesPerLong);
  assert.ok(Array.isArray(states.data) && states.data.length === Math.ceil(4096 / entriesPerLong), 'Invalid modern padded block-state data length');
  const word = BigInt.asUintN(64, longToBigInt(states.data[wordIndex]));
  const shift = BigInt((index % entriesPerLong) * bitsPerEntry);
  const paletteIndex = Number((word >> shift) & ((1n << BigInt(bitsPerEntry)) - 1n));
  assert.ok(paletteIndex < palette.length, 'Packed block-state palette index is out of bounds');
  const entry = palette[paletteIndex];
  assert.equal(typeof entry.Name, 'string', 'Palette entry has no block name');
  return { name: entry.Name, properties: entry.Properties || {}, paletteIndex, bitsPerEntry, wordIndex };
}
async function readRegionChunk(worldDirectory, position) {
  const location = blockLocation(position);
  const regionFile = path.join(worldDirectory, 'region', `r.${location.regionX}.${location.regionZ}.mca`);
  const region = fs.readFileSync(regionFile);
  assert.ok(region.length >= 8192, 'Anvil region header is incomplete');
  const address = region.readUInt32BE(location.regionIndex * 4);
  const sectorOffset = address >>> 8;
  const sectorCount = address & 0xff;
  assert.ok(sectorOffset >= 2 && sectorCount > 0, `Chunk is not present in the saved region: ${location.chunkX},${location.chunkZ}`);
  const offset = sectorOffset * 4096;
  assert.ok(offset + 5 <= region.length, 'Chunk header is outside the region file');
  const storedLength = region.readUInt32BE(offset);
  const compressionByte = region[offset + 4];
  const external = Boolean(compressionByte & 0x80);
  const compression = compressionByte & 0x7f;
  assert.ok(storedLength >= 1 && offset + 4 + storedLength <= region.length, 'Invalid Anvil chunk payload length');
  assert.ok(storedLength + 4 <= sectorCount * 4096, 'Anvil chunk payload exceeds allocated sectors');
  const externalFile = external ? path.join(path.dirname(regionFile), `c.${location.chunkX}.${location.chunkZ}.mcc`) : null;
  const compressed = external ? fs.readFileSync(externalFile) : region.subarray(offset + 5, offset + 4 + storedLength);
  const payload = compression === 1 ? zlib.gunzipSync(compressed)
    : compression === 2 ? zlib.inflateSync(compressed) : compression === 3 ? compressed : null;
  assert.ok(payload, `Unsupported Anvil compression ${compression}; cannot infer the block`);
  const parsed = nbt.simplify((await nbt.parse(payload)).parsed);
  assert.ok(parsed.DataVersion >= 2860, 'Audit requires the modern 1.18+ section format');
  assert.equal(parsed.xPos, location.chunkX, 'Saved chunk X does not match its region address');
  assert.equal(parsed.zPos, location.chunkZ, 'Saved chunk Z does not match its region address');
  assert.ok(['minecraft:full', 'full'].includes(parsed.Status), `Saved chunk is not fully generated: ${parsed.Status}`);
  assert.ok(Array.isArray(parsed.sections), 'Modern chunk sections are absent');
  return { chunk: parsed, location, regionFile, externalFile,
    regionTimestamp: region.readUInt32BE(4096 + location.regionIndex * 4),
    compression, dataVersion: parsed.DataVersion, lastUpdate: longToBigInt(parsed.LastUpdate).toString() };
}
async function readAnvilBlock(worldDirectory, position) {
  const saved = await readRegionChunk(worldDirectory, position);
  const section = saved.chunk.sections.find((entry) => entry.Y === saved.location.sectionY);
  const block = section ? decodeSectionBlock(section, position) : {
    name: 'minecraft:air', properties: {}, paletteIndex: 0, bitsPerEntry: 0, absentAirSection: true };
  return { position: { ...position }, ...block, regionFile: saved.regionFile,
    regionTimestamp: saved.regionTimestamp, chunk: { x: saved.location.chunkX, z: saved.location.chunkZ },
    sectionY: saved.location.sectionY, compression: saved.compression, dataVersion: saved.dataVersion,
    lastUpdate: saved.lastUpdate };
}
async function readLevelMetadata(worldDirectory) {
  const levelFile = path.join(worldDirectory, 'level.dat');
  const data = nbt.simplify((await nbt.parse(fs.readFileSync(levelFile))).parsed).Data;
  assert.ok(data && data.WorldGenSettings, 'Modern saved world metadata is absent');
  return { levelFile, sha256: sha256(levelFile), dataVersion: data.DataVersion,
    seed: longToBigInt(data.WorldGenSettings.seed).toString(), gameType: data.GameType, difficulty: data.Difficulty,
    hardcore: data.hardcore, spawn: { x: data.SpawnX, y: data.SpawnY, z: data.SpawnZ },
    generator: data.WorldGenSettings.dimensions?.['minecraft:overworld']?.generator?.type,
    gameRules: data.GameRules, lastPlayed: longToBigInt(data.LastPlayed).toString(),
    gameTime: longToBigInt(data.Time).toString(), dayTime: longToBigInt(data.DayTime).toString() };
}
function exactPosition(a, b) { return a && b && ['x', 'y', 'z'].every((axis) => a[axis] === b[axis]); }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
function automaticDescentEvidence(result, events, submitted, outcome) {
  const duringTask = (event) => event.elapsedMs >= submitted.elapsedMs && event.elapsedMs <= outcome.elapsedMs;
  const snapshots = events.filter((event) => event.type === 'snapshot' && duringTask(event));
  const initialBase = snapshots.find((event) => event.checkpoint?.base)?.checkpoint.base || null;
  const baseMatches = exactPosition(initialBase, result.base);
  const route = result.task?.diamondExpedition?.navigation?.breadcrumbs || result.task?.diamondExpedition?.navigation?.route || [];
  const routeStartsAtBase = route.length > 0 && exactPosition(route[0], initialBase);
  const connectedRoute = routeStartsAtBase && route.every((point, index) => ['x', 'y', 'z'].every((axis) => Number.isInteger(point[axis]))
    && (!index || Math.abs(point.x - route[index - 1].x) + Math.abs(point.z - route[index - 1].z) === 1
      && Math.abs(point.y - route[index - 1].y) <= 1));
  const below = (position, depth) => initialBase && Number.isFinite(position?.y) && position.y <= initialBase.y - depth + 1e-6;
  const deepSnapshots = snapshots.filter((event) => below(event.position, 8));
  const deepRoute = route.filter((point) => below(point, 8));
  const deepDigs = events.filter((event) => event.type === 'digging_completed' && duringTask(event)
    && below(event.playerPosition, 7) && below(event.position, 6));
  return { initialBase, reportedBase: result.base, baseMatches, routeStartsAtBase, connectedRoute, routeLength: route.length,
    minimumObservedY: snapshots.reduce((minimum, event) => Number.isFinite(event.position?.y) ? Math.min(minimum, event.position.y) : minimum, Infinity),
    deepSnapshotCount: deepSnapshots.length, firstDeepSnapshot: deepSnapshots[0] || null,
    deepRouteCount: deepRoute.length, firstDeepRoutePosition: deepRoute[0] || null,
    deepCompletedDigCount: deepDigs.length, firstDeepCompletedDig: deepDigs[0] || null,
    confirmed: Boolean(baseMatches && connectedRoute && deepSnapshots.length && deepRoute.length && deepDigs.length) };
}
function frozenSourceEvidence(result, started) {
  const requiredKeys = ['protocolCompatibility.js', 'runtime.js', 'vendor/server/minecraftTaskAgent.js',
    'vendor/server/minecraft/miningNavigation.js', 'vendor/server/minecraft/diamondExpedition.js',
    'test-support/real-natural-diamond-server.cjs'];
  const before = result.sourceHashes?.started || {};
  const after = result.sourceHashes?.ended || {};
  const keys = Object.keys(before);
  const missingRequiredKeys = requiredKeys.filter((key) => !/^[a-f0-9]{64}$/.test(before[key] || '') || !/^[a-f0-9]{64}$/.test(after[key] || ''));
  const changedKeys = keys.filter((key) => before[key] !== after[key]);
  const matchesRunStarted = json(before) === json(started.sourceHashes);
  return { requiredKeys, missingRequiredKeys, changedKeys, observedFileCount: keys.length, matchesRunStarted,
    confirmed: keys.length >= requiredKeys.length && missingRequiredKeys.length === 0 && changedKeys.length === 0
      && Object.keys(after).length === keys.length && matchesRunStarted };
}
function requestedTargetEvidence(result, submitted) {
  const requested = result.requestedDiamondCount ?? 1;
  const validRequest = Number.isSafeInteger(requested) && requested >= 1 && requested <= 64;
  const plannedStep = result.task?.plan?.steps?.find((step) => step.skill === 'mine_resource' && step.args?.block === 'diamond');
  const planned = Number.isFinite(plannedStep?.args?.count) ? plannedStep.args.count : null;
  const executed = Number.isFinite(result.task?.diamondExpedition?.targetCount) ? result.task.diamondExpedition.targetCount : null;
  const expectedCommand = requested === 1 ? '从零开始挖到钻石' : `从零开始挖到 ${requested} 个钻石`;
  const matchesPublicSubmission = submitted.command === expectedCommand && (submitted.requestedDiamondCount ?? 1) === requested;
  const confirmed = validRequest && planned === requested && executed === requested && matchesPublicSubmission;
  return { requested, planned, executed, validRequest, expectedCommand, matchesPublicSubmission,
    verification: confirmed ? 'CONFIRMED' : planned === null || executed === null ? 'UNKNOWN' : 'MISMATCH', confirmed };
}
function classifyLavaChanges(events) {
  const snapshots = events.filter((event) => event.type === 'snapshot' && event.position);
  const digs = events.filter((event) => event.type === 'digging_completed' && event.position);
  const placements = events.filter((event) => event.type === 'block_placed' && event.position);
  return events.filter((event) => event.type === 'block_update' && event.from === 'lava' && event.to !== 'lava').map((change) => {
    const snapshot = snapshots.reduce((nearest, candidate) => !nearest
      || Math.abs(candidate.elapsedMs - change.elapsedMs) < Math.abs(nearest.elapsedMs - change.elapsedMs) ? candidate : nearest, null);
    const matchingDigs = digs.filter((dig) => exactPosition(dig.position, change.position)
      && Math.abs(dig.elapsedMs - change.elapsedMs) <= 5000);
    const adjacentDigs = digs.filter((dig) => Math.abs(dig.elapsedMs - change.elapsedMs) <= 5000
      && distance(dig.position, change.position) <= 2);
    const matchingPlacements = placements.filter((placement) => exactPosition(placement.position, change.position)
      && Math.abs(placement.elapsedMs - change.elapsedMs) <= 5000);
    const playerDistance = snapshot ? distance(snapshot.position, change.position) : null;
    const snapshotOffsetMs = snapshot ? snapshot.elapsedMs - change.elapsedMs : null;
    // A remote lava-to-obsidian/gravel tick while the player is on the surface
    // cannot be labelled an excavation. Nearby uncorrelated changes remain
    // unconfirmed; proximity alone does not prove that the agent caused them.
    const classification = matchingDigs.length || matchingPlacements.length ? 'completed_agent_action_correlated'
      : adjacentDigs.length ? 'nearby_excavation_correlated_environment_change'
        : snapshot && Math.abs(snapshotOffsetMs) <= 5000 && playerDistance > 16
          ? 'remote_environment_change_no_agent_dig_correlation' : 'unassociated_environment_change';
    return { change, classification, matchingDigs, matchingPlacements, adjacentDigs, playerDistance, snapshotOffsetMs,
      playerPosition: snapshot?.position || null };
  });
}
function observedFood(events) {
  const completions = events.filter((event) => event.type === 'food_consumption_status' && event.foodItem);
  return completions.map((completion) => {
    const close = (event) => Math.abs(event.elapsedMs - completion.elapsedMs) <= 3500;
    const update = events.find((event) => event.type === 'health_packet' && close(event)
      && Number.isFinite(event.previousFood) && event.food > event.previousFood);
    const decrement = events.find((event) => event.type === 'food_inventory_decrease' && close(event)
      && event.name === completion.foodItem && event.after < event.before);
    return { completion, authoritativeIncrease: update || null, inventoryDecrease: decrement || null,
      confirmed: Boolean(update && decrement) };
  });
}
function independentLavaDetour(hazard, events) {
  const start = hazard.navigation;
  if (!start?.currentRoutePosition || !Number.isInteger(start.routeIndex) || !hazard.playerPosition) return null;
  const points = new Map();
  const observations = [{ elapsedMs: hazard.elapsedMs, navigation: start }, ...events.filter((event) => event.type === 'snapshot'
    && event.elapsedMs > hazard.elapsedMs && event.elapsedMs <= hazard.elapsedMs + 120_000).map((event) => ({ ...event, navigation: event.checkpoint?.navigation }))];
  for (const observation of observations) {
    if (['prepare_food', 'prepare_wood', 'resupply_food', 'smelt_iron', 'return_home', 'returning', 'return', 'blocked'].includes(observation.checkpoint?.phase)) return null;
    const route = observation.navigation;
    if (Number.isInteger(route?.routeIndex) && route.routeIndex < start.routeIndex) return null;
    const tail = route?.lastRoutePositions;
    if (Number.isInteger(route?.routeLength) && Array.isArray(tail)) {
      for (let index = 0; index < tail.length; index += 1) points.set(route.routeLength - tail.length + index, tail[index]);
    }
    if (observation.elapsedMs === hazard.elapsedMs || !(observation.checkpoint?.searchSteps > hazard.searchSteps)
      || !Number.isInteger(route?.routeIndex) || route.routeIndex <= start.routeIndex || route.routeIndex !== route.routeLength - 1) continue;
    const segment = [];
    let continuous = true;
    for (let index = start.routeIndex; index <= route.routeIndex; index += 1) {
      const point = points.get(index);
      const previous = segment[segment.length - 1];
      if (!point || !['x', 'y', 'z'].every((axis) => Number.isInteger(point[axis]))
        || previous && (Math.abs(point.x - previous.x) + Math.abs(point.z - previous.z) !== 1 || Math.abs(point.y - previous.y) > 1)) {
        continuous = false;
        break;
      }
      segment.push(point);
    }
    if (!continuous || !exactPosition(segment[0], start.currentRoutePosition)) continue;
    const last = segment[segment.length - 1];
    const actual = observation.position;
    if (!actual || !exactPosition({ x: Math.floor(actual.x), y: Math.floor(actual.y), z: Math.floor(actual.z) }, last)) continue;
    const displacement = distance(hazard.playerPosition, actual);
    if (displacement >= 0.75) return { at: observation.at, elapsedMs: observation.elapsedMs, position: actual,
      heading: observation.checkpoint.heading, searchSteps: observation.checkpoint.searchSteps, movedDistance: displacement,
      originIndex: start.routeIndex, finalRouteIndex: route.routeIndex, checkedRoute: segment };
  }
  return null;
}
function observedLava(events) {
  return events.filter((event) => event.type === 'hazard_observation' && event.playerPosition
    && event.nearbyLava?.some((point) => distance(point, { x: Math.floor(event.playerPosition.x),
      y: Math.floor(event.playerPosition.y), z: Math.floor(event.playerPosition.z) }) <= 6)).map((hazard) => {
    const reason = /lava|岩浆/i.test(hazard.reason || '') ? hazard.reason : events.find((event) =>
      event.type === 'agent_event' && Math.abs(event.elapsedMs - hazard.elapsedMs) <= 3000
      && /lava|岩浆/i.test([event.event?.task?.progressText, event.event?.message, event.event?.error].filter(Boolean).join(' ')))?.event;
    const detour = independentLavaDetour(hazard, events);
    return { hazard, explicitReason: reason || null, detour, confirmed: Boolean(reason && detour) };
  });
}
async function auditNaturalWorld(runDirectory) {
  const resultFile = path.join(runDirectory, 'result.json');
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const lifecycle = JSON.parse(fs.readFileSync(path.join(runDirectory, 'server-lifecycle.json'), 'utf8'));
  assert.ok(lifecycle.serverStopped && lifecycle.serverExitCode === 0 && !lifecycle.serverExitSignal,
    'Independent saved-world audit requires a normal completed server stop; no inference from a live or unconfirmed save');
  const eventsFile = path.join(runDirectory, 'events.jsonl');
  const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const started = events.find((event) => event.type === 'run_started');
  const committed = events.find((event) => event.type === 'seed_committed_before_world_generation');
  const submitted = events.find((event) => event.type === 'task_submitted');
  const outcome = events.find((event) => event.type === 'task_outcome_frozen_before_readback');
  const initial = events.find((event) => event.type === 'natural_spawn_empty_inventory');
  assert.ok(started && committed && submitted && outcome && initial, 'Required natural-run timeline evidence is missing');
  const worldDirectory = path.join(runDirectory, 'world');
  const level = await readLevelMetadata(worldDirectory);
  const consoleEvents = events.filter((event) => event.type === 'server_command');
  const readOnlyCommand = (text) => /^(?:seed|difficulty|stop)$/.test(text)
    || /^gamerule (?:doMobSpawning|doDaylightCycle|doWeatherCycle|keepInventory|naturalRegeneration)$/.test(text)
    || /^data get entity DeskPetNatural (?:Inventory|Pos|Health|foodLevel|foodSaturationLevel|foodExhaustionLevel)$/.test(text)
    || /^execute if block -?\d+ -?\d+ -?\d+ (?:air|lava) run say DESKPET_NATURAL_[A-Z0-9_-]+$/.test(text)
    || /^say DESKPET_NATURAL_[A-Z0-9_-]+$/.test(text);
  const unexpectedCommands = consoleEvents.filter((event) => !readOnlyCommand(event.command));
  const executionCommands = consoleEvents.filter((event) => event.elapsedMs >= submitted.elapsedMs && event.elapsedMs < outcome.elapsedMs);
  const oreEvidence = [];
  for (const ore of result.minedOre || []) {
    const removal = events.find((event) => event.type === 'block_update' && event.from === ore.name
      && event.to === 'air' && exactPosition(event.position, ore.position));
    const dig = events.find((event) => event.type === 'digging_completed' && exactPosition(event.position, ore.position)
      && removal && Math.abs(event.elapsedMs - removal.elapsedMs) <= 5000);
    let saved;
    let readError;
    try { saved = await readAnvilBlock(worldDirectory, ore.position); }
    catch (error) { readError = error.message; }
    oreEvidence.push({ originalOre: ore, originalRemoval: removal || null, completedRealDig: dig || null,
      savedBlock: saved || null, readError: readError || null,
      confirmedAir: Boolean(removal && dig && saved?.name === 'minecraft:air') });
  }
  const lava = observedLava(events);
  for (const episode of lava) {
    const position = episode.hazard.nearbyLava[0];
    try { episode.savedReference = await readAnvilBlock(worldDirectory, position); }
    catch (error) { episode.readError = error.message; }
    episode.referenceRemainsLava = episode.savedReference?.name === 'minecraft:lava';
  }
  const food = observedFood(events);
  const snapshots = events.filter((event) => event.type === 'snapshot');
  const finalInventory = (result.finalInventory || []).map(({ name, count, slot }) => ({ name, count, slot })).sort((a, b) => a.slot - b.slot);
  const serverInventory = result.serverInventory;
  const diamonds = finalInventory.filter((item) => item.name === 'diamond').reduce((sum, item) => sum + item.count, 0);
  const serverDiamonds = serverInventory?.filter((item) => item.name === 'diamond').reduce((sum, item) => sum + item.count, 0);
  const diamondOre = oreEvidence.filter((entry) => /diamond_ore/.test(entry.originalOre.name));
  const sources = frozenSourceEvidence(result, started);
  const descent = automaticDescentEvidence(result, events, submitted, outcome);
  const target = requestedTargetEvidence(result, submitted);
  const deathEvents = events.filter((event) => event.type === 'bot_death');
  const lavaChanges = classifyLavaChanges(events);
  const agentLavaExcavations = lavaChanges.filter((entry) => entry.matchingDigs.length > 0 || entry.matchingPlacements.length > 0);
  const shutdownLog = fs.readFileSync(path.join(runDirectory, 'server.log'), 'utf8');
  const criteria = {
    normalServerStop: lifecycle.serverStopped && lifecycle.serverExitCode === 0 && !lifecycle.serverExitSignal,
    allDimensionsSaveLogged: /All dimensions are saved/.test(shutdownLog),
    naturalGenerator: started.properties?.['level-type'] === 'minecraft:normal' && level.generator === 'minecraft:noise',
    seedCommittedBeforeGeneration: committed.elapsedMs <= started.elapsedMs && committed.campaign.seed === started.seed
      && level.seed === started.seed && result.campaign.seed === level.seed,
    savedNormalSurvival: level.gameType === 0 && level.difficulty === 2 && !level.hardcore,
    savedNaturalRules: ['doMobSpawning', 'doDaylightCycle', 'doWeatherCycle', 'naturalRegeneration'].every((name) => level.gameRules[name] === 'true')
      && level.gameRules.keepInventory === 'false',
    initialInventoryEmpty: initial.inventory.length === 0 && initial.serverInventory.length === 0,
    noConsoleMutations: unexpectedCommands.length === 0, noConsoleCommandsDuringTask: executionCommands.length === 0,
    sourceHashesUnchanged: sources.confirmed,
    publicTaskCompleted: result.status === 'completed' && outcome.status === 'completed' && result.task?.status === 'completed',
    requestedTargetMatchesPlan: target.confirmed,
    diamondsMatchServer: diamonds >= target.requested && serverDiamonds === diamonds,
    fullInventoryMatchesServer: json(finalInventory) === json(serverInventory),
    positionMatchesServer: Math.hypot(result.finalPosition.x - result.serverPosition.x, result.finalPosition.y - result.serverPosition.y,
      result.finalPosition.z - result.serverPosition.z) < 0.2,
    returnedToBase: Number.isFinite(result.baseDistance) && Number.isFinite(result.serverBaseDistance)
      && result.baseDistance <= 2 && result.serverBaseDistance <= 2,
    actualAutomaticDescent: descent.confirmed,
    observedToolchain: ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'raw_iron', 'iron_ingot'].every((name) => result.inventoryItemsObserved?.includes(name)),
    realDiamondDigsAndSavedAir: diamondOre.length > 0 && diamondOre.every((entry) => entry.confirmedAir),
    actualFoodReplenishment: food.some((entry) => entry.confirmed),
    actualLavaDetectionDetourAndSavedLava: lava.some((entry) => entry.confirmed && entry.referenceRemainsLava),
    noDeath: deathEvents.length === 0 && result.deaths === 0,
    noSampledLavaContact: result.lavaFootContact === false, noObservedAgentLavaExcavation: agentLavaExcavations.length === 0,
  };
  return { auditedAt: new Date().toISOString(), runDirectory, originalResultFile: resultFile,
    originalHarnessAcceptance: result.acceptancePassed, originalUnmetCriteria: result.unmetCriteria,
    auditMode: 'Independent read-only post-stop saved MCA/NBT and observed protocol/event audit',
    auditedInputs: { resultSha256: sha256(resultFile), eventsSha256: sha256(eventsFile), scriptSha256: sha256(__filename) },
    levelMetadata: level, lifecycle, initialObservation: initial, seedCommit: committed,
    frozenTaskOutcome: outcome, consoleCommandsDuringTask: executionCommands, unexpectedCommands,
    sourceHashes: result.sourceHashes, sourceEvidence: sources, descentEvidence: descent, targetEvidence: target,
    oreEvidence, foodEvidence: food, lavaEvidence: lava,
    serverEvidence: { inventory: serverInventory, diamonds: serverDiamonds, position: result.serverPosition,
      clientInventory: finalInventory, clientDiamonds: diamonds, clientPosition: result.finalPosition,
      baseDistance: result.baseDistance, serverBaseDistance: result.serverBaseDistance },
    observedSurvival: { deaths: deathEvents, lavaChanges, agentLavaExcavations, minimumSampledHealth: Math.min(...snapshots.map((event) => event.health).filter(Number.isFinite)),
      minimumSampledFood: Math.min(...snapshots.map((event) => event.food).filter(Number.isFinite)), sampledLavaFootContact: result.lavaFootContact },
    criteria, independentAuditPassed: Object.values(criteria).every(Boolean),
    unmetCriteria: Object.entries(criteria).filter(([, passed]) => !passed).map(([name]) => name),
    limitations: ['This verifies one unchanged random seed, not all worlds or servers.',
      'No world bytes were written. Saved block reads require a normal stop and complete generated chunks; missing/unsupported data remains UNKNOWN.',
      'Foot contact is sampled every 500 ms. Lava references are sampled cells, not an entire aquifer.',
      'Natural fluid solidification and falling blocks may replace lava. Only a same-cell completed real dig or observed block placement is classified as agent lava excavation; adjacent or unassociated changes are reported without a causal claim.',
      'A detour requires new search steps and at least 0.75 m real movement along a continuous checked breadcrumb segment within 120 seconds; resupply or retreat interrupts the association. Heading alone does not pass.',
      'Inventory and position use original independent server console readback; original result.json is never replaced.'] };
}

module.exports = { longToBigInt, blockLocation, decodeSectionBlock, readRegionChunk, readAnvilBlock, readLevelMetadata,
  classifyLavaChanges, automaticDescentEvidence, frozenSourceEvidence, requestedTargetEvidence,
  independentLavaDetour, observedLava, auditNaturalWorld };
if (require.main === module) {
  const runDirectory = path.resolve(process.argv[2] || '');
  assert.ok(process.argv[2], 'Usage: node natural-world-audit.cjs RUN_DIRECTORY');
  auditNaturalWorld(runDirectory).then((audit) => {
    const destination = path.join(runDirectory, 'independent-audit.json');
    assert.ok(!fs.existsSync(destination), 'Refusing to replace an existing independent audit');
    fs.writeFileSync(destination, json(audit, 2) + '\n', { flag: 'wx' });
    console.log(json({ independentAuditPassed: audit.independentAuditPassed, unmetCriteria: audit.unmetCriteria, destination }));
    if (!audit.independentAuditPassed) process.exitCode = 1;
  }).catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
}
