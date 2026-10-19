'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const folder = __dirname;
const parent = fs.readFileSync(path.join(folder, 'natural-public-building-acceptance-v4.cjs'), 'utf8');
const current = fs.readFileSync(path.join(folder, 'natural-public-building-acceptance-v5.cjs'), 'utf8');
const fragment = fs.readFileSync(path.join(folder, 'natural-public-dynamic-observer-v5-fragment.cjs'), 'utf8');
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const acorn = require('../electron/node_modules/acorn');
const ast = acorn.parse(current, { ecmaVersion: 'latest' });
const functionSource = name => { const n = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name); assert.ok(n); return current.slice(n.start, n.end); };
const api = vm.runInNewContext([functionSource('nativeMotionEvidence'), functionSource('goalEvidence'), functionSource('installDynamicObservers'), '({nativeMotionEvidence,installDynamicObservers})'].join('\n'), { position: p => p && ({ x: p.x, y: p.y, z: p.z }) });
const clone = v => JSON.parse(JSON.stringify(v));
const metadataBackToParent = s => s.replaceAll('observerRevision: 5', 'observerRevision: 4').replaceAll('observerRevision:5', 'observerRevision:4')
  .replaceAll('202407974ea7a9f0678c8b475afa866260c6b0cb56c83d8a778268a7a663fe8b', '006f13270394bce62970cd7eb3f90a5805d0fbad7a59e91c8d70ab48b7a4e5e0');
