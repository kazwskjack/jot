import {ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve,isAbsolute,relative,sep,join,dirname} from 'node:path';
import {lstat} from 'node:fs/promises';
import {canonical,exact,immutable,normalizeSupervisorScope,normalizeSupervisorEnvelope,normalizeDrainReceipt,supervisorUuid} from './host-supervisor-contract.mjs';
const sessions=new WeakSet();
const childStopGraceMs=1000;
const fail=()=>{throw new Error('desktop_host_supervisor_unavailable');};
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&(process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b));
const overlap=(a,b)=>{const inside=(x,y)=>{const r=relative(resolve(x),resolve(y));return !r||r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r);};return inside(a,b)||inside(b,a);};

// Endpoint is an already protected inherited IPC endpoint. This function never
// discovers a pipe/socket or treats process.channel alone as owner authority.
export function bindDesktopHostSupervisorChannel({endpoint,producer}={}){
 if(typeof endpoint?.on!=='function'||typeof endpoint?.off!=='function'||typeof endpoint?.send!=='function'||typeof producer?.identity!=='function')fail();
 const identity=producer.identity();let last=0,disposed=false;const seen=new Set();
 const sent=(value,after)=>{try{endpoint.send(value,error=>{if(error){void lost();return;}after?.();});}catch{void lost();}};
 async function lost(){if(disposed)return;disposed=true;endpoint.off('message',receive);endpoint.off('disconnect',lost);endpoint.off('error',lost);await producer.disconnected();}
 async function receive(input){
  if(disposed)return;
  let request;
  try{
   request=normalizeSupervisorEnvelope(input);
   if(request.sequence!==last+1||seen.has(request.requestId)||seen.size>=1024||canonical(request.scope)!==canonical(identity.scope)||!exact(request.payload,[]))fail();
   last=request.sequence;seen.add(request.requestId);
   const method=request.action==='ready'?producer.ready:request.action==='drain'?producer.drain:producer.disposeProbe;
   if(typeof method!=='function')fail();
   const result=await method({scope:request.scope,requestId:request.requestId});
   if(disposed)return;
   sent({...request,payload:{status:'completed',result}},request.action==='drain'?()=>producer.exitAfterDrain():request.action==='dispose'?()=>producer.exitAfterProbe():undefined);
  }catch{
   // No raw dependency errors, paths, credentials or arbitrary payloads in replies.
   if(request)sent({...request,payload:{status:'unknown',reason:'desktop_host_supervisor_unknown'}});
   await lost();
  }
 }
 endpoint.on('message',receive);endpoint.on('disconnect',lost);endpoint.on('error',lost);
 sent({protocol:1,kind:'desktop-host-supervisor-hello',...identity});
 return Object.freeze({dispose:lost});
}

