import {constants} from 'node:fs';
import {open,lstat,realpath,mkdir,unlink,rename} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
const protocol='jot.desktop.diagnostics.v1',prefix='{"protocol":"'+protocol+'",';
const kinds=new Set(['renderer-unresponsive','renderer-responsive','renderer-reload','session-start','session-closing','backend-start','backend-ready','backend-draining','backend-closed','backend-error','http-server-error','desktop-error','renderer-process-gone','records-dropped']);
const codes=new Set(['EACCES','ENOENT','EIO','EMFILE','ENOSPC','ETIMEDOUT','ECONNREFUSED','ECONNRESET','EADDRINUSE','EPIPE','FST_ERR_VALIDATION','FST_ERR_CTP_INVALID_MEDIA_TYPE','FST_ERR_CTP_INVALID_JSON_BODY','FST_ERR_CTP_BODY_TOO_LARGE','FST_ERR_NOT_FOUND','FST_ERR_REPLY_ALREADY_SENT','FST_ERR_BAD_STATUS_CODE','SQLITE_BUSY','SQLITE_LOCKED','SQLITE_FULL','SQLITE_IOERR']);
for(const code of ['SQLITE_CORRUPT','SQLITE_NOTADB','desktop_update_configuration_invalid','desktop_backend_address_invalid','desktop_update_active_release_unavailable','desktop_update_current_release_mismatch','desktop_host_supervisor_bootstrap_unavailable','desktop_help_logs_unavailable','desktop_help_logs_open_failed'])codes.add(code);
const exitReasons=new Set(['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed','integrity-failure']);
const errorTypes=new Set(['Error','TypeError','RangeError','SyntaxError','AbortError']);
const noFollow=constants.O_NOFOLLOW??0,maxBytes=1024*1024;
// One process owns one bounded writer after acquiring the existing instance lock.
export function createDesktopDiagnosticLog({userDataPath}={}){
 if(typeof userDataPath!=='string'||!isAbsolute(userDataPath))throw Error('desktop_log_root_invalid');
 let directory=null,file=null,queue=[],writing=null,accepting=true,failed=false,ready=false,dropped=0,checkedBackup=false;
 const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
 const ensureDirectory=async()=>{
  if(!directory){const root=await realpath(userDataPath);directory=join(root,'logs');try{await mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}file=join(directory,'desktop-host.jsonl');}
  const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||!same(await realpath(directory),directory))throw Error('desktop_log_path_unsafe');
 };
 const ownedFile=async(path,flags)=>{
  await ensureDirectory();const handle=await open(path,flags|noFollow,0o600);
  try{
   const info=await handle.stat(),entry=await lstat(path);
   if(!info.isFile()||info.nlink!==1||entry.isSymbolicLink()||entry.ino!==info.ino||entry.dev!==info.dev)throw Error('desktop_log_file_unsafe');
   if(info.size){const bytes=Buffer.alloc(128),read=await handle.read(bytes,0,bytes.length,0);if(!bytes.subarray(0,read.bytesRead).toString('utf8').startsWith(prefix))throw Error('desktop_log_file_unowned');}
   return {handle,size:info.size};
  }catch(error){await handle.close();throw error;}
 };
 const append=async line=>{
  await ensureDirectory();let target=await ownedFile(file,constants.O_RDWR|constants.O_CREAT|constants.O_APPEND);
  try{
   if(!checkedBackup){
    let old;try{old=await ownedFile(file+'.1',constants.O_RDONLY);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(old){const oversized=old.size>maxBytes;await old.handle.close();if(oversized)await unlink(file+'.1');}checkedBackup=true;
   }
   if(target.size>maxBytes){await target.handle.truncate(0);target.size=0;}
   if(target.size+Buffer.byteLength(line)>maxBytes){
    await target.handle.close();target=null;const backup=file+'.1';
    let old;try{old=await ownedFile(backup,constants.O_RDONLY);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(old){await old.handle.close();await unlink(backup);}
    await rename(file,backup);target=await ownedFile(file,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_APPEND);
   }
   await target.handle.writeFile(line);ready=true;
  }finally{await target?.handle.close();}
 };
 const line=(kind,detail={})=>{
  const record={protocol,time:new Date().toISOString(),kind};
  try{if(detail.error){record.error_type=errorTypes.has(detail.error.name)?detail.error.name:'Error';if(codes.has(detail.error.code))record.error_code=detail.error.code;else if(codes.has(detail.error.message))record.error_code=detail.error.message;}}catch{}
  if(kind==='renderer-process-gone'&&exitReasons.has(detail.reason))record.reason=detail.reason;
  if(Number.isInteger(detail.status)&&detail.status>=500&&detail.status<=599)record.status=detail.status;
  if(kind==='records-dropped'&&Number.isSafeInteger(detail.count)&&detail.count>0&&detail.count<=1000000000)record.count=detail.count;
  return JSON.stringify(record)+'\n';
 };
 const pump=()=>{
  if(writing||failed||!queue.length)return;
  writing=(async()=>{while(queue.length){if(dropped){const count=dropped;dropped=0;await append(line('records-dropped',{count}));}await append(queue.shift());}})()
   .catch(()=>{failed=true;ready=false;queue=[];}).finally(()=>{writing=null;if(queue.length&&!failed)pump();});
 };
 const record=(kind,detail)=>{
  if(!accepting||failed||!kinds.has(kind))return false;
  if(queue.length>=128){dropped=Math.min(dropped+1,1000000000);return false;}
  let value;try{value=line(kind,detail);}catch{return false;}if(Buffer.byteLength(value)>512)return false;queue.push(value);pump();return true;
 };
 const flush=async()=>{
  pump();if(!writing)return !failed;
  let timer;try{return await Promise.race([writing.then(()=>!failed&&!queue.length),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),750);timer.unref?.();})]);}finally{if(timer)clearTimeout(timer);}
 };
 const getFile=async()=>{
  if(!await flush()||!ready||failed||!file)return null;
  try{const result=await ownedFile(file,constants.O_RDONLY);await result.handle.close();return file;}catch{return null;}
 };
 const close=async()=>{if(accepting){record('session-closing');accepting=false;}await flush();};
 return Object.freeze({record,flush,getFile,close});
}
