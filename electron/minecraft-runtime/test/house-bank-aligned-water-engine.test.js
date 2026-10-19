/* global require, setTimeout */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { engineFixture, Vec3 } = require('../test-support/house-bank-aligned-engine-native-fixture.cjs');
const { routeFrame } = require('../vendor/server/minecraft/houseShallowWaterTraversal');
const { hasGroundedBodySupport } = require('../vendor/server/minecraft/houseSurfaceGraph');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('hostile on the departure shore lets the real surface controller reach the safer opposite bank', {timeout:15000}, async t=>{
  const f=engineFixture(t,{width:24,initialLateral:0});
  f.task.materialSupply.materialSource='self_gathered';
  const route={...f.route,kind:'loaded_surface_swim',depth:'surface_only'};
  const enemy={id:900,name:'zombie',type:'mob',isValid:true,position:new Vec3(route.from.x-2,route.from.y,route.from.z),metadata:[]};
  f.bot.entities[enemy.id]=enemy;
  let triggered=false,pending;
  const onTick=()=>{if(!triggered&&f.bot.entity.isInWater){triggered=true;pending=f.agent.__testHandleSurvivalCritical('water-test');}};
  f.bot.on('physicsTick',onTick);t.after(()=>f.bot.removeListener('physicsTick',onTick));
  const result=await f.agent.__testHouseSurfaceWater(route);await pending;
  assert.equal(triggered,true);assert.equal(result.confirmed,true);assert.ok(dryAt(f,route.to));
  assert.ok(f.diagnostics().some(d=>d.event==='house_water_escape_forward'));
  assert.equal(f.diagnostics().some(d=>d.event==='house_surface_surface_swim_recovered'),false);
});
async function until(predicate, ms = 6000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await sleep(5);
  assert.ok(predicate(), 'bounded actual original-Physics condition observed');
}
const dryAt = (f, p) => f.bot.entity.position.floored().equals(new Vec3(p.x, p.y, p.z))
  && hasGroundedBodySupport(f.bot) && !f.bot.entity.isInWater && !f.bot.entity.isInLava;
const activeAlignment = f => Math.abs(routeFrame(f.route).v(f.bot.entity.position)) > .15
  && f.agent.__testGetHouseWaterFrame()?.session.isActive();
function checkAlignmentAndWater(f, expectedKind = 'water') {
  const ds = f.diagnostics(), entry = ds.find(d => d.event === 'house_surface_transport_entry'),
    aligned = ds.find(d => d.event === 'house_surface_dry_bank_alignment_confirmed'),
    started = ds.find(d => d.event === (expectedKind === 'water' ? 'house_surface_water_native_started' : 'house_surface_surface_swim_started'));
  assert.ok(entry); assert.ok(aligned); assert.ok(started);
  assert.ok(Math.abs(routeFrame(f.route).v(entry.details.position)) >= .17 - 1e-8, 'constructor pose reproduces rejected preflight tolerance');
  assert.ok(Math.abs(aligned.details.actual.position.x - f.route.from.x - .5) <= .08);
  assert.ok(Math.abs(aligned.details.actual.position.z - f.route.from.z - .5) <= .08);
  assert.equal(aligned.details.actual.onGround, true); assert.equal(aligned.details.stableTicks, 3);
  assert.equal(aligned.details.profileUnchanged, true);
  assert.ok(entry.at <= aligned.at && aligned.at <= started.at);
  assert.ok(f.points.some(p => p.wet), 'installed Physics actually entered water');
  assert.ok(f.looks.length > 0, 'original Mineflayer look used');
  assert.equal(f.agent.__testGetHouseWaterFrame(), null);
}

// Only initial constructor offsets vary. All subsequent positions/velocities
// come from original PlayerState.apply at real20Hz; no Java/server acceptance.
for (const [offset, direction] of [[.17, { x: 1, z: 0 }], [.35, { x: 1, z: 0 }],
  [-.35, { x: 1, z: 0 }], [.35, { x: 0, z: 1 }]]) {
  test(`production entry aligns lateral ${offset} before native cardinal water ${direction.x},${direction.z}`, { timeout: 15000 }, async t => {
    const f = engineFixture(t, { initialLateral: offset, direction }), lease = f.task.movementLease;
    const result = await f.agent.__testHouseSurfaceWater(f.route);
    assert.equal(result.confirmed, true); assert.ok(dryAt(f, f.route.to));
    checkAlignmentAndWater(f);
    assert.equal(f.bot.pathfinder.movements, f.originalProfile);
    assert.equal(f.agent.__testGetActiveMovementLease(), lease);
  });
}

