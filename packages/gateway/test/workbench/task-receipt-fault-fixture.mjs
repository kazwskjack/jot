import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export async function crash(f,request,stage){
 const scenario=join(dirname(f.fixtureConfig.databasePath),`crash-${stage}.json`);writeFileSync(scenario,JSON.stringify({config:f.fixtureConfig,request,stage}));
 const child=spawn(process.execPath,[fileURLToPath(new URL('./task-receipt-crash-child.mjs',import.meta.url)),scenario],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='',timedOut=false;child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 const timer=setTimeout(()=>{timedOut=true;child.kill();},15000);
 try{
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(timedOut,false,output);assert.equal(code,73,output);assert.match(output,new RegExp(`FIXTURE_CRASH:${stage}`));
 }finally{clearTimeout(timer);}
 return output;
}
