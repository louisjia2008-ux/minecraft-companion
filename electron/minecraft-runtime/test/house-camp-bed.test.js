'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{Vec3}=require('vec3');
const {prepareHouseCampBed,chooseCampBed,spawnMessage}=require('../vendor/server/minecraft/houseCampBed');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
function fixture(mode){
 const cells=new Map(),bot=Object.assign(new EventEmitter(),{game:{dimension:'overworld'},isSleeping:false}),camp={x:20,y:64,z:20};let cp,cancelled=false,current=bot;const calls=[];
 const block=(name,p,props)=>Object.assign(props?Block.fromProperties(registry.blocksByName[name].id,props,0):Block.fromStateId(registry.blocksByName[name].defaultState),{position:p});
 bot.blockAt=p=>cells.get(p.toString())||block(p.y<64?'stone':'air',p);
 const setOccupied=occupied=>{for(const part of ['foot','head']){const p=new Vec3(cp[part].x,cp[part].y,cp[part].z);cells.set(p.toString(),block('white_bed',p,{facing:'north',part,occupied}));}};
 const deps={getBot:()=>current,getCamp:()=>camp,getCheckpoint:()=>cp,save:r=>{cp=JSON.parse(JSON.stringify(r));},excluded:p=>p.x===20&&p.z===20,
  assertActive:()=>{if(cancelled)throw Object.assign(Error('paused'),{code:'paused'});},ensure:async targets=>calls.push(['recipe',targets]),
  place:async spec=>{calls.push(['placement',spec]);if(mode!=='no_placement')setOccupied(false);},reach:async p=>calls.push(['reach',p]),
  activate:async()=>{calls.push(['activate']);if(mode==='ack')bot.emit('message',{json:{translate:'block.minecraft.set_spawn'}});
   if(mode==='foreign_chat')bot.emit('message',{json:{text:'Respawn point set'}});
   if(mode==='sleep'){bot.isSleeping=true;setOccupied(true);bot.emit('sleep');setTimeout(()=>{setOccupied(false);bot.isSleeping=false;bot.emit('wake');},100);}
   if(mode==='changed')cells.clear();if(mode==='paused')cancelled=true;if(mode==='foreign')current={};},sleep:ms=>new Promise(r=>setTimeout(r,ms)),record:r=>calls.push(['confirmed',r])};
 return {deps,bot,calls,camp,cp:()=>cp,cells};
}
for(const mode of ['ack','sleep'])test(`early owned camp bed requires native server spawn/sleep evidence: ${mode}`,async()=>{
 const f=fixture(mode),r=await prepareHouseCampBed(f.deps);assert.equal(r.spawnConfirmed,true);assert.deepEqual(r.camp,f.camp);assert.deepEqual(f.calls[0],['recipe',{white_bed:1}]);assert.ok(f.calls.some(c=>c[0]==='confirmed'));
 assert.equal(r.confirmation,mode==='ack'?'native_server_respawn_message':'native_sleep_and_occupied');if(mode==='sleep'){assert.equal(r.slept,true);assert.equal(r.woke,true);assert.equal(f.bot.isSleeping,false);}
 const before=f.calls.length;await prepareHouseCampBed(f.deps);assert.equal(f.calls.length,before,'Confirmed intact owned bed is reused without recipe or activation replay');
});
for(const [mode,code]of [['no_ack','house_camp_bed_spawn_unconfirmed'],['foreign_chat','house_camp_bed_spawn_unconfirmed'],['no_placement','house_camp_bed_placement_unconfirmed'],['changed','house_camp_bed_changed'],['paused','paused'],['foreign','house_camp_bed_owner_changed']])test(`camp bed refuses unsupported confirmation: ${mode}`,{timeout:6000},async()=>{
 const f=fixture(mode);await assert.rejects(prepareHouseCampBed(f.deps),{code});assert.notEqual(f.cp()?.spawnConfirmed,true);assert.equal(f.bot.listenerCount('message'),0);assert.equal(f.bot.listenerCount('sleep'),0);
});
test('bed planning excludes unknown floors, waterlogged supports and protected camp stations',()=>{
 const f=fixture('ack');assert.throws(()=>chooseCampBed(f.bot,f.camp,()=>true),{code:'house_camp_bed_site_unconfirmed'});
 f.bot.blockAt=()=>null;assert.throws(()=>chooseCampBed(f.bot,f.camp,()=>false),{code:'house_camp_bed_site_unconfirmed'});
 assert.equal(spawnMessage({json:{translate:'chat.type.text',with:['other','Respawn point set']}}),false);
});
test('camp bed never activates outside overworld',async()=>{const f=fixture('ack');f.bot.game.dimension='the_nether';await assert.rejects(prepareHouseCampBed(f.deps),{code:'house_camp_bed_dimension'});assert.equal(f.calls.length,0);});
