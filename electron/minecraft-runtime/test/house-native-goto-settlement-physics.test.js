'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{goals}=require('mineflayer-pathfinder');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
const {settleNativeGoto}=require('../vendor/server/minecraft/houseNativeGotoSettlement');
// Original installed pathfinder and physics; the initial empty partial timing
// is an explicit modeled event reproducing formal51's recorded native sequence.
function fixture(t,worldAt){const f=native.exports.fixture(t,{worldAt});const original=f.bot.pathfinder.goto.bind(f.bot.pathfinder);let calls=0;f.bot.pathfinder.goto=goal=>{calls++;const p=original(goal);f.bot.emit('path_update',{status:'partial',path:[]});return p;};return {...f,calls:()=>calls};}
test('installed goto really resolves on an empty partial before the player has reached its native target',async t=>{const f=fixture(t),goal=new goals.GoalBlock(5,1,0);await f.bot.pathfinder.goto(goal);assert.equal(goal.isEnd(f.bot.entity.position.floored()),false);assert.equal(f.calls(),1);});
test('settlement keeps the original native goal running to actual arrival after empty partial',{timeout:5000},async t=>{const f=fixture(t),goal=new goals.GoalBlock(5,1,0),records=[];await settleNativeGoto({...f.deps,record:r=>records.push(r)},{goal,deadline:Date.now()+3000});assert.equal(goal.isEnd(f.bot.entity.position.floored()),true);assert.ok(f.points.length>3);assert.equal(f.calls(),1);assert.equal(records[0].actualArrivalConfirmed,true);assert.equal(f.bot.listenerCount('goal_reached'),0);});
for(const mode of ['pause','foreignProfile','foreignGoal','deadline','noPath'])test(`pending native partial cannot credit arrival after ${mode}`,{timeout:4000},async t=>{
 const f=fixture(t),goal=new goals.GoalBlock(12,1,0),records=[];
 const work=settleNativeGoto({...f.deps,record:r=>records.push(r)},{goal,deadline:Date.now()+(mode==='deadline'?25:3000)});
 setTimeout(()=>{if(mode==='pause')f.cancel();else if(mode==='foreignProfile')f.bot.pathfinder.setMovements(new (require('mineflayer-pathfinder').Movements)(f.bot));else if(mode==='foreignGoal')f.bot.pathfinder.setGoal(new goals.GoalBlock(-10,1,0));else if(mode==='noPath')f.bot.emit('path_update',{status:'noPath',path:[]});},10);
 await assert.rejects(work,mode==='pause'?{code:'cancelled'}:mode==='deadline'?{code:'step_timeout'}:mode==='noPath'?{name:'NoPath'}:{code:'movement_preempted'});assert.equal(records.length,0);assert.equal(f.calls(),1);
});
test('ordinary real native noPath still does not grant an arrival receipt',async t=>{const f=native.exports.fixture(t,{worldAt:p=>p.y<1||p.y===3||p.y<3&&(Math.abs(p.x)===1||Math.abs(p.z)===1)?'stone':'air'}),goal=new goals.GoalBlock(3,1,0);f.bot.pathfinder.movements.canDig=false;f.bot.pathfinder.movements.allowParkour=false;await settleNativeGoto(f.deps,{goal,deadline:Date.now()+500});assert.equal(goal.isEnd(f.bot.entity.position.floored()),false);});
for(const permitted of [false,true])test(`native timeout with a complete goal endpoint needs a captured guarded-leg receipt: permitted=${permitted}`,{timeout:4000},async t=>{
 const f=native.exports.fixture(t),goal=new goals.GoalBlock(5,1,0),original=f.bot.pathfinder.goto.bind(f.bot.pathfinder),records=[];let calls=0;
 f.bot.pathfinder.goto=g=>{calls++;const p=original(g);f.bot.emit('path_update',{status:'timeout',path:[{x:g.x+.5,y:g.y,z:g.z+.5}]});return p;};
 const work=settleNativeGoto({...f.deps,allowPendingTimeout:()=>permitted,record:r=>records.push(r)},{goal,deadline:Date.now()+2500});
 if(permitted){await work;assert.equal(goal.isEnd(f.bot.entity.position.floored()),true);assert.ok(f.points.length>3);assert.equal(records[0].nativeTimeoutWithGoalEndpoint,true);}else{await assert.rejects(work,{name:'Timeout'});assert.equal(records.length,0);}assert.equal(calls,1);
});
test('a timeout partial endpoint short of the goal remains a native timeout even with a guarded leg',async t=>{
 const f=native.exports.fixture(t),goal=new goals.GoalBlock(5,1,0),original=f.bot.pathfinder.goto.bind(f.bot.pathfinder);f.bot.pathfinder.goto=g=>{const p=original(g);f.bot.emit('path_update',{status:'timeout',path:[{x:1.5,y:1,z:.5}]});return p;};await assert.rejects(settleNativeGoto({...f.deps,allowPendingTimeout:()=>true},{goal,deadline:Date.now()+2000}),{name:'Timeout'});
});
