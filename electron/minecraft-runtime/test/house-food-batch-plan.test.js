'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {immediateMealCost:cost}=require('../vendor/server/minecraft/houseFoodBatchPlan');
const points=n=>({cooked_chicken:6,cooked_beef:8,bread:5,carrot:3})[n]||0;
test('the meal eaten on arrival and spare reserve cannot count the same chicken',()=>{
 const items=[{name:'cooked_chicken',count:1}],facts={health:20,food:17,items,points};
 assert.equal(cost(facts),6);assert.ok(6-cost(facts)<4);
 assert.equal(cost({...facts,items:[{name:'cooked_chicken',count:2}]}),6);
 assert.ok(12-cost({...facts,items:[{name:'cooked_chicken',count:2}]})>=4);
 assert.equal(cost({...facts,food:20}),0);assert.equal(cost({...facts,food:19}),0);
 assert.equal(cost({...facts,health:19,food:19}),6);
});
test('whole mixed meal units follow the existing food priority and malformed survival cannot grant a batch',()=>{
 assert.equal(cost({health:10,food:7,items:[{name:'cooked_beef',count:1},{name:'bread',count:2}],points}),13);
 assert.equal(cost({health:20,food:17,items:[],points}),3);
 assert.equal(cost({health:0,food:17,items:[],points}),Infinity);
});
