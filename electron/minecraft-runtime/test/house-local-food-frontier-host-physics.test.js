'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const filename=path.join(__dirname,'mining-combat-coordination.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);
native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf("\ntest('a grounded self-supply camp"))+'\nmodule.exports={fixture};\n',filename);
function setup(t){const f=native.exports.fixture(t,{interrupt:false});f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';
 f.task.materialSupply={schema:1,materialSource:'self_gathered',profile:'cottage',houseAnchor:{x:100,y:1,z:100},camp:{anchor:{x:100,y:1,z:100},stations:{},storageSites:[]},ownedStations:{}};
 f.bot._client.write=()=>{};f.bot.inventory.items=()=>[];f.bot.inventory.count=()=>0;f.bot.heldItem=null;return f;}
test('formal local nutrition frontier starts at actual actor and makes native progress without returning to distant camp',{timeout:8000},async t=>{
 const f=setup(t),before=f.bot.entity.position.clone();
 const moved=await f.agent.__testWithHouseResourceWork(()=>f.agent.__testLocalFoodFrontier(Date.now()+5000));
 assert.equal(moved,true);assert.ok(f.bot.entity.position.distanceTo(before)>1);assert.ok(f.bot.entity.position.distanceTo(before)<32);
 const search=f.task.materialSupply.fieldFoodSearch;assert.deepEqual(search.anchor,{x:0,y:1,z:0});assert.equal(search.graph.visits,2);
 assert.deepEqual(f.task.materialSupply.camp.anchor,{x:100,y:1,z:100});assert.equal(f.bot.inventory.items().length,0);assert.equal(f.bot.food,20);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});
for(const mode of ['pause','deadline'])test(`local nutrition frontier cannot create an origin after ${mode}`,async t=>{
 const f=setup(t);if(mode==='pause')f.task.cancellationToken.pause();
 await assert.rejects(f.agent.__testWithHouseResourceWork(()=>f.agent.__testLocalFoodFrontier(Date.now()+(mode==='deadline'?-1:1000))));
 assert.equal(f.task.materialSupply.fieldFoodSearch,undefined);assert.equal(f.attempts.length,0);
});
