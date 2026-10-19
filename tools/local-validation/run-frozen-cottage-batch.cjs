'use strict';
// Host-only sequential verifier. Does not modify source, reuse seeds, or
// control any pre-existing server. All execution uses the sealed public runner.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn,execFileSync}=require('node:child_process');
const base='./.minecraft-local-test',ev=path.join(base,'evidence/estate-20261013');
const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].slice(2)]=process.argv[i+1];
const {manifest,qa,baseline,prefix}=args,start=Number(args.start),count=Number(args.count);
if(![manifest,qa,baseline,prefix].every(v=>path.isAbsolute(v||''))||!Number.isInteger(start)||!Number.isInteger(count)||count<1||count>3)throw Error('Absolute evidence paths and1..3 sequential runs required');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'),m=JSON.parse(fs.readFileSync(manifest)),q=JSON.parse(fs.readFileSync(qa)),native=JSON.parse(fs.readFileSync(baseline));
const expectedRunner='031ce350e6c410ff9008da661a987e8d0d586a44043c59f79046c1e436f292f8';
const anchor={manifest:hash(manifest),qa:hash(qa),baseline:hash(baseline),runner:expectedRunner};
const runner=path.join(base,'acceptance/natural-public-building-acceptance-v7-runtime-tick.cjs');
const receipt=prefix+'-receipt.json',rows=[];if(fs.existsSync(receipt))throw Error('Existing batch evidence');
function write(status){const temp=receipt+'.tmp';fs.writeFileSync(temp,JSON.stringify({schema:1,status,updatedAt:new Date().toISOString(),anchor,candidate:m.candidate,runs:rows,wholePasses:rows.filter(r=>r.wholePassed).length},null,2)+'\n',{flag:'wx'});fs.renameSync(temp,receipt);}
function verify(){
 if(hash(manifest)!==anchor.manifest||hash(qa)!==anchor.qa||hash(baseline)!==anchor.baseline||hash(runner)!==expectedRunner)throw Error('Pinned inputs changed');
 if(q.status!=='PASS_FULL_QA_ONLY'||q.manifestSha256!==anchor.manifest||q.candidateRoot!==m.candidate)throw Error('FullQA does not bind this candidate');
 for(const [f,h]of Object.entries(m.files))if(hash(path.join(m.candidate,f))!==h)throw Error('Frozen source changed');
 for(const [f,h]of Object.entries(native.files))if(hash(f)!==h)throw Error('Native dependency changed');
 const java=execFileSync('/bin/ps',['-axo','pid,comm'],{encoding:'utf8'}).split('\n').filter(l=>/\bjava$/i.test(l.trim()));if(java.length)throw Error('Existing Java process; no new server started');
}
let activeChild=null,stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;activeChild?.kill('SIGINT');});
function run(argv,fd){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,argv,{stdio:['ignore',fd,fd]});activeChild=child;child.once('error',reject);child.once('close',(code,signal)=>{if(activeChild===child)activeChild=null;resolve({code,signal});});});}
(async()=>{
 write('VERIFYING');
 for(let i=0;i<count;i++){
  await new Promise(resolve=>setImmediate(resolve));if(stopping)throw Error('Owned batch stop requested');
  verify();const number=start+i,name=`natural-public-cottage-self-${number}`,dir=path.join(base,'worlds',name),log=path.join(ev,name+'-console.log'),auditFile=path.join(ev,name+'-independent-closed.json');
  if(fs.existsSync(dir)||fs.existsSync(log)||fs.existsSync(auditFile))throw Error('Run name/evidence already exists');
  const row={number,name,status:'RUNNING',wholePassed:false,log};rows.push(row);write('RUNNING');console.log(JSON.stringify({event:'run_started',number,name}));
  const fd=fs.openSync(log,'wx',0o600);let exit;try{exit=await run([runner,'--accept-eula','--run-name',name,'--profile','cottage','--timeout-ms','7200000','--runtime-root',m.candidate],fd);}finally{fs.closeSync(fd);}
  row.nodeExit=exit.code;row.signal=exit.signal;
  const resultFile=path.join(dir,'result.json');if(exit.signal||!Number.isInteger(exit.code)||!fs.existsSync(resultFile))throw Error('Abnormal/incomplete owned run; batch stopped');
  const result=JSON.parse(fs.readFileSync(resultFile));row.seed=String(result.seed);row.elapsedMs=result.elapsedMs;row.error=result.task?.error||result.fatalError||null;
  if(!result.stopped?.normal)throw Error('Owned server normal stop not confirmed');
  const afd=fs.openSync(prefix+`-audit-${number}.log`,'wx',0o600);let audited;try{audited=await run([path.join(base,'tools/audit-natural-public-building-closed-v3.cjs'),'--run-dir',dir,'--manifest',manifest,'--expected-manifest-sha',anchor.manifest,'--runner',runner,'--node-exit',String(exit.code),'--report',auditFile,'--extra-source-baseline',baseline],afd);}finally{fs.closeSync(afd);}
  if(audited.code!==0||audited.signal||!fs.existsSync(auditFile))throw Error('Independent audit did not close');
  const audit=JSON.parse(fs.readFileSync(auditFile));row.audit=auditFile;row.auditSHA=hash(auditFile);row.integrityPassed=audit.integrityPassed===true;
  row.wholePassed=result.publicBuildingAcceptancePassed===true&&audit.publicWholeHouseAcceptance===true&&row.integrityPassed;
  row.status=row.wholePassed?'WHOLE_PASS':'CLOSED_FAIL_PRESERVED';write(row.wholePassed?'STOPPED_ON_FIRST_WHOLE_PASS':'RUNNING');console.log(JSON.stringify({event:'run_closed',...row}));
  if(!row.integrityPassed)throw Error('Integrity not confirmed; batch stopped');
  if(row.wholePassed)return;
 }
 write('BOUNDED_BATCH_CLOSED_NO_WHOLE_PASS');
})().catch(error=>{try{write('STOPPED_ERROR');}catch{}console.error(JSON.stringify({event:'batch_stopped',error:error.message}));process.exitCode=1;});
