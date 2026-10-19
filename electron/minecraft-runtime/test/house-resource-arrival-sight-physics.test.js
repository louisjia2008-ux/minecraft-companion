'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {Vec3}=require('vec3'),{goals}=require('mineflayer-pathfinder');
const file=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(file,'utf8'),host=new Module(file,module);host.filename=file;host.paths=Module._nodeModulePaths(__dirname);host._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',file);
const {createHouseResourceReach}=require('../vendor/server/minecraft/houseResourceReach'),{clearHouseResourceSight}=require('../vendor/server/minecraft/houseResourceSight'),{hasGroundedBodySupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
test('successful native approach clears freshly reachable actual leaf sight before resource rejection',{timeout:6000},async t=>{
 let removed=false,digs=0,moves=0;const budgets=[];
 const f=host.exports.fixture(t,{worldAt:p=>p.y<1?'stone':p.x===6&&p.y===2&&p.z===0?'spruce_log':!removed&&p.x===5&&p.y===2&&p.z===0?'spruce_leaves':'air'});
 const b=f.bot;b.canDigBlock=block=>block?.diggable&&block.position.offset(.5,.5,.5).distanceTo(b.entity.position.offset(0,1.65,0))<=5.1;b.canSeeBlock=()=>false;
 const target=b.blockAt(new Vec3(6,2,0)),safe=()=>hasGroundedBodySupport(b);
 await createHouseResourceReach({getBot:()=>b,captureActive:()=>f.deps.assertActive,avoidsSupport:()=>true,standingSafely:safe,
  moveToBlock:async()=>{moves++;await b.pathfinder.goto(new goals.GoalBlock(4,1,0));},
  clearSight:async(block,options)=>{budgets.push(options.maximumLeaves);return clearHouseResourceSight({getBot:()=>b,assertActive:f.deps.assertActive,standingSafely:safe,canClear:()=>true,
   dig:async leaf=>{assert.equal(leaf.name,'spruce_leaves');removed=true;digs++;b.emit('blockUpdate',leaf,b.blockAt(leaf.position));}},block,options);}
 })(target);
 assert.equal(moves,1);assert.equal(digs,1);assert.deepEqual(budgets,[2,2]);assert.ok(b.entity.position.x>4);assert.equal(b.entity.onGround,true);
 assert.equal(b.blockAt(target.position).name,'spruce_log');assert.equal(b.pathfinder.goal,null);
});
