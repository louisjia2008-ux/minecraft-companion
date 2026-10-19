/* global require */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isSelfSuppliedHouseTask, assertHouseExternalWithdrawalAllowed } = require('../vendor/server/minecraft/houseSelfSupplyPolicy');
const plan = (skill, args = {}) => ({ steps: [{ skill, args }] });
test('all four house profiles default to self acquisition, including recursive food and mining contexts', () => {
  for (const [skill, profile] of [['build_furnished_house_phase', 'cottage'], ['build_furnished_house_phase', 'enchanting_library'], ['build_estate', 'medieval_castle'], ['build_estate', 'riverside_villa']]) {
    assert.equal(isSelfSuppliedHouseTask({ plan: plan(skill, { profile }) }), true);
    assert.throws(() => assertHouseExternalWithdrawalAllowed({ plan: plan(skill, { profile }) }), { code: 'house_external_supply_forbidden' });
  }
  assert.throws(() => assertHouseExternalWithdrawalAllowed({ plan: plan('mine_resource') }, { selfSupplyOnly: true }), { code: 'house_external_supply_forbidden' });
});
test('recovery cannot replace the original self acquisition contract with a supply chest plan', () => {
  const task = { completionPlan: plan('build_estate', { profile: 'medieval_castle' }), plan: plan('build_estate', { useNearbySupplyChests: true }) };
  assert.throws(() => assertHouseExternalWithdrawalAllowed(task), { code: 'house_external_supply_forbidden' });
});
test('stale depot coordinates or conflicting supplied flags do not authorize a self source withdrawal', () => {
  for (const useNearbySupplyChests of [false, true]) assert.throws(() => assertHouseExternalWithdrawalAllowed({ plan:
    plan('build_estate', { materialSource: 'self_gathered', useNearbySupplyChests, depots: [{ x: 0, y: 64, z: 0 }] }) }), { code: 'house_external_supply_forbidden' });
  assert.throws(() => assertHouseExternalWithdrawalAllowed({ plan: plan('build_estate', { depots: [{ x: 0, y: 64, z: 0 }] }) }), { code: 'house_external_supply_forbidden' });
});
test('explicit supplied construction diagnostics and unrelated player withdrawal remain separate authorized modes', () => {
  assert.equal(isSelfSuppliedHouseTask({ plan: plan('build_estate', { useNearbySupplyChests: true }) }), false);
  assert.doesNotThrow(() => assertHouseExternalWithdrawalAllowed({ plan: plan('withdraw_items') }));
});
