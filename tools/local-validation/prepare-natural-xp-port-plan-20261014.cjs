'use strict';
// Builds a NEW read-only proposal directory from pinned files. No engine,
// server, actor, world, native plugin, or task is loaded or changed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const workspace = '.';
const evidence = path.join(workspace, '.minecraft-local-test/evidence/estate-20261013');
const frozenV1 = path.join(evidence, 'natural-xp-host-private-frozen-v1');
const frozenV2 = path.join(evidence, 'natural-xp-host-private-frozen-v2');
const destination = path.join(workspace, '.minecraft-local-test/module-candidates/natural-xp-production-port-plan-20261014');
const acorn = require(path.join(workspace, 'personal-ai-deskpet-electron-work/electron/node_modules/acorn'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(file);
const originals = JSON.parse(read(path.join(frozenV1, 'deskpet-natural-xp-host-v1-readiness.json'))).originalIntegrity;
const v2Pinned = [
  ['deskpet-natural-xp-host-v2.cjs', 'a38a7500551080e02b9139505aaf342a761e83c60b819d92860344db65339f1c'],
  ['deskpet-natural-xp-stage-policy-v2.cjs', '11963a13ecd76c8d9d4387f29feca9430a47960886182901696e2b6755fc3e78'],
  ['deskpet-natural-xp-host-engine-glue-v2.txt', '29c3cafb9ba9cc31371497079de583c14a054be1d7224d2724808080b7aece1d'],
  ['deskpet-natural-xp-host-engine-v2.patch', '43916eb2d7a5f319f880165bdee84e960efc6eb395b472bd238aee40f15bcb5f'],
  ['deskpet-natural-xp-host-v2-handoff.md', 'a89e62e67dac3aa3bf2160e047d4d3d7b0a21addd8d3ecea50db1f8d30d23bab'],
];
if (fs.existsSync(destination)) throw new Error('Refusing to overwrite existing proposal directory');
const inputs = [
  ...originals.map(entry => ({ file: entry.path, expected: entry.expectedSHA256, group: 'ten-originals' })),
  ...v2Pinned.map(([name, expected]) => ({ file: path.join(frozenV2, name), expected, group: 'v2-reference' })),
];
for (const entry of inputs) {
  entry.bytes = read(entry.file); entry.actual = sha(entry.bytes);
  if (entry.actual !== entry.expected) throw new Error(`Pinned source changed: ${entry.file}`);
}
fs.mkdirSync(destination, { recursive: true });
const files = [];
function save(relative, bytes) {
  const file = path.join(destination, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o444 });
  files.push({ path: relative, sha256: sha(bytes), bytes: Buffer.byteLength(bytes) });
}
for (const entry of inputs) save(`originals/${entry.group}/${path.basename(entry.file)}`, entry.bytes);
const host = inputs.find(entry => path.basename(entry.file) === 'deskpet-natural-xp-host-v2.cjs').bytes.toString();
const hostBodyStart = host.indexOf('const AIR = ');
const hostExportStart = host.lastIndexOf('module.exports = ');
if (hostBodyStart < 0 || hostExportStart < 0) throw new Error('Host source markers missing');
const hostHeader = `/* global require, module, setTimeout, clearTimeout, setInterval, clearInterval */
'use strict';
// Proposal only: relative dependency port of the pinned native XP host.
// Actual production entry, current-source integration, and world acceptance remain pending.
const native = require;
const { Vec3 } = require('vec3'), { Movements, goals } = require('mineflayer-pathfinder');
const { dryFoot, getSurfaceGraphProtectedPositions } = require('./houseSurfaceGraph');
const { createEstatePlacement } = require('./estatePlacement');
const { withHouseNativeSourceGuard } = require('./houseNativeSourceGuard');
const dependencies = Object.freeze({
  provider: require('./houseNaturalXPProvider'),
  pool: require('./houseNaturalXPLevelProgressPool'),
  renewable: require('./houseRenewableCactusProvider'),
  enchant: require('./houseNaturalEnchant'),
});
function loadFrozen(label) {
  if (!Object.prototype.hasOwnProperty.call(dependencies, label)) throw new TypeError('Unknown native XP dependency');
  return dependencies[label];
}
`;
const modules = new Map();
modules.set('houseNaturalXPHost.js', hostHeader + host.slice(hostBodyStart, hostExportStart)
  + 'module.exports = { createNaturalHouseXPHost, isOwnedNaturalHouseXPCancel, getNaturalXPProtectedPositions };\n');
modules.set('houseNaturalXPStagePolicy.js', read(path.join(frozenV2, 'deskpet-natural-xp-stage-policy-v2.cjs')).toString());
const pool = read('/private/tmp/deskpet-house-xp-furnace-pool-v2.cjs').toString();
const poolStart = pool.indexOf('const frames = ');
modules.set('houseNaturalXPLevelProgressPool.js', `/* global require, module, setTimeout, clearTimeout, setInterval, clearInterval */
'use strict';
// Proposal only: level/progress successor; preserves the older production pool.
const runtimeRequire = require;
const { Vec3 } = require('vec3');
const { dryBody, isOwnedXPNativeCancel } = require('./houseNaturalXPProvider');
` + pool.slice(poolStart));
const renewable = read('/private/tmp/deskpet-renewable-cactus-provider-v1.cjs').toString();
const renewableStart = renewable.indexOf('const frames=');
modules.set('houseRenewableCactusProvider.js', `'use strict';
// Proposal only: relative dependency port, with original native crop core unchanged.
const runtimeRequire=require;
const {Vec3}=require('vec3'),{Movements,goals}=require('mineflayer-pathfinder'),NativeMove=require('mineflayer-pathfinder/lib/move');
const {dryBody}=require('./houseNaturalXPProvider');
const {dryFoot}=require('./houseSurfaceGraph');
const {createEstatePlacement}=require('./estatePlacement');
` + renewable.slice(renewableStart));
const enchant = read('/private/tmp/deskpet-house-natural-enchant.cjs').toString();
const enchantStart = enchant.indexOf('const copy=');
modules.set('houseNaturalEnchant.js', `'use strict';
// Proposal only: relative dependency port of the original native enchant core.
const {Vec3}=require('vec3');
const ItemFactory=require('prismarine-item');
` + enchant.slice(enchantStart));
const coreProofs = [];
const sourceMap = {
  houseNaturalXPHost: host,
  houseNaturalXPStagePolicy: modules.get('houseNaturalXPStagePolicy.js'),
  houseNaturalXPLevelProgressPool: pool,
  houseRenewableCactusProvider: renewable,
  houseNaturalEnchant: enchant,
};
for (const [name, source] of modules) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest' });
  const original = sourceMap[name.slice(0, -3)];
  const oldAST = acorn.parse(original, { ecmaVersion: 'latest' });
  const oldFunctions = oldAST.body.filter(node => node.type === 'FunctionDeclaration' && node.id.name !== 'loadFrozen');
  const checks = oldFunctions.map(node => {
    const fresh = ast.body.find(entry => entry.type === 'FunctionDeclaration' && entry.id.name === node.id.name);
    const before = original.slice(node.start, node.end), after = fresh && source.slice(fresh.start, fresh.end);
    return { name: node.id.name, unchanged: before === after, sha256: sha(before), bytes: Buffer.byteLength(before) };
  });
  if (checks.some(check => !check.unchanged)) throw new Error(`Unexpected core function change: ${name}`);
  let remainderEqual;
  if (name === 'houseNaturalXPHost.js') remainderEqual = source.slice(source.indexOf('const AIR = '), source.lastIndexOf('module.exports = ')) === host.slice(hostBodyStart, hostExportStart);
  else if (name === 'houseNaturalXPStagePolicy.js') remainderEqual = source === original;
  else {
    const marker = name === 'houseNaturalXPLevelProgressPool.js' ? 'const frames = ' : name === 'houseRenewableCactusProvider.js' ? 'const frames=' : 'const copy=';
    remainderEqual = source.slice(source.indexOf(marker)) === original.slice(original.indexOf(marker));
  }
  if (!remainderEqual) throw new Error(`Unexpected non-loader source change: ${name}`);
  coreProofs.push({ module: name, originalFile: name === 'houseNaturalXPHost.js' ? path.join(frozenV2, 'deskpet-natural-xp-host-v2.cjs')
    : name === 'houseNaturalXPStagePolicy.js' ? path.join(frozenV2, 'deskpet-natural-xp-stage-policy-v2.cjs')
    : name === 'houseNaturalXPLevelProgressPool.js' ? '/private/tmp/deskpet-house-xp-furnace-pool-v2.cjs'
    : name === 'houseRenewableCactusProvider.js' ? '/private/tmp/deskpet-renewable-cactus-provider-v1.cjs' : '/private/tmp/deskpet-house-natural-enchant.cjs',
  allCoreRemainderBytesUnchanged: remainderEqual, originalFunctions: checks });
  save(`proposal/vendor/server/minecraft/${name}`, source);
}
save('core-preservation-proof.json', JSON.stringify({ schema: 1, status: 'HEADER_ONLY_PROPOSAL_NOT_BOUND', coreProofs,
  productionEngineEdited: false, privateOriginalsEdited: false, javaStarted: false, worldReadOrModified: false,
  moduleImportedOrExecuted: false, syntaxParser: 'installed acorn, AST only',
  copiedSources: inputs.map(({ file, expected, actual, group }) => ({ file, expected, actual, unchanged: expected === actual, group })),
}, null, 2) + '\n');
save('artifact-manifest.json', JSON.stringify({ schema: 1, status: 'READ_ONLY_RELATIVE_DEPENDENCY_PROPOSAL',
  destination, builtAt: new Date().toISOString(), files, parentHostSHA256: v2Pinned[0][1],
  engineOverlayReady: false, naturalXPAccepted: false, javaStarted: false, productionEdited: false,
}, null, 2) + '\n');
console.log(JSON.stringify({ destination, originalSources: inputs.length, proposedModules: modules.size,
  allPinnedOriginalsUnchanged: true, allCoreBytesUnchanged: true, files: files.length,
  manifestSHA256: sha(read(path.join(destination, 'artifact-manifest.json'))) }));
