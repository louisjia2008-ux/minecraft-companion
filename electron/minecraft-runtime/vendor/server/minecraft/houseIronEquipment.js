'use strict';

// One parameterized survival loadout, planned from actual carried/equipped
// items. Better equipment is retained; a chestplate alone is not completion.
const LOADOUT = Object.freeze([
  { kind: 'pickaxe', iron: 3 }, { kind: 'sword', iron: 2 },
  { kind: 'helmet', iron: 5, slot: 5, destination: 'head' },
  { kind: 'chestplate', iron: 8, slot: 6, destination: 'torso' },
  { kind: 'leggings', iron: 7, slot: 7, destination: 'legs' },
  { kind: 'boots', iron: 4, slot: 8, destination: 'feet' },
  { kind: 'axe', iron: 3 }, { kind: 'shovel', iron: 1 },
]);
function equipmentPlan(bot) {
  const carried=bot.inventory.items();
  const items = [...new Set([...carried, ...bot.inventory.slots.filter(Boolean)])];
  const usable = item => {
    const maximum = bot.registry.items[item.type]?.maxDurability;
    const reserve=/_(helmet|chestplate|leggings|boots)$/.test(item.name)?32:16;
    return !Number.isFinite(maximum) || maximum - Number(item.durabilityUsed || 0) > reserve;
  };
  const entries = LOADOUT.map(spec => {
    const accepted = ['netherite', 'diamond', 'iron'].map(tier => `${tier}_${spec.kind}`);
    const item = accepted.map(name => items.find(value => value.name === name && usable(value))).find(Boolean);
    const name = `iron_${spec.kind}`;
    // Recipe targets count backpack items, like the native inventory API.
    // A worn broken helmet does not require crafting two replacement helmets.
    return { ...spec, name, item, target: carried.filter(value => value.name === name).reduce((n, value) => n + value.count, 0) + 1 };
  });
  return { entries, ironNeeded: entries.filter(entry => !entry.item).reduce((n, entry) => n + entry.iron, 0) };
}

