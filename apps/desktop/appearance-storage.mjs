// Adapts PilotDeck 783499ff appearanceStorage/native preferences; AGPL-3.0.
import {constants} from 'node:fs';
import {open,lstat,realpath,rename,unlink} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {normalizeLightAppearance} from '../../packages/desktop/src/light-appearance.mjs';
const maxBytes=8192,noFollow=constants.O_NOFOLLOW??0;
const mode=value=>['system','light','dark'].includes(value);
const exact=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
export async function createDesktopAppearanceStore({userDataPath}={}){
 if(typeof userDataPath!=='string'||!isAbsolute(userDataPath))throw Error('desktop_appearance_path_invalid');
 const directory=await realpath(userDataPath),directoryInfo=await lstat(directory),file=join(directory,'desktop-appearance.json');
 let state={version:1,revision:0,themeMode:'system',lightAppearance:normalizeLightAppearance()},stored=false,writable=true,error=null,fingerprint=null,writing=null;
 const checkDirectory=async()=>{
  const info=await lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||info.dev!==directoryInfo.dev||info.ino!==directoryInfo.ino||!same(await realpath(directory),directory))throw Error('desktop_appearance_path_unsafe');
 };
 const readFile=async()=>{
  await checkDirectory();let handle;
  try{
   handle=await open(file,constants.O_RDONLY|noFollow);const info=await handle.stat(),entry=await lstat(file);
   if(!info.isFile()||info.nlink!==1||entry.isSymbolicLink()||entry.ino!==info.ino||entry.dev!==info.dev||info.size>maxBytes||!same(await realpath(file),file))throw Error('desktop_appearance_file_unsafe');
   const bytes=Buffer.alloc(maxBytes+1),result=await handle.read(bytes,0,bytes.length,0),after=await handle.stat();
   if(result.bytesRead!==info.size||after.size!==info.size||after.mtimeMs!==info.mtimeMs)throw Error('desktop_appearance_file_changed');
   return bytes.subarray(0,result.bytesRead);
  }catch(cause){if(cause.code==='ENOENT')return null;throw cause;}
  finally{await handle?.close();}
 };
 try{
  const bytes=await readFile();
  if(bytes){
   const value=JSON.parse(bytes.toString('utf8'));
   if(!exact(value,['version','revision','themeMode','lightAppearance'])||value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<1||!mode(value.themeMode)||
    !value.lightAppearance||typeof value.lightAppearance!=='object'||Array.isArray(value.lightAppearance)||![1,2].includes(value.lightAppearance.version))throw Error('desktop_appearance_corrupt');
   state={version:1,revision:value.revision,themeMode:value.themeMode,lightAppearance:normalizeLightAppearance(value.lightAppearance)};stored=true;fingerprint=hash(bytes);
  }
 }catch{writable=false;error='desktop_appearance_unavailable';}
 const read=()=>Object.freeze({protocol:1,revision:state.revision,stored,writable,error,themeMode:state.themeMode,lightAppearance:normalizeLightAppearance(state.lightAppearance)});
 const unchanged=async()=>{
  const bytes=await readFile();
  if((bytes?hash(bytes):null)!==fingerprint){writable=false;error='desktop_appearance_conflict';throw Error(error);}
 };
 const write=async(request,canCommit=()=>true)=>{
  if(!writable||writing)throw Error(writable?'desktop_appearance_busy':error);
  if(request.expectedRevision!==state.revision||state.revision>=Number.MAX_SAFE_INTEGER)throw Error('desktop_appearance_conflict');
  const next={version:1,revision:state.revision+1,themeMode:request.themeMode,lightAppearance:normalizeLightAppearance(request.lightAppearance)};
  if(!mode(next.themeMode))throw Error('desktop_appearance_invalid');
  const bytes=Buffer.from(JSON.stringify(next)+'\n');if(bytes.length>maxBytes)throw Error('desktop_appearance_invalid');
  const temporary=join(directory,'.desktop-appearance.'+process.pid+'.'+randomUUID()+'.tmp');
  const job=(async()=>{
   let handle,created=false;
   try{
    await unchanged();if(!canCommit())throw Error('desktop_window_unavailable');
    handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|noFollow,0o600);created=true;
    await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
    await unchanged();if(!canCommit())throw Error('desktop_window_unavailable');
    await rename(temporary,file);created=false;
    state=next;stored=true;fingerprint=hash(bytes);return read();
   }finally{
    await handle?.close().catch(()=>{});
    if(created)try{await checkDirectory();await unlink(temporary);}catch{}
   }
  })();writing=job;
  try{return await job;}finally{if(writing===job)writing=null;}
 };
 const flush=async()=>{
  if(!writing)return true;let timer;
  try{await Promise.race([writing.catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,1000);timer.unref?.();})]);return !writing;}
  finally{if(timer)clearTimeout(timer);}
 };
 return Object.freeze({read,write,flush});
}
