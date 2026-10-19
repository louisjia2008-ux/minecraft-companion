/* global process, console, __dirname, __filename, require, module, setTimeout, clearTimeout, setInterval, clearInterval */
'use strict';
// PRIVATE controlled vanilla Survival estate acceptance. Public construction
// uses actual native interactions and external authorized supply chests only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const runtime = path.resolve(__dirname, '../personal-ai-deskpet-electron-work/electron/minecraft-runtime');
const runtimeRequire = createRequire(path.join(runtime, 'package.json'));
const { Vec3 } = runtimeRequire('vec3');
const mineflayer = runtimeRequire('mineflayer');
const nbt = runtimeRequire('prismarine-nbt');
const { pathfinder, Movements, goals } = runtimeRequire('mineflayer-pathfinder');
const { createMinecraftTaskAgent, configureFurnishedHouseDoorTraversal } = runtimeRequire('./vendor/server/minecraftTaskAgent');
const { CancellationToken } = runtimeRequire('./vendor/server/minecraft/agentControl');
const { createEstateBlueprint, getEstateMaterialBudget, getEstateFarmBudget } = runtimeRequire('./vendor/server/minecraft/estateBlueprints');
const { planEstateDoorClosure } = runtimeRequire('./vendor/server/minecraft/estateDoorClosure');
const { acknowledgePlayerLoaded } = runtimeRequire('./runtime');
const { withMinecraftProtocolCompatibility, installMinecraftBedWakeCompatibility } = runtimeRequire('./protocolCompatibility');
const { matches, effectiveBookshelves } = runtimeRequire('./test-support/furnished-house-audit.cjs');
const { readRegionChunk, decodeSectionBlock, blockLocation, readLevelMetadata } = runtimeRequire('./test-support/natural-world-audit.cjs');
const argv = process.argv.slice(2);
const arg = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const installation = path.resolve(arg('--installation', __dirname));
const profile = arg('--profile', 'medieval_castle');
assert.ok(['medieval_castle', 'riverside_villa'].includes(profile), 'Use medieval_castle or riverside_villa');
const runName = arg('--run-name', `estate-${profile}-${Date.now()}`);
assert.match(runName, /^[a-zA-Z0-9_-]+$/);
const runDir = path.join(installation, 'worlds', runName);
const timeoutMs = Number(arg('--timeout-ms', 7_200_000));
const username = 'DeskPetEstate';
const anchor = { x: 4, y: -60, z: 4 };
const blueprint = createEstateBlueprint(anchor, { profile });
const supplyPositions = Array.from({ length: 8 }, (_, i) => ({ x: -4, y: -60, z: -8 + i * 2 }));
const publicCommand = `用补给箱里的材料在 4 -60 4 建造${profile === 'medieval_castle' ? '中世纪城堡' : '河畔木屋别墅'}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (value, indent) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, indent);
const clone = (value) => JSON.parse(json(value));
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const start = Date.now();
const events = [];
const waiters = new Set();
const interruptWaiters = new Set();
let server;
let bot;
let agent;
let output = '';
let phase = 'setup';
let constructionActive = false;
let interval;
let rawTask;
let snapshotError;
let lastReport = 0;
let deaths = 0;
let result;
let initialHashes;
let runCreated = false;
let interruptRequested = '';
let serverExitPromise;
let serverClosePromise;
let logFinishedPromise;
let serverClosed = false;
const forcedTerminations = [];

function requestControlledStop(signal) {
  if (interruptRequested) return;
  interruptRequested = signal;
  if (runCreated) record('harness_stop_requested', { signal, constructionActive });
  // During construction the main loop freezes the unfinished outcome, then
  // invokes the public pause API. Outside it, fail the current console wait.
  if (!constructionActive) {
    for (const reject of interruptWaiters) reject(new Error(`Harness interrupted: ${signal}`));
    for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new Error(`Harness interrupted: ${signal}`)); }
    waiters.clear();
  }
}
process.once('SIGINT', () => requestControlledStop('SIGINT'));
process.once('SIGTERM', () => requestControlledStop('SIGTERM'));

function sourceHashes() {
  const files = ['runtime.js', 'protocolCompatibility.js', 'vendor/server/minecraftTaskAgent.js',
    'vendor/server/minecraft/furnishedHouseBlueprints.js', 'vendor/server/minecraft/furnishedHouseBuilder.js',
    'vendor/server/minecraft/estateBlueprints.js', 'vendor/server/minecraft/estateBuilder.js',
    'vendor/server/minecraft/estateMaterials.js', 'vendor/server/minecraft/estateNativeAdapter.js',
    'vendor/server/minecraft/estateFarm.js', 'vendor/server/action/actionRegistry.js',
    'vendor/server/minecraft/estateDoorClosure.js', 'vendor/server/minecraft/estateNativeInteractions.js',
    'vendor/server/minecraft/commandPlanner.js', 'test-support/natural-world-audit.cjs',
    'test-support/furnished-house-audit.cjs'];
  return { ...Object.fromEntries(files.map(file => [file, hash(path.join(runtime, file))])),
    'estate-native-server.cjs': hash(__filename) };
}
function record(type, data = {}) {
  const event = clone({ at: new Date().toISOString(), elapsedMs: Date.now() - start, phase, type, ...data });
  events.push(event);
  fs.appendFileSync(path.join(runDir, 'events.jsonl'), json(event) + '\n');
  return event;
}
function checkWaiters() {
  for (const waiter of waiters) {
    const match = output.slice(waiter.from).match(waiter.pattern);
    if (!match) continue;
    clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(match[0]);
  }
}
function readback(pattern, from = output.length, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const waiter = { pattern, from, resolve, reject };
    waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Console readback timed out: ${pattern}`)); }, timeout);
    waiters.add(waiter); checkWaiters();
  });
}
function command(text) {
  assert.ok(server?.stdin.writable && !server.killed, 'Server stdin unavailable');
  assert.ok(!constructionActive || text === 'stop', 'ZERO console commands during production construction');
  record('server_command', { command: text, constructionActive });
  server.stdin.write(text + '\n');
}
async function batch(commands, label) {
  const marker = `DESKPET_ESTATE_${label}_${events.length}`;
  const from = output.length;
  const finished = readback(new RegExp(marker), from);
  commands.forEach(command); command(`say ${marker}`); await finished;
  const text = output.slice(from);
  fs.appendFileSync(path.join(runDir, 'server-readback.log'), `\n# ${phase}: ${label}\n${text}`);
  return text;
}
async function until(predicate, description, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (interruptRequested) throw new Error(`Harness interrupted: ${interruptRequested}`);
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    if (bot && bot._client.state !== 'play') throw new Error(`Disconnected during ${description}`);
    await sleep(100);
  }
}
async function bounded(promise, description, ms = 20_000) {
  let timer;
  let rejectInterrupted;
  const interrupted = new Promise((_resolve, reject) => {
    rejectInterrupted = reject;
    interruptWaiters.add(reject);
    if (interruptRequested && !constructionActive) reject(new Error(`Harness interrupted: ${interruptRequested}`));
  });
  try { return await Promise.race([promise, interrupted, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), ms); })]); }
  finally { clearTimeout(timer); interruptWaiters.delete(rejectInterrupted); }
}
function inventory() {
  return bot.inventory.items().map((item) => ({ name: item.name, count: item.count, slot: item.slot,
    ...(item.components?.length ? { components: clone(item.components) } : {}) })).sort((a, b) => a.slot - b.slot);
}
function counts(items = inventory()) {
  return items.reduce((sum, item) => { sum[item.name] = (sum[item.name] || 0) + item.count; return sum; }, {});
}
function parseInventory(text) {
  const line = text.split('\n').find((entry) => /has the following entity data: \[(?:\{|\])/.test(entry));
  assert.ok(line, 'Authoritative vanilla inventory readback absent');
  const snbt = line.slice(line.indexOf('entity data: ') + 'entity data: '.length);
  const entries = [];
  let depth = 0; let begin = 0; let quoted = false; let escaped = false;
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
    const savedSlot = Number(entry.match(/\bSlot:\s*(-?\d+)b/)?.[1]);
    assert.ok(name && Number.isInteger(count) && Number.isInteger(savedSlot), 'Malformed inventory SNBT');
    const slot = savedSlot >= 0 && savedSlot <= 8 ? savedSlot + 36 : savedSlot;
    return { name, count, slot, raw: entry };
  }).sort((a, b) => a.slot - b.slot);
}
function observed(block) {
  return block ? { name: block.name, stateId: block.stateId, properties: block.getProperties(), position: block.position } : null;
}
function snapshot(force = false) {
  if (!bot?.entity || !agent) return;
  rawTask = agent.__testGetReconnectTask() || rawTask;
  const checkpoint = rawTask?.stepCheckpoint?.estate;
  if (checkpoint?.anchor && !result.blueprint) {
    assert.deepEqual(checkpoint.anchor, anchor, 'The public command fixes the exact construction anchor');
    assert.equal(checkpoint.sourceProfile, profile, 'The public command fixes the complete estate profile');
    result.blueprint = clone(createEstateBlueprint(checkpoint.anchor, { profile }));
    record('actual_selected_estate_anchor', { anchor: checkpoint.anchor, blueprint: result.blueprint });
  }
  record('snapshot', { position: bot.entity.position, onGround: bot.entity.onGround, health: bot.health, food: bot.food,
    inventory: inventory(), task: { taskId: rawTask?.taskId, status: rawTask?.status, intent: rawTask?.intent,
      progressText: rawTask?.progressText, error: rawTask?.error }, checkpoint });
  if (force || Date.now() - lastReport > 15_000) {
    lastReport = Date.now();
    console.log(json({ elapsedSeconds: Math.floor((Date.now() - start) / 1000), profile, phase: checkpoint?.phase,
      status: rawTask?.status, progress: rawTask?.progressText, error: rawTask?.error,
      position: bot.entity.position, placed: checkpoint?.ownedBlockIds?.length, health: bot.health, food: bot.food }));
  }
}
async function readInventory(label) {
  const deadline = Date.now() + 2000;
  const attempts = [];
  while (true) {
    const text = await batch([`data get entity ${username} Inventory`], label);
    const authoritative = parseInventory(text);
    const client = inventory();
    const compact = (items) => items.map(({ name, count, slot }) => ({ name, count, slot }));
    attempts.push({ client: compact(client), authoritative: compact(authoritative), text });
    if (json(compact(client)) === json(compact(authoritative))) return { confirmed: true, client, authoritative, text, attempts };
    if (Date.now() >= deadline) assert.deepEqual(compact(client), compact(authoritative), 'Client inventory must equal server slots');
    // Console and native click packets can reach different tick queues. Observe
    // their convergence without resending any craft/transfer/use action.
    await sleep(100);
  }
}
async function walk(position) {
  record('furniture_use_walk_requested', { target: position, playerPosition: bot.entity.position });
  await bounded(bot.pathfinder.goto(new goals.GoalBlock(position.x, position.y, position.z)), 'safe furniture-use walk', 25_000);
  await until(() => bot.entity.onGround, 'furniture-use landing', 2000);
  record('furniture_use_walk_completed', { target: position, playerPosition: bot.entity.position });
}
const block = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));
const key = p => `${p.x},${p.y},${p.z}`;
const air = b => ['air', 'cave_air', 'void_air'].includes(String(b?.name || '').replace(/^minecraft:/, ''));
const inside = (p, bounds) => p.x >= bounds.minX && p.x <= bounds.maxX && p.y >= bounds.minY && p.y <= bounds.maxY && p.z >= bounds.minZ && p.z <= bounds.maxZ;

