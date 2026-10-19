/* global process, console, __dirname, __filename, setTimeout, clearTimeout, setInterval, clearInterval */
'use strict';

// Opt-in acceptance against an unmodified, randomly generated vanilla world.
// This file observes the real client and server; it does not replace bot APIs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { once } = require('node:events');
const mineflayer = require('mineflayer');
const { createMinecraftTaskAgent } = require('../vendor/server/minecraftTaskAgent');
const { acknowledgePlayerLoaded } = require('../runtime');
const { withMinecraftProtocolCompatibility } = require('../protocolCompatibility');

function parseRequestedDiamondCount(value = '1') {
  const count = Number(value);
  assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= 64, 'diamond-count must be an integer from 1 to 64');
  return count;
}
function targetCountEvidence(task, requested) {
  const step = task?.plan?.steps?.find((entry) => entry.skill === 'mine_resource' && entry.args?.block === 'diamond');
  const planned = Number.isFinite(step?.args?.count) ? step.args.count : null;
  const executed = Number.isFinite(task?.diamondExpedition?.targetCount) ? task.diamondExpedition.targetCount : null;
  const mismatch = planned !== null && planned !== requested || executed !== null && executed !== requested;
  return { requested, planned, executed, verification: mismatch ? 'MISMATCH'
    : planned !== null && executed !== null ? 'CONFIRMED' : 'UNKNOWN' };
}
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node minecraft-runtime/test-support/real-natural-diamond-server.cjs --accept-eula --run-name natural-diamond-01 [--diamond-count 1..64] [--timeout-ms 14400000] [--installation DIRECTORY]');
  console.log('One crypto-random seed is saved before generation in natural-diamond-campaign.json and reused for all repair worlds. No terrain, inventory, time, weather, teleport or gamerule mutations are permitted.');
  process.exit(0);
}
const argument = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `Missing value for ${name}`);
  return args[index + 1];
};
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--accept-eula') continue;
  assert.ok(['--installation', '--run-name', '--timeout-ms', '--diamond-count'].includes(args[index]), `Unsupported argument: ${args[index]}`);
  index += 1;
}
const workspace = path.resolve(__dirname, '../../..');
const installation = path.resolve(argument('--installation', path.join(workspace, '.minecraft-local-test')));
const installed = JSON.parse(fs.readFileSync(path.join(installation, 'installation.json'), 'utf8'));
const java = installed.java;
const jar = installed.minecraft?.jar;
const version = installed.minecraft?.version;
const runName = argument('--run-name', `natural-diamond-${new Date().toISOString().replace(/[:.]/g, '-')}`);
assert.match(runName, /^[a-zA-Z0-9_-]+$/, 'Run name must be a simple directory name');
const runDir = path.join(installation, 'worlds', runName);
const campaignFile = path.join(installation, 'natural-diamond-campaign.json');
const maximumMs = Number(argument('--timeout-ms', 14_400_000));
assert.ok(Number.isSafeInteger(maximumMs) && maximumMs >= 60_000, 'timeout-ms must be an integer of at least 60000');
const username = 'DeskPetNatural';
const requestedDiamondCount = parseRequestedDiamondCount(argument('--diamond-count', '1'));
const userCommand = requestedDiamondCount === 1 ? '从零开始挖到钻石' : `从零开始挖到 ${requestedDiamondCount} 个钻石`;
const runtimeRoot = path.resolve(__dirname, '..');
const startedAt = Date.now();
const events = [];
const removals = [];
const completedDigs = new Set();
const phases = new Set();
const inventorySeen = new Set();
const hazardObservations = [];
const serverWaiters = new Set();
let server;
let serverExit;
let serverOutput = '';
let bot;
let agent;
let polling;
let rawTask;
let taskSubmittedAt = null;
let endedAt = null;
let campaign;
let startedSourceHashes;
let initialObservation;
let result;
let lastSignature = '';
let lastReportAt = 0;
let lastPerceptionAt = 0;
let lastAvoidedHazards = 0;
let minimumY = Infinity;
let minimumHealth = Infinity;
let minimumFood = Infinity;
let deaths = 0;
let lavaFootContact = false;
let previousFood = null;
let lastHeldFood = null;
let pollingFailure;
let targetObservation;

