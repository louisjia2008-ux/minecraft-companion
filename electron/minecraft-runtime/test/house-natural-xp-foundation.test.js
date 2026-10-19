/* global require, __dirname, setTimeout */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {fixture,Vec3,Block,registry}=require('./fixtures/house-natural-xp-native');
const poolFixture=require('./fixtures/house-natural-xp-pool');
const {inspectRecordedNaturalXPFoundation}=require('../vendor/server/minecraft/houseNaturalXPSupport');
const {createRenewableCactusProvider,planLoadedCactusSites}=require('../vendor/server/minecraft/houseRenewableCactusProvider');
const filename=path.join(__dirname,'house-natural-xp-host.test.js'),original=fs.readFileSync(filename,'utf8'),loaded=new Module(filename,module);
loaded.filename=filename;loaded.paths=Module._nodeModulePaths(__dirname);loaded._compile(original.slice(0,original.indexOf('\ntest('))+'\nmodule.exports={furnaceFixture,bind};\n',filename);
const {furnaceFixture,bind}=loaded.exports,key=p=>`${p.x},${p.y},${p.z}`,block=(name,p)=>Object.assign(Block.fromProperties(registry.blocksByName[name].id,{},0),{position:new Vec3(p.x,p.y,p.z)});
function recorded(origin,names){const cells=new Map(),foundation=names.map((name,n)=>{const position={...origin,y:origin.y-n},b=block(name,position);cells.set(key(position),b);return{position,name,stateId:b.stateId};});return{support:foundation[0],foundation,cells};}
function proof(f,assertActive=()=>{}){return inspectRecordedNaturalXPFoundation({...f,blockAt:p=>f.cells.get(key(p))||null,assertActive});}
for(const origin of [{x:0,y:63,z:0},{x:-91,y:-61,z:204},{x:732,y:119,z:-407}])for(const gravity of ['sand','red_sand','gravel'])for(const base of ['stone','deepslate','grass_block'])test(`recorded complete ${gravity}/${base} support remains valid at ${key(origin)} without changing facts`,()=>{
 const f=recorded(origin,[gravity,gravity,base]),before=JSON.stringify(f.foundation);assert.equal(proof(f).safe,true);assert.equal(JSON.stringify(f.foundation),before);
});
for(const kind of ['removed','changed','unloaded','partial','hazard','unsupported_base','noncontinuous','missing_base','too_long'])test(`recorded XP geometry refuses ${kind} without replacing remembered support`,()=>{
 const f=recorded({x:17,y:78,z:-22},['sand','gravel','stone']),last=f.foundation.at(-1),before=JSON.stringify(f.foundation);
 if(kind==='removed')f.cells.set(key(last.position),block('air',last.position));
 if(kind==='changed')f.cells.set(key(last.position),block('andesite',last.position));
 if(kind==='unloaded')f.cells.delete(key(last.position));
 if(kind==='partial')f.cells.get(key(last.position)).shapes=[[0,0,0,1,.5,1]];
 if(kind==='hazard')f.cells.get(key(last.position)).getProperties=()=>({waterlogged:true});
 if(kind==='unsupported_base'){const b=block('gravel',last.position);f.cells.set(key(last.position),b);last.name=b.name;last.stateId=b.stateId;}
 if(kind==='noncontinuous')last.position.y--;
 if(kind==='missing_base')f.foundation.pop();
 if(kind==='too_long')f.foundation=Array.from({length:17},(_,n)=>({...last,position:{...f.support.position,y:f.support.position.y-n}}));
 const planned=JSON.stringify(f.foundation),result=proof(f);assert.equal(result.safe,false);assert.equal(JSON.stringify(f.foundation),planned);assert.ok(before.length>0);
});
for(const kind of ['foreign','cancel'])test(`owner ${kind} during a foundation read propagates its original cause before geometry admission`,()=>{
 const f=recorded({x:-1,y:-2,z:3},['sand','stone']),stop=Object.assign(new Error(kind),{code:kind==='foreign'?'movement_preempted':'paused'});let active=true,reads=0;
 assert.throws(()=>inspectRecordedNaturalXPFoundation({...f,blockAt:p=>{reads++;active=false;return f.cells.get(key(p));},assertActive:()=>{if(!active)throw stop;}}),e=>e===stop);assert.equal(reads,1);
});
test('the original sixteen-cell planner bound admits fifteen actual gravity layers and a stable base',()=>{
 assert.equal(proof(recorded({x:51,y:-30,z:28},[...Array(15).fill('sand'),'stone'])).safe,true);
});
function mutate(f,entry,kind){const p=entry.foundation.at(-1).position;if(kind==='removed')f.put(p,'air');else if(kind==='changed')f.put(p,'andesite');else if(kind==='unloaded'){const prior=f.bot.blockAt;f.bot.blockAt=q=>key(q)===key(p)?null:prior(q);}else f.state[kind==='foreign'?'foreign':'cancelled']=true;}
for(const timing of ['supply','deferred_native'])for(const kind of ['removed','changed','unloaded','foreign','cancel'])test(`original native XP furnace blocks ${kind} foundation/owner at ${timing} with zero placement and authority`,{timeout:4000},async t=>{
 const f=furnaceFixture(t,{lookDelay:timing==='deferred_native'?40:0}),sourceEnsure=f.source.ensure;let changed=false;
 if(timing==='supply')f.source.ensure=async needs=>{await sourceEnsure(needs);if(!changed){changed=true;mutate(f,f.getCP().stations[0],kind);}};
 const extra=timing==='deferred_native'?{placeNative:async(...args)=>{const timer=setTimeout(()=>mutate(f,f.getCP().stations[0],kind),5);t.after(()=>clearTimeout(timer));return f.nativePlace(...args);}}:{};
 const api=f.api(extra);await assert.rejects(f.run(()=>api.ensureOwnedFurnaces()),e=>['house_xp_foundation_pending','house_xp_owner_changed','cancelled'].includes(e.code));
 await new Promise(r=>setTimeout(r,70));assert.equal(f.writes.filter(w=>w.name==='block_place').length,0);assert.equal(f.facts.length,0);assert.equal(f.getCP().stations.some(s=>s.confirmedOwned),false);
});
function cactusFixture(t,kind,timing){
 const f=fixture(t,{item:'cactus',count:1,spare:0,lookDelay:timing==='deferred_native'?40:0}),anchor={x:-4,y:64,z:0},wanted={x:0,y:64,z:1};let cp=null;
 const plan=planLoadedCactusSites(f.bot,{anchor,targetColumns:1,isProtectedPosition:p=>p.x!==wanted.x||p.z!==wanted.z});assert.equal(plan.sites.length,1);const site=plan.sites[0],facts=[];
 const deps={ownerId:'OFFLINE-actual-native-geometry',getBot:()=>f.state.foreign?{}:f.bot,assertActive:f.deps.assertActive,isOwnerContext:f.deps.isOwnerContext,getCP:()=>cp,saveCP:v=>{cp=JSON.parse(JSON.stringify(v));},ensureFood:async()=>{},returnCamp:async()=>{},
  reachDry:async()=>{if(timing==='reach')mutate(f,site,kind);},placeNative:async(...args)=>{if(timing==='deferred_native'){const timer=setTimeout(()=>mutate(f,site,kind),5);t.after(()=>clearTimeout(timer));}return f.nativePlace(...args);},
  digNative:()=>assert.fail('no dig'),collectDrops:()=>assert.fail('no grant'),onOperationAbort:()=>{},recordConfirmedFact:v=>facts.push(v)};
 const provider=createRenewableCactusProvider(deps,{actionMs:1000,readbackMs:100,pollMs:25});return{f,provider,anchor,plan,site,facts,getCP:()=>cp};
}
for(const timing of ['reach','deferred_native'])for(const kind of ['removed','changed','unloaded','foreign','cancel'])test(`actual planned native cactus blocks ${kind} at ${timing} before planting or credit`,{timeout:4000},async t=>{
 const {f,provider,anchor,plan,facts,getCP}=cactusFixture(t,kind,timing);
 await assert.rejects(f.contexts.run(f.owner,()=>provider.provision({anchor,plan,targetColumns:1})),e=>['cactus_foundation_pending','cactus_owner_changed','cancelled'].includes(e.code));
 await new Promise(r=>setTimeout(r,70));assert.equal(f.writes.filter(w=>w.name==='block_place').length,0);assert.equal(facts.length,0);assert.equal(getCP().columns.length,0);
});
test('fresh actual planned sand foundation permits one installed cactus placement and debit ACK, while an unwalked camp stays unconfirmed',{timeout:4000},async t=>{
 const {f,provider,anchor,plan,facts,getCP}=cactusFixture(t,null,'unchanged');
 // This protocol fixture has no native Physics/camp walking adapter. Preserve
 // that admission boundary rather than teleporting its actor to claim return.
 await assert.rejects(f.contexts.run(f.owner,()=>provider.provision({anchor,plan,targetColumns:1})),e=>e.code==='cactus_camp_unconfirmed');
 assert.equal(f.writes.filter(w=>w.name==='block_place').length,1);assert.equal(facts.length,1);assert.equal(getCP().columns[0].confirmedOwned,true);assert.equal(f.bot.inventory.items().some(i=>i.name==='cactus'),false);
 const before=f.writes.length;mutate(f,getCP().columns[0],'unloaded');
 await assert.rejects(f.contexts.run(f.owner,()=>provider.gather(1,{anchor})),e=>e.code==='cactus_foundation_pending');assert.equal(f.writes.length,before);
});
for(const kind of ['changed_lower_base','missing_record'])test(`an already owned furnace with ${kind} cannot be reauthorized or opened`,{timeout:8000},async t=>{
 const f=furnaceFixture(t),api=f.api();await f.run(()=>api.ensureOwnedFurnaces());const before=f.writes.length;
 if(kind==='changed_lower_base')mutate(f,f.getCP().stations[0],'removed');else delete f.getCP().stations[0].foundation;
 await assert.rejects(f.run(()=>api.ensureOwnedFurnaces()),e=>e.code==='house_xp_foundation_pending');assert.equal(f.writes.length,before);
});

