// Test-only status trace. Requests and responses still use the original fetch.
import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

const path=process.env.JOT_ACCEPTANCE_FETCH_TRACE;
const observationBarrier=process.env.JOT_ACCEPTANCE_OBSERVATION_BARRIER_DIR;
const barrierParticipants=Math.max(1,Number(process.env.JOT_ACCEPTANCE_OBSERVATION_BARRIER_PARTICIPANTS)||1);

if(path||observationBarrier){
 let barrierUsed=false;
 const original=globalThis.fetch;
 globalThis.fetch=async(...args)=>{
  const response=await original(...args);
  const url=new URL(typeof args[0]==='object'&&'url' in args[0]?args[0].url:String(args[0]));
  let error,nativeIdle;
  try{
   if(url.pathname.endsWith('/idle-observation')){
    const body=await response.clone().json();
    if(typeof body.native_idle==='string')nativeIdle=body.native_idle;
   }
   if(!response.ok){
    const body=await response.clone().json();
    if(typeof body.error==='string'&&/^[a-zA-Z_]+$/.test(body.error))error=body.error;
   }
  }catch{}
  if(observationBarrier&&!barrierUsed&&url.pathname.endsWith('/idle-observation')){
   barrierUsed=true;
   const filename=barrierParticipants===1?'arrived.json':`arrived-${process.pid}.json`;
   writeFileSync(join(observationBarrier,filename),JSON.stringify({path:url.pathname,status:response.status,pid:process.pid,...(process.env.JOT_ACCEPTANCE_WORKER_ID?{worker_id:process.env.JOT_ACCEPTANCE_WORKER_ID}:{}),...(nativeIdle?{native_idle:nativeIdle}:{})}));
   const deadline=Date.now()+25000;
   while(!existsSync(join(observationBarrier,'release'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
   if(!existsSync(join(observationBarrier,'release')))throw Error('fixture_observation_barrier_timeout');
  }
  try{if(path)appendFileSync(path,JSON.stringify({path:url.pathname,status:response.status,...(error?{error}:{}),...(nativeIdle?{native_idle:nativeIdle}:{})})+'\n');}catch{}
  return response;
 };
}