function fixture() {
  const bot = new EventEmitter(), client = new EventEmitter(), events = [];
  let writes = 0, motors = 0, requests = 0;
  bot._client = client; client.write = () => writes++;
  bot.entity = { position: { x: 1.5, y: 64, z: 2.5 }, velocity: { x: .1, y: .3332, z: 0 }, onGround: false, yaw: .6, pitch: -.1 };
  bot.controlState = { forward: true, back: false, left: false, right: false, jump: true, sprint: false, sneak: false };
  bot.jumpTicks = 3; bot.jumpQueued = true;
  bot.world = { chunks: { '0,0': { states: [1, 2, 3], height: 384 } } };
  bot.entities = {};
  class GoalBlock { constructor() { this.x = 8; this.y = 64; this.z = 0; } }
  bot.pathfinder = { goal: new GoalBlock(), goto: () => motors++, setMovements: () => motors++, setGoal: () => motors++ };
  bot.setControlState = () => motors++; bot.clearControlStates = () => motors++;
  bot.blockAt = () => requests++; bot.findBlocks = () => requests++;
  const state = () => hash({ entity: bot.entity, entities: bot.entities, controls: bot.controlState, jumpTicks: bot.jumpTicks, jumpQueued: bot.jumpQueued, world: bot.world, goal: bot.pathfinder.goal });
  const emit = (type, data) => events.push({ type, ...clone(data) });
  return { bot, client, events, emit, state, counters: () => ({ writes, motors, requests }) };
}
test('exact v5 field and metadata inverse restores every frozen v4 byte and preserves all non-observer functions', () => {
  assert.equal(hash(parent), '202407974ea7a9f0678c8b475afa866260c6b0cb56c83d8a778268a7a663fe8b');
  const reverted = metadataBackToParent(current).replace('creeperPosition: point(entity.position)', 'position: point(entity.position)');
  assert.equal(reverted, parent);
  assert.ok(current.includes(fragment + '\n'));
  const parentAST = acorn.parse(parent, { ecmaVersion: 'latest' });
  for (const n of parentAST.body.filter(n => n.type === 'FunctionDeclaration' && n.id.name !== 'installDynamicObservers')) {
    assert.equal(metadataBackToParent(functionSource(n.id.name)), parent.slice(n.start, n.end), 'Unchanged function ' + n.id.name);
  }
});
test('motion projection records yaw pitch seven controls and jumping, while UNKNOWN remains null', () => {
  const f = fixture(), before = f.state();
  assert.deepEqual(clone(api.nativeMotionEvidence(f.bot)), { yaw: .6, pitch: -.1, controls: f.bot.controlState, jumpTicks: 3, jumpQueued: true });
  assert.equal(f.state(), before);
  f.bot.entity.yaw = undefined; f.bot.controlState.jump = undefined; f.bot.jumpQueued = null;
  const unknown = api.nativeMotionEvidence(f.bot);
  assert.equal(unknown.yaw, null); assert.equal(unknown.controls.jump, null); assert.equal(unknown.jumpQueued, null);
  Object.defineProperty(f.bot.entity, 'pitch', { get() { throw Error('read only metadata fault'); } });
  assert.equal(api.nativeMotionEvidence(f.bot).pitch, null);
});
test('native path result copied at most64 coordinates without changing actor world controls path or APIs', () => {
  const f = fixture(), before = f.state(), goto = f.bot.pathfinder.goto, release = api.installDynamicObservers(f.bot, f.emit, () => true);
  const points = Array.from({ length: 90 }, (_, x) => Object.freeze({ x, y: 64, z: 0 }));
  Object.defineProperty(points, 64, { get() { throw Error('observer read beyond64'); } }); Object.freeze(points);
  const result = { status: 'partial', path: points }; Object.defineProperty(result, 'chunkData', { get() { throw Error('payload read'); } });
  f.bot.emit('path_update', result);
  const e = f.events[0]; assert.equal(e.type, 'native_path_update'); assert.equal(e.points.length, 64); assert.equal(e.pathLength, 90); assert.equal(e.pathTruncated, true); assert.equal(e.status, 'partial');
  assert.equal(e.nativeGoal.type, 'GoalBlock'); assert.equal(e.yaw, .6); assert.equal(e.controls.jump, true); assert.equal(e.duringExecution, true);
  e.points[0].x = 999; assert.equal(points[0].x, 0);
  assert.equal(f.state(), before); assert.equal(f.bot.pathfinder.goto, goto); assert.deepEqual(f.counters(), { writes: 0, motors: 0, requests: 0 });
  release();
});
test('path reset and actual reached goal preserve native actor state and never write controls', () => {
  const f = fixture(), before = f.state(), release = api.installDynamicObservers(f.bot, f.emit, () => false);
  f.bot.emit('path_reset', 'goal_updated'); f.bot.emit('goal_reached', f.bot.pathfinder.goal);
  assert.deepEqual(f.events.map(e => e.type), ['native_path_reset', 'native_goal_reached']);
  assert.equal(f.events[0].reason, 'goal_updated'); assert.equal(f.events[1].reachedGoal.x, 8); assert.equal(f.events[1].duringExecution, false);
  assert.equal(f.state(), before); assert.deepEqual(f.counters(), { writes: 0, motors: 0, requests: 0 }); release();
});
test('already present creepers and native movement/change events are captured once without other usernames', () => {
  const f = fixture(), creeper = { id: 2, name: 'creeper', isValid: true, position: { x: 3, y: 64, z: 2 } };
  const player = { id: 3, name: 'player' }; Object.defineProperty(player, 'username', { get() { throw Error('other username read'); } });
  f.bot.entities = { 2: creeper, 3: player }; const before = f.state(), release = api.installDynamicObservers(f.bot, f.emit, () => true);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].nativeOrigin, 'observer.install_existing_creepers');
  f.bot.emit('entityMoved', creeper); f.bot.emit('entitySpawn', player); assert.equal(f.events.length, 1);
  creeper.position = { x: 3.1, y: 64, z: 2 }; const movedBefore = f.state(); f.bot.emit('entityMoved', creeper);
  assert.equal(f.events.length, 2); assert.equal(f.events[1].type, 'native_creeper_moved'); assert.equal(f.state(), movedBefore);
  creeper.isValid = false; const goneBefore = f.state(); f.bot.emit('entityMoved', creeper); assert.equal(f.events.length, 3); f.bot.emit('entityGone', creeper); assert.equal(f.events.length, 4);
  assert.equal(f.events[3].isValid, false); assert.ok(f.events.every(e => !('username' in e))); assert.notEqual(goneBefore, before); assert.equal(f.state(), goneBefore); assert.deepEqual(f.counters(), { writes: 0, motors: 0, requests: 0 }); release();
});
test('observer faults remain passive and release leaves original independent listeners intact', () => {
  const f = fixture(); let native = 0;
  const release = api.installDynamicObservers(f.bot, () => { throw Error('sink error'); }, () => true);
  const independent = () => native++; f.bot.on('path_update', independent);
  assert.doesNotThrow(() => f.bot.emit('path_update', { status: 'success', path: [] })); assert.equal(native, 1);
  assert.doesNotThrow(release); assert.equal(f.bot.listeners('path_update').length, 1); assert.equal(f.bot.listeners('path_update')[0], independent);
  f.bot.emit('path_update', {}); assert.equal(native, 2); assert.deepEqual(f.counters(), { writes: 0, motors: 0, requests: 0 });
});
test('release handles one removal failure without skipping the other listener detachments', () => {
  const f = fixture(), release = api.installDynamicObservers(f.bot, f.emit, () => true), remove = f.bot.removeListener.bind(f.bot);
  f.bot.removeListener = (event, listener) => { if (event === 'path_update') throw Error('detach fault'); return remove(event, listener); };
  assert.doesNotThrow(release); for (const event of ['path_reset', 'goal_reached', 'entitySpawn', 'entityMoved', 'entityGone']) assert.equal(f.bot.listenerCount(event), 0);
});
test('one observer installation failure remains passive and other native events still attach', () => {
  const f = fixture(), on = f.bot.on.bind(f.bot), before = f.state();
  f.bot.on = (event, listener) => { if (event === 'path_update') throw Error('listener registration fault'); return on(event, listener); };
  let release; assert.doesNotThrow(() => { release = api.installDynamicObservers(f.bot, f.emit, () => true); });
  assert.equal(f.events[0].type, 'dynamic_observation_error');
  f.bot.emit('path_reset', 'goal_updated'); assert.equal(f.events.at(-1).type, 'native_path_reset');
  assert.equal(f.state(), before); assert.deepEqual(f.counters(), { writes: 0, motors: 0, requests: 0 }); assert.doesNotThrow(release);
});
test('observer AST has no native motor/world API calls or native-object assignments', () => {
  const forbidden = new Set(['write', 'goto', 'setGoal', 'setMovements', 'setControlState', 'clearControlStates', 'dig', 'craft', 'apply', 'simulatePlayer', 'setBlock', 'setColumn', 'getColumn', 'blockAt', 'findBlocks', 'getPathTo', 'shift', 'splice', 'sort']);
  function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression') assert.equal(forbidden.has(n.callee.property.name), false, n.callee.property.name);
    if (n.type === 'AssignmentExpression') assert.notEqual(n.left.type, 'MemberExpression', 'Observer native/packet member mutation');
    if (n.type === 'UnaryExpression' && n.operator === 'delete') throw Error('Native property deletion');
    for (const value of Object.values(n)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value);
  }
  for (const name of ['nativeMotionEvidence', 'installDynamicObservers']) walk(ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name));
});

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
