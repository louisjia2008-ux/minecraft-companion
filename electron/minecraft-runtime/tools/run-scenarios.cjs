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

async function runOnce({ scenario, server, bot, username, run, seed, difficulty, runDir, lifecycle, traceInventory }) {
  const rng = mulberry32(seed + run * 7919);
  const eventsFile = fs.createWriteStream(path.join(runDir, `run-${String(run + 1).padStart(2, '0')}.jsonl`));
  const write = (type, data = {}) => eventsFile.write(JSON.stringify({ type, t: Date.now(), ...data }) + '\n');
  const setup = scenario.setup({ username, run, rng, difficulty });
  write('setup', { seed, run, difficulty, details: setup.details, botLifecycle: lifecycle });
  const trace = (stage) => write('inventory_state', { stage, ...inventorySnapshot(bot) });
  const packetListeners = ['set_slot', 'set_player_inventory', 'window_items'].map((name) => {
    const listener = (packet) => write('inventory_packet', { name, windowId: packet.windowId,
      slot: packet.slot ?? packet.slotId, stateId: packet.stateId, ...inventorySnapshot(bot) });
    if (traceInventory) bot._client.on(name, listener);
    return [name, listener];
  });
  let readback = Promise.resolve();
  let readbackAt = 0;
  for (const command of setup.commands) server.command(command);
  // `list` is processed after every queued command, so its reply is a barrier.
  await server.query('list', /players online/, 15000);
  await sleep(2000);
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

  let deaths = 0;
  const onDeath = () => { deaths += 1; write('death', { position: bot.entity?.position }); };
  bot.on('death', onDeath);
  let outcome = null;
  let resolveOutcome;
  const finished = new Promise((resolve) => { resolveOutcome = resolve; });
  const companion = createCompanion({
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
      // `stopped` covers death: the brain drops its goal when the bot dies.
      if (event.type === 'goal_done' || event.type === 'goal_failed' || event.type === 'stopped') {
        outcome = outcome || event;
        resolveOutcome();
      }
    },
  });
  const startedAt = Date.now();
  const goal = await scenario.start(companion);
  // A heartbeat every minute so long runs can be followed live.
  const heartbeat = setInterval(() => {
    const inv = {};
    for (const item of bot.inventory.items()) inv[item.name] = (inv[item.name] || 0) + item.count;
    const status = companion.status();
    const line = { minute: Math.round((Date.now() - startedAt) / 60000), running: status.running,
      steps: status.goal?.progress, health: bot.health, food: bot.food, deaths,
      position: bot.entity?.position?.floored?.(), dimension: bot.game?.dimension, inventory: inv };
    write('heartbeat', line);
    console.log(`    [${line.minute}m] ${line.running || 'idle'} steps=${line.steps ?? '-'} hp=${Math.round(bot.health)}`
      + ` food=${bot.food} deaths=${deaths} ${line.dimension} ${Object.entries(inv).map(([k, n]) => `${k}:${n}`).join(' ')}`);
  }, 60000);
  // Scenarios may also act on the world while the goal runs (e.g. skip a night
  // once the goal is ready for it), every two seconds.
  // One call at a time, and the last one is awaited before verify() so their
  // server queries never overlap.
  let duringCall = Promise.resolve();
  const during = scenario.during ? setInterval(() => {
    duringCall = duringCall.then(() => scenario.during({ server, bot, goal, write }))
      .catch((error) => write('during_failed', { error: String(error) }));
  }, 2000) : null;
  // Scenarios may also end on a world condition (e.g. the next morning).
  const deadline = new AbortController();
  const condition = scenario.finishWhen ? (async () => {
    for (;;) { await delay(2000, null, { signal: deadline.signal }); if (scenario.finishWhen({ bot })) return false; }
  })() : new Promise(() => {});
  const timedOut = await Promise.race([finished.then(() => false), condition,
    delay(scenario.timeoutMs, null, { signal: deadline.signal }).then(() => true)]);
  deadline.abort();
  clearInterval(heartbeat);
  if (during) clearInterval(during);
  await duringCall;
  await companion.dispose();
  bot.removeListener('death', onDeath);
  const durationMs = Date.now() - startedAt;
  await sleep(500);
  const verdict = await scenario.verify({ server, username, bot, goal, deaths });
  const reason = verdict.pass ? null
    : timedOut ? 'timeout'
      : outcome?.type === 'goal_failed' ? `goal_failed:${(outcome.reasons || []).at(-1) || 'unknown'}`
        : outcome?.type === 'stopped' ? `stopped:${outcome.reason}`
          : 'verify_failed';
  const result = { run: run + 1, pass: verdict.pass, reason, durationMs, deaths,
    brainOutcome: outcome?.type || null, failureReasons: outcome?.reasons || [], ...verdict.details };
  write('result', result);
  for (const [name, listener] of packetListeners) bot._client.removeListener(name, listener);
  await readback;
  await new Promise((resolve) => eventsFile.end(resolve));
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
    fs.mkdirSync(batchDir, { recursive: true });
    console.log(`\n▶ ${name}: ${scenario.description}\n  runs=${runs} seed=${seed} difficulty=${difficulty}\n  output=${batchDir}`);
    const server = await startVanillaServer({ java, jar, dir: path.join(batchDir, 'server'),
      properties: { ...scenario.serverProperties, difficulty } });
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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
