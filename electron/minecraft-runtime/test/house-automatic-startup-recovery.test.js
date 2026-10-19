'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const {selfGatheredHouseWork,armHouseRecovery,houseRecoveryDecision}=require('../vendor/server/minecraft/houseAutomaticRecovery');
const task=()=>({intent:'build_furnished_house',startupWood:{schema:1},plan:{steps:[{skill:'build_furnished_house_phase',args:{materialSource:'self_gathered'}}]}});
test('automatic startup recovery only arms bounded transient combat errors for natural production plans',()=>{
 const t=task();assert.equal(selfGatheredHouseWork(t),true);assert.equal(t.materialSupply,undefined);
 assert.equal(armHouseRecovery(t,'house_no_safe_site',100),null);assert.equal(armHouseRecovery(t,'movement_preempted',100),null);
 assert.equal(armHouseRecovery({...t,plan:{steps:[{skill:'build_furnished_house_phase',args:{materialSource:'external_depots'}}]}},'house_creeper_escape_no_path',100),null);
 assert.ok(armHouseRecovery(t,'house_ranged_cover_unavailable',100));
 assert.ok(armHouseRecovery(t,'house_dry_graph_survival_limit',100));
 assert.ok(armHouseRecovery(t,'house_surface_creeper_escape_unconfirmed',100));
 assert.ok(armHouseRecovery(t,'house_creeper_escape_path_changed',100));
 assert.equal(armHouseRecovery(t,'house_surface_creeper_escape_threat_limit',100),null);
 const r=armHouseRecovery(t,'house_creeper_escape_no_path',100);assert.equal(r.deadline,120100);assert.equal(r.attempts,0);
 assert.equal(armHouseRecovery({...t,automaticWorkRecovery:{attempts:8}},'house_creeper_escape_no_path',100),null);
});
test('automatic work resume requires actual native safety, no threat/motor, same owner and finite recovery budget',()=>{
 const r=armHouseRecovery(task(),'house_creeper_escape_no_path',100),facts={now:1200,ownerCurrent:true,health:20,food:20,grounded:true,dry:true,goalActive:false,controlsActive:false,threatPresent:false};
 assert.equal(houseRecoveryDecision(r,facts),'ready');
 for(const extra of [{health:NaN},{food:Infinity},{threatPresent:undefined},{health:15},{food:13},{grounded:false},{dry:false},{goalActive:true},{controlsActive:true},{threatPresent:true}])assert.equal(houseRecoveryDecision(r,{...facts,...extra}),'waiting');
 assert.equal(houseRecoveryDecision(r,{...facts,ownerCurrent:false}),'foreign');assert.equal(houseRecoveryDecision(r,{...facts,now:120100}),'expired');
});
const filename=path.join(__dirname,'mining-combat-coordination.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\ntest('))+'\nmodule.exports={fixture};\n',filename);
test('production paused pre-camp task retains independent native self-defense without fabricating material supply',{timeout:6000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false});Object.assign(f.task,task(),{status:'paused',automaticSurvivalRecovery:true,automaticWorkRecovery:{enabled:true,attempts:0}});f.task.cancellationToken.pause();
 f.bot.inventory.items=()=>[];f.bot.heldItem=null;
 const hostile={id:88,name:'zombie',displayName:'Zombie',isValid:true,position:new Vec3(2.5,1,.5),height:1.95};f.bot.entities[88]=hostile;
 await f.agent.__testHandleSurvivalCritical('modeled_startup_paused_contact');
 assert.ok(f.attacks.length>0);assert.equal(f.task.status,'paused');assert.equal(f.task.cancellationToken.pauseRequested,true);
 assert.equal(f.task.materialSupply,undefined);assert.ok(f.task.startupWood.combatMode);
 await f.agent.handleMessage({type:'mc_command_pause'});assert.equal(f.task.automaticSurvivalRecovery,false);assert.equal(f.task.automaticWorkRecovery.enabled,false);
});

