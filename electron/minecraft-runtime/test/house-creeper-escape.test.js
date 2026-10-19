/* global require, setTimeout, setInterval, clearInterval */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3'), { Physics, PlayerState } = require('prismarine-physics'), { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const registry = require('prismarine-registry')('1.21.8'), Block = require('prismarine-block')(registry);
const { createHouseCreeperEscape } = require('../vendor/server/minecraft/houseCreeperEscape');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// OFFLINE actual installed pathfinder/Physics. Bot entity position/velocity are
// configured once at fixture spawn; all later movement uses PlayerState.apply.
// Creeper movement below is an independently recorded fixture script, not a
// real server creeper/fuse/AI or packet-proven combat acceptance.
function fixture(t, options = {}) {
  const cells = new Map(), controls = Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(k => [k, false]));
  const writes = [], attempts = [], records = [], samples = [], threatSamples = [];
  let owner = true, paused = false, ticks = 0;
  const bot = Object.assign(new EventEmitter(), { registry, version: '1.21.8', username: 'PrivateCreeperEscape', health: 20, food: 20,
    _client: { state: 'play', socket: { writable: true, destroyed: false } }, game: { dimension: 'overworld', minY: -64, height: 384, gameMode: 'survival' },
    entities: {}, players: {}, player: { ping: 1 }, inventory: { slots: Array(46).fill(null), items: () => [] },
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, controlState: controls,
    entity: { id: 1, position: options.initialPosition?.clone()||new Vec3(.5, 1, .5), velocity: options.initialVelocity?.clone() || new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false,
      isCollidedHorizontally: false, isCollidedVertically: true, eyeHeight: 1.62, height: 1.8, width: .6, yaw: 0, pitch: 0, effects: {}, attributes: {} } });
  bot.blockAt = raw => {
    const p = raw.floored(); if (Math.abs(p.x) > 16 || Math.abs(p.z) > 16 || p.y < -64 || p.y > 20) return null;
    const name = cells.get(p.toString()) || (p.y < 1 ? 'stone' : 'air'); if (name === 'UNKNOWN') return null;
    return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position: p });
  };
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; };
  bot.setControlState = (name, value) => { writes.push({ kind: 'control', name, value, owner, paused }); controls[name] = value; };
  bot.clearControlStates = () => { writes.push({ kind: 'clear', owner, paused }); for (const name of Object.keys(controls)) controls[name] = false; };
  bot.deactivateItem = () => {}; bot.stopDigging = () => {};
  const creeper = { id: 2, name: options.threatName || 'creeper', type: 'mob', isValid: true, position: options.threatPosition?.clone() || new Vec3(options.distance ?? 8.5, 1, .5) }; bot.entities[2] = creeper;
  bot.attack = () => { throw new Error('Creeper escape must never attack'); };
  bot.physics = Physics(registry, { getBlock: bot.blockAt }); pathfinder(bot);
  const profile = new Movements(bot); profile.canDig = false; profile.scafoldingBlocks = []; profile.allow1by1towers = false; profile.allowParkour = false;
  profile.allowFreeMotion = false; profile.allowSprinting = false; profile.maxDropDown = 2; profile.infiniteLiquidDropdownDistance = false; profile.getMoveDiagonal = () => {};
  for (const name of ['water', 'lava', 'bubble_column', 'fire', 'magma_block', 'cactus']) profile.blocksToAvoid.add(registry.blocksByName[name].id);
  profile.exclusionAreasStep.push(block => block?.position && [-1, 0, 1].every(dy => {
    const b = bot.blockAt(block.position.offset(0, dy, 0)); return b && !['water', 'lava', 'bubble_column', 'fire', 'magma_block', 'cactus'].includes(b.name);
  }) ? 0 : Infinity);
  bot.pathfinder.setMovements(profile);
  const installedGoto = bot.pathfinder.goto.bind(bot.pathfinder);
  bot.pathfinder.goto = goal => { attempts.push({ goal, profile: bot.pathfinder.movements, owner, paused, velocity: bot.entity.velocity.clone() }); return installedGoto(goal); };
  const timer = setInterval(() => {
    bot.physics.simulatePlayer(new PlayerState(bot, controls), { getBlock: bot.blockAt }).apply(bot); ticks++;
    if (options.approaching) {
      const dx = bot.entity.position.x - creeper.position.x, dz = bot.entity.position.z - creeper.position.z, d = Math.hypot(dx, dz);
      if (d > .1) { creeper.position.x += dx / d * (options.approachStep??.035); creeper.position.z += dz / d * (options.approachStep??.035); }
      threatSamples.push({ tick: ticks, source: 'independent_offline_fixture', position: { x: creeper.position.x, y: creeper.position.y, z: creeper.position.z } });
    }
    samples.push({ tick: ticks, position: bot.entity.position.clone(), distance: Math.hypot(bot.entity.position.x - creeper.position.x, bot.entity.position.z - creeper.position.z), onGround: bot.entity.onGround });
    bot.emit('physicsTick');
  }, options.physicsMs || 10);
  const deps = { getBot: () => bot, assertActive: () => { if (paused) throw Object.assign(new Error('paused'), { code: 'paused' }); }, isOwnerCurrent: () => owner,
    getThreat: () => creeper, record: (kind, facts) => records.push({ kind, facts }) };
  t.after(() => { clearInterval(timer); bot.pathfinder.setGoal(null); bot.clearControlStates(); });
  return { bot, cells, profile, creeper, deps, attempts, writes, records, samples, threatSamples, pause: () => { paused = true; }, foreign: () => { owner = false; }, ticks: () => ticks };
}

