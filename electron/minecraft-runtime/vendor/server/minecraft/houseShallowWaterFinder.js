'use strict';
// Loaded-client shallow route discovery. No file/MCA/network/resource-coordinate
// input; a returned native path is a plan, never evidence of walking it.
const {validateRoute,routeFrame,stableSupport,inspectBody}=require('./houseShallowWaterTraversal');
const {naturalWalkingFoot:dryFoot,hasGroundedBodySupport}=require('./houseSurfaceGraph');
const {isNaturalWalkingBodyBlock}=require('./houseNaturalWalkingBody');
const failure=(code,message,details={})=>Object.assign(new Error(message),{code,...details});
const p3=p=>({x:p.x,y:p.y,z:p.z});
const integer=p=>!!p&&['x','y','z'].every(k=>Number.isSafeInteger(p[k]));
const air=b=>!!b&&['air','cave_air','void_air'].includes(b.name);
const source=b=>!!b&&b.name==='water'&&Number(b.getProperties?.().level)===0;
const directions=[{x:1,z:0},{x:0,z:1},{x:-1,z:0},{x:0,z:-1}];
function routeIdentity(route){const f=routeFrame(route);return `source_water_depth1:${route.surfaceY}:${[`${route.from.x},${route.from.z}`,`${route.to.x},${route.to.z}`].sort().join('|')}:${route.width}:${f.d.x?'x':'z'}`;}
function createLoadedShallowWaterFinder(deps){
 const {Vec3,Movements,GoalBlock}=deps;
 if(!Vec3||!Movements||!GoalBlock||typeof deps.getBot!=='function'||typeof deps.assertActive!=='function')throw new TypeError('Original native dependencies and active owner assertion required');
 function find(options={}){
  deps.assertActive();const bot=deps.getBot(),origin=options.origin;
  if(!bot||!integer(origin)||!bot.entity?.onGround||bot.entity.isInWater||bot.entity.isInLava)throw failure('water_discovery_origin_unknown','Actual dry grounded integer graph origin required');
  if(Math.hypot(bot.entity.position.x-(origin.x+.5),bot.entity.position.y-origin.y,bot.entity.position.z-(origin.z+.5))>1)throw failure('water_discovery_origin_not_actual','Loaded discovery must start at the actual graph node');
  inspectBody(bot,Vec3);
  if(!dryFoot(bot,origin)||!hasGroundedBodySupport(bot))throw failure('water_discovery_origin_unsafe','Actual dry origin needs real body support');
  const readLimit=Math.min(32768,Math.max(1,Number.isSafeInteger(options.readLimit)?options.readLimit:8192));
  const probeLimit=Math.min(16,Math.max(1,Number.isSafeInteger(options.probeLimit)?options.probeLimit:8));
  const resultLimit=Math.min(8,Math.max(1,Number.isSafeInteger(options.resultLimit)?options.resultLimit:4));
  const horizontalRadius=Math.min(16,Math.max(1,Number.isSafeInteger(options.horizontalRadius)?options.horizontalRadius:16));
  const verticalRadius=Math.min(8,Math.max(0,Number.isSafeInteger(options.verticalRadius)?options.verticalRadius:4));
  const scanMs=Math.min(2000,Math.max(50,Number.isFinite(options.scanTimeoutMs)?options.scanTimeoutMs:750)),deadline=Date.now()+scanMs;
  const cache=new Map(),routes=[],rejections={},seen=new Set(options.seenRouteIds||[]);let reads=0,probes=0,candidates=0,stopped=null;
  const reject=code=>{rejections[code]=(rejections[code]||0)+1;};
  const check=()=>{deps.assertActive();if(Date.now()>deadline)throw failure('water_discovery_deadline','Bounded loaded-water scan elapsed');};
  const read=raw=>{const p=raw.floored(),key=`${p.x},${p.y},${p.z}`;if(cache.has(key))return cache.get(key);check();if(reads>=readLimit)throw failure('water_discovery_read_budget','Loaded read budget exhausted');reads++;const b=bot.blockAt(p);cache.set(key,b);return b;};
  const loaded={blockAt:read};
  const dryCell=(p,headroom=2)=>{try{stableSupport(loaded,{...p,y:p.y-1},Vec3);for(let y=0;y<headroom;y++)if(!air(read(new Vec3(p.x,p.y+y,p.z))))return false;return true;}catch(e){if(e.code?.startsWith('water_discovery_'))throw e;return false;}};
  const dryProfile=new Movements(bot);dryProfile.canDig=false;dryProfile.scafoldingBlocks=[];dryProfile.allowParkour=false;dryProfile.allow1by1towers=false;dryProfile.allowSprinting=false;dryProfile.maxDropDown=1;dryProfile.infiniteLiquidDropdownDistance=false;dryProfile.getMoveDiagonal=()=>{};
  dryProfile.exclusionAreasStep.push(b=>b?.position&&integer(b.position)&&(air(read(b.position))||isNaturalWalkingBodyBlock(read(b.position)))?0:Infinity);
  const nativeProbe=bank=>{
   check();if(probes>=probeLimit)throw failure('water_discovery_probe_budget','Native dry approach probe budget exhausted');probes++;
   const goal=new GoalBlock(bank.x,bank.y,bank.z),iterator=bot.pathfinder.getPathFromTo(dryProfile,bot.entity.position,goal,{optimizePath:false,timeout:Math.min(120,Math.max(1,deadline-Date.now())),tickTimeout:10,searchRadius:18});
   let result;for(let iteration=0;iteration<16;iteration++){check();const next=iterator.next();result=next.value?.result;if(next.done||!result||result.status!=='partial')break;}
   if(result?.status!=='success')throw failure('water_discovery_approach_unreachable','Original native dry probe did not reach bank',{nativeStatus:result?.status||null});
   const plannedPath=[];let previous=origin,length=Math.hypot(bot.entity.position.x-(origin.x+.5),bot.entity.position.y-origin.y,bot.entity.position.z-(origin.z+.5));
   if(!dryFoot(loaded,origin))throw failure('water_discovery_origin_unsafe','Actual origin changed during discovery');
   for(const step of result.path||[]){if(!integer(step)||step.toBreak?.length||step.toPlace?.length||!dryFoot(loaded,step))throw failure('water_discovery_path_unsafe','Native approach contains unknown/wet/dig/place state');const dx=Math.abs(step.x-previous.x),dz=Math.abs(step.z-previous.z),dy=Math.abs(step.y-previous.y);if(dx+dz>1||dy>1)throw failure('water_discovery_path_noncardinal','Native dry approach must use checked cardinal unit steps');length+=Math.hypot(step.x-previous.x,step.y-previous.y,step.z-previous.z);if(length>16+1e-8)throw failure('water_discovery_approach_over16','Original native dry path exceeds16m');plannedPath.push(p3(step));previous=step;}
   if(previous.x!==bank.x||previous.y!==bank.y||previous.z!==bank.z)throw failure('water_discovery_path_incomplete','Native plan endpoint differs from the bank');
   return {from:p3(origin),to:p3(bank),plannedPath,plannedLength:length,actualConfirmed:false,nativeStatus:'success',optimizePath:false,profile:{canDig:false,scaffold:false,parkour:false,sprint:false,diagonal:false,maxDropDown:1}};
  };
  const offsets=[];for(let dx=-horizontalRadius;dx<=horizontalRadius;dx++)for(let dz=-horizontalRadius;dz<=horizontalRadius;dz++)for(let dy=-verticalRadius;dy<=verticalRadius;dy++){const distance=Math.hypot(dx,dy,dz);if(distance<=16)offsets.push({dx,dy,dz,distance});}offsets.sort((a,b)=>a.distance-b.distance||Math.abs(a.dy)-Math.abs(b.dy)||a.dx-b.dx||a.dz-b.dz);
  try{for(const offset of offsets){check();const bank={x:origin.x+offset.dx,y:origin.y+offset.dy,z:origin.z+offset.dz};for(const d of directions){
   const waterStart={x:bank.x+d.x,z:bank.z+d.z};if(!source(read(new Vec3(waterStart.x,bank.y-1,waterStart.z))))continue;
   if(!dryCell(bank,4)){reject('near_bank_not_stable_dry');continue;}
   let width=0;for(;width<13;width++){const p=new Vec3(waterStart.x+d.x*width,bank.y-1,waterStart.z+d.z*width);if(!source(read(p)))break;}
   if(width<1||width>12){reject('water_width_unsupported');continue;}
   const to={x:waterStart.x+d.x*width,y:bank.y,z:waterStart.z+d.z*width};
   const route={schema:1,kind:'loaded_source_water_wade',from:p3(bank),to,waterStart,surfaceY:bank.y,direction:{...d},width,depth:1};
   const id=routeIdentity(route);if(seen.has(id))continue;candidates++;
   let geometry,approach;try{geometry=validateRoute(loaded,route,Vec3);approach=nativeProbe(bank);}catch(e){if(e.code?.startsWith('water_discovery_')&&['water_discovery_read_budget','water_discovery_probe_budget','water_discovery_deadline'].includes(e.code))throw e;reject(e.code||'water_discovery_probe_failed');continue;}
   deps.assertActive();seen.add(id);routes.push({id,route,approach,geometry,nativeApproachProbeConfirmed:true,actualTraversalConfirmed:false});if(routes.length>=resultLimit)break;
  }if(routes.length>=resultLimit)break;}}
  catch(e){if(['water_discovery_read_budget','water_discovery_probe_budget','water_discovery_deadline'].includes(e.code))stopped=e.code;else throw e;}
  deps.assertActive();
  const result={schema:1,source:'actual_loaded_client_world_only',origin:p3(origin),routes,diagnostics:{reads,readLimit,probes,probeLimit,candidates,rejections,stopReason:stopped,scanTimeoutMs:scanMs,verticalRadius,horizontalRadius,scanCompleteWithinDeclaredEnvelope:stopped===null,unseenWorld:'UNKNOWN'},actualMovementPerformed:false};deps.record?.('water_loaded_discovery',result);return result;
 }
 return {find};
}
module.exports={createLoadedShallowWaterFinder,routeIdentity};
