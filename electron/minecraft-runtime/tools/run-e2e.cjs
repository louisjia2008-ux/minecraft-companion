#!/usr/bin/env node
/* global require, process, console, __dirname */
'use strict';
// The end-to-end scenario (scenarios/e2e.cjs) in several independent sessions
// at once: each session is its own vanilla server, fresh world and seed.
//
//   npm run e2e -- --accept-eula                       # 3 sessions, seeds 1-3
//   npm run e2e -- --accept-eula --sessions 2 --seed 40
//
// Results land in <installation>/scenario-runs/e2e-<time>/; e2e.json there
// holds the verdict. Exits 1 unless every session passes.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};

function usage(message) {
  if (message) console.error(message);
  console.error(`Usage: node tools/run-e2e.cjs --accept-eula [--sessions N] [--seed FIRST] [--scenario NAME]
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

async function main() {
  if (args.includes('--help')) usage();
  if (!args.includes('--accept-eula')) usage('Pass --accept-eula after accepting https://aka.ms/MinecraftEULA');
  const sessions = Number(option('--sessions', 3));
  const firstSeed = Number(option('--seed', 1));
  const scenario = option('--scenario', 'e2e-flat');
  if (!Number.isSafeInteger(sessions) || sessions < 1) usage('--sessions must be a positive integer');
  if (!Number.isSafeInteger(firstSeed)) usage('--seed must be an integer');
  const runtime = path.resolve(__dirname, '..');
  const installation = path.resolve(option('--installation', path.join(runtime, '../../.minecraft-local-test')));
  const passthrough = ['--java', '--server-jar', '--version'].flatMap((name) => {
    const value = option(name, null);
    return value === null ? [] : [name, value];
  });
  const batch = `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const batchDir = path.join(installation, 'scenario-runs', batch);
  console.log(`▶ ${scenario}: ${sessions} sessions, seeds ${firstSeed}..${firstSeed + sessions - 1}\n  output=${batchDir}`);
  const startedAt = Date.now();
  const verdicts = await Promise.all(Array.from({ length: sessions }, async (_, i) => {
    const seed = firstSeed + i;
    const session = `${batch}/seed-${seed}`;
    const child = await run(process.execPath, [path.join(runtime, 'tools/run-scenarios.cjs'), '--accept-eula',
      '--scenario', scenario, '--runs', '1', '--seed', String(seed), '--batch', session.replace('/', '.'),
      '--installation', installation, ...passthrough], { prefix: `[seed ${seed}] `, cwd: runtime });
    const summaryFile = path.join(installation, 'scenario-runs', session.replace('/', '.'), scenario, 'summary.json');
    const summary = fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile, 'utf8')) : null;
    const result = summary?.results?.[0] || null;
    return { seed, pass: child.code === 0 && Boolean(result?.pass), exitCode: child.code,
      output: path.dirname(summaryFile), result };
  }));
  const passed = verdicts.every((v) => v.pass);
  fs.mkdirSync(batchDir, { recursive: true });
  fs.writeFileSync(path.join(batchDir, 'e2e.json'), JSON.stringify({ scenario, passed,
    durationSeconds: Math.round((Date.now() - startedAt) / 1000), sessions: verdicts }, null, 2) + '\n');
  console.log(`\nEnd to end (${scenario}): ${passed ? 'PASS' : 'FAIL'}`);
  for (const v of verdicts) {
    const r = v.result;
    const injections = (r?.injections || []).map((i) => `${i.name}${i.recoveredAt ? `:${i.seconds}s` : ':NOT RECOVERED'}`).join(' ');
    console.log(`  ${v.pass ? 'PASS' : 'FAIL'}  seed ${v.seed}  ${r ? `${Math.round(r.durationMs / 60000)} min, deaths ${r.deaths}`
      + `${r.reason ? `, ${r.reason}` : ''}\n        ${injections}` : `no result (exit ${v.exitCode})`}\n        ${v.output}`);
  }
  console.log(`  details: ${path.join(batchDir, 'e2e.json')}`);
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
