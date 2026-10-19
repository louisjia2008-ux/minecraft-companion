/* global process, console, __filename, setTimeout, clearTimeout, setInterval, clearInterval */
'use strict';
// Private opt-in harness. No setup resources, terrain edits, teleport, weather,
// time, XP or gamerule setters. Normal vanilla physics and real production APIs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { AsyncLocalStorage } = require('node:async_hooks');
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('node natural-public-building-acceptance-v6.cjs --accept-eula --run-name UNIQUE --profile cottage|enchanting_library|medieval_castle|riverside_villa [--timeout-ms 7200000] [--verification-timeout-ms 7200000] [--natural-growth-timeout-ms 3600000] [--natural-night-timeout-ms 1250000] | --preflight');
  console.log('Fresh normal Survival empty-inventory public construction with self-obtained functional inputs. Unsupported mandatory capabilities remain PENDING; supplied component fixtures never count.');
  console.log('v6 reserves a unique crypto signed64 seed and fresh run directory before runtime/Java preflight. --preflight also consumes its UNIQUE run-name/seed; actual execution needs another UNIQUE name. Failed allocation/preflight/start attempts are never deleted, resumed or redrawn.');
  process.exit(0);
}
function argument(name, fallback) {
  const index = argv.indexOf(name); if (index < 0) return fallback;
  assert.ok(argv[index + 1] && !argv[index + 1].startsWith('--'), `Missing ${name}`); return argv[index + 1];
}
for (let index = 0; index < argv.length; index++) {
  if (['--accept-eula', '--preflight'].includes(argv[index])) continue;
  assert.ok(['--run-name', '--profile', '--timeout-ms', '--verification-timeout-ms', '--natural-growth-timeout-ms', '--natural-night-timeout-ms', '--installation', '--runtime-root'].includes(argv[index]), `Unsupported argument ${argv[index]}`); index++;
}
const workspace = path.resolve(__dirname, '..');
const runtimeRoot = path.resolve(argument('--runtime-root', path.join(workspace, 'electron/minecraft-runtime')));
const installation = path.resolve(argument('--installation', path.join(workspace, '.minecraft-local-test')));
const { allocateFreshRun, inspectSeedAllocation } = require('./fresh-seed-allocation-v1.cjs');
const runName = argument('--run-name', `natural-public-${argument('--profile', 'cottage')}-${Date.now()}`); assert.match(runName, /^[A-Za-z0-9_-]+$/);
const runDir = path.join(installation, 'worlds', runName);
// Allocation and receipt are durable before runtime loading or any preflight.
const campaign = allocateFreshRun({ installation, runtimeRoot, runner: __filename, runName, profile: argument('--profile', 'cottage'), preflightOnly: argv.includes('--preflight') });
const campaignFile = path.join(runDir, 'seed-allocation.json');
const installed = JSON.parse(fs.readFileSync(path.join(installation, 'installation.json'), 'utf8'));
const req = createRequire(path.join(runtimeRoot, 'package.json'));
const mineflayer = req('mineflayer');
const { Vec3 } = req('vec3');
const { goals } = req('mineflayer-pathfinder');
const { createMinecraftTaskAgent } = req(path.join(runtimeRoot, 'vendor/server/minecraftTaskAgent'));
const { createFurnishedHouseBlueprint } = req(path.join(runtimeRoot, 'vendor/server/minecraft/furnishedHouseBlueprints'));
const { createEstateBlueprint } = req(path.join(runtimeRoot, 'vendor/server/minecraft/estateBlueprints'));
const { planEstateDoorClosure } = req(path.join(runtimeRoot, 'vendor/server/minecraft/estateDoorClosure'));
const { createMinecraftActionRegistry } = req(path.join(runtimeRoot, 'vendor/server/action/actionRegistry'));
const { createHeuristicPlanner } = req(path.join(runtimeRoot, 'vendor/server/minecraft/commandPlanner'));
const { withHouseNativeSourceGuard } = req(path.join(runtimeRoot, 'vendor/server/minecraft/houseNativeSourceGuard'));
const Item = req('prismarine-item')(installed.minecraft.version);
const { CancellationToken } = req(path.join(runtimeRoot, 'vendor/server/minecraft/agentControl'));
const { withMinecraftProtocolCompatibility, installMinecraftBedWakeCompatibility } = req(path.join(runtimeRoot, 'protocolCompatibility'));
const { acknowledgePlayerLoaded } = req(path.join(runtimeRoot, 'runtime'));
const { readRegionChunk, decodeSectionBlock, blockLocation, readLevelMetadata } = req(path.join(runtimeRoot, 'test-support/natural-world-audit.cjs'));
const { compareManifest, geometryEvidence } = req(path.join(runtimeRoot, 'test-support/furnished-house-audit.cjs'));
const mode = 'public';
const profile = argument('--profile', 'cottage');
const profiles = Object.freeze({ cottage: {command:'造一座美观小屋',schema:2,skill:'build_furnished_house_phase',intent:'build_furnished_house'}, enchanting_library:{command:'造一座带附魔台和书架的高级小屋',schema:2,skill:'build_furnished_house_phase',intent:'build_furnished_house'}, medieval_castle:{command:'建造一座带农田的中世纪城堡',schema:1,skill:'build_estate',intent:'build_estate'}, riverside_villa:{command:'建造一座带农田和码头的河畔木屋别墅',schema:1,skill:'build_estate',intent:'build_estate'} });
assert.ok(profiles[profile], 'Unsupported building profile');
const isEstate = ['medieval_castle','riverside_villa'].includes(profile);
const enchanting = profile !== 'cottage';
const blueprintFor = anchor => isEstate ? createEstateBlueprint(anchor,{profile}) : createFurnishedHouseBlueprint(anchor,{profile});
const stateFor = value => value?.stepCheckpoint?.[isEstate ? 'estate' : 'furnishedHouse'];
const nativeOwner = new AsyncLocalStorage();
const stages = [];
const typed = (code,message) => Object.assign(new Error(message),{code});
// Run identity and immutable seed receipt are allocated before imports above.
const maximumMs = Number(argument('--timeout-ms', '7200000')); assert.ok(Number.isSafeInteger(maximumMs) && maximumMs >= 60000);
const username = 'DeskPetSelfBuild';
const commandText = profiles[profile].command;
const verificationMaximumMs=Number(argument('--verification-timeout-ms','7200000')), naturalGrowthMs=Number(argument('--natural-growth-timeout-ms','3600000')), naturalNightMs=Number(argument('--natural-night-timeout-ms','1250000'));
for(const n of [verificationMaximumMs,naturalGrowthMs,naturalNightMs])assert.ok(Number.isSafeInteger(n)&&n>=60000&&n<=43200000);
function validatePublicPlan(plan) {
 const construction=(plan?.steps||[]).filter(s=>s.skill===profiles[profile].skill);
 const injected=(plan?.steps||[]).some(s=>s.args?.anchor||s.args?.depots?.length||s.args?.useNearbySupplyChests===true||s.args?.materialSource==='external_depots');
 return {confirmed:plan?.mode==='task'&&plan.intent===profiles[profile].intent&&construction.length>0&&!injected&&construction.every(s=>s.args?.schema===profiles[profile].schema&&s.args?.profile===profile&&s.args?.materialSource==='self_gathered'),constructionSteps:construction.length,injected};
}
const actualHeuristicPlan=createHeuristicPlanner({actionRegistry:createMinecraftActionRegistry(),getLearnedSearchRadius:(_name,fallback)=>fallback})(commandText,{});
assert.equal(validatePublicPlan(actualHeuristicPlan).confirmed,true,'Current public planner must retain default natural self supply');
if(argv.includes('--preflight')){console.log(JSON.stringify({observerRevision:5,runnerRevision:6,seedPolicyRevision:1,parentRunnerSha256:'8880727e18ccf78dff09ec7f1098776b6a6fb5685e1ed9af456a80a7f07c966d',profile,commandText,seed:campaign.seed,seedAllocationFile:campaignFile,seedRuntimeSha256:campaign.runtime.sha256,actualPublicPlan:validatePublicPlan(actualHeuristicPlan),javaStarted:false,implementedRunner:true,liveAccepted:false,readiness:'PRIVATE_OFFLINE_VERIFIED_LIVE_NOT_RUN',typedPendingCapabilities:['natural_xp_provider','natural_lapis_provider','rare_fluid_provider','natural_riverside_selector']}));process.exit(0);}
const startedAt = Date.now();
const events = [], waiters = new Set(), digTargets = new Map();
let created = false, server, serverOutcome, serverExitPromise, serverClosePromise, serverClosed=false, serverOutput = '', bot, agent, task, frozenTask;
let polling, pollingReject, failurePromise, signalReject;
let sourceBefore, sourceAfter, initial, executionStarted, executionEnded, stopped, result, finalReadback, publicPlanSnapshot;
let deaths = 0, disconnected = false, nativeUse = null, lastSignature = '', lastReport = 0, lastFood, stopPromise;
let abortError = null, fatalError = null;
let releaseChunkObservers = () => {};
let releaseDynamicObservers = () => {};
const json = (value, indent) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, indent);
const clone = value => JSON.parse(json(value));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const position = p => p && ({ x: p.x, y: p.y, z: p.z });
const key = p => `${p.x},${p.y},${p.z}`;
const air = b => ['air', 'cave_air', 'void_air'].includes(String(b?.name).replace(/^minecraft:/, ''));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const signalPromise = new Promise((_, reject) => { signalReject = reject; }); signalPromise.catch(() => {});
function requestAbort(error) { abortError ||= error; signalReject(abortError); }
const assertStartupActive=()=>{if(abortError)throw abortError;};
function fatalRuntimeError(kind, reason) {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  process.exitCode = 1;
  if (!fatalError) {
    fatalError = { kind, message: error.message, code: error.code || null, stack: String(error.stack || '').slice(0, 20000) };
    // Never serialize the rejected Promise, native goal or world graph here.
    // Failing to write a diagnostic must still abort into owned cleanup.
    if (created) try { record('fatal_runtime_error', fatalError); } catch (loggingError) { console.error('Fatal diagnostic write failed:', loggingError.message); }
  }
  requestAbort(error);
}
const fatalHandlers = { uncaughtException: error => fatalRuntimeError('uncaughtException', error),
  unhandledRejection: reason => fatalRuntimeError('unhandledRejection', reason) };
