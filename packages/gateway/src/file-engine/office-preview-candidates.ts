import {officePreviewEnvironmentSettings} from './office-preview-configuration.ts';
// Candidate locations follow pinned PilotDeck officePreview.js (783499ff).
// AGPL-3.0 notice retained in packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt.
import {opendir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,win32} from 'node:path';
import {fileEngineChildEnvironment} from './engine.ts';
import {probeOfficePreviewBinary} from './office-preview-binary.ts';
import type {OfficePreviewCandidates} from '../../contracts/types.ts';

export type OfficePreviewCandidateDirectory={root:string;pattern:RegExp;suffix:string[]};
export function officePreviewCandidateLocations(environment:NodeJS.ProcessEnv){
 const paths=new Set<string>();let truncated=false;
 const add=(value:string|undefined)=>{
  const candidate=value?.trim();if(!candidate)return;
  if(candidate.length>4096||/[\u0000-\u001f\u007f]/.test(candidate)){truncated=true;return;}
  paths.add(candidate);
 };
 add(environment.GENERAL_AGENT_LIBREOFFICE);add(environment.LIBREOFFICE_PATH);add(environment.SOFFICE_PATH);
 const directories:OfficePreviewCandidateDirectory[] = [];
 if(process.platform==='win32'){
  for(const root of new Set([environment.ProgramW6432,environment.ProgramFiles,environment['ProgramFiles(x86)'],'C:\\Program Files','C:\\Program Files (x86)'])){
   if(root)add(win32.join(root,'LibreOffice','program','soffice.com'));
  }
 }else if(process.platform==='darwin'){
  for(const path of ['/Applications/LibreOffice.app/Contents/MacOS/soffice','/opt/homebrew/bin/soffice','/usr/local/bin/soffice'])add(path);
  for(const root of ['/Applications',join(homedir(),'Applications')])directories.push({root,pattern:/^LibreOffice.*\.app$/i,suffix:['Contents','MacOS','soffice']});
 }else{
  for(const path of ['/usr/bin/soffice','/usr/bin/libreoffice','/usr/local/bin/soffice','/usr/local/bin/libreoffice','/snap/bin/libreoffice','/opt/libreoffice/program/soffice'])add(path);
  directories.push({root:'/opt',pattern:/^libreoffice/i,suffix:['program','soffice']});
 }
 // Keep fixed PATH launchers ahead of versioned installation directories.
 const pathLaunchers=[process.platform==='win32'?'soffice.com':'soffice','libreoffice'].filter(path=>!paths.has(path));
 for(const path of pathLaunchers)add(path);
 return {paths:[...paths],directories,truncated,pathLaunchers};
}

async function scanCandidates(environment:NodeJS.ProcessEnv,signal:AbortSignal):Promise<OfficePreviewCandidates>{
 const locations=officePreviewCandidateLocations(environment),paths=new Set(locations.paths);
 let truncated=locations.truncated;
 const directories=locations.directories;
 const add=(candidate:string)=>{
  if(candidate.length>4096||/[\u0000-\u001f\u007f]/.test(candidate)||paths.size>=32&&!paths.has(candidate)){truncated=true;return;}
  paths.add(candidate);
 };
 for(const directory of directories){
  signal.throwIfAborted();
  // Protocol1 keeps its original prefix limit; protocol2 continues through officePreviewCandidateBatches.
  const found:string[]=[];let count=0;
  try{
   const entries=await opendir(directory.root,{bufferSize:16});
   for await(const entry of entries){
    signal.throwIfAborted();
    if(entry.isDirectory()&&directory.pattern.test(entry.name))found.push(join(directory.root,entry.name,...directory.suffix));
    if(++count>=64){truncated=true;break;}
   }
  }catch(error){
   signal.throwIfAborted();
   if((error as NodeJS.ErrnoException).code!=='ENOENT')truncated=true;
  }
  for(const path of found.sort())add(path);
 }
 const candidates:OfficePreviewCandidates['candidates']=[],childEnvironment=fileEngineChildEnvironment(environment);
 for(const path of paths){
  signal.throwIfAborted();
  candidates.push(await probeOfficePreviewBinary(path,childEnvironment,signal));
 }
 signal.throwIfAborted();
 return {protocol:1,checkedAt:new Date().toISOString(),candidates,truncated,execution_authorized:false};
}

export function createOfficePreviewCandidateReader(readSettings=officePreviewEnvironmentSettings){
 let cached:{key:string;at:number;value:OfficePreviewCandidates}|undefined;
 let pending:{key:string;promise:Promise<OfficePreviewCandidates>;controller:AbortController}|undefined;
 let closed=false;
 return {
  async read(refresh=false):Promise<OfficePreviewCandidates>{
   if(closed)throw Error('office_preview_candidates_closed');
   const environment={...process.env,GENERAL_AGENT_LIBREOFFICE:readSettings().binaryPath||process.env.GENERAL_AGENT_LIBREOFFICE};
   const key=JSON.stringify([environment.GENERAL_AGENT_LIBREOFFICE,environment.LIBREOFFICE_PATH,environment.SOFFICE_PATH,environment.PATH,
    environment.PYTHONPATH,environment.ProgramW6432,environment.ProgramFiles,environment['ProgramFiles(x86)'],homedir()]);
   if(cached?.key===key&&Date.now()-cached.at<(refresh?1000:30000))return cached.value;
   if(pending){
    if(pending.key===key)return pending.promise;
    // Finish the cancelled probe before another scan can acquire a native process.
    const previous=pending;previous.controller.abort();await previous.promise.catch(()=>{});
    return this.read(refresh);
   }
   const controller=new AbortController(),promise=scanCandidates(environment,controller.signal);
   pending={key,promise,controller};
   try{
    const value=await promise;
    if(!closed&&!controller.signal.aborted)cached={key,at:Date.now(),value};
    return value;
   }finally{if(pending?.promise===promise)pending=undefined;}
  },
  close(){closed=true;pending?.controller.abort();cached=undefined;}
 };
}
