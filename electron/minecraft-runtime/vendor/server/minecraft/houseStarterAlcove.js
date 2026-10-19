'use strict';
const {Vec3}=require('vec3'),{goals}=require('mineflayer-pathfinder');
const {naturalWalkingFoot,hasGroundedBodySupport,inspectSurfaceBody,runSurfaceGraphNativeProbe}=require('./houseSurfaceGraph');
const fail=(code,message)=>Object.assign(Error(message),{code});
const key=p=>`${p.x},${p.y},${p.z}`,plain=p=>({x:p.x,y:p.y,z:p.z});
const solid=b=>b&&!['sand','gravel','water','lava','magma_block','cactus','powder_snow','campfire'].includes(b.name)
 &&![true,'true'].includes(b.getProperties?.().waterlogged)&&b.shapes?.some(s=>s.length===6&&s.every((n,i)=>n===(i<3?0:1)));
const night=bot=>Number.isFinite(bot.time?.timeOfDay)&&bot.time.timeOfDay>=12000;
function planStarterAlcove(bot,excluded=()=>false,rejectedStands=new Set()){
 if(!hasGroundedBodySupport(bot)||!inspectSurfaceBody(bot).dry)return null;
 const origin=bot.entity.position.floored(),cache=new Map();
 const at=p=>{const k=key(p);if(!cache.has(k)){if(cache.size>=2048)return null;cache.set(k,bot.blockAt(new Vec3(p.x,p.y,p.z)));}return cache.get(k);};
 const view=Object.create(bot);view.blockAt=at;
 const offsets=[];for(let x=-8;x<=8;x++)for(let z=-8;z<=8;z++)if(Math.hypot(x,z)<=8)offsets.push([x,z]);offsets.sort((a,b)=>Math.hypot(...a)-Math.hypot(...b));
 // A flat dirt surface can supply its own three-block shelter. Excavate
 // only adjacent columns: a one-step entrance and a second lower standing
 // cell. Never dig the actor's own support. The two entrance plugs and roof
 // use only the three actually collected dirt drops.
 for(const [x,z]of offsets)for(const dy of [0,1,-1,2,-2]){
  const stand=origin.offset(x,dy,z);if(rejectedStands.has(key(stand))||stand.offset(.5,0,.5).distanceTo(bot.entity.position)>8||!naturalWalkingFoot(view,stand)||excluded(stand))continue;
  for(const [dx,dz]of [[1,0],[-1,0],[0,1],[0,-1]]){
   const entry=stand.offset(dx,-1,dz),inside=stand.offset(2*dx,-2,2*dz);
   const dig=[entry,inside.offset(0,1,0),inside];
   if(dig.some(p=>excluded(p)||!['dirt','grass_block'].includes(at(p)?.name)
     ||Math.abs(p.x+.5-bot.entity.position.x)<.8&&Math.abs(p.z+.5-bot.entity.position.z)<.8))continue;
   const walls=[inside.offset(-dz,0,dx),inside.offset(dz,0,-dx),inside.offset(dx,0,dz)]
    .flatMap(p=>[p,p.offset(0,1,0)]).concat([entry.offset(0,-1,0)]);
   const roofs=[inside.offset(0,2,0)],floors=[inside.offset(0,-1,0)];
   const placements=[entry,entry.offset(0,1,0),roofs[0]];
   // The first seal currently contains the exact excavated soil; the head
   // plug and roof must be loaded air or exact thin snow cleared below.
   if([...walls,...floors].some(p=>!solid(at(p)))||placements.slice(1).some(p=>excluded(p)||!['air','cave_air','void_air'].includes(at(p)?.name)&&!(at(p)?.name==='snow'&&Number(at(p).getProperties?.().layers)===1)))continue;
   return {schema:1,kind:'self_excavated_two_step_pit',stand:plain(stand),inside:[plain(inside)],
    dig:dig.map(p=>({position:plain(p),stateId:at(p).stateId})),clearCaps:placements.slice(1).filter(p=>at(p)?.name==='snow').map(p=>({position:plain(p),stateId:at(p).stateId})),walls:walls.map(plain),roofs:roofs.map(plain),floors:floors.map(plain),
    seals:placements.map(p=>({id:`starter-pit:${key(p)}`,position:plain(p),item:'dirt',properties:{}})),reads:cache.size};
  }
 }
 for(const [x,z]of offsets)for(const dy of [0,-1,1,-2,2]){
  const stand=origin.offset(x,dy,z);if(rejectedStands.has(key(stand))||stand.distanceTo(bot.entity.position)>6||!naturalWalkingFoot(view,stand)||excluded(stand))continue;
  for(const [dx,dz]of [[1,0],[-1,0],[0,1],[0,-1]]){
   const cells=[1,2].map(n=>stand.offset(dx*n,0,dz*n)),dig=cells.flatMap(p=>[p.offset(0,1,0),p]);
   if(dig.some(p=>excluded(p)||!['dirt','grass_block'].includes(at(p)?.name)))continue;
   const walls=cells.flatMap(p=>[p.offset(-dz,0,dx),p.offset(dz,0,-dx)]).concat([stand.offset(dx*3,0,dz*3)]).flatMap(p=>[p,p.offset(0,1,0)]);
   const roofs=cells.map(p=>p.offset(0,2,0)),floors=cells.map(p=>p.offset(0,-1,0));
   const seal=[stand,stand.offset(0,1,0)];
   if([...walls,...roofs,...floors].some(p=>!solid(at(p)))||seal.some(p=>excluded(p)||!['air','snow','short_grass'].includes(at(p)?.name)))continue;
   return {schema:1,stand:plain(stand),inside:cells.map(plain),dig:dig.map(p=>({position:plain(p),stateId:at(p).stateId})),
    walls:walls.map(plain),roofs:roofs.map(plain),floors:floors.map(plain),seals:seal.map((p,i)=>({id:`starter-alcove:${key(p)}`,position:plain(p),item:'dirt',properties:{}})),reads:cache.size};
  }
 }
 return null;
}
function starterBodyInside(bot,plan){
 if(!plan||!hasGroundedBodySupport(bot)||!inspectSurfaceBody(bot).dry)return false;
 const points=plan.inside,minX=Math.min(...points.map(p=>p.x)),maxX=Math.max(...points.map(p=>p.x))+1,minZ=Math.min(...points.map(p=>p.z)),maxZ=Math.max(...points.map(p=>p.z))+1,p=bot.entity.position;
 return p.x-.3>=minX-1e-6&&p.x+.3<=maxX+1e-6&&p.z-.3>=minZ-1e-6&&p.z+.3<=maxZ+1e-6&&Math.abs(p.y-points[0].y)<=.075;
}
function starterAlcoveConfirmed(bot,plan){
 if(!starterBodyInside(bot,plan))return false;
 return [...plan.walls,...plan.roofs,...plan.floors].every(q=>solid(bot.blockAt(new Vec3(q.x,q.y,q.z))))
  &&plan.seals.every(s=>bot.blockAt(new Vec3(s.position.x,s.position.y,s.position.z))?.name==='dirt');
}
async function prepareStarterAlcove(deps){
 const bot=deps.getBot(),client=bot._client,now=deps.now||Date.now,wait=deps.wait||(ms=>new Promise(r=>setTimeout(r,ms))),began=now(),
  constructionDeadline=Math.min(began+60000,Number.isFinite(deps.constructionDeadline)?deps.constructionDeadline:Infinity),replans=deps.replans||0;
 const active=()=>{deps.assertActive();if(deps.getBot()!==bot||bot._client!==client||deps.isOwnerCurrent()!==true)throw fail('house_starter_owner_changed','起步避难点已失去原任务归属');};
 active();let state=deps.getState(),plan=state?.plan;
 if(!Number.isFinite(bot.time?.timeOfDay)||bot.time.timeOfDay<0||bot.time.timeOfDay>=24000)
  throw fail('house_starter_clock_unknown','没有确认原生昼夜数据，保留掩体封口');
 if(!night(bot)&&!starterAlcoveConfirmed(bot,plan))return {used:false,reason:'native_daylight'};
 if(!starterAlcoveConfirmed(bot,plan)){
  if(bot.health<14||bot.food<8||deps.hasThreat()||deps.hasConstructionThreat?.()===true)return {used:false,reason:'no_safe_construction_window'};
  // Initial ground/time packets can precede the chunk's native entities.
  // Reobserve after a bounded real interval before committing to excavation.
  if(typeof deps.hasConstructionThreat==='function'){
   await wait(Math.min(1000,Math.max(0,constructionDeadline-now())));active();
   if(now()>=constructionDeadline)throw fail('house_starter_construction_timeout','原起步掩体施工预算已结束');
   if(deps.hasThreat()||deps.hasConstructionThreat()===true)return {used:false,reason:'no_safe_construction_window'};
  }
  const rejectedStands=new Set();let confirmedApproach=false;
  for(let attempt=0;attempt<4;attempt++){
   active();if(now()>=constructionDeadline)throw fail('house_starter_construction_timeout','原起步掩体施工预算已结束');
   plan=planStarterAlcove(bot,deps.excluded,rejectedStands);
   if(!plan)return {used:false,reason:attempt?'no_confirmed_bounded_alcove_approach':'no_loaded_soil_alcove'};
   const approachGoal=new goals.GoalBlock(plan.stand.x,plan.stand.y,plan.stand.z);
   const observed=runSurfaceGraphNativeProbe(bot,bot.pathfinder.movements,approachGoal,{assertActive:active,isOwnerCurrent:()=>deps.isOwnerCurrent()===true});
   const probe=observed.result||{};
   confirmedApproach=observed.facts.conclusive&&probe.status==='success'&&Array.isArray(probe.path)&&probe.path.length<=16
    &&probe.path.every(p=>!p.toBreak?.length&&!p.toPlace?.length&&new Vec3(Math.floor(p.x)+.5,p.y,Math.floor(p.z)+.5).distanceTo(bot.entity.position)<=8);
   deps.record('house_starter_native_approach_probe',{attempt:attempt+1,stand:plan.stand,status:probe.status,pathCount:probe.path?.length,
    confirmedPlan:confirmedApproach,slices:observed.facts.slices,actualMovementPerformed:false});
   if(confirmedApproach)break;
   // A failed/inconclusive approach does not condemn all other loaded sites.
   // Try a different stand under the same four-probe/original time bounds.
   rejectedStands.add(key(plan.stand));await wait(0);
  }
  if(!confirmedApproach)return {used:false,reason:'no_confirmed_bounded_alcove_approach'};
  deps.saveState({schema:1,phase:'digging',plan,startedAt:began});deps.record('house_starter_alcove_planned',{plan,protectionConfirmed:false});
  const action=async fn=>{active();if(now()>=constructionDeadline)throw fail('house_starter_construction_timeout','原起步掩体施工预算已结束');await fn();active();};
  try{await action(()=>deps.goto(new goals.GoalBlock(plan.stand.x,plan.stand.y,plan.stand.z),Math.max(1,constructionDeadline-now())));}
  catch(error){
   active();const r=error.siteDefenseRelocation,p=bot.entity.position;
   if(error.code!=='house_site_defense_relocated'||r?.kind!=='actual_owned_site_defense_relocation'||r.oldTargetReached!==false
     ||r.arrivalConfirmed!==true||!r.actual||!['x','y','z'].every(k=>Number.isFinite(r.actual[k]))
     ||p.distanceTo(new Vec3(r.actual.x,r.actual.y,r.actual.z))>.5||!hasGroundedBodySupport(bot)||!inspectSurfaceBody(bot).dry
     ||replans>=4||now()>=constructionDeadline)throw error;
   deps.saveState({schema:1,phase:'interrupted_owned_defense',plan,startedAt:began,actual:plain(p)});
   deps.record('house_starter_owned_approach_reobserved',{actual:plain(p),originalDeadline:constructionDeadline,replans:replans+1,oldSiteReturnRequired:false,protectionConfirmed:false});
   return prepareStarterAlcove({...deps,constructionDeadline,replans:replans+1});
  }
  for(const spec of plan.dig){
   const p=new Vec3(spec.position.x,spec.position.y,spec.position.z),b=bot.blockAt(p);
   if(!b||b.stateId!==spec.stateId||!['dirt','grass_block'].includes(b.name)||deps.excluded(p))throw fail('house_starter_soil_changed','起步土坡已变化，保留实际施工状态');
   try{await action(()=>deps.dig(b));}
   catch(error){
    if(error.code==='movement_preempted'&&replans<4&&typeof deps.resumeAfterDefense==='function'
      &&await deps.resumeAfterDefense(error,{deadline:Math.min(constructionDeadline,now()+35000)})===true){
      active();
      deps.saveState({schema:1,phase:'interrupted_owned_defense',plan,startedAt:began,actual:plain(bot.entity.position)});
      deps.record('house_starter_owned_defense_reobserved',{actual:plain(bot.entity.position),originalDeadline:constructionDeadline,
        replans:replans+1,protectionConfirmed:false,oldSiteReturnRequired:false});
      // Actual defense may have changed the viable site or completed this
      // dig. Reobserve from the native actor, keeping the original budget;
      // never retry a stale block or claim the old pit was completed.
      return prepareStarterAlcove({...deps,constructionDeadline,replans:replans+1});
    }
    throw error;
   }
   if(!['air','cave_air','void_air'].includes(bot.blockAt(p)?.name))throw fail('house_starter_dig_unconfirmed','起步挖掘尚未收到真实空气方块确认');
  }
  for(const cap of plan.clearCaps||[]){
   const p=new Vec3(cap.position.x,cap.position.y,cap.position.z),b=bot.blockAt(p);
   if(['air','cave_air','void_air'].includes(b?.name))continue;
   if(b?.name!=='snow'||b.stateId!==cap.stateId||deps.excluded(p))throw fail('house_starter_cap_changed','起步坑顶薄雪已变化');
   await action(()=>deps.dig(b));if(!['air','cave_air','void_air'].includes(bot.blockAt(p)?.name))throw fail('house_starter_cap_unconfirmed','薄雪尚未实际清成空气');
  }
  const target=plan.inside.at(-1);await action(()=>deps.goto(new goals.GoalBlock(target.x,target.y,target.z),Math.max(1,constructionDeadline-now())));
  const settleUntil=Math.min(constructionDeadline,now()+1500);
  while(!starterBodyInside(bot,plan)&&now()<settleUntil){active();await wait(25);}
  if(!starterBodyInside(bot,plan))throw fail('house_starter_landing_unconfirmed','起步坑内尚未实际落稳并进入封口范围');
  const dropsUntil=Math.min(constructionDeadline,now()+2500);while(deps.countDirt()<plan.seals.length&&now()<dropsUntil){active();await wait(50);}
  if(deps.countDirt()<plan.seals.length)throw fail('house_starter_dirt_unconfirmed','起步封口和顶盖需要实际拾取足够泥土');
  for(const spec of plan.seals){await action(()=>deps.place(spec));if(bot.blockAt(new Vec3(spec.position.x,spec.position.y,spec.position.z))?.name!=='dirt')throw fail('house_starter_seal_unconfirmed','没有确认原生泥土封口');deps.rememberSeal(spec);}
  if(!starterAlcoveConfirmed(bot,plan))throw fail('house_starter_enclosure_unconfirmed','起步掩体尚未实际封闭并落稳');
  state={schema:1,phase:'waiting_native_daylight',plan,startedAt:began};deps.saveState(state);
  deps.record('house_starter_alcove_native_confirmed',{actual:plain(bot.entity.position),seals:plan.seals,protectionConfirmed:true,houseAccepted:false});
 }
 // Native time packets and geometry are the only waiting witnesses. No time,
 // health, inventory, position or velocity is assigned by this controller.
 const waitDeadline=now()+720000;let lastTime=bot.time?.timeOfDay,lastClockAt=now();
 deps.report?.('起步土坡掩体已实际封闭，等待自然天亮');
 while(night(bot)){
  active();if(!starterAlcoveConfirmed(bot,plan))throw fail('house_starter_cover_lost','等待天亮期间起步掩体已不完整');
  if(now()>=waitDeadline||now()-lastClockAt>30000)throw fail('house_starter_daylight_unconfirmed','原等待预算内没有确认自然昼夜推进');
  if(bot.time.timeOfDay!==lastTime){lastTime=bot.time.timeOfDay;lastClockAt=now();deps.onNativeClock?.({timeOfDay:lastTime,age:bot.time.age,actual:plain(bot.entity.position)});}
  await wait(1000);
 }
 active();
 const exitDeadline=now()+120000;
 while(deps.exitThreatPresent(plan)){
  active();if(!starterAlcoveConfirmed(bot,plan))throw fail('house_starter_cover_lost','等待入口清空期间掩体已不完整');
  if(now()>=exitDeadline)throw fail('house_starter_exit_threat_pending','已自然天亮，但入口近敌尚未实际离开');
  if(bot.time.timeOfDay!==lastTime){lastTime=bot.time.timeOfDay;deps.onNativeClock?.({timeOfDay:lastTime,age:bot.time.age,phase:'exit_threat_clearance',actual:plain(bot.entity.position)});}
  await wait(1000);
 }
 for(const spec of [...plan.seals].reverse()){
  active();const p=new Vec3(spec.position.x,spec.position.y,spec.position.z),block=bot.blockAt(p);
  if(block?.name!=='dirt')throw fail('house_starter_exit_changed','起步封口已变化，不能清除未确认的方块');
  await deps.dig(block);active();if(!['air','cave_air','void_air'].includes(bot.blockAt(p)?.name))throw fail('house_starter_exit_unconfirmed','起步入口清理尚未实际确认为空气');deps.retireSeal(spec);
 }
 await deps.goto(new goals.GoalBlock(plan.stand.x,plan.stand.y,plan.stand.z),5000);active();
 deps.saveState({...state,plan,phase:'exited_native_daylight',exitedAt:now()});
 deps.record('house_starter_daylight_exit_confirmed',{actual:plain(bot.entity.position),timeOfDay:bot.time.timeOfDay,removed:plan.seals.length,oldRemoteCleanupStillRequired:true});
 return {used:true,nativeDaylight:true};
}
module.exports={planStarterAlcove,starterAlcoveConfirmed,prepareStarterAlcove};
