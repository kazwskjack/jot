// Adapts PilotDeck 783499ff appearanceStorage/native preferences; AGPL-3.0.
import {constants,openSync,readSync,fstatSync,lstatSync,realpathSync,closeSync} from 'node:fs';
import {applicationLanguage,isApplicationLanguage} from '../../packages/desktop/src/application-language.mjs';
import {normalizeInterfacePreferences} from '../../packages/desktop/src/interface-preferences.mjs';
import {open,lstat,realpath,rename,unlink,mkdir,opendir} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {appearanceImageSize} from '../../packages/desktop/src/appearance-image.mjs';
import {normalizeLightAppearance,isImageId,MAX_BACKGROUND_BYTES} from '../../packages/desktop/src/light-appearance.mjs';
const maxBytes=8192,noFollow=constants.O_NOFOLLOW??0;
const mode=value=>['system','light','dark'].includes(value);
const exact=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function parseAppearance(value,locale='en'){
 const keys=['version','revision','themeMode','lightAppearance'];
 if(value?.version===2||value?.version===3)keys.push('interfacePreferences');
 if(value?.version===3)keys.push('language');
 if(!exact(value,keys)||![1,2,3].includes(value.version)||!Number.isSafeInteger(value.revision)||value.revision<1||!mode(value.themeMode)||
  !value.lightAppearance||typeof value.lightAppearance!=='object'||Array.isArray(value.lightAppearance)||![1,2].includes(value.lightAppearance.version))throw Error('desktop_appearance_corrupt');
 const interfacePreferences=normalizeInterfacePreferences(value.interfacePreferences);
 if(value.version>=2&&JSON.stringify(interfacePreferences)!==JSON.stringify(value.interfacePreferences))throw Error('desktop_appearance_corrupt');
 if(value.version===3&&!isApplicationLanguage(value.language))throw Error('desktop_appearance_corrupt');
 return {version:3,language:applicationLanguage(value.language,locale),revision:value.revision,themeMode:value.themeMode,lightAppearance:normalizeLightAppearance(value.lightAppearance),interfacePreferences};
}
// Electron consumes this read-only snapshot before the first startup await; all writes still require the instance owner.
export function configureDesktopHardware(app,userDataPath){
 if(app.isReady()||typeof app.disableHardwareAcceleration!=='function')return Object.freeze({protocol:1,hardwareAcceleration:null});
 let hardwareAcceleration=true,handle;
 try{
  if(typeof userDataPath!=='string'||!isAbsolute(userDataPath))throw Error('desktop_appearance_path_invalid');
  const directory=realpathSync(userDataPath),directoryInfo=lstatSync(directory),file=join(directory,'desktop-appearance.json');
  if(!directoryInfo.isDirectory()||directoryInfo.isSymbolicLink())throw Error('desktop_appearance_path_unsafe');
  const entry=lstatSync(file);if(!entry.isFile()||entry.isSymbolicLink()||entry.nlink!==1||entry.size>maxBytes)throw Error('desktop_appearance_file_unsafe');
  handle=openSync(file,constants.O_RDONLY|noFollow|(constants.O_NONBLOCK??0));const info=fstatSync(handle);
  if(!info.isFile()||info.nlink!==1||entry.isSymbolicLink()||info.ino!==entry.ino||info.dev!==entry.dev||info.size>maxBytes||!same(realpathSync(file),file))throw Error('desktop_appearance_file_unsafe');
  const bytes=Buffer.alloc(maxBytes+1),length=readSync(handle,bytes,0,bytes.length,0),after=fstatSync(handle),last=lstatSync(file),dir=lstatSync(directory);
  if(length!==info.size||after.size!==info.size||after.mtimeMs!==info.mtimeMs||last.isSymbolicLink()||last.ino!==info.ino||last.dev!==info.dev||last.size!==info.size||last.mtimeMs!==info.mtimeMs||last.nlink!==1||dir.ino!==directoryInfo.ino||dir.dev!==directoryInfo.dev||!same(realpathSync(directory),directory))throw Error('desktop_appearance_file_changed');
  hardwareAcceleration=parseAppearance(JSON.parse(bytes.subarray(0,length).toString('utf8'))).interfacePreferences.hardwareAcceleration;
 }catch{}finally{if(handle!==undefined)try{closeSync(handle);}catch{}}
 if(!hardwareAcceleration)app.disableHardwareAcceleration();
 return Object.freeze({protocol:1,hardwareAcceleration});
}
export async function createDesktopAppearanceStore({userDataPath,decodeImage,language='en'}={}){
 if(typeof userDataPath!=='string'||!isAbsolute(userDataPath))throw Error('desktop_appearance_path_invalid');
 const directory=await realpath(userDataPath),directoryInfo=await lstat(directory),file=join(directory,'desktop-appearance.json');
 let state={version:3,language:applicationLanguage(language),revision:0,themeMode:'system',lightAppearance:normalizeLightAppearance(),interfacePreferences:normalizeInterfacePreferences()},stored=false,writable=true,error=null,fingerprint=null,writing=null;
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
   state=parseAppearance(JSON.parse(bytes.toString('utf8')),language);stored=true;fingerprint=hash(bytes);
  }
 }catch{writable=false;error='desktop_appearance_unavailable';}
 const read=()=>Object.freeze({protocol:3,language:state.language,revision:state.revision,stored,writable,error,themeMode:state.themeMode,lightAppearance:normalizeLightAppearance(state.lightAppearance),interfacePreferences:normalizeInterfacePreferences(state.interfacePreferences)});
 const unchanged=async()=>{
  const bytes=await readFile();
  if((bytes?hash(bytes):null)!==fingerprint){writable=false;error='desktop_appearance_conflict';throw Error(error);}
 };
 let pendingImageId=null,assetWork=null,assetDirectoryInfo=null,imageReads=0;const deleting=new Set(),staged=new Map();
 const imageKey=id=>typeof id==='string'?id.toLowerCase():null;
 const referenced=id=>imageKey(state.lightAppearance.background.imageId)===imageKey(id)||imageKey(pendingImageId)===imageKey(id);
 const purgeStages=()=>{for(const [id,live] of staged){let active=false;try{active=live()===true;}catch{}if(!active)staged.delete(id);}};
 const write=async(request,canCommit=()=>true)=>{
  if(!writable||writing)throw Error(writable?'desktop_appearance_busy':error);
  if(request.expectedRevision!==state.revision||state.revision>=Number.MAX_SAFE_INTEGER)throw Error('desktop_appearance_conflict');
  if(request.language!==undefined&&!isApplicationLanguage(request.language))throw Error('desktop_appearance_invalid');
  const next={version:3,language:request.language??state.language,revision:state.revision+1,themeMode:request.themeMode,lightAppearance:normalizeLightAppearance(request.lightAppearance),interfacePreferences:normalizeInterfacePreferences(request.interfacePreferences??state.interfacePreferences)};
  if(!mode(next.themeMode))throw Error('desktop_appearance_invalid');
  if(deleting.has(imageKey(next.lightAppearance.background.imageId)))throw Error('desktop_appearance_busy');
  // Initial legacy restoration may retain a missing identity; later new references must exist.
  const newReference=stored&&next.lightAppearance.background.imageId&&imageKey(next.lightAppearance.background.imageId)!==imageKey(state.lightAppearance.background.imageId);
  if(newReference&&assetWork)throw Error('desktop_appearance_image_busy');
  const bytes=Buffer.from(JSON.stringify(next)+'\n');if(bytes.length>maxBytes)throw Error('desktop_appearance_invalid');
  const temporary=join(directory,'.desktop-appearance.'+process.pid+'.'+randomUUID()+'.tmp');
  pendingImageId=next.lightAppearance.background.imageId;
  const job=(async()=>{
   let handle,created=false;
   try{
    await unchanged();if(!canCommit())throw Error('desktop_window_unavailable');
    if(newReference){const image=await imageFile(next.lightAppearance.background.imageId);await image.handle.close();}
    handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|noFollow,0o600);created=true;
    await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
    await unchanged();if(!canCommit())throw Error('desktop_window_unavailable');
    await rename(temporary,file);created=false;
    state=next;stored=true;fingerprint=hash(bytes);staged.delete(imageKey(next.lightAppearance.background.imageId));return read();
   }finally{
    await handle?.close().catch(()=>{});
    if(created)try{await checkDirectory();await unlink(temporary);}catch{}
   }
  })();writing=job;
  try{return await job;}finally{if(writing===job){writing=null;pendingImageId=null;}}
 };
 const imageDirectory=async(create=false)=>{
  await checkDirectory();const path=join(directory,'appearance-images');
  if(create)try{await mkdir(path,{mode:0o700});}catch(cause){if(cause.code!=='EEXIST')throw cause;}
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()||!same(await realpath(path),path)||assetDirectoryInfo&&(info.dev!==assetDirectoryInfo.dev||info.ino!==assetDirectoryInfo.ino))throw Error('desktop_appearance_image_path_unsafe');
  assetDirectoryInfo??=info;return path;
 };
 const imageFile=async id=>{
  if(!isImageId(id))throw Error('desktop_appearance_image_invalid');
  const directory=await imageDirectory();let path=join(directory,'jot-'+id),handle;
  try{
   try{handle=await open(path,constants.O_RDONLY|noFollow);}catch(cause){if(cause.code!=='ENOENT')throw cause;path=join(directory,id);handle=await open(path,constants.O_RDONLY|noFollow);}const info=await handle.stat(),entry=await lstat(path);
   if(!info.isFile()||info.nlink!==1||entry.isSymbolicLink()||entry.dev!==info.dev||entry.ino!==info.ino||info.size<=0||info.size>MAX_BACKGROUND_BYTES||!same(await realpath(path),path))throw Error('desktop_appearance_image_invalid');
   return {path,handle,info};
  }catch(cause){await handle?.close().catch(()=>{});throw cause;}
 };
 const mutateImage=action=>{
  if(assetWork||!writable)return Promise.reject(Error(writable?'desktop_appearance_image_busy':'desktop_appearance_unavailable'));
  const job=action();assetWork=job;return job.finally(()=>{if(assetWork===job)assetWork=null;});
 };
 const saveImage=(value,canCommit=()=>true)=>mutateImage(async()=>{
  if(!(value instanceof Uint8Array)||value.byteLength>MAX_BACKGROUND_BYTES||typeof decodeImage!=='function')throw Error('desktop_appearance_image_invalid');
  const bytes=Buffer.from(value),size=appearanceImageSize(bytes,'image/png',{stored:true});
  if(!size)throw Error('desktop_appearance_image_invalid');
  const decoded=decodeImage(bytes);if(decoded?.width!==size.width||decoded?.height!==size.height)throw Error('desktop_appearance_image_invalid');
  const directory=await imageDirectory(true),entries=await opendir(directory);let count=0,total=0,scanned=0;
  for await(const entry of entries){
   if(++scanned>128)throw Error('desktop_appearance_image_quota');
   if(isImageId(entry.name)||entry.name.startsWith('jot-')&&isImageId(entry.name.slice(4))){const info=await lstat(join(directory,entry.name));if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw Error('desktop_appearance_image_path_unsafe');count++;total+=info.size;}
  }
  purgeStages();
  if(count>=32||staged.size>=32||total+bytes.length>160*1024*1024)throw Error('desktop_appearance_image_quota');
  if(!canCommit())throw Error('desktop_window_unavailable');
  const id=randomUUID()+'.png',path=join(directory,'jot-'+id);let handle,created=false,keep=false;
  try{
   handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|noFollow,0o600);created=true;
   await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
   await imageDirectory();if(!canCommit())throw Error('desktop_window_unavailable');staged.set(imageKey(id),canCommit);keep=true;return id;
  }finally{await handle?.close().catch(()=>{});if(created&&!keep)try{await imageDirectory();await unlink(path);}catch{}}
 });
 const readImage=async(id,canCommit=()=>true)=>{
  if(imageReads>=4)throw Error('desktop_appearance_image_busy');imageReads++;let file;
  try{
   file=await imageFile(id);const bytes=Buffer.alloc(file.info.size+1),result=await file.handle.read(bytes,0,bytes.length,0),after=await file.handle.stat();
   if(result.bytesRead!==file.info.size||after.size!==file.info.size||after.mtimeMs!==file.info.mtimeMs)throw Error('desktop_appearance_image_changed');
   const value=bytes.subarray(0,result.bytesRead);
   if(!appearanceImageSize(value,id.toLowerCase().endsWith('.png')?'image/png':'image/webp',{stored:true})||!canCommit())throw Error('desktop_appearance_image_invalid');
   return new Uint8Array(value);
  }finally{await file?.handle.close().catch(()=>{});imageReads--;}
 };
 const deleteImage=(id,canCommit=()=>true)=>mutateImage(async()=>{
  if(!isImageId(id))throw Error('desktop_appearance_image_invalid');
  if(referenced(id))return false;deleting.add(imageKey(id));let file;
  try{
   await unchanged();if(referenced(id))return false;
   try{file=await imageFile(id);}catch(cause){if(cause.code==='ENOENT'){staged.delete(imageKey(id));return true;}throw cause;}
   await file.handle.close();file.handle=null;await imageDirectory();await unchanged();
   if(referenced(id))return false;if(!canCommit())throw Error('desktop_window_unavailable');
   await unlink(file.path);staged.delete(imageKey(id));return true;
  }finally{await file?.handle?.close().catch(()=>{});deleting.delete(imageKey(id));}
 });
 const recoverImages=(canCommit=()=>true)=>mutateImage(async()=>{
  await unchanged();purgeStages();let directory;
  try{directory=await imageDirectory();}catch(cause){if(cause.code==='ENOENT')return {protocol:1,removed:0,retained:0,scanned:0,complete:true};throw cause;}
  let scanned=0,removed=0,retained=0,complete=true;const entries=await opendir(directory);
  for await(const entry of entries){
   if(scanned>=128){complete=false;break;}scanned++;
   // Only the new reserved managed namespace is eligible; legacy/unknown entries are retained.
   if(!entry.name.startsWith('jot-')||!isImageId(entry.name.slice(4))){retained++;continue;}
   const id=entry.name.slice(4),key=imageKey(id);purgeStages();
   if(referenced(id)||staged.has(key)){retained++;continue;}
   deleting.add(key);let handle;
   try{
    const path=join(directory,entry.name);handle=await open(path,constants.O_RDONLY|noFollow);
    const info=await handle.stat(),entryInfo=await lstat(path);
    if(!info.isFile()||info.nlink!==1||info.size>MAX_BACKGROUND_BYTES||entryInfo.isSymbolicLink()||entryInfo.dev!==info.dev||entryInfo.ino!==info.ino||!same(await realpath(path),path)){retained++;continue;}
    await handle.close();handle=null;await imageDirectory();await unchanged();
    const last=await lstat(path);
    if(last.isSymbolicLink()||!last.isFile()||last.nlink!==1||last.ino!==info.ino||last.dev!==info.dev||last.size!==info.size||last.mtimeMs!==info.mtimeMs){retained++;continue;}
    if(referenced(id)||staged.has(key)){retained++;continue;}if(!canCommit())throw Error('desktop_window_unavailable');
    await unlink(path);removed++;
   }catch(cause){if(cause.code==='ENOENT')continue;if(!writable||!canCommit())throw cause;retained++;}
   finally{await handle?.close().catch(()=>{});deleting.delete(key);}
  }
  return {protocol:1,removed,retained,scanned,complete};
 });
 const flush=async()=>{
  if(!writing&&!assetWork)return true;let timer;
  try{await Promise.race([Promise.allSettled([writing,assetWork]),new Promise(resolve=>{timer=setTimeout(resolve,1000);timer.unref?.();})]);return !writing&&!assetWork;}
  finally{if(timer)clearTimeout(timer);}
 };
 return Object.freeze({read,write,saveImage,readImage,deleteImage,recoverImages,flush});
}
