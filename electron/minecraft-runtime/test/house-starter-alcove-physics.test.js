'use strict';
// Original installed pathfinder and Physics own all actor motion. Dig/drop/
// placement and time packets below are explicitly MODELED server ACKs. This
// verifies controller contracts, never real Java shelter/daylight acceptance.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3'),{Movements}=require('mineflayer-pathfinder');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',filename);
const {prepareStarterAlcove,starterAlcoveConfirmed}=require('../vendor/server/minecraft/houseStarterAlcove');
for(const mode of ['complete','pause','unknown_roof','protected','no_drop_ack','no_place_ack','unknown_clock','pit_complete','pit_pause','pit_no_drop_ack','pit_unknown_floor','pit_protected','pit_saved','pit_saved_uphill','pit_saved_sand_edge','pit_owned_dig_interrupt','pit_foreign_dig_interrupt','pit_pause_dig_interrupt','pit_second_approach','pit_no_approach','pit_partial_approach','pit_owned_approach_interrupt','pit_foreign_approach_interrupt','pit_pause_approach_interrupt','pit_nearby_threat','pit_arriving_threat'])test(`bounded native starter alcove controller with modeled server ${mode}`,{timeout:8000},async t=>{
 const cells=new Map(),writes=[],ledger=new Set(['legacy-remote-cover']),saved=mode.startsWith('pit_saved')?require('../test-support/fixtures/formal58-run145-contact-pack.json'):null;
 const f=native.exports.fixture(t,{initialPosition:saved?(mode==='pit_saved_uphill'?new Vec3(-160.5,70,46.5):mode==='pit_saved_sand_edge'?new Vec3(-152.5,69,45.5):new Vec3(-166.5,71,53.5)):undefined,initialVelocity:new Vec3(0,-.0784000015258789,0),worldAt:p=>{
  if(saved){const v=cells.get(`${p.x},${p.y},${p.z}`);if(v)return v;const i=saved.states[`${p.x},${p.y},${p.z}`];return i===undefined?null:saved.palette[i];}
  if(mode==='unknown_roof'&&p.y===3)return null;
  if(mode.startsWith('pit')){
   const v=cells.get(`${p.x},${p.y},${p.z}`);if(v)return v;
   if(mode==='pit_unknown_floor'&&p.y===-2)return null;
   return p.y<-1?'stone':p.y===-1?'dirt':p.y===0?'grass_block':'air';
  }
  const v=cells.get(`${p.x},${p.y},${p.z}`);if(v)return v;
  if(p.y<1)return 'stone';if(p.x>=1&&p.x<=4&&Math.abs(p.z)<=2&&p.y<=3)return p.y===3?'grass_block':'dirt';return 'air';
 }}),bot=f.bot,profile=new Movements(bot);Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allowSprinting:false,allow1by1towers:false,allowFreeMotion:false,maxDropDown:2,infiniteLiquidDropdownDistance:false});profile.getMoveDiagonal=()=>{};bot.pathfinder.setMovements(profile);
 const originalSlices=bot.pathfinder.getPathFromTo.bind(bot.pathfinder);let approachProbes=0,slices=0;
 bot.pathfinder.getPathFromTo=function*(...args){approachProbes++;
  if(mode==='pit_no_approach'||mode==='pit_second_approach'&&approachProbes===1){yield {result:{status:'noPath',path:[]}};return;}
  if(mode==='pit_partial_approach'&&args[3]?.optimizePath===false){yield {result:{status:'partial',path:[]}};slices++;}
  yield* originalSlices(...args);
 };
 bot.time=mode==='unknown_clock'?{}:{timeOfDay:13000,age:13000};let state=null,stock=0,clock=0,waits=0,paused=false,interrupted=false;
 const records=[],deps={getBot:()=>bot,isOwnerCurrent:()=>true,assertActive:()=>{if(paused)throw Object.assign(Error('paused'),{code:'paused'});},getState:()=>state,saveState:s=>{state=s;},now:()=>clock,
  wait:async ms=>{clock+=ms;await new Promise(r=>setTimeout(r,5));if(state?.phase==='waiting_native_daylight'){waits++;bot.time.age+=20;bot.time.timeOfDay=waits>=2?0:13020;}},
  excluded:p=>mode==='protected'&&p.x>=1||mode==='pit_protected'&&p.y<=0,hasThreat:()=>false,hasConstructionThreat:()=>mode==='pit_nearby_threat'||mode==='pit_arriving_threat'&&clock>=1000,countDirt:()=>stock,
  goto:async g=>{if(mode.endsWith('approach_interrupt')&&!interrupted){interrupted=true;await bot.pathfinder.goto(new (require('mineflayer-pathfinder').goals.GoalBlock)(-3,1,0));if(mode==='pit_pause_approach_interrupt')paused=true;throw Object.assign(Error('modeled owned native relocation'),{code:'house_site_defense_relocated',siteDefenseRelocation:{kind:'actual_owned_site_defense_relocation',oldTargetReached:false,arrivalConfirmed:mode!=='pit_foreign_approach_interrupt',actual:{...bot.entity.position}}});}return bot.pathfinder.goto(g);},dig:async b=>{writes.push({kind:'dig',position:b.position.clone()});cells.set(`${b.position.x},${b.position.y},${b.position.z}`,'air');if(!mode.includes('no_drop_ack')&&['dirt','grass_block'].includes(b.name))stock++;
   if(mode.endsWith('dig_interrupt')&&!interrupted){interrupted=true;throw Object.assign(Error('modeled exact defense interrupted dig'),{code:'movement_preempted'});}},
  resumeAfterDefense:async(error,options)=>{assert.equal(error.code,'movement_preempted');assert.equal(options.deadline,Math.min(60000,clock+35000));
   if(mode==='pit_foreign_dig_interrupt')return false;if(mode==='pit_pause_dig_interrupt')throw Object.assign(Error('paused'),{code:'paused'});
   await bot.pathfinder.goto(new (require('mineflayer-pathfinder').goals.GoalBlock)(-3,1,0));return true;},
  place:async s=>{writes.push({kind:'place',position:s.position});assert.ok(stock>0);stock--;if(mode!=='no_place_ack')cells.set(`${s.position.x},${s.position.y},${s.position.z}`,'dirt');},
  rememberSeal:s=>ledger.add(s.id),retireSeal:s=>ledger.delete(s.id),exitThreatPresent:()=>false,record:(kind,facts)=>records.push({kind,facts}),
  onNativeClock:()=>{if(mode.endsWith('pause'))paused=true;},};
 const run=prepareStarterAlcove(deps);
 if(['complete','pit_complete','pit_saved','pit_saved_uphill','pit_saved_sand_edge','pit_owned_dig_interrupt','pit_second_approach','pit_partial_approach','pit_owned_approach_interrupt'].includes(mode)){
  const r=await run;assert.equal(r.used,true);assert.equal(state.phase,'exited_native_daylight');assert.equal(writes.filter(w=>w.kind==='dig').length,mode.startsWith('pit_saved')?8:mode==='pit_owned_dig_interrupt'?7:6);assert.equal(writes.filter(w=>w.kind==='place').length,mode.startsWith('pit')?3:2);if(mode.startsWith('pit'))assert.equal(state.plan.kind,'self_excavated_two_step_pit');
  assert.deepEqual([...ledger],['legacy-remote-cover']);assert.ok(f.points.length>10);assert.equal(bot.entity.position.floored().equals(new Vec3(state.plan.stand.x,state.plan.stand.y,state.plan.stand.z)),true);assert.ok(records.some(r=>r.kind==='house_starter_alcove_native_confirmed'));
  if(mode==='pit_partial_approach')assert.ok(slices>0);
  if(mode==='pit_second_approach'){assert.equal(records.filter(r=>r.kind==='house_starter_native_approach_probe').length,2);assert.ok(records.some(r=>r.kind==='house_starter_native_approach_probe'&&r.facts.confirmedPlan===false));}
  if(mode==='pit_owned_dig_interrupt'){assert.equal(state.plan.stand.x,-3);assert.ok(records.some(r=>r.kind==='house_starter_owned_defense_reobserved'&&r.facts.oldSiteReturnRequired===false));}
 }else if(mode==='protected'||mode==='unknown_roof'||mode==='pit_unknown_floor'||mode==='pit_protected'||mode==='pit_no_approach'||mode==='pit_nearby_threat'||mode==='pit_arriving_threat'){assert.equal((await run).used,false);assert.equal(writes.length,0);if(mode==='pit_no_approach')assert.equal(approachProbes,4);}
 else{await assert.rejects(run,{code:{pause:'paused',no_drop_ack:'house_starter_dirt_unconfirmed',no_place_ack:'house_starter_seal_unconfirmed',unknown_clock:'house_starter_clock_unknown',pit_pause:'paused',pit_no_drop_ack:'house_starter_dirt_unconfirmed',pit_foreign_dig_interrupt:'movement_preempted',pit_pause_dig_interrupt:'paused',pit_foreign_approach_interrupt:'house_site_defense_relocated',pit_pause_approach_interrupt:'paused'}[mode]});
  if(mode.endsWith('pause')){assert.equal(starterAlcoveConfirmed(bot,state.plan),true);assert.equal(writes.length,6);assert.equal(ledger.size,mode==='pit_pause'?4:3);}}
});