function newAgent(directory) {
  return createMinecraftTaskAgent({ appPaths: { appDataDir: path.join(runDir, directory) },
    readConfig: () => ({ mcExecutorMode: 'strict-executor', mcAgentAutoReconnect: false }),
    parseJsonObjectFromText: JSON.parse, broadcast: event => record('agent_event', { event }),
    broadcastMinecraftError: message => record('agent_error', { message }), allowAutonomousMaintenance: () => false,
    requestPlannerCompletion: async () => { throw new Error('No AI provider authorized for deterministic estate acceptance'); } });
}
function disposeCurrentAgent() {
  const old = agent; agent = null;
  if (!old) return;
  try { old.detachBot('manual_disconnect'); }
  catch (error) { record('cleanup_error', { operation: 'detachBot', message: error.message }); }
  finally {
    try { old.dispose(); }
    catch (error) { record('cleanup_error', { operation: 'dispose', message: error.message }); }
  }
}
function installUseMovements() {
  bot.pathfinder.setGoal(null); bot.clearControlStates();
  const movements = configureFurnishedHouseDoorTraversal(new Movements(bot));
  movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false;
  movements.maxDropDown = 2; movements.allowFreeMotion = false; movements.scafoldingBlocks = [];
  movements.allowSprinting = false;
  for (const name of ['lava', 'water', 'fire', 'cactus', 'magma_block', 'powder_snow']) movements.blocksToAvoid.add(bot.registry.blocksByName[name].id);
  bot.pathfinder.setMovements(movements);
}
async function approach(position) {
  const target = new Vec3(position.x, position.y, position.z);
  await bounded(bot.pathfinder.goto(new goals.GoalLookAtBlock(target, bot.world, { reach: 4.5 })), `approach ${key(position)}`, 30_000);
  await until(() => bot.entity.onGround, 'actual interaction landing', 2500);
  const distance = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0).distanceTo(target.offset(0.5, 0.5, 0.5));
  assert.ok(distance <= 4.8, 'Actual native interaction must remain in server reach');
}
async function doorState(door, open) {
  await approach(door.lower);
  if (block(door.lower).getProperties().open !== open) await bot.activateBlock(block(door.lower));
  await until(() => block(door.lower).getProperties().open === open && block(door.upper).getProperties().open === open, 'both real door halves', 3000);
}
function standingEvidence() {
  const e = bot.entity; const p = e.position; const half = (e.width || 0.6) / 2;
  let support = false;
  for (let x = Math.floor(p.x - half); x <= Math.floor(p.x + half); x += 1) for (let z = Math.floor(p.z - half); z <= Math.floor(p.z + half); z += 1) {
    for (let y = Math.floor(p.y - 0.06); y <= Math.floor(p.y + (e.height || 1.8)); y += 1) {
      const cell = block({ x, y, z });
      if (!cell || ['water', 'lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'powder_snow'].includes(cell.name) || cell.getProperties().waterlogged === true) return { confirmed: false };
      for (const shape of cell.shapes || []) {
        if (p.x + half <= x + shape[0] || p.x - half >= x + shape[3] || p.z + half <= z + shape[2] || p.z - half >= z + shape[5]) continue;
        const top = y + shape[4];
        if (Math.abs(p.y - top) <= 0.08) support = true;
        if (p.y + 0.02 < top && p.y + (e.height || 1.8) > y + shape[1] + 0.02) return { confirmed: false };
      }
    }
  }
  return { confirmed: support && e.onGround === true, actual: clone(p), onGround: e.onGround };
}
async function closeDoorFromDeclaredSide(step) {
  const p = step.approach;
  const surfaces = [];
  for (let y = p.y - 2; y <= p.y; y += 1) {
    const support = block({ x: p.x, y, z: p.z });
    if (!support || ['water', 'lava', 'magma_block', 'cactus', 'powder_snow'].includes(support.name)) continue;
    for (const shape of support.shapes || []) {
      if (shape[0] < 0.8 && shape[3] > 0.2 && shape[2] < 0.8 && shape[5] > 0.2) surfaces.push(y + shape[4]);
    }
  }
  const candidates = [...new Set(surfaces)].filter(y => Math.abs(y - p.y) <= 1.1).sort((a, b) => Math.abs(a - p.y) - Math.abs(b - p.y));
  assert.ok(candidates.length, 'Declared door side has no loaded real standing surface');
  // Use the real loaded support height. Native pathfinder and physics choose
  // the stance; no look-at goal may move us across the door afterwards.
  const feetY = candidates[0];
  await walk({ x: p.x, y: Math.floor(feetY), z: p.z });
  const direction = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }[step.door.facing];
  const validateSide = () => {
    const stance = standingEvidence();
    const dot = (bot.entity.position.x - step.door.lower.x - 0.5) * direction[0]
      + (bot.entity.position.z - step.door.lower.z - 0.5) * direction[1];
    assert.equal(stance.confirmed, true, 'Door closure requires actual dry onGround support');
    assert.ok(Math.hypot(bot.entity.position.x - p.x - 0.5, bot.entity.position.z - p.z - 0.5) <= 0.8, 'Must stand at the declared approach cell');
    assert.ok(step.side === 'outside' ? dot > 0.35 : dot < -0.35, 'Must remain on the declared door-facing side');
    return { ...stance, facingDot: dot, side: step.side, target: p, observedSupportY: feetY };
  };
  const before = validateSide();
  if (block(step.door.lower).getProperties().open !== false) {
    await bot.lookAt(new Vec3(step.door.lower.x + 0.5, step.door.lower.y + 0.5, step.door.lower.z + 0.5), false);
    validateSide();
    await bot.activateBlock(block(step.door.lower));
  }
  await until(() => block(step.door.lower).getProperties().open === false && block(step.door.upper).getProperties().open === false, 'declared-side native door closure', 3000);
  const after = validateSide();
  const evidence = { door: step.door, escapePurpose: step.escapePurpose, before, after,
    lower: observed(block(step.door.lower)), upper: observed(block(step.door.upper)) };
  record('declared_side_door_closure_confirmed', evidence);
  return evidence;
}
async function useFurniture() {
  phase = 'independent_native_use';
  record('post_public_fixtures_started', { boundary: 'All grants, night and XP are separate post-public use fixtures, never construction evidence.' });
  const publicFarmCheckpoint = clone(result.task.stepCheckpoint?.estateFarm || null);
  disposeCurrentAgent();
  installUseMovements();
  const b = result.blueprint; const f = b.furniture;
  const use = result.furnitureUse = {};
  const attempt = async (name, operation) => {
    if (interruptRequested) throw new Error(`Post-public test interrupted: ${interruptRequested}`);
    try { use[name] = await operation(); record('native_use_confirmed', { name, evidence: use[name] }); }
    catch (error) {
      if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
      bot.clearControlStates(); bot.pathfinder.setGoal(null);
      use[name] = { confirmed: false, error: error.message, stack: error.stack };
      record('native_use_failed', { name, ...use[name] });
    }
  };
  await attempt('routes', async () => {
    for (const door of f.doors) await doorState(door, true);
    const traversed = [];
    for (const route of b.routes) {
      const points = [];
      for (const point of route.waypoints) {
        await walk(point);
        assert.ok(Math.hypot(bot.entity.position.x - point.x - 0.5, bot.entity.position.z - point.z - 0.5) <= 0.85 && Math.abs(bot.entity.position.y - point.y) <= 1.1);
        points.push({ target: point, actual: clone(bot.entity.position), onGround: bot.entity.onGround });
      }
      traversed.push({ id: route.id, confirmed: true, points });
    }
    return { confirmed: traversed.length === b.routes.length, traversed };
  });
  await attempt('crafting', async () => {
    await batch([`give ${username} oak_planks 3`, `give ${username} stick 2`], 'POSTPUBLIC_CRAFT_INPUTS');
    await until(() => (counts().oak_planks || 0) >= 3 && (counts().stick || 0) >= 2, '3x3 crafting inputs');
    await approach(f.craftingTable);
    const before = counts();
    const recipe = bot.recipesFor(bot.registry.itemsByName.wooden_pickaxe.id, null, 1, block(f.craftingTable))[0];
    assert.ok(recipe?.requiresTable, 'Actual 3x3 workbench recipe is mandatory');
    await bounded(bot.craft(recipe, 1, block(f.craftingTable)), 'actual estate table crafting');
    const after = counts();
    assert.equal((after.wooden_pickaxe || 0) - (before.wooden_pickaxe || 0), 1);
    assert.equal(before.oak_planks - (after.oak_planks || 0), 3);
    assert.equal(before.stick - (after.stick || 0), 2);
    return { confirmed: true, before, after, server: await readInventory('CRAFT_SERVER_CONFIRMED') };
  });
  await attempt('chest', async () => {
    await batch([`give ${username} gold_ingot 2`], 'POSTPUBLIC_CHEST_MARKER');
    await until(() => (counts().gold_ingot || 0) >= 2, 'chest marker');
    await approach(f.chest);
    const gold = bot.registry.itemsByName.gold_ingot.id;
    let chest = await bounded(bot.openContainer(block(f.chest)), 'estate chest open');
    await bounded(chest.deposit(gold, null, 2), 'native gold deposit'); chest.close();
    chest = await bounded(bot.openContainer(block(f.chest)), 'fresh server chest deposit readback');
    const deposited = chest.containerItems().filter(i => i.name === 'gold_ingot').reduce((n, i) => n + i.count, 0);
    assert.equal(deposited, 2);
    await bounded(chest.withdraw(gold, null, 1), 'native gold withdrawal'); chest.close();
    chest = await bounded(bot.openContainer(block(f.chest)), 'fresh server chest withdrawal readback');
    const items = chest.containerItems().map(i => ({ name: i.name, count: i.count, slot: i.slot }));
    assert.equal(items.filter(i => i.name === 'gold_ingot').reduce((n, i) => n + i.count, 0), 1); chest.close();
    return { confirmed: true, deposited, remainder: 1, freshServerItems: items, server: await readInventory('CHEST_SERVER_CONFIRMED') };
  });
  await attempt('furnace', async () => {
    await batch([`give ${username} raw_iron 1`, `give ${username} coal 1`], 'POSTPUBLIC_SMELT_INPUTS');
    await until(() => (counts().raw_iron || 0) >= 1 && (counts().coal || 0) >= 1, 'smelt inputs');
    await approach(f.furnace);
    const before = counts(); const furnace = await bounded(bot.openFurnace(block(f.furnace)), 'actual estate furnace');
    await furnace.putInput(bot.registry.itemsByName.raw_iron.id, null, 1);
    await furnace.putFuel(bot.registry.itemsByName.coal.id, null, 1);
    await until(() => furnace.outputItem()?.name === 'iron_ingot', 'real vanilla smelt', 20_000);
    const outputItem = clone({ name: furnace.outputItem().name, count: furnace.outputItem().count });
    const lit = block(f.furnace).getProperties().lit;
    await furnace.takeOutput(); furnace.close();
    const after = counts(); assert.equal((after.iron_ingot || 0) - (before.iron_ingot || 0), 1); assert.equal(lit, true);
    return { confirmed: true, before, after, outputItem, lit, server: await readInventory('SMELT_SERVER_CONFIRMED') };
  });
  await attempt('bed', async () => {
    await batch(['gamerule playersSleepingPercentage 101', 'time set 13000'], 'POSTPUBLIC_NIGHT');
    await until(() => bot.time.timeOfDay >= 12541, 'nighttime client update');
    await approach(f.bed.foot);
    await bounded(bot.sleep(block(f.bed.foot)), 'actual estate bed sleep', 5000);
    assert.equal(bot.isSleeping, true);
    const text = await batch([`execute if block ${f.bed.head.x} ${f.bed.head.y} ${f.bed.head.z} white_bed[occupied=true] run say DESKPET_ESTATE_BED_OCCUPIED_CONFIRMED`], 'BED_SERVER_CONFIRMED');
    assert.ok(text.includes('DESKPET_ESTATE_BED_OCCUPIED_CONFIRMED'));
    await bot.wake(); await until(() => !bot.isSleeping, 'actual bed wake', 5000);
    return { confirmed: true, serverOccupiedReadback: text, woke: true };
  });
  await attempt('enchanting', async () => {
    await batch([`give ${username} diamond_sword 1`, `give ${username} lapis_lazuli 3`, `experience set ${username} 30 levels`], 'POSTPUBLIC_ENCHANT_INPUT_XP');
    await until(() => (counts().diamond_sword || 0) >= 1 && (counts().lapis_lazuli || 0) >= 3 && bot.experience.level >= 30, 'enchant fixture');
    await approach(f.enchantingTable);
    const beforeLevel = bot.experience.level; const beforeLapis = counts().lapis_lazuli;
    const table = await bounded(bot.openEnchantmentTable(block(f.enchantingTable)), 'actual estate enchanting table');
    await table.putTargetItem(bot.currentWindow.items().find(i => i.name === 'diamond_sword'));
    await table.putLapis(bot.currentWindow.items().find(i => i.name === 'lapis_lazuli'));
    await until(() => table.enchantments?.[2]?.level === 30, 'real third level-30 option');
    const options = clone(table.enchantments);
    await bounded(table.enchant(2), 'native third level-30 enchant', 8000);
    await until(() => table.targetItem()?.components?.some(i => /enchantments/.test(i.type)), 'server enchanted component');
    const enchanted = clone(table.targetItem().components); await table.takeTargetItem(); table.close();
    await until(() => bot.experience.level === beforeLevel - 3, 'actual XP deduction');
    const afterLapis = counts().lapis_lazuli || 0; assert.equal(beforeLapis - afterLapis, 3);
    const server = await readInventory('ENCHANT_SERVER_CONFIRMED');
    assert.ok(server.authoritative.some(i => i.name === 'diamond_sword' && i.raw.includes('minecraft:enchantments')));
    return { confirmed: true, options, beforeLevel, afterLevel: bot.experience.level, beforeLapis, afterLapis, enchanted, server };
  });
  await attempt('farm', async () => {
    await batch([`give ${username} bone_meal 64`, `give ${username} wheat_seeds 8`, 'time set noon'], 'POSTPUBLIC_FARM_VALIDATION_INPUTS');
    await until(() => (counts().bone_meal || 0) >= 64 && (counts().wheat_seeds || 0) >= 8, 'farm validation inputs');
    assert.ok(publicFarmCheckpoint?.specFingerprint, 'The actual public task farm checkpoint must be captured');
    agent = newAgent('post-public-farm-data'); agent.attachBot(bot); agent.initializeBotRuntime();
    const task = { taskId: 'post-public-native-farm-validation', source: 'explicit-post-public-fixture', intent: 'estate_farm_validation',
      status: 'running', executionGeneration: 0, logs: [], currentStepIndex: 0, startedAt: Date.now(),
      cancellationToken: new CancellationToken(), plan: { steps: [] }, stepCheckpoint: { estateFarm: clone(publicFarmCheckpoint) } };
    agent.__testSetReconnectTask(task);
    task.movementLease = agent.__testClaimMovementLease('task', task.taskId);
    record('independent_farm_component_started', { taskId: task.taskId, source: task.source, copiedPublicCheckpoint: publicFarmCheckpoint });
    const spec = { schema: 1, id: `${profile}:${key(b.anchor)}:farms`, plots: b.farms };
    try {
      const summary = await bounded(agent.__testEstateFarm(spec, { postPublicTask: true, allowBoneMeal: true }), 'native farm grow harvest pickup and replant', 180_000);
      assert.equal(summary.validationVerified, true); assert.equal(summary.cycles.length, 2);
      for (const cycle of summary.cycles) {
        assert.equal(cycle.ageMature, 7); assert.equal(cycle.ageAfterReplant, 0);
        assert.equal(cycle.seedConsumedForReplant, 1); assert.ok(cycle.wheatCollected >= 1);
      }
      task.status = 'completed';
      const checkpoint = clone(task.stepCheckpoint.estateFarm);
      return { confirmed: true, summary, checkpoint, server: await readInventory('FARM_SERVER_CONFIRMED') };
    } finally {
      task.cancellationToken.cancel('cancelled');
      agent.__testSetReconnectTask(null);
      disposeCurrentAgent(); installUseMovements();
    }
  });
  await attempt('doorClosure', async () => {
    const closure = planEstateDoorClosure(b);
    const steps = [];
    for (const step of closure) steps.push(await closeDoorFromDeclaredSide(step));
    assert.ok(f.doors.every(d => block(d.lower).getProperties().open === false && block(d.upper).getProperties().open === false));
    return { confirmed: true, steps, doors: f.doors.map(d => ({ lower: observed(block(d.lower)), upper: observed(block(d.upper)) })) };
  });
  record('post_public_native_use_finished', { furnitureUse: use });
}
async function main() {
  if (argv.includes('--help')) { console.log('PRIVATE official vanilla estate test: --accept-eula --profile medieval_castle|riverside_villa --run-name UNIQUE [--timeout-ms 7200000]; --check-fixture performs offline contract checks only'); return; }
  if (argv.includes('--check-fixture')) { console.log(json(checkFixtureContract())); return; }
  assert.ok(argv.includes('--accept-eula'), 'Pass --accept-eula for the authorized local official server');
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 30_000 && timeoutMs <= 7_200_000);
  assert.ok(!fs.existsSync(runDir), 'Never overwrite an existing world or acceptance report');
  const installed = JSON.parse(fs.readFileSync(path.join(installation, 'installation.json'), 'utf8'));
  const java = installed.java; const jar = installed.minecraft.jar; const version = installed.minecraft.version;
  assert.equal(version, '1.21.8'); assert.ok(fs.existsSync(java) && fs.existsSync(jar));
  fs.mkdirSync(path.dirname(runDir), { recursive: true });
  fs.mkdirSync(runDir); runCreated = true;
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const materialBudget = getEstateMaterialBudget(blueprint);
  const farmBudget = getEstateFarmBudget(blueprint);
  const fixtureBudget = { ...materialBudget };
  for (const [item, count] of Object.entries(farmBudget)) if (item !== 'bone_meal') fixtureBudget[item] = (fixtureBudget[item] || 0) + count;
  fixtureBudget.iron_hoe = 1;
  result = { mode: 'controlled-real-estate', profile, publicCommand, runDir, port,
    fixtureLimits: 'Fresh superflat Normal Survival world. Finished building/scaffold/farm materials reside only in <=8 recorded single supply chests outside workBounds, selected by native authorized nearby supply discovery. Only iron tools and food are granted to the player before submission; initial empty inventory is independently recorded. Villa river_surface is a declared pretask terrain fixture. No prebuilt structure/farm/furniture, no task-bot teleport, no console or resource/state intervention during public construction. Post-public craft/smelt/chest/XP/night/bone-meal fixtures are separate use tests. No from-zero material acquisition claim.',
    constructionMaterialBudget: fixtureBudget, materialBudget, farmBudget, expectedBlueprint: clone(blueprint), supplyPositions, furnitureUse: {}, taskBotTeleported: false };
  const properties = { 'server-ip': '127.0.0.1', 'server-port': port, 'online-mode': false, 'enforce-secure-profile': false,
    'level-name': 'world', 'level-type': 'minecraft:flat', 'level-seed': 42,
    'generator-settings': json({ layers: [{ block: 'minecraft:bedrock', height: 1 }, { block: 'minecraft:dirt', height: 2 },
      { block: 'minecraft:grass_block', height: 1 }], biome: 'minecraft:plains', structures: {} }),
    difficulty: 'normal', gamemode: 'survival', 'force-gamemode': true, 'max-players': 1, 'view-distance': 6, 'simulation-distance': 4,
    'spawn-protection': 0, 'allow-flight': false, 'sync-chunk-writes': true, 'pause-when-empty-seconds': 0 };
  fs.writeFileSync(path.join(runDir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(runDir, 'server.properties'), Object.entries(properties).map(([name, value]) => `${name}=${value}`).join('\n') + '\n');
  initialHashes = sourceHashes();
  record('run_started', { ...result, properties, sourceHashes: initialHashes, version, jarSha256: hash(jar) });
  server = spawn(java, ['-Xms512M', '-Xmx1G', '-jar', jar, 'nogui'], { cwd: runDir, stdio: ['pipe', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(runDir, 'server.log'));
  logFinishedPromise = new Promise(resolve => log.once('finish', resolve));
  let resolveExit;
  serverExitPromise = new Promise(resolve => { resolveExit = resolve; });
  serverClosePromise = new Promise(resolve => server.once('close', (code, signal) => {
    serverClosed = true; log.end();
    record('server_close', { code, signal, ownedPid: server.pid }); resolve({ code, signal });
  }));
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { log.write(chunk); output += chunk.toString(); checkWaiters(); });
  server.once('exit', (code, signal) => { record('server_exit', { code, signal, ownedPid: server.pid }); resolveExit({ code, signal }); });
  server.once('error', error => {
    result.serverSpawnError = { message: error.message, code: error.code }; record('server_spawn_error', result.serverSpawnError);
    resolveExit({ error: error.message });
    for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(error); } waiters.clear();
  });
  await readback(/Done \([^)]+\)! For help/, 0, 180_000);
  await batch(['gamerule doMobSpawning false', 'gamerule doDaylightCycle false', 'gamerule doWeatherCycle false',
    'gamerule spawnRadius 0', 'time set noon', 'weather clear', 'setworldspawn 0 -60 0'], 'CONTROLLED_WORLD_READY');
  bot = mineflayer.createBot(withMinecraftProtocolCompatibility({ host: '127.0.0.1', port, username, auth: 'offline', version, hideErrors: false }));
  bot.on('error', (error) => record('bot_error', { message: error.message, stack: error.stack }));
  bot.on('kicked', (reason) => record('bot_kicked', { reason }));
  await bounded(once(bot, 'spawn'), 'real house player spawn', 60_000);
  installMinecraftBedWakeCompatibility(bot);
  await bounded(bot.waitForChunksToLoad(), 'real loaded construction chunks', 60_000);
  record('player_loaded_acknowledgement', { sent: await acknowledgePlayerLoaded(bot), version: bot.version });
  result.initialGameMode = bot.game.gameMode; assert.equal(bot.game.gameMode, 'survival'); assert.equal(inventory().length, 0);
  record('initial_empty_spawn', { position: bot.entity.position, mode: bot.game.gameMode, inventory: inventory() });
  await initializeTerrainAndSupplies(fixtureBudget);
  await batch([`give ${username} iron_pickaxe 1`, `give ${username} iron_axe 1`, `give ${username} iron_shovel 1`, `give ${username} cooked_porkchop 64`], 'PRETASK_AUXILIARY_TOOLS_AND_FOOD');
  await until(() => counts().iron_pickaxe === 1 && counts().cooked_porkchop === 64, 'explicit auxiliary tool and food fixture');
  assert.ok(Object.keys(fixtureBudget).every(name => !(counts()[name] > 0)), 'Building and farm materials must be in supply chests, not injected into player inventory');
  await readInventory('PRETASK_RESOURCE_SLOTS');
  bot.on('death', () => { deaths += 1; record('bot_death', { position: bot.entity.position }); });
  bot.on('diggingCompleted', (cell) => record('digging_completed', { position: cell.position, name: cell.name, playerPosition: bot.entity.position }));
  bot.on('blockUpdate', (before, after) => { if (before && after && before.stateId !== after.stateId)
    record('block_update', { before: observed(before), after: observed(after), playerPosition: bot.entity.position }); });
  bot.on('blockPlaced', (cell) => record('block_placed', { block: observed(cell), playerPosition: bot.entity.position }));
  bot.inventory.on('updateSlot', (slot, before, after) => record('inventory_delta', { slot,
    before: before ? { name: before.name, count: before.count } : null, after: after ? { name: after.name, count: after.count, components: after.components } : null }));
  bot._client.on('packet', (data, meta) => {
    if (['window_items', 'set_slot', 'craft_progress_bar', 'experience'].includes(meta.name)) record('server_protocol', { name: meta.name, data });
  });
  agent = newAgent('deskpet-data');
  agent.attachBot(bot); agent.initializeBotRuntime();
  if (interruptRequested) throw new Error(`Harness interrupted before submission: ${interruptRequested}`);
  phase = 'production_construction'; constructionActive = true; result.taskSubmittedAt = Date.now() - start;
  record('task_submitted', { command: publicCommand, initialInventory: inventory(), position: bot.entity.position });
  await agent.handleMessage({ type: 'mc_command_submit', command: publicCommand, source: 'deskpet' });
  interval = setInterval(() => { try { snapshot(); } catch (error) { snapshotError = error; } }, 500);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (snapshotError) throw snapshotError;
    snapshot();
    if (interruptRequested) break;
    if (rawTask && ['completed', 'paused', 'failed', 'cancelled'].includes(rawTask.status)) break;
    if (deaths || bot._client.state !== 'play') break;
    await sleep(500);
  }
  clearInterval(interval); snapshot(true);
  result.task = clone({ taskId: rawTask?.taskId, status: rawTask?.status, intent: rawTask?.intent,
    error: rawTask?.error, plan: rawTask?.plan, stepCheckpoint: rawTask?.stepCheckpoint });
  if (rawTask?.status === 'running') await agent.handleMessage({ type: 'mc_command_pause' });
  result.taskEndedAt = Date.now() - start; constructionActive = false;
  result.playerUuid = bot._client.uuid || bot.uuid || bot.entity.uuid;
  record('construction_outcome_frozen_before_readback', { task: result.task, inventory: inventory(), position: bot.entity.position });
  result.constructionMismatches = result.blueprint?.blocks.flatMap((expected) => {
    const actual = observed(block(expected.position));
    return matches(actual, expected.item, expected.properties) ? [] : [{ expected, actual }];
  }) || null;
  result.constructionInventory = await readInventory('CONSTRUCTION_SERVER_SLOTS');
  if (result.task.status === 'completed') await useFurniture();
  result.finalInventory = await readInventory('FINAL_SERVER_SLOTS');
  result.finalFarmStates = result.blueprint?.farms.map(plot => ({ id: plot.id, water: observed(block(plot.water)), soil: plot.soil.map(p => observed(block(p))), crops: plot.crops.map(c => observed(block(c.position))) }));
}
async function cleanup() {
  clearInterval(interval); constructionActive = false; phase = 'cleanup';
  disposeCurrentAgent();
  try { bot?.pathfinder?.setGoal(null); bot?.clearControlStates(); bot?.quit('Controlled estate acceptance complete'); } catch { /* retain original failure */ }
  async function closedWithin(ms) {
    let timer;
    try { return await Promise.race([serverClosePromise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
    finally { clearTimeout(timer); }
  }
  if (server) {
    if (!serverClosed && server.exitCode === null && server.signalCode === null && server.stdin.writable && !server.killed) command('stop');
    if (!await closedWithin(30_000)) {
      forcedTerminations.push({ signal: 'SIGTERM', ownedPid: server.pid, at: new Date().toISOString(), delivered: server.kill('SIGTERM') });
      record('owned_server_forced_termination', forcedTerminations.at(-1));
      if (!await closedWithin(5000)) {
        forcedTerminations.push({ signal: 'SIGKILL', ownedPid: server.pid, at: new Date().toISOString(), delivered: server.kill('SIGKILL') });
        record('owned_server_forced_termination', forcedTerminations.at(-1));
        if (!await closedWithin(5000)) throw new Error('Owned official server failed to close after stop/TERM/KILL; no final audit is permitted');
      }
    }
    await serverExitPromise;
    let logTimer;
    try {
      await Promise.race([logFinishedPromise, new Promise((_resolve, reject) => {
        logTimer = setTimeout(() => reject(new Error('Server log did not finish after actual close')), 5000);
      })]);
    } finally { clearTimeout(logTimer); }
  }
  if (server) fs.writeFileSync(path.join(runDir, 'server-lifecycle.json'), json({ stoppedAt: new Date().toISOString(),
    serverStopped: serverClosed, ownedPid: server.pid, forcedTerminations,
    serverExitCode: server.exitCode, serverExitSignal: server.signalCode }, 2) + '\n', { flag: 'wx' });
  for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('Acceptance ended')); } waiters.clear();
  if (result) {
    result.deaths = deaths; result.elapsedMs = Date.now() - start;
    result.interruptionRequested = interruptRequested || null;
    result.sourceHashes = { started: initialHashes, ended: sourceHashes() };
    fs.writeFileSync(path.join(runDir, 'result.json'), json(result, 2) + '\n', { flag: 'wx' });
  }
}

async function initializeTerrainAndSupplies(budget) {
  phase = 'pretask_controlled_terrain_and_supplies';
  // Surface height is -61. Only the declared villa water surface replaces
  // terrain; no building, crop, tilled soil, furniture or support is prebuilt.
  const terrainCommands = [];
  for (const zone of blueprint.waterZones) {
    assert.equal(zone.id, 'river_surface'); assert.equal(zone.expectedBlock, 'water');
    const b = zone.bounds;
    assert.equal(b.minY, anchor.y - 1); assert.equal(b.maxY, anchor.y - 1);
    for (const dry of blueprint.siteRequirements.dryGroundCells) assert.equal(inside(dry, b), false, 'River fixture must not replace required dry support');
    terrainCommands.push(`fill ${b.minX} ${b.minY} ${b.minZ} ${b.maxX} ${b.maxY} ${b.maxZ} minecraft:water[level=0]`);
  }
  if (terrainCommands.length) await batch(terrainCommands, 'DECLARED_RIVER_SURFACE_ONLY');
  const slots = [];
  for (const [item, amount] of Object.entries(budget)) {
    const size = bot.registry.itemsByName[item]?.stackSize;
    assert.ok(Number.isInteger(size) && size > 0, `Unknown material ${item}`);
    for (let remaining = amount; remaining > 0; remaining -= size) slots.push({ item, count: Math.min(remaining, size) });
  }
  assert.ok(slots.length <= supplyPositions.length * 27, 'Materials exceed eight authorized single chests');
  const commands = [];
  for (const position of supplyPositions) {
    assert.equal(inside(position, blueprint.workBounds), false, 'Supply chest intersects construction work bounds');
    assert.ok(Math.hypot(position.x + 0.5 - bot.entity.position.x, position.z + 0.5 - bot.entity.position.z) <= 24);
    assert.ok(air(block(position)), 'Never overwrite existing chest or player structure');
    assert.equal(block({ ...position, y: position.y - 1 })?.name, 'grass_block');
    commands.push(`setblock ${position.x} ${position.y} ${position.z} minecraft:chest[facing=east,type=single]`);
  }
  const manifest = slots.map((slot, index) => ({ ...slot, position: supplyPositions[Math.floor(index / 27)], slot: index % 27 }));
  for (const slot of manifest) commands.push(`item replace block ${slot.position.x} ${slot.position.y} ${slot.position.z} container.${slot.slot} with minecraft:${slot.item} ${slot.count}`);
  result.pretaskSupplyManifest = clone(manifest);
  record('authorized_supply_fixture', { positions: supplyPositions, manifest, boundary: 'Finished materials in recorded external chests; no building blocks preplaced.' });
  await batch(commands, 'EXTERNAL_FINISHED_MATERIAL_SUPPLIES');
  await until(() => supplyPositions.every(p => block(p)?.name === 'chest'), 'server supply chest blocks');
  bot.loadPlugin(pathfinder); installUseMovements();
  const observedSupplies = [];
  for (const position of supplyPositions) {
    await approach(position);
    const chest = await bounded(bot.openContainer(block(position)), 'pretask native supply chest inspection');
    const items = chest.containerItems().map(i => ({ name: i.name, count: i.count, slot: i.slot }));
    chest.close(); observedSupplies.push({ position, items });
  }
  const actual = observedSupplies.flatMap(s => s.items).reduce((sum, item) => { sum[item.name] = (sum[item.name] || 0) + item.count; return sum; }, {});
  assert.deepEqual(actual, budget, 'Fresh native window_items must confirm every supplied material count');
  assert.equal(inventory().length, 0, 'Supply inspection must not transfer materials before the public task');
  result.pretaskSuppliesConfirmed = { confirmed: true, observedSupplies, totals: actual };
  await walk({ x: 0, y: -60, z: 0 });
  phase = 'setup';
}

function worldFileHashes(directory) {
  const result = {};
  const visit = (folder) => {
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      if (item.isDirectory()) visit(file);
      else if (item.isFile()) result[path.relative(directory, file)] = hash(file);
      else throw new Error('Independent world audit does not follow symlinks');
    }
  };
  visit(directory); return result;
}

