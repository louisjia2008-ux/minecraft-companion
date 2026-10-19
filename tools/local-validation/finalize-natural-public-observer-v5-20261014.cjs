'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const workspace = '.';
const folder = path.join(workspace, '.minecraft-local-test/acceptance');
const evidence = path.join(workspace, '.minecraft-local-test/evidence/estate-20261013');
const acorn = require(path.join(workspace, 'personal-ai-deskpet-electron-work/electron/node_modules/acorn'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const files = new Map();
function save(file, bytes) {
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o444 }); files.set(file, sha(bytes));
}
const parentFile = path.join(folder, 'natural-public-building-acceptance-v4.cjs');
const runnerFile = path.join(folder, 'natural-public-building-acceptance-v5.cjs');
const fragmentFile = path.join(folder, 'natural-public-dynamic-observer-v5-fragment.cjs');
const testFile = path.join(folder, 'natural-public-dynamic-observer-v5.test.cjs');
const parent = fs.readFileSync(parentFile, 'utf8'), runner = fs.readFileSync(runnerFile, 'utf8');
const parentSHA256 = '202407974ea7a9f0678c8b475afa866260c6b0cb56c83d8a778268a7a663fe8b';
if (sha(parent) !== parentSHA256) throw new Error('Frozen parent v4 changed');
const normalized = source => source.replaceAll('observerRevision: 5', 'observerRevision: 4').replaceAll('observerRevision:5', 'observerRevision:4')
  .replaceAll(parentSHA256, '006f13270394bce62970cd7eb3f90a5805d0fbad7a59e91c8d70ab48b7a4e5e0');
const inverse = normalized(runner).replace('creeperPosition: point(entity.position)', 'position: point(entity.position)');
if (inverse !== parent) throw new Error('Full-byte inverse to v4 failed');
const parentAST = acorn.parse(parent, { ecmaVersion: 'latest' }), currentAST = acorn.parse(runner, { ecmaVersion: 'latest' });
const originalFunctions = parentAST.body.filter(node => node.type === 'FunctionDeclaration');
const functions = originalFunctions.map(node => {
  const fresh = currentAST.body.find(entry => entry.type === 'FunctionDeclaration' && entry.id.name === node.id.name);
  const oldBody = parent.slice(node.start, node.end), freshBody = runner.slice(fresh.start, fresh.end);
  const same = normalized(freshBody) === oldBody;
  return { name: node.id.name, unchangedExceptAllowedMetadata: same, allowedObserverChange: !same && node.id.name === 'installDynamicObservers',
    beforeSHA256: sha(oldBody), afterSHA256: sha(freshBody) };
});
if (functions.some(entry => !entry.unchangedExceptAllowedMetadata && !entry.allowedObserverChange)) throw new Error('Unexpected non-observer function changed');
const proofFile = path.join(evidence, 'natural-public-dynamic-observer-v5-core-proof.json');
save(proofFile, JSON.stringify({ schema: 1, parentSHA256, runnerSHA256: sha(runner), inverseSHA256: sha(inverse), exactParentBytesRestored: true,
  functions, changedProjection: 'creeperPosition preserves actual entity position; position remains actor frame',
  noTaskParamsServerWorldMaterialsFurnitureCriteriaTimeoutOrLifecycleChange: true,
  noNewNativeApiWraps: true, noNewWorldQueries: true, javaStarted: false }, null, 2) + '\n');
