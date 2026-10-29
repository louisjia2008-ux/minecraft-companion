/* global require, setInterval, clearInterval, setTimeout */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {Vec3}=require('vec3'),{Physics,PlayerState}=require('prismarine-physics');
const {pathfinder,Movements,goals}=require('mineflayer-pathfinder');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {createLoadedDryGraph,runSurfaceGraphNativeProbe}=require('../vendor/server/minecraft/houseSurfaceGraph');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const point=p=>({x:p.x,y:p.y,z:p.z});

// CONTRACT MODEL of the host's owned-defense handoff, not a simulated success:
// both retreat and continuation use installed pathfinder + original Physics.
// Only the host ownership/suspension witness and live policy change are modeled.
// No actor position/velocity writes after this one initial setup; no path/probe
// result substitution. The mining integration regression exercises real defense.
async function fixture(t,mode='changed',{legTimeoutMs=4000}={}) {
  let owner=true,suspended=false,changed=false,terrain='normal',cancelled=false,ticks=0,cp;
  const controls=Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(k=>[k,false]));
  const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',username:'DeskPet',health:20,food:20,oxygenLevel:20,
    game:{minY:-64,height:384,dimension:'overworld',gameMode:'survival'},entities:{},players:{},jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,
    player:{ping:1},_client:{state:'play',socket:{writable:true,destroyed:false}},controlState:controls,
    entity:{position:new Vec3(.5,1,.5),velocity:new Vec3(0,0,0),onGround:true,eyeHeight:1.62,height:1.8,width:.6,yaw:0,pitch:0,
      effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false},
    inventory:{slots:Array(46).fill(null),items:()=>[]}});
  bot.blockAt=raw=>{const p=raw.floored();
    if(terrain==='unknown'&&p.x===-2)return null;
    const name=terrain==='hazard'&&p.x===-2&&p.y===1?'lava':p.y<1&&Math.abs(p.z)<=1?'stone':'air';
    return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:p});};
  bot.look=async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;};
  bot.setControlState=(name,value)=>{controls[name]=value;};
  bot.clearControlStates=()=>{for(const name of Object.keys(controls))controls[name]=false;};
  bot.stopDigging=()=>{};bot.deactivateItem=()=>{};
  bot.physics=Physics(registry,{getBlock:bot.blockAt});pathfinder(bot);
  const nativeGoto=bot.pathfinder.goto.bind(bot.pathfinder),nativeGoals=[],moves=[],changes=[],continuations=[],readyCalls=[],frames=[];
  bot.pathfinder.goto=goal=>{nativeGoals.push({target:point(goal),at:Date.now()});return nativeGoto(goal);};
  const timer=setInterval(()=>{bot.physics.simulatePlayer(new PlayerState(bot,controls),{getBlock:bot.blockAt}).apply(bot);
    ticks++;frames.push({at:Date.now(),position:point(bot.entity.position),onGround:bot.entity.onGround});bot.emit('physicsTick');},10);
  let graph,pending,callback,witness,readyAtHandoff,first=true;
  t.after(async()=>{cancelled=true;clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();
    if(pending)await Promise.race([pending.catch(()=>{}),sleep(500).then(()=>{throw Error('owned model adapter failed to join');})]);});
  const anchor={x:0,y:1,z:0},target={x:2,y:1,z:0};
  // Retain only a real planning observation from the actual occupied anchor.
  const planned=runSurfaceGraphNativeProbe(bot,new Movements(bot),new goals.GoalBlock(2,1,0),{
    assertActive:()=>{if(cancelled)throw Object.assign(Error('cancelled'),{code:'cancelled'});},
    isOwnerCurrent:()=>owner&&!cancelled&&bot.pathfinder.goal===null});
  assert.equal(planned.facts.conclusive,true);assert.equal(planned.result.status,'success');
  cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:64,step:8,
    nodes:{'0,1,0':{position:anchor,parent:null,expanded:true}},order:['0,1,0'],
    frontier:[{parent:'0,1,0',target,plannedSteps:planned.result.path.length}],blockedEdges:[],current:'0,1,0',resumeNode:'0,1,0',visits:1,probes:1};
  const deps={getBot:()=>bot,getCheckpoint:()=>cp,setCheckpoint:value=>{cp=value;},
    assertActive:()=>{if(cancelled)throw Object.assign(Error('cancelled'),{code:'cancelled'});},
    isMovementOwner:()=>owner,isMovementSuspended:()=>suspended,
    isStepAllowed:p=>!changed||mode==='still_safe'||p.x<0,
    ready:async options=>{readyCalls.push({options,at:Date.now()});
      if(options&&mode==='readiness_expired')await sleep(Math.max(0,options.deadline-Date.now()+1));},
    onPostDefenseTargetChanged:value=>changes.push(value),onPostDefenseContinuation:value=>continuations.push(value),
    actualnativegoto:(goal,profile,options)=>{
      moves.push({target:point(goal),deadline:options.deadline,at:Date.now(),hasHook:typeof options.onOwnedRangedRetreat==='function'});
      const operation=(async()=>{
        if(!first)return bot.pathfinder.goto(goal);first=false;
        callback=options.onOwnedRangedRetreat;assert.equal(typeof callback,'function');
        const from=point(bot.entity.position);suspended=true;
        await bot.pathfinder.goto(new goals.GoalBlock(-2,1,0));
        while((bot.entity.velocity.x!==0||bot.entity.velocity.z!==0||!bot.entity.onGround)&&Date.now()<options.deadline)await sleep(10);
        assert.equal(bot.pathfinder.goal,null);changed=true;
        if(mode==='airborne'){bot.setControlState('jump',true);const before=ticks;while(ticks===before)await sleep(1);bot.setControlState('jump',false);}
        if(mode==='hazard'||mode==='unknown')terrain=mode;
        if(mode==='foreign')owner=false;
        if(mode==='paused')cancelled=true;
        if(mode==='profile')bot.pathfinder.setMovements(new Movements(bot));
        witness={kind:'actual_owned_ranged_retreat',bot,goal,movements:profile,from,actual:point(bot.entity.position),
          deadline:options.deadline,observedAt:Date.now(),maximumDisplacement:32,maximumVerticalDisplacement:8};
        if(mode==='wrong_bot')witness.bot={};
        if(mode==='wrong_goal')witness.goal=new goals.GoalBlock(goal.x,goal.y,goal.z);
        if(mode==='wrong_deadline')witness.deadline++;
        if(mode==='outside_displacement')witness.from={x:100,y:1,z:.5};
        if(mode==='stale')witness.observedAt-=2001;
        if(mode==='expired')await sleep(Math.max(0,options.deadline-Date.now()+1));
        suspended=false;readyAtHandoff=readyCalls.length;
        if(mode==='forged')throw Object.assign(Error('serialized error is not a capability'),{code:'dry_graph_post_defense_target_changed'});
        callback(witness);
        return bot.pathfinder.goto(goal);
      })();
      pending=operation;operation.catch(()=>{});return operation;
    }};
  graph=createLoadedDryGraph(deps,{anchor,step:8,radius:64,legTimeoutMs});
  return {bot,graph,moves,nativeGoals,changes,continuations,readyCalls,frames,get ticks(){return ticks;},
    callback:()=>callback,witness:()=>witness,get readyAtHandoff(){return readyAtHandoff;},join:async()=>pending?.catch(()=>{}),checkpoint:()=>cp};
}

