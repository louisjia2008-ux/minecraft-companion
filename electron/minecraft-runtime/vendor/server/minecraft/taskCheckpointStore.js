'use strict';
const fs=require('node:fs'),path=require('node:path');
// Durable task data only. A new process must acquire fresh tokens, leases,
// client identity and native world observations before explicit resume.
const fields=['taskId','source','userCommand','intent','createdAt','startedAt','currentStep','currentStepIndex','plan','executionGeneration',
 'automaticWorkRecovery','automaticSurvivalRecovery','stepCheckpoint','materialSupply','siteSearch','startupWood','logs','recoveryCount','maxRecoveryAttempts','aiMidTaskRevisionCount','replyText','planApproval'];
function createTaskCheckpointStore({file}){
 function save(task,identity){
  if(!identity||!task||!['running','paused'].includes(task.status)||!task.plan?.steps?.length)return false;
  const data=Object.fromEntries(fields.filter(k=>task[k]!==undefined).map(k=>[k,task[k]]));
  const text=JSON.stringify({schema:1,kind:'production_task_checkpoint',identity,savedAt:Date.now(),task:data});
  fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp';
  fs.writeFileSync(temp,text+'\n',{mode:0o600});fs.renameSync(temp,file);return true;
 }
 function load(identity){
  if(!identity||!fs.existsSync(file))return null;
  const text=fs.readFileSync(file,'utf8');if(text.length>33554432)throw Error('Task checkpoint exceeds finite size');
  const saved=JSON.parse(text),task=saved.task;
  if(saved.schema!==1||saved.kind!=='production_task_checkpoint'||saved.identity!==identity
    ||typeof task?.taskId!=='string'||!Array.isArray(task.plan?.steps)||!task.plan.steps.length
    ||!Number.isSafeInteger(task.currentStepIndex)||task.currentStepIndex<0||task.currentStepIndex>=task.plan.steps.length)
   throw Object.assign(Error('Saved task or world identity changed'),{code:'task_checkpoint_identity_changed'});
  return Object.fromEntries(fields.filter(k=>task[k]!==undefined).map(k=>[k,task[k]]));
 }
 function clear(){if(fs.existsSync(file))fs.unlinkSync(file);}
 return {save,load,clear};
}
module.exports={createTaskCheckpointStore};
