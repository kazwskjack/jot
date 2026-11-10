import {officePreviewEnvironmentSettings} from './office-preview-configuration.ts';
// Status/signature semantics adapted from pinned PilotDeck officePreviewStatus.ts.
// AGPL-3.0 notices are retained in packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt.
import {execFile} from 'node:child_process';
import {fileEngineChildEnvironment} from './engine.ts';
import type {OfficePreviewStatus,OfficePreviewBinaryStatus} from '../../contracts/types.ts';

export function probeOfficePreviewBinary(binaryPath:string,environment:Record<string,string>,signal:AbortSignal):Promise<OfficePreviewBinaryStatus>{
 return new Promise(resolve=>{
  execFile(binaryPath,['--version'],{env:environment,windowsHide:true,encoding:'utf8',
   timeout:2000,maxBuffer:4096,killSignal:'SIGKILL',signal},(error,stdout)=>{
   const version=typeof stdout==='string'?stdout.trim().replace(/\s+/g,' '):'';
   resolve(error?{binaryPath,available:false,reason:'probe_failed'}
    :/^LibreOffice [^\r\n]{1,180}$/.test(version)?{binaryPath,available:true,version}
    :{binaryPath,available:false,reason:'version_unconfirmed'});
  });
 });
}

export function createOfficePreviewStatusReader(readSettings=officePreviewEnvironmentSettings){
 let cached:{key:string;at:number;value:OfficePreviewStatus}|undefined;
 let pending:{key:string;promise:Promise<OfficePreviewStatus>;controller:AbortController}|undefined;
 let closed=false;
 return {
  async read(refresh=false):Promise<OfficePreviewStatus>{
   if(closed)throw Error('office_preview_status_closed');
   const {service,binaryPath:configuredBinaryPath}=readSettings();
   if(configuredBinaryPath.length>4096||configuredBinaryPath.includes('\0'))throw Error('office_preview_configuration_invalid');
   const environment=fileEngineChildEnvironment({...process.env,GENERAL_AGENT_LIBREOFFICE:configuredBinaryPath||process.env.GENERAL_AGENT_LIBREOFFICE}),binaryPath=environment.GENERAL_AGENT_LIBREOFFICE!;
   const key=JSON.stringify([service,configuredBinaryPath,binaryPath,environment.PATH]);
   // Coalesce refresh clicks during an active probe and its immediate result window.
   if(cached?.key===key&&Date.now()-cached.at<(refresh?1000:30000))return cached.value;
   if(pending?.key===key)return pending.promise;
   pending?.controller.abort();
   const controller=new AbortController();
   const promise=probeOfficePreviewBinary(binaryPath,environment,controller.signal).then(libreOffice=>({
    protocol:1 as const,service,configuredBinaryPath,
    rendererSignature:JSON.stringify([service,configuredBinaryPath,binaryPath]),checkedAt:new Date().toISOString(),
    supportedServices:['builtin','libreoffice'] as ['builtin','libreoffice'],libreOffice,execution_authorized:false as const,
   }));
   pending={key,promise,controller};
   try{
    const value=await promise;
    if(!closed&&!controller.signal.aborted&&pending?.promise===promise)cached={key,at:Date.now(),value};
    return value;
   }finally{if(pending?.promise===promise)pending=undefined;}
  },
  close(){closed=true;pending?.controller.abort();pending=undefined;cached=undefined;}
 };
}
