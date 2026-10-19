'use strict';
// Production ensureTool closure; installed Mineflayer inventory receives
// MODELED crafting set_slot ACKs. This is not Java crafting acceptance.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const fixtureFile=path.join(__dirname,'house-resource-gatherer-progress-retry.test.js'),m=new Module(fixtureFile,module);m.filename=fixtureFile;m.paths=Module._nodeModulePaths(__dirname);
const fixtureSource=fs.readFileSync(fixtureFile,'utf8');m._compile(fixtureSource.slice(0,fixtureSource.indexOf("\ntest("))+'\nmodule.exports={fixture};',fixtureFile);
const source=fs.readFileSync(path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),'utf8'),start=source.indexOf('      ensureTool: async (name, block) => {'),end=source.indexOf('      reachDig: createHouseResourceReach',start),closure=source.slice(start,end);
for(const mode of ['carried','craft_ack','missing_ack','pause'])test(`production soil selection preserves sword ${mode}`,async()=>{
 const f=m.exports.fixture({name:'dirt',block:'dirt'}),bot=f.bot;f.slot(1,'wooden_sword',36);f.slot(1,'stick',37);
 if(mode==='carried')f.slot(1,'wooden_shovel',38);
 const events=[];let active=true;
 const deps={bot,PICKAXE_ITEM_NAMES:['wooden_pickaxe'],remainingHouseToolDurability:i=>(bot.registry.itemsByName[i.name]?.maxDurability||0)-Number(i.durabilityUsed||0),
  checkTaskSignal:()=>{if(!active)throw Object.assign(Error('paused'),{code:'paused'});},
  runAtHouseCamp:async(route,fn)=>{assert.equal(route.resource,'dirt');events.push('camp');await fn();},
  source:{ensure:async requirements=>{assert.deepEqual(requirements,{wooden_shovel:1});events.push('craft');if(mode!=='missing_ack')f.slot(1,'wooden_shovel',38);if(mode==='pause')active=false;}},
  getItemCountByName:f.inventoryCount,equipInventoryItem:async item=>{assert.equal(active,true);events.push(['equip',item.name]);},
  equipBestTool:async()=>{throw Error('Old generic harvest selection could reuse the sword');}};
 const ensure=Function(...Object.keys(deps),`return ({${closure}}).ensureTool;`)(...Object.values(deps));
 if(mode==='missing_ack'||mode==='pause')await assert.rejects(ensure('dirt',f.first),{code:mode==='pause'?'paused':'house_resource_shovel_missing'});
 else {await ensure('dirt',f.first);assert.deepEqual(events.at(-1),['equip','wooden_shovel']);assert.equal(events.includes('craft'),mode==='craft_ack');}
 assert.equal(f.inventoryCount('wooden_sword'),1);assert.equal(bot.inventory.items().find(i=>i.name==='wooden_sword').durabilityUsed,0);
 if(mode==='missing_ack'||mode==='pause')assert.equal(events.some(e=>Array.isArray(e)&&e[0]==='equip'),false);
});
