'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {equipmentFromEntitySNBT}=require('../vanilla-player-equipment-v1.cjs');
function observer(filename){const source=fs.readFileSync(path.join(__dirname,'..',filename),'utf8'),body=source.slice(source.indexOf('function checkWaiters()'),source.indexOf('function waitForServer('));return Function('clearTimeout',`let serverOutput='',waiters=new Set();${body};return {append(chunk){serverOutput+=chunk;checkWaiters();},watch(pattern,resolve){waiters.add({pattern,from:serverOutput.length,resolve,timer:null});}};`)(()=>{});}
const line='DeskPetSelfBuild has the following entity data: {recipeBook: {recipes: ['+Array(1000).fill('"minecraft:oak_planks"').join(',')+']}, equipment: {offhand: {count: 1, id: "minecraft:shield"}}, Inventory: []}';
test('large actual entity response cannot resolve on stdout fragments or an unterminated compound',()=>{
 const o=observer('natural-public-building-acceptance-v12-complete-server-lines.cjs');let answer;
 o.watch(/DeskPetSelfBuild has the following entity data: [^\r\n]+/,value=>{answer=value;});
 for(let i=0;i<line.length;i+=4096){o.append(line.slice(i,i+4096));assert.equal(answer,undefined);}
 o.append('\n');assert.equal(answer,line);assert.deepEqual(equipmentFromEntitySNBT(answer),[{name:'shield',count:1,slot:45}]);
});
test('regression demonstrates the previous observer resolves on an incomplete server entity response',()=>{
 const o=observer('natural-public-building-acceptance-v11-equipment-observer.cjs');let answer;
 o.watch(/DeskPetSelfBuild has the following entity data: [^\r\n]+/,value=>{answer=value;});o.append(line.slice(0,4096));assert.ok(answer);assert.throws(()=>equipmentFromEntitySNBT(answer),/Expected actual SNBT compound/);
});