test('manual pause during independent pre-camp defense revokes its writes and automatic work resume',{timeout:6000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false,killAfter:99});Object.assign(f.task,task(),{status:'paused',automaticSurvivalRecovery:true,automaticWorkRecovery:{enabled:true,attempts:0}});f.task.cancellationToken.pause();
 f.bot.inventory.items=()=>[];f.bot.heldItem=null;f.bot.entities[88]={id:88,name:'zombie',displayName:'Zombie',isValid:true,position:new Vec3(2.5,1,.5),height:1.95};
 const defending=f.agent.__testHandleSurvivalCritical('modeled_pause_during_startup_defense');defending.catch(()=>{});
 const until=Date.now()+1500;while(!f.attacks.length&&Date.now()<until)await new Promise(r=>setTimeout(r,10));assert.ok(f.attacks.length);
 await f.agent.handleMessage({type:'mc_command_pause'});const attacks=f.attacks.length;
 await defending.catch(()=>{});await new Promise(r=>setTimeout(r,400));
 assert.equal(f.attacks.length,attacks);assert.equal(f.task.automaticSurvivalRecovery,false);assert.equal(f.task.automaticWorkRecovery.enabled,false);assert.equal(f.task.materialSupply,undefined);
});

test('production pre-camp resource profile refuses ordinary unarmed steps toward a loaded close melee mob',{timeout:6000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false});Object.assign(f.task,task());f.bot.inventory.items=()=>[];f.bot.heldItem=null;
 f.bot.entities[88]={id:88,name:'zombie',displayName:'Zombie',isValid:true,position:new Vec3(2.5,1,.5),height:1.95};
 await f.agent.__testWithHouseResourceWork(async()=>{
  const profile=f.bot.pathfinder.movements,near=f.bot.blockAt(new Vec3(1,1,0)),away=f.bot.blockAt(new Vec3(-2,1,0));
  assert.ok(profile.exclusionAreasStep.some(check=>check(near)===Infinity));assert.ok(profile.exclusionAreasStep.every(check=>check(away)!==Infinity));
  const {goals}=require('mineflayer-pathfinder'),plan=f.bot.pathfinder.getPathTo(profile,new goals.GoalBlock(1,1,0),100);
  assert.notEqual(plan.status,'success');assert.equal(f.attempts.length,0);
 },{deadline:Date.now()+3000});assert.equal(f.task.materialSupply,undefined);
});

test('production empty-hand contact reaction is not suppressed by an ordinary distant creeper',{timeout:6000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false});Object.assign(f.task,task());f.bot.inventory.items=()=>[];f.bot.heldItem=null;
 f.bot.entities[88]={id:88,name:'zombie',displayName:'Zombie',isValid:true,position:new Vec3(2.5,1,.5),height:1.95};
 const creeper={id:89,name:'creeper',isValid:true,position:new Vec3(6.5,1,.5),height:1.7,metadata:[]},keys=f.bot.registry.entitiesByName.creeper.metadataKeys;
 creeper.metadata[keys.indexOf('is_powered')]=false;creeper.metadata[keys.indexOf('is_ignited')]=false;creeper.metadata[keys.indexOf('swell_dir')]=-1;f.bot.entities[89]=creeper;
 await f.agent.__testHandleSurvivalCritical('modeled_empty_hand_contact_before_distant_creeper');
 assert.ok(f.attacks.length);assert.equal(f.attacks[0].id,88);assert.equal(f.task.materialSupply,undefined);
});
test('production empty-hand blocked-contact defense uses native hand cooldown, not the slower sword cooldown',{timeout:6000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false,killAfter:3});Object.assign(f.task,task());f.bot.inventory.items=()=>[];f.bot.heldItem=null;
 const old=f.bot.blockAt;
 f.bot.blockAt=p=>{const q=p.floored();return q.y===0&&(q.x< -1||q.x>2||q.z< -1||q.z>1)
  ?Object.assign(require('prismarine-block')(f.bot.registry).fromStateId(f.bot.registry.blocksByName.water.defaultState),{position:q}):old(p);};
 f.bot.entities[88]={id:88,name:'zombie',displayName:'Zombie',isValid:true,position:new Vec3(2.5,1,.5),height:1.95};
 await f.agent.__testHandleSurvivalCritical('modeled_empty_hand_blocked_contact');
 assert.equal(f.attacks.length,3);for(let i=1;i<f.attacks.length;i++){const delay=f.attacks[i].at-f.attacks[i-1].at;assert.ok(delay>=250&&delay<600,`actual packet delay ${delay}`);}
 assert.equal(f.task.materialSupply,undefined);
});