test('owned retreat invalidates only the old target and really continues under the same deadline',{timeout:7000},async t=>{
  const f=await fixture(t),result=await f.graph.next(),state=f.graph.getState();
  assert.equal(result.moved,true);assert.equal(f.changes.length,1);assert.equal(f.continuations.length,1);
  const changed=f.changes[0],continued=f.continuations[0];
  assert.deepEqual(changed.abandonedTarget,{x:2,y:1,z:0});assert.equal(changed.oldEdgeTraversalCredit,false);assert.equal(changed.materialCredit,false);
  assert.equal(continued.arrivalConfirmed,true);assert.deepEqual(continued.actual,result.actual);assert.ok(result.actual.x<-2);
  assert.equal(continued.originalDeadline,f.moves[0].deadline);assert.ok(continued.observedAt<continued.originalDeadline);
  assert.ok(f.moves.every(move=>move.deadline===f.moves[0].deadline));
  assert.ok(f.readyCalls.some(call=>call.options?.deadline===f.moves[0].deadline));
  assert.ok(f.nativeGoals.every(move=>move.target.x<0));assert.equal(state.nodes['2,1,0'],undefined);
  assert.equal(state.nodes['-2,1,0'].survivalRelocation.oldEdgeTraversalCredit,false);
  assert.equal(state.nodes['-2,1,0'].dryParentTrail,undefined);assert.equal(state.visits,3);
  assert.ok(f.frames.length>20);assert.equal(f.bot.entity.onGround,true);
  const before=JSON.stringify(state);
  assert.throws(()=>f.callback()(f.witness()));assert.equal(JSON.stringify(f.graph.getState()),before,'closed capability cannot be reused');
});

test('still-admissible target retains ordinary real native resume',{timeout:7000},async t=>{
  const f=await fixture(t,'still_safe'),result=await f.graph.next();
  assert.equal(result.moved,true);assert.deepEqual(result.actual,{x:2,y:1,z:0});assert.equal(f.changes.length,0);
  assert.deepEqual(f.nativeGoals.map(v=>v.target),[{x:-2,y:1,z:0},{x:2,y:1,z:0}]);assert.equal(f.graph.getState().visits,2);
  const returned=await f.graph.returnToAnchor();assert.equal(returned.confirmed,true);
  assert.equal(f.moves.at(-1).hasHook,false,'explicit observed return has no relocation capability');
});

for(const mode of ['foreign','paused','profile','wrong_bot','wrong_goal','wrong_deadline','outside_displacement','stale','forged','hazard','unknown','airborne'])
test(`post-defense handoff fails closed without old-target replay or landing credit: ${mode}`,{timeout:5000},async t=>{
  const f=await fixture(t,mode);
  await assert.rejects(f.graph.next(),error=>['dry_graph_ranged_return_invalid','dry_graph_movement_preempted',...(mode==='paused'?['cancelled']:[])].includes(error.code));
  await f.join();assert.equal(f.readyCalls.length,f.readyAtHandoff,'Invalid handoff cannot enter fresh readiness');assert.equal(f.changes.length,0);assert.equal(f.continuations.length,0);
  assert.equal(f.graph.getState().visits,1);assert.equal(f.graph.getState().nodes['-2,1,0'],undefined);
  assert.deepEqual(f.nativeGoals.map(v=>v.target),[{x:-2,y:1,z:0}]);
});

for(const mode of ['expired','readiness_expired'])test(`original leg deadline cannot be renewed at ${mode}`,{timeout:5000},async t=>{
  const f=await fixture(t,mode,{legTimeoutMs:1200});
  await assert.rejects(f.graph.next(),{code:'dry_graph_leg_timeout'});await f.join();
  assert.equal(f.continuations.length,0);assert.equal(f.moves.length,1);
  assert.deepEqual(f.nativeGoals.map(v=>v.target),[{x:-2,y:1,z:0}]);
  assert.equal(f.graph.getState().nodes['2,1,0'],undefined);
});