export async function createDesktopHostSupervisorSession({authorityRef,operationScope,role='host',installRoot,userDataRoot,probeRoot=null,journal,timeoutMs=5000}={},localFixture={}){
 if(typeof authorityRef?.authorizeSupervisorSession!=='function'||typeof authorityRef?.assertSupervisorSession!=='function'||
  !['host','probe'].includes(role)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||
  !isAbsolute(installRoot??'')||!isAbsolute(userDataRoot??'')||overlap(installRoot,userDataRoot)||
  !exact(operationScope,['operationId','releaseId','manifestSha256','runtimeSha256','generation','restoredNonce'])||
  role==='probe'&&(!isAbsolute(probeRoot??'')||overlap(probeRoot,installRoot)||overlap(probeRoot,userDataRoot)||operationScope.restoredNonce!==null))fail();
 const authorizeRef=authorityRef.authorizeSupervisorSession.bind(authorityRef),assertRef=authorityRef.assertSupervisorSession.bind(authorityRef);
 const validated=normalizeSupervisorScope({...operationScope,ownerRefId:'pending-validation',sessionId:randomUUID(),instanceId:randomUUID()});
 installRoot=resolve(installRoot);userDataRoot=resolve(userDataRoot);
 let result;try{result=await authorizeRef({installRoot,userDataRoot,operationId:validated.operationId,releaseId:validated.releaseId,
  manifestSha256:validated.manifestSha256,runtimeSha256:validated.runtimeSha256,sessionId:validated.sessionId,role,probeRoot});}catch{fail();}
 if(!exact(result,['authorizationId','ownerRefId'])||typeof result.authorizationId!=='string'||!result.authorizationId||result.authorizationId.length>128)fail();
 const grant=Object.freeze({...result});
 const seeded=normalizeSupervisorScope({...validated,ownerRefId:grant.ownerRefId});
 const {instanceId:unused,...baseScope}=seeded;
 const profileRoot=role==='probe'?probeRoot:userDataRoot;
 const bootstrap=immutable({protocol:1,role,scope:baseScope,profileRoot});
 let child=null,scope=null,verified=null,sequence=0,closed=false,dead=false,expectedExit=false,childExitObserved=false,
  helloWait=null,launchChannel=null,unsubscribeChannel=null,stopPromise=null;
 const pending=new Map();
 async function assertAuthority(action){try{
  return await assertRef({authorizationId:grant.authorizationId,ownerRefId:grant.ownerRefId,
   sessionId:baseScope.sessionId,operationId:baseScope.operationId,action});
 }catch{fail();}}
 async function authorize(action){
  const result=await assertAuthority(action);
  if(result!==true||dead)fail();
 }
 async function unknown(){
  if(role==='host'&&scope)for(const [requestId,request]of pending)if(request.action==='drain')await journal?.markSupervisorDrainUnknown({scope,requestId}).catch(()=>{});
 }
 function waitChildExit(timeoutMs){
  if(!child||childExitObserved||child.exitCode!==null||child.signalCode!==null)return Promise.resolve(true);
  return new Promise(resolvePromise=>{
   const onExit=()=>finish(true),timer=setTimeout(()=>finish(false),timeoutMs);
   function finish(exited){clearTimeout(timer);child.off('exit',onExit);resolvePromise(exited);}
   child.once('exit',onExit);
  });
 }
 function stopChild(){
  if(stopPromise)return stopPromise;
  stopPromise=(async()=>{
   if(!child||childExitObserved||child.exitCode!==null||child.signalCode!==null)return true;
   try{launchChannel?.close();}catch{}
   try{child.kill('SIGTERM');}catch{}
   if(await waitChildExit(childStopGraceMs))return true;
   try{child.kill('SIGKILL');}catch{}
   return waitChildExit(childStopGraceMs);
  })();
  return stopPromise;
 }
 function lose(){if(dead)return;dead=true;void unknown();if(!expectedExit)void stopChild();helloWait?.reject(new Error('desktop_host_supervisor_unknown'));for(const request of pending.values())request.reject(new Error('desktop_host_supervisor_unknown'));}
 function validateIdentity(value){
  if(!exact(value,['pid','execPath','releaseRoot','userDataRoot','versions'])||value.pid!==child.pid||!samePath(value.execPath,verified.execPath)||!samePath(value.releaseRoot,verified.releaseRoot)||!samePath(value.userDataRoot,profileRoot)||
   !exact(value.versions,['node','electron','modules','napi'])||value.versions.node!==verified.target.nodeVersion||
   value.versions.modules!==verified.target.abi?.node||value.versions.napi!==verified.target.abi?.napi||
   (localFixture.testOnlyRuntime!==true&&(verified.target.runtimeKind!=='electron'||value.versions.electron!==verified.target.electronVersion)))fail();
 }
 function receive(value){
  try{
   if(!scope){
    if(!exact(value,['protocol','kind','scope','process','target'])||value.protocol!==1||value.kind!=='desktop-host-supervisor-hello')fail();
    const candidate=normalizeSupervisorScope(value.scope),{instanceId,...incoming}=candidate;
    if(canonical(incoming)!==canonical(baseScope)||canonical(value.target)!==canonical(verified.target))fail();
    validateIdentity(value.process);scope=candidate;helloWait?.resolve();return;
   }
   const reply=normalizeSupervisorEnvelope(value),request=pending.get(reply.requestId);
   if(!request||reply.sequence!==request.sequence||reply.action!==request.action||canonical(reply.scope)!==canonical(scope)||
    !exact(reply.payload,['status','result'])||reply.payload.status!=='completed')fail();
   request.resolve(reply.payload.result);
  }catch{lose();}
 }
 function bounded(action){return new Promise((resolvePromise,rejectPromise)=>{
  const timer=setTimeout(()=>rejectPromise(new Error('desktop_host_supervisor_unknown')),timeoutMs);
  action(value=>{clearTimeout(timer);resolvePromise(value);},error=>{clearTimeout(timer);rejectPromise(error);});
 });}
 async function attachVerifiedChild(actualChild,proof,{channel,sendBootstrap}={}){
  await authorize('attach');
  if(child||!(actualChild instanceof ChildProcess)||!Number.isSafeInteger(actualChild.pid)||!actualChild.connected||
   typeof channel?.send!=='function'||typeof channel?.subscribe!=='function'||typeof channel?.close!=='function'||
   proof?.completeRuntimeProof!==true||proof.releaseId!==baseScope.releaseId||proof.manifestSha256!==baseScope.manifestSha256||proof.runtimeSha256!==baseScope.runtimeSha256||
   !isAbsolute(proof.execPath??'')||!isAbsolute(proof.releaseRoot??'')||!samePath(actualChild.spawnfile,proof.execPath)||
   localFixture.testOnlyRuntime!==true&&(proof.target?.runtimeKind!=='electron'||!samePath(proof.releaseRoot,join(installRoot,'releases',baseScope.releaseId))||
    !samePath(dirname(proof.execPath),proof.releaseRoot)))fail();
  child=actualChild;verified=immutable(JSON.parse(JSON.stringify(proof)));launchChannel=channel;
  try{unsubscribeChannel=channel.subscribe(receive);}catch{fail();}if(typeof unsubscribeChannel!=='function')fail();
  child.once('exit',()=>{childExitObserved=true;});
  child.on('disconnect',lose);child.on('error',lose);
  child.once('close',()=>{closed=true;lose();});
  await bounded((resolvePromise,rejectPromise)=>{
   helloWait={resolve:resolvePromise,reject:rejectPromise};
   if(!sendBootstrap){rejectPromise(new Error('desktop_host_supervisor_unknown'));return;}
   Promise.resolve().then(()=>sendBootstrap(bootstrap)).catch(()=>rejectPromise(new Error('desktop_host_supervisor_unknown')));
  });
  await authorize('attach');return scope;
 }
 async function request(action,{signal}={}){
  await authorize(action);if(signal?.aborted||!child||!scope||!child.connected||closed||pending.size)fail();
  const requestId=randomUUID(),number=++sequence;
  let abort;
  try{
   const result=await bounded((resolvePromise,rejectPromise)=>{
    pending.set(requestId,{action,sequence:number,resolve:resolvePromise,reject:rejectPromise});
    abort=()=>rejectPromise(new Error('desktop_host_supervisor_unknown'));signal?.addEventListener('abort',abort,{once:true});
    try{Promise.resolve(launchChannel.send({protocol:1,requestId,sequence:number,action,scope,payload:{}})).catch(()=>rejectPromise(new Error('desktop_host_supervisor_unknown')));}catch{rejectPromise(new Error('desktop_host_supervisor_unknown'));}
   });
   const authorized=await assertAuthority(action);
   if(authorized!==true||action==='ready'&&dead)fail();return {result,requestId};
  }catch{
   if(action==='drain')await journal?.markSupervisorDrainUnknown({scope,requestId}).catch(()=>{});
   lose();throw new Error('desktop_host_supervisor_unknown');
  }finally{if(abort)signal?.removeEventListener('abort',abort);pending.delete(requestId);}
 }
 async function readReady(options){try{
  const {result}=await request('ready',options);
  if(!exact(result,['receipt','process']))fail();validateIdentity(result.process);
  const receipt=result.receipt;
  if(!exact(receipt,['releaseId','instanceId','origin','readyAt','status','target'])||receipt.releaseId!==scope.releaseId||receipt.instanceId!==scope.instanceId||
   receipt.status!=='ready'||canonical(receipt.target)!==canonical(verified.target)||!Number.isFinite(Date.parse(receipt.readyAt))||new Date(receipt.readyAt).toISOString()!==receipt.readyAt)fail();
  const origin=new URL(receipt.origin);if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash)fail();
  return immutable(receipt);
 }catch(error){lose();throw error;}
 }
 async function waitExit(){
  if(closed)return;
  try{await bounded(done=>{const onClose=()=>done();child.once('close',onClose);pendingExitCleanup=()=>child.off('close',onClose);});}
  catch(error){expectedExit=false;await stopChild();throw error;}
  finally{pendingExitCleanup?.();pendingExitCleanup=null;}
 }
 let pendingExitCleanup=null;
 async function drainActive({releaseId,signal}={}){
  if(signal?.aborted||role!=='host'||baseScope.operationId===null||releaseId!==baseScope.releaseId)fail();
  const {result,requestId}=await request('drain',{signal});
  try{const receipt=normalizeDrainReceipt(result,scope);expectedExit=true;await waitExit();if(child.exitCode!==75||child.signalCode)fail();
   // Child disconnect is expected after a completed response; revalidate original authority directly.
   if(await assertAuthority('complete-drain')!==true||signal?.aborted)fail();
   await journal.completeSupervisorDrain({scope,requestId,receipt});return receipt;
  }catch{await journal?.markSupervisorDrainUnknown({scope,requestId}).catch(()=>{});throw new Error('desktop_host_supervisor_unknown');}
 }
 async function disposeProbe(){if(role!=='probe')fail();const {result}=await request('dispose');if(!exact(result,['disposed'])||result.disposed!==true)fail();expectedExit=true;await waitExit();if(child.exitCode!==0||child.signalCode)fail();}
 async function dispose(){lose();pendingExitCleanup?.();unsubscribeChannel?.();unsubscribeChannel=null;child?.off('disconnect',lose);child?.off('error',lose);try{launchChannel?.close();}catch{}}
 const session=Object.freeze({bootstrap,attachVerifiedChild,readReady,drainActive,disposeProbe,dispose,get scope(){return scope;},get role(){return role;},get connected(){return !!child?.connected&&!dead&&!closed;}});
 sessions.add(session);return session;
}