test('distant loaded mobs do not spend terrain-ray reads or starve a native adjacent startup path',{timeout:6000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false});Object.assign(f.task,task());f.bot.inventory.items=()=>[];f.bot.heldItem=null;
 for(let i=0;i<160;i++)f.bot.entities[100+i]={id:100+i,name:'zombie',isValid:true,position:new Vec3(20+i,1,10),height:1.95};
 let reads=0;const old=f.bot.blockAt;f.bot.blockAt=p=>{reads++;return old(p);};
 await f.agent.__testWithHouseResourceWork(async()=>{
  const profile=f.bot.pathfinder.movements,point=f.bot.blockAt(new Vec3(1,1,0));reads=0;
  assert.equal(profile.exclusionAreasStep[2](point),0);assert.equal(reads,0,'An irrelevant far mob needs no terrain occlusion proof');
  const {goals}=require('mineflayer-pathfinder'),plan=f.bot.pathfinder.getPathTo(profile,new goals.GoalBlock(1,1,0),100);
  assert.equal(plan.status,'success');assert.equal(f.attempts.length,0);
 },{deadline:Date.now()+3000});assert.equal(f.task.materialSupply,undefined);
});

test('an actual observed archer aggressor keeps ranged cover routing instead of generic low-health melee escape',{timeout:10000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false});Object.assign(f.task,task());f.bot.inventory.items=()=>[];f.bot.heldItem=null;f.bot.health=9;
 for(let z=2;z<=8;z++)for(let y=1;y<=2;y++)f.change('stone',new Vec3(2,y,z));
 const threat={id:88,name:'stray',isValid:true,entityType:f.bot.registry.entitiesByName.stray.id,height:1.99,position:new Vec3(4.5,1,.5)};f.bot.entities[88]=threat;
 assert.equal(require('../vendor/server/minecraft/entitySemantics').recordObservedSelfAggressor(f.bot,f.bot.entity,threat),true);
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('modeled_observed_archer_cover'));
 assert.equal(require('../vendor/server/minecraft/houseRangedCover').rangedCoverConfirmed(f.bot,f.bot.entity.position,[threat]),true);
 assert.equal(f.attacks.length,0);assert.equal(f.task.materialSupply,undefined);assert.equal(f.bot.health,9);
});

test('a healthy unarmed creeper escape does not acquire a distant nonattacking archer after the threat is resolved',{timeout:8000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false,resourceThreat:'creeper'});Object.assign(f.task,task());f.bot.inventory.items=()=>[];f.bot.heldItem=null;
 const archer={id:88,name:'skeleton',isValid:true,position:new Vec3(-12.5,1,8.5),height:1.99};f.bot.entities[88]=archer;
 f.task.diagnostics={traceId:'ranged-reselection',tracePath:path.join(process.env.MC_AGENT_DIAGNOSTICS_DIR,'ranged-reselection.jsonl'),startedAt:Date.now(),eventCount:0};
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('modeled_creeper_with_distant_archer'));
 assert.equal(f.bot.health,20);assert.equal(f.attacks.length,0);assert.ok(f.bot.entity.position.distanceTo(f.bot.entities[4].position)>=8.5);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 const files=fs.readdirSync(process.env.MC_AGENT_DIAGNOSTICS_DIR).filter(n=>n.endsWith('.jsonl'));
 const events=files.flatMap(n=>fs.readFileSync(path.join(process.env.MC_AGENT_DIAGNOSTICS_DIR,n),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
 assert.equal(events.some(e=>e.event==='house_ranged_target_locked'),false);
});

test('ordinary unarmed startup native planning refuses approaching a visible fifteen-meter creeper but permits retreat',{timeout:6000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false});Object.assign(f.task,task());f.bot.inventory.items=()=>[];f.bot.heldItem=null;
 f.bot.entities[88]={id:88,name:'creeper',isValid:true,position:new Vec3(15.5,1,.5),height:1.7};
 await f.agent.__testWithHouseResourceWork(async()=>{
  const profile=f.bot.pathfinder.movements,{goals}=require('mineflayer-pathfinder');
  const toward=f.bot.pathfinder.getPathTo(profile,new goals.GoalBlock(1,1,0),100);assert.notEqual(toward.status,'success');
  const away=f.bot.pathfinder.getPathTo(profile,new goals.GoalBlock(-1,1,0),100);assert.equal(away.status,'success');
  assert.equal(f.attempts.length,0);
 },{deadline:Date.now()+3000});
});

