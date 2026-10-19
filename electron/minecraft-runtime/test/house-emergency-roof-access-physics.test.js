'use strict';
// Original pathfinder, Physics and prismarine-world raycasts. World dig/place
// ACKs and inventory are MODELED; this is not real Java construction proof.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3'),{Movements,goals}=require('mineflayer-pathfinder');
const file=path.join(__dirname,'house-surface-graph.test.js'),src=fs.readFileSync(file,'utf8'),native=new Module(file,module);native.filename=file;native.paths=Module._nodeModulePaths(__dirname);native._compile(src.slice(0,src.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',file);
const {planEmergencyShelter,planEmergencyRoof}=require('../vendor/server/minecraft/houseEmergencyShelter'),{completeEmergencyRoofAccess}=require('../vendor/server/minecraft/houseEmergencyRoofAccess'),{hasGroundedBodySupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
const WorldSync=require('prismarine-world/src/worldsync'),key=p=>`${p.x},${p.y},${p.z}`;
for(const mode of ['sealed_partial','new_build','foreign_wall','unknown_tread','no_stock','pause','no_place_ack','saved176','edge_build'])test(`native emergency roof access and final seal ${mode}`,{timeout:10000},async t=>{
 const saved=mode==='saved176'?require('../test-support/fixtures/formal58-run176-partial-emergency-roof.json'):null;
 const cells=new Map(),writes=[],events=[];let stock=saved?23:32,active=mode!=='pause';
 const f=native.exports.fixture(t,{initialPosition:saved?new Vec3(saved.position.x,saved.position.y,saved.position.z):mode==='edge_build'?new Vec3(.01,1,.99):undefined,initialVelocity:new Vec3(0,-.0784000015258789,0),worldAt:p=>{
  if(mode==='unknown_tread'&&p.x===-2&&p.y===0&&Math.abs(p.z)<=1)return null;
  if(cells.has(key(p)))return cells.get(key(p));
  if(saved){const i=saved.states[key(p)];return i===undefined?null:saved.palette[i];}
  return p.y<=0?'stone':'air';
 }}),bot=f.bot,profile=new Movements(bot);Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allowSprinting:false,allow1by1towers:false,allowFreeMotion:false,maxDropDown:2,infiniteLiquidDropdownDistance:false});profile.getMoveDiagonal=()=>{};bot.pathfinder.setMovements(profile);
 const world=Object.create(WorldSync.prototype);world.getBlock=p=>bot.blockAt(p.floored());bot.world=world;
 const at=p=>bot.blockAt(new Vec3(p.x,p.y,p.z)),threat={id:7,name:'skeleton',height:1.8,position:saved?new Vec3(-247.5,72,40.5):new Vec3(10.5,1,.5)};
 const plan=saved?JSON.parse(JSON.stringify(saved.cover.plan)):planEmergencyShelter({position:bot.entity.position,threat:threat.position,blockAt:at,inventory:{dirt:32,cobblestone:0}});assert.ok(plan);
 const cover={plan,placed:saved?JSON.parse(JSON.stringify(saved.cover.placed)):['new_build','edge_build'].includes(mode)?[]:plan.blocks.map(s=>({...s}))},ledger=new Map(cover.placed.map(s=>[key(s.position),s]));
 if(!saved&&!['new_build','edge_build'].includes(mode))for(const s of plan.blocks)cells.set(key(s.position),s.item);
 if(mode==='foreign_wall'){cover.placed=cover.placed.filter(s=>s.position.x!==-1||s.position.z!==0);for(const [k,s]of ledger)if(s.position.x===-1&&s.position.z===0)ledger.delete(k);}
 if(mode==='no_stock')stock=0;
 const probe=goal=>{const it=bot.pathfinder.getPathFromTo(profile,bot.entity.position,goal,{timeout:300,tickTimeout:10});let r;for(let i=0;i<32;i++){const n=it.next();r=n.value?.result;if(n.done||r?.status!=='partial')break;}it.return?.();return r;};
 if(mode==='sealed_partial'){
  const roof=planEmergencyRoof({plan,blockAt:at,inventory:{dirt:32,cobblestone:0}}),cap=roof.blocks[0],below=new Vec3(0,-1,0);
  const g=new goals.GoalPlaceBlock(new Vec3(cap.position.x,cap.position.y,cap.position.z),world,{range:4.5,faces:[below]});assert.notEqual(probe(g)?.status,'success','sealed two-high walls cannot reach the first raised roof anchor');
 }
 const assertActive=()=>{if(!active)throw Object.assign(Error('paused'),{code:'paused'});};
 const intersects=p=>{const a=bot.entity.position;return a.x+.3>p.x&&a.x-.3<p.x+1&&a.z+.3>p.z&&a.z-.3<p.z+1&&a.y+1.8>p.y&&a.y<p.y+1;};
 const deps={getBot:()=>bot,assertActive,blockAt:at,count:n=>n==='dirt'?stock:0,threats:()=>[threat],excluded:()=>false,
  canRemove:()=>true,remove:async block=>{assertActive();writes.push(['dig',key(block.position)]);cells.set(key(block.position),'air');},retire:s=>ledger.delete(key(s.position)),remember:s=>ledger.set(key(s.position),s),
  place:async(spec,onConfirmed)=>{
   assertActive();const target=new Vec3(spec.position.x,spec.position.y,spec.position.z),g=new goals.GoalPlaceBlock(target,world,{range:4.5});
   const ready=()=>!intersects(target)&&hasGroundedBodySupport(bot)&&g.getFaceAndRef(bot.entity.position.offset(0,1.62,0));
   if(!ready()){
    assert.equal(probe(g)?.status,'success',`actual native placement stance ${key(target)}`);await bot.pathfinder.goto(g);
    const until=Date.now()+1000;while(!ready()&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
   }
   assert.ok(ready(),`actual grounded native placement ray ${key(target)}`);writes.push(['place',key(target)]);
   if(mode==='no_place_ack')return;
   assert.ok(stock>0);stock--;cells.set(key(target),spec.item);onConfirmed();
  },
  goto:async g=>{assertActive();await bot.pathfinder.goto(g);},wait:ms=>new Promise(r=>setTimeout(r,ms)),record:(kind,facts)=>events.push({kind,facts})};
 const run=()=>completeEmergencyRoofAccess(deps,{cover,deadline:Date.now()+7000});
 if(['foreign_wall','unknown_tread','no_stock','pause','no_place_ack'].includes(mode)){
  await assert.rejects(run(),{code:mode==='pause'?'paused':mode==='no_place_ack'?'house_recovery_cover_unconfirmed':'house_recovery_cover_access_unavailable'});
  if(mode!=='no_place_ack')assert.equal(writes.length,0);return;
 }
 assert.equal(await run(),true);const b=plan.bounds,roofKey=key({x:b.loX+1,y:b.y+2,z:b.loZ+1}),door=cover.roofAccess.seals;
 assert.equal(at({x:b.loX+1,y:b.y+2,z:b.loZ+1}).name,'dirt');for(const p of door)assert.equal(at(p.position).name,'dirt');
 assert.ok(f.points.some(p=>p.x<b.loX&&p.y>=b.y+1));assert.ok(hasGroundedBodySupport(bot));assert.ok(Math.abs(bot.entity.position.x-Math.floor(plan.origin.x)-.5)<=.2);
 assert.ok(events.some(e=>e.kind==='house_emergency_roof_access_sealed'));assert.ok(ledger.has(key(cover.roofAccess.stepPosition)));
 const roofIndex=writes.findIndex(e=>e[0]==='place'&&e[1]===roofKey),lastDoor=writes.findLastIndex(e=>e[0]==='place'&&e[1]===key(door[1].position));assert.ok(roofIndex>=0&&lastDoor>roofIndex);
});
