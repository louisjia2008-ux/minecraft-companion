'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root='./.minecraft-local-test',candidate=`${root}/runtime-candidates/house-self34-aquatic-body-clearance-20261014`,run=`${root}/worlds/natural-public-cottage-self-20`,world=`${run}/world`;
const req=require('node:module').createRequire(`${candidate}/package.json`),{Vec3}=req('vec3'),registry=req('prismarine-registry')('1.21.8'),Block=req('prismarine-block')(registry);
const {readRegionChunk,decodeSectionBlock}=req('./test-support/natural-world-audit.cjs'),{inspectBody}=req('./vendor/server/minecraft/houseShallowWaterTraversal'),surface=req('./vendor/server/minecraft/houseSurfaceGraph');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const tree=dir=>Object.fromEntries(fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?Object.entries(tree(path.join(dir,e.name))):e.isFile()?[[path.join(dir,e.name),hash(path.join(dir,e.name))]]:[]));
(async()=>{
 const before=tree(run),result=JSON.parse(fs.readFileSync(`${run}/result.json`)),events=fs.readFileSync(`${run}/events.jsonl`,'utf8').trim().split('\n').map(JSON.parse);
 const last=[...events].reverse().find(v=>v.type==='snapshot'),p=last.position,center=new Vec3(p.x,p.y,p.z).floored(),{chunk}=await readRegionChunk(world,center);assert.ok(['full','minecraft:full'].includes(chunk.Status));
 const facts=[],map=new Map();
 for(let x=center.x-1;x<=center.x+1;x++)for(let z=center.z-1;z<=center.z+1;z++)for(let y=center.y-2;y<=center.y+3;y++){
  const q=new Vec3(x,y,z),s=chunk.sections.find(s=>s.Y===Math.floor(y/16)),data=s?decodeSectionBlock(s,q):{name:'minecraft:air',properties:{}};
  const type=registry.blocksByName[data.name.replace(/^minecraft:/,'')];assert.ok(type,data.name);
  const b=Object.assign(Block.fromProperties(type.id,data.properties||{},0),{position:q});map.set(`${x},${y},${z}`,b);
  facts.push({position:{x,y,z},name:b.name,stateId:b.stateId,boundingBox:b.boundingBox,shapes:b.shapes,properties:b.getProperties()});
 }
 const bot={entity:{position:new Vec3(p.x,p.y,p.z),velocity:new Vec3(last.velocity.x,last.velocity.y,last.velocity.z),onGround:last.onGround,
  width:.6,height:1.8,eyeHeight:1.62,isInWater:false,isInLava:false},health:last.health,food:last.food,oxygenLevel:20,
  blockAt:q=>map.get(`${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`)||null};
 let old;try{old={passed:true,facts:inspectBody(bot,Vec3)};}catch(error){old={passed:false,code:error.code,message:error.message,cells:error.cells,position:error.position};}
 assert.deepEqual(tree(run),before);
 const report={schema:1,status:'READONLY_SAVED_WORLD_COMPONENT_REPLAY',seed:result.seed,sourceRun:result.runName,
  resultSha256:hash(`${run}/result.json`),sourceModuleSha256:hash(`${candidate}/vendor/server/minecraft/houseShallowWaterTraversal.js`),
  actualSnapshot:{position:p,velocity:last.velocity,onGround:last.onGround,health:last.health,food:last.food},facts,old,
  surface:{body:surface.inspectSurfaceBody(bot),walkingFoot:surface.naturalWalkingFoot(bot,center),grounded:surface.hasGroundedBodySupport(bot)},wholeHouseAcceptance:false,allOriginalRunBytesUnchanged:true,limitations:'Saved block-state replay; water flags configured dry from unchanged grounded final pose, no Java startup, movement, network or coordinate injection into production.'};
 const file=`${root}/evidence/estate-20261013/natural-public-cottage-self-20-body-readonly.json`;
 fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({file,sha256:hash(file),old,surface:report.surface,nearFoot:facts.filter(c=>c.position.x===center.x&&c.position.z===center.z),originalBytesUnchanged:true}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
