'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
// Capture the host scheduler before enabling the task/Physics clock. Native
// AStar's performance.now and this 8s watchdog keep their real host clocks.
const {setTimeout:hostTimeout,clearTimeout:clearHostTimeout,setImmediate:hostImmediate}=require('node:timers');
const hostTurn=()=>new Promise(resolve=>hostImmediate(resolve));
const filename=path.join(__dirname,'mining-combat-coordination.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);
native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf("\ntest('a grounded self-supply camp"))+'\nmodule.exports={fixture};\n',filename);
function setup(t){const f=native.exports.fixture(t,{interrupt:false});f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';
 f.task.materialSupply={schema:1,materialSource:'self_gathered',profile:'cottage',houseAnchor:{x:100,y:1,z:100},camp:{anchor:{x:100,y:1,z:100},stations:{},storageSites:[]},ownedStations:{}};
 f.bot._client.write=()=>{};f.bot.inventory.items=()=>[];f.bot.inventory.count=()=>0;f.bot.heldItem=null;return f;}
async function advanceNativeClock(t,f,pending,budgetMs){
 const started=Date.now();let settled=false,outcome,hostExpired=false;
 const observed=Promise.resolve(pending).then(value=>{outcome={value};settled=true;},error=>{outcome={error};settled=true;});
 const stop=()=>{f.task.cancellationToken.cancel();f.bot.pathfinder.setGoal(null);f.bot.clearControlStates();};
 const watchdog=hostTimeout(()=>{hostExpired=true;stop();},8000);
 try{
  // The unchanged fixture advances one original 50ms Physics step per20ms
  // scheduler interval. At5000ms there can be at most250 physics steps.
  for(let frame=0;frame<budgetMs/20&&!settled&&!hostExpired;frame++){
   t.mock.timers.tick(20);await hostTurn();
  }
  // Let zero-delay native goto acknowledgements and their promise continuations
  // settle without granting another interval, physical step or task budget.
  for(let turn=0;turn<20&&!settled&&!hostExpired;turn++){t.mock.timers.tick(0);await hostTurn();}
  assert.equal(hostExpired,false,'Native fixture must retain its real8s host watchdog');
  assert.equal(settled,true,'Native result must settle within the original logical task budget');
  await observed;return {...outcome,elapsedMs:Date.now()-started};
 }finally{
  clearHostTimeout(watchdog);
  if(!settled){
   stop();
   for(let turn=0;turn<20&&!settled;turn++){t.mock.timers.tick(0);await hostTurn();}
   assert.equal(settled,true,'Failure cleanup must join the cancelled native goal without extending its budget');
  }
 }
}
test('formal local nutrition frontier starts at actual actor and makes native progress without returning to distant camp',{timeout:8000},async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:Date.now()});
 const f=setup(t),before=f.bot.entity.position.clone();
 const result=await advanceNativeClock(t,f,f.agent.__testWithHouseResourceWork(()=>f.agent.__testLocalFoodFrontier(Date.now()+5000)),5000);
 if(result.error)throw result.error;
 assert.equal(result.value,true);assert.ok(f.bot.entity.position.distanceTo(before)>1);assert.ok(f.bot.entity.position.distanceTo(before)<32);
 const search=f.task.materialSupply.fieldFoodSearch;assert.deepEqual(search.anchor,{x:0,y:1,z:0});assert.equal(search.graph.visits,2);
 assert.deepEqual(f.task.materialSupply.camp.anchor,{x:100,y:1,z:100});assert.equal(f.bot.inventory.items().length,0);assert.equal(f.bot.food,20);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 assert.ok(result.elapsedMs<=5000);assert.ok(f.ticks()<=250);
 t.diagnostic(`native physics ticks=${f.ticks()}, logical task elapsed=${result.elapsedMs}ms, budget=5000ms`);
});
for(const mode of ['pause','deadline'])test(`local nutrition frontier cannot create an origin after ${mode}`,async t=>{
 const f=setup(t);if(mode==='pause')f.task.cancellationToken.pause();
 await assert.rejects(f.agent.__testWithHouseResourceWork(()=>f.agent.__testLocalFoodFrontier(Date.now()+(mode==='deadline'?-1:1000))),{code:mode==='pause'?'paused':'house_food_search_timeout'});
 assert.equal(f.task.materialSupply.fieldFoodSearch,undefined);assert.equal(f.attempts.length,0);
});
test('an in-flight local nutrition frontier expires at its original logical deadline without granting another leg',{timeout:8000},async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:Date.now()});
 const f=setup(t),before=f.bot.entity.position.clone(),deadline=Date.now()+1000;
 const result=await advanceNativeClock(t,f,f.agent.__testWithHouseResourceWork(()=>f.agent.__testLocalFoodFrontier(deadline)),1000);
 assert.equal(result.error?.code,'house_food_search_timeout');assert.equal(result.elapsedMs,1000);assert.equal(Date.now(),deadline);
 assert.equal(f.attempts.length,1);assert.ok(f.bot.entity.position.distanceTo(before)>1);
 const search=f.task.materialSupply.fieldFoodSearch;assert.deepEqual(search.anchor,{x:0,y:1,z:0});assert.equal(search.graph.visits,1);
 assert.deepEqual(search.graph.order,['0,1,0']);assert.equal(f.bot.pathfinder.goal,null);
 const attempts=f.attempts.length,visits=search.graph.visits;
 t.mock.timers.tick(1000);await hostTurn();
 assert.equal(f.attempts.length,attempts);assert.equal(search.graph.visits,visits);assert.equal(f.bot.pathfinder.goal,null);
 assert.equal(Object.values(f.bot.controlState).some(Boolean),false);
 t.diagnostic(`deadline rejected after${f.ticks()-50} original-budget physics ticks; no new native leg or visit after expiry`);
});
