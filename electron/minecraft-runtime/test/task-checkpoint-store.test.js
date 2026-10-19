'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createTaskCheckpointStore}=require('../vendor/server/minecraft/taskCheckpointStore');
test('durable production checkpoint preserves task ledger while excluding old runtime authority',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task-checkpoint-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'task.json'),store=createTaskCheckpointStore({file});
 const task={taskId:'task-73',status:'paused',currentStepIndex:2,plan:{steps:[{skill:'a'},{skill:'b'},{skill:'c'}]},materialSupply:{ownedStations:{crafting_table:{confirmedPlaced:true,position:{x:1,y:64,z:2}}}},siteSearch:{graph:{probes:100}},executionGeneration:8,cancellationToken:{foreign:true},movementLease:{id:9}};
 assert.equal(store.save(task,'world58/player'),true);const loaded=createTaskCheckpointStore({file}).load('world58/player');
 assert.equal(loaded.taskId,'task-73');assert.deepEqual(loaded.materialSupply,task.materialSupply);assert.equal(loaded.siteSearch.graph.probes,100);assert.equal(loaded.executionGeneration,8);
 assert.equal(loaded.cancellationToken,undefined);assert.equal(loaded.movementLease,undefined);
 assert.throws(()=>store.load('another-world/player'),{code:'task_checkpoint_identity_changed'});
 assert.equal(store.save({...task,status:'completed'},'world58/player'),false);assert.equal(store.load('world58/player').taskId,'task-73');
 store.clear();assert.equal(store.load('world58/player'),null);
});
test('corrupt or out of range saved plan cannot restore task ownership',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task-checkpoint-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'task.json'),store=createTaskCheckpointStore({file});
 fs.writeFileSync(file,JSON.stringify({schema:1,kind:'production_task_checkpoint',identity:'same',task:{taskId:'task-1',currentStepIndex:5,plan:{steps:[{}]}}}));
 assert.throws(()=>store.load('same'),{code:'task_checkpoint_identity_changed'});
 fs.writeFileSync(file,'{invalid');assert.throws(()=>store.load('same'));
});