for (const [event, handler] of Object.entries(fatalHandlers)) process.on(event, handler);
const signalHandlers = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, () => requestAbort(new Error(`Harness interrupted by ${signal}`))]));
for (const [signal, handler] of Object.entries(signalHandlers)) process.once(signal, handler);
async function deadline(promise, ms, label) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}
function record(type, data = {}) {
  assert.ok(created, 'Run must be exclusively created before recording evidence');
  const event = clone({ at: new Date().toISOString(), elapsedMs: Date.now() - startedAt, type, ...data });
  events.push(event); fs.appendFileSync(path.join(runDir, 'events.jsonl'), json(event) + '\n'); return event;
}
function hashes() {
  const all = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', 'test', 'test-support'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.js') || entry.name === 'package.json') all[path.relative(runtimeRoot, file)] = hash(file);
    }
  }
  walk(runtimeRoot);
  for (const file of ['test-support/natural-world-audit.cjs', 'test-support/furnished-house-audit.cjs']) all[file] = hash(path.join(runtimeRoot, file));
  all['private/natural-public-building-acceptance.cjs'] = hash(__filename);
  all['private/fresh-seed-allocation-v1.cjs'] = hash(path.join(__dirname, 'fresh-seed-allocation-v1.cjs'));
  if(fs.existsSync('/private/tmp/deskpet-house-natural-enchant.cjs'))all['private/deskpet-house-natural-enchant.cjs']=hash('/private/tmp/deskpet-house-natural-enchant.cjs');
  for(const name of ['mineflayer/lib/plugins/inventory','mineflayer/lib/plugins/craft','mineflayer/lib/plugins/furnace','mineflayer/lib/plugins/enchantment_table','mineflayer/lib/plugins/bed','mineflayer/lib/plugins/physics','mineflayer-pathfinder'])all[`native/${name}.js`]=hash(req.resolve(name));return all;
}
function saveSources(manifest) {
  for (const [relative, digest] of Object.entries(manifest)) {
    const from = relative === 'private/natural-public-building-acceptance.cjs' ? __filename : relative === 'private/fresh-seed-allocation-v1.cjs' ? path.join(__dirname, 'fresh-seed-allocation-v1.cjs') : relative.startsWith('private/') ? path.join('/private/tmp',path.basename(relative)) : relative.startsWith('native/') ? req.resolve(relative.slice(7,-3)) : path.join(runtimeRoot, relative);
    const to = path.join(runDir, 'execution-source-snapshot', relative);
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    assert.equal(hash(to), digest, 'Execution source must equal pre-run fingerprint');
  }
}
function inventory() { return (bot?.inventory?.slots || []).flatMap((item, slot) => item && slot >= 5 ? [{ name: item.name, count: item.count, slot }] : []).sort((a, b) => a.slot - b.slot); }
const counts = items => items.reduce((out, item) => { out[item.name] = (out[item.name] || 0) + item.count; return out; }, {});
function goalEvidence(goal) {
  if (!goal) return null;
  const out = { type: goal.constructor?.name || 'Goal' };
  for (const name of ['x', 'y', 'z', 'range', 'rangeSq']) if (Number.isFinite(goal[name])) out[name] = goal[name];
  const p = goal.pos || goal.position || goal.entity?.position; if (p && ['x', 'y', 'z'].every(n => Number.isFinite(p[n]))) out.position = position(p);
  return out;
}
function taskEvidence(value) {
  return value && clone({ taskId: value.taskId, status: value.status, error: value.error, userCommand: value.userCommand, intent: value.intent,
    executionGeneration: value.executionGeneration, currentStep: value.currentStep, currentStepIndex: value.currentStepIndex, progressText: value.progressText,
    plan: value.plan, diagnostics: value.diagnostics, stepCheckpoint: value.stepCheckpoint, materialSupply: value.materialSupply, logs: value.logs });
}
// Pure observation: no native API replacement, motor/world writes or requests.
function nativeMotionEvidence(observedBot) {
  const read = (object, name, kind) => {
    try { const value = object?.[name]; return kind === 'number' ? Number.isFinite(value) ? value : null
      : typeof value === 'boolean' ? value : null; } catch { return null; }
  };
  let entity, controls;
  try { entity = observedBot?.entity; } catch { /* Unknown native entity. */ }
  try { controls = observedBot?.controlState; } catch { /* Unknown native controls. */ }
  return { yaw: read(entity, 'yaw', 'number'), pitch: read(entity, 'pitch', 'number'),
    controls: Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(name => [name, read(controls, name, 'boolean')])),
    jumpTicks: read(observedBot, 'jumpTicks', 'number'), jumpQueued: read(observedBot, 'jumpQueued', 'boolean') };
}
function installDynamicObservers(observedBot, emitRecord, duringExecution) {
  const seen = new Map();
  const point = value => value && ['x', 'y', 'z'].every(name => Number.isFinite(value[name]))
    ? { x: value.x, y: value.y, z: value.z } : null;
  const frame = () => ({ position: point(observedBot.entity?.position), velocity: point(observedBot.entity?.velocity),
    onGround: typeof observedBot.entity?.onGround === 'boolean' ? observedBot.entity.onGround : null,
    ...nativeMotionEvidence(observedBot), nativeGoal: goalEvidence(observedBot.pathfinder?.goal), duringExecution: duringExecution() });
  const passive = (nativeOrigin, operation) => {
    try { operation(); }
    catch { try { emitRecord('dynamic_observation_error', { nativeOrigin,
      message: 'Native observation read or evidence storage failed' }); } catch { /* Evidence faults never interrupt native listeners. */ } }
  };
  const pathUpdate = result => passive('bot.path_update', () => {
    const path = Array.isArray(result?.path) ? result.path : null;
    const points = [];
    if (path) for (let i = 0; i < Math.min(64, path.length); i++) points.push(point(path[i]));
    emitRecord('native_path_update', { nativeOrigin: 'bot.path_update', status: typeof result?.status === 'string' ? result.status.slice(0, 80) : null,
      pathLength: path ? path.length : null, pathTruncated: path ? path.length > 64 : null, points, ...frame() });
  });
  const pathReset = reason => passive('bot.path_reset', () => emitRecord('native_path_reset', {
    nativeOrigin: 'bot.path_reset', reason: typeof reason === 'string' ? reason.slice(0, 80) : null, ...frame() }));
  const goalReached = goal => passive('bot.goal_reached', () => emitRecord('native_goal_reached', {
    nativeOrigin: 'bot.goal_reached', reachedGoal: goalEvidence(goal), ...frame() }));
  function creeper(origin, entity) {
    passive(origin, () => {
      if (entity?.name !== 'creeper' || !Number.isSafeInteger(entity.id)) return;
      const value = { entityId: entity.id, name: 'creeper', isValid: typeof entity.isValid === 'boolean' ? entity.isValid : null, creeperPosition: point(entity.position) };
      const signature = JSON.stringify(value);
      if (origin === 'bot.entityGone') {
        if (seen.has(entity.id)) { emitRecord('native_creeper_gone', { nativeOrigin: origin, ...value, ...frame() }); seen.delete(entity.id); }
        return;
      }
      if (seen.get(entity.id) === signature) return;
      if (!seen.has(entity.id) && seen.size >= 128) seen.delete(seen.keys().next().value);
      seen.set(entity.id, signature);
      emitRecord(origin === 'bot.entityMoved' ? 'native_creeper_moved' : 'native_creeper_observed', {
        nativeOrigin: origin, ...value, ...frame() });
    });
  }
  const spawn = entity => creeper('bot.entitySpawn', entity);
  const moved = entity => creeper('bot.entityMoved', entity);
  const gone = entity => creeper('bot.entityGone', entity);
  const listeners = [['path_update', pathUpdate], ['path_reset', pathReset], ['goal_reached', goalReached],
    ['entitySpawn', spawn], ['entityMoved', moved], ['entityGone', gone]];
  for (const [event, listener] of listeners) passive('observer.install_listener', () => observedBot.on(event, listener));
  passive('observer.install_existing_creepers', () => {
    let entities; try { entities = observedBot.entities; } catch { return; }
    if (!entities) return;
    for (const id of Object.keys(entities)) {
      if (seen.size >= 128) break;
      const entity = entities[id]; if (entity?.name === 'creeper') creeper('observer.install_existing_creepers', entity);
    }
  });
  return () => {
    for (const [event, listener] of listeners) {
      try { observedBot.removeListener(event, listener); } catch { /* Own task cleanup remains independent. */ }
    }
    seen.clear();
  };
}

