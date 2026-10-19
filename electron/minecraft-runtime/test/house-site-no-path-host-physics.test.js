'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const filename=path.join(__dirname,'mining-combat-coordination.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);
native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf("\ntest('a grounded self-supply camp"))+'\nmodule.exports={fixture};\n',filename);
for(const baseline of [true,false])test(`formal37 production host lets only the captured site graph settle its real native NoPath landing: baseline=${baseline}`,{timeout:12000},async t=>{
 let createAgent;
 if(baseline){const file=path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),old=new Module(file,module);old.filename=file;old.paths=Module._nodeModulePaths(path.dirname(file));
  const text=fs.readFileSync(file,'utf8'),needle="if(error?.name==='NoPath'&&options.isExpectedNativeNoPath?.()===true)throw error;";assert.ok(text.includes(needle));old._compile(text.replace(needle,"if(false)throw error;"),file);createAgent=old.exports.createMinecraftTaskAgent;}
 const f=native.exports.fixture(t,{interrupt:false,createAgent,startPosition:{x:.5,y:3,z:.5},worldAt:p=>{return Object.assign(Block.fromStateId(registry.blocksByName[p.y<=0||p.x<=0&&p.y<=2?'stone':'air'].defaultState),{position:p});}});
 const anchor={x:0,y:3,z:0},target={x:16,y:1,z:0};let cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{'0,3,0':{position:anchor,parent:null,expanded:true}},order:['0,3,0'],frontier:[{parent:'0,3,0',target}],blockedEdges:[],current:'0,3,0',resumeNode:'0,3,0',visits:1,probes:0};
 let injected=false;f.bot.on('physicsTick',()=>{if(injected||f.bot.entity.position.x<1.15)return;injected=true;f.bot.emit('path_update',{status:'noPath',path:[{x:2.5,y:1,z:.5}]});});
 const run=()=>f.agent.__testHouseSurfaceGraphNext(anchor,{resource:'house_site_cottage',graphCheckpoint:{get:()=>cp,save:value=>{cp=value;}},assertGraphActive:()=>f.task.cancellationToken.throwIfRequested(),legTimeoutMs:8000});
 if(baseline){await assert.rejects(run());assert.ok(cp.blockedEdges.some(e=>e.reason==='NoPath'));assert.equal(cp.visits,1);assert.ok(f.task.physicalRecoveryCount>=1);return;}
 const result=await run();assert.equal(injected,true);assert.equal(result.moved,true);assert.equal(result.actual.y,1);assert.equal(cp.visits,2);assert.notDeepEqual(result.actual,target);assert.equal(f.bot.entity.onGround,true);assert.equal(f.task.physicalRecoveryCount||0,0);
 const trace=fs.readFileSync(f.task.diagnostics.tracePath,'utf8').trim().split('\n').map(JSON.parse);assert.ok(trace.some(d=>d.event==='house_site_partial_native_landing'&&d.details.oldEdgeTraversalCredit===false));
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});
