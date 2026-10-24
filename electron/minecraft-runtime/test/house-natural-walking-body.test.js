/* global require, process, setInterval, clearInterval */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3'), { Physics, PlayerState } = require('prismarine-physics'), { pathfinder } = require('mineflayer-pathfinder');
const registry = require('prismarine-registry')('1.21.8'), Block = require('prismarine-block')(registry);
const graph = require(process.env.HOUSE_WALKING_BODY_RUNTIME ? `${process.env.HOUSE_WALKING_BODY_RUNTIME}/vendor/server/minecraft/houseSurfaceGraph` : '../vendor/server/minecraft/houseSurfaceGraph');
const site = require(process.env.HOUSE_WALKING_BODY_RUNTIME ? `${process.env.HOUSE_WALKING_BODY_RUNTIME}/vendor/server/minecraft/houseNaturalSiteSearch` : '../vendor/server/minecraft/houseNaturalSiteSearch');
const { isNaturalWalkingBodyBlock, isNaturalWalkingBodyFact } = require('../vendor/server/minecraft/houseNaturalWalkingBody');
const { createHouseCreeperEscape } = require('../vendor/server/minecraft/houseCreeperEscape');
const { createHouseCampConnector } = require('../vendor/server/minecraft/houseCampConnector');
const walking = graph.naturalWalkingFoot || graph.dryFoot, clone = v => JSON.parse(JSON.stringify(v)), key = p => `${p.x},${p.y},${p.z}`;
const plants = ['short_grass','fern','tall_grass','large_fern','dandelion','poppy','dead_bush','leaf_litter','sugar_cane','mangrove_propagule'];
const block = (name,p,properties={}) => Object.assign(Block.fromProperties(registry.blocksByName[name].id,properties,0),{position:p});
function fixture(name,origin) {
  const controls=Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(n=>[n,false])), state={owner:true,paused:false,reads:0}, writes=[];
  const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',health:20,food:20,entities:{},players:{},player:{ping:1},_client:Object.assign(new EventEmitter(),{state:'play',socket:{writable:true,destroyed:false}}),
    inventory:{items:()=>[],slots:Array(46).fill(null)},controlState:controls,jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,
    entity:{position:new Vec3(origin.x+.5,origin.y+.05,origin.z+.5),velocity:new Vec3(0,0,0),onGround:false,yaw:0,pitch:0,width:.6,height:1.8,eyeHeight:1.62,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:false,elytraFlying:false},
    game:{minY:-64,height:384,dimension:'overworld'},supportFeature:n=>registry.supportFeature(n),look:async()=>{},stopDigging:()=>{},deactivateItem:()=>{}});
  bot.blockAt=raw=>{state.reads++;const p=raw.floored(),foot=p.x===origin.x&&p.z===origin.z&&p.y===origin.y,upper=['tall_grass','large_fern'].includes(name)&&p.x===origin.x&&p.z===origin.z&&p.y===origin.y+1;
    return block(p.y<origin.y?'grass_block':foot||upper?name:'air',p,foot||upper?{half:upper?'upper':'lower',waterlogged:false}:{});};
  bot.setControlState=(n,v)=>{writes.push({n,v,owner:state.owner});controls[n]=v;};bot.clearControlStates=()=>Object.keys(controls).forEach(n=>bot.setControlState(n,false));
  const world={getBlock:p=>bot.blockAt(p)};bot.physics=Physics(registry,world);pathfinder(bot);const poses=[];
  // Constructed terrain, original Physics only: no manual pose/velocity/ground
  // updates after boot, no Java or real world/motor mutation.
  for(let n=0;n<8;n++){bot.physics.simulatePlayer(new PlayerState(bot,controls),world).apply(bot);poses.push({position:bot.entity.position.clone(),onGround:bot.entity.onGround});}
  return{bot,origin,state,writes,poses,active:()=>{if(state.paused)throw Object.assign(Error('paused'),{code:'paused'});if(!state.owner)throw Object.assign(Error('foreign'),{code:'foreign'});}};
}
const origins=[{x:0,y:64,z:0},{x:-101,y:-31,z:209},{x:734,y:117,z:-407},{x:42,y:72,z:91}];
for(const origin of origins)for(const name of plants)test(`original Physics and graph register supported ${name} at ${key(origin)} while facility cells stay strict AIR`,async()=>{
  const f=fixture(name,origin),p=new Vec3(origin.x,origin.y,origin.z);let graphCP=null,siteCP=null,next=0;
  assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.position.y,origin.y);assert.equal(graph.hasGroundedBodySupport(f.bot),true);assert.equal(graph.dryFoot(f.bot,p),false);assert.equal(walking(f.bot,p),true);
  const g=graph.createHouseSurfaceGraph({getBot:()=>f.bot,assertActive:f.active,isMovementOwner:()=>f.state.owner,getCP:()=>graphCP,saveCP:v=>{f.active();graphCP=clone(v);}});
  const api=site.createNaturalHouseSiteSearch({ownerIdentity:{taskId:'MODELED-native-walking-body',generation:1},getBot:()=>f.bot,assertActive:f.active,isOwnerCurrent:()=>f.state.owner,isOwnerContext:()=>f.state.owner,
    getCP:()=>siteCP,saveCP:v=>{f.active();siteCP={...clone(v),graph:graphCP};},getGraphCP:()=>graphCP,readRemainingMs:()=>60000,
    initializeGraph:async o=>{o.assertActive();await g.returnToAnchor({anchor:o.anchor});o.assertActive();},next:async()=>{next++;throw Error('No real exploration needed');},travelObserved:async()=>{throw Error('No planned camp');}});
  const result=await api.search({profile:'cottage'});assert.equal(result.confirmed,true);assert.equal(next,0);assert.deepEqual(result.actual,origin);assert.equal(graphCP.current,key(origin));assert.equal(graphCP.order.length,1);assert.equal(graphCP.visits,1);
  for(const stand of [result.camp.stations.crafting_table,result.camp.stations.furnace,...result.camp.storageSites])assert.equal(graph.dryFoot(f.bot,stand),true);
  assert.equal(f.bot.blockAt(p).name,name);assert.ok(f.poses.some(p=>p.onGround));assert.equal(result.authority,'loaded_geometry_and_actual_camp_only');assert.equal(f.writes.some(w=>w.v),false);
});
test('all sixteen original sugar cane states need fresh empty native shapes; malformed or wet sugar cane is refused',()=>{
  const range=registry.blocksByName.sugar_cane;assert.equal(range.maxStateId-range.minStateId+1,16);
  for(let stateId=range.minStateId;stateId<=range.maxStateId;stateId++){
    const b=Block.fromStateId(stateId);assert.equal(b.name,'sugar_cane');assert.equal(b.boundingBox,'empty');assert.deepEqual(b.shapes,[]);assert.equal(isNaturalWalkingBodyBlock(b),true);
    for(const invalid of [null,{...b,stateId:null},{...b,boundingBox:'block'},{...b,shapes:null},{...b,shapes:[[0,0,0,1,.01,1]]},
      {...b,getProperties:()=>({waterlogged:true})},{...b,getProperties:()=>({waterlogged:'true'})}])assert.equal(isNaturalWalkingBodyBlock(invalid),false);
  }
});
test('original native goto and Physics walk through nine trusted natural species and arrive at a real graph endpoint',{timeout:5000},async t=>{
  const origin={x:-47,y:85,z:213},f=fixture('short_grass',origin),read=f.bot.blockAt,seen=new Set(),poses=[];let cp=null,gotos=0;
  f.bot.blockAt=q=>{const p=q.floored(),name=plants[((p.x-origin.x)%plants.length+plants.length)%plants.length];
    if(p.y===origin.y)return block(name,p,{half:'lower'});
    if(p.y===origin.y+1&&['tall_grass','large_fern'].includes(name))return block(name,p,{half:'upper'});return read(q);};
  f.bot.look=async(yaw,pitch)=>{f.bot.entity.yaw=yaw;f.bot.entity.pitch=pitch;};
  const nativeGoto=f.bot.pathfinder.goto.bind(f.bot.pathfinder);f.bot.pathfinder.goto=goal=>{gotos++;return nativeGoto(goal);};
  const timer=setInterval(()=>{f.bot.physics.simulatePlayer(new PlayerState(f.bot,f.bot.controlState),{getBlock:p=>f.bot.blockAt(p)}).apply(f.bot);
    poses.push(f.bot.entity.position.clone());for(const c of graph.inspectSurfaceBody(f.bot).cells)if(plants.includes(c.name))seen.add(c.name);f.bot.emit('physicsTick');},10);
  t.after(()=>{clearInterval(timer);f.bot.pathfinder.setGoal(null);f.bot.clearControlStates();});
  const g=graph.createHouseSurfaceGraph({getBot:()=>f.bot,assertActive:f.active,isMovementOwner:()=>f.state.owner,getCP:()=>cp,saveCP:v=>{f.active();cp=clone(v);}},{step:16,radius:32,maxNodes:4,maxEdges:128});
  const result=await g.next({anchor:origin});assert.equal(result.moved,true);assert.ok(gotos>0);assert.ok(poses.length>20);assert.equal(f.bot.entity.onGround,true);
  assert.equal(walking(f.bot,result.actual),true);assert.equal(graph.hasGroundedBodySupport(f.bot),true);assert.deepEqual(f.bot.entity.position.floored(),new Vec3(result.actual.x,result.actual.y,result.actual.z));
  assert.equal(cp.visits,2);assert.equal(cp.order.length,2);assert.ok(f.writes.some(w=>w.v));assert.equal(seen.size,9);assert.equal(f.bot.entity.isInWater,false);assert.equal(f.bot.entity.isInLava,false);
});
test('a real Physics-supported grass camp is captured by the original construction connector without facility authority',()=>{
  const origin={x:104,y:-23,z:-208},f=fixture('short_grass',origin);let cp=null;
  const c=createHouseCampConnector({getBot:()=>f.bot,assertActive:f.active,isOwnerCurrent:()=>f.state.owner,isOwnerContext:()=>f.state.owner,
    getCheckpoint:()=>cp,saveCheckpoint:v=>{f.active();cp=clone(v);},isOwnedConstructionSupport:()=>false,withMovements:async()=>{},moveTo:async()=>{},returnDry:async()=>{}},{anchor:origin,taskId:'MODELED-native-plant-connector'});
  assert.equal(c.observe(),true);assert.equal(cp.points.length,1);assert.equal(cp.points[0].graphCompatible,true);assert.equal(cp.points[0].supports.every(s=>s.owned===false),true);
  assert.equal(graph.dryFoot(f.bot,origin),false);assert.equal(f.writes.some(w=>w.v),false);c.release();
});
test('original creeper escape walks from actual native grounded grass while keeping the captured no-dig profile',{timeout:5000},async t=>{
  const origin={x:23,y:91,z:-43},f=fixture('short_grass',origin),profile=graph.createLoadedDryGraph({getBot:()=>f.bot},{anchor:origin}).movements,poses=[];
  f.bot.pathfinder.setMovements(profile);
  f.bot.look=async(yaw,pitch)=>{f.bot.entity.yaw=yaw;f.bot.entity.pitch=pitch;};
  const threat={id:2,name:'creeper',isValid:true,position:new Vec3(origin.x+8.5,origin.y,origin.z+.5)};f.bot.entities[2]=threat;
  const timer=setInterval(()=>{f.bot.physics.simulatePlayer(new PlayerState(f.bot,f.bot.controlState),{getBlock:p=>f.bot.blockAt(p)}).apply(f.bot);poses.push(f.bot.entity.position.clone());f.bot.emit('physicsTick');},10);
  t.after(()=>{clearInterval(timer);f.bot.pathfinder.setGoal(null);f.bot.clearControlStates();});
  const result=await createHouseCreeperEscape({getBot:()=>f.bot,assertActive:f.active,isOwnerCurrent:()=>f.state.owner,getThreat:()=>threat}).escape();
  assert.equal(result.confirmed,true);assert.ok(result.finalDistance>=8.5);assert.ok(poses.length>5);assert.ok(f.writes.some(w=>w.v));assert.equal(f.bot.pathfinder.movements,profile);
  assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.isInWater,false);assert.equal(f.bot.entity.isInLava,false);
});
for(const name of ['wither_rose','sweet_berry_bush','cobweb','nether_portal','end_portal','end_gateway','water','lava','fire','powder_snow'])test(`original body tick classification refuses ${name} without trusting empty collision`,()=>{
  const f=fixture('short_grass',origins[0]),read=f.bot.blockAt,p=new Vec3(0,64,0);
  f.bot.blockAt=q=>key(q.floored())==='0,64,0'?block(name,q.floored()):read(q);
  assert.equal(isNaturalWalkingBodyBlock(f.bot.blockAt(p)),false);assert.equal(walking(f.bot,p),false);assert.equal(graph.inspectSurfaceBody(f.bot).dry,false);
});
for(const kind of ['unknown','shape_missing','shape_nonempty','bounding_wrong','wet_bool','wet_string','state_unknown','unsupported'])test(`walking helper refuses ${kind} fresh evidence while the native actor is unchanged`,()=>{
  const f=fixture('short_grass',origins[0]),read=f.bot.blockAt,p=new Vec3(0,64,0),before={position:f.bot.entity.position.clone(),velocity:f.bot.entity.velocity.clone(),onGround:f.bot.entity.onGround};
  f.bot.blockAt=q=>{const b=read(q);if(key(q.floored())===(kind==='unsupported'?'0,63,0':'0,64,0')){
    if(kind==='unknown'||kind==='unsupported')return null;if(kind==='shape_missing')b.shapes=null;if(kind==='shape_nonempty')b.shapes=[[0,0,0,1,.01,1]];
    if(kind==='bounding_wrong')b.boundingBox='block';if(kind==='wet_bool')b.getProperties=()=>({waterlogged:true});if(kind==='wet_string')b.getProperties=()=>({waterlogged:'true'});if(kind==='state_unknown')b.stateId=null;}return b;};
  assert.equal(Boolean(walking(f.bot,p)),false);if(kind!=='unsupported')assert.equal(graph.inspectSurfaceBody(f.bot).dry,false);assert.deepEqual({position:f.bot.entity.position,velocity:f.bot.entity.velocity,onGround:f.bot.entity.onGround},before);
});
test('fresh facts require shape/state evidence; a remembered plant name alone is not a jump witness',()=>{
  const f=fixture('leaf_litter',origins[0]),body=graph.inspectSurfaceBody(f.bot),fact=body.cells.find(c=>c.name==='leaf_litter');
  assert.equal(isNaturalWalkingBodyFact(fact),true);assert.equal(isNaturalWalkingBodyFact({...fact,shapes:null}),false);assert.equal(isNaturalWalkingBodyFact({...fact,boundingBox:null}),false);assert.equal(isNaturalWalkingBodyFact({...fact,stateId:null}),false);
});
test('camp permits replaceable plants but rejects a foreign container at a stored facility target',async()=>{
  const f=fixture('short_grass',origins[0]),bounds=[{minX:100,maxX:110,minY:0,maxY:150,minZ:100,maxZ:110}];
  const first=site.inspectNaturalSiteSearchCamp({bot:f.bot,anchor:origins[0],constructionBounds:bounds,blockAt:p=>f.bot.blockAt(new Vec3(p.x,p.y,p.z)),assertActive:f.active});assert.equal(first.valid,true);
  const target=first.camp.stations.crafting_table,read=f.bot.blockAt;f.bot.blockAt=q=>key(q.floored())===key(target)?block('fern',q.floored()):read(q);
  const after=site.inspectNaturalSiteSearchCamp({bot:f.bot,anchor:origins[0],camp:first.camp,constructionBounds:bounds,blockAt:p=>f.bot.blockAt(new Vec3(p.x,p.y,p.z)),assertActive:f.active});assert.equal(after.valid,true);assert.deepEqual(after.camp,first.camp);
  assert.equal(f.writes.length,0,'A reservation cannot clear plants or authorize placement');
  f.bot.blockAt=q=>key(q.floored())===key(target)?block('chest',q.floored()):read(q);
  const foreign=site.inspectNaturalSiteSearchCamp({bot:f.bot,anchor:origins[0],camp:first.camp,constructionBounds:bounds,blockAt:p=>f.bot.blockAt(new Vec3(p.x,p.y,p.z)),assertActive:f.active});assert.equal(foreign.valid,false);assert.equal(foreign.camp,undefined);
});
for(const mode of ['foreign','paused'])test(`owner ${mode} in a fresh plant body read produces no graph or reservation writes`,async()=>{
  const f=fixture('short_grass',origins[0]),read=f.bot.blockAt;let saves=0,calls=0,changed=false;
  f.bot.blockAt=q=>{const b=read(q);if(!changed){changed=true;if(mode==='foreign')f.state.owner=false;else f.state.paused=true;}return b;};
  const api=site.createNaturalHouseSiteSearch({ownerIdentity:{taskId:'MODELED-owner-plant-read',generation:1},getBot:()=>f.bot,assertActive:f.active,isOwnerCurrent:()=>f.state.owner,isOwnerContext:()=>f.state.owner,
    getCP:()=>null,saveCP:()=>{saves++;},getGraphCP:()=>null,readRemainingMs:()=>60000,initializeGraph:async()=>{calls++;},next:async()=>{calls++;},travelObserved:async()=>{calls++;}});
  await assert.rejects(api.search({profile:'cottage'}),e=>e.code===mode);assert.equal(saves,0);assert.equal(calls,0);
});

