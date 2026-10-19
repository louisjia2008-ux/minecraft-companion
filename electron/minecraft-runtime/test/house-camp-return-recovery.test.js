'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {returnCampWithLocalRecovery,isCampReturnRouteFailure}=require('../vendor/server/minecraft/houseCampReturnRecovery');
test('a stalled initial native return leaves the same finite deadline available for an actual local alternative',async()=>{
 let clock=1000,origin='initial',calls=0;const deadlines=[],budgets=[];
 const result=await returnCampWithLocalRecovery({assertActive(){},now:()=>clock,positionKey:()=>origin,native:async budget=>{budgets.push(budget);if(calls++===0){clock+=budget;throw Error('自给采集返回固定营地超时');}return 'actual-arrival';},recover:async deadline=>{deadlines.push(deadline);clock+=5000;origin='actual-next';return true;}},{deadline:61000});
 assert.equal(result,'actual-arrival');assert.deepEqual(deadlines,[61000]);assert.deepEqual(budgets,[8000,8000]);assert.equal(clock,14000);
});
for(const control of ['paused','cancelled','movement_preempted','connection_lost'])test(`camp return cannot repair or restart a ${control} owner`,async()=>{
 let repairs=0;await assert.rejects(returnCampWithLocalRecovery({assertActive(){},positionKey:()=>'',native:async()=>{throw Object.assign(Error(control),{code:control});},recover:async()=>{repairs++;return true;}},{deadline:Date.now()+1000}),{code:control});assert.equal(repairs,0);
});
test('a cancelled local alternative cannot start the next native action',async()=>{
 let cancelled=false,calls=0;await assert.rejects(returnCampWithLocalRecovery({assertActive(){if(cancelled)throw Object.assign(Error('paused'),{code:'paused'});},positionKey:()=>'',native:async()=>{calls++;throw Object.assign(Error('no path'),{code:'NoPath'});},recover:async()=>{cancelled=true;return true;}},{deadline:Date.now()+1000}),{code:'paused'});assert.equal(calls,1);
});
test('real excavation support failure is not reclassified as an ordinary native route miss',async()=>{
 assert.equal(isCampReturnRouteFailure({code:'MINING_NO_SUPPORT'}),false);let calls=0;
 await assert.rejects(returnCampWithLocalRecovery({assertActive(){},positionKey:()=>'',native:async()=>{calls++;throw Object.assign(Error('no path'),{code:'NoPath'});},recover:async()=>{throw Object.assign(Error('protected route floor'),{code:'MINING_NO_SUPPORT'});}},{deadline:Date.now()+1000}),{code:'MINING_NO_SUPPORT'});assert.equal(calls,1);
});
test('unmoving retries and an expired original budget cannot create an unbounded return',async()=>{
 let calls=0;await assert.rejects(returnCampWithLocalRecovery({assertActive(){},positionKey:()=>'same',native:async()=>{calls++;throw Object.assign(Error('no path'),{code:'NoPath'});},recover:async()=>true},{deadline:Date.now()+1000}),{code:'NoPath'});assert.equal(calls,2);
 let clock=10;await assert.rejects(returnCampWithLocalRecovery({assertActive(){},now:()=>clock,positionKey:()=>'',native:async budget=>{clock+=budget;throw Error('自给采集返回固定营地超时');},recover:async()=>{throw Error('expired callback must not run');}},{deadline:30}),/返回固定营地超时/);
});
