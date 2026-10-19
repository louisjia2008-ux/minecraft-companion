'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { allocateFreshRun, inspectSeedAllocation } = require('./fresh-seed-allocation-v1.cjs');
const acorn = require('../electron/node_modules/acorn');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const bytes = seed => { const buffer = Buffer.alloc(8); buffer.writeBigInt64BE(BigInt(seed)); return buffer; };
function fixture(t, options = {}) {
  // Test-only filesystem models, never a Java run or actual Minecraft world.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-fresh-seed-contract-'));
  const installation = path.join(dir, 'installation'), runtimeRoot = path.join(dir, 'runtime');
  fs.mkdirSync(installation); fs.mkdirSync(runtimeRoot); fs.mkdirSync(path.join(runtimeRoot, 'test-support'));
  fs.writeFileSync(path.join(runtimeRoot, 'package.json'), '{}\n'); fs.writeFileSync(path.join(runtimeRoot, 'runtime.js'), 'module.exports={};\n');
  for (const name of ['natural-world-audit.cjs', 'furnished-house-audit.cjs']) fs.writeFileSync(path.join(runtimeRoot, 'test-support', name), 'module.exports={};\n');
  fs.writeFileSync(path.join(installation, 'installation.json'), JSON.stringify({ minecraft: { version: '1.21.8', jar: '/no-java.jar' }, java: '/no-java' }));
  if (options.campaign !== false) fs.writeFileSync(path.join(installation, 'natural-furnished-house-campaign.json'), JSON.stringify({ schema: 1, version: '1.21.8', seed: '17', firstRun: 'legacy-model', selection: 'Historical model only' }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = { installation, runtimeRoot, runner: path.join(__dirname, 'natural-public-building-acceptance-v6.cjs'), profile: 'cottage' };
  return { installation, runtimeRoot, base, registry: path.join(installation, 'acceptance', 'fresh-seed-registry-v1'),
    allocate: (runName, extra = {}) => allocateFreshRun({ ...base, runName, ...extra }) };
}

test('real cryptographic signed64 draws reserve distinct seeds and names before any test-only start callback', t => {
  const f = fixture(t), seen = new Set();
  for (let i = 0; i < 12; i++) {
    const a = f.allocate(`unique-${i}`), proof = inspectSeedAllocation(a.runDir);
    assert.equal(proof.confirmed, true); assert.equal(a.ready, true); assert.ok(!seen.has(a.seed)); seen.add(a.seed);
    assert.ok(BigInt(a.seed) >= -(2n ** 63n) && BigInt(a.seed) < 2n ** 63n); assert.notEqual(a.seed, '17');
    assert.equal(fs.existsSync(path.join(a.runDir, 'world')), false);
    assert.equal(hash(fs.readFileSync(a.runner.path)), a.runner.sha256); assert.ok(a.runtime.sha256);
    assert.equal(a.priorCampaign.seed, '17');
  }
});

test('registered and historical collisions are the only bounded reasons to redraw', t => {
  const f = fixture(t); f.allocate('first', { randomBytes: () => bytes(20) });
  const values = [17, 20, 21]; let draws = 0;
  const a = f.allocate('second', { randomBytes: () => bytes(values[draws++]) });
  assert.equal(a.seed, '21'); assert.equal(draws, 3);
  const lines = fs.readFileSync(path.join(f.registry, 'by-run', 'second.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.filter(e => e.status === 'collision').map(e => e.reason), ['known_historical_seed', 'registered_seed']);
});

test('collision exhaustion keeps the rejected attempt and never creates or resumes a world', t => {
  const f = fixture(t); f.allocate('original', { randomBytes: () => bytes(-20) }); let draws = 0;
  assert.throws(() => f.allocate('collision-limit', { maxDraws: 3, randomBytes: () => { draws++; return bytes(-20); } }), { code: 'SEED_COLLISION_LIMIT' });
  assert.equal(draws, 3); assert.equal(fs.existsSync(path.join(f.installation, 'worlds', 'collision-limit')), false);
  const journal = fs.readFileSync(path.join(f.registry, 'by-run', 'collision-limit.jsonl'), 'utf8');
  assert.equal(journal.match(/"status":"collision"/g).length, 3); assert.match(journal, /allocation_or_preflight_failed/);
});

test('a modeled start failure retains the same seed and forbids name reuse or failure redraw', t => {
  const f = fixture(t); let draws = 0;
  const a = f.allocate('failed-start', { randomBytes: () => { draws++; return bytes(22); } });
  const before = fs.readFileSync(a.reservation);
  assert.throws(() => { assert.equal(inspectSeedAllocation(a.runDir).allocation.seed, '22'); throw new Error('modeled start failed'); });
  assert.throws(() => f.allocate('failed-start', { randomBytes: () => { draws++; return bytes(23); } }), { code: 'EEXIST' });
  assert.equal(draws, 1); assert.deepEqual(fs.readFileSync(a.reservation), before);
});

test('an existing world is never overwritten and its refusal remains registered before any draw', t => {
  const f = fixture(t), dir = path.join(f.installation, 'worlds', 'existing'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.marker'), 'untouched'); let draws = 0;
  assert.throws(() => f.allocate('existing', { randomBytes: () => { draws++; return bytes(24); } }), /existing run\/world/);
  assert.equal(draws, 0); assert.equal(fs.readFileSync(path.join(dir, 'world.marker'), 'utf8'), 'untouched');
  assert.match(fs.readFileSync(path.join(f.registry, 'by-run', 'existing.jsonl'), 'utf8'), /allocation_or_preflight_failed/);
});

test('missing legacy campaign never falls back to the old fixed seed', t => {
  const f = fixture(t, { campaign: false }); const a = f.allocate('no-legacy', { randomBytes: () => bytes(-25) });
  assert.equal(a.seed, '-25'); assert.equal(a.priorCampaign.status, 'MISSING');
});

test('old text-property seeds are excluded and historical unknown attempts stay explicitly unknown', t => {
  const f = fixture(t), old = path.join(f.installation, 'worlds', 'old-map'), unknown = path.join(f.installation, 'worlds', 'old-preflight');
  fs.mkdirSync(old, { recursive: true }); fs.mkdirSync(unknown); fs.writeFileSync(path.join(old, 'server.properties'), 'level-seed=-26\n');
  const values = [-26, 27]; let draw = 0;
  const a = f.allocate('history', { randomBytes: () => bytes(values[draw++]) });
  assert.equal(a.seed, '27'); assert.equal(draw, 2); assert.deepEqual(a.unknownHistoricalRuns, ['old-preflight']);
  assert.deepEqual(a.knownHistoricalRuns[0].seeds, ['-26']);
});

test('a reservation write error stops after the first assigned draw and leaves the occupied seed', t => {
  const f = fixture(t); let draws = 0, reservationFd, failed = false;
  const originalOpen = fs.openSync, originalWrite = fs.writeFileSync;
  try {
    fs.openSync = function (file, flags, ...rest) { const fd = originalOpen.call(this, file, flags, ...rest); if (String(file).endsWith('/28.json') && flags === 'wx') reservationFd = fd; return fd; };
    fs.writeFileSync = function (file, ...rest) { if (file === reservationFd && !failed) { failed = true; throw Object.assign(new Error('modeled write failure'), { code: 'EIO' }); } return originalWrite.call(this, file, ...rest); };
    assert.throws(() => f.allocate('write-error', { randomBytes: () => { draws++; return bytes(28); } }), { code: 'EIO' });
  } finally { fs.openSync = originalOpen; fs.writeFileSync = originalWrite; }
  assert.equal(draws, 1); assert.ok(fs.existsSync(path.join(f.registry, 'by-seed', '28.json')));
  assert.match(fs.readFileSync(path.join(f.registry, 'by-run', 'write-error.jsonl'), 'utf8'), /allocation_or_preflight_failed/);
});

test('runtime preflight failure retains allocation bytes and refuses a fresh seed for the same name', t => {
  const f = fixture(t); fs.rmSync(f.runtimeRoot, { recursive: true }); let draws = 0;
  assert.throws(() => f.allocate('invalid-runtime', { randomBytes: () => { draws++; return bytes(29); } }), /preflight is UNKNOWN/);
  const runDir = path.join(f.installation, 'worlds', 'invalid-runtime'), a = JSON.parse(fs.readFileSync(path.join(runDir, 'seed-allocation.json')));
  assert.equal(a.seed, '29'); assert.equal(a.runtime.status, 'UNKNOWN'); assert.equal(a.ready, false); assert.ok(fs.existsSync(a.reservation));
  assert.throws(() => f.allocate('invalid-runtime', { randomBytes: () => { draws++; return bytes(30); } }), { code: 'EEXIST' }); assert.equal(draws, 1);
});

test('actual v6 Node preflight retains a seed even when runtime loading fails; no Java is started', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [f.base.runner, '--preflight', '--run-name', 'failed-import', '--installation', f.installation, '--runtime-root', f.runtimeRoot], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /Cannot find module/);
  const a = inspectSeedAllocation(path.join(f.installation, 'worlds', 'failed-import')).allocation;
  assert.equal(a.preflightOnly, true); assert.ok(a.seed); assert.equal(fs.existsSync(path.join(a.runDir, 'server.properties')), false);
  assert.equal(fs.existsSync(path.join(a.runDir, 'world')), false);
});

test('actual Node-only public-plan preflight uses a separately allocated name, and reuse is refused before Java', t => {
  const f = fixture(t), runtime = path.resolve(__dirname, '../runtime-candidates/house-self22-recorded-return-input-recovery-20261014');
  const args = [f.base.runner, '--preflight', '--run-name', 'plan-preflight', '--installation', f.installation, '--runtime-root', runtime];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr); const output = JSON.parse(result.stdout.trim());
  assert.equal(output.javaStarted, false); assert.equal(output.runnerRevision, 6); assert.equal(output.actualPublicPlan.confirmed, true);
  const a = inspectSeedAllocation(path.join(f.installation, 'worlds', 'plan-preflight')).allocation;
  assert.equal(a.seed, output.seed); assert.equal(a.preflightOnly, true); assert.equal(fs.existsSync(path.join(a.runDir, 'world')), false);
  const reuse = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 }); assert.equal(reuse.status, 1); assert.match(reuse.stderr, /EEXIST/);
});

