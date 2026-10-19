/* global process, console, __dirname, __filename, setTimeout, clearTimeout, setInterval, clearInterval */
'use strict';

// Opt-in, real vanilla-server acceptance. Never imported by the application or
// unit suite. All construction happens before mc_command_submit; the resulting
// bot uses unmodified Mineflayer physics, inventory, crafting and digging APIs.
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const args = process.argv.slice(2);
const argument = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const workspace = path.resolve(__dirname, '../../..');
const installation = path.resolve(argument('--installation', path.join(workspace, '.minecraft-local-test')));
const installationFile = path.join(installation, 'installation.json');
const installed = fs.existsSync(installationFile) ? JSON.parse(fs.readFileSync(installationFile, 'utf8')) : {};
const java = argument('--java', installed.java || path.join(installation, 'runtime/jdk/Contents/Home/bin/java'));
const jar = argument('--server-jar', installed.minecraft?.jar || path.join(installation, 'server.jar'));
const runName = argument('--run-name', `diamond-${new Date().toISOString().replace(/[:.]/g, '-')}`);
assert.match(runName, /^[a-zA-Z0-9_-]+$/, 'Run name must be a simple directory name');
const runDir = path.join(installation, 'worlds', runName);
const version = argument('--version', installed.minecraft?.version || '1.21.8');
const maximumMs = Number(argument('--timeout-ms', 7_200_000));
const username = 'DeskPetMiner';
const startedAt = Date.now();
const events = [];
const mined = [];
const phases = new Set();
const inventorySeen = new Set();
const lavaAvoidanceEvidence = [];
let server;
let bot;
let agent;
let polling;
let rawTask;
let lastEventSignature = '';
let lastReportAt = 0;
let minimumY = Infinity;
let maximumAvoidedHazards = 0;
let lastObservedAvoidedHazards = 0;
let deathCount = 0;
let lavaContact = false;
let serverOutput = '';
let setupCompletedAt = 0;
let setupCommandCount = 0;
let startedSourceHashes;
const serverWaiters = new Set();

