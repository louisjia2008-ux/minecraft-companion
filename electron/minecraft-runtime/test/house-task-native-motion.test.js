'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{Vec3}=require('vec3'),{createHouseTaskNativeMotion}=require('../vendor/server/minecraft/houseTaskNativeMotion');
function fixture(t){let now=1000,active;const token={},lease={},client={},bot=Object.assign(new EventEmitter(),{_client:client,entity:{position:new Vec3(0,1,0)}}),task={status:'running',executionGeneration:3,cancellationToken:token,movementLease:lease};let defense=null,currentTask=task;active=lease;t.mock.method(Date,'now',()=>now);
 const frame={task,bot,client,token,lease,generation:3,deadline:10000},w=createHouseTaskNativeMotion({getBot:()=>bot,getTask:()=>currentTask,getDefense:()=>defense,isDefenseCurrent:d=>d===defense,isLeaseActive:l=>l===active},frame);t.after(w.close);
 const tick=()=>{now+=50;bot.entity.position.x+=.2;bot.emit('physicsTick');};return{w,frame,task,bot,token,tick,setDefense:d=>{defense=d;active=d?.lease||lease;},foreign:()=>{active={};},setTime:n=>{now=n;},replaceTask:()=>{currentTask={};}};}
test('owned native tick observations do not write task progress, arrival or a new absolute deadline',t=>{
 const f=fixture(t),before=JSON.stringify(f.task);f.tick();f.tick();assert.equal(f.w.lastObservedAt(),1100);assert.equal(JSON.stringify(f.task),before);assert.equal(f.frame.deadline,10000);
});
test('only the exact finite captured defense may hold the step watchdog',t=>{
 const f=fixture(t);f.setDefense({bot:f.bot,client:f.bot._client,task:f.task,workToken:f.token,previousLease:f.task.movementLease,runGeneration:3,deadline:2000,lease:{},finished:false});assert.equal(f.w.ownedDefense(),true);f.tick();f.tick();assert.ok(f.w.lastObservedAt()>0);
 f.setTime(2100);assert.equal(f.w.ownedDefense(),false);const before=f.w.lastObservedAt();f.tick();assert.equal(f.w.lastObservedAt(),before);assert.equal(f.frame.deadline,10000);
});
for(const reason of ['foreign','pause','replaceTask'])test(`native motion under ${reason} cannot refresh the old task witness`,t=>{
 const f=fixture(t);f.tick();f.tick();const before=f.w.lastObservedAt();if(reason==='pause')f.token.pauseRequested=true;else f[reason]();f.tick();f.tick();assert.equal(f.w.lastObservedAt(),before);assert.equal(f.w.ownedDefense(),false);
});

test('world126 slow native starting displacement is observable while submillimeter jitter is not',t=>{
 const f=fixture(t),before=JSON.stringify(f.task);f.bot.emit('physicsTick');
 f.setTime(1050);f.bot.entity.position.z+=.02;f.bot.emit('physicsTick');assert.equal(f.w.lastObservedAt(),1050);
 f.setTime(1100);f.bot.entity.position.z+=.0001;f.bot.emit('physicsTick');assert.equal(f.w.lastObservedAt(),1050);
 assert.equal(JSON.stringify(f.task),before);assert.equal(f.frame.deadline,10000);
});