for(const name of ['torch','wall_torch','soul_torch','soul_wall_torch','redstone_torch','redstone_wall_torch'])test(`loaded noncolliding ${name} permits walking body but grants no support or placement credit`,()=>{
 const origin={x:-83,y:63,z:-109},f=fixture(name,origin),p=new Vec3(origin.x,origin.y,origin.z);
 assert.equal(walking(f.bot,p),true);assert.equal(graph.inspectSurfaceBody(f.bot).dry,true);assert.equal(graph.dryFoot(f.bot,p),false);
 const b=f.bot.blockAt(p);for(const changed of [{...b,stateId:null},{...b,shapes:null},{...b,shapes:[[0,0,0,1,1,1]]},{...b,getProperties:()=>({waterlogged:true})}])assert.equal(isNaturalWalkingBodyBlock(changed),false);
 const read=f.bot.blockAt;f.bot.blockAt=q=>q.floored().y===origin.y-1?block(name,q.floored()):read(q);
 assert.equal(Boolean(walking(f.bot,p)),false);assert.equal(graph.hasGroundedBodySupport(f.bot),false);
});
test('native graph and Physics walk through actual torch cells without misclassifying a lit camp route as hazard',{timeout:5000},async t=>{
 const origin={x:-84,y:64,z:-109},f=fixture('torch',origin),read=f.bot.blockAt,seen=new Set(),poses=[];let cp=null;
 f.bot.blockAt=q=>{const p=q.floored();return p.y===origin.y&&p.x>=origin.x&&p.x<=origin.x+16?block('torch',p):read(q);};
 f.bot.look=async(yaw,pitch)=>{f.bot.entity.yaw=yaw;f.bot.entity.pitch=pitch;};
 const timer=setInterval(()=>{f.bot.physics.simulatePlayer(new PlayerState(f.bot,f.bot.controlState),{getBlock:p=>f.bot.blockAt(p)}).apply(f.bot);
  poses.push(f.bot.entity.position.clone());for(const c of graph.inspectSurfaceBody(f.bot).cells)if(c.name==='torch')seen.add(key(c.position));f.bot.emit('physicsTick');},10);
 t.after(()=>{clearInterval(timer);f.bot.pathfinder.setGoal(null);f.bot.clearControlStates();});
 const g=graph.createHouseSurfaceGraph({getBot:()=>f.bot,assertActive:f.active,isMovementOwner:()=>f.state.owner,getCP:()=>cp,saveCP:v=>{f.active();cp=clone(v);}},{step:16,radius:32,maxNodes:4,maxEdges:128});
 const result=await g.next({anchor:origin});assert.equal(result.moved,true);assert.ok(poses.length>20);assert.ok(seen.size>5);assert.equal(cp.visits,2);
 assert.equal(f.bot.entity.onGround,true);assert.equal(graph.hasGroundedBodySupport(f.bot),true);assert.equal(f.bot.entity.isInWater,false);
});

