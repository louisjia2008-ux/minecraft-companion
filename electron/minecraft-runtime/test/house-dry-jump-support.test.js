/* global require, setInterval, clearInterval */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Physics, PlayerState } = require('prismarine-physics');
const { Vec3 } = require('vec3');
const { pathfinder } = require('mineflayer-pathfinder');
const { data, createSavedJumpFixture } = require('../test-support/whole11-saved-dry-jump.cjs');
const { inspectDryJumpSupport, inspectDryDescentSupport, inspectSurfaceBody, hasGroundedBodySupport,
  createLoadedDryGraph } = require('../vendor/server/minecraft/houseSurfaceGraph');
const clone = value => JSON.parse(JSON.stringify(value));
const options = () => ({ tick: data.physicsTick, lastGrounded: clone(data.lastGrounded) });
const inspect = (f, extra = {}) => inspectDryJumpSupport(f.bot, { ...options(), ...extra });
const at = (p, target) => ['x','y','z'].every(k => p[k] === target[k]);
function replaceCells(f, predicate, value) {
  const original = f.bot.blockAt, Block = require('prismarine-block')(f.bot.registry);
  f.bot.blockAt = raw => {
    const p = raw.floored();
    if (!predicate(p)) return original(p);
    if (value === null) return null;
    const spec = typeof value === 'string' ? { name: value, properties: {} } : value;
    return Object.assign(Block.fromProperties(f.bot.registry.blocksByName[spec.name].id, spec.properties, 0), { position: p });
  };
  f.world.getBlock = f.bot.blockAt;
}
function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
function nativeLanding(f, limit = 16) {
  const state = new PlayerState(f.bot, clone(f.controls)); state.attributes = clone(state.attributes);
  const physics = Physics(f.bot.registry, f.world), points = [];
  for (let n = 1; n <= limit; n++) {
    try { physics.simulatePlayer(state, f.world); } catch(error) {
      if(error.code==='saved_fixture_unknown') return { state, points, landed:false, unknown:true };
      throw error;
    }
    points.push({ tick: n, position: { ...state.pos }, velocity: { ...state.vel }, onGround: state.onGround,
      isInWater: state.isInWater, isInLava: state.isInLava });
    const projected = Object.create(f.bot);
    projected.entity = { ...f.bot.entity, position:state.pos, velocity:state.vel, onGround:state.onGround,
      isInWater:state.isInWater, isInLava:state.isInLava };
    // Native onGround can describe a vertical collision before this tick's
    // horizontal motion carries the AABB off its edge. Require real contact.
    if (state.onGround && hasGroundedBodySupport(projected)) return { state, points, landed: true };
  }
  return { state, points, landed: false };
}

test('whole11 saved rising edge admits an explicit normal-jump scenario with an eleven-tick native landing witness', () => {
  const f = createSavedJumpFixture(), before = clone({ entity: f.bot.entity, controls: f.controls });
  assert.equal(data.actualControls, 'UNKNOWN'); assert.equal(data.actualYaw, 'UNKNOWN');
  assert.equal(data.actualPendingPath, 'UNKNOWN');
  assert.equal(inspectSurfaceBody(f.bot).dry, true); assert.equal(hasGroundedBodySupport(f.bot), false);
  assert.equal(inspectDryDescentSupport(f.bot, options()).accepted, false);
  for (const down of [1,2]) assert.equal(f.bot.blockAt(f.bot.entity.position.floored().offset(0,-down,0)).name, 'air');
  const result = inspect(f), independently = nativeLanding(f);
  assert.equal(result.accepted, true); assert.equal(result.predictionApplied, false); assert.equal(result.actualGrounded, false);
  assert.equal(result.predictions.length, 11); assert.equal(independently.points.length, 11);
  assert.equal(independently.state.onGround, true); assert.equal(independently.state.pos.y, 66);
  assert.equal(independently.state.isInWater, false); assert.equal(independently.state.isInLava, false);
  assert.deepEqual({ ...independently.state.pos }, result.predictions.at(-1).position);
  assert.ok(result.predictions.at(-1).contacts.some(c => at(c.position, data.lastGrounded.contacts[0].position)));
  assert.deepEqual(clone({ entity: f.bot.entity, controls: f.controls }), before);
  assert.equal(f.bot.entity.onGround, false);
});

