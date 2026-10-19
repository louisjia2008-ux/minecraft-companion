'use strict';
// New observer revision only. Frozen v4 and every runtime/world file are read-only inputs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const folder = 'acceptance';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const parentFile = path.join(folder, 'natural-public-building-acceptance-v4.cjs');
const parent = fs.readFileSync(parentFile, 'utf8');
const parentSHA256 = '202407974ea7a9f0678c8b475afa866260c6b0cb56c83d8a778268a7a663fe8b';
if (sha(parent) !== parentSHA256) throw new Error('Exact v4 source changed');
const oldFragment = fs.readFileSync(path.join(folder, 'natural-public-dynamic-observer-v4-fragment.cjs'), 'utf8');
const oldValue = "isValid: typeof entity.isValid === 'boolean' ? entity.isValid : null, position: point(entity.position)";
const newValue = "isValid: typeof entity.isValid === 'boolean' ? entity.isValid : null, creeperPosition: point(entity.position)";
if (oldFragment.split(oldValue).length !== 2 || parent.split(oldValue).length !== 2) throw new Error('Creeper projection marker changed');
const fragment = oldFragment.replace(oldValue, newValue);
const runner = parent.replace(oldValue, newValue).replaceAll('observerRevision: 4', 'observerRevision: 5').replaceAll('observerRevision:4', 'observerRevision:5')
  .replaceAll('006f13270394bce62970cd7eb3f90a5805d0fbad7a59e91c8d70ab48b7a4e5e0', parentSHA256);
const reverse = runner.replace(newValue, oldValue).replaceAll('observerRevision: 5', 'observerRevision: 4').replaceAll('observerRevision:5', 'observerRevision:4')
  .replaceAll(parentSHA256, '006f13270394bce62970cd7eb3f90a5805d0fbad7a59e91c8d70ab48b7a4e5e0');
if (reverse !== parent) throw new Error('Exact reverse field/metadata transform failed');
let tests = fs.readFileSync(path.join(folder, 'natural-public-dynamic-observer-v4.test.cjs'), 'utf8');
tests = tests.replaceAll('natural-public-building-acceptance-v4.cjs', 'natural-public-building-acceptance-v5.cjs')
  .replaceAll('natural-public-building-acceptance-v3.cjs', 'natural-public-building-acceptance-v4.cjs')
  .replaceAll('natural-public-dynamic-observer-v4-fragment.cjs', 'natural-public-dynamic-observer-v5-fragment.cjs');
