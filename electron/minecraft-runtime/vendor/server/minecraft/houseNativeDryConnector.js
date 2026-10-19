'use strict';
function restrictNativeDryConnectorProfile(profile,{bot,isDefenseOwner=()=>false}={}){
 // House verification/cleanup may call from a construction context rather
 // than selfSupplyOnly. Its dry connector still must not inherit sprinting
 // or corner-cutting diagonals from that caller.
 profile.allowSprinting=false;
 profile.getMoveDiagonal=()=>{};
 if(bot)profile.exclusionAreasStep.push(block=>{
  if(isDefenseOwner()===true)return 0; // Exact host-owned defense retains its own escape contract.
  const p=block?.position,actual=bot.entity?.position;if(!p||!actual)return Infinity;
  const {isThreateningMobEntity}=require('./entitySemantics');
  return Object.values(bot.entities||{}).filter(e=>e?.name==='creeper'&&e.isValid!==false&&e.position
    &&isThreateningMobEntity(e,bot.registry)&&Math.abs(e.position.y-p.y)<4).every(e=>
      Math.hypot(p.x+.5-e.position.x,p.z+.5-e.position.z)>=Math.min(9.5,
        Math.hypot(actual.x-e.position.x,actual.z-e.position.z)))?0:Infinity;
 });
 return profile;
}
const key=p=>`${p.x},${p.y},${p.z}`;
const cell=p=>({x:Math.floor(p.x),y:Math.floor(p.y),z:Math.floor(p.z)});
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
// A partial/UNKNOWN native path supplies directions only. Every executed leg
// needs a separate conclusive native proof and actual dry grounded arrival.
// No digging, placing, old-edge credit, or changes to the native probe budget.
async function followNativeDryConnector(deps,target,{deadline,maxLegs=12}={}){
 if(!target||!Object.values(target).every(Number.isSafeInteger)||!Number.isFinite(deadline)
   ||!Number.isSafeInteger(maxLegs)||maxLegs<1||maxLegs>12)throw TypeError('Finite native connector required');
 deps.assertActive();
 if(distance(deps.position(),target)>96||!deps.safeFoot(target)||!deps.grounded()||!deps.dry())return false;
 const attempted=new Set();let legs=0;
 const arrived=p=>key(cell(deps.position()))===key(p)&&Math.abs(deps.position().y-p.y)<=.075&&deps.grounded()&&deps.dry();
 const usable=proof=>proof?.facts?.conclusive===true&&proof.facts.status==='success'
   &&Array.isArray(proof.result?.path)&&proof.result.path.length<=512
   &&proof.result.path.every(p=>!p.toBreak?.length&&!p.toPlace?.length&&deps.safeFoot(cell(p)));
 const probe=p=>{
  deps.assertActive();if(Date.now()>=deadline)return null;
  const proof=deps.probe(p);deps.assertActive();
  deps.record?.({target:p,status:proof?.facts?.status||'UNKNOWN',conclusive:proof?.facts?.conclusive===true,
    pathLength:proof?.result?.path?.length||0,legs,actualMovementPerformed:false});
  return proof;
 };
 while(Date.now()<deadline&&legs<maxLegs){
  deps.assertActive();if(arrived(target))return true;
  const from=cell(deps.position()),direct=probe(target);
  // Even a conclusive detour may be too long for one finite execution leg.
  // Use it only as directions until a short endpoint has its own proof.
  let next=usable(direct)&&direct.result.path.length<=24?target:null;
  if(!next){
   const path=direct?.result?.path||[];
   // A nearby endpoint can require a long detour around a cliff. Taking only
   // the last eight hints repeatedly reprobed 40+ step suffixes and never
   // tried the independently reachable first leg. Prefer a bounded prefix;
   // every hint still needs its OWN conclusive <=24-step native proof.
   const ordered=[...path.slice(0,24).reverse(),...path.slice().reverse()];
   const hints=[...new Map(ordered.map(cell).map(p=>[key(p),p])).values()]
    .filter(p=>key(p)!==key(target)&&distance(p,from)>=1&&distance(p,from)<=12&&deps.safeFoot(p)
      &&!attempted.has(`${key(from)}>${key(p)}`));
   for(const p of hints.slice(0,8)){
    if(Date.now()>=deadline)break;
    const proof=probe(p);if(usable(proof)&&proof.result.path.length<=24){next=p;break;}
   }
  }
  if(!next)return false;
  const id=`${key(from)}>${key(next)}`;if(attempted.has(id))return false;attempted.add(id);
  deps.assertActive();if(!deps.safeFoot(next)||!deps.grounded()||!deps.dry())return false;
  await deps.move(next,deadline);deps.assertActive();legs++;
  const settleUntil=Math.min(deadline,Date.now()+1500);
  while(!arrived(next)&&Date.now()<settleUntil){deps.assertActive();await deps.wait(25);}
  deps.assertActive();if(!arrived(next))return false;
  deps.record?.({target:next,actual:deps.position(),legs,actualMovementPerformed:true,arrivalConfirmed:true});
 }
 deps.assertActive();return arrived(target);
}
module.exports={followNativeDryConnector,restrictNativeDryConnectorProfile};
