'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../natural-public-building-acceptance-v12-complete-server-lines.cjs'),'utf8');
const body=src.slice(src.indexOf('async function originalTaskCombatEvidence('),src.indexOf('async function main()'));
for(const mode of ['already_defending','hurt_starts_defense','no_native_hurt','animal_hunt','foreign_actor'])test(`combat audit uses actual native self-hurt and original-task hostile attack: ${mode}`,async t=>{
 const runDir=fs.mkdtempSync(path.join(os.tmpdir(),'deskpet-real-hurt-audit-'));t.after(()=>fs.rmSync(runDir,{recursive:true,force:true}));
 const native=mode==='no_native_hurt'?[]:[{type:'entity_hurt',self:true,id:6,name:'player',at:new Date(mode==='hurt_starts_defense'?900:1200).toISOString()}];
 const diag=[{at:1000,event:'house_combat_mode_started',taskId:'original',details:{resumeTaskId:'original',trigger:mode==='hurt_starts_defense'?'entity_hurt':'house_creeper_proximity'}},{at:1300,event:'house_defense_attack_sent',taskId:mode==='foreign_actor'?'different':'original',details:{targetId:7,targetName:mode==='animal_hunt'?'sheep':'zombie'}},{at:1400,event:'house_combat_cleanup_verification',taskId:'original',details:{removed:4,pendingWork:0,interrupted:false,deadlineReached:false}},{at:1500,event:'house_combat_task_resumed',taskId:'original',details:{cleanupPending:0,resumeTaskId:'original'}}];
 const file=path.join(runDir,'diag.jsonl');fs.writeFileSync(file,diag.map(JSON.stringify).join('\n')+'\n');fs.writeFileSync(path.join(runDir,'events.jsonl'),native.map(JSON.stringify).join('\n')+(native.length?'\n':''));
 const check=Function('fs','path','require','runDir',body+';return originalTaskCombatEvidence;')(fs,path,require,runDir),r=await check({taskId:'original',status:'completed',diagnostics:{tracePath:file}});
 const valid=['already_defending','hurt_starts_defense'].includes(mode);assert.equal(r.hurtAttack,valid);assert.equal(r.clearedAndResumed,true);if(valid){assert.equal(r.hurt.type,'entity_hurt');assert.equal(r.attackDelayMs,mode==='already_defending'?100:400);assert.equal(r.defenseAlreadyActive,mode==='already_defending');}
});