test('early8m stationary creeper escapes through actual native dry physics; no attack/profile swap', { timeout: 6000 }, async t => {
  const f = fixture(t), result = await createHouseCreeperEscape(f.deps).escape();
  assert.equal(result.confirmed, true); assert.equal(result.initialDistance, 8); assert.ok(result.finalDistance >= 8.5); assert.ok(result.traveled > .5 && result.traveled <= 12);
  assert.ok(result.nativeStoppedEarly); assert.equal(f.bot.entity.isInWater, false); assert.equal(f.bot.entity.onGround, true); assert.equal(f.bot.pathfinder.movements, f.profile);
  assert.equal(f.attempts.length, 1); assert.ok(f.samples.length > 5); assert.ok(f.samples.every(s => s.distance >= 8 - .025)); assert.equal(f.bot.pathfinder.goal, null);
});
test('whole39 residual velocity settles by original friction on a controlled50ms physics clock',{timeout:6000},async t=>{
 // Recorded horizontal velocity and relative mob pose, on an explicit flat
 // fixture (not the saved terrain). Only original Physics changes the actor.
 // A deterministic scheduler tests the friction/control contract; separate
 // real-clock tests retain missing/late-frame refusal, and live Java remains
 // the authority for actual wall-clock acceptance.
 t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:1800000000000});
 const f=fixture(t,{physicsMs:50,initialVelocity:new Vec3(0,-.0784000015258789,.11781015234537406),threatPosition:new Vec3(4.555179526731813,2,7.130376487141889)});
 t.after(()=>t.mock.timers.reset());
 let settled=false,result,error;
 const running=createHouseCreeperEscape(f.deps).escape().then(value=>{result=value;settled=true;},reason=>{error=reason;settled=true;});
 for(let ms=0;!settled&&ms<6000;ms+=10){t.mock.timers.tick(10);for(let i=0;i<30;i++)await Promise.resolve();}
 assert.equal(settled,true,'controlled native operation must settle within its unchanged limit');await running;if(error)throw error;
 assert.equal(result.confirmed,true);assert.ok(result.finalDistance>=8.5);assert.ok(result.elapsedMs<=4000);
 const braking=f.records.find(r=>r.kind==='dry_escape_braking_confirmed');assert.ok(braking);
 assert.ok(braking.facts.traveled>0&&braking.facts.traveled<=.6);
 assert.ok(f.attempts.length);assert.ok(Math.hypot(f.attempts[0].velocity.x,f.attempts[0].velocity.z)<=.03);
 assert.equal(f.bot.pathfinder.goal,null);assert.equal(f.bot.entity.onGround,true);
});
for(const mode of ['pause','foreign','unknown'])test(`native braking rejects ${mode} without starting an escape goal or leaking its observer`,{timeout:3000},async t=>{
 const f=fixture(t,{physicsMs:50,initialVelocity:new Vec3(.11781015234537406,-.0784000015258789,0)});
 let changed=false,foreignGoal;
 const change=()=>{if(changed)return;changed=true;
  if(mode==='pause')f.pause();
  if(mode==='unknown')f.cells.set(f.bot.entity.position.floored().toString(),'UNKNOWN');
  if(mode==='foreign'){f.foreign();foreignGoal=new goals.GoalBlock(15,1,0);f.bot.pathfinder.setGoal(foreignGoal);}
 };
 f.bot.on('physicsTick',change);const listeners=f.bot.listenerCount('physicsTick');
 await assert.rejects(createHouseCreeperEscape(f.deps).escape(),e=>mode==='pause'?e.code==='paused':mode==='foreign'?e.code==='house_creeper_escape_preempted':e.code==='house_creeper_escape_hazard');
 assert.equal(changed,true);assert.equal(f.attempts.length,0);assert.equal(f.bot.listenerCount('physicsTick'),listeners);
 if(mode==='foreign')assert.equal(f.bot.pathfinder.goal,foreignGoal);else assert.equal(f.bot.pathfinder.goal,null);
});
for(const mode of ['speed','close_threat','missing_ticks'])test(`native braking refuses ${mode} within the original bounded budget`,{timeout:3000},async t=>{
 const f=fixture(t,{physicsMs:mode==='missing_ticks'?1000:50,initialVelocity:new Vec3(mode==='speed'?.3:.11781015234537406,-.0784000015258789,0),distance:mode==='close_threat'?4:8.5});
 const listeners=f.bot.listenerCount('physicsTick');
 await assert.rejects(createHouseCreeperEscape(f.deps).escape(),e=>e.code===({speed:'house_creeper_escape_braking_unconfirmed',close_threat:'house_creeper_escape_braking_limit',missing_ticks:'house_creeper_escape_braking_timeout'})[mode]);
 assert.equal(f.attempts.length,0);assert.equal(f.bot.pathfinder.goal,null);assert.equal(f.bot.listenerCount('physicsTick'),listeners);
 assert.equal(f.writes.some(w=>w.kind==='control'&&w.value),false);
});
test('late queued native physics ticks cannot confirm an expired braking window',{timeout:3000},async t=>{
 const f=fixture(t,{physicsMs:1000,initialVelocity:new Vec3(.11781015234537406,-.0784000015258789,0)});
 const listeners=f.bot.listenerCount('physicsTick'),running=createHouseCreeperEscape(f.deps).escape();running.catch(()=>{});
 // Model a busy JS event loop followed by queued native catch-up frames.
 // No fake Date, actor overwrite or synthetic velocity reset is used.
 const until=Date.now()+1025;while(Date.now()<until) { /* blocked scheduling */ }
 for(let i=0;i<3;i++){f.bot.physics.simulatePlayer(new PlayerState(f.bot,f.bot.controlState),{getBlock:f.bot.blockAt}).apply(f.bot);f.bot.emit('physicsTick');}
 f.pause();
 await assert.rejects(running,{code:'house_creeper_escape_braking_timeout'});
 assert.equal(f.records.some(r=>r.kind==='dry_escape_braking_confirmed'),false);
 assert.equal(f.attempts.length,0);assert.equal(f.bot.listenerCount('physicsTick'),listeners);
});

test('emergency melee retreat settles supported residual motion despite a nearby spider, within original budgets',{timeout:6000},async t=>{
 const f=fixture(t,{threatName:'spider',distance:3.5,initialVelocity:new Vec3(-.11781015234537406,-.0784000015258789,0)});
 f.bot.health=8;
 const result=await createHouseCreeperEscape(f.deps,{threatName:'spider',emergencyRetreat:true}).escape();
 assert.ok(f.records.some(r=>r.kind==='dry_escape_braking_confirmed'));
 assert.ok(f.attempts.length>0);assert.ok(result.finalDistance>=8.5);assert.ok(result.traveled<=12);assert.ok(result.elapsedMs<=4000);
 assert.equal(f.bot.health,8);assert.equal(f.bot.pathfinder.movements,f.profile);assert.equal(f.bot.pathfinder.goal,null);
});

