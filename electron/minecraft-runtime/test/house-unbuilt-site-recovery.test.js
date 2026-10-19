'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {canReselectUnbuiltHouse}=require('../vendor/server/minecraft/houseUnbuiltSiteRecovery');
test('an occupied unbuilt site may be reselected without authorizing demolition',()=>{
 assert.equal(canReselectUnbuiltHouse({code:'house_site_occupied'},{schema:2,phase:'clear_site'}),true);
 for(const change of [{ownedBlockIds:['floor:1']},{ownedScaffold:[{}]},{phase:'walls'},{schema:1}])
  assert.equal(canReselectUnbuiltHouse({code:'house_site_occupied'},{schema:2,phase:'clear_site',...change}),false);
 for(const code of ['paused','movement_preempted','house_unsafe_site','house_state_mismatch'])
  assert.equal(canReselectUnbuiltHouse({code},{schema:2,phase:'clear_site'}),false);
});
