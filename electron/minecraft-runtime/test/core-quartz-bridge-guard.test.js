'use strict';
// Read/write voxel model only; no server or item-grant command is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const runtime = process.env.QUARTZ_NAV_TEST_RUNTIME || path.resolve(__dirname, '..');
const { Vec3 } = require('vec3');
const { createPortalTrip } = require(path.join(runtime, 'core/netherTrip'));
const end = require(path.join(runtime, 'core/end'));
function fixture({ count = 100, unknown } = {}) {
  const cells = new Map([['0,69,0', 'obsidian'], ['-4,70,-4', 'nether_portal']]);
  const put = (p, name) => cells.set(`${p.x},${p.y},${p.z}`, name);
  for (let x = 5; x <= 8; x++) for (let z = -1; z <= 2; z++) put(new Vec3(x, 69, z), 'basalt');
  const controls = {}; const placed = []; const events = [];
  const bag = { count };
  const bot = { game: { dimension: 'the_nether' }, entity: { position: new Vec3(0.5, 70, 0.5), onGround: true },
    inventory: { items: () => bag.count ? [{ name: 'cobblestone', count: bag.count }] : [] },
    getControlState: (name) => controls[name] || false,
    setControlState: (name, value) => { controls[name] = value; },
    blockAt(p) { const q = p.floored(); if (unknown?.equals(q)) return null;
      const name = cells.get(`${q.x},${q.y},${q.z}`) || 'air';
      const empty = ['air', 'nether_portal', 'fire', 'soul_fire', 'water', 'lava'].includes(name);
      return { name, position: q, boundingBox: empty ? 'empty' : 'block', shapes: empty ? [] : [[0, 0, 0, 1, 1, 1]] }; },
    lookAt: async () => {}, equip: async () => {},
    placeBlock: async (ref, face) => { const p = ref.position.plus(face); put(p, 'cobblestone'); placed.push(p); bag.count--; },
  };
  const WorldSync = require('prismarine-world/src/worldsync');
  bot.world = { getBlock: (p) => bot.blockAt(p) }; bot.world.raycast = WorldSync.prototype.raycast.bind(bot.world);
  bot._placeBlockWithOptions = (...args) => bot.placeBlock(...args);
  const memory = { netherPortal: new Vec3(-4, 70, -4) };
  const trip = createPortalTrip({ bot, memory, protectedBridge: true,
    actions: { recentre: async () => {}, haltBody: () => { controls.forward = false; } } });
  return { bot, memory, trip, put, controls, placed, events, bag, ctx: { record: (type, data) => events.push({ type, ...data }) } };
}
async function prepareOne(t, f, { feet = new Vec3(0, 70, 0), dir = new Vec3(1, 0, 0), after } = {}) {
  let preparation;
  t.mock.method(end, 'bridgeStep', async (_bot, _ctx, _target, options) => {
    assert.equal(typeof options.prepareNext, 'function', 'protected trip must require preparation');
    const ahead = feet.plus(dir);
    preparation = await options.prepareNext({ feet, ahead, dir });
    if (preparation.ok && preparation.afterClear) preparation = await preparation.afterClear();
    after?.(preparation);
    return { ok: false, reason: 'MODELED_stop_before_body_step' };
  });
  await f.trip.leaveLedge(f.ctx, [feet]);
  return preparation;
}
test('end bridge preparation failure returns before any forward body control', async () => {
  let forward = false; let prepared = false;
  const bot = { entity: { position: new Vec3(0.5, 70, 0.5), onGround: true },
    blockAt(p) { return { name: p.y === 69 ? 'stone' : 'air', boundingBox: p.y === 69 ? 'block' : 'empty' }; },
    lookAt: async () => {}, setControlState(name, value) { if (name === 'forward' && value) { forward = true; throw new Error('body moved before preparation'); } } };
  const result = await end.bridgeStep(bot, { record() {} }, new Vec3(2.5, 70, 0.5), {
    prepareNext: async () => { prepared = true; return { ok: false, reason: 'MODELED_guard_not_ready' }; },
  });
  assert.equal(prepared, true); assert.equal(result.reason, 'MODELED_guard_not_ready'); assert.equal(forward, false);
});
test('the next complete 3x3 ground patch and two-high walls exist before movement', async (t) => {
  const f = fixture(); const result = await prepareOne(t, f);
  assert.equal(result.ok, true);
  for (let x = 0; x <= 2; x++) for (let z = -1; z <= 1; z++) assert.equal(f.bot.blockAt(new Vec3(x, 69, z)).boundingBox, 'block');
  for (let x = 0; x <= 2; x++) for (const z of [-1, 1]) for (const y of [70, 71]) assert.equal(f.bot.blockAt(new Vec3(x, y, z)).boundingBox, 'block');
  for (const p of f.placed) assert.ok(f.memory.ledgeSupports.has(`${p.x},${p.y},${p.z}`), 'all placed guard blocks remain owned after TTL');
  assert.equal(f.controls.sneak, false); assert.equal(f.bag.count, 100 - f.placed.length);
});
test('insufficient actual stone refuses the whole guard before side placement or body movement', async (t) => {
  const f = fixture({ count: 4 });
  assert.equal((await prepareOne(t, f)).reason, 'no_bridge_blocks');
  assert.equal(f.events.some((e) => e.type === 'bridge_guard_prepared'), false);
  assert.equal(f.controls.sneak || false, false); assert.equal(f.placed.length, 0);
});
test('an unknown support cell cannot be inferred from the planned guard shape', async (t) => {
  const f = fixture({ unknown: new Vec3(0, 69, 1) });
  assert.equal((await prepareOne(t, f)).reason, 'bridge_guard_unknown');
  assert.equal(f.events.some((e) => e.type === 'bridge_guard_prepared'), false);
});
test('side walls do not close an existing observed bridge corridor at a turn', async (t) => {
  const f = fixture(); f.bot.entity.position = new Vec3(1.5, 70, 0.5);
  f.put(new Vec3(1, 69, 0), 'cobblestone');
  f.memory.ledgeRoute = [new Vec3(0, 70, 0), new Vec3(1, 70, 0)];
  assert.equal((await prepareOne(t, f, { feet: new Vec3(1, 70, 0), dir: new Vec3(0, 0, 1) })).ok, true);
  assert.equal(f.bot.blockAt(new Vec3(0, 70, 0)).boundingBox, 'empty');
  assert.equal(f.bot.blockAt(new Vec3(0, 71, 0)).boundingBox, 'empty');
});
test('a natural landing is neither walled off nor replaced with self-laid supports', async (t) => {
  const f = fixture(); f.bot.entity.position = new Vec3(4.5, 70, 0.5); f.put(new Vec3(4, 69, 0), 'cobblestone');
  assert.equal((await prepareOne(t, f, { feet: new Vec3(4, 70, 0) })).ok, true);
  assert.equal(f.bot.blockAt(new Vec3(5, 69, 0)).name, 'basalt', 'a pre-existing natural floor is never replaced');
  for (const z of [-1, 1]) assert.equal(f.bot.blockAt(new Vec3(5, 70, z)).name, 'air');
  assert.equal(f.memory.ledgeSupports.has('5,69,1'), false);
});
test('cancellation during guard placement clears sneak and never emits guard-ready', async (t) => {
  const f = fixture(); const controller = new AbortController(); f.ctx.signal = controller.signal;
  f.bot.placeBlock = async () => { controller.abort('MODELED_cancel'); throw Object.assign(new Error('aborted'), { code: 'aborted' }); };
  await assert.rejects(prepareOne(t, f), { code: 'aborted' });
  assert.equal(f.controls.sneak, false); assert.equal(f.events.some((e) => e.type === 'bridge_guard_prepared'), false);
});