test('resource graph cooperative boundary drains a defense acquired before any native goal starts',{timeout:10000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false,killAfter:2});Object.assign(f.task,task(),{materialSupply:{materialSource:'self_gathered'}});
 const set=f.bot.pathfinder.setMovements.bind(f.bot.pathfinder);let injected=false,defending;
 f.bot.pathfinder.setMovements=profile=>{const value=set(profile);if(!injected&&profile.canDig===false){
  injected=true;f.bot.entities[88]={id:88,name:'zombie',isValid:true,position:new Vec3(2.5,1,.5),height:1.95};
  defending=f.agent.__testHandleSurvivalCritical('modeled_graph_boundary_defense');defending.catch(()=>{});
 }return value;};
 const result=await f.agent.__testHouseSurfaceGraphNext({x:0,y:1,z:0});await defending;
 assert.equal(injected,true);assert.equal(f.attacks.length,2);assert.equal(f.bot.entities[88],undefined);
 assert.equal(result.moved,true);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);assert.equal(f.task.status,'running');
});

test('wounded original material task may resume only its mandatory nutrition path under actual safe provisioning facts',()=>{
 const r=armHouseRecovery(task(),'house_creeper_escape_no_path',100),facts={now:1200,ownerCurrent:true,health:8,food:17,grounded:true,dry:true,goalActive:false,controlsActive:false,threatPresent:false,provisionInOriginalTask:true};
 assert.equal(houseRecoveryDecision(r,facts),'provision');
 for(const change of [{provisionInOriginalTask:false},{provisionInOriginalTask:undefined},{health:5.9},{food:7},{threatPresent:true},{grounded:false},{dry:false},{goalActive:true},{controlsActive:true}])assert.equal(houseRecoveryDecision(r,{...facts,...change}),'waiting');
 assert.equal(houseRecoveryDecision(r,{...facts,health:16,food:14}),'ready');
 assert.equal(houseRecoveryDecision(r,{...facts,ownerCurrent:false}),'foreign');
});

test('blocked unarmed defense reobserves the nearer second zombie between native attack packets',{timeout:6000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false,killAfter:99});Object.assign(f.task,task());f.bot.inventory.items=()=>[];f.bot.heldItem=null;
 delete f.bot.entities[2];
 const old=f.bot.blockAt;
 f.bot.blockAt=p=>{const q=p.floored();return q.y===0&&(q.x< -1||q.x>2||q.z< -1||q.z>1)
  ?Object.assign(require('prismarine-block')(f.bot.registry).fromStateId(f.bot.registry.blocksByName.water.defaultState),{position:q}):old(p);};
 const a={id:88,name:'zombie',isValid:true,position:new Vec3(2,1,.5),height:1.95};
 const b={id:89,name:'zombie',isValid:true,position:new Vec3(2.8,1,.5),height:1.95};f.bot.entities[88]=a;f.bot.entities[89]=b;
 const sent=[];f.bot.attack=e=>{sent.push(e.id);if(sent.length===1){a.position=new Vec3(2.8,1,.5);b.position=new Vec3(1.5,1,.5);}
  if(sent.length>=2){delete f.bot.entities[88];delete f.bot.entities[89];f.bot.emit('entityGone',a);f.bot.emit('entityGone',b);}};
 await f.agent.__testHandleSurvivalCritical('modeled_two_native_contact_attackers');
 assert.deepEqual(sent,[88,89]);assert.equal(f.bot.pathfinder.goal,null);
});

test('low-health original food work retreats from an observed unarmed distant attacker instead of failing the no-chase gate',{timeout:6000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false});Object.assign(f.task,task());f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.inventory.items=()=>[];f.bot.heldItem=null;f.bot.health=7;f.bot.food=17;
 const tracePath=path.join(process.env.MC_AGENT_DIAGNOSTICS_DIR,'low-health-food-retreat.jsonl');
 f.task.diagnostics={traceId:'low-health-food-retreat',tracePath,startedAt:Date.now(),eventCount:0};
 const e={id:88,name:'zombie',isValid:true,entityType:f.bot.registry.entitiesByName.zombie.id,position:new Vec3(6.5,1,.5),height:1.95};f.bot.entities[88]=e;
 await f.agent.__testWithHouseResourceWork(async()=>{
  await new Promise(r=>setTimeout(r,150));
  f.bot.emit('entityHurt',f.bot.entity,e);
  const until=Date.now()+2500;
  while(Date.now()<until){await new Promise(r=>setTimeout(r,20));if(f.attempts.length&&f.agent.__testGetActiveMovementLease()===f.task.movementLease)break;}
  assert.ok(f.attempts.length,fs.existsSync(tracePath)?fs.readFileSync(tracePath,'utf8'):'no diagnostic');assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 },{deadline:Date.now()+4000});
 const rows=fs.readFileSync(tracePath,'utf8').trim().split('\n').map(JSON.parse);
 assert.ok(rows.some(r=>r.event==='creeper_escape_confirmed'));
 assert.equal(rows.some(r=>r.event==='house_combat_defense_failed'),false);
 assert.ok(f.bot.entity.position.x<0);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.health,7);
});

