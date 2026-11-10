import {randomBytes} from 'node:crypto';
import {opendir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {officePreviewCandidateLocations} from './office-preview-candidates.ts';
import {officePreviewEnvironmentSettings} from './office-preview-configuration.ts';
import {fileEngineChildEnvironment} from './engine.ts';
import {probeOfficePreviewBinary} from './office-preview-status.ts';
import type {OfficePreviewCandidatePage} from '../../contracts/types.ts';

type Batch={paths:string[];truncated:boolean};
async function* candidateBatches(environment:NodeJS.ProcessEnv,signal:AbortSignal):AsyncGenerator<Batch,void>{
 const locations=officePreviewCandidateLocations(environment),fixed=new Set(locations.paths);
 let truncated=locations.truncated;
 yield {paths:locations.paths,truncated};
 let paths:string[]=[],entries=0;
 for(const directory of locations.directories){
  signal.throwIfAborted();
  try{
   const handle=await opendir(directory.root,{bufferSize:16});
   for await(const entry of handle){
    signal.throwIfAborted();entries++;
    if(entry.isDirectory()&&directory.pattern.test(entry.name)){
     const path=join(directory.root,entry.name,...directory.suffix);
     if(path.length>4096||/[\u0000-\u001f\u007f]/.test(path))truncated=true;
     else if(!fixed.has(path)&&!paths.includes(path))paths.push(path);
    }
    if(paths.length>=32||entries>=64){
     yield {paths,truncated};paths=[];entries=0;
    }
   }
  }catch(error){
   signal.throwIfAborted();
   if((error as NodeJS.ErrnoException).code!=='ENOENT')truncated=true;
  }
 }
 if(paths.length||entries||truncated)yield {paths,truncated};
}

type Scan={owner:string;key:string;environment:NodeJS.ProcessEnv;controller:AbortController;
 iterator:AsyncGenerator<Batch,void>;buffer:Batch|undefined;seen:number;
 lastCursor:string|undefined;nextCursor:string|undefined;value:OfficePreviewCandidatePage|undefined;
 pending:Promise<OfficePreviewCandidatePage>|undefined};
const idleMs=5*60*1000;

export function createOfficePreviewCandidatePager(readSettings=officePreviewEnvironmentSettings){
 const scans=new Set<Scan>();let closed=false,activeWork:Promise<unknown>|undefined;
 const snapshot=()=>{
  const environment:NodeJS.ProcessEnv={};
  for(const name of ['PATH','PYTHONPATH','LIBREOFFICE_PATH','SOFFICE_PATH','ProgramW6432','ProgramFiles','ProgramFiles(x86)'])environment[name]=process.env[name];
  environment.GENERAL_AGENT_LIBREOFFICE=readSettings().binaryPath||process.env.GENERAL_AGENT_LIBREOFFICE;
  return {environment,key:JSON.stringify([environment,homedir()])};
 };
 const discard=async(scan:Scan)=>{
  scans.delete(scan);scan.controller.abort();
  await scan.pending?.catch(()=>{});
  await scan.iterator.return(undefined).catch(()=>{});
 };
 const prune=async()=>{
  for(const scan of scans)if(!scan.pending&&Date.now()-scan.seen>=idleMs)await discard(scan);
 };
 const perform=async(scan:Scan,cursor:string|undefined):Promise<OfficePreviewCandidatePage>=>{
  let batch=scan.buffer;
  if(!batch){const first=await scan.iterator.next();batch=first.done?{paths:[],truncated:false}:first.value;}
  const candidates:OfficePreviewCandidatePage['candidates']=[],environment=fileEngineChildEnvironment(scan.environment);
  for(const path of batch.paths){
   scan.controller.signal.throwIfAborted();
   candidates.push(await probeOfficePreviewBinary(path,environment,scan.controller.signal));
  }
  const next=await scan.iterator.next();scan.controller.signal.throwIfAborted();
  if(snapshot().key!==scan.key)throw Error('office_preview_candidate_cursor_stale');
  const nextCursor=next.done?undefined:randomBytes(32).toString('base64url');
  const value:OfficePreviewCandidatePage={protocol:2,checkedAt:new Date().toISOString(),candidates,
   truncated:batch.truncated,execution_authorized:false,...(nextCursor?{next_cursor:nextCursor}:{})};
  scan.buffer=next.done?undefined:next.value;scan.lastCursor=cursor;scan.nextCursor=nextCursor;
  scan.value=value;scan.seen=Date.now();return value;
 };
 let timer:ReturnType<typeof setInterval>|undefined;
 const maintenance=()=>{
  if(closed||activeWork)return;
  const work=prune();activeWork=work;
  void work.catch(()=>{}).finally(()=>{if(activeWork===work)activeWork=undefined;});
 };
 return {
  async read(owner:string,cursor?:string):Promise<OfficePreviewCandidatePage>{
   if(closed)throw Error('office_preview_candidates_closed');
   if(cursor!==undefined&&!/^[A-Za-z0-9_-]{43}$/.test(cursor))throw Error('office_preview_candidate_query_invalid');
   const current=snapshot();
   let scan=cursor?[...scans].find(item=>item.owner===owner&&(item.nextCursor===cursor||item.lastCursor===cursor)):undefined;
   if(cursor&&(!scan||Date.now()-scan.seen>=idleMs||scan.key!==current.key))throw Error('office_preview_candidate_cursor_stale');
   if(scan){
    scan.seen=Date.now();
    if(scan.lastCursor===cursor&&scan.value)return scan.value;
    if(scan.pending)return scan.pending;
   }
   if(activeWork)throw Error('office_preview_candidate_scan_busy');
   const run=async()=>{
    await prune();if(closed)throw Error('office_preview_candidates_closed');
    if(!scan){
     if(scans.size>=16){
      const oldest=[...scans].sort((a,b)=>a.seen-b.seen)[0];if(oldest)await discard(oldest);
     }
     if(closed)throw Error('office_preview_candidates_closed');
     const controller=new AbortController();
     scan={owner,key:current.key,environment:current.environment,controller,iterator:candidateBatches(current.environment,controller.signal),
      buffer:undefined,seen:Date.now(),lastCursor:undefined,nextCursor:undefined,value:undefined,pending:undefined};
     scans.add(scan);
     if(!timer){timer=setInterval(maintenance,30000);timer.unref();}
    }
    const selected=scan;
    const promise=perform(selected,cursor);selected.pending=promise;
    try{return await promise;}
    catch(error){selected.pending=undefined;await discard(selected);throw error;}
    finally{selected.pending=undefined;}
   };
   const work=run();activeWork=work;
   try{return await work;}finally{if(activeWork===work)activeWork=undefined;}
  },
  async close(){
   closed=true;if(timer)clearInterval(timer);
   for(const scan of scans)scan.controller.abort();
   await activeWork?.catch(()=>{});
   await Promise.all([...scans].map(discard));
  }
 };
}
