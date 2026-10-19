'use strict';
const fail=(code,message)=>Object.assign(Error(message),{code});
// Escape an accidental immersion using the installed native pathfinder. This
// supplies no digging, placing, teleportation, arbitrary network or host access.
async function escapeEmergencyShore(deps){
 const bot=deps.getBot(),client=bot._client,origin=bot.entity.position.clone();
 const {Vec3,Movements,GoalBlock}=deps,previous=bot.pathfinder.movements;
 const deadline=Date.now()+12000,hazards=new Set(['lava','fire','soul_fire','magma_block','campfire','soul_campfire','cactus','powder_snow','bubble_column','sweet_berry_bush']);
 const check=()=>{deps.assertActive();if(deps.getBot()!==bot||bot._client!==client||bot.health<=0)throw fail('house_shore_owner_changed','上岸期间连接或任务已改变');
  if(Date.now()>=deadline)throw fail('house_shore_timeout','有限上岸动作超时');};
 const read=p=>{const b=bot.blockAt(p);return b&&!hazards.has(b.name)?b:null;};
 const pass=p=>{const b=read(p);return !!b&&(b.name==='water'||b.boundingBox==='empty');};
 const legal=p=>Math.hypot(p.x-origin.x,p.z-origin.z)<=16&&p.y>=origin.y-3&&p.y<=origin.y+7&&pass(p)&&pass(p.offset(0,1,0));
 const profile=new Movements(bot);profile.canDig=false;profile.scafoldingBlocks=[];profile.allow1by1towers=false;
 profile.allowParkour=false;profile.allowSprinting=false;profile.allowFreeMotion=false;profile.maxDropDown=1;profile.infiniteLiquidDropdownDistance=false;
 for(const name of hazards){const id=bot.registry.blocksByName[name]?.id;if(id!==undefined)profile.blocksToAvoid.add(id);}
 // safeOrBreak also queries head cells, so validate loaded body cells here and
 // validate full feet/head geometry of the returned native path separately.
 profile.exclusionAreasStep.push(b=>b?.position&&read(b.position)&&Math.hypot(b.position.x-origin.x,b.position.z-origin.z)<=16?0:Infinity);
 // A saved swimmer below a bank lip has no legal native starting node.
 // Float under this same12s rescue budget before probing, using only native
 // jump/physics. Query contact tolerance is installed by the production host.
 if(!deps.isGrounded()&&origin.y%1>.01){
  check();if(bot.pathfinder.goal)throw fail('house_shore_native_goal_active','上浮前原动作尚未收束');
  const until=Math.min(deadline,Date.now()+1800),targetY=Math.ceil(origin.y)+.1;
  deps.setActive?.(profile);bot.pathfinder.setMovements(profile);
  try{
   bot.setControlState('jump',true);
   while(!deps.isGrounded()&&bot.entity.position.y<targetY&&Date.now()<until){check();
    if(Math.hypot(bot.entity.position.x-origin.x,bot.entity.position.z-origin.z)>.5)throw fail('house_shore_float_displacement','原地上浮偏离实际水格');
    const feet=bot.entity.position.floored(),under=bot.blockAt(feet),head=bot.blockAt(feet.offset(0,1,0));
    if(!under||!head||hazards.has(under.name)||hazards.has(head.name))throw fail('house_shore_float_hazard','原地上浮遇到未知或危险方块');
    await new Promise(resolve=>setTimeout(resolve,20));
   }
   check();deps.record?.('house_emergency_shore_floated',{before:{x:origin.x,y:origin.y,z:origin.z},actual:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},nativePhysicsOnly:true});
  }finally{
   let owns=false;try{deps.assertActive();owns=deps.getBot()===bot&&bot._client===client&&bot.pathfinder.movements===profile;}catch{}
   if(owns){bot.setControlState('jump',false);bot.pathfinder.setMovements(previous);}deps.setActive?.(null);
  }
 }
 const threats=Object.values(bot.entities||{}).filter(e=>e.isValid!==false&&e.position&&['creeper','zombie','husk','drowned','spider','cave_spider','skeleton','stray','bogged'].includes(e.name));
 const away=p=>!threats.some(e=>p.distanceTo(e.position)<Math.min(e.name==='creeper'?8.5:4.5,origin.distanceTo(e.position)-.15));
 const candidates=[];
 for(let r=1;r<=16;r++)for(let dx=-r;dx<=r;dx++)for(let dz=-r;dz<=r;dz++){
  if(Math.max(Math.abs(dx),Math.abs(dz))!==r)continue;
  for(let dy=-1;dy<=7;dy++){
   const p=origin.floored().offset(dx,dy,dz);if(!legal(p)||!deps.isDryFoot(p))continue;
   if(threats.some(e=>e.position.distanceTo(p)<(e.name==='creeper'?5:3)))continue;
   candidates.push(p);
  }
 }
 candidates.sort((a,b)=>a.distanceTo(origin)-b.distanceTo(origin));
 // The nearest sixteen feet can all belong to the same unclimbable bank.
 // Give other directions/heights a probe within the original time budget.
 const groups=new Set(),spread=[],rest=[];
 for(const p of candidates){
  const sector=Math.round(Math.atan2(p.z-origin.z,p.x-origin.x)/(Math.PI/4));
  const group=`${sector}:${Math.min(2,Math.max(-1,p.y-Math.floor(origin.y)))}`;
  if(groups.has(group))rest.push(p);else{groups.add(group);spread.push(p);}
 }
 let probes=0,lastError;const outcomes={};
 try{
  for(const target of [...spread,...rest]){
   check();if(++probes>32)break;
   const goal=new GoalBlock(target.x,target.y,target.z);
   const result=bot.pathfinder.getPathTo(profile,goal,200);
   outcomes[result.status]=(outcomes[result.status]||0)+1;
   if(result.status!=='success'||!result.path?.length||result.path.length>64||result.path.some(p=>(!legal(new Vec3(p.x,p.y,p.z))||!away(new Vec3(p.x,p.y,p.z)))))continue;
   bot.pathfinder.setMovements(profile);deps.setActive?.(profile);
   deps.record?.('house_emergency_shore_started',{target:{x:target.x,y:target.y,z:target.z},health:bot.health,pathLength:result.path.length});
   try{
    await deps.goto(goal,{timeoutMs:Math.max(1,deadline-Date.now()),isOwnerCurrent:()=>{try{check();return true;}catch{return false;}}});
    check();const landUntil=Math.min(deadline,Date.now()+900);
    while(!deps.isGrounded()&&Date.now()<landUntil){check();await new Promise(resolve=>setTimeout(resolve,20));}
    check();
    if(!deps.isDryFoot(bot.entity.position.floored())||!deps.isGrounded())throw fail('house_shore_arrival_unconfirmed','原生寻路没有确认实际干地上岸');
    deps.record?.('house_emergency_shore_confirmed',{position:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},health:bot.health});return true;
   }catch(error){check();lastError=error;}finally{
    // Cancellation or a replacement actor must never receive the old profile.
    let owns=false;try{deps.assertActive();owns=deps.getBot()===bot&&bot._client===client&&bot.pathfinder.movements===profile;}catch{}
    if(owns)bot.pathfinder.setMovements(previous);
    deps.setActive?.(null);
   }
  }
  deps.record?.('house_emergency_shore_unavailable',{candidates:candidates.length,probes:Math.min(probes,32),outcomes,
    actual:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},lastError:lastError?.code||null});
  throw lastError||fail('house_shore_no_path','附近已加载地形尚未找到可实际执行的有限上岸路径');
 }finally{deps.setActive?.(null);}
}
module.exports={escapeEmergencyShore};
