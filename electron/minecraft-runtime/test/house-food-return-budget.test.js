'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {foodReturnTimeoutMs:budget}=require('../vendor/server/minecraft/houseFoodReturnBudget');
const origin={x:0,y:63,z:0};
test('nearby camp work retains the original twenty second leg budget',()=>{
 assert.equal(budget(origin,origin),20000);assert.equal(budget({x:8,y:63,z:8},origin),20000);
});
test('the recorded whole51 long food route receives enough budget for its observed arrival',()=>{
 const from={x:80.5,y:66,z:-129.5},camp={x:34,y:63,z:-113};
 const ms=budget(from,camp);assert.equal(ms,35000);assert.ok(ms>23000,'original20s expiry plus actual second-leg arrival fits');
 assert.deepEqual(from,{x:80.5,y:66,z:-129.5});
});
test('normal local radius remains bounded and extreme detours never exceed sixty seconds',()=>{
 assert.equal(budget({x:64,y:63,z:0},origin),42000);
 assert.equal(budget({x:96,y:63,z:0},origin),58000);
 assert.equal(budget({x:10000,y:10000,z:10000},origin),60000);
});
test('height differences participate in the finite return allowance',()=>{
 assert.equal(budget({x:0,y:103,z:0},origin),30000);
});
test('unknown and nonfinite positions cannot become an unlimited deadline',()=>{
 for(const point of [null,{}, {x:NaN,y:63,z:0},{x:Infinity,y:63,z:0}])assert.throws(()=>budget(point,origin),TypeError);
});
