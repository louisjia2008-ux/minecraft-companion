'use strict';
const assert=require('node:assert/strict');
const slots=Object.freeze({head:5,chest:6,legs:7,feet:8,offhand:45});
function fields(raw){
 raw=raw.trim();assert.ok(raw.startsWith('{')&&raw.endsWith('}'),'Expected actual SNBT compound');
 const result={},parts=[];let depth=0,quote=null,escaped=false,start=1;
 for(let i=1;i<raw.length-1;i++){
  const c=raw[i];if(escaped){escaped=false;continue;}if(quote){if(c==='\\')escaped=true;else if(c===quote)quote=null;continue;}
  if(c==='"'||c==="'"){quote=c;continue;}if(c==='{'||c==='[')depth++;else if(c==='}'||c===']')depth--;
  assert.ok(depth>=0,'Unbalanced SNBT');if(c===','&&depth===0){parts.push(raw.slice(start,i));start=i+1;}
 }
 assert.ok(!quote&&depth===0,'Unbalanced SNBT');parts.push(raw.slice(start,-1));
 for(const part of parts){if(!part.trim())continue;const m=part.match(/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_]+))\s*:\s*([\s\S]+)$/);assert.ok(m,'Invalid SNBT field');const key=m[1]||m[2]||m[3];assert.ok(!Object.hasOwn(result,key),'Duplicate SNBT field');result[key]=m[4].trim();}
 return result;
}
function equipmentFromEntitySNBT(line){
 const marker='entity data: ',index=line.indexOf(marker);assert.ok(index>=0,'Missing authoritative entity response');
 const root=fields(line.slice(index+marker.length));if(!Object.hasOwn(root,'equipment'))return [];
 const equipment=fields(root.equipment);return Object.entries(equipment).map(([slot,raw])=>{
  assert.ok(Object.hasOwn(slots,slot),`Unsupported player equipment slot ${slot}`);
  const item=fields(raw),id=item.id?.match(/^["']minecraft:([^"']+)["']$/),count=Number(item.count);
  assert.ok(id&&Number.isSafeInteger(count)&&count>0,'Invalid actual equipped stack');return {name:id[1],count,slot:slots[slot]};
 }).sort((a,b)=>a.slot-b.slot);
}
function savedEquipment(equipment={}){return Object.entries(equipment).map(([slot,item])=>{
 assert.ok(Object.hasOwn(slots,slot),`Unsupported saved player equipment slot ${slot}`);
 assert.ok(/^minecraft:/.test(item.id)&&Number.isSafeInteger(item.count)&&item.count>0,'Invalid saved equipment');
 return {name:item.id.slice(10),count:item.count,slot:slots[slot],components:item.components||item.tag||null};
});}
function mergeEquipment(inventory,equipment){const combined=[...inventory,...equipment].sort((a,b)=>a.slot-b.slot);assert.equal(new Set(combined.map(i=>i.slot)).size,combined.length,'Server inventory and equipment cannot credit the same slot twice');return combined;}
module.exports={equipmentFromEntitySNBT,savedEquipment,mergeEquipment};