// Original installed furnace/inventory/experience plugins and explicit server
// ACKs; restored ownership and stable sand/stone geometry are modeled inputs.
function restoredPool(t){
 const f=poolFixture.fixture(t,{initialPoints:1387}),previous=f.bot.blockAt;
 f.bot.blockAt=p=>p.y<63?block('stone',p.floored()):previous(p);
 const stations=f.stations.map(s=>{const position=new Vec3(s.position.x,s.position.y-1,s.position.z),foundation=[position,position.offset(0,-1,0)].map(p=>{const actual=f.bot.blockAt(p);return{position:{x:p.x,y:p.y,z:p.z},name:actual.name,stateId:actual.stateId};});return{position:s.position,purpose:'xp',confirmedOwned:true,debitConfirmed:true,emptyAuthorized:true,support:foundation[0],foundation};});
 const b=bind(f,{anchor:poolFixture.anchor,cp:{schema:1,kind:'natural_house_xp_host',taskId:'original-natural-XP',anchor:poolFixture.anchor,stations,seedHarvests:[],pool:null,renewable:null,enchant:null}});b.source.ensure=async()=>{};
 return{f,b,stations,api:b.api({},{totalMs:100000,actionMs:5000,readbackMs:1000})};
}
for(const kind of ['changed','unloaded','foreign','cancel','foreign_window'])test(`captured original native XP window refuses ${kind} after its fresh open/snapshot before the first click`,async t=>{
 const {f,b,stations,api}=restoredPool(t),emit=f.client.emit,base=stations[0].foundation.at(-1).position,writer=f.client.write,listeners=f.bot.listenerCount('windowOpen');let mutated=false,foreign;
 f.client.emit=function(name,packet,...rest){const result=emit.call(this,name,packet,...rest);if(!mutated&&name==='window_items'&&packet.windowId===f.stations[0].id){mutated=true;
  if(kind==='changed'||kind==='unloaded'){const previous=f.bot.blockAt;f.bot.blockAt=p=>key(p)===key(base)?kind==='unloaded'?null:block('andesite',p):previous(p);}
  if(kind==='foreign')f.state.foreign=true;if(kind==='cancel')f.state.paused=true;
  if(kind==='foreign_window'){
    const originalWindow=f.bot.currentWindow;
    emit.call(this,'open_window',{windowId:originalWindow.id,inventoryType:'minecraft:furnace',windowTitle:'Foreign native same-id fixture',slotCount:3});
    foreign=f.bot.currentWindow;assert.notEqual(foreign,originalWindow,'installed inventory creates a separate native window object');
  }
 }return result;};
 const expected={changed:'house_xp_foundation_pending',unloaded:'house_xp_foundation_pending',foreign:'movement_preempted',cancel:'paused',foreign_window:'house_xp_furnace_snapshot_unconfirmed'};
 await assert.rejects(f.settle(b.run(()=>api.ensureLevels(30)),100000),e=>e.code===expected[kind]);
 assert.equal(mutated,true);assert.equal(f.state.writes.filter(w=>w.name==='window_click').length,0);assert.equal(b.getCP().pool.batches.length,0);assert.equal(f.bot.experience.level,29);
 if(foreign)assert.equal(f.bot.currentWindow,foreign,'old cleanup never replaces or closes a foreign window');
 const sent=f.state.writes.length;await f.advance(100);assert.equal(f.state.writes.length,sent,'old native chain cannot emit a late packet');assert.equal(f.client.write,writer);assert.equal(f.bot.listenerCount('windowOpen'),listeners);
});
test('unknown lower foundation cannot block the original current-owner window close or introduce a click',async t=>{
 const {f,b,stations,api}=restoredPool(t),emit=f.client.emit,base=stations[0].foundation.at(-1).position;let closed=false;
 f.client.emit=function(name,packet,...rest){const result=emit.call(this,name,packet,...rest);if(!closed&&name==='window_items'&&packet.windowId===f.stations[0].id){closed=true;const previous=f.bot.blockAt;f.bot.blockAt=p=>key(p)===key(base)?null:previous(p);f.bot.currentWindow.close();}return result;};
 await assert.rejects(f.settle(b.run(()=>api.ensureLevels(30)),100000));
 // The original pool finally also closes its captured window. Both the native
 // explicit close and unchanged safe cleanup remain allowed; neither clicks.
 const closes=f.state.writes.filter(w=>w.name==='close_window');
 assert.equal(closed,true);assert.equal(f.state.writes.filter(w=>w.name==='window_click').length,0);assert.equal(closes.length,2);assert.ok(closes.every(w=>w.data.windowId===f.stations[0].id));assert.equal(b.getCP().pool.batches.length,0);
});
test('a raw planting ACK after its lower foundation unloads preserves the one real packet/debit and pending intent without owned credit',{timeout:4000},async t=>{
 const f=fixture(t,{item:'cactus',count:1,spare:0,noRawWorld:true}),anchor={x:-4,y:64,z:0},wanted={x:0,y:64,z:1},facts=[];let cp=null;
 const plan=planLoadedCactusSites(f.bot,{anchor,targetColumns:1,isProtectedPosition:p=>p.x!==wanted.x||p.z!==wanted.z}),site=plan.sites[0],base=site.foundation.at(-1).position;
 const previous=f.client.write;f.client.write=function(name,packet,...rest){const result=previous.call(this,name,packet,...rest);if(name==='block_place'){
  const mutation=setTimeout(()=>{const read=f.bot.blockAt;f.bot.blockAt=p=>key(p)===key(base)?null:read(p);},65);
  const ack=setTimeout(()=>f.client.emit('block_change',{location:site.position,type:f.bot.blockAt(new Vec3(site.position.x,site.position.y,site.position.z)).stateId}),90);t.after(()=>{clearTimeout(mutation);clearTimeout(ack);});
 }return result;};
 const provider=createRenewableCactusProvider({ownerId:'OFFLINE-post-native-ACK',getBot:()=>f.bot,assertActive:f.deps.assertActive,isOwnerContext:f.deps.isOwnerContext,getCP:()=>cp,saveCP:v=>{cp=JSON.parse(JSON.stringify(v));},ensureFood:async()=>{},returnCamp:async()=>{},reachDry:async()=>{},placeNative:f.nativePlace,digNative:()=>assert.fail('no dig'),collectDrops:()=>assert.fail('no grant'),onOperationAbort:()=>{},recordConfirmedFact:v=>facts.push(v)},{actionMs:1000,readbackMs:250,pollMs:25});
 await assert.rejects(f.contexts.run(f.owner,()=>provider.provision({anchor,plan,targetColumns:1})),e=>e.code==='cactus_foundation_pending');
 assert.equal(f.writes.filter(w=>w.name==='block_place').length,1);assert.equal(f.bot.inventory.items().some(i=>i.name==='cactus'),false);assert.equal(facts.length,0);assert.equal(cp.columns.length,0);assert.equal(cp.pending.kind,'plant');
});
