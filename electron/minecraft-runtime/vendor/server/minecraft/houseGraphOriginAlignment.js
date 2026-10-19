'use strict';
const {Vec3}=require('vec3'),{goals}=require('mineflayer-pathfinder');
const {naturalWalkingFoot,hasGroundedBodySupport,inspectSurfaceBody}=require('./houseSurfaceGraph');
const fail=(code,message)=>Object.assign(Error(message),{code});
// Align an actual supported edge contact before any integer graph root is
// captured. This neither changes an existing graph nor credits a visited node.
async function alignHouseGraphOrigin(deps,{deadline,excluded=()=>false}={}){
 const bot=deps.getBot(),client=bot?._client,profile=bot?.pathfinder?.movements,origin=bot?.entity?.position?.clone();
 const active=()=>{deps.assertActive();if(deps.getBot()!==bot||bot._client!==client||bot.pathfinder.movements!==profile
   ||!Number.isFinite(deadline)||Date.now()>=deadline)throw fail('house_graph_origin_preempted','Graph-origin alignment lost its original owner/profile/budget');};
 active();if(naturalWalkingFoot(bot,origin.floored())&&hasGroundedBodySupport(bot))return {aligned:false,actual:origin,graphNodeCredit:false};
 if(bot.entity.onGround!==true||!hasGroundedBodySupport(bot)||!inspectSurfaceBody(bot).dry
   ||Math.abs(origin.y-Math.round(origin.y))>.075)throw fail('house_graph_origin_unconfirmed','No actual dry grounded edge to align');
 if(profile.canDig!==false||profile.scafoldingBlocks?.length||profile.allowParkour!==false||profile.allow1by1towers!==false
   ||profile.allowSprinting!==false||profile.allowFreeMotion!==false||profile.infiniteLiquidDropdownDistance!==false||profile.maxDropDown>2)
   throw fail('house_graph_origin_profile_unsafe','Graph-origin alignment requires the captured no-dig/no-place profile');
 const half=(bot.entity.width||.6)/2,y=Math.round(origin.y),candidates=[];
 for(let x=Math.floor(origin.x-half+1e-8);x<=Math.floor(origin.x+half-1e-8);x++)for(let z=Math.floor(origin.z-half+1e-8);z<=Math.floor(origin.z+half-1e-8);z++){
  active();const p=new Vec3(x,y,z),floor=bot.blockAt(p.offset(0,-1,0));
  if(excluded(p)||!naturalWalkingFoot(bot,p)||p.offset(.5,0,.5).distanceTo(origin)>1
    ||y>origin.y+1e-6||origin.y-y>.075||!floor?.shapes?.some(s=>s.length===6&&s.every((n,i)=>n===(i<3?0:1))))continue;
  candidates.push({p,stateId:floor.stateId});
 }
 candidates.sort((a,b)=>a.p.offset(.5,0,.5).distanceTo(origin)-b.p.offset(.5,0,.5).distanceTo(origin));
 const selected=candidates[0];if(!selected)throw fail('house_graph_origin_unconfirmed','No loaded actual full-floor contact can receive the original actor');
 const goal=new goals.GoalBlock(selected.p.x,selected.p.y,selected.p.z),native=bot.pathfinder.getPathTo(profile,goal,100);
 deps.record?.({phase:'native_probe',actual:bot.entity.position.clone(),selected:selected.p,status:native.status,path:(native.path||[]).slice(0,8).map(p=>({x:p.x,y:p.y,z:p.z,breakCount:p.toBreak?.length||0,placeCount:p.toPlace?.length||0})),stepExclusions:profile.exclusionAreasStep.map(fn=>{try{return fn(bot.blockAt(selected.p));}catch(error){return error.code||error.message;}})});
 active();if(native.status!=='success'||!Array.isArray(native.path)||native.path.length>2
   ||native.path.some(p=>p.toBreak?.length||p.toPlace?.length||p.y!==y))throw fail('house_graph_origin_no_path','No finite native alignment path is confirmed');
 await deps.goto(goal,Math.max(1,Math.min(2000,deadline-Date.now())));active();
 // A native goal can complete during the final fraction of a knockback
 // landing. Observe the already falling actor only; do not issue another
 // motor command or credit support before actual contact is restored.
 const landingDeadline=Math.min(deadline,Date.now()+1200);
 while(bot.entity.onGround===false&&bot.entity.position.floored().equals(selected.p)
   &&bot.entity.velocity.y<=0&&bot.entity.velocity.y>=-.9
   &&bot.entity.position.y>=y&&bot.entity.position.y-y<=.5){
  active();
  if(!inspectSurfaceBody(bot).dry||bot.entity.position.distanceTo(origin)>1
    ||!naturalWalkingFoot(bot,selected.p)||bot.blockAt(selected.p.offset(0,-1,0))?.stateId!==selected.stateId
    ||bot.pathfinder.goal!==null&&bot.pathfinder.goal!==goal
    ||['forward','back','left','right','jump','sprint','sneak'].some(k=>bot.controlState[k]!==false)
    ||Date.now()>=landingDeadline)break;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 active();
 if(!bot.entity.position.floored().equals(selected.p)||bot.entity.onGround!==true||!hasGroundedBodySupport(bot)
   ||!naturalWalkingFoot(bot,selected.p)||bot.blockAt(selected.p.offset(0,-1,0))?.stateId!==selected.stateId
   ||Math.abs(bot.entity.position.y-y)>.075||bot.entity.position.distanceTo(origin)>1)
   throw fail('house_graph_origin_arrival_unconfirmed','Original actor has not actually aligned with its unchanged dry support');
 const result={aligned:true,before:origin,actual:bot.entity.position.clone(),graphNodeCredit:false,positionOrVelocityWritten:false};deps.record?.(result);return result;
}
module.exports={alignHouseGraphOrigin};