test('recorded formal04 jump past native pale hanging moss retains dry body with real prior support',()=>{
 const position=new Vec3(-9.403329894787138,103.48249998688698,.5394785048108217);
 const bot={entity:{position,width:.6,height:1.8,isInWater:false,isInLava:false},blockAt:raw=>{
  const p=raw.floored();return block(p.x===-10&&p.z===0&&p.y===103?'pale_moss_carpet':p.x===-10&&p.z===0&&p.y===105?'pale_hanging_moss':p.y<103?'pale_moss_block':'air',p);
 }};
 assert.equal(graph.inspectSurfaceBody(bot).dry,true);
 const range=registry.blocksByName.pale_hanging_moss;
 for(let id=range.minStateId;id<=range.maxStateId;id++){
  const native=Block.fromStateId(id);assert.equal(native.boundingBox,'empty');assert.deepEqual(native.shapes,[]);assert.equal(isNaturalWalkingBodyBlock(native),true);
  assert.equal(isNaturalWalkingBodyBlock({...native,getProperties:()=>({waterlogged:true})}),false);
  assert.equal(isNaturalWalkingBodyBlock({...native,shapes:[[0,0,0,1,1,1]]}),false);
 }
 bot.entity.isInWater=true;assert.equal(graph.inspectSurfaceBody(bot).dry,false);
});