for (const name of ['zombie', 'husk', 'drowned', 'spider', 'cave_spider']) test(`captured ${name} reuses finite native dry escape without disguising entity type`, { timeout: 6000 }, async t => {
  const f = fixture(t, { threatName: name });
  const result = await createHouseCreeperEscape(f.deps, { threatName: name }).escape();
  assert.equal(result.threatName, name); assert.equal(f.creeper.name, name);
  assert.ok(result.finalDistance >= 8.5); assert.ok(result.traveled <= 12);
  assert.equal(f.bot.pathfinder.movements, f.profile); assert.equal(f.bot.entity.onGround, true);
});

test('dry melee escape refuses ranged or player entities as unsupported threat capabilities', t => {
  const f = fixture(t);
  for (const name of ['skeleton', 'player', 'cow']) assert.throws(() => createHouseCreeperEscape(f.deps, { threatName: name }), TypeError);
  assert.equal(f.attempts.length, 0);
});
test('independently moving creeper still requires actual current8.5m distance, not original threat snapshot', { timeout: 6000 }, async t => {
  const f = fixture(t, { distance: 6.5, approaching: true }), result = await createHouseCreeperEscape(f.deps).escape();
  assert.equal(result.confirmed, true); assert.ok(result.finalDistance >= 8.5); assert.ok(result.traveled <= 12); assert.ok(f.threatSamples.length > 10);
  assert.ok(f.threatSamples.at(-1).position.x < 6.5); assert.ok(f.samples.at(-1).distance >= 8.5);
});
test('already close3.2m stationary threat may move monotonically out of initial danger circle', { timeout: 6000 }, async t => {
  const f = fixture(t, { distance: 3.7 }), result = await createHouseCreeperEscape(f.deps).escape();
  assert.ok(Math.abs(result.initialDistance - 3.2) < 1e-7); assert.ok(result.finalDistance >= 8.5); assert.ok(result.traveled > 5); assert.ok(result.traveled <= 12);
  assert.ok(f.samples.every(s => s.distance >= 3.2 - .025));
});
test('unknown, wet, deep shaft and lava-only escape terrain never produces a native goto', async t => {
  for (const mode of ['UNKNOWN', 'water', 'lava', 'shaft']) {
    const f = fixture(t);
    for (let x = -16; x <= 16; x++) for (let z = -16; z <= 16; z++) if (x !== 0 || z !== 0) {
      if (mode === 'shaft') for (let y = -4; y <= 0; y++) f.cells.set(new Vec3(x, y, z).toString(), 'air');
      else f.cells.set(new Vec3(x, mode === 'UNKNOWN' ? 1 : 0, z).toString(), mode);
    }
    await assert.rejects(createHouseCreeperEscape(f.deps).escape(), e => e.code === 'house_creeper_escape_no_path'); assert.equal(f.attempts.length, 0);
  }
});
test('pause while native escape is moving stops owned controls and cannot start a later goto', { timeout: 6000 }, async t => {
  const f = fixture(t, { distance: 3.7 }), api = createHouseCreeperEscape(f.deps);
  const pause = () => { if (f.ticks() >= 5) { f.bot.removeListener('physicsTick', pause); f.pause(); } }; f.bot.on('physicsTick', pause);
  await assert.rejects(api.escape(), e => e.code === 'paused'); const count = f.attempts.length; await sleep(200);
  assert.equal(f.attempts.length, count); assert.equal(f.bot.pathfinder.goal, null); assert.ok(Object.values(f.bot.controlState).every(v => v === false));
  assert.ok(f.records.every(r => r.kind !== 'creeper_escape_confirmed'));
});
test('foreign profile and goal takeover is preserved; old escape performs no further control reset', { timeout: 6000 }, async t => {
  const f = fixture(t, { distance: 3.7 }); let replacement, foreignGoal, at;
  const take = () => {
    if (f.ticks() < 5) return; f.bot.removeListener('physicsTick', take); f.foreign(); replacement = new Movements(f.bot); replacement.canDig = false;
    foreignGoal = new goals.GoalBlock(0, 1, 4); f.bot.pathfinder.setMovements(replacement); f.bot.pathfinder.setGoal(foreignGoal); at = f.writes.length;
  }; f.bot.on('physicsTick', take);
  await assert.rejects(createHouseCreeperEscape(f.deps).escape(), e => e.code === 'house_creeper_escape_preempted'); await sleep(30);
  assert.equal(f.bot.pathfinder.movements, replacement); assert.equal(f.bot.pathfinder.goal, foreignGoal);
  assert.equal(f.writes.slice(at).filter(w => w.kind === 'clear').length, 0); assert.ok(f.records.every(r => r.kind !== 'creeper_escape_confirmed'));
});
test('actual in-flight fluid/low-health fails without safe credit or restarting native movement', { timeout: 6000 }, async t => {
  for (const mode of ['fluid', 'health']) {
    const f = fixture(t, { distance: 3.7 }); const change = () => {
      if (f.ticks() < 5) return; f.bot.removeListener('physicsTick', change);
      if (mode === 'health') f.bot.health = 15;
      else { const p = f.bot.entity.position.floored(); f.cells.set(p.toString(), 'water'); }
    }; f.bot.on('physicsTick', change);
    await assert.rejects(createHouseCreeperEscape(f.deps).escape(), e => ['house_creeper_escape_hazard', 'house_creeper_escape_survival_limit'].includes(e.code));
    assert.equal(f.attempts.length, 1); assert.ok(f.records.every(r => r.kind !== 'creeper_escape_confirmed'));
  }
});
test('original total deadline includes movement and does not extend for target arrival', { timeout: 6000 }, async t => {
  const f = fixture(t, { distance: 3.7, physicsMs: 30 });
  await assert.rejects(createHouseCreeperEscape(f.deps, { timeoutMs: 80 }).escape(), e => e.code === 'house_creeper_escape_timeout');
  await sleep(150); assert.equal(f.attempts.length, 1); assert.equal(f.bot.pathfinder.goal, null); assert.ok(f.records.every(r => r.kind !== 'creeper_escape_confirmed'));
});
test('delayed host wrapper cannot revive exact old native goal after timeout, without affecting foreign goals', { timeout: 6000 }, async t => {
  const f = fixture(t, { distance: 3.7 });
  f.deps.actualNativeGoto = async goal => { await sleep(300); return f.bot.pathfinder.goto(goal); };
  await assert.rejects(createHouseCreeperEscape(f.deps, { timeoutMs: 80 }).escape(), e => e.code === 'house_creeper_escape_timeout');
  const foreignGoal = new goals.GoalBlock(0, 1, 12); f.foreign(); f.bot.pathfinder.setGoal(foreignGoal); await sleep(350);
  assert.equal(f.attempts.length, 0, 'Delayed actual installed goto was denied before it could setGoal'); assert.equal(f.bot.pathfinder.goal, foreignGoal);
});
test('escaping primary cannot walk toward a second actual creeper; native perpendicular dry route remains possible', { timeout: 6000 }, async t => {
  const f = fixture(t); f.bot.entities[3] = { id: 3, name: 'creeper', isValid: true, position: new Vec3(-7.5, 1, .5) };
  const result = await createHouseCreeperEscape(f.deps).escape(); assert.ok(result.finalDistance >= 8.5); assert.ok(Math.abs(result.actual.z - .5) > 3);
  assert.ok(result.plan.path.every(p => p.x === 0));
});
test('a path only toward the initial threat is not an escape even if its far endpoint would be distant', async t => {
  const f = fixture(t, { distance: 3.7 });
  for (let x = -16; x <= 16; x++) for (let z = -16; z <= 16; z++) if (x < 0 || z !== 0) f.cells.set(new Vec3(x, 1, z).toString(), 'UNKNOWN');
  await assert.rejects(createHouseCreeperEscape(f.deps).escape(), e => e.code === 'house_creeper_escape_no_path'); assert.equal(f.attempts.length, 0);
});
test('a distant captured primary cannot mark already-safe while another actual creeper remains close', { timeout: 6000 }, async t => {
  const f = fixture(t, { distance: 10.5 }); f.bot.entities[3] = { id: 3, name: 'creeper', isValid: true, position: new Vec3(3.7, 1, .5) };
  const result = await createHouseCreeperEscape(f.deps).escape(); assert.ok(result.initialDistance < 3.21); assert.ok(result.finalDistance >= 8.5);
  assert.equal(result.alreadySafe, undefined); assert.equal(f.attempts.length, 1); assert.ok(result.traveled > 5);
});

