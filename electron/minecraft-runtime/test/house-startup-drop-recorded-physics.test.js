'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
const saved=require('../test-support/fixtures/formal45-startup-drop.json'),buf=require('node:zlib').gunzipSync(Buffer.from(saved.statesGzipBase64,'base64')),cells=new Uint16Array(buf.buffer,buf.byteOffset,buf.byteLength/2),b=saved.bounds;
const {pickupStartupDrop}=require('../vendor/server/minecraft/houseStartupDropPickup');
function fixture(t){const f=native.exports.fixture(t,{initialPosition:new Vec3(saved.start.x,saved.start.y,saved.start.z),worldAt:p=>{
 if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;
 return saved.palette[cells[(p.x-b.minX)*(b.maxZ-b.minZ+1)*(b.maxY-b.minY+1)+(p.z-b.minZ)*(b.maxY-b.minY+1)+p.y-b.minY]];
 }});const item={id:100,isValid:true,position:new Vec3(-204.6541235776861,74,39.65463823958733),getDroppedItem:()=>({name:'jungle_log'})};f.bot.entities[item.id]=item;return {...f,item};}
test('formal45 saved log endpoint is NoPath under ordinary one-metre drop policy',async t=>{
 const f=fixture(t),{Movements,goals}=require('mineflayer-pathfinder'),m=new Movements(f.bot);m.canDig=false;m.allowParkour=false;m.allowSprinting=false;m.allow1by1towers=false;m.scafoldingBlocks=[];m.maxDropDown=2;
 const result=f.bot.pathfinder.getPathTo(m,new goals.GoalBlock(-205,74,39),1000);assert.equal(result.status,'noPath');assert.equal(f.attempts.length,0);
});
test('formal45 pickup physically reaches saved two-metre dry log endpoint without material receipt',{timeout:8000},async t=>{
 const f=fixture(t),records=[];const result=await pickupStartupDrop({...f.deps,onProbe:v=>t.diagnostic(JSON.stringify(v)),record:v=>records.push(v)},{entity:f.item,expectedName:'jungle_log',deadline:Date.now()+5000});
 t.diagnostic(JSON.stringify({result,attempts:f.attempts,cp:f.checkpoint()}));assert.equal(result,true);assert.equal(f.bot.entity.onGround,true);assert.deepEqual(f.bot.entity.position.floored(),new Vec3(-205,74,39));assert.equal(f.bot.health,20);assert.equal(f.waterTicks.length,0);assert.ok(f.points.length>3);assert.equal(records[0].inventoryCredit,false);assert.equal(f.bot.inventory.items().length,0);
});
for(const mode of ['foreignEntity','wrongItem','airborneItem','tooDeep','cancelled','unknownFloor','waterFloor'])test(`startup drop refuses ${mode} before movement`,async t=>{
 const f=fixture(t);if(mode==='foreignEntity')f.bot.entities[f.item.id]={...f.item};if(mode==='wrongItem')f.item.getDroppedItem=()=>({name:'dirt'});if(mode==='airborneItem')f.item.position.y+=.4;if(mode==='tooDeep')f.item.position.y-=1;if(mode==='cancelled')f.cancel();
 if(['unknownFloor','waterFloor'].includes(mode)){const old=f.bot.blockAt;f.bot.blockAt=p=>p.floored().equals(new Vec3(-205,73,39))?(mode==='unknownFloor'?null:Object.assign(require('prismarine-block')(f.bot.registry).fromStateId(f.bot.registry.blocksByName.water.defaultState),{position:p.floored()})):old(p);}
 const work=pickupStartupDrop(f.deps,{entity:f.item,expectedName:'jungle_log',deadline:Date.now()+3000});if(mode==='cancelled')await assert.rejects(work,{code:'cancelled'});else assert.equal(await work,false);assert.equal(f.attempts.length,0);
});
for(const reason of ['pause','foreignOwner'])test(`startup pickup stops when ${reason} arrives during native movement`,{timeout:5000},async t=>{
 const f=fixture(t);let owner=true;const original=f.bot.pathfinder.goto.bind(f.bot.pathfinder);f.bot.pathfinder.goto=goal=>{const p=original(goal);queueMicrotask(()=>{if(reason==='pause')f.cancel();else owner=false;});return p;};
 await assert.rejects(pickupStartupDrop({...f.deps,isMovementOwner:()=>owner},{entity:f.item,expectedName:'jungle_log',deadline:Date.now()+3000}),reason==='pause'?{code:'cancelled'}:{code:'dry_graph_movement_preempted'});
 assert.equal(f.bot.inventory.items().length,0);
});
