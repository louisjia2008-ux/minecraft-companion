'use strict';
// A native planning result is not the material acceptance condition. Recheck
// the same live target under the captured owner; never turn an abort or a
// movement guardian failure into permission to dig.
const nativePlanningFailure=error=>error.code==='house_resource_native_approach_timeout'
  ||['NoPath','Timeout'].includes(error.name)&&(!error.code||error.code===error.name);
function createHouseResourceReach(deps) {
  for(const name of ['getBot','captureActive','avoidsSupport','standingSafely','moveToBlock'])
    if(typeof deps[name]!=='function')throw new TypeError(`Resource reach requires ${name}`);
  return async block=>{
    const bot=deps.getBot(),assertActive=deps.captureActive(bot),client=bot._client,dimension=bot.game?.dimension;
    const position=block.position.clone(),expectedName=block.name,expectedState=block.stateId;
    const parentDeadline=deps.getDeadline?.(),deadline=Math.min(Date.now()+30000,Number.isFinite(parentDeadline)?parentDeadline:Infinity);
    const active=()=>{assertActive();if(Date.now()>=deadline)throw Object.assign(Error('Resource approach reached its original finite deadline'),{code:'house_resource_reach_timeout'});if(deps.getBot()!==bot||bot._client!==client||bot.game?.dimension!==dimension)
      throw Object.assign(new Error('采集连接已改变'),{code:'house_resource_connection_changed'});};
    const fresh=()=>bot.blockAt(position);
    const ready=()=>{active();const b=fresh();return b?.name===expectedName&&b.stateId===expectedState
      &&bot.canDigBlock(b)===true&&deps.avoidsSupport(position,bot.entity.position)===true
      &&require('./houseResourceVisibility').hasHouseResourceSight(bot,b,{assertActive:active,onRecovered:deps.onVisibilityRecovered});};
    let sightCleared=0;
    const clearSight=async()=>{if(typeof deps.clearSight!=='function'||sightCleared>=2)return;
      const remaining=2-sightCleared,cleared=await deps.clearSight(block,{maximumLeaves:remaining});active();
      if(!Number.isSafeInteger(cleared)||cleared<0||cleared>remaining)throw new TypeError('Resource sight clearing must account for its finite leaf budget');
      sightCleared+=cleared;};
    active();
    try {
      if(!ready())await clearSight();
      if(!ready())await deps.moveToBlock(block,{deadline});
      active();
      if(!ready()&&deps.standingSafely(bot.entity.position)===true)await clearSight();
      active();
      if(!ready())throw Object.assign(new Error('天然建材没有安全视线或会挖断脚下支撑'),{code:'house_resource_unsafe_target'});
    } catch(error) {
      active();
      // The original native approach may stop within real dig reach behind
      // leaves. Reobserve there, sharing the same two-leaf total allowance.
      if(nativePlanningFailure(error)&&deps.standingSafely(bot.entity.position)===true){
        const b=fresh();if(b?.name===expectedName&&b.stateId===expectedState&&bot.canDigBlock(b)===true
          &&deps.avoidsSupport(position,bot.entity.position)===true&&!ready())await clearSight();
      }
      active();
      if(nativePlanningFailure(error)&&typeof deps.recoverApproach==='function'){
        for(let attempt=0;attempt<2&&!ready();attempt++){
          active();const current=fresh();if(current?.name!==expectedName||current.stateId!==expectedState
            ||deps.standingSafely(bot.entity.position)!==true)break;
          const progressed=await deps.recoverApproach(current,{deadline:Math.min(deadline,Date.now()+10000)});active();
          if(!progressed)break;
          if(!ready()){
            try{await deps.moveToBlock(block,{deadline});}
            catch(next){active();if(!nativePlanningFailure(next))throw next;}
            active();if(!ready())await clearSight();
          }
        }
      }
      active();
      if(nativePlanningFailure(error)&&ready()
        &&deps.standingSafely(bot.entity.position)===true) {
        active();
        deps.onRecovered?.({nativeError:error.name,target:{x:position.x,y:position.y,z:position.z},
          actualPosition:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},
          sameState:true,actualMovementOrMaterialCredit:false});
        active();return;
      }
      try {
        const b=fresh(),first=b&&require('./houseResourceVisibility').firstLoadedResourceShape(bot,b,{assertActive:active})?.block;
        error.resourceTargetFacts={firstShapeHit:first?{name:first.name,position:{x:first.position.x,y:first.position.y,z:first.position.z},stateId:first.stateId}:null,actualPosition:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},
          target:{x:position.x,y:position.y,z:position.z},expectedName,actualName:b?.name||null,loaded:Boolean(b),
          canDig:b?bot.canDigBlock(b)===true:false,avoidsActualSupport:deps.avoidsSupport(position,bot.entity.position),
          visible:b&&typeof bot.canSeeBlock==='function'?bot.canSeeBlock(b)===true:null};
      } catch(diagnosticError) {active();error.resourceTargetFacts={unavailable:true,code:diagnosticError.code||null};}
      throw error;
    }
  };
}
module.exports={createHouseResourceReach};
