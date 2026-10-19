'use strict';
// Original installed Block / Physics / Pathfinder, constructed offline terrain.
// These are component proofs, not server or arbitrary-map acceptance.
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {Vec3}=require('vec3'),{Physics,PlayerState}=require('prismarine-physics'),{pathfinder}=require('mineflayer-pathfinder');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {NATURAL_BODY_PLANTS}=require('../vendor/server/minecraft/houseNaturalWalkingBody');
const root=process.env.HOUSE_BIOME_BODY_RUNTIME;
const {isNaturalWalkingBodyBlock}=require(root?`${root}/vendor/server/minecraft/houseNaturalWalkingBody`:'../vendor/server/minecraft/houseNaturalWalkingBody');
const {inspectSurfaceBody,naturalWalkingFoot,dryFoot,hasGroundedBodySupport,createHouseSurfaceGraph}=require(root?`${root}/vendor/server/minecraft/houseSurfaceGraph`:'../vendor/server/minecraft/houseSurfaceGraph');
const b=(name,p,properties={})=>{const type=registry.blocksByName[name],defaults=Block.fromStateId(type.defaultState).getProperties();
 return Object.assign(Block.fromProperties(type.id,{...defaults,...properties},0),{position:p});};

test('recorded whole17 AABB vine edge is dry without inventing loaded floor cells or changing original block states',()=>{
 const observation=require('../test-support/whole17-vine-body-observation.json'),o=observation.observedMovement;
 const cells=[...o.safetyFacts.body.cells,o.safetyFacts.below],map=new Map(cells.map(c=>[`${c.position.x},${c.position.y},${c.position.z}`,c]));
 const bot={entity:{position:new Vec3(o.position.x,o.position.y,o.position.z),width:.6,height:1.8,onGround:o.onGround,
  isInWater:o.isInWater,isInLava:o.isInLava},blockAt:p=>{
   const q=p.floored(),c=map.get(`${q.x},${q.y},${q.z}`);if(!c)return null;
   const native=Object.assign(Block.fromStateId(c.stateId),{position:q});
   assert.equal(native.name,c.name);assert.equal(native.boundingBox,c.boundingBox);assert.deepEqual(native.shapes,c.shapes);return native;
  }};
 assert.equal(o.safetyFacts.body.dry,false);assert.ok(o.safetyFacts.body.cells.some(c=>c.name==='vine'));
 assert.equal(inspectSurfaceBody(bot).dry,true);assert.equal(hasGroundedBodySupport(bot),true);
 assert.equal(bot.blockAt(new Vec3(-3,68,-9)),null,'unobserved neighbor floor remains unknown');
});
function fixture(origin,worldAt) {
 const controls=Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(k=>[k,false]));
 const writes=[];const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',username:'OfflineBiome',health:20,food:20,oxygenLevel:20,
  game:{minY:-64,height:384,dimension:'overworld'},entities:{},players:{},inventory:{slots:Array(46).fill(null),items:()=>[]},player:{ping:1},
  _client:{state:'play',socket:{writable:true,destroyed:false}},controlState:controls,jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,
  entity:{position:new Vec3(origin.x+.5,origin.y+.05,origin.z+.5),velocity:new Vec3(0,0,0),onGround:false,width:.6,height:1.8,eyeHeight:1.62,
   yaw:0,pitch:0,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:false,elytraFlying:false}});
 bot.blockAt=raw=>{const p=raw.floored();return worldAt(p);};
 bot.look=async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;};bot.stopDigging=()=>{};bot.deactivateItem=()=>{};
 bot.setControlState=(k,v)=>{writes.push({k,v});controls[k]=v;};bot.clearControlStates=()=>Object.keys(controls).forEach(k=>bot.setControlState(k,false));
 const physics=Physics(registry,{getBlock:bot.blockAt});bot.physics=physics;pathfinder(bot);
 const tick=()=>{physics.simulatePlayer(new PlayerState(bot,controls),{getBlock:bot.blockAt}).apply(bot);bot.emit('physicsTick');};
 for(let n=0;n<8;n++)tick();return{bot,tick,writes};
}
for(const origin of [{x:0,y:64,z:0},{x:-109,y:-29,z:211},{x:537,y:118,z:-483}])test(`fresh native plant states with actual grounded support at ${JSON.stringify(origin)}`,()=>{
 for(const name of NATURAL_BODY_PLANTS){
  const type=registry.blocksByName[name];assert.ok(type,name);
  for(let id=type.minStateId;id<=type.maxStateId;id++){
   const plant=Block.fromStateId(id),wet=plant.getProperties().waterlogged===true;
   assert.equal(isNaturalWalkingBodyBlock(plant),!wet&&plant.boundingBox==='empty'&&plant.shapes.length===0,`${name}:${id}`);
  }
  const f=fixture(origin,p=>b(p.y<origin.y?'grass_block':p.y<origin.y+2?name:'air',p));
  assert.equal(f.bot.entity.onGround,true,name);assert.equal(hasGroundedBodySupport(f.bot),true,name);
  assert.equal(inspectSurfaceBody(f.bot).dry,true,name);assert.equal(naturalWalkingFoot(f.bot,new Vec3(origin.x,origin.y,origin.z)),true,name);
  assert.equal(dryFoot(f.bot,new Vec3(origin.x,origin.y,origin.z)),false,name);
  assert.equal(f.writes.some(w=>w.v),false,name);
 }
});

