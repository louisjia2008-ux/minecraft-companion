#!/usr/bin/env node
/* global require, process, console, __dirname */
'use strict';
// Repeated scenario runs against a real vanilla server, reporting a pass rate.
//
//   node tools/run-scenarios.cjs --accept-eula --scenario collect-logs-flat --runs 20
//
// Java and the server jar default to the project-local installation created by
// `npm run setup:minecraft:local` (in electron/). Each batch gets a fresh world
// directory; results land in <installation>/scenario-runs/<batch>/.

const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const mineflayer = require('mineflayer');
const { startVanillaServer } = require('../scenarios/vanillaServer.cjs');
const { SCENARIOS } = require('../scenarios/index.cjs');
const { createCompanion } = require('../core/companion');
const { haltBody } = require('../core/actions');
const { acknowledgePlayerLoaded } = require('../runtime');
const { withMinecraftProtocolCompatibility } = require('../protocolCompatibility');
const { ownedItems, countInventory } = require('../core/perception');
const { scenarioResult, scenarioExitCode } = require('./scenario-result.cjs');
const { runSetup } = require('./scenario-setup.cjs');


function usage(message) {
  if (message) console.error(message);
  console.error(`Usage: node tools/run-scenarios.cjs --accept-eula [--scenario NAME[,NAME]] [--runs N]
  [--start-run N] [--bot-lifecycle reuse|fresh] [--inventory-trace] [--trace-movement]
  [--difficulty peaceful|easy|normal] [--seed N] [--batch NAME] [--installation DIR] [--java PATH]
  [--server-jar PATH] [--version V]
Scenarios: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(2);
}

// Small deterministic PRNG so a failing run can be replayed from its seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function connectBot({ port, username, version, signal }) {
  if (signal?.aborted) throw interruptionError(signal);
  const bot = mineflayer.createBot(withMinecraftProtocolCompatibility({
    host: '127.0.0.1', port, username, auth: 'offline', version, hideErrors: false,
  }));
  const timeout = new AbortController();
  const onAbort = () => bot.quit();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([once(bot, 'spawn', { signal }), delay(60000, null, { signal: timeout.signal })
      .then(() => { throw new Error('spawn timeout'); })]);
    await acknowledgePlayerLoaded(bot, () => !signal?.aborted);
    if (signal?.aborted) throw interruptionError(signal);
    await bot.waitForChunksToLoad();
    if (signal?.aborted) throw interruptionError(signal);
    bot.on('spawn', () => { acknowledgePlayerLoaded(bot).catch(() => {}); });
  } catch (error) {
    bot.quit();
    throw error;
  } finally { timeout.abort(); signal?.removeEventListener('abort', onAbort); }
  return bot;
}

function inventorySnapshot(bot) {
  const item = (i) => i && { name: i.name, count: i.count, slot: i.slot };
  return { inventory: countInventory(bot.inventory.items()), owned: countInventory(ownedItems(bot)),
    slots: bot.inventory.slots.map(item), cursor: item(bot.inventory.selectedItem),
    window: bot.currentWindow && { id: bot.currentWindow.id, type: bot.currentWindow.type,
      slots: bot.currentWindow.slots.map(item), cursor: item(bot.currentWindow.selectedItem) } };
}

// What the body is doing right now: tells a bot stuck in a loop (jumping,
// digging, swimming) apart from one standing still.
function bodyState(bot) {
  const e = bot.entity;
  if (!e) return null;
  const controls = Object.entries(bot.controlState || {}).filter(([, on]) => on).map(([name]) => name);
  return { onGround: e.onGround, inLava: e.isInLava || false, inWater: e.isInWater || false, controls,
    pathing: bot.pathfinder?.isMoving?.() || false, mining: bot.pathfinder?.isMining?.() || false,
    digging: bot.targetDigBlock?.name || null, vehicle: bot.vehicle?.name || null, velocity: e.velocity && [e.velocity.x, e.velocity.y, e.velocity.z].map((v) => Math.round(v * 100) / 100) };
}

function interruptionError(signal) {
  return Object.assign(new Error(String(signal?.reason || 'external_abort')), { code: 'interrupted' });
}

function interruptedResult(result, signal) {
  return { ...result, pass: false, reason: `interrupted:${String(signal.reason || 'external_abort')}`,
    interrupted: true, interruption: String(signal.reason || 'external_abort') };
}

async function runOnce({ scenario, server, bot, username, run, seed, difficulty, runDir, lifecycle, traceInventory, traceMovement,
  companionFactory = createCompanion, settleMs = 2000, hookIntervalMs = 2000, signal }) {
  const rng = mulberry32(seed + run * 7919);
  const eventsFile = fs.createWriteStream(path.join(runDir, `run-${String(run + 1).padStart(2, '0')}.jsonl`));
  const write = (type, data = {}) => eventsFile.write(JSON.stringify({ type, t: Date.now(), ...data }) + '\n');
  const cleanup = [];
  const harnessFailures = [];
  const goalEvents = [];
  const readbacks = new Set();
  const operations = new Set();
  const deadline = new AbortController();
  let resolveInterrupted;
  const interrupted = new Promise((resolve) => { resolveInterrupted = resolve; });
  let companion = null;
  let captureOutcome = true;
  let quiesced = false;
  let quiescing = Promise.resolve();
  let requestQuiesce = null;
  const onAbort = () => { captureOutcome = false; deadline.abort(signal.reason); requestQuiesce?.('scenario_interrupted'); resolveInterrupted(false); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const check = () => { if (signal?.aborted) throw interruptionError(signal); };
  // After interruption, finish commands already sent, but start no new world
  // operations. This also bounds a large setup to its current console query.
  const scopedServer = Object.create(server);
  for (const name of ['command', 'query', 'execute', 'waitFor']) if (typeof server[name] === 'function') {
    scopedServer[name] = (...args) => {
      check();
      const value = server[name](...args);
      if (!value || typeof value.then !== 'function') return value;
      operations.add(value);
      value.then(() => operations.delete(value), () => operations.delete(value));
      return value;
    };
  }
  let result = null;
  let verdict = { pass: false };
  let deaths = 0;
  let outcome = null;
  let startedAt = null;
  let timedOut = false;
  let disposed = false;
  let heartbeat = null;
  let during = null;
  let duringCall = Promise.resolve();
  let condition = null;
  const stopScheduling = () => {
    captureOutcome = false; deadline.abort(); clearInterval(heartbeat); clearInterval(during); requestQuiesce?.('scenario_finished');
  };
  const cleanupError = (error) => {
    harnessFailures.push(`cleanup:${error.message}`);
    write('cleanup_error', { reason: error.message });
  };
  requestQuiesce = (reason) => {
    if (!companion || quiesced) return;
    quiesced = true;
    const jobs = [];
    // Disable the director and synchronously mark the brain disposed before
    // draining hooks. stop() alone leaves permanent survival ticks enabled.
    for (const stop of [() => companion.director?.disable(reason), () => companion.brain?.dispose()]) {
      try { jobs.push(Promise.resolve(stop()).catch(cleanupError)); } catch (error) { cleanupError(error); }
    }
    quiescing = Promise.all(jobs);
  };
  const join = async () => {
    const joined = await Promise.allSettled([duringCall, condition, quiescing]);
    // A failed finishWhen must not short-circuit outstanding console reads.
    while (operations.size || readbacks.size) await Promise.allSettled([...operations, ...readbacks]);
    const failed = joined.find((entry) => entry.status === 'rejected');
    if (failed) throw failed.reason;
  };
  const dispose = async () => {
    if (!companion || disposed) return;
    disposed = true;
    try { await companion.dispose(); } catch (error) { cleanupError(error); }
  };
  try {
    check();
    // Setup may ask the server first (e.g. where a structure is), so it can be async.
    const setup = await scenario.setup({ username, run, rng, difficulty, server: scopedServer });
    write('setup', { seed, run, difficulty, details: setup.details, botLifecycle: lifecycle });
    const trace = (stage) => write('inventory_state', { stage, ...inventorySnapshot(bot) });
    for (const name of ['set_slot', 'set_player_inventory', 'window_items']) {
      const listener = (packet) => write('inventory_packet', { name, windowId: packet.windowId,
        slot: packet.slot ?? packet.slotId, stateId: packet.stateId, ...inventorySnapshot(bot) });
      if (traceInventory) bot._client.on(name, listener);
      cleanup.push(() => bot._client.removeListener(name, listener));
    }
    let readbackAt = 0;
    await runSetup({ server: scopedServer, setup, properties: scenario.serverProperties, write });
    check();
    await delay(settleMs, null, { signal: deadline.signal });
    for (let attempt = 1; ; attempt += 1) {
      check();
      try { await bot.waitForChunksToLoad(); check(); break; }
      catch (error) { check(); if (attempt >= 6) throw error; }
    }
    if (traceInventory) trace('after_setup');
    const onDeath = () => { deaths += 1; write('death', { position: bot.entity?.position }); };
    bot.on('death', onDeath);
    cleanup.push(() => bot.removeListener('death', onDeath));
    // A reused bot must not carry the last run's movement into this one.
    haltBody(bot);
    const runState = {};
    cleanup.push(() => scenario.dispose?.({ server: scopedServer, bot, username, state: runState, write }));
    await scenario.initialize?.({ server: scopedServer, bot, username, state: runState, write, signal: deadline.signal });
    check();
    let resolveOutcome;
    const finished = new Promise((resolve) => { resolveOutcome = resolve; });
    companion = companionFactory({ bot, onEvent(event) {
      write('brain', event);
      if (traceInventory && (event.type === 'plan_step' || event.type === 'behavior_finished')) trace(event.type);
      if (!signal?.aborted && traceInventory && event.reason === 'missing_ingredients' && Date.now() - readbackAt > 60000) {
        readbackAt = Date.now();
        const readback = scopedServer.query(`data get entity ${username} Inventory`, /has the following entity data: .*/)
          .then((match) => write('server_inventory', { data: match[0] }))
          .catch((error) => write('server_inventory_error', { reason: error.message }));
        readbacks.add(readback);
        readback.then(() => readbacks.delete(readback));
      }
      if (captureOutcome && ['goal_set', 'goal_done', 'goal_failed', 'stopped'].includes(event.type)) {
        goalEvents.push(event);
        outcome = event.type === 'goal_set' ? null : event;
      }
      if (!scenario.autonomous && ((event.type === 'goal_done' && scenario.finishOnGoalDone !== false) || event.type === 'goal_failed' || event.type === 'stopped')) resolveOutcome();
    } });
    if (signal?.aborted) requestQuiesce('scenario_interrupted');
    startedAt = Date.now();
    check();
    const goal = await scenario.start(companion, runState, bot);
    check();
    // --trace-movement: who last set a path goal or pressed forward, in each heartbeat.
    const moves = {};
    if (traceMovement && bot.pathfinder && !bot.companionMoveTrace) {
      const where = () => new Error().stack.split('\n').slice(3, 7).map((l) => l.trim().replace(/^at /, '').replace(/\(.*minecraft-runtime\//, '(')).join(' < ');
      const setGoal = bot.pathfinder.setGoal.bind(bot.pathfinder);
      const setControlState = bot.setControlState.bind(bot);
      bot.pathfinder.setGoal = (goal, dynamic) => {
        if (goal) moves.goal = { at: Date.now(), goal: goal.constructor?.name, x: goal.x, z: goal.z, by: where() };
        return setGoal(goal, dynamic);
      };
      bot.setControlState = (control, on) => {
        if (on && control === 'forward') moves.forward = { at: Date.now(), by: where() };
        return setControlState(control, on);
      };
      bot.companionMoveTrace = moves;
    }
    heartbeat = setInterval(() => {
      const inv = {};
      for (const item of bot.inventory.items()) inv[item.name] = (inv[item.name] || 0) + item.count;
      const status = companion.status();
      const line = { minute: Math.round((Date.now() - startedAt) / 60000), running: status.running,
        steps: status.goal?.progress, health: bot.health, food: bot.food, deaths,
        position: bot.entity?.position?.floored?.(), dimension: bot.game?.dimension, inventory: inv, body: bodyState(bot),
        ...(bot.companionMoveTrace ? { moves: { ...bot.companionMoveTrace } } : {}) };
      write('heartbeat', line);
      line.autonomy = status.autonomy?.current || null;
      console.log(`    [${line.minute}m] ${line.running || 'idle'}${line.autonomy ? ` (auto:${line.autonomy})` : ''} steps=${line.steps ?? '-'} hp=${Math.round(bot.health)}`
        + ` food=${bot.food} deaths=${deaths} ${line.dimension} ${Object.entries(inv).map(([k, n]) => `${k}:${n}`).join(' ')}`);
    }, 60000);
    if (scenario.during) during = setInterval(() => {
      duringCall = duringCall.then(() => deadline.signal.aborted ? undefined
        : scenario.during({ server: scopedServer, bot, goal, state: runState, username, write, signal: deadline.signal }))
        .catch((error) => { if (!signal?.aborted) harnessFailures.push(String(error)); write('during_failed', { error: String(error) }); });
    }, hookIntervalMs);
    const hookContext = () => ({ server: scopedServer, bot, username, companion, goal, state: runState, write, deaths,
      elapsedMs: Date.now() - startedAt, signal: deadline.signal });
    condition = scenario.finishWhen || scenario.onTick ? (async () => {
      for (;;) {
        await delay(hookIntervalMs, null, { signal: deadline.signal });
        if (scenario.onTick) {
          try { await scenario.onTick(hookContext()); }
          catch (error) { if (!signal?.aborted) harnessFailures.push(error.message); write('hook_error', { reason: error.message }); }
        }
        if (deadline.signal.aborted) return false;
        if (await scenario.finishWhen?.(hookContext())) return false;
      }
    })().catch((error) => { if (error.name !== 'AbortError') throw error; return false; }) : null;
    timedOut = await Promise.race([finished.then(() => false), interrupted,
      ...(condition ? [condition] : []), delay(scenario.timeoutMs, null, { signal: deadline.signal }).then(() => true)]);
    stopScheduling();
    await join();
    captureOutcome = false;
    await dispose();
    check();
    const durationMs = Date.now() - startedAt;
    await delay(500, null, { signal: signal });
    check();
    verdict = await scenario.verify({ server: scopedServer, username, bot, goal, deaths, companion, state: runState });
    check();
    result = scenarioResult({ run: run + 1, verdict, timedOut, outcome,
      durationMs, deaths, harnessFailures, goalEvents });
  } catch (error) {
    if (!signal?.aborted) harnessFailures.push(error.message);
    write(signal?.aborted ? 'interrupted' : 'harness_error', { reason: signal?.aborted ? String(signal.reason) : error.message });
    result = scenarioResult({ run: run + 1, verdict, timedOut, outcome,
      durationMs: startedAt === null ? 0 : Date.now() - startedAt, deaths, harnessFailures, goalEvents });
  } finally {
    stopScheduling();
    try { await join(); } catch (error) { if (!harnessFailures.includes(error.message)) cleanupError(error); }
    captureOutcome = false;
    await dispose();
    for (const release of cleanup.reverse()) {
      try { await release(); } catch (error) { cleanupError(error); }
    }
    try { await join(); } catch (error) { if (!harnessFailures.includes(error.message)) cleanupError(error); }
    if (harnessFailures.length && result) { result.pass = false; result.reason = `harness_error:${harnessFailures[0]}`; }
    if (signal?.aborted) result = interruptedResult(result, signal);
    signal?.removeEventListener('abort', onAbort);
    if (result) write('result', result);
    await new Promise((resolve) => eventsFile.end(resolve));
  }
  return result;
}

function summarize(name, results) {
  const passed = results.filter((r) => r.pass).length;
  const durations = results.filter((r) => r.pass).map((r) => r.durationMs).sort((a, b) => a - b);
  const reasons = {};
  for (const r of results) if (!r.pass) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  return {
    scenario: name, runs: results.length, passed, passRate: results.length ? passed / results.length : 0,
    medianSeconds: durations.length ? Math.round(durations[Math.floor(durations.length / 2)] / 1000) : null,
    deaths: results.reduce((sum, r) => sum + r.deaths, 0), failureReasons: reasons,
  };
}

async function disconnectBot(bot, timeoutMs = 5000) {
  if (!bot || bot._client?.ended) return;
  const timeout = new AbortController();
  try {
    const ended = once(bot, 'end');
    bot.quit();
    await Promise.race([ended, delay(timeoutMs, null, { signal: timeout.signal })
      .then(() => { throw new Error('bot_disconnect_timeout'); })]);
  } finally { timeout.abort(); }
}

async function main({ argv = process.argv.slice(2), processTarget = process, signal,
  scenarios = SCENARIOS, startServer = startVanillaServer, connect = connectBot,
  runScenario = runOnce, disconnect = disconnectBot } = {}) {
  const args = argv;
  const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
  if (args.includes('--help')) usage();
  if (!args.includes('--accept-eula')) usage('Pass --accept-eula after accepting https://aka.ms/MinecraftEULA');
  const workspace = path.resolve(__dirname, '../../..');
  const installation = path.resolve(option('--installation', path.join(workspace, '.minecraft-local-test')));
  const installedFile = path.join(installation, 'installation.json');
  const installed = fs.existsSync(installedFile) ? JSON.parse(fs.readFileSync(installedFile, 'utf8')) : {};
  const java = option('--java', installed.java || 'java');
  const jar = option('--server-jar', installed.minecraft?.jar || path.join(installation, 'server.jar'));
  const version = option('--version', installed.minecraft?.version || '1.21.8');
  const runs = Number(option('--runs', 20));
  const startRun = Number(option('--start-run', 1));
  const lifecycle = option('--bot-lifecycle', 'reuse');
  const traceInventory = args.includes('--inventory-trace');
  const traceMovement = args.includes('--trace-movement');
  const seed = Number(option('--seed', Date.now() % 1_000_000));
  const difficultyOption = option('--difficulty', null);
  const names = option('--scenario', 'collect-logs-flat').split(',');
  if (!fs.existsSync(jar)) usage(`Server jar not found: ${jar}`);
  if (!Number.isSafeInteger(runs) || runs < 1) usage('--runs must be a positive integer');
  if (!Number.isSafeInteger(startRun) || startRun < 1) usage('--start-run must be a positive integer');
  if (!['reuse', 'fresh'].includes(lifecycle)) usage('--bot-lifecycle must be reuse or fresh');
  if (difficultyOption && !['peaceful', 'easy', 'normal', 'hard'].includes(difficultyOption)) usage('Unknown --difficulty');
  for (const name of names) if (!scenarios[name]) usage(`Unknown scenario: ${name}`);

  const batch = option('--batch', new Date().toISOString().replace(/[:.]/g, '-'));
  if (!/^[\w.-]+$/.test(batch)) usage('--batch may only contain letters, digits, ".", "_" and "-"');
  const interruption = new AbortController();
  const requestStop = (reason) => {
    if (!interruption.signal.aborted) interruption.abort(reason);
  };
  const onInt = () => requestStop('SIGINT');
  const onTerm = () => requestStop('SIGTERM');
  const onAbort = () => requestStop(signal.reason || 'external_abort');
  processTarget.on('SIGINT', onInt);
  processTarget.on('SIGTERM', onTerm);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const summaries = [];
  const reports = [];
  try {
    for (const name of names) {
      if (interruption.signal.aborted) break;
      const scenario = scenarios[name];
      const difficulty = difficultyOption || scenario.defaultDifficulty || 'peaceful';
      const batchDir = path.join(installation, 'scenario-runs', batch, name);
      if (fs.existsSync(batchDir) && (fs.existsSync(path.join(batchDir, 'server/world'))
        || fs.existsSync(path.join(batchDir, 'summary.json'))
        || fs.readdirSync(batchDir).some((file) => /^run-\d+\.jsonl$/.test(file)))) {
        throw new Error(`batch_exists: choose a fresh --batch; refusing to overwrite ${batchDir}`);
      }
      fs.mkdirSync(batchDir, { recursive: true });
      console.log(`\n▶ ${name}: ${scenario.description}\n  runs=${runs} seed=${seed} difficulty=${difficulty}\n  output=${batchDir}`);
      const username = 'DeskPetCore';
      let server = null;
      let bot = null;
      const results = [];
      const cleanupFailures = [];
      let serverCleanup = null;
      const errorResult = (error, run) => {
        let result = scenarioResult({ run, verdict: { pass: false }, durationMs: 0, deaths: 0,
          harnessFailures: interruption.signal.aborted ? [] : [error.message || String(error)] });
        if (interruption.signal.aborted) result = interruptedResult(result, interruption.signal);
        return result;
      };
      try {
        server = await startServer({ java, jar, dir: path.join(batchDir, 'server'),
          properties: { ...scenario.serverProperties, difficulty }, dataPacks: scenario.serverDataPacks,
          signal: interruption.signal });
        for (let run = startRun - 1; run < startRun - 1 + runs && !interruption.signal.aborted; run += 1) {
          let result;
          try {
            if (!bot) {
              bot = await connect({ port: server.port, username, version, signal: interruption.signal });
              bot.on('error', (error) => console.error('bot error:', error.message));
            }
            if (interruption.signal.aborted) throw interruptionError(interruption.signal);
            result = await runScenario({ scenario, server, bot, username, run, seed, difficulty, runDir: batchDir,
              lifecycle, traceInventory, traceMovement, signal: interruption.signal });
          } catch (error) { result = errorResult(error, run + 1); }
          results.push(result);
          if (lifecycle === 'fresh' && bot) { await disconnect(bot); bot = null; }
          console.log(`  run ${String(run + 1).padStart(2)}: ${result.pass ? 'PASS' : 'FAIL'}`
            + ` ${Math.round(result.durationMs / 1000)}s${result.reason ? ` (${result.reason})` : ''}`
            + `${result.logsOnServer !== undefined ? ` logs=${result.logsOnServer}` : ''}`
            + `${result.quartzOnServer !== undefined ? ` quartz=${result.quartzOnServer} dimension=${result.dimension}` : ''}`
            + `${result.placed !== undefined ? ` house=${result.placed}/${result.total} furniture=${JSON.stringify(result.furniture)}`
              + ` gear=${JSON.stringify(result.gear)} chest=${result.chestUsed} bed=${result.bedUsed}` : ''}`);
        }
        if (!results.length && interruption.signal.aborted) results.push(errorResult(interruptionError(interruption.signal), startRun));
      } catch (error) {
        if (error.cleanup) { serverCleanup = error.cleanup; cleanupFailures.push(...error.cleanup.failures); }
        if (!results.length) results.push(errorResult(error, startRun));
        else cleanupFailures.push(error.message || String(error));
      } finally {
        try { await disconnect(bot); } catch (error) { cleanupFailures.push(`bot:${error.message}`); }
        if (server) {
          try { serverCleanup = await server.stop(); }
          catch (error) { serverCleanup = error.cleanup; cleanupFailures.push(error.message || String(error)); }
        }
        // A stop failure belongs to the batch, after each reuse round has
        // already closed its terminal JSONL. Never rewrite those observations.
        for (const result of results) {
          const file = path.join(batchDir, `run-${String(result.run).padStart(2, '0')}.jsonl`);
          if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ type: 'result', t: Date.now(), ...result }) + '\n');
        }
        const summary = summarize(name, results);
        const report = { summary, results, batchFailures: cleanupFailures, interrupted: interruption.signal.aborted,
          interruption: interruption.signal.reason, cleanup: { pass: cleanupFailures.length === 0, failures: cleanupFailures, server: serverCleanup } };
        fs.writeFileSync(path.join(batchDir, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
        summaries.push(summary); reports.push(report);
      }
      if (interruption.signal.aborted || cleanupFailures.length) break;
    }
    console.log('\nSummary');
    for (const s of summaries) console.log(`  ${s.scenario}: ${s.passed}/${s.runs} passed (${Math.round(s.passRate * 100)}%),`
      + ` median ${s.medianSeconds ?? '-'}s, deaths ${s.deaths}`
      + (Object.keys(s.failureReasons).length ? `, failures ${JSON.stringify(s.failureReasons)}` : ''));
    const exitCode = interruption.signal.aborted
      ? ({ SIGINT: 130, SIGTERM: 143 }[interruption.signal.reason] || 1) : reports.some((report) => report.batchFailures.length) ? 1 : scenarioExitCode(summaries);
    processTarget.exitCode = exitCode;
    return { summaries, reports, interrupted: interruption.signal.aborted, interruption: interruption.signal.reason, exitCode };
  } finally {
    processTarget.removeListener('SIGINT', onInt);
    processTarget.removeListener('SIGTERM', onTerm);
    signal?.removeEventListener('abort', onAbort);
  }
}

module.exports = { runOnce, summarize, main, mulberry32 };
if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
