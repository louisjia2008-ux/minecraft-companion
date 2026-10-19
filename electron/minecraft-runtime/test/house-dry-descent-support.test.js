/* global require */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Physics, PlayerState } = require('prismarine-physics');
const { Vec3 } = require('vec3');
const { data, createSavedDescentFixture } = require('../test-support/whole05-saved-dry-descent.cjs');
const { inspectDryDescentSupport, inspectSurfaceBody, inspectShoreSupport, hasGroundedBodySupport } = require('../vendor/server/minecraft/houseSurfaceGraph');

// The MCA geometry and airborne p/v are real stopped-world observations.
// Controls/yaw are explicit scenario inputs: the historical values are UNKNOWN.
// Only initial fixture setup changes actor state. The production helper and
// independent native predictions never apply a PlayerState or move a real bot.
const clone = value => JSON.parse(JSON.stringify(value));
const options = () => ({ tick: data.physicsTick, lastGrounded: clone(data.lastGrounded) });
const inspect = (f, overrides = {}) => inspectDryDescentSupport(f.bot, { ...options(), ...overrides });
const floorCell = { x: 59, y: 64, z: -285 };
const oldFloor = data.lastGrounded.contacts[0].position;
const at = (p, target) => ['x', 'y', 'z'].every(axis => p[axis] === target[axis]);
function replaceCells(f, predicate, value) {
  const original = f.bot.blockAt;
  const Block = require('prismarine-block')(f.bot.registry);
  f.bot.blockAt = raw => {
    const p = raw.floored();
    if (!predicate(p)) return original(p);
    if (value === null) return null;
    const spec = typeof value === 'string' ? { name: value, properties: {} } : value;
    return Object.assign(Block.fromProperties(f.bot.registry.blocksByName[spec.name].id, spec.properties, 0), { position: p });
  };
}
function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

test('actual whole05 airborne edge needs one native tick to land on the same real sand shape', () => {
  const f = createSavedDescentFixture(), before = clone({ entity: f.bot.entity, controls: f.controls });
  assert.equal(data.actualControls, 'UNKNOWN');
  assert.equal(data.actualYaw, 'UNKNOWN');
  assert.equal(inspectSurfaceBody(f.bot).dry, true);
  assert.equal(hasGroundedBodySupport(f.bot), false);
  assert.equal(inspectShoreSupport(f.bot, options()).accepted, false);
  for (const down of [1, 2]) assert.equal(f.bot.blockAt(f.bot.entity.position.floored().offset(0, -down, 0)).name, 'air');
  const result = inspect(f);
  assert.equal(result.accepted, true);
  assert.equal(result.predictionApplied, false);
  assert.equal(result.actualGrounded, false);
  assert.equal(result.predictions.length, 1);
  assert.equal(result.predictions[0].sameFloor, true);
  assert.equal(result.predictions[0].onGround, true);
  assert.equal(result.predictions[0].bodyDry, true);
  assert.equal(result.predictions[0].position.y, 65);
  assert.ok(result.supports.some(s => at(s.position, floorCell) && s.top === 65));
  assert.deepEqual(clone({ entity: f.bot.entity, controls: f.controls }), before);
  assert.equal(f.bot.entity.onGround, false, 'a prediction never gives actual grounded credit');

  const state = new PlayerState(f.bot, clone(f.controls));
  state.attributes = clone(state.attributes);
  Physics(f.bot.registry, f.world).simulatePlayer(state, f.world);
  assert.equal(state.onGround, true);
  assert.equal(state.isInWater, false);
  assert.equal(state.isInLava, false);
  assert.deepEqual({ ...state.pos }, result.predictions[0].position);
  assert.deepEqual(clone({ entity: f.bot.entity, controls: f.controls }), before);
});

test('saved airborne pose lands across 576 explicit native input scenarios without claiming historical controls', () => {
  let scenarios = 0;
  for (let turn = 0; turn < 8; turn++) for (const horizontal of [{}, { forward: true }, { back: true }, { left: true }, { right: true },
    { forward: true, left: true }, { forward: true, right: true }, { back: true, left: true }, { back: true, right: true }]) {
    for (const jump of [false, true]) for (const sneak of [false, true]) for (const sprint of [false, true]) {
      const f = createSavedDescentFixture({ yaw: turn * Math.PI / 4, controls: { ...horizontal, jump, sneak, sprint } });
      const before = clone({ entity: f.bot.entity, controls: f.controls });
      const result = inspect(f);
      assert.equal(result.accepted, true, `scenario ${scenarios}`);
      assert.equal(result.predictions[0].tick, 1);
      assert.equal(result.predictions[0].sameFloor, true);
      assert.deepEqual(clone({ entity: f.bot.entity, controls: f.controls }), before);
      scenarios++;
    }
  }
  assert.equal(scenarios, 576);
});

for (const [label, change] of [
  ['missing recent contact', o => { o.lastGrounded = null; }],
  ['expired contact', o => { o.tick = data.lastGrounded.tick + 9; }],
  ['future contact', o => { o.tick = data.lastGrounded.tick - 1; }],
  ['far contact', o => { o.lastGrounded.position.x += 2; }],
  ['drop greater than one step', o => { o.lastGrounded.position.y = data.initial.position.y + 1.051; }],
  ['feet higher than recent ground', o => { o.lastGrounded.position.y = data.initial.position.y - .01; }],
]) test(`${label} cannot authorize a dry airborne edge`, () => {
  const f = createSavedDescentFixture(), opts = options(); change(opts);
  const result = inspectDryDescentSupport(f.bot, opts);
  assert.equal(result.accepted, false);
  assert.equal(result.predictions.length, 0);
});

