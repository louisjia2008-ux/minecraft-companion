'use strict';
// Production food perception closure and real native entity registry/ranged
// policy. Positions are MODELED, including the saved183 observed stray.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{Vec3}=require('vec3'),registry=require('prismarine-registry')('1.21.8');
const ranged=require('../vendor/server/minecraft/houseRangedCover'),{isThreateningMobEntity}=require('../vendor/server/minecraft/entitySemantics');
const s=fs.readFileSync(path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),'utf8'),start=s.indexOf('  function immediateFoodThreat(bot)'),end=s.indexOf('  async function settleHouseFoodThreats(',start),closure=s.slice(start,end);
for(const mode of ['saved183','near_archer','recent_damage','armed_press','natural_cover','underground_creeper'])test(`production food ranged handoff agrees with native defense ${mode}`,()=>{
 const self={id:1,name:'player',position:mode==='saved183'?new Vec3(-152.50666959460764,66,86.53567172487737):new Vec3(.5,1,.5)};
 const target={id:54,name:mode==='underground_creeper'?'creeper':'stray',isValid:true,metadata:[],position:mode==='saved183'?new Vec3(-175.7,65,92.5):new Vec3(mode==='near_archer'?7.5:mode==='armed_press'?15.5:23.5,mode==='underground_creeper'?-9:1,.5)};
 const bot={entity:self,registry,version:'1.21.8',health:mode==='armed_press'?20:15.1,inventory:{items:()=>mode==='armed_press'?[{name:'wooden_sword'}]:[],slots:[]},entities:{1:self,54:target}};
 const deps={isThreateningMobEntity,isHouseRangedThreatEntity:ranged.isHouseRangedThreatEntity,terrainSeparatedHouseMelee:()=>false,rangedCoverConfirmed:()=>mode==='natural_cover',combatMemory:{lastBotHurtAt:mode==='recent_damage'?Date.now():0},require:p=>require('../vendor/server/'+p.replace(/^\.\//,''))};
 const urgent=Function(...Object.keys(deps),`${closure};return immediateFoodThreat;`)(...Object.values(deps));
 assert.equal(urgent(bot),['near_archer','recent_damage','armed_press'].includes(mode));
});
