'use strict';
// Actual1.21.8 block shapes/native raycast, acknowledged body/placement model.
// Real vanilla construction acceptance is a separate isolated server diagnostic.
const test = require('node:test'); const assert = require('node:assert/strict'); const { Vec3 } = require('vec3');
const path = require('node:path'); const end = require(path.join(process.env.QUARTZ04_RUNTIME || path.resolve(__dirname, '..'), 'core/end')); const { model } = require('./core-quartz-bridge04-fixture');
test('saved02 portal layout gets a completely prepared east exit before turning north to the original shore', async (t) => {
  const f = model(); t.mock.method(end, 'bridgeStep', f.acknowledgedStep);
  const result = await f.trip.leaveLedge(f.ctx, f.trip.ledge());
  assert.equal(result.landed, true); assert.equal(f.steps[0].to.equals(new Vec3(2, 70, 0)), true);
  assert.equal(f.steps.every((s) => s.readyBeforeMoving), true);
  assert.equal(f.attempts.some((a) => a.target.x === 0 && [-1, 0].includes(a.target.z) && a.target.y >= 70 && a.target.y <= 72), false);
  for (const z of [-1, 0]) for (const y of [70, 71, 72]) assert.equal(f.bot.blockAt(new Vec3(0, y, z)).name, 'nether_portal');
  assert.equal(f.events.find((e) => e.type === 'ledge_bridge').to, '1,69,-5');
});
for (const reason of ['bridge_guard_place_failed', 'no_bridge_blocks']) test(`${reason} does not turn a local construction failure into a rejected natural shore`, async (t) => {
  const f = model({ portal: false }); t.mock.method(end, 'bridgeStep', async () => ({ ok: false, reason }));
  await f.trip.leaveLedge(f.ctx, [f.bot.entity.position.floored()]);
  await f.trip.leaveLedge(f.ctx, [f.bot.entity.position.floored()]);
  const targets = f.events.filter((e) => e.type === 'ledge_bridge').map((e) => e.to);
  assert.equal(targets.length, 2); assert.equal(targets[0], targets[1]); assert.equal(f.memory.ledgeBlocked?.size || 0, 0);
});
test('a cached outbound bridge with insufficient construction material reports the existing resupply contract', async (t) => {
  const f = model({ portal: false }); f.put(new Vec3(2, 69, 0), 'cobblestone');
  f.memory.ledgeRoute = [new Vec3(1, 70, 0), new Vec3(2, 70, 0)];
  t.mock.method(end, 'bridgeStep', async () => ({ ok: false, reason: 'no_bridge_blocks' }));
  assert.equal((await f.trip.leaveLedge(f.ctx, [f.bot.entity.position.floored()])).reason, 'ledge_no_blocks');
});
test('every dispatched construction attempt retains actual target/reference/face, item delta and error evidence', async (t) => {
  const f = model({ portal: false }); let captured;
  t.mock.method(end, 'bridgeStep', async (_bot, _ctx, _target, options) => { captured = options; return { ok: false, reason: 'MODELED_capture' }; });
  await f.trip.leaveLedge(f.ctx, [f.bot.entity.position.floored()]); t.mock.restoreAll();
  f.bot.failPlacement = () => true;
  await captured.prepareNext({ feet: new Vec3(1, 70, 0), ahead: new Vec3(1, 70, -1), dir: new Vec3(0, 0, -1) });
  const failed = f.events.find((e) => e.type === 'bridge_guard_place_result' && e.ok === false);
  assert.ok(failed); for (const field of ['cell', 'before', 'reference', 'face', 'itemBefore', 'itemAfter', 'error', 'actual']) assert.ok(Object.hasOwn(failed, field), field);
  assert.match(failed.error, /MODELED_transient/); assert.equal(failed.actual.name, 'air');
});

test('a fully acknowledged protected route returns over an existing endpoint layout with zero new material', async (t) => {
  const f = model(); t.mock.method(end, 'bridgeStep', f.acknowledgedStep);
  assert.equal((await f.trip.leaveLedge(f.ctx, f.trip.ledge())).landed, true);
  const placed = f.attempts.length; f.bag.count = 0;
  assert.equal((await f.trip.toOverworld(f.ctx)).retraced, true);
  assert.equal(f.bot.entity.position.floored().equals(new Vec3(1, 70, 0)), true);
  assert.equal(f.attempts.length, placed, 'return may not expand an already complete layout into the portal');
});

