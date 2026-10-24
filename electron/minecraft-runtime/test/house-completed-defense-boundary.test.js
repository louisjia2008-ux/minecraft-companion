'use strict';
// Production boundary closure with modeled completed-frame authority; actor
// movement is installed native Physics. Not Java combat acceptance.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{goals}=require('mineflayer-pathfinder');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',filename);
const host=fs.readFileSync(path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),'utf8'),start=host.indexOf('    let pendingBoundaryDefense=null,graphQueryState=null;'),end=host.indexOf("    recordTaskDiagnostic(ownerTask,'house_graph_query_native_threats'",start),callback=host.slice(start,end);
for(const mode of ['fight','escape','failed','foreign','pause'])test(`world147 completed defense records actual graph boundary only for original successful owner: ${mode}`,async t=>{
 const f=native.exports.fixture(t),bot=f.bot,lease={},token={},ownerTask={materialSupply:{}},frame={bot,client:bot._client,task:ownerTask,runGeneration:1,token,previousLease:lease,surfacePosition:{x:.5,y:1,z:.5},deadline:Date.now()+3000};let active=true;
 const deps={toPlainPosition:p=>({x:p.x,y:p.y,z:p.z}),bot,client:bot._client,ownerTask,generation:1,token,lease,isMovementLeaseActive:()=>active,isSurvivalOwnerCurrent:()=>mode!=='foreign',assertActive:f.deps.assertActive,
  settleSurvivalDefense:async()=>{await bot.pathfinder.goto(new goals.GoalBlock(3,1,0));bot.pathfinder.setGoal(null);bot.clearControlStates();frame.finished=true;if(mode==='failed')frame.error=Error('failed');if(mode==='escape')frame.creeperEscape={confirmed:true};if(mode==='pause')f.cancel();},maybeHandleSurvivalCritical:async()=>{}};
 const closure=Function(...Object.keys(deps),'activeSurvivalInterrupt',`${callback};return {ready:readyHouseGraph,take:()=>pendingBoundaryDefense};`)(...Object.values(deps),frame);
 if(mode==='pause'){await assert.rejects(closure.ready(),{code:'cancelled'});return;}
 await closure.ready();const receipt=closure.take();
 if(['failed','foreign'].includes(mode)){assert.equal(receipt,null);return;}
 assert.equal(receipt.kind,'actual_owned_graph_boundary_defense');assert.equal(receipt.oldTargetReached,false);assert.equal(receipt.defenseOutcome,mode==='escape'?'escape_confirmed':'completed_owned_defense');assert.equal(receipt.actual.x,bot.entity.position.x);assert.ok(receipt.actual.x>2.5);assert.deepEqual(receipt.from,frame.surfacePosition);assert.ok(f.points.length);
});
