// Revision12: original-task-only acceptance; append-only evidence stays on disk; retain only final-criteria event types in memory.
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
const {equipmentFromEntitySNBT,savedEquipment,mergeEquipment}=require('./vanilla-player-equipment-v1.cjs');
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('node natural-public-building-acceptance-v13-camp-respawn.cjs --accept-eula --run-name UNIQUE --profile cottage|enchanting_library|medieval_castle|riverside_villa [--timeout-ms 7200000] [--verification-timeout-ms 7200000] [--natural-growth-timeout-ms 3600000] [--natural-night-timeout-ms 1250000] | --preflight');
  console.log('Fresh normal Survival empty-inventory public construction with self-obtained functional inputs. Unsupported mandatory capabilities remain PENDING; supplied component fixtures never count.');
  console.log('v13 reserves a unique crypto signed64 seed and fresh run directory before runtime/Java preflight. --preflight also consumes its UNIQUE run-name/seed; actual execution needs another UNIQUE name. Failed allocation/preflight/start attempts are never deleted, resumed or redrawn.');
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
// Development continuation: fixed saved world, never allocates or redraws a seed.
const parentDir = path.join(installation, 'worlds', 'natural-cottage-formal-20261017-58');
const runName = argument('--run-name', 'development-continue-01'); assert.match(runName, /^[A-Za-z0-9_-]+$/);
const runDir = path.join(parentDir, 'continuations', runName);
assert.ok(fs.existsSync(path.join(parentDir, 'world', 'level.dat')), 'Saved world 58 required');
fs.mkdirSync(runDir, {recursive:true});
assert.ok(!fs.existsSync(path.join(runDir,'events.jsonl')), 'Never overwrite continuation evidence');
fs.symlinkSync(path.join(parentDir,'world'), path.join(runDir,'world'), 'dir');
for(const name of ['libraries','versions'])if(fs.existsSync(path.join(parentDir,name)))fs.symlinkSync(path.join(parentDir,name),path.join(runDir,name),'dir');
const campaignFile = path.join(parentDir,'seed-allocation.json');
const campaign = JSON.parse(fs.readFileSync(campaignFile,'utf8'));
const installed = JSON.parse(fs.readFileSync(path.join(installation, 'installation.json'), 'utf8'));
const req = createRequire(path.join(runtimeRoot, 'package.json'));
const mineflayer = req('mineflayer');
const { Vec3 } = req('vec3');
const { goals } = req('mineflayer-pathfinder');
const { createRuntimeTickLoop } = req(path.join(runtimeRoot, 'vendor/server/minecraft/runtimeTickLoop'));
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
if(argv.includes('--preflight')){console.log(JSON.stringify({observerRevision:5,siteObserverRevision:1,runnerRevision:13,seedPolicyRevision:1,runtimeTickLoopRevision:1,parentRunnerSha256:'26af281a7052b873098795d721769755f1311f5075fa2543f87e3b5e5f4fda91',profile,commandText,seed:campaign.seed,seedAllocationFile:campaignFile,seedRuntimeSha256:campaign.runtime.sha256,actualPublicPlan:validatePublicPlan(actualHeuristicPlan),javaStarted:false,implementedRunner:true,liveAccepted:false,readiness:'PRIVATE_OFFLINE_VERIFIED_LIVE_NOT_RUN',typedPendingCapabilities:['natural_xp_provider','natural_lapis_provider','rare_fluid_provider','natural_riverside_selector']}));process.exit(0);}
let priorWorldDeaths=0;
const startedAt = Date.now();
const events = [], waiters = new Set(), digTargets = new Map();
let created = false, server, serverOutcome, serverExitPromise, serverClosePromise, serverClosed=false, serverOutput = '', bot, agent, task, frozenTask;
let polling, pollingReject, failurePromise, signalReject, runtimeTicks;
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
  // Keep every original event on disk. Full task/graph snapshots grow during
  // hours of native gathering, so they must not accumulate again in the heap.
  // These are exactly the event kinds read by the final acceptance predicates.
  if (['server_slot_ack','server_window_inventory','digging_completed','server_command','unexpected_provider_request'].includes(type)) events.push(event);
  fs.appendFileSync(path.join(runDir, 'events.jsonl'), json(event) + '\n'); return event;
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
  all['private/vanilla-player-equipment-v1.cjs']=hash(path.join(__dirname,'vanilla-player-equipment-v1.cjs'));
  if(fs.existsSync('/private/tmp/deskpet-house-natural-enchant.cjs'))all['private/deskpet-house-natural-enchant.cjs']=hash('/private/tmp/deskpet-house-natural-enchant.cjs');
  for(const name of ['mineflayer/lib/plugins/inventory','mineflayer/lib/plugins/craft','mineflayer/lib/plugins/furnace','mineflayer/lib/plugins/enchantment_table','mineflayer/lib/plugins/bed','mineflayer/lib/plugins/physics','mineflayer-pathfinder'])all[`native/${name}.js`]=hash(req.resolve(name));return all;
}
function saveSources(manifest) {
  for (const [relative, digest] of Object.entries(manifest)) {
    const from = relative === 'private/natural-public-building-acceptance.cjs' ? __filename : relative === 'private/fresh-seed-allocation-v1.cjs' ? path.join(__dirname, 'fresh-seed-allocation-v1.cjs') : relative === 'private/vanilla-player-equipment-v1.cjs' ? path.join(__dirname,'vanilla-player-equipment-v1.cjs') : relative.startsWith('private/') ? path.join('/private/tmp',path.basename(relative)) : relative.startsWith('native/') ? req.resolve(relative.slice(7,-3)) : path.join(runtimeRoot, relative);
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
    siteSearch: value.siteSearch,
    plan: value.plan, diagnostics: value.diagnostics, stepCheckpoint: value.stepCheckpoint, materialSupply: value.materialSupply, logs: value.logs });
}
// SITE_OBSERVER_REVISION_1_BEGIN
// Pure checkpoint projection only. This never establishes site validity,
// physical arrival, materials or ownership, and never reads the world/bot.
function siteSearchObservation(value) {
  const read = (object, name) => { try { return object?.[name]; } catch { return undefined; } };
  const text = value => typeof value === 'string' ? value.slice(0, 160) : null;
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const point = value => ['x','y','z'].every(k => Number.isSafeInteger(read(value,k)))
    ? Object.fromEntries(['x','y','z'].map(k => [k,read(value,k)])) : null;
  const array = value => Array.isArray(value) ? value : null;
  const keys = value => { try { return value && typeof value === 'object' ? Object.keys(value) : null; } catch { return null; } };
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
  try {
  if (!value || typeof value !== 'object') return null;
  const checked = array(read(value,'checkedNodes')), diagnostics = read(value,'diagnostics'), rejection = read(diagnostics,'rejections');
  const rejectionKeys = keys(rejection), graph = read(value,'graph'), order = array(read(graph,'order')), nodes = read(graph,'nodes'), nodeKeys = keys(nodes);
  const observed = new Set(); let invalidOrder = false;
  if (order) for (let i = 0; i < Math.min(order.length,256); i++) {
    const id = read(order,i), p = point(read(read(nodes,id),'position'));
    if (typeof id !== 'string' || !p || id !== `${p.x},${p.y},${p.z}` || observed.has(id)) { invalidOrder = true; continue; }
    observed.add(id);
  }
  const water = read(graph,'pendingWater'), trail = read(graph,'pendingDryTrail'), prefix = array(read(trail,'confirmedPrefix'));
  const reservation = read(value,'reservation'), camp = read(reservation,'camp'), stations = keys(read(camp,'stations')), storage = array(read(camp,'storageSites'));
  const graphValid = read(graph,'schema') === 2 && read(graph,'kind') === 'loaded_dry_waypoint_graph';
  const current = text(read(graph,'current')), resume = text(read(graph,'resumeNode'));
  return { siteObserverRevision:1, proofDomain:'CHECKPOINT_OBSERVATION_ONLY', schema:number(read(value,'schema')), kind:text(read(value,'kind')), profile:text(read(value,'profile')),
    startedAt:number(read(value,'startedAt')), deadline:number(read(value,'deadline')), creatorGeneration:number(read(value,'creatorGeneration')), budgetGeneration:number(read(value,'budgetGeneration')),
    checkedNodesCount:checked ? checked.length : null, checkedNodesSample:checked ? checked.slice(0,16).map(text) : null, checkedNodesTruncated:checked ? checked.length > 16 : null,
    diagnostics:{ reads:number(read(diagnostics,'reads')), inspected:number(read(diagnostics,'inspected')), advances:number(read(diagnostics,'advances')),
      rejectionReasonCount:rejectionKeys ? rejectionKeys.length : null, rejections:rejectionKeys ? Object.fromEntries(rejectionKeys.slice(0,64).map(k => [text(k),number(read(rejection,k))])) : null,
      rejectionsTruncated:rejectionKeys ? rejectionKeys.length > 64 : null },
    graph:graph ? { schema:number(read(graph,'schema')), kind:text(read(graph,'kind')), nodeObjectCount:nodeKeys ? nodeKeys.length : null, registeredOrderCount:order ? order.length : null,
      actualRegisteredNodeCount:graphValid && order && order.length <= 256 && !invalidOrder ? observed.size : null,
      registrationProjectionTruncated:order ? order.length > 256 : null, current, currentRegistered:graphValid && order && order.length <= 256 && !invalidOrder ? observed.has(current) : null,
      resumeNode:resume, probes:number(read(graph,'probes')), visits:number(read(graph,'visits')), frontierCount:array(read(graph,'frontier'))?.length ?? null, blockedEdgesCount:array(read(graph,'blockedEdges'))?.length ?? null,
      pendingWater:water ? { present:true, originNode:text(read(water,'originNode')), reverse:typeof read(water,'reverse') === 'boolean' ? read(water,'reverse') : null } : null,
      pendingDryTrail:trail ? { present:true, kind:text(read(trail,'kind')), originNode:text(read(trail,'originNode')), targetNode:text(read(trail,'targetNode')), confirmedPrefixCount:prefix ? prefix.length : null } : null } : null,
    reservation:reservation ? { schema:number(read(reservation,'schema')), kind:text(read(reservation,'kind')), profile:text(read(reservation,'profile')), houseAnchor:point(read(reservation,'houseAnchor')),
      campAnchor:point(read(camp,'anchor')), campNodeId:text(read(reservation,'campNodeId')), stationCount:stations ? stations.length : null, storageSiteCount:storage ? storage.length : null,
      confirmedAt:number(read(reservation,'confirmedAt')), houseDigest:digest(read(reservation,'houseDigest')),
      campDigest:digest(read(reservation,'campDigest')) } : null };
  } catch { return { siteObserverRevision:1,proofDomain:'CHECKPOINT_OBSERVATION_ONLY',observationError:'Site checkpoint projection unavailable' }; }
}
// SITE_OBSERVER_REVISION_1_END
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
    siteSearch: siteSearchObservation(task?.siteSearch),
    supply, house: house && { ...house, ownedBlockIds: undefined, ownedBlocksCount: house.ownedBlockIds?.length } };
  const signature = json(data);
  if (force || signature !== lastSignature || Date.now() - lastReport > 30000) { record('snapshot', data); lastSignature = signature; }
  if (force || Date.now() - lastReport > 15000) {
    console.log(json({ elapsedMs: Date.now() - startedAt, mode, status: task?.status, progress: task?.progressText,
      siteSearch: data.siteSearch,
      position: data.position, health: data.health, food: data.food, inventory: counts(data.inventory) })); lastReport = Date.now();
  }
}
function checkWaiters() {
  for (const waiter of waiters) { const pending = serverOutput.slice(waiter.from);
    // Node stdout chunks may split one large entity NBT response. Only a
    // complete server line can resolve an observational readback.
    const complete = pending.slice(0,pending.lastIndexOf('\n')+1);
    const match = complete.match(waiter.pattern); if (!match) continue;
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
    || text === `data get entity ${username}`
    || new RegExp(`^data get entity ${username} (?:Inventory|Pos|Health|foodLevel|foodSaturationLevel|foodExhaustionLevel|XpLevel|XpTotal|XpP)$`).test(text)
    || /^data get block -?\d+ -?\d+ -?\d+$/.test(text)
    || /^execute if block -?\d+ -?\d+ -?\d+ [a-z_]+(?:\[[a-z0-9_=,]+\])? run say DESKPET_SELF_[A-Z0-9_-]+$/.test(text)
    || /^say DESKPET_SELF_[A-Z0-9_-]+$/.test(text);
  assert.ok(allowed, `Non-observational command refused: ${text}`);
  assert.ok(server?.stdin.writable && server.exitCode === null, 'Owned server stdin unavailable');
  record('server_command', { command: text, duringExecution: executionStarted != null && executionEnded == null }); server.stdin.write(text + '\n');
}
async function read(text, pattern) { const answer = waitForServer(pattern); consoleRead(text); return answer; }
async function entity(field) { return read(`data get entity ${username}${field ? ` ${field}` : ""}`, new RegExp(`${username} has the following entity data: [^\\r\\n]+`)); }
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
    const serverInventory = mergeEquipment(parseInventory(await entity('Inventory')),equipmentFromEntitySNBT(await entity(''))), serverPosition = parsePos(await entity('Pos'));
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
  bot._client.on('damage_event', packet => record('native_damage_event', { packet, self: packet.entityId === bot.entity?.id }));
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
  const earlyBed=supply?.respawnCamp;let savedCampBed=null;
  if(earlyBed?.foot&&earlyBed?.head){
    for(const p of [earlyBed.foot,earlyBed.head,earlyBed.access].filter(Boolean))await load(p);
    savedCampBed={record:earlyBed,foot:get(earlyBed.foot),head:get(earlyBed.head)};
    savedCampBed.confirmed=earlyBed.placed===true&&earlyBed.spawnConfirmed===true&&['foot','head'].every(part=>{
      const actual=savedCampBed[part];return actual.name==='minecraft:white_bed'&&actual.properties.part===part&&actual.properties.facing==='north';});
  }
  const nbt=req('prismarine-nbt'),playerDir=path.join(world,'playerdata'),files=fs.readdirSync(playerDir).filter(f=>f.endsWith('.dat'));assert.equal(files.length,1,'Exactly one actual natural Survival player');
  const player=nbt.simplify((await nbt.parse(fs.readFileSync(path.join(playerDir,files[0])))).parsed),savedInventory=[...(player.Inventory||[]).map(i=>({name:i.id.replace(/^minecraft:/,''),count:i.count,slot:i.Slot,components:i.components||i.tag||null})),...savedEquipment(player.equipment)];
  const allSavedItems=[...(player.Inventory||[]),...Object.values(player.equipment||{}),...chests.flatMap(c=>c.items),...builtContainers.flatMap(c=>c.blockEntity?.Items||[])];
  const positiveLevels=value=>value&&typeof value==='object'&&Object.entries(value).some(([k,v])=>typeof v==='number'&&v>0&&k.includes(':')||v&&typeof v==='object'&&positiveLevels(v));
  const enchantedItems=allSavedItems.filter(i=>positiveLevels(i.components?.['minecraft:enchantments'])||i.tag?.Enchantments?.length);
  const playerCounts=counts(savedInventory),clientCounts=counts(finalReadback.clientInventory),positionDifference=Math.hypot(...player.Pos.map((v,i)=>v-finalReadback.serverPosition[['x','y','z'][i]]));
  const savedPlayer={respawn:player.respawn||null,position:player.Pos,inventory:savedInventory,gameType:player.playerGameType,health:player.Health,food:player.foodLevel,experience:{level:player.XpLevel,total:player.XpTotal,progress:player.XpP},inventoryMatchesClient:canonical(playerCounts)===canonical(clientCounts),positionDifference,enchantedItems};
  const finalBeds=structure?.savedBedStates?.map(b=>b.bed)||[],respawn=player.respawn;
  const savedFinalBedRespawnConfirmed=Array.isArray(respawn?.pos)&&respawn.pos.length===3
    &&(!respawn.dimension||respawn.dimension==='minecraft:overworld')&&finalBeds.some(b=>[b.foot,b.head].some(p=>['x','y','z'].every((axis,i)=>p[axis]===respawn.pos[i])));
  let earlyCampRespawnEstablished=false;
  const trace=frozenTask?.diagnostics?.tracePath;
  if(trace&&fs.existsSync(trace)){
    const rows=require('node:readline').createInterface({input:fs.createReadStream(trace),crlfDelay:Infinity});let confirmationAt=null,defenseAt=null;
    for await(const line of rows){if(!line.trim())continue;const row=JSON.parse(line);if(row.taskId!==frozenTask.taskId||row.event!=='house_preparation_stage')continue;
      if(row.details?.stage==='camp_respawn_confirmed'&&row.details.spawnConfirmed===true&&confirmationAt===null)confirmationAt=row.at;
      if(row.details?.stage==='defense'&&defenseAt===null)defenseAt=row.at;
    }
    earlyCampRespawnEstablished=savedCampBed?.confirmed===true&&Number.isFinite(confirmationAt)&&Number.isFinite(defenseAt)&&confirmationAt<=defenseAt;
  }
  const naturalMetadataConfirmed=metadata.seed===campaign.seed&&metadata.gameType===0&&metadata.difficulty===2&&metadata.generator==='minecraft:noise'&&['doMobSpawning','doDaylightCycle','doWeatherCycle','naturalRegeneration'].every(r=>metadata.gameRules[r]==='true')&&metadata.gameRules.keepInventory==='false';
  assert.deepEqual(wholeWorld(world),before,'Read-only independent audit must preserve all saved world files');
  const audit={schema:1,mode,profile,readOnly:true,metadata,seed:campaign.seed,naturalMetadataConfirmed,camp,savedCampBed,earlyCampRespawnEstablished,savedFinalBedRespawnConfirmed,stations,chests,structure,farms,builtContainers,savedPlayer,
    ownedUtilityConfirmed:stations.length>=2&&stations.every(s=>s.confirmed)&&stations.some(s=>s.item==='crafting_table'&&s.confirmed)&&stations.some(s=>s.item==='furnace'&&s.confirmed)&&chests.length>=1&&chests.every(c=>c.confirmed),
    savedPlayerConfirmed:savedPlayer.gameType===0&&savedPlayer.inventoryMatchesClient&&positionDifference<=0.15,
    savedExperienceMatches:!!finalReadback.clientExperience&&player.XpLevel===finalReadback.clientExperience.level&&player.XpTotal===finalReadback.clientExperience.points&&Math.abs(player.XpP-finalReadback.clientExperience.progress)<=1e-6,
    originalWorldUnchangedByAudit:true,worldFilesHashed:Object.keys(before).length};
  fs.writeFileSync(path.join(runDir,'independent-natural-public-building-audit.json'),json(audit,2)+'\n',{flag:'wx'});return audit;
}