test('a farther than48-Manhattan shore remains the same target across a real-material segmented return and continuation', async (t) => {
  const f = model({ portal: false });
  for (const [cell, name] of f.cells) if (name === 'basalt') f.cells.delete(cell);
  for (let x = 30; x <= 33; x++) for (let z = -32; z <= -31; z++) f.put(new Vec3(x, 69, z), 'basalt');
  t.mock.method(end, 'bridgeStep', f.acknowledgedStep);
  let result;
  for (let i = 0; i < 3; i++) { result = await f.trip.leaveLedge(f.ctx, [f.bot.entity.position.floored()]); if (result.reason === 'ledge_no_blocks') break; }
  assert.equal(result.reason, 'ledge_no_blocks'); assert.equal(result.landed, false);
  const target = f.memory.ledgeTarget.clone(); const prefix = f.memory.ledgeRoute.length; assert.ok(prefix > 30);
  f.trip.setBridgeResupply(true); const previousAttempts = f.attempts.length; f.bag.count = 0;
  assert.equal((await f.trip.toOverworld(f.ctx)).retraced, true); assert.equal(f.attempts.length, previousAttempts);
  // The logical overworld restock is modeled input here; the goal's separate
  // regression checks that intent cannot clear until actual counted stock.
  f.bag.count = 450; f.trip.setBridgeResupply(false);
  result = await f.trip.leaveLedge(f.ctx, [f.bot.entity.position.floored()]);
  assert.equal(result.landed, true); assert.equal(f.memory.ledgeTarget.equals(target), true);
  assert.ok(f.memory.ledgeRoute.length > prefix); assert.equal(f.memory.ledgeBlocked?.size || 0, 0);
});
test('equip/aim cancellation never dispatches another protected placement', async (t) => {
  const f = model({ portal: false }); let options;
  t.mock.method(end, 'bridgeStep', async (_b, _c, _t, value) => { options = value; return { ok: false, reason: 'MODELED_capture' }; });
  await f.trip.leaveLedge(f.ctx, [f.bot.entity.position.floored()]); t.mock.restoreAll();
  const controller = new AbortController(); f.ctx.signal = controller.signal;
  f.bot.lookAt = async () => { controller.abort('MODELED_cancel_during_aim'); };
  await assert.rejects(options.prepareNext({ feet: new Vec3(1, 70, 0), ahead: new Vec3(1, 70, -1), dir: new Vec3(0, 0, -1) }), { code: 'aborted' });
  assert.equal(f.attempts.length, 0);
});
test('movement within the same standing cell during equip retires construction before another placement', async (t) => {
  const f = model({ portal: false }); let options;
  t.mock.method(end, 'bridgeStep', async (_b, _c, _t, value) => { options = value; return { ok: false, reason: 'MODELED_capture' }; });
  await f.trip.leaveLedge(f.ctx, [f.bot.entity.position.floored()]); t.mock.restoreAll();
  f.bot.equip = async () => { f.bot.entity.position = f.bot.entity.position.offset(0.25, 0, 0); };
  assert.equal((await options.prepareNext({ feet: new Vec3(1, 70, 0), ahead: new Vec3(1, 70, -1), dir: new Vec3(0, 0, -1) })).reason, 'bridge_guard_position_changed');
  assert.equal(f.attempts.length, 0);
});

