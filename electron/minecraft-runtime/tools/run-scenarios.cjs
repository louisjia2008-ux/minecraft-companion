#!/usr/bin/env node
/* global require, process, console, __dirname, setTimeout */
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
const { acknowledgePlayerLoaded } = require('../runtime');
const { withMinecraftProtocolCompatibility } = require('../protocolCompatibility');
const { ownedItems, countInventory } = require('../core/perception');
const { scenarioResult, scenarioExitCode } = require('./scenario-result.cjs');
const { runSetup } = require('./scenario-setup.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};

function usage(message) {
  if (message) console.error(message);
  console.error(`Usage: node tools/run-scenarios.cjs --accept-eula [--scenario NAME[,NAME]] [--runs N]
  [--start-run N] [--bot-lifecycle reuse|fresh] [--inventory-trace]
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

async function connectBot({ port, username, version }) {
  const bot = mineflayer.createBot(withMinecraftProtocolCompatibility({
    host: '127.0.0.1', port, username, auth: 'offline', version, hideErrors: false,
  }));
  const timeout = new AbortController();
  try {
    await Promise.race([once(bot, 'spawn'), delay(60000, null, { signal: timeout.signal })
      .then(() => { throw new Error('spawn timeout'); })]);
  } catch (error) {
    bot.quit();
    throw error;
  } finally { timeout.abort(); }
  await acknowledgePlayerLoaded(bot);
  await bot.waitForChunksToLoad();
  // A respawn needs the same acknowledgement, as the desktop runtime does on
  // every spawn; until then the server ignores the player's digging.
  bot.on('spawn', () => { acknowledgePlayerLoaded(bot).catch(() => {}); });
  return bot;
}

function inventorySnapshot(bot) {
  const item = (i) => i && { name: i.name, count: i.count, slot: i.slot };
  return { inventory: countInventory(bot.inventory.items()), owned: countInventory(ownedItems(bot)),
    slots: bot.inventory.slots.map(item), cursor: item(bot.inventory.selectedItem),
    window: bot.currentWindow && { id: bot.currentWindow.id, type: bot.currentWindow.type,
      slots: bot.currentWindow.slots.map(item), cursor: item(bot.currentWindow.selectedItem) } };
}

async function runOnce({ scenario, server, bot, username, run, seed, difficulty, runDir, lifecycle, traceInventory,
  companionFactory = createCompanion, settleMs = 2000, hookIntervalMs = 2000 }) {
  const rng = mulberry32(seed + run * 7919);
  const eventsFile = fs.createWriteStream(path.join(runDir, `run-${String(run + 1).padStart(2, '0')}.jsonl`));
  const write = (type, data = {}) => eventsFile.write(JSON.stringify({ type, t: Date.now(), ...data }) + '\n');
  const cleanup = [];
  const harnessFailures = [];
  const goalEvents = [];
  let result = null;
  let deaths = 0;
  let outcome = null;
  let startedAt = null;
  let timedOut = false;
  try {
  const setup = scenario.setup({ username, run, rng, difficulty });
  write('setup', { seed, run, difficulty, details: setup.details, botLifecycle: lifecycle });
  const trace = (stage) => write('inventory_state', { stage, ...inventorySnapshot(bot) });
  ['set_slot', 'set_player_inventory', 'window_items'].map((name) => {
    const listener = (packet) => write('inventory_packet', { name, windowId: packet.windowId,
      slot: packet.slot ?? packet.slotId, stateId: packet.stateId, ...inventorySnapshot(bot) });
    if (traceInventory) bot._client.on(name, listener);
    cleanup.push(() => bot._client.removeListener(name, listener));
    return [name, listener];
  });
  let readback = Promise.resolve();
  cleanup.push(() => readback);
  let readbackAt = 0;
  await runSetup({ server, setup, properties: scenario.serverProperties, write });
  await sleep(settleMs);
  // A teleport into ungenerated terrain can take longer than Mineflayer's
  // fixed 10 s, especially with two servers generating at once.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await bot.waitForChunksToLoad();
      break;
    } catch (error) {
      if (attempt >= 6) throw error;
    }
  }
  if (traceInventory) trace('after_setup');

  const onDeath = () => { deaths += 1; write('death', { position: bot.entity?.position }); };
  bot.on('death', onDeath);
  cleanup.push(() => bot.removeListener('death', onDeath));
  let captureOutcome = true;
  const runState = {};
  cleanup.push(() => scenario.dispose?.({ server, bot, username, state: runState, write }));
  await scenario.initialize?.({ server, bot, username, state: runState, write });
  let resolveOutcome;
  const finished = new Promise((resolve) => { resolveOutcome = resolve; });
  const companion = companionFactory({
    bot,
    onEvent(event) {
      write('brain', event);
      if (traceInventory && (event.type === 'plan_step' || event.type === 'behavior_finished')) trace(event.type);
      if (traceInventory && event.reason === 'missing_ingredients' && Date.now() - readbackAt > 60000) {
        readbackAt = Date.now();
        readback = server.query(`data get entity ${username} Inventory`, /has the following entity data: .*/)
          .then((match) => write('server_inventory', { data: match[0] }))
          .catch((error) => write('server_inventory_error', { reason: error.message }));
      }
      if (captureOutcome && ['goal_set', 'goal_done', 'goal_failed', 'stopped'].includes(event.type)) {
        goalEvents.push(event);
        outcome = event.type === 'goal_set' ? null : event;
      }
      // Death interrupts actions; only genuine terminal goal events end a single-goal run.
      // An autonomous scenario outlives its goals: only finishWhen or the timeout end it.
      if (!scenario.autonomous && ((event.type === 'goal_done' && scenario.finishOnGoalDone !== false) || event.type === 'goal_failed' || event.type === 'stopped')) {
        resolveOutcome();
      }
    },
  });
  let disposed = false;
  cleanup.push(async () => { if (!disposed) await companion.dispose(); });
  startedAt = Date.now();
  const goal = await scenario.start(companion, runState, bot);
  // A heartbeat every minute so long runs can be followed live.
  const heartbeat = setInterval(() => {
    const inv = {};
    for (const item of bot.inventory.items()) inv[item.name] = (inv[item.name] || 0) + item.count;
    const status = companion.status();
    const line = { minute: Math.round((Date.now() - startedAt) / 60000), running: status.running,
      steps: status.goal?.progress, health: bot.health, food: bot.food, deaths,
      position: bot.entity?.position?.floored?.(), dimension: bot.game?.dimension, inventory: inv };
    write('heartbeat', line);
    line.autonomy = status.autonomy?.current || null;
    console.log(`    [${line.minute}m] ${line.running || 'idle'}${line.autonomy ? ` (auto:${line.autonomy})` : ''} steps=${line.steps ?? '-'} hp=${Math.round(bot.health)}`
      + ` food=${bot.food} deaths=${deaths} ${line.dimension} ${Object.entries(inv).map(([k, n]) => `${k}:${n}`).join(' ')}`);
  }, 60000);
  cleanup.push(() => clearInterval(heartbeat));
  // Scenarios may also act on the world while the goal runs (e.g. skip a night
  // once the goal is ready for it), every two seconds.
  // One call at a time, and the last one is awaited before verify() so their
  // server queries never overlap.
  let duringCall = Promise.resolve();
  const during = scenario.during ? setInterval(() => {
    duringCall = duringCall.then(() => scenario.during({ server, bot, goal, state: runState, username, write }))
      .catch((error) => { harnessFailures.push(String(error)); write('during_failed', { error: String(error) }); });
  }, 2000) : null;
  cleanup.push(async () => { if (during) clearInterval(during); await duringCall; });
  // Scenarios may also end on a world condition (e.g. the next morning).
  const deadline = new AbortController();
  cleanup.push(() => deadline.abort());
  const hookContext = () => ({ server, bot, username, companion, goal, state: runState, write, deaths,
    elapsedMs: Date.now() - startedAt, signal: deadline.signal });
  const condition = scenario.finishWhen || scenario.onTick ? (async () => {
    for (;;) {
      await delay(hookIntervalMs, null, { signal: deadline.signal });
      if (scenario.onTick) {
        try { await scenario.onTick(hookContext()); } catch (error) { harnessFailures.push(error.message); write('hook_error', { reason: error.message }); }
      }
      if (deadline.signal.aborted) return false;
      if (await scenario.finishWhen?.(hookContext())) return false;
    }
  })().catch((error) => { if (error.name !== 'AbortError') throw error; return false; }) : new Promise(() => {});
  cleanup.push(async () => { deadline.abort(); if (scenario.finishWhen || scenario.onTick) await condition; });
  timedOut = await Promise.race([finished.then(() => false), condition,
    delay(scenario.timeoutMs, null, { signal: deadline.signal }).then(() => true)]);
  deadline.abort();
  clearInterval(heartbeat);
  if (during) clearInterval(during);
  await duringCall;
  if (scenario.finishWhen || scenario.onTick) await condition;
  captureOutcome = false;
  await companion.dispose();
  disposed = true;
  bot.removeListener('death', onDeath);
  const durationMs = Date.now() - startedAt;
  await sleep(500);
  const verdict = await scenario.verify({ server, username, bot, goal, deaths, companion, state: runState });
  result = scenarioResult({ run: run + 1, verdict, timedOut, outcome, durationMs, deaths, harnessFailures, goalEvents });
  await readback;
  } catch (error) {
    harnessFailures.push(error.message);
    write('harness_error', { reason: error.message });
    result = scenarioResult({ run: run + 1, verdict: { pass: false }, timedOut, outcome,
      durationMs: startedAt === null ? 0 : Date.now() - startedAt, deaths, harnessFailures, goalEvents });
  } finally {
    for (const release of cleanup.reverse()) {
      try { await release(); } catch (error) {
        harnessFailures.push(`cleanup:${error.message}`);
        write('cleanup_error', { reason: error.message });
        if (result) { result.pass = false; result.reason = `harness_error:cleanup:${error.message}`; }
      }
    }
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

async function main() {
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
  const seed = Number(option('--seed', Date.now() % 1_000_000));
  const difficultyOption = option('--difficulty', null);
  const names = option('--scenario', 'collect-logs-flat').split(',');
  if (!fs.existsSync(jar)) usage(`Server jar not found: ${jar}`);
  if (!Number.isSafeInteger(runs) || runs < 1) usage('--runs must be a positive integer');
  if (!Number.isSafeInteger(startRun) || startRun < 1) usage('--start-run must be a positive integer');
  if (!['reuse', 'fresh'].includes(lifecycle)) usage('--bot-lifecycle must be reuse or fresh');
  if (difficultyOption && !['peaceful', 'easy', 'normal', 'hard'].includes(difficultyOption)) usage('Unknown --difficulty');
  for (const name of names) if (!SCENARIOS[name]) usage(`Unknown scenario: ${name}`);

  const batch = option('--batch', new Date().toISOString().replace(/[:.]/g, '-'));
  if (!/^[\w.-]+$/.test(batch)) usage('--batch may only contain letters, digits, ".", "_" and "-"');
  const summaries = [];
  for (const name of names) {
    const scenario = SCENARIOS[name];
    const difficulty = difficultyOption || scenario.defaultDifficulty || 'peaceful';
    const batchDir = path.join(installation, 'scenario-runs', batch, name);
    if (fs.existsSync(batchDir) && (fs.existsSync(path.join(batchDir, 'server/world'))
      || fs.existsSync(path.join(batchDir, 'summary.json'))
      || fs.readdirSync(batchDir).some((file) => /^run-\d+\.jsonl$/.test(file)))) {
      throw new Error(`batch_exists: choose a fresh --batch; refusing to overwrite ${batchDir}`);
    }
    fs.mkdirSync(batchDir, { recursive: true });
    console.log(`\n▶ ${name}: ${scenario.description}\n  runs=${runs} seed=${seed} difficulty=${difficulty}\n  output=${batchDir}`);
    const server = await startVanillaServer({ java, jar, dir: path.join(batchDir, 'server'),
      properties: { ...scenario.serverProperties, difficulty }, dataPacks: scenario.serverDataPacks });
    const username = 'DeskPetCore';
    let bot = null;
    const results = [];
    try {
      for (let run = startRun - 1; run < startRun - 1 + runs; run += 1) {
        let result;
        try {
          if (!bot) {
            bot = await connectBot({ port: server.port, username, version });
            bot.on('error', (error) => console.error('bot error:', error.message));
          }
          result = await runOnce({ scenario, server, bot, username, run, seed, difficulty, runDir: batchDir,
            lifecycle, traceInventory });
        } catch (error) {
          result = { run: run + 1, pass: false, reason: `harness_error:${error.message}`, durationMs: 0, deaths: 0 };
        }
        results.push(result);
        if (lifecycle === 'fresh' && bot) {
          const ended = once(bot, 'end');
          bot.quit();
          await ended;
          bot = null;
        }
        console.log(`  run ${String(run + 1).padStart(2)}: ${result.pass ? 'PASS' : 'FAIL'}`
          + ` ${Math.round(result.durationMs / 1000)}s${result.reason ? ` (${result.reason})` : ''}`
          + `${result.logsOnServer !== undefined ? ` logs=${result.logsOnServer}` : ''}`
          + `${result.quartzOnServer !== undefined ? ` quartz=${result.quartzOnServer} dimension=${result.dimension}` : ''}`
          + `${result.placed !== undefined ? ` house=${result.placed}/${result.total} furniture=${JSON.stringify(result.furniture)}`
            + ` gear=${JSON.stringify(result.gear)} chest=${result.chestUsed} bed=${result.bedUsed}` : ''}`);
      }
    } finally {
      bot?.quit();
      await server.stop();
    }
    const summary = summarize(name, results);
    fs.writeFileSync(path.join(batchDir, 'summary.json'), JSON.stringify({ summary, results }, null, 2) + '\n');
    summaries.push(summary);
  }
  console.log('\nSummary');
  for (const s of summaries) {
    console.log(`  ${s.scenario}: ${s.passed}/${s.runs} passed (${Math.round(s.passRate * 100)}%),`
      + ` median ${s.medianSeconds ?? '-'}s, deaths ${s.deaths}`
      + (Object.keys(s.failureReasons).length ? `, failures ${JSON.stringify(s.failureReasons)}` : ''));
  }
  process.exitCode = scenarioExitCode(summaries);
}

module.exports = { runOnce, summarize, main, mulberry32 };
if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
