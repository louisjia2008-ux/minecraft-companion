/* global require, setInterval, clearInterval */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {Vec3}=require('vec3'),{Physics,PlayerState}=require('prismarine-physics'),{pathfinder}=require('mineflayer-pathfinder');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {selectSurfaceExplorationFrontier,createLoadedDryGraph,hasGroundedBodySupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
const clone=x=>JSON.parse(JSON.stringify(x)),key=p=>`${p.x},${p.y},${p.z}`;
function state(positions,anchor=positions[0]){
  const nodes={},order=[];for(const p of positions){const id=key(p);nodes[id]={position:clone(p),parent:order.at(-1)||null,expanded:true};order.push(id);}
  return{schema:2,kind:'loaded_dry_waypoint_graph',anchor:clone(anchor),step:16,radius:128,nodes,order,current:order.at(-1),resumeNode:order.at(-1),frontier:[],blockedEdges:[],visits:order.length,probes:0};
}
const p=(x,z,y=1)=>({x,y,z});
function simple(){const s=state([p(0,0),p(32,0),p(48,0)]);s.frontier=[{parent:s.current,target:p(64,0)},{parent:s.order[0],target:p(-32,0)}];return s;}

test('one genuinely separated local outward half-cell step can precede a distant parent replay without granting coverage',()=>{
  const s=simple(),before=clone(s);assert.equal(selectSurfaceExplorationFrontier(s),0);assert.deepEqual(s,before);
  assert.equal(s.nodes['64,1,0'],undefined);assert.equal(s.visits,3);
});

test('a second actual point in the covered target cell closes the bridge and restores unseen-cell priority',()=>{
  const s=simple(),id='64,1,0';s.nodes[id]={position:p(64,0),parent:s.current,expanded:true};s.order.push(id);s.current=id;s.resumeNode=id;s.visits++;
  s.frontier=[{parent:id,target:p(64,-16)},{parent:s.order[0],target:p(-32,0)}];
  assert.equal(selectSurfaceExplorationFrontier(s),1);assert.equal(s.nodes['64,1,-16'],undefined);
});

test('fresh local uncovered coverage retains priority over a covered-cell bridge',()=>{
  const s=simple();s.frontier.push({parent:s.current,target:p(80,0)});assert.equal(selectSurfaceExplorationFrontier(s),2);
});

test('short hops, non-outward edges and neighbors of other actual nodes cannot borrow the bridge',()=>{
  for(const target of [p(56,0),p(40,0),p(36,8)]){const s=simple();s.frontier[0].target=target;assert.equal(selectSurfaceExplorationFrontier(s),1);}
  const s=simple();s.nodes['64,1,8']={position:p(64,8),parent:s.current,expanded:true};s.order.splice(1,0,'64,1,8');s.visits++;
  assert.equal(selectSurfaceExplorationFrontier(s),1);
});

test('unconfirmed plans, pending transport and inflated visit counts do not close a real single-point cell',()=>{
  const s=simple(),before=clone(s);s.pendingWater={edge:s.frontier[0]};s.visits=999;
  assert.equal(selectSurfaceExplorationFrontier(s),0);assert.deepEqual(s.order,before.order);assert.equal(s.nodes['64,1,0'],undefined);
});

test('native observed block guidance keeps its existing priority over a geometry-only bridge',()=>{
  const s=simple();s.frontier[1].target=p(-160,0);
  const target={kind:'native_loaded_block_observation',position:p(-192,0),lastValidatedAt:Date.now()};
  assert.equal(selectSurfaceExplorationFrontier(s,s.anchor,target),1);
});

test('fresh food-entity observation guides existing frontier without granting visits; stale entity position does not',()=>{
 const s=simple(),before=clone(s);s.frontier[1].target=p(-160,0);
 const target={kind:'native_loaded_entity_observation',entityId:42,name:'cow',position:p(-192,0),lastValidatedAt:Date.now()};
 assert.equal(selectSurfaceExplorationFrontier(s,s.anchor,target),1);
 assert.equal(s.visits,before.visits);assert.deepEqual(s.nodes,before.nodes);
 assert.equal(selectSurfaceExplorationFrontier(s,s.anchor,{...target,lastValidatedAt:Date.now()-6000}),0);
});

// Two reduced exact recorded choice inputs from stopped whole12 snapshots.
// These are pure ranking counterexamples, with no bot, seed lookup, resource
// coordinates or movement instruction. Full evidence lives outside runtime.
const whole12Positions=[p(-39,-166,64),p(-23,-150,64),p(-39,-134,64),p(-55,-118,63),p(-67,-138,63),p(-75,-162,63),
  p(-23,-182,67),p(-7,-198,68),p(13,-210,65),p(29,-226,67),p(45,-242,63),p(57,-262,63),p(-39,-198,63),p(9,-182,68),p(45,-210,63)];
test('whole12 recorded choice at183860ms can advance a full safe-probed local step into a singly observed neighboring covered cell',()=>{
  const s=state(whole12Positions.slice(0,13));s.frontier=[{parent:s.current,target:p(-19,-210,64)},
    {parent:'-7,68,-198',target:p(9,-182,68)}];
  const before=clone(s);assert.equal(selectSurfaceExplorationFrontier(s),0);assert.deepEqual(s,before);
});

test('whole12 recorded choice at226119ms can fill only the second separated point in its local covered cell',()=>{
  const s=state(whole12Positions);s.frontier=[{parent:s.current,target:p(60,-204,63)},
    {parent:'13,65,-210',target:p(-3,-226,63)}];
  assert.equal(selectSurfaceExplorationFrontier(s),0);
  s.nodes['60,63,-204']={position:p(60,-204,63),parent:s.current,expanded:true};s.order.push('60,63,-204');s.current='60,63,-204';s.visits++;
  s.frontier[0]={parent:s.current,target:p(72,-183,63)};
  assert.equal(selectSurfaceExplorationFrontier(s),1,'Dense covered cells cannot repeatedly displace fresh global coverage');
});

test('installed native pathfinder and Physics physically complete the bridge before it becomes the second observed point',{timeout:5000},async t=>{
  let cp=simple();const initial=clone(cp),controls=Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(n=>[n,false])),moves=[],points=[];
  const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',health:20,food:20,entities:{},players:{},player:{ping:1},
    inventory:{slots:Array(46).fill(null),items:()=>[]},game:{minY:-64,height:384,dimension:'overworld'},controlState:controls,jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,
    _client:{state:'play',socket:{writable:true,destroyed:false}},entity:{position:new Vec3(48.5,1,.5),velocity:new Vec3(0,-.0784000015258789,0),onGround:true,yaw:0,pitch:0,eyeHeight:1.62,width:.6,height:1.8,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false}});
  bot.blockAt=raw=>{const q=raw.floored();if(q.x < -48||q.x>88||Math.abs(q.z)>3)return null;return Object.assign(Block.fromStateId(registry.blocksByName[q.y<1?'stone':'air'].defaultState),{position:q});};
  bot.look=async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;};bot.setControlState=(name,value)=>{controls[name]=value;};
  bot.clearControlStates=()=>{for(const name of Object.keys(controls))controls[name]=false;};bot.stopDigging=()=>{};bot.deactivateItem=()=>{};
  const world={getBlock:bot.blockAt};bot.physics=Physics(registry,world);pathfinder(bot);const native=bot.pathfinder.goto.bind(bot.pathfinder);
  const timer=setInterval(()=>{bot.physics.simulatePlayer(new PlayerState(bot,controls),world).apply(bot);points.push(bot.entity.position.clone());bot.emit('physicsTick');},5);
  t.after(()=>{clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();});
  const graph=createLoadedDryGraph({getBot:()=>bot,assertActive:()=>{},getCP:()=>cp,saveCP:s=>{cp=clone(s);},actualnativegoto:async(goal,m)=>{
    assert.equal(m.canDig,false);assert.equal(m.allowParkour,false);assert.equal(cp.visits,initial.visits);assert.equal(cp.nodes['64,1,0'],undefined);
    moves.push({x:goal.x,y:goal.y,z:goal.z});await native(goal);}}, {anchor:cp.anchor,radius:128,maxNodes:16,legTimeoutMs:4000});
  const outcome=await graph.next();assert.equal(outcome.moved,true);assert.deepEqual(outcome.actual,p(64,0));assert.deepEqual(moves,[p(64,0)]);
  assert.equal(hasGroundedBodySupport(bot),true);assert.ok(points.length>20);assert.equal(cp.visits,initial.visits+1);assert.equal(cp.order.length,initial.order.length+1);
  const after=graph.getState();after.frontier=[{parent:after.current,target:p(64,-16)},{parent:after.order[0],target:p(-32,0)}];
  assert.equal(selectSurfaceExplorationFrontier(after),1);
});
