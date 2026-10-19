/* global require, setTimeout, setInterval, clearInterval */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'), { AsyncLocalStorage } = require('node:async_hooks');
const { Vec3 } = require('vec3'), { Physics, PlayerState } = require('prismarine-physics');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const registry = require('prismarine-registry')('1.21.8'), Block = require('prismarine-block')(registry);
const { createHouseCampConnector } = require('../vendor/server/minecraft/houseCampConnector');
const { hasGroundedBodySupport } = require('../vendor/server/minecraft/houseSurfaceGraph');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const anchor = { x: 0, y: 1, z: 0 };
const pkey = p => `${p.x},${p.y},${p.z}`;
const clone = v => JSON.parse(JSON.stringify(v));

// OFFLINE actual installed pathfinder/Physics, immutable controlled geometry.
// Only the initial bot state is assigned. Outbound and return motion is native;
// no live-server, constructed-house, GUI, or natural-resource claim is made.
function fixture(t, options = {}) {
  const context = new AsyncLocalStorage(), ownerContext = {}, foreignContext = {};
  let cp = null, cancelled = false, currentOwner = true, record = false, connector;
  const changes = new Map(), owned = new Set(), samples = [], moves = [], dryReturns = [], writes = [];
  const baseCells = new Map();
  for (const [x, y, name, properties] of [[3,1,'oak_slab',{type:'bottom',waterlogged:false}],
    [4,1,'oak_stairs',{facing:'east',half:'bottom',shape:'straight',waterlogged:false}],
    [5,2,'oak_slab',{type:'bottom',waterlogged:false}], [6,2,'oak_planks',{}],
    [7,3,'oak_slab',{type:'bottom',waterlogged:false}], [8,3,'oak_slab',{type:'bottom',waterlogged:false}]]) {
    // Under every upper step are actual owned blocks; no hovering slab is
    // treated as native reachable from an absent support column.
    for (let low = 1; low < y; low++) { baseCells.set(`${x},${low},0`, {name:'oak_planks',properties:{}}); owned.add(`${x},${low},0`); }
    baseCells.set(`${x},${y},0`,{name,properties}); owned.add(`${x},${y},0`);
  }
  const bot = Object.assign(new EventEmitter(), { registry, version:'1.21.8', health:20, food:20, oxygenLevel:20,
    username:'ConstructionConnector', _client:{state:'play',socket:{writable:true,destroyed:false}},
    game:{dimension:'overworld',minY:-64,height:384,gameMode:'survival'}, entities:{},players:{},player:{ping:1},
    jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,inventory:{slots:Array(46).fill(null),items:()=>[]},
    controlState:Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(k=>[k,false])),
    entity:{id:1,position:new Vec3(.5,1,.5),velocity:new Vec3(0,0,0),onGround:true,
      isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,
      yaw:0,pitch:0,eyeHeight:1.62,height:1.8,width:.6,effects:{},attributes:{},elytraFlying:false}});
  bot.blockAt = raw => {
    const p = raw.floored();
    if (p.x < -4 || p.x > 12 || Math.abs(p.z)>2 || p.y < -2 || p.y > 12) return null;
    const value = changes.has(pkey(p)) ? changes.get(pkey(p)) : baseCells.get(pkey(p)) || {name:p.y<1?'stone':'air',properties:{}};
    if (!value) return null;
    return Object.assign(Block.fromProperties(registry.blocksByName[value.name].id,value.properties||{},0),{position:p});
  };
  bot.look = async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;};
  bot.setControlState=(name,value)=>{writes.push({name,value,cancelled,owner:currentOwner,context:context.getStore()});bot.controlState[name]=value;};
  bot.clearControlStates=()=>{for(const name of Object.keys(bot.controlState))bot.setControlState(name,false);};
  bot.stopDigging=()=>{};bot.deactivateItem=()=>{};
  bot.physics=Physics(registry,{getBlock:bot.blockAt});pathfinder(bot);
  function houseProfile() {
    const movements=new Movements(bot);movements.canDig=false;movements.scafoldingBlocks=[];movements.allowParkour=false;
    movements.allow1by1towers=false;movements.allowFreeMotion=false;movements.allowSprinting=false;movements.maxDropDown=2;
    movements.infiniteLiquidDropdownDistance=false;movements.getMoveDiagonal=()=>{};
    movements.exclusionAreasStep.push(block=>block?.position?.z===0?0:Infinity);
    return movements;
  }
  const initialProfile=houseProfile();bot.pathfinder.setMovements(initialProfile);
  const nativeGoto=bot.pathfinder.goto.bind(bot.pathfinder);
  bot.pathfinder.goto=goal=>{moves.push({goal,from:bot.entity.position.clone()});return nativeGoto(goal);};
  const assertActive=()=>{if(cancelled)throw Object.assign(new Error('paused'),{code:'paused'});};
  const deps={getBot:()=>bot,assertActive,isOwnerCurrent:()=>currentOwner,isOwnerContext:()=>context.getStore()===ownerContext,
    getCheckpoint:()=>cp,saveCheckpoint:value=>{assertActive();assert.equal(currentOwner,true);cp=value;},
    isOwnedConstructionSupport:(p,b)=>owned.has(pkey(p))&&baseCells.get(pkey(p))?.name===b.name,
    withMovements:async(profile,action)=>{const previous=bot.pathfinder.movements;bot.pathfinder.setMovements(profile);
      try{return await action();}finally{if(currentOwner&&bot.pathfinder.movements===profile)bot.pathfinder.setMovements(previous);}},
    moveTo:async(position,proof)=>{
      if(options.delayMove)await options.delayMove();
      // Deliberately let the late native call use the installed pathfinder;
      // the connector must guard this real boundary even if the host forgot
      // to recheck after an unrelated asynchronous wait.
      if (hasGroundedBodySupport(bot) && proof.canAct(bot.entity.position)) return;
      const candidates=[];
      for(let x=Math.floor(position.x)-1;x<=Math.floor(position.x)+1;x++)for(let z=Math.floor(position.z)-1;z<=Math.floor(position.z)+1;z++)for(let y=Math.floor(position.y)-2;y<=Math.ceil(position.y);y++){
        const block=bot.blockAt(new Vec3(x,y,z));
        for(const shape of block?.shapes||[]){const feet=new Vec3(x+.5,y+shape[4],z+.5);
          if(proof.canAct(feet))candidates.push(new goals.GoalBlock(x,Math.ceil(feet.y-1e-6),z));}
      }
      await bot.pathfinder.goto(new goals.GoalCompositeAny(candidates));
      const deadline=Date.now()+600;
      while((!hasGroundedBodySupport(bot)||!proof.canAct(bot.entity.position))&&Date.now()<deadline){proof.assertActive();await sleep(5);}
    },
    returnDry:async via=>{dryReturns.push(clone(via));
      for(const p of [...via].reverse()){
        assertActive();await bot.pathfinder.goto(new goals.GoalBlock(p.x,p.y,p.z));
        const deadline=Date.now()+600;while(!hasGroundedBodySupport(bot)&&Date.now()<deadline)await sleep(5);
      }
    }};
  connector=createHouseCampConnector(deps,{anchor,taskId:'connector-task',...options.limits});
  const timer=setInterval(()=>{
    context.run(ownerContext,()=>{
      bot.physics.simulatePlayer(new PlayerState(bot,bot.controlState),{getBlock:bot.blockAt}).apply(bot);
      samples.push({position:bot.entity.position.clone(),grounded:bot.entity.onGround,wet:bot.entity.isInWater});
      if(record&&!cancelled&&currentOwner)connector.observe();bot.emit('physicsTick');
    });
  },5);
  t.after(()=>{clearInterval(timer);context.run(foreignContext,()=>{bot.pathfinder.setGoal(null);bot.clearControlStates();});connector.release();});
  async function outbound(last=8){record=true;
    await context.run(ownerContext,async()=>{
      connector.observe();
      for(let x=1;x<=last;x++){
        const feetY=x<3?1:x===3?1.5:x===4?2:x===5?2.5:x===6?3:3.5;
        await bot.pathfinder.goto(new goals.GoalBlock(x,Math.ceil(feetY-1e-6),0));
        const deadline=Date.now()+1000;
        while((!hasGroundedBodySupport(bot)||Math.abs(bot.entity.position.y-feetY)>.075)&&Date.now()<deadline)await sleep(5);
        assert.equal(hasGroundedBodySupport(bot),true);assert.ok(Math.abs(bot.entity.position.y-feetY)<=.075);
        connector.observe();
      }
    });record=false;return cp;
  }
  return{bot,deps,context,ownerContext,foreignContext,initialProfile,outbound,connector,samples,moves,dryReturns,writes,changes,
    cp:()=>clone(cp),pause:()=>{cancelled=true;},foreign:()=>{currentOwner=false;},
    run:action=>context.run(ownerContext,action)};
}

