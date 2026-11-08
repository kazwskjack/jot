import {randomUUID} from 'node:crypto';
import {isAbsolute,relative,resolve,sep,join,dirname,basename} from 'node:path';
import {mkdir,lstat} from 'node:fs/promises';
import {normalizeSupervisorScope,exact,canonical,supervisorDigest} from '../../packages/desktop/src/host-supervisor-contract.mjs';
import {createUpdateStateStore} from '../../packages/desktop/src/update-state.mjs';
import {bindDesktopHostSupervisorChannel} from '../../packages/desktop/src/host-supervisor-session.mjs';
import {createDesktopHostSupervisorProducer} from './host-supervisor-producer.mjs';
import {startLocalBackend} from './backend.mjs';

const fail=()=>{throw new Error('desktop_host_supervisor_bootstrap_unavailable');};
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&(process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b));
const overlaps=(a,b)=>{const inside=(x,y)=>{const r=relative(resolve(x),resolve(y));return !r||r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r);};return inside(a,b)||inside(b,a);};
const scopeKeys=['ownerRefId','sessionId','operationId','releaseId','manifestSha256','runtimeSha256','generation','restoredNonce'];
const targetKeys=['abi','arch','electronArchiveSha256','electronExecutableSha256','electronVersion','nodeVersion','platform','profile','runtimeKind'];
function validBootstrapTarget(target){
 return exact(target,targetKeys)&&target.runtimeKind==='electron'&&target.profile==='desktop-electron'&&
  typeof target.platform==='string'&&/^[a-z0-9_-]+$/i.test(target.platform)&&
  typeof target.arch==='string'&&/^[a-z0-9_-]+$/i.test(target.arch)&&
  typeof target.nodeVersion==='string'&&/^\d+\.\d+\.\d+$/.test(target.nodeVersion)&&
  typeof target.electronVersion==='string'&&/^\d+\.\d+\.\d+$/.test(target.electronVersion)&&
  exact(target.abi,['node','napi'])&&/^\d+$/.test(target.abi.node??'')&&/^\d+$/.test(target.abi.napi??'')&&
  supervisorDigest.test(target.electronArchiveSha256??'')&&supervisorDigest.test(target.electronExecutableSha256??'');
}

function validateBootstrap(frame,endpoint,testOnlyRuntime){
 let size;try{size=Buffer.byteLength(JSON.stringify(frame));}catch{fail();}
 if(size>64*1024||!exact(frame,['protocol','kind','scope','role','target','releaseRoot','probeRoot'])||frame.protocol!==1||
  frame.kind!=='desktop-host-supervisor-bootstrap'||!exact(frame.scope,scopeKeys)||!['host','probe'].includes(frame.role)||
  !isAbsolute(frame.releaseRoot??'')||!validBootstrapTarget(frame.target))fail();
 const scope=normalizeSupervisorScope({...frame.scope,instanceId:randomUUID()}),args=endpoint.argv??process.argv;
 const probeRequested=args.includes('--jot-runtime-probe');
 if(probeRequested!==(frame.role==='probe')||frame.role==='probe'&&scope.operationId===null||
  frame.role==='host'&&frame.probeRoot!==null||frame.role==='probe'&&(!isAbsolute(frame.probeRoot??'')||
   overlaps(frame.probeRoot,dirname(dirname(frame.releaseRoot)))))fail();
 if(!testOnlyRuntime){
  const installRoot=dirname(dirname(frame.releaseRoot)),target=frame.target;
  if(basename(dirname(frame.releaseRoot))!=='releases'||!samePath(join(installRoot,'releases',scope.releaseId),frame.releaseRoot)||
   !samePath(dirname(process.execPath),frame.releaseRoot)||!samePath(realpathSync(frame.releaseRoot),frame.releaseRoot)||
   target.runtimeKind!=='electron'||target.profile!=='desktop-electron'||target.platform!==process.platform||
   target.arch!==process.arch||target.nodeVersion!==process.versions.node||target.abi?.node!==process.versions.modules||
   target.abi?.napi!==process.versions.napi||target.electronVersion!==process.versions.electron)fail();
 }
 return Object.freeze({...JSON.parse(JSON.stringify(frame)),scope,endpoint});
}
import {realpathSync} from 'node:fs';

