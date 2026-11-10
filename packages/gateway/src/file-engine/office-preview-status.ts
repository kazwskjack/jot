// Status/signature semantics adapted from pinned PilotDeck officePreviewStatus.ts.
// AGPL-3.0 notice retained in packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt.
import {homedir} from 'node:os';
import {officePreviewEnvironmentSettings} from './office-preview-configuration.ts';
import {officePreviewCandidateBatches} from './office-preview-candidate-pages.ts';
import {probeOfficePreviewBinary} from './office-preview-binary.ts';
import {fileEngineChildEnvironment} from './engine.ts';
import type {OfficePreviewStatus,OfficePreviewBinaryStatus} from '../../contracts/types.ts';
export {probeOfficePreviewBinary} from './office-preview-binary.ts';

async function resolveBinary(configuredBinaryPath:string,environment:NodeJS.ProcessEnv,signal:AbortSignal):Promise<OfficePreviewBinaryStatus>{
 const childEnvironment=fileEngineChildEnvironment(environment);
 const probe=(path:string)=>probeOfficePreviewBinary(path,{...childEnvironment,GENERAL_AGENT_LIBREOFFICE:path},signal);
 if(configuredBinaryPath){
  const result=await probe(configuredBinaryPath);signal.throwIfAborted();return result;
 }
 let last:OfficePreviewBinaryStatus|undefined;
 for await(const batch of officePreviewCandidateBatches(environment,signal,true)){
  for(const path of batch.paths){
   signal.throwIfAborted();last=await probe(path);signal.throwIfAborted();
   if(last.available)return last;
  }
 }
 signal.throwIfAborted();
 if(!last)throw Error('office_preview_binary_unavailable');
 return last;
}

type Pending={key:string;promise:Promise<OfficePreviewStatus>;controller:AbortController;waiters:number;done:boolean};
export function createOfficePreviewStatusReader(readSettings=officePreviewEnvironmentSettings){
 let cached:{key:string;at:number;value:OfficePreviewStatus}|undefined,pending:Pending|undefined;
 let closed=false;
 const snapshot=()=>{
  const settings=readSettings(),environment:NodeJS.ProcessEnv={};
  if(!['builtin','libreoffice'].includes(settings.service)||settings.binaryPath.length>4096||/[\u0000-\u001f\u007f]/.test(settings.binaryPath))throw Error('office_preview_configuration_invalid');
  for(const name of ['PATH','PYTHONPATH','GENERAL_AGENT_FILE_ENGINE_TEMPLATE_ROOT','GENERAL_AGENT_LIBREOFFICE','LIBREOFFICE_PATH','SOFFICE_PATH','ProgramW6432','ProgramFiles','ProgramFiles(x86)'])environment[name]=process.env[name];
  return {settings,environment,key:JSON.stringify([settings.service,settings.binaryPath,environment,homedir()])};
 };
 return {
  async read(refresh=false,signal?:AbortSignal):Promise<OfficePreviewStatus>{
   signal?.throwIfAborted();if(closed)throw Error('office_preview_status_closed');
   const source=snapshot();
   if(cached?.key===source.key&&Date.now()-cached.at<(refresh?1000:30000))return cached.value;
   if(pending&&(pending.key!==source.key||pending.controller.signal.aborted)){
    const previous=pending;previous.controller.abort();await previous.promise.catch(()=>{});
    return this.read(refresh,signal);
   }
   if(!pending){
    const controller=new AbortController();let job:Pending;
    const promise=resolveBinary(source.settings.binaryPath,source.environment,controller.signal).then(libreOffice=>{
     controller.signal.throwIfAborted();
     if(snapshot().key!==source.key)throw Error('office_preview_configuration_changed');
     const value:OfficePreviewStatus={protocol:1,service:source.settings.service,configuredBinaryPath:source.settings.binaryPath,
      rendererSignature:JSON.stringify([source.settings.service,source.settings.binaryPath,libreOffice.binaryPath]),
      checkedAt:new Date().toISOString(),supportedServices:['builtin','libreoffice'],libreOffice,execution_authorized:false};
     if(!closed&&pending===job)cached={key:source.key,at:Date.now(),value};
     return value;
    }).finally(()=>{job.done=true;if(pending===job)pending=undefined;});
    job={key:source.key,promise,controller,waiters:0,done:false};pending=job;
   }
   const selected=pending;selected.waiters++;
   let abort:(()=>void)|undefined;
   try{
    return await new Promise<OfficePreviewStatus>((resolve,reject)=>{
     abort=()=>reject(signal?.reason??Error('office_preview_status_cancelled'));
     signal?.addEventListener('abort',abort,{once:true});
     selected.promise.then(resolve,reject);
     if(signal?.aborted)abort();
    });
   }finally{
    if(abort)signal?.removeEventListener('abort',abort);
    selected.waiters--;
    if(!selected.done&&selected.waiters===0)selected.controller.abort();
   }
  },
  invalidate(){cached=undefined;pending?.controller.abort(Error('office_preview_configuration_changed'));},
  async close(){
   closed=true;cached=undefined;const job=pending;job?.controller.abort();
   await job?.promise.catch(()=>{});
  }
 };
}
