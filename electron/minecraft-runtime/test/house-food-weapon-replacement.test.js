'use strict';
// Real production boundary closure; crafting outcomes are MODELED, not Java proof.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),'utf8');
const begin=source.indexOf('      // A nutrition-first retry must not keep hunting'),end=source.indexOf('      const anchor = bot.entity.position.clone();',begin),code=source.slice(begin,end);
assert.ok(begin>0&&end>begin);
for(const mode of ['actual_ack','no_ack','threat','low_health','no_stock','paused'])test(`production food weapon replacement ${mode}`,async()=>{
 let weapon=false,calls=0,checks=0;const events=[],ownerTask={taskId:'task-1'};
 const context={houseSelfSupply:{prepareSurvivalTools:async options=>{calls++;assert.equal(options.localWorkshopOnly,true);assert.equal(options.deadline,1234);weapon=mode!=='no_ack';return true;}}};
 const deps={context,ownerTask,WEAPON_ITEM_PRIORITY:['wooden_sword'],deadline:1234,
 bot:{health:mode==='low_health'?13:15,food:17,entity:{position:{}},inventory:{items:()=>[{name:'spruce_log',count:mode==='no_stock'?2:5}]}},
 findInventoryItem:()=>weapon,hasGroundedBodySupport:()=>true,safeSurfaceFoot:()=>true,immediateFoodThreat:()=>mode==='threat',
 executionContextStorage:{run:async(value,fn)=>{assert.equal(value.foodWeaponReplacement,'task-1');return fn();}},
 checkTaskSignal:()=>{checks++;if(mode==='paused')throw Object.assign(Error('paused'),{code:'paused'});},recordTaskDiagnostic:(...args)=>events.push(args)};
 const run=Function(...Object.keys(deps),`return async()=>{let localToolsAttempted=false;for(let i=0;i<2;i++){${code}break;}return localToolsAttempted;};`)(...Object.values(deps));
 if(mode==='no_ack'||mode==='paused')await assert.rejects(run(),{code:mode==='paused'?'paused':'house_food_weapon_unconfirmed'});
 else {await run();assert.equal(calls,mode==='actual_ack'?1:0);}
 if(mode==='actual_ack'){assert.equal(checks,1);assert.equal(events[0][2].weaponPresent,true);}
 if(mode==='paused')assert.equal(events.length,0);
});
