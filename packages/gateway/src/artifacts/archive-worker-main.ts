import {openProductDatabase} from '../db/database.ts';
import {ArtifactArchiveService} from './archive-service.ts';
import {BaiduPcsClient} from './baidu-client.ts';
import {join} from 'node:path';

if(process.env.GENERAL_AGENT_ARTIFACT_ARCHIVE_ENABLED!=='true')throw Error('artifact_archive_executor_not_configured');
if(!process.connected||typeof process.send!=='function')throw Error('artifact_archive_executor_parent_required');
const databasePath=process.env.GENERAL_AGENT_DB?.trim(),root=process.env.GENERAL_AGENT_FILE_ROOT?.trim(),executable=process.env.BAIDUPCS_EXECUTABLE?.trim();
if(!databasePath||!root||!executable)throw Error('artifact_archive_executor_binding_required');
const cleanup=process.env.GENERAL_AGENT_ARTIFACT_ARCHIVE_CLEANUP_ENABLED==='true';
const control=new AbortController(),stop=()=>control.abort();
process.once('SIGINT',stop);process.once('SIGTERM',stop);
process.once('disconnect',stop);
if(!process.connected)stop();
process.on('message',value=>{if(value&&typeof value==='object'&&(value as {protocol?:unknown}).protocol===1&&(value as {type?:unknown}).type==='artifact-archive-stop')stop();});
let started:string|undefined,completed:string|undefined;
function report(state:'idle'|'restoring'|'archiving'|'cleaning'|'failed'){
 if(process.connected)process.send?.({protocol:1,type:'artifact-archive-state',state,
  ...(started?{last_started_at:started}:{}),...(completed?{last_completed_at:completed}:{})},()=>{});
}
function wait(ms:number):Promise<void>{
 return new Promise(resolveWait=>{
  if(control.signal.aborted){resolveWait();return;}
  const done=()=>{clearTimeout(timer);control.signal.removeEventListener('abort',done);resolveWait();};
  const timer=setTimeout(done,ms);control.signal.addEventListener('abort',done,{once:true});
 });
}
const db=openProductDatabase(databasePath);
try{
 const service=new ArtifactArchiveService(db,root,new BaiduPcsClient(executable,join(root,'sessions','archive-stage')));
 let lastCleanup=0;
 report('idle');
 while(!control.signal.aborted){
  let delay=30000;
  try{
   started=new Date().toISOString();report('restoring');
   const restored=await service.restorePending(undefined,control.signal,1);
   control.signal.throwIfAborted();report('archiving');
   const archived=await service.archivePending(undefined,control.signal,1);
   control.signal.throwIfAborted();
   let deleted=0;
   if(cleanup&&!restored.failed&&!archived.failed&&Date.now()-lastCleanup>=3600000){
    report('cleaning');deleted=service.cleanupVerified(new Date(),24).deleted;lastCleanup=Date.now();
   }
   completed=new Date().toISOString();
   report(restored.failed||archived.failed?'failed':'idle');
   if(!restored.failed&&!archived.failed&&(restored.restored||archived.verified||deleted))delay=10;
  }catch{if(control.signal.aborted)break;report('failed');}
  await wait(delay);
 }
}finally{
 db.close();
 if(process.connected){
  await new Promise<void>(resolveDrained=>process.send?.({protocol:1,type:'artifact-archive-drained'},()=>resolveDrained()));
  if(process.connected)process.disconnect();
 }
}
