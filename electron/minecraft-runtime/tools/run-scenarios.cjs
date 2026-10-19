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
const mineflayer = require('mineflayer');
const { startVanillaServer } = require('../scenarios/vanillaServer.cjs');
const { SCENARIOS } = require('../scenarios/index.cjs');
const { createCompanion } = require('../core/companion');
const { acknowledgePlayerLoaded } = require('../runtime');
const { withMinecraftProtocolCompatibility } = require('../protocolCompatibility');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};

function usage(message) {
  if (message) console.error(message);
  console.error(`Usage: node tools/run-scenarios.cjs --accept-eula [--scenario NAME[,NAME]] [--runs N]
  [--difficulty peaceful|easy|normal] [--seed N] [--installation DIR] [--java PATH] [--server-jar PATH] [--version V]
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
  await Promise.race([once(bot, 'spawn'), sleep(60000).then(() => { throw new Error('spawn timeout'); })]);
  await acknowledgePlayerLoaded(bot);
  await bot.waitForChunksToLoad();
  return bot;
}

async function runOnce({ scenario, server, bot, username, run, seed, difficulty, runDir }) {
  const rng = mulberry32(seed + run * 7919);
  const eventsFile = fs.createWriteStream(path.join(runDir, `run-${String(run + 1).padStart(2, '0')}.jsonl`));
  const write = (type, data = {}) => eventsFile.write(JSON.stringify({ type, t: Date.now(), ...data }) + '\n');
  const setup = scenario.setup({ username, run, rng, difficulty });
  write('setup', { seed, run, difficulty, details: setup.details });
  for (const command of setup.commands) server.command(command);
  // `list` is processed after every queued command, so its reply is a barrier.
  await server.query('list', /players online/, 15000);
  await sleep(2000);
  await bot.waitForChunksToLoad();

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
      // `stopped` covers death: the brain drops its goal when the bot dies.
      if (event.type === 'goal_done' || event.type === 'goal_failed' || event.type === 'stopped') {
        outcome = outcome || event;
        resolveOutcome();
      }
    },
  });
  const startedAt = Date.now();
  await scenario.start(companion);
  const timedOut = await Promise.race([finished.then(() => false), sleep(scenario.timeoutMs).then(() => true)]);
  await companion.dispose();
  bot.removeListener('death', onDeath);
  const durationMs = Date.now() - startedAt;
  await sleep(500);
  const verdict = await scenario.verify({ server, username, bot });
  const reason = verdict.pass ? null
    : timedOut ? 'timeout'
      : outcome?.type === 'goal_failed' ? `goal_failed:${(outcome.reasons || []).at(-1) || 'unknown'}`
        : outcome?.type === 'stopped' ? `stopped:${outcome.reason}`
          : 'verify_failed';
  const result = { run: run + 1, pass: verdict.pass, reason, durationMs, deaths,
    brainOutcome: outcome?.type || null, failureReasons: outcome?.reasons || [], ...verdict.details };
  write('result', result);
  eventsFile.end();
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
  const seed = Number(option('--seed', Date.now() % 1_000_000));
  const difficulty = option('--difficulty', 'peaceful');
  const names = option('--scenario', 'collect-logs-flat').split(',');
  if (!fs.existsSync(jar)) usage(`Server jar not found: ${jar}`);
  if (!Number.isSafeInteger(runs) || runs < 1) usage('--runs must be a positive integer');
  if (!['peaceful', 'easy', 'normal', 'hard'].includes(difficulty)) usage('Unknown --difficulty');
  for (const name of names) if (!SCENARIOS[name]) usage(`Unknown scenario: ${name}`);

  const batch = new Date().toISOString().replace(/[:.]/g, '-');
  const summaries = [];
  for (const name of names) {
    const scenario = SCENARIOS[name];
    const batchDir = path.join(installation, 'scenario-runs', batch, name);
    fs.mkdirSync(batchDir, { recursive: true });
    console.log(`\n▶ ${name}: ${scenario.description}\n  runs=${runs} seed=${seed} difficulty=${difficulty}\n  output=${batchDir}`);
    const server = await startVanillaServer({ java, jar, dir: path.join(batchDir, 'server'),
      properties: { ...scenario.serverProperties, difficulty } });
    const username = 'DeskPetCore';
    const bot = await connectBot({ port: server.port, username, version });
    bot.on('error', (error) => console.error('bot error:', error.message));
    const results = [];
    try {
      for (let run = 0; run < runs; run += 1) {
        let result;
        try {
          result = await runOnce({ scenario, server, bot, username, run, seed, difficulty, runDir: batchDir });
        } catch (error) {
          result = { run: run + 1, pass: false, reason: `harness_error:${error.message}`, durationMs: 0, deaths: 0 };
        }
        results.push(result);
        console.log(`  run ${String(run + 1).padStart(2)}: ${result.pass ? 'PASS' : 'FAIL'}`
          + ` ${Math.round(result.durationMs / 1000)}s${result.reason ? ` (${result.reason})` : ''}`
          + `${result.logsOnServer !== undefined ? ` logs=${result.logsOnServer}` : ''}`);
      }
    } finally {
      bot.quit();
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
