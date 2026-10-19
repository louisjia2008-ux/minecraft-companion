/* global process, console, __dirname, setTimeout, clearTimeout, setInterval, clearInterval */
'use strict';

// Opt-in controlled hazard test: a separate real player pours an actual bucket.
// Tools, food and terrain are deliberate fixtures; this is not a natural-world
// or empty-inventory acceptance claim. No production method is replaced.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { once } = require('node:events');
const { Vec3 } = require('vec3');
const mineflayer = require('mineflayer');
const { createMinecraftTaskAgent } = require('../vendor/server/minecraftTaskAgent');
const { acknowledgePlayerLoaded } = require('../runtime');
const { withMinecraftProtocolCompatibility } = require('../protocolCompatibility');
const { observedLava, classifyLavaChanges, readAnvilBlock } = require('./natural-world-audit.cjs');

const argv = process.argv.slice(2);
const arg = (key, fallback) => argv.includes(key) ? argv[argv.indexOf(key) + 1] : fallback;
const installation = path.resolve(arg('--installation', path.resolve(__dirname, '../../../.minecraft-local-test')));
const installed = JSON.parse(fs.readFileSync(path.join(installation, 'installation.json'), 'utf8'));
const runName = arg('--run-name', 'bucket-lava-01');
assert.match(runName, /^[a-zA-Z0-9_-]+$/);
const runDir = path.join(installation, 'worlds', runName);
const version = installed.minecraft?.version || '1.21.8';
const java = installed.java;
const jar = installed.minecraft?.jar || path.join(installation, 'server.jar');
const timeoutMs = Number(arg('--timeout-ms', 600_000));
const username = 'DeskPetBucket';
const fixtureUsername = 'BucketFixture';
const sourceCell = { x: 2, y: -49, z: 0 };
const diamondCells = [{ x: 0, y: -53, z: 18 }, { x: 1, y: -53, z: 18 }];
const publicCommand = '从零开始挖到钻石';
const start = Date.now();
const events = [];
const waiters = new Set();
let server;
let bot;
let fixture;
let agent;
let interval;
let output = '';
let taskSubmittedAt = 0;
let taskEndedAt = 0;
let rawTask;
let result;
let snapshotError;
let lastAvoided = 0;
let lastReport = 0;
let footLava = false;
let deaths = 0;
let initialHashes;
let pouredEvidence;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (value, indent) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, indent);
const clone = (value) => JSON.parse(json(value));
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function hashes() {
  return Object.fromEntries(['../vendor/server/minecraftTaskAgent.js', '../vendor/server/minecraft/miningNavigation.js',
    '../vendor/server/minecraft/diamondExpedition.js', '../runtime.js', '../protocolCompatibility.js',
    './natural-world-audit.cjs', './real-bucket-lava-server.cjs'].map((file) => [file, hash(path.resolve(__dirname, file))]));
}
function record(type, data = {}) {
  const event = clone({ at: new Date().toISOString(), elapsedMs: Date.now() - start, type, ...data });
  events.push(event);
  fs.appendFileSync(path.join(runDir, 'events.jsonl'), json(event) + '\n');
  return event;
}
function checkWaiters() {
  for (const waiter of waiters) {
    const match = output.slice(waiter.from).match(waiter.pattern);
    if (!match) continue;
    clearTimeout(waiter.timer);
    waiters.delete(waiter);
    waiter.resolve(match[0]);
  }
}
function readback(pattern, from = output.length, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const waiter = { pattern, from, resolve, reject };
    waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Console readback timed out: ${pattern}`)); }, timeout);
    waiters.add(waiter);
    checkWaiters();
  });
}
function command(text) {
  assert.ok(server?.stdin.writable && !server.killed, 'Server stdin unavailable');
  assert.ok(!taskSubmittedAt || taskEndedAt || text === 'stop', 'No console command is permitted while the production task is running');
  record('server_command', { command: text, beforeTask: !taskSubmittedAt });
  server.stdin.write(text + '\n');
}
async function batch(commands, marker) {
  const from = output.length;
  const finished = readback(new RegExp(marker), from);
  for (const text of commands) command(text);
  command(`say ${marker}`);
  await finished;
  return output.slice(from);
}
async function until(predicate, description, ms = 20_000) {
  const untilAt = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= untilAt) throw new Error(`Timed out: ${description}`);
    await sleep(100);
  }
}
function inventory(player = bot) {
  return player.inventory.items().map((item) => ({ name: item.name, count: item.count, slot: item.slot }))
    .sort((a, b) => a.slot - b.slot);
}
function parseInventory(text) {
  const line = text.split('\n').find((entry) => /has the following entity data: \[(?:\{|\])/.test(entry));
  assert.ok(line, 'Server inventory readback is absent');
  const snbt = line.slice(line.indexOf('entity data: ') + 'entity data: '.length);
  const entries = [];
  let depth = 0;
  let begin = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < snbt.length; index += 1) {
    const char = snbt[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === '\\') { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (char === '{' && depth++ === 0) begin = index;
    if (char === '}' && --depth === 0) entries.push(snbt.slice(begin, index + 1));
  }
  return entries.map((entry) => {
    const name = entry.match(/\bid:\s*"minecraft:([^"]+)"/)?.[1];
    const count = Number(entry.match(/\bcount:\s*(\d+)/)?.[1]);
    const slot = Number(entry.match(/\bSlot:\s*(\d+)b/)?.[1]);
    assert.ok(name && Number.isInteger(count) && Number.isInteger(slot), 'Malformed server inventory compound');
    return { name, count, slot: slot <= 8 ? slot + 36 : slot };
  }).sort((a, b) => a.slot - b.slot);
}
async function connect(name) {
  const player = mineflayer.createBot(withMinecraftProtocolCompatibility({ host: '127.0.0.1', port: result.port,
    username: name, auth: 'offline', version, hideErrors: false }));
  player.on('error', (error) => record('bot_error', { player: name, message: error.message, stack: error.stack }));
  player.on('kicked', (reason) => record('bot_kicked', { player: name, reason }));
  await Promise.race([once(player, 'spawn'), sleep(60_000).then(() => { throw new Error(`${name} spawn timed out`); })]);
  await player.waitForChunksToLoad();
  record('player_loaded_acknowledgement', { player: name, sent: await acknowledgePlayerLoaded(player), version: player.version });
  return player;
}
function snapshot(force = false) {
  if (!bot?.entity || !agent) return;
  rawTask = agent.__testGetReconnectTask() || rawTask;
  const state = rawTask?.diamondExpedition;
  const nav = state?.navigation;
  const route = nav?.breadcrumbs || nav?.route;
  const navigation = nav ? { routeIndex: nav.routeIndex, routeLength: route?.length,
    currentRoutePosition: route?.[nav.routeIndex], lastRoutePositions: route?.slice(-4) } : null;
  if (bot.blockAt(bot.entity.position.floored())?.name === 'lava') footLava = true;
  if (state?.avoidedHazards > lastAvoided) {
    const nearbyLava = bot.findBlocks({ matching: bot.registry.blocksByName.lava.id, maxDistance: 6, count: 12 })
      .filter((point) => bot.blockAt(point)?.name === 'lava');
    record('hazard_observation', { before: lastAvoided, after: state.avoidedHazards,
      reason: rawTask.progressText, playerPosition: bot.entity.position, heading: state.heading,
      searchSteps: state.searchSteps, phase: state.phase, nearbyLava, navigation });
    lastAvoided = state.avoidedHazards;
  }
  record('snapshot', { position: bot.entity.position, onGround: bot.entity.onGround, velocity: bot.entity.velocity,
    health: bot.health, food: bot.food, inventory: inventory(),
    task: { status: rawTask?.status, error: rawTask?.error, progressText: rawTask?.progressText },
    checkpoint: state ? { phase: state.phase, targetCount: state.targetCount, searchSteps: state.searchSteps,
      avoidedHazards: state.avoidedHazards, heading: state.heading, base: state.base, navigation } : null });
  if (force || Date.now() - lastReport >= 15_000) {
    lastReport = Date.now();
    console.log(json({ elapsedSeconds: Math.floor((Date.now() - start) / 1000), status: rawTask?.status,
      phase: state?.phase, position: bot.entity.position, health: bot.health, food: bot.food,
      diamonds: inventory().filter((item) => item.name === 'diamond').reduce((sum, item) => sum + item.count, 0),
      avoidedHazards: state?.avoidedHazards, progress: rawTask?.progressText, error: rawTask?.error }));
  }
}
async function pourBucket() {
  fixture = await connect(fixtureUsername);
  fixture.inventory.on('updateSlot', (slot, previous, next) => record('fixture_inventory_delta', { slot,
    previous: previous ? { name: previous.name, count: previous.count } : null,
    next: next ? { name: next.name, count: next.count } : null }));
  await batch([`tp ${fixtureUsername} 2.5 -48 -0.5`, `give ${fixtureUsername} lava_bucket 1`], 'DESKPET_BUCKET_FIXTURE_READY');
  await until(() => Math.abs(fixture.entity.position.x - 2.5) < 0.1 && Math.abs(fixture.entity.position.z + 0.5) < 0.1
    && fixture.entity.onGround && fixture.inventory.items().some((item) => item.name === 'lava_bucket'), 'fixture position and real lava bucket');
  const bucket = fixture.inventory.items().find((item) => item.name === 'lava_bucket');
  await fixture.equip(bucket, 'hand');
  const aim = new Vec3(2.5, -49, 0.5);
  await fixture.lookAt(aim, true);
  record('actual_bucket_use_requested', { player: fixtureUsername, heldItem: fixture.heldItem.name,
    playerPosition: fixture.entity.position, lookAt: aim, expectedSourceCell: sourceCell,
    api: 'Unmodified Mineflayer activateItem(), native vanilla bucket use; no setblock/fill lava command' });
  fixture.activateItem();
  await until(() => fixture.inventory.items().some((item) => item.name === 'bucket')
    && fixture.blockAt(new Vec3(sourceCell.x, sourceCell.y, sourceCell.z))?.name === 'lava', 'real bucket became empty and source block became lava');
  const text = await batch([`data get entity ${fixtureUsername} Inventory`,
    `execute if block ${sourceCell.x} ${sourceCell.y} ${sourceCell.z} lava[level=0] run say DESKPET_BUCKET_SOURCE_CONFIRMED`], 'DESKPET_BUCKET_POUR_READBACK');
  assert.ok(text.includes('DESKPET_BUCKET_SOURCE_CONFIRMED'), 'Vanilla must confirm the lava source after native bucket use');
  assert.ok(/id:\s*"minecraft:bucket"/.test(text), 'Vanilla must confirm the emptied real bucket');
  pouredEvidence = record('actual_bucket_pour_confirmed', { sourceCell, fixtureInventory: inventory(fixture),
    sourceBlock: fixture.blockAt(new Vec3(sourceCell.x, sourceCell.y, sourceCell.z)).getProperties(),
    serverReadback: text });
  fixture.quit('Fixture completed before production task');
  await sleep(500);
}
async function main() {
  assert.ok(argv.includes('--accept-eula'), 'Pass --accept-eula for the explicitly authorized local official server');
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 30_000 && timeoutMs <= 1_800_000);
  assert.ok(fs.existsSync(java) && fs.existsSync(jar));
  assert.ok(!fs.existsSync(runDir), 'Never replace existing acceptance evidence');
  fs.mkdirSync(runDir, { recursive: true });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  result = { mode: 'controlled-real-bucket-lava-hazard', runDir, port, sourceCell, diamondCells,
    fixtures: 'Flat stone surface at Y=-49; survival task starts at natural configured spawn Y=-48. Deliberately granted planks/sticks/cobblestone, iron pickaxe, food; no diamonds granted. Separate fixture client receives and pours one lava bucket before the task.',
    taskBotTeleported: false, publicCommand };
  const properties = { 'server-ip': '127.0.0.1', 'server-port': port, 'online-mode': false, 'enforce-secure-profile': false,
    'level-name': 'world', 'level-type': 'minecraft:flat', 'level-seed': 42,
    'generator-settings': json({ layers: [{ block: 'minecraft:bedrock', height: 1 }, { block: 'minecraft:stone', height: 14 },
      { block: 'minecraft:grass_block', height: 1 }], biome: 'minecraft:plains', structures: {} }),
    difficulty: 'normal', gamemode: 'survival', 'max-players': 2, 'view-distance': 6, 'simulation-distance': 4,
    'spawn-protection': 0, 'allow-flight': true, 'sync-chunk-writes': true, 'pause-when-empty-seconds': 0 };
  fs.writeFileSync(path.join(runDir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(runDir, 'server.properties'), Object.entries(properties).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  initialHashes = hashes();
  record('run_started', { ...result, version, properties, sourceHashes: initialHashes, jarSha256: hash(jar) });
  server = spawn(java, ['-Xms512M', '-Xmx1G', '-jar', jar, 'nogui'], { cwd: runDir, stdio: ['pipe', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(runDir, 'server.log'));
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { log.write(chunk); output += chunk.toString(); checkWaiters(); });
  server.on('exit', (code, signal) => record('server_exit', { code, signal }));
  await readback(/Done \([^)]+\)! For help/, 0, 180_000);
  await batch(['gamerule doMobSpawning false', 'gamerule doDaylightCycle false', 'gamerule doWeatherCycle false',
    'gamerule spawnRadius 0', 'time set noon', 'weather clear', 'setworldspawn 0 -48 0',
    'setblock 2 -49 0 air', ...diamondCells.map((p) => `setblock ${p.x} ${p.y} ${p.z} deepslate_diamond_ore`)], 'DESKPET_BUCKET_TERRAIN_READY');
  await pourBucket();
  bot = await connect(username);
  assert.equal(bot.game.gameMode, 'survival');
  record('task_bot_spawn', { position: bot.entity.position, inventory: inventory(), mode: bot.game.gameMode });
  assert.equal(inventory().length, 0, 'Before controlled grants the task bot starts empty');
  await batch([`give ${username} oak_planks 128`, `give ${username} stick 64`, `give ${username} cobblestone 64`,
    `give ${username} iron_pickaxe 1`, `give ${username} cooked_porkchop 4`], 'DESKPET_BUCKET_TASK_RESOURCES_READY');
  await until(() => bot.inventory.items().some((item) => item.name === 'iron_pickaxe')
    && bot.inventory.items().some((item) => item.name === 'cooked_porkchop'), 'controlled task resources arrived');
  bot.on('death', () => { deaths += 1; record('bot_death', { position: bot.entity.position }); });
  bot.on('physicsTick', () => { if (taskSubmittedAt && bot.blockAt(bot.entity.position.floored())?.name === 'lava') footLava = true; });
  bot.on('diggingCompleted', (block) => { if (taskSubmittedAt) record('digging_completed', { position: block.position,
    resultingBlock: block.name, playerPosition: bot.entity.position }); });
  bot.on('blockUpdate', (before, after) => { if (taskSubmittedAt && before && after && before.name !== after.name)
    record('block_update', { position: after.position, from: before.name, to: after.name, playerPosition: bot.entity.position }); });
  bot.on('blockPlaced', (block) => { if (taskSubmittedAt) record('block_placed', { position: block.position, name: block.name }); });
  bot.inventory.on('updateSlot', (slot, previous, next) => { if (taskSubmittedAt) record('inventory_delta', { slot,
    previous: previous ? { name: previous.name, count: previous.count } : null,
    next: next ? { name: next.name, count: next.count } : null }); });
  agent = createMinecraftTaskAgent({ appPaths: { appDataDir: path.join(runDir, 'deskpet-data') },
    readConfig: () => ({ mcExecutorMode: 'strict-executor', mcAgentAutoReconnect: false }),
    parseJsonObjectFromText: JSON.parse, broadcast: (event) => record('agent_event', { event }),
    broadcastMinecraftError: (message) => record('agent_error', { message }), allowAutonomousMaintenance: () => false,
    requestPlannerCompletion: async () => { throw new Error('No AI provider is authorized for deterministic bucket acceptance'); } });
  agent.attachBot(bot); agent.initializeBotRuntime();
  taskSubmittedAt = Date.now() - start;
  record('task_submitted', { command: publicCommand, initialInventory: inventory(), position: bot.entity.position });
  await agent.handleMessage({ type: 'mc_command_submit', command: publicCommand, source: 'deskpet' });
  interval = setInterval(() => { try { snapshot(); } catch (error) { snapshotError = error; } }, 200);
  while (Date.now() - start < timeoutMs) {
    if (snapshotError) throw snapshotError;
    snapshot();
    if (rawTask && ['completed', 'paused', 'failed', 'cancelled'].includes(rawTask.status)) break;
    if (deaths || bot._client.state !== 'play') break;
    await sleep(200);
  }
  snapshot(true); clearInterval(interval);
  const frozenTask = clone({ taskId: rawTask?.taskId, status: rawTask?.status, error: rawTask?.error,
    plan: rawTask?.plan, checkpoint: rawTask?.diamondExpedition });
  if (rawTask?.status === 'running') await agent.handleMessage({ type: 'mc_command_pause' });
  taskEndedAt = Date.now() - start;
  record('task_outcome_frozen_before_readback', { task: frozenTask, position: bot.entity.position, inventory: inventory() });
  const text = await batch([`data get entity ${username} Inventory`, `data get entity ${username} Pos`,
    `execute if block ${sourceCell.x} ${sourceCell.y} ${sourceCell.z} lava[level=0] run say DESKPET_BUCKET_SOURCE_STILL_LAVA`,
    ...diamondCells.map((p) => `execute if block ${p.x} ${p.y} ${p.z} air run say DESKPET_BUCKET_DIAMOND_AIR_${p.x}_${p.y}_${p.z}`)], 'DESKPET_BUCKET_FINAL_READBACK');
  fs.writeFileSync(path.join(runDir, 'server-readback.log'), text);
  const serverInventory = parseInventory(text);
  const positionMatch = text.match(/has the following entity data: \[(-?[\d.]+)d,\s*(-?[\d.]+)d,\s*(-?[\d.]+)d\]/);
  assert.ok(positionMatch, 'Server Pos readback missing');
  const serverPosition = { x: Number(positionMatch[1]), y: Number(positionMatch[2]), z: Number(positionMatch[3]) };
  const base = frozenTask.checkpoint?.base;
  const finalInventory = inventory();
  const lavaEvidence = observedLava(events);
  Object.assign(result, { elapsedMs: Date.now() - start, task: frozenTask, taskSubmittedAt, taskEndedAt,
    actualBucketPour: pouredEvidence, finalInventory, serverInventory, finalPosition: clone(bot.entity.position), serverPosition,
    diamonds: serverInventory.filter((item) => item.name === 'diamond').reduce((sum, item) => sum + item.count, 0),
    base, baseDistance: base ? Math.hypot(serverPosition.x - base.x - 0.5, serverPosition.y - base.y, serverPosition.z - base.z - 0.5) : null,
    positionDifference: Math.hypot(bot.entity.position.x - serverPosition.x, bot.entity.position.y - serverPosition.y, bot.entity.position.z - serverPosition.z),
    inventoryMatchesServer: json(finalInventory) === json(serverInventory), lavaEvidence, deaths, footLava,
    serverSourceStillLava: text.includes('DESKPET_BUCKET_SOURCE_STILL_LAVA'),
    sourceHashes: { started: initialHashes, ended: hashes() },
    consoleCommandsDuringTask: events.filter((event) => event.type === 'server_command' && event.elapsedMs > taskSubmittedAt && event.elapsedMs < taskEndedAt) });
  fs.writeFileSync(path.join(runDir, 'result.json'), json(result, 2) + '\n', { flag: 'wx' });
}
async function cleanup() {
  clearInterval(interval);
  if (agent) { try { agent.detachBot('manual_disconnect'); agent.dispose(); } catch (error) { record('cleanup_error', { message: error.message }); } }
  for (const player of [fixture, bot]) { try { player?.quit('Isolated real bucket acceptance complete'); } catch { /* preserve evidence */ } }
  if (server && server.exitCode === null && server.signalCode === null) {
    command('stop'); await Promise.race([once(server, 'exit'), sleep(30_000)]);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  }
  if (server) fs.writeFileSync(path.join(runDir, 'server-lifecycle.json'), json({ stoppedAt: new Date().toISOString(),
    serverStopped: server.exitCode !== null, serverExitCode: server.exitCode, serverExitSignal: server.signalCode }, 2) + '\n');
  for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('Acceptance ended')); }
  waiters.clear();
}
async function auditStopped() {
  if (!result?.task) return;
  const lifecycle = JSON.parse(fs.readFileSync(path.join(runDir, 'server-lifecycle.json')));
  assert.ok(lifecycle.serverStopped && lifecycle.serverExitCode === 0 && !lifecycle.serverExitSignal, 'Normal saved stop required');
  const lava = await readAnvilBlock(path.join(runDir, 'world'), sourceCell);
  const oreChanges = events.filter((event) => event.type === 'block_update' && /diamond_ore/.test(event.from) && event.to === 'air');
  const ores = [];
  for (const change of oreChanges) {
    const realDig = events.find((event) => event.type === 'digging_completed'
      && json(event.position) === json(change.position) && Math.abs(event.elapsedMs - change.elapsedMs) < 5000);
    ores.push({ change, realDig: realDig || null, savedBlock: await readAnvilBlock(path.join(runDir, 'world'), change.position) });
  }
  const excavations = classifyLavaChanges(events).filter((entry) => entry.matchingDigs.length || entry.matchingPlacements.length);
  const firstDetour = result.lavaEvidence.find((episode) => episode.confirmed);
  const laterDig = firstDetour && events.find((event) => event.type === 'digging_completed' && event.elapsedMs > firstDetour.detour.elapsedMs);
  const criteria = { actualNativeBucketPoured: Boolean(pouredEvidence), explicitLavaCauseAndRealCheckedDetour: Boolean(firstDetour),
    continuedActualDigAfterDetour: Boolean(laterDig), completedPublicTask: result.task.status === 'completed', realDiamondInventory: result.diamonds >= 1,
    diamondDigsAndSavedAir: ores.length >= 1 && ores.every((entry) => entry.realDig && entry.savedBlock.name === 'minecraft:air'),
    sourceLavaConfirmedServerAndSaved: result.serverSourceStillLava && lava.name === 'minecraft:lava' && lava.properties.level === '0',
    noObservedLavaFootContact: !result.footLava, noDeath: result.deaths === 0, noAgentLavaExcavation: excavations.length === 0,
    returnedToBase: result.baseDistance !== null && result.baseDistance < 0.2, inventoryMatchesServer: result.inventoryMatchesServer,
    positionMatchesServer: result.positionDifference < 0.2, noConsoleCommandsDuringTask: result.consoleCommandsDuringTask.length === 0,
    sourceHashesUnchanged: json(result.sourceHashes.started) === json(result.sourceHashes.ended), normalStop: lifecycle.serverExitCode === 0 };
  const report = { auditedAt: new Date().toISOString(), mode: result.mode, fixtureLimits: result.fixtures, criteria,
    acceptancePassed: Object.values(criteria).every(Boolean), unmetCriteria: Object.entries(criteria).filter(([, ok]) => !ok).map(([key]) => key),
    actualBucketPour: pouredEvidence, lavaEvidence: result.lavaEvidence, savedSource: lava, diamondEvidence: ores,
    continuedDigAfterDetour: laterDig || null, lifecycle, excavations,
    limitations: ['Controlled resources and terrain; this test does not claim natural-world or empty-inventory acceptance.',
      'Foot lava contact sampled on actual physics ticks and snapshots; no guarantee about unobserved protocol ticks.',
      'No task-time console/world/player intervention; setup fixture player alone was teleported before task submission.'] };
  fs.writeFileSync(path.join(runDir, 'bucket-independent-audit.json'), json(report, 2) + '\n', { flag: 'wx' });
  console.log(json({ acceptancePassed: report.acceptancePassed, unmetCriteria: report.unmetCriteria, runDir, diamonds: result.diamonds }));
  if (!report.acceptancePassed) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error.stack || error); process.exitCode = 1;
  if (fs.existsSync(runDir)) record('harness_failure', { message: error.message, stack: error.stack });
}).finally(async () => {
  try { await cleanup(); await auditStopped(); } catch (error) {
    console.error(error.stack || error); process.exitCode = 1;
    if (fs.existsSync(runDir)) record('post_stop_audit_failure', { message: error.message, stack: error.stack });
  }
});
