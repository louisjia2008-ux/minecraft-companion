'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {inspectNaturalHouseSite,inspectCreatableHouseSite,planHouseSiteFoundation}=require('../vendor/server/minecraft/naturalHouseSites');
const {createFurnishedHouseBuilder}=require('../vendor/server/minecraft/furnishedHouseBuilder'),{createFurnishedHouseBlueprint}=require('../vendor/server/minecraft/furnishedHouseBlueprints');
const anchor={x:13,y:64,z:-27},key=p=>`${p.x},${p.y},${p.z}`;
// Actual native Block shapes; dig/place acknowledgements here are explicitly
// modeled dependency replies, not live harvesting or real-server acceptance.
function fixture(mode){const edits=new Map(),writes=[],receipts=[];let cp={},active=true,requests=[],cobbleAvailable=0;
 const put=(p,name)=>edits.set(key(p),name);
 const blockAt=p=>{const name=edits.has(key(p))?edits.get(key(p)):p.y<64?'dirt':'air';return name===null?null:Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:new Vec3(p.x,p.y,p.z)});};
 const cut={x:anchor.x+2,y:64,z:anchor.z+2},upper={...cut,y:65},hole={x:anchor.x+4,y:63,z:anchor.z+4};
 put(cut,'dirt');put(upper,'grass_block');put(hole,'air');
 const deps={getBot:()=>({blockAt}),assertActive:()=>{if(!active)throw Object.assign(Error('paused'),{code:'paused'});},getCheckpoint:()=>cp,setCheckpoint:v=>{cp=v;},report:()=>{},
 getItemCount:name=>mode==='recordMaterials'&&name==='cobblestone'?cobbleAvailable:10000,getBlueprint:createFurnishedHouseBlueprint,chooseAnchor:()=>{const p=inspectCreatableHouseSite({anchor,blockAt});if(!p.valid)throw Object.assign(Error(p.reason),{code:'house_no_safe_site'});return anchor;},
 planSitePreparation:inspectCreatableHouseSite,planFoundation:planHouseSiteFoundation,onSitePrepared:r=>receipts.push(r),prepareMaterials:async items=>{requests.push(items);cobbleAvailable=items.cobblestone||0;},moveTo:async()=>{},
 breakBlock:async p=>{writes.push({kind:'dig',p:{...p}});if(mode!=='missingDigAck')put(p,'air');if(mode==='pauseAfterDig')active=false;},
 placeBlock:async spec=>{writes.push({kind:'place',p:{...spec.position},item:spec.item});if(mode!=='missingPlaceAck')put(spec.position,spec.item);if(mode==='pauseAfterPlace')active=false;}};
 return {edits,writes,receipts,deps,blockAt,put,cut,upper,hole,builder:createFurnishedHouseBuilder(deps),cp:()=>cp,resume:()=>{active=true;},requests:()=>requests};}
test('a bounded soil terrace and supported one-cell pit are a plan, not prepared ground',()=>{const f=fixture();assert.equal(inspectNaturalHouseSite({anchor,blockAt:f.blockAt}).valid,false);const p=inspectCreatableHouseSite({anchor,blockAt:f.blockAt});assert.equal(p.valid,true);assert.equal(p.terrainPreparation.actualPrepared,false);assert.equal(p.terrainPreparation.excavation.length,2);assert.deepEqual(p.foundation,[f.hole]);assert.equal(f.writes.length,0);});
test('builder physically clears top-down and fills the actual supported hole before preparation confirmation',async()=>{const f=fixture();await f.builder.run({phase:'clear_site'});assert.deepEqual(f.writes,[{kind:'dig',p:f.upper},{kind:'dig',p:f.cut},{kind:'place',p:f.hole,item:'cobblestone'}]);assert.equal(f.blockAt(f.cut).name,'air');assert.equal(f.blockAt(f.hole).name,'cobblestone');assert.equal(f.cp().sitePreparation.actualPrepared,true);assert.equal(f.receipts.length,1);assert.equal(f.receipts[0].houseAccepted,false);});
for(const [mode,code]of [['missingDigAck','house_site_preparation_unconfirmed'],['missingPlaceAck','house_state_mismatch'],['pauseAfterDig','paused']])test(`no prepared receipt after ${mode}`,async()=>{const f=fixture(mode);await assert.rejects(f.builder.run({phase:'clear_site'}),{code});assert.equal(f.receipts.length,0);assert.notEqual(f.cp().sitePreparation?.actualPrepared,true);});
for(const mode of ['deepPit','water','lava','unknown','container','gravityCut','thirdCutLayer','gravityAbove'])test(`creating a site rejects ${mode} without edits`,()=>{const f=fixture();if(mode==='deepPit')for(const y of [62,61,60])f.put({...f.hole,y},'air');else if(mode==='thirdCutLayer')f.put({...f.cut,y:66},'dirt');else if(mode==='gravityAbove')f.put({...f.cut,y:72},'sand');else f.put(f.cut,{water:'water',lava:'lava',unknown:null,container:'chest',gravityCut:'gravel'}[mode]);assert.equal(inspectCreatableHouseSite({anchor,blockAt:f.blockAt}).valid,false);assert.equal(f.writes.length,0);});
test('terrain changes after material preparation are re-inspected before the first dig',async()=>{const f=fixture();await f.builder.run({phase:'prepare_materials'});f.put(f.cut,'chest');await assert.rejects(f.builder.run({phase:'clear_site'}),{code:'house_unsafe_site'});assert.equal(f.writes.length,0);assert.equal(f.receipts.length,0);});

