#!/usr/bin/env node
/* global require, process, console, __dirname */
'use strict';
// One command for the task regression suite: core unit tests, then every
// scenario of the suite against real vanilla servers, judged by pass-rate gates.
//
//   npm run regression -- --accept-eula                 # quick suite
//   npm run regression -- --accept-eula --suite full --parallel 3
//
// Each scenario runs in its own `run-scenarios.cjs` process with its own
// server. Results land in <installation>/scenario-runs/regression-<time>/;
// regression.json there holds the verdict. Exits 1 when any gate fails.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SUITES } = require('../scenarios/regression.cjs');
const { SCENARIOS } = require('../scenarios/index.cjs');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};

function usage(message) {
  if (message) console.error(message);
  console.error(`Usage: node tools/run-regression.cjs --accept-eula [--suite ${Object.keys(SUITES).join('|')}]
  [--only NAME[,NAME]] [--runs N] [--parallel N] [--seed N] [--skip-unit]
  [--installation DIR] [--java PATH] [--server-jar PATH] [--version V]`);
  process.exit(2);
}

function run(command, commandArgs, { prefix, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const relay = (stream, out) => {
      let pending = '';
      stream.on('data', (chunk) => {
        pending += chunk.toString();
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) out.write(`${prefix}${line}\n`);
      });
      stream.on('end', () => { if (pending) out.write(`${prefix}${pending}\n`); });
    };
    relay(child.stdout, process.stdout);
    relay(child.stderr, process.stderr);
    child.on('error', (error) => resolve({ code: null, error }));
    child.on('close', (code) => resolve({ code }));
  });
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

async function main() {
  if (args.includes('--help')) usage();
  if (!args.includes('--accept-eula')) usage('Pass --accept-eula after accepting https://aka.ms/MinecraftEULA');
  const suiteName = option('--suite', 'quick');
  const suite = SUITES[suiteName];
  if (!suite) usage(`Unknown suite: ${suiteName}`);
  const only = option('--only', null)?.split(',');
  for (const name of only || []) if (!SCENARIOS[name]) usage(`Unknown scenario: ${name}`);
  const entries = only ? only.map((name) => suite.find((e) => e.scenario === name)
    || { scenario: name, runs: 1, minPassRate: 1 }) : suite;
  const runsOverride = option('--runs', null);
  if (runsOverride !== null && !(Number.isSafeInteger(Number(runsOverride)) && Number(runsOverride) >= 1)) {
    usage('--runs must be a positive integer');
  }
  const parallel = Number(option('--parallel', 2));
  if (!Number.isSafeInteger(parallel) || parallel < 1) usage('--parallel must be a positive integer');
  const seed = Number(option('--seed', Date.now() % 1_000_000));
  if (!Number.isSafeInteger(seed)) usage('--seed must be an integer');
  const runtime = path.resolve(__dirname, '..');
  const installation = path.resolve(option('--installation', path.join(runtime, '../../.minecraft-local-test')));
  const passthrough = ['--java', '--server-jar', '--version'].flatMap((name) => {
    const value = option(name, null);
    return value === null ? [] : [name, value];
  });

  if (!args.includes('--skip-unit')) {
    console.log('▶ core unit tests');
    const unit = await run(process.execPath, ['--test', ...fs.readdirSync(path.join(runtime, 'test'))
      .filter((f) => /^core-.*\.test\.js$/.test(f)).map((f) => path.join('test', f))],
    { prefix: '  ', cwd: runtime });
    if (unit.code !== 0) {
      console.error('\nCore unit tests failed; scenarios not started.');
      process.exit(1);
    }
  }

  const batch = `regression-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const batchDir = path.join(installation, 'scenario-runs', batch);
  console.log(`\n▶ suite ${suiteName}: ${entries.map((e) => e.scenario).join(', ')}`
    + `\n  seed=${seed} parallel=${parallel}\n  output=${batchDir}`);
  const startedAt = Date.now();
  const verdicts = await pool(entries, parallel, async (entry) => {
    const runs = runsOverride === null ? entry.runs : Number(runsOverride);
    const child = await run(process.execPath, [path.join(runtime, 'tools/run-scenarios.cjs'), '--accept-eula',
      '--scenario', entry.scenario, '--runs', String(runs), '--seed', String(seed), '--batch', batch,
      '--installation', installation, ...passthrough], { prefix: `[${entry.scenario}] `, cwd: runtime });
    const summaryFile = path.join(batchDir, entry.scenario, 'summary.json');
    const summary = fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile, 'utf8')).summary : null;
    const pass = child.code === 0 && summary !== null && summary.runs === runs
      && summary.passRate >= entry.minPassRate;
    return { ...entry, runs, pass, exitCode: child.code, summary };
  });

  const passed = verdicts.every((v) => v.pass);
  fs.mkdirSync(batchDir, { recursive: true });
  fs.writeFileSync(path.join(batchDir, 'regression.json'), JSON.stringify({ suite: suiteName, seed, passed,
    durationSeconds: Math.round((Date.now() - startedAt) / 1000), scenarios: verdicts }, null, 2) + '\n');
  console.log(`\nRegression (${suiteName}, seed ${seed}): ${passed ? 'PASS' : 'FAIL'}`);
  for (const v of verdicts) {
    const s = v.summary;
    console.log(`  ${v.pass ? 'PASS' : 'FAIL'}  ${v.scenario.padEnd(22)}`
      + (s ? `${s.passed}/${s.runs} (gate ${Math.round(v.minPassRate * 100)}%), median ${s.medianSeconds ?? '-'}s,`
        + ` deaths ${s.deaths}${Object.keys(s.failureReasons).length ? `, failures ${JSON.stringify(s.failureReasons)}` : ''}`
        : `no summary (exit ${v.exitCode})`));
  }
  console.log(`  details: ${path.join(batchDir, 'regression.json')}`);
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
