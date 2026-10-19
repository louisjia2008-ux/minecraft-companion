'use strict';
// Historical stock is a reason to visit an owned workshop, never inventory
// credit. The caller must physically arrive and reopen/reconcile its chest.
function ownsNeededGlass(prior,requirements,count){
 const missing=Math.max(0,Number(requirements?.glass||0)-count('glass'));
 if(!missing||!prior?.ownedStations?.crafting_table||!prior.ownedStations.furnace)return false;
 return (prior.storage?.chests||[]).filter(c=>c.confirmedPlaced&&c.emptyAuthorized===true
  &&!c.pendingTransfer&&!c.pendingClosedInventory).reduce((n,c)=>n+Number(c.stock?.glass||0),0)>=missing;
}
function ownsUsefulWoolStock(prior,count){
 const stock={};
 for(const c of prior?.storage?.chests||[])if(c.confirmedPlaced&&c.emptyAuthorized===true&&!c.pendingTransfer&&!c.pendingClosedInventory)
  for(const[n,k]of Object.entries(c.stock||{}))stock[n]=(stock[n]||0)+k;
 return (stock.white_wool||0)>0||((stock.bone||0)+(stock.bone_meal||0)+(stock.white_dye||0)>0
  &&['black','light_gray','gray','brown','pink','red','blue','green','yellow','orange','purple','cyan','light_blue','lime','magenta'].some(c=>count(`${c}_wool`)>0));
}
function latestOwnedCampArchives(state){
 const seen=new Set(state.storage?.storageId?[state.storage.storageId]:[]),result=[];
 for(const prior of [...(state.retiredCamps||[])].reverse()){
  const id=prior.storage?.storageId||JSON.stringify(prior.camp?.anchor);
  if(seen.has(id))continue;seen.add(id);result.push(prior);
 }
 return result;
}
function ownsGlassInputs(prior,requirements,count){
 const missing=Math.max(0,Number(requirements?.glass||0)-count('glass'));if(!missing)return false;
 const stock={};for(const c of prior.storage?.chests||[])if(c.confirmedPlaced&&c.emptyAuthorized===true&&!c.pendingTransfer&&!c.pendingClosedInventory)
  for(const[k,n]of Object.entries(c.stock||{}))stock[k]=(stock[k]||0)+n;
 return (stock.sand||0)>=missing&&((stock.coal||0)+(stock.charcoal||0)+count('coal')+count('charcoal'))>0;
}
function hasOwnedBootstrapWoodHint(state,blockAt){
 const table=state?.ownedStations?.crafting_table;
 if(state?.materialSource!=='self_gathered'||!table?.confirmedPlaced||!table.position)return false;
 const observedTable=blockAt(table.position);if(observedTable&&observedTable.name!=='crafting_table')return false;
 let planks=0;
 for(const chest of state.storage?.chests||[]){
  if(!chest.confirmedPlaced||chest.emptyAuthorized!==true||chest.pendingTransfer||chest.pendingClosedInventory
    ||!chest.position)continue;
  const observedChest=blockAt(chest.position);if(observedChest&&observedChest.name!=='chest')continue;
  for(const [name,count]of Object.entries(chest.usableStock||chest.stock||{}))
   if(Number.isSafeInteger(count)&&count>0)planks+=name.endsWith('_log')?count*4:name.endsWith('_planks')?count:0;
 }
 return planks>=12;
}
module.exports={ownsNeededGlass,ownsUsefulWoolStock,latestOwnedCampArchives,ownsGlassInputs,hasOwnedBootstrapWoodHint};
