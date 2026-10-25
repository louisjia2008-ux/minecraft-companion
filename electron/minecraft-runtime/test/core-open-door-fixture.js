'use strict';
// Real registry blocks, native planner and native physics in a bounded world.
// This fixture never starts Java or fabricates a pathfinder result.
const { EventEmitter } = require('node:events');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { Vec3 } = require('vec3');
const AStar = require('mineflayer-pathfinder/lib/astar');
const Move = require('mineflayer-pathfinder/lib/move');
const { GoalBlock } = require('mineflayer-pathfinder/lib/goals');
const { configureMovements } = require('../core/companion');

function fixture(facing='north', hinge='left', options={}) {
  const normal = facing === 'north' || facing === 'south' ? {x:0,z:1} : {x:1,z:0};
  const tangent = {x:normal.z,z:-normal.x};
  const world = (u,v=0,y=0) => new Vec3(u*normal.x+v*tangent.x,y,u*normal.z+v*tangent.z);
  const blocks = new Map();
  function at(point) {
    const p = point.floored();
    const u = p.x*normal.x+p.z*normal.z, v=p.x*tangent.x+p.z*tangent.z;
    const key = p.toString();
    if (blocks.has(key)) return blocks.get(key);
    let b;
    if (u===0 && v===0 && (p.y===0||p.y===1)) {
      if(p.y===1 && options.unknownUpper) return null;
      if(p.y===1 && options.missingUpper) b=Block.fromProperties(registry.blocksByName.air.id,{},0);
      else {
        const props={facing,hinge,open:options.open!==false,powered:false,half:p.y===0?'lower':'upper'};
        if (p.y===1 && options.inconsistentUpper) props.hinge=hinge==='left'?'right':'left';
        b=Block.fromProperties(registry.blocksByName.oak_door.id,props,0);
        if(options.centreCollision) b.shapes=[[0,0,0,1,1,1]];
        if(options.wrongPlane) b.shapes=[[0,0,0,1,1,.1875]];
      }
    } else {
      const wall=p.y<0 || p.y>=2 || Math.abs(u)>=3 || Math.abs(v)>=2 || (!options.crossRoom && u===0);
      b=Block.fromProperties(registry.blocksByName[wall?'stone':'air'].id,{},0);
    }
    b.position=p; blocks.set(key,b); return b;
  }
  const bot=Object.assign(new EventEmitter(),{registry,blockAt:at,entity:{effects:{},position:world(options.reverse?2:-2).offset(.5,0,.5),onGround:true},inventory:{items:()=>[]},game:{minY:-64},clearControlStates(){}});
  require('mineflayer-pathfinder').pathfinder(bot);
  const nativeGetter = bot.pathfinder.getPathFromTo;
  const movements = configureMovements(bot);
  movements.exclusionAreasBreak.push((block)=>block?.name==='stone'?100:0);
  movements.allowEntityDetection=false;
  const start=world(options.reverse?2:-2), end=world(options.reverse?-2:2);
  const plan=()=>{
    const astar=new AStar(new Move(start.x,start.y,start.z,0,0),movements,new GoalBlock(end.x,end.y,end.z),1000,1000,20);
    let r=astar.compute(); while(r.status==='partial')r=astar.compute();return r;
  };
  return {bot,movements,world,at,blocks,start,end,plan,nativeGetter};
}

function nativeBody(f) {
  const bot = f.bot;
  Object.assign(bot, { version: '1.21.8', health: 20, food: 20, entities: {}, players: {},
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    controlState: Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(k=>[k,false])) });
  Object.assign(bot.entity, { velocity: new Vec3(0,0,0), eyeHeight: 1.62, height: 1.8, width: .6,
    yaw: 0, pitch: 0, attributes: {}, isInWater: false, isInLava: false, isInWeb: false,
    isCollidedHorizontally: false, isCollidedVertically: true, elytraFlying: false });
  bot.inventory.slots = Array(46).fill(null);
  bot.setControlState = (key,value) => { bot.controlState[key]=value; };
  bot.clearControlStates = () => { for(const key of Object.keys(bot.controlState))bot.controlState[key]=false; };
  bot.look = async (yaw,pitch) => { bot.entity.yaw=yaw;bot.entity.pitch=pitch; };
  bot.physics = require('prismarine-physics').Physics(registry, { getBlock: bot.blockAt });
  return { bot, PlayerState: require('prismarine-physics').PlayerState };
}


module.exports = { fixture, nativeBody, registry };
