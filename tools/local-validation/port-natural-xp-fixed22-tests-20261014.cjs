'use strict';
// Namespace test ports only. Server responses remain explicit offline fixtures.
const fs = require('node:fs');
const path = require('node:path');
const workspace = '.';
const runtime = path.join(workspace, 'personal-ai-deskpet-electron-work/electron/minecraft-runtime');
const frozen = path.join(workspace, '.minecraft-local-test/evidence/estate-20261013/natural-xp-host-private-frozen-v2');
const read = name => fs.readFileSync(path.join(frozen, name), 'utf8');
const outputs = new Map();
let placement = read('deskpet-natural-xp-host-native-fixture-v2.cjs');
placement = placement.replace("const req=require('node:module').createRequire('./.minecraft-local-test/runtime-candidates/house-self17-coordinate-native-probe-20261014/package.json');", "const req=require('node:module').createRequire(require.resolve('../../package.json'));")
  .replace("const {createRenewableCactusProvider,findMatureNaturalColumns,planLoadedCactusSites,isOwnedRenewableCactusCancel}=require('./deskpet-natural-xp-host-v2.cjs').loadFrozen('renewable');\n", '')
  .replace("const {withHouseNativeSourceGuard}=req('./vendor/server/minecraft/houseNativeSourceGuard');\n", '')
  .replace("const test = require('node:test');\n", '').replace("const assert = require('node:assert/strict');\n", '')
  .replace('const point=p=>({x:p.x,y:p.y,z:p.z}),anchor={x:0,y:64,z:0},plant={x:0,y:64,z:1};', 'const point=p=>({x:p.x,y:p.y,z:p.z});');
outputs.set('test/fixtures/house-natural-xp-native.js', placement);
let enchant = read('deskpet-natural-xp-host-enchant-fixture-v2.cjs');
enchant = enchant.replace("const test=require('node:test'),assert=", 'const assert=')
  .replace("createRequire('./.minecraft-local-test/runtime-candidates/house-self17-coordinate-native-probe-20261014/package.json')", "createRequire(require.resolve('../../package.json'))")
  .replace("require('./deskpet-natural-xp-host-v2.cjs').loadFrozen('enchant')", "req('./vendor/server/minecraft/houseNaturalEnchant')");
outputs.set('test/fixtures/house-natural-xp-enchant.js', enchant);
let pool = read('deskpet-natural-xp-host-pool-fixture-v2.cjs');
pool = pool.replace("require('node:module').createRequire('./.minecraft-local-test/runtime-candidates/house-self17-coordinate-native-probe-20261014/package.json')", "require('node:module').createRequire(require.resolve('../../package.json'))")
  .replace("const test = require('node:test'), assert =", 'const assert =')
  .replace('createHouseXPFurnacePool, houseXPAtLevel, houseXPRemainingForPlanning', 'createHouseXPFurnacePool, houseXPAtLevel')
  .replace("require('./deskpet-natural-xp-host-v2.cjs').loadFrozen('pool')", "runtimeRequire('./vendor/server/minecraft/houseNaturalXPLevelProgressPool')")
  .replace("require('./deskpet-natural-xp-host-v2.cjs').loadFrozen('pool')", "runtimeRequire('./vendor/server/minecraft/houseNaturalXPLevelProgressPool')")
  .replace('createHouseNaturalXPProvider, isOwnedXPNativeCancel', 'isOwnedXPNativeCancel')
  .replace("require('./deskpet-natural-xp-host-v2.cjs').loadFrozen('provider')", "runtimeRequire('./vendor/server/minecraft/houseNaturalXPProvider')");
outputs.set('test/fixtures/house-natural-xp-pool.js', pool);
let tests = read('deskpet-natural-xp-host-v2.test.cjs');
tests = tests.replace("require('./deskpet-natural-xp-host-v2.cjs')", "require('../vendor/server/minecraft/houseNaturalXPHost')")
  .replace("require('./deskpet-natural-xp-host-native-fixture-v2.cjs')", "require('./fixtures/house-natural-xp-native')")
  .replace("require('./deskpet-natural-xp-host-enchant-fixture-v2.cjs')", "require('./fixtures/house-natural-xp-enchant')")
  .replace("require('./deskpet-natural-xp-host-pool-fixture-v2.cjs')", "require('./fixtures/house-natural-xp-pool')")
  .replace("require('./deskpet-natural-xp-stage-policy-v2.cjs')", "require('../vendor/server/minecraft/houseNaturalXPStagePolicy')");
const oldFirst = `test('PRIVATE loader pins immutable17 native deps and preserves four original candidate bytes', () => {
  for (const name of ['provider', 'pool', 'renewable', 'enchant']) assert.ok(Object.keys(host.loadFrozen(name)).length);
  assert.match(host.immutable, /house-self17-coordinate-native-probe/);
});`;
const newFirst = `test('relative native XP host exposes only guarded runtime APIs without private loaders', () => {
  assert.deepEqual(Object.keys(host).sort(), ['createNaturalHouseXPHost', 'getNaturalXPProtectedPositions', 'isOwnedNaturalHouseXPCancel'].sort());
  const fs = require('node:fs'), path = require('node:path');
  for (const name of ['houseNaturalXPHost', 'houseNaturalXPLevelProgressPool', 'houseNaturalXPStagePolicy', 'houseRenewableCactusProvider', 'houseNaturalEnchant']) {
    const source = fs.readFileSync(path.join(__dirname, '../vendor/server/minecraft', name + '.js'), 'utf8');
    assert.doesNotMatch(source, /Module\\._compile|createRequire|\\/private\\/tmp|\\/Volumes\\//);
  }
});`;
if (!tests.includes(oldFirst)) throw new Error('Original first native regression marker changed');
tests = tests.replace(oldFirst, newFirst).replace('/* global require, setTimeout */', '/* global require, setTimeout, __dirname */');
outputs.set('test/house-natural-xp-host.test.js', tests);
for (const [name] of outputs) if (fs.existsSync(path.join(runtime, name))) throw new Error(`New test namespace occupied: ${name}`);
for (const [name, source] of outputs) {
  if (/\/private\/tmp|\/Volumes\//.test(source)) throw new Error(`Absolute private dependency in new fixture/test: ${name}`);
  const file = path.join(runtime, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, source, { flag: 'wx' });
}
console.log(JSON.stringify({ ported: [...outputs.keys()], productionFilesChanged: false, javaStarted: false }));