async function originalTaskCombatEvidence(value) {
  const file = value?.diagnostics?.tracePath;
  const selected = [];
  if (file && fs.existsSync(file)) {
    const lines = require('node:readline').createInterface({input:fs.createReadStream(file),crlfDelay:Infinity});
    for await (const line of lines) {
      if (!/house_combat_mode_started|house_defense_attack_sent|house_combat_cover_removed|house_combat_cleanup_verification|house_combat_task_resumed/.test(line)) continue;
      const entry=JSON.parse(line); if(entry.taskId===value.taskId) selected.push(entry);
    }
  }
  const hurts = [];
  const nativeLines = require('node:readline').createInterface({input:fs.createReadStream(path.join(runDir,'events.jsonl')),crlfDelay:Infinity});
  for await (const line of nativeLines) {
    if (!line.includes('entity_hurt')) continue;
    const event=JSON.parse(line);
    if (event.type==='entity_hurt' && event.self===true && Number.isFinite(Date.parse(event.at))) hurts.push({...event,epochMs:Date.parse(event.at)});
  }
  const hostileNames = new Set(['zombie','husk','drowned','spider','cave_spider','enderman','creeper','skeleton','stray','bogged','pillager','witch','phantom','blaze','ghast','vindicator','evoker','ravager','guardian','elder_guardian']);
  const starts=selected.filter(e=>e.event==='house_combat_mode_started'&&e.details?.resumeTaskId===value.taskId);
  let hurtAttack=null;
  for (const hurt of hurts) {
    const attack=selected.find(e=>e.event==='house_defense_attack_sent'&&e.at>=hurt.epochMs&&e.at-hurt.epochMs<=1000&&hostileNames.has(e.details?.targetName));
    if(!attack)continue;
    const start=starts.filter(e=>e.at<=attack.at).at(-1);
    const ended=start&&selected.some(e=>e.event==='house_combat_task_resumed'&&e.at>=start.at&&e.at<attack.at);
    if(start&&!ended){hurtAttack={start,attack,hurt};break;}
  }
  const cleanup=selected.find(e=>e.event==='house_combat_cleanup_verification'&&e.details?.removed>0&&e.details.pendingWork===0&&!e.details.interrupted&&!e.details.deadlineReached);
  const resumed=cleanup&&selected.find(e=>e.event==='house_combat_task_resumed'&&e.at>=cleanup.at&&e.details?.cleanupPending===0&&e.details.resumeTaskId===value.taskId);
  return {source:file,originalTaskId:value?.taskId,hurtAttack:!!hurtAttack,clearedAndResumed:!!resumed,
    defenseAlreadyActive:hurtAttack?hurtAttack.start.at<hurtAttack.hurt.epochMs:null,
    reactionMs:hurtAttack&&hurtAttack.start.at>=hurtAttack.hurt.epochMs?hurtAttack.start.at-hurtAttack.hurt.epochMs:null,
    attackDelayMs:hurtAttack?hurtAttack.attack.at-hurtAttack.hurt.epochMs:null,
    hurt:hurtAttack?.hurt,defense:hurtAttack?.start,attack:hurtAttack?.attack,cleanup,resumed,originalTaskCompleted:value?.status==='completed'};
}
async function main() {
  assert.ok(argv.includes('--accept-eula'),'Explicit --accept-eula required');
  priorWorldDeaths=await require('./stream-native-deaths-v1.cjs').countPriorWorldDeaths(path.join(parentDir,'continuations'),runName);
  for(const name of ['MC_AGENT_DATA_DIR','MC_AGENT_DIAGNOSTICS_DIR','MC_AGENT_LEARNING_PATH'])assert.equal(process.env[name],undefined,'Isolated public acceptance must not reuse external agent state');
  assert.ok(fs.existsSync(installed.java) && fs.existsSync(installed.minecraft.jar), 'Installed Java/JAR missing');
  assert.ok(fs.existsSync(path.join(runDir, 'world', 'level.dat')), 'Fixed saved world required');
  assert.equal(campaign.version, installed.minecraft.version); created = true;
  record('seed_committed_before_generation', { campaign, campaignFile, sha256: hash(campaignFile) });
  const probe=createServer();let port;try{assertStartupActive();probe.listen(0,'127.0.0.1');await once(probe,'listening');assertStartupActive();port=probe.address().port;}finally{await new Promise(resolve=>probe.close(resolve));}assertStartupActive();
  const properties = { 'server-ip': '127.0.0.1', 'server-port': port, 'online-mode': false, 'enforce-secure-profile': false, 'enable-rcon': false,
    'level-name': 'world', 'level-type': 'minecraft:normal', 'level-seed': campaign.seed, 'generate-structures': true, difficulty: 'normal', gamemode: 'survival',
    'force-gamemode': true, 'max-players': 1, 'view-distance': 10, 'simulation-distance': 8, 'spawn-protection': 0, 'allow-flight': false, 'sync-chunk-writes': true, 'pause-when-empty-seconds': 0 };
  fs.writeFileSync(path.join(runDir, 'server.properties'), Object.entries(properties).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  fs.writeFileSync(path.join(runDir, 'eula.txt'), '# Authorized isolated local test.\neula=true\n');
  sourceBefore = hashes();
  record('development_continuation', {parentDir, freshEmptyInventoryAcceptance:false, publicProductionAgent:true});
  saveSources(sourceBefore);
  record('run_started', { mode, sourceHashes: sourceBefore, properties, java: installed.java, jar: installed.minecraft.jar, jarSha256: hash(installed.minecraft.jar),
    runDir, profile,publicCommand:commandText,declaredMaterialSource:'self_gathered',
    policy: 'SAVED WORLD 58 development continuation with its actual carried inventory. No human resources, foreign depots, terrain/time/weather/XP/effects/teleport/gamerule mutations. No Java/source stubs.' });
  assertStartupActive();assert.ok(fs.existsSync(path.join(runDir, 'world', 'level.dat')), 'Refusing loss of fixed world');server = spawn(installed.java, ['-Xms1G', '-Xmx3G', '-jar', installed.minecraft.jar, 'nogui'], { cwd: runDir, stdio: ['pipe', 'pipe', 'pipe'] });
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
  assertStartupActive();bot = mineflayer.createBot(withMinecraftProtocolCompatibility({ host: '127.0.0.1', port, username, auth: 'offline', respawn: false, version: installed.minecraft.version, hideErrors: false }));
  // The saved development player may be dead from a prior attempt. Use the
  // same vanilla client's ordinary respawn once, before task execution only.
  const savedDeathRespawn=()=>{record('native_saved_world_respawn_requested',{priorWorldDeaths,resourcesGranted:false});bot.respawn();};
  if(priorWorldDeaths>0)bot.once('death',savedDeathRespawn);
  releaseChunkObservers = installChunkObservers(bot, record, () => executionStarted != null && executionEnded == null);
  await Promise.race([deadline(once(bot, 'spawn'), 60000, 'Natural spawn timeout'), signalPromise]); assertStartupActive(); bot.removeListener('death',savedDeathRespawn); installObservers(); installMinecraftBedWakeCompatibility(bot);
  // Finish native chunk readiness before the ordinary client loading ACK.
  // Keep loading protection only through controller initialization and the
  // public resume call; never extend it into gameplay or grant acceptance.
  await Promise.race([deadline(bot.waitForChunksToLoad(), 60000, 'Initial chunk readiness timeout'), signalPromise]);
  assertStartupActive();assert.equal(bot.game.gameMode, 'survival'); record('continued_inventory', {inventory:inventory()});
  // This is a saved development world with failed fresh criteria. Start
  // its production controller promptly; a native client snapshot is labeled
  // explicitly and never relabeled as a server inventory readback.
  const emptyRead={serverInventory:null,clientInventory:inventory(),serverReadback:'NOT_OBSERVED_AT_CONTINUATION_START',
    clientPosition:position(bot.entity.position),inventoryMatches:null,positionDifference:null};
  const initialExperience={confirmed:false,reason:'development_start_readback_skipped_to_avoid_exposed_idle_actor'};
  initial = record('saved_world_continuation_spawn', { ...emptyRead,type:'saved_world_continuation_spawn',initialExperience, health: bot.health, food: bot.food, gameMode: bot.game.gameMode });
  agent = createMinecraftTaskAgent({ appPaths: { appDataDir: path.join(parentDir, 'production-agent-data') }, getWorldIdentity:()=>fs.realpathSync(path.join(parentDir,'world')), readConfig: () => ({ mcExecutorMode: 'strict-executor', mcAgentAutoReconnect: false, mcTaskAutoRecovery:true }),
    parseJsonObjectFromText: JSON.parse, broadcast: event => record('agent_event', { event }), broadcastMinecraftError: message => record('agent_error', { message }),
    allowAutonomousMaintenance: () => false, requestPlannerCompletion: async () => { record('unexpected_provider_request'); throw new Error('No cloud provider authorized for this native acceptance'); } });
  agent.attachBot(bot); agent.initializeBotRuntime();
  failurePromise = new Promise((_, reject) => { pollingReject = reject; }); failurePromise.catch(() => {});
  polling = setInterval(() => { try { snapshot(); if (deaths || disconnected || serverOutcome) pollingReject(new Error('Death, disconnect or server exit during execution')); } catch (error) { pollingReject(error); } }, 500);
  runtimeTicks = createRuntimeTickLoop({ isReady: () => Boolean(agent && bot?.entity && !disconnected && !serverOutcome),
    tick: () => agent.tickIdleBehavior(), onFault: error => {
      agent?.reportRuntimeFault?.('idle_tick_fault', error, { broadcastError: false });
      record('runtime_tick_fault', { code: error.code, message: error.message });
    } });
  record('production_tick_loop_started', { intervalMs: 2000, autonomousMaintenance: false, sharedRuntimeScheduler: true });
  executionStarted = Date.now();
  record('public_task_submitted',{command:commandText,profile,materialSource:'self_gathered',noHarnessAnchor:true});
  const hasProductionCheckpoint=fs.existsSync(path.join(parentDir,'production-agent-data','minecraft-agent','task-checkpoint.json'));
  record('production_checkpoint_resume_decision',{hasProductionCheckpoint,taskInjection:false});
  await Promise.race([agent.handleMessage(hasProductionCheckpoint?{type:'mc_command_resume'}:{type:'mc_command_submit',command:commandText,source:'deskpet'}),failurePromise,signalPromise]);
  const playerLoadedSent = await Promise.race([deadline(acknowledgePlayerLoaded(bot), 60000, 'Player-loaded handshake timeout'),failurePromise, signalPromise]);
  record('player_loaded_ack', { sent: playerLoadedSent, version: bot.version, publicControllerAlreadyAttached:true, publicResumeAlreadyRequested:true });
  const limit=executionStarted+maximumMs;
  while(Date.now()<limit){await Promise.race([sleep(500),failurePromise,signalPromise]);task=agent.__testGetReconnectTask();if(task&&['completed','failed','paused','cancelled'].includes(task.status)&&!(task.status==='paused'&&task.automaticWorkRecovery?.enabled))break;}
  if (abortError) throw abortError;
  if(!['completed','failed','paused','cancelled'].includes(task?.status))stages.push({stage:'public_construction_completed',status:'FAIL',required:true,code:'PUBLIC_TASK_TIMEOUT'});else stages.push({stage:'public_construction_completed',status:task.status==='completed'?'PASS':'FAIL',required:true,actualStatus:task.status,error:task.error});
  await runtimeTicks.stop(); record('production_tick_loop_drained');
  record('public_task_execution_ended',{status:task?.status}); snapshot(true); frozenTask = taskEvidence(task);
  fs.writeFileSync(path.join(runDir, 'task-outcome-before-cleanup.json'), json(frozenTask, 2) + '\n', { flag: 'wx' });
  record('task_outcome_frozen', { status: frozenTask?.status, error: frozenTask?.error, mode, publicTaskCompleted: mode === 'public' && frozenTask?.status === 'completed' });
  if(frozenTask?.status!=='completed'){
    // A paused task is already a failed development attempt. Disconnect now,
    // before slow readbacks can leave a stopped actor exposed to live mobs.
    clearInterval(polling);executionEnded=Date.now();record('failed_task_disconnect_before_observer_readbacks',{status:frozenTask?.status});
    agent.detachBot('manual_disconnect');agent.dispose();agent=null;
    if(bot?._client?.state==='play')bot.quit('Saved development pause; disconnect before observer readbacks');
    await sleep(100);await stopServer();sourceAfter=hashes();
    result={developmentContinuation:true,parentWorld:parentDir,priorWorldDeaths,task:frozenTask,stopped,
      publicBuildingAcceptancePassed:false,developmentEquipmentHouseFurnitureCompleted:false,
      failureObserverReadbacksSkipped:true,criteria:{publicTaskCompleted:false,noDeath:deaths===0&&priorWorldDeaths===0,
        runtimeSourceUnchanged:json(sourceBefore)===json(sourceAfter),serverNormalStop:stopped.normal},
      unmetCriteria:['publicTaskCompleted','full_building_furniture_combat_acceptance_not_completed']};
    fs.writeFileSync(path.join(runDir,'result.json'),json(result,2)+'\n',{flag:'wx'});
    console.log(json({status:frozenTask?.status,error:frozenTask?.error,normalStop:stopped.normal,priorWorldDeaths,developmentContinuation:true}));process.exitCode=1;return;
  }
  if (mode === 'public' && frozenTask?.status === 'completed' && stateFor(frozenTask)?.anchor) {
    const blueprint = blueprintFor(stateFor(frozenTask).anchor);
    const actual = stateFor(frozenTask)?.actualFurnitureUse;
    const names = { routes:'native_permanent_routes',crafting:'native_3x3_craft',chest:'native_all_chests_roundtrip',furnace:'native_all_furnaces_smelt',bed:'native_all_beds_sleep_wake',door:'native_final_door_closure_and_exit' };
    nativeUse = actual && { ...actual, materialSupply: frozenTask.materialSupply, requiredStages: Object.values(names),
      checks: Object.fromEntries(Object.entries(names).map(([key,name]) => [name,{stage:name,status:actual.checks[key]?.confirmed===true?'PASS':'NOT_OBSERVED',required:true,evidence:actual.checks[key]}])) };
    assert.equal(actual?.originalTaskId, frozenTask.taskId, 'Furniture must belong to the original public task');
    record('original_task_native_use_result', nativeUse);
  }
  if(!nativeUse)stages.push({stage:'original_task_functional_verification',status:'NOT_RUN',required:true,code:'PUBLIC_CONSTRUCTION_NOT_COMPLETED'});
  // Original terminal task already frozen; pause only unfinished native work.
  const activeTask = agent.__testGetReconnectTask(); if (activeTask && ['running', 'planning'].includes(activeTask.status)) await agent.handleMessage({ type: 'mc_command_pause' });
  agent.detachBot('manual_disconnect'); agent.dispose(); agent = null; clearInterval(polling); executionEnded=Date.now();record('all_native_execution_ended'); await sleep(200);
  finalReadback = await authoritative();finalReadback.experienceReadback=await authoritativeExperience();finalReadback.clientExperience=clone(finalReadback.experienceReadback.clientExperience||null); const finalCounts = counts(finalReadback.clientInventory), serverCounts = counts(finalReadback.serverInventory);
  const houseState = stateFor(frozenTask), summary = houseState?.verificationSummary;
  const utility = frozenTask?.materialSupply;
  const combatEvidence=await originalTaskCombatEvidence(frozenTask);
  fs.writeFileSync(path.join(runDir,'original-task-combat-evidence.json'),json(combatEvidence,2)+'\n',{flag:'wx'});
  const materialEvidence=serverAcknowledgedMaterialFacts();
  const sourcePolicy = utility?.schema === 1 && utility.materialSource === 'self_gathered' && utility.profile === profile;
  const criteria = { initialEmptyInventory: initial.serverInventory?.length === 0 && initial.clientInventory.length === 0,
    initialZeroExperience:initial.initialExperience?.confirmed===true&&initial.initialExperience.serverExperience.level===0&&initial.initialExperience.serverExperience.points===0&&initial.initialExperience.serverExperience.progress===0,
    experienceMatchesServer:finalReadback.experienceReadback?.confirmed===true,
    naturalNormalSurvival: bot.game.gameMode === 'survival' && gameRules.doMobSpawning && gameRules.doDaylightCycle && gameRules.doWeatherCycle && !gameRules.keepInventory,
    noTaskTimeConsoleCommands: events.filter(e => e.type === 'server_command' && e.duringExecution).length === 0,
    noDeath: deaths === 0 && priorWorldDeaths === 0, inventoryMatchesServer: finalReadback.inventoryMatches, positionMatchesServer: finalReadback.positionDifference <= .15,
    selfGatheredMaterialContract: sourcePolicy,actualNaturalMaterialEvidence:materialEvidence.confirmed, noUnexpectedProvider: !events.some(e => e.type === 'unexpected_provider_request') };
  Object.assign(criteria,{ publicTaskCompleted:frozenTask?.status==='completed',originalPublicProfilePlan:!!publicPlanSnapshot&&validatePublicPlan(publicPlanSnapshot).confirmed,
    productionStructureAndFurniture:summary?.schema===profiles[profile].schema&&summary.sourceProfile===profile&&summary.missingBlocks===0&&summary.stateMismatches?.length===0&&summary.clearanceViolations?.length===0&&summary.furnitureVerified===true&&!houseState.ownedScaffold?.length&&(!isEstate||summary.routeVerified===true&&summary.farmVerified===true),
    naturalFurnitureActualUse:nativeUse?.confirmed===true,
    furnitureSameOriginalTask:nativeUse?.originalTaskId===frozenTask?.taskId && frozenTask?.status==='completed',
    hurtCounterattackObserved:combatEvidence.hurtAttack===true,
    actualOwnedObstacleCleanupAndOriginalTaskResume:combatEvidence.clearedAndResumed===true&&combatEvidence.originalTaskCompleted===true,
    actualEquippedIronKit:require(path.join(runtimeRoot,'vendor/server/minecraft/houseIronEquipment')).carriedIronEquipmentVerified(bot)===true });
  const ending = once(bot, 'end').catch(() => {}); bot.quit('Controlled natural acceptance finished'); await deadline(ending, 5000, 'Client disconnect timeout').catch(() => {});
  await stopServer(); const audit = stopped.normal ? await savedAudit() : null;
  sourceAfter = hashes(); criteria.runtimeSourceUnchanged = json(sourceBefore) === json(sourceAfter); criteria.serverNormalStop = stopped.normal;
  criteria.savedOwnedUtilityConfirmed = audit?.ownedUtilityConfirmed === true;
  criteria.earlyCampRespawnEstablished=audit?.earlyCampRespawnEstablished===true;
  criteria.savedFinalBedRespawnConfirmed=audit?.savedFinalBedRespawnConfirmed===true;
  criteria.savedNaturalMetadataConfirmed = audit?.naturalMetadataConfirmed === true;
  criteria.savedCompleteBuilding=audit?.structure?.confirmed===true;criteria.savedPlayerConfirmed=audit?.savedPlayerConfirmed===true;
  if(isEstate)criteria.savedCompleteFarms=audit?.farms?.confirmed===true;
  if(enchanting){criteria.savedExperienceMatches=audit?.savedExperienceMatches===true;}
  if(enchanting)criteria.savedRealEnchantedItem=(audit?.savedPlayer?.enchantedItems?.length||0)>0;
  criteria.noTaskOrVerificationConsoleCommands=!events.some(e=>e.type==='server_command'&&e.duringExecution);
  criteria.nativeStagesAllPassed=nativeUse?.requiredStages?.length>0&&nativeUse.requiredStages.every(name=>nativeUse.checks[name]?.status==='PASS');
  criteria.noFatalOrInterrupt=!abortError&&!fatalError;
  if(abortError||fatalError)process.exitCode=1;
  result = { schema: 1, observerRevision: 5, siteObserverRevision:1, runnerRevision:13,seedPolicyRevision:1,runtimeTickLoopRevision:1,parentRunnerSha256:'26af281a7052b873098795d721769755f1311f5075fa2543f87e3b5e5f4fda91', mode, profile, runName, verificationStages:stages,fatalError,interruption:abortError&&{code:abortError.code||null,message:abortError.message}, version: installed.minecraft.version, seed: campaign.seed, startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt,
    command:commandText,publicPlanSnapshot,
    initial, task: frozenTask,materialEvidence, combatEvidence, nativeUse, finalReadback, criteria,
    unmetCriteria: Object.entries(criteria).filter(([, passed]) => passed !== true).map(([name]) => name),
    developmentContinuation:true,parentWorld:parentDir,priorWorldDeaths,
    developmentEquipmentHouseFurnitureCompleted:criteria.publicTaskCompleted&&criteria.actualEquippedIronKit&&criteria.savedCompleteBuilding&&criteria.nativeStagesAllPassed,
    publicBuildingAcceptancePassed:false,strictCriteriaSatisfied:mode==='public'&&fullAcceptanceDecision(criteria),
    sourceHashes: { started: sourceBefore, ended: sourceAfter }, stopped,
    limits: ['Every attempt keeps a distinct crypto signed64 seed allocated before preflight/start; failed attempts are retained. No arbitrary-map acceptance claim.', 'Only the original public task, its own actual functional furniture results, observed combat/cleanup and saved-world proof can pass. No independent verification actor or client supplements any stage.', 'No supplied resources/setup/grants; all native post-use inputs also self-gathered. Unsupported required stages remain PENDING, never PASS.', 'Absent MCA chunk remains error/UNKNOWN, never guessed air.'] };
  fs.writeFileSync(path.join(runDir, 'result.json'), json(result, 2) + '\n', { flag: 'wx' }); console.log(json(result, 2));
  if (result.unmetCriteria.length) process.exitCode = 1;
}
main().catch(async error => {
  console.error(error.stack || error); process.exitCode = 1;
  if (!created) return;
  clearInterval(polling); void runtimeTicks?.stop();
  record('harness_failure', { message: error.message, code: error.code || null, stack: error.stack, fatalError, task: taskEvidence(task) });
  if (agent) {
    try { const current = agent.__testGetReconnectTask(); if (current && ['running', 'planning'].includes(current.status)) await deadline(agent.handleMessage({ type: 'mc_command_pause' }), 5000, 'Failure pause timeout'); }
    catch (cleanupError) { record('cleanup_error', { step: 'pause', message: cleanupError.message }); }
    for (const [step, cleanup] of [['detach', () => agent.detachBot('manual_disconnect')], ['dispose', () => agent.dispose()]]) {
      try { cleanup(); } catch (cleanupError) { record('cleanup_error', { step, message: cleanupError.message }); }
    }
    agent = null;
  }
  await runtimeTicks?.stop();
  try { bot?.quit('Natural harness failure'); } catch { /* Continue owned server cleanup after a closed client. */ }
  try { await stopServer(); } catch (cleanupError) { record('server_stop_error', { message: cleanupError.message }); }
  const failure = { schema: 1, observerRevision: 5, siteObserverRevision:1, runnerRevision:13,seedPolicyRevision:1,runtimeTickLoopRevision:1,parentRunnerSha256:'26af281a7052b873098795d721769755f1311f5075fa2543f87e3b5e5f4fda91', mode, profile, runName, verificationStages:stages, harnessFailure: { message: error.message, code: error.code || null, fatalError }, task: frozenTask || taskEvidence(task), stopped,
    publicBuildingAcceptancePassed: false, sourceHashes: { started: sourceBefore, ended: hashes() } };
  if (!fs.existsSync(path.join(runDir, 'result.json'))) fs.writeFileSync(path.join(runDir, 'result.json'), json(failure, 2) + '\n', { flag: 'wx' });
}).finally(() => { void runtimeTicks?.stop(); releaseDynamicObservers(); releaseChunkObservers(); for (const waiter of waiters) clearTimeout(waiter.timer); clearInterval(polling);
  for (const [signal, handler] of Object.entries(signalHandlers)) process.removeListener(signal, handler);
  for (const [event, handler] of Object.entries(fatalHandlers)) process.removeListener(event, handler); });