test('576 explicit yaw/control inputs are checked against independently simulated native landings', () => {
  let scenarios = 0, accepted = 0, rejected = 0;
  for (let turn = 0; turn < 8; turn++) for (const horizontal of [{}, {forward:true}, {back:true}, {left:true}, {right:true},
    {forward:true,left:true}, {forward:true,right:true}, {back:true,left:true}, {back:true,right:true}]) {
    for (const jump of [false,true]) for (const sprint of [false,true]) for (const sneak of [false,true]) {
      const f = createSavedJumpFixture({ yaw: turn*Math.PI/4, controls: { ...horizontal, jump, sprint, sneak } });
      const before = clone({ entity:f.bot.entity, controls:f.controls }), result = inspect(f), native = nativeLanding(f);
      if (result.accepted) {
        accepted++; assert.equal(native.landed, true, `scenario ${scenarios}`);
        assert.equal(native.state.isInWater, false); assert.equal(native.state.isInLava, false);
        assert.ok(native.state.pos.y >= 65 && native.state.pos.y <= 67);
        assert.deepEqual(result.predictions.at(-1).position, { ...native.state.pos });
      } else {
        rejected++;
        assert.ok(!native.landed || native.state.pos.y < 65 || Math.hypot(native.state.pos.x-data.lastGrounded.position.x,
          native.state.pos.z-data.lastGrounded.position.z) > 2.5, `a safe nearby native landing was rejected in scenario ${scenarios}`);
      }
      assert.deepEqual(clone({ entity:f.bot.entity, controls:f.controls }), before); scenarios++;
    }
  }
  assert.equal(scenarios,576); assert.equal(accepted,464); assert.equal(rejected,112);
});

test('actual native ascending, apex and descending states keep their original physics until real landing', () => {
  const f = createSavedJumpFixture({ controls: { jump:true } }), before = clone(f.controls);
  let rises=0, descents=0, inspected=0;
  for (let n=0;n<16&&!f.bot.entity.onGround;n++) {
    const result = inspect(f, { tick:data.physicsTick+n });
    assert.equal(result.accepted,true, `native tick ${n}: ${result.reason}`);
    assert.equal(f.bot.entity.onGround,false); inspected++;
    if (f.bot.entity.velocity.y>0) rises++; else descents++;
    const state=new PlayerState(f.bot,f.controls); state.attributes=clone(state.attributes);
    f.bot.physics.simulatePlayer(state,f.world).apply(f.bot);
  }
  assert.equal(inspected,11); assert.ok(rises>0&&descents>0); assert.equal(f.bot.entity.position.y,66);
  assert.equal(f.bot.entity.onGround,true); assert.deepEqual(f.controls,before);
  // Held jump triggers the next real native takeoff only after actual landing.
  const state = new PlayerState(f.bot,f.controls); state.attributes=clone(state.attributes);
  f.bot.physics.simulatePlayer(state,f.world).apply(f.bot);
  assert.equal(f.bot.entity.onGround,false); assert.ok(f.bot.entity.velocity.y>0);
  const next=inspect(f,{tick:data.physicsTick+12,lastGrounded:{...clone(data.lastGrounded),tick:data.physicsTick+11,
    position:{...data.lastGrounded.position,z:data.initial.position.z}}});
  assert.equal(next.accepted,true); assert.equal(next.actualGrounded,false);
});

for (const [label, change] of [
  ['missing contact',o=>{o.lastGrounded=null;}], ['stale contact',o=>{o.tick=data.lastGrounded.tick+17;}],
  ['future contact',o=>{o.tick=data.lastGrounded.tick-1;}], ['same tick contact',o=>{o.tick=data.lastGrounded.tick;}],
  ['far contact',o=>{o.lastGrounded.position.x+=2;}],
  ['excessive ascent',o=>{o.lastGrounded.position.y=data.initial.position.y-1.301;}],
  ['actual feet already below contact',o=>{o.lastGrounded.position.y=data.initial.position.y+.01;}],
]) test(`${label} cannot authorize a dry jump`,()=>{
  const f=createSavedJumpFixture(),o=options();change(o);
  const result=inspectDryJumpSupport(f.bot,o);assert.equal(result.accepted,false);assert.equal(result.predictions.length,0);
});