test('actual owned stairs and bottom-slab trail retains fractional feet and physically returns to dry camp', {timeout:12000}, async t=>{
  const f=fixture(t);const trace=await f.outbound();
  assert.equal(trace.invalidReason,undefined);assert.ok(trace.points.some(p=>Math.abs(p.position.y%1-.5)<1e-6));
  const before=f.moves.length; let result; try { result=await f.run(()=>f.connector.returnToCamp()); } catch (error) { t.diagnostic(JSON.stringify({errorFacts:error.observedMovement,points:trace.points,actual:f.bot.entity.position,moves:f.moves.slice(before).map(m=>({target:{x:m.goal.x,y:m.goal.y,z:m.goal.z},from:m.from}))})); throw error; }
  assert.equal(result.confirmed,true);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.position.floored().x,0);
  assert.equal(f.bot.entity.position.y,1);assert.ok(f.moves.length>before);
  assert.ok(f.moves.slice(before).some(m=>m.goal.goals?.some(g=>g.x===7&&g.y===4)),'Native node is ceil(3.5), while actual physics feet stay 3.5');
  assert.ok(f.samples.some(s=>s.grounded&&s.position.y===3.5));assert.ok(f.samples.every(s=>!s.wet));
  assert.ok(f.dryReturns[0].every(p=>Number.isInteger(p.y)&&p.x<=2),'Only the original natural dry prefix reaches the dry graph');
  assert.equal(f.bot.pathfinder.movements,f.initialProfile);assert.equal(f.cp().points.length,1);
});