test('whole32 rounded observed underground zombie cannot block escape from the actual surface zombie', { timeout: 6000 }, async t => {
  // Relative positions from recorded mc_world_context (rounded0.1m), using
  // explicit flat offline geometry. This is not the original loaded world.
  const f=fixture(t,{threatName:'zombie',distance:6.1});f.creeper.position.z=1.5;
  f.bot.entities[3]={id:3,name:'zombie',isValid:true,position:new Vec3(-7.5,-47,-12.8)};
  const result=await createHouseCreeperEscape(f.deps,{threatName:'zombie'}).escape();
  assert.equal(result.confirmed,true);assert.ok(result.finalDistance>=8.5);assert.ok(f.attempts.length>0);
  assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.pathfinder.movements,f.profile);
});
test('a previously deep entity entering actual nearby space is rechecked during native escape', { timeout: 6000 }, async t => {
  const f=fixture(t,{threatName:'zombie',distance:6.1});f.creeper.position.z=1.5;
  const deep={id:3,name:'creeper',isValid:true,position:new Vec3(-7.5,-47,-12.8)};f.bot.entities[3]=deep;
  let surfaced=false;f.bot.on('physicsTick',()=>{if(!surfaced&&f.attempts.length){surfaced=true;deep.position=f.bot.entity.position.offset(-1,0,0);}});
  await assert.rejects(createHouseCreeperEscape(f.deps,{threatName:'zombie'}).escape(),e=>e.code==='house_creeper_escape_approaching');
  assert.equal(surfaced,true);assert.equal(f.bot.pathfinder.goal,null);assert.ok(f.records.every(r=>r.kind!=='creeper_escape_confirmed'));
});

test('explicit low-health emergency retreat keeps native terrain bounds while ordinary exploration refuses',{timeout:6000},async t=>{
 const f=fixture(t);f.bot.health=.5;f.bot.food=10;
 await assert.rejects(createHouseCreeperEscape(f.deps).escape(),{code:'house_creeper_escape_survival_limit'});
 assert.equal(f.attempts.length,0);
 const result=await createHouseCreeperEscape(f.deps,{emergencyRetreat:true}).escape();
 assert.equal(result.confirmed,true);assert.ok(result.finalDistance>=8.5);assert.ok(result.traveled<=12);
 assert.equal(f.profile.canDig,false);assert.equal(f.profile.maxDropDown,2);assert.equal(f.bot.health,.5);
});

for(const cancel of [false,true])test(`a moving threat after native stop gets one fresh leg inside original budgets${cancel?' unless paused':''}`,{timeout:6000},async t=>{
 const f=fixture(t);let calls=0;
 f.deps.actualNativeGoto=async(goal,options)=>{
  const first=++calls===1;
  try{await f.bot.pathfinder.goto(goal);}catch(error){if(!options.isExpectedNativeStop())throw error;}
  // Independently scripted fixture mob motion after the captured old goal
  // settles. Bot movement still comes solely from installed native Physics.
  if(first)f.creeper.position.x-=1.5;
 };
 const originalRecord=f.deps.record;
 f.deps.record=(kind,value)=>{originalRecord(kind,value);if(cancel&&kind==='creeper_escape_live_replan')f.pause();};
 const escape=createHouseCreeperEscape(f.deps);
 if(cancel){await assert.rejects(escape.escape(),{code:'paused'});assert.equal(calls,1);}
 else{
  const result=await escape.escape();assert.equal(result.confirmed,true);assert.equal(calls,2);
  assert.ok(result.finalDistance>=8.5);assert.ok(result.traveled<=12);assert.ok(result.elapsedMs<4000);
  const plans=f.records.filter(x=>x.kind==='creeper_escape_plan');assert.ok(plans.reduce((n,x)=>n+x.facts.probes,0)<=8);
  assert.ok(plans.reduce((n,x)=>n+x.facts.planStats.planningElapsedMs,0)<=120);
  await assert.rejects(escape.escape(),{code:'house_creeper_escape_closed'});
 }
 assert.equal(f.records.filter(x=>x.kind==='creeper_escape_live_replan').length,1);
});