function ironExpeditionFoodPoints(bot){
  // A healthy, fed miner can start with one useful cooked meal. Requiring a
  // larger stockpile before every short ore batch can consume that meal on
  // the provisioning journey itself and restart hunting indefinitely. The
  // in-work hunger/recovery scheduler still eats and returns for real need.
  if(bot.health>=14&&bot.food>=18)return 4;
  if(equipmentPlan(bot).entries.find(entry=>entry.kind==='chestplate').item)
    return 24;
  return 12;
}
async function prepareHouseIronEquipment(deps) {
  const active = deps.assertActive;
  active();
  let plan = equipmentPlan(deps.getBot());
  if (plan.ironNeeded) {
    await deps.provision(); active();
    const availableIron=()=>deps.availableIron?deps.availableIron():deps.getBot().inventory.items()
      .filter(item=>['iron_ingot','raw_iron'].includes(item.name)).reduce((n,item)=>n+item.count,0);
    const equipAvailableArmor=async()=>{
    for(const kind of ['chestplate','leggings','boots','helmet']){
      let armor=equipmentPlan(deps.getBot()).entries.find(entry=>entry.kind===kind);
      if(armor.item||availableIron()<armor.iron)continue;
      await deps.ensure({[armor.name]:armor.target});active();
      armor=equipmentPlan(deps.getBot()).entries.find(entry=>entry.kind===kind);
      if(!armor.item)throw Object.assign(Error('现有铁料护甲未实际入包'),{code:'house_defense_equipment_missing'});
      await deps.equip(armor.item,armor.destination);active();
      if(deps.getBot().inventory.slots[armor.slot]?.name!==armor.item.name)
        throw Object.assign(Error('现有铁料护甲未实际穿戴'),{code:'house_defense_armor_unconfirmed'});
      deps.report?.({kind:armor.kind,item:armor.item.name,slot:armor.slot,phase:'available_iron_protection'});
    }
    };
    if(equipmentPlan(deps.getBot()).entries.find(entry=>entry.kind==='chestplate').item)await equipAvailableArmor();
    // Unlock harvest tiers with the first three ingots. Requiring the entire
    // armor batch first strands a stone miner beside gold/redstone/diamond.
    const pick = equipmentPlan(deps.getBot()).entries.find(entry => entry.kind === 'pickaxe');
    if (!pick.item) {
      await deps.ensure({ [pick.name]: pick.target }); active();
      const actual = equipmentPlan(deps.getBot()).entries.find(entry => entry.kind === 'pickaxe');
      if (!actual.item) throw Object.assign(Error('首批铁镐没有真实入包'), { code: 'house_defense_equipment_missing' });
      deps.report?.({ kind: 'pickaxe', item: actual.item.name, slot: null, phase: 'bootstrap' });
    }
    // Put the first real protective batch on the body before mining the rest
    // of a loadout. A missing/broken torso must not wait for every tool/armor.
    let torso=equipmentPlan(deps.getBot()).entries.find(entry=>entry.kind==='chestplate');
    if(!torso.item){
      await deps.ensure({[torso.name]:torso.target});active();
      torso=equipmentPlan(deps.getBot()).entries.find(entry=>entry.kind==='chestplate');
      if(!torso.item)throw Object.assign(Error('首批护身胸甲没有实际入包'),{code:'house_defense_equipment_missing'});
      await deps.equip(torso.item,torso.destination);active();
      if(deps.getBot().inventory.slots[torso.slot]?.name!==torso.item.name)throw Object.assign(Error('首批护身胸甲没有实际穿戴'),{code:'house_defense_armor_unconfirmed'});
      deps.report?.({kind:torso.kind,item:torso.item.name,slot:torso.slot,phase:'first_protection'});
    }
    // Already obtained iron should protect the survivor before another long
    // expedition. Reuse the same actual craft/equip/slot readback checks.
    await equipAvailableArmor();active();
    plan = equipmentPlan(deps.getBot());
    // Gather and smelt the missing kit in one material batch, instead of one
    // camp-to-mine expedition per recipe, after unlocking the iron pickaxe.
    // Existing ingots count toward it.
    if (plan.ironNeeded) { await deps.ensure({ iron_ingot: plan.ironNeeded }); active(); }
  }
  for (const spec of LOADOUT) {
    active();
    let entry = equipmentPlan(deps.getBot()).entries.find(value => value.kind === spec.kind);
    if (!entry.item) {
      await deps.ensure({ [entry.name]: entry.target }); active();
      entry = equipmentPlan(deps.getBot()).entries.find(value => value.kind === spec.kind);
    }
    if (!entry.item) throw Object.assign(Error(`未实际取得可用装备 ${entry.name}`), { code: 'house_defense_equipment_missing' });
    if (spec.destination && deps.getBot().inventory.slots[spec.slot] !== entry.item) {
      await deps.equip(entry.item, spec.destination); active();
    }
    if (spec.destination && deps.getBot().inventory.slots[spec.slot]?.name !== entry.item.name) {
      throw Object.assign(Error(`装备未实际穿戴 ${entry.name}`), { code: 'house_defense_armor_unconfirmed' });
    }
    deps.report?.({ kind: spec.kind, item: entry.item.name, slot: spec.slot ?? null });
  }
  active(); plan = equipmentPlan(deps.getBot());
  if (plan.ironNeeded) throw Object.assign(Error('铁制生存装备验收缺项'), { code: 'house_defense_equipment_missing' });
  return plan.entries.map(entry => ({ kind: entry.kind, item: entry.item.name, slot: entry.slot ?? null }));
}
function carriedIronEquipmentVerified(bot){
 const plan=equipmentPlan(bot);
 if(plan.ironNeeded||plan.entries.some(e=>e.slot!=null&&bot.inventory.slots[e.slot]!==e.item))return false;
 const shield=bot.inventory.slots[45],maximum=bot.registry.items[shield?.type]?.maxDurability;
 return shield?.name==='shield'&&Number.isFinite(maximum)&&maximum-Number(shield.durabilityUsed||0)>16;
}
module.exports = { equipmentPlan, prepareHouseIronEquipment, ironExpeditionFoodPoints,carriedIronEquipmentVerified };