function snapshot(force = false) {
  if (!bot?.entity || !agent) return;
  task = agent.__testGetReconnectTask() || task;
  if(!publicPlanSnapshot&&task?.intent===profiles[profile].intent&&task?.plan?.steps?.length){publicPlanSnapshot=clone(task.plan);record('original_public_plan_observed',{plan:publicPlanSnapshot,identity:validatePublicPlan(publicPlanSnapshot)});}
  const supply = task?.materialSupply, house = stateFor(task);
  const data = { ...nativeMotionEvidence(bot), position: position(bot.entity.position), velocity: position(bot.entity.velocity), onGround: bot.entity.onGround,
    health: bot.health, food: bot.food, saturation: bot.foodSaturation, inventory: inventory(), heldItem: bot.heldItem && { name: bot.heldItem.name, count: bot.heldItem.count },
    task: { status: task?.status, error: task?.error, currentStep: task?.currentStep, progressText: task?.progressText },
    pathfinder: { moving: bot.pathfinder?.isMoving?.(), goal: goalEvidence(bot.pathfinder?.goal) },
    supply, house: house && { ...house, ownedBlockIds: undefined, ownedBlocksCount: house.ownedBlockIds?.length } };
  const signature = json(data);
  if (force || signature !== lastSignature || Date.now() - lastReport > 30000) { record('snapshot', data); lastSignature = signature; }
  if (force || Date.now() - lastReport > 15000) {
    console.log(json({ elapsedMs: Date.now() - startedAt, mode, status: task?.status, progress: task?.progressText,
      position: data.position, health: data.health, food: data.food, inventory: counts(data.inventory) })); lastReport = Date.now();
  }
}
function checkWaiters() {
  for (const waiter of waiters) { const match = serverOutput.slice(waiter.from).match(waiter.pattern); if (!match) continue;
    clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(match[0]); }
}
function waitForServer(pattern, timeout = 30000, from = serverOutput.length) {
  const answer = new Promise((resolve, reject) => { const waiter = { pattern, from, resolve, reject };
    waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Server readback timed out: ${pattern}`)); }, timeout);
    waiters.add(waiter); checkWaiters(); });
  return Promise.race([answer, signalPromise]);
}
function consoleRead(text) {
  const allowed = ['seed', 'difficulty', 'stop'].includes(text)
    || /^gamerule (?:doMobSpawning|doDaylightCycle|doWeatherCycle|keepInventory|naturalRegeneration)$/.test(text)
    || new RegExp(`^data get entity ${username} (?:Inventory|Pos|Health|foodLevel|foodSaturationLevel|foodExhaustionLevel|XpLevel|XpTotal|XpP)$`).test(text)
    || /^data get block -?\d+ -?\d+ -?\d+$/.test(text)
    || /^execute if block -?\d+ -?\d+ -?\d+ [a-z_]+(?:\[[a-z0-9_=,]+\])? run say DESKPET_SELF_[A-Z0-9_-]+$/.test(text)
    || /^say DESKPET_SELF_[A-Z0-9_-]+$/.test(text);
  assert.ok(allowed, `Non-observational command refused: ${text}`);
  assert.ok(server?.stdin.writable && server.exitCode === null, 'Owned server stdin unavailable');
  record('server_command', { command: text, duringExecution: executionStarted != null && executionEnded == null }); server.stdin.write(text + '\n');
}
async function read(text, pattern) { const answer = waitForServer(pattern); consoleRead(text); return answer; }
async function entity(field) { return read(`data get entity ${username} ${field}`, new RegExp(`${username} has the following entity data: [^\\r\\n]+`)); }
function parseInventory(line) {
  const raw = line.slice(line.indexOf('entity data: ') + 13), compounds = []; let depth = 0, start = 0, quoted = false, escaped = false;
  for (let i = 0; i < raw.length; i++) { const c = raw[i]; if (escaped) { escaped = false; continue; }
    if (quoted && c === '\\') { escaped = true; continue; } if (c === '"') { quoted = !quoted; continue; } if (quoted) continue;
    if (c === '{' && depth++ === 0) start = i; if (c === '}' && --depth === 0) compounds.push(raw.slice(start, i + 1)); }
  return compounds.map(c => { const name = c.match(/\bid:\s*"minecraft:([^"]+)"/)?.[1], count = Number(c.match(/\bcount:\s*(\d+)/)?.[1]), slot = Number(c.match(/\bSlot:\s*(-?\d+)b/)?.[1]);
    assert.ok(name && Number.isInteger(count) && Number.isInteger(slot), `Invalid Inventory compound ${c}`);
    return { name, count, slot: slot >= 0 && slot <= 8 ? slot + 36 : slot >= 100 && slot <= 103 ? 108 - slot : slot === -106 ? 45 : slot };
  }).sort((a, b) => a.slot - b.slot);
}
function parsePos(line) { const m = line.match(/entity data: \[(-?[\d.eE+-]+)d,\s*(-?[\d.eE+-]+)d,\s*(-?[\d.eE+-]+)d\]/); assert.ok(m, line); return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }; }
async function authoritative() {
  let observed;
  for (let attempt = 0; attempt < 5; attempt++) {
    const serverInventory = parseInventory(await entity('Inventory')), serverPosition = parsePos(await entity('Pos'));
    const clientInventory = inventory(), clientPosition = position(bot.entity.position);
    observed = { serverInventory, serverPosition, clientInventory, clientPosition, inventoryMatches: json(serverInventory) === json(clientInventory),
      positionDifference: Math.hypot(serverPosition.x - clientPosition.x, serverPosition.y - clientPosition.y, serverPosition.z - clientPosition.z) };
    if (observed.inventoryMatches && observed.positionDifference <= .15) break;
    await sleep(200);
  }
  return record('authoritative_inventory_position', observed);
}
function parseExperienceScalar(line){const m=line.match(/entity data:\s*(-?[\d.eE+-]+)(?:[fd])?\s*$/);assert.ok(m,'Actual XP field must be numeric SNBT');const value=Number(m[1]);assert.ok(Number.isFinite(value));return value;}
async function authoritativeExperience(){
  let value;
  for(let attempt=0;attempt<5;attempt++){
    const levelLine=await entity('XpLevel'),totalLine=await entity('XpTotal'),progressLine=await entity('XpP');
    const serverExperience={level:parseExperienceScalar(levelLine),points:parseExperienceScalar(totalLine),progress:parseExperienceScalar(progressLine)},clientExperience=bot.experience&&{level:bot.experience.level,points:bot.experience.points,progress:bot.experience.progress};
    value={serverExperience,clientExperience,lines:{levelLine,totalLine,progressLine},confirmed:!!clientExperience&&serverExperience.level===clientExperience.level&&serverExperience.points===clientExperience.points&&Math.abs(serverExperience.progress-clientExperience.progress)<=1e-6};
    if(value.confirmed)break;await sleep(100);
  }
  return record('authoritative_experience',value);
}
// Observation only: installed Mineflayer forwards native world chunk events.
// The raw header listener is attached before spawn; it never copies chunkData.
function installChunkObservers(observedBot, emitRecord, duringExecution) {
  const client = observedBot._client;
  function observe(nativeOrigin, chunkX, chunkZ) {
    try {
      if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) return;
      const column = observedBot.world?.getColumn?.(chunkX, chunkZ);
      emitRecord(nativeOrigin === 'client.map_chunk' ? 'native_map_chunk_header' :
        nativeOrigin === 'bot.chunkColumnLoad' ? 'native_chunk_column_load' : 'native_chunk_column_unload', {
        corner: { x: chunkX * 16, y: 0, z: chunkZ * 16 }, chunkX, chunkZ,
        nativeOrigin, duringExecution: duringExecution(),
        loadedColumnPresent: observedBot.world?.getColumn ? column != null : null,
      });
    } catch (error) {
      // An observation failure must not reject a native event handler or stop
      // the bot, task, future observers, or the existing owned shutdown path.
      try { emitRecord('chunk_observation_error', {
        nativeOrigin, message: String(error?.message || 'Chunk observation failed').slice(0, 400),
      }); } catch { /* The observer remains passive if evidence storage fails. */ }
    }
  }
  const onLoad = corner => {
    try { observe('bot.chunkColumnLoad', corner?.x / 16, corner?.z / 16); }
    catch { /* Reading an invalid event must not escape into native listeners. */ }
  };
  const onUnload = corner => {
    try { observe('bot.chunkColumnUnload', corner?.x / 16, corner?.z / 16); }
    catch { /* Observation only. */ }
  };
  const onHeader = packet => {
    try { observe('client.map_chunk', packet?.x, packet?.z); }
    catch { /* Never read the payload or binary chunk data. */ }
  };
  observedBot.on('chunkColumnLoad', onLoad);
  observedBot.on('chunkColumnUnload', onUnload);
  client.on('map_chunk', onHeader);
  return () => {
    for (const [emitter, event, listener] of [[observedBot, 'chunkColumnLoad', onLoad],
      [observedBot, 'chunkColumnUnload', onUnload], [client, 'map_chunk', onHeader]]) {
      try { emitter.removeListener(event, listener); } catch { /* Owned shutdown is independent of observations. */ }
    }
  };
}
function installObservers() {
  releaseDynamicObservers = installDynamicObservers(bot, record, () => executionStarted != null && executionEnded == null);
  bot.on('death', () => { deaths++; record('death', { position: position(bot.entity?.position) }); });
  bot.on('end', reason => { disconnected = true; record('bot_end', { reason }); });
  bot.on('error', error => record('bot_error', { message: error.message }));
  bot.on('kicked', reason => record('kicked', { reason }));
  // Observation only. Never install a movement correction or alter metadata.
  bot.on('forcedMove', () => record('native_position_correction', {
    duringExecution: executionStarted != null && executionEnded == null,
    position: position(bot.entity?.position), velocity: position(bot.entity?.velocity) }));
  bot._client.on('entity_metadata', packet => {
    if (packet.entityId === bot.entity?.id) record('raw_self_metadata', {
      entityId: packet.entityId, metadata: packet.metadata,
      duringExecution: executionStarted != null && executionEnded == null });
  });
  bot.on('diggingCompleted', block => record('digging_completed', { position: position(block.position), resultingBlock: block.name,
    startedBlock: digTargets.get(key(block.position)) || null, playerPosition: position(bot.entity.position) }));
  bot.on('blockUpdate', (before, after) => { if (!executionStarted || !before || !after || before.stateId === after.stateId) return;
    record('block_update', { position: position(after.position), from: before.name, to: after.name, properties: after.getProperties?.(),
      distance: after.position.distanceTo(bot.entity.position) }); });
  bot.on('blockPlaced', (before, after) => record('native_block_placed', { position: position(after.position), from: before.name, to: after.name }));
  bot.on('entityHurt', entity => record('entity_hurt', { id: entity.id, name: entity.name, self: entity.id === bot.entity.id, position: position(entity.position) }));
  bot._client.on('set_slot', packet => record('server_slot_ack', { windowId: packet.windowId, stateId: packet.stateId, slot: packet.slot, item: packet.item }));
  bot._client.on('window_items', packet => record('server_window_inventory', { windowId: packet.windowId, stateId: packet.stateId, items: packet.items }));
  bot._client.on('entity_status', packet => { if (packet.entityId === bot.entity.id) record('self_entity_status', { status: packet.entityStatus, food: bot.food, heldItem: bot.heldItem && { name: bot.heldItem.name, count: bot.heldItem.count } }); });
  bot._client.on('experience',packet=>record('experience_packet',{...packet,actual:bot.experience&&{...bot.experience}}));
  bot._client.on('update_health', packet => { record('health_packet', { previousFood: lastFood, ...packet }); lastFood = packet.food; });
  bot.on('windowOpen', window => record('native_window_open', { id: window.id, type: window.type, inventoryStart: window.inventoryStart, inventoryEnd: window.inventoryEnd }));
  bot.on('windowClose', window => record('native_window_close', { id: window?.id, type: window?.type }));
  bot.on('sleep', () => record('native_sleep', { position: position(bot.entity.position), time: bot.time?.timeOfDay }));
  bot.on('wake', () => record('native_wake', { position: position(bot.entity.position), time: bot.time?.timeOfDay }));
  const previousWrite = bot._client.write;
  bot._client.write = function (name, packet) {
    if (name === 'block_dig' && packet.status === 0 && packet.location) {
      const actual = bot.blockAt(new Vec3(packet.location.x, packet.location.y, packet.location.z));
      digTargets.set(key(packet.location), { name: actual?.name, properties: actual?.getProperties?.(), at: Date.now() });
    }
    if (['block_place', 'block_dig', 'window_click', 'craft_recipe_request', 'use_item', 'use_entity', 'entity_action', 'held_item_slot'].includes(name)) record('native_outbound', { name, packet, heldItem:bot.heldItem&&{name:bot.heldItem.name,count:bot.heldItem.count} });
    return previousWrite.apply(this, arguments);
  };
  return () => { if (bot?._client?.write && bot._client.write !== previousWrite) bot._client.write = previousWrite; };
}

function fullAcceptanceDecision(criteria){
  const required=['initialZeroExperience','experienceMatchesServer','initialEmptyInventory','naturalNormalSurvival','noTaskTimeConsoleCommands','noDeath','inventoryMatchesServer','positionMatchesServer','selfGatheredMaterialContract','actualNaturalMaterialEvidence','noUnexpectedProvider','publicTaskCompleted','originalPublicProfilePlan','productionStructureAndFurniture','naturalFurnitureActualUse','runtimeSourceUnchanged','serverNormalStop','savedOwnedUtilityConfirmed','savedNaturalMetadataConfirmed','savedCompleteBuilding','savedPlayerConfirmed','noTaskOrVerificationConsoleCommands','nativeStagesAllPassed','noFatalOrInterrupt',...(isEstate?['savedCompleteFarms']:[]),...(enchanting?['savedExperienceMatches','savedRealEnchantedItem']:[])];
  return !abortError&&!fatalError&&required.every(name=>criteria[name]===true)&&Object.values(criteria).every(value=>value===true);
}
function serverAcknowledgedMaterialFacts() {
  const observed=new Set(),errors=[];
  const take=item=>{try{const decoded=Item.fromNotch(item);if(decoded&&decoded.count>0)observed.add(decoded.name);}catch(error){errors.push(error.message);}};
  for(const e of events){if(e.type==='server_slot_ack')take(e.item);if(e.type==='server_window_inventory')for(const item of e.items||[])take(item);}
  const digs=events.filter(e=>e.type==='digging_completed');
  const wood=digs.filter(e=>/(?:_log|_stem)$/.test(e.startedBlock?.name||''));
  const base=['oak_log','oak_planks','cobblestone','glass','white_wool'];
  const rare=enchanting?['obsidian','diamond','book','bookshelf','enchanting_table']:[];
  return {acknowledgedNames:[...observed].sort(),decodeErrors:errors,actualWoodDigs:wood.length,actualCompletedDigs:digs.length,requiredNames:[...base,...rare],missingNames:[...base,...rare].filter(name=>!observed.has(name)),confirmed:wood.length>0&&[...base,...rare].every(name=>observed.has(name))};
}
function ownedTask(id) {
  const value = { taskId: id, status: 'running', source: 'deskpet', intent: 'natural_public_building_verification', executionGeneration: 1,
    logs: [], startedAt: Date.now(), currentStepIndex: 0, currentStep: 'natural_public_building_verification', cancellationToken: new CancellationToken(), plan: { steps: [] } };
  value.movementLease = agent.__testClaimMovementLease('task', id); agent.__testSetReconnectTask(value); return value;
}
async function runFurnitureUse(original, blueprint) {
  const useTask=ownedTask(`${runName}-native-use`), capturedBot=bot;
  useTask.materialSupply=clone(original.materialSupply);
  useTask.stepCheckpoint={estateFarm:clone(original.stepCheckpoint?.estateFarm||null)};
  const f=blueprint.furniture, use={profile,source:'self_gathered',checks:{},materialSupply:null};
  const at=p=>bot.blockAt(new Vec3(p.x,p.y,p.z));
  const count=name=>counts(inventory())[name]||0;
  const active=()=>{useTask.cancellationToken.throwIfRequested();assert.equal(bot,capturedBot);assert.equal(agent.__testGetReconnectTask(),useTask);assert.equal(agent.__testGetActiveMovementLease(),useTask.movementLease);if(abortError)throw abortError;if(deaths||disconnected)throw typed('NATIVE_VERIFICATION_INTERRUPTED','Death or disconnect during native verification');};
  let naturalCropOnly=false;
  const guarded=(operation,extra=()=>{})=>withHouseNativeSourceGuard(bot,{assertActive:()=>{active();if(naturalCropOnly&&bot.heldItem?.name==='bone_meal')throw typed('NATURAL_FARM_BONE_MEAL_FORBIDDEN','No bone meal interaction is authorized in natural crop verification');extra();},isOwnerContext:()=>nativeOwner.getStore()===useTask},operation);
  async function waitActual(predicate,label,ms=10000){const end=Date.now()+ms;for(;;){active();if(predicate())return;if(Date.now()>=end)throw typed('NATIVE_READBACK_TIMEOUT',label);await Promise.race([sleep(50),signalPromise,failurePromise]);}}
  async function native(operation,label,ms=15000,guard=()=>{}){active();let open=true,timer;const pending=guarded(operation,()=>{if(!open)throw typed('NATIVE_OPERATION_CLOSED','Late write after closed native operation');guard();});try{return await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>{open=false;const e=typed('NATIVE_OPERATION_TIMEOUT',label);useTask.cancellationToken.pause();requestAbort(e);reject(e);},ms);}),signalPromise]);}finally{open=false;clearTimeout(timer);}}
  async function attempt(name,operation){
    active();let entry;
    try{const evidence=await operation();active();if(evidence?.confirmed!==true)throw typed('NATIVE_VERIFICATION_UNCONFIRMED',name);entry={stage:name,status:'PASS',required:true,evidence};}
    catch(error){if(abortError||deaths||disconnected||useTask.cancellationToken.cancelled||useTask.cancellationToken.pauseRequested)throw error;
      active();entry={stage:name,status:/pending|unsupported|not_observed|not_implemented|insufficient_levels|unavailable/i.test(error.code||'')?'PENDING':'FAIL',required:true,code:error.code||'NATIVE_VERIFICATION_FAILED',message:error.message};
      if(bot.currentWindow)await native(()=>bot.closeWindow(bot.currentWindow),'Close owned failed verification window',5000).catch(()=>{});
      if(agent.__testGetActiveMovementLease()===useTask.movementLease){bot.pathfinder.setGoal(null);bot.clearControlStates();}
    }
    stages.push(entry);use.checks[name]=entry;record('native_verification_stage',entry);return entry;
  }
  async function supply(requirements,label){active();record('native_verification_self_supply',{label,requirements,anchor:blueprint.anchor,profile});await native(()=>agent.__testHouseSelfSupply(requirements,{anchor:blueprint.anchor,profile}),`Native verification self supply ${label}`,maximumMs);active();}
  async function maintainFood(){
    active();if(bot.health<16)throw typed('NATIVE_VERIFICATION_LOW_HEALTH','Natural verification stopped below16 health');
    if(bot.food>=14)return;
    const safe=['cooked_beef','cooked_porkchop','cooked_mutton','cooked_rabbit','bread','apple','carrot','rabbit','beef','porkchop','mutton'];
    const item=bot.inventory.items().find(i=>safe.includes(i.name));if(!item)throw typed('NATURAL_VERIFICATION_FOOD_PENDING','No already self-obtained food during natural wait');
    const foodBefore=bot.food,stock=count(item.name),from=events.length;
    await native(()=>bot.equip(item,'hand'),'Equip own natural food');await native(()=>bot.consume(),'Consume own natural food');
    await waitActual(()=>bot.food>foodBefore&&count(item.name)<stock&&events.slice(from).some(e=>e.type==='self_entity_status'&&e.status===9),'Actual natural food replenishment');
    record('natural_verification_food_confirmed',{item:item.name,foodBefore,foodAfter:bot.food,stockBefore:stock,stockAfter:count(item.name)});
  }
  async function walk(point,range=0.85){
    active();const goal=new goals.GoalBlock(Math.floor(point.x),Math.floor(point.y),Math.floor(point.z));
    await native(()=>bot.pathfinder.goto(goal),'Native permanent waypoint',20000);
    await waitActual(()=>bot.entity.onGround===true&&agent.__testFurnishedHouseStandingSafely(bot.entity.position),'Native waypoint grounded',2500);
    assert.ok(Math.hypot(bot.entity.position.x-point.x-0.5,bot.entity.position.z-point.z-0.5)<=range&&Math.abs(bot.entity.position.y-point.y)<=1.1,'Native waypoint actual endpoint');
    return {target:point,actual:position(bot.entity.position),onGround:bot.entity.onGround};
  }
  async function approach(point){active();await native(()=>bot.pathfinder.goto(new goals.GoalNear(point.x,point.y,point.z,2)),'Native furniture approach',20000);await bot.waitForTicks(3);active();assert.equal(bot.entity.onGround,true);assert.ok(agent.__testFurnishedHouseStandingSafely(bot.entity.position));}
  const doors=f.doors||[f.door];
  async function setDoor(door,open,guard=()=>{}){
    active();guard();for(const p of [door.lower,door.upper])assert.equal(at(p)?.name,'oak_door');
    if(at(door.lower).getProperties().open!==open)await native(()=>bot.activateBlock(at(door.lower)),'Native door activation',8000,guard);
    await waitActual(()=>[door.lower,door.upper].every(p=>at(p)?.getProperties().open===open),'Door two-half state');
  }
  async function freshWindow(p,method,label){
    await approach(p);const from=events.length,w=await native(()=>bot[method](at(p)),label);
    await waitActual(()=>events.slice(from).some(e=>e.type==='server_window_inventory'&&e.windowId===w.id),'Fresh authoritative window_items',5000);
    const packet=events.slice(from).filter(e=>e.type==='server_window_inventory'&&e.windowId===w.id).at(-1),decoded=packet.items.map(i=>Item.fromNotch(i));
    const toCounts=items=>counts(items.filter(Boolean).map(i=>({name:i.name,count:i.count})));
    return {window:w,rawPlayer:toCounts(decoded.slice(w.inventoryStart,w.inventoryEnd)),rawContainer:toCounts(decoded.slice(0,w.inventoryStart)),rawWindowId:w.id};
  }
  async function rawPlayerSnapshot(){const read=await freshWindow(f.chest,'openContainer','Own chest authoritative player snapshot');await native(()=>read.window.close(),'Snapshot window close');return read.rawPlayer;}
  const openDoors=async()=>{for(const door of doors){await approach(door.lower);await setDoor(door,true);}};
  async function waitNaturalNight(){const end=Date.now()+naturalNightMs;while(!(bot.time.timeOfDay>=12542&&bot.time.timeOfDay<=23460)){active();await maintainFood();if(Date.now()>=end)throw typed('NATURAL_NIGHT_NOT_OBSERVED','No natural night within finite wait');await Promise.race([sleep(500),signalPromise,failurePromise]);}}
  function bookshelfEvidence(){const table=f.enchantingTable;const cells=(f.bookshelves||[]).map(p=>{const dx=p.x-table.x,dz=p.z-table.z,gap={x:table.x+Math.trunc(dx/2),y:table.y,z:table.z+Math.trunc(dz/2)};return {position:p,actual:at(p)?.name,gap,clear:air(at(gap))&&air(at({...gap,y:gap.y+1}))};});return {confirmed:cells.filter(c=>c.actual==='bookshelf'&&c.clear).length>=15,effectiveCount:cells.filter(c=>c.actual==='bookshelf'&&c.clear).length,cells};}
  await nativeOwner.run(useTask,()=>agent.__testWithFurnishedHouseMovements(async()=>{
    await attempt('native_permanent_routes',async()=>{await openDoors();const routes=blueprint.routes||[{id:'entrance_and_furniture',waypoints:[blueprint.entrance.outside,blueprint.entrance.inside]}];const traversed=[];for(const route of routes){const points=[];for(const p of route.waypoints)points.push(await walk(p));traversed.push({id:route.id,points});}return {confirmed:traversed.length===routes.length,traversed};});
    await attempt('native_3x3_craft',async()=>{
      await supply({oak_planks:4,stick:2},'3x3-crafting');await openDoors();const before=await rawPlayerSnapshot();await approach(f.craftingTable);
      const recipe=bot.recipesFor(bot.registry.itemsByName.wooden_pickaxe.id,null,1,at(f.craftingTable)).find(r=>r.requiresTable);assert.ok(recipe);
      await native(()=>bot.craft(recipe,1,at(f.craftingTable)),'Native3x3 crafting',25000);const after=await rawPlayerSnapshot();
      assert.equal(after.wooden_pickaxe,(before.wooden_pickaxe||0)+1);assert.equal(after.oak_planks||0,(before.oak_planks||0)-3);assert.equal(after.stick||0,(before.stick||0)-2);
      return {confirmed:true,before,after,requiresTable:true,inventoryProof:'Actual fresh server window_items before and after native crafting'};
    });
    await attempt('native_all_chests_roundtrip',async()=>{
      await supply({oak_planks:1},'own-chest-marker');await openDoors();const results=[];
      for(const p of f.chests||[f.chest]){let read=await freshWindow(p,'openContainer','Native chest authoritative baseline');let w=read.window;const before=read.rawPlayer.oak_planks||0,old=read.rawContainer.oak_planks||0;assert.ok(before>=1);
        await native(()=>w.deposit(bot.registry.itemsByName.oak_planks.id,null,1),'Native own marker deposit');await native(()=>w.close(),'Chest close');
        read=await freshWindow(p,'openContainer','Fresh chest deposit readback');w=read.window;const deposited=read.rawContainer.oak_planks||0;assert.equal(deposited,old+1);assert.equal(read.rawPlayer.oak_planks||0,before-1);
        await native(()=>w.withdraw(bot.registry.itemsByName.oak_planks.id,null,1),'Native own marker withdraw');await native(()=>w.close(),'Chest close');
        read=await freshWindow(p,'openContainer','Fresh chest withdrawal readback');w=read.window;const after=read.rawContainer.oak_planks||0;assert.equal(after,old);assert.equal(read.rawPlayer.oak_planks||0,before);await native(()=>w.close(),'Chest close');
        results.push({position:p,beforePlayer:before,afterPlayer:read.rawPlayer.oak_planks||0,old,deposited,finalStock:after,proof:'Fresh raw server window_items on all three opens'});
      }return {confirmed:results.length===(f.chests||[f.chest]).length,results};
    });
    await attempt('native_all_furnaces_smelt',async()=>{
      const furnaces=f.furnaces||[f.furnace];await supply({sand:furnaces.length,oak_planks:furnaces.length},'all-native-furnace-inputs');await openDoors();const results=[];
      for(const p of furnaces){let read=await freshWindow(p,'openFurnace','Native furnace authoritative baseline'),w=read.window;const before=read.rawPlayer;assert.equal(w.inputItem(),null);assert.equal(w.outputItem(),null);
        await native(()=>w.putInput(bot.registry.itemsByName.sand.id,null,1),'Native sand input');await native(()=>w.putFuel(bot.registry.itemsByName.oak_planks.id,null,1),'Native own fuel');
        await waitActual(()=>w.outputItem()?.name==='glass','Actual vanilla smelting',30000);const output={name:w.outputItem().name,count:w.outputItem().count};await native(()=>w.takeOutput(),'Native output extraction');await native(()=>w.close(),'Furnace close');
        read=await freshWindow(p,'openFurnace','Fresh furnace output/player readback');w=read.window;const after=read.rawPlayer;assert.equal(w.outputItem(),null);assert.equal(after.glass,(before.glass||0)+1);assert.equal(after.sand||0,before.sand-1);assert.equal(after.oak_planks||0,before.oak_planks-1);await native(()=>w.close(),'Furnace close');results.push({position:p,before,after,output,proof:'Fresh raw server player inventory after native output extraction'});
      }return {confirmed:results.length===furnaces.length,results};
    });
    await attempt('native_all_beds_sleep_wake',async()=>{
      await openDoors();const results=[];
      for(const bed of f.beds||[f.bed]){await waitNaturalNight();await approach(bed.foot);const from=events.length;await native(()=>bot.sleep(at(bed.foot)),'Native natural-night sleep',8000);await waitActual(()=>bot.isSleeping===true&&events.slice(from).some(e=>e.type==='native_sleep'),'Native bed sleeping',3000);
        const occupied=[bed.foot,bed.head].map(p=>({position:p,name:at(p)?.name,properties:at(p)?.getProperties()}));assert.ok(occupied.some(b=>b.properties.occupied===true));
        await native(()=>bot.wake(),'Native bed wake',8000);await waitActual(()=>bot.isSleeping===false&&events.slice(from).some(e=>e.type==='native_wake'),'Native real wake',8000);results.push({bed,occupied,timeOfDay:bot.time.timeOfDay,woke:true});
      }return {confirmed:results.length===(f.beds||[f.bed]).length,results};
    });
    if(enchanting){
      await attempt('fifteen_effective_bookshelves',async()=>bookshelfEvidence());
      await attempt('natural_xp_and_native_level30_enchantment',async()=>{
        if((bot.experience?.level||0)<30)throw typed('NATURAL_XP_PROVIDER_PENDING','No integrated natural XP30 provider; real observed level remains below30');
        const privateModule='/private/tmp/deskpet-house-natural-enchant.cjs';if(!fs.existsSync(privateModule))throw typed('NATIVE_ENCHANT_ADAPTER_PENDING','Private strictly native enchant verifier unavailable');
        const {createHouseNaturalEnchant}=require(privateModule);let xpCP=null;
        const tableSpec=blueprint.blocks.find(s=>s.item==='enchanting_table'&&key(s.position)===key(f.enchantingTable));
        const owned=!!tableSpec&&(stateFor(original)?.ownedBlockIds||[]).includes(tableSpec.id);
        const candidate=createHouseNaturalEnchant({getBot:()=>bot,assertActive:active,isOwnerContext:()=>nativeOwner.getStore()===useTask,getCP:()=>xpCP,saveCP:v=>{active();xpCP=clone(v);record('natural_xp_verification_checkpoint',{checkpoint:xpCP});},onOperationTimeout:error=>{useTask.cancellationToken.pause();requestAbort(error);},
          returncamp:async camp=>{await openDoors();await walk(camp);},reach:async p=>{await openDoors();await approach(p);},ownedEnchantmentTable:async()=>({confirmedOwned:owned,position:f.enchantingTable}),
          ensureMaterials:async options=>{if(options.stage!=='enchant30')return {pending:true,reason:'Active natural XP acquisition not implemented'};try{await supply(options.requirements,'natural-level30-enchant-inputs');return {confirmed:true};}catch(e){if(/unsupported|pending/.test(e.code||''))return {pending:true,reason:e.message};throw e;}}});
        const camp=original.materialSupply?.camp?.anchor;assert.ok(camp&&['x','y','z'].every(axis=>Number.isSafeInteger(camp[axis])),'Actual self-owned camp anchor required');const before=clone(bot.experience);await candidate.ensureLevels(30,{anchor:camp});const result=await candidate.enchant30({anchor:camp,itemName:'wooden_pickaxe',table:f.enchantingTable});active();return {confirmed:result.confirmed===true,before,after:clone(bot.experience),native:result,provenance:'Actual raw experience updates; no XP setup or arithmetic substitution'};
      });
    }
    if(isEstate){
      await attempt('natural_age7_harvest_pickup_replant_and_seed_reserve',async()=>{
        await supply({wheat_seeds:2},'self-obtained-replant-reserve');await openDoors();const spec={schema:1,id:`${profile}:${key(blueprint.anchor)}:farms`,plots:blueprint.farms};
        const end=Date.now()+naturalGrowthMs,targets=[];
        for(const plot of blueprint.farms){await walk(plot.access[0]);let chosen;while(!chosen){active();await maintainFood();chosen=plot.crops.find(c=>at(c.position)?.name==='wheat'&&Number(at(c.position).getProperties().age)===7);if(chosen)break;if(Date.now()>=end)throw typed('NATURAL_CROP_MATURITY_NOT_OBSERVED','No naturally age7 crop in every plot within budget');await Promise.race([sleep(1000),signalPromise,failurePromise]);}targets.push(chosen.position);record('natural_crop_age7_observed',{plot:plot.id,position:chosen.position,properties:at(chosen.position).getProperties()});}
        if(targets.some(p=>Number(at(p)?.getProperties().age)!==7))throw typed('NATURAL_CROP_MATURITY_NOT_OBSERVED','A selected crop changed before harvest');
        const reserve=()=>count('wheat_seeds')+(useTask.materialSupply?.storage?.chests||[]).reduce((n,c)=>n+(c.stock?.wheat_seeds||0),0);
        const beforeReserve=reserve(),from=events.length;let summary;naturalCropOnly=true;try{summary=await native(()=>agent.__testEstateFarm(spec,{postPublicTask:true,allowBoneMeal:true,targets}),'Natural native harvest/replant',180000);}finally{naturalCropOnly=false;}active();
        const afterReserve=reserve();assert.equal(summary.validationVerified,true);assert.equal(summary.boneMealUsed,0);assert.equal(summary.cycles.length,2);assert.ok(summary.cycles.every(c=>c.ageMature===7&&c.ageAfterReplant===0&&c.seedConsumedForReplant===1&&c.wheatCollected>=1&&c.boneMealUsed===0));
        const forbidden=events.slice(from).filter(e=>e.type==='native_outbound'&&['use_item','block_place'].includes(e.name)&&e.heldItem?.name==='bone_meal');assert.equal(forbidden.length,0);
        if(afterReserve<beforeReserve)throw typed('FARM_RENEWABILITY_NOT_DEMONSTRATED',`Observed seed reserve decreased ${beforeReserve}->${afterReserve}; no supplementary seed added within cycle`);
        return {confirmed:true,targets,summary,beforeReserve,afterReserve,netSeedReserve:afterReserve-beforeReserve,sampleCount:summary.cycles.length,boneMealPackets:forbidden.length,limits:'Finite observed cycles only; no claim of guaranteed infinite renewability'};
      });
    }
    if(profile==='riverside_villa')await attempt('actual_natural_riverside_and_dock_out_and_back',async()=>{
      const dock=blueprint.blocks.filter(s=>s.component==='villa_dock'&&s.item==='oak_planks'),biomes=dock.map(s=>{const b=at({...s.position,y:s.position.y-1});return {position:s.position,block:b?.name,biome:typeof b?.biome==='string'?b.biome:b?.biome?.name||bot.registry.biomes[b?.biome]?.name||null};});
      if(!biomes.some(b=>/river/.test(b.biome||'')))throw typed('NATURAL_RIVERSIDE_BIOME_PENDING','Loaded world has not established a natural river biome; water alone is insufficient');
      const route=blueprint.routes.find(r=>r.id==='dock_access');assert.ok(route);const points=[];for(const p of [...route.waypoints,...route.waypoints.slice().reverse()]){points.push(await walk(p));assert.notEqual(bot.entity.isInWater,true);assert.notEqual(bot.entity.isInLava,true);}return {confirmed:true,biomes,points};
    });
    await attempt('native_final_door_closure_and_exit',async()=>{
      const plan=isEstate?planEstateDoorClosure(blueprint):[{door:f.door,side:'outside',approach:blueprint.entrance.outside,escapePurpose:'leave_public_house'}],closed=[];
      for(const step of plan){await walk(step.approach,0.85);const [dx,dz]={north:[0,-1],south:[0,1],east:[1,0],west:[-1,0]}[step.door.facing];
        const side=()=>{active();const p=bot.entity.position,n=(p.x-step.door.lower.x-0.5)*dx+(p.z-step.door.lower.z-0.5)*dz;assert.equal(bot.entity.onGround,true);assert.ok(step.side==='outside'?n>0.35:n< -0.35);};
        await setDoor(step.door,false,side);closed.push(step);
      }await walk(blueprint.entrance.outside);return {confirmed:doors.every(d=>[d.lower,d.upper].every(p=>at(p)?.getProperties().open===false)),closed,actualExit:position(bot.entity.position)};
    });
  }));
  use.materialSupply=clone(useTask.materialSupply);use.finalInventory=inventory();use.finalPosition=position(bot.entity.position);use.experience=clone(bot.experience);
  const expected=['native_permanent_routes','native_3x3_craft','native_all_chests_roundtrip','native_all_furnaces_smelt','native_all_beds_sleep_wake','native_final_door_closure_and_exit',...(enchanting?['fifteen_effective_bookshelves','natural_xp_and_native_level30_enchantment']:[]),...(isEstate?['natural_age7_harvest_pickup_replant_and_seed_reserve']:[]),...(profile==='riverside_villa'?['actual_natural_riverside_and_dock_out_and_back']:[])];use.requiredStages=expected;use.confirmed=expected.length>0&&expected.every(name=>use.checks[name]?.status==='PASS');return use;
}

async function stopServerOnce() {
  if (stopped) return stopped;
  let requested = false, forced = false;
  if (server && !serverOutcome) {
    if (server.stdin.writable) { consoleRead('stop'); requested = true; }
    try { await deadline(serverExitPromise, 60000, 'Server graceful stop timeout'); }
    catch { forced = true; server.kill('SIGTERM'); try { await deadline(serverExitPromise, 10000, 'Server SIGTERM timeout'); }
      catch { server.kill('SIGKILL'); await deadline(serverExitPromise, 5000, 'Owned server SIGKILL timeout'); } }
  }
  if(server&&serverClosePromise)await deadline(serverClosePromise,5000,'Owned server stdio close timeout');
  stopped = { requested, forced, ...serverOutcome, stopped: !server || !!serverOutcome,serverClosed,
    normal: !!serverOutcome && serverOutcome.code === 0 && serverOutcome.signal == null && !forced && serverClosed };
  if (created) fs.writeFileSync(path.join(runDir, 'server-lifecycle.json'), json(stopped, 2) + '\n', { flag: 'wx' }); return stopped;
}
function stopServer() { return stopPromise ||= stopServerOnce(); }
async function savedAudit() {
  const world=path.join(runDir,'world'),wholeWorld=dir=>{const out={};for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const f=path.join(dir,e.name);if(e.isDirectory())Object.assign(out,wholeWorld(f));else if(e.isFile())out[path.relative(world,f)]=hash(f);}return out;};
  const before=wholeWorld(world),metadata=await readLevelMetadata(world),cells=new Map(),chunks=new Map();
  async function load(p){if(cells.has(key(p)))return;const loc=blockLocation(p),id=`${loc.chunkX},${loc.chunkZ}`;if(!chunks.has(id))chunks.set(id,await readRegionChunk(world,p));const saved=chunks.get(id),section=saved.chunk.sections.find(s=>s.Y===loc.sectionY);cells.set(key(p),{position:{...p},...(section?decodeSectionBlock(section,p):{name:'minecraft:air',properties:{},absentAirSection:true})});}
  const get=p=>{assert.ok(cells.has(key(p)),'Saved block must be loaded from real full MCA');return cells.get(key(p));};
  const supply=nativeUse?.materialSupply||frozenTask?.materialSupply,camp=supply?.camp,owned=supply?.ownedStations||{},storage=supply?.storage;
  for(const entry of [...Object.values(owned),...(storage?.chests||[])])await load(entry.position);
  const stations=Object.entries(owned).map(([item,entry])=>({item,position:entry.position,actual:get(entry.position),confirmed:get(entry.position).name===`minecraft:${item}`}));
  function containerAt(p){const loc=blockLocation(p),chunk=chunks.get(`${loc.chunkX},${loc.chunkZ}`).chunk;return(chunk.block_entities||[]).find(e=>e.x===p.x&&e.y===p.y&&e.z===p.z);}
  const canonical=stock=>json(Object.entries(stock||{}).filter(([,n])=>n).sort(([a],[b])=>a.localeCompare(b)));
  const chests=(storage?.chests||[]).map(entry=>{const saved=containerAt(entry.position),savedStock=counts((saved?.Items||[]).map(i=>({name:i.id.replace(/^minecraft:/,''),count:i.count})));const stockConfirmed=!!saved&&canonical(savedStock)===canonical(entry.stock)&&!entry.pendingTransfer&&!entry.pendingClosedInventory;return{position:entry.position,actual:get(entry.position),confirmed:entry.confirmedPlaced===true&&get(entry.position).name==='minecraft:chest'&&stockConfirmed,stockConfirmed,expectedStock:entry.stock,savedStock,items:saved?.Items||[]};});
  const house=stateFor(frozenTask);let structure=null,farms=null,builtContainers=[],savedBedStates=[];
  if(house?.anchor){const blueprint=blueprintFor(house.anchor);
    for(const entry of [...blueprint.blocks,...blueprint.clearance,...blueprint.scaffold])await load(entry.position);
    if(!isEstate)for(let x=-1;x<=blueprint.dimensions.width;x++)for(let z=-1;z<=blueprint.dimensions.depth;z++)for(let y=0;y<=blueprint.dimensions.maxY;y++)await load({x:house.anchor.x+x,y:house.anchor.y+y,z:house.anchor.z+z});
    const mismatches=compareManifest(get,blueprint),geometry=isEstate?null:geometryEvidence(get,blueprint),clearance=blueprint.clearance.filter(c=>!air(get(c.position))),scaffold=blueprint.scaffold.filter(c=>!air(get(c.position)));
    for(const p of [...(blueprint.furniture.chests||[blueprint.furniture.chest]),...(blueprint.furniture.furnaces||[blueprint.furniture.furnace])]){await load(p);builtContainers.push({position:p,block:get(p),blockEntity:containerAt(p)||null});}
    savedBedStates=(blueprint.furniture.beds||[blueprint.furniture.bed]).map(b=>({bed:b,foot:get(b.foot),head:get(b.head),unoccupied:get(b.foot).properties.occupied==='false'&&get(b.head).properties.occupied==='false'}));
    structure={profile,anchor:house.anchor,mismatches,geometry,clearance,scaffold,savedBedStates,confirmed:mismatches.length===0&&clearance.length===0&&scaffold.length===0&&savedBedStates.every(b=>b.unoccupied)};
    if(isEstate){const plots=[];for(const plot of blueprint.farms){for(const p of [plot.water,...plot.soil,...plot.crops.map(c=>c.position)])await load(p);const water=get(plot.water),soil=plot.soil.map(get),crops=plot.crops.map(c=>get(c.position));plots.push({id:plot.id,water,soil,crops,confirmed:water.name==='minecraft:water'&&Number(water.properties.level)===0&&soil.length===24&&soil.every(b=>b.name==='minecraft:farmland'&&Number(b.properties.moisture)===7)&&crops.length===24&&crops.every(b=>b.name==='minecraft:wheat')});}farms={plots,confirmed:plots.length===2&&plots.every(p=>p.confirmed)};}
  }
  const nbt=req('prismarine-nbt'),playerDir=path.join(world,'playerdata'),files=fs.readdirSync(playerDir).filter(f=>f.endsWith('.dat'));assert.equal(files.length,1,'Exactly one actual natural Survival player');
  const player=nbt.simplify((await nbt.parse(fs.readFileSync(path.join(playerDir,files[0])))).parsed),savedInventory=(player.Inventory||[]).map(i=>({name:i.id.replace(/^minecraft:/,''),count:i.count,slot:i.Slot,components:i.components||i.tag||null}));
  const allSavedItems=[...(player.Inventory||[]),...chests.flatMap(c=>c.items),...builtContainers.flatMap(c=>c.blockEntity?.Items||[])];
  const positiveLevels=value=>value&&typeof value==='object'&&Object.entries(value).some(([k,v])=>typeof v==='number'&&v>0&&k.includes(':')||v&&typeof v==='object'&&positiveLevels(v));
  const enchantedItems=allSavedItems.filter(i=>positiveLevels(i.components?.['minecraft:enchantments'])||i.tag?.Enchantments?.length);
  const playerCounts=counts(savedInventory),clientCounts=counts(finalReadback.clientInventory),positionDifference=Math.hypot(...player.Pos.map((v,i)=>v-finalReadback.serverPosition[['x','y','z'][i]]));
  const savedPlayer={position:player.Pos,inventory:savedInventory,gameType:player.playerGameType,health:player.Health,food:player.foodLevel,experience:{level:player.XpLevel,total:player.XpTotal,progress:player.XpP},inventoryMatchesClient:canonical(playerCounts)===canonical(clientCounts),positionDifference,enchantedItems};
  const naturalMetadataConfirmed=metadata.seed===campaign.seed&&metadata.gameType===0&&metadata.difficulty===2&&metadata.generator==='minecraft:noise'&&['doMobSpawning','doDaylightCycle','doWeatherCycle','naturalRegeneration'].every(r=>metadata.gameRules[r]==='true')&&metadata.gameRules.keepInventory==='false';
  assert.deepEqual(wholeWorld(world),before,'Read-only independent audit must preserve all saved world files');
  const audit={schema:1,mode,profile,readOnly:true,metadata,seed:campaign.seed,naturalMetadataConfirmed,camp,stations,chests,structure,farms,builtContainers,savedPlayer,
    ownedUtilityConfirmed:stations.length>=2&&stations.every(s=>s.confirmed)&&stations.some(s=>s.item==='crafting_table'&&s.confirmed)&&stations.some(s=>s.item==='furnace'&&s.confirmed)&&chests.length>=1&&chests.every(c=>c.confirmed),
    savedPlayerConfirmed:savedPlayer.gameType===0&&savedPlayer.inventoryMatchesClient&&positionDifference<=0.15,
    savedExperienceMatches:!!finalReadback.clientExperience&&player.XpLevel===finalReadback.clientExperience.level&&player.XpTotal===finalReadback.clientExperience.points&&Math.abs(player.XpP-finalReadback.clientExperience.progress)<=1e-6,
    originalWorldUnchangedByAudit:true,worldFilesHashed:Object.keys(before).length};
  fs.writeFileSync(path.join(runDir,'independent-natural-public-building-audit.json'),json(audit,2)+'\n',{flag:'wx'});return audit;
}

async function main() {
  assert.ok(argv.includes('--accept-eula'),'Explicit --accept-eula required');
  for(const name of ['MC_AGENT_DATA_DIR','MC_AGENT_DIAGNOSTICS_DIR','MC_AGENT_LEARNING_PATH'])assert.equal(process.env[name],undefined,'Isolated public acceptance must not reuse external agent state');
  assert.ok(fs.existsSync(installed.java) && fs.existsSync(installed.minecraft.jar), 'Installed Java/JAR missing');
  assert.ok(!fs.existsSync(path.join(runDir, 'world')), 'Allocated run must still have no preexisting world');
  const seedProof = inspectSeedAllocation(runDir); assert.equal(seedProof.receiptSha256, hash(campaignFile)); assert.equal(campaign.version, installed.minecraft.version); created = true;
  record('seed_committed_before_generation', { campaign, campaignFile, sha256: hash(campaignFile) });
  const probe=createServer();let port;try{assertStartupActive();probe.listen(0,'127.0.0.1');await once(probe,'listening');assertStartupActive();port=probe.address().port;}finally{await new Promise(resolve=>probe.close(resolve));}assertStartupActive();
  const properties = { 'server-ip': '127.0.0.1', 'server-port': port, 'online-mode': false, 'enforce-secure-profile': false, 'enable-rcon': false,
    'level-name': 'world', 'level-type': 'minecraft:normal', 'level-seed': campaign.seed, 'generate-structures': true, difficulty: 'normal', gamemode: 'survival',
    'force-gamemode': true, 'max-players': 1, 'view-distance': 10, 'simulation-distance': 8, 'spawn-protection': 0, 'allow-flight': false, 'sync-chunk-writes': true, 'pause-when-empty-seconds': 0 };
  fs.writeFileSync(path.join(runDir, 'server.properties'), Object.entries(properties).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  fs.writeFileSync(path.join(runDir, 'eula.txt'), '# Authorized isolated local test.\neula=true\n');
  sourceBefore = hashes();
  for (const [name, expected] of Object.entries(campaign.runtime.files)) assert.equal(sourceBefore[name], expected, 'Runtime source changed after persistent seed allocation');
  assert.equal(hash(__filename), campaign.runner.sha256); assert.equal(hash(path.join(__dirname, 'fresh-seed-allocation-v1.cjs')), campaign.allocator.sha256);
  saveSources(sourceBefore);
  record('run_started', { mode, sourceHashes: sourceBefore, properties, java: installed.java, jar: installed.minecraft.jar, jarSha256: hash(installed.minecraft.jar),
    runDir, profile,publicCommand:commandText,declaredMaterialSource:'self_gathered',
    policy: 'Empty natural spawn. No human resources, foreign depots, terrain/time/weather/XP/effects/teleport/gamerule mutations. No Java/source stubs.' });
  assertStartupActive();assert.ok(!fs.existsSync(path.join(runDir, 'world')), 'Refusing world creation/reuse before owned Java startup');server = spawn(installed.java, ['-Xms1G', '-Xmx3G', '-jar', installed.minecraft.jar, 'nogui'], { cwd: runDir, stdio: ['pipe', 'pipe', 'pipe'] });
  server.once('spawn', () => record('owned_server_spawned', { pid: server.pid, port, java: installed.java, worldDir: runDir }));
  serverClosePromise=new Promise(resolve=>server.once('close',(code,signal)=>{serverClosed=true;record('server_closed',{code,signal,pid:server.pid});resolve({code,signal});}));
  serverExitPromise = new Promise(resolve => { server.once('exit', (code, signal) => { serverOutcome = { code, signal, pid: server.pid }; record('server_exit', serverOutcome); resolve(serverOutcome); });
    server.once('error', error => { serverOutcome = { code: null, signal: null, error: error.message, pid: server.pid }; record('server_error', serverOutcome); resolve(serverOutcome); }); });
  server.stdin.on('error', error => { record('server_stdin_error', { message: error.message }); if (!serverOutcome && !stopPromise) requestAbort(error); });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { serverOutput += chunk.toString(); fs.appendFileSync(path.join(runDir, 'server.log'), chunk); checkWaiters(); });
  await waitForServer(/Done \([^)]+\)! For help/, 240000, 0);
  const serverSeed = await read('seed', /Seed: \[-?\d+\]/); assert.equal(serverSeed.match(/\[(-?\d+)\]/)[1], campaign.seed);
  const difficulty = await read('difficulty', /The difficulty is \w+/); assert.ok(/normal/i.test(difficulty));
  const gameRules = {}; for (const rule of ['doMobSpawning', 'doDaylightCycle', 'doWeatherCycle', 'keepInventory', 'naturalRegeneration']) {
    const line = await read(`gamerule ${rule}`, new RegExp(`Gamerule ${rule} is currently set to: (?:true|false)`)); gameRules[rule] = line.endsWith('true'); }
  assert.deepEqual(gameRules, { doMobSpawning: true, doDaylightCycle: true, doWeatherCycle: true, keepInventory: false, naturalRegeneration: true });
  record('natural_rules_confirmed', { gameRules, difficulty, seed: campaign.seed });
  assertStartupActive();bot = mineflayer.createBot(withMinecraftProtocolCompatibility({ host: '127.0.0.1', port, username, auth: 'offline', version: installed.minecraft.version, hideErrors: false }));
  releaseChunkObservers = installChunkObservers(bot, record, () => executionStarted != null && executionEnded == null);
  await Promise.race([deadline(once(bot, 'spawn'), 60000, 'Natural spawn timeout'), signalPromise]); assertStartupActive(); installObservers(); installMinecraftBedWakeCompatibility(bot);
  const playerLoadedSent = await Promise.race([deadline(acknowledgePlayerLoaded(bot), 60000, 'Player-loaded handshake timeout'), signalPromise]);
  await Promise.race([deadline(bot.waitForChunksToLoad(), 60000, 'Initial chunk readiness timeout'), signalPromise]); record('player_loaded_ack', { sent: playerLoadedSent, version: bot.version });
  assertStartupActive();assert.equal(bot.game.gameMode, 'survival'); assert.equal(inventory().length, 0);
  const emptyRead = await authoritative();const initialExperience=await authoritativeExperience();assert.equal(initialExperience.confirmed,true);assert.deepEqual(initialExperience.serverExperience,{level:0,points:0,progress:0}); assert.equal(emptyRead.serverInventory.length, 0); assert.ok(emptyRead.inventoryMatches && emptyRead.positionDifference <= .15);
  initial = record('empty_natural_spawn', { ...emptyRead,type:'empty_natural_spawn',initialExperience, health: bot.health, food: bot.food, gameMode: bot.game.gameMode });
  agent = createMinecraftTaskAgent({ appPaths: { appDataDir: path.join(runDir, 'deskpet-data') }, readConfig: () => ({ mcExecutorMode: 'strict-executor', mcAgentAutoReconnect: false }),
    parseJsonObjectFromText: JSON.parse, broadcast: event => record('agent_event', { event }), broadcastMinecraftError: message => record('agent_error', { message }),
    allowAutonomousMaintenance: () => false, requestPlannerCompletion: async () => { record('unexpected_provider_request'); throw new Error('No cloud provider authorized for this native acceptance'); } });
  agent.attachBot(bot); agent.initializeBotRuntime();
  failurePromise = new Promise((_, reject) => { pollingReject = reject; }); failurePromise.catch(() => {});
  polling = setInterval(() => { try { snapshot(); if (deaths || disconnected || serverOutcome) pollingReject(new Error('Death, disconnect or server exit during execution')); } catch (error) { pollingReject(error); } }, 500);
  executionStarted = Date.now();
  record('public_task_submitted',{command:commandText,profile,materialSource:'self_gathered',noHarnessAnchor:true});
  await Promise.race([agent.handleMessage({type:'mc_command_submit',command:commandText,source:'deskpet'}),failurePromise,signalPromise]);
  const limit=executionStarted+maximumMs;
  while(Date.now()<limit){await Promise.race([sleep(500),failurePromise,signalPromise]);task=agent.__testGetReconnectTask();if(task&&['completed','failed','paused','cancelled'].includes(task.status))break;}
  if (abortError) throw abortError;
  if(!['completed','failed','paused','cancelled'].includes(task?.status))stages.push({stage:'public_construction_completed',status:'FAIL',required:true,code:'PUBLIC_TASK_TIMEOUT'});else stages.push({stage:'public_construction_completed',status:task.status==='completed'?'PASS':'FAIL',required:true,actualStatus:task.status,error:task.error});
  record('public_task_execution_ended',{status:task?.status}); snapshot(true); frozenTask = taskEvidence(task);
  fs.writeFileSync(path.join(runDir, 'task-outcome-before-cleanup.json'), json(frozenTask, 2) + '\n', { flag: 'wx' });
  record('task_outcome_frozen', { status: frozenTask?.status, error: frozenTask?.error, mode, publicTaskCompleted: mode === 'public' && frozenTask?.status === 'completed' });
  if (mode === 'public' && frozenTask?.status === 'completed' && stateFor(frozenTask)?.anchor) {
    const blueprint = blueprintFor(stateFor(frozenTask).anchor);
    nativeUse = await Promise.race([deadline(runFurnitureUse(task, blueprint),verificationMaximumMs,'Native functional verification deadline'), failurePromise, signalPromise]); record('native_use_result', nativeUse);
  }
  if(!nativeUse)stages.push({stage:'independent_native_functional_verification',status:'NOT_RUN',required:true,code:'PUBLIC_CONSTRUCTION_NOT_COMPLETED'});
  // Original terminal task already frozen; pause only unfinished native work.
  const activeTask = agent.__testGetReconnectTask(); if (activeTask && ['running', 'planning'].includes(activeTask.status)) await agent.handleMessage({ type: 'mc_command_pause' });
  agent.__testSetReconnectTask(null); agent.detachBot('manual_disconnect'); agent.dispose(); agent = null; clearInterval(polling); executionEnded=Date.now();record('all_native_execution_ended'); await sleep(200);
  finalReadback = await authoritative();finalReadback.experienceReadback=await authoritativeExperience();finalReadback.clientExperience=clone(finalReadback.experienceReadback.clientExperience||null); const finalCounts = counts(finalReadback.clientInventory), serverCounts = counts(finalReadback.serverInventory);
  const houseState = stateFor(frozenTask), summary = houseState?.verificationSummary;
  const utility = frozenTask?.materialSupply;
  const materialEvidence=serverAcknowledgedMaterialFacts();
  const sourcePolicy = utility?.schema === 1 && utility.materialSource === 'self_gathered' && utility.profile === profile;
  const criteria = { initialEmptyInventory: initial.serverInventory.length === 0 && initial.clientInventory.length === 0,
    initialZeroExperience:initial.initialExperience?.confirmed===true&&initial.initialExperience.serverExperience.level===0&&initial.initialExperience.serverExperience.points===0&&initial.initialExperience.serverExperience.progress===0,
    experienceMatchesServer:finalReadback.experienceReadback?.confirmed===true,
    naturalNormalSurvival: bot.game.gameMode === 'survival' && gameRules.doMobSpawning && gameRules.doDaylightCycle && gameRules.doWeatherCycle && !gameRules.keepInventory,
    noTaskTimeConsoleCommands: events.filter(e => e.type === 'server_command' && e.duringExecution).length === 0,
    noDeath: deaths === 0, inventoryMatchesServer: finalReadback.inventoryMatches, positionMatchesServer: finalReadback.positionDifference <= .15,
    selfGatheredMaterialContract: sourcePolicy,actualNaturalMaterialEvidence:materialEvidence.confirmed, noUnexpectedProvider: !events.some(e => e.type === 'unexpected_provider_request') };
  Object.assign(criteria,{ publicTaskCompleted:frozenTask?.status==='completed',originalPublicProfilePlan:!!publicPlanSnapshot&&validatePublicPlan(publicPlanSnapshot).confirmed,
    productionStructureAndFurniture:summary?.schema===profiles[profile].schema&&summary.sourceProfile===profile&&summary.missingBlocks===0&&summary.stateMismatches?.length===0&&summary.clearanceViolations?.length===0&&summary.furnitureVerified===true&&!houseState.ownedScaffold?.length&&(!isEstate||summary.routeVerified===true&&summary.farmVerified===true),
    naturalFurnitureActualUse:nativeUse?.confirmed===true });
  const ending = once(bot, 'end').catch(() => {}); bot.quit('Controlled natural acceptance finished'); await deadline(ending, 5000, 'Client disconnect timeout').catch(() => {});
  await stopServer(); const audit = stopped.normal ? await savedAudit() : null;
  sourceAfter = hashes(); criteria.runtimeSourceUnchanged = json(sourceBefore) === json(sourceAfter); criteria.serverNormalStop = stopped.normal;
  criteria.savedOwnedUtilityConfirmed = audit?.ownedUtilityConfirmed === true;
  criteria.savedNaturalMetadataConfirmed = audit?.naturalMetadataConfirmed === true;
  criteria.savedCompleteBuilding=audit?.structure?.confirmed===true;criteria.savedPlayerConfirmed=audit?.savedPlayerConfirmed===true;
  if(isEstate)criteria.savedCompleteFarms=audit?.farms?.confirmed===true;
  if(enchanting){criteria.savedExperienceMatches=audit?.savedExperienceMatches===true;}
  if(enchanting)criteria.savedRealEnchantedItem=(audit?.savedPlayer?.enchantedItems?.length||0)>0;
  criteria.noTaskOrVerificationConsoleCommands=!events.some(e=>e.type==='server_command'&&e.duringExecution);
  criteria.nativeStagesAllPassed=nativeUse?.requiredStages?.length>0&&nativeUse.requiredStages.every(name=>nativeUse.checks[name]?.status==='PASS');
  criteria.noFatalOrInterrupt=!abortError&&!fatalError;
  if(abortError||fatalError)process.exitCode=1;
  result = { schema: 1, observerRevision: 5, runnerRevision:6,seedPolicyRevision:1,parentRunnerSha256: '8880727e18ccf78dff09ec7f1098776b6a6fb5685e1ed9af456a80a7f07c966d', mode, profile, runName, verificationStages:stages,fatalError,interruption:abortError&&{code:abortError.code||null,message:abortError.message}, version: installed.minecraft.version, seed: campaign.seed, startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt,
    command:commandText,publicPlanSnapshot,
    initial, task: frozenTask,materialEvidence,  nativeUse, finalReadback, criteria,
    unmetCriteria: Object.entries(criteria).filter(([, passed]) => passed !== true).map(([name]) => name),
    publicBuildingAcceptancePassed:mode==='public'&&fullAcceptanceDecision(criteria),
    sourceHashes: { started: sourceBefore, ended: sourceAfter }, stopped,
    limits: ['Every attempt keeps a distinct crypto signed64 seed allocated before preflight/start; failed attempts are retained. No arbitrary-map acceptance claim.', 'Only the actual public task plus every required independent native stage and saved-world proof can pass.', 'No supplied resources/setup/grants; all native post-use inputs also self-gathered. Unsupported required stages remain PENDING, never PASS.', 'Absent MCA chunk remains error/UNKNOWN, never guessed air.'] };
  fs.writeFileSync(path.join(runDir, 'result.json'), json(result, 2) + '\n', { flag: 'wx' }); console.log(json(result, 2));
  if (result.unmetCriteria.length) process.exitCode = 1;
}
main().catch(async error => {
  console.error(error.stack || error); process.exitCode = 1;
  if (!created) return;
  clearInterval(polling);
  record('harness_failure', { message: error.message, code: error.code || null, stack: error.stack, fatalError, task: taskEvidence(task) });
  if (agent) {
    try { const current = agent.__testGetReconnectTask(); if (current && ['running', 'planning'].includes(current.status)) await deadline(agent.handleMessage({ type: 'mc_command_pause' }), 5000, 'Failure pause timeout'); }
    catch (cleanupError) { record('cleanup_error', { step: 'pause', message: cleanupError.message }); }
    for (const [step, cleanup] of [['clear_task', () => agent.__testSetReconnectTask(null)], ['detach', () => agent.detachBot('manual_disconnect')], ['dispose', () => agent.dispose()]]) {
      try { cleanup(); } catch (cleanupError) { record('cleanup_error', { step, message: cleanupError.message }); }
    }
    agent = null;
  }
  try { bot?.quit('Natural harness failure'); } catch { /* Continue owned server cleanup after a closed client. */ }
  try { await stopServer(); } catch (cleanupError) { record('server_stop_error', { message: cleanupError.message }); }
  const failure = { schema: 1, observerRevision: 5, runnerRevision:6,seedPolicyRevision:1,parentRunnerSha256: '8880727e18ccf78dff09ec7f1098776b6a6fb5685e1ed9af456a80a7f07c966d', mode, profile, runName, verificationStages:stages, harnessFailure: { message: error.message, code: error.code || null, fatalError }, task: frozenTask || taskEvidence(task), stopped,
    publicBuildingAcceptancePassed: false, sourceHashes: { started: sourceBefore, ended: hashes() } };
  if (!fs.existsSync(path.join(runDir, 'result.json'))) fs.writeFileSync(path.join(runDir, 'result.json'), json(failure, 2) + '\n', { flag: 'wx' });
}).finally(() => { releaseDynamicObservers(); releaseChunkObservers(); for (const waiter of waiters) clearTimeout(waiter.timer); clearInterval(polling);
  for (const [signal, handler] of Object.entries(signalHandlers)) process.removeListener(signal, handler);
  for (const [event, handler] of Object.entries(fatalHandlers)) process.removeListener(event, handler); });