async function auditEstate(directory) {
  const savedResult = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'));
  const lifecycle = JSON.parse(fs.readFileSync(path.join(directory, 'server-lifecycle.json'), 'utf8'));
  assert.ok(lifecycle.serverStopped && lifecycle.serverExitCode === 0 && !lifecycle.serverExitSignal, 'Only normally saved worlds can pass');
  assert.ok(savedResult.blueprint?.anchor, 'Do not infer an unobserved construction anchor');
  const world = path.join(directory, 'world'); const beforeWorld = worldFileHashes(world);
  const b = savedResult.blueprint; const chunks = new Map(); const cells = new Map(); const regions = new Map();
  const load = async position => {
    const loc = blockLocation(position); const chunkKey = `${loc.chunkX},${loc.chunkZ}`;
    if (!chunks.has(chunkKey)) {
      const saved = await readRegionChunk(world, position); chunks.set(chunkKey, saved); regions.set(saved.regionFile, hash(saved.regionFile));
    }
    const chunk = chunks.get(chunkKey).chunk;
    const section = chunk.sections.find(entry => entry.Y === loc.sectionY);
    const cell = section ? decodeSectionBlock(section, position) : { name: 'minecraft:air', properties: {}, absentAirSection: true };
    cells.set(key(position), { position, name: cell.name, properties: cell.properties });
  };
  const positions = new Map();
  const queue = p => positions.set(key(p), p);
  for (const spec of [...b.blocks, ...b.scaffold, ...b.clearance]) queue(spec.position);
  for (const plot of b.farms) { queue(plot.water); plot.soil.forEach(queue); plot.crops.forEach(c => queue(c.position)); }
  for (const zone of b.waterZones) for (let x = zone.bounds.minX; x <= zone.bounds.maxX; x += 1) for (let z = zone.bounds.minZ; z <= zone.bounds.maxZ; z += 1) queue({ x, y: zone.bounds.minY, z });
  for (const p of b.furniture.bookshelves) {
    const t = b.furniture.enchantingTable;
    for (const dy of [0, 1]) queue({ x: t.x + Math.trunc((p.x - t.x) / 2), y: t.y + dy, z: t.z + Math.trunc((p.z - t.z) / 2) });
  }
  // effectiveBookshelves independently scans both possible provider layers.
  const table = b.furniture.enchantingTable;
  for (let dx = -2; dx <= 2; dx += 1) for (let dz = -2; dz <= 2; dz += 1) for (const dy of [0, 1]) {
    queue({ x: table.x + dx, y: table.y + dy, z: table.z + dz });
  }
  for (const position of positions.values()) await load(position);
  const get = p => cells.get(key(p));
  const mismatches = b.blocks.flatMap(expected => {
    const properties = Object.fromEntries(Object.entries(expected.properties || {}).filter(([name]) => !['lit', 'occupied'].includes(name)));
    const actual = get(expected.position);
    return matches(actual, expected.item, properties) ? [] : [{ expected, actual }];
  });
  const scaffoldRemaining = b.scaffold.filter(s => !air(get(s.position)));
  const clearanceViolations = b.clearance.filter(s => !air(get(s.position)));
  const farms = b.farms.map(plot => ({ id: plot.id, water: get(plot.water),
    soil: plot.soil.map(get), crops: plot.crops.map(c => get(c.position)),
    sourceWater: matches(get(plot.water), 'water', { level: '0' }),
    hydratedSoil: plot.soil.filter(p => matches(get(p), 'farmland', { moisture: '7' })).length,
    planted: plot.crops.filter(c => matches(get(c.position), 'wheat') && Number.isInteger(Number(get(c.position).properties.age)) && Number(get(c.position).properties.age) >= 0 && Number(get(c.position).properties.age) <= 7).length }));
  const bookshelfEvidence = effectiveBookshelves(get, table);
  const metadata = await readLevelMetadata(world);
  const blockEntities = [...chunks.values()].flatMap(saved => saved.chunk.block_entities || []);
  const chestEntity = blockEntities.find(e => e.x === b.furniture.chest.x && e.y === b.furniture.chest.y && e.z === b.furniture.chest.z);
  const playerFiles = fs.readdirSync(path.join(world, 'playerdata')).filter(f => f.endsWith('.dat'));
  assert.equal(playerFiles.length, 1, 'Only the real construction player may enter this acceptance world');
  const player = nbt.simplify((await nbt.parse(fs.readFileSync(path.join(world, 'playerdata', playerFiles[0])))).parsed);
  const savedSword = player.Inventory?.find(i => i.id === 'minecraft:diamond_sword' && i.components?.['minecraft:enchantments']);
  const logged = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const interventions = logged.filter(e => e.type === 'server_command' && e.elapsedMs >= savedResult.taskSubmittedAt && e.elapsedMs < savedResult.taskEndedAt);
  const use = savedResult.furnitureUse || {}; const summary = savedResult.task?.stepCheckpoint?.estate?.verificationSummary;
  const sources = savedResult.sourceHashes;
  const criteria = {
    harnessFinished: !savedResult.harnessFailure && !savedResult.interruptionRequested,
    normallyStopped: lifecycle.serverExitCode === 0 && !lifecycle.serverExitSignal,
    noForcedServerTermination: lifecycle.forcedTerminations?.length === 0,
    cleanAgentShutdown: !logged.some(e => e.type === 'cleanup_error'),
    survivalNormalWorld: savedResult.initialGameMode === 'survival' && metadata.gameType === 0 && metadata.difficulty === 2,
    publicEstateCompleted: savedResult.task?.status === 'completed' && savedResult.task?.intent === 'build_estate',
    exactRequestedProfile: savedResult.task?.plan?.steps?.some(s => s.skill === 'build_estate' && s.args.profile === b.profile) === true,
    publicSummaryVerified: summary?.schema === 1 && summary.sourceProfile === b.profile && summary.furnitureVerified === true && summary.routeVerified === true && summary.farmVerified === true,
    initialExternalSuppliesConfirmed: savedResult.pretaskSuppliesConfirmed?.confirmed === true && savedResult.supplyPositions.length <= 8 && savedResult.supplyPositions.every(p => !inside(p, b.workBounds)),
    nativeSupplyTransferObserved: logged.some(e => e.type === 'inventory_delta' && e.after?.count > (e.before?.count || 0) && ['cobblestone', 'oak_planks'].includes(e.after.name)),
    noPublicConsoleInterventions: interventions.length === 0,
    noTaskBotTeleport: savedResult.taskBotTeleported === false && !logged.some(e => e.type === 'server_command' && /^(?:tp|teleport)\b/.test(e.command)),
    noDeaths: savedResult.deaths === 0,
    allConstructionStatesBeforeUse: savedResult.constructionMismatches?.length === 0,
    savedCompleteManifest: mismatches.length === 0,
    savedClearanceAir: clearanceViolations.length === 0,
    savedTemporaryScaffoldRemoved: scaffoldRemaining.length === 0,
    actualDeclaredRoutesWalked: use.routes?.confirmed === true && use.routes.traversed?.length === b.routes.length,
    actualNativeCraft: use.crafting?.confirmed === true,
    actualChestDepositWithdrawReopen: use.chest?.confirmed === true,
    savedChestMarker: (chestEntity?.Items || []).some(i => i.id === 'minecraft:gold_ingot' && i.count === 1),
    actualNativeSmelt: use.furnace?.confirmed === true,
    actualSleepServerOccupiedAndWake: use.bed?.confirmed === true,
    actualThirdLevel30Enchant: use.enchanting?.confirmed === true && use.enchanting.options?.[2]?.level === 30,
    savedEnchantedSword: Boolean(savedSword),
    fifteenEffectiveSavedBookshelves: bookshelfEvidence.effectiveCount === 15,
    allDoorsActuallyClosed: use.doorClosure?.confirmed === true && b.furniture.doors.every(d => matches(get(d.lower), 'oak_door', { open: false }) && matches(get(d.upper), 'oak_door', { open: false })),
    declaredDoorEscapeSidesObserved: use.doorClosure?.steps?.length === b.furniture.doors.length && use.doorClosure.steps.every(step =>
      [step.before, step.after].every(stance => stance.confirmed === true && stance.onGround === true
        && (stance.side === 'outside' ? stance.facingDot > 0.35 : stance.facingDot < -0.35))),
    allSavedFarmSourcesAndHydration: farms.length === 2 && farms.every(f => f.sourceWater && f.hydratedSoil === 24 && f.planted === 24),
    actualNativeGrowHarvestPickupReplant: use.farm?.confirmed === true && use.farm.summary?.cycles?.length === 2 && use.farm.summary.cycles.every(c => c.ageMature === 7 && c.ageAfterReplant === 0 && c.seedConsumedForReplant === 1 && c.wheatCollected >= 1),
    authoritativeInventoryReadbacks: savedResult.constructionInventory?.confirmed === true && savedResult.finalInventory?.confirmed === true,
    sourceHashesUnchanged: Boolean(sources?.started && Object.keys(sources.started).length >= 15 && json(sources.started) === json(sources.ended)),
    savedWorldReadOnlyAudit: true,
  };
  assert.deepEqual(worldFileHashes(world), beforeWorld, 'Independent MCA/player/level audit must not change any saved world byte');
  const report = { auditedAt: new Date().toISOString(), acceptancePassed: Object.values(criteria).every(Boolean),
    profile: b.profile, blueprintAnchor: b.anchor, lifecycle, runDir: directory, criteria,
    unmetCriteria: Object.entries(criteria).filter(([, passed]) => !passed).map(([name]) => name),
    fixtureLimits: savedResult.fixtureLimits, mismatches, scaffoldRemaining, clearanceViolations,
    farms, bookshelfEvidence, savedChestEntity: chestEntity, savedEnchantedSword: savedSword || null,
    worldMetadata: metadata, regionHashes: Object.fromEntries(regions), worldHashes: beforeWorld,
    furnitureUse: use, interventions, sourceHashes: sources,
    limitations: ['Finished construction resources were supplied in recorded external chests; this is not from-zero resource acquisition.',
      'River surface is a recorded pretask terrain fixture; no constructed estate or planted farm was prebuilt.',
      'Night/XP/craft/marker/smelt/bone-meal inputs occur only after the independently frozen public construction outcome.'] };
  fs.writeFileSync(path.join(directory, 'actual-estate-blocks.json'), json({ source: 'Normally stopped official Vanilla Anvil world', cells: [...cells.values()] }, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'estate-independent-audit.json'), json(report, 2) + '\n', { flag: 'wx' });
  return report;
}

