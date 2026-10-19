'use strict';
// Original native blocks and A*, immutable offline discovery fixtures. No
// server, movement, world writes, oxygen overrides or actual traversal credit.
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {Vec3}=require('vec3'),{pathfinder,Movements,goals}=require('mineflayer-pathfinder');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const root=process.env.HOUSE_WATER_BIOME_RUNTIME;
const moduleAt=name=>require(root?`${root}/vendor/server/minecraft/${name}`:`../vendor/server/minecraft/${name}`);
const {inspectBody,validateRoute}=moduleAt('houseShallowWaterTraversal');
const {createLoadedShallowWaterFinder}=moduleAt('houseShallowWaterFinder');
const {createLoadedSurfaceSwimFinder}=moduleAt('houseSurfaceSwimFinder');
const b=(name,p,properties={})=>{const type=registry.blocksByName[name];return Object.assign(Block.fromProperties(type.id,
 {...Block.fromStateId(type.defaultState).getProperties(),...properties},0),{position:p});};
function botFor(position,read) {
 const controls=[],packets=[];const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',username:'OfflineWaterBiome',
  health:20,food:20,game:{minY:-64,height:384,dimension:'overworld'},player:{ping:1},entities:{},players:{},
  inventory:{slots:Array(46).fill(null),items:()=>[]},entity:{position:position.clone(),velocity:new Vec3(0,-.0784000015258789,0),
   onGround:true,width:.6,height:1.8,eyeHeight:1.62,yaw:0,pitch:0,effects:{},attributes:{},isInWater:false,isInLava:false},
  _client:Object.assign(new EventEmitter(),{state:'play',socket:{writable:true,destroyed:false},write:(...args)=>packets.push(args)}),
  blockAt:p=>read(p.floored()),setControlState:(...args)=>controls.push(args),clearControlStates:()=>controls.push('clear'),stopDigging:()=>{},deactivateItem:()=>{}});
 pathfinder(bot);return{bot,controls,packets};
}
const deps=bot=>({getBot:()=>bot,assertActive:()=>{},Vec3,Movements,GoalBlock:goals.GoalBlock});

test('saved whole18 tall-grass body is inspectable while eye-air remains strictly false',()=>{
 const saved=require('../test-support/whole18-tall-grass-body-observation.json'),map=new Map(saved.facts.map(c=>[`${c.position.x},${c.position.y},${c.position.z}`,c])),p=saved.actualSnapshot.position;
 const f=botFor(new Vec3(p.x,p.y,p.z),q=>{const c=map.get(`${q.x},${q.y},${q.z}`);if(!c)return null;
  const native=Object.assign(Block.fromStateId(c.stateId),{position:q});assert.equal(native.name,c.name);assert.deepEqual(native.shapes,c.shapes);return native;});
 const body=inspectBody(f.bot,Vec3);assert.equal(body.onGround,true);assert.equal(body.isInWater,false);
 assert.equal(body.eyeAir,false,'tall grass does not become AIR or breathing proof');assert.ok(body.cells.every(c=>c.name==='tall_grass'));
 const before=f.bot.entity.position.clone();
 for(const factory of [createLoadedShallowWaterFinder,createLoadedSurfaceSwimFinder]){
  const found=factory(deps(f.bot)).find({origin:{x:-13,y:72,z:12},horizontalRadius:2,verticalRadius:0,scanTimeoutMs:200});
  assert.equal(found.routes.length,0,'unknown surroundings do not become a water route');
 }
 assert.deepEqual(f.bot.entity.position,before);assert.equal(f.controls.length,0);assert.equal(f.packets.length,0);
});

for(const [factory,width] of [[createLoadedShallowWaterFinder,4],[createLoadedSurfaceSwimFinder,32]])test(`native discovery can approach an AIR bank from supported plants, width ${width}`,()=>{
 const origin={x:-5,y:2,z:0},f=botFor(new Vec3(-4.5,2,.5),p=>{
  if(p.x < -24||p.x>width+12||Math.abs(p.z)>5||p.y< -8||p.y>8)return null;
  if(p.y>=2)return b(p.x<=-2&&p.y<4?'tall_grass':'air',p,{half:p.y===3?'upper':'lower'});
  if(p.x>=0&&p.x<width){if(p.y===1)return b('water',p,{level:0});return width===4?b('stone',p):null;}
  return b('stone',p);
 });
 const before=JSON.stringify(f.bot.entity);
 const result=factory(deps(f.bot)).find({origin,scanTimeoutMs:1000,readLimit:32768,resultLimit:4});
 assert.ok(result.routes.length>0,JSON.stringify(result.diagnostics));
 for(const candidate of result.routes){assert.equal(candidate.approach.actualConfirmed,false);assert.ok(candidate.approach.plannedPath.length>0);
  assert.ok(candidate.approach.plannedPath.some(p=>p.x<=-2),'original A* traverses supported plant cells');}
 assert.equal(JSON.stringify(f.bot.entity),before);assert.equal(f.controls.length,0);assert.equal(f.packets.length,0);
 const route=result.routes[0].route,read=f.bot.blockAt;
 f.bot.blockAt=p=>p.floored().equals(new Vec3(route.from.x,route.from.y,route.from.z))?b('tall_grass',p.floored(),{half:'lower'}):read(p);
 if(width===4)assert.throws(()=>validateRoute(f.bot,route,Vec3),e=>e.code==='water_bank_headroom');
 else assert.throws(()=>moduleAt('houseSurfaceSwim').validateSurfaceRoute(f.bot,route,Vec3),e=>e.code==='surface_swim_bank_air');
});

test('body plants do not permit dangerous blocks, flowing water, solid penetration or waterlogged roots',()=>{
 for(const [name,properties] of [['wither_rose',{}],['sweet_berry_bush',{}],['cobweb',{}],['nether_portal',{}],
  ['powder_snow',{}],['stone',{}],['water',{level:1}],['hanging_roots',{waterlogged:true}]]){
  const f=botFor(new Vec3(.5,64,.5),p=>b(p.y===64?name:'air',p,properties));
  assert.throws(()=>inspectBody(f.bot,Vec3),e=>e.code==='water_body_unsafe',name);
  assert.equal(f.controls.length,0);assert.equal(f.packets.length,0);
 }
});
