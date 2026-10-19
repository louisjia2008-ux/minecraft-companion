'use strict';
function canReselectUnbuiltHouse(error,checkpoint){
 return error?.code==='house_site_occupied'&&checkpoint?.schema===2&&checkpoint.phase==='clear_site'
  &&!(checkpoint.ownedBlockIds||[]).length&&!(checkpoint.ownedScaffold||[]).length;
}
module.exports={canReselectUnbuiltHouse};
