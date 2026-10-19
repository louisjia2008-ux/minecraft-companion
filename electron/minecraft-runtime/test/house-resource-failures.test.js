'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {canRetryResource,rememberResourceFailure,forgetResourceFailuresNear}=require('../vendor/server/minecraft/houseResourceFailures');
const block={position:{x:40,y:64,z:0},name:'oak_log',stateId:123},origin={x:0,y:64,z:0};
test('failed targets survive serialization, but a substantially closer real approach can retry',()=>{
 const entries=JSON.parse(JSON.stringify(rememberResourceFailure([],block,origin)));
 assert.equal(canRetryResource(entries,block,origin),false);assert.equal(canRetryResource(entries,block,{x:16,y:64,z:0}),true);
 assert.equal(canRetryResource(entries,block,{x:0,y:64,z:16}),false);
 assert.equal(canRetryResource(entries,block,{x:2,y:64,z:0}),false);
 assert.equal(canRetryResource(entries,block,{x:32,y:64,z:0}),true);
});
test('changed target state allows a new attempt, without affecting other observations',()=>{
 const entries=rememberResourceFailure([],block,origin);assert.equal(canRetryResource(entries,{...block,stateId:124},origin),true);
 assert.equal(canRetryResource(entries,block,origin),false);
});
test('actual nearby world edits release local failures while distant failures remain',()=>{
 let entries=rememberResourceFailure([],block,origin);const far={...block,position:{x:80,y:64,z:0}};entries=rememberResourceFailure(entries,far,origin);
 entries=forgetResourceFailuresNear(entries,{x:41,y:64,z:0});assert.equal(canRetryResource(entries,block,origin),true);assert.equal(canRetryResource(entries,far,origin),false);
});
test('memory is finite and deduplicates a target after a new approach',()=>{
 let entries=[];for(let x=0;x<300;x++)entries=rememberResourceFailure(entries,{...block,position:{x,y:64,z:0}},origin);
 assert.equal(entries.length,256);entries=rememberResourceFailure(entries,{...block,position:{x:299,y:64,z:0}},{x:40,y:64,z:0});assert.equal(entries.length,256);
 assert.deepEqual(entries.at(-1).origin,{x:40,y:64,z:0});
});

test('an actual close approach to a formerly distant tree is not blacklisted by a32m origin radius',()=>{
 const tree={position:{x:-171,y:64,z:-14},name:'oak_log',stateId:137};
 const entries=rememberResourceFailure([],tree,{x:-137.5,y:64,z:-20.2});
 assert.equal(canRetryResource(entries,tree,{x:-165.5,y:64,z:-25.5}),true);
 assert.equal(canRetryResource(entries,tree,{x:-138,y:64,z:-20}),false);
});

test('a changed approach strategy gets one new attempt while preserving the old failure and denying repeated same-strategy retries',()=>{
 const legacy=rememberResourceFailure([],block,origin),options={approachRevision:2};
 assert.equal(canRetryResource(legacy,block,origin),false);assert.equal(canRetryResource(legacy,block,origin,options),true);
 const current=rememberResourceFailure(legacy,block,origin,options);assert.equal(current.length,2);assert.deepEqual(current[0],legacy[0]);
 assert.equal(canRetryResource(current,block,origin,options),false);assert.equal(current[1].approachRevision,2);
 assert.equal(canRetryResource(JSON.parse(JSON.stringify(current)),block,origin,options),false);
});