for(const [label,setup]of [
  ['too fast up',f=>{f.bot.entity.velocity.y=.431;}], ['too fast down',f=>{f.bot.entity.velocity.y=-.501;}],
  ['too fast horizontally',f=>{f.bot.entity.velocity.x=.251;}], ['unknown yaw',f=>{f.bot.entity.yaw=NaN;}],
  ['unknown pitch',f=>{f.bot.entity.pitch=NaN;}], ['unknown controls',f=>{delete f.controls.forward;}],
  ['wet actual body',f=>{f.bot.entity.isInWater=true;}], ['lava actual body',f=>{f.bot.entity.isInLava=true;}],
  ['already grounded',f=>{f.bot.entity.onGround=true;}],
])test(`${label} fails closed without a jump witness`,()=>{
  const f=createSavedJumpFixture();setup(f);const result=inspect(f);
  assert.equal(result.accepted,false);assert.equal(result.predictions.length,0);
});

for(const value of [null,'air','stone','water','lava','magma_block',
  {name:'oak_slab',properties:{type:'top',waterlogged:false}}])test(`changed true grounded support ${JSON.stringify(value)} is rejected`,()=>{
  const f=createSavedJumpFixture();replaceCells(f,p=>at(p,data.lastGrounded.contacts[0].position),value);
  assert.equal(inspect(f).accepted,false);
});

test('below1 and below2 remain strictly loaded AIR rather than granting arbitrary new descent depth',()=>{
  for(const down of [1,2])for(const value of [null,'stone','water','lava','magma_block']){
    const f=createSavedJumpFixture(),p=f.bot.entity.position.floored().offset(0,-down,0);
    replaceCells(f,q=>at(q,p),value);assert.equal(inspect(f).accepted,false);
  }
});

test('source water, lava, magma, waterlogged and UNKNOWN entered after takeoff cannot borrow native jump prediction',()=>{
  for(const value of [null,'water','lava','magma_block',{name:'oak_slab',properties:{type:'top',waterlogged:true}}]) {
    const f=createSavedJumpFixture({yaw:Math.PI/2,controls:{forward:true}});
    // The actual AABB is x98.0..98.6. Native horizontal inputs then enter x97.
    replaceCells(f,p=>p.x===97&&p.y>=65&&p.y<=68,value);
    assert.equal(inspectSurfaceBody(f.bot).dry,true);
    const result=inspect(f);assert.equal(result.accepted,false);assert.equal(result.reason,'dry_jump_unknown_or_hazard');
  }
});

test('removed future landing shapes and multiple directions into a shaft remain unconfirmed',()=>{
  let rejected=0;
  for(let turn=0;turn<8;turn++) {
    const f=createSavedJumpFixture({yaw:turn*Math.PI/4,controls:{forward:true}});
    const old=data.lastGrounded.contacts[0].position;
    // Keep the old actual contact. Every other nearby floor is a loaded shaft.
    replaceCells(f,p=>p.y<=67&&!at(p,old),'air');
    const result=inspect(f);
    if(!result.accepted) { rejected++; assert.ok(['jump_prediction_outside_edge_limit','jump_native_landing_unconfirmed'].includes(result.reason)); }
    else { const native=nativeLanding(f);assert.equal(native.landed,true);assert.equal(native.state.pos.y,66); }
  }
  assert.ok(rejected>=4,'native directional inputs leading off the retained edge must fail closed');
});

test('protected native trajectory and protected touchdown are rejected before giving witness credit',()=>{
  const f=createSavedJumpFixture();
  assert.equal(inspect(f,{excluded:p=>p.y===67}).accepted,false);
  assert.equal(inspect(f,{excluded:p=>p.y===66&&p.x===98&&p.z===-191}).accepted,false);
});

test('ownership preemption before, during and after a block read prevents all prediction credit and writes',()=>{
  for(const cut of [0,1,4,10]) {
    const f=createSavedJumpFixture(),original=f.bot.blockAt;let reads=0,owner=true,writes=0;
    f.bot.blockAt=p=>{reads++;const b=original(p);if(reads===cut)owner=false;return b;};
    for(const action of ['setControlState','clearControlStates','look','stopDigging','activateItem'])f.bot[action]=()=>{writes++;};
    f.bot._client={write:()=>{writes++;}};
    if(!cut)owner=false;
    const result=inspect(f,{body:inspectSurfaceBody(createSavedJumpFixture().bot),isOwnerCurrent:()=>owner});
    assert.equal(result.accepted,false);assert.equal(result.reason,'dry_graph_movement_preempted');assert.equal(writes,0);
    assert.equal(reads,cut);assert.equal(f.bot.entity.onGround,false);
  }
});

