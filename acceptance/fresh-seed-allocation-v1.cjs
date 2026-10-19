'use strict';
// Durable forward-only test seed reservations. No Java, world reads or runtime
// loading here. Every registered attempt is retained, including failed setup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = file => digest(fs.readFileSync(file));
const canonicalSeed = value => {
  const text = String(value);
  assert.match(text, /^-?\d+$/, 'Seed must be a signed64 decimal integer');
  const seed = BigInt(text);
  assert.ok(seed >= -(2n ** 63n) && seed < 2n ** 63n, 'Seed outside signed64 range');
  return seed.toString();
};
function syncDirectory(dir) {
  const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function durableExclusive(file, text, mode = 0o444) {
  const fd = fs.openSync(file, 'wx', mode);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}
function durableAppend(file, value) {
  const fd = fs.openSync(file, 'a');
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}
function runtimeFingerprint(runtimeRoot) {
  const files = {};
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', 'test', 'test-support'].includes(e.name)) continue;
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file);
      else if (e.isFile() && (e.name.endsWith('.js') || e.name === 'package.json')) files[path.relative(runtimeRoot, file)] = fileHash(file);
    }
  }
  try {
    walk(runtimeRoot);
    for (const name of ['test-support/natural-world-audit.cjs', 'test-support/furnished-house-audit.cjs']) files[name] = fileHash(path.join(runtimeRoot, name));
    assert.ok(files['package.json'], 'Runtime package fingerprint missing');
    return { path: runtimeRoot, sha256: digest(JSON.stringify(files)), files, status: 'RECORDED' };
  } catch (error) { return { path: runtimeRoot, sha256: null, files, status: 'UNKNOWN', error: error.message }; }
}
function history(installation) {
  const campaignFile = path.join(installation, 'natural-furnished-house-campaign.json');
  const priorCampaign = { path: campaignFile, status: 'MISSING', sha256: null };
  const seeds = new Set(), knownHistoricalRuns = [], unknownHistoricalRuns = [];
  if (fs.existsSync(campaignFile)) {
    const value = JSON.parse(fs.readFileSync(campaignFile, 'utf8'));
    Object.assign(priorCampaign, { status: 'RECORDED', sha256: fileHash(campaignFile), schema: value.schema,
      seed: canonicalSeed(value.seed), version: value.version, firstRun: value.firstRun, selection: value.selection });
    seeds.add(priorCampaign.seed);
  }
  const worlds = path.join(installation, 'worlds');
  if (fs.existsSync(worlds)) for (const e of fs.readdirSync(worlds, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const dir = path.join(worlds, e.name), found = new Set(), sources = [];
    const properties = path.join(dir, 'server.properties');
    if (fs.existsSync(properties)) {
      const raw = fs.readFileSync(properties, 'utf8').match(/^level-seed=(.*)$/m)?.[1].trim();
      if (raw) { found.add(canonicalSeed(raw)); sources.push({ path: properties, sha256: fileHash(properties) }); }
    }
    const result = path.join(dir, 'result.json');
    if (fs.existsSync(result)) {
      const seed = JSON.parse(fs.readFileSync(result, 'utf8')).seed;
      if (seed !== undefined && seed !== null) { found.add(canonicalSeed(seed)); sources.push({ path: result, sha256: fileHash(result) }); }
    }
    if (!found.size) unknownHistoricalRuns.push(e.name);
    else { for (const seed of found) seeds.add(seed); knownHistoricalRuns.push({ runName: e.name, seeds: [...found], sources }); }
  }
  return { priorCampaign, seeds, knownHistoricalRuns, unknownHistoricalRuns };
}
function allocateFreshRun(options) {
  const installation = path.resolve(options.installation), runtimeRoot = path.resolve(options.runtimeRoot), runner = path.resolve(options.runner);
  const runName = options.runName; assert.match(runName, /^[A-Za-z0-9_-]+$/);
  const registryRoot = path.join(installation, 'acceptance', 'fresh-seed-registry-v1');
  const byRun = path.join(registryRoot, 'by-run'), bySeed = path.join(registryRoot, 'by-seed');
  for (const dir of [byRun, bySeed]) fs.mkdirSync(dir, { recursive: true });
  const journal = path.join(byRun, `${runName}.jsonl`), runDir = path.join(installation, 'worlds', runName);
  const request = { schema: 2, kind: 'fresh_random_signed64_run', runName, profile: options.profile,
    attemptedAt: new Date().toISOString(), preflightOnly: options.preflightOnly === true, runner: { path: runner, sha256: fileHash(runner) },
    allocator: { path: __filename, sha256: fileHash(__filename) }, runtime: runtimeFingerprint(runtimeRoot), registryRoot, runDir };
  durableExclusive(journal, JSON.stringify({ status: 'requested', ...request }) + '\n', 0o600);
  try {
    assert.ok(!fs.existsSync(runDir), 'Refusing any existing run/world directory; allocated names are never resumed');
    let lineage, lineageError;
    try { lineage = history(installation); } catch (error) { lineageError = error.message; lineage = { priorCampaign: { status: 'UNKNOWN' }, seeds: new Set(), knownHistoricalRuns: [], unknownHistoricalRuns: [] }; }
    let version = null, installationError;
    try { version = JSON.parse(fs.readFileSync(path.join(installation, 'installation.json'), 'utf8')).minecraft.version; }
    catch (error) { installationError = error.message; }
    const draw = options.randomBytes || crypto.randomBytes;
    const maxDraws = options.maxDraws ?? 16; assert.ok(Number.isSafeInteger(maxDraws) && maxDraws >= 1 && maxDraws <= 64);
    for (let attempt = 1; attempt <= maxDraws; attempt++) {
      const bytes = draw(8); assert.ok(Buffer.isBuffer(bytes) && bytes.length === 8, 'Crypto seed draw must be eight bytes');
      const seed = bytes.readBigInt64BE().toString();
      const reservation = path.join(bySeed, `${seed}.json`);
      if (lineage.seeds.has(seed) || fs.existsSync(reservation)) {
        durableAppend(journal, { status: 'collision', seed, attempt, reason: lineage.seeds.has(seed) ? 'known_historical_seed' : 'registered_seed' }); continue;
      }
      const allocation = { ...request, seed, version, allocatedAt: new Date().toISOString(), drawAttempt: attempt,
        priorCampaign: lineage.priorCampaign, knownHistoricalRuns: lineage.knownHistoricalRuns, unknownHistoricalRuns: lineage.unknownHistoricalRuns,
        lineageError: lineageError || null, installationError: installationError || null, reservation,
        seedPolicy: 'First cryptographic signed64 draw not already reserved/known historical. Only collisions permit bounded redraw. No map filtering, failure redraw, reuse or legacy seed fallback.',
        ready: request.runtime.status === 'RECORDED' && !lineageError && !installationError };
      const text = JSON.stringify(allocation, null, 2) + '\n';
      // Only exclusive-open EEXIST is a concurrent seed collision. Any write,
      // fsync or receipt error aborts this attempt without drawing another seed.
      let fd;
      try { fd = fs.openSync(reservation, 'wx', 0o444); }
      catch (error) { if (error.code !== 'EEXIST') throw error; durableAppend(journal, { status: 'collision', seed, attempt, reason: 'concurrent_registered_seed' }); continue; }
      try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      syncDirectory(bySeed);
      durableAppend(journal, { status: 'allocated', seed, reservation, allocationSha256: digest(text) });
      fs.mkdirSync(path.dirname(runDir), { recursive: true }); fs.mkdirSync(runDir); syncDirectory(path.dirname(runDir));
      durableExclusive(path.join(runDir, 'seed-allocation.json'), text);
      assert.ok(allocation.ready, 'Allocation retained but runtime/installation/lineage preflight is UNKNOWN; refuse Java startup');
      return allocation;
    }
    throw Object.assign(new Error('Bounded seed collision budget exhausted; no world generated'), { code: 'SEED_COLLISION_LIMIT' });
  } catch (error) { durableAppend(journal, { status: 'allocation_or_preflight_failed', code: error.code || null, message: error.message }); throw error; }
}
function inspectSeedAllocation(runDir) {
  const file = path.join(path.resolve(runDir), 'seed-allocation.json'), bytes = fs.readFileSync(file), value = JSON.parse(bytes);
  assert.equal(value.schema, 2); assert.equal(value.kind, 'fresh_random_signed64_run'); assert.equal(value.runName, path.basename(runDir));
  assert.equal(value.runDir, path.resolve(runDir)); assert.equal(value.seed, canonicalSeed(value.seed)); assert.equal(value.ready, true);
  const installation = path.dirname(path.dirname(path.resolve(runDir))), registryRoot = path.join(installation, 'acceptance', 'fresh-seed-registry-v1');
  assert.equal(value.registryRoot, registryRoot); assert.equal(value.reservation, path.join(registryRoot, 'by-seed', `${value.seed}.json`));
  assert.deepEqual(fs.readFileSync(value.reservation), bytes, 'Per-run receipt differs from immutable seed reservation');
  const journal = fs.readFileSync(path.join(registryRoot, 'by-run', `${value.runName}.jsonl`), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(journal[0].status, 'requested');
  for (const name of ['runName', 'runDir', 'registryRoot', 'runner', 'allocator', 'runtime', 'attemptedAt', 'preflightOnly']) assert.deepEqual(journal[0][name], value[name], 'Allocation must retain its initial request identity');
  assert.ok(journal.some(e => e.status === 'allocated' && e.seed === value.seed && e.allocationSha256 === digest(bytes)));
  return { confirmed: true, allocation: value, receiptSha256: digest(bytes), journalSha256: fileHash(path.join(registryRoot, 'by-run', `${value.runName}.jsonl`)) };
}
module.exports = { allocateFreshRun, inspectSeedAllocation, runtimeFingerprint };
