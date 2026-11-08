import {randomUUID} from 'node:crypto';
import {dirname,resolve,join} from 'node:path';
import {realpathSync} from 'node:fs';
import {normalizeSupervisorScope,canonical,immutable,normalizeDrainReceipt,exact,supervisorDigest} from '../../packages/desktop/src/host-supervisor-contract.mjs';

const fail=()=>{throw new Error('desktop_host_supervisor_unavailable');};
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&(process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b));
const validElectronTarget=target=>exact(target,['abi','arch','electronArchiveSha256','electronExecutableSha256','electronVersion','nodeVersion','platform','profile','runtimeKind'])&&
 target.runtimeKind==='electron'&&target.profile==='desktop-electron'&&typeof target.platform==='string'&&/^[a-z0-9_-]+$/i.test(target.platform)&&
 typeof target.arch==='string'&&/^[a-z0-9_-]+$/i.test(target.arch)&&typeof target.nodeVersion==='string'&&/^\d+\.\d+\.\d+$/.test(target.nodeVersion)&&
 typeof target.electronVersion==='string'&&/^\d+\.\d+\.\d+$/.test(target.electronVersion)&&exact(target.abi,['node','napi'])&&
 /^\d+$/.test(target.abi.node??'')&&/^\d+$/.test(target.abi.napi??'')&&supervisorDigest.test(target.electronArchiveSha256??'')&&
 supervisorDigest.test(target.electronExecutableSha256??'');