test('emergency nearby creeper cannot veto bounded native friction handoff by proximity alone',{timeout:6000},async t=>{
 const f=fixture(t,{distance:3.5,initialVelocity:new Vec3(-.11781015234537406,-.0784000015258789,0)});
 const r=await createHouseCreeperEscape(f.deps,{emergencyRetreat:true}).escape();
 assert.equal(r.confirmed,true);assert.ok(r.finalDistance>=8.5);assert.ok(r.traveled<=12);assert.ok(r.elapsedMs<=4000);
});
test('pursuing target can require three settled native legs without renewing original budgets',{timeout:6000},async t=>{
 const f=fixture(t);let calls=0;
 f.deps.actualNativeGoto=async(goal,options)=>{
  calls++;try{await f.bot.pathfinder.goto(goal);}catch(e){if(!options.isExpectedNativeStop())throw e;}
  if(calls<=2)f.creeper.position.x-=1.5;
 };
 const r=await createHouseCreeperEscape(f.deps).escape();assert.equal(r.confirmed,true);assert.equal(calls,3);
 assert.ok(r.traveled<=12);assert.ok(r.elapsedMs<=4000);assert.ok(f.records.filter(x=>x.kind==='creeper_escape_plan').reduce((n,x)=>n+x.facts.probes,0)<=8);
});

test('native emergency retreat can descend two adjacent one-block dry steps without a false shaft stop',{timeout:6000},async t=>{
 const f=fixture(t,{threatPosition:new Vec3(.5,1,6.5)});
 for(let x=-16;x<=16;x++)for(let z=-16;z<0;z++){
  f.cells.set(new Vec3(x,0,z).toString(),'air');
  if(z<-1)f.cells.set(new Vec3(x,-1,z).toString(),'air');
 }
 const result=await createHouseCreeperEscape(f.deps,{emergencyRetreat:true}).escape();
 assert.equal(result.confirmed,true);assert.ok(result.finalDistance>=8.5);
 assert.equal(f.bot.entity.onGround,true);assert.ok(f.samples.some(s=>s.position.y<-.9));
 assert.ok(f.bot.entity.position.y>=-1);assert.ok(result.traveled<=12);
});

test('native escape endpoint reached mid-step keeps its original guard until real landing, without safe credit on budget refusal',{timeout:7000},async t=>{
 const f=fixture(t,{distance:6.5,physicsMs:50,approaching:true,approachStep:.12});
 for(let x=-16;x<=16;x++)for(let z=-16;z<=16;z++){
  if(z!==0)for(let y=1;y<=4;y++)f.cells.set(new Vec3(x,y,z).toString(),'stone');
  else if(x<=-6)f.cells.set(new Vec3(x,1,z).toString(),'stone');
 }
 let result,error;try{result=await createHouseCreeperEscape(f.deps,{emergencyRetreat:true}).escape();}catch(e){error=e;}
 assert.equal(f.bot.entity.onGround,true,'The final integer cell is insufficient: wait for actual native landing before refusal/replan');
 assert.equal(f.bot.entity.position.y,2);assert.ok(f.samples.some(s=>!s.onGround));
 if(result){assert.equal(result.confirmed,true);assert.ok(result.finalDistance>=8.5);assert.ok(result.elapsedMs<=4000);}
 else{assert.equal(error.code,'house_creeper_escape_unconfirmed');assert.equal(error.nativeSettlement,'SETTLED');assert.equal(f.records.some(e=>e.kind==='creeper_escape_confirmed'),false);}
});

for(const proven of [false,true])test(`neutral polar bear escape requires the exact native self-damage proof: ${proven}`,{timeout:6000},async t=>{
 const f=fixture(t,{threatName:'polar_bear',distance:2.5});
 if(!proven){assert.throws(()=>createHouseCreeperEscape(f.deps,{threatName:'polar_bear',emergencyRetreat:true}),/exact native self-damage source/);assert.equal(f.attempts.length,0);return;}
 const {recordObservedSelfAggressor}=require('../vendor/server/minecraft/entitySemantics');
 assert.equal(recordObservedSelfAggressor(f.bot,f.bot.entity,f.creeper),true);
 const result=await createHouseCreeperEscape(f.deps,{threatName:'polar_bear',emergencyRetreat:true}).escape();
 assert.equal(result.confirmed,true);assert.ok(result.finalDistance>=8.5);assert.ok(result.traveled<=12);assert.ok(result.elapsedMs<=4000);
 assert.equal(f.bot.pathfinder.movements,f.profile);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.pathfinder.goal,null);
 assert.ok(f.samples.length>5);assert.equal(f.bot.entities[2],f.creeper);
});

test('world58 recorded fractional pose can retreat from a creeper without treating 7m zombies as blast threats',{timeout:6000},async t=>{
 const f=fixture(t,{initialPosition:new Vec3(.64661207700624,1,.0531841188896),threatPosition:new Vec3(.49380535686063,2,6.97326576060829)});
 const secondary=[{id:43,name:'zombie',position:new Vec3(-5.27382982292215,1.24934569001198,3.51182492103585)},
 {id:47,name:'zombie',position:new Vec3(-6.5865722360171,1.92159999847412,-.41691431732144)}];
 for(const e of secondary)f.bot.entities[e.id]={...e,type:'mob',isValid:true};
 const result=await createHouseCreeperEscape(f.deps,{emergencyRetreat:true}).escape();
 assert.equal(result.confirmed,true);assert.ok(result.finalDistance>=8.5);assert.ok(result.traveled<=12);assert.equal(f.bot.entity.onGround,true);
 assert.ok(f.samples.every(s=>secondary.every(e=>Math.hypot(s.position.x-e.position.x,s.position.z-e.position.z)>=4.5)));
 assert.ok(f.samples.some(s=>secondary.some(e=>Math.hypot(s.position.x-e.position.x,s.position.z-e.position.z)<8.5)));
});

