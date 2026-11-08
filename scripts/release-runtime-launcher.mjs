import {spawn} from 'node:child_process';
import {lstatSync,readFileSync} from 'node:fs';
import {basename,isAbsolute,resolve,toNamespacedPath} from 'node:path';
import {parseEnv} from 'node:util';
import {verifyRuntimeManifest} from './release-runtime-integrity.mjs';

const fail=code=>{throw new Error(code);};
const desktopRestoreNoncePattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const liveChildren=new WeakMap();
const exitProofs=new WeakMap();
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
function channelFrame(value){
 const seen=new Set();
 function check(item,depth=0){
  if(depth>20)fail('release_runtime_channel_frame_invalid');
  if(item===null||typeof item==='string'||typeof item==='boolean')return;
  if(typeof item==='number'&&Number.isFinite(item))return;
  if(!item||typeof item!=='object'||seen.has(item)||(!Array.isArray(item)&&Object.getPrototypeOf(item)!==Object.prototype))
   fail('release_runtime_channel_frame_invalid');
  seen.add(item);
  for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))){
   if(Array.isArray(item)&&key==='length')continue;
   if(key==='__proto__'||key==='authorityRef'||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable)fail('release_runtime_channel_frame_invalid');
   check(descriptor.value,depth+1);
  }
  seen.delete(item);
 }
 if(!value||Array.isArray(value)||typeof value!=='object')fail('release_runtime_channel_frame_invalid');
 check(value);const bytes=JSON.stringify(value);
 if(Buffer.byteLength(bytes)>64*1024)fail('release_runtime_channel_frame_invalid');
 return freeze(JSON.parse(bytes));
}
// This parent-local handle is transport evidence, never an owner/authorization provider.
export function queryVerifiedRuntimeChild(session,expectedChild){
 const held={state:'held',reason:'release_runtime_session_unavailable'};
 const facts=liveChildren.get(session);if(!facts||expectedChild!==undefined&&expectedChild!==facts.child)return held;
 return Object.freeze({state:facts.exitObserved?'exited':facts.failed?'unknown':facts.connected?'live':'disconnected',
  pid:facts.child.pid,exitObserved:facts.exitObserved,exitCode:facts.exitCode,signal:facts.signal});
}
export function queryVerifiedRuntimeExit(result){
 const facts=exitProofs.get(result);
 if(!facts)return Object.freeze({state:'held',exitObserved:false});
 return Object.freeze({state:facts.exitObserved?'exited':'unknown',exitObserved:facts.exitObserved,pid:facts.child.pid,
  exitCode:facts.exitCode,signal:facts.signal});
}
export function bindVerifiedRuntimeResult(result,{releaseId,manifestSha256}={}){
 const facts=exitProofs.get(result);
 if(!facts||releaseId!==basename(facts.releaseRoot)||manifestSha256!==facts.manifestSha256)fail('release_runtime_exit_proof_invalid');
 const bound=Object.freeze({...result,releaseId,manifestSha256});exitProofs.set(bound,facts);return bound;
}
function safeEntry(path){
 if(typeof path!=='string'||!path||path.length>4096||path.includes('\\')||path.startsWith('/')||/^[A-Za-z]:/.test(path)||/[\x00-\x1f\x7f]/.test(path))return false;
 return !path.split('/').some(part=>!part||part==='.'||part==='..');
}