for(const origin of [{x:-3,y:69,z:-8},{x:121,y:-24,z:303}])test(`original native walk accepts body-edge vines and mixed biome flora at ${JSON.stringify(origin)}`,{timeout:8000},async t=>{
 let cp=null;const touched=new Set();
 const f=fixture(origin,p=>{
  if(p.y<origin.y)return b('grass_block',p);
  if(p.y===origin.y||p.y===origin.y+1){
   // Any original cardinal route must cross mixed feet-level plants and
   // side/head vines. Coverage cannot depend on which equally safe frontier
   // wins the finite native planner's timing-dependent tie.
   const index=p.x-origin.x+p.z-origin.z;
   const name=p.y===origin.y+1&&(Math.abs(p.x-origin.x)+Math.abs(p.z-origin.z))%4===1?'vine':
    NATURAL_BODY_PLANTS[(index%NATURAL_BODY_PLANTS.length+NATURAL_BODY_PLANTS.length)%NATURAL_BODY_PLANTS.length];
   return b(name,p,{east:true,north:true});
  }
  return b('air',p);
 });
 const native=f.bot.pathfinder.goto.bind(f.bot.pathfinder);let gotos=0;const profiles=[];
 f.bot.pathfinder.goto=goal=>{gotos++;profiles.push({canDig:f.bot.pathfinder.movements.canDig,scaffold:[...f.bot.pathfinder.movements.scafoldingBlocks]});return native(goal);};
 f.bot.on('physicsTick',()=>{for(const cell of inspectSurfaceBody(f.bot).cells)if(NATURAL_BODY_PLANTS.includes(cell.name))touched.add(cell.name);});
 const timer=setInterval(f.tick,10);t.after(()=>{clearInterval(timer);f.bot.pathfinder.setGoal(null);f.bot.clearControlStates();});
 const graph=createHouseSurfaceGraph({getBot:()=>f.bot,assertActive:()=>{},isMovementOwner:()=>true,getCP:()=>cp,saveCP:v=>{cp=JSON.parse(JSON.stringify(v));}},
  {radius:32,step:16,maxNodes:4,maxEdges:128});
 const result=await graph.next({anchor:origin});
 assert.equal(result.moved,true);assert.ok(gotos>0);assert.equal(f.bot.entity.onGround,true);assert.equal(hasGroundedBodySupport(f.bot),true);
 assert.ok(touched.has('vine'),'fresh AABB included side vines, not just center-column air');assert.ok(touched.size>=10);
 assert.equal(cp.visits,2);assert.equal(f.bot.entity.isInWater,false);assert.equal(f.bot.entity.isInLava,false);
 assert.ok(profiles.every(p=>p.canDig===false&&p.scaffold.length===0));
});

test('plants do not become floor supports or allow unsupported vine climbing',async()=>{
 const origin={x:0,y:64,z:0};const f=fixture(origin,p=>b(p.y<origin.y?'vine':'air',p,{east:true}));
 assert.equal(f.bot.entity.onGround,false);assert.equal(hasGroundedBodySupport(f.bot),false);
 assert.equal(naturalWalkingFoot(f.bot,f.bot.entity.position.floored()),false);
 const graph=createHouseSurfaceGraph({getBot:()=>f.bot,assertActive:()=>{},isMovementOwner:()=>true});
 await assert.rejects(graph.next({anchor:origin}));assert.equal(f.writes.some(w=>w.v),false);
 for(const name of ['wither_rose','sweet_berry_bush','powder_snow','cobweb','nether_portal','end_portal','water','lava','fire'])
  assert.equal(isNaturalWalkingBodyBlock(b(name,new Vec3(0,64,0))),false,name);
});
