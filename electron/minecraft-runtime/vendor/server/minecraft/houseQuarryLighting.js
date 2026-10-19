'use strict';
const {Vec3}=require('vec3');
const {classifyMiningBlock}=require('./miningNavigation');
const fail=(code,message)=>Object.assign(Error(message),{code});
// Use a floor on the route already walked, without a separate navigation goal.
// The live block confirmation, rather than an attempted placement, is saved.
async function lightHouseQuarry(deps,navigation,previous=[]) {
  deps.assertActive();const bot=deps.getBot(),at=p=>bot.blockAt(new Vec3(p.x,p.y,p.z));
  const confirmed=previous.filter(p=>at(p)?.name==='torch');
  // Adjacent fishbone branches share actual server light even when their
  // torch is absent from this branch's breadcrumb suffix. Unknown light
  // retains the existing placement path; daylight never substitutes for it.
  const feet=bot.entity.position.floored();
  const light=[at(feet),at(feet.offset(0,1,0))].map(b=>b?.light);
  if(light.every(n=>Number.isInteger(n)&&n>=8&&n<=15))return confirmed;
  const route=navigation.breadcrumbs.slice(0,navigation.routeIndex+1);
  const recent=route.slice(-6);
  if(recent.some(p=>at(p)?.name==='torch'))return confirmed;
  if(route.length<2)return confirmed;
  const eye=bot.entity.position.offset(0,1.62,0);
  const target=route.slice(0,-1).reverse().slice(0,4).find(p=>{
    const b=at(p),floor=at({...p,y:p.y-1});
    return ['air','cave_air'].includes(b?.name)&&classifyMiningBlock(floor).support
      &&!deps.isExcluded(p)&&eye.distanceTo(new Vec3(p.x+.5,p.y,p.z+.5))<=4.5
      &&bot.entity.position.distanceTo(new Vec3(p.x+.5,p.y,p.z+.5))>=1.1;
  });
  if(!target)return confirmed;
  if(!bot.inventory.items().some(i=>i.name==='torch'&&i.count>0))throw fail('house_quarry_torches_required','矿道火把已用尽，先沿已知矿道补充照明');
  deps.assertActive();await deps.place(target);deps.assertActive();
  if(at(target)?.name!=='torch')throw fail('house_quarry_torch_unconfirmed','矿道火把尚未确认实际放置');
  return [...confirmed,{...target}].slice(-512);
}
function quarryLightingBatch(torches,fuel){
 if(![torches,fuel].every(n=>Number.isSafeInteger(n)&&n>=0))throw TypeError('Actual nonnegative inventory counts required');
 const target=32,batches=Math.ceil(Math.max(0,target-torches)/4),missingFuel=Math.max(0,batches-fuel);
 return {target,batches,missingFuel,sticks:batches,smeltingPlanks:Math.max(3,Math.ceil(missingFuel/1.5))};
}
async function craftQuarryLighting(deps){
 deps.assertActive();const actual=deps.count();
 if(!Number.isSafeInteger(actual)||actual<0)throw TypeError('Actual torch count required');
 const missing=Math.max(0,32-actual);
 if(missing)await deps.craft(missing);
 deps.assertActive();
 if(deps.count()<32)throw fail('house_quarry_torches_required','矿道照明批量补给未实际入包');
}
module.exports={lightHouseQuarry,quarryLightingBatch,craftQuarryLighting};
