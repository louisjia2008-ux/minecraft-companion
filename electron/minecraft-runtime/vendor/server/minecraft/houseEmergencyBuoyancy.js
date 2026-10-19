'use strict';

// Vertical survival reflex, independent of a foreground task's pause/timeout.
// It never steers, digs, teleports, changes a route or borrows another client.
function createEmergencyBuoyancy(deps) {
  const bot=deps.getBot(),client=bot?._client;
  let ownsJump=false,closed=false;
  return {
    tick() {
      if(closed||deps.getBot()!==bot||bot._client!==client||client?.state!=='play'
        ||!Number.isFinite(bot.health)||bot.health<=0)return;
      // A formal water session owns its own flotation and controlled retreat.
      if(deps.isHandled()){ownsJump=false;return;}
      const p=bot.entity?.position;if(!p)return;
      const eye=p.offset(0,bot.entity.eyeHeight||1.62,0).floored();
      const submerged=bot.blockAt(eye)?.name==='water';
      const wet=bot.entity.isInWater===true||submerged;
      if(submerged||ownsJump&&wet){
        if(!ownsJump)deps.record?.('emergency_buoyancy_started',{position:{x:p.x,y:p.y,z:p.z}});
        ownsJump=true;bot.setControlState('jump',true);
      }else if(ownsJump&&deps.isDryGrounded()){
        ownsJump=false;bot.setControlState('jump',false);
        deps.record?.('emergency_buoyancy_dry',{position:{x:p.x,y:p.y,z:p.z}});
      }
    },
    close(){closed=true;},
  };
}
module.exports={createEmergencyBuoyancy};
