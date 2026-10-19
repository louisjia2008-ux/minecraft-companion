/* global process, console, __dirname, __filename, setTimeout, clearTimeout, setInterval, clearInterval */
'use strict';

// Private opt-in component integration. This does not submit or complete an
// estate public task. It exercises its production native farm adapter with
// explicitly granted resources in a unique official vanilla Survival world.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const argv = process.argv.slice(2);
const arg = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const installation = path.resolve(arg('--installation', __dirname));
const electron = path.resolve(__dirname, '../personal-ai-deskpet-electron-work/electron');
const runtime = path.join(electron, 'minecraft-runtime');
const localRequire = createRequire(path.join(runtime, 'package.json'));
const { Vec3 } = localRequire('vec3');
const mineflayer = localRequire('mineflayer');
const runName = arg('--run-name', 'estate-farm-01');
assert.match(runName, /^[a-zA-Z0-9_-]+$/);
const runDir = path.join(installation, 'worlds', runName);
const timeoutMs = Number(arg('--timeout-ms', 900_000));
const hydrationTimeoutMs = Number(arg('--hydration-timeout-ms', 420_000));
const username = 'DeskPetFarm';
const start = Date.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (value, indent) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item, indent);
const clone = value => JSON.parse(json(value));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const waiters = new Set();
let server, serverClosed, bot, agent, task, activeOperation, interval;
let output = '', phase = 'setup', nativeActive = false, runCreated = false;
let interruption = '', serverSpawnError, botFailure, initialHashes, result;
let cleanupPromise;
let lastSummary = 0;
const sourceFiles = ['runtime.js', 'protocolCompatibility.js', 'vendor/server/minecraftTaskAgent.js',
  'vendor/server/minecraft/estateFarm.js', 'vendor/server/minecraft/estateNativeAdapter.js'];
