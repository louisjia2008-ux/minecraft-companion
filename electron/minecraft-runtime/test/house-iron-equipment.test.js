'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('prismarine-registry')('1.21.8');
const { equipmentPlan, prepareHouseIronEquipment } = require('../vendor/server/minecraft/houseIronEquipment');
function fixture() {
  const slots = Array(46).fill(null), inventory = [], calls = [], crafted = [];
  const item = name => ({ name, type: registry.itemsByName[name].id, count: 1, durabilityUsed: 0 });
  const bot = { registry, inventory: { slots, items: () => inventory } };
  const deps = { getBot: () => bot, assertActive: () => {}, provision: async () => {},
    ensure: async requirement => {
      calls.push(requirement);
      for (const [name] of Object.entries(requirement)) if (name !== 'iron_ingot') { inventory.push(item(name)); crafted.push(name); }
    }, equip: async (value, destination) => { slots[{ head: 5, torso: 6, legs: 7, feet: 8 }[destination]] = value; },
  };
  return { bot, slots, inventory, calls, crafted, item, deps };
}
test('a chestplate and shield still require the rest of the iron kit, batched once', async () => {
  const f = fixture(); f.slots[6] = f.item('iron_chestplate'); f.slots[45] = f.item('shield');
  assert.equal(equipmentPlan(f.bot).ironNeeded, 25);
  const result = await prepareHouseIronEquipment(f.deps);
  assert.deepEqual(f.calls[0], { iron_pickaxe: 1 });
  assert.deepEqual(f.calls[1], { iron_ingot: 22 });
  assert.equal(f.calls.filter(call => call.iron_ingot).length, 1);
  assert.equal(result.length, 8); assert.equal(equipmentPlan(f.bot).ironNeeded, 0);
  assert.ok([5, 6, 7, 8].every(slot => f.slots[slot]?.name.startsWith('iron_')));
  assert.equal(f.crafted.includes('iron_chestplate'), false);
});
test('nineteen already obtained iron equips chest legs and boots before requiring the remaining batch',async()=>{
 const f=fixture();f.inventory.push(f.item('iron_pickaxe'));let iron=19;
 f.deps.availableIron=()=>iron;const ensure=f.deps.ensure;
 f.deps.ensure=async request=>{
  if(request.iron_ingot){
   assert.equal(request.iron_ingot,11);
   for(const slot of [6,7,8])assert.ok(f.slots[slot]?.name.startsWith('iron_'),'Protection must actually be worn before more mining');
  }
  await ensure(request);
  for(const [name]of Object.entries(request))iron-=({iron_chestplate:8,iron_leggings:7,iron_boots:4,iron_helmet:5}[name]||0);
 };
 await prepareHouseIronEquipment(f.deps);
 assert.deepEqual(f.calls.slice(0,3),[{iron_chestplate:1},{iron_leggings:1},{iron_boots:1}]);
 assert.equal(equipmentPlan(f.bot).ironNeeded,0);
});
test('better equipment is retained and a resumed completed kit crafts nothing', async () => {
  const f = fixture(); f.inventory.push(f.item('diamond_pickaxe')); f.slots[5] = f.item('netherite_helmet');
  await prepareHouseIronEquipment(f.deps);
  assert.equal(f.crafted.includes('iron_pickaxe'), false); assert.equal(f.slots[5].name, 'netherite_helmet');
  f.calls.length = 0; await prepareHouseIronEquipment(f.deps); assert.deepEqual(f.calls, []);
});
test('weak armor and nearly broken iron tools are upgraded using an additional actual item', async () => {
  const f = fixture(); f.slots[6] = f.item('golden_chestplate');
  const broken = f.item('iron_pickaxe'); broken.durabilityUsed = registry.items[broken.type].maxDurability - 4;
  f.inventory.push(broken); await prepareHouseIronEquipment(f.deps);
  assert.ok(f.calls.some(call => call.iron_pickaxe === 2)); assert.equal(f.slots[6].name, 'iron_chestplate');
});
test('a craft acknowledgement without real inventory never completes the kit', async () => {
  const f = fixture(); f.deps.ensure = async () => {};
  await assert.rejects(prepareHouseIronEquipment(f.deps), { code: 'house_defense_equipment_missing' });
});
test('equipment acknowledgement without armor-slot readback is rejected', async () => {
  const f = fixture(); f.deps.equip = async () => {};
  await assert.rejects(prepareHouseIronEquipment(f.deps), { code: 'house_defense_armor_unconfirmed' });
});
test('cancellation preserves already crafted equipment and stops later recipes', async () => {
  const f = fixture(); let cancelled = false;
  f.deps.assertActive = () => { if (cancelled) throw Object.assign(Error('cancelled'), { code: 'cancelled' }); };
  const ensure = f.deps.ensure; f.deps.ensure = async request => { await ensure(request); if (request.iron_sword) cancelled = true; };
  await assert.rejects(prepareHouseIronEquipment(f.deps), { code: 'cancelled' });
  assert.deepEqual(f.crafted, ['iron_pickaxe', 'iron_chestplate', 'iron_sword']);
  cancelled = false; f.deps.ensure = ensure; await prepareHouseIronEquipment(f.deps);
  assert.equal(f.crafted.filter(name => name === 'iron_pickaxe').length, 1);
});

