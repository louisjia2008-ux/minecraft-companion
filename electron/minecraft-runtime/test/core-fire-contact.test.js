'use strict';
// Contract fixtures only: movement responses below are modeled control receipts,
// not server or physical survival acceptance. No terrain is changed by behavior.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createSurvivalBehaviors } = require('../core/behaviors/survival');
const { createBrain } = require('../core/brain');
function fixture({ feetFire = false, fire = 'fire', move = true } = {}) {
  const cells = new Map(); const unknown = new Set(); const controls = {}; const events = []; const actionsCalled = [];
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const position = feetFire ? new Vec3(2.5, 70, -26.5) : new Vec3(2.25934922321, 70, -26.4427956922055);
  cells.set(feetFire ? '2,70,-27' : '1,70,-27', fire);
  const movements = { canDig: true, allowParkour: true, allow1by1towers: true, scafoldingBlocks: [14], maxDropDown: 4, allowSprinting: true };
  let aim = null; let beforeForward = null;
  const bot = { entity: { position, width: .6, height: 1.8, onGround: true, metadata: {} }, game: { dimension: 'the_nether' },
    registry: { foodsByName: { mutton: {} } }, inventory: { slots: [], items: () => [] }, entities: {},
    pathfinder: { movements, setGoal() {} },
    blockAt(p) {
      if (unknown.has(key(p))) return null;
      const name = cells.get(key(p)) || (Math.floor(p.y) === 69 ? 'cobblestone' : 'air');
      const solid = !['air', 'fire', 'soul_fire', 'lava', 'water'].includes(name);
      return { name, position: p.floored(), boundingBox: solid ? 'block' : 'empty',
        shapes: solid ? name === 'stone_slab' ? [[0, 0, 0, 1, .5, 1]] : [[0, 0, 0, 1, 1, 1]] : [] };
    },
    lookAt: async (p) => { aim = p; },
    setControlState(name, value) {
      controls[name] = value;
      if (name === 'forward' && value) {
        beforeForward?.();
        if (move && aim) { const delta = aim.minus(bot.entity.position); const n = Math.hypot(delta.x, delta.z); const step = Math.min(.12, n);
          bot.entity.position = bot.entity.position.offset(delta.x / n * step, 0, delta.z / n * step); }
      }
    },
  };
  const actions = { haltBody: () => { actionsCalled.push('halt'); for (const name of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) controls[name] = false; },
    eat: async () => { actionsCalled.push('eat'); return { ok: true }; } };
  const behaviors = createSurvivalBehaviors({ bot, actions });
  const behavior = () => { const b = behaviors.find((b) => b.name === 'leave_fire'); assert.ok(b, 'actual fire contact needs a survival escape behavior'); return b; };
  const state = { alive: true, health: 9, food: 19, inventory: { mutton: 6 }, hostiles: [], sheltered: false, position };
  const controller = new AbortController(); const ctx = { signal: controller.signal, record: (type, data) => events.push({ type, ...data }), perceive: () => state };
  return { bot, movements, cells, unknown, controls, events, actionsCalled, behaviors, behavior, ctx, controller, state, key,
    beforeForward: (fn) => { beforeForward = fn; } };
}
test('observed .04065 block adjacent-fire overlap outranks eating and recentres on actual safe ground', async () => {
  const f = fixture(); const b = f.behavior();
  assert.ok(b.want(f.state) > 0); assert.ok(b.band > f.behaviors.find((b) => b.name === 'eat').band);
  const saved = { ...f.movements }; const result = await b.run(f.ctx);
  assert.equal(result.ok, true); assert.ok(f.bot.entity.position.x >= 2.3);
  assert.equal(f.events.find((e) => e.type === 'fire_escape_start').mode, 'recentre');
  assert.equal(f.events.find((e) => e.type === 'fire_escape_result').contacts.length, 0);
  assert.deepEqual(f.movements, saved); assert.equal(f.controls.forward, false);
});
test('a lingering on-fire tag after leaving the fire never triggers another escape', () => {
  const f = fixture(); f.bot.entity.position = new Vec3(2.5, 70, -26.5); f.bot.entity.metadata[0] = 1;
  assert.equal(f.behavior().want(f.state), 0);
});
test('lava retains its existing leave_lava behavior instead of new fire movement', () => {
  const f = fixture(); f.bot.entity.isInLava = true;
  assert.equal(f.behavior().want(f.state), 0);
  assert.ok(f.behaviors.find((b) => b.name === 'leave_lava').want(f.state) > 0);
});
test('soul fire contact triggers, while an unknown adjacent cell is not invented as fire', () => {
  const f = fixture({ fire: 'soul_fire' }); assert.ok(f.behavior().want(f.state) > 0);
  f.unknown.add('1,70,-27'); assert.equal(f.behavior().want(f.state), 0);
});
test('a feet-cell fire exits only to an actually reached same-height safe neighbour', async () => {
  const f = fixture({ feetFire: true }); const result = await f.behavior().run(f.ctx);
  assert.equal(result.ok, true); assert.equal(f.bot.entity.position.floored().x, 3); assert.equal(f.bot.entity.position.y, 70);
  assert.equal(f.events.find((e) => e.type === 'fire_escape_start').mode, 'neighbour');
  assert.equal(f.events.find((e) => e.type === 'fire_escape_result').contacts.length, 0);
});
test('no loaded safe neighbour fails without movement, digging, placement or invented recovery', async () => {
  const f = fixture({ feetFire: true });
  for (const cell of ['3,69,-27', '1,69,-27', '2,69,-26', '2,69,-28']) f.unknown.add(cell);
  const r = await f.behavior().run(f.ctx); assert.equal(r.ok, false); assert.equal(r.reason, 'no_safe_fire_exit');
  assert.equal(f.controls.forward || false, false); assert.equal(f.events.some((e) => e.type === 'fire_escape_start'), false);
});
test('partial support is refused and cannot authorize a safe fire exit', async () => {
  const f = fixture({ feetFire: true }); f.cells.set('2,69,-27', 'stone_slab');
  assert.equal((await f.behavior().run(f.ctx)).reason, 'no_safe_fire_exit'); assert.equal(f.controls.forward || false, false);
});
test('a newly missing support after aiming is refused before a movement pulse', async () => {
  const f = fixture({ feetFire: true }); f.bot.lookAt = async () => { f.unknown.add('3,69,-27'); };
  assert.equal((await f.behavior().run(f.ctx)).ok, false); assert.equal(f.controls.forward || false, false);
});
test('cancellation during aim halts controls and restores movement without a fresh pulse', async () => {
  const f = fixture(); const saved = { ...f.movements }; f.bot.lookAt = async () => f.controller.abort('cancel fire escape');
  await assert.rejects(f.behavior().run(f.ctx), { code: 'aborted' });
  assert.deepEqual(f.movements, saved); assert.equal(f.controls.forward || false, false); assert.ok(f.actionsCalled.includes('halt'));
});
test('movement acknowledgements without body movement never report fire escape success', async () => {
  const f = fixture({ move: false }); const result = await f.behavior().run(f.ctx);
  assert.equal(result.ok, false); assert.ok(f.events.find((e) => e.type === 'fire_escape_result').contacts.length > 0);
});
test('the real brain chooses fire contact before maintenance and keeps the interrupted task', async () => {
  const f = fixture(); const events = []; let goalSteps = 0;
  const brain = createBrain({ perceive: () => f.state, behaviors: f.behaviors, onEvent: (e) => events.push(e) });
  brain.setGoal({ name: 'quartz_fixture', progress: () => goalSteps, isDone: () => false, run: async () => { goalSteps++; return { ok: true }; } });
  try { await brain.tick();
    assert.equal(events.find((e) => e.type === 'behavior_started').behavior, 'leave_fire');
    assert.equal(brain.status().goal.name, 'quartz_fixture'); assert.equal(goalSteps, 0);
  } finally { await brain.dispose(); }
});

