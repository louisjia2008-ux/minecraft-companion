'use strict';
// Production eating closure; the native food ACK below is MODELED.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {armHouseRecovery,houseRecoveryDecision}=require('../vendor/server/minecraft/houseAutomaticRecovery');
const {selectBootstrapFood}=require('../vendor/server/minecraft/survivalScheduler');
test('critical recovery permits only observed carried meal under original material owner safety',()=>{
 const task={materialSupply:{materialSource:'self_gathered'}},r=armHouseRecovery(task,'house_creeper_escape_approaching',100);
 const f={now:1200,ownerCurrent:true,health:4.5,food:16,grounded:true,dry:true,goalActive:false,controlsActive:false,threatPresent:false,provisionInOriginalTask:true,carriedEmergencyMeal:true};
 assert.equal(houseRecoveryDecision(r,f),'provision');
 for(const extra of [{carriedEmergencyMeal:false},{carriedEmergencyMeal:undefined},{health:0},{food:7},{food:18},{threatPresent:true},{grounded:false},{dry:false},{goalActive:true},{controlsActive:true},{provisionInOriginalTask:false}])assert.equal(houseRecoveryDecision(r,{...f,...extra}),'waiting');
 assert.equal(houseRecoveryDecision(r,{...f,ownerCurrent:false}),'foreign');assert.equal(houseRecoveryDecision(r,{...f,now:120100}),'expired');
});
const s=fs.readFileSync(path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),'utf8'),start=s.indexOf('  async function ensureHouseBootstrapFood('),end=s.indexOf('\n  function getPlantingReserveCount()',start),closure=s.slice(start,end);
for(const mode of ['carried','no_food','ordinary_search','paused'])test(`production critical carried food ${mode}`,async()=>{
 let count=mode==='no_food'?0:1,calls=0;const task={executionGeneration:1,materialSupply:{}},context={selfSupplyOnly:true,houseSelfSupply:{},task},bot={_client:{},health:4.5,food:16,inventory:{items:()=>count?[{name:'rotten_flesh',count}]:[]},on:()=>{},removeListener:()=>{}};
 const d={ensureBotReady:()=>bot,surfaceSearchPositions:()=>[],getExecutionContext:()=>context,currentTask:task,currentBot:bot,foodSupplyRunning:false,
 checkTaskSignal:()=>{if(mode==='paused')throw Object.assign(Error('paused'),{code:'paused'});},assertHuntingHealth:()=>{throw Object.assign(Error('No hunting at 4.5 HP'),{code:'food_supply_low_health'});},selectBootstrapFood,
 stopBotActions:()=>{},recordTaskDiagnostic:()=>{},getItemCountByName:()=>count,physicalEquip:async()=>{},physicalConsume:async()=>{calls++;count--;bot.food=20;},sleep:async()=>{},hasGroundedBodySupport:()=>true,safeSurfaceFoot:()=>true};
 // Match the real branch's inventory selection and native equip primitive.
 bot.entity={position:new (require('vec3').Vec3)(0,1,0)};d.findInventoryItem=()=>bot.inventory.items()[0];d.equipInventoryItem=async()=>{};
 const run=Function(...Object.keys(d),`${closure};return ensureHouseBootstrapFood;`)(...Object.values(d));
 if(mode==='ordinary_search'||mode==='paused')await assert.rejects(run(18,{carriedOnly:mode!=='ordinary_search'}),{code:mode==='paused'?'paused':'food_supply_low_health'});
 else {assert.equal(await run(18,{carriedOnly:true}),mode==='carried');assert.equal(calls,mode==='carried'?1:0);assert.equal(bot.health,4.5);}
});
