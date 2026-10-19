'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createSkillCatalog}=require('../vendor/server/minecraft/skillCatalog');
const {skillSourceDigest}=require('../vendor/server/minecraft/skillSourceDigest');
const {createApprovedSkillVerifier,approveHouseSkill,HOUSE_CRITERIA}=require('../vendor/server/minecraft/skillApproval');
const {createMinecraftActionRegistry}=require('../vendor/server/action/actionRegistry');
const registry=createMinecraftActionRegistry();
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// These are modeled trusted-host receipts for qualification-boundary tests.
// They certify no Minecraft server, house, materials, seed or terrain.
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mc-skill-approval-')),root=path.join(dir,'runtime');fs.mkdirSync(path.join(root,'vendor'),{recursive:true});
 fs.writeFileSync(path.join(root,'vendor/fixture.js'),'// modeled source identity\n');fs.writeFileSync(path.join(root,'package-lock.json'),'{}');
 fs.mkdirSync(path.join(root,'node_modules/fixture'),{recursive:true});const nativeFile=path.join(root,'node_modules/fixture/native.js');fs.writeFileSync(nativeFile,'// modeled native package\n');
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const sourceDigest=skillSourceDigest(root),catalogFile=path.join(dir,'learning.json.skills.json'),approvalFile=path.join(dir,'learning.json.skill-approvals.json');
 const plan={intent:'build_furnished_house',steps:[{skill:'build_furnished_house_phase',args:{schema:2,phase:'inspect_inventory',profile:'cottage',materialSource:'self_gathered'}}]};
 const verifier=createApprovedSkillVerifier({file:approvalFile,runtimeRoot:root}),options={file:catalogFile,registry,sourceDigest,validateEvidence:verifier};
 const catalog=createSkillCatalog(options),context={minecraftVersion:'1.21.8',dimension:'overworld'},record=catalog.recordCandidate(plan,context);
 const manifestFile=path.join(dir,'manifest.json'),qaFile=path.join(dir,'qa.json'),wholeAuditFile=path.join(dir,'whole.json'),resultFile=path.join(dir,'result.json');
 const source={candidate:root,files:{'vendor/fixture.js':hash(path.join(root,'vendor/fixture.js')),'package-lock.json':hash(path.join(root,'package-lock.json'))}};
 fs.writeFileSync(manifestFile,JSON.stringify(source));
 const result={publicBuildingAcceptancePassed:true,mode:'public',profile:'cottage',version:'1.21.8',seed:'123',initial:{clientInventory:[]},task:{status:'completed',intent:'build_furnished_house',plan}};
 fs.writeFileSync(resultFile,JSON.stringify(result));
 const qa={status:'PASS_FULL_QA_ONLY',nodeExitCode:0,manifestSha256:hash(manifestFile),sourceDigest,candidateRoot:root,sourceCount:2,sourceMismatch:[],nativeMismatch:[],nativeCount:1,counts:{tests:2,pass:2,fail:0,cancelled:0,skipped:0}};
 const whole={status:'CLOSED_RESULT_PASS_INDEPENDENT_SOURCE_NBT_MCA_RECHECK',integrityPassed:true,publicWholeHouseAcceptance:true,ownedJavaPidState:'ABSENT',originalNodeExitCode:0,source:{immutableManifestSha256:hash(manifestFile)},originalEvidence:{'result.json':hash(resultFile)},checks:{source:{passed:true},native:{passed:true}},criteria:Object.fromEntries(HOUSE_CRITERIA.map(name=>[name,true])),metadata:{seed:'123'}};
 whole.source.additionalSourceBaseline={fileCount:1,files:{[nativeFile]:hash(nativeFile)}};
 fs.writeFileSync(qaFile,JSON.stringify(qa));fs.writeFileSync(wholeAuditFile,JSON.stringify(whole));
 const args={runtimeRoot:root,catalogFile,approvalFile,candidateId:record.id,manifestFile,qaFile,wholeAuditFile,resultFile,registry,expectedHashes:{manifestFile:hash(manifestFile),qaFile:hash(qaFile),wholeAuditFile:hash(wholeAuditFile),resultFile:hash(resultFile)}};
 return{args,options,catalog,context,plan,record,qa,whole,source,dir,verifier,refresh(name,value){fs.writeFileSync(args[name],JSON.stringify(value));args.expectedHashes[name]=hash(args[name]);}};
}
test('trusted qualification enables a persisted candidate; fresh verifier and catalog retain approval after restart',t=>{
 const f=fixture(t);assert.equal(f.catalog.find(f.plan,f.context),null);
 assert.equal(approveHouseSkill(f.args).status,'enabled');
 const fresh=createSkillCatalog({...f.options,validateEvidence:createApprovedSkillVerifier({file:f.args.approvalFile,runtimeRoot:f.args.runtimeRoot})});
 assert.equal(fresh.find(f.plan,f.context).id,f.record.id);assert.equal(fresh.snapshot().records[f.record.id].evidence.universalTerrainReliability,false);
 fresh.revoke(f.record.id,'regression');assert.equal(fresh.find(f.plan,f.context),null);
});
test('removed, revoked, tampered or corrupt host approval disables retrieval immediately without rewriting files',t=>{
 const f=fixture(t);approveHouseSkill(f.args);const original=fs.readFileSync(f.args.approvalFile);
 const active=createSkillCatalog(f.options);assert.equal(active.find(f.plan,f.context).id,f.record.id);
 for(const edit of [s=>{delete s.approvals[f.record.id];},s=>{s.approvals[f.record.id].status='revoked';},s=>{s.approvals[f.record.id].sourceDigest='other';},s=>{s.approvals[f.record.id].evidenceDigest='forged';}]){
  const state=JSON.parse(original);edit(state);fs.writeFileSync(f.args.approvalFile,JSON.stringify(state));const before=fs.readFileSync(f.args.approvalFile);assert.equal(active.find(f.plan,f.context),null);assert.deepEqual(fs.readFileSync(f.args.approvalFile),before);
 }
 fs.writeFileSync(f.args.approvalFile,'{broken');assert.equal(active.find(f.plan,f.context),null);assert.equal(fs.readFileSync(f.args.approvalFile,'utf8'),'{broken');
});
test('a pinned-file mismatch rejects before approval or catalog mutation',t=>{
 const f=fixture(t),before=fs.readFileSync(f.args.catalogFile);fs.appendFileSync(f.args.qaFile,' ');
 assert.throws(()=>approveHouseSkill(f.args),{code:'skill_evidence_hash_mismatch'});assert.equal(fs.existsSync(f.args.approvalFile),false);assert.deepEqual(fs.readFileSync(f.args.catalogFile),before);
});
test('partial QA, source drift or a failed actual whole receipt cannot approve a candidate',t=>{
 for(const edit of [f=>{f.qa.counts.fail=1;f.refresh('qaFile',f.qa);},f=>{f.qa.sourceDigest='other';f.refresh('qaFile',f.qa);},f=>{f.whole.publicWholeHouseAcceptance=false;f.refresh('wholeAuditFile',f.whole);},f=>{f.whole.criteria.actualState=false;f.refresh('wholeAuditFile',f.whole);},f=>{fs.appendFileSync(path.join(f.args.runtimeRoot,'vendor/fixture.js'),'changed');}]){
  const f=fixture(t);edit(f);assert.throws(()=>approveHouseSkill(f.args));assert.equal(fs.existsSync(f.args.approvalFile),false);assert.equal(f.catalog.snapshot().records[f.record.id].status,'candidate');
 }
});
test('receipt for another candidate, version or profile cannot qualify the stored plan',t=>{
 const f=fixture(t),result=JSON.parse(fs.readFileSync(f.args.resultFile));result.task.plan.steps[0].args.phase='floor';f.refresh('resultFile',result);f.whole.originalEvidence['result.json']=hash(f.args.resultFile);f.refresh('wholeAuditFile',f.whole);
 assert.throws(()=>approveHouseSkill(f.args),{code:'skill_candidate_receipt_mismatch'});assert.equal(fs.existsSync(f.args.approvalFile),false);
});
test('unreadable approval store is preserved during attempted qualification',t=>{
 const f=fixture(t);fs.writeFileSync(f.args.approvalFile,'broken');assert.throws(()=>approveHouseSkill(f.args));assert.equal(fs.readFileSync(f.args.approvalFile,'utf8'),'broken');assert.equal(f.catalog.snapshot().records[f.record.id].status,'candidate');
});
test('game-like evidence success declarations cannot substitute for trusted host approval',t=>{
 const f=fixture(t);assert.equal(f.verifier(f.record.manifest,{success:true,approvalId:'guess'}),false);assert.throws(()=>f.catalog.validate(f.record.id,{success:true}),{message:'regression_evidence_not_verified'});
 assert.equal(fs.existsSync(f.args.approvalFile),false);
});
test('the agent default host verifier reloads approved parameterized skills without a supplied function or model call',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mc-default-approval-')),file=path.join(dir,'learning.json');
 const prior=process.env.MC_AGENT_LEARNING_PATH;process.env.MC_AGENT_LEARNING_PATH=file;
 let agent;
 t.after(()=>{agent?.dispose();if(prior===undefined)delete process.env.MC_AGENT_LEARNING_PATH;else process.env.MC_AGENT_LEARNING_PATH=prior;fs.rmSync(dir,{recursive:true,force:true});});
 const {createHeuristicPlanner}=require('../vendor/server/minecraft/commandPlanner'),{createMinecraftTaskAgent}=require('../vendor/server/minecraftTaskAgent'),{digest}=require('../vendor/server/minecraft/skillCatalog');
 const planner=createHeuristicPlanner({actionRegistry:registry}),sourceDigest=skillSourceDigest(path.resolve(__dirname,'..'));
 const approvalFile=`${file}.skill-approvals.json`,verify=createApprovedSkillVerifier({file:approvalFile});
 const catalog=createSkillCatalog({file:`${file}.skills.json`,registry,sourceDigest,validateEvidence:verify}),record=catalog.recordCandidate(planner('采五块木头'),{minecraftVersion:'1.21.8',dimension:'overworld'});
 const evidence={approvalId:'explicitly-modeled-host-receipt'};
 const nativeFile=require.resolve('vec3'),nativeFiles={'vec3/index.js':hash(nativeFile)};
 fs.writeFileSync(approvalFile,JSON.stringify({schemaVersion:1,approvals:{[record.id]:{status:'approved',manifestId:record.id,approvalId:evidence.approvalId,sourceDigest,minecraftVersion:'1.21.8',dimension:'overworld',nodeMajor:Number(process.versions.node.split('.')[0]),scope:{universalTerrainReliability:false},evidenceDigest:digest(evidence),nativeFiles}}}));
 catalog.validate(record.id,evidence);catalog.enable(record.id);
 let calls=0;agent=createMinecraftTaskAgent({appPaths:{appDataDir:dir},readConfig:()=>({mcExecutorMode:'experimental-autonomy'}),broadcast:()=>{},broadcastMinecraftError:()=>{},requestPlannerCompletion:async()=>{calls++;throw Error('model');}});
 const {EventEmitter}=require('node:events'),bot=new EventEmitter();bot.version='1.21.8';bot.game={dimension:'overworld'};agent.attachBot(bot);
 const fresh=planner('采十块木头');await agent.__testChooseLearnedTaskScript('采十块木头',fresh);
 assert.equal(fresh.scriptMeta.catalogSkillId,record.id);assert.equal(fresh.steps[0].args.count,10);assert.equal(calls,0);
 fs.writeFileSync(approvalFile,'broken');const rejected=planner('采五块木头');await agent.__testChooseLearnedTaskScript('采五块木头',rejected);assert.equal(rejected.scriptMeta?.catalogSkillId,undefined);assert.equal(calls,0);
});
test('package file changes require rejection on a fresh helper verifier rather than trusting unchanged lock declarations',t=>{
 const f=fixture(t);approveHouseSkill(f.args);fs.appendFileSync(path.join(f.args.runtimeRoot,'node_modules/fixture/native.js'),'changed');
 const fresh=createSkillCatalog({...f.options,validateEvidence:createApprovedSkillVerifier({file:f.args.approvalFile,runtimeRoot:f.args.runtimeRoot})});
 assert.equal(fresh.find(f.plan,f.context),null);
});
