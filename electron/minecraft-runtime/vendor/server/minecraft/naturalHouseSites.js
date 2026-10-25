/* global require, module */
'use strict';
const { createFurnishedHouseBlueprint, getFurnishedHouseMaterialBudget } = require('./furnishedHouseBlueprints');
const AIR = new Set(['air', 'cave_air', 'void_air']);
const HAZARDS = new Set(['lava','water','fire','soul_fire','magma_block','powder_snow','cactus','campfire','soul_campfire']);
const GRAVITY = new Set(['sand','red_sand','gravel']);
const { isNaturalHouseTerrain } = require('./houseNaturalTerrain');
const PREPARABLE_TERRAIN = /^(?:dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|stone|deepslate|tuff|granite|diorite|andesite)$/;
const CLEARABLE_SURFACE = new Set(['red_sand', 'snow_block']);
const key = p => `${p.x},${p.y},${p.z}`;
const support = b => Boolean(b && b.boundingBox === 'block' && !HAZARDS.has(b.name) && b.getProperties?.().waterlogged !== true);
const error = (reason, position, block) => ({ valid: false, reason, position, block: block?.name || null });
// Pure loaded-column planning. Every filled cell has a known continuous dry
// column to real non-leaf ground; ownership can recognize only actual cobble
// at previously acknowledged support coordinates, never a foreign container.
function planHouseSiteFoundation({blueprint,blockAt,depth=3,includeScaffold=true,ownedFoundationPositions=[]}){
 if(!Number.isInteger(depth)||depth<0||depth>3)return {valid:false,reason:'invalid_foundation_depth'};
 const owned=new Set(ownedFoundationPositions.map(p=>typeof p==='string'?p:key(p))),bases=new Map(),fills=new Map();
 const add=(p,role)=>bases.set(key(p),{position:{...p},role});
 for(const s of blueprint.blocks.filter(s=>s.phase==='floor'))add({...s.position,y:s.position.y-1},'floor');
 if(includeScaffold){for(const s of blueprint.scaffold.filter(s=>s.position.y===blueprint.anchor.y))add({...s.position,y:s.position.y-1},'scaffold');const p=blueprint.entrance.outside;add({...p,y:p.y-1},'entrance');}
 for(const {position,role} of bases.values()){
  const pending=[];let confirmed=false;
  for(let offset=0;offset<=depth;offset++){
   const p={...position,y:position.y-offset},b=blockAt(p);
   if(support(b)&&!b.name.endsWith('_leaves')&&(isNaturalHouseTerrain(b.name)||owned.has(key(p))&&b.name==='cobblestone')){confirmed=true;break;}
   if(!b||HAZARDS.has(b.name)||b.getProperties?.().waterlogged===true||!AIR.has(b.name)&&!(b.boundingBox==='empty'&&isNaturalHouseTerrain(b.name)))
    return error(role==='floor'?'unsafe_floor_support':role==='scaffold'?'unsupported_scaffold':'entrance_unsupported',p,b);
   pending.push(p);
  }
  if(!confirmed)return error(role==='floor'?'unsupported_floor':role==='scaffold'?'unsupported_scaffold':'entrance_unsupported',position,blockAt(position));
  for(const p of pending)fills.set(key(p),p);
  if(fills.size>256)return error('terrain_preparation_fill_limit',position,blockAt(position));
 }
 return {valid:true,foundation:[...fills.values()].sort((a,b)=>a.y-b.y),basePositions:[...bases.values()].map(v=>v.position),maximumFillLayers:depth};
}
// Read-only candidate proof. It authorizes a bounded plan, never completed
// terrain, materials, placement ownership, native access or a finished house.
function inspectNaturalHouseSite({ anchor, profile = 'cottage', blockAt, allowSingleLayerFoundation = false, allowTerrainPreparation = false, foundationDepth=1,ownedFoundationPositions=[] }) {
 const blueprint=createFurnishedHouseBlueprint(anchor,{profile}),floor=blueprint.blocks.filter(v=>v.phase==='floor'),scaffoldBottom=blueprint.scaffold.filter(v=>v.position.y===anchor.y);
 let foundation=[];
 if(allowTerrainPreparation){const plan=planHouseSiteFoundation({blueprint,blockAt,depth:foundationDepth,ownedFoundationPositions});if(!plan.valid)return plan;foundation=plan.foundation;}
 else{
  for(const spec of floor){const p={...spec.position,y:spec.position.y-1},b=blockAt(p);if(support(b)&&isNaturalHouseTerrain(b.name)&&!b.name.endsWith('_leaves'))continue;
   if(!b||HAZARDS.has(b.name)||(!AIR.has(b.name)&&(!isNaturalHouseTerrain(b.name)||b.name.endsWith('_leaves'))))return error('unsafe_floor_support',p,b);
   if(!allowSingleLayerFoundation||!AIR.has(b.name)||!support(blockAt({...p,y:p.y-1})))return error('unsupported_floor',p,b);foundation.push(p);}
  for(const spec of scaffoldBottom){const p={...spec.position,y:spec.position.y-1},b=blockAt(p);if(!support(b)||!isNaturalHouseTerrain(b.name)||b.name.endsWith('_leaves'))return error('unsupported_scaffold',p,b);}
 }
 const removals=new Map(),excavation=new Map();
 const inspectClear=p=>{const b=blockAt(p);if(!b||HAZARDS.has(b.name)||b.getProperties?.().waterlogged===true)return error('unsafe_clearance',p,b);
  if(AIR.has(b.name))return null;if(!isNaturalHouseTerrain(b.name))return error('foreign_site_block',p,b);
  const matchingSurface=CLEARABLE_SURFACE.has(b.name)&&blockAt({...p,y:anchor.y-1})?.name===b.name;
  if(b.boundingBox==='block'&&!b.name.endsWith('_leaves')&&!matchingSurface){
   if(!allowTerrainPreparation||!PREPARABLE_TERRAIN.test(b.name)||p.y>anchor.y+1)return error('terrain_excavation_required',p,b);
   excavation.set(key(p),{position:{...p},name:b.name,stateId:b.stateId});if(excavation.size>96)return error('terrain_preparation_cut_limit',p,b);}
  removals.set(key(p),{...p});return null;};
 for(let y=blueprint.bounds.minY;y<=blueprint.bounds.maxY;y++)for(let x=blueprint.bounds.minX;x<=blueprint.bounds.maxX;x++)for(let z=blueprint.bounds.minZ;z<=blueprint.bounds.maxZ;z++){const bad=inspectClear({x,y,z});if(bad)return bad;}
 for(let x=blueprint.bounds.minX;x<=blueprint.bounds.maxX;x++)for(let z=blueprint.bounds.minZ;z<=blueprint.bounds.maxZ;z++){const p={x,y:blueprint.bounds.maxY+1,z},b=blockAt(p);if(!b||GRAVITY.has(b.name))return error('gravity_above_clearance',p,b);}
 for(const feet of [blueprint.entrance.outside,...blueprint.scaffoldRoute]){
  for(const y of [feet.y,feet.y+1]){const p={...feet,y},b=blockAt(p);if(allowTerrainPreparation){const bad=inspectClear(p);if(bad)return bad;}else if(!b||!AIR.has(b.name))return error('outside_route_obstructed',p,b);}
  const p={...feet,y:feet.y-1},b=blockAt(p);if(!allowTerrainPreparation&&key(feet)===key(blueprint.entrance.outside)&&!support(b))return error('entrance_unsupported',p,b);
 }
 if(allowTerrainPreparation){const tops=new Map();for(const p of removals.values()){const k=`${p.x},${p.z}`;if(!tops.has(k)||tops.get(k).y<p.y)tops.set(k,p);}
  for(const p of tops.values()){const above={...p,y:p.y+1},b=blockAt(above);if(!b||GRAVITY.has(b.name))return error('gravity_above_clearance',above,b);}}
 const budget=getFurnishedHouseMaterialBudget(blueprint);budget.cobblestone=(budget.cobblestone||0)+foundation.length;
 return {valid:true,schema:2,profile,anchor:{...anchor},finalBlocks:blueprint.blocks.length,nativePlacements:blueprint.blocks.filter(v=>!v.derived).length,scaffoldBlocks:blueprint.scaffold.length,
  floorSupportCells:floor.length,scaffoldBaseCells:scaffoldBottom.length,clearingCount:removals.size,foundationCount:foundation.length,foundation,
  terrainPreparation:{kind:'loaded_bounded_site_preparation_plan',actualPrepared:false,maximumCutLayers:2,maximumFillLayers:allowTerrainPreparation?foundationDepth:1,excavation:[...excavation.values()],foundation:foundation.map(p=>({...p})),foundationMaterial:'cobblestone'},
  materialBudget:budget,removals:[...removals.values()].sort((a,b)=>b.y-a.y)};
}
function chooseLoadedNaturalHouseSite({ origin, profile='cottage', blockAt, radius=24, limit=1024 }) {
  const offsets = [[2,2],[-10,2],[2,-14],[-10,-14],[0,0]];
  for (let ring=4;ring<=radius;ring+=4) for (let x=-ring;x<=ring;x+=4) for (let z=-ring;z<=ring;z+=4) {
    if (Math.max(Math.abs(x),Math.abs(z))===ring) offsets.push([x,z]);
  }
  const seen = new Set(); const rejected = []; let inspected=0;
  for (const [dx,dz] of offsets) for (const dy of [0,1,-1,2,-2]) {
    const anchor = {x:Math.floor(origin.x)+dx,y:Math.floor(origin.y)+dy,z:Math.floor(origin.z)+dz};
    if (seen.has(key(anchor))) continue; seen.add(key(anchor));
    if (++inspected>limit) return {valid:false,reason:'finite_site_search_exhausted',inspected:inspected-1,rejected};
    const result=inspectNaturalHouseSite({anchor,profile,blockAt});
    if(result.valid) return {...result,inspected};
    rejected.push({anchor,reason:result.reason});
  }
  return {valid:false,reason:'finite_site_search_exhausted',inspected,rejected};
}
function inspectCreatableHouseSite(options) {
  return inspectNaturalHouseSite({...options,allowSingleLayerFoundation:true,allowTerrainPreparation:true,foundationDepth:3});
}
module.exports={inspectNaturalHouseSite,inspectCreatableHouseSite,planHouseSiteFoundation,chooseLoadedNaturalHouseSite};