function evidenceJson(value, replacer = null, indentation) {
  assert.equal(replacer, null, 'Evidence uses the shared exact-value serializer');
  return JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, indentation);
}
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function runtimeHashes() {
  const entries = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', 'test', 'test-support'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.js') || entry.name === 'package.json') entries.push([path.relative(runtimeRoot, file), sha256(file)]);
    }
  }
  walk(runtimeRoot);
  entries.push(['test-support/real-natural-diamond-server.cjs', sha256(__filename)]);
  return Object.fromEntries(entries);
}
function record(type, data = {}) {
  const event = { at: new Date().toISOString(), elapsedMs: Date.now() - startedAt, type, ...data };
  const encoded = evidenceJson(event);
  // Vec3 positions and checkpoint objects are mutable. Retained observations
  // must describe the instant recorded, including the in-memory post-audit.
  const retained = JSON.parse(encoded);
  events.push(retained);
  fs.appendFileSync(path.join(runDir, 'events.jsonl'), encoded + '\n');
  return retained;
}
function key(position) { return `${position.x},${position.y},${position.z}`; }
function inventory() {
  // Include equipped armor/offhand when comparing the entire server player
  // Inventory NBT; items() only exposes main inventory and hotbar.
  return (bot?.inventory?.slots || []).flatMap((item, slot) => item && slot >= 5 ? [{ name: item.name, count: item.count,
    slot, durabilityUsed: item.durabilityUsed ?? null }] : []);
}
function foodCounts() {
  const counts = {};
  for (const item of inventory()) if (bot.registry.foodsByName[item.name]) counts[item.name] = (counts[item.name] || 0) + item.count;
  return counts;
}
function goalEvidence(goal) {
  if (!goal) return null;
  const projected = { type: goal.constructor?.name || 'UnknownGoal' };
  for (const name of ['x', 'y', 'z', 'range', 'rangeSq', 'reach', 'entityHeight']) {
    if (Number.isFinite(goal[name])) projected[name] = goal[name];
  }
  const target = goal.pos || goal.position || goal.entity?.position;
  if (target && ['x', 'y', 'z'].every((name) => Number.isFinite(target[name]))) {
    projected.position = { x: target.x, y: target.y, z: target.z };
  }
  if (Number.isInteger(goal.entity?.id)) projected.entityId = goal.entity.id;
  if (Number.isFinite(goal.options?.range)) projected.range = goal.options.range;
  if (Array.isArray(goal.goals)) projected.subgoalCount = goal.goals.length;
  return projected;
}
function startPolling() {
  let rejectFailure;
  pollingFailure = new Promise((_, reject) => { rejectFailure = reject; });
  // A callback may fail while main is waiting for a different asynchronous
  // operation. Preserve it until main observes the same rejected promise.
  pollingFailure.catch(() => {});
  polling = setInterval(() => {
    try { snapshot(); }
    catch (error) { clearInterval(polling); rejectFailure(error); }
  }, 500);
}
function checkServerWaiters() {
  for (const waiter of serverWaiters) {
    const match = serverOutput.slice(waiter.from).match(waiter.pattern);
    if (!match) continue;
    clearTimeout(waiter.timer);
    serverWaiters.delete(waiter);
    waiter.resolve(match[0]);
  }
}
function serverReadback(pattern, timeout = 30_000, from = serverOutput.length) {
  return new Promise((resolve, reject) => {
    const waiter = { pattern, from, resolve, reject };
    waiter.timer = setTimeout(() => { serverWaiters.delete(waiter); reject(new Error(`Server readback timed out: ${pattern}`)); }, timeout);
    serverWaiters.add(waiter);
    checkServerWaiters();
  });
}
// This allowlist applies before AND after submission. In particular there is
// no setup-command exception that could grant resources or alter the world.
function command(text) {
  const allowed = text === 'seed' || text === 'difficulty' || text === 'stop'
    || /^gamerule (?:doMobSpawning|doDaylightCycle|doWeatherCycle|keepInventory|naturalRegeneration)$/.test(text)
    || new RegExp(`^data get entity ${username} (?:Inventory|Pos|Health|foodLevel|foodSaturationLevel|foodExhaustionLevel)$`).test(text)
    || /^execute if block -?\d+ -?\d+ -?\d+ (?:air|lava) run say DESKPET_NATURAL_[A-Z0-9_-]+$/.test(text)
    || /^say DESKPET_NATURAL_[A-Z0-9_-]+$/.test(text);
  assert.ok(allowed, `Refusing non-observational server command: ${text}`);
  assert.ok(server?.stdin.writable && server.exitCode === null, 'Server stdin unavailable');
  record('server_command', { command: text, beforeTask: !taskSubmittedAt });
  server.stdin.write(text + '\n');
}
async function readCommand(text, pattern) {
  const waiting = serverReadback(pattern);
  command(text);
  return waiting;
}
async function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function withDeadline(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]);
  } finally { clearTimeout(timer); }
}
function parseServerInventory(line) {
  const snbt = line.slice(line.indexOf('entity data: ') + 'entity data: '.length);
  const compounds = [];
  let depth = 0;
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < snbt.length; index += 1) {
    const char = snbt[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === '\\') { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (char === '{' && depth++ === 0) start = index;
    if (char === '}' && --depth === 0) compounds.push(snbt.slice(start, index + 1));
  }
  return compounds.map((compound) => {
    const name = compound.match(/\bid:\s*"minecraft:([^"]+)"/)?.[1];
    const count = Number(compound.match(/\bcount:\s*(\d+)/)?.[1]);
    const slot = Number(compound.match(/\bSlot:\s*(-?\d+)b/)?.[1]);
    assert.ok(name && Number.isInteger(count) && Number.isInteger(slot), `Cannot parse inventory compound: ${compound}`);
    // Hotbar0..8→window36..44; armor100..103→window8..5; offhand-106→45.
    return { name, count, slot: slot <= 8 && slot >= 0 ? slot + 36 : slot >= 100 && slot <= 103 ? 108 - slot : slot === -106 ? 45 : slot };
  }).sort((a, b) => a.slot - b.slot);
}
async function entityRead(field) {
  return readCommand(`data get entity ${username} ${field}`, new RegExp(`${username} has the following entity data: [^\\r\\n]+`));
}
function parsePosition(line) {
  const match = line.match(/entity data: \[(-?[\d.eE+-]+)d,\s*(-?[\d.eE+-]+)d,\s*(-?[\d.eE+-]+)d\]/);
  assert.ok(match, `Cannot parse server position: ${line}`);
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
}
function parseScalar(line) {
  const match = line.match(/entity data: (-?[\d.eE+-]+)[fd]?\s*$/);
  assert.ok(match, `Cannot parse server scalar: ${line}`);
  return Number(match[1]);
}
function perceive(force = false) {
  if (!bot?.entity || (!force && Date.now() - lastPerceptionAt < 30_000)) return;
  lastPerceptionAt = Date.now();
  const groups = {
    trees: Object.values(bot.registry.blocksByName).filter((block) => /(?:_log|_stem)$/.test(block.name)).map((block) => block.id),
    iron: ['iron_ore', 'deepslate_iron_ore'].map((name) => bot.registry.blocksByName[name]?.id).filter(Number.isInteger),
    foodBlocks: ['wheat', 'carrots', 'potatoes', 'sweet_berry_bush', 'melon', 'pumpkin', 'brown_mushroom', 'red_mushroom'].map((name) => bot.registry.blocksByName[name]?.id).filter(Number.isInteger),
    lava: [bot.registry.blocksByName.lava?.id].filter(Number.isInteger),
  };
  const resources = {};
  for (const [name, matching] of Object.entries(groups)) resources[name] = matching.length
    ? bot.findBlocks({ matching, maxDistance: 32, count: 12 }).map((position) => ({ name: bot.blockAt(position)?.name, position })) : [];
  const entities = Object.values(bot.entities).filter((entity) => entity.id !== bot.entity.id && entity.position.distanceTo(bot.entity.position) < 48)
    .map((entity) => ({ id: entity.id, name: entity.name, type: entity.type, position: entity.position, distance: entity.position.distanceTo(bot.entity.position) }));
  record('natural_perception', { position: bot.entity.position, biome: bot.blockAt(bot.entity.position)?.biome?.name,
    time: bot.time, resources, entities });
}
function snapshot(force = false) {
  if (!bot?.entity || !agent) return;
  const task = agent.__testGetReconnectTask();
  if (task) rawTask = task;
  const state = rawTask?.diamondExpedition;
  const target = targetCountEvidence(rawTask, requestedDiamondCount);
  assert.notEqual(target.verification, 'MISMATCH', `Public planner/executor diamond target differs from the requested count: ${evidenceJson(target)}`);
  if (!targetObservation && target.verification === 'CONFIRMED') targetObservation = record('requested_target_confirmed', target);
  if (state?.phase) phases.add(state.phase);
  const position = bot.entity.position;
  minimumY = Math.min(minimumY, position.y);
  if (Number.isFinite(bot.health)) minimumHealth = Math.min(minimumHealth, bot.health);
  if (Number.isFinite(bot.food)) minimumFood = Math.min(minimumFood, bot.food);
  if (/lava/.test(bot.blockAt(position.floored())?.name || '')) lavaFootContact = true;
  for (const item of inventory()) inventorySeen.add(item.name);
  const navigation = state?.navigation;
  const route = navigation?.breadcrumbs || navigation?.route;
  const navigationEvidence = navigation ? { routeIndex: navigation.routeIndex, routeLength: route?.length,
    currentRoutePosition: route?.[navigation.routeIndex], lastRoutePositions: route?.slice(-4) } : null;
  if (state?.avoidedHazards > lastAvoidedHazards) {
    const nearbyLava = bot.findBlocks({ matching: bot.registry.blocksByName.lava.id, maxDistance: 6, count: 12 })
      .filter((p) => bot.blockAt(p)?.name === 'lava');
    const evidence = record('hazard_observation', { before: lastAvoidedHazards, after: state.avoidedHazards,
      reason: rawTask.progressText, playerPosition: position, heading: state.heading, searchSteps: state.searchSteps,
      phase: state.phase, nearbyLava, navigation: navigationEvidence });
    hazardObservations.push(evidence);
    lastAvoidedHazards = state.avoidedHazards;
  }
  const checkpoint = state ? { ...state, navigation: navigation ? { ...navigation, route: undefined,
    breadcrumbs: undefined, routeLength: route?.length, currentRoutePosition: route?.[navigation.routeIndex],
    lastRoutePositions: route?.slice(-4) } : null } : null;
  const data = { position, onGround: bot.entity.onGround, velocity: bot.entity.velocity,
    heldItem: bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count, durabilityUsed: bot.heldItem.durabilityUsed ?? null } : null,
    pathfinder: { isMoving: bot.pathfinder?.isMoving?.(), goal: goalEvidence(bot.pathfinder?.goal) },
    health: bot.health, food: bot.food, saturation: bot.foodSaturation, inventory: inventory(),
    task: { status: rawTask?.status, error: rawTask?.error, progressText: rawTask?.progressText, currentStep: rawTask?.currentStep }, checkpoint };
  const signature = evidenceJson([position, data.health, data.food, data.saturation, data.inventory,
    data.task, state?.phase, state?.searchSteps, state?.avoidedHazards]);
  if (force || signature !== lastSignature) { record('snapshot', data); lastSignature = signature; }
  if (force || Date.now() - lastReportAt >= 15_000) {
    lastReportAt = Date.now();
    console.log(evidenceJson({ elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000), status: rawTask?.status,
      phase: state?.phase, position, health: bot.health, food: bot.food, saturation: bot.foodSaturation,
      diamonds: inventory().filter((item) => item.name === 'diamond').reduce((sum, item) => sum + item.count, 0),
      searchSteps: state?.searchSteps, avoidedHazards: state?.avoidedHazards, progress: rawTask?.progressText, error: rawTask?.error }));
  }
  perceive(force);
}
function foodEvidence() {
  const completions = events.filter((event) => event.type === 'food_consumption_status' && event.foodItem);
  const healthUpdates = events.filter((event) => event.type === 'health_packet' && Number.isFinite(event.previousFood)
    && event.food > event.previousFood);
  const decreases = events.filter((event) => event.type === 'food_inventory_decrease');
  return completions.map((completion) => {
    const nearby = (event) => Math.abs(event.elapsedMs - completion.elapsedMs) <= 3500;
    const increase = healthUpdates.find(nearby);
    const decrease = decreases.find((event) => nearby(event) && event.name === completion.foodItem);
    return { completion, authoritativeFoodIncrease: increase || null, inventoryDecrease: decrease || null,
      confirmed: Boolean(increase && decrease) };
  });
}
function checkedLavaDetour(episode, snapshots) {
  const origin = episode.navigation?.currentRoutePosition;
  const originIndex = episode.navigation?.routeIndex;
  if (!origin || !Number.isInteger(originIndex) || !episode.playerPosition) return null;
  const routeByIndex = new Map();
  function retain(navigation) {
    const tail = navigation?.lastRoutePositions;
    if (!Array.isArray(tail) || !Number.isInteger(navigation.routeLength)) return;
    tail.forEach((point, offset) => routeByIndex.set(navigation.routeLength - tail.length + offset, point));
  }
  retain(episode.navigation);
  for (const observation of snapshots) {
    if (observation.elapsedMs <= episode.elapsedMs) continue;
    if (observation.elapsedMs > episode.elapsedMs + 120_000) break;
    if (['resupply_food', 'prepare_food', 'prepare_wood', 'smelt_iron', 'return_home', 'return', 'returning', 'blocked'].includes(observation.checkpoint?.phase)) break;
    const navigation = observation.checkpoint?.navigation;
    if (Number.isInteger(navigation?.routeIndex) && navigation.routeIndex < originIndex) break;
    retain(navigation);
    if (!(observation.checkpoint?.searchSteps > episode.searchSteps) || !Number.isInteger(navigation?.routeIndex)
      || navigation.routeIndex <= originIndex || navigation.routeIndex !== navigation.routeLength - 1) continue;
    const checkedRoute = [];
    for (let index = originIndex; index <= navigation.routeIndex; index += 1) checkedRoute.push(routeByIndex.get(index));
    const continuous = checkedRoute.every((point, index) => point && ['x', 'y', 'z'].every((axis) => Number.isInteger(point[axis]))
      && (!index || Math.abs(point.x - checkedRoute[index - 1].x) + Math.abs(point.z - checkedRoute[index - 1].z) === 1
        && Math.abs(point.y - checkedRoute[index - 1].y) <= 1));
    if (!continuous || key(checkedRoute[0]) !== key(origin)) continue;
    const finalCell = checkedRoute[checkedRoute.length - 1];
    const actual = observation.position;
    if (!actual || Math.floor(actual.x) !== finalCell.x || Math.floor(actual.y) !== finalCell.y || Math.floor(actual.z) !== finalCell.z) continue;
    const movedDistance = Math.hypot(actual.x - episode.playerPosition.x, actual.y - episode.playerPosition.y, actual.z - episode.playerPosition.z);
    if (movedDistance < 0.75) continue;
    return { at: observation.at, elapsedMs: observation.elapsedMs, position: actual,
      heading: observation.checkpoint.heading, searchSteps: observation.checkpoint.searchSteps,
      health: observation.health, food: observation.food, movedDistance, originIndex, finalRouteIndex: navigation.routeIndex, checkedRoute };
  }
  return null;
}
function lavaEvidence() {
  const snapshots = events.filter((event) => event.type === 'snapshot');
  const reasons = events.filter((event) => event.type === 'agent_event'
    && /lava|岩浆/i.test([event.event?.task?.progressText, event.event?.message, event.event?.error].filter(Boolean).join(' ')));
  return hazardObservations.filter((event) => event.playerPosition && event.nearbyLava.some((cell) => Math.hypot(
    cell.x - Math.floor(event.playerPosition.x), cell.y - Math.floor(event.playerPosition.y), cell.z - Math.floor(event.playerPosition.z)) <= 6)).map((episode) => {
    const correlatedReason = /lava|岩浆/i.test(episode.reason || '') ? episode.reason
      : reasons.find((event) => Math.abs(event.elapsedMs - episode.elapsedMs) < 3000)?.event;
    const detour = checkedLavaDetour(episode, snapshots);
    return { ...episode, explicitLavaReason: correlatedReason || null,
      subsequentDetour: detour, confirmed: Boolean(correlatedReason && detour) };
  });
}
function lavaChangeEvidence() {
  const snapshots = events.filter((event) => event.type === 'snapshot' && event.position);
  const actions = events.filter((event) => ['digging_completed', 'block_placed'].includes(event.type) && event.position);
  return events.filter((event) => event.type === 'block_update' && event.from === 'lava' && event.to !== 'lava').map((change) => {
    const correlatedActions = actions.filter((action) => key(action.position) === key(change.position)
      && Math.abs(action.elapsedMs - change.elapsedMs) <= 5000);
    const nearest = snapshots.reduce((best, snapshot) => !best
      || Math.abs(snapshot.elapsedMs - change.elapsedMs) < Math.abs(best.elapsedMs - change.elapsedMs) ? snapshot : best, null);
    const playerDistance = nearest ? Math.hypot(nearest.position.x - change.position.x,
      nearest.position.y - change.position.y, nearest.position.z - change.position.z) : null;
    return { change, correlatedActions, agentActionCorrelated: correlatedActions.length > 0,
      nearestPlayerPosition: nearest?.position || null, playerDistance,
      snapshotOffsetMs: nearest ? nearest.elapsedMs - change.elapsedMs : null,
      classification: correlatedActions.length ? 'same_cell_completed_agent_action_correlated'
        : playerDistance > 16 ? 'remote_change_without_observed_agent_action' : 'unattributed_change_without_observed_agent_action' };
  });
}
async function finalReadback() {
  record('final_readback_started');
  const offset = serverOutput.length;
  const serverInventory = parseServerInventory(await entityRead('Inventory'));
  const serverPosition = parsePosition(await entityRead('Pos'));
  const serverHealth = parseScalar(await entityRead('Health'));
  const serverFood = parseScalar(await entityRead('foodLevel'));
  const mined = removals.filter((block) => completedDigs.has(key(block.position)));
  const ore = mined.filter((block) => /diamond_ore|iron_ore/.test(block.name));
  for (const [index, block] of ore.entries()) {
    const { x, y, z } = block.position;
    const marker = `DESKPET_NATURAL_ORE_${index}_${x}_${y}_${z}`;
    const sentinel = `DESKPET_NATURAL_CHECK_DONE_${index}`;
    const from = serverOutput.length;
    command(`execute if block ${x} ${y} ${z} air run say ${marker}`);
    await readCommand(`say ${sentinel}`, new RegExp(`\\[Server\\] ${sentinel}`));
    block.serverConfirmedAir = serverOutput.slice(from).includes(`[Server] ${marker}`);
  }
  const lava = lavaEvidence();
  for (const [index, episode] of lava.entries()) {
    const position = episode.nearbyLava[0];
    const { x, y, z } = position;
    const marker = `DESKPET_NATURAL_LAVA_${index}_${x}_${y}_${z}`;
    const sentinel = `DESKPET_NATURAL_LAVA_DONE_${index}`;
    const from = serverOutput.length;
    command(`execute if block ${x} ${y} ${z} lava run say ${marker}`);
    await readCommand(`say ${sentinel}`, new RegExp(`\\[Server\\] ${sentinel}`));
    episode.serverReference = { position, remainsLava: serverOutput.slice(from).includes(`[Server] ${marker}`) };
  }
  fs.writeFileSync(path.join(runDir, 'server-readback.log'), serverOutput.slice(offset));
  return { serverInventory, serverPosition, serverHealth, serverFood, mined, ore, lava };
}
async function main() {
  assert.ok(args.includes('--accept-eula'), 'Pass --accept-eula for this user-authorized local server');
  assert.ok(typeof java === 'string' && fs.existsSync(java), 'Installed Java is unavailable');
  assert.ok(typeof jar === 'string' && fs.existsSync(jar), 'Installed official server jar is unavailable');
  assert.ok(version, 'Installed Minecraft version is missing');
  assert.ok(!fs.existsSync(runDir), 'Refusing to overwrite an existing world; choose a fresh run name');
  fs.mkdirSync(runDir, { recursive: true });
  if (!fs.existsSync(campaignFile)) {
    const firstCampaign = { createdAt: new Date().toISOString(), version,
      seed: crypto.randomBytes(8).readBigInt64BE().toString(), firstRun: runName,
      generation: 'minecraft:normal', selection: 'First and only crypto-random 64-bit draw; generated before starting Java; no preview or seed filtering.',
      repairPolicy: 'Reuse this exact seed for every fresh repair world; never replace this manifest to seek favorable terrain.' };
    fs.writeFileSync(campaignFile, evidenceJson(firstCampaign, null, 2) + '\n', { flag: 'wx' });
  }
  campaign = JSON.parse(fs.readFileSync(campaignFile, 'utf8'));
  assert.equal(campaign.version, version, 'Repair runs must retain the campaign Minecraft version');
  assert.match(campaign.seed, /^-?\d+$/, 'Campaign must contain an exact signed integer seed');
  assert.ok(BigInt(campaign.seed) >= -(2n ** 63n) && BigInt(campaign.seed) < 2n ** 63n, 'Campaign seed is outside signed 64-bit range');
  record('seed_committed_before_world_generation', { campaignFile, campaign, campaignSha256: sha256(campaignFile) });
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const properties = {
    'server-ip': '127.0.0.1', 'server-port': port, 'online-mode': false, 'enforce-secure-profile': false,
    'enable-rcon': false, 'enable-query': false, 'level-name': 'world', 'level-type': 'minecraft:normal',
    'level-seed': campaign.seed, 'generate-structures': true, difficulty: 'normal', gamemode: 'survival',
    'force-gamemode': true, 'max-players': 1, 'view-distance': 10, 'simulation-distance': 8,
    'spawn-protection': 0, 'allow-flight': false, 'max-tick-time': 60000, 'sync-chunk-writes': true,
    'pause-when-empty-seconds': 0, motd: 'DeskPet isolated natural-world acceptance', 'initial-enabled-packs': 'vanilla',
  };
  fs.writeFileSync(path.join(runDir, 'server.properties'), Object.entries(properties).map(([name, value]) => `${name}=${value}`).join('\n') + '\n');
  fs.writeFileSync(path.join(runDir, 'eula.txt'), '# Accepted for the explicitly requested isolated local Minecraft server.\neula=true\n');
  startedSourceHashes = runtimeHashes();
  record('run_started', { mode: 'real-vanilla-random-natural-normal-survival', version, java, jar,
    jarSha256: sha256(jar), campaignFile, seed: campaign.seed, sourceHashes: startedSourceHashes,
    serverAddress: `127.0.0.1:${port}`, properties, worldDir: runDir, requestedDiamondCount, userCommand,
    interventionPolicy: 'No terrain/item/food/time/weather/teleport/effect/gamerule mutations; natural spawn, native physics and public production command only.' });
  server = spawn(java, ['-Xms1G', '-Xmx3G', '-jar', jar, 'nogui'], { cwd: runDir, stdio: ['pipe', 'pipe', 'pipe'] });
  serverExit = once(server, 'exit');
  const log = fs.createWriteStream(path.join(runDir, 'server.log'));
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => {
    log.write(chunk); serverOutput += chunk.toString(); checkServerWaiters();
  });
  server.on('error', (error) => record('server_error', { message: error.message }));
  server.on('exit', (code, signal) => record('server_exit', { code, signal }));
  await serverReadback(/Done \([^)]+\)! For help/, 240_000, 0);
  const seedLine = await readCommand('seed', /Seed: \[-?\d+\]/);
  assert.equal(seedLine.match(/\[(-?\d+)\]/)[1], campaign.seed, 'Server must confirm the precommitted random seed');
  const difficultyLine = await readCommand('difficulty', /The difficulty is \w+/i);
  const serverDifficulty = difficultyLine.match(/The difficulty is (\w+)/i)[1].toLowerCase();
  assert.equal(serverDifficulty, 'normal', 'Server must independently confirm normal difficulty');
  const gameRules = {};
  for (const rule of ['doMobSpawning', 'doDaylightCycle', 'doWeatherCycle', 'keepInventory', 'naturalRegeneration']) {
    const line = await readCommand(`gamerule ${rule}`, new RegExp(`Gamerule ${rule} is currently set to: (?:true|false)`));
    gameRules[rule] = line.endsWith('true');
  }
  assert.deepEqual(gameRules, { doMobSpawning: true, doDaylightCycle: true, doWeatherCycle: true, keepInventory: false, naturalRegeneration: true });
  record('server_natural_rules_confirmed', { seed: campaign.seed, difficulty: serverDifficulty, difficultyLine, gameRules });
  console.log(evidenceJson({ serverReady: true, runDir, port, seed: campaign.seed }));
  bot = mineflayer.createBot(withMinecraftProtocolCompatibility({
    host: '127.0.0.1', port, username, auth: 'offline', version, hideErrors: false,
  }));
  bot.on('error', (error) => record('bot_error', { message: error.message, stack: error.stack }));
  bot.on('kicked', (reason) => record('bot_kicked', { reason }));
  bot.on('death', () => { deaths += 1; record('bot_death', { position: bot.entity?.position }); });
  bot.on('diggingCompleted', (block) => {
    if (taskSubmittedAt) completedDigs.add(key(block.position));
    record('digging_completed', { position: block.position, resultingBlock: block.name, playerPosition: bot.entity?.position });
  });
  bot.on('blockPlaced', (oldBlock, newBlock) => {
    if (!taskSubmittedAt || !oldBlock || !newBlock) return;
    record('block_placed', { position: newBlock.position, from: oldBlock.name, to: newBlock.name,
      playerPosition: bot.entity?.position, heldItem: bot.heldItem?.name || null });
  });
  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (!taskSubmittedAt || !oldBlock || !newBlock || oldBlock.name === newBlock.name) return;
    record('block_update', { position: newBlock.position, from: oldBlock.name, to: newBlock.name });
    if (newBlock.name === 'air' && !['air', 'cave_air', 'void_air'].includes(oldBlock.name)) removals.push({
      at: new Date().toISOString(), position: newBlock.position.clone(), name: oldBlock.name,
      playerPosition: bot.entity?.position.clone() });
  });
  await withDeadline(once(bot, 'spawn'), 60_000, 'Natural player spawn timed out');
  previousFood = bot.food;
  let previousFoodCounts = foodCounts();
  bot.on('heldItemChanged', (item) => {
    if (bot.registry.foodsByName[item?.name]) lastHeldFood = { name: item.name, at: Date.now() };
  });
  bot.inventory.on('updateSlot', (slot, oldItem, newItem) => {
    if (newItem) inventorySeen.add(newItem.name);
    const counts = foodCounts();
    for (const [name, previous] of Object.entries(previousFoodCounts)) if ((counts[name] || 0) < previous) record('food_inventory_decrease', {
      name, before: previous, after: counts[name] || 0, health: bot.health, food: bot.food, position: bot.entity.position });
    previousFoodCounts = counts;
    if (taskSubmittedAt) record('inventory_delta', { slot, previous: oldItem ? { name: oldItem.name, count: oldItem.count } : null,
      next: newItem ? { name: newItem.name, count: newItem.count } : null });
  });
  bot._client.on('update_health', (packet) => {
    record('health_packet', { previousFood, food: packet.food, health: packet.health, saturation: packet.foodSaturation,
      heldItem: bot.heldItem?.name, position: bot.entity?.position });
    previousFood = packet.food;
  });
  bot._client.prependListener('entity_status', (packet) => {
    if (packet.entityId === bot.entity.id && packet.entityStatus === 9) record('food_consumption_status', {
      foodItem: bot.registry.foodsByName[bot.heldItem?.name] ? bot.heldItem.name
        : lastHeldFood && Date.now() - lastHeldFood.at <= 5000 ? lastHeldFood.name : null,
      heldItem: bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count } : null,
      health: bot.health, food: bot.food, saturation: bot.foodSaturation, position: bot.entity.position });
  });
  bot.on('entityHurt', (entity) => record('entity_hurt', { entityId: entity.id, name: entity.name,
    isSelf: entity.id === bot.entity.id, position: entity.position }));
  const acknowledged = await acknowledgePlayerLoaded(bot);
  await bot.waitForChunksToLoad();
  record('player_loaded_acknowledgement', { sent: acknowledged, version: bot.version,
    via: 'Production acknowledgePlayerLoaded helper; real chunks loaded' });
  assert.equal(bot.game.gameMode, 'survival', 'Natural player must start in survival');
  // Mineflayer 4.37.1 does not reliably retain the initial difficulty packet
  // by spawn. The server's read-only difficulty query above is authoritative.
  if (bot.game.difficulty !== undefined) assert.equal(bot.game.difficulty, serverDifficulty, 'Client difficulty differs from the server');
  assert.equal(bot.inventory.items().length, 0, 'Natural player must start with an empty inventory');
  const initialServerInventory = parseServerInventory(await entityRead('Inventory'));
  const initialServerPosition = parsePosition(await entityRead('Pos'));
  assert.equal(initialServerInventory.length, 0, 'Server must independently confirm empty initial inventory');
  initialObservation = record('natural_spawn_empty_inventory', { position: bot.entity.position.clone(),
    serverPosition: initialServerPosition, inventory: inventory(), serverInventory: initialServerInventory,
    health: bot.health, food: bot.food, saturation: bot.foodSaturation, gameMode: bot.game.gameMode,
    difficulty: serverDifficulty, clientDifficulty: bot.game.difficulty ?? null, naturalSpawn: true, teleportCommands: 0 });
  perceive(true);
  agent = createMinecraftTaskAgent({ appPaths: { appDataDir: path.join(runDir, 'deskpet-data') },
    readConfig: () => ({ mcExecutorMode: 'strict-executor', mcAgentAutoReconnect: false }),
    parseJsonObjectFromText: JSON.parse, broadcast: (event) => record('agent_event', { event }),
    broadcastMinecraftError: (message) => record('agent_error', { message }), allowAutonomousMaintenance: () => false,
    requestPlannerCompletion: async () => { record('unexpected_planner_request'); throw new Error('No cloud AI provider is authorized for this acceptance'); } });
  agent.attachBot(bot);
  agent.initializeBotRuntime();
  startPolling();
  taskSubmittedAt = Date.now();
  record('task_submitted', { command: userCommand, source: 'deskpet', requestedDiamondCount });
  await Promise.race([agent.handleMessage({ type: 'mc_command_submit', command: userCommand, source: 'deskpet' }), pollingFailure]);
  snapshot(true);
  while (Date.now() - startedAt < maximumMs) {
    await Promise.race([delay(500), pollingFailure]);
    snapshot();
    if (rawTask && ['completed', 'failed', 'paused', 'cancelled'].includes(rawTask.status)) break;
    if (deaths || bot._client.state !== 'play' || server.exitCode !== null) break;
  }
  snapshot(true);
  endedAt = Date.now();
  if (rawTask?.status === 'running') {
    record('harness_pause', { reason: deaths ? 'player_death' : bot._client.state !== 'play' ? 'connection_lost' : 'deadline' });
    await agent.handleMessage({ type: 'mc_command_pause' });
    snapshot(true);
  }
  clearInterval(polling);
  const taskEvidence = rawTask ? JSON.parse(evidenceJson({ taskId: rawTask.taskId, status: rawTask.status,
    error: rawTask.error, userCommand: rawTask.userCommand, plan: rawTask.plan,
    stepCheckpoint: rawTask.stepCheckpoint, diamondExpedition: rawTask.diamondExpedition, logs: rawTask.logs })) : null;
  record('task_outcome_frozen_before_readback', { status: taskEvidence?.status, error: taskEvidence?.error,
    pathfinderMoving: bot.pathfinder?.isMoving?.(), digging: Boolean(bot.targetDigBlock), usingHeldItem: bot.usingHeldItem,
    currentWindow: bot.currentWindow?.type || null });
  // A stopped/paused client retains its actual position; the harness never
  // teleports or gives resources to manufacture a successful final readback.
  const authoritative = await finalReadback();
  const finalInventory = inventory();
  const finalPosition = bot.entity.position.clone();
  const diamondCount = finalInventory.filter((item) => item.name === 'diamond').reduce((sum, item) => sum + item.count, 0);
  const serverDiamondCount = authoritative.serverInventory.filter((item) => item.name === 'diamond').reduce((sum, item) => sum + item.count, 0);
  const inventoryMatchesServer = evidenceJson(authoritative.serverInventory) === evidenceJson(finalInventory
    .map(({ name, count, slot }) => ({ name, count, slot })).sort((a, b) => a.slot - b.slot));
  const positionDifference = Math.hypot(finalPosition.x - authoritative.serverPosition.x,
    finalPosition.y - authoritative.serverPosition.y, finalPosition.z - authoritative.serverPosition.z);
  const base = taskEvidence?.diamondExpedition?.base;
  const distanceFromBase = (position) => base ? Math.hypot(position.x - base.x - 0.5, position.y - base.y, position.z - base.z - 0.5) : null;
  const endedSourceHashes = runtimeHashes();
  const food = foodEvidence();
  const lavaChanges = lavaChangeEvidence();
  const targetEvidence = targetCountEvidence(taskEvidence, requestedDiamondCount);
  const forbiddenCommands = events.filter((event) => event.type === 'server_command' && event.command !== 'stop'
    && !/^(?:seed|difficulty|gamerule \w+|data get entity |execute if block |say DESKPET_NATURAL_)/.test(event.command));
  const executionCommands = events.filter((event) => event.type === 'server_command' && event.elapsedMs >= taskSubmittedAt - startedAt
    && event.elapsedMs < endedAt - startedAt);
  const criteria = {
    taskCompleted: taskEvidence?.status === 'completed', emptyInventoryNaturalSpawn: initialObservation.inventory.length === 0 && initialObservation.serverInventory.length === 0,
    naturalNormalSurvivalRules: serverDifficulty === 'normal' && gameRules.doMobSpawning
      && gameRules.doDaylightCycle && gameRules.doWeatherCycle && !gameRules.keepInventory,
    noConsoleMutations: forbiddenCommands.length === 0, noConsoleCommandsDuringExecution: executionCommands.length === 0,
    runtimeSourceUnchanged: evidenceJson(startedSourceHashes) === evidenceJson(endedSourceHashes),
    campaignSeedUnchanged: JSON.parse(fs.readFileSync(campaignFile, 'utf8')).seed === campaign.seed,
    requestedTargetMatchesPlan: targetEvidence.verification === 'CONFIRMED',
    clientAndServerDiamonds: diamondCount >= requestedDiamondCount && serverDiamondCount === diamondCount,
    inventoryMatchesServer, positionMatchesServer: positionDifference < 0.2,
    returnedToBase: distanceFromBase(finalPosition) !== null && distanceFromBase(finalPosition) <= 2 && distanceFromBase(authoritative.serverPosition) <= 2,
    realDiamondMiningServerConfirmed: authoritative.ore.some((block) => /diamond_ore/.test(block.name) && block.serverConfirmedAir)
      && authoritative.ore.filter((block) => /diamond_ore/.test(block.name)).every((block) => block.serverConfirmedAir),
    completeToolchainObserved: ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'raw_iron', 'iron_ingot'].every((name) => inventorySeen.has(name)),
    actualAutomaticDescent: Boolean(base && minimumY <= base.y - 8
      && (taskEvidence?.diamondExpedition?.navigation?.breadcrumbs || taskEvidence?.diamondExpedition?.navigation?.route)
        ?.some((position) => position.y <= base.y - 8)),
    actualFoodReplenishment: food.some((episode) => episode.confirmed),
    actualLavaDetectionAndDetour: authoritative.lava.some((episode) => episode.confirmed && episode.serverReference.remainsLava),
    noDeath: deaths === 0, noObservedLavaFootContact: !lavaFootContact,
    noObservedAgentLavaExcavation: !lavaChanges.some((change) => change.agentActionCorrelated),
  };
  result = {
    status: taskEvidence?.status || 'not_started', error: taskEvidence?.error || '', startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, minecraftVersion: version,
    mode: 'real-vanilla-random-natural-normal-survival', runName, campaign, campaignFile, requestedDiamondCount, targetEvidence,
    initialObservation, phases: [...phases], minimumY, minimumHealth, minimumFood, deaths, lavaFootContact,
    diamonds: diamondCount, serverDiamondCount, finalInventory, finalPosition,
    serverInventory: authoritative.serverInventory, serverPosition: authoritative.serverPosition,
    serverHealth: authoritative.serverHealth, serverFood: authoritative.serverFood, inventoryMatchesServer, positionDifference,
    base, baseDistance: distanceFromBase(finalPosition), serverBaseDistance: distanceFromBase(authoritative.serverPosition),
    foodEvidence: food, lavaAvoidanceEvidence: authoritative.lava, lavaChangesEvidence: lavaChanges,
    unattributedLavaChanges: lavaChanges.filter((change) => !change.agentActionCorrelated), minedBlockCount: authoritative.mined.length,
    minedOre: authoritative.ore, inventoryItemsObserved: [...inventorySeen],
    sourceHashes: { started: startedSourceHashes, ended: endedSourceHashes, unchanged: criteria.runtimeSourceUnchanged },
    task: taskEvidence,
    consoleCommandsDuringExecution: executionCommands, criteria, acceptancePassed: Object.values(criteria).every(Boolean),
    unmetCriteria: Object.entries(criteria).filter(([, passed]) => !passed).map(([name]) => name),
    evidenceLimits: ['One precommitted random seed, not proof for arbitrary seeds or servers.',
      'Foot contact sampled every 500 ms; does not prove continuous sub-tick absence of contact.',
      'Lava reference cells are checked after the run, not every cell of every natural aquifer.',
      'A lava detour requires an explicit lava reason, real nearby lava, new checked-route steps and at least 0.75 m actual movement along continuous recorded breadcrumbs within 120 seconds; heading alone is insufficient.',
      'Every lava replacement is retained. Only a same-cell completed dig or observed real block placement within 5 seconds fails the agent-excavation criterion; absent correlation does not establish the cause of a natural change.',
      'Food requires a server entity-status consumption event, server-reported hunger increase and matching inventory decrease; supplies alone do not pass.',
      'Ore removal is cross-checked by a completed real dig and independent server block readback.'],
    eventsPath: path.join(runDir, 'events.jsonl'), readbackPath: path.join(runDir, 'server-readback.log'),
  };
  fs.writeFileSync(path.join(runDir, 'result.json'), evidenceJson(result, null, 2) + '\n');
  console.log(evidenceJson({ acceptancePassed: result.acceptancePassed, status: result.status, error: result.error,
    diamonds: diamondCount, minimumY, minimumFood, foodReplenishmentEpisodes: food.filter((episode) => episode.confirmed).length,
    lavaDetourEpisodes: authoritative.lava.filter((episode) => episode.confirmed).length,
    baseDistance: result.baseDistance, unmetCriteria: result.unmetCriteria, resultPath: path.join(runDir, 'result.json') }));
  if (!result.acceptancePassed) process.exitCode = 1;
}
async function cleanup() {
  clearInterval(polling);
  if (agent) {
    try { await agent.handleMessage({ type: 'mc_command_cancel' }); } catch { /* Preserve first failure. */ }
    agent.detachBot('manual_disconnect'); agent.dispose();
  }
  if (bot) { try { bot.quit('Natural local acceptance finished'); } catch { /* Already disconnected. */ } }
  if (server?.exitCode === null && server.signalCode === null) {
    command('stop');
    try { await withDeadline(serverExit, 30_000, 'Graceful server stop timeout'); }
    catch { server.kill('SIGTERM'); await withDeadline(serverExit, 10_000, 'Server termination timeout').catch(() => {}); }
  }
  for (const waiter of serverWaiters) { clearTimeout(waiter.timer); waiter.reject(new Error('Acceptance ended')); }
  serverWaiters.clear();
  if (fs.existsSync(runDir)) {
    const lifecycle = { stoppedAt: new Date().toISOString(), serverExitCode: server?.exitCode ?? null,
      serverExitSignal: server?.signalCode ?? null, serverStopped: Boolean(server && (server.exitCode !== null || server.signalCode !== null)),
      campaignSeed: campaign?.seed, acceptancePassed: result?.acceptancePassed ?? false };
    fs.writeFileSync(path.join(runDir, 'server-lifecycle.json'), evidenceJson(lifecycle, null, 2) + '\n');
  }
}
main().catch((error) => {
  console.error(error.stack || error);
  if (fs.existsSync(runDir)) {
    record('harness_failure', { message: error.message, stack: error.stack });
    fs.writeFileSync(path.join(runDir, 'harness-failure.json'), evidenceJson({ message: error.message, stack: error.stack }, null, 2) + '\n');
  }
  process.exitCode = 1;
}).finally(cleanup);