export function verifiedRuntimeEnvironment({envFile,env}={}){
 let fileEnvironment={};
 if(envFile!==undefined){
  if(typeof envFile!=='string'||!envFile||!isAbsolute(envFile)||/[\x00-\x1f\x7f]/.test(envFile))fail('release_runtime_env_file_invalid');
  let raw;
  try{
   const path=toNamespacedPath(resolve(envFile)),info=lstatSync(path);
   if(!info.isFile()||info.isSymbolicLink())fail('release_runtime_env_file_invalid');
   raw=readFileSync(path,'utf8');
  }catch(error){
   if(error?.code!=='ENOENT')fail('release_runtime_env_file_invalid');
  }
  if(raw!==undefined){
   try{fileEnvironment=parseEnv(raw);}catch{fail('release_runtime_env_file_invalid');}
   if(Object.keys(fileEnvironment).some(key=>key.toUpperCase()==='NODE_OPTIONS'))fail('release_runtime_env_file_invalid');
  }
 }
 const result={...fileEnvironment,...process.env,...env};
 for(const key of Object.keys(result))if(key.toUpperCase()==='NODE_OPTIONS')delete result[key];
 return result;
}

export async function startVerifiedRuntime({root,cwd,expectedRuntimeSha256,expectedSourceManifestSha256,expectedTarget,entryRelative,args=[],envFile,env,
 signal,spawnRuntime=spawn,runtimeKind,desktopRestoreNonce,inheritedChannel=false}){
 if(typeof inheritedChannel!=='boolean'||inheritedChannel&&spawnRuntime!==spawn)fail('release_runtime_channel_unavailable');
 const verified=verifyRuntimeManifest({root,expectedRuntimeSha256,expectedSourceManifestSha256,expectedTarget});
 if(!safeEntry(entryRelative)||!verified.manifest.files.some(item=>item.path===entryRelative&&item.type==='file'))fail('release_runtime_entry_invalid');
 const verifiedKind=verified.target.runtimeKind??'node',chosenKind=runtimeKind??verifiedKind;
 if(chosenKind!==verifiedKind||!['node','electron'].includes(chosenKind)
  ||(chosenKind==='electron'&&(verified.target.profile!=='desktop-electron'||entryRelative!=='Jot.exe'))
  ||(chosenKind==='node'&&verified.target.profile==='desktop-electron'))fail('release_runtime_kind_mismatch');
 if(desktopRestoreNonce!==undefined&&(chosenKind!=='electron'||!desktopRestoreNoncePattern.test(desktopRestoreNonce)))
  fail('release_runtime_restore_nonce_invalid');
 if(!Array.isArray(args)||args.some(arg=>typeof arg!=='string'))fail('release_runtime_arguments_invalid');
 if(signal?.aborted)fail('release_runtime_start_cancelled');
 const entry=resolve(root,...entryRelative.split('/'));
 const workingDirectory=toNamespacedPath(resolve(cwd??root));
 const runtimeEnv=verifiedRuntimeEnvironment({envFile,env});
 delete runtimeEnv.JOT_DESKTOP_RESTORED_STARTUP_NONCE;
 if(desktopRestoreNonce!==undefined)runtimeEnv.JOT_DESKTOP_RESTORED_STARTUP_NONCE=desktopRestoreNonce;
 let child;
 const command=chosenKind==='electron'?entry:process.execPath,commandArgs=chosenKind==='electron'?args:[entry,...args];
 try{child=spawnRuntime(command,commandArgs,{cwd:workingDirectory,env:runtimeEnv,
  stdio:inheritedChannel?['inherit','inherit','inherit','ipc']:'inherit',serialization:'json',windowsHide:true});}
 catch{fail('release_runtime_start_failed');}
 const facts={child,releaseRoot:resolve(root),manifestSha256:expectedSourceManifestSha256,
  connected:inheritedChannel&&child.connected===true,exitObserved:false,exitCode:null,signal:null,failed:false};
 let resolveExit;const exited=new Promise(resolvePromise=>{resolveExit=resolvePromise;});
 const listeners=new Set();
 const disconnected=()=>{facts.connected=false;listeners.clear();};
 const closeChannel=()=>{disconnected();if(child.connected)try{child.disconnect();}catch{}};
 const message=value=>{let frame;try{frame=channelFrame(value);}catch{closeChannel();return;}
  for(const listener of listeners){try{listener(frame);}catch{closeChannel();return;}}};
 if(inheritedChannel){child.on('message',message);child.once('disconnect',disconnected);}
 child.once('exit',(code,childSignal)=>{facts.exitObserved=true;facts.exitCode=code;facts.signal=childSignal;disconnected();
  resolveExit(Object.freeze({state:'exited',pid:child.pid,exitCode:code,signal:childSignal}));});
 const closed=new Promise((resolvePromise,rejectPromise)=>{
  const stop=()=>{try{child.kill('SIGTERM');}catch{}};
  const cleanup=()=>{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);signal?.removeEventListener('abort',stop);};
  if(!inheritedChannel){
   if(signal?.aborted){stop();cleanup();return rejectPromise(new Error('release_runtime_start_cancelled'));}
   process.once('SIGINT',stop);process.once('SIGTERM',stop);signal?.addEventListener('abort',stop,{once:true});
  }
  child.once('error',()=>{facts.failed=true;closeChannel();cleanup();resolveExit({state:'unknown',reason:'release_runtime_start_failed'});
   rejectPromise(new Error('release_runtime_start_failed'));});
  child.once('close',(code,childSignal)=>{cleanup();disconnected();child.removeListener('message',message);
   const result={exitCode:code,signal:childSignal,runtimeSha256:verified.runtimeSha256,target:verified.target};
   if(inheritedChannel){result.target=freeze(structuredClone(verified.target));Object.freeze(result);exitProofs.set(result,facts);}
   resolvePromise(result);});
 });
 void closed.catch(()=>{});
 const channel=inheritedChannel?Object.freeze({
  async send(value){
   const frame=channelFrame(value);
   if(!facts.connected||facts.exitObserved||facts.failed||!child.connected)fail('release_runtime_channel_unavailable');
   return await new Promise((resolvePromise,rejectPromise)=>{
    try{child.send(frame,error=>{if(error){closeChannel();rejectPromise(new Error('release_runtime_channel_unavailable'));}else resolvePromise();});}
    catch{closeChannel();rejectPromise(new Error('release_runtime_channel_unavailable'));}
   });
  },
  subscribe(listener){if(typeof listener!=='function'||!facts.connected)fail('release_runtime_channel_unavailable');
   listeners.add(listener);return ()=>listeners.delete(listener);},
  close:closeChannel
 }):null;
 const verifiedLaunch=Object.freeze({child,pid:child.pid,execPath:command,entryPath:entry,releaseRoot:resolve(root),
  manifestSha256:expectedSourceManifestSha256,runtimeSha256:verified.runtimeSha256,target:freeze(structuredClone(verified.target))});
 const session=Object.freeze({verifiedLaunch,channel,exited,closed});liveChildren.set(session,facts);
 if(inheritedChannel&&(!Number.isSafeInteger(child.pid)||child.pid<1||!facts.connected)){closeChannel();fail('release_runtime_channel_unavailable');}
 return session;
}

export async function launchVerifiedRuntime(options){
 const binding=options?.launchBinding;
 if(binding!==undefined&&(!binding||typeof binding.attachVerifiedChild!=='function'))fail('release_runtime_supervisor_unavailable');
 const session=await startVerifiedRuntime({...options,inheritedChannel:binding!==undefined||options?.inheritedChannel===true});
 if(binding!==undefined){
  const launch=session.verifiedLaunch;
  const proof=Object.freeze({completeRuntimeProof:true,releaseId:basename(launch.releaseRoot),manifestSha256:launch.manifestSha256,
   runtimeSha256:launch.runtimeSha256,execPath:launch.execPath,releaseRoot:launch.releaseRoot,target:launch.target});
  // W10 owns authority/bootstrap/hello ordering. First two arguments match its public
  // attachVerifiedChild(actualChild, proof); the optional third stays parent-local.
  // Nothing here serializes authority, invents a Host instance or sends bootstrap on its own.
  try{await binding.attachVerifiedChild(launch.child,proof,session);}catch{session.channel.close();fail('release_runtime_supervisor_unavailable');}
 }
 return await session.closed;
}
