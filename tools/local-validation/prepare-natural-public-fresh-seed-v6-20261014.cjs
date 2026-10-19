'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const folder = path.resolve(__dirname, '../acceptance'), parentFile = path.join(folder, 'natural-public-building-acceptance-v5.cjs');
const parent = fs.readFileSync(parentFile, 'utf8'), hash = s => crypto.createHash('sha256').update(s).digest('hex');
const parentSha = '8880727e18ccf78dff09ec7f1098776b6a6fb5685e1ed9af456a80a7f07c966d';
if (hash(parent) !== parentSha) throw new Error('Exact preserved v5 runner mismatch');
const edits = [];
const replace = (before, after) => { if (runner.split(before).length !== 2) throw new Error('Expected one edit anchor: ' + before.slice(0, 120)); runner = runner.replace(before, after); edits.push({ before, after }); };
let runner = parent;
replace("const installed = JSON.parse(fs.readFileSync(path.join(installation, 'installation.json'), 'utf8'));", `const { allocateFreshRun, inspectSeedAllocation } = require('./fresh-seed-allocation-v1.cjs');
const runName = argument('--run-name', \`natural-public-\${argument('--profile', 'cottage')}-\${Date.now()}\`); assert.match(runName, /^[A-Za-z0-9_-]+$/);
const runDir = path.join(installation, 'worlds', runName);
// Allocation and receipt are durable before runtime loading or any preflight.
const campaign = allocateFreshRun({ installation, runtimeRoot, runner: __filename, runName, profile: argument('--profile', 'cottage'), preflightOnly: argv.includes('--preflight') });
const campaignFile = path.join(runDir, 'seed-allocation.json');
const installed = JSON.parse(fs.readFileSync(path.join(installation, 'installation.json'), 'utf8'));`);
replace("const runName = argument('--run-name', `natural-public-${profile}-${Date.now()}`); assert.match(runName, /^[A-Za-z0-9_-]+$/);\nconst runDir = path.join(installation, 'worlds', runName);\nconst campaignFile = path.join(installation, 'natural-furnished-house-campaign.json');\n", '// Run identity and immutable seed receipt are allocated before imports above.\n');
replace('let sourceBefore, sourceAfter, campaign, initial,', 'let sourceBefore, sourceAfter, initial,');
replace("  all['private/natural-public-building-acceptance.cjs'] = hash(__filename);", "  all['private/natural-public-building-acceptance.cjs'] = hash(__filename);\n  all['private/fresh-seed-allocation-v1.cjs'] = hash(path.join(__dirname, 'fresh-seed-allocation-v1.cjs'));");
replace("relative === 'private/natural-public-building-acceptance.cjs' ? __filename : relative.startsWith('private/')", "relative === 'private/natural-public-building-acceptance.cjs' ? __filename : relative === 'private/fresh-seed-allocation-v1.cjs' ? path.join(__dirname, 'fresh-seed-allocation-v1.cjs') : relative.startsWith('private/')");
replace("  assert.ok(!fs.existsSync(runDir), 'Refusing to overwrite existing run'); fs.mkdirSync(runDir); created = true;\n  assert.ok(fs.existsSync(campaignFile),'A precommitted campaign manifest is mandatory; never draw/filter a new seed in the public runner');\n  campaign = JSON.parse(fs.readFileSync(campaignFile, 'utf8')); assert.equal(campaign.seed,'6239290801279771110','Retain the original committed natural-house campaign'); assert.equal(campaign.version, installed.minecraft.version); assert.match(campaign.seed, /^-?\\d+$/);\n  assert.ok(BigInt(campaign.seed) >= -(2n ** 63n) && BigInt(campaign.seed) < 2n ** 63n);", "  assert.ok(!fs.existsSync(path.join(runDir, 'world')), 'Allocated run must still have no preexisting world');\n  const seedProof = inspectSeedAllocation(runDir); assert.equal(seedProof.receiptSha256, hash(campaignFile)); assert.equal(campaign.version, installed.minecraft.version); created = true;");
replace("'One fixed random campaign seed; no arbitrary-seed guarantee.'", "'Every attempt keeps a distinct crypto signed64 seed allocated before preflight/start; failed attempts are retained. No arbitrary-map acceptance claim.'");
replace('profile,commandText,actualPublicPlan:validatePublicPlan(actualHeuristicPlan)', 'profile,commandText,seed:campaign.seed,seedAllocationFile:campaignFile,seedRuntimeSha256:campaign.runtime.sha256,actualPublicPlan:validatePublicPlan(actualHeuristicPlan)');
replace('  sourceBefore = hashes(); saveSources(sourceBefore);', `  sourceBefore = hashes();
  for (const [name, expected] of Object.entries(campaign.runtime.files)) assert.equal(sourceBefore[name], expected, 'Runtime source changed after persistent seed allocation');
  assert.equal(hash(__filename), campaign.runner.sha256); assert.equal(hash(path.join(__dirname, 'fresh-seed-allocation-v1.cjs')), campaign.allocator.sha256);
  saveSources(sourceBefore);`);
replace("  console.log('Fresh normal Survival empty-inventory public construction with self-obtained functional inputs. Unsupported mandatory capabilities remain PENDING; supplied component fixtures never count.');", "  console.log('Fresh normal Survival empty-inventory public construction with self-obtained functional inputs. Unsupported mandatory capabilities remain PENDING; supplied component fixtures never count.');\n  console.log('v6 reserves a unique crypto signed64 seed and fresh run directory before runtime/Java preflight. --preflight also consumes its UNIQUE run-name/seed; actual execution needs another UNIQUE name. Failed allocation/preflight/start attempts are never deleted, resumed or redrawn.');");
replace('node /private/tmp/natural-public-building-acceptance.cjs --accept-eula', 'node natural-public-building-acceptance-v6.cjs --accept-eula');
replace('  assertStartupActive();server = spawn(installed.java,', "  assertStartupActive();assert.ok(!fs.existsSync(path.join(runDir, 'world')), 'Refusing world creation/reuse before owned Java startup');server = spawn(installed.java,");
// Metadata only. Observer revision remains 5; no observer or grading change.
for (const before of ["observerRevision: 5, parentRunnerSha256: '202407974ea7a9f0678c8b475afa866260c6b0cb56c83d8a778268a7a663fe8b'", "observerRevision:5,parentRunnerSha256:'202407974ea7a9f0678c8b475afa866260c6b0cb56c83d8a778268a7a663fe8b'"]) {
  const after = before.replace(/parentRunnerSha256:/, 'runnerRevision:6,seedPolicyRevision:1,parentRunnerSha256:').replace('202407974ea7a9f0678c8b475afa866260c6b0cb56c83d8a778268a7a663fe8b', parentSha);
  const count = runner.split(before).length - 1; if (!count) throw new Error('Metadata edit anchor missing');
  runner = runner.replaceAll(before, after); edits.push({ before, after, all: true });
}
let reverted = runner; for (const e of [...edits].reverse()) reverted = e.all ? reverted.replaceAll(e.after, e.before) : reverted.replace(e.after, e.before);
if (reverted !== parent) throw new Error('Exact inverse to v5 failed');
const target = path.join(folder, 'natural-public-building-acceptance-v6.cjs');
fs.writeFileSync(target, runner, { flag: 'wx' });
const proof = { schema: 1, parentFile, parentSha256: parentSha, runner: target, runnerSha256: hash(runner), inverseRestoresEveryV5Byte: true, edits };
fs.writeFileSync(path.join(folder, 'natural-public-fresh-seed-v6-edit-proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ runner: target, sha256: hash(runner), inverseExact: true }));
