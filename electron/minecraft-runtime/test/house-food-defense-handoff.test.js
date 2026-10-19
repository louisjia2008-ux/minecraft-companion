'use strict';
// Exact production meal branch. Food packets/inventory ACKs and survival-frame
// completion below are modeled contracts, not real Java nutrition acceptance.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const host=fs.readFileSync(path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),'utf8'),fn=host.indexOf('  async function ensureHouseBootstrapFood('),start=host.indexOf('      if (food) {',fn),end=host.indexOf('      const anchor = bot.entity.position.clone();',start),branch=host.slice(start,end);
for(const mode of ['ack_then_interrupt','interrupt_before_ack','foreign','pause','limit'])test(`world153 production food handoff reobserves actual nutrition: ${mode}`,async()=>{
 const bot={food:17},food={name:'bread',count:2},records=[];let calls=0,resumes=0,consumed=0;
 const interrupt=()=>Object.assign(Error('preempted'),{code:'movement_preempted',survivalInterrupt:{identity:'modeled exact original owner'}});
 const deps={bot,minFood:20,food,deadline:Date.now()+60000,currentTask:{},getItemCountByName:()=>food.count,
  stopBotActions:()=>{},equipInventoryItem:async()=>{},checkTaskSignal:()=>{},physicalConsume:async()=>{calls++;if(mode==='interrupt_before_ack'&&calls===1||mode==='limit')throw interrupt();food.count--;consumed++;bot.food=20;throw interrupt();},
  resumeHouseResourceAfterSurvival:async(error,options)=>{resumes++;assert.ok(options.deadline<=Date.now()+35000);assert.equal(options.bot,bot);if(mode==='pause')throw Object.assign(Error('paused'),{code:'paused'});return mode!=='foreign';},
  recordTaskDiagnostic:(_t,event,facts)=>records.push({event,facts}),sleep:async()=>{}};
 const run=Function(...Object.keys(deps),`return async()=>{let mealDefenseHandoffs=0;while(bot.food<minFood){${branch}}};`)(...Object.values(deps));
 if(mode==='foreign'||mode==='pause'||mode==='limit')await assert.rejects(run(),{code:mode==='pause'?'paused':'movement_preempted'});else await run();
 if(mode==='ack_then_interrupt'){assert.equal(calls,1);assert.equal(consumed,1);assert.equal(food.count,1);assert.equal(records[0].facts.actualFood,20);}
 if(mode==='interrupt_before_ack'){assert.equal(calls,2);assert.equal(consumed,1);assert.equal(food.count,1);assert.equal(resumes,2);}
 if(mode==='limit'){assert.equal(resumes,8);assert.equal(calls,9);assert.equal(consumed,0);assert.equal(food.count,2);}
 if(mode==='foreign'||mode==='pause'){assert.equal(calls,1);assert.equal(records.length,0);}
});
