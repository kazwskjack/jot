import {spawn,type ChildProcess} from 'node:child_process';
import {isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ArtifactArchiveExecutorStatus} from '../../contracts/types.ts';

export interface ArtifactArchiveExecutor {
 readonly binding:{databasePath:string;fileRoot:string};
 start():void;
 close():Promise<void>;
 status():ArtifactArchiveExecutorStatus;
}

export function artifactArchiveExecutorFromEnvironment(env:NodeJS.ProcessEnv,databasePath:string,fileRoot:string):ArtifactArchiveExecutor|undefined {
 const enabled=env.GENERAL_AGENT_ARTIFACT_ARCHIVE_ENABLED,cleanup=env.GENERAL_AGENT_ARTIFACT_ARCHIVE_CLEANUP_ENABLED;
 if([enabled,cleanup].some(value=>value!==undefined&&value!=='true'&&value!=='false')
  ||cleanup==='true'&&enabled!=='true')throw Error('config_artifact_archive_enabled_invalid');
 if(enabled!=='true')return undefined;
 const executable=env.BAIDUPCS_EXECUTABLE?.trim()||'/usr/local/bin/BaiduPCS-Go';
 if(!isAbsolute(executable)||/[\u0000-\u001f\u007f]/.test(executable))throw Error('config_artifact_archive_executable_invalid');
 return new ManagedArtifactArchiveExecutor(databasePath,fileRoot,executable,cleanup==='true',env);
}

class ManagedArtifactArchiveExecutor implements ArtifactArchiveExecutor {
 readonly binding:{databasePath:string;fileRoot:string};
 private child:ChildProcess|undefined;
 private timer:ReturnType<typeof setTimeout>|undefined;
 private stopping=true;
 private attempts=0;
 private startedAt=0;
 private closing:Promise<void>|undefined;
 private readonly executable:string;
 private readonly cleanup:boolean;
 private readonly env:NodeJS.ProcessEnv;
 private observed:ArtifactArchiveExecutorStatus={mode:'managed',state:'stopped'};
 constructor(databasePath:string,fileRoot:string,executable:string,cleanup:boolean,env:NodeJS.ProcessEnv){
  this.binding=Object.freeze({databasePath:resolve(databasePath),fileRoot:resolve(fileRoot)});
  this.executable=executable;this.cleanup=cleanup;this.env={...env};
 }
 status():ArtifactArchiveExecutorStatus{return {...this.observed,mode:'managed',cleanup_enabled:this.cleanup};}
 start():void {
  if(!this.stopping||this.closing)return;
  this.stopping=false;this.launch();
 }
 private launch():void {
  if(this.stopping||this.child)return;
  this.observed={...this.observed,state:'starting'};this.startedAt=Date.now();
  try{
   const extension=import.meta.url.endsWith('.ts')?'ts':'js';
   const entry=fileURLToPath(new URL(`./archive-worker-main.${extension}`,import.meta.url));
   const child=spawn(process.execPath,[...(extension==='ts'?['--experimental-transform-types']:[]),entry],{
    env:{...this.env,GENERAL_AGENT_DB:this.binding.databasePath,GENERAL_AGENT_FILE_ROOT:this.binding.fileRoot,
     GENERAL_AGENT_ARTIFACT_ARCHIVE_ENABLED:'true',GENERAL_AGENT_ARTIFACT_ARCHIVE_CLEANUP_ENABLED:String(this.cleanup),BAIDUPCS_EXECUTABLE:this.executable},
    windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','ignore','ignore','ipc'],
   });
   this.child=child;
   child.on('message',value=>{
    if(this.child!==child||this.stopping||!value||typeof value!=='object')return;
    const state=value as {protocol?:unknown;type?:unknown;state?:unknown;last_started_at?:unknown;last_completed_at?:unknown};
    if(state.protocol!==1||state.type!=='artifact-archive-state'||typeof state.state!=='string'
     ||!['idle','restoring','archiving','cleaning','failed'].includes(state.state))return;
    for(const field of ['last_started_at','last_completed_at'] as const){
     if(state[field]!==undefined&&(typeof state[field]!=='string'||!/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(state[field] as string)))return;
    }
    this.observed={mode:'managed',state:state.state as ArtifactArchiveExecutorStatus['state'],
     ...(typeof state.last_started_at==='string'?{last_started_at:state.last_started_at}:{}),
     ...(typeof state.last_completed_at==='string'?{last_completed_at:state.last_completed_at}:{})};
   });
   child.once('error',()=>{if(this.child===child&&!this.stopping)this.observed={...this.observed,state:'failed'};});
   child.once('close',()=>{
    if(this.child!==child)return;
    this.child=undefined;
    if(!this.stopping&&process.platform!=='win32'&&child.pid){
     try{process.kill(-child.pid,'SIGKILL');}catch(error){if((error as {code?:string}).code!=='ESRCH')this.observed={...this.observed,state:'failed'};}
    }
    if(this.stopping){this.observed={...this.observed,state:'stopped'};return;}
    if(Date.now()-this.startedAt>=60000)this.attempts=0;
    this.observed={...this.observed,state:'failed'};this.restart();
   });
  }catch{this.observed={...this.observed,state:'failed'};this.restart();}
 }
 private restart():void {
  if(this.stopping)return;
  const delay=Math.min(300000,1000*2**Math.min(this.attempts,9));this.attempts+=1;
  this.timer=setTimeout(()=>{this.timer=undefined;this.launch();},delay);this.timer.unref();
 }
 close():Promise<void> {
  if(this.closing)return this.closing;
  this.stopping=true;if(this.timer)clearTimeout(this.timer);this.timer=undefined;
  const child=this.child;
  if(!child){this.observed={...this.observed,state:'stopped'};this.closing=Promise.resolve();return this.closing;}
  this.closing=new Promise<void>((resolveClose,rejectClose)=>{
   let killer:ChildProcess|undefined,workerClosed=false,killerClosed=true,failure:Error|undefined;
   const finalDeadline=setTimeout(()=>{failure=Error('artifact_archive_shutdown_timeout');this.observed={...this.observed,state:'failed'};rejectClose(failure);},40000);
   const finish=()=>{if(!workerClosed||!killerClosed)return;clearTimeout(finalDeadline);this.observed={...this.observed,state:'stopped'};if(failure)rejectClose(failure);else resolveClose();};
   const deadline=setTimeout(()=>{
    if(this.child!==child||child.exitCode!==null||child.signalCode!==null)return;
    if(process.platform==='win32'){
     killerClosed=false;
     killer=spawn(join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
     const killerDeadline=setTimeout(()=>{failure=Error('artifact_archive_process_tree_stop_failed');killer?.kill('SIGKILL');},10000);
     killer.once('error',()=>{failure=Error('artifact_archive_process_tree_stop_failed');});
     killer.once('close',code=>{clearTimeout(killerDeadline);killerClosed=true;if(code!==0&&!workerClosed)failure=Error('artifact_archive_process_tree_stop_failed');finish();});
    }else{
     try{if(child.pid)process.kill(-child.pid,'SIGKILL');}
     catch(error){if((error as {code?:string}).code!=='ESRCH')failure=Error('artifact_archive_process_tree_stop_failed');}
    }
   },30000);
   child.once('close',()=>{workerClosed=true;clearTimeout(deadline);finish();});
   if(child.connected)child.send({protocol:1,type:'artifact-archive-stop'},()=>{});
   else child.kill('SIGTERM');
  });
  return this.closing;
 }
}