test('actual End preparation confirms the floor before clearing an old rail and completes walls before its body pulse', async (t) => {
  const f = model({ portal: false }); const actual = end.bridgeStep; let options;
  f.put(new Vec3(1, 69, -1), 'cobblestone'); f.put(new Vec3(1, 70, -1), 'cobblestone'); f.put(new Vec3(1, 71, -1), 'cobblestone');
  t.mock.method(end, 'bridgeStep', async (_b, _c, _t, value) => { options = value; return { ok: false, reason: 'MODELED_capture' }; });
  await f.trip.leaveLedge(f.ctx, [f.bot.entity.position.floored()]); t.mock.restoreAll();
  t.mock.method(require(path.join(process.env.QUARTZ04_RUNTIME || path.resolve(__dirname, '..'), 'core/actions')), 'digBlock', async (_b, _ctx, block) => {
    assert.equal(f.events.some((e) => e.type === 'bridge_guard_floor_prepared'), true);
    assert.equal(f.events.some((e) => e.type === 'bridge_guard_prepared'), false);
    assert.equal(f.controls.sneak, true); f.put(block.position, 'air'); return { ok: true };
  });
  f.bot.canDigBlock = () => true;
  const set = f.bot.setControlState; f.bot.setControlState = (name, value) => {
    if (name === 'forward' && value) { assert.equal(f.events.some((e) => e.type === 'bridge_guard_prepared'), true); f.bot.entity.position = new Vec3(1.5, 70, -0.5); }
    set(name, value);
  };
  assert.equal((await actual(f.bot, f.ctx, new Vec3(1.5, 69, -4.5), options)).ok, true);
});
test('visible and occluded native faces are labelled honestly and both still require an actual block acknowledgement', async (t) => {
  const f = model(); t.mock.method(end, 'bridgeStep', f.acknowledgedStep);
  assert.equal((await f.trip.leaveLedge(f.ctx, f.trip.ledge())).landed, true);
  const results = f.events.filter((e) => e.type === 'bridge_guard_place_result' && e.ok);
  assert.ok(results.some((e) => e.losAtDispatch === 'client_visible'));
  assert.ok(results.some((e) => e.losAtDispatch === 'client_occluded'));
  for (const result of results.filter((e) => e.losAtDispatch === 'client_visible')) {
    const attempt = f.attempts.find((a) => `${a.target.x},${a.target.y},${a.target.z}` === result.cell);
    assert.ok(attempt.nativeHit); assert.equal(`${attempt.nativeHit.position.x},${attempt.nativeHit.position.y},${attempt.nativeHit.position.z}`, result.reference.position);
    const face = attempt.face; const expected = face.y < 0 ? 0 : face.y > 0 ? 1 : face.z < 0 ? 2 : face.z > 0 ? 3 : face.x < 0 ? 4 : 5;
    assert.equal(attempt.nativeHit.face, expected);
  }
});
test('an acknowledgement arriving with cancellation remains owned but cannot start a second placement', async (t) => {
  const f = model({ portal: false }); let options;
  t.mock.method(end, 'bridgeStep', async (_b, _c, _t, value) => { options = value; return { ok: false, reason: 'MODELED_capture' }; });
  await f.trip.leaveLedge(f.ctx, [f.bot.entity.position.floored()]); t.mock.restoreAll();
  const controller = new AbortController(); f.ctx.signal = controller.signal; const place = f.bot._placeBlockWithOptions;
  f.bot._placeBlockWithOptions = async (...args) => { await place(...args); controller.abort('MODELED_cancel_after_ack'); };
  await assert.rejects(options.prepareNext({ feet: new Vec3(1, 70, 0), ahead: new Vec3(1, 70, -1), dir: new Vec3(0, 0, -1) }), { code: 'aborted' });
  assert.equal(f.attempts.length, 1); const p = f.attempts[0].target;
  assert.equal(f.memory.ledgeSupports.has(`${p.x},${p.y},${p.z}`), true);
});

test('the first novel north turn prepares the entire next-centred z-2 floor row before its body moves', async (t) => {
  const f = model(); let checked = false;
  t.mock.method(end, 'bridgeStep', async (...args) => {
    const before = f.bot.entity.position.floored(); const result = await f.acknowledgedStep(...args);
    if (before.equals(new Vec3(2, 70, 0)) && f.bot.entity.position.floored().equals(new Vec3(2, 70, -1))) {
      checked = true; for (const x of [1, 2, 3]) assert.equal(f.bot.blockAt(new Vec3(x, 69, -2)).boundingBox, 'block', 'a cheaper previous-centred pad is not the required new next3x3');
    }
    return result;
  });
  assert.equal((await f.trip.leaveLedge(f.ctx, f.trip.ledge())).landed, true); assert.equal(checked, true);
});
test('an isolated natural basalt support cannot waive its two-high outer guard column', async (t) => {
  const f = model({ portal: false }); f.put(new Vec3(0, 69, -1), 'basalt'); let options;
  t.mock.method(end, 'bridgeStep', async (_b, _c, _t, value) => { options = value; return { ok: false, reason: 'MODELED_capture' }; });
  await f.trip.leaveLedge(f.ctx, [f.bot.entity.position.floored()]); t.mock.restoreAll();
  const prepared = await options.prepareNext({ feet: new Vec3(1, 70, 0), ahead: new Vec3(1, 70, -1), dir: new Vec3(0, 0, -1) });
  assert.equal((await prepared.afterClear()).ok, true);
  for (const y of [70, 71]) assert.equal(f.bot.blockAt(new Vec3(0, y, -1)).name, 'cobblestone');
});
