'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const text=fs.readFileSync(path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),'utf8'),start=text.indexOf('  async function buildHouseEmergencyCover('),end=text.indexOf('  function houseCombatCleanupDependencies(',start),body=text.slice(start,end);
for(const code of ['survival_threat_escalated','paused'])test(`a native-confirmed cover receipt survives ${code} before the next old-owner write`,async()=>{
 const target={id:'native-cover',item:'dirt',position:{x:1,y:1,z:0}},cells=new Map();let revoked=false,writes=0;
 const bot={health:16,entity:{position:{x:0,y:1,z:0}},blockAt:p=>({name:cells.get(`${p.x},${p.y},${p.z}`)||'air'})},task={materialSupply:{},stepCheckpoint:{furnishedHouse:{phase:'prepare_materials'}}};
 const deps={ensureBotReady:()=>bot,toPlainPosition:p=>({...p}),toVec3:p=>p,recordTaskDiagnostic:()=>{},planEmergencyShelter:()=>({blocks:[target,{...target,id:'later',position:{x:2,y:1,z:0}}]}),
 getItemCountByName:()=>15,executionContextStorage:{run:(_c,fn)=>fn()},getExecutionContext:()=>({}),houseResourcePositionExcluded:()=>false,requiredEmergencyCoverCell:()=>true,matchesFurnishedHouseBlock:(b,s)=>b.name===s.item,
 placeFurnishedHouseBlock:async(spec,onConfirmed)=>{writes++;cells.set(`${spec.position.x},${spec.position.y},${spec.position.z}`,spec.item);revoked=true;onConfirmed();},planEmergencyRoof:()=>null,require:require('node:module').createRequire(path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'))};
 const run=Function(...Object.keys(deps),body+';return buildHouseEmergencyCover;')(...Object.values(deps));
 await assert.rejects(run(task,[{name:'zombie',position:{x:2,y:1,z:0}}],{deadline:Date.now()+5000,assertActive:()=>{if(revoked)throw Object.assign(Error(code),{code});}}),{code});
 assert.equal(writes,1);assert.equal(task.materialSupply.defensiveCover.placed.length,1);assert.equal(require('../vendor/server/minecraft/houseCombatMode').combatCover(task.materialSupply).length,1);assert.equal(bot.blockAt(target.position).name,'dirt');
});
