/* global module, require */
"use strict";

const { HOSTILE_MOB_NAMES } = require("./taskCatalog");

function getEntityDefinition(entity, registry) {
  const name = String(entity?.name || "").trim().toLowerCase().replace(/^minecraft:/, "");
  return registry?.entitiesByName?.[name] || registry?.entities?.[entity?.entityType] || null;
}

function getEntityName(entity, registry) {
  return String(getEntityDefinition(entity, registry)?.name || entity?.name || "")
    .trim().toLowerCase().replace(/^minecraft:/, "");
}

function isDroppedItemEntity(entity, registry) {
  const name = getEntityName(entity, registry);
  // Current Mineflayer reports dropped items as "other"; older versions used "object".
  // Boats, arrows and crystals also use those broad types and must not be collected.
  return name === "item" || name === "item_stack" || name === "dropped_item";
}

function isHostileMobEntity(entity, registry) {
  if (!entity || entity.type === "player") return false;
  const name = getEntityName(entity, registry);
  if (HOSTILE_MOB_NAMES.has(name)) return true;
  const definition = getEntityDefinition(entity, registry);
  return Boolean(name && (definition?.type === "hostile" || entity.type === "hostile"
    || definition?.category === "Hostile mobs"));
}
function getObservedEntityHealth(entity,registry){
  const index=getEntityDefinition(entity,registry)?.metadataKeys?.indexOf('health');
  const value=index>=0?entity?.metadata?.[index]:undefined;
  return Number.isFinite(value)?value:null;
}
const observedSelfAggressors = new WeakMap();
function recordObservedSelfAggressor(bot, hurt, source) {
  if (!bot?.entity || hurt !== bot.entity || !source || source === hurt || source.type === 'player'
    || source.isValid === false || bot.entities?.[source.id] !== source
    || !['mob','animal','hostile','water_creature','ambient','golem'].includes(getEntityDefinition(source, bot.registry)?.type)) return false;
  observedSelfAggressors.set(source, {bot, client:bot._client, until:Date.now()+15000});
  return true;
}
function isObservedSelfAggressor(entity) {
  const proof=entity && observedSelfAggressors.get(entity);
  return Boolean(proof && proof.bot._client===proof.client && proof.bot.entities?.[entity.id]===entity
    && entity.isValid!==false && Date.now()<proof.until);
}
function isThreateningMobEntity(entity, registry) {
  if(entity?.isValid===false||getObservedEntityHealth(entity,registry)===0)return false;
  if(isObservedSelfAggressor(entity))return true;
  if(!isHostileMobEntity(entity,registry))return false;
  if(getEntityName(entity,registry)!=='enderman')return true;
  const keys=getEntityDefinition(entity,registry)?.metadataKeys||[];
  // Endermen are neutral until provoked. Do not stare at or attack a nearby
  // neutral one merely because minecraft-data classifies its family hostile.
  return ['creepy','stared_at'].some(name=>{
    const index=keys.indexOf(name),value=index<0?undefined:entity.metadata?.[index];
    return value===true||value===1;
  });
}

function distanceBetweenPositions(a, b) {
  if (![a?.x, a?.y, a?.z, b?.x, b?.y, b?.z].every(Number.isFinite)) return Number.POSITIVE_INFINITY;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

module.exports = { getEntityName, isDroppedItemEntity, isHostileMobEntity, isThreateningMobEntity, getObservedEntityHealth, distanceBetweenPositions, recordObservedSelfAggressor, isObservedSelfAggressor };
