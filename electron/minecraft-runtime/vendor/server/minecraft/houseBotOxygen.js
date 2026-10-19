/* global module */
'use strict';

// Mineflayer 4.37.1 updates bot.oxygenLevel for air metadata belonging to ANY
// loaded entity. Read only this player's native metadata; missing self metadata
// stays UNKNOWN rather than borrowing an animal's breath or assuming full air.
function readHouseBotOxygen(bot) {
  const entity = bot?.entity;
  const keys = bot?.registry?.entitiesByName?.player?.metadataKeys;
  const index = Array.isArray(keys) ? keys.indexOf('air_supply') : -1;
  const raw = index >= 0 ? entity?.metadata?.[index] : undefined;
  if (!Number.isSafeInteger(entity?.id) || !Number.isSafeInteger(raw) || raw < -20 || raw > 300) {
    return { entityId: Number.isSafeInteger(entity?.id) ? entity.id : null,
      rawAirSupply: null, oxygenLevel: null, source: 'own_entity_metadata_unknown' };
  }
  return { entityId: entity.id, rawAirSupply: raw, oxygenLevel: Math.round(raw / 15), source: 'own_entity_metadata' };
}

module.exports = { readHouseBotOxygen };