for(const depth of [2,3])test(`supported ${depth}-layer house foundation is filled bottom-up using only native placement acknowledgements`,async()=>{
 const f=fixture();for(let i=0;i<depth;i++)f.put({...f.hole,y:63-i},'air');const plan=inspectCreatableHouseSite({anchor,blockAt:f.blockAt});assert.equal(plan.valid,true);assert.equal(plan.foundationCount,depth);
 await f.builder.run({phase:'clear_site'});const fills=f.writes.filter(w=>w.kind==='place');assert.deepEqual(fills.map(w=>w.p.y),Array.from({length:depth},(_,i)=>64-depth+i));assert.equal(f.receipts[0].confirmedFoundationCells,depth);
});
test('supported scaffold and entrance holes belong to the prepared work yard and are physically filled',async()=>{
 const f=fixture(),bp=createFurnishedHouseBlueprint(anchor),scaffold=bp.scaffold.find(s=>s.position.y===anchor.y).position,entrance=bp.entrance.outside;
 for(const p of [scaffold,entrance]){f.put({...p,y:p.y-1},'air');f.put({...p,y:p.y-2},'air');}
 const plan=inspectCreatableHouseSite({anchor,blockAt:f.blockAt});assert.equal(plan.valid,true);await f.builder.run({phase:'clear_site'});
 for(const p of [scaffold,entrance])assert.equal(f.blockAt({...p,y:p.y-1}).name,'cobblestone');assert.equal(f.receipts[0].actualPrepared,true);
});
test('a shallow natural stone obstruction is planned then actually cleared after tools/material preparation',async()=>{const f=fixture();f.put(f.cut,'stone');assert.equal(inspectCreatableHouseSite({anchor,blockAt:f.blockAt}).valid,true);await f.builder.run({phase:'clear_site'});assert.equal(f.blockAt(f.cut).name,'air');});
test('entrance headroom is cleared with the site, and a native ACK is required there too',async()=>{const f=fixture(),p=createFurnishedHouseBlueprint(anchor).entrance.outside;f.put(p,'dirt');assert.equal(inspectCreatableHouseSite({anchor,blockAt:f.blockAt}).valid,true);await f.builder.run({phase:'clear_site'});assert.equal(f.blockAt(p).name,'air');assert.ok(f.writes.some(w=>w.kind==='dig'&&key(w.p)===key(p)));});
test('every additional foundation layer is present in the actual material request',async()=>{const a=fixture('recordMaterials'),b=fixture('recordMaterials');b.put({...b.hole,y:62},'air');b.put({...b.hole,y:61},'air');await a.builder.run({phase:'prepare_materials'});await b.builder.run({phase:'prepare_materials'});assert.equal(b.requests()[0].cobblestone-a.requests()[0].cobblestone,2);});
test('a paused acknowledged bottom layer can be revalidated as owned without granting a foreign support',async()=>{
 const f=fixture('pauseAfterPlace');f.put({...f.hole,y:62},'air');f.put({...f.hole,y:61},'air');await assert.rejects(f.builder.run({phase:'clear_site'}),{code:'paused'});assert.equal(f.receipts.length,0);
 assert.equal(f.blockAt({...f.hole,y:61}).name,'cobblestone');assert.equal(inspectCreatableHouseSite({anchor,blockAt:f.blockAt}).valid,false,'unowned cobble is not natural ground');
 assert.equal(inspectCreatableHouseSite({anchor,blockAt:f.blockAt,ownedFoundationPositions:f.cp().ownedBlockIds.filter(id=>id.startsWith('support:')).map(id=>id.slice(8))}).valid,true);
});
