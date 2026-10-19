'use strict';
const {goals}=require('mineflayer-pathfinder');
const {classifyMiningBlock}=require('./miningNavigation');
const {planEmergencyRoof,requiredEmergencyCoverCell}=require('./houseEmergencyShelter');
const {hasGroundedBodySupport,inspectSurfaceBody}=require('./houseSurfaceGraph');
const key=p=>`${p.x},${p.y},${p.z}`,at=(f,p)=>f({x:p.x,y:p.y,z:p.z});
const cube=b=>{const c=classifyMiningBlock(b);return c.loaded&&!c.hazard&&!c.gravity&&!b.getProperties?.().waterlogged&&b.shapes?.some(s=>s.length===6&&s.every((v,i)=>v===(i<3?0:1)));};
const air=b=>b&&['air','cave_air','void_air'].includes(b.name);
const matches=(b,s)=>b&&(b.name===s.item||s.item==='dirt'&&b.name==='grass_block');
const fail=(code,message)=>Object.assign(Error(message),{code});
function planEmergencyRoofAccess({plan,placed,position,threats,blockAt,inventory,excluded=()=>false}){
 const b=plan?.bounds;if(!b||!Array.isArray(placed)||!threats?.length||threats.some(e=>!e?.position||!['x','y','z'].every(k=>Number.isFinite(e.position[k]))))return null;
 const owned=new Map(placed.map(s=>[key(s.position),s])),options=[];
 for(const foot of plan.blocks.filter(s=>s.position.y===b.y)){
  const p=foot.position,dx=p.x===b.loX?-1:p.x===b.hiX?1:0,dz=p.z===b.loZ?-1:p.z===b.hiZ?1:0;
  if(Math.abs(dx)+Math.abs(dz)!==1)continue;
  const head=plan.blocks.find(s=>s.position.x===p.x&&s.position.z===p.z&&s.position.y===b.y+1);if(!head)continue;
  if(threats.some(e=>(e.position.x-position.x)*dx+(e.position.z-position.z)*dz> -Math.hypot(e.position.x-position.x,e.position.z-position.z)*.25))continue;
  if([head,foot].some(s=>excluded(s.position)||!air(at(blockAt,s.position))&&!matches(at(blockAt,s.position),owned.get(key(s.position))||{})))continue;
  for(const tangent of [0,1,-1]){
   const step={x:p.x+dx+dz*tangent,y:b.y,z:p.z+dz-dx*tangent},current=at(blockAt,step),c=classifyMiningBlock(current);
   if(excluded(step)||!cube(at(blockAt,{...step,y:step.y-1}))||!c.loaded||c.hazard||c.gravity||!cube(current)&&!c.passable
     ||[1,2].some(y=>!classifyMiningBlock(at(blockAt,{...step,y:step.y+y})).passable)
     ||Math.abs(step.x+.5-position.x)<.8&&Math.abs(step.z+.5-position.z)<.8)continue;
   const stepReady=cube(current),item=inventory.dirt>0?'dirt':inventory.cobblestone>0?'cobblestone':null;
   if(!stepReady&&!item)continue;
   const sealKeys=new Set([key(foot.position),key(head.position)]),missing=plan.blocks.filter(s=>!sealKeys.has(key(s.position))&&!matches(at(blockAt,s.position),s)).length;
   const roofCount=(b.hiX-b.loX-1)*(b.hiZ-b.loZ-1)+1;
   if(inventory.dirt+inventory.cobblestone<missing+roofCount+2+(stepReady?0:1))continue;
   options.push({seals:[foot,head],step:stepReady?null:{id:`emergency-roof-access:${key(step)}`,position:step,item,properties:{}},stepPosition:step,outward:{x:dx,z:dz},score:threats.reduce((n,e)=>n+(e.position.x-position.x)*dx+(e.position.z-position.z)*dz,0)});
  }
 }
 options.sort((a,b)=>a.score-b.score);return options[0]||null;
}
async function completeEmergencyRoofAccess(deps,{cover,deadline}){
 if(!Number.isFinite(deadline)||!cover?.plan||!Array.isArray(cover.placed)||cover.placed.length>64||!Array.isArray(cover.plan.blocks)||cover.plan.blocks.length>64)throw TypeError('Finite owned emergency roof access required');
 const bot=deps.getBot(),client=bot._client,profile=bot.pathfinder.movements,plan=cover.plan;
 const active=()=>{deps.assertActive();if(deps.getBot()!==bot||bot._client!==client||bot.pathfinder.movements!==profile)throw fail('movement_preempted','临时顶盖施工失去原控制权');if(Date.now()>=deadline)throw fail('house_recovery_cover_timeout','临时顶盖达到原施工时限');};
 const stock=()=>({dirt:deps.count('dirt'),cobblestone:deps.count('cobblestone')});
 const place=async spec=>{active();if(matches(deps.blockAt(spec.position),spec))return;
  if(!deps.count(spec.item)){const item=['dirt','cobblestone'].find(n=>deps.count(n)>0);if(!item)throw fail('house_recovery_cover_materials_missing','临时顶盖缺少实际方块');spec.item=item;}
  await deps.place(spec,()=>{const i=cover.placed.findIndex(s=>key(s.position)===key(spec.position));if(i<0)cover.placed.push({...spec});else cover.placed[i]={...spec};deps.remember(spec);});active();
  if(!matches(deps.blockAt(spec.position),spec))throw fail('house_recovery_cover_unconfirmed','临时顶盖放置未获实际确认');
 };
 active();const roofDone=()=>{const b=plan.bounds;for(let x=b.loX+1;x<b.hiX;x++)for(let z=b.loZ+1;z<b.hiZ;z++)if(!cube(deps.blockAt({x,y:b.y+2,z})))return false;return true;};
 const access=roofDone()?null:planEmergencyRoofAccess({plan,placed:cover.placed,position:bot.entity.position,threats:deps.threats(),blockAt:deps.blockAt,inventory:stock(),excluded:deps.excluded});
 if(!roofDone()&&!access)throw fail('house_recovery_cover_access_unavailable','临时顶盖没有已知安全的外侧垫脚通道');
 const sealKeys=new Set(access?.seals.map(s=>key(s.position))||[]);
 const safeAccess=()=>{active();if(access&&deps.threats().some(e=>(e.position.x-plan.origin.x)*access.outward.x+(e.position.z-plan.origin.z)*access.outward.z> -Math.hypot(e.position.x-plan.origin.x,e.position.z-plan.origin.z)*.25))throw fail('house_recovery_cover_access_changed','临时顶盖背向敌人的通道已改变');};
 if(access){
  cover.roofAccess=access;
  for(const spec of [...access.seals].reverse()){
   safeAccess();const block=deps.blockAt(spec.position);if(air(block))continue;
   if(!cover.placed.some(s=>key(s.position)===key(spec.position)&&matches(block,s))||deps.canRemove(block)!==true)throw fail('house_recovery_cover_access_unavailable','不能打开未知或不属于自己的墙体');
   if([[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(([x,y,z])=>{const c=classifyMiningBlock(deps.blockAt({x:spec.position.x+x,y:spec.position.y+y,z:spec.position.z+z}));return !c.loaded||c.hazard||(y===1&&c.gravity);}))throw fail('house_recovery_cover_access_unavailable','通道相邻方块存在未知、危险或坠落风险');
   await deps.remove(block);active();if(!air(deps.blockAt(spec.position)))throw fail('house_recovery_cover_unconfirmed','通道墙体尚未实际变成空气');
   cover.placed=cover.placed.filter(s=>key(s.position)!==key(spec.position));deps.retire(spec);
  }
  deps.record('house_emergency_roof_access_opened',{seals:access.seals.map(s=>s.position),step:access.stepPosition,protectionConfirmed:false});
 }
 for(const spec of plan.blocks){if(sealKeys.has(key(spec.position))||!requiredEmergencyCoverCell(plan,spec.position)||spec.position.y>plan.bounds.y+1)continue;safeAccess();await place(spec);}
 if(access?.step){safeAccess();await place(access.step);}
 const roof=planEmergencyRoof({plan,blockAt:deps.blockAt,inventory:stock(),excluded:deps.excluded});
 if(!roof)throw fail('house_recovery_cover_access_unavailable','临时顶盖的实际连接支撑未确认');
 for(const p of roof.structure)if(!plan.structure.some(q=>key(q)===key(p)))plan.structure.push(p);
 for(const spec of roof.blocks){safeAccess();if(!plan.blocks.some(s=>s.id===spec.id))plan.blocks.push(spec);await place(spec);}
 if(access){
  const target={x:Math.floor(plan.origin.x),y:plan.bounds.y,z:Math.floor(plan.origin.z)};safeAccess();
  await deps.goto(new goals.GoalBlock(target.x,target.y,target.z),Math.max(1,deadline-Date.now()));active();
  const inside=()=>{const p=bot.entity.position,b=plan.bounds;return hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry&&p.x-.3>=b.loX+1-1e-6&&p.x+.3<=b.hiX+1e-6&&p.z-.3>=b.loZ+1-1e-6&&p.z+.3<=b.hiZ+1e-6&&Math.abs(p.y-b.y)<=.075;};
  const until=Math.min(deadline,Date.now()+1200);while(!inside()&&Date.now()<until){active();await deps.wait(20);}active();
  if(!inside())throw fail('house_recovery_cover_access_unavailable','临时顶盖封口前未实际回到内部');
  for(const spec of access.seals){safeAccess();await place(spec);}
  deps.record('house_emergency_roof_access_sealed',{actual:{...bot.entity.position},roofConfirmed:roofDone(),protectionConfirmed:false});
 }
 active();return roofDone();
}
module.exports={planEmergencyRoofAccess,completeEmergencyRoofAccess};
