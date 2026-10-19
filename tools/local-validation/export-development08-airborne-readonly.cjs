'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const base='./.minecraft-local-test',run=`${base}/worlds/cottage-development-from57`,runtime='electron/minecraft-runtime';
const req=require('node:module').createRequire(`${runtime}/package.json`),{Vec3}=req('vec3'),{readRegionChunk,decodeSectionBlock}=req('./test-support/natural-world-audit.cjs');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function tree(dir){return Object.fromEntries(fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const f=path.join(dir,e.name);return e.isDirectory()?Object.entries(tree(f)):e.isFile()?[[f,hash(f)]]:[];}));}
(async()=>{
 const before=tree(`${run}/world/region`),outcome=JSON.parse(fs.readFileSync(`${run}/development-sessions/debug08/checkpoint-end.json`));
 const trace=outcome.diagnostics.tracePath,guard=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse).find(e=>e.event==='house_surface_guard_failure');assert.ok(guard);
 const pose=guard.details.observedMovement,p=pose.position,foot=new Vec3(p.x,p.y,p.z).floored(),bounds={minX:foot.x-6,maxX:foot.x+6,minY:foot.y-8,maxY:foot.y+4,minZ:foot.z-6,maxZ:foot.z+6};
 const chunks=new Map(),palette=[],indices=[],ids=new Map();
 for(let x=bounds.minX;x<=bounds.maxX;x++)for(let y=bounds.minY;y<=bounds.maxY;y++)for(let z=bounds.minZ;z<=bounds.maxZ;z++){
  const q=new Vec3(x,y,z),ck=`${Math.floor(x/16)},${Math.floor(z/16)}`;if(!chunks.has(ck)){const {chunk}=await readRegionChunk(`${run}/world`,q);assert.ok(['full','minecraft:full'].includes(chunk.Status));chunks.set(ck,chunk);}
  const chunk=chunks.get(ck),section=chunk.sections.find(s=>s.Y===Math.floor(y/16)),state=section?decodeSectionBlock(section,q):{name:'minecraft:air',properties:{}};
  const id=JSON.stringify(state);if(!ids.has(id)){ids.set(id,palette.length);palette.push(state);}indices.push(ids.get(id));
 }
 assert.deepEqual(tree(`${run}/world/region`),before);
 const data={schema:1,kind:'saved_actual_development08_airborne',bounds,palette,indices,initial:{position:p,velocity:pose.velocity,onGround:pose.onGround,isInWater:pose.isInWater,isInLava:pose.isInLava},lastGrounded:pose.safetyFacts.shore.lastGrounded,physicsTick:pose.safetyFacts.physicsTick,controls:pose.controls,yaw:pose.yaw,pitch:pose.pitch,jumpTicks:pose.jumpTicks,jumpQueued:pose.jumpQueued,actualOldReason:guard.details.code,seed:JSON.parse(fs.readFileSync(`${run}/development-origin.json`)).seed,provenance:{traceSha256:hash(trace),resultSha256:hash(`${run}/development-sessions/debug08/checkpoint-end.json`),regionBytesUnchanged:true},limitations:'Exact recorded actor/control/guard facts and stopped saved geometry. Historical packet-loaded set and unrelated entities are unknown. Offline prediction is not live house acceptance.'};
 const file=`${base}/evidence/estate-20261013/development08-saved-airborne.json`;fs.writeFileSync(file,JSON.stringify(data)+'\n',{flag:'wx'});console.log(JSON.stringify({file,sha256:hash(file),regionBytesUnchanged:true,oldReason:data.actualOldReason}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