test('read-only native prediction preserves frozen attributes, controls, inventory, metadata and actor',()=>{
  const f=createSavedJumpFixture({controls:{sprint:true}});
  f.bot.entity.attributes={ [f.bot.physics.movementSpeedAttribute]:{value:.1,modifiers:[{uuid:f.bot.physics.sprintingUUID,amount:.3,operation:2}]} };
  f.bot.entity.metadata={air:300};
  for(const value of [f.bot.entity,f.controls,f.bot.inventory.slots])freezeDeep(value);
  const before=clone({entity:f.bot.entity,controls:f.controls,slots:f.bot.inventory.slots});let writes=0;
  for(const name of ['setControlState','clearControlStates','look','stopDigging','activateItem']) f.bot[name]=()=>{writes++;throw Error('prediction native action');};
  f.bot._client={write:()=>{writes++;throw Error('prediction packet');}};
  assert.equal(inspect(f).accepted,true);assert.equal(writes,0);
  assert.deepEqual(clone({entity:f.bot.entity,controls:f.controls,slots:f.bot.inventory.slots}),before);
});

test('actual native path guard failure snapshots yaw, controls and remaining original path before owned stop',{timeout:5000},async t=>{
  const f=createSavedJumpFixture(),Block=require('prismarine-block')(f.bot.registry),bot=Object.assign(new EventEmitter(),f.bot);
  // Synthetic flat native fixture, initialized once. Every later actor change
  // is installed Physics/PlayerState.apply, with the installed pathfinder.
  bot.entity={...bot.entity,position:new Vec3(.5,1,.5),velocity:new Vec3(0,0,0),onGround:true};
  bot.game.gameMode='survival';bot.entities={};bot.players={};bot.player={ping:1};
  bot._client={state:'play',socket:{writable:true,destroyed:false}};let hazard=false;
  bot.blockAt=raw=>{const p=raw.floored(),name=hazard&&p.x>=2&&p.y===1?'lava':p.y<1?'stone':'air';
    return Object.assign(Block.fromStateId(bot.registry.blocksByName[name].defaultState),{position:p});};
  bot.look=async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;};
  bot.setControlState=(name,value)=>{bot.controlState[name]=value;};
  bot.clearControlStates=()=>{for(const name of Object.keys(bot.controlState))bot.controlState[name]=false;};
  bot.stopDigging=()=>{};bot.deactivateItem=()=>{};
  const world={getBlock:bot.blockAt};bot.physics=Physics(bot.registry,world);pathfinder(bot);
  const timer=setInterval(()=>{bot.physics.simulatePlayer(new PlayerState(bot,bot.controlState),world).apply(bot);
    if(bot.entity.position.x>1.9)hazard=true;bot.emit('physicsTick');},10);
  t.after(()=>{clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();});
  const anchor={x:0,y:1,z:0},id='0,1,0',checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,
    nodes:{[id]:{position:anchor,parent:null,expanded:true}},order:[id],current:id,resumeNode:id,visits:1,probes:0,
    frontier:[{parent:id,target:{x:16,y:1,z:0},plannedSteps:16}],blockedEdges:[]};
  const failures=[],graph=createLoadedDryGraph({getBot:()=>bot,assertActive:()=>{},getCheckpoint:()=>checkpoint,onFailure:e=>failures.push(e)}, {anchor,nativeReachableHints:true});
  await assert.rejects(graph.next(),e=>e.code==='dry_graph_hazard');
  assert.equal(failures.length,1);const observed=failures[0].observedMovement;
  assert.equal(typeof observed.yaw,'number');assert.equal(typeof observed.pitch,'number');
  assert.equal(Object.keys(observed.controls).length,7);assert.ok(Object.values(observed.controls).every(v=>typeof v==='boolean'));
  assert.equal(observed.pendingPath.available,true);assert.ok(observed.pendingPath.remainingCount>0);
  assert.ok(observed.pendingPath.points.length>0&&observed.pendingPath.points.length<=32);
  assert.ok(observed.controls.forward||observed.controls.back||observed.controls.left||observed.controls.right);
  assert.equal(bot.pathfinder.goal,null);assert.ok(Object.values(bot.controlState).every(v=>v===false));
  assert.equal(bot.listenerCount('path_update'),0);assert.equal(bot.listenerCount('path_reset'),0);
});

test('saved geometry is finite and missing geometry stays UNKNOWN',()=>{
  const f=createSavedJumpFixture();
  assert.throws(()=>f.bot.blockAt(new Vec3(data.bounds.minX-1,66,-191)),e=>e.code==='saved_fixture_unknown');
});