test('unarmed melee retreat uses its contact separation while a secondary creeper retains blast separation', {timeout:6000}, async t=>{
 const f=fixture(t,{threatName:'zombie',distance:4,physicsMs:10});
 f.bot.entities[3]={id:3,name:'creeper',isValid:true,position:new Vec3(8,1,.5)};
 const result=await createHouseCreeperEscape(f.deps,{threatName:'zombie',safeDistance:6.5,emergencyRetreat:true}).escape();
 assert.equal(result.confirmed,true);assert.ok(result.finalDistance>=6.5);
 assert.ok(f.bot.entity.position.distanceTo(f.bot.entities[3].position)>=8.5);
 assert.ok(result.traveled<=12);assert.equal(f.bot.entity.onGround,true);
 assert.equal(f.bot.pathfinder.goal,null);
});

for(const aggressive of [true,false])test(`native enderman anger metadata permits early retreat without requiring a first injury: ${aggressive}`,{timeout:6000},async t=>{
 const f=fixture(t,{threatName:'enderman',distance:4});const keys=registry.entitiesByName.enderman.metadataKeys;
 f.creeper.metadata=[];f.creeper.metadata[keys.indexOf('creepy')]=aggressive;f.creeper.metadata[keys.indexOf('stared_at')]=false;
 if(!aggressive){assert.throws(()=>createHouseCreeperEscape(f.deps,{threatName:'enderman',safeDistance:6.5,emergencyRetreat:true}),TypeError);assert.equal(f.attempts.length,0);return;}
 const result=await createHouseCreeperEscape(f.deps,{threatName:'enderman',safeDistance:6.5,emergencyRetreat:true}).escape();
 assert.equal(result.confirmed,true);assert.ok(result.finalDistance>=6.5);assert.equal(f.bot.health,20);assert.equal(f.bot.entity.onGround,true);
 assert.ok(result.traveled<=12);assert.equal(f.bot.pathfinder.goal,null);
});

test('explicit emergency native sprint outruns a pursuing creeper within unchanged dry12m4s limits',{timeout:6500},async t=>{
 const f=fixture(t,{distance:6.5,approaching:true,approachStep:.20,physicsMs:50});
 let result;try{result=await createHouseCreeperEscape(f.deps,{emergencyRetreat:true,emergencySprinting:true}).escape();}
 catch(e){assert.fail(JSON.stringify({code:e.code,actual:f.bot.entity.position,sprintWrites:f.writes.filter(w=>w.name==='sprint'&&w.value).length,records:f.records.filter(r=>['creeper_escape_plan','creeper_escape_live_replan','creeper_escape_confirmed'].includes(r.kind)).map(r=>({kind:r.kind,target:r.facts.target,traveled:r.facts.traveled})),last:f.records.filter(r=>r.kind==='creeper_escape_tick').slice(-1)}));}
 assert.equal(result.confirmed,true);assert.ok(result.finalDistance>=8.5);assert.ok(result.traveled<=12);assert.ok(result.elapsedMs<=4000);
 assert.ok(f.writes.some(w=>w.name==='sprint'&&w.value===true));assert.equal(f.profile.allowSprinting,false);
 assert.equal(f.bot.controlState.sprint,false);assert.equal(f.bot.pathfinder.goal,null);assert.equal(f.bot.entity.onGround,true);
 assert.equal(f.profile.canDig,false);assert.equal(f.profile.allowParkour,false);assert.equal(f.profile.maxDropDown,2);
});

test('emergency sprint restores its restrictive profile after user pause',{timeout:6000},async t=>{
 const f=fixture(t,{distance:6.5,approaching:true,approachStep:.20,physicsMs:50});let paused=false;
 f.bot.on('physicsTick',()=>{if(!paused&&f.bot.controlState.sprint){paused=true;f.pause();}});
 await assert.rejects(createHouseCreeperEscape(f.deps,{emergencyRetreat:true,emergencySprinting:true}).escape(),{code:'paused'});
 assert.equal(paused,true);assert.equal(f.profile.allowSprinting,false);assert.equal(f.bot.pathfinder.goal,null);
});
test('native hunger gate cannot grant emergency sprint when food is6',{timeout:2000},async t=>{
 const f=fixture(t,{distance:6.5});f.bot.food=6;
 await assert.rejects(createHouseCreeperEscape(f.deps,{emergencyRetreat:true,emergencySprinting:true}).escape(),{code:'house_creeper_escape_survival_limit'});
 assert.equal(f.profile.allowSprinting,false);assert.equal(f.attempts.length,0);
});

test('failed sprint-grant diagnostics restore the exact original restrictive profile without movement',async t=>{
 const f=fixture(t,{distance:6.5});f.deps.record=()=>{throw Error('diagnostic write failed');};
 await assert.rejects(createHouseCreeperEscape(f.deps,{emergencyRetreat:true,emergencySprinting:true}).escape(),/diagnostic write failed/);
 assert.equal(f.profile.allowSprinting,false);assert.equal(f.attempts.length,0);
});

for(const emergency of [true,false])test(`saved96 actual ice support permits only emergency friction handoff inside original total budget: ${emergency}`,{timeout:6000},async t=>{
 // Recorded velocity/threat offset on an explicit flat ice fixture, not a full saved-terrain replay.
 // Read-only saved MCA independently confirms the real support cells were ice.
 const f=fixture(t,{threatName:'zombie',initialVelocity:new Vec3(.016203912589614906,-.0784000015258789,-.1777212242360293),threatPosition:new Vec3(-.4479001545852,1,6.2490501801849),physicsMs:50});
 for(let x=-16;x<=16;x++)for(let z=-16;z<=16;z++)f.cells.set(new Vec3(x,0,z).toString(),'ice');
 f.bot.health=13.166666030883789;f.bot.food=16;
 const run=createHouseCreeperEscape(f.deps,{threatName:'zombie',safeDistance:6.5,emergencyRetreat:true,emergencySprinting:emergency}).escape();
 if(!emergency){await assert.rejects(run,{code:'house_creeper_escape_braking_limit'});return;}
 const result=await run;assert.equal(result.confirmed,true);assert.ok(result.traveled<=12);assert.ok(result.elapsedMs<=4000);
 const braking=f.records.find(r=>r.kind==='dry_escape_braking_confirmed');assert.equal(braking.facts.iceBrake,true);assert.ok(braking.facts.traveled>.6&&braking.facts.traveled<=2.8);assert.ok(braking.facts.steps>=1);
 assert.equal(f.bot.entity.onGround,true);assert.equal(f.profile.allowSprinting,false);assert.equal(f.bot.pathfinder.goal,null);
});

