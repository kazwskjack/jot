import {lstat,mkdir,realpath,rm} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startLocalBackend} from '../../../apps/desktop/backend.mjs';

const digestPattern=/^[a-f0-9]{64}$/;
function fail(code){throw new Error(code);}
function inside(parent,child){
 const rel=relative(parent,child);
 return rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel));
}
function overlaps(first,second){return inside(first,second)||inside(second,first);}
async function mustBeRegular(root,path){
 let cursor=root;
 for(const part of relative(root,path).split(sep)){
  if(!part||part==='.')continue;
  cursor=join(cursor,part);
  let info;try{info=await lstat(cursor);}catch{fail('desktop_update_candidate_release_invalid');}
  if(info.isSymbolicLink())fail('desktop_update_candidate_release_unsafe');
  if(cursor===path){if(!info.isFile())fail('desktop_update_candidate_release_invalid');}
  else if(!info.isDirectory())fail('desktop_update_candidate_release_invalid');
 }
}
function validCapabilities(value){
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&['agent','demo'].includes(value.mode)&&
  typeof value.csrf==='string'&&value.csrf.length>0&&value.conversation_modes&&typeof value.conversation_modes==='object'&&
  Array.isArray(value.tools)&&value.limits&&typeof value.limits==='object';
}

export async function startCandidateProbe({releaseRoot,probeRoot,manifestSha256,loadServer=specifier=>import(specifier),startBackend=startLocalBackend,fetchImpl=globalThis.fetch,signal,timeoutMs=5000}={}){
 if(typeof releaseRoot!=='string'||!isAbsolute(releaseRoot)||typeof probeRoot!=='string'||!isAbsolute(probeRoot)||
  !digestPattern.test(manifestSha256)||typeof loadServer!=='function'||typeof startBackend!=='function'||typeof fetchImpl!=='function'||
  !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)fail('desktop_update_candidate_probe_invalid');
 const requestedReleaseRoot=resolve(releaseRoot),requestedProbeRoot=resolve(probeRoot);
 if(overlaps(requestedReleaseRoot,requestedProbeRoot))fail('desktop_update_candidate_paths_overlap');
 let candidateRoot;
 try{
  candidateRoot=await realpath(requestedReleaseRoot);
  const info=await lstat(candidateRoot);if(!info.isDirectory()||info.isSymbolicLink())fail('desktop_update_candidate_release_invalid');
 }catch(error){if(error?.message?.startsWith('desktop_update_'))throw error;fail('desktop_update_candidate_release_invalid');}
 const entry=resolve(candidateRoot,'src','server.mjs');
 if(!inside(candidateRoot,entry))fail('desktop_update_candidate_release_invalid');
 await mustBeRegular(candidateRoot,entry);
 let probeExists;
 try{await lstat(requestedProbeRoot);probeExists=true;}catch(error){if(error?.code==='ENOENT')probeExists=false;else fail('desktop_update_probe_root_invalid');}
 if(probeExists)fail('desktop_update_probe_root_exists');
 try{await mkdir(dirname(requestedProbeRoot),{recursive:true});await mkdir(requestedProbeRoot,{recursive:false,mode:0o700});}
 catch(error){if(error?.code==='EEXIST')fail('desktop_update_probe_root_exists');fail('desktop_update_probe_root_invalid');}
 let created=true,backend=null,result=null,failure=null;
 try{
  const profileInfo=await lstat(requestedProbeRoot);
  if(!profileInfo.isDirectory()||profileInfo.isSymbolicLink())fail('desktop_update_probe_root_invalid');
  const moduleUrl=pathToFileURL(entry);moduleUrl.searchParams.set('jotManifest',manifestSha256);
  const candidateModule=await loadServer(moduleUrl.href);
  if(!candidateModule||typeof candidateModule.buildServer!=='function')fail('desktop_update_candidate_module_invalid');
  backend=await startBackend({buildServer:candidateModule.buildServer,userDataPath:requestedProbeRoot,publicRoot:join(candidateRoot,'dist'),signal});
  if(!backend||typeof backend.close!=='function'||typeof backend.origin!=='string')fail('desktop_update_candidate_backend_invalid');
  let origin;
  try{origin=new URL(backend.origin);}catch{fail('desktop_update_candidate_backend_invalid');}
  if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||
   !Number.isInteger(Number(origin.port))||Number(origin.port)<1||Number(origin.port)>65535)fail('desktop_update_candidate_backend_invalid');
  const healthUrl=backend.origin+'/api/capabilities',timeout=AbortSignal.timeout(timeoutMs),probeSignal=signal?AbortSignal.any([signal,timeout]):timeout;
  let response;
  try{response=await fetchImpl(healthUrl,{method:'GET',headers:{accept:'application/json'},signal:probeSignal,cache:'no-store',redirect:'error'});}
  catch{if(signal?.aborted)fail('desktop_update_cancelled');fail('desktop_update_candidate_health_failed');}
  if(!response||response.status!==200||response.ok===false)fail('desktop_update_candidate_health_failed');
  let capabilities;
  try{capabilities=await response.json();}catch{fail('desktop_update_candidate_health_failed');}
  if(!validCapabilities(capabilities))fail('desktop_update_candidate_health_failed');
  result=Object.freeze({healthy:true,releaseRoot:candidateRoot,manifestSha256,healthUrl,capabilities:Object.freeze({...capabilities})});
 }catch(error){failure=error;}
 finally{
  if(backend){try{await backend.close();}catch(error){if(!failure)failure=new Error('desktop_update_candidate_backend_close_failed',{cause:error});}}
  if(created){try{await rm(requestedProbeRoot,{recursive:true,force:true});}catch(error){if(!failure)failure=new Error('desktop_update_probe_cleanup_failed',{cause:error});}}
 }
 if(failure)throw failure;
 return result;
}
