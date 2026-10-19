'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {craftWithSurvivalRecovery}=require('../vendor/server/minecraft/houseInterruptedCraft');
const interrupted=()=>Object.assign(Error('modeled survival preemption'),{code:'movement_preempted'});
test('native output observed during defense prevents a duplicate recipe after the same owner resumes',async()=>{
 let stock=0,crafts=0,resumes=0;
 await craftWithSurvivalRecovery({assertActive(){},count:()=>stock,craft:async()=>{crafts++;throw interrupted();},resume:async()=>{resumes++;stock=1;return true;}},{target:1,deadline:Date.now()+1000});
 assert.equal(crafts,1);assert.equal(resumes,1);assert.equal(stock,1);
});
test('an interrupted craft with no output retries only after captured defense has drained',async()=>{
 let stock=0,crafts=0,resumed=false;
 await craftWithSurvivalRecovery({assertActive(){},count:()=>stock,craft:async()=>{crafts++;if(crafts===1)throw interrupted();assert.equal(resumed,true);stock=1;},resume:async()=>{resumed=true;return true;}},{target:1,deadline:Date.now()+1000});
 assert.equal(crafts,2);assert.equal(stock,1);
});
for(const code of ['paused','cancelled','house_resource_connection_changed'])test(`interrupted recipe never retries ${code}`,async()=>{
 let crafts=0,resumes=0;await assert.rejects(craftWithSurvivalRecovery({assertActive(){},count:()=>0,craft:async()=>{crafts++;throw Object.assign(Error(code),{code});},resume:async()=>{resumes++;return true;}},{target:1,deadline:Date.now()+1000}),{code});assert.equal(crafts,1);assert.equal(resumes,0);
});
test('a foreign defense cannot authorize a retry and repeated interruptions remain finite',async()=>{
 let crafts=0;await assert.rejects(craftWithSurvivalRecovery({assertActive(){},count:()=>0,craft:async()=>{crafts++;throw interrupted();},resume:async()=>false},{target:1,deadline:Date.now()+1000}),{code:'movement_preempted'});assert.equal(crafts,1);
 crafts=0;await assert.rejects(craftWithSurvivalRecovery({assertActive(){},count:()=>0,craft:async()=>{crafts++;throw interrupted();},resume:async()=>true},{target:1,deadline:Date.now()+1000}),{code:'movement_preempted'});assert.equal(crafts,5);
});