async function readFirstBootstrap(endpoint,timeoutMs){
 return await new Promise((resolvePromise,rejectPromise)=>{
  let settled=false;
  const cleanup=()=>{clearTimeout(timer);endpoint.off('message',onMessage);endpoint.off('disconnect',onDisconnect);endpoint.off('error',onDisconnect);};
  const finish=(error,value)=>{if(settled)return;settled=true;cleanup();error?rejectPromise(error):resolvePromise(value);};
  const onMessage=value=>finish(null,value),onDisconnect=()=>finish(new Error('desktop_host_supervisor_bootstrap_unavailable'));
  const timer=setTimeout(()=>finish(new Error('desktop_host_supervisor_bootstrap_unavailable')),timeoutMs);
  endpoint.on('message',onMessage);endpoint.on('disconnect',onDisconnect);endpoint.on('error',onDisconnect);
  if(endpoint.connected!==true)finish(new Error('desktop_host_supervisor_bootstrap_unavailable'));
 });
}

export async function consumeDesktopHostSupervisorBootstrap(_config=null,localFixture={}){
 const testOnlyRuntime=localFixture.testOnlyRuntime===true,endpoint=testOnlyRuntime?localFixture.endpoint:process;
 if(!endpoint)fail();
 const args=endpoint.argv??process.argv,probeRequested=args.includes('--jot-runtime-probe');
 const hasInheritedIpc=endpoint.connected===true&&typeof endpoint.send==='function'&&
  (testOnlyRuntime||endpoint.channel!==undefined&&endpoint.channel!==null);
 if(!hasInheritedIpc){if(probeRequested)fail();return null;}
 const timeoutMs=testOnlyRuntime&&Number.isSafeInteger(localFixture.timeoutMs)?localFixture.timeoutMs:5000;
 if(timeoutMs<1||timeoutMs>30000||typeof endpoint.on!=='function'||typeof endpoint.off!=='function')fail();
 let frame;try{frame=await readFirstBootstrap(endpoint,timeoutMs);}catch{fail();}
 try{return validateBootstrap(frame,endpoint,testOnlyRuntime);}catch{fail();}
}

export async function startDesktopHostSupervisorProbe(electron,{bootstrap,loadJotServer=()=>import('../../src/server.mjs')}={}){
 if(bootstrap?.role!=='probe'||!bootstrap.endpoint||!isAbsolute(bootstrap.probeRoot??'')||
  !isAbsolute(bootstrap.releaseRoot??'')||!exact(bootstrap.scope,['ownerRefId','sessionId','operationId','releaseId','manifestSha256','runtimeSha256','instanceId','generation','restoredNonce'])||
  !samePath(join(dirname(dirname(bootstrap.releaseRoot)),'releases',bootstrap.scope.releaseId),bootstrap.releaseRoot)||
  overlaps(bootstrap.probeRoot,dirname(dirname(bootstrap.releaseRoot))))fail();
 const installRoot=dirname(dirname(bootstrap.releaseRoot)),statePath=join(installRoot,'.jot-state','update-state.json');
 try{await lstat(bootstrap.probeRoot);fail();}catch(error){if(error?.code!=='ENOENT')throw error;}
 let backend,phase='starting';
 const lifecycle={get phase(){return phase;},async stop(){if(phase==='stopped')return;phase='stopping';await backend.close();phase='stopped';}};
 const journal=createUpdateStateStore({statePath});
 const producer=createDesktopHostSupervisorProducer({...bootstrap,installRoot,userDataRoot:bootstrap.probeRoot,
  getUserDataPath:()=>electron.app.getPath('userData'),journal,getBackend:()=>backend,getLifecycle:()=>lifecycle,
  exit:code=>electron.app.exit(code)});
 producer.verifyRuntime(); // Verify the W16-proven executable before creating the isolated profile.
 try{
  await mkdir(bootstrap.probeRoot,{recursive:false,mode:0o700});
  electron.app.setPath('userData',bootstrap.probeRoot);await electron.app.whenReady();
  const {buildServer}=await loadJotServer();
  backend=await startLocalBackend({buildServer,userDataPath:bootstrap.probeRoot,publicRoot:resolve(bootstrap.releaseRoot,'dist'),probeOnly:true});
  phase='ready';return bindDesktopHostSupervisorChannel({endpoint:bootstrap.endpoint,producer});
 }catch(error){await backend?.close().catch(()=>{});throw error;}
}
