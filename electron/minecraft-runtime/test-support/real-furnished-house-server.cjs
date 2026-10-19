/* global process, console, __dirname, setTimeout, clearTimeout, setInterval, clearInterval */
'use strict';

// Controlled real vanilla Survival construction acceptance. Finished materials
// are fixtures. No method, physics, player position or task step is replaced.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { once } = require('node:events');
const { Vec3 } = require('vec3');
const mineflayer = require('mineflayer');
const { Movements, goals } = require('mineflayer-pathfinder');
const { createMinecraftTaskAgent, configureFurnishedHouseDoorTraversal } = require('../vendor/server/minecraftTaskAgent');
const { createFurnishedHouseBlueprint, getFurnishedHouseMaterialBudget } = require('../vendor/server/minecraft/furnishedHouseBlueprints');
const { acknowledgePlayerLoaded } = require('../runtime');
const { withMinecraftProtocolCompatibility, installMinecraftBedWakeCompatibility } = require('../protocolCompatibility');
const { matches, auditHouse } = require('./furnished-house-audit.cjs');

const argv = process.argv.slice(2);
const arg = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const installation = path.resolve(arg('--installation', path.resolve(__dirname, '../../../.minecraft-local-test')));
const profile = arg('--profile', 'cottage');
assert.ok(['cottage', 'enchanting_library'].includes(profile), 'Use cottage or enchanting_library');
const runName = arg('--run-name', `house-${profile}-01`);
assert.match(runName, /^[a-zA-Z0-9_-]+$/);
const runDir = path.join(installation, 'worlds', runName);
const timeoutMs = Number(arg('--timeout-ms', 1_800_000));
const username = 'DeskPetHouse';
const publicCommand = profile === 'cottage' ? '造一座美观小屋' : '造一座带附魔台和书架的高级小屋';
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
  const files = ['../runtime.js', '../protocolCompatibility.js', '../vendor/server/minecraftTaskAgent.js',
    '../vendor/server/minecraft/furnishedHouseBlueprints.js', '../vendor/server/minecraft/furnishedHouseBuilder.js',
    '../vendor/server/action/actionRegistry.js', '../vendor/server/minecraft/commandPlanner.js',
    './real-furnished-house-server.cjs', './furnished-house-audit.cjs'];
  return Object.fromEntries(files.map((file) => [file, hash(path.resolve(__dirname, file))]));
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
  const marker = `DESKPET_HOUSE_${label}_${events.length}`;
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
  const checkpoint = rawTask?.stepCheckpoint?.furnishedHouse;
  if (checkpoint?.anchor && !result.blueprint) {
    result.blueprint = clone(createFurnishedHouseBlueprint(checkpoint.anchor, { profile }));
    record('actual_selected_house_anchor', { anchor: checkpoint.anchor, blueprint: result.blueprint });
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
async function useFurniture() {
  phase = 'independent_furniture_use';
  record('post_construction_use_stage_started', { limits: 'Separate controlled grants/time/XP permitted only after production terminal; native APIs and actual physics retained.' });
  agent.detachBot('manual_disconnect'); agent.dispose(); agent = null;
  bot.pathfinder.setGoal(null); bot.clearControlStates();
  const movements = configureFurnishedHouseDoorTraversal(new Movements(bot)); movements.canDig = false; movements.allow1by1towers = false;
  // Pathfinder 2.4.5 compares current feet Y with destination FLOOR Y;
  // value 2 admits an actual one-block descent, including the porch step.
  movements.allowParkour = false; movements.maxDropDown = 2; movements.allowFreeMotion = false;
  movements.scafoldingBlocks = [];
  for (const name of ['lava', 'water', 'fire', 'cactus', 'magma_block']) movements.blocksToAvoid.add(bot.registry.blocksByName[name].id);
  bot.pathfinder.setMovements(movements);
  const b = result.blueprint; const a = b.anchor; const f = b.furniture;
  const use = result.furnitureUse = {};
  const p = (x, z) => ({ x: a.x + x, y: a.y + 1, z: a.z + z });
  const attempt = async (name, operation) => {
    if (interruptRequested) throw new Error(`Furniture use interrupted: ${interruptRequested}`);
    try { use[name] = await operation(); record('furniture_use_confirmed', { name, evidence: use[name] }); }
    catch (error) { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); bot.clearControlStates(); bot.pathfinder.setGoal(null);
      use[name] = { confirmed: false, error: error.message, stack: error.stack }; record('furniture_use_failed', { name, ...use[name] }); }
  };
  await attempt('door', async () => {
    await bounded(bot.pathfinder.goto(new goals.GoalLookAtBlock(new Vec3(f.door.lower.x, f.door.lower.y, f.door.lower.z), bot.world)), 'approach actual door');
    if (!block(f.door.lower).getProperties().open) await bot.activateBlock(block(f.door.lower));
    await until(() => block(f.door.lower).getProperties().open === true, 'server door opened');
    await walk(b.entrance.inside);
    return { confirmed: true, positionInside: clone(bot.entity.position), door: observed(block(f.door.lower)) };
  });
  await attempt('crafting', async () => {
    await batch([`give ${username} oak_planks 3`, `give ${username} stick 2`], 'CRAFT_INPUT_FIXTURE');
    await until(() => (counts().oak_planks || 0) >= 3 && counts().stick >= 2, '3x3 crafting inputs');
    await walk(p(b.dimensions.width - 3, 2));
    const before = counts();
    const recipe = bot.recipesFor(bot.registry.itemsByName.wooden_pickaxe.id, null, 1, block(f.craftingTable))[0];
    assert.ok(recipe?.requiresTable, 'A real 3x3 recipe requiring the placed crafting table is mandatory');
    await bounded(bot.craft(recipe, 1, block(f.craftingTable)), 'actual table crafting');
    const after = counts();
    assert.equal(after.wooden_pickaxe - (before.wooden_pickaxe || 0), 1);
    assert.equal(before.oak_planks - (after.oak_planks || 0), 3);
    assert.equal(before.stick - (after.stick || 0), 2);
    return { confirmed: true, before, after, server: await readInventory('CRAFT_SERVER_CONFIRMED') };
  });
  await attempt('chest', async () => {
    await batch([`give ${username} gold_ingot 2`], 'CHEST_MARKER_FIXTURE');
    await until(() => (counts().gold_ingot || 0) >= 2, 'chest marker');
    await walk(p(b.dimensions.width - 3, 3));
    let chest = await bounded(bot.openContainer(block(f.chest)), 'actual chest open');
    const gold = bot.registry.itemsByName.gold_ingot.id;
    await bounded(chest.deposit(gold, null, 2), 'actual chest deposit'); chest.close();
    chest = await bounded(bot.openContainer(block(f.chest)), 'fresh server chest after deposit');
    const deposited = chest.containerItems().filter((item) => item.name === 'gold_ingot').reduce((sum, item) => sum + item.count, 0);
    assert.equal(deposited, 2, 'Fresh window_items must confirm deposit');
    await bounded(chest.withdraw(gold, null, 1), 'actual chest withdrawal'); chest.close();
    chest = await bounded(bot.openContainer(block(f.chest)), 'fresh server chest after withdrawal');
    const remainder = chest.containerItems().filter((item) => item.name === 'gold_ingot').reduce((sum, item) => sum + item.count, 0);
    const freshServerItems = chest.containerItems().map((item) => ({ name: item.name, count: item.count, slot: item.slot }));
    assert.equal(remainder, 1); chest.close();
    return { confirmed: true, deposited, remainder, freshServerItems, server: await readInventory('CHEST_SERVER_CONFIRMED') };
  });
  await attempt('furnace', async () => {
    await batch([`give ${username} raw_iron 1`, `give ${username} coal 1`], 'SMELT_INPUT_FIXTURE');
    await until(() => counts().raw_iron >= 1 && counts().coal >= 1, 'smelt inputs');
    await walk(p(b.dimensions.width - 3, 4));
    const before = counts(); const furnace = await bounded(bot.openFurnace(block(f.furnace)), 'actual furnace open');
    await furnace.putInput(bot.registry.itemsByName.raw_iron.id, null, 1);
    await furnace.putFuel(bot.registry.itemsByName.coal.id, null, 1);
    await until(() => furnace.outputItem()?.name === 'iron_ingot', 'real vanilla furnace smelt', 20_000);
    const outputItem = { name: furnace.outputItem().name, count: furnace.outputItem().count };
    const lit = block(f.furnace).getProperties().lit;
    await furnace.takeOutput(); furnace.close();
    const after = counts(); assert.equal(after.iron_ingot - (before.iron_ingot || 0), 1); assert.equal(lit, true);
    return { confirmed: true, before, after, outputItem, lit, server: await readInventory('SMELT_SERVER_CONFIRMED') };
  });
  await attempt('bed', async () => {
    await batch(['gamerule playersSleepingPercentage 101', 'time set 13000'], 'NIGHTTIME_SLEEP_FIXTURE');
    await until(() => bot.time.timeOfDay >= 12541, 'nighttime client update');
    await walk(p(2, 3));
    await bounded(bot.sleep(block(f.bed.foot)), 'actual bed sleep', 5000);
    assert.equal(bot.isSleeping, true);
    const text = await batch([`execute if block ${f.bed.head.x} ${f.bed.head.y} ${f.bed.head.z} white_bed[occupied=true] run say DESKPET_HOUSE_BED_OCCUPIED_CONFIRMED`], 'SLEEP_SERVER_CONFIRMED');
    assert.ok(text.includes('DESKPET_HOUSE_BED_OCCUPIED_CONFIRMED'), 'Vanilla must confirm the occupied bed');
    await bot.wake(); await until(() => !bot.isSleeping, 'actual bed wake', 5000);
    return { confirmed: true, actualSleepEvent: true, serverOccupiedReadback: text, woke: !bot.isSleeping };
  });
  if (profile === 'enchanting_library') await attempt('enchanting', async () => {
    await batch([`give ${username} diamond_sword 1`, `give ${username} lapis_lazuli 3`, `experience set ${username} 30 levels`], 'ENCHANT_INPUT_XP_FIXTURE');
    await until(() => counts().diamond_sword >= 1 && counts().lapis_lazuli >= 3 && bot.experience.level >= 30, 'enchant fixtures');
    await walk(p(4, 6));
    const beforeLevel = bot.experience.level; const beforeLapis = counts().lapis_lazuli;
    const table = await bounded(bot.openEnchantmentTable(block(f.enchantingTable)), 'actual enchanting table');
    // Item.slot must refer to the currently open enchantment window, whose
    // player inventory starts at 2 rather than the closed inventory's 9.
    await table.putTargetItem(bot.currentWindow.items().find((item) => item.name === 'diamond_sword'));
    await table.putLapis(bot.currentWindow.items().find((item) => item.name === 'lapis_lazuli'));
    await until(() => table.enchantments?.[2]?.level === 30, 'real level-30 enchant option');
    const options = clone(table.enchantments);
    await bounded(table.enchant(2), 'actual level-30 enchant', 8000);
    await until(() => table.targetItem()?.components?.some((entry) => /enchantments/.test(entry.type)), 'server enchanted item component');
    const enchanted = clone(table.targetItem().components);
    await table.takeTargetItem(); table.close();
    await until(() => bot.experience.level === beforeLevel - 3, 'real XP deduction');
    const afterLapis = counts().lapis_lazuli || 0; assert.equal(beforeLapis - afterLapis, 3);
    const server = await readInventory('ENCHANT_SERVER_CONFIRMED');
    assert.ok(server.authoritative.some((item) => item.name === 'diamond_sword' && item.raw.includes('minecraft:enchantments')), 'Vanilla inventory must persist enchantment component');
    return { confirmed: true, options, beforeLevel, afterLevel: bot.experience.level, beforeLapis, afterLapis, enchanted, server };
  });
  await attempt('doorClosure', async () => {
    await walk(b.entrance.inside);
    if (block(f.door.lower).getProperties().open) await bot.activateBlock(block(f.door.lower));
    await until(() => block(f.door.lower).getProperties().open === false, 'actual door closed');
    return { confirmed: true, lower: observed(block(f.door.lower)), upper: observed(block(f.door.upper)) };
  });
  record('post_construction_use_stage_finished', { furnitureUse: use });
}
async function main() {
  if (argv.includes('--help')) { console.log('Opt-in controlled vanilla house test: --accept-eula --profile cottage|enchanting_library --run-name unique-name [--timeout-ms 1800000]'); return; }
  assert.ok(argv.includes('--accept-eula'), 'Pass --accept-eula for the authorized local official server');
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 30_000 && timeoutMs <= 3_600_000);
  assert.ok(!fs.existsSync(runDir), 'Never overwrite an existing world or acceptance report');
  const installed = JSON.parse(fs.readFileSync(path.join(installation, 'installation.json'), 'utf8'));
  const java = installed.java; const jar = installed.minecraft.jar; const version = installed.minecraft.version;
  assert.equal(version, '1.21.8'); assert.ok(fs.existsSync(java) && fs.existsSync(jar));
  fs.mkdirSync(path.dirname(runDir), { recursive: true });
  fs.mkdirSync(runDir); runCreated = true;
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const fixtureBudget = getFurnishedHouseMaterialBudget(createFurnishedHouseBlueprint({ x: 0, y: 0, z: 0 }, { profile }));
  result = { mode: 'controlled-real-furnished-house', profile, publicCommand, runDir, port,
    fixtureLimits: 'Fresh superflat normal Survival world. All finished building materials, dirt scaffold, iron tools and food granted before public submission; no from-zero acquisition claim. Mob/day/weather cycles held for isolated construction. Furniture-use grants/night/XP occur only after the frozen construction outcome.',
    constructionMaterialBudget: fixtureBudget, furnitureUse: {}, taskBotTeleported: false };
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
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { log.write(chunk); output += chunk.toString(); checkWaiters(); });
  server.on('exit', (code, signal) => record('server_exit', { code, signal }));
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
  await batch([...Object.entries(fixtureBudget).map(([name, count]) => `give ${username} ${name} ${count}`),
    `give ${username} iron_pickaxe 1`, `give ${username} iron_axe 1`, `give ${username} iron_shovel 1`,
    `give ${username} cooked_porkchop 16`], 'FINISHED_CONSTRUCTION_MATERIALS');
  await until(() => Object.entries(fixtureBudget).every(([name, count]) => counts()[name] >= count)
    && counts().iron_pickaxe === 1 && counts().cooked_porkchop === 16, 'all controlled finished materials');
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
  agent = createMinecraftTaskAgent({ appPaths: { appDataDir: path.join(runDir, 'deskpet-data') },
    readConfig: () => ({ mcExecutorMode: 'strict-executor', mcAgentAutoReconnect: false }),
    parseJsonObjectFromText: JSON.parse, broadcast: (event) => record('agent_event', { event }),
    broadcastMinecraftError: (message) => record('agent_error', { message }), allowAutonomousMaintenance: () => false,
    requestPlannerCompletion: async () => { throw new Error('No AI provider authorized for deterministic house acceptance'); } });
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
  record('construction_outcome_frozen_before_readback', { task: result.task, inventory: inventory(), position: bot.entity.position });
  result.constructionMismatches = result.blueprint?.blocks.flatMap((expected) => {
    const actual = observed(block(expected.position));
    return matches(actual, expected.item, expected.properties) ? [] : [{ expected, actual }];
  }) || null;
  result.constructionInventory = await readInventory('CONSTRUCTION_SERVER_SLOTS');
  if (result.task.status === 'completed') await useFurniture();
  result.finalInventory = await readInventory('FINAL_SERVER_SLOTS');
}
async function cleanup() {
  clearInterval(interval); constructionActive = false; phase = 'cleanup';
  if (agent) { try { agent.detachBot('manual_disconnect'); agent.dispose(); } catch (error) { record('cleanup_error', { message: error.message }); } }
  try { bot?.pathfinder?.setGoal(null); bot?.clearControlStates(); bot?.quit('Controlled house acceptance complete'); } catch { /* retain original failure */ }
  if (server && server.exitCode === null && server.signalCode === null) {
    command('stop'); await Promise.race([once(server, 'exit'), sleep(30_000)]);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM'); await Promise.race([once(server, 'exit'), sleep(5000)]);
    }
  }
  if (server) fs.writeFileSync(path.join(runDir, 'server-lifecycle.json'), json({ stoppedAt: new Date().toISOString(),
    serverStopped: server.exitCode !== null, serverExitCode: server.exitCode, serverExitSignal: server.signalCode }, 2) + '\n', { flag: 'wx' });
  for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('Acceptance ended')); } waiters.clear();
  if (result) {
    result.deaths = deaths; result.elapsedMs = Date.now() - start;
    result.interruptionRequested = interruptRequested || null;
    result.sourceHashes = { started: initialHashes, ended: sourceHashes() };
    fs.writeFileSync(path.join(runDir, 'result.json'), json(result, 2) + '\n', { flag: 'wx' });
  }
}
main().catch((error) => {
  console.error(error.stack || error); process.exitCode = 1;
  if (result) result.harnessFailure = { message: error.message, stack: error.stack };
  if (runCreated) record('harness_failure', { message: error.message, stack: error.stack });
}).finally(async () => {
  try {
    await cleanup();
    if (result?.blueprint) {
      const report = await auditHouse(runDir);
      console.log(json({ runDir, acceptancePassed: report.acceptancePassed, unmetCriteria: report.unmetCriteria }));
      if (!report.acceptancePassed) process.exitCode = 1;
    } else if (result) process.exitCode = 1;
  } catch (error) { console.error(error.stack || error); process.exitCode = 1;
    if (runCreated) record('post_stop_audit_failure', { message: error.message, stack: error.stack }); }
});