tests = tests.replace(/\bv3\b/g, 'parent').replace(/\bv4\b/g, 'current');
tests = tests.replace('natural-public-building-acceptance-current.cjs', 'natural-public-building-acceptance-v4.cjs');
const beginMetadata = tests.indexOf('const metadataBackToParent = '), endMetadata = tests.indexOf('function fixture()', beginMetadata);
tests = tests.slice(0, beginMetadata) + `const metadataBackToParent = s => s.replaceAll('observerRevision: 5', 'observerRevision: 4').replaceAll('observerRevision:5', 'observerRevision:4')
  .replaceAll('${parentSHA256}', '006f13270394bce62970cd7eb3f90a5805d0fbad7a59e91c8d70ab48b7a4e5e0');
` + tests.slice(endMetadata);
const beginFirst = tests.indexOf("test('original "), endFirst = tests.indexOf("test('motion projection", beginFirst);
tests = tests.slice(0, beginFirst) + `test('exact v5 field and metadata inverse restores every frozen v4 byte and preserves all non-observer functions', () => {
  assert.equal(hash(parent), '${parentSHA256}');
  const reverted = metadataBackToParent(current).replace('creeperPosition: point(entity.position)', 'position: point(entity.position)');
  assert.equal(reverted, parent);
  assert.ok(current.includes(fragment + '\\n'));
  const parentAST = acorn.parse(parent, { ecmaVersion: 'latest' });
  for (const n of parentAST.body.filter(n => n.type === 'FunctionDeclaration' && n.id.name !== 'installDynamicObservers')) {
    assert.equal(metadataBackToParent(functionSource(n.id.name)), parent.slice(n.start, n.end), 'Unchanged function ' + n.id.name);
  }
});
` + tests.slice(endFirst);
tests += `
test('distinct actual actor and initial creeper coordinates retain separate namespaces without mutation', () => {
  const f = fixture(), creeper = { id: 9, name: 'creeper', isValid: true, position: { x: 103, y: 65, z: -8 } };
  f.bot.entities = { 9: creeper }; const before = f.state(), release = api.installDynamicObservers(f.bot, f.emit, () => true);
  assert.equal(f.events.length, 1); const e = f.events[0];
  assert.equal(e.nativeOrigin, 'observer.install_existing_creepers');
  assert.deepEqual(e.position, f.bot.entity.position); assert.deepEqual(e.creeperPosition, creeper.position);
  assert.notDeepEqual(e.position, e.creeperPosition); assert.equal(e.entityId, 9); assert.equal(e.isValid, true);
  assert.equal(f.state(), before); assert.deepEqual(f.counters(), { writes: 0, motors: 0, requests: 0 }); release();
});
test('moving only the creeper records changed actual creeper coordinates with unchanged actor frame', () => {
  const f = fixture(), creeper = { id: 10, name: 'creeper', isValid: true, position: { x: 103, y: 65, z: -8 } };
  const release = api.installDynamicObservers(f.bot, f.emit, () => true); f.bot.emit('entitySpawn', creeper);
  const actorBefore = clone(f.bot.entity); creeper.position = { x: 104, y: 65, z: -8 }; const before = f.state();
  f.bot.emit('entityMoved', creeper); assert.equal(f.events.length, 2);
  assert.deepEqual(f.events[1].creeperPosition, creeper.position); assert.deepEqual(f.events[1].position, actorBefore.position);
  assert.deepEqual(f.bot.entity, actorBefore); assert.equal(f.state(), before); assert.deepEqual(f.counters(), { writes: 0, motors: 0, requests: 0 }); release();
});
test('moving only the actor does not manufacture an unchanged creeper movement or duplicate spawn', () => {
  const f = fixture(), creeper = { id: 11, name: 'creeper', isValid: true, position: { x: 103, y: 65, z: -8 } };
  const release = api.installDynamicObservers(f.bot, f.emit, () => true); f.bot.emit('entitySpawn', creeper);
  f.bot.entity.position = { x: 9.5, y: 64, z: 2.5 }; const before = f.state();
  f.bot.emit('entityMoved', creeper); f.bot.emit('entitySpawn', creeper); assert.equal(f.events.length, 1);
  assert.equal(f.state(), before); assert.deepEqual(f.counters(), { writes: 0, motors: 0, requests: 0 }); release();
});
test('gone creeper records actual last position and validity independently of current actor location', () => {
  const f = fixture(), creeper = { id: 12, name: 'creeper', isValid: true, position: { x: 103, y: 65, z: -8 } };
  const release = api.installDynamicObservers(f.bot, f.emit, () => true); f.bot.emit('entitySpawn', creeper);
  f.bot.entity.position = { x: 20.5, y: 63, z: -4 }; creeper.position = { x: 105, y: 65, z: -8 }; creeper.isValid = false;
  const before = f.state(); f.bot.emit('entityGone', creeper); const e = f.events.at(-1);
  assert.equal(e.type, 'native_creeper_gone'); assert.equal(e.isValid, false); assert.deepEqual(e.creeperPosition, creeper.position);
  assert.deepEqual(e.position, f.bot.entity.position); assert.equal(f.state(), before); assert.deepEqual(f.counters(), { writes: 0, motors: 0, requests: 0 }); release();
});
test('null unknown creeper position does not borrow actor coordinates and stays null on Gone', () => {
  const f = fixture(), creeper = { id: 13, name: 'creeper', isValid: undefined, position: null };
  const before = f.state(), release = api.installDynamicObservers(f.bot, f.emit, () => true);
  f.bot.emit('entitySpawn', creeper); const first = f.events[0];
  assert.equal(first.creeperPosition, null); assert.equal(first.isValid, null); assert.deepEqual(first.position, f.bot.entity.position);
  f.bot.emit('entityMoved', creeper); assert.equal(f.events.length, 1); f.bot.emit('entityGone', creeper);
  assert.equal(f.events[1].creeperPosition, null); assert.deepEqual(f.events[1].position, f.bot.entity.position);
  assert.equal(f.state(), before); assert.deepEqual(f.counters(), { writes: 0, motors: 0, requests: 0 }); release();
});
test('null actor position cannot overwrite a distinct loaded creeper position', () => {
  const f = fixture(), creeper = { id: 14, name: 'creeper', isValid: true, position: { x: 103, y: 65, z: -8 } };
  f.bot.entity.position = null; const before = f.state(), release = api.installDynamicObservers(f.bot, f.emit, () => true);
  f.bot.emit('entitySpawn', creeper); assert.equal(f.events[0].position, null); assert.deepEqual(f.events[0].creeperPosition, creeper.position);
  assert.equal(f.state(), before); assert.deepEqual(f.counters(), { writes: 0, motors: 0, requests: 0 }); release();
});
`;
const outputs = [['natural-public-building-acceptance-v5.cjs', runner], ['natural-public-dynamic-observer-v5-fragment.cjs', fragment], ['natural-public-dynamic-observer-v5.test.cjs', tests]];
for (const [name] of outputs) if (fs.existsSync(path.join(folder, name))) throw new Error(`New v5 namespace occupied: ${name}`);
for (const [name, bytes] of outputs) fs.writeFileSync(path.join(folder, name), bytes, { flag: 'wx' });
console.log(JSON.stringify({ files: outputs.map(([name, bytes]) => ({ name, sha256: sha(bytes) })), exactInverseV4: true, javaStarted: false, runtimeOrWorldModified: false }));