function runtimeHashes() {
  return Object.fromEntries([
    ['minecraftTaskAgent.js', path.join(__dirname, '../vendor/server/minecraftTaskAgent.js')],
    ['miningNavigation.js', path.join(__dirname, '../vendor/server/minecraft/miningNavigation.js')],
    ['diamondExpedition.js', path.join(__dirname, '../vendor/server/minecraft/diamondExpedition.js')],
    ['runtime.js', path.join(__dirname, '../runtime.js')],
    ['real-diamond-server.cjs', __filename],
  ].map(([name, file]) => [name, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
}

function parseServerInventory(readback) {
  const line = readback.split('\n').find((text) => /has the following entity data: \[(?:\{|\])/.test(text));
  if (!line) return null;
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
    const slot = Number(compound.match(/\bSlot:\s*(\d+)b/)?.[1]);
    if (!name || !Number.isInteger(count) || !Number.isInteger(slot)) throw new Error(`Cannot decode server inventory entry: ${compound}`);
    // Vanilla player NBT hotbar 0..8 corresponds to Mineflayer window 36..44.
    return { name, count, slot: slot <= 8 ? slot + 36 : slot };
  }).sort((a, b) => a.slot - b.slot);
}

function record(type, data) {
  const event = { at: new Date().toISOString(), elapsedMs: Date.now() - startedAt, type, ...data };
  events.push(event);
  fs.appendFileSync(path.join(runDir, 'events.jsonl'), JSON.stringify(event) + '\n');
}

function serverReadback(pattern, timeout = 30_000, from = serverOutput.length) {
  return new Promise((resolve, reject) => {
    const waiter = { pattern, from, resolve, reject };
    waiter.timer = setTimeout(() => { serverWaiters.delete(waiter); reject(new Error(`Server readback timed out: ${pattern}`)); }, timeout);
    serverWaiters.add(waiter);
    checkServerWaiters();
  });
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

function command(text) {
  assert.ok(server && !server.killed && server.stdin.writable, 'Server stdin is unavailable');
  record('server_command', { command: text, beforeTask: !setupCompletedAt });
  server.stdin.write(text + '\n');
}

async function commandBatch(commands) {
  for (const text of commands) {
    command(text);
    setupCommandCount += 1;
  }
  const marker = `DESKPET_SETUP_${setupCommandCount}`;
  const completed = serverReadback(new RegExp(marker));
  command(`say ${marker}`);
  await completed;
}

function inventory() {
  return (bot?.inventory.items() || []).map((item) => ({ name: item.name, count: item.count,
    slot: item.slot, durabilityUsed: item.durabilityUsed ?? null }));
}

function snapshot(force = false) {
  if (!bot?.entity) return;
  const task = agent.__testGetReconnectTask();
  if (task) rawTask = task;
  const state = rawTask?.diamondExpedition;
  if (state?.phase) phases.add(state.phase);
  maximumAvoidedHazards = Math.max(maximumAvoidedHazards, state?.avoidedHazards || 0);
  if (state && state.avoidedHazards > lastObservedAvoidedHazards) {
    const lavaId = bot.registry.blocksByName.lava?.id;
    const nearbyLava = Number.isInteger(lavaId) ? bot.findBlocks({ matching: lavaId, maxDistance: 5, count: 8 }) : [];
    const confirmed = nearbyLava.filter((position) => bot.blockAt(position)?.name === 'lava');
    if (confirmed.length) {
      const evidence = { avoidedHazardsBefore: lastObservedAvoidedHazards, avoidedHazardsAfter: state.avoidedHazards,
        playerPosition: bot.entity.position.clone(), heading: state.heading, nearbyLava: confirmed,
        phase: state.phase, reason: rawTask.progressText, searchSteps: state.searchSteps };
      lavaAvoidanceEvidence.push(evidence);
      record('lava_avoidance_observed', evidence);
    }
    lastObservedAvoidedHazards = state.avoidedHazards;
  }
  minimumY = Math.min(minimumY, bot.entity.position.y);
  for (const item of inventory()) inventorySeen.add(item.name);
  const foot = bot.blockAt(bot.entity.position.floored());
  if (/lava/.test(foot?.name || '')) lavaContact = true;
  const data = { position: bot.entity.position, onGround: bot.entity.onGround, velocity: bot.entity.velocity,
    heldItem: bot.heldItem ? { name: bot.heldItem.name, durabilityUsed: bot.heldItem.durabilityUsed ?? null } : null,
    pathfinder: { isMoving: bot.pathfinder?.isMoving?.(), goal: bot.pathfinder?.goal || null }, health: bot.health, food: bot.food,
    inventory: inventory(), task: { status: rawTask?.status, error: rawTask?.error,
      progressText: rawTask?.progressText, currentStep: rawTask?.currentStep }, checkpoint: state || null };
  const signature = JSON.stringify([data.position, data.health, data.food, data.inventory,
    data.task, state?.phase, state?.searchSteps, state?.avoidedHazards]);
  if (force || signature !== lastEventSignature) {
    record('snapshot', data);
    lastEventSignature = signature;
  }
  if (Date.now() - lastReportAt > 15_000 || force) {
    lastReportAt = Date.now();
    console.log(JSON.stringify({ elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
      status: rawTask?.status, phase: state?.phase, position: bot.entity.position,
      health: bot.health, food: bot.food, diamonds: inventory().filter((item) => item.name === 'diamond').reduce((sum, item) => sum + item.count, 0),
      searchSteps: state?.searchSteps, dug: state?.navigation?.dug,
      avoidedHazards: state?.avoidedHazards, progress: rawTask?.progressText, error: rawTask?.error }));
  }
}

async function setupTerrain() {
  const commands = [
    'gamerule doMobSpawning false', 'gamerule doWeatherCycle false', 'gamerule doDaylightCycle false',
    'time set noon', 'weather clear', 'setworldspawn 0 30 0',
    'forceload add -48 -48 128 128',
    'fill -18 29 5 -2 29 9 farmland[moisture=7]',
    'fill -18 30 5 -2 30 9 wheat[age=7]',
    'fill -19 29 5 -19 29 9 water',
  ];
  // Eight small trees supply exactly the 16 logs needed for 64 planks. Leaves
  // are persistent so the complete pre-task test terrain remains reproducible.
  for (let x = -2; x >= -16; x -= 2) {
    commands.push(`fill ${x - 1} 32 -1 ${x + 1} 32 1 oak_leaves[persistent=true]`);
    commands.push(`fill ${x} 30 0 ${x} 31 0 oak_log`);
  }
  for (const x of [0, 4, 8, 12, 16, 20]) commands.push(`fill ${x} 16 -1 ${x + 1} 18 1 iron_ore`);
  // The east staircase encounters a contained lava seam well before diamond
  // depth. Stable rock surrounds it; opening a mining face is unnecessary.
  commands.push('fill 50 -45 -24 50 -25 24 lava[level=0]');
  // Static ore clusters lie beyond the first diamond-depth position and its
  // 12-block scan radius, requiring additional real corridor prospecting.
  for (const [x, z] of [[48, 45], [48, 65], [28, 45], [68, 45], [68, 0], [88, 0]]) {
    commands.push(`fill ${x} -53 ${z} ${x + 1} -52 ${z + 1} deepslate_diamond_ore`);
  }
  await commandBatch(commands);
  await commandBatch([`clear ${username}`, `gamemode survival ${username}`, `effect clear ${username}`,
    `spawnpoint ${username} 0 30 0`, `tp ${username} 0.5 30 0.5`]);
  await sleep(1500);
  await bot.waitForChunksToLoad();
  assert.equal(bot.inventory.items().length, 0, 'The real player must start with an empty inventory');
  assert.equal(bot.game.gameMode, 'survival', 'The player must run in survival mode');
  setupCompletedAt = Date.now();
  record('setup_complete', { commands: setupCommandCount, inventory: inventory(), position: bot.entity.position,
    terrain: 'Static controlled vanilla world, surface Y=30; real logs, iron ore, stone/deepslate, contained lava seam and buried diamond clusters.',
    modificationsDuringTask: 'Only the real bot may dig/place/craft; console performs readback only.' });
}

async function main() {
  assert.ok(args.includes('--accept-eula'), 'Pass --accept-eula after accepting https://aka.ms/MinecraftEULA');
  assert.ok(fs.existsSync(java), `Java executable does not exist: ${java}`);
  assert.ok(fs.existsSync(jar), `Server jar does not exist: ${jar}`);
  assert.ok(!fs.existsSync(runDir), 'Refusing to replace an existing test world; choose another --run-name');
  fs.mkdirSync(runDir, { recursive: true });
  const portProbe = createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));
  const generator = { layers: [{ block: 'minecraft:bedrock', height: 1 },
    { block: 'minecraft:deepslate', height: 63 }, { block: 'minecraft:stone', height: 26 },
    { block: 'minecraft:dirt', height: 3 }, { block: 'minecraft:grass_block', height: 1 }],
  biome: 'minecraft:plains', structures: {} };
  const properties = {
    'server-ip': '127.0.0.1', 'server-port': port, 'online-mode': false, 'enforce-secure-profile': false,
    'enable-rcon': false, 'enable-query': false, 'level-name': 'world', 'level-type': 'minecraft:flat',
    'generator-settings': JSON.stringify(generator), 'level-seed': 42, difficulty: 'normal', gamemode: 'survival',
    'max-players': 1, 'view-distance': 8, 'simulation-distance': 4, 'spawn-protection': 0,
    'allow-flight': true, 'max-tick-time': 60000, 'sync-chunk-writes': true, 'pause-when-empty-seconds': 0,
    motd: 'DeskPet isolated local acceptance', 'initial-enabled-packs': 'vanilla',
  };
  fs.writeFileSync(path.join(runDir, 'server.properties'), Object.entries(properties).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  fs.writeFileSync(path.join(runDir, 'eula.txt'), '# Accepted for this explicitly requested isolated local server setup.\neula=true\n');
  startedSourceHashes = runtimeHashes();
  record('run_started', { version, java, jar, jarSha256: crypto.createHash('sha256').update(fs.readFileSync(jar)).digest('hex'), sourceHashes: startedSourceHashes,
    serverAddress: `127.0.0.1:${port}`, worldDir: runDir, properties });
  server = spawn(java, ['-Xms1G', '-Xmx2G', '-jar', jar, 'nogui'], { cwd: runDir, stdio: ['pipe', 'pipe', 'pipe'] });
  const serverLog = fs.createWriteStream(path.join(runDir, 'server.log'));
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => {
    serverLog.write(chunk);
    serverOutput += chunk.toString();
    checkServerWaiters();
  });
  server.on('exit', (code, signal) => record('server_exit', { code, signal }));
  await serverReadback(/Done \([^)]+\)! For help/, 180_000, 0);
  console.log(JSON.stringify({ serverReady: true, runDir, port }));
  bot = mineflayer.createBot({ host: '127.0.0.1', port, username, auth: 'offline', version, hideErrors: false });
  bot.on('error', (error) => record('bot_error', { message: error.message, stack: error.stack }));
  bot.on('kicked', (reason) => record('bot_kicked', { reason }));
  bot.on('death', () => { deathCount += 1; record('bot_death', { position: bot.entity?.position }); });
  bot.on('diggingCompleted', (block) => {
    // Mineflayer passes the NEW block (usually air), so original ore names must
    // come from blockUpdate's oldBlock and be cross-checked on the server.
    record('digging_completed', { position: block.position, resultingBlock: block.name,
      playerPosition: bot.entity?.position });
  });
  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (setupCompletedAt && oldBlock && newBlock && oldBlock.name !== newBlock.name) {
      record('block_update', { position: newBlock.position, from: oldBlock.name, to: newBlock.name });
      if (newBlock.name === 'air' && !['air', 'cave_air', 'void_air'].includes(oldBlock.name)) {
        mined.push({ at: new Date().toISOString(), position: newBlock.position, name: oldBlock.name,
          playerPosition: bot.entity?.position });
      }
    }
  });
  await Promise.race([once(bot, 'spawn'), sleep(60_000).then(() => { throw new Error('Mineflayer spawn timeout'); })]);
  const acknowledged = await acknowledgePlayerLoaded(bot);
  record('player_loaded_acknowledgement', { sent: acknowledged, version: bot.version,
    via: 'Production runtime acknowledgePlayerLoaded helper after chunks loaded' });
  bot.inventory.on('updateSlot', (slot, oldItem, newItem) => {
    if (newItem) inventorySeen.add(newItem.name);
    if (setupCompletedAt) record('inventory_delta', { slot,
      previous: oldItem ? { name: oldItem.name, count: oldItem.count } : null,
      next: newItem ? { name: newItem.name, count: newItem.count } : null });
  });
  await bot.waitForChunksToLoad();
  await setupTerrain();
  agent = createMinecraftTaskAgent({ appPaths: { appDataDir: path.join(runDir, 'deskpet-data') },
    readConfig: () => ({ mcExecutorMode: 'strict-executor', mcAgentAutoReconnect: false }),
    parseJsonObjectFromText: JSON.parse, broadcast: (event) => record('agent_event', { event }),
    broadcastMinecraftError: (message) => record('agent_error', { message }),
    allowAutonomousMaintenance: () => false,
    requestPlannerCompletion: async () => { record('unexpected_planner_request', {}); throw new Error('No AI provider is permitted during this deterministic acceptance'); },
  });
  agent.attachBot(bot);
  agent.initializeBotRuntime();
  polling = setInterval(() => snapshot(), 500);
  await agent.handleMessage({ type: 'mc_command_submit', command: '从零开始挖到钻石', source: 'deskpet' });
  record('task_submitted', { command: '从零开始挖到钻石' });
  snapshot(true);
  while (Date.now() - startedAt < maximumMs) {
    await sleep(500);
    snapshot();
    if (rawTask && ['completed', 'failed', 'paused', 'cancelled'].includes(rawTask.status)) break;
    if (deathCount || bot._client.state !== 'play') break;
  }
  snapshot(true);
  if (rawTask?.status === 'running') await agent.handleMessage({ type: 'mc_command_pause' });
  const readbackStart = serverOutput.length;
  const readbackCommands = [`data get entity ${username} Inventory`, `data get entity ${username} Pos`,
    `data get entity ${username} Health`, `data get entity ${username} foodLevel`];
  for (const block of mined.filter((item) => /diamond_ore|iron_ore/.test(item.name))) {
    const p = block.position;
    readbackCommands.push(`execute if block ${p.x} ${p.y} ${p.z} air run say DESKPET_SERVER_MINED_${p.x}_${p.y}_${p.z}`);
  }
  readbackCommands.push('execute if block 50 -35 0 lava run say DESKPET_LAVA_SEAM_INTACT');
  for (const text of readbackCommands) command(text);
  const marker = 'DESKPET_FINAL_READBACK';
  const readbackReady = serverReadback(new RegExp(marker), 30_000, readbackStart);
  command(`say ${marker}`);
  await readbackReady;
  const readback = serverOutput.slice(readbackStart);
  fs.writeFileSync(path.join(runDir, 'server-readback.log'), readback);
  const finalInventory = inventory();
  const diamondCount = finalInventory.filter((item) => item.name === 'diamond').reduce((sum, item) => sum + item.count, 0);
  const finalPosition = bot.entity.position.clone();
  const serverInventory = parseServerInventory(readback);
  const serverDiamondCount = serverInventory?.filter((item) => item.name === 'diamond').reduce((sum, item) => sum + item.count, 0) ?? null;
  const serverPositionMatch = readback.match(/has the following entity data: \[(-?[\d.]+)d,\s*(-?[\d.]+)d,\s*(-?[\d.]+)d\]/);
  const serverPosition = serverPositionMatch ? { x: Number(serverPositionMatch[1]), y: Number(serverPositionMatch[2]), z: Number(serverPositionMatch[3]) } : null;
  const positionDifference = serverPosition ? Math.hypot(finalPosition.x - serverPosition.x, finalPosition.y - serverPosition.y, finalPosition.z - serverPosition.z) : null;
  const inventoryMatchesServer = JSON.stringify(serverInventory) === JSON.stringify(finalInventory.map(({ name, count, slot }) => ({ name, count, slot })).sort((a, b) => a.slot - b.slot));
  const endedSourceHashes = runtimeHashes();
  const runtimeSourceStable = JSON.stringify(startedSourceHashes) === JSON.stringify(endedSourceHashes);
  const base = rawTask?.diamondExpedition?.base;
  const baseDistance = base ? Math.hypot(finalPosition.x - base.x - 0.5, finalPosition.y - base.y, finalPosition.z - base.z - 0.5) : null;
  const serverBaseDistance = base && serverPosition ? Math.hypot(serverPosition.x - base.x - 0.5, serverPosition.y - base.y, serverPosition.z - base.z - 0.5) : null;
  const result = {
    status: rawTask?.status || 'not_started', error: rawTask?.error || '', elapsedMs: Date.now() - startedAt,
    minecraftVersion: version, mode: 'real-vanilla-controlled-static-terrain', zeroInventoryStart: true,
    phases: [...phases], minimumY, maximumAvoidedHazards, lavaAvoidanceEvidence, deathCount, lavaContact, diamonds: diamondCount,
    finalInventory, finalPosition, serverInventory, serverDiamondCount, serverPosition, positionDifference,
    inventoryMatchesServer, base, baseDistance, serverBaseDistance, minedBlockCount: mined.length,
    sourceHashes: { started: startedSourceHashes, ended: endedSourceHashes, unchanged: runtimeSourceStable },
    minedOre: mined.filter((item) => /diamond_ore|iron_ore/.test(item.name)),
    serverInventoryConfirmsDiamond: serverDiamondCount === diamondCount && diamondCount > 0,
    serverDiamondBlocksConfirmAir: mined.filter((item) => /diamond_ore/.test(item.name)).every((item) =>
      readback.includes(`DESKPET_SERVER_MINED_${item.position.x}_${item.position.y}_${item.position.z}`)),
    serverLavaSeamIntact: readback.includes('DESKPET_LAVA_SEAM_INTACT'),
    task: rawTask, eventsPath: path.join(runDir, 'events.jsonl'), readbackPath: path.join(runDir, 'server-readback.log'),
  };
  // Tokens and runtime internals are not needed in the retained evidence.
  if (result.task) result.task = { taskId: rawTask.taskId, status: rawTask.status, error: rawTask.error,
    userCommand: rawTask.userCommand, plan: rawTask.plan, stepCheckpoint: rawTask.stepCheckpoint,
    diamondExpedition: rawTask.diamondExpedition, logs: rawTask.logs };
  result.acceptancePassed = result.status === 'completed' && diamondCount >= 1 && deathCount === 0 && !lavaContact
    && minimumY <= -52 && maximumAvoidedHazards >= 1 && lavaAvoidanceEvidence.length >= 1 && phases.has('prospect_diamond')
    && baseDistance !== null && baseDistance <= 2 && result.serverInventoryConfirmsDiamond
    && serverBaseDistance !== null && serverBaseDistance <= 2 && inventoryMatchesServer
    && positionDifference !== null && positionDifference < 0.2 && runtimeSourceStable
    && result.minedOre.some((item) => /diamond_ore/.test(item.name))
    && result.serverDiamondBlocksConfirmAir && result.serverLavaSeamIntact
    && ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'raw_iron', 'iron_ingot'].every((name) => inventorySeen.has(name));
  result.inventoryItemsObserved = [...inventorySeen];
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ acceptancePassed: result.acceptancePassed, status: result.status, error: result.error,
    diamonds: diamondCount, minimumY, maximumAvoidedHazards, phases: result.phases, baseDistance,
    resultPath: path.join(runDir, 'result.json') }));
  if (!result.acceptancePassed) process.exitCode = 1;
}

async function cleanup() {
  clearInterval(polling);
  if (agent) { try { await agent.handleMessage({ type: 'mc_command_cancel' }); } catch { /* Preserve original failure. */ }
    agent.detachBot('manual_disconnect'); agent.dispose(); }
  if (bot) { try { bot.quit('Local acceptance finished'); } catch { /* Connection may already be closed. */ } }
  if (server && server.exitCode === null && server.signalCode === null) {
    command('stop');
    await Promise.race([once(server, 'exit'), sleep(30_000)]);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  }
  for (const waiter of serverWaiters) { clearTimeout(waiter.timer); waiter.reject(new Error('Server acceptance ended')); }
  serverWaiters.clear();
}

main().catch((error) => {
  console.error(error.stack || error);
  if (fs.existsSync(runDir)) {
    record('harness_failure', { message: error.message, stack: error.stack });
    fs.writeFileSync(path.join(runDir, 'harness-failure.json'), JSON.stringify({ message: error.message, stack: error.stack }, null, 2) + '\n');
  }
  process.exitCode = 1;
}).finally(cleanup);
