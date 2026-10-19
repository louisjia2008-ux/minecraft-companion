'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3'),{Movements}=require('mineflayer-pathfinder');
const {seekHouseRangedCover,rangedCoverConfirmed}=require('../vendor/server/minecraft/houseRangedCover');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
const terrain=require('../test-support/fixtures/formal13-ranged-quarry.json');
test('formal13 a recorded exposed mine lip can physically retreat to its loaded protected tunnel under the same no-dig profile',{timeout:12000},async t=>{
 const o=terrain.origin,f=native.exports.fixture(t,{initialPosition:new Vec3(o.x,o.y,o.z),worldAt:p=>{const b=terrain.bounds;if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;return terrain.palette[terrain.states[`${p.x},${p.y},${p.z}`]||0];}}),e={id:3068,name:'skeleton',height:1.99,isValid:true,position:new Vec3(44.5,12,-60.9)};
 f.bot.entities[3068]=e;const profile=new Movements(f.bot);Object.assign(profile,{canDig:false,allowParkour:false,allow1by1towers:false,allowSprinting:false,allowFreeMotion:false,maxDropDown:2,infiniteLiquidDropdownDistance:false,scafoldingBlocks:[]});profile.getMoveDiagonal=()=>{};
 const columns=new Set(['43,-69','44,-69']);profile.exclusionAreasStep.push(b=>columns.has(`${b.position.x},${b.position.z}`)?0:1000);profile.exclusionAreasPlace.push(()=>1000);profile.exclusionAreasBreak.push(()=>1000);f.bot.pathfinder.setMovements(profile);
 const probes=[],nativeProbe=f.bot.pathfinder.getPathFromTo.bind(f.bot.pathfinder);f.bot.pathfinder.getPathFromTo=function*(...args){const it=nativeProbe(...args);for(;;){const n=it.next();probes.push({goal:{x:args[2].x,y:args[2].y,z:args[2].z},status:n.value?.result?.status,path:n.value?.result?.path?.map(p=>({x:p.x,y:p.y,z:p.z,toBreak:p.toBreak,toPlace:p.toPlace})),done:n.done});if(n.done)return n.value;yield n.value;}};
 assert.equal(rangedCoverConfirmed(f.bot,f.bot.entity.position,[e]),false);
 const deadline=Date.now()+8000;
 const positions=Array.from({length:6},(_,i)=>({x:38+i,y:16,z:-69}));
 const result=await require('../vendor/server/minecraft/houseMiningRangedRetreat').withRecordedMiningRangedRetreat({getBot:()=>f.bot,assertActive:f.deps.assertActive,setActive(){},positions,deadline},({assertActive})=>seekHouseRangedCover({getBot:()=>f.bot,assertActive,goto:g=>f.bot.pathfinder.goto(g)}, {deadline}));
 assert.equal(result.covered,true,JSON.stringify({result,probes:probes.slice(-10)}));assert.ok(f.bot.entity.position.distanceTo(new Vec3(o.x,o.y,o.z))>.1);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.pathfinder.movements,profile);
});

for(const mode of ['foreign_owner','missing_recorded_origin'])test(`recorded mining retreat refuses ${mode} without restoring or moving a stale actor`,async t=>{
 const o=terrain.origin,f=native.exports.fixture(t,{initialPosition:new Vec3(o.x,o.y,o.z),worldAt:p=>{const b=terrain.bounds;if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;return terrain.palette[terrain.states[`${p.x},${p.y},${p.z}`]||0];}});
 let owns=true,entered=false;const foreign=new Movements(f.bot),previous=f.bot.pathfinder.movements;
 const positions=Array.from({length:mode==='missing_recorded_origin'?5:6},(_,i)=>({x:38+i,y:16,z:-69}));
 const running=require('../vendor/server/minecraft/houseMiningRangedRetreat').withRecordedMiningRangedRetreat({getBot:()=>f.bot,positions,deadline:Date.now()+1000,setActive(){},assertActive(){if(!owns)throw Object.assign(Error('cancelled'),{code:'cancelled'});}},async()=>{entered=true;owns=false;f.bot.pathfinder.setMovements(foreign);});
 if(mode==='missing_recorded_origin'){await assert.rejects(running,{code:'house_mining_retreat_unavailable'});assert.equal(entered,false);assert.equal(f.bot.pathfinder.movements,previous);}
 else{await running;assert.equal(f.bot.pathfinder.movements,foreign);}
 assert.equal(f.attempts.length,0);
});

test('a new close threat can escalate within the same survival owner after the scoped profile is restored',async t=>{
 const o=terrain.origin,f=native.exports.fixture(t,{initialPosition:new Vec3(o.x,o.y,o.z),worldAt:p=>{const b=terrain.bounds;if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;return terrain.palette[terrain.states[`${p.x},${p.y},${p.z}`]||0];}}),previous=f.bot.pathfinder.movements;
 let escalated=false;
 await assert.rejects(require('../vendor/server/minecraft/houseMiningRangedRetreat').withRecordedMiningRangedRetreat({getBot:()=>f.bot,positions:Array.from({length:6},(_,i)=>({x:38+i,y:16,z:-69})),deadline:Date.now()+1000,setActive(){},isOwnerCurrent:()=>true,assertActive(){if(escalated)throw Object.assign(Error('new contact threat'),{code:'survival_threat_escalated'});}},async()=>{escalated=true;throw Object.assign(Error('new contact threat'),{code:'survival_threat_escalated'});}),{code:'survival_threat_escalated'});
 assert.equal(f.bot.pathfinder.movements,previous);assert.equal(f.attempts.length,0);
});
