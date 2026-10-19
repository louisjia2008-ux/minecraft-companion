'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry),{Vec3}=require('vec3');
const {planEmergencyShelter,planEmergencyRoof,selectEmergencyExit,emergencyShelterConfirmed}=require('../vendor/server/minecraft/houseEmergencyShelter');
function fixture(position={x:.5,y:66,z:.5}){
 const cells=new Map(),key=p=>`${p.x},${p.y},${p.z}`;
 const blockAt=p=>{const name=cells.get(key(p))??(p.y<66?'grass_block':'air');return name===null?null:Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:new Vec3(p.x,p.y,p.z)});};
 const raycast=(from,to)=>{const {RaycastIterator}=require('prismarine-world/src/iterators'),start=new Vec3(from.x,from.y,from.z),delta=new Vec3(to.x,to.y,to.z).minus(start),iter=new RaycastIterator(start,delta.unit(),delta.norm());let p=start;while(p){const b=blockAt(new Vec3(p.x,p.y,p.z).floored());if(b&&iter.intersect(b.shapes,b.position))return b;p=iter.next();}return null;};
 const args={position,threat:{x:10,y:65,z:10},blockAt,raycast,inventory:{dirt:24,cobblestone:24}};
 return {args,cells,key,place:plan=>plan.blocks.forEach(p=>cells.set(key(p.position),p.item))};
}
for(const p of [{x:.5,y:66,z:.5},{x:.01,y:66,z:.99},{x:-154.1773150293,y:66,z:-142.7434383095}])test('temporary cover encloses actual body even across block boundaries without occupying it',()=>{
 const f=fixture(p),plan=planEmergencyShelter(f.args);assert.ok(plan);assert.ok(plan.blocks.length<=24);assert.equal(plan.actualProtectionConfirmed,false);
 assert.equal(emergencyShelterConfirmed({...f.args,plan}),false);f.place(plan);
 assert.equal(emergencyShelterConfirmed({...f.args,plan}),true);
 assert.ok(plan.blocks.every(b=>b.position.y===66||b.position.y===67));
 assert.ok(plan.blocks.every(b=>!(p.x+.3>b.position.x&&p.x-.3<b.position.x+1&&p.z+.3>b.position.z&&p.z-.3<b.position.z+1)));
});
test('existing solid natural structure is reused without spending or claiming new placed blocks',()=>{
 const f=fixture();f.cells.set('1,67,1','oak_log');const plan=planEmergencyShelter(f.args);assert.ok(plan);assert.equal(plan.blocks.some(b=>f.key(b.position)==='1,67,1'),false);
});
test('mixed ranged and ordinary melee threats require actual enclosing walls and blocked rays for every threat',()=>{
 const f=fixture(),plan=planEmergencyShelter(f.args);f.place(plan);
 const skeleton={name:'skeleton',height:1.8,position:{x:10,y:66,z:0}};
 const zombie={name:'zombie',height:1.95,position:{x:-10,y:66,z:0}};
 assert.equal(emergencyShelterConfirmed({...f.args,plan,threats:[skeleton,zombie]}),true);
 for(const name of ['creeper','spider','cave_spider','enderman','witch'])assert.equal(emergencyShelterConfirmed({...f.args,plan,threats:[skeleton,{...zombie,name}]}),false);
 assert.equal(emergencyShelterConfirmed({...f.args,plan,threats:[skeleton,zombie],raycast:(from,to)=>from.x<0?null:f.args.raycast(from,to)}),false);
 assert.equal(emergencyShelterConfirmed({...f.args,plan,threats:[{...zombie,position:{x:-10,y:67,z:0}}]}),false);
 f.cells.set('2,66,0','dirt');
 assert.equal(emergencyShelterConfirmed({...f.args,plan,threats:[skeleton,zombie]}),false,'Adjacent higher ground invalidates open-top melee cover before the zombie climbs');
});
for(const mode of ['unknown','lava','stock','protected'])test(`temporary cover cannot use ${mode}`,()=>{
 const f=fixture();if(mode==='unknown')f.args.blockAt=()=>null;if(mode==='lava')f.args.blockAt=p=>Object.assign(Block.fromStateId(registry.blocksByName.lava.defaultState),{position:new Vec3(p.x,p.y,p.z)});
 if(mode==='stock')f.args.inventory={};if(mode==='protected')f.args.excluded=()=>true;
 assert.equal(planEmergencyShelter(f.args),null);
});
test('cover confirmation rechecks walls, actual inside position, threat height and threat type',()=>{
 const f=fixture(),plan=planEmergencyShelter(f.args);f.place(plan);const enemy={name:'skeleton',height:1.8,position:{x:10,y:65,z:10}};
 assert.equal(emergencyShelterConfirmed({...f.args,plan,threats:[enemy]}),true);
 assert.equal(emergencyShelterConfirmed({...f.args,plan,threats:[{...enemy,position:{x:10,y:67,z:10}}]}),false);
 assert.equal(emergencyShelterConfirmed({...f.args,plan,threats:[{...enemy,name:'creeper'}]}),false);
 assert.equal(emergencyShelterConfirmed({...f.args,plan,position:{x:5,y:66,z:5}}),false);
 f.cells.set(f.key(plan.blocks[0].position),'air');assert.equal(emergencyShelterConfirmed({...f.args,plan}),false);
});