for (const [label, velocity] of [
  ['ascending', { y: .001 }], ['fast downward', { y: -.501 }],
  ['fast horizontal', { x: .251, z: 0 }], ['non-finite', { x: NaN }],
]) test(`${label} velocity fails closed before native prediction`, () => {
  const f = createSavedDescentFixture(); Object.assign(f.bot.entity.velocity, velocity);
  const result = inspect(f);
  assert.equal(result.accepted, false);
  assert.equal(result.predictions.length, 0);
});

test('unknown controls, yaw, actual fluid flags or already grounded state cannot borrow descent prediction', () => {
  for (const setup of [f => { delete f.controls.forward; }, f => { f.bot.entity.yaw = NaN; },
    f => { f.bot.entity.isInWater = true; }, f => { f.bot.entity.isInLava = true; }, f => { f.bot.entity.onGround = true; }]) {
    const f = createSavedDescentFixture(); setup(f);
    assert.equal(inspect(f).accepted, false);
  }
});

for (const value of [null, 'water', 'lava', 'stone']) test(`center below air must stay loaded AIR (${value})`, () => {
  const f = createSavedDescentFixture(), center = f.bot.entity.position.floored().offset(0, -1, 0);
  replaceCells(f, p => at(p, center), value);
  assert.equal(inspect(f).accepted, false);
});

test('changed or removed last actual support cannot authorize a new descent', () => {
  for (const value of [null, 'air', 'stone', 'water']) {
    const f = createSavedDescentFixture(); replaceCells(f, p => at(p, oldFloor), value);
    const result = inspect(f);
    assert.equal(result.accepted, false);
    assert.equal(result.predictions.length, 0);
  }
});

test('lower landing must be a loaded full cube; vanished, fluid or top slab is rejected', () => {
  for (const value of [null, 'air', 'water', 'lava', { name: 'oak_slab', properties: { type: 'top', waterlogged: false } }]) {
    const f = createSavedDescentFixture(); replaceCells(f, p => at(p, floorCell), value);
    const result = inspect(f);
    assert.equal(result.accepted, false);
    assert.equal(result.predictions.length, 0);
  }
});

test('native lookahead rejects newly entered UNKNOWN, source water or lava beyond current AABB', () => {
  for (const value of [null, 'water', 'lava']) {
    const f = createSavedDescentFixture(); f.bot.entity.velocity.x = -.23;
    replaceCells(f, p => p.x === 58 && p.y === 65, value);
    assert.equal(inspectSurfaceBody(f.bot).dry, true, 'current body still has entirely loaded dry air');
    const result = inspect(f);
    assert.ok(result.supports.length > 0, 'current projected safe lower shape exists');
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'dry_descent_unknown_or_hazard');
  }
});

test('two native ticks without actual shape contact stay unconfirmed', () => {
  const f = createSavedDescentFixture(); f.bot.entity.velocity.y = 0;
  const result = inspect(f);
  assert.equal(result.accepted, false);
  assert.equal(result.predictions.length, 2);
  assert.ok(result.predictions.every(p => !p.onGround && !p.sameFloor));
  assert.equal(f.bot.entity.onGround, false);
});

test('frozen nonempty attributes, metadata, actor position and controls remain immutable', () => {
  const f = createSavedDescentFixture({ controls: { sprint: true } });
  f.bot.entity.attributes = {
    [f.bot.physics.movementSpeedAttribute]: { value: .1, modifiers: [{ uuid: f.bot.physics.sprintingUUID, amount: .3, operation: 2 }] },
  };
  f.bot.entity.metadata = { air: 300 };
  for (const value of [f.bot.entity, f.controls, f.bot.inventory.slots]) freezeDeep(value);
  const before = clone({ entity: f.bot.entity, controls: f.controls, slots: f.bot.inventory.slots });
  let writes = 0;
  for (const name of ['setControlState', 'clearControlStates', 'look', 'stopDigging', 'activateItem']) {
    f.bot[name] = () => { writes++; throw new Error('readonly prediction attempted a native action'); };
  }
  f.bot._client = { write: () => { writes++; throw new Error('readonly prediction attempted a packet'); } };
  // Cancellation may be observed during reads. The helper has no authority to
  // act on a paused task, settle it, restore controls, or apply any prediction.
  let cancelled = false;
  const original = f.bot.blockAt;
  f.bot.blockAt = p => { cancelled = true; return original(p); };
  const result = inspect(f);
  assert.equal(cancelled, true);
  assert.equal(result.accepted, true);
  assert.equal(writes, 0);
  assert.deepEqual(clone({ entity: f.bot.entity, controls: f.controls, slots: f.bot.inventory.slots }), before);
});

test('fixture remains intentionally bounded and never converts missing saved geometry into air', () => {
  const f = createSavedDescentFixture();
  assert.throws(() => f.bot.blockAt(new Vec3(data.bounds.minX - 1, 65, -285)), error => error.code === 'saved_fixture_unknown');
});