test('recorded98 native airborne impulse over continuous ice remains bounded for sprint while ordinary walking retains its old guard',{timeout:3000},async t=>{
 // Initial airborne state and previous actual ground point are recorded native
 // observations. Flat ice is explicit fixture geometry, not full MCA replay.
 const f=fixture(t,{initialPosition:new Vec3(.0737369625165,1.275125,1.185624692557),initialVelocity:new Vec3(-.1930747,.191222503721714,.30165135),physicsMs:50});
 f.bot.entity.onGround=false; // Initial fixture setup before its first physics tick.
 for(let x=-16;x<=16;x++)for(let z=-16;z<=16;z++)f.cells.set(new Vec3(x,0,z).toString(),'ice');
 const {boundedNativeAirborneMotion}=require('../vendor/server/minecraft/houseCreeperEscape');
 const previous={position:{x:.2902369625165,y:1,z:.84737469255696},tick:0};let ticks=1,walkingRefused=false,airborne=0;
 const observe=()=>{ticks++;if(!f.bot.entity.onGround){airborne++;assert.equal(boundedNativeAirborneMotion(f.bot,{tick:ticks,lastGrounded:previous,sprinting:true}),true);
  if(!boundedNativeAirborneMotion(f.bot,{tick:ticks,lastGrounded:previous,sprinting:false}))walkingRefused=true;}};
 f.bot.on('physicsTick',observe);t.after(()=>f.bot.removeListener('physicsTick',observe));
 const deadline=Date.now()+1500;while(!f.bot.entity.onGround&&Date.now()<deadline)await sleep(10);
 assert.ok(airborne>0);assert.equal(walkingRefused,true);assert.equal(f.bot.entity.onGround,true);assert.equal(f.attempts.length,0);
 assert.ok(ticks<=16);
});
for(const mode of ['removed','native_health_zero','foreign'])test(`target loss during the initial native coast grants only a genuine idle receipt: ${mode}`,async t=>{
 const f=fixture(t,{initialVelocity:new Vec3(.06128314330408908,-.0784000015258789,-.06174936656721651),distance:4});let changed=false;
 f.bot.prependListener('physicsTick',()=>{if(changed)return;changed=true;if(mode==='foreign'){f.foreign();f.creeper.isValid=false;}else if(mode==='native_health_zero'){f.creeper.metadata=[];f.creeper.metadata[registry.entitiesByName.creeper.metadataKeys.indexOf('health')]=0;}else f.creeper.isValid=false;});
 const err=await createHouseCreeperEscape(f.deps,{emergencyRetreat:true,emergencySprinting:true}).escape().then(()=>null,e=>e);
 assert.ok(err);assert.equal(f.attempts.length,0);
 if(mode==='foreign'){assert.equal(err.code,'house_creeper_escape_preempted');assert.notEqual(err.nativeSettlement,'SETTLED');}
 else{assert.equal(err.code,'house_creeper_escape_threat_lost');assert.equal(err.nativeSettlement,'SETTLED');assert.equal(err.nativeGoalIssued,false);assert.equal(err.nativeIdleObserved,true);assert.ok(Math.hypot(f.bot.entity.velocity.x,f.bot.entity.velocity.z)<=.03);assert.equal(f.bot.entity.onGround,true);}
});

for(const mode of ['native','pause','foreign','unknown'])test(`world120 rising native impulse coast ${mode}`,{timeout:6000},async t=>{
 const f=fixture(t,{physicsMs:50,threatName:'zombie_villager',distance:4,initialVelocity:new Vec3(-.258375,.275125,.07675)});
 f.bot.health=3;
 if(mode==='pause')setTimeout(f.pause,60);
 if(mode==='foreign')setTimeout(f.foreign,60);
 if(mode==='unknown')f.cells.set('(-1, 0, 0)','UNKNOWN');
 const run=createHouseCreeperEscape(f.deps,{threatName:'zombie_villager',safeDistance:6.5,emergencyRetreat:true,emergencySprinting:true}).escape();
 if(mode==='native'){
  const result=await run;const coast=f.records.find(r=>r.kind==='dry_escape_braking_confirmed');
  assert.equal(coast.facts.risingBrake,true);assert.ok(coast.facts.traveled>0&&coast.facts.traveled<=3.5);
  assert.ok(f.samples.some(s=>!s.onGround));assert.ok(result.confirmed);
  assert.ok(f.attempts.every(a=>Math.hypot(a.velocity.x,a.velocity.z)<=.03));
 }else {await assert.rejects(run);assert.equal(f.attempts.length,0);}
});

test('world128 ice retreat prefers a confirmed straight native corridor under unchanged bounds',{timeout:6000},async t=>{
 const f=fixture(t,{physicsMs:50,distance:7.5,threatPosition:new Vec3(5.5,1,5.5)});
 for(let x=-16;x<=16;x++)for(let z=-16;z<=16;z++)f.cells.set(new Vec3(x,0,z).toString(),'ice');
 const r=await createHouseCreeperEscape(f.deps,{emergencyRetreat:true,emergencySprinting:true}).escape();
 const plan=f.records.find(e=>e.kind==='creeper_escape_plan');assert.equal(plan.facts.iceCorridorPreferred,true);
 assert.ok(plan.facts.target.x===0||plan.facts.target.z===0);assert.equal(r.confirmed,true);assert.ok(r.traveled<=12);assert.ok(r.elapsedMs<=4000);
});