for (const feetFire of [false, true]) test(`MODELED native Physics ${feetFire ? 'feet-fire neighbour exit' : 'recorded adjacent-fire recentre'} uses continuous ticks without pose correction`, async () => {
  const { Physics, PlayerState } = require('prismarine-physics');
  const registry = require('prismarine-registry')('1.21.8');
  const Block = require('prismarine-block')(registry);
  const f = fixture({ feetFire, move: false });
  Object.assign(f.bot, { version: '1.21.8', registry, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0 });
  Object.assign(f.bot.entity, { yaw: 0, pitch: 0, velocity: new Vec3(0, -.0784, 0), effects: {}, attributes: {},
    isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: true, elytraFlying: false });
  f.bot.blockAt = (point) => { const p = point.floored(), key = f.key(p); if (f.unknown.has(key)) return null;
    const name = f.cells.get(key) || (p.y === 69 ? 'cobblestone' : 'air');
    return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position: p }); };
  const world = { getBlock: (p) => f.bot.blockAt(p) };
  const physics = Physics(registry, world), state = new PlayerState(f.bot, f.controls);
  f.bot.lookAt = async (p) => { const delta = p.minus(f.bot.entity.position); state.yaw = Math.atan2(-delta.x, -delta.z); };
  const from = f.bot.entity.position.clone(); let ticks = 0; let fell = false;
  const timer = setInterval(() => { physics.simulatePlayer(state, world).apply(f.bot); ticks++; if (state.pos.y < 70 - 1e-6) fell = true; }, 10);
  try { const result = await f.behavior().run(f.ctx);
    assert.equal(result.ok, true); assert.ok(ticks > 0); assert.equal(fell, false);
    assert.ok(f.bot.entity.position.distanceTo(from) > .04);
    assert.equal(f.events.find((e) => e.type === 'fire_escape_result').contacts.length, 0);
  } finally { clearInterval(timer); }
});

