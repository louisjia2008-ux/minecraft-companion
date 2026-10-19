'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMinecraftActionRegistry } = require('../vendor/server/action/actionRegistry');
const { createHeuristicPlanner } = require('../vendor/server/minecraft/commandPlanner');
const { createLearningStateStore } = require('../vendor/server/minecraft/learningStore');
const { createSkillCatalog } = require('../vendor/server/minecraft/skillCatalog');
const { createMinecraftTaskAgent } = require('../vendor/server/minecraftTaskAgent');

const registry = createMinecraftActionRegistry();
const plan = createHeuristicPlanner({ actionRegistry: registry });
const temporary = t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-skill-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
};

test('Chinese, Arabic and full width counts use one parameterized skill', () => {
  for (const [command, count] of [['采五块木头',5],['采十块木头',10],['砍两根原木',2],
    ['收集十一块木头',11],['采一百零五块木头',105],['采二百五十六块木头',256],['collect ２４ logs',24],
    ['collect 5 oak logs',5],['gather 10 pieces of wood',10]]) {
    assert.equal(plan(command).steps[0].skill, 'gather_wood');
    assert.equal(plan(command).steps[0].args.count, count, command);
  }
  assert.equal(plan('挖两颗钻石').steps[0].args.count, 2);
  assert.equal(plan('挖点钻石').steps[0].args.count, 1);
  assert.equal(plan('合成两把石镐').steps[0].args.count,2);
  assert.equal(plan('craft wooden_pickaxe').steps[0].args.count,1);
  const {parseTaskQuantity}=require('../vendor/server/minecraft/taskQuantity');
  assert.equal(parseTaskQuantity('坐标 10 64 -5 附近采五块木头').value,5);
  assert.deepEqual(plan('去 -10 64 -5').steps[0].args, { x:-10, y:64, z:-5 });
});

test('invalid explicit counts never silently become another task', () => {
  for (const command of ['采零块木头', '采负五块木头', '采五点五块木头', '采二三十块木头',
    'collect 0 logs', 'collect -5 logs', 'collect 1.5 logs', 'collect 257 logs', 'collect 10000 logs',
    '合成零把铁镐','craft 33 iron_pickaxe','collect 10000 oak logs','collect 1e3 oak logs','collect 1e3 logs']) {
    assert.equal(plan(command).intent, 'invalid_quantity', command);
    assert.deepEqual(plan(command).steps, [], command);
  }
});

test('pending learning data flushes on dispose and keeps previous file on serialization failure', t => {
  const file = path.join(temporary(t), 'learning.json');
  const errors = [];
  const store = createLearningStateStore({ learningStatePath:file, broadcastMinecraftError:e=>errors.push(e) });
  store.scheduleSave({ schemaVersion:2, taskScripts:{ a:{ success:1 } } });
  assert.equal(store.dispose(), true);
  const bytes = fs.readFileSync(file);
  const cyclic = {}; cyclic.self = cyclic;
  store.scheduleSave(cyclic); assert.equal(store.dispose(), false);
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(errors.length,1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['learning.json']);
});

test('candidate -> validated -> enabled -> reload -> parameterized hit -> revoked', t => {
  const file = path.join(temporary(t), 'skills.json');
  const acceptedEvidence = { runIds:['native-a','native-b'], sourceDigest:'source-a', scope:'overworld_dry_ground' };
  const options = { file, registry, sourceDigest:'source-a', validateEvidence:(_manifest,evidence)=>
    JSON.stringify(evidence) === JSON.stringify(acceptedEvidence) };
  const context = { minecraftVersion:'1.21.8', dimension:'overworld' };
  let catalog = createSkillCatalog(options);
  const candidate = catalog.recordCandidate(plan('采五块木头'), context);
  assert.equal(candidate.status,'candidate'); assert.equal(catalog.find(plan('采十块木头'), context),null);
  assert.throws(()=>catalog.enable(candidate.id), /not_validated/);
  assert.throws(()=>catalog.validate(candidate.id, { success:true }), /not_verified/);
  catalog.validate(candidate.id,acceptedEvidence); catalog.enable(candidate.id);
  catalog = createSkillCatalog(options);
  assert.equal(catalog.find(plan('采十块木头'),context).id,candidate.id);
  assert.equal(catalog.recordCandidate(plan('采十块木头'),context).id,candidate.id);
  assert.equal(catalog.find(plan('采十块木头'),{...context,minecraftVersion:'1.21.11'}),null);
  assert.equal(catalog.find(plan('采十块木头'),{...context,dimension:'the_nether'}),null);
  assert.equal(createSkillCatalog({...options,sourceDigest:'source-b'}).find(plan('采十块木头'),context),null);
  assert.equal(createSkillCatalog({...options,validateEvidence:undefined}).find(plan('采十块木头'),context),null);
  catalog.revoke(candidate.id,'regression');
  assert.equal(createSkillCatalog(options).find(plan('采十块木头'),context),null);
});

