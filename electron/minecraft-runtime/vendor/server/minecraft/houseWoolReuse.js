'use strict';
// Native recipes and real inventory deltas decide what can be reused. No
// synthetic wool credit and no hunting when carried/owned conversion suffices.
async function reuseOwnedWool(target,d){
 d.active();const stock=d.stock(),wanted={};
 const deficit=Math.max(0,target-d.count('white_wool'));
 if(!deficit)return;
 let colors=0;
 for(const [name,n] of Object.entries(stock))if(name.endsWith('_wool')&&name!=='white_wool'&&colors<deficit){
  const amount=Math.min(n,deficit-colors);if(amount>0){wanted[name]=d.count(name)+amount;colors+=amount;}
 }
 if(colors||d.coloredCount()){
  for(const name of ['bone','bone_meal','white_dye'])if(stock[name]>0)wanted[name]=d.count(name)+Math.min(stock[name],name==='bone'?1:deficit);
 }
 if(d.count('string')+(stock.string||0)>=4)wanted.string=Math.min(12,d.count('string')+(stock.string||0));
 if(Object.keys(wanted).length){await d.withdraw(wanted);d.active();}
 for(let i=0;i<12&&d.count('white_wool')<target;i++){
  d.active();let acted=false;
  const names=['white_wool',...(d.coloredCount()&&d.count('white_dye')<deficit?['white_dye']:[]),
    ...(d.coloredCount()&&!d.count('white_dye')&&!d.count('bone_meal')?['bone_meal']:[])];
  for(const item of names){
   const recipe=d.recipe(item);if(!recipe||recipe.requiresTable)continue;
   const before=d.count(item);await d.craft(item,recipe);d.active();
   if(d.count(item)<=before)throw Object.assign(Error('羊毛复用合成未确认实际入账'),{code:'house_materials_no_progress'});
   acted=true;break;
  }
  if(!acted)break;
 }
}
module.exports={reuseOwnedWool};