test('formal38 actual dry hanging mangrove propagule state46 is body clearance only; wet or colliding states remain refused',()=>{
 const native=Block.fromStateId(46);assert.equal(native.name,'mangrove_propagule');assert.deepEqual(native.shapes,[]);assert.equal(native.getProperties().waterlogged,false);
 const position=new Vec3(16.59461885858629,69,-2.8195121576762117),bot={entity:{position,width:.6,height:1.8,isInWater:false,isInLava:false},blockAt:raw=>{
  const p=raw.floored();return p.x===16&&p.y===70&&p.z===-4?Object.assign(Block.fromStateId(46),{position:p}):block(p.y<69?'mangrove_leaves':'air',p);
 }};
 const body=graph.inspectSurfaceBody(bot);assert.equal(body.dry,true);assert.ok(body.cells.some(c=>c.stateId===46));
 const range=registry.blocksByName.mangrove_propagule;
 for(let id=range.minStateId;id<=range.maxStateId;id++){
  const b=Block.fromStateId(id);assert.equal(isNaturalWalkingBodyBlock(b),b.getProperties().waterlogged!==true);
  assert.equal(isNaturalWalkingBodyBlock({...b,shapes:[[0,0,0,1,1,1]]}),false);
 }
 const prior=bot.blockAt;bot.blockAt=raw=>raw.floored().y<69?Object.assign(Block.fromStateId(46),{position:raw.floored()}):prior(raw);
 assert.equal(graph.hasGroundedBodySupport(bot),false);
});
test('original native graph physically walks under dry hanging propagules without granting floor support',{timeout:6000},async t=>{
 const origin={x:0,y:69,z:0},f=fixture('air',origin),read=f.bot.blockAt,seen=new Set(),poses=[];let cp=null;
 f.bot.blockAt=q=>{const p=q.floored();return p.y===origin.y+1&&p.x>=0&&p.x<=16?Object.assign(Block.fromStateId(46),{position:p}):read(q);};
 f.bot.look=async(yaw,pitch)=>{f.bot.entity.yaw=yaw;f.bot.entity.pitch=pitch;};
 const timer=setInterval(()=>{f.bot.physics.simulatePlayer(new PlayerState(f.bot,f.bot.controlState),{getBlock:p=>f.bot.blockAt(p)}).apply(f.bot);
  poses.push(f.bot.entity.position.clone());for(const c of graph.inspectSurfaceBody(f.bot).cells)if(c.stateId===46)seen.add(key(c.position));f.bot.emit('physicsTick');},10);
 t.after(()=>{clearInterval(timer);f.bot.pathfinder.setGoal(null);f.bot.clearControlStates();});
 const g=graph.createHouseSurfaceGraph({getBot:()=>f.bot,assertActive:f.active,isMovementOwner:()=>f.state.owner,getCP:()=>cp,saveCP:v=>{f.active();cp=clone(v);}},{step:16,radius:32,maxNodes:4,maxEdges:128});
 const result=await g.next({anchor:origin});assert.equal(result.moved,true);assert.ok(poses.length>20);assert.ok(seen.size>5);assert.equal(cp.visits,2);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.isInWater,false);
});
