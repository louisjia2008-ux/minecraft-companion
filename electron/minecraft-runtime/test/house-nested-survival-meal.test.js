'use strict';
// Exact production closures and native idle actor. Food/health packets below
// are MODELED server acknowledgements, never live Java acceptance evidence.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{AsyncLocalStorage}=require('node:async_hooks');
const filename=path.join(__dirname,'house-surface-graph.test.js'),text=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(text.slice(0,text.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',filename);
const host=fs.readFileSync(path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),'utf8'),start=host.indexOf('    const maintainCarriedSurvival=async()=>{'),end=host.indexOf('    const maintainSurvival=async()=>{',start),callback=host.slice(start,end).replace('    const maintainCarriedSurvival=','').trim().replace(/;$/,''),{hasGroundedBodySupport,naturalWalkingFoot}=require('../vendor/server/minecraft/houseSurfaceGraph'),{restoreLocalSurvivalMeal,selectBootstrapFood}=require('../vendor/server/minecraft/survivalScheduler'),{prepareHouseRecovery}=require('../vendor/server/minecraft/houseRecoveryPreparation');
for(const mode of ['ack','food_unconfirmed','unsafe','nested','pause'])test(`world158 nested survival boundary uses carried food before more wood: ${mode}`,{timeout:4000},async t=>{
 const f=native.exports.fixture(t),bot=f.bot,storage=new AsyncLocalStorage(),records=[],items=[{name:'rotten_flesh',count:1}];bot.health=7;bot.food=16;bot.inventory.items=()=>items.filter(i=>i.count>0);let meals=0,healthTimer=null;
 t.after(()=>clearInterval(healthTimer));const deps={bot,ownerTask:{},getExecutionContext:()=>storage.getStore(),foodConsumptionFlights:new WeakMap(),activeSurvivalInterrupt:null,
  hasGroundedBodySupport,safeSurfaceFoot:p=>naturalWalkingFoot(bot,p),imminentSurvivalThreat:()=>mode==='unsafe',selectBootstrapFood,executionContextStorage:storage,
  withSurfaceResourceMovements:async action=>action(),checkTaskSignal:f.deps.assertActive,restoreLocalSurvivalMeal,findInventoryItem:()=>null,WEAPON_ITEM_PRIORITY:['wooden_sword'],
  ensureHouseBootstrapFood:async(min,options)=>{assert.equal(min,18);assert.equal(options.carriedOnly,true);assert.equal(storage.getStore().carriedMealMaintenance,true);meals++;
   if(mode==='food_unconfirmed')return false;items[0].count--;bot.food=20;
   if(mode==='pause'){setTimeout(f.cancel,30);return true;}
   healthTimer=setInterval(()=>{if(bot.health<14)bot.health++;},40);return true;},
  recordTaskDiagnostic:(_t,event,facts)=>records.push({event,facts}),recordTaskHeartbeat:()=>{},safeBotLookAt:async point=>assert.ok(point.y<bot.entity.position.y),prepareHouseRecovery,settleSurvivalDefense:async()=>true};
 const run=Function(...Object.keys(deps),`return (${callback});`)(...Object.values(deps)),action=()=>storage.run({survivalMaintenance:true,carriedMealMaintenance:mode==='nested'},run);
 if(mode==='food_unconfirmed'||mode==='pause')await assert.rejects(action(),{code:mode==='pause'?'cancelled':'house_local_meal_unconfirmed'});else await action();
 if(mode==='ack'){assert.equal(meals,1);assert.equal(bot.health,14);assert.equal(bot.food,20);assert.ok(records.some(r=>r.event==='house_nested_native_health_recovered'&&r.facts.health===14));assert.ok(f.points.length);assert.ok(f.points.every(p=>p.x===.5&&p.z===.5));}
 if(mode==='unsafe'||mode==='nested'){assert.equal(meals,0);assert.equal(records.length,0);}
 if(mode==='food_unconfirmed'){assert.equal(meals,1);assert.equal(items[0].count,1);assert.equal(records.length,0);}
});
test('nested collection adapter calls local meal maintenance rather than skipping it',async()=>{
 const start=host.indexOf('      ensureFood: async () => {'),end=host.indexOf('\n      ensureWeapon:',start),callback=host.slice(start,end).replace('      ensureFood:','').trim().replace(/,$/,'');let local=0,global=0;
 const deps={getExecutionContext:()=>({survivalMaintenance:true}),maintainCarriedSurvival:async()=>local++,foodSupplyRunning:true,maintainSurvival:async()=>global++};
 await Function(...Object.keys(deps),`return (${callback});`)(...Object.values(deps))();assert.equal(local,1);assert.equal(global,0);
});
