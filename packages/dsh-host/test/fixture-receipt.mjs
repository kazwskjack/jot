import * as fs from 'node:fs';
const sleeper=new Int32Array(new SharedArrayBuffer(4));
/** Test-only observation artifact. Never use for native logs or admission writes.
 * A Windows reader can briefly deny replacement of this synthetic receipt. */
export function writeFixtureReceipt(path,value,{fs:io=fs,pause=ms=>Atomics.wait(sleeper,0,0,ms),attempts=10}={}){
 if(!Number.isSafeInteger(attempts)||attempts<1||attempts>10)throw TypeError('invalid fixture rename attempts');
 const temporary=path+'.new';io.writeFileSync(temporary,JSON.stringify(value));
 for(let i=0;i<attempts;i++){
  try{io.renameSync(temporary,path);return;}catch(error){
   if(!['EPERM','EACCES','EBUSY'].includes(error.code)||i===attempts-1)throw error;
   pause(10);
  }
 }
}