test('same production entry alignment also precedes original native surface-swim controller', { timeout: 15000 }, async t => {
  const f = engineFixture(t, { initialLateral: .35 });
  const route = { ...f.route, kind: 'loaded_surface_swim', depth: 'surface_only' };
  const result = await f.agent.__testHouseSurfaceWater(route);
  assert.equal(result.confirmed, true); assert.ok(dryAt(f, route.to)); checkAlignmentAndWater(f, 'surface');
});

for (const action of ['pause', 'cancel']) test(`public ${action} during actual dry alignment cannot enter water and revokes only after settlement`, { timeout: 6000 }, async t => {
  const f = engineFixture(t, { initialLateral: .35 }), lease = f.task.movementLease, generation = f.task.executionGeneration;
  const running = f.agent.__testHouseSurfaceWater(f.route).then(value => ({ value }), error => ({ error }));
  await until(() => activeAlignment(f) && f.points.some(p => Math.abs(p.position.z - f.route.from.z - .5 - .35) > .005));
  const stopping = f.agent.handleMessage({ type: `mc_command_${action}` });
  // A public stop may settle synchronously while already proven dry. Its
  // postcondition must remain actual dry/no crossing, not an artificial delay.
  await stopping; const result = await running;
  assert.equal(result.error?.code, action === 'pause' ? 'paused' : 'cancelled');
  assert.ok(dryAt(f, f.route.from)); assert.equal(f.points.some(p => p.wet), false);
  assert.equal(f.agent.__testGetHouseWaterFrame(), null);
  assert.ok(f.task.executionGeneration > generation); assert.equal(f.agent.__testGetActiveMovementLease(), null);
  assert.notEqual(f.agent.__testGetActiveMovementLease(), lease);
  assert.equal(f.diagnostics().some(d => d.event === 'house_surface_water_native_started'), false);
});

test('same-generation foreign takeover during actual dry alignment is fact-only cleanup', { timeout: 6000 }, async t => {
  const f = engineFixture(t, { initialLateral: .35 });
  const running = f.agent.__testRunTaskExecution(f.task, { executeStep: () => f.agent.__testHouseSurfaceWater(f.route) });
  await until(() => activeAlignment(f) && f.points.length > 1);
  const generation = f.task.executionGeneration, foreign = f.takeover(); await running; await sleep(160);
  assert.equal(f.task.executionGeneration, generation);
  assert.equal(f.agent.__testGetActiveMovementLease(), foreign.lease);
  assert.equal(f.bot.pathfinder.movements, foreign.profile);
  assert.equal(f.bot.getControlState('jump'), true);
  assert.deepEqual(f.writes.slice(foreign.traceIndex), []);
  assert.equal(f.agent.__testGetHouseWaterFrame(), null);
  assert.equal(f.diagnostics().some(d => d.event === 'house_surface_water_native_started'), false);
});

test('real unknown-bank observation creates alignment HOLD retained through public pause', { timeout: 6000 }, async t => {
  const f = engineFixture(t, { initialLateral: .35 }), generation = f.task.executionGeneration, lease = f.task.movementLease;
  const running = f.agent.__testHouseSurfaceWater(f.route).then(value => ({ value }), error => ({ error }));
  await until(() => activeAlignment(f) && f.points.length > 1); f.setUnknownBank(true);
  const result = await running; assert.equal(result.error?.holding, true);
  const frame = f.agent.__testGetHouseWaterFrame(); assert.ok(frame?.session.isHolding());
  assert.equal(frame.isPhysicalOwner(), true); assert.equal(f.bot.getControlState('jump'), true);
  const profile = f.bot.pathfinder.movements, at = f.writes.length;
  await f.agent.handleMessage({ type: 'mc_command_pause' }); await sleep(120);
  assert.equal(f.agent.__testGetHouseWaterFrame(), frame); assert.equal(frame.session.isHolding(), true);
  assert.equal(f.task.executionGeneration, generation); assert.equal(f.agent.__testGetActiveMovementLease(), lease);
  assert.equal(f.bot.pathfinder.movements, profile); assert.equal(f.bot.getControlState('jump'), true);
  assert.deepEqual(f.writes.slice(at), []);
  assert.equal(f.diagnostics().some(d => d.event === 'house_surface_water_native_started'), false);
});