test('native inventory recipe target excludes a nearly broken worn helmet',()=>{
 const window=require('prismarine-windows')('1.21.8').createWindow(0,'minecraft:inventory','Inventory',46);
 const old={name:'iron_helmet',type:registry.itemsByName.iron_helmet.id,count:1,durabilityUsed:163};window.updateSlot(5,old);
 const bot={registry,inventory:window};assert.equal(window.items().length,0);
 assert.equal(equipmentPlan(bot).entries.find(e=>e.kind==='helmet').target,1);
 window.updateSlot(9,{...old});
 assert.equal(equipmentPlan(bot).entries.find(e=>e.kind==='helmet').target,2);
});

test('nine remaining chestplate durability cannot pass the final survival kit and replacement crafts only one',async()=>{
 const f=fixture();const old=f.item('iron_chestplate');old.durabilityUsed=231;f.slots[6]=old;
 const chest=equipmentPlan(f.bot).entries.find(e=>e.kind==='chestplate');assert.equal(chest.item,undefined);assert.equal(chest.target,1);
 await prepareHouseIronEquipment(f.deps);assert.notEqual(f.slots[6],old);
 assert.ok(f.calls.some(c=>c.iron_chestplate===1));assert.equal(equipmentPlan(f.bot).ironNeeded,0);
});

test('first chestplate is actually worn before requesting the remaining bulk iron kit',async()=>{
 const f=fixture(),ensure=f.deps.ensure;
 f.deps.ensure=async r=>{if(r.iron_ingot)assert.equal(f.slots[6]?.name,'iron_chestplate');return ensure(r);};
 await prepareHouseIronEquipment(f.deps);
 assert.deepEqual(f.calls.slice(0,2),[{iron_pickaxe:1},{iron_chestplate:1}]);
 assert.equal(equipmentPlan(f.bot).ironNeeded,0);
});

test('first protective chestplate uses a bounded smaller food reserve instead of hunting before every attempt',()=>{
 const {ironExpeditionFoodPoints:reserve}=require('../vendor/server/minecraft/houseIronEquipment');
 const f=fixture();assert.equal(reserve(f.bot),12);
 f.bot.health=20;f.bot.food=20;assert.equal(reserve(f.bot),4);
 f.bot.health=13;assert.equal(reserve(f.bot),12);f.bot.health=20;
 f.slots[6]=f.item('iron_chestplate');assert.equal(reserve(f.bot),4);
 f.bot.health=13;assert.equal(reserve(f.bot),24);f.bot.health=20;
 f.bot.food=17;assert.equal(reserve(f.bot),24);f.bot.food=20;
 f.slots[6].durabilityUsed=231;assert.equal(reserve(f.bot),4);
});

test('a protected worker puts already obtained iron into boots before spending it on another worn-pick replacement',async()=>{
 const f=fixture();f.slots[6]=f.item('iron_chestplate');let iron=6;
 f.deps.availableIron=()=>iron;const ensure=f.deps.ensure;
 f.deps.ensure=async r=>{
  if(r.iron_pickaxe)assert.equal(f.slots[8]?.name,'iron_boots','Available protection must precede a replacement mining tool');
  await ensure(r);iron-=({iron_boots:4,iron_pickaxe:3}[Object.keys(r)[0]]||0);
 };
 await prepareHouseIronEquipment(f.deps);
 assert.deepEqual(f.calls[0],{iron_boots:1});assert.equal(equipmentPlan(f.bot).ironNeeded,0);
});

test('final equipment readback accepts the complete worn usable kit without an expedition, but refuses missing, stowed or worn-out gear',async()=>{
 const {carriedIronEquipmentVerified:ready}=require('../vendor/server/minecraft/houseIronEquipment');
 const f=fixture();await prepareHouseIronEquipment(f.deps);f.slots[45]=f.item('shield');
 assert.equal(ready(f.bot),true);assert.equal(f.calls.length>0,true);
 const helmet=f.slots[5];f.slots[5]=null;assert.equal(ready(f.bot),false);f.slots[5]=helmet;
 const pick=f.inventory.find(i=>i.name==='iron_pickaxe');pick.durabilityUsed=245;assert.equal(ready(f.bot),false);pick.durabilityUsed=0;
 f.slots[45].durabilityUsed=330;assert.equal(ready(f.bot),false);f.slots[45].durabilityUsed=0;
 assert.equal(ready(f.bot),true);
});
