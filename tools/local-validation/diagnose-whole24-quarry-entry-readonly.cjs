'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const base='./.minecraft-local-test',run=`${base}/worlds/natural-public-cottage-self-24`,candidate=`${base}/runtime-candidates/house-self39-resource-survival-20261015`;
const req=require('node:module').createRequire(`${candidate}/package.json`),{Vec3}=req('vec3'),registry=req('prismarine-registry')('1.21.8'),Block=req('prismarine-block')(registry);
const {readRegionChunk,decodeSectionBlock}=req('./test-support/natural-world-audit.cjs'),{createHouseQuarryEntry}=req('./vendor/server/minecraft/houseQuarryEntry'),{inspectMiningStep,CARDINALS,classifyMiningBlock}=req('./vendor/server/minecraft/miningNavigation'),surface=req('./vendor/server/minecraft/houseSurfaceGraph');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const tree=d=>Object.fromEntries(fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?Object.entries(tree(path.join(d,e.name))):e.isFile()?[[path.join(d,e.name),hash(path.join(d,e.name))]]:[]));
(async()=>{
 const before=tree(run),v=JSON.parse(fs.readFileSync(`${run}/result.json`)),s=v.task.materialSupply,camp=s.camp.anchor;
 const file=`${run}/events.jsonl`,fd=fs.openSync(file,'r'),size=fs.statSync(file).size,buf=Buffer.alloc(Math.min(size,1048576));fs.readSync(fd,buf,0,buf.length,size-buf.length);fs.closeSync(fd);
 const rows=buf.toString().split('\n').slice(1).filter(Boolean).map(JSON.parse),last=rows.reverse().find(e=>e.type==='snapshot');
 const chunks=new Map(),facts=[],map=new Map();
 for(let x=camp.x-8;x<=camp.x+8;x++)for(let z=camp.z-8;z<=camp.z+8;z++)for(let y=camp.y-8;y<=camp.y+6;y++){
  const q=new Vec3(x,y,z),id=`${Math.floor(x/16)},${Math.floor(z/16)}`;
  if(!chunks.has(id)){try{const {chunk}=await readRegionChunk(`${run}/world`,q);chunks.set(id,['full','minecraft:full'].includes(chunk.Status)?chunk:null);}catch{chunks.set(id,null);}}
  const chunk=chunks.get(id);if(!chunk)continue;
  const section=chunk.sections.find(a=>a.Y===Math.floor(y/16)),data=section?decodeSectionBlock(section,q):{name:'minecraft:air',properties:{}};
  const type=registry.blocksByName[data.name.replace(/^minecraft:/,'')];assert.ok(type,data.name);
  const block=Object.assign(Block.fromProperties(type.id,data.properties||{},0),{position:q});map.set(`${x},${y},${z}`,block);
  facts.push({position:{x,y,z},name:block.name,stateId:block.stateId,properties:block.getProperties()});
 }
 const at=q=>map.get(`${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`)||null;
 const p=last.position,bot={game:{minY:-64,height:384},entity:{position:new Vec3(p.x,p.y,p.z),velocity:new Vec3(last.velocity.x,last.velocity.y,last.velocity.z),onGround:last.onGround,width:.6,height:1.8,isInWater:false,isInLava:false},blockAt:at};
 const blueprint=req('./vendor/server/minecraft/furnishedHouseBlueprints').createFurnishedHouseBlueprint(s.houseAnchor,{profile:'cottage'}),cells=[...blueprint.blocks,...blueprint.scaffold].map(a=>a.position),bb={...blueprint.bounds,minY:blueprint.anchor.y-3,maxY:blueprint.bounds.maxY+2,minX:Math.min(blueprint.bounds.minX,...cells.map(p=>p.x))-1,maxX:Math.max(blueprint.bounds.maxX,...cells.map(p=>p.x))+1,minZ:Math.min(blueprint.bounds.minZ,...cells.map(p=>p.z))-1,maxZ:Math.max(blueprint.bounds.maxZ,...cells.map(p=>p.z))+1};
 const pointBounds=p=>({minX:p.x,maxX:p.x,minZ:p.z,maxZ:p.z,minY:p.y-1,maxY:p.y+2}),inBounds=(p,b)=>p.x>=b.minX&&p.x<=b.maxX&&p.y>=b.minY&&p.y<=b.maxY&&p.z>=b.minZ&&p.z<=b.maxZ;
 const exclusion=[bb,pointBounds(camp),...Object.values(s.camp.stations).map(pointBounds),...s.camp.storageSites.map(pointBounds)];
 const entryExcluded=p=>inBounds(p,bb)||Object.values(s.ownedStations||{}).some(a=>inBounds(p,pointBounds(a.position)));
 const protectedDig=p=>exclusion.some(b=>inBounds(p,b));
 const deps={getBot:()=>bot,getObservedGraph:()=>null,blockAt:at,assertActive:()=>{},isOwnerContext:()=>true,isExcludedEntry:entryExcluded,isProtectedDig:protectedDig};
 let choice;try{choice={passed:true,entry:createHouseQuarryEntry(deps,{camp}).choose()};}catch(e){choice={passed:false,code:e.code,message:e.message};}
 const steps=CARDINALS.flatMap(direction=>[true,false].map(descend=>{const check=inspectMiningStep({blockAt:at,from:camp,direction,descend,minY:-64,maxY:319});return {direction,descend,ok:check.ok,code:check.code,reason:check.reason,needsSupport:check.needsSupport,protectedClearance:check.clearance?.filter(p=>!classifyMiningBlock(at(new Vec3(p.x,p.y,p.z))).passable&&protectedDig(p))};}));
 assert.deepEqual(tree(run),before);
 const report={schema:1,status:'READONLY_SAVED_QUARRY_ENTRY_REPLAY',seed:v.seed,camp,actualSnapshot:{position:p,onGround:last.onGround,velocity:last.velocity},actorWaterFlags:'configured dry for replay; original snapshot has no wet flags',campBelow:facts.find(f=>f.position.x===camp.x&&f.position.z===camp.z&&f.position.y===camp.y-1),body:surface.inspectSurfaceBody(bot),grounded:surface.hasGroundedBodySupport(bot),choice,steps,facts,allOriginalRunBytesUnchanged:true,wholeHouseAcceptance:false,limitations:'Saved native block geometry only; original entities, packet-time loaded set and flags not reconstructed. No live movement or server restart.'};
 const out=`${base}/evidence/estate-20261013/natural-public-cottage-self-24-quarry-entry-readonly.json`;fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({out,sha256:hash(out),campBelow:report.campBelow,bodyDry:report.body.dry,grounded:report.grounded,choice,steps,originalBytesUnchanged:true}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