test('original food safety drains each remaining native contact threat before returning to low-health provisioning',{timeout:8000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false});Object.assign(f.task,task());f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.health=7;f.bot.inventory.items=()=>[];f.bot.heldItem=null;
 delete f.bot.entities[2];
 const nativeBlockAt=f.bot.blockAt;
 f.bot.blockAt=p=>{const q=p.floored();return q.y===0&&(q.x< -1||q.x>2||q.z< -1||q.z>1)
  ?Object.assign(require('prismarine-block')(f.bot.registry).fromStateId(f.bot.registry.blocksByName.water.defaultState),{position:q}):nativeBlockAt(p);};
 f.bot.entities[88]={id:88,name:'zombie',isValid:true,position:new Vec3(2,1,.5),height:1.95};
 f.bot.entities[89]={id:89,name:'zombie',isValid:true,position:new Vec3(2.6,1,.5),height:1.95};
 const until=Date.now()+5000;
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testSettleHouseFoodThreats(until,'modeled_low_health_food_two_threats'),{deadline:until});
 assert.deepEqual([...new Set(f.attacks.map(a=>a.id))].sort(),[88,89]);
 assert.equal(f.bot.entities[88],undefined);assert.equal(f.bot.entities[89],undefined);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);assert.equal(f.bot.health,7);
});

test('food defense drain cannot extend an expired original provisioning deadline',async t=>{
 const f=native.exports.fixture(t,{interrupt:false});Object.assign(f.task,task());
 await assert.rejects(f.agent.__testSettleHouseFoodThreats(Date.now()-1,'expired_food_deadline'),{code:'house_food_defense_deadline'});
 assert.equal(f.attacks.length,0);assert.equal(f.attempts.length,0);
});

test('observed incoming archer takes over a native melee defense once no melee remains in contact',{timeout:7000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false,killAfter:99});Object.assign(f.task,task());f.task.materialSupply={materialSource:'self_gathered'};
 const tracePath=path.join(process.env.MC_AGENT_DIAGNOSTICS_DIR,'contact-to-native-archer.jsonl');f.task.diagnostics={traceId:'contact-to-native-archer',tracePath,startedAt:Date.now(),eventCount:0};
 const melee={id:88,name:'zombie',isValid:true,entityType:f.bot.registry.entitiesByName.zombie.id,position:new Vec3(2.5,1,.5),height:1.95};f.bot.entities[88]=melee;
 const archer={id:89,name:'skeleton',isValid:true,entityType:f.bot.registry.entitiesByName.skeleton.id,position:new Vec3(12.5,1,.5),height:1.99};
 let sent=0;f.bot.attack=()=>{sent++;melee.position=new Vec3(5.5,1,.5);f.bot.entities[89]=archer;f.bot.emit('entityHurt',f.bot.entity,archer);};
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('native_melee_then_archer')).catch(e=>assert.ok(['house_ranged_cover_unavailable','house_ranged_cover_limit','survival_interrupt_timeout'].includes(e.code),e.code));
 const rows=fs.readFileSync(tracePath,'utf8').trim().split('\n').map(JSON.parse);
 assert.ok(rows.some(r=>r.event==='survival_threat_escalated'&&r.details.to==='skeleton'));
 assert.equal(sent,1,'The distant old melee target must not consume more attacks after the observed archer hit');
});

test('startup origin readiness drains only its exact active native defense before passive settling',{timeout:6000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false,killAfter:3});Object.assign(f.task,task());f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.entities[88]={id:88,name:'zombie',isValid:true,entityType:f.bot.registry.entitiesByName.zombie.id,position:new Vec3(2.5,1,.5),height:1.95};
 await f.agent.__testWithHouseResourceWork(async()=>{
  const defending=f.agent.__testHandleSurvivalCritical('native_startup_origin_boundary');
  assert.equal(await f.agent.__testDrainStartupOriginDefense(),true);await defending;
  assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
  assert.equal(await f.agent.__testDrainStartupOriginDefense(),false);
 },{deadline:Date.now()+4000});assert.equal(f.attacks.length,3);
});
