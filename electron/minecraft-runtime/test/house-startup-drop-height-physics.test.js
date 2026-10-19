'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
const {pickupStartupDrop}=require('../vendor/server/minecraft/houseStartupDropPickup');
for(const rise of [0,1,2])test(`native startup log pickup reaches actual endpoint with ${rise} metres rise instead of a loose one-block goal`,{timeout:8000},async t=>{
 const f=native.exports.fixture(t,{worldAt:p=>{const top=1+Math.min(rise,Math.max(0,p.x-1));return p.y<top?'stone':'air';}});
 const item={id:888,isValid:true,position:new Vec3(3.5,1+rise,.5),getDroppedItem:()=>({name:'spruce_log'})};f.bot.entities[item.id]=item;
 const records=[];const result=await pickupStartupDrop({...f.deps,record:r=>records.push(r),onFailure:e=>t.diagnostic(JSON.stringify({code:e.code,message:e.message})),onProbe:e=>{if(rise===2)t.diagnostic(JSON.stringify(e));}},{entity:item,expectedName:'spruce_log',deadline:Date.now()+5000});if(!result)t.diagnostic(JSON.stringify({attempts:f.attempts,actual:f.bot.entity.position,records}));assert.equal(result,true);
 assert.deepEqual(f.bot.entity.position.floored(),new Vec3(3,1+rise,0));assert.equal(f.bot.entity.onGround,true);assert.ok(f.points.length>2);
 assert.equal(records[0].inventoryCredit,false);assert.equal(f.bot.inventory.items().length,0);
});
test('a log above the original two-metre endpoint range cannot grant climbing or digging',async t=>{
 const f=native.exports.fixture(t),item={id:888,isValid:true,position:new Vec3(3.5,4,.5),getDroppedItem:()=>({name:'spruce_log'})};f.bot.entities[item.id]=item;
 assert.equal(await pickupStartupDrop(f.deps,{entity:item,expectedName:'spruce_log',deadline:Date.now()+3000}),false);assert.equal(f.attempts.length,0);
});