test('a guard destroyed during its last placement is freshly refused before movement', async (t) => {
  const f = fixture(); const place = f.bot.placeBlock;
  f.bot.placeBlock = async (reference, face) => {
    await place(reference, face);
    if (reference.position.plus(face).equals(new Vec3(2, 71, 1))) f.put(new Vec3(0, 69, -1), 'air');
  };
  assert.equal((await prepareOne(t, f)).reason, 'bridge_guard_changed');
  assert.equal(f.events.some((e) => e.type === 'bridge_guard_prepared'), false);
});

for (const [label, at, shape] of [
  ['fence floor', new Vec3(0, 69, 1), [0.375, 0, 0.375, 0.625, 1.5, 0.625]],
  ['bottom slab wall', new Vec3(1, 70, 1), [0, 0, 0, 1, 0.5, 1]],
]) test(`a ${label} cannot authorize a complete protected causeway`, async (t) => {
  const f = fixture(); const blockAt = f.bot.blockAt;
  f.bot.blockAt = (p) => p.floored().equals(at) ? { name: label.includes('fence') ? 'nether_brick_fence' : 'cobblestone_slab',
    position: at, boundingBox: 'block', shapes: [shape] } : blockAt(p);
  assert.equal((await prepareOne(t, f)).reason, 'bridge_guard_partial');
  assert.equal(f.events.some((e) => e.type === 'bridge_guard_prepared'), false);
  assert.equal(f.placed.length, 0);
});

