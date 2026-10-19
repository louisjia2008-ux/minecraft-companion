'use strict';
// One narrowly scoped repair of our own already running development harness.
// Closes the temporary loopback inspector after removing the breakpoint.
const assert=require('node:assert/strict');
const pid=Number(process.argv[2]);assert.ok(Number.isSafeInteger(pid)&&pid>1);
(async()=>{
 const targets=await(await fetch('http://127.0.0.1:9229/json/list')).json();assert.equal(targets.length,1);
 const ws=new WebSocket(targets[0].webSocketDebuggerUrl),pending=new Map();let seq=0,paused;
 const pause=new Promise(r=>paused=r);
 ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){const p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(Error(message.error.message)):p.resolve(message.result);}}else if(message.method==='Debugger.paused')paused(message.params);};
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 let breakpoint;
 try{
  const actual=await call('Runtime.evaluate',{expression:'process.pid',returnByValue:true});assert.equal(actual.result.value,pid);
  await call('Debugger.enable');
  const b=await call('Debugger.setBreakpointByUrl',{urlRegex:'continue-cottage-development\\.cjs$',lineNumber:376});breakpoint=b.breakpointId;
  let timeout;const event=await Promise.race([pause,new Promise((_,j)=>{timeout=setTimeout(()=>j(Error('Owned harness breakpoint timeout')),45000);})]);clearTimeout(timeout);
  const frame=event.callFrames.find(f=>b.locations.some(l=>l.scriptId===f.location.scriptId));assert.ok(frame,'Only the owned harness frame can be repaired');
  const result=await call('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:'wake = () => {}; record("development_wakeup_repaired",{serverRetained:true}); setTimeout(()=>process.mainModule.require("node:inspector").close(),1000); "patched";',returnByValue:true});
  assert.equal(result.result.value,'patched');console.log(JSON.stringify({patched:true,pid,serverRestarted:false,gameCommands:false}));
 }finally{
  if(breakpoint)await call('Debugger.removeBreakpoint',{breakpointId:breakpoint});
  await call('Debugger.resume').catch(()=>{});ws.close();
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