test('roof uses a supported carried cap when no upper anchor exists and its connected blocks receive no protection credit before placement',()=>{
 const f=fixture(),plan=planEmergencyShelter(f.args);f.place(plan);
 const capped=planEmergencyRoof({plan,blockAt:f.args.blockAt,inventory:{dirt:4}});
 assert.equal(capped.blocks.length,2);
 assert.equal(planEmergencyRoof({plan,blockAt:f.args.blockAt,inventory:{dirt:1}}),null);
 assert.equal(planEmergencyRoof({plan,blockAt:f.args.blockAt,inventory:{dirt:4},excluded:()=>true}),null);
 f.cells.set('1,68,0','oak_log');const roof=planEmergencyRoof({plan,blockAt:f.args.blockAt,inventory:{dirt:4}});
 assert.ok(roof);assert.equal(roof.blocks.length,1);
 const raised={name:'skeleton',height:1.8,position:{x:5,y:67,z:.5}};
 assert.equal(emergencyShelterConfirmed({...f.args,plan,threats:[raised]}),false);
 plan.structure.push(...roof.structure);f.place(roof);
 assert.equal(emergencyShelterConfirmed({...f.args,plan,threats:[raised]}),true);
});

test('legacy corner gaps are accepted only when every fresh native body ray is actually blocked',()=>{
 const f=fixture(),plan=planEmergencyShelter(f.args);f.place(plan);delete plan.cornerPolicy;
 for(const p of plan.structure)if([plan.bounds.loX,plan.bounds.hiX].includes(p.x)&&[plan.bounds.loZ,plan.bounds.hiZ].includes(p.z))f.cells.set(f.key(p),'air');
 const enemy={name:'skeleton',height:1.8,position:{x:10,y:65,z:.5}};
 assert.equal(emergencyShelterConfirmed({...f.args,plan,threats:[enemy]}),true);
 assert.equal(emergencyShelterConfirmed({...f.args,plan,threats:[{...enemy,position:{x:10,y:65,z:10}}]}),true);
 assert.equal(emergencyShelterConfirmed({...f.args,plan,threats:[enemy],raycast:()=>null}),false);
});

test('exit leads away from the newly observed enemy direction using only owned noncorner wall blocks',()=>{
 const f=fixture(),plan=planEmergencyShelter(f.args),placed=plan.blocks;
 const east=selectEmergencyExit({plan,placed,position:f.args.position,threat:{x:10,y:66,z:.5}});
 const west=selectEmergencyExit({plan,placed,position:f.args.position,threat:{x:-10,y:66,z:.5}});
 assert.equal(east.x,plan.bounds.loX);assert.equal(west.x,plan.bounds.hiX);assert.equal(east.z,0);assert.equal(west.z,0);
 assert.equal(selectEmergencyExit({plan,placed:[],position:f.args.position,threat:{x:10,y:66,z:0}}),null);
});

test('an owned base under a natural upper block cannot be chosen as a complete exit',()=>{
 const f=fixture(),plan=planEmergencyShelter(f.args),east=plan.blocks.filter(p=>p.position.x===plan.bounds.hiX&&p.position.z===0);
 const onlyBase=east.filter(p=>p.position.y===plan.bounds.y);
 assert.equal(selectEmergencyExit({plan,placed:onlyBase,position:f.args.position,threat:{x:10,y:66,z:.5}}),null);
});

test('first emergency wall column blocks a cardinal attacker before building remote corners',()=>{
 const f=fixture();f.args.threat={x:10,y:66,z:.5};
 const plan=planEmergencyShelter(f.args);assert.ok(plan);
 for(const s of plan.blocks.slice(0,2))f.cells.set(f.key(s.position),s.item);
 assert.ok(f.args.raycast({x:10,y:67.62,z:.5},{x:.5,y:67.62,z:.5}));
 assert.ok(f.args.raycast({x:10,y:66.6,z:.5},{x:.5,y:66.6,z:.5}));
 assert.equal(emergencyShelterConfirmed({...f.args,plan}),false);
});