test('a cancellation acknowledged by equip does not dispatch another placement', async (t) => {
  const f = fixture(); const controller = new AbortController(); f.ctx.signal = controller.signal;
  f.bot.equip = async () => { controller.abort('MODELED_cancel_during_equip'); };
  await assert.rejects(prepareOne(t, f), { code: 'aborted' });
  assert.equal(f.placed.length, 0); assert.equal(f.controls.sneak, false);
});
test('the real optional End hook constructs and acknowledges the central floor before body control', async (t) => {
  const f = fixture(); const actualStep = end.bridgeStep; let callback;
  t.mock.method(end, 'bridgeStep', async (_bot, _ctx, _target, options) => { callback = options.prepareNext; return { ok: false, reason: 'MODELED_capture_only' }; });
  await f.trip.leaveLedge(f.ctx, [new Vec3(0, 70, 0)]);
  t.mock.restoreAll(); f.bot.lookAt = async () => {};
  const setControl = f.bot.setControlState;
  f.bot.setControlState = (name, value) => {
    if (name === 'forward' && value) {
      assert.equal(f.events.some((e) => e.type === 'bridge_guard_prepared'), true);
      assert.equal(f.bot.blockAt(new Vec3(1, 69, 0)).name, 'cobblestone');
      assert.equal(f.bot.blockAt(new Vec3(1, 71, 1)).name, 'cobblestone');
      f.bot.entity.position = new Vec3(1.5, 70, 0.5); // acknowledged body action model
    }
    setControl(name, value);
  };
  assert.equal((await actualStep(f.bot, f.ctx, new Vec3(5.5, 69, 0.5), { prepareNext: callback })).ok, true);
  assert.equal(f.bag.count, 80, 'one current floor plus20new physical blocks completes the first guard');
  assert.equal(f.memory.ledgeSupports.has('1,69,0'), true);
});

