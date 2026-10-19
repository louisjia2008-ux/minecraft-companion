'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createFurnishedHouseBlueprint}=require('../vendor/server/minecraft/furnishedHouseBlueprints');
const {planHouseExteriorGrade}=require('../vendor/server/minecraft/houseExteriorGrade');
const b=createFurnishedHouseBlueprint({x:17,y:64,z:-23},{profile:'cottage'});
const terrain=p=>({name:p.y<64?'dirt':p.x<b.bounds.minX&&p.y<=65?'grass_block':'air',boundingBox:p.y<64||p.x<b.bounds.minX&&p.y<=65?'block':'empty'});
test('repair follows raised adjacent grade, uses only cleared strip and keeps doors/routes open',()=>{
 const plan=planHouseExteriorGrade(b,terrain);assert.ok(plan.length>0);
 for(const s of plan){assert.equal(s.position.x,b.bounds.minX);assert.ok(s.position.y>=64&&s.position.y<=65);
  assert.ok(!b.blocks.some(v=>JSON.stringify(v.position)===JSON.stringify(s.position)));
  assert.ok(!b.scaffoldRoute.some(p=>p.x===s.position.x&&p.z===s.position.z));}
 assert.ok(plan.every((s,i)=>!i||s.position.y>=plan[i-1].position.y));
});
test('unloaded neighbours, fluid, unsupported holes and foreign contents grant no filling authority',()=>{
 assert.deepEqual(planHouseExteriorGrade(b,()=>null),[]);
 assert.deepEqual(planHouseExteriorGrade(b,p=>p.y<64?{name:'air',boundingBox:'empty'}:terrain(p)),[]);
 const target={x:b.bounds.minX,y:64,z:b.bounds.minZ};
 for(const name of ['water','chest']){
  const plan=planHouseExteriorGrade(b,p=>p.x===target.x&&p.z===target.z&&p.y===64?{name,boundingBox:'block'}:terrain(p));
  assert.ok(!plan.some(s=>s.position.x===target.x&&s.position.z===target.z));
 }
});
