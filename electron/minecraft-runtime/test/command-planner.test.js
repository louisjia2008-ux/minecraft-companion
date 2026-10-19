/* global require */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMinecraftActionRegistry } = require('../vendor/server/action/actionRegistry');
const { createHeuristicPlanner } = require('../vendor/server/minecraft/commandPlanner');

const registry = createMinecraftActionRegistry();
const plan = createHeuristicPlanner({ actionRegistry: registry, getLearnedSearchRadius: (_, fallback) => fallback });

for (const [command, skill, args] of [
  ['craft wooden_pickaxe', 'craft_item', { item: 'wooden_pickaxe' }],
  ['CRAFT WOODEN PICKAXE', 'craft_item', { item: 'wooden_pickaxe' }],
  ['合成一个石镐', 'craft_item', { item: 'stone_pickaxe' }],
  ['craft iron_pickaxe', 'craft_item', { item: 'iron_pickaxe' }],
  ['从箱子拿 8 个木头', 'withdraw_items', { item: 'oak_log', count: 8 }],
  ['fetch 8 logs', 'withdraw_items', { item: 'oak_log', count: 8 }],
  ['withdraw 2 wooden_pickaxe', 'withdraw_items', { item: 'wooden_pickaxe', count: 2 }],
  ['build a wooden house', 'build_furnished_house_phase', { phase: 'inspect_inventory', profile: 'cottage' }],
  ['盖一个木屋', 'build_furnished_house_phase', { phase: 'inspect_inventory', profile: 'cottage' }],
  ['收集 8 个木头', 'gather_wood', { count: 8 }],
  ['collect 8 logs', 'gather_wood', { count: 8 }],
  ['采集 8 个原木', 'gather_wood', { count: 8 }],
  ['挖 10 个圆石', 'mine_resource', { block: 'stone', count: 10 }],
  ['collect 10 cobblestone', 'mine_resource', { block: 'stone', count: 10 }],
  ['去 10 64 -5', 'go_to_position', { x: 10, y: 64, z: -5 }],
  ['GO TO 10, 64, -5', 'go_to_position', { x: 10, y: 64, z: -5 }],
  ['FOLLOW ME', 'follow_player', { playerName: 'Owner' }],
  ['跟着我', 'follow_player', { playerName: 'Owner' }],
]) {
  test(`natural language selects the requested operation: ${command}`, () => {
    const result = plan(command, { playerName: 'Owner' });
    assert.equal(result.mode, 'task');
    assert.equal(result.steps[0].skill, skill);
    for (const [key, value] of Object.entries(args)) assert.equal(result.steps[0].args[key], value);
  });
}

test('incidental substrings do not become destructive resource tasks', () => {
  for (const command of ['show the catalog', 'wooden_pickaxe', 'Minecraft wooden_pickaxe', 'mine redstone', 'collect environment data']) {
    const result = plan(command, { playerName: 'Owner' });
    assert.equal(result.mode, 'chat', command);
    assert.deepEqual(result.steps, [], command);
  }
});

test('every parsed step exists in the same action registry used by the executor', () => {
  const supported = new Set(registry.listActions().map((action) => action.actionId));
  for (const command of ['跟着我', '护卫我', '去 10 64 -5', '挖 10 个圆石', '收集 8 个木头', 'craft wooden_pickaxe', 'build a wooden house', '从箱子拿 8 个木头']) {
    for (const step of plan(command, { playerName: 'Owner' }).steps) assert.ok(supported.has(step.skill), `${command}: ${step.skill}`);
  }
});
