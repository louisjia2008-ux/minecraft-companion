'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const base='./.minecraft-local-test',run=`${base}/worlds/natural-public-cottage-self-29`,runtime='electron/minecraft-runtime';
const req=require('node:module').createRequire(`${runtime}/package.json`),{Vec3}=req('vec3'),{readRegionChunk,decodeSectionBlock}=req('./test-support/natural-world-audit.cjs');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');function tree(dir){return Object.fromEntries(fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const f=path.join(dir,e.name);return e.isDirectory()?Object.entries(tree(f)):e.isFile()?[[f,hash(f)]]:[];}));}
(async()=>{
 const before=tree(run),outcome=JSON.parse(fs.readFileSync(`${run}/task-outcome-before-cleanup.json`));
 const trace=outcome.diagnostics.tracePath,guard=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse).find(e=>e.event==='house_surface_guard_failure'),pose=guard.details.observedMovement,g=outcome.siteSearch.graph,child=g.nodes[g.current];
 const bounds={minX:-61,maxX:-26,minY:60,maxY:86,minZ:14,maxZ:46},chunks=new Map(),palette=[],indices=[],ids=new Map();
 for(let x=bounds.minX;x<=bounds.maxX;x++)for(let z=bounds.minZ;z<=bounds.maxZ;z++)for(let y=bounds.minY;y<=bounds.maxY;y++){
  const q=new Vec3(x,y,z),ck=`${Math.floor(x/16)},${Math.floor(z/16)}`;if(!chunks.has(ck)){const {chunk}=await readRegionChunk(`${run}/world`,q);assert.ok(['full','minecraft:full'].includes(chunk.Status));chunks.set(ck,chunk);}
  const chunk=chunks.get(ck),section=chunk.sections.find(s=>s.Y===Math.floor(y/16)),state=section?decodeSectionBlock(section,q):{name:'minecraft:air',properties:{}};
  const id=JSON.stringify(state);if(!ids.has(id)){ids.set(id,palette.length);palette.push(state);}indices.push(ids.get(id));
 }
 assert.deepEqual(tree(run),before);const data={schema:1,kind:'saved_actual_whole29_native_return_timeout',bounds,palette,indices,pose,parent:g.nodes[child.parent].position,child:child.position,trail:child.dryParentTrail,provenance:{traceSha256:hash(trace),resultSha256:hash(`${run}/result.json`),originalBytesUnchanged:true},limitations:'Saved post-stop geometry and actual recorded guard/parent-edge observations. Historical loaded set, nearby entities and network timing are not reconstructed. Offline movement is component evidence only.'};
 const file=`${runtime}/test-support/whole29-native-return-voxels.json`;fs.writeFileSync(file,JSON.stringify(data)+'\n',{flag:'wx'});console.log(JSON.stringify({file,sha256:hash(file),originalBytesUnchanged:true,trailPoints:data.trail.points.length}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
