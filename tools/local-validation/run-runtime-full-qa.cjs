'use strict';
// Private read-only-source QA runner. All tests run; short native deadlines
// retain their real limits while avoiding concurrent planner CPU contention.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),{createRequire}=require('node:module');
const values={};for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i]?.startsWith('--')||!process.argv[i+1])throw Error('Expected --name value');values[process.argv[i].slice(2)]=process.argv[i+1];}
for(const key of ['manifest','native-baseline','prefix'])if(!path.isAbsolute(values[key]||''))throw Error(`Absolute ${key} required`);
const manifestFile=values.manifest,nativeFile=values['native-baseline'],prefix=values.prefix,manifest=JSON.parse(fs.readFileSync(manifestFile)),native=JSON.parse(fs.readFileSync(nativeFile)),root=manifest.candidate;
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const mismatches=(entries,resolve)=>Object.entries(entries).flatMap(([f,h])=>{try{return hash(resolve(f))===h?[]:[f];}catch{return[f];}});
const sourceBefore=mismatches(manifest.files,f=>path.join(root,f)),nativeBefore=mismatches(native.files,f=>f);
if(sourceBefore.length||nativeBefore.length)throw Error('Source/native mismatch before QA');
const files=fs.readdirSync(path.join(root,'test')).filter(f=>f.endsWith('.test.js')).sort().map(f=>`test/${f}`);
files.push('vendor/server/minecraftModules.test.js','vendor/server/minecraftAgentLearning.test.js');
const isolated=new Set(['test/mining-combat-coordination.test.js','test/house-creeper-escape.test.js','test/house-creeper-height-native.test.js']);
if([...isolated].some(f=>!files.includes(f)))throw Error('Missing native fixture file');
const groups=[{name:'batch',concurrency:4,files:files.filter(f=>!isolated.has(f))},{name:'native-isolated',concurrency:1,files:files.filter(f=>isolated.has(f))}];
if(new Set(groups.flatMap(g=>g.files)).size!==files.length)throw Error('Test coverage mismatch');
const qaFile=`${prefix}-qa.json`;if(fs.existsSync(qaFile)||groups.some(g=>fs.existsSync(`${prefix}-${g.name}.log`)))throw Error('Existing evidence must never be overwritten');
async function runGroup(group){
 const log=`${prefix}-${group.name}.log`,fd=fs.openSync(log,'wx',0o600),start=Date.now();
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--test',`--test-concurrency=${group.concurrency}`,...group.files],{cwd:root,stdio:['ignore',fd,fd]});
  child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
 }).finally(()=>fs.closeSync(fd));
 const output=fs.readFileSync(log,'utf8'),counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped'].map(k=>[k,Number(output.match(new RegExp(`^# ${k} (\\d+)$`,'m'))?.[1])]));
 return {...group,log,nodeExitCode:result.code,signal:result.signal,counts,durationMs:Date.now()-start,failedNames:output.split('\n').filter(l=>l.startsWith('not ok ')).slice(0,20)};
}
(async()=>{
 const start=Date.now(),results=[];for(const group of groups)results.push(await runGroup(group));
 const sourceMismatch=mismatches(manifest.files,f=>path.join(root,f)),nativeMismatch=mismatches(native.files,f=>f);
 const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped'].map(k=>[k,results.reduce((n,g)=>n+g.counts[k],0)]));
 const expected=Number(values['expected-tests']);
 const passed=Number.isSafeInteger(expected)&&counts.tests===expected&&counts.pass===expected&&!counts.fail&&!counts.cancelled&&!counts.skipped&&!sourceMismatch.length&&!nativeMismatch.length&&results.every(g=>g.nodeExitCode===0&&!g.signal&&Object.values(g.counts).every(Number.isFinite));
 const req=createRequire(path.join(root,'package.json'));
 const receipt={schema:1,createdAt:new Date().toISOString(),status:passed?'PASS_FULL_QA_ONLY':'FAIL_FULL_QA_PRESERVED',nodeExitCode:passed?0:1,counts,durationMs:Date.now()-start,sourceCount:Object.keys(manifest.files).length,sourceMismatch,nativeCount:Object.keys(native.files).length,nativeMismatch,concurrency:{batch:4,native:1},groups:results,whole:'NOT_RUN',manifestSha256:hash(manifestFile),candidateRoot:root,sourceDigest:req('./vendor/server/minecraft/skillSourceDigest').skillSourceDigest(root)};
 fs.writeFileSync(qaFile,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({qaFile,status:receipt.status,counts,sourceMismatch,nativeMismatch,groups:results.map(g=>({name:g.name,nodeExitCode:g.nodeExitCode,counts:g.counts,failedNames:g.failedNames,log:g.log}))}));process.exitCode=passed?0:1;
})().catch(error=>{console.error(JSON.stringify({status:'QA_RUNNER_ERROR',message:error.message}));process.exitCode=1;});