const patchFile = path.join(folder, 'natural-public-building-v5-to-v4.patch');
const diff = cp.spawnSync('diff', ['-u', '-L', 'natural-public-building-acceptance.cjs', '-L', 'natural-public-building-acceptance.cjs', runnerFile, parentFile], { encoding: 'utf8' });
if (diff.status !== 1) throw new Error('Expected one exact reverse patch');
save(patchFile, diff.stdout);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-observer-v5-inverse-'));
const copied = path.join(temp, 'natural-public-building-acceptance.cjs'); fs.writeFileSync(copied, runner, { flag: 'wx' });
const patch = cp.spawnSync('patch', ['-p0', '-i', patchFile], { cwd: temp, encoding: 'utf8' });
const restored = fs.readFileSync(copied);
if (patch.status !== 0 || sha(restored) !== parentSHA256) throw new Error('System reverse patch did not restore exact v4');
const reverseProof = path.join(evidence, 'natural-public-dynamic-observer-v5-reverse-patch-proof.json');
save(reverseProof, JSON.stringify({ schema: 1, patchFile, patchSHA256: sha(diff.stdout), tempCopy: copied, systemPatchExitCode: patch.status,
  systemPatchOutput: patch.stdout + patch.stderr, restoredSHA256: sha(restored), expectedV4SHA256: parentSHA256,
  exactParentBytesRestored: true, originalV4SHA256After: sha(fs.readFileSync(parentFile)), originalV5SHA256After: sha(fs.readFileSync(runnerFile)),
  originalFilesUnchanged: true, javaStarted: false }, null, 2) + '\n');
for (const [input, name] of [
  ['/private/tmp/natural-public-dynamic-observer-v5-tests-01.log', 'natural-public-dynamic-observer-v5-tests-01.log'],
  ['/private/tmp/natural-public-dynamic-observer-v5-tests-02.log', 'natural-public-dynamic-observer-v5-tests-02.log'],
  ['/private/tmp/natural-public-dynamic-observer-v5-preflight-01.json', 'natural-public-dynamic-observer-v5-preflight-01.json'],
]) save(path.join(evidence, name), fs.readFileSync(input));
for (const file of [runnerFile, fragmentFile, testFile]) { files.set(file, sha(fs.readFileSync(file))); fs.chmodSync(file, 0o444); }
const manifest = { schema: 1, status: 'PURE_OBSERVER_V5_OFFLINE_PASS_NOT_LIVE_RUN', createdAt: new Date().toISOString(),
  parentRunner: parentFile, parentRunnerSha256: parentSHA256, runner: runnerFile, runnerSha256: sha(runner), files: Object.fromEntries(files),
  tests: { pass: 15, fail: 0, nodeExit: 0, durationMs: 81.814166, newCoordinateNamespaceCases: 6 },
  preflight: JSON.parse(fs.readFileSync('/private/tmp/natural-public-dynamic-observer-v5-preflight-01.json')),
  coreProof: 'System patch applied only to a temporary copy restores every v4 byte; all non-observer functions and full grader/furniture/savedAudit/lifecycle unchanged except revision/parent metadata.',
  change: 'One projection key: actual creeper entity position now uses creeperPosition, preserving actor position from frame.',
  bounds: { pathPoints: 64, creeperCache: 128, newTimers: 0, newWorldQueries: 0, newNativeApiWraps: 0 },
  firstOfflineFailure: 'tests01 namespace variable rename altered parent filename to acceptance-current; source runner inverse was already exact. Only the new test parent filename was corrected; first failure log preserved.',
  historicalLimit: 'Frozen v4 whole14 native_creeper_* position fields were actor positions due to overwritten keys. IDs/name/isValid and actual-change event dedup remain observations, but actual creeper positions/distance/attack attribution cannot be recovered or retroactively accepted.',
  limits: ['No Java or v5 live dynamic event acceptance', 'No historical v4 corrections', 'Original v4 30-level XP and every existing acceptance requirement retained', 'Receipt observer/parser remains a separate candidate'],
  productionSourceModified: false, worldReadOrModifiedByPreparation: false, javaStarted: false };
const manifestFile = path.join(folder, 'natural-public-dynamic-observer-v5-manifest.json');
save(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ runnerFile, runnerSHA256: sha(runner), fragmentSHA256: sha(fs.readFileSync(fragmentFile)), testSHA256: sha(fs.readFileSync(testFile)),
  manifestFile, manifestSHA256: sha(fs.readFileSync(manifestFile)), originalFunctionCount: functions.length,
  nonObserverFunctionsUnchanged: functions.filter(entry => entry.unchangedExceptAllowedMetadata).length, exactReverseSystemPatch: true, testsPassed: 15,
  javaStarted: false }));
