/* global require, process */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { createMinecraftTaskAgent } = require('../vendor/server/minecraftTaskAgent');
const { createMinecraftActionRegistry } = require('../vendor/server/action/actionRegistry');

test('estate objective requires the original profile and anchor plus complete structure, furniture, permanent routes and farms', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-estate-completion-'));
  const keys = ['MC_AGENT_LEARNING_PATH', 'MC_AGENT_DIAGNOSTICS_DIR', 'MC_AGENT_DISCONNECT_TRACE_PATH'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.MC_AGENT_LEARNING_PATH = path.join(dir, 'learning.json');
  process.env.MC_AGENT_DIAGNOSTICS_DIR = path.join(dir, 'diagnostics');
  process.env.MC_AGENT_DISCONNECT_TRACE_PATH = path.join(dir, 'disconnect.jsonl');
  const agent = createMinecraftTaskAgent({ appPaths: { appDataDir: dir },
    readConfig: () => ({ mcExecutorMode: 'strict-executor', mcAgentAutoReconnect: false }),
    requestPlannerCompletion: async () => { throw new Error('No AI repair may replace the original advanced objective'); },
    parseJsonObjectFromText: JSON.parse, broadcast: () => {}, broadcastMinecraftError: () => {},
    allowAutonomousMaintenance: () => false });
  const bot = Object.assign(new EventEmitter(), {
    username: 'DeskPet', health: 20, food: 20, entities: {}, players: {},
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true },
    inventory: { items: () => [] }, game: { dimension: 'overworld' }, player: { ping: 0 },
    _client: { state: 'play', socket: { writable: true, destroyed: false } },
    clearControlStates: () => {}, findBlock: () => null, findBlocks: () => [], blockAt: () => null,
    pathfinder: { setMovements: () => {}, setGoal: () => {}, stop: () => {} },
  });
  t.after(() => {
    agent.__testSetReconnectTask(null); agent.detachBot('manual_disconnect'); agent.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  });
  agent.attachBot(bot);
  const plan = createMinecraftActionRegistry().buildHeuristicTaskPlan('build_estate', { profile: 'medieval_castle', anchor: { x: 0, y: 64, z: 0 } });
  const valid = { schema: 1, sourceProfile: 'medieval_castle', anchor: { x: 0, y: 64, z: 0 }, ownedScaffold: [], verificationSummary: {
    schema: 1, sourceProfile: 'medieval_castle', anchor: { x: 0, y: 64, z: 0 }, missingBlocks: 0,
    stateMismatches: [], clearanceViolations: [], furnitureVerified: true, routeVerified: true, farmVerified: true,
  } };
  const task = { taskId: 'medieval-castle', status: 'running', intent: plan.intent, logs: [],
    completionPlan: plan, plan: { ...plan, steps: [{ skill: 'go_to_position', args: { x: 1, y: 64, z: 1 } }] },
    stepCheckpoint: { estate: valid } };
  agent.__testSetReconnectTask(task);
  assert.equal(await agent.__testVerifyTaskCompletion(task), true, 'Return-only repair retains the original objective');
  const invalid = [
    { ...valid, verificationSummary: { ...valid.verificationSummary, schema: 2 } },
    { ...valid, sourceProfile: 'riverside_villa' },
    { ...valid, verificationSummary: { ...valid.verificationSummary, sourceProfile: 'riverside_villa' } },
    { ...valid, verificationSummary: { ...valid.verificationSummary, missingBlocks: 1 } },
    { ...valid, verificationSummary: { ...valid.verificationSummary, stateMismatches: ['wrong bed part'] } },
    { ...valid, verificationSummary: { ...valid.verificationSummary, clearanceViolations: ['blocked bookshelf gap'] } },
    { ...valid, verificationSummary: { ...valid.verificationSummary, furnitureVerified: false } },
    { ...valid, anchor: { x: 1, y: 64, z: 0 } },
    { ...valid, verificationSummary: { ...valid.verificationSummary, anchor: { x: 1, y: 64, z: 0 } } },
    { ...valid, verificationSummary: { ...valid.verificationSummary, routeVerified: false } },
    { ...valid, verificationSummary: { ...valid.verificationSummary, farmVerified: false } },
    { ...valid, ownedScaffold: [{ x: 1, y: 65, z: 12 }] },
  ];
  for (const state of invalid) {
    task.stepCheckpoint.estate = state;
    await assert.rejects(agent.__testVerifyTaskCompletion(task), { code: 'estate_completion_unverified' });
  }
});