// This component does not execute estateBuilder/estateBlueprints/estateMaterials.
// Their parallel implementation is outside this predeclared component freeze.
function sourceHashes() {
  return { ...Object.fromEntries(sourceFiles.map(file => [file, hash(path.join(runtime, file))])),
    privateHarness: hash(__filename) };
}
function record(type, data = {}) {
  const event = clone({ at: new Date().toISOString(), elapsedMs: Date.now() - start, phase, type, ...data });
  if (runCreated) fs.appendFileSync(path.join(runDir, 'events.jsonl'), json(event) + '\n');
  return event;
}
function interrupt(signal) {
  if (interruption) return;
  interruption = signal;
  record('interruption_requested', { signal, nativeActive });
  if (agent) Promise.resolve(agent.handleMessage({ type: 'mc_command_pause' })).catch(error => record('pause_error', { message: error.message }));
}
process.once('SIGTERM', () => interrupt('SIGTERM'));
process.once('SIGINT', () => interrupt('SIGINT'));
function check() {
  if (interruption) throw new Error(`Harness interrupted: ${interruption}`);
  if (serverSpawnError) throw serverSpawnError;
  if (botFailure) throw botFailure;
  if (server && (server.exitCode !== null || server.signalCode !== null)) throw new Error('Official server exited before controlled stop');
}
async function until(predicate, description, ms = 20_000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    check();
    if (Date.now() >= end) throw new Error(`Timed out: ${description}`);
    await sleep(50);
  }
}
async function bounded(promise, description, ms = 20_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), ms);
  })]); } finally { clearTimeout(timer); }
}
function checkWaiters() {
  for (const waiter of waiters) {
    const found = output.slice(waiter.from).match(waiter.pattern);
    if (!found) continue;
    clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(found[0]);
  }
}
function readback(pattern, from = output.length, ms = 30_000) {
  return new Promise((resolve, reject) => {
    const waiter = { pattern, from, resolve, reject };
    waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Console readback timed out: ${pattern}`)); }, ms);
    waiters.add(waiter); checkWaiters();
  });
}
function command(text) {
  assert.ok(server?.stdin.writable && !server.killed, 'Server stdin unavailable');
  assert.ok(!nativeActive || text === 'stop', 'ZERO console commands during production native farm actions');
  record('server_command', { command: text, nativeActive });
  server.stdin.write(text + '\n');
}
async function batch(commands, label) {
  check();
  const marker = `DESKPET_FARM_${label}_${Date.now()}_${output.length}`;
  const from = output.length;
  const finished = readback(new RegExp(marker), from);
  commands.forEach(command); command(`say ${marker}`);
  await finished;
  const text = output.slice(from);
  fs.appendFileSync(path.join(runDir, 'server-readback.log'), `\n# ${phase}: ${label}\n${text}`);
  return text;
}
function inventory() {
  return bot.inventory.items().map(item => ({ name: item.name, count: item.count, slot: item.slot })).sort((a, b) => a.slot - b.slot);
}
function counts(items = inventory()) {
  return items.reduce((out, item) => { out[item.name] = (out[item.name] || 0) + item.count; return out; }, {});
}
function parseInventory(text) {
  const line = text.split('\n').find(entry => /has the following entity data: \[(?:\{|\])/.test(entry));
  assert.ok(line, 'Authoritative inventory readback absent');
  const snbt = line.slice(line.indexOf('entity data: ') + 'entity data: '.length);
  const entries = [];
  let depth = 0, begin = 0, quoted = false, escaped = false;
  for (let index = 0; index < snbt.length; index += 1) {
    const char = snbt[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === '\\') { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (char === '{' && depth++ === 0) begin = index;
    if (char === '}' && --depth === 0) entries.push(snbt.slice(begin, index + 1));
  }
  return entries.map(entry => {
    const name = entry.match(/\bid:\s*"minecraft:([^"]+)"/)?.[1];
    const count = Number(entry.match(/\bcount:\s*(\d+)/)?.[1]);
    const savedSlot = Number(entry.match(/\bSlot:\s*(-?\d+)b/)?.[1]);
    assert.ok(name && Number.isInteger(count) && Number.isInteger(savedSlot), 'Malformed inventory SNBT');
    return { name, count, slot: savedSlot >= 0 && savedSlot <= 8 ? savedSlot + 36 : savedSlot };
  }).sort((a, b) => a.slot - b.slot);
}
async function readInventory(label) {
  const attempts = [];
  const end = Date.now() + 2000;
  while (true) {
    const text = await batch([`data get entity ${username} Inventory`], label);
    const authoritative = parseInventory(text), client = inventory();
    attempts.push({ client, authoritative, text });
    if (json(client) === json(authoritative)) return { confirmed: true, client, authoritative, attempts };
    if (Date.now() >= end) assert.deepEqual(client, authoritative, 'Client inventory must match actual server slots');
    await sleep(100);
  }
}
const pointKey = p => `${p.x},${p.y},${p.z}`;
const observe = block => block ? { name: block.name, stateId: block.stateId, position: block.position, properties: block.getProperties() } : null;
function farmSpec() {
  return { schema: 1, id: runName, plots: [3, 10].map((x, index) => {
    const water = { x, y: -61, z: 3 }, soil = [], access = [];
    for (let dx = -2; dx <= 2; dx += 1) for (let dz = -2; dz <= 2; dz += 1) {
      if (dx || dz) soil.push({ x: x + dx, y: -61, z: 3 + dz });
    }
    for (let step = -3; step <= 3; step += 1) {
      access.push({ x: x + step, y: -60, z: 0 }, { x: x + step, y: -60, z: 6 },
        { x: x - 3, y: -60, z: 3 + step }, { x: x + 3, y: -60, z: 3 + step });
    }
    return { id: `farm-${index + 1}`, component: `farm-${index + 1}`, water, soil, access,
      crops: soil.map(p => ({ soilPosition: p, position: { ...p, y: p.y + 1 }, item: 'wheat_seeds', block: 'wheat' })) };
  }) };
}
function observedFarm(spec) {
  const block = p => observe(bot.blockAt(new Vec3(p.x, p.y, p.z)));
  return spec.plots.map(plot => ({ id: plot.id, water: block(plot.water),
    soil: plot.soil.map(block), crops: plot.crops.map(crop => block(crop.position)) }));
}
function snapshot(force = false) {
  if (!bot?.entity || !task) return;
  const state = clone({ position: bot.entity.position, onGround: bot.entity.onGround, food: bot.food, health: bot.health,
    inventory: inventory(), task: { taskId: task.taskId, status: task.status, progressText: task.progressText }, checkpoint: task.stepCheckpoint?.estateFarm });
  record('snapshot', state);
  if (force || Date.now() - lastSummary > 15_000) {
    lastSummary = Date.now();
    console.log(json({ elapsedSeconds: Math.floor((Date.now() - start) / 1000), phase,
      farmPhase: state.checkpoint?.phase, position: state.position, health: state.health, food: state.food,
      water: state.checkpoint?.waterSources?.length, tilled: state.checkpoint?.tilledSoil?.length, planted: state.checkpoint?.plantedCrops?.length }));
  }
}
async function runNative(label, options) {
  phase = label; nativeActive = true;
  record('native_stage_started', { options: options || null, position: bot.entity.position, inventory: inventory() });
  activeOperation = Promise.resolve(agent.__testEstateFarm(result.spec, options));
  try {
    const value = await bounded(activeOperation, label, timeoutMs);
    check(); snapshot(true);
    record('native_stage_completed', { value, position: bot.entity.position, inventory: inventory(), checkpoint: task.stepCheckpoint?.estateFarm });
    return clone(value);
  } finally { nativeActive = false; }
}
async function main() {
  if (argv.includes('--help')) {
    console.log('Private official vanilla farm integration: --accept-eula [--run-name estate-farm-01] [--timeout-ms 900000] [--hydration-timeout-ms 420000]. Fixed two 5x5 plots; controlled materials; component native hooks, not public estate acceptance.');
    return;
  }
  assert.ok(argv.includes('--accept-eula'), 'Explicit local official-server EULA flag required');
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 30_000 && timeoutMs <= 1_800_000);
  assert.ok(Number.isFinite(hydrationTimeoutMs) && hydrationTimeoutMs >= 30_000 && hydrationTimeoutMs <= 600_000);
  assert.ok(!fs.existsSync(runDir), 'Never overwrite existing world or historical evidence');
  const { createMinecraftTaskAgent } = localRequire('./vendor/server/minecraftTaskAgent');
  const { CancellationToken } = localRequire('./vendor/server/minecraft/agentControl');
  const { withMinecraftProtocolCompatibility, installMinecraftBedWakeCompatibility } = localRequire('./protocolCompatibility');
  const { acknowledgePlayerLoaded } = localRequire('./runtime');
  const installed = JSON.parse(fs.readFileSync(path.join(installation, 'installation.json'), 'utf8'));
  assert.equal(installed.minecraft.version, '1.21.8');
  assert.ok(fs.existsSync(installed.java));
  assert.equal(crypto.createHash('sha1').update(fs.readFileSync(installed.minecraft.jar)).digest('hex'), installed.minecraft.serverDownload.sha1);
  initialHashes = sourceHashes();
  fs.mkdirSync(path.dirname(runDir), { recursive: true });
  fs.mkdirSync(runDir); runCreated = true;
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  result = { schema: 1, mode: 'controlled-native-estate-farm-component', runName, runDir, port, spec: farmSpec(),
    fixtureLimits: 'Fresh normal Survival superflat with normal randomTickSpeed=3, noon and mob/day/weather cycles held. Before native build, grant two water buckets, one iron hoe, iron shovel, dirt reserve, 48 seeds and food. After build is frozen and authoritative hydration is observed, grant eight bone meal and four reserve seeds for explicit native validation. No zero-resource acquisition or completed public estate task claim. No task bot teleport, block/world/physics override, or task-time console commands.',
    taskBotTeleported: false, publicTaskSubmitted: false, publicTaskCompleted: false,
    fixtureResources: { water_bucket: 2, iron_hoe: 1, iron_shovel: 1, dirt: 48, wheat_seeds: 48, cooked_porkchop: 16 },
    validationResources: { bone_meal: 8, wheat_seeds: 4 }, deaths: 0 };
  const properties = { 'server-ip': '127.0.0.1', 'server-port': port, 'online-mode': false, 'enforce-secure-profile': false,
    'level-name': 'world', 'level-type': 'minecraft:flat', 'level-seed': 42,
    'generator-settings': json({ layers: [{ block: 'minecraft:bedrock', height: 1 }, { block: 'minecraft:dirt', height: 2 },
      { block: 'minecraft:grass_block', height: 1 }], biome: 'minecraft:plains', structures: {} }),
    difficulty: 'normal', gamemode: 'survival', 'force-gamemode': true, 'max-players': 1, 'view-distance': 6, 'simulation-distance': 4,
    'spawn-protection': 0, 'allow-flight': false, 'sync-chunk-writes': true, 'pause-when-empty-seconds': 0 };
  fs.writeFileSync(path.join(runDir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(runDir, 'server.properties'), Object.entries(properties).map(([name, value]) => `${name}=${value}`).join('\n') + '\n');
  record('run_started', { ...result, properties, sourceHashes: initialHashes, java: installed.java,
    minecraftVersion: installed.minecraft.version, jarSha1: installed.minecraft.serverDownload.sha1 });
  server = spawn(installed.java, ['-Xms512M', '-Xmx1G', '-jar', installed.minecraft.jar, 'nogui'], { cwd: runDir, stdio: ['pipe', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(runDir, 'server.log'));
  serverClosed = new Promise(resolve => {
    server.once('error', error => {
      serverSpawnError = error; record('server_spawn_error', { message: error.message });
      for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(error); } waiters.clear();
    });
    server.once('close', (code, signal) => { log.end(); record('server_closed', { code, signal }); resolve({ code, signal }); });
  });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { log.write(chunk); output += chunk.toString(); checkWaiters(); });
  await readback(/Done \([^)]+\)! For help/, 0, 180_000);
  await batch(['gamerule doMobSpawning false', 'gamerule doDaylightCycle false', 'gamerule doWeatherCycle false',
    'gamerule randomTickSpeed 3', 'gamerule spawnRadius 0', 'time set noon', 'weather clear', 'setworldspawn 0 -60 0'], 'CONTROLLED_WORLD_READY');
  bot = mineflayer.createBot(withMinecraftProtocolCompatibility({ host: '127.0.0.1', port, username, auth: 'offline', version: '1.21.8', hideErrors: false }));
  bot.on('error', error => { botFailure = error; record('bot_error', { message: error.message, stack: error.stack }); });
  bot.on('kicked', reason => { botFailure = new Error(`Bot kicked: ${json(reason)}`); record('bot_kicked', { reason }); });
  await bounded(once(bot, 'spawn'), 'actual farm bot spawn', 60_000);
  installMinecraftBedWakeCompatibility(bot);
  await bounded(bot.waitForChunksToLoad(), 'actual farm chunks loaded', 60_000);
  record('player_loaded_acknowledgement', { sent: await acknowledgePlayerLoaded(bot) });
  await until(() => bot.entity.onGround, 'actual spawn landing');
  assert.equal(bot.game.gameMode, 'survival'); assert.equal(inventory().length, 0);
  result.initialEmptySpawn = clone({ position: bot.entity.position, onGround: bot.entity.onGround, mode: bot.game.gameMode, inventory: inventory() });
  record('empty_survival_spawn', result.initialEmptySpawn);
  await batch(Object.entries(result.fixtureResources).map(([name, count]) => `give ${username} ${name} ${count}`), 'CONTROLLED_MATERIALS');
  await until(() => Object.entries(result.fixtureResources).every(([name, count]) => counts()[name] === count), 'controlled resources arrived');
  result.beforeBuildInventory = await readInventory('PRE_BUILD_INVENTORY');
  result.beforeBuildBlocks = observedFarm(result.spec);
  for (const plot of result.beforeBuildBlocks) {
    assert.equal(plot.water?.name, 'grass_block');
    assert.ok(plot.soil.every(block => block?.name === 'grass_block'));
    assert.ok(plot.crops.every(block => block?.name === 'air'));
  }
  const tracked = new Set(result.spec.plots.flatMap(plot => [plot.water, ...plot.soil, ...plot.crops.map(crop => crop.position)]).map(pointKey));
  bot.on('blockUpdate', (before, after) => { if (after && tracked.has(pointKey(after.position)) && before?.stateId !== after.stateId)
    record('actual_block_update', { before: observe(before), after: observe(after), playerPosition: bot.entity.position }); });
  bot.on('diggingCompleted', block => record('native_dig_completed', { block: observe(block), position: bot.entity.position }));
  bot.on('heldItemChanged', () => record('held_item_changed', { heldItem: bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count } : null }));
  bot.inventory.on('updateSlot', (slot, before, after) => record('inventory_delta', { slot,
    before: before ? { name: before.name, count: before.count } : null, after: after ? { name: after.name, count: after.count } : null }));
  bot.on('death', () => { result.deaths += 1; record('bot_death', { position: bot.entity.position }); interrupt('BOT_DEATH'); });
  agent = createMinecraftTaskAgent({ appPaths: { appDataDir: path.join(runDir, 'deskpet-data') },
    readConfig: () => ({ mcExecutorMode: 'strict-executor', mcAgentAutoReconnect: false }), parseJsonObjectFromText: JSON.parse,
    broadcast: event => record('agent_event', { event }), broadcastMinecraftError: message => record('agent_error', { message }),
    allowAutonomousMaintenance: () => false,
    requestPlannerCompletion: async () => { throw new Error('No AI provider authorized for deterministic farm integration'); } });
  agent.attachBot(bot); agent.initializeBotRuntime();
  task = { taskId: runName, status: 'running', source: 'deskpet', intent: 'component-native-farm', executionGeneration: 0,
    cancellationToken: new CancellationToken(), logs: [], createdAt: Date.now(), startedAt: Date.now(), stepCheckpoint: {}, plan: { steps: [] } };
  agent.__testSetReconnectTask(task);
  task.movementLease = agent.__testClaimMovementLease('task', task.taskId);
  interval = setInterval(() => { try { snapshot(); } catch (error) { botFailure = error; } }, 500);
  result.build = await runNative('native_component_build');
  phase = 'independent_build_readback';
  result.buildCheckpoint = clone(task.stepCheckpoint.estateFarm);
  result.buildBlocks = observedFarm(result.spec);
  result.afterBuildInventory = await readInventory('POST_BUILD_INVENTORY');
  const beforeCounts = counts(result.beforeBuildInventory.client), afterCounts = counts(result.afterBuildInventory.client);
  assert.equal(beforeCounts.water_bucket - (afterCounts.water_bucket || 0), 2);
  assert.equal((afterCounts.bucket || 0) - (beforeCounts.bucket || 0), 2);
  assert.equal(beforeCounts.wheat_seeds - (afterCounts.wheat_seeds || 0), 48);
  assert.ok(afterCounts.dirt >= beforeCounts.dirt && afterCounts.dirt <= beforeCounts.dirt + 2, 'Natural water-hole dirt drops may add up to two dirt; no soil replacement should consume dirt');
  phase = 'vanilla_hydration';
  await until(() => result.spec.plots.every(plot => plot.soil.every(p => {
    const block = bot.blockAt(new Vec3(p.x, p.y, p.z));
    return block?.name === 'farmland' && Number(block.getProperties().moisture) === 7;
  })), 'all 48 actual farmland moisture=7 at vanilla randomTickSpeed=3', hydrationTimeoutMs);
  result.hydratedBlocks = observedFarm(result.spec);
  const conditions = result.spec.plots.flatMap(plot => [
    `execute if block ${plot.water.x} ${plot.water.y} ${plot.water.z} water[level=0] run say FARM_SOURCE_${plot.id}`,
    ...plot.soil.map((p, index) => `execute if block ${p.x} ${p.y} ${p.z} farmland[moisture=7] run say FARM_HYDRATED_${plot.id}_${index}`),
    ...plot.crops.map((crop, index) => `execute if block ${crop.position.x} ${crop.position.y} ${crop.position.z} wheat run say FARM_PLANTED_${plot.id}_${index}`) ]);
  const hydrationReadback = await batch(conditions, 'AUTHORITATIVE_FARM_HYDRATION');
  for (const plot of result.spec.plots) {
    assert.match(hydrationReadback, new RegExp(`FARM_SOURCE_${plot.id}\\s*\\r?\\n`));
    for (let index = 0; index < 24; index += 1) {
      assert.match(hydrationReadback, new RegExp(`FARM_HYDRATED_${plot.id}_${index}\\s*\\r?\\n`));
      assert.match(hydrationReadback, new RegExp(`FARM_PLANTED_${plot.id}_${index}\\s*\\r?\\n`));
    }
  }
  result.hydrationReadback = hydrationReadback;
  phase = 'controlled_validation_resources';
  await batch(Object.entries(result.validationResources).map(([name, count]) => `give ${username} ${name} ${count}`), 'POST_BUILD_VALIDATION_MATERIALS');
  await until(() => counts().bone_meal === 8 && counts().wheat_seeds === 4, 'post-build controlled bone meal and reserve seeds');
  result.beforeValidationInventory = await readInventory('PRE_VALIDATION_INVENTORY');
  result.validation = await runNative('native_post_build_validation', { postPublicTask: true, allowBoneMeal: true });
  phase = 'independent_final_readback';
  result.validationCheckpoint = clone(task.stepCheckpoint.estateFarm);
  result.finalBlocks = observedFarm(result.spec);
  result.finalInventory = await readInventory('FINAL_SERVER_INVENTORY');
  result.finalHealth = { health: bot.health, food: bot.food, position: clone(bot.entity.position), onGround: bot.entity.onGround };
  record('all_native_stages_finished', { build: result.build, validation: result.validation, checkpoint: result.validationCheckpoint });
}
function closedServer() { return server && (server.exitCode !== null || server.signalCode !== null); }
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    clearInterval(interval);
    phase = 'cleanup';
    if (agent) {
      try { await agent.handleMessage({ type: 'mc_command_pause' }); }
      catch (error) { record('cleanup_pause_error', { message: error.message }); }
    }
    if (activeOperation) await Promise.race([activeOperation.catch(() => {}), sleep(6000)]);
    nativeActive = false;
    if (agent) {
      try { agent.__testSetReconnectTask(null); agent.detachBot('manual_disconnect'); }
      catch (error) { record('cleanup_agent_error', { message: error.message }); }
      finally { try { agent.dispose(); } catch (error) { record('cleanup_dispose_error', { message: error.message }); } }
    }
    try { bot?.pathfinder?.setGoal(null); bot?.clearControlStates(); bot?.quit('Controlled native farm integration ended'); }
    catch (error) { record('cleanup_bot_error', { message: error.message }); }
    const termination = [];
    if (server && !closedServer() && !serverSpawnError) {
      try { command('stop'); } catch (error) { record('cleanup_stop_error', { message: error.message }); }
      await Promise.race([serverClosed, sleep(30_000)]);
      if (!closedServer()) { termination.push('SIGTERM'); server.kill('SIGTERM'); await Promise.race([serverClosed, sleep(5000)]); }
      if (!closedServer()) { termination.push('SIGKILL'); server.kill('SIGKILL'); await Promise.race([serverClosed, sleep(5000)]); }
    }
    if (serverClosed && closedServer()) await serverClosed;
    for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('Harness cleanup ended console wait')); }
    waiters.clear();
    if (result) {
      result.lifecycle = { stoppedAt: new Date().toISOString(), ownedServerPid: server?.pid || null,
        serverStopped: Boolean(closedServer()), serverExitCode: server?.exitCode ?? null,
        serverExitSignal: server?.signalCode ?? null, forcedTermination: termination,
        serverSpawnError: serverSpawnError?.message || null };
      result.elapsedMs = Date.now() - start;
      result.interruption = interruption || null;
      result.sourceHashes = { started: initialHashes, ended: sourceHashes() };
      fs.writeFileSync(path.join(runDir, 'server-lifecycle.json'), json(result.lifecycle, 2) + '\n', { flag: 'wx' });
      fs.writeFileSync(path.join(runDir, 'result.json'), json(result, 2) + '\n', { flag: 'wx' });
    }
  })();
  return cleanupPromise;
}
async function audit() {
  const criteria = {
    harnessFinishedWithoutError: !result.harnessFailure && !result.interruption,
    normalOfficialServerStop: result.lifecycle?.serverStopped === true && result.lifecycle.serverExitCode === 0
      && !result.lifecycle.serverExitSignal && !result.lifecycle.forcedTermination.length,
    frozenSourceHashes: json(result.sourceHashes?.started) === json(result.sourceHashes?.ended),
    componentBuildVerified: result.build?.farmVerified === true && result.buildCheckpoint?.buildSummary?.farmVerified === true,
    buildInventoryServerConfirmed: result.beforeBuildInventory?.confirmed === true && result.afterBuildInventory?.confirmed === true,
    postBuildValidationInventoryServerConfirmed: result.beforeValidationInventory?.confirmed === true && result.finalInventory?.confirmed === true,
    actualTwoBucketDebits: false, actualFortyEightSeedDebits: false, naturalSoilTilledWithoutDirtReplacement: false,
    nativeBuildNoConsoleCommands: false, nativeValidationNoConsoleCommands: false,
    nativeFixedPlotHarvestReplant: false, noBotDeath: result.deaths === 0,
    hydratedServerReadback: Boolean(result.hydrationReadback),
    savedVanillaSurvivalNormal: false, savedVanillaRandomTicksDefault: false,
    savedTwoStationaryWaterSources: false, savedFortyEightHydratedFarmland: false,
    savedFortyEightWheat: false, savedReplantedTargets: false, noUnexpectedSavedWater: false,
  };
  const before = result.beforeBuildInventory?.client && counts(result.beforeBuildInventory.client);
  const after = result.afterBuildInventory?.client && counts(result.afterBuildInventory.client);
  criteria.actualTwoBucketDebits = Boolean(before && after && (before.water_bucket || 0) - (after.water_bucket || 0) === 2
    && (after.bucket || 0) - (before.bucket || 0) === 2);
  criteria.actualFortyEightSeedDebits = Boolean(before && after && (before.wheat_seeds || 0) - (after.wheat_seeds || 0) === 48);
  criteria.naturalSoilTilledWithoutDirtReplacement = Boolean(before && after && after.dirt >= before.dirt && after.dirt <= before.dirt + 2); 
  const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const buildUpdates = events.filter(event => event.phase === 'native_component_build' && event.type === 'actual_block_update');
  const waterCenters = result.spec.plots.map(plot => pointKey(plot.water));
  criteria.naturalSoilTilledWithoutDirtReplacement = criteria.naturalSoilTilledWithoutDirtReplacement
    && waterCenters.every(center => buildUpdates.some(event => pointKey(event.after.position) === center && event.before?.name === 'grass_block' && event.after.name === 'air'))
    && !buildUpdates.some(event => event.after.name === 'dirt');
  const stages = events.filter(event => event.type === 'native_stage_completed');
  const starts = events.filter(event => event.type === 'native_stage_started');
  const consoleEvents = events.filter(event => event.type === 'server_command');
  const noConsole = stage => {
    const begin = starts.find(event => event.phase === stage), end = stages.find(event => event.phase === stage);
    return Boolean(begin && end && !consoleEvents.some(event => event.elapsedMs >= begin.elapsedMs && event.elapsedMs <= end.elapsedMs));
  };
  criteria.nativeBuildNoConsoleCommands = noConsole('native_component_build');
  criteria.nativeValidationNoConsoleCommands = noConsole('native_post_build_validation');
  const cycles = result.validation?.cycles || [];
  const targets = result.spec.plots.map(plot => plot.crops[0].position);
  criteria.nativeFixedPlotHarvestReplant = result.validation?.validationVerified === true && cycles.length === 2
    && targets.every(target => cycles.some(cycle => pointKey(cycle.position) === pointKey(target)
      && cycle.confirmed === true && cycle.ageMature === 7 && cycle.wheatCollected >= 1 && cycle.boneMealUsed >= 1
      && cycle.seedConsumedForReplant === 1 && cycle.ageAfterReplant === 0));
  let saved = null, level = null, auditError = null;
  if (criteria.normalOfficialServerStop) {
    try {
      const { readAnvilBlock, readLevelMetadata } = localRequire('./test-support/natural-world-audit.cjs');
      const world = path.join(runDir, 'world');
      level = await readLevelMetadata(world);
      saved = [];
      for (const plot of result.spec.plots) {
        const water = await readAnvilBlock(world, plot.water), soil = [], crops = [], surroundings = [];
        for (const p of plot.soil) soil.push(await readAnvilBlock(world, p));
        for (const crop of plot.crops) crops.push(await readAnvilBlock(world, crop.position));
        for (let dx = -3; dx <= 3; dx += 1) for (let dz = -3; dz <= 3; dz += 1) {
          const p = { x: plot.water.x + dx, y: plot.water.y, z: plot.water.z + dz };
          if (dx || dz) surroundings.push(await readAnvilBlock(world, p));
        }
        saved.push({ id: plot.id, water, soil, crops, surroundings });
      }
      criteria.savedVanillaSurvivalNormal = level.gameType === 0 && level.difficulty === 2 && !level.hardcore;
      criteria.savedVanillaRandomTicksDefault = String(level.gameRules?.randomTickSpeed) === '3';
      criteria.savedTwoStationaryWaterSources = saved.length === 2 && saved.every(plot => plot.water.name === 'minecraft:water' && Number(plot.water.properties.level) === 0);
      criteria.savedFortyEightHydratedFarmland = saved.flatMap(plot => plot.soil).length === 48
        && saved.every(plot => plot.soil.every(block => block.name === 'minecraft:farmland' && Number(block.properties.moisture) === 7));
      criteria.savedFortyEightWheat = saved.every(plot => plot.crops.length === 24 && plot.crops.every(block => block.name === 'minecraft:wheat'
        && Number(block.properties.age) >= 0 && Number(block.properties.age) <= 7));
      criteria.savedReplantedTargets = targets.every(target => saved.flatMap(plot => plot.crops).some(block => pointKey(block.position) === pointKey(target)
        && block.name === 'minecraft:wheat' && Number(block.properties.age) >= 0 && Number(block.properties.age) <= 7));
      criteria.noUnexpectedSavedWater = saved.every(plot => plot.surroundings.every(block => block.name !== 'minecraft:water'));
    } catch (error) { auditError = { message: error.message, stack: error.stack }; }
  }
  const unmetCriteria = Object.entries(criteria).filter(([, passed]) => passed !== true).map(([name]) => name);
  const report = { schema: 1, auditedAt: new Date().toISOString(), mode: result.mode, runDir,
    acceptancePassed: unmetCriteria.length === 0 && !auditError, criteria, unmetCriteria, auditError,
    evidenceLimits: 'Component native integration with explicit controlled resources. Not a completed public estate build, natural acquisition, client GUI or visual aesthetic acceptance.',
    level, actualSavedPlots: saved, nativeValidationCycles: cycles, sourceHashes: result.sourceHashes };
  fs.writeFileSync(path.join(runDir, 'farm-independent-audit.json'), json(report, 2) + '\n', { flag: 'wx' });
  console.log(json({ runDir, acceptancePassed: report.acceptancePassed, unmetCriteria, auditError }));
  if (!report.acceptancePassed) process.exitCode = 1;
}
main().catch(error => {
  console.error(error.stack || error); process.exitCode = 1;
  if (result) result.harnessFailure = { message: error.message, code: error.code, stack: error.stack };
  if (runCreated) record('harness_failure', { message: error.message, code: error.code, stack: error.stack });
}).finally(async () => {
  try { await cleanup(); if (result) await audit(); }
  catch (error) { console.error(error.stack || error); process.exitCode = 1;
    if (runCreated) record('post_stop_audit_error', { message: error.message, stack: error.stack }); }
});