if (require.main === module) main().catch(error => {
  console.error(error.stack || error); process.exitCode = 1;
  if (result) result.harnessFailure = { message: error.message, stack: error.stack };
  if (runCreated) record('harness_failure', { message: error.message, stack: error.stack });
}).finally(async () => {
  try {
    await cleanup();
    if (result?.blueprint) {
      const report = await auditEstate(runDir);
      console.log(json({ runDir, acceptancePassed: report.acceptancePassed, unmetCriteria: report.unmetCriteria }));
      if (!report.acceptancePassed) process.exitCode = 1;
    } else if (result) process.exitCode = 1;
  } catch (error) {
    console.error(error.stack || error); process.exitCode = 1;
    if (runCreated) record('post_stop_audit_failure', { message: error.message, stack: error.stack });
  }
});
module.exports = { auditEstate };

function checkFixtureContract() {
  const { createMinecraftActionRegistry } = runtimeRequire('./vendor/server/action/actionRegistry');
  const { createHeuristicPlanner } = runtimeRequire('./vendor/server/minecraft/commandPlanner');
  const actionRegistry = createMinecraftActionRegistry();
  const planner = createHeuristicPlanner({ actionRegistry });
  const selected = planner(publicCommand);
  assert.equal(selected.intent, 'build_estate'); assert.equal(selected.steps.length, 1);
  assert.deepEqual(selected.steps[0].args.anchor, anchor);
  assert.equal(selected.steps[0].args.profile, profile);
  assert.equal(selected.steps[0].args.useNearbySupplyChests, true);
  const b = blueprint.workBounds;
  assert.ok(supplyPositions.length <= 8 && supplyPositions.every(p => !inside(p, b)));
  for (let i = 0; i < supplyPositions.length; i += 1) for (let j = i + 1; j < supplyPositions.length; j += 1) {
    assert.ok(Math.hypot(supplyPositions[i].x - supplyPositions[j].x, supplyPositions[i].z - supplyPositions[j].z) >= 2);
  }
  for (const zone of blueprint.waterZones) {
    assert.equal(zone.id, 'river_surface');
    assert.ok(blueprint.siteRequirements.dryGroundCells.every(p => !inside(p, zone.bounds)));
  }
  const budget = getEstateMaterialBudget(blueprint); const farm = getEstateFarmBudget(blueprint);
  for (const [name, count] of Object.entries(farm)) if (name !== 'bone_meal') budget[name] = (budget[name] || 0) + count;
  budget.iron_hoe = 1;
  const registry = runtimeRequire('minecraft-data')('1.21.8');
  const closure = planEstateDoorClosure(blueprint);
  assert.equal(closure.length, blueprint.furniture.doors.length);
  const nativeBlock = runtimeRequire('prismarine-block')(registry);
  const manifest = new Map(blueprint.blocks.map(s => [key(s.position), s]));
  for (const step of closure) {
    let support = false;
    for (let y = step.approach.y - 2; y <= step.approach.y; y += 1) {
      const spec = manifest.get(key({ ...step.approach, y }));
      if (!spec) continue;
      const cell = nativeBlock.fromProperties(registry.blocksByName[spec.item].id, spec.properties || {}, 0);
      if (cell.shapes.some(s => s[0] < 0.8 && s[3] > 0.2 && s[2] < 0.8 && s[5] > 0.2 && Math.abs(y + s[4] - step.approach.y) <= 1.1)) support = true;
    }
    assert.ok(support, 'Every declared door approach has permanent native collision support');
  }
  const stacks = Object.entries(budget).reduce((sum, [name, count]) => sum + Math.ceil(count / registry.itemsByName[name].stackSize), 0);
  assert.ok(stacks <= 8 * 27);
  return { mode: 'OFFLINE_FIXTURE_CONTRACT_ONLY_NO_REAL_SERVER', profile, publicCommand, selectedPlan: selected,
    blocks: blueprint.blocks.length, scaffold: blueprint.scaffold.length, farms: blueprint.farms.length,
    supplyPositions, materialStacks: stacks, materialBudget: budget, doorClosure: closure, verified: true };
}
