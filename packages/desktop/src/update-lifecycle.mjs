import {randomUUID} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {verifyUpdateEnvelope} from './update-envelope.mjs';

const digestPattern=/^[a-f0-9]{64}$/;
const releaseIdPattern=/^[a-f0-9]{40,64}-[a-f0-9]{12}-(?:standalone|desktop-electron)$/i;
const operationIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(code){throw new Error(code);}
function safeObject(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function sameAbsolutePath(left,right){
 const first=resolve(left),second=resolve(right);
 return process.platform==='win32'?first.toLocaleLowerCase('en-US')===second.toLocaleLowerCase('en-US'):first===second;
}
function stable(value){
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
 return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
}
function isProductionVerifier(verifier,policy){return verifier?.identity==='windows-authenticode-v1'&&typeof verifier.verify==='function'&&policy.platform==='win32';}
function isTestVerifier(verifier){return verifier?.identity==='test-only'&&verifier.testOnly===true&&typeof verifier.verify==='function';}
function profileFor(value){return value?.profile??'standalone';}
function targetKey(envelope){const parts=[envelope.product,envelope.channel,envelope.platform,envelope.arch];if(profileFor(envelope)==='desktop-electron')parts.push('desktop-electron');return JSON.stringify(parts);}
function expectedReleaseId(envelope){return envelope.sourceCommit+'-'+envelope.manifestSha256.slice(0,12)+'-'+profileFor(envelope);}
function safeSummary(envelope){return Object.freeze({version:envelope.version,sequence:envelope.sequence,channel:envelope.channel,platform:envelope.platform,arch:envelope.arch});}
function validDeploymentRef(value,profile='standalone'){
 if(!value||typeof value!=='object'||typeof value.releaseId!=='string'||!releaseIdPattern.test(value.releaseId)||
  !digestPattern.test(value.manifestSha256)||value.profile!==profile||!value.releaseId.endsWith('-'+profile))return false;
 return profile==='standalone'||digestPattern.test(value.runtimeSha256??'')&&safeObject(value.target)&&value.target.profile==='desktop-electron';
}
function validateManifest(envelope,manifest){
 if(profileFor(envelope)==='desktop-electron'){
  if(!safeObject(manifest)||manifest.protocol!=='jot.desktop.portable.v1'||manifest.status!=='candidate'||
   manifest.appVersion!==envelope.version||manifest.sourceCommit!==envelope.sourceCommit||
   manifest.target?.platform!==envelope.platform||manifest.target?.arch!==envelope.arch||
   !digestPattern.test(manifest.runtimeReceiptSha256??'')||!digestPattern.test(manifest.appLockSha256??'')||
   !digestPattern.test(manifest.rootLockSha256??'')||!Array.isArray(manifest.files))fail('desktop_update_manifest_invalid');
  return manifest;
 }
 if(!safeObject(manifest)||manifest.protocol!==1||!safeObject(manifest.source)||manifest.source.tag!==envelope.sourceTag||manifest.source.commit!==envelope.sourceCommit||
  !safeObject(manifest.databaseProtocol)||!digestPattern.test(manifest.databaseProtocol.sha256)||!Array.isArray(manifest.files))fail('desktop_update_manifest_invalid');
 return manifest;
}
function validateProbe(probe,releaseRoot,manifestSha256){
 if(!probe||probe.healthy!==true||probe.releaseRoot!==releaseRoot||probe.manifestSha256!==manifestSha256||typeof probe.healthUrl!=='string')
  fail('desktop_update_candidate_health_failed');
 let url;try{url=new URL(probe.healthUrl);}catch{fail('desktop_update_candidate_health_failed');}
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/api/capabilities'||url.search||url.hash)
  fail('desktop_update_candidate_health_failed');
 return probe;
}
function validateRestoredProbeReceipt(probe,previous){
 if(!safeObject(probe)||Object.keys(probe).sort().join(',')!=='instanceId,origin,readyAt,releaseId,status,target'||
  typeof probe.instanceId!=='string'||!probe.instanceId||probe.releaseId!==previous.releaseId||probe.status!=='ready'||stable(probe.target)!==stable(previous.target))
  fail('desktop_update_restored_startup_probe_invalid');
 let readyAt;try{readyAt=new Date(probe.readyAt);}catch{fail('desktop_update_restored_startup_probe_invalid');}
 if(typeof probe.readyAt!=='string'||!Number.isFinite(readyAt.getTime())||readyAt.toISOString()!==probe.readyAt)
  fail('desktop_update_restored_startup_probe_invalid');
 let origin;try{origin=new URL(probe.origin);}catch{fail('desktop_update_restored_startup_probe_invalid');}
 if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)
  fail('desktop_update_restored_startup_probe_invalid');
 return probe;
}
function normalizeHostProcessContext(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='execPath,pid,releaseRoot'||
  !Number.isSafeInteger(value.pid)||value.pid<1||typeof value.execPath!=='string'||typeof value.releaseRoot!=='string'||
  !value.execPath.startsWith('/')&&!/^[A-Za-z]:\\/.test(value.execPath)||!value.releaseRoot.startsWith('/')&&!/^[A-Za-z]:\\/.test(value.releaseRoot)||
  !sameAbsolutePath(resolve(value.execPath),value.execPath)||!sameAbsolutePath(resolve(value.releaseRoot),value.releaseRoot)||
  !sameAbsolutePath(dirname(value.execPath),value.releaseRoot))fail('desktop_update_restored_startup_process_invalid');
 return {pid:value.pid,execPath:value.execPath,releaseRoot:value.releaseRoot};
}
function validateReceipt(staged,envelope){
 const releaseId=expectedReleaseId(envelope);
 if(profileFor(envelope)==='desktop-electron'){
  if(!staged||staged.staged!==true||staged.profile!=='desktop-electron'||staged.releaseId!==releaseId||
   staged.manifestSha256!==envelope.manifestSha256||staged.sourceCommit!==envelope.sourceCommit||
   !digestPattern.test(staged.runtimeSha256??'')||!safeObject(staged.target)||staged.target.profile!=='desktop-electron'||
   staged.completeRuntimeProof!==true||staged.sourceAndBuildFilesVerified!==true||staged.dependencyClosureProven!==false)
   fail('desktop_update_stage_receipt_invalid');
  return staged;
 }
 if(!staged||staged.staged!==true||staged.profile!=='standalone'||staged.releaseId!==releaseId||staged.manifestSha256!==envelope.manifestSha256||
  staged.sourceTag!==envelope.sourceTag||staged.sourceCommit!==envelope.sourceCommit)fail('desktop_update_stage_receipt_invalid');
 return staged;
}

