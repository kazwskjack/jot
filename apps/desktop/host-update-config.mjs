const baseRequiredFields=['policy','releaseOps','fetchEnvelope'];
const allowedFields=new Set([...baseRequiredFields,'loadActiveRelease','platformSignatureVerifier','candidateProbe','desktopLifecycle','hostBackupScript','runCommand']);
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
function fail(){throw new Error('desktop_update_host_config_invalid');}

// Only trusted product code should call this factory. It never reads renderer, environment, or userData values.
// Parent authority and child bootstrap come from the W16 verified-launch IPC contract, not config callbacks.
export function createDesktopUpdateHostConfig(input){
 if(input===undefined||input===null)return null;
 const profile=input?.policy?.profile??'standalone';
 if(!record(input)||baseRequiredFields.some(key=>!Object.hasOwn(input,key))||Object.keys(input).some(key=>!allowedFields.has(key))||
  !record(input.policy)||!record(input.policy.trustedKeys)||!record(input.policy.platformSigners)||
  !record(input.releaseOps)||typeof input.releaseOps.readDeploymentState!=='function'||
  typeof input.releaseOps.createRecoveryPoint!=='function'||typeof input.releaseOps.verifyRecoveryPoint!=='function'||
  typeof input.fetchEnvelope!=='function'||!['standalone','desktop-electron'].includes(profile)||
  profile==='standalone'&&typeof input.loadActiveRelease!=='function'||
  profile==='desktop-electron'&&(input.loadActiveRelease!==undefined||input.runCommand!==undefined||!record(input.desktopLifecycle)||
   Object.keys(input.desktopLifecycle).sort().join(',')!=='drainActive,probeRelease'||
   typeof input.desktopLifecycle.drainActive!=='function'||typeof input.desktopLifecycle.probeRelease!=='function')||
  input.platformSignatureVerifier!==undefined&&(!record(input.platformSignatureVerifier)||typeof input.platformSignatureVerifier.verify!=='function')||
  input.candidateProbe!==undefined&&typeof input.candidateProbe!=='function'||input.runCommand!==undefined&&typeof input.runCommand!=='function'||
  input.hostBackupScript!==undefined&&typeof input.hostBackupScript!=='string')fail();
 const policy=Object.freeze({...input.policy,
  trustedKeys:Object.freeze({...input.policy.trustedKeys}),
  platformSigners:Object.freeze(Object.fromEntries(Object.entries(input.policy.platformSigners).map(([platform,signers])=>{
   if(!Array.isArray(signers)||signers.some(value=>typeof value!=='string'))fail();
   return [platform,Object.freeze([...signers])];
  })))
 });
 return Object.freeze({...input,policy,releaseOps:Object.freeze({...input.releaseOps}),
  ...(input.desktopLifecycle?{desktopLifecycle:Object.freeze({...input.desktopLifecycle})}:{})});
}

// The desktop updater remains default-off until its trusted policy and update operations are approved.
export const desktopUpdateHostConfig=null;