test('corrupt catalog is preserved; code and unregistered actions are never promoted', t => {
  const file = path.join(temporary(t), 'skills.json'); fs.writeFileSync(file,'{broken');
  const catalog = createSkillCatalog({file,registry,sourceDigest:'source-a'});
  assert.throws(()=>catalog.recordCandidate(plan('采五块木头')),/unreadable_preserved/);
  assert.equal(fs.readFileSync(file,'utf8'),'{broken');
  assert.throws(()=>catalog.recordCandidate({intent:'bad',steps:[{skill:'run_js',args:{code:'process.exit()'}}]}),/unregistered/);
});

test('unreadable legacy learning data cannot be overwritten by empty fallback state', t => {
  const file=path.join(temporary(t),'learning.json'); fs.writeFileSync(file,'{broken');
  const store=createLearningStateStore({learningStatePath:file});
  assert.ok(store.load().error); store.scheduleSave({schemaVersion:2});
  assert.equal(store.dispose(),false);assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});

test('hybrid existing skill and exact hit issue zero model requests, keeping fresh quantity', async t => {
  const directory = temporary(t);
  const file = path.join(directory,'learning.json');
  const scripts = {};
  for (const [key, command] of [['gather_wood:wood','采五块木头'],['gather_wood:alternate','采八块木头']]) {
    const bucket = registry.ensureTaskScriptBucket(scripts,key,'gather_wood');
    registry.rememberTaskScriptOutcome(bucket,{plan:plan(command),userCommand:command},'completed');
  }
  fs.writeFileSync(file, JSON.stringify({schemaVersion:2,taskScripts:scripts}));
  const previous = process.env.MC_AGENT_LEARNING_PATH; process.env.MC_AGENT_LEARNING_PATH=file;
  let calls=0;
  const agent = createMinecraftTaskAgent({appPaths:{appDataDir:directory},readConfig:()=>({}),broadcast:()=>{},
    broadcastMinecraftError:()=>{},requestPlannerCompletion:async()=>{calls++;throw new Error('model must not run');}});
  t.after(()=>{agent.dispose(); if(previous===undefined)delete process.env.MC_AGENT_LEARNING_PATH;else process.env.MC_AGENT_LEARNING_PATH=previous;});
  agent.setRuntimeOptions({mcExecutorMode:'experimental-autonomy'});
  const fresh=await agent.__testPlanCommand('采十块木头',{});
  const match=await agent.__testChooseLearnedTaskScript('采十块木头',fresh);
  assert.equal(match.rerankMode,'exact');
  const compiled=registry.compileTaskScriptPlan('采十块木头',fresh,scripts,{});
  assert.equal(compiled.steps[0].args.count,10); assert.equal(calls,0);
  const crafting=await agent.__testPlanCommand('合成一个铁镐',{});
  assert.equal(crafting.scriptMeta.plannerMode,'registered_skill_direct'); assert.equal(calls,0);
  const invalid=await agent.__testPlanCommand('采零块木头',{});
  assert.equal(invalid.mode,'chat');assert.equal(calls,0);
});

test('enabled catalog routes through the real agent after restart without stale count or ranking', async t => {
  const directory=temporary(t),file=path.join(directory,'learning.json');
  const previous=process.env.MC_AGENT_LEARNING_PATH;process.env.MC_AGENT_LEARNING_PATH=file;
  const {skillSourceDigest}=require('../vendor/server/minecraft/skillSourceDigest');
  const sourceDigest=skillSourceDigest(path.resolve(__dirname,'..'));
  const evidence={receipt:'test-only-modeled-regression'};
  const verify=(_manifest,proof)=>proof?.receipt===evidence.receipt;
  const catalog=createSkillCatalog({file:`${file}.skills.json`,registry,sourceDigest,validateEvidence:verify});
  const candidate=catalog.recordCandidate(plan('采五块木头'),{minecraftVersion:'1.21.8',dimension:'overworld'});
  catalog.validate(candidate.id,evidence);catalog.enable(candidate.id);
  let calls=0;
  const agent=createMinecraftTaskAgent({appPaths:{appDataDir:directory},readConfig:()=>({mcExecutorMode:'experimental-autonomy'}),
    validateSkillEvidence:verify,broadcast:()=>{},broadcastMinecraftError:()=>{},requestPlannerCompletion:async()=>{calls++;throw Error('model');}});
  const {EventEmitter}=require('node:events');const bot=new EventEmitter();
  bot.version='1.21.8';bot.game={dimension:'overworld'};agent.attachBot(bot);
  t.after(()=>{agent.dispose();if(previous===undefined)delete process.env.MC_AGENT_LEARNING_PATH;else process.env.MC_AGENT_LEARNING_PATH=previous;});
  const fresh=plan('采十块木头');
  assert.equal(await agent.__testChooseLearnedTaskScript('采十块木头',fresh),null);
  assert.equal(fresh.scriptMeta.catalogSkillId,candidate.id);assert.equal(fresh.steps[0].args.count,10);assert.equal(calls,0);
  agent.revokeSkillCandidate(candidate.id,'regression');
  assert.equal(agent.getSkillCatalogSnapshot().records[candidate.id].status,'revoked');
});
