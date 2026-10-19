'use strict';
const {FOOD_ITEM_PRIORITY}=require('./taskCatalog');
// Account for whole edible items, not fractional food points: eating one
// chicken to restore two hunger points consumes all six potential points.
function immediateMealCost({health,food,items,points}){
 if(!Number.isFinite(health)||health<=0||!Number.isFinite(food)||food<0||food>20)return Infinity;
 let need=food<=18||health<20&&food<20?20-food:0,cost=0;
 for(const name of FOOD_ITEM_PRIORITY){
  if(need<=0)break;const value=points(name),count=items.filter(i=>i.name===name).reduce((n,i)=>n+Math.max(0,Math.floor(i.count||0)),0);
  if(!Number.isFinite(value)||value<=0||!count)continue;
  const used=Math.min(count,Math.ceil(need/value));cost+=used*value;need-=used*value;
 }
 return cost+Math.max(0,need);
}
module.exports={immediateMealCost};
