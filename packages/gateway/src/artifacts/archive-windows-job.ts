import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export type ArchiveWindowsJob={close():Promise<void>};

// Call only from a dedicated archive process, before it starts any provider.
export async function ownArchiveWindowsJob(signal?:AbortSignal):Promise<ArchiveWindowsJob|undefined>{
 if(process.platform!=='win32')return undefined;
 signal?.throwIfAborted();
 const executable=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./archive-windows-job.ps1',import.meta.url)),
  '-OwnerProcessId',String(process.pid)],{windowsHide:true,stdio:['pipe','pipe','ignore']});
 let phase:'opening'|'attaching'|'attached'|'closing'|'released'='opening',buffer='',failure:unknown,closing:Promise<void>|undefined;
 let ready:()=>void=()=>{},rejectReady:(reason:unknown)=>void=()=>{};
 const attached=new Promise<void>((resolve,reject)=>{ready=resolve;rejectReady=reject;});
 const fail=(reason:unknown)=>{failure??=reason;rejectReady(failure);child.kill('SIGKILL');};
 const abort=()=>fail(signal?.reason??Error('artifact_archive_job_start_aborted'));
 const startup=setTimeout(()=>fail(Error('artifact_archive_job_start_timeout')),30000);
 const ended=new Promise<{code:number|null;released:boolean}>(resolveEnded=>{
  child.once('error',error=>fail(error));
  child.once('close',code=>{
   clearTimeout(startup);signal?.removeEventListener('abort',abort);
   const released=phase==='released';
   if(!released){
    failure??=Error('artifact_archive_job_close_unconfirmed');rejectReady(failure);
   }
   resolveEnded({code,released});
  });
 });
 child.stdin.on('error',error=>fail(error));
 child.stdout.setEncoding('utf8');
 child.stdout.on('data',(chunk:string)=>{
  buffer+=chunk;
  if(buffer.length>256){fail(Error('artifact_archive_job_protocol_invalid'));return;}
  let newline:number;
  while((newline=buffer.indexOf('\n'))>=0){
   const line=buffer.slice(0,newline).replace(/\r$/,'');buffer=buffer.slice(newline+1);
   if(phase==='opening'&&line==='ready'){
    phase='attaching';child.stdin.write('attach\n');
   }else if(phase==='attaching'&&line==='attached'){
    phase='attached';clearTimeout(startup);signal?.removeEventListener('abort',abort);ready();
   }else if(phase==='closing'&&line==='released')phase='released';
   else{fail(Error('artifact_archive_job_protocol_invalid'));return;}
  }
 });
 signal?.addEventListener('abort',abort,{once:true});
 if(signal?.aborted)abort();
 try{await attached;}
 catch(error){await ended;throw error;}
 return {close(){
  if(closing)return closing;
  closing=(async()=>{
   if(phase!=='attached')throw failure??Error('artifact_archive_job_close_unconfirmed');
   phase='closing';
   const deadline=setTimeout(()=>fail(Error('artifact_archive_job_close_timeout')),10000);
   child.stdin.end('disarm\n');
   try{
    const result=await ended;
    if(failure||result.code!==0||!result.released)throw failure??Error('artifact_archive_job_close_unconfirmed');
   }finally{clearTimeout(deadline);}
  })();
  return closing;
 }};
}
