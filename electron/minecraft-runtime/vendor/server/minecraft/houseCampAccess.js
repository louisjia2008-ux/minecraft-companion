'use strict';
const key=p=>`${p.x},${p.y},${p.z}`;
const air=b=>b&&['air','cave_air','void_air'].includes(b.name);
const support=b=>b&&b.boundingBox==='block'&&!['sand','red_sand','gravel','suspicious_sand','suspicious_gravel','magma_block','slime_block','honey_block','ice','packed_ice','blue_ice'].includes(b.name)
 &&!/_leaves$|_concrete_powder$/.test(b.name)
 &&![true,'true'].includes(b.getProperties?.().waterlogged)&&b.shapes?.some(s=>s[0]===0&&s[2]===0&&s[3]===1&&s[4]===1&&s[5]===1);
const fail=(code,message)=>Object.assign(Error(message),{code});
function planHouseCampAccess({from,goal,blockAt,protectedBody=()=>false,maxSteps=10,maxBlocks=16}){
 if(![from,goal].every(p=>p&&['x','y','z'].every(k=>Number.isSafeInteger(p[k])))||goal.y<from.y||goal.y-from.y>6
  ||Math.hypot(from.x-goal.x,from.z-goal.z)>8)return null;
 if(!support(blockAt({...from,y:from.y-1})))return null;
 const queue=[{at:{...from},steps:[],blocks:[],placed:new Set()}],seen=new Set();let reads=0;
 const read=p=>{if(++reads>16000)throw fail('house_camp_access_read_limit','营地入口规划达到读取上限');return blockAt(p);};
 while(queue.length&&seen.size<512){
  queue.sort((a,b)=>a.steps.length+Math.abs(a.at.x-goal.x)+Math.abs(a.at.z-goal.z)+Math.abs(a.at.y-goal.y)
   -(b.steps.length+Math.abs(b.at.x-goal.x)+Math.abs(b.at.z-goal.z)+Math.abs(b.at.y-goal.y))||a.blocks.length-b.blocks.length);
  const current=queue.shift();if(key(current.at)===key(goal))return{from:{...from},goal:{...goal},steps:current.steps,blocks:current.blocks};
  if(seen.has(key(current.at))||current.steps.length>=maxSteps)continue;seen.add(key(current.at));
  for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]])for(const dy of [1,0]){
   const next={x:current.at.x+dx,y:current.at.y+dy,z:current.at.z+dz};
   if(next.y>goal.y||Math.hypot(next.x-goal.x,next.z-goal.z)>8||seen.has(key(next)))continue;
   const occupied=p=>current.placed.has(key(p))||!air(read(p));
   if(occupied(next)||occupied({...next,y:next.y+1}))continue;
   const floor={...next,y:next.y-1},floorBlock=read(floor),add=[];
   const solid=p=>current.placed.has(key(p))||support(read(p));
   if(!solid(floor)){
    if(!air(floorBlock)||protectedBody(floor))continue;
    if(dy===1){const base={...floor,y:floor.y-1};
     if(!solid(base)){if(!air(read(base))||protectedBody(base))continue;add.push(base);}
    }
    add.push(floor);
   }
   if(current.blocks.length+add.length>maxBlocks)continue;
   queue.push({at:next,steps:[...current.steps,{from:current.at,to:next,place:add}],blocks:[...current.blocks,...add],
    placed:new Set([...current.placed,...add.map(key)])});
  }
 }
 return null;
}
async function repairHouseCampAccess(deps){
 deps.assertActive();let plan=deps.plan();if(!plan)return{repaired:false,reason:'no_bounded_plan'};
 if(!plan.blocks.length)return{repaired:false,reason:'no_material_repair_needed'};
 const deadline=Date.now()+90000,active=()=>{deps.assertActive();if(Date.now()>=deadline)throw fail('house_camp_access_timeout','营地入口修复达到90秒上限');};
 const materialBudget=plan.blocks.length;await deps.acquire(materialBudget);active();
 plan=deps.plan();if(!plan||plan.blocks.length>materialBudget)throw fail('house_camp_access_origin_changed','取料后入口计划已改变，保留实际材料重新规划');
 let placed=0;
 for(const step of plan.steps){
  active();if(!deps.at(step.from))throw fail('house_camp_access_origin_changed','营地入口修复的实际站位已改变');
  for(const p of step.place){
   active();if(support(deps.blockAt(p)))continue;
   if(!air(deps.blockAt(p)))throw fail('house_camp_access_changed','营地入口修复格已改变');
   await deps.place(p);active();if(!support(deps.blockAt(p)))throw fail('house_camp_access_unconfirmed','入口方块未获实际确认');placed++;
  }
  await deps.move(step.from,step.to);active();if(!deps.at(step.to))throw fail('house_camp_access_arrival_unconfirmed','台阶未实际落地');
 }
 return{repaired:true,placed,steps:plan.steps.length};
}
module.exports={planHouseCampAccess,repairHouseCampAccess};