// Runtime trust is inherited only from the parent that launched this verified child over W16's private IPC channel.
export function createDesktopHostSupervisorProducer({scope:base,role='host',target,installRoot,releaseRoot,userDataRoot,releaseOps,journal,
 getBackend,getLifecycle,getUserDataPath,exit}={},localFixture={}){
 if(!['host','probe'].includes(role)||typeof installRoot!=='string'||typeof releaseRoot!=='string'||
  typeof userDataRoot!=='string'||typeof getBackend!=='function'||typeof getLifecycle!=='function'||
  typeof exit!=='function'||typeof getUserDataPath!=='function'||typeof journal?.beginSupervisorDrain!=='function')fail();
 try{target=immutable(JSON.parse(JSON.stringify(target)));}catch{fail();}
 const scope=normalizeSupervisorScope({...base,instanceId:base?.instanceId??randomUUID()}),fixture=localFixture.testOnlyRuntime===true;
 const versions=Object.freeze({node:process.versions.node,electron:process.versions.electron??null,modules:process.versions.modules,napi:process.versions.napi});
 function processIdentity(){const current=getUserDataPath();if(!samePath(current,userDataRoot))fail();return Object.freeze({pid:process.pid,execPath:process.execPath,releaseRoot,userDataRoot:current,versions});}
 let drainRequest=null,channelLost=false,probeDisposed=false;
 function verifyRuntime(){try{
  if(!samePath(dirname(process.execPath),releaseRoot)||!samePath(realpathSync(process.execPath),process.execPath)||
   !samePath(realpathSync(releaseRoot),releaseRoot)||!fixture&&
   (!samePath(join(installRoot,'releases',scope.releaseId),releaseRoot)||!samePath(dirname(releaseRoot),join(installRoot,'releases'))))fail();
  if(target.platform!==process.platform||target.arch!==process.arch||target.nodeVersion!==process.versions.node||
   target.abi?.node!==process.versions.modules||target.abi?.napi!==process.versions.napi||
   fixture&&target.runtimeKind!=='node'||!fixture&&(!validElectronTarget(target)||target.runtimeKind!=='electron'||!process.versions.electron||
    target.profile!=='desktop-electron'||target.electronVersion!==process.versions.electron))fail();
  if(fixture&&releaseOps?.verifyInstalledRelease){
   const verified=releaseOps.verifyInstalledRelease({installRoot,releaseId:scope.releaseId,expectedManifestSha256:scope.manifestSha256,
    expectedRuntimeSha256:scope.runtimeSha256,expectedTarget:target});
   if(!verified||verified.then||verified.completeRuntimeProof!==true||verified.releaseId!==scope.releaseId||
    verified.manifestSha256!==scope.manifestSha256||verified.runtimeSha256!==scope.runtimeSha256||canonical(verified.target)!==canonical(target))fail();
  }
 }catch{fail();}}
 function assertScope(requestScope){if(canonical(normalizeSupervisorScope(requestScope))!==canonical(scope))fail();}
 function identity(){verifyRuntime();return immutable({scope,process:processIdentity(),target:JSON.parse(JSON.stringify(target))});}
 async function ready({scope:requested}={}){
  assertScope(requested);verifyRuntime();processIdentity();
  const backend=getBackend(),lifecycle=getLifecycle();
  if(channelLost||lifecycle?.phase!=='ready'||!backend||backend.draining===true&&!(role==='probe'&&backend.probeOnly===true))fail();
  const origin=new URL(backend.origin);
  if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)fail();
  if(scope.restoredNonce!==null){
   const restored=await journal.readRestoredStartup({operationId:scope.operationId});
   if(!restored||restored.nonce!==scope.restoredNonce||restored.generation!==scope.generation||!['attempted','healthy'].includes(restored.state)||
    restored.processContext?.pid!==process.pid||!samePath(restored.processContext?.execPath,process.execPath)||
    !samePath(restored.processContext?.releaseRoot,releaseRoot))fail();
  }
  verifyRuntime();if(channelLost||getLifecycle()?.phase!=='ready'||getBackend()!==backend||
   backend.draining===true&&!(role==='probe'&&backend.probeOnly===true))fail();
  return immutable({receipt:{releaseId:scope.releaseId,instanceId:scope.instanceId,origin:origin.origin+'/',readyAt:new Date().toISOString(),
   status:'ready',target:JSON.parse(JSON.stringify(target))},process:processIdentity()});
 }
 async function drain({scope:requested,requestId}={}){
  assertScope(requested);verifyRuntime();processIdentity();if(role!=='host'||scope.operationId===null)fail();
  const started=await journal.beginSupervisorDrain({scope,requestId});
  if(!started.dispatchAllowed){if(started.record.state==='stopped')return started.record.receipt;throw new Error('desktop_host_supervisor_unknown');}
  drainRequest=requestId;
  try{
   verifyRuntime();processIdentity();if(channelLost)fail();const backend=getBackend(),lifecycle=getLifecycle();
   if(lifecycle?.phase!=='ready'||typeof backend?.beginDrain!=='function'||backend.draining===true)fail();
   backend.beginDrain(); // Close admission before the first asynchronous close.
   if(backend.draining!==true)fail();
   await lifecycle.stop('desktop-supervisor-drain');
   if(lifecycle.phase!=='stopped'||backend.draining!==true||backend.closed!==true||!fixture&&backend.service?.store?.db?.isOpen!==false)fail();
   return normalizeDrainReceipt({releaseId:scope.releaseId,instanceId:scope.instanceId,lifecyclePhase:'stopped',
    backendClosedAt:new Date().toISOString()},scope);
  }catch{await journal.markSupervisorDrainUnknown({scope,requestId}).catch(()=>{});throw new Error('desktop_host_supervisor_unknown');}
 }
 async function disconnected(){channelLost=true;if(drainRequest)await journal.markSupervisorDrainUnknown({scope,requestId:drainRequest}).catch(()=>{});}
 async function disposeProbe({scope:requested}={}){
  assertScope(requested);verifyRuntime();if(role!=='probe'||probeDisposed||channelLost)fail();
  await getLifecycle().stop('desktop-supervisor-probe-dispose');
  if(getLifecycle().phase!=='stopped'||getBackend()?.closed!==true)fail();probeDisposed=true;return Object.freeze({disposed:true});
 }
 function exitAfterProbe(){if(!probeDisposed)fail();exit(0);}
 function exitAfterDrain(){if(!drainRequest||getLifecycle()?.phase!=='stopped')fail();exit(75);}
 return Object.freeze({identity,verifyRuntime,ready:async input=>{try{return await ready(input);}catch{fail();}},drain,disconnected,exitAfterDrain,disposeProbe,exitAfterProbe});
}
