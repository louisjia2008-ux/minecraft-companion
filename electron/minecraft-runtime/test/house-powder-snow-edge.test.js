/* global require, setInterval, clearInterval */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {Vec3}=require('vec3'),{Physics,PlayerState}=require('prismarine-physics'),{pathfinder,goals}=require('mineflayer-pathfinder');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {createLoadedDryGraph}=require(process.env.HOUSE_EDGE_RUNTIME?`${process.env.HOUSE_EDGE_RUNTIME}/vendor/server/minecraft/houseSurfaceGraph`:'../vendor/server/minecraft/houseSurfaceGraph');
const {createSurfaceHazardEdgePolicy,avoidsKnownSurfaceHazardEdge}=require('../vendor/server/minecraft/houseSurfaceGraph');
const copy=v=>JSON.parse(JSON.stringify(v));
function fixture(t,{narrow=false,floor='powder_snow',fluidLevel=null,fluidFloorOnly=false}={}) {
 const controls=Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(n=>[n,false])),moves=[],samples=[];
 let cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor:{x:0,y:1,z:0},step:16,radius:32,nodes:{'0,1,0':{position:{x:0,y:1,z:0},parent:null,expanded:true}},order:['0,1,0'],current:'0,1,0',resumeNode:'0,1,0',visits:1,probes:0,blockedEdges:[],frontier:[{parent:'0,1,0',target:{x:16,y:1,z:0}}]};
 const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',health:20,food:20,entities:{},players:{},player:{ping:1},game:{dimension:'overworld',minY:-64,height:384},inventory:{items:()=>[],slots:Array(46).fill(null)},controlState:controls,jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,_client:{state:'play',socket:{writable:true,destroyed:false}},entity:{position:new Vec3(.5,1,.5),velocity:new Vec3(0,0,0),onGround:true,yaw:0,pitch:0,eyeHeight:1.62,width:.6,height:1.8,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false}});
 bot.blockAt=raw=>{const p=raw.floored();if(p.x< -2||p.x>20||Math.abs(p.z)>4||p.y< -40||p.y>40)return null;
  const hazard=p.x===6&&p.y===(fluidLevel===null||fluidFloorOnly?0:1)&&p.z===1;
  const name=hazard?floor:narrow&&p.z!==0&&p.y>=1&&p.y<=4?'bedrock':p.y<1?'stone':'air';
  return Object.assign(hazard&&fluidLevel!==null?Block.fromProperties(registry.blocksByName[name].id,{level:String(fluidLevel)},0):Block.fromStateId(registry.blocksByName[name].defaultState),{position:p});};
 bot.look=async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;};bot.setControlState=(n,v)=>{controls[n]=v;};bot.clearControlStates=()=>{for(const n in controls)controls[n]=false;};bot.stopDigging=()=>{};bot.deactivateItem=()=>{};
 bot.physics=Physics(registry,{getBlock:bot.blockAt});pathfinder(bot);const nativeGoto=bot.pathfinder.goto.bind(bot.pathfinder);bot.pathfinder.goto=goal=>{moves.push(goal);return nativeGoto(goal);};
 const timer=setInterval(()=>{bot.physics.simulatePlayer(new PlayerState(bot,controls),{getBlock:bot.blockAt}).apply(bot);samples.push({...bot.entity.position});bot.emit('physicsTick');},5);
 const graph=createLoadedDryGraph({getBot:()=>bot,assertActive:()=>{},isMovementOwner:()=>true,getCP:()=>cp,saveCP:v=>{cp=copy(v);}},{anchor:{x:0,y:1,z:0},step:16,radius:32,maxNodes:8,maxEdges:128,timeoutMs:10000,legTimeoutMs:4000});
 t.after(()=>{clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();});return{bot,graph,moves,samples,state:()=>cp};
}
test('native dry route detours around the adjacent powder-snow floor and actually arrives', {timeout:7000}, async t=>{
 const f=fixture(t),path=f.bot.pathfinder.getPathTo(f.graph.movements,new goals.GoalBlock(16,1,0),1000);
 assert.equal(path.status,'success');assert.ok(path.path.every(p=>Math.abs(p.x-6)>1||Math.abs(p.z-1)>1),'No planned foot node touches the powder edge halo');
 const result=await f.graph.next();assert.equal(result.moved,true);assert.equal(f.state().visits,2);assert.equal(f.bot.entity.onGround,true);assert.ok(f.samples.some(p=>p.z<0));
});
test('a powder-edge-only corridor grants no native move or invented arrival', async t=>{
 const f=fixture(t,{narrow:true}),result=await f.graph.next();assert.equal(result.moved,false);assert.equal(f.moves.length,0);assert.equal(f.state().visits,1);
});
test('ordinary snow blocks remain valid adjacent terrain under unchanged native movement', {timeout:7000},async t=>{
 const f=fixture(t,{floor:'snow_block'}),result=await f.graph.next();assert.equal(result.moved,true);assert.equal(f.bot.entity.onGround,true);assert.equal(f.state().visits,2);
});
for(const fluid of ['water','lava'])test(`native dry movement detours before a known flowing ${fluid} body edge`,{timeout:7000},async t=>{
 const f=fixture(t,{floor:fluid,fluidLevel:1}),path=f.bot.pathfinder.getPathTo(f.graph.movements,new goals.GoalBlock(16,1,0),1000);
 assert.equal(path.status,'success');assert.ok(path.path.every(p=>Math.abs(p.x-6)>1||Math.abs(p.z-1)>1),'planned dry cells retain flowing-fluid clearance');
 const result=await f.graph.next();assert.equal(result.moved,true);assert.equal(f.state().visits,2);assert.equal(f.bot.entity.onGround,true);
 assert.ok(f.samples.some(p=>p.z<0));assert.equal(f.bot.entity.isInWater,false);assert.equal(f.bot.entity.isInLava,false);
});
test('a flowing-water-edge-only corridor grants no movement or invented arrival',async t=>{
 const f=fixture(t,{floor:'water',fluidLevel:1,narrow:true}),result=await f.graph.next();
 assert.equal(result.moved,false);assert.equal(f.moves.length,0);assert.equal(f.state().visits,1);
});
test('dry solid-floor shoreline remains walkable when adjacent flowing water is below the feet',{timeout:7000},async t=>{
 const f=fixture(t,{floor:'water',fluidLevel:1,fluidFloorOnly:true,narrow:true});
 const result=await f.graph.next();assert.equal(result.moved,true);assert.equal(f.state().visits,2);
 assert.equal(f.bot.entity.isInWater,false);assert.ok(f.samples.every(p=>p.y>=1));
 assert.equal(avoidsKnownSurfaceHazardEdge(f.bot,new Vec3(6,1,0)),true);
});
test('below-feet flow allowance requires actual stable support beneath sand',()=>{
 for(const base of ['stone','air','water',null]){
  const bot={blockAt:p=>p.x===-1&&p.y===0&&p.z===0?Object.assign(Block.fromProperties(registry.blocksByName.water.id,{level:'1'},0),{position:p}):
   p.x===0&&p.z===0&&p.y===0?Object.assign(Block.fromStateId(registry.blocksByName.sand.defaultState),{position:p}):
   p.x===0&&p.z===0&&p.y===-1?(base===null?null:Object.assign(Block.fromStateId(registry.blocksByName[base].defaultState),{position:p})):Object.assign(Block.fromStateId(registry.blocksByName.air.defaultState),{position:p})};
  assert.equal(avoidsKnownSurfaceHazardEdge(bot,new Vec3(0,1,0)),base==='stone');
 }
});
test('ordinary still source water retains the separate typed crossing entry policy',async t=>{
 const f=fixture(t,{floor:'water',fluidLevel:0});
 assert.equal(f.graph.movements.exclusionStep(f.bot.blockAt(new Vec3(6,1,0))),0);
 assert.equal(f.moves.length,0);
});
test('actual whole41 MCA dry center beside level1 water is rejected before body-edge contact',t=>{
 const f=fixture(t),data=require('../test-support/whole41-saved-flowing-edge.json'),b=data.bounds,view=Object.create(f.bot);
 view.blockAt=raw=>{const p=raw.floored();if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;
 const i=((p.x-b.minX)*(b.maxY-b.minY+1)+(p.y-b.minY))*(b.maxZ-b.minZ+1)+(p.z-b.minZ),s=data.palette[data.indices[i]];
 return Object.assign(Block.fromProperties(registry.blocksByName[s.name.replace(/^minecraft:/,'')].id,s.properties,0),{position:p});};
 const p=new Vec3(data.initial.position.x,data.initial.position.y,data.initial.position.z).floored();
 const graph=createLoadedDryGraph({getBot:()=>view,assertActive:()=>{}},{anchor:{x:p.x,y:p.y,z:p.z}}),center=view.blockAt(p),side=view.blockAt(p.offset(0,0,-1));
 assert.equal(center.name,'air');assert.equal(view.blockAt(p.offset(0,-1,0)).name,'grass_block');
 assert.equal(side.name,'water');assert.equal(side.getProperties().level,'1');
 assert.equal(graph.movements.exclusionStep(center),Infinity);
 assert.equal(f.moves.length,0);assert.equal(data.provenance.originalBytesUnchanged,true);
});
function edgeCacheFixture(){
 let wet=false,reads=0,mutateRead=0;
 const bot=Object.assign(new EventEmitter(),{_client:{},world:{},game:{dimension:'overworld'}});
 bot.blockAt=p=>{
  reads++;if(reads===mutateRead){wet=true;bot.emit('blockUpdate');}
  return Object.assign(wet&&p.equals(new Vec3(-1,0,-1))?Block.fromProperties(registry.blocksByName.water.id,{level:'1'},0):Block.fromStateId(registry.blocksByName.air.defaultState),{position:p});
 };
 return{bot,wet:v=>{wet=v;},reads:()=>reads,reset:()=>{reads=0;},mutate:n=>{mutateRead=n;}};
}
test('synchronous edge geometry reuse reduces repeated native reads and expires before the next microtask',async()=>{
 const f=edgeCacheFixture(),p=new Vec3(0,1,0);
 for(let i=0;i<10;i++)assert.equal(avoidsKnownSurfaceHazardEdge(f.bot,p),true);
 const originalReads=f.reads();assert.equal(originalReads,270);f.reset();
 const policy=createSurfaceHazardEdgePolicy(f.bot);for(let i=0;i<10;i++)assert.equal(policy(p),true);
 assert.equal(f.reads(),27);assert.equal(policy(new Vec3(1,1,0)),true);assert.equal(f.reads(),36,'adjacent halos share actual block facts');
 await Promise.resolve();f.wet(true);assert.equal(policy(p),false,'a new microtask cannot borrow the previous dry observation');
 console.log(JSON.stringify({scope:'offline_geometry_reads_only',uncachedRepeated:originalReads,cachedRepeated:27,cachedAdjacentTotal:36}));
});
test('world events and native identity changes invalidate edge geometry without duplicate per-profile listeners',()=>{
 const f=edgeCacheFixture(),p=new Vec3(0,1,0),policy=createSurfaceHazardEdgePolicy(f.bot);
 for(const event of ['blockUpdate','chunkColumnLoad','chunkColumnUnload','physicsTick']){
  f.wet(false);f.bot.emit(event);assert.equal(policy(p),true);
  f.wet(true);f.bot.emit(event);assert.equal(policy(p),false);
  createSurfaceHazardEdgePolicy(f.bot);assert.equal(f.bot.listenerCount(event),1);
 }
 for(const change of [()=>{f.bot._client={};},()=>{f.bot.world={};},()=>{f.bot.game.dimension='nether';},()=>{const old=f.bot.blockAt;f.bot.blockAt=p=>old(p); }]){
  f.wet(false);f.bot.emit('blockUpdate');assert.equal(policy(p),true);f.wet(true);change();assert.equal(policy(p),false);
 }
});
test('a synchronous world update while reading a halo cannot cache a stale dry result',()=>{
 const f=edgeCacheFixture(),policy=createSurfaceHazardEdgePolicy(f.bot);f.mutate(3);
 assert.equal(policy(new Vec3(0,1,0)),false);
 assert.equal(policy(new Vec3(0,1,0)),false);
});

