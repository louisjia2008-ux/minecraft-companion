'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const token='"type":"death"';
async function countDeathTokens(stream){
 let carry='',count=0;
 for await(const bytes of stream){const text=carry+bytes.toString('utf8');let at=0;
  while((at=text.indexOf(token,at))!==-1){count++;at+=token.length;}
  carry=text.slice(-(token.length-1));
 }
 return count;
}
async function countNativeDeaths(file){
 const source=fs.createReadStream(file,{highWaterMark:65536});
 const stream=file.endsWith('.gz')?source.pipe(zlib.createGunzip()):source;
 if(stream!==source)source.on('error',error=>stream.destroy(error));
 try{return await countDeathTokens(stream);}finally{source.destroy();if(stream!==source)stream.destroy();}
}
async function countPriorWorldDeaths(directory,currentRun){
 let count=0;
 for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.name===currentRun)continue;
  const file=path.join(directory,entry.name,'events.jsonl');
  if(fs.existsSync(file))count+=await countNativeDeaths(file);
  else if(fs.existsSync(file+'.gz'))count+=await countNativeDeaths(file+'.gz');
 }
 return count;
}
module.exports={countDeathTokens,countNativeDeaths,countPriorWorldDeaths};
