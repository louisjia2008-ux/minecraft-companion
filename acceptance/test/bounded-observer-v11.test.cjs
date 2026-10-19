'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../natural-public-building-acceptance-v11-equipment-observer.cjs'),'utf8');
const body=source.slice(source.indexOf('function record(type,'),source.indexOf('function hashes()'));
test('long-run observer persists every original event while retaining only evidence consumed by final acceptance',t=>{
 const runDir=fs.mkdtempSync(path.join(os.tmpdir(),'deskpet-bounded-observer-'));t.after(()=>fs.rmSync(runDir,{recursive:true,force:true}));const events=[],json=JSON.stringify,clone=v=>JSON.parse(json(v));
 const record=Function('assert','fs','path','clone','json','created','events','runDir','startedAt',body+';return record;')(assert,fs,path,clone,json,true,events,runDir,Date.now());
 for(let i=0;i<2500;i++)record(i%2?'snapshot':'block_update',{sequence:i,original:{position:{x:i,y:65,z:3}}});
 assert.equal(events.length,0);
 for(const type of ['server_slot_ack','server_window_inventory','digging_completed','server_command','unexpected_provider_request'])record(type,{duringExecution:true,marker:type});
 assert.equal(events.length,5);assert.equal(events.find(e=>e.type==='server_command').duringExecution,true);
 const saved=fs.readFileSync(path.join(runDir,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(saved.length,2505);assert.equal(saved[2499].original.position.x,2499);assert.equal(saved[2499].sequence,2499);assert.equal(saved.at(-1).marker,'unexpected_provider_request');
});