test('unknown collision shapes do not authorize a full support floor', async () => {
  const f = fixture({ feetFire: true }); const read = f.bot.blockAt;
  f.bot.blockAt = (p) => { const b = read(p); if (p.y === 69) delete b.shapes; return b; };
  assert.equal((await f.behavior().run(f.ctx)).reason, 'no_safe_fire_exit');
});
test('cancellation during a movement pulse retires the escape and restores all movement settings', async () => {
  const f = fixture({ feetFire: true }); const saved = { ...f.movements }; let pulses = 0;
  f.beforeForward(() => { pulses++; f.controller.abort('cancel active fire movement'); });
  await assert.rejects(f.behavior().run(f.ctx), { code: 'aborted' });
  assert.equal(pulses, 1); assert.equal(f.controls.forward, false); assert.deepEqual(f.movements, saved);
  assert.equal(f.events.some((e) => e.type === 'fire_escape_result' && e.ok), false);
});

test('cancellation restores the raw sprint preference behind the hunger-gated getter', async () => {
  const f = fixture(); let rawSprint = true; f.bot.food = 17;
  Object.defineProperty(f.movements, 'allowSprinting', { configurable: true, enumerable: true,
    get: () => rawSprint && f.bot.food >= 18, set: (value) => { rawSprint = Boolean(value); } });
  Object.defineProperty(f.movements, 'sprintSetting', { configurable: true, get: () => rawSprint });
  assert.equal(f.movements.allowSprinting, false); assert.equal(f.movements.sprintSetting, true);
  f.bot.lookAt = async () => f.controller.abort('cancel low-food escape');
  await assert.rejects(f.behavior().run(f.ctx), { code: 'aborted' });
  assert.equal(f.movements.sprintSetting, true); assert.equal(f.movements.allowSprinting, false);
  f.bot.food = 20; assert.equal(f.movements.allowSprinting, true);
});

function fortressLip() {
  const f = fixture();
  const position = new Vec3(-276.6450096938778, 76, -162.1539409771996);
  const fire = new Vec3(-277, 76, -162);
  const exit = new Vec3(-276, 76, -162);
  f.bot.entity.position = position;
  f.cells.set(f.key(fire), 'fire');
  for (const pos of [fire, exit]) f.cells.set(f.key(pos.offset(0, -1, 0)), 'nether_bricks');
  return { ...f, fire, exit };
}

test('a fire contact on the original fortress lip can retreat diagonally along continuous full support', async () => {
  const f = fortressLip();
  assert.ok(f.behavior().want(f.state) > 0);
  assert.equal((await f.behavior().run(f.ctx)).ok, true);
  assert.ok(f.bot.entity.position.floored().equals(f.exit));
  assert.ok(f.bot.entity.position.distanceTo(f.exit.offset(.5, 0, .5)) <= .19);
  assert.equal(f.events.find((e) => e.type === 'fire_escape_start').mode, 'supported_lip');
});

for (const hazard of ['missing_floor', 'new_fire', 'airborne', 'outside_nether']) {
  test(`fire lip retreat refuses ${hazard} before movement`, async () => {
    const f = fortressLip();
    if (hazard === 'missing_floor') f.cells.delete(f.key(f.fire.offset(0, -1, 0)));
    if (hazard === 'new_fire') f.cells.set(f.key(f.exit.offset(0, 1, 0)), 'fire');
    if (hazard === 'airborne') f.bot.entity.onGround = false;
    if (hazard === 'outside_nether') f.bot.game.dimension = 'overworld';
    let pulses = 0;
    f.beforeForward(() => { pulses += 1; });
    assert.equal((await f.behavior().run(f.ctx)).reason, 'no_safe_fire_exit');
    assert.equal(pulses, 0);
  });
}
