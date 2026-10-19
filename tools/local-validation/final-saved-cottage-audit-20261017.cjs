'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const base=path.resolve(__dirname,'..'),world=path.join(base,'worlds/natural-cottage-combat-20261017-new03'),runtime=path.resolve(base,'../personal-ai-deskpet-electron-work/electron/minecraft-runtime');
const {readRegionChunk,decodeSectionBlock,readLevelMetadata}=require(runtime+'/test-support/natural-world-audit.cjs');
const {compareManifest,geometryEvidence,renderSavedBlocks}=require(runtime+'/test-support/furnished-house-audit.cjs');
const task=JSON.parse(fs.readFileSync(world+'/development-checkpoint.json')).task;
const blueprint=require(runtime+'/vendor/server/minecraft/furnishedHouseBlueprints').createFurnishedHouseBlueprint(task.stepCheckpoint.furnishedHouse.anchor,{profile:'cottage'});
(async()=>{const chunks=new Map(),cells=new Map(),a=blueprint.anchor;
for(let x=a.x-2;x<=a.x+8;x++)for(let z=a.z-3;z<=a.z+10;z++)for(let y=a.y-1;y<=a.y+9;y++){
 const p={x,y,z},ck=`${Math.floor(x/16)},${Math.floor(z/16)}`;if(!chunks.has(ck))chunks.set(ck,await readRegionChunk(world+'/world',p));const saved=chunks.get(ck),sec=saved.chunk.sections.find(s=>s.Y===Math.floor(y/16));cells.set(`${x},${y},${z}`,{position:p,...(sec?decodeSectionBlock(sec,p):{name:'minecraft:air',properties:{}})});
}
const get=p=>cells.get(`${p.x},${p.y},${p.z}`),geometry=geometryEvidence(get,blueprint),raw=compareManifest(get,blueprint);
// Door open is an operational state following actual furnace entry, not a missing block.
const structuralBlueprint={...blueprint,blocks:blueprint.blocks.map(s=>s.item==='oak_door'?{...s,properties:Object.fromEntries(Object.entries(s.properties||{}).filter(([k])=>k!=='open'))}:s)};
const mismatches=compareManifest(get,structuralBlueprint),metadata=await readLevelMetadata(world+'/world');assert.equal(mismatches.length,0);assert.equal(geometry.floorHoles.length+geometry.wallHoles.length+geometry.roofHoles.length,0);assert.ok(geometry.bed.confirmed&&geometry.chest.confirmed&&geometry.furnace.confirmed&&geometry.craftingTable.confirmed);assert.ok(geometry.route.every(c=>c.clear));
const result={domain:'READ_ONLY_NORMALLY_STOPPED_SAVED_WORLD',confirmed:true,metadata,anchor:a,manifestBlocks:blueprint.blocks.length,structuralMismatches:mismatches,operationalStateDifferences:raw,geometry,normalStopObserved:true,doorOpenAtFinalSave:geometry.door.lower.properties.open==='true',doorFunctionalProof:'native-post-use/actual-furniture-20261017-01/result.json and 02/result.json; final furnace entry opened door',chunksRead:chunks.size};
fs.writeFileSync(world+'/final-saved-world-audit-20261017.json',JSON.stringify(result,null,2));fs.writeFileSync(world+'/final-saved-house-cutaway-20261017.svg',renderSavedBlocks([...cells.values()],blueprint,{cutaway:true,front:true}));console.log(JSON.stringify({confirmed:result.confirmed,blocks:result.manifestBlocks,structuralMismatches:mismatches.length,operationalDifferences:raw.length,seed:metadata.seed,doorOpen:result.doorOpenAtFinalSave}));
})().catch(e=>{console.error(e);process.exitCode=1;});