test('restoring the captured task trail keeps fractional geometry without adopting a nearby foreign support', {timeout:12000}, async t=>{
  const f=fixture(t);await f.outbound(5);const saved=f.cp();
  const resumed=createHouseCampConnector(f.deps,{anchor,taskId:'connector-task'});
  assert.deepEqual(resumed.getState(),saved);
  await f.run(()=>resumed.returnToCamp());assert.equal(f.bot.entity.position.y,1);assert.equal(f.bot.entity.position.floored().x,0);resumed.release();
});

test('foreign replacement or missing native support rejects before a new return movement', {timeout:12000}, async t=>{
  const f=fixture(t);await f.outbound(5);const before=f.moves.length;
  f.changes.set('3,1,0',{name:'obsidian'});
  await assert.rejects(f.run(()=>f.connector.returnToCamp()),e=>e.code==='house_camp_connector_route_changed');
  assert.equal(f.moves.length,before);assert.equal(f.dryReturns.length,0);
  f.changes.set('3,1,0',null);
  await assert.rejects(f.run(()=>f.connector.returnToCamp()),e=>e.code==='house_camp_connector_route_changed');assert.equal(f.moves.length,before);
});

test('no captured camp trail and wrong task checkpoint cannot be converted to a two-point route', async t=>{
  const f=fixture(t);
  await assert.rejects(f.run(()=>f.connector.returnToCamp()),e=>e.code==='house_camp_connector_trail_missing');
  await f.outbound(3);
  assert.throws(()=>createHouseCampConnector(f.deps,{anchor,taskId:'other-task'}),e=>e.code==='house_camp_connector_checkpoint');
});

test('promise success without actual fractional arrival never credits a camp return', {timeout:12000}, async t=>{
  const f=fixture(t);await f.outbound(5);const before=f.cp();
  const connector=createHouseCampConnector({...f.deps,moveTo:async()=>{}},{anchor,taskId:'connector-task'});
  await assert.rejects(f.run(()=>connector.returnToCamp()),e=>e.code==='house_camp_connector_unconfirmed');
  assert.deepEqual(f.cp(),before);assert.equal(f.dryReturns.length,0);connector.release();
});

test('pause while host awaits cannot send a late native goto or write checkpoint facts', {timeout:12000}, async t=>{
  let resume;const wait=new Promise(resolve=>{resume=resolve;});
  const f=fixture(t,{delayMove:()=>wait});await f.outbound(5);const before=f.moves.length,cp=f.cp();
  const pending=f.run(()=>f.connector.returnToCamp());await sleep(20);f.pause();
  await assert.rejects(pending,e=>e.code==='paused');resume();await sleep(30);
  assert.equal(f.moves.length,before);assert.deepEqual(f.cp(),cp);assert.equal(f.dryReturns.length,0);
});