export function createDesktopSupervisorLifecycle({activeSession,getActiveSession,openVerifiedProbeSession,installRoot,userDataRoot}={}){
 if(!sessions.has(activeSession)&&typeof getActiveSession!=='function'||typeof openVerifiedProbeSession!=='function')fail();
 return Object.freeze({drainActive:input=>{
  const session=getActiveSession?getActiveSession(input?.releaseId):activeSession;
  if(!sessions.has(session))fail();return session.drainActive(input);
 },async probeRelease(input={}){
  if(!isAbsolute(input.probeRoot??'')||overlap(input.probeRoot,installRoot)||overlap(input.probeRoot,userDataRoot)||input.signal?.aborted)fail();
  try{await lstat(input.probeRoot);fail();}catch(error){if(error?.code!=='ENOENT')throw error;}
  const probe=await openVerifiedProbeSession(input);
  if(!sessions.has(probe)||probe.role!=='probe')fail();
  try{
   if(probe.scope?.releaseId!==input.releaseId||probe.scope.generation!==null||probe.scope.restoredNonce!==null)fail();
   const receipt=await probe.readReady({signal:input.signal});if(canonical(receipt.target)!==canonical(input.expectedTarget))fail();
   await probe.disposeProbe();if(input.signal?.aborted)fail();return receipt;
  }finally{await probe.dispose();}
 }});
}
