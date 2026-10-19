'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {observeNativeNutritionProgress}=require('../vendor/server/minecraft/houseNutritionSignals');
test('only actual captured-client health or food increases are nutrition progress',()=>{
 const client=new EventEmitter(),signals=[];const close=observeNativeNutritionProgress(client,{initialHealth:14,initialFood:20,isOwnerCurrent:()=>true,onProgress:e=>signals.push(e)});
 client.emit('update_health',{health:14,food:20});client.emit('update_health',{health:13,food:20});assert.equal(signals.length,0);
 client.emit('update_health',{health:15,food:19});client.emit('update_health',{health:15,food:20});assert.equal(signals.length,2);
 assert.ok(signals.every(e=>e.source==='native_update_health'));close();assert.equal(client.listenerCount('update_health'),0);
 client.emit('update_health',{health:20,food:20});assert.equal(signals.length,2);
});
test('revoked ownership, unrelated events and invalid packets cannot extend nutrition waiting',()=>{
 const client=new EventEmitter(),signals=[];let owned=true;const close=observeNativeNutritionProgress(client,{initialHealth:14,initialFood:17,isOwnerCurrent:()=>owned,onProgress:e=>signals.push(e)});
 client.emit('log',{health:20,food:20});client.emit('update_health',{health:NaN,food:20});client.emit('update_health',{health:20,food:21});
 owned=false;client.emit('update_health',{health:20,food:20});assert.equal(signals.length,0);close();
});