export function createDesktopUpdateLifecycle({policy,releaseOps,packageLifecycle,downloader,stateStore,platformSignatureVerifier,candidateProbe,hostLifecycle,
 desktopLifecycle,getHealthUrl,exitForHandoff,fetchEnvelope,relaunch,confirmActivation,probeRestoredRelease,getHostProcessContext}={}){
 const currentHostProcessContext=getHostProcessContext??(({releaseRoot})=>({pid:process.pid,execPath:process.execPath,releaseRoot}));
 let checked=null;
 const contexts=new Map(),controllers=new Map(),progressListeners=new Set();
 const emitProgress=(operationId,phase)=>{
  const event=Object.freeze({operation_id:operationId,phase});
  for(const listener of progressListeners)try{listener(event);}catch{}
 };

 function policyError(){return policy?.enabled?null:policy?.reason??'desktop_update_host_policy_missing';}
 function verifierError(){
  if(isTestVerifier(platformSignatureVerifier))return null;
  if(isProductionVerifier(platformSignatureVerifier,policy))return null;
  return 'desktop_platform_signature_verifier_unavailable';
 }
 function configurationError(){
  const profile=profileFor(policy);
  if(policyError())return policyError();
  const verifier=verifierError();if(verifier)return verifier;
  if(!releaseOps||typeof releaseOps.readDeploymentState!=='function'||!packageLifecycle||typeof packageLifecycle.stage!=='function'||
   typeof packageLifecycle.resolveStagedRelease!=='function'||typeof packageLifecycle.createRecoveryPoint!=='function'||
   typeof packageLifecycle.verifyRecoveryPoint!=='function'||typeof packageLifecycle.activate!=='function'||typeof packageLifecycle.rollback!=='function'||
   !downloader||typeof downloader.download!=='function'||typeof downloader.resume!=='function'||!stateStore||typeof stateStore.read!=='function'||
   typeof stateStore.beginOperation!=='function'||typeof stateStore.setPhase!=='function'||typeof stateStore.recordDownloadProgress!=='function'||
   typeof stateStore.recordReleaseReceipt!=='function'||typeof stateStore.recordRecoveryPoint!=='function'||typeof stateStore.reconcileDeployment!=='function'||
   typeof stateStore.claimStartupAttempt!=='function'||typeof stateStore.confirmStartup!=='function'||typeof stateStore.markRollback!=='function'||
   typeof fetchEnvelope!=='function')return 'desktop_update_configuration_invalid';
  if(profile==='desktop-electron'){
   if(typeof stateStore.recordLauncherHandoff!=='function'||typeof stateStore.transitionHandoff!=='function'||
    typeof stateStore.readHandoff!=='function'||typeof stateStore.readStartup!=='function'||typeof stateStore.waitForStartup!=='function'||
    typeof stateStore.markUnknown!=='function'||typeof stateStore.prepareRestoredStartup!=='function'||
    typeof stateStore.readRestoredStartup!=='function'||typeof stateStore.claimRestoredStartup!=='function'||
    typeof stateStore.confirmRestoredStartup!=='function'||typeof stateStore.markRestoredStartupUnknown!=='function'||
    typeof stateStore.waitForRestoredStartup!=='function'||typeof probeRestoredRelease!=='function'||
    typeof packageLifecycle.verifyRecoveryPoint!=='function'||!desktopLifecycle||typeof desktopLifecycle.drainActive!=='function'||
    typeof desktopLifecycle.probeRelease!=='function'||typeof getHealthUrl!=='function'||typeof exitForHandoff!=='function')
    return 'desktop_update_configuration_invalid';
  }else if(typeof candidateProbe!=='function'||!hostLifecycle||typeof hostLifecycle.stop!=='function'||typeof relaunch!=='function')
   return 'desktop_update_configuration_invalid';
  return null;
 }
 function assertReady(){const error=configurationError();if(error)fail(error);}

 async function reconcile(){
  if(policyError())return {enabled:false,reason:policyError(),state:null};
  const state=await stateStore.read();
  if(!state?.enabled)return state;
  let deployment;
  try{deployment=releaseOps.readDeploymentState(policy.installRoot);}catch{return {enabled:false,reason:'desktop_update_deployment_unknown',state:state.state};}
  if(deployment===null||deployment===undefined){
   if(state.state?.operation?.phase==='activating'){
    try{await stateStore.setPhase(state.state.operation.id,'unknown');}catch{}
    return {enabled:false,reason:'desktop_update_deployment_unknown',state:(await stateStore.read()).state};
   }
   return state;
  }
  return stateStore.reconcileDeployment(deployment);
 }

 async function status(){
  const error=configurationError();
  if(error)return Object.freeze({enabled:false,reason:error,phase:null});
  const state=await stateStore.read();
  if(!state?.enabled)return Object.freeze({enabled:false,reason:state?.reason??'desktop_update_state_unavailable',phase:state?.state?.operation?.phase??null});
  return Object.freeze({enabled:true,reason:null,phase:state.state?.operation?.phase??'available',operationId:state.state?.operation?.id??null});
 }

 async function prepareStartup({restoredStartupNonce=null}={}){
  if(configurationError())return restoredStartupNonce!==null&&restoredStartupNonce!==undefined?Object.freeze({start:false,operationId:null,enabled:false,
   reason:'desktop_update_restored_startup_contract_unavailable'}):Object.freeze({start:true,operationId:null,enabled:false});
  const loaded=await stateStore.read();
  if(!loaded?.enabled)return Object.freeze({start:true,operationId:null,enabled:false,reason:loaded?.reason??'desktop_update_state_unavailable'});
  let operation=loaded.state?.operation;
  if(operation?.phase==='activating'){
   const reconciled=await reconcile();
   if(!reconciled.enabled)return Object.freeze({start:true,operationId:null,enabled:false,reason:reconciled.reason});
   operation=reconciled.state?.operation;
  }
  if(profileFor(policy)==='desktop-electron'&&operation?.handoff){
   const handoff=operation.handoff,deployment=releaseOps.readDeploymentState(policy.installRoot);
   if(handoff.state==='rolled-back'){
    if(!deployment||!validDeploymentRef(deployment.active,'desktop-electron')||!validDeploymentRef(deployment.previous,'desktop-electron')||
     deployment.active.releaseId!==handoff.previous.releaseId||deployment.active.manifestSha256!==handoff.previous.manifestSha256||
     deployment.previous.releaseId!==handoff.candidate.releaseId||deployment.previous.manifestSha256!==handoff.candidate.manifestSha256)
     fail('desktop_update_startup_recovery_target_invalid');
    const backup=packageLifecycle.verifyRecoveryPoint({backupId:handoff.recovery.backupId,expectedReleaseId:handoff.recovery.releaseId});
    if(!backup?.backupVerified||backup.backupId!==handoff.recovery.backupId||backup.releaseId!==handoff.recovery.releaseId||
     backup.profile!=='desktop-electron'||backup.manifestSha256!==deployment.active.manifestSha256||
     backup.runtimeSha256!==deployment.active.runtimeSha256||stable(backup.target)!==stable(deployment.active.target))
     fail('desktop_package_backup_receipt_invalid');
    const before={protocol:deployment.protocol,active:deployment.previous,previous:deployment.active};
    await stateStore.markRollback({before,after:deployment,backupDigest:handoff.recovery.backupId});
    const restored=await stateStore.readRestoredStartup({operationId:operation.id});
    if(!restored||restored.state!=='prepared'||typeof restoredStartupNonce!=='string'||restored.nonce!==restoredStartupNonce||
     !validDeploymentRef(deployment.active,'desktop-electron')||stable(restored.previous)!==stable(deployment.active)||
     stable(restored.recovery)!==stable(handoff.recovery))
     return Object.freeze({start:false,operationId:null,enabled:false,reason:'desktop_update_restored_startup_launch_context_invalid'});
    const resolvedPrevious=packageLifecycle.resolveStagedRelease({releaseId:deployment.active.releaseId,
     expectedManifestSha256:deployment.active.manifestSha256});
    if(!resolvedPrevious?.releaseRoot||resolvedPrevious.verified?.completeRuntimeProof!==true||
     resolvedPrevious.verified?.runtimeSha256!==deployment.active.runtimeSha256||
     stable(resolvedPrevious.verified.target)!==stable(deployment.active.target))
     fail('desktop_update_startup_target_invalid');
    const process=normalizeHostProcessContext(currentHostProcessContext({releaseRoot:resolvedPrevious.releaseRoot}));
    if(process.releaseRoot!==resolvedPrevious.releaseRoot)
     fail('desktop_update_restored_startup_process_invalid');
    const claimed=await stateStore.claimRestoredStartup({operationId:operation.id,previous:restored.previous,recovery:restored.recovery,
     nonce:restored.nonce,processContext:process});
    if(claimed?.claimed!==true)fail('desktop_update_restored_startup_replay_forbidden');
    return Object.freeze({start:true,operationId:null,enabled:true,rolledBack:true,activeReleaseId:deployment.active.releaseId,
     restoredStartup:claimed.receipt});
   }
   if(handoff.state==='unknown')fail('desktop_update_state_unknown');
   if(operation.startupStatus==='pending'){
    if(handoff.state!=='launched'||deployment?.active?.releaseId!==handoff.candidate.releaseId||
     deployment.active.manifestSha256!==handoff.candidate.manifestSha256||deployment?.previous?.releaseId!==handoff.previous.releaseId||
     deployment.previous.manifestSha256!==handoff.previous.manifestSha256)fail('desktop_update_startup_handoff_invalid');
    await stateStore.claimStartupAttempt(operation.id);
    return Object.freeze({start:true,operationId:operation.id,enabled:true});
   }
   if(operation.startupStatus==='attempted'){
    if(handoff.state==='launched')await stateStore.transitionHandoff({operationId:operation.id,from:'launched',to:'unknown'});
    fail('desktop_update_startup_retry_forbidden');
   }
   if(handoff.state==='requested'){
    await stateStore.transitionHandoff({operationId:operation.id,from:'requested',to:'unknown'});
    fail('desktop_update_startup_handoff_invalid');
   }
  }
  if(operation?.startupStatus==='pending'){
   const deployment=releaseOps.readDeploymentState(policy.installRoot);
   if(deployment?.active?.releaseId!==operation.candidate?.releaseId||deployment?.active?.manifestSha256!==operation.candidate?.manifestSha256)
    fail('desktop_update_startup_target_invalid');
   await stateStore.claimStartupAttempt(operation.id);
   return Object.freeze({start:true,operationId:operation.id,enabled:true});
  }
  if(operation?.startupStatus==='attempted'){
   const recovered=await recoverStartupFailure({operationId:operation.id});
   return Object.freeze({start:false,operationId:operation.id,enabled:true,...recovered});
  }
  return Object.freeze({start:true,operationId:null,enabled:true});
 }

 async function confirmStartup({operationId}={}){
  if(typeof operationId!=='string'||!operationIdPattern.test(operationId))return Object.freeze({confirmed:false});
  assertReady();
  const loaded=await stateStore.read(),operation=loaded.state?.operation;
  if(!loaded.enabled)fail(loaded.reason??'desktop_update_state_unavailable');
  if(!operation||operation.id!==operationId||operation.phase!=='active'||operation.startupStatus!=='attempted')
   fail('desktop_update_startup_confirmation_invalid');
  const deployment=releaseOps.readDeploymentState(policy.installRoot);
  if(deployment?.active?.releaseId!==operation.candidate?.releaseId||deployment?.active?.manifestSha256!==operation.candidate?.manifestSha256)
   fail('desktop_update_startup_target_invalid');
  await stateStore.confirmStartup(operationId);
  return Object.freeze({confirmed:true});
 }

 async function confirmRestoredStartup({operationId,nonce}={}){
  if(typeof operationId!=='string'||!operationIdPattern.test(operationId)||typeof nonce!=='string'||!operationIdPattern.test(nonce))
   return Object.freeze({confirmed:false});
  assertReady();
  const loaded=await stateStore.read(),operation=loaded.state?.operation;
  if(!loaded.enabled)fail(loaded.reason??'desktop_update_state_unavailable');
  const restored=await stateStore.readRestoredStartup({operationId});
  if(!operation||operation.id!==operationId||operation.profile!=='desktop-electron'||!restored||restored.nonce!==nonce||restored.state!=='attempted')
   fail('desktop_update_restored_startup_confirmation_invalid');
  const deployment=releaseOps.readDeploymentState(policy.installRoot);
  if(!deployment||!validDeploymentRef(deployment.active,'desktop-electron')||stable(deployment.active)!==stable(restored.previous)||
   stable(restored.recovery)!==stable(operation.handoff?.recovery))fail('desktop_update_startup_recovery_target_invalid');
  const active=packageLifecycle.resolveStagedRelease({releaseId:deployment.active.releaseId,
   expectedManifestSha256:deployment.active.manifestSha256});
  const process=normalizeHostProcessContext(currentHostProcessContext({releaseRoot:active?.releaseRoot}));
  if(stable(process)!==stable(restored.processContext))fail('desktop_update_restored_startup_process_invalid');
  if(!active||active.releaseRoot!==process.releaseRoot||active.verified?.releaseId!==deployment.active.releaseId||
   active.verified?.manifestSha256!==deployment.active.manifestSha256||active.verified?.runtimeSha256!==deployment.active.runtimeSha256||
   active.verified?.completeRuntimeProof!==true||stable(active.verified.target)!==stable(deployment.active.target))
   fail('desktop_update_startup_target_invalid');
  const probeReceipt=validateRestoredProbeReceipt(await probeRestoredRelease({releaseId:deployment.active.releaseId,
   releaseRoot:active.releaseRoot,expectedTarget:deployment.active.target,healthUrl:getHealthUrl(),nonce}),deployment.active);
  const result=await stateStore.confirmRestoredStartup({operationId,previous:deployment.active,recovery:restored.recovery,nonce,
   processContext:process,probeReceipt});
  return Object.freeze({confirmed:result.confirmed===true,receipt:result.receipt});
 }

 async function handleRestoredStartupFailure({operationId,nonce}={}){
  if(typeof operationId!=='string'||!operationIdPattern.test(operationId)||typeof nonce!=='string'||!operationIdPattern.test(nonce))
   return Object.freeze({unknown:false});
  assertReady();
  const restored=await stateStore.readRestoredStartup({operationId});
  const changed=await stateStore.markRestoredStartupUnknown({operationId,nonce,processContext:restored?.processContext??null});
  return Object.freeze({unknown:true,changed});
 }

 async function recoverStartupFailure({operationId}={}){
  const loaded=await stateStore.read(),operation=loaded.state?.operation;
  if(!loaded.enabled)fail(loaded.reason??'desktop_update_state_unavailable');
  if(!operation||operation.id!==operationId||operation.phase!=='active'||operation.startupStatus!=='attempted'||!operation.candidate||!operation.recoveryPoint)
   fail('desktop_update_rollback_unavailable');
  const deployment=releaseOps.readDeploymentState(policy.installRoot);
  if(deployment?.active?.releaseId===operation.candidate.releaseId&&deployment.active.manifestSha256===operation.candidate.manifestSha256)
   return rollbackPrevious({operationId});
  if(deployment?.active?.releaseId===operation.recoveryPoint.releaseId&&deployment?.previous?.releaseId===operation.candidate.releaseId&&
   deployment?.previous?.manifestSha256===operation.candidate.manifestSha256){
   const backup=packageLifecycle.verifyRecoveryPoint({backupId:operation.recoveryPoint.backupId,expectedReleaseId:operation.recoveryPoint.releaseId});
   if(!backup?.backupVerified||backup.backupId!==operation.recoveryPoint.backupId||backup.releaseId!==operation.recoveryPoint.releaseId)
    fail('desktop_package_backup_receipt_invalid');
   const before={protocol:deployment.protocol,active:deployment.previous,previous:deployment.active};
   const result=await stateStore.markRollback({before,after:deployment,backupDigest:operation.recoveryPoint.backupId});
   await relaunch();
   return Object.freeze({rolledBack:true,reconciled:true,activeReleaseId:deployment.active.releaseId,highWaterByTarget:result.state.highWaterByTarget});
  }
  fail('desktop_update_startup_recovery_target_invalid');
 }

 async function handleStartupFailure({operationId}={}){
  if(typeof operationId!=='string'||!operationIdPattern.test(operationId))return Object.freeze({rolledBack:false});
  assertReady();
  const loaded=await stateStore.read(),operation=loaded.state?.operation;
  if(!loaded.enabled)fail(loaded.reason??'desktop_update_state_unavailable');
  if(!operation||operation.id!==operationId||operation.startupStatus!=='attempted')return Object.freeze({rolledBack:false});
  if(profileFor(policy)==='desktop-electron')return Object.freeze({rolledBack:false,launcherOwned:true});
  return recoverStartupFailure({operationId});
 }

 async function restoreStagedContext(operation,envelope,rawBytes){
  if(!operation.candidate||operation.candidate.releaseId!==expectedReleaseId(envelope)||operation.candidate.manifestSha256!==envelope.manifestSha256)
   fail('desktop_update_resume_state_invalid');
  const stagedRelease=packageLifecycle.resolveStagedRelease({releaseId:operation.candidate.releaseId,expectedManifestSha256:envelope.manifestSha256});
  const manifest=validateManifest(envelope,stagedRelease.manifest);
  const verification=await platformSignatureVerifier.verify({platform:envelope.platform,artifactRoot:stagedRelease.releaseRoot,artifacts:envelope.platformArtifacts,
   allowedSignerSha256:policy.allowedSignerSha256});
  if(!verification||verification.verified!==true||verification.platform!==envelope.platform||
   !(isTestVerifier(platformSignatureVerifier)||verification.verifier==='windows-authenticode'))fail('desktop_platform_signature_verification_failed');
  let backup=null;
  if(operation.recoveryPoint){
   backup=packageLifecycle.verifyRecoveryPoint({backupId:operation.recoveryPoint.backupId,expectedReleaseId:operation.recoveryPoint.releaseId});
   if(!backup?.backupVerified||backup.backupId!==operation.recoveryPoint.backupId||backup.releaseId!==operation.recoveryPoint.releaseId)
    fail('desktop_package_backup_receipt_invalid');
   if(profileFor(envelope)==='desktop-electron'&&(!deployment||backup.profile!=='desktop-electron'||
    backup.manifestSha256!==deployment.active.manifestSha256||backup.runtimeSha256!==deployment.active.runtimeSha256||
    stable(backup.target)!==stable(deployment.active.target)))fail('desktop_package_backup_receipt_invalid');
  }
  const probe=profileFor(envelope)==='desktop-electron'?null:validateProbe(await candidateProbe({releaseRoot:stagedRelease.releaseRoot,
   probeRoot:join(policy.stateRoot,'resume-probe-'+operation.id),manifestSha256:envelope.manifestSha256}),stagedRelease.releaseRoot,envelope.manifestSha256);
  if(operation.phase==='staged')await stateStore.setPhase(operation.id,'awaiting-activation');
  const staged=profileFor(envelope)==='desktop-electron'?{...stagedRelease.verified,releaseId:operation.candidate.releaseId,
   manifestSha256:operation.candidate.manifestSha256,sourceCommit:envelope.sourceCommit,profile:'desktop-electron',staged:true}:
   {releaseId:operation.candidate.releaseId,manifestSha256:operation.candidate.manifestSha256,sourceTag:envelope.sourceTag,
    sourceCommit:envelope.sourceCommit,profile:'standalone',staged:true};
  const signerFingerprints=[...new Set((verification.artifacts??[]).map(item=>item.signerSha256).filter(value=>typeof value==='string'))];
  const context={operationId:operation.id,envelope,rawBytes,summary:safeSummary(envelope),staged,stagedRelease,probe,manifest,backup,
   verification,signerFingerprints};
  contexts.set(operation.id,context);checked=context;emitProgress(operation.id,'awaiting-activation');
  return context;
 }

 async function check(){
  assertReady();
  const reconciled=await reconcile();if(!reconciled.enabled)fail(reconciled.reason??'desktop_update_state_unavailable');
  const loaded=await stateStore.read();if(!loaded.enabled)fail(loaded.reason??'desktop_update_state_unavailable');
  const floor=loaded.state.highWaterByTarget[targetKey({product:policy.product,channel:policy.channel,platform:policy.platform,arch:policy.arch,profile:profileFor(policy)})];
  const existing=loaded.state.operation;
  if(existing&&!['active','cancelled','failed'].includes(existing.phase)){
   if(!existing.signedEnvelopeBase64)fail('desktop_update_resume_envelope_missing');
   const rawBytes=Buffer.from(existing.signedEnvelopeBase64,'base64');
   const envelope=verifyUpdateEnvelope({rawBytes,policy,currentSequence:floor?.sequence,currentEnvelopeDigest:floor?.envelopeDigest});
   if(envelope.envelopeDigest!==existing.envelopeDigest||envelope.manifestSha256!==existing.manifestSha256||targetKey(envelope)!==existing.targetKey)
    fail('desktop_update_resume_envelope_mismatch');
   if(['staged','awaiting-activation'].includes(existing.phase)){
    const context=await restoreStagedContext(existing,envelope,rawBytes);
    return Object.freeze({available:true,operationId:context.operationId,phase:'awaiting-activation',...safeSummary(envelope)});
   }
   checked={operationId:existing.id,envelope,rawBytes};
   contexts.set(existing.id,{operationId:existing.id,envelope,rawBytes,summary:safeSummary(envelope)});
   emitProgress(existing.id,existing.phase);
   return Object.freeze({available:true,operationId:existing.id,phase:existing.phase,resumable:['downloading','downloaded'].includes(existing.phase),...safeSummary(envelope)});
  }
  const raw=await fetchEnvelope({policy,signal:undefined});
  const rawBytes=Buffer.isBuffer(raw)?raw:raw?.rawBytes;
  if(!Buffer.isBuffer(rawBytes))fail('desktop_update_envelope_invalid');
  const envelope=verifyUpdateEnvelope({rawBytes,policy,currentSequence:floor?.sequence,currentEnvelopeDigest:floor?.envelopeDigest});
  if(floor&&BigInt(envelope.sequence)===BigInt(floor.sequence)&&envelope.envelopeDigest===floor.envelopeDigest){
   checked=null;
   return Object.freeze({available:false,reason:'desktop_update_already_current',...safeSummary(envelope)});
  }
  const operationId=randomUUID();
  await stateStore.beginOperation({id:operationId,target:{product:envelope.product,channel:envelope.channel,platform:envelope.platform,arch:envelope.arch},
   envelopeDigest:envelope.envelopeDigest,manifestSha256:envelope.manifestSha256,signedEnvelopeBase64:rawBytes.toString('base64'),profile:profileFor(envelope)});
  checked={operationId,envelope,rawBytes};
  contexts.set(operationId,{operationId,envelope,rawBytes,summary:safeSummary(envelope)});
  emitProgress(operationId,'available');
  return Object.freeze({available:true,operationId,...safeSummary(envelope)});
 }

 async function download(){
  assertReady();
  if(!checked)fail('desktop_update_check_required');
  const context=contexts.get(checked.operationId);
  if(!context)fail('desktop_update_operation_context_unavailable');
  const operationId=context.operationId,envelope=context.envelope,controller=new AbortController();
  controllers.set(operationId,controller);
  try{
   const state=await stateStore.read(),operation=state.state?.operation;
   if(!state.enabled||operation?.id!==operationId)fail('desktop_update_phase_invalid');
   if(['staged','awaiting-activation'].includes(operation.phase))return Object.freeze({operationId,phase:'awaiting-activation',...safeSummary(envelope)});
   let downloaded;
   if(operation.phase==='available')downloaded=await downloader.download({operationId,verifiedEnvelope:envelope,signal:controller.signal});
   else if(['downloading','downloaded'].includes(operation.phase))downloaded=await downloader.resume({operationId,verifiedEnvelope:envelope,signal:controller.signal});
   else fail('desktop_update_phase_invalid');
   if(controller.signal.aborted)fail('desktop_update_cancelled');
   if(!downloaded||downloaded.manifestSha256!==envelope.manifestSha256||downloaded.envelopeDigest!==envelope.envelopeDigest||typeof downloaded.packageRoot!=='string')
    fail('desktop_update_download_receipt_invalid');
   emitProgress(operationId,'downloaded');
   const manifest=validateManifest(envelope,downloaded.manifest);
   if(!platformSignatureVerifier||typeof platformSignatureVerifier.verify!=='function')fail('desktop_platform_signature_verifier_unavailable');
   const verification=await platformSignatureVerifier.verify({platform:envelope.platform,artifactRoot:downloaded.packageRoot,artifacts:envelope.platformArtifacts,
    allowedSignerSha256:policy.allowedSignerSha256,signal:controller.signal});
   if(controller.signal.aborted)fail('desktop_update_cancelled');
   if(!verification||verification.verified!==true||verification.platform!==envelope.platform||
    !(isTestVerifier(platformSignatureVerifier)||verification.verifier==='windows-authenticode'))fail('desktop_platform_signature_verification_failed');
   emitProgress(operationId,'verified');

   let backup=null,deployment;
   try{deployment=releaseOps.readDeploymentState(policy.installRoot);}catch{fail('desktop_update_deployment_unknown');}
   if(deployment){
    if(!validDeploymentRef(deployment.active,profileFor(envelope)))fail('desktop_update_deployment_unknown');
    const active=packageLifecycle.resolveStagedRelease({releaseId:deployment.active.releaseId,expectedManifestSha256:deployment.active.manifestSha256});
    if(profileFor(envelope)==='standalone'&&active.manifest.databaseProtocol?.sha256!==manifest.databaseProtocol.sha256)
     fail('desktop_update_database_protocol_mismatch');
    if(typeof packageLifecycle.createRecoveryPoint!=='function'||typeof packageLifecycle.verifyRecoveryPoint!=='function')fail('desktop_package_backup_unavailable');
    backup=await packageLifecycle.createRecoveryPoint({releaseId:deployment.active.releaseId});
    if(!backup||backup.verified!==true||backup.releaseId!==deployment.active.releaseId||typeof backup.backupId!=='string'||!digestPattern.test(backup.backupId))
     fail('desktop_package_backup_receipt_invalid');
    const verifiedBackup=packageLifecycle.verifyRecoveryPoint({backupId:backup.backupId,expectedReleaseId:deployment.active.releaseId});
    if(!verifiedBackup||verifiedBackup.backupVerified!==true||verifiedBackup.backupId!==backup.backupId||verifiedBackup.releaseId!==deployment.active.releaseId)
     fail('desktop_package_backup_receipt_invalid');
    if(profileFor(envelope)==='desktop-electron'&&(verifiedBackup.profile!=='desktop-electron'||
     verifiedBackup.manifestSha256!==deployment.active.manifestSha256||verifiedBackup.runtimeSha256!==deployment.active.runtimeSha256||
     stable(verifiedBackup.target)!==stable(deployment.active.target)))fail('desktop_package_backup_receipt_invalid');
    await stateStore.recordRecoveryPoint(operationId,backup.backupId,deployment.active.releaseId);
   }
   if(controller.signal.aborted)fail('desktop_update_cancelled');
   const staged=validateReceipt(await packageLifecycle.stage({packageRoot:downloaded.packageRoot,expectedManifestSha256:envelope.manifestSha256,signal:controller.signal}),envelope);
   const receipt={releaseId:staged.releaseId,envelopeDigest:envelope.envelopeDigest,manifestSha256:envelope.manifestSha256,
    product:envelope.product,channel:envelope.channel,platform:envelope.platform,arch:envelope.arch,sequence:envelope.sequence,profile:profileFor(envelope)};
   await stateStore.recordReleaseReceipt(receipt);
   await stateStore.setPhase(operationId,'staged');
   emitProgress(operationId,'staged');
   if(controller.signal.aborted)fail('desktop_update_cancelled');
   const stagedRelease=packageLifecycle.resolveStagedRelease({releaseId:staged.releaseId,expectedManifestSha256:envelope.manifestSha256});
   const probe=profileFor(envelope)==='desktop-electron'?null:validateProbe(await candidateProbe({releaseRoot:stagedRelease.releaseRoot,
    probeRoot:join(policy.stateRoot,'probe-'+operationId),manifestSha256:envelope.manifestSha256,signal:controller.signal}),
    stagedRelease.releaseRoot,envelope.manifestSha256);
   if(controller.signal.aborted)fail('desktop_update_cancelled');
   await stateStore.setPhase(operationId,'awaiting-activation');
   emitProgress(operationId,'awaiting-activation');
   const signerFingerprints=[...new Set((verification.artifacts??[]).map(item=>item.signerSha256).filter(value=>typeof value==='string'))];
   context.downloaded=downloaded;context.manifest=manifest;context.staged=staged;context.stagedRelease=stagedRelease;context.probe=probe;context.backup=backup;
   context.deployment=deployment;
   context.verification=verification;context.signerFingerprints=signerFingerprints;context.operationId=operationId;
   return Object.freeze({operationId,phase:'awaiting-activation',...safeSummary(envelope)});
  }catch(error){
   let progressPhase=controller.signal.aborted||error?.message==='desktop_update_cancelled'?'cancelled':'failed';
   try{
    const current=await stateStore.read(),operation=current.state?.operation;
    if(operation?.id===operationId&&!['active','cancelled','failed','unknown'].includes(operation.phase)){
     await stateStore.setPhase(operationId,controller.signal.aborted||error?.message==='desktop_update_cancelled'?'cancelled':'failed');
     progressPhase=controller.signal.aborted||error?.message==='desktop_update_cancelled'?'cancelled':'failed';
    }else if(operation?.id===operationId)progressPhase=operation.phase;
   }catch{}
   emitProgress(operationId,progressPhase);
   contexts.delete(operationId);if(checked?.operationId===operationId)checked=null;
   throw error;
  }finally{controllers.delete(operationId);}
 }

 async function cancel({operationId}={}){
  if(typeof operationId!=='string'||!operationIdPattern.test(operationId))fail('desktop_update_operation_invalid');
  const loaded=await stateStore.read();if(!loaded.enabled)fail(loaded.reason??'desktop_update_state_unavailable');
  const operation=loaded.state.operation;
  if(!operation||operation.id!==operationId)fail('desktop_update_operation_mismatch');
  if(['active','failed','cancelled','unknown','activating'].includes(operation.phase))fail('desktop_update_cancel_unavailable');
  controllers.get(operationId)?.abort();
  if(!controllers.has(operationId))await stateStore.setPhase(operationId,'cancelled');
  emitProgress(operationId,'cancelled');
  contexts.delete(operationId);if(checked?.operationId===operationId)checked=null;
  return Object.freeze({cancelled:true,operationId});
 }

 async function activate({operationId}={}){
  assertReady();
  if(typeof operationId!=='string'||!operationIdPattern.test(operationId))fail('desktop_update_operation_invalid');
  const context=contexts.get(operationId),loaded=await stateStore.read();
  if(!loaded.enabled)fail(loaded.reason??'desktop_update_state_unavailable');
  if(!loaded.state.operation||loaded.state.operation.id!==operationId)fail('desktop_update_operation_mismatch');
  if(loaded.state.operation.phase!=='awaiting-activation'||!context?.staged||
   profileFor(context.envelope)==='standalone'&&!context?.probe)fail('desktop_update_phase_invalid');
  if(typeof confirmActivation!=='function')fail('desktop_update_confirmation_unavailable');
  const confirmation=await confirmActivation({version:context.envelope.version,channel:context.envelope.channel,platform:context.envelope.platform,
   arch:context.envelope.arch,signerFingerprints:context.signerFingerprints??[]});
  if(confirmation!==true){await stateStore.setPhase(operationId,'cancelled');emitProgress(operationId,'cancelled');contexts.delete(operationId);return Object.freeze({declined:true,operationId});}
  await stateStore.setPhase(operationId,'activating');
  emitProgress(operationId,'activating');
  if(profileFor(context.envelope)==='desktop-electron'){
   try{
    const before=releaseOps.readDeploymentState(policy.installRoot);
    if(!before||!validDeploymentRef(before.active,'desktop-electron')||!context.backup||
     context.backup.releaseId!==before.active.releaseId||!digestPattern.test(context.backup.backupId??''))
     fail('desktop_update_handoff_recovery_invalid');
    const healthUrl=await getHealthUrl();
    await packageLifecycle.activate({releaseId:context.staged.releaseId,expectedManifestSha256:context.envelope.manifestSha256,
     backupId:context.backup.backupId,healthUrl});
    const deployment=releaseOps.readDeploymentState(policy.installRoot);
    if(!deployment||!validDeploymentRef(deployment.active,'desktop-electron')||!validDeploymentRef(deployment.previous,'desktop-electron')||
     deployment.active.releaseId!==context.staged.releaseId||deployment.active.manifestSha256!==context.envelope.manifestSha256||
     deployment.previous.releaseId!==before.active.releaseId||deployment.previous.manifestSha256!==before.active.manifestSha256)
     fail('desktop_update_handoff_pointer_mismatch');
    const reconciled=await stateStore.reconcileDeployment(deployment);
    if(!reconciled.enabled||reconciled.state?.operation?.phase!=='active'||reconciled.state.operation.startupStatus!=='pending')
     fail(reconciled.reason??'desktop_update_deployment_unknown');
    const handoff={protocol:1,operationId,profile:'desktop-electron',
     candidate:{releaseId:deployment.active.releaseId,manifestSha256:deployment.active.manifestSha256},
     previous:{releaseId:deployment.previous.releaseId,manifestSha256:deployment.previous.manifestSha256},
     recovery:{backupId:context.backup.backupId,releaseId:deployment.previous.releaseId},state:'requested'};
    await stateStore.recordLauncherHandoff(operationId,handoff);
    const exited=await exitForHandoff({exitCode:75,operationId,releaseId:deployment.active.releaseId,manifestSha256:deployment.active.manifestSha256});
    if(exited!==true){try{await stateStore.transitionHandoff({operationId,from:'requested',to:'unknown'});}catch{}
     if(typeof stateStore.markUnknown==='function')try{await stateStore.markUnknown(operationId);}catch{}
     fail('desktop_update_launcher_handoff_exit_failed');}
    contexts.delete(operationId);if(checked?.operationId===operationId)checked=null;
    emitProgress(operationId,'active');
    return Object.freeze({activated:true,reconciled:false,handoffRequested:true,exitCode:75,version:context.envelope.version});
   }catch(error){
    try{const stored=await stateStore.read(),current=stored.state?.operation;
     if(current?.id===operationId&&current.handoff?.state==='requested')await stateStore.transitionHandoff({operationId,from:'requested',to:'unknown'});
     else if(current?.id===operationId&&current.phase!=='unknown'&&typeof stateStore.markUnknown==='function')await stateStore.markUnknown(operationId);
    }catch{}
    throw error;
   }
  }
  try{
   await hostLifecycle.stop('desktop-update-activation');
   const healthProbe=async(profile,url)=>{
    if(profile!=='standalone'||url!==context.probe.healthUrl||context.probe.healthy!==true||context.probe.releaseRoot!==context.stagedRelease.releaseRoot)
     fail('desktop_update_candidate_health_failed');
   };
   await packageLifecycle.activate({releaseId:context.staged.releaseId,expectedManifestSha256:context.envelope.manifestSha256,
    backupId:context.backup?.backupId,drained:true,healthUrl:context.probe.healthUrl,healthProbe});
  }catch(error){
   let deployment;
   try{deployment=releaseOps.readDeploymentState(policy.installRoot);}catch{}
   if(deployment){
    const reconciled=await stateStore.reconcileDeployment(deployment);
    if(reconciled.enabled&&reconciled.state?.operation?.phase==='active'&&reconciled.activeReleaseId===context.staged.releaseId){
     await relaunch();contexts.delete(operationId);if(checked?.operationId===operationId)checked=null;
     emitProgress(operationId,'active');
     return Object.freeze({activated:true,reconciled:true,version:context.envelope.version});
    }
   }else{
    try{await stateStore.setPhase(operationId,'unknown');}catch{}
   }
   throw error;
  }
  let deployment;
  try{deployment=releaseOps.readDeploymentState(policy.installRoot);}catch{fail('desktop_update_deployment_unknown');}
  const reconciled=await stateStore.reconcileDeployment(deployment);
  if(!reconciled.enabled||reconciled.state?.operation?.phase!=='active'||reconciled.activeReleaseId!==context.staged.releaseId)
   fail(reconciled.reason??'desktop_update_deployment_unknown');
  await relaunch();contexts.delete(operationId);if(checked?.operationId===operationId)checked=null;
  emitProgress(operationId,'active');
  return Object.freeze({activated:true,reconciled:false,version:context.envelope.version});
 }

 async function rollbackPrevious({operationId}={}){
  assertReady();
  if(profileFor(policy)==='desktop-electron')fail('desktop_update_launcher_rollback_only');
  if(typeof operationId!=='string'||!operationIdPattern.test(operationId))fail('desktop_update_operation_invalid');
  const loaded=await stateStore.read(),operation=loaded.state?.operation,context=contexts.get(operationId);
  if(!loaded.enabled)fail(loaded.reason??'desktop_update_state_unavailable');
  if(!operation||operation.id!==operationId||operation.phase!=='active'||!operation.candidate||!operation.recoveryPoint)fail('desktop_update_rollback_unavailable');
  const before=releaseOps.readDeploymentState(policy.installRoot);
  if(!before?.active||!before?.previous||before.active.releaseId!==operation.candidate.releaseId||before.active.manifestSha256!==operation.candidate.manifestSha256||
   before.previous.releaseId!==operation.recoveryPoint.releaseId)fail('desktop_update_rollback_target_invalid');
  const previousReceipt=loaded.state.releaseReceipts.find(item=>item.releaseId===before.previous.releaseId&&item.manifestSha256===before.previous.manifestSha256);
  if(!previousReceipt)fail('desktop_update_rollback_receipt_missing');
  const backup=packageLifecycle.verifyRecoveryPoint({backupId:operation.recoveryPoint.backupId,expectedReleaseId:before.previous.releaseId});
  if(!backup?.backupVerified||backup.backupId!==operation.recoveryPoint.backupId||backup.releaseId!==before.previous.releaseId)fail('desktop_package_backup_receipt_invalid');
  const previous=packageLifecycle.resolveStagedRelease({releaseId:before.previous.releaseId,expectedManifestSha256:before.previous.manifestSha256});
  const probe=validateProbe(await candidateProbe({releaseRoot:previous.releaseRoot,probeRoot:join(policy.stateRoot,'rollback-probe-'+operationId),
   manifestSha256:before.previous.manifestSha256}),previous.releaseRoot,before.previous.manifestSha256);
  await hostLifecycle.stop('desktop-update-rollback');
  const healthProbe=async(profile,url)=>{if(profile!=='standalone'||url!==probe.healthUrl||probe.healthy!==true)fail('desktop_update_candidate_health_failed');};
  await packageLifecycle.rollback({restoreReleaseId:before.previous.releaseId,backupId:operation.recoveryPoint.backupId,drained:true,healthUrl:probe.healthUrl,healthProbe});
  const after=releaseOps.readDeploymentState(policy.installRoot);
  const result=await stateStore.markRollback({before,after,backupDigest:operation.recoveryPoint.backupId});
  await relaunch();
  return Object.freeze({rolledBack:true,activeReleaseId:after.active.releaseId,highWaterByTarget:result.state.highWaterByTarget});
 }

 function onProgress(listener){
  if(typeof listener!=='function')fail('desktop_update_progress_listener_invalid');
  progressListeners.add(listener);return ()=>progressListeners.delete(listener);
 }
 return Object.freeze({status,check,download,cancel,activate,reconcile,prepareStartup,confirmStartup,confirmRestoredStartup,
  handleRestoredStartupFailure,handleStartupFailure,rollbackPrevious,onProgress});
}
