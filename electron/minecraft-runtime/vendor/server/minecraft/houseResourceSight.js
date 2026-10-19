'use strict';
// Clear only the first loaded leaf on the actual eye-to-target ray. This is
// not permission to dig a route, support, wall, or the requested resource.
async function clearHouseResourceSight(deps,target,{maximumLeaves=2}={}){
 if(!Number.isSafeInteger(maximumLeaves)||maximumLeaves<1||maximumLeaves>2)throw new TypeError("Resource sight leaf allowance must be1..2");
 const bot=deps.getBot(),client=bot._client,dimension=bot.game?.dimension;
 const {hasHouseResourceSight,firstLoadedResourceShape}=require('./houseResourceVisibility');
 const active=()=>{deps.assertActive();if(deps.getBot()!==bot||bot._client!==client||bot.game?.dimension!==dimension)
  throw Object.assign(Error('Resource sight actor changed'),{code:'house_resource_connection_changed'});};
 let cleared=0;
 for(let i=0;i<maximumLeaves;i++){
  active();const fresh=bot.blockAt(target.position);
  if(fresh?.name!==target.name||fresh.stateId!==target.stateId||hasHouseResourceSight(bot,fresh,{assertActive:active})
    ||bot.canDigBlock(fresh)!==true||!deps.standingSafely())break;
  const leaf=firstLoadedResourceShape(bot,fresh,{assertActive:active})?.block;active();
  if(!leaf?.name?.endsWith('_leaves')||bot.canDigBlock(leaf)!==true||!deps.canClear(leaf))break;
  const before=leaf.stateId;await deps.dig(leaf);active();
  if(bot.blockAt(leaf.position)?.stateId===before)break;
  cleared++;
 }
 return cleared;
}
module.exports={clearHouseResourceSight};