test('actual runner missing-Java startup preflight preserves its assigned seed and never generates a map', t => {
  const f = fixture(t), runtime = path.resolve(__dirname, '../runtime-candidates/house-self22-recorded-return-input-recovery-20261014');
  const result = spawnSync(process.execPath, [f.base.runner, '--accept-eula', '--run-name', 'missing-java', '--installation', f.installation, '--runtime-root', runtime], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /Installed Java\/JAR missing/);
  const a = inspectSeedAllocation(path.join(f.installation, 'worlds', 'missing-java')).allocation;
  assert.equal(a.preflightOnly, false); assert.ok(a.seed); assert.equal(fs.existsSync(path.join(a.runDir, 'world')), false);
  assert.equal(fs.existsSync(path.join(a.runDir, 'server.properties')), false);
});

test('receipt readback rejects substituted seed, name or missing registry reservation', t => {
  const f = fixture(t); const a = f.allocate('receipt-negative', { randomBytes: () => bytes(31) });
  const file = path.join(a.runDir, 'seed-allocation.json'), before = fs.readFileSync(file); fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, JSON.stringify({ ...a, seed: '32' })); assert.throws(() => inspectSeedAllocation(a.runDir));
  fs.writeFileSync(file, JSON.stringify({ ...a, runName: 'foreign' })); assert.throws(() => inspectSeedAllocation(a.runDir));
  fs.writeFileSync(file, before); fs.unlinkSync(a.reservation); assert.throws(() => inspectSeedAllocation(a.runDir), { code: 'ENOENT' });
});