for(const mode of ['emergency','ordinary','lowhealth','secondcreeper'])test(`world130 opposing threats bounded secondary yield: ${mode}`,{timeout:6000},async t=>{
 const f=fixture(t,{physicsMs:50,threatPosition:new Vec3(-6.8705325975866,0,-1.65295571845503)});
 f.bot.entities[3]={id:3,name:mode==='secondcreeper'?'creeper':'zombie',type:'mob',isValid:true,position:new Vec3(2.17246467782272,1.61801433381412,3.68511631694278)};
 if(mode==='lowhealth')f.bot.health=11;
 const run=createHouseCreeperEscape(f.deps,{emergencyRetreat:mode!=='ordinary',emergencySprinting:mode!=='ordinary'}).escape();
 if(mode==='emergency'){const r=await run;assert.ok(r.confirmed);assert.ok(r.traveled<=12);assert.ok(r.elapsedMs<=4000);const floor=f.records.find(r=>r.kind==='dry_escape_secondary_yield_floor');assert.ok(floor);assert.ok(floor.facts.minimumDistance>=2.75);assert.ok(floor.facts.initialDistance-floor.facts.minimumDistance<=.500001);}
 else{await assert.rejects(run);assert.equal(f.records.some(r=>r.kind==='dry_escape_secondary_yield_floor'),false);}
});


test('native stepped corridor stops unsafe forward inertia before its one-block landing',{timeout:6000},async t=>{
 const f=fixture(t,{physicsMs:50,initialPosition:new Vec3(.5,1,.5),threatName:'zombie',distance:6});
 for(let x=-16;x<=16;x++)for(let z=-2;z<=2;z++)for(let y=-4;y<=4;y++){
  const top=x<0?Math.max(-2,1+x):1;
  f.cells.set(new Vec3(x,y,z).toString(),z===0?(y<top?'stone':'air'):'stone');
 }
 const r=await createHouseCreeperEscape(f.deps,{threatName:'zombie',safeDistance:6.5,emergencyRetreat:true,emergencySprinting:true}).escape();
 assert.equal(r.confirmed,true);assert.ok(f.records.some(e=>e.kind==='creeper_escape_native_descent_brake'));assert.equal(f.bot.entity.onGround,true);assert.ok(r.traveled<=12);
});

test('world141 distant melee ring retains original safe-boundary approach rather than freezing all exits',{timeout:6000},async t=>{
 const p={x:-176.64303144059136,y:68,z:66.43345022654448};
 const relative=(x,y,z)=>new Vec3(x-p.x+.5,y-p.y+1,z-p.z+.5);
 const f=fixture(t,{physicsMs:50,threatPosition:relative(-175.4971352061981,68.02442408821369,62.790592639331024)});
 for(const [id,name,x,y,z]of [[72,'zombie',-176.5004604337487,65,56.785019420073084],[73,'zombie',-188.68818797686083,66,60.25660719811853],[74,'zombie',-177.19451744943223,67,52.70512895053904],[101,'zombie_villager',-179.61178819187364,66,78.0597828561638]])f.bot.entities[id]={id,name,isValid:true,position:relative(x,y,z)};
 const r=await createHouseCreeperEscape(f.deps,{emergencyRetreat:true,emergencySprinting:true}).escape();
 assert.equal(r.confirmed,true);assert.ok(r.traveled<=12);assert.ok(r.elapsedMs<=4000);assert.equal(f.records.some(e=>e.kind==='dry_escape_secondary_yield_floor'),false);
});

test('world146 emergency ice coast covers the admitted .35 native speed within unchanged total escape budget',{timeout:6000},async t=>{
 const f=fixture(t,{threatName:'zombie',initialVelocity:new Vec3(.35,-.0784000015258789,0),threatPosition:new Vec3(-5,1,.5),physicsMs:50});
 for(let x=-16;x<=16;x++)for(let z=-16;z<=16;z++)f.cells.set(new Vec3(x,0,z).toString(),'ice');
 const r=await createHouseCreeperEscape(f.deps,{threatName:'zombie',safeDistance:5,emergencyRetreat:true,emergencySprinting:true}).escape();
 assert.equal(r.confirmed,true);assert.ok(r.traveled<=12);assert.ok(r.elapsedMs<=4000);
 const c=f.records.find(r=>r.kind==='dry_escape_braking_confirmed');assert.ok(c.facts.traveled>2.8&&c.facts.traveled<=3.5);assert.ok(c.facts.ticks<=28);assert.equal(f.bot.entity.onGround,true);
});

test('ice coast tolerates bounded modeled repeated notifications inside original time and distance caps',{timeout:6000},async t=>{
 const f=fixture(t,{threatName:'zombie',initialVelocity:new Vec3(.35,-.0784000015258789,0),threatPosition:new Vec3(-5,1,.5),physicsMs:50});
 for(let x=-16;x<=16;x++)for(let z=-16;z<=16;z++)f.cells.set(new Vec3(x,0,z).toString(),'ice');
 const running=createHouseCreeperEscape(f.deps,{threatName:'zombie',safeDistance:5,emergencyRetreat:true,emergencySprinting:true}).escape();
 // Explicitly MODELED repeated observer notifications, not a reconstruction
 // of run166 packet scheduling. They never move the original Physics actor.
 for(let i=0;i<8;i++)f.bot.emit('physicsTick');
 const r=await running,c=f.records.find(e=>e.kind==='dry_escape_braking_confirmed');
 assert.equal(r.confirmed,true);assert.ok(c.facts.ticks>28&&c.facts.ticks<=34);
 assert.ok(c.facts.traveled<=3.5);assert.ok(c.facts.elapsedMs<=1700);assert.ok(r.traveled<=12);assert.ok(r.elapsedMs<=4000);
});

test('ordinary creeper packet approach cannot turn actual retreat into self-approach',{timeout:6000},async t=>{
 const f=fixture(t,{threatPosition:new Vec3(-7,1,.5),physicsMs:20});f.creeper.metadata=[];
 // MODELED single authoritative mob update during a native Physics retreat.
 // The original actor pose/velocity is never assigned by this fixture script.
 f.bot.prependOnceListener('physicsTick',()=>{f.creeper.position.x=-2;});
 const r=await createHouseCreeperEscape(f.deps,{emergencyRetreat:true,emergencySprinting:true}).escape();
 assert.equal(r.confirmed,true);assert.ok(r.finalDistance>=8.5);assert.ok(r.traveled<=12);assert.ok(r.elapsedMs<=4000);
 assert.ok(f.records.some(e=>e.kind==='dry_escape_primary_lateral_floor'));
 assert.ok(f.samples.every(e=>e.position.x>=.5));
});
