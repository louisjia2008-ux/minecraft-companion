'use strict';
const fail=message=>Object.assign(Error(message),{code:'house_field_wood_origin_budget_limit'});
function fieldWoodUsage(search,history=[]){
 const graphs=[...history,search].filter(Boolean).flatMap(s=>[...(s.graphSegments||[]).map(v=>v.graph),s.graph]).filter(Boolean);
 return {nodes:graphs.reduce((n,g)=>n+(g.order?.length||0),0),probes:graphs.reduce((n,g)=>n+(g.probes||0),0),segments:graphs.length};
}
function beginFieldWoodBudget(previous,{generation,usage,deadline,now=Date.now()}){
 if(!Number.isSafeInteger(generation)||!usage||!['nodes','probes','segments'].every(k=>Number.isSafeInteger(usage[k])&&usage[k]>=0)||!Number.isFinite(deadline)||deadline<=now)throw fail('就地木材搜索原有限时限已结束');
 if(previous?.generation===generation){
  if(previous.deadline<=now)throw fail('本执行代次的就地木材搜索原时限已用尽');
  return {...previous,deadline:Math.min(previous.deadline,deadline)};
 }
 return {kind:'bounded_field_wood_execution_budget',generation,baseline:{...usage},spent:{nodes:0,probes:0},deadline:Math.min(deadline,now+600000),historicalUsagePreserved:true};
}
function chargeFieldWoodBudget(budget,usage){
 const spent={nodes:usage.nodes-budget.baseline.nodes,probes:usage.probes-budget.baseline.probes};
 if(!Object.values(spent).every(Number.isSafeInteger)||spent.nodes<(budget.spent?.nodes||0)||spent.probes<(budget.spent?.probes||0)||spent.nodes>256||spent.probes>8192)
  throw fail('就地木材搜索本执行代次有限节点或探测预算已用尽');
 return {...budget,spent};
}
module.exports={fieldWoodUsage,beginFieldWoodBudget,chargeFieldWoodBudget};
