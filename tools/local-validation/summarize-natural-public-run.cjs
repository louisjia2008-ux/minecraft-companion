'use strict';
// Bounded read-only progress/failure summary. Complete logs remain untouched.
const fs=require('node:fs'),path=require('node:path');
const name=process.argv[2];
if(!/^[a-zA-Z0-9_-]+$/.test(name||''))throw Error('One existing run name required');
const run=path.join('./.minecraft-local-test/worlds',name);
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
let snapshot=null,latestTask=null;
const events=path.join(run,'events.jsonl');
if(fs.existsSync(events)){
 const fd=fs.openSync(events,'r');
 try{
  const size=fs.fstatSync(fd).size,length=Math.min(size,1024*1024),bytes=Buffer.alloc(length);
  const count=fs.readSync(fd,bytes,0,length,size-length);
  for(const line of bytes.subarray(0,count).toString('utf8').split('\n').reverse()){
   try{const event=JSON.parse(line);
    if(!snapshot&&event.type==='snapshot')snapshot=event;
    if(!latestTask&&event.type==='agent_event'&&event.event?.type==='mc_task_status')latestTask=event.event.task;
    if(snapshot&&latestTask)break;
   }catch{}
  }
 }finally{fs.closeSync(fd);}
}
if(!snapshot){
 const consoleFile=path.join('./.minecraft-local-test/evidence/estate-20261013',`${name}-console.log`);
 if(fs.existsSync(consoleFile)){
  const fd=fs.openSync(consoleFile,'r');try{
   const size=fs.fstatSync(fd).size,length=Math.min(size,65536),bytes=Buffer.alloc(length),count=fs.readSync(fd,bytes,0,length,size-length);
   for(const line of bytes.subarray(0,count).toString('utf8').split('\n').reverse())try{
    const row=JSON.parse(line);if(row.mode==='public'&&Number.isFinite(row.elapsedMs)&&row.position){
     snapshot={...row,task:{status:row.status,error:row.error||null,progressText:row.progress},
      inventory:Object.entries(row.inventory||{}).map(([name,count])=>({name,count})),observationSource:'bounded_runner_console_fallback'};break;
    }
   }catch{}
  }finally{fs.closeSync(fd);}
 }
}
const resultFile=path.join(run,'result.json'),result=fs.existsSync(resultFile)?json(resultFile):null;
const seedFile=path.join(run,'seed-allocation.json');
const inventory={};for(const item of snapshot?.inventory||[])inventory[item.name]=(inventory[item.name]||0)+item.count;
console.log(JSON.stringify({runName:name,seed:fs.existsSync(seedFile)?json(seedFile).seed:null,
 completed:!!result,wholePassed:result?.publicBuildingAcceptancePassed??null,
 elapsedMs:result?.elapsedMs??snapshot?.elapsedMs??null,
 status:result?.task?.status??snapshot?.task?.status??null,error:result?.task?.error??snapshot?.task?.error??null,
 step:result?.task?.currentStepIndex??latestTask?.currentStepIndex??null,
 phase:(result?.task||latestTask)?.plan?.steps?.[(result?.task||latestTask)?.currentStepIndex]?.args?.phase??null,
 progress:snapshot?.task?.progressText??null,
 position:snapshot?.position??null,health:snapshot?.health??null,food:snapshot?.food??null,inventory,
 actualSiteNodes:snapshot?.siteSearch?.graph?.actualRegisteredNodeCount??null,
 siteAdvances:snapshot?.siteSearch?.diagnostics?.advances??null,
 unmetCriteria:result?.unmetCriteria??null,serverStop:result?.stopped??null}));
