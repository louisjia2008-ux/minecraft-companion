'use strict';
// Only this captured client's native player-health packet can keep a bounded
// nutrition wait alive. Logs, repeated packets and damage are not progress.
function observeNativeNutritionProgress(client,{initialHealth,initialFood,isOwnerCurrent,onProgress}){
 if(typeof client?.on!=='function'||typeof client?.removeListener!=='function'||typeof isOwnerCurrent!=='function'||typeof onProgress!=='function')throw TypeError('Native nutrition observation requires a captured client and owner');
 let open=true,health=initialHealth,food=initialFood;
 const listener=packet=>{
  if(!open||!isOwnerCurrent())return;
  const nextHealth=packet?.health,nextFood=packet?.food;
  if(!Number.isFinite(nextHealth)||nextHealth<0||!Number.isFinite(nextFood)||nextFood<0||nextFood>20)return;
  const improved=nextHealth>health||nextFood>food;health=nextHealth;food=nextFood;
  if(improved&&open&&isOwnerCurrent())onProgress({health,food,source:'native_update_health'});
 };
 client.on('update_health',listener);
 return()=>{open=false;client.removeListener('update_health',listener);};
}
module.exports={observeNativeNutritionProgress};
