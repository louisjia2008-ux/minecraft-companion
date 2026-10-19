'use strict';
// Read-only compact evidence. These are cached client/checkpoint observations;
// independently query the owned native server before claiming live acceptance.
const fs=require('node:fs'),path=require('node:path');
const base=path.resolve(__dirname,'..'),world=path.join(base,'worlds/cottage-development-from57');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
function tail(p,limit){const fd=fs.openSync(p,'r');try{const size=fs.fstatSync(fd).size,start=Math.max(0,size-limit),buf=Buffer.alloc(size-start);fs.readSync(fd,buf,0,buf.length,start);return buf.toString('utf8').split('\n').slice(start?1:0).flatMap(s=>{try{return [JSON.parse(s)];}catch{return [];}});}finally{fs.closeSync(fd);}}
const control=read(path.join(world,'development-control.json')),task=read(path.join(world,'development-checkpoint.json')).task;
const snapshots=tail(path.join(base,'evidence/estate-20261013',`cottage-development-${control.session}-console.log`),24000).filter(s=>s.position&&Array.isArray(s.inventory));
const latest=snapshots.at(-1),items={};for(const i of latest?.inventory||[])items[i.name]=(items[i.name]||0)+i.count;
const house=task.stepCheckpoint?.furnishedHouse||{},goals=house.requirements||{};
const events=tail(path.join(world,'development-sessions',control.session,'task-diagnostics.jsonl'),90000);
const skip=/_tick|probe_unsettled|loaded_surface_query|observed_resource_query|water_discovery|swim_discovery|development_legacy|step_started/;
const meaningful=events.filter(e=>!skip.test(e.event||''));
const recent=snapshots.slice(-8);let movement=0;for(let i=1;i<recent.length;i++)movement+=Math.hypot(...['x','y','z'].map(k=>recent[i].position[k]-recent[i-1].position[k]));
console.log(JSON.stringify({source:'cached_client_and_checkpoint_NOT_independent_native_acceptance',control,
 task:{status:task.status,step:task.currentStepIndex,phase:house.phase,error:task.error,camp:task.materialSupply?.camp?.anchor,house:house.anchor,
 ownedBlockRecords:house.ownedBlockIds?.length,ownedScaffoldRecords:house.ownedScaffold?.length,observedDamageRecords:house.observedStructureDamageIds?.length,
 lastVerification:house.verificationSummary||null},
 client:{position:latest?.position,health:latest?.health,food:latest?.food,movementInRecentSnapshotWindow:Math.round(movement*100)/100,
 inventory:items,goalsMissingFromClientInventory:Object.fromEntries(Object.entries(goals).filter(([k,n])=>(items[k]||0)<n).map(([k,n])=>[k,n-(items[k]||0)]))},
 recentEvents:meaningful.slice(-6).map(e=>({at:e.at,event:e.event,details:e.details})),requiresNativeServerRecheck:true},null,2));