test('foreign profile and goal survive pending construction movement, including its late host promise', {timeout:12000}, async t=>{
  let resume;const wait=new Promise(resolve=>{resume=resolve;});
  const f=fixture(t,{delayMove:()=>wait});await f.outbound(5);const pending=f.run(()=>f.connector.returnToCamp());await sleep(20);
  const profile=new Movements(f.bot),goal=new goals.GoalBlock(9,4,0);
  f.context.run(f.foreignContext,()=>{f.foreign();f.bot.pathfinder.setMovements(profile);f.bot.pathfinder.setGoal(goal);});
  await assert.rejects(pending,e=>e.code==='house_camp_connector_preempted');
  const before=f.moves.length;resume();await sleep(30);
  assert.equal(f.moves.length,before);assert.equal(f.bot.pathfinder.movements,profile);assert.equal(f.bot.pathfinder.goal,goal);
  assert.equal(f.dryReturns.length,0);
});

test('finite native deadline closes delayed same-owner capability without blocking foreign native moves', {timeout:12000}, async t=>{
  let resume;const wait=new Promise(resolve=>{resume=resolve;});
  const f=fixture(t,{delayMove:()=>wait,limits:{legTimeoutMs:60}});await f.outbound(5);
  const before=f.moves.length,cp=f.cp();
  await assert.rejects(f.run(()=>f.connector.returnToCamp()),e=>e.code==='house_camp_connector_timeout');
  resume();await sleep(30);assert.equal(f.moves.length,before);assert.deepEqual(f.cp(),cp);
  const goal=new goals.GoalBlock(6,3,0);
  await f.context.run(f.foreignContext,()=>f.bot.pathfinder.goto(goal));
  assert.equal(f.moves.length,before+1);assert.equal(f.dryReturns.length,0);
});


test('dry suffix timeout also blocks an awaited late native goto from the captured owner', {timeout:12000}, async t=>{
  const f=fixture(t);await f.outbound(2);let resume;const wait=new Promise(resolve=>{resume=resolve;});
  const connector=createHouseCampConnector({...f.deps,returnDry:async()=>{await wait;await f.bot.pathfinder.goto(new goals.GoalBlock(0,1,0));}},
    {anchor,taskId:'connector-task',timeoutMs:60});
  const before=f.moves.length,cp=f.cp();
  await assert.rejects(f.run(()=>connector.returnToCamp()),e=>e.code==='house_camp_connector_timeout');
  resume();await sleep(30);assert.equal(f.moves.length,before);assert.deepEqual(f.cp(),cp);connector.release();
});

test('an actual native return stops on an unknown body cell without crediting the camp', {timeout:12000}, async t=>{
  const f=fixture(t);await f.outbound();const before=f.cp();let injected=false;
  const introduce=()=>{if(!injected&&f.bot.entity.position.x<7.6){injected=true;const p=f.bot.entity.position.floored().offset(0,1,0);f.changes.set(pkey(p),null);}};
  f.bot.on('physicsTick',introduce);
  await assert.rejects(f.run(()=>f.connector.returnToCamp()),e=>['house_camp_connector_hazard','house_camp_connector_route_changed'].includes(e.code));
  f.bot.removeListener('physicsTick',introduce);assert.equal(injected,true);assert.equal(f.dryReturns.length,0);assert.deepEqual(f.cp(),before);
});


test('removing the observed landing and slab support during native movement stops the dry connector', {timeout:12000}, async t=>{
  const f=fixture(t);await f.outbound();const before=f.cp();let injected=false;
  const remove=()=>{if(!injected&&f.bot.entity.position.x<7.6){injected=true;
    for(const p of ['6,2,0','7,3,0'])f.changes.set(p,{name:'air'});}};
  f.bot.on('physicsTick',remove);
  await assert.rejects(f.run(()=>f.connector.returnToCamp()),e=>['house_camp_connector_airshaft','house_camp_connector_route_changed'].includes(e.code));
  f.bot.removeListener('physicsTick',remove);assert.equal(injected,true);assert.equal(f.dryReturns.length,0);assert.deepEqual(f.cp(),before);
});