async function capturedProtectedStep(t, f, beforeMove) {
  const actual = end.bridgeStep; let options;
  t.mock.method(end, 'bridgeStep', async (_bot, _ctx, _target, value) => { options = value; return { ok: false, reason: 'MODELED_capture_only' }; });
  await f.trip.leaveLedge(f.ctx, [new Vec3(0, 70, 0)]);
  t.mock.restoreAll(); f.bot.canDigBlock = () => true;
  f.bot.lookAt = async () => { beforeMove?.(); };
  let forwards = 0; const set = f.bot.setControlState;
  f.bot.setControlState = (name, value) => { if (name === 'forward' && value) { forwards++; f.bot.entity.position = new Vec3(1.5, 70, 0.5); } set(name, value); };
  return { run: () => actual(f.bot, f.ctx, new Vec3(5.5, 69, 0.5), options), forwards: () => forwards };
}
for (const [label, at, name] of [
  ['feet fire', new Vec3(1, 70, 0), 'fire'],
  ['head soul_fire', new Vec3(1, 71, 0), 'soul_fire'],
]) test(`protected central ${label} refuses movement before guard construction`, async (t) => {
  const f = fixture(); f.put(at, name); const step = await capturedProtectedStep(t, f);
  const result = await step.run();
  assert.equal(result.reason, 'bridge_guard_unsafe'); assert.equal(step.forwards(), 0); assert.equal(f.placed.length, 0);
});
for (const y of [70, 71]) test(`protected central unknown y${y} refuses movement before guard construction`, async (t) => {
  const f = fixture({ unknown: new Vec3(1, y, 0) }); const step = await capturedProtectedStep(t, f);
  assert.equal((await step.run()).reason, 'bridge_guard_unknown'); assert.equal(step.forwards(), 0); assert.equal(f.placed.length, 0);
});
for (const change of ['fire', 'unknown']) test(`protected central ${change} appearing after side-wall removal refuses movement`, async (t) => {
  const f = fixture(); f.put(new Vec3(1, 70, 0), 'cobblestone'); f.put(new Vec3(1, 71, 0), 'cobblestone');
  const step = await capturedProtectedStep(t, f); const blockAt = f.bot.blockAt; let unknown = false;
  f.bot.blockAt = (p) => unknown && p.floored().equals(new Vec3(1, 70, 0)) ? null : blockAt(p);
  const actions = require(path.join(runtime, 'core/actions'));
  t.mock.method(actions, 'digBlock', async (_bot, _ctx, block) => {
    f.put(block.position, 'air');
    if (block.position.y === 70) { if (change === 'unknown') unknown = true; else f.put(block.position, 'fire'); }
    return { ok: true };
  });
  assert.equal((await step.run()).reason, change === 'unknown' ? 'bridge_guard_unknown' : 'bridge_guard_unsafe');
  assert.equal(step.forwards(), 0);
});
test('protected central old side wall may be explicitly cleared into fresh safe headroom', async (t) => {
  const f = fixture(); f.put(new Vec3(1, 70, 0), 'cobblestone'); f.put(new Vec3(1, 71, 0), 'cobblestone');
  const step = await capturedProtectedStep(t, f); const dug = [];
  t.mock.method(require(path.join(runtime, 'core/actions')), 'digBlock', async (_bot, _ctx, block) => { dug.push(block.position.y); f.put(block.position, 'air'); return { ok: true }; });
  assert.equal((await step.run()).ok, true); assert.deepEqual(dug, [71, 70]); assert.equal(step.forwards(), 1);
});
test('protected central fire appearing during lookAt refuses the next forward pulse', async (t) => {
  const f = fixture(); const step = await capturedProtectedStep(t, f, () => f.put(new Vec3(1, 70, 0), 'fire'));
  assert.equal((await step.run()).reason, 'bridge_guard_unsafe'); assert.equal(step.forwards(), 0);
});

test('mid-aim bridge cancellation cannot dispatch a fresh forward pulse', async () => {
  const controller = new AbortController(); const controls = {}; let forwards = 0;
  const bot = { entity: { position: new Vec3(0.5, 70, 0.5), onGround: true },
    blockAt(p) { return { name: p.y === 69 ? 'stone' : 'air', boundingBox: p.y === 69 ? 'block' : 'empty' }; },
    lookAt: async () => { controller.abort('MODELED_cancel_during_aim'); },
    setControlState(name, value) { controls[name] = value; if (name === 'forward' && value) forwards++; } };
  await assert.rejects(end.bridgeStep(bot, { signal: controller.signal, record() {} }, new Vec3(2.5, 70, 0.5)), { code: 'aborted' });
  assert.equal(forwards, 0); assert.equal(controls.forward, false); assert.equal(controls.sneak, false);
});
