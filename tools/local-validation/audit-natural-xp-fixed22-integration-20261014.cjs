'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const workspace = '.';
const runtime = path.join(workspace, 'personal-ai-deskpet-electron-work/electron/minecraft-runtime');
const frozen22 = path.join(workspace, '.minecraft-local-test/runtime-candidates/house-self22-recorded-return-input-recovery-20261014');
const evidence = path.join(workspace, '.minecraft-local-test/evidence/estate-20261013');
const acorn = require(path.join(workspace, 'personal-ai-deskpet-electron-work/electron/node_modules/acorn'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(file, 'utf8');
const functions = source => {
  const found = new Map(), counts = new Map();
  function visit(node, parents) {
    if (!node || typeof node !== 'object') return;
    let next = parents;
    if (node.type === 'FunctionDeclaration') {
      const base = [...parents, node.id.name].join('::'), n = counts.get(base) || 0;
      counts.set(base, n + 1); found.set(`${base}#${n}`, { name: node.id.name, bytes: source.slice(node.start, node.end) });
      next = [...parents, node.id.name];
    }
    for (const [key, value] of Object.entries(node)) if (!['start', 'end'].includes(key)) {
      if (Array.isArray(value)) for (const child of value) visit(child, next);
      else if (value && typeof value === 'object') visit(value, next);
    }
  }
  visit(acorn.parse(source, { ecmaVersion: 'latest' }), []); return found;
};
const engineName = 'vendor/server/minecraftTaskAgent.js';
const before = read(path.join(frozen22, engineName)), after = read(path.join(runtime, engineName));
const oldFunctions = functions(before), newFunctions = functions(after);
const allowed = new Set(['createMinecraftTaskAgent', 'getStepWatchdogProfile', 'executeStepWithWatchdog',
  'houseResourcePositionExcluded', 'createHouseMaterialRuntime', 'executeBuildFurnishedHousePhase', 'executeBuildEstate']);
const originalFunctions = [...oldFunctions].map(([key, value]) => {
  const fresh = newFunctions.get(key), unchanged = fresh?.bytes === value.bytes;
  return { key, name: value.name, unchanged, allowedChange: !unchanged && allowed.has(value.name),
    beforeSHA256: sha(value.bytes), afterSHA256: fresh && sha(fresh.bytes) };
});
const added = [...newFunctions].filter(([key]) => !oldFunctions.has(key)).map(([key, value]) => ({ key, name: value.name, sha256: sha(value.bytes) }));
const oldMaterial = [...oldFunctions.values()].find(entry => entry.name === 'createHouseMaterialRuntime').bytes;
const newMaterial = [...newFunctions.values()].find(entry => entry.name === 'createHouseMaterialRuntime').bytes;
const invertedMaterial = newMaterial
  .replace(' || isOwnedNaturalHouseXPCancel(bot, name, data)', '')
  .replace('    source.runXPAtCamp = action => runAtHouseCamp({ resource: "cactus" }, action);\n    source.returnXPCamp = returnHouseCamp;\n', '');
const builderName = 'vendor/server/minecraft/furnishedHouseBuilder.js';
const oldBuilder = read(path.join(frozen22, builderName)), newBuilder = read(path.join(runtime, builderName));
const builderInverseExact = newBuilder.replace('  return { run, verifyFurniture };', '  return { run };') === oldBuilder;
const preservedNames = ['vendor/server/minecraft/houseSelfSupplyRuntime.js', 'vendor/server/minecraft/houseQuarry.js',
  'vendor/server/minecraft/houseQuarryEntry.js', 'vendor/server/minecraft/houseSurfaceGraph.js',
  'vendor/server/minecraft/houseNativeSourceGuard.js', 'test/house-quarry-entry-engine.test.js', 'test/house-quarry-entry.test.js'];
const preserved = preservedNames.map(file => ({ file, currentSHA256: sha(read(path.join(runtime, file))),
  frozen22SHA256: sha(read(path.join(frozen22, file))), unchanged: read(path.join(runtime, file)) === read(path.join(frozen22, file)) }));
const originals = JSON.parse(read(path.join(evidence, 'natural-xp-host-private-frozen-v1/deskpet-natural-xp-host-v1-readiness.json'))).originalIntegrity;
const originalTen = originals.map(entry => ({ path: entry.path, expectedSHA256: entry.expectedSHA256,
  actualSHA256: sha(fs.readFileSync(entry.path)), unchanged: sha(fs.readFileSync(entry.path)) === entry.expectedSHA256 }));
const frozenHost = read(path.join(evidence, 'natural-xp-host-private-frozen-v2/deskpet-natural-xp-host-v2.cjs'));
const currentHost = read(path.join(runtime, 'vendor/server/minecraft/houseNaturalXPHost.js'));
const oldHostCore = [...functions(frozenHost).values()].find(entry => entry.name === 'createNaturalHouseXPHost').bytes;
const newHostCore = [...functions(currentHost).values()].find(entry => entry.name === 'createNaturalHouseXPHost').bytes;
const payload = { schema: 1, status: 'SCOPED_SOURCE_AUDIT_PENDING_TEST_CLOSEOUT', frozen22ManifestSHA256: '9609435a464805ca7ad1e1fd82fb237bdf79b926d3a590d994a91573b054119e',
  parentEngineSHA256: sha(before), currentEngineSHA256: sha(after), oldFunctionCount: oldFunctions.size, currentFunctionCount: newFunctions.size,
  changedOriginalFunctions: originalFunctions.filter(entry => !entry.unchanged), addedFunctions: added,
  unexpectedChanges: originalFunctions.filter(entry => !entry.unchanged && !entry.allowedChange),
  materialRuntimeInverseExact: invertedMaterial === oldMaterial, materialRuntimeOriginalSHA256: sha(oldMaterial),
  materialRuntimeInverseSHA256: sha(invertedMaterial), builderInverseExact, currentBuilderSHA256: sha(newBuilder),
  existingQuarryEntryAndSourceFiles: preserved, originalTen, hostCore: { bytes: Buffer.byteLength(newHostCore),
    beforeSHA256: sha(oldHostCore), afterSHA256: sha(newHostCore), originalFunctionBodyExact: oldHostCore === newHostCore },
  javaStarted: false, worldReadOrModified: false, fullQARun: false, naturalXPWorldAccepted: false };
payload.pass = !payload.unexpectedChanges.length && added.length === 1 && added[0].name === 'finishNaturalHouseXP'
  && originalFunctions.filter(entry => !entry.unchanged).length === allowed.size && payload.materialRuntimeInverseExact
  && builderInverseExact && preserved.every(entry => entry.unchanged) && originalTen.every(entry => entry.unchanged) && payload.hostCore.originalFunctionBodyExact;
const destination = path.join(evidence, 'natural-xp-production-integration22-source-audit-01.json');
fs.writeFileSync(destination, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
console.log(JSON.stringify({ destination, pass: payload.pass, engineSHA256: payload.currentEngineSHA256,
  functionsBefore: oldFunctions.size, functionsAfter: newFunctions.size, changed: payload.changedOriginalFunctions.map(entry => entry.name),
  added: added.map(entry => entry.name), materialRuntimeInverseExact: payload.materialRuntimeInverseExact, builderInverseExact,
  originalTenUnchanged: originalTen.every(entry => entry.unchanged), hostCoreExact: payload.hostCore.originalFunctionBodyExact }));
process.exitCode = payload.pass ? 0 : 1;
