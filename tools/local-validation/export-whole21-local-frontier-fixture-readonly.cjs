'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const root='./.minecraft-local-test',candidate=`${root}/runtime-candidates/house-self35-native-snow1-body-20261014`,run=`${root}/worlds/natural-public-cottage-self-21`,world=`${run}/world`;
const req=require('node:module').createRequire(`${candidate}/package.json`),{Vec3}=req('vec3'),registry=req('prismarine-registry')('1.21.8'),Block=req('prismarine-block')(registry),{pathfinder,goals}=req('mineflayer-pathfinder');
const {readRegionChunk,decodeSectionBlock}=req('./test-support/natural-world-audit.cjs'),{createLoadedDryGraph,loadedSurfaceFeet}=req('./vendor/server/minecraft/houseSurfaceGraph');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function tree(dir){return Object.fromEntries(fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const f=path.join(dir,e.name);return e.isDirectory()?Object.entries(tree(f)):e.isFile()?[[f,hash(f)]]:[];}));}
(async()=>{
 const before=tree(run),r=JSON.parse(fs.readFileSync(`${run}/result.json`)),p=r.finalReadback.clientPosition,a=r.task.siteSearch.graph.anchor;
 const chunks=new Map(),cache=new Map(),missing=[];
 for(let x=-3;x<=2;x++)for(let z=-3;z<=2;z++){try{const {chunk}=await readRegionChunk(world,new Vec3(x*16,88,z*16));if(['full','minecraft:full'].includes(chunk.Status))chunks.set(`${x},${z}`,chunk);else missing.push({x,z});}catch(error){missing.push({x,z,error:error.code||error.message});}}
 const blockAt=raw=>{const q=raw.floored(),key=`${q.x},${q.y},${q.z}`;if(cache.has(key))return cache.get(key);const chunk=chunks.get(`${Math.floor(q.x/16)},${Math.floor(q.z/16)}`);if(!chunk)return null;
  const s=chunk.sections.find(s=>s.Y===Math.floor(q.y/16)),data=s?decodeSectionBlock(s,q):{name:'minecraft:air',properties:{}};
  const type=registry.blocksByName[data.name.replace(/^minecraft:/,'')];if(!type)return null;
  const b=Object.assign(Block.fromProperties(type.id,data.properties||{},0),{position:q});cache.set(key,b);return b;
 };
 const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',username:'ReadonlyLocalFrontier',health:20,food:20,
  game:{minY:-64,height:384,dimension:'overworld'},player:{ping:1},players:{},entities:{},inventory:{slots:Array(46).fill(null),items:()=>[]},
  entity:{id:1,position:new Vec3(p.x,p.y,p.z),velocity:new Vec3(0,-.0784000015258789,0),onGround:true,width:.6,height:1.8,eyeHeight:1.62,
   yaw:0,pitch:0,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false},blockAt,
  _client:Object.assign(new EventEmitter(),{state:'play',write:()=>{throw Error('No native writes in readonly probe');}}),
  setControlState:()=>{throw Error('No controls in readonly probe');},clearControlStates:()=>{},stopDigging:()=>{},deactivateItem:()=>{}});
 bot.entities[1]=bot.entity;pathfinder(bot);const graph=createLoadedDryGraph({getBot:()=>bot,assertActive:()=>{}},{anchor:a}),rows=[];
 const directions=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
 for(const radius of[1,2,4,8,16])for(const [dx,dz] of directions){
  const targets=loadedSurfaceFeet(bot,a.x+dx*radius,a.z+dz*radius,a.y,{up:8,down:8}).slice(0,3);
  for(const target of targets){const result=bot.pathfinder.getPathTo(graph.movements,new goals.GoalBlock(target.x,target.y,target.z),120);rows.push({radius,target:{x:target.x,y:target.y,z:target.z},status:result.status,pathCount:result.path.length,
   endpoint:result.path.length?{x:result.path.at(-1).x,y:result.path.at(-1).y,z:result.path.at(-1).z}:null,
   plannedPath:result.status==='success'?result.path.map(p=>({x:p.x,y:p.y,z:p.z})):null});}
 }
 assert.deepEqual(tree(run),before);
 const report={schema:1,status:'READONLY_COUNTERFACTUAL_NATIVE_LOCAL_FRONTIER',seed:r.seed,actualAnchor:a,actualPosition:p,chunks:chunks.size,missing,
  rows,allOriginalRunBytesUnchanged:true,noMovement:true,noProductionCoordinateInjection:true,
  limitations:'Saved geometry with original installed A* and frozen35 profile. Historical other entities, exact loaded set and dynamic creep exclusions are UNKNOWN. Planned success is not actual movement or site acceptance.'};
 const fixture={schema:1,domain:'OFFLINE_SAVED_GEOMETRY_NATIVE_PHYSICS_COMPONENT_ONLY',sourceRun:r.runName,seed:r.seed,resultSha256:hash(`${run}/result.json`),anchor:a,initialPosition:p,bounds:{minX:a.x-6,maxX:a.x+6,minZ:a.z-6,maxZ:a.z+6,minY:a.y-8,maxY:a.y+12},palette:[],data:[]}; const ids=new Map(); for(let x=fixture.bounds.minX;x<=fixture.bounds.maxX;x++)for(let z=fixture.bounds.minZ;z<=fixture.bounds.maxZ;z++)for(let y=fixture.bounds.minY;y<=fixture.bounds.maxY;y++){const b=blockAt(new Vec3(x,y,z));if(!b){fixture.data.push(-1);continue;}if(!ids.has(b.stateId)){ids.set(b.stateId,fixture.palette.length);fixture.palette.push({name:b.name,stateId:b.stateId,boundingBox:b.boundingBox,shapes:b.shapes,properties:b.getProperties()});}fixture.data.push(ids.get(b.stateId));} const fp='electron/minecraft-runtime/test-support/whole21-local-frontier-voxels.json';fs.writeFileSync(fp,JSON.stringify(fixture)+'\n',{flag:'wx'});const file=`${root}/evidence/estate-20261013/natural-public-cottage-self-21-local-frontier-fixture-export.json`;
 fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({file,sha256:hash(file),successful:rows.filter(r=>r.status==='success').map(({plannedPath,...r})=>r),unchanged:true}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
