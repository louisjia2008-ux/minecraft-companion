'use strict';
// Human inspection only. All commands below target a separate copied world.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const base=path.resolve(__dirname,'..'),source=path.join(base,'worlds/cottage-development-from57');
const viewId=process.argv[2]||'01';assert.match(viewId,/^\d{2}$/);
const run=path.join(base,`client-1.21.8/observations/development-debug66-view-${viewId}`);
const settings=JSON.parse(fs.readFileSync(path.join(base,'installation.json'))),config=JSON.parse(fs.readFileSync(path.join(base,'client-1.21.8/launch-config.json')));
const events=fs.readFileSync(path.join(source,'development-sessions/debug66/events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const snapshot=events.findLast(e=>e.type==='snapshot'&&e.position);assert.ok(snapshot);
assert.equal(JSON.parse(fs.readFileSync(path.join(source,'development-sessions/debug66/result.json'))).closed.code,0);
assert.equal(fs.existsSync(run),false);fs.mkdirSync(run,{recursive:true});
const hashTree=dir=>{const r={};function visit(d){for(const e of fs.readdirSync(d,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const f=path.join(d,e.name);if(e.isDirectory())visit(f);else if(e.isFile())r[path.relative(dir,f)]=crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');}}visit(dir);return r;};
const before=hashTree(path.join(source,'world'));fs.cpSync(path.join(source,'world'),path.join(run,'world'),{recursive:true});
fs.copyFileSync(path.join(source,'eula.txt'),path.join(run,'eula.txt'));
let server,client,stopping=false,output='',serverExit;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const report={source,run,mode:'FROZEN_COPY_FOR_HUMAN_INSPECTION',originalWorldBefore:before,actorSnapshot:snapshot,commands:[]};
async function wait(pattern,cursor=0,ms=60000){const end=Date.now()+ms;while(!pattern.test(output.slice(cursor))){assert.ok(!serverExit&&!stopping&&Date.now()<end,'Observer readiness timeout');await sleep(100);}}
function command(text){assert.ok(server.stdin.writable&&!stopping);report.commands.push(text);server.stdin.write(text+'\n');}
async function stop(){if(stopping)return;stopping=true;if(server?.stdin.writable)server.stdin.write('stop\n');for(let i=0;i<600&&server&&!serverExit;i++)await sleep(100);report.serverExit=serverExit||null;report.originalWorldAfter=hashTree(path.join(source,'world'));report.originalWorldUnchanged=JSON.stringify(before)===JSON.stringify(report.originalWorldAfter);fs.writeFileSync(path.join(run,'result.json'),JSON.stringify(report,null,2));if(client?.exitCode===null)client.kill('SIGTERM');console.log(JSON.stringify({type:'observer_stopped',originalWorldUnchanged:report.originalWorldUnchanged,serverExit}));}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>stop().catch(console.error));
(async()=>{
 const probe=net.createServer();await new Promise((r,j)=>{probe.once('error',j);probe.listen(0,'127.0.0.1',r);});const port=probe.address().port;await new Promise(r=>probe.close(r));report.port=port;
 fs.writeFileSync(path.join(run,'server.properties'),`server-ip=127.0.0.1\nserver-port=${port}\nonline-mode=false\nenforce-secure-profile=false\ngamemode=spectator\nforce-gamemode=true\ndifficulty=normal\nspawn-protection=0\nview-distance=8\nsimulation-distance=3\nmax-players=1\nlevel-name=world\nenable-rcon=false\n`);
 server=spawn(settings.java,['-Xms512m','-Xmx1G','-jar',settings.minecraft.jar,'nogui'],{cwd:run,stdio:['pipe','pipe','pipe']});for(const s of [server.stdout,server.stderr])s.on('data',b=>{output+=b;fs.appendFileSync(path.join(run,'server.log'),b);});server.on('close',(code,signal)=>{serverExit={code,signal};if(!stopping)stop().catch(console.error);});server.on('error',e=>{console.error(e);stop().catch(console.error);});
 await wait(/Done \([^)]+\)! For help/);const cursor=output.length;command('tick freeze');await wait(/The game is frozen/,cursor,10000);
 const fd=fs.openSync(path.join(run,'client.log'),'wx');client=spawn(config.java,[...config.jvm,...config.game,'--quickPlayMultiplayer',`127.0.0.1:${port}`],{cwd:config.cwd,stdio:['ignore',fd,fd]});fs.closeSync(fd);client.on('close',()=>stop().catch(console.error));client.on('error',e=>{console.error(e);stop().catch(console.error);});
 await wait(/DeskPetView joined the game/);command('execute as DeskPetView run spectate');
 const p=snapshot.position;command(`tp DeskPetView ${(p.x+4).toFixed(4)} ${(p.y+5).toFixed(4)} ${(p.z+5).toFixed(4)} 140 30`);
 fs.writeFileSync(path.join(run,'ready.json'),JSON.stringify({...report,originalWorldBefore:undefined,clientPid:client.pid,originalWorldUnchanged:JSON.stringify(before)===JSON.stringify(hashTree(path.join(source,'world')))},null,2));
 console.log(JSON.stringify({type:'observer_ready',port,clientPid:client.pid,run,mode:report.mode,actorPosition:p,health:snapshot.health}));
})().catch(async e=>{console.error(e);report.error=e.message;await stop();process.exitCode=1;});
