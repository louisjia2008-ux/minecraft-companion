'use strict';
const {inspectMiningStep}=require('./miningNavigation');
const key=p=>`${p.x},${p.y},${p.z}`;
const distance=(a,b)=>Math.hypot(a.x-b.x,(a.y??b.y)-b.y,a.z-b.z);
const allowed=b=>b&&(/^(dirt|grass_block|rooted_dirt|coarse_dirt|stone|cobblestone|andesite|granite|diorite|deepslate|cobbled_deepslate|tuff|calcite|coal_ore|iron_ore|copper_ore|deepslate_coal_ore|deepslate_iron_ore|deepslate_copper_ore)$/.test(b.name)||b.name.endsWith('_leaves'));
function isHouseFoodApproachRouteFailure(error){
 if(error?.code&&/paused|cancelled|preempted|owner|connection/.test(error.code))return false;
 return ['NoPath','no_path','executor_stalled'].includes(String(error?.code||error?.name))
  ||!error?.code&&['Promise timed out.','接近食用动物超时'].includes(error?.message);
}
// Read-only finite local alternatives. The executor must recheck each step
// through createMiningNavigator; a plan never grants movement/dig credit.
function planHouseLocalRoute({blockAt,from,goal,protectedPosition=()=>false,canDig=()=>false,maxNodes=192,maxSteps=6,maxDigs=8,canOpenWithoutHarvest=()=>false,maxNonHarvestableDigs=0}){
 if(!Number.isSafeInteger(maxNonHarvestableDigs)||maxNonHarvestableDigs<0||maxNonHarvestableDigs>1)throw TypeError("At most one non-harvesting route opening is permitted");
 const origin={x:Math.floor(from.x),y:Math.floor(from.y),z:Math.floor(from.z)},queue=[{position:origin,path:[],digs:0,openedWithoutHarvest:new Map(),openedCells:new Set(),routeFloors:new Set([key({...origin,y:origin.y-1})])}],costs=new Map([[key(origin),0]]);
 let best=null,bestScore=Infinity,reads=0,inspected=0;
 const mustRise=(goal.y??origin.y)>origin.y+1;
 const lower=mustRise?origin.y:Math.min(origin.y,goal.y??origin.y)-2;
 const upper=Math.max(origin.y+Math.min(3,maxSteps),Math.min(origin.y+maxSteps,goal.y??origin.y));
 while(queue.length&&inspected<Math.min(256,maxNodes)){
  const priority=n=>n.path.length+n.digs*3+n.openedWithoutHarvest.size*10+distance(n.position,goal)+(mustRise?Math.max(0,goal.y-n.position.y)*10:0);
  queue.sort((a,b)=>priority(a)-priority(b));
  const node=queue.shift();inspected++;if(node.path.length>=Math.min(8,maxSteps))continue;
  const view=q=>node.openedCells.has(key(q))?{name:'air',position:{...q},boundingBox:'empty',shapes:[],diggable:false,getProperties:()=>({})}:blockAt(q);
  for(const [x,z]of [[1,0],[0,1],[-1,0],[0,-1]])for(const dy of [0,1,-1]){
   const p=inspectMiningStep({blockAt:q=>{reads++;return view(q);},from:node.position,direction:{x,z},ascend:dy===1,descend:dy===-1,minY:-64,maxY:319,allowLeafSupport:true,allowCeilingClearance:true,allowStableGravitySupport:true});
   if(!p.ok||p.needsSupport||p.target.y<lower||p.target.y>upper
    ||p.clearance.some(point=>node.routeFloors.has(key(point))))continue;
   const blocks=p.clearance.map(view).filter(b=>b&&b.boundingBox!=='empty'&&b.shapes?.length);
   const openedWithoutHarvest=new Map(node.openedWithoutHarvest);
   if(blocks.some(b=>{if(!allowed(b)||protectedPosition(b.position))return true;if(canDig(b))return false;
     if(!canOpenWithoutHarvest(b))return true;openedWithoutHarvest.set(key(b.position),{position:{...b.position},name:b.name,stateId:b.stateId});return false;})
     ||openedWithoutHarvest.size>maxNonHarvestableDigs||node.digs+blocks.length>Math.min(18,maxDigs))continue;
   const next={position:p.target,openedWithoutHarvest,openedCells:new Set([...node.openedCells,...blocks.map(b=>key(b.position))]),path:[...node.path,{direction:{x,z},ascend:dy===1,descend:dy===-1}],digs:node.digs+blocks.length,routeFloors:new Set([...node.routeFloors,key({...p.target,y:p.target.y-1})])};const cost=next.path.length+next.digs*3+openedWithoutHarvest.size*10;
   if((costs.get(key(p.target))??Infinity)<=cost)continue;costs.set(key(p.target),cost);queue.push(next);
   const score=distance(p.target,goal)+next.path.length*.15+next.digs*3;
   const betterHeight=mustRise&&(!best||p.target.y>best.position.y);
   if((mustRise?p.target.y>origin.y:distance(p.target,goal)<distance(origin,goal)-.5)
     &&(betterHeight||(!mustRise||!best||p.target.y===best.position.y)&&score<bestScore)){best=next;bestScore=score;}
  }
 }
 if(!best)return null;
 const {routeFloors,openedWithoutHarvest,openedCells,...result}=best;return {...result,...(openedWithoutHarvest.size?{nonHarvestableOpenings:[...openedWithoutHarvest.values()]}:{}),inspectedNodes:inspected,reads,actualMovementConfirmed:false};
}
module.exports={planHouseLocalRoute,isHouseFoodApproachRouteFailure};
