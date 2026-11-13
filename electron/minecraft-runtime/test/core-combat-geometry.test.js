'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { entityDimensions, meleeGeometry, meleeSight, MeleeFollowGoal, installEntityGeometry } = require('../core/entityGeometry');
const filename = require.resolve('../core/actions');
const localRequire = createRequire(filename);
const registry = { entitiesByName: { magma_cube: { width: .52, height: .52, metadataKeys: ['health', 'size'] },
  slime: { width: .52, height: .52, metadataKeys: ['size'] } } };
const cube = (x = 3.8, y = 0, size = 4) => ({ id: 7, name: 'magma_cube', isValid: true, position: new Vec3(x, y, 0), width: .52, height: .52, metadata: [16, size] });
function actionFixture({ target = cube(), blocked = false, unknown = false, cancelOnLook = false, moveOnLook = false, cancelOnSleep = false } = {}) {
  const clock = { now: 1000 };
  const signal = new AbortController();
  const bot = new EventEmitter();
  const sword = { name: 'iron_sword', count: 1 };
  const counts = { attacks: 0, raycasts: 0, controlsCleared: 0, goals: [], records: [] };
  Object.assign(bot, { registry, entity: { position: new Vec3(0, 0, 0), eyeHeight: 1.62, width: .6, height: 1.8, onGround: true },
    entities: { 7: target }, inventory: { items: () => [sword], slots: [] }, heldItem: sword,
    pathfinder: { goal: null, setGoal(goal) { this.goal = goal; if (goal) counts.goals.push(goal); } },
    blockAt: () => unknown ? null : { name: 'air', boundingBox: 'empty' },
    world: { raycast() { counts.raycasts += 1; return blocked ? { name: 'basalt' } : null; } },
    equip: async () => {}, lookAt: async () => { if (cancelOnLook) signal.abort('during_look'); if (moveOnLook) target.position.x = 12; },
    attack: () => { counts.attacks += 1; bot.emit('entityDead', target); delete bot.entities[7]; },
    clearControlStates: () => { counts.controlsCleared += 1; }, setControlState: () => {} });
  const confirm = localRequire('./confirm');
  const fakeRequire = (name) => name === './confirm' ? { ...confirm, sleep: async (ms, current) => {
    if (current?.aborted) throw confirm.abortError(current);
    clock.now += ms;
    if (cancelOnSleep) signal.abort('fixture_cancel');
    if (current?.aborted) throw confirm.abortError(current);
  } } : localRequire(name);
  const context = vm.createContext({ Date: { now: () => clock.now }, setTimeout, clearTimeout, setInterval, clearInterval });
  const module = { exports: {} };
  const fn = new vm.Script('(function(require,module,exports){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename }).runInContext(context);
  fn(fakeRequire, module, module.exports);
  return { bot, target, signal, counts, attack: (options) => module.exports.attack(bot, { signal: signal.signal, record: (name, data) => counts.records.push({ name, ...data }) }, 7, options) };
}

test('wide magma in actual eye-to-AABB reach attacks rather than chasing feet until stuck', async () => {
  const f = actionFixture();
  const result = await f.attack();
  assert.equal(result.ok, true);
  assert.equal(f.counts.attacks, 1);
  assert.equal(f.counts.goals.length, 0);
});

test('airborne small cube in eye-to-AABB reach attacks while feet separation exceeds three', async () => {
  const f = actionFixture({ target: cube(2.9, 1, 1) });
  assert.ok(f.target.position.distanceTo(f.bot.entity.position) > 3);
  assert.equal((await f.attack()).ok, true);
  assert.equal(f.counts.attacks, 1);
});

test('a wall or unobserved ray segment cannot authorize an attack', async () => {
  for (const options of [{ blocked: true }, { unknown: true }]) {
    const f = actionFixture({ ...options, target: cube(2, 0, 1) });
    assert.equal((await f.attack({ timeoutMs: 1000 })).ok, false);
    assert.equal(f.counts.attacks, 0);
    assert.equal(f.bot.pathfinder.goal, null);
  }
});

test('abort during aiming and a target moving out of reach never send a stale attack', async () => {
  const cancelled = actionFixture({ target: cube(2, 0, 1), cancelOnLook: true });
  await assert.rejects(cancelled.attack(), { code: 'aborted' });
  assert.equal(cancelled.counts.attacks, 0);
  assert.equal(cancelled.bot.listenerCount('entityDead'), 0);
  assert.equal(cancelled.bot.pathfinder.goal, null);
  const moved = actionFixture({ target: cube(2, 0, 1), moveOnLook: true });
  assert.equal((await moved.attack({ timeoutMs: 1000 })).ok, false);
  assert.equal(moved.counts.attacks, 0);
});

test('stationary melee attacks in reach and never follows a target that leaves reach during aim', async () => {
  const reachable = actionFixture({ target: cube(2, 0, 1) });
  assert.equal((await reachable.attack({ pursue: false })).died, true);
  assert.equal(reachable.counts.attacks, 1);
  assert.deepEqual(reachable.counts.goals, []);
  const moved = actionFixture({ target: cube(2, 0, 1), moveOnLook: true });
  assert.equal((await moved.attack({ pursue: false })).reason, 'target_outside_stationary_reach');
  assert.equal(moved.counts.attacks, 0);
  assert.deepEqual(moved.counts.goals, []);
});

test('confirmed death stops attacks while the corpse is still valid and tracked', async () => {
  const f = actionFixture();
  f.bot.attack = () => { f.counts.attacks += 1; f.bot.emit('entityDead', f.target); };
  const result = await f.attack({ timeoutMs: 500 });
  assert.equal(result.ok, true);
  assert.equal(result.died, true);
  assert.equal(result.hits, 1);
  assert.equal(f.counts.attacks, 1);
  assert.equal(f.bot.entities[7], f.target);
  assert.equal(f.target.isValid, true);
  assert.equal(f.counts.goals.length, 0);
  assert.equal(f.bot.listenerCount('entityDead'), 0);
  assert.equal(f.bot.pathfinder.goal, null);
  assert.ok(f.counts.controlsCleared > 0);
});

test('confirmed death during aiming sends no attack at a still-valid corpse', async () => {
  const f = actionFixture();
  f.bot.lookAt = async () => { f.bot.emit('entityDead', f.target); };
  const result = await f.attack();
  assert.equal(result.ok, true);
  assert.equal(result.died, true);
  assert.equal(result.hits, 0);
  assert.equal(f.counts.attacks, 0);
  assert.equal(f.bot.entities[7], f.target);
  assert.equal(f.target.isValid, true);
  assert.equal(f.bot.listenerCount('entityDead'), 0);
  assert.equal(f.bot.pathfinder.goal, null);
  assert.ok(f.counts.controlsCleared > 0);
});

test('cancellation during aiming retains precedence over a confirmed target death', async () => {
  const f = actionFixture();
  f.bot.lookAt = async () => { f.bot.emit('entityDead', f.target); f.signal.abort('cancel_after_death'); };
  await assert.rejects(f.attack(), { code: 'aborted' });
  assert.equal(f.counts.attacks, 0);
  assert.equal(f.bot.listenerCount('entityDead'), 0);
  assert.equal(f.bot.pathfinder.goal, null);
  assert.ok(f.counts.controlsCleared > 0);
});

test('confirmed death during the optional safe-sweep jump sends no corpse attack', async () => {
  const f = actionFixture({ target: cube(2, 0, 1) });
  f.bot.entities[8] = { name: 'zombified_piglin', position: new Vec3(2.5, 0, 0) };
  f.bot.setControlState = (control, value) => {
    if (control !== 'jump' || !value) return;
    f.bot.entity.onGround = false;
    f.bot.entity.velocity = new Vec3(0, -.1, 0);
    queueMicrotask(() => f.bot.emit('entityDead', f.target));
  };
  const result = await f.attack();
  assert.equal(result.ok, true);
  assert.equal(result.died, true);
  assert.equal(result.hits, 0);
  assert.equal(f.counts.attacks, 0);
  assert.equal(f.bot.entities[7], f.target);
  assert.equal(f.bot.listenerCount('entityDead'), 0);
  assert.equal(f.bot.pathfinder.goal, null);
  assert.ok(f.counts.controlsCleared > 0);
});

test('chase abort releases controls, goal and death listener', async () => {
  const f = actionFixture({ target: cube(8), cancelOnSleep: true });
  await assert.rejects(f.attack(), { code: 'aborted' });
  assert.equal(f.bot.pathfinder.goal, null);
  assert.equal(f.bot.listenerCount('entityDead'), 0);
  assert.ok(f.counts.controlsCleared > 0);
});

test('named size metadata scales registry dimensions once and never guesses an index', () => {
  const e = cube();
  assert.deepEqual(entityDimensions(e, registry), { width: 2.08, height: 2.08, size: 4 });
  e.width = e.height = 2.08;
  assert.equal(entityDimensions(e, registry).width, 2.08);
  assert.equal(entityDimensions(e, { entitiesByName: { magma_cube: { width: .52, height: .52 } } }), null);
  for (const size of [undefined, 0, -1, 128, 1.5, NaN, '4']) {
    e.metadata[1] = size;
    assert.equal(entityDimensions(e, registry), null);
  }
});

const pairedRegistry = { ...registry, version: { minecraftVersion: '1.21.8' } };
const initialAttributes = () => ({ 'generic.max_health': { value: 1, modifiers: [] }, 'generic.armor': { value: 3, modifiers: [] } });

test('vanilla default size omitted from metadata is known only after initial sync attributes', () => {
  const e = { ...cube(), metadata: [] };
  assert.equal(entityDimensions(e, pairedRegistry), null, 'spawn alone cannot shrink an unsynchronized large cube');
  e.attributes = {};
  assert.equal(entityDimensions(e, pairedRegistry), null, 'empty attributes are not a received nonempty living sync packet');
  e.attributes = initialAttributes();
  assert.deepEqual(entityDimensions(e, pairedRegistry), { width: .52, height: .52, size: 1 });
});

test('sparse default proof does not override explicit invalid size or guess across versions', () => {
  const e = { ...cube(), metadata: [], attributes: initialAttributes() };
  assert.equal(entityDimensions(e, { ...pairedRegistry, version: { minecraftVersion: '1.21.7' } }), null);
  for (const value of [undefined, null, 0, -1, 128, 1.5, '1']) {
    e.metadata[1] = value;
    assert.equal(entityDimensions(e, pairedRegistry), null);
  }
  delete e.metadata[1];
  e.attributes = { malformed: { value: NaN, modifiers: [] } };
  assert.equal(entityDimensions(e, pairedRegistry), null);
});

test('preexisting complete sparse cube is normalized when the companion geometry owner starts', () => {
  const e = { ...cube(), width: 2.08, height: 2.08, metadata: [], attributes: initialAttributes() };
  const bot = Object.assign(new EventEmitter(), { registry: pairedRegistry, entities: { 7: e } });
  const cleanup = installEntityGeometry(bot);
  assert.equal(e.width, .52);
  assert.equal(e.height, .52);
  cleanup();
});

test('initial attributes complete a newly spawned sparse cube and later explicit large size still wins', () => {
  const e = { ...cube(), metadata: [] };
  const bot = Object.assign(new EventEmitter(), { registry: pairedRegistry, entities: { 7: e } });
  const cleanup = installEntityGeometry(bot);
  bot.emit('entitySpawn', e);
  assert.equal(entityDimensions(e, pairedRegistry), null);
  e.attributes = initialAttributes(); bot.emit('entityAttributes', e);
  assert.deepEqual(entityDimensions(e, pairedRegistry), { width: .52, height: .52, size: 1 });
  e.width = e.height = 2.08;
  bot.emit('entityAttributes', e);
  assert.equal(e.width, .52);
  e.metadata[1] = 4; bot.emit('entityUpdate', e);
  assert.equal(e.width, 2.08);
  cleanup();
  assert.equal(bot.listenerCount('entityAttributes'), 0);
  e.width = 9; bot.emit('entityAttributes', e);
  assert.equal(e.width, 9, 'disposed geometry owner cannot mutate native dimensions');
});

test('a paired default-small cube is fought by the real action instead of rejected as unknown', async () => {
  const f = actionFixture({ target: { ...cube(2), metadata: [], attributes: initialAttributes() } });
  f.bot.registry = pairedRegistry;
  assert.equal((await f.attack()).ok, true);
  assert.equal(f.counts.attacks, 1);
});

test('unknown geometry records target identity, sparse metadata and initial-sync evidence without attacking', async () => {
  const f = actionFixture({ target: { ...cube(2), metadata: [] } });
  f.bot.registry = pairedRegistry;
  assert.equal((await f.attack()).reason, 'unknown_target_geometry');
  assert.equal(f.counts.attacks, 0);
  const record = f.counts.records.find((row) => row.name === 'combat_geometry_unknown');
  assert.ok(record);
  assert.equal(record.targetId, 7);
  assert.equal(record.mob, 'magma_cube');
  assert.equal(record.evidence.sizePresent, false);
  assert.equal(record.evidence.initialSyncComplete, false);
  assert.equal(record.evidence.source, 'awaiting_initial_sync');
});

test('native dimensions track observed spawn/update size and hooks unsubscribe without changing poses', () => {
  const bot = Object.assign(new EventEmitter(), { registry, entities: {} });
  const e = cube();
  bot.entities[7] = e;
  const position = e.position;
  const cleanup = installEntityGeometry(bot);
  assert.equal(e.width, 2.08);
  e.metadata[1] = 2; bot.emit('entityUpdate', e);
  assert.equal(e.width, 1.04);
  const slime = { ...cube(), name: 'slime', metadata: [4], position: new Vec3(1, 2, 3) };
  bot.emit('entitySpawn', slime); assert.equal(slime.width, 2.08);
  cleanup(); cleanup();
  assert.equal(bot.listenerCount('entitySpawn'), 0);
  assert.equal(bot.listenerCount('entityUpdate'), 0);
  e.metadata[1] = 4; bot.emit('entityUpdate', e); assert.equal(e.width, 1.04);
  assert.equal(e.position, position);
});

test('large-body chase endpoints stop outside collision volume at a clear reachable stance', () => {
  const f = actionFixture({ target: cube(0) });
  const goal = new MeleeFollowGoal(f.bot, f.target, 3);
  assert.equal(goal.isEnd({ x: 0, y: 0, z: 0 }), false);
  assert.equal(goal.isEnd({ x: 2, y: 0, z: 0 }), true);
  f.target.metadata[1] = 2;
  assert.equal(goal.hasChanged(), true);
});

test('unknown geometry and missing raycast fail closed without granting reach', () => {
  const f = actionFixture();
  assert.equal(meleeGeometry(f.bot.entity, { ...f.target, position: new Vec3(NaN, 0, 0) }, registry), null);
  const geometry = meleeGeometry(f.bot.entity, f.target, registry);
  assert.equal(meleeSight({ blockAt: f.bot.blockAt }, geometry), 'unknown');
  assert.equal(meleeSight(f.bot, { ...geometry, distance: Infinity }), 'unknown');
  assert.equal(meleeSight(f.bot, { ...geometry, point: new Vec3(NaN, 0, 0) }), 'unknown');
  assert.equal(meleeSight({ ...f.bot, blockAt: () => null }, { ...geometry, point: geometry.eye, distance: 0 }), 'unknown');
});

test('a short missing-column corner crossing cannot hide between sightline samples', () => {
  const eye = new Vec3(15.49, 1.62, 15.49);
  const point = new Vec3(17.49, 1.62, 17.48);
  const bot = { blockAt: (p) => p.x >= 16 && p.x < 32 && p.z < 16 ? null : { name: 'air', boundingBox: 'empty' },
    world: { raycast: () => null } };
  assert.equal(meleeSight(bot, { eye, point, distance: eye.distanceTo(point) }), 'unknown');
});
