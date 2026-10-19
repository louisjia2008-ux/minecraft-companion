'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Readable}=require('node:stream'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib');
const {countDeathTokens,countPriorWorldDeaths}=require('./stream-native-deaths-v1.cjs');
for(let size=1;size<=32;size++)test(`native death token count survives every chunk boundary: ${size}`,async()=>{
 const input=Buffer.from('{"type":"spawn"}\n{"type":"death"}\n{"message":"受伤"}\n{"type":"death"}\n');const chunks=[];
 for(let i=0;i<input.length;i+=size)chunks.push(input.subarray(i,i+size));assert.equal(await countDeathTokens(Readable.from(chunks)),2);
});
test('prior native counts include compressed logs, exclude current run, and never double-count raw/gzip siblings',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-deaths-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const name of ['a','b','live'])fs.mkdirSync(path.join(dir,name));
 const death='{"type":"death"}\n';fs.writeFileSync(path.join(dir,'a','events.jsonl'),death);fs.writeFileSync(path.join(dir,'a','events.jsonl.gz'),zlib.gzipSync(death));
 fs.writeFileSync(path.join(dir,'b','events.jsonl.gz'),zlib.gzipSync(death.repeat(2)));fs.writeFileSync(path.join(dir,'live','events.jsonl'),death.repeat(4));
 assert.equal(await countPriorWorldDeaths(dir,'live'),3);
});