test('actual whole33 MCA shows a centrally dry native waypoint beside the recorded powder-snow column', t=>{
 const f=fixture(t),data=require('../test-support/whole33-saved-powder-edge.json'),b=data.bounds,view=Object.create(f.bot);
 view.blockAt=raw=>{const p=raw.floored();if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;
 const i=((p.x-b.minX)*(b.maxY-b.minY+1)+(p.y-b.minY))*(b.maxZ-b.minZ+1)+(p.z-b.minZ),s=data.palette[data.indices[i]];return Object.assign(Block.fromProperties(registry.blocksByName[s.name.replace(/^minecraft:/,'')].id,s.properties,0),{position:p});};
 const graph=createLoadedDryGraph({getBot:()=>view,assertActive:()=>{}},{anchor:{x:-9,y:151,z:6}}),waypoint=view.blockAt(new Vec3(-5,149,5));
 assert.equal(waypoint.name,'snow');assert.equal(waypoint.getProperties().layers,'1');
 assert.equal(view.blockAt(new Vec3(-5,148,5)).name,'snow_block');assert.equal(view.blockAt(new Vec3(-5,148,6)).name,'powder_snow');
 assert.equal(graph.movements.exclusionStep(waypoint),Infinity,'The original native pending-path waypoint must be rejected before approaching the powder edge');
 assert.equal(f.moves.length,0,'Saved geometry grants no arrival or real-world movement');assert.equal(data.provenance.originalBytesUnchanged,true);
});