test('v6 exact inverse preserves all v5 bytes and every non-setup core function including grader and saved audit', () => {
  const proof = JSON.parse(fs.readFileSync(path.join(__dirname, 'natural-public-fresh-seed-v6-edit-proof.json')));
  const current = fs.readFileSync(proof.runner, 'utf8'), parent = fs.readFileSync(proof.parentFile, 'utf8'); let reverse = current;
  assert.equal(hash(parent), proof.parentSha256); assert.equal(hash(current), proof.runnerSha256);
  for (const e of [...proof.edits].reverse()) reverse = e.all ? reverse.replaceAll(e.after, e.before) : reverse.replace(e.after, e.before);
  assert.equal(reverse, parent);
  const a = acorn.parse(parent, { ecmaVersion: 'latest' }), b = acorn.parse(current, { ecmaVersion: 'latest' });
  for (const n of a.body.filter(n => n.type === 'FunctionDeclaration' && !['main', 'hashes', 'saveSources'].includes(n.id.name))) {
    const m = b.body.find(v => v.type === 'FunctionDeclaration' && v.id.name === n.id.name); assert.ok(m);
    assert.equal(current.slice(m.start, m.end), parent.slice(n.start, n.end), n.id.name);
  }
  assert.ok(current.indexOf('allocateFreshRun({') < current.indexOf("const mineflayer = req('mineflayer')"));
  assert.ok(current.indexOf('allocateFreshRun({') < current.indexOf('spawn(installed.java'));
  assert.ok(!current.includes("campaign.seed,'6239290801279771110'"));
});

test('new closed auditor retains every old byte except fresh allocation checks and dynamic saved seed', () => {
  const proof = JSON.parse(fs.readFileSync(path.join(__dirname, 'natural-public-fresh-seed-closeout-v2-edit-proof.json')));
  const current = fs.readFileSync(proof.target, 'utf8'), parent = fs.readFileSync(proof.parentFile, 'utf8'); let reverse = current;
  for (const e of [...proof.edits].reverse()) reverse = reverse.replace(e.after, e.before);
  assert.equal(reverse, parent); assert.equal(hash(parent), proof.parentSha256); assert.equal(hash(current), proof.targetSha256);
  assert.ok(current.includes('metadata.seed === seedAllocation.seed')); assert.ok(current.includes('allocatedSeedHelperSource'));
});
