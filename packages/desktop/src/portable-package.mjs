import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {readFile,unlink} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';

const sha256Pattern=/^[a-f0-9]{64}$/;
const commitPattern=/^[a-f0-9]{40,64}$/i;
const releaseIdPattern=/^[a-f0-9]{40,64}-[a-f0-9]{12}-(?:standalone|desktop-electron)$/i;
const portableManifestName='portable-package-manifest.json';
const portableManifestSidecarName='portable-package-manifest.sha256';

function pathInside(parent,child){
 const rel=relative(parent,child);
 return rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel));
}

function canonicalPath(path){
 let cursor=resolve(path),tail=[];
 while(!existsSync(cursor)){
  const parent=dirname(cursor);
  if(parent===cursor)throw new Error('desktop_package_path_invalid');
  tail.unshift(basename(cursor));cursor=parent;
 }
 const info=lstatSync(cursor);
 if(info.isSymbolicLink()){
  if(tail.length===0)throw new Error('desktop_package_root_unsafe');
 }else if(!info.isDirectory())throw new Error('desktop_package_root_invalid');
 return resolve(realpathSync(cursor),...tail);
}

function assertDisjoint(first,second){
 if(pathInside(first,second)||pathInside(second,first))throw new Error('desktop_package_roots_overlap');
}

function hash(bytes){return createHash('sha256').update(bytes).digest('hex');}

function expectedRuntimeTarget(manifest){
 const electron=manifest?.electron;
 return Object.freeze({electronVersion:electron?.version,nodeVersion:electron?.nodeVersion,platform:electron?.platform,arch:electron?.arch,
  nodeModuleAbi:electron?.nodeModuleAbi,napiVersion:electron?.napiVersion});
}

function verifiedTargetFromBinding(binding){
 const {manifest}=binding,electron=manifest.electron;
 return {profile:'desktop-electron',runtimeKind:'electron',electronVersion:electron.version,platform:electron.platform,arch:electron.arch,
  nodeVersion:electron.nodeVersion,abi:{node:electron.nodeModuleAbi,napi:electron.napiVersion},
  electronArchiveSha256:electron.archiveSha256,electronExecutableSha256:electron.executableSha256};
}

function readDesktopManifest(packageRoot,expectedManifestSha256){
 const expected=validateManifestHash(expectedManifestSha256),manifestPath=join(packageRoot,portableManifestName),sidecarPath=join(packageRoot,portableManifestSidecarName);
 let raw,manifest,sidecar;
 try{
  const info=lstatSync(manifestPath),sidecarInfo=lstatSync(sidecarPath);
  if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024||!sidecarInfo.isFile()||sidecarInfo.isSymbolicLink()||sidecarInfo.size>256)
   throw new Error();
  raw=readFileSync(manifestPath);sidecar=readFileSync(sidecarPath,'utf8');manifest=JSON.parse(raw.toString('utf8'));
 }catch{throw new Error('desktop_package_manifest_invalid');}
 if(hash(raw)!==expected||sidecar!==expected+'  '+portableManifestName+'\n'||raw.toString('utf8')!==JSON.stringify(manifest,null,2)+'\n'||
  !manifest||typeof manifest!=='object'||Array.isArray(manifest)||manifest.protocol!=='jot.desktop.portable.v1'||manifest.status!=='candidate'||
  typeof manifest.sourceCommit!=='string'||!/^[a-f0-9]{40}$/.test(manifest.sourceCommit)||
  typeof manifest.appVersion!=='string'||!sha256Pattern.test(manifest.runtimeReceiptSha256??'')||
  !manifest.target||typeof manifest.target.platform!=='string'||typeof manifest.target.arch!=='string'||
  !manifest.electron||manifest.electron.platform!==manifest.target.platform||manifest.electron.arch!==manifest.target.arch||
  !sha256Pattern.test(manifest.appLockSha256??'')||!sha256Pattern.test(manifest.rootLockSha256??''))
  throw new Error('desktop_package_manifest_invalid');
 return Object.freeze({manifest:Object.freeze(manifest),expectedManifestSha256:expected,expectedRuntimeTarget:expectedRuntimeTarget(manifest)});
}

function validateDesktopVerifiedPackage(info,binding){
 const {manifest,expectedManifestSha256,expectedRuntimeTarget:target}=binding;
 const sameTarget=info&&stable(info.target)===stable(verifiedTargetFromBinding(binding));
 if(!info||typeof info!=='object'||Array.isArray(info)||info.manifestSha256!==expectedManifestSha256||
  info.sourceCommit!==manifest.sourceCommit||info.sourceTreeSha256!==manifest.sourceTreeSha256||
  stable(info.manifest)!==stable(manifest)||info.profile!=='desktop-electron'||!sameTarget||
  info.runtimeReceiptSha256!==manifest.runtimeReceiptSha256||info.appLockSha256!==manifest.appLockSha256||
  info.rootLockSha256!==undefined&&info.rootLockSha256!==manifest.rootLockSha256||!Number.isSafeInteger(info.fileCount)||info.fileCount<1)
  throw new Error('desktop_package_manifest_invalid');
 return info;
}

function validateDesktopStageReceipt(receipt,verified,binding){
 const expectedReleaseId=verified.sourceCommit+'-'+binding.expectedManifestSha256.slice(0,12)+'-desktop-electron';
 if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||receipt.releaseId!==expectedReleaseId||
  receipt.manifestSha256!==binding.expectedManifestSha256||receipt.sourceCommit!==verified.sourceCommit||
  receipt.profile!=='desktop-electron'||receipt.staged!==true||!sha256Pattern.test(receipt.runtimeSha256??'')||
  stable(receipt.target)!==stable(verified.target)||receipt.completeRuntimeProof!==true||receipt.sourceAndBuildFilesVerified!==true||
  receipt.dependencyClosureProven!==false)throw new Error('desktop_package_stage_receipt_invalid');
 return receipt;
}

function canonicalJson(value){
 if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalJson(value[key])).join(',')+'}';
 return JSON.stringify(value);
}

function stable(value){
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
 const keys=Object.keys(value).sort();
 return '{'+keys.map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
}

function validateManifestHash(value){
 if(typeof value!=='string'||!sha256Pattern.test(value))throw new Error('desktop_package_manifest_hash_invalid');
 return value;
}

function validatePackageRoot(packageRoot,installRoot,userDataRoot){
 if(typeof packageRoot!=='string'||!isAbsolute(packageRoot))throw new Error('desktop_package_source_invalid');
 const source=canonicalPath(packageRoot);
 assertDisjoint(source,installRoot);assertDisjoint(source,userDataRoot);
 return source;
}

function validateVerifiedPackage(info,expectedManifestSha256){
 if(!info||typeof info!=='object'||Array.isArray(info)||info.manifestSha256!==expectedManifestSha256||
  typeof info.sourceTag!=='string'||!info.sourceTag||info.sourceTag.length>200||
  typeof info.sourceCommit!=='string'||!commitPattern.test(info.sourceCommit)||
  !Number.isSafeInteger(info.fileCount)||info.fileCount<1)throw new Error('desktop_package_manifest_invalid');
 return info;
}

function validateStagedReceipt(receipt,verified,expectedManifestSha256){
 const expectedReleaseId=verified.sourceCommit+'-'+expectedManifestSha256.slice(0,12)+'-standalone';
 if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||receipt.releaseId!==expectedReleaseId||
  receipt.manifestSha256!==expectedManifestSha256||receipt.sourceTag!==verified.sourceTag||
  receipt.sourceCommit!==verified.sourceCommit||receipt.profile!=='standalone'||receipt.staged!==true)
  throw new Error('desktop_package_stage_receipt_invalid');
 return receipt;
}

function validateReleaseId(value){
 if(typeof value!=='string'||!releaseIdPattern.test(value))throw new Error('desktop_package_release_id_invalid');
 return value;
}

function validateHealthUrl(value){
 let url;
 try{url=new URL(value);}catch{throw new Error('desktop_package_health_url_invalid');}
 if(url.protocol!=='http:'||url.username||url.password||url.search||url.hash||
  !['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.pathname!=='/api/capabilities')
  throw new Error('desktop_package_health_url_invalid');
 return value;
}

function validateOwnedFiles(manifest,expectedManifestSha256){
 validateManifestHash(expectedManifestSha256);
 const topKeys=['databaseProtocol','files','license','packages','protocol','source'];
 if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||Object.getPrototypeOf(manifest)!==Object.prototype||
  Object.keys(manifest).sort().join(',')!==topKeys.join(',')||manifest.protocol!==1||!Array.isArray(manifest.files)||
  hash(canonicalJson(manifest))!==expectedManifestSha256)throw new Error('desktop_package_owned_manifest_invalid');
 const files=manifest.files;
 const seen=new Set();let previous='';
 return files.map(file=>{
  if(!file||typeof file!=='object'||Array.isArray(file)||Object.getPrototypeOf(file)!==Object.prototype||
   Object.keys(file).sort().join(',')!=='bytes,mode,path,sha256'||typeof file.path!=='string'||
   typeof file.sha256!=='string'||!sha256Pattern.test(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<0||![100644,100755].includes(file.mode))
   throw new Error('desktop_package_owned_files_invalid');
  const path=file.path;
  if(!path||path.length>4096||/^[A-Za-z]:/.test(path)||path.startsWith('/')||path.includes('\\')||Array.from(path).some(char=>{const code=char.charCodeAt(0);return code<32||code===127;})||
   path.endsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..'))
   throw new Error('desktop_package_owned_path_invalid');
  if(['releases','.jot-state'].includes(path.split('/')[0].toLocaleLowerCase('en-US')))
   throw new Error('desktop_package_owned_path_invalid');
  if(path.localeCompare(previous,'en')<0)throw new Error('desktop_package_owned_manifest_invalid');
  const key=process.platform==='win32'?path.toLocaleLowerCase('en-US'):path;
  if(seen.has(key))throw new Error('desktop_package_owned_path_invalid');
  seen.add(key);previous=path;
  return {path,sha256:file.sha256,bytes:file.bytes};
 });
}

function inspectOwnedPath(root,path){
 const parts=path.split('/');let cursor=root;
 for(let index=0;index<parts.length;index++){
  cursor=resolve(cursor,parts[index]);
  if(!pathInside(root,cursor))throw new Error('desktop_package_owned_path_invalid');
  let info;try{info=lstatSync(cursor);}catch(error){if(error?.code==='ENOENT')return {kind:'missing'};throw error;}
  if(info.isSymbolicLink())throw new Error('desktop_package_owned_path_unsafe');
  if(index<parts.length-1&&!info.isDirectory())return {kind:'missing'};
  if(index===parts.length-1&&!info.isFile())throw new Error('desktop_package_owned_path_unsafe');
 }
 return {kind:'file',path:cursor};
}

export function createDesktopPackageLifecycle({releaseOps,installRoot,userDataRoot,backupConfig,hostBackupScript,runCommand,validationRoot,
 profile='standalone',desktopLifecycle}={}){
 if(!['standalone','desktop-electron'].includes(profile))throw new Error('desktop_package_profile_invalid');
 for(const [name,value]of Object.entries({installRoot,userDataRoot}))
  if(typeof value!=='string'||!isAbsolute(value))throw new Error('desktop_package_root_invalid:'+name);
 if(!releaseOps||typeof releaseOps.verifyReleasePackage!=='function'||typeof releaseOps.stageRelease!=='function'||
  typeof releaseOps.readDeploymentState!=='function'||typeof releaseOps.activateRelease!=='function'||typeof releaseOps.rollbackRelease!=='function')
  throw new Error('desktop_package_release_ops_invalid');
 const installPath=canonicalPath(installRoot),userDataPath=canonicalPath(userDataRoot);
 assertDisjoint(installPath,userDataPath);
 if(backupConfig!==undefined&&(typeof backupConfig!=='string'||!isAbsolute(backupConfig)))throw new Error('desktop_package_backup_config_invalid');
 if(hostBackupScript!==undefined&&(typeof hostBackupScript!=='string'||!isAbsolute(hostBackupScript)))throw new Error('desktop_package_backup_script_invalid');
 if(runCommand!==undefined&&typeof runCommand!=='function')throw new Error('desktop_package_runner_invalid');
 if(validationRoot!==undefined&&(typeof validationRoot!=='string'||!isAbsolute(validationRoot)))throw new Error('desktop_package_validation_root_invalid');
 if(profile==='desktop-electron'&&(!desktopLifecycle||typeof desktopLifecycle.drainActive!=='function'||typeof desktopLifecycle.probeRelease!=='function'))
  throw new Error('desktop_package_desktop_lifecycle_invalid');

 function state(){return releaseOps.readDeploymentState(installPath);}
 function freshProbeRoot(label,releaseId){
  const path=join(dirname(installPath),`.jot-${label}-probe-${releaseId.slice(0,12)}-${randomUUID()}`);
  assertDisjoint(path,installPath);assertDisjoint(path,userDataPath);
  return path;
 }
 function assertStateUnchanged(before,after){
  if(stable(before)!==stable(after))throw new Error('desktop_package_active_state_changed');
 }

 function resolveStagedRelease({releaseId,expectedManifestSha256}={}){
  const id=validateReleaseId(releaseId),expected=validateManifestHash(expectedManifestSha256),releasesPath=join(installPath,'releases'),root=join(releasesPath,id);
  for(const path of [releasesPath,root]){
   let info;try{info=lstatSync(path);}catch{throw new Error('desktop_package_release_missing');}
   if(info.isSymbolicLink()||!info.isDirectory())throw new Error('desktop_package_release_unsafe');
  }
  const realRoot=resolve(realpathSync(root));
  if(!pathInside(installPath,realRoot)||realRoot!==root)throw new Error('desktop_package_release_unsafe');
  if(profile==='desktop-electron'){
   const binding=readDesktopManifest(realRoot,expected);
   if(id!==binding.manifest.sourceCommit+'-'+expected.slice(0,12)+'-desktop-electron')throw new Error('desktop_package_release_manifest_invalid');
   if(typeof releaseOps.verifyInstalledRelease!=='function')throw new Error('desktop_package_release_ops_invalid');
   const installed=releaseOps.verifyInstalledRelease({installRoot:installPath,releaseId:id,expectedManifestSha256:expected});
   if(!installed||installed.releaseId!==id||installed.manifestSha256!==expected||installed.profile!=='desktop-electron'||
    installed.sourceCommit!==binding.manifest.sourceCommit||installed.completeRuntimeProof!==true||
    !sha256Pattern.test(installed.runtimeSha256??'')||stable(installed.target)!==stable(verifiedTargetFromBinding(binding)))
    throw new Error('desktop_package_release_manifest_invalid');
   return Object.freeze({releaseRoot:realRoot,manifest:installed.manifest,verified:installed});
  }
  const manifestPath=join(realRoot,'release-manifest.json');
  let raw,manifest;
  try{
   const info=lstatSync(manifestPath);if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024)throw new Error();
   raw=readFileSync(manifestPath,'utf8');manifest=JSON.parse(raw);
  }catch{throw new Error('desktop_package_release_manifest_invalid');}
  if(raw!==canonicalJson(manifest)+'\n'||hash(canonicalJson(manifest))!==expected||!manifest.source||
   typeof manifest.source.commit!=='string'||!commitPattern.test(manifest.source.commit)||typeof manifest.source.tag!=='string'||
   id!==manifest.source.commit+'-'+expected.slice(0,12)+'-standalone')throw new Error('desktop_package_release_manifest_invalid');
  validateOwnedFiles(manifest,expected);
  if(validationRoot===undefined)throw new Error('desktop_package_validation_root_invalid');
  const validationPath=resolve(validationRoot);assertDisjoint(validationPath,installPath);assertDisjoint(validationPath,userDataPath);
  let verificationRoot;
  try{
   mkdirSync(validationPath,{recursive:true,mode:0o700});
   const info=lstatSync(validationPath);if(info.isSymbolicLink()||!info.isDirectory())throw new Error('desktop_package_validation_root_unsafe');
   const realValidationPath=resolve(realpathSync(validationPath));assertDisjoint(realValidationPath,installPath);assertDisjoint(realValidationPath,userDataPath);
   verificationRoot=mkdtempSync(join(realValidationPath,'release-verify-'));
   for(const file of validateOwnedFiles(manifest,expected)){
    const inspected=inspectOwnedPath(realRoot,file.path);if(inspected.kind!=='file')throw new Error('desktop_package_release_file_missing');
    const bytes=readFileSync(inspected.path);if(bytes.length!==file.bytes||hash(bytes)!==file.sha256)throw new Error('desktop_package_release_file_mismatch');
    const target=join(verificationRoot,...file.path.split('/'));mkdirSync(dirname(target),{recursive:true,mode:0o700});
    writeFileSync(target,bytes,{flag:'wx',mode:file.mode===100755?0o700:0o600});
   }
   writeFileSync(join(verificationRoot,'release-manifest.json'),raw,{flag:'wx',mode:0o600});
  }catch(error){if(verificationRoot)rmSync(verificationRoot,{recursive:true,force:true});throw error;}
  let verified;
  try{verified=validateVerifiedPackage(releaseOps.verifyReleasePackage({packageRoot:verificationRoot,expectedManifestSha256:expected}),expected);}
  finally{rmSync(verificationRoot,{recursive:true,force:true});}
  if(verified.sourceCommit!==manifest.source.commit||verified.sourceTag!==manifest.source.tag)throw new Error('desktop_package_release_manifest_invalid');
  return Object.freeze({releaseRoot:realRoot,manifest:Object.freeze(manifest),verified});
 }

 async function stage({packageRoot,expectedManifestSha256,signal}={}){
  const expected=validateManifestHash(expectedManifestSha256);
  const source=validatePackageRoot(packageRoot,installPath,userDataPath);
  const before=state();
  try{
   if(profile==='desktop-electron'){
    const binding=readDesktopManifest(source,expected),manifest=binding.manifest;
    const verificationArgs={packageRoot:source,expectedManifestSha256:expected,profile,
     expectedRuntimeReceiptSha256:manifest.runtimeReceiptSha256,expectedRuntimeTarget:binding.expectedRuntimeTarget,
     expectedAppLockSha256:manifest.appLockSha256,expectedRootLockSha256:manifest.rootLockSha256};
    const verified=validateDesktopVerifiedPackage(releaseOps.verifyReleasePackage(verificationArgs),binding);
    const receipt=validateDesktopStageReceipt(await releaseOps.stageRelease({...verificationArgs,installRoot:installPath,userDataRoot:userDataPath,signal}),verified,binding);
    assertStateUnchanged(before,state());return receipt;
   }
   const verified=validateVerifiedPackage(releaseOps.verifyReleasePackage({packageRoot:source,expectedManifestSha256:expected}),expected);
   const receipt=validateStagedReceipt(await releaseOps.stageRelease({packageRoot:source,expectedManifestSha256:expected,installRoot:installPath,profile:'standalone',signal,...(runCommand?{runCommand}:{})}),verified,expected);
   assertStateUnchanged(before,state());
   return receipt;
  }catch(error){
   const after=state();
   assertStateUnchanged(before,after);
   throw error;
  }
 }

 async function activate({releaseId,expectedManifestSha256,backupId,drained,healthUrl,healthProbe}={}){
  const id=validateReleaseId(releaseId),manifestHash=validateManifestHash(expectedManifestSha256);
  if(profile==='desktop-electron'){
   if(drained!==undefined||(backupId!==undefined&&backupId!==null&&(typeof backupId!=='string'||!sha256Pattern.test(backupId))))
    throw new Error('desktop_package_activation_invalid');
   const before=state(),candidate=resolveStagedRelease({releaseId:id,expectedManifestSha256:manifestHash}),verified=candidate.verified;
   if(before?.active&&(typeof before.active.runtimeSha256!=='string'||!sha256Pattern.test(before.active.runtimeSha256)||
    typeof before.active.profile!=='string'||before.active.profile!=='desktop-electron'))throw new Error('desktop_package_activation_invalid');
   if(before?.active){if(typeof backupId!=='string'||!sha256Pattern.test(backupId))throw new Error('desktop_package_activation_invalid');
    const point=verifyRecoveryPoint({backupId,expectedReleaseId:before.active.releaseId});
    if(point.profile!=='desktop-electron'||point.manifestSha256!==before.active.manifestSha256||point.runtimeSha256!==before.active.runtimeSha256||
     stable(point.target)!==stable(before.active.target))throw new Error('desktop_package_backup_receipt_invalid');}
   const health=validateHealthUrl(healthUrl),probeRoot=freshProbeRoot('activation',id);
   try{return await releaseOps.activateRelease({installRoot:installPath,releaseId:id,expectedManifestSha256:manifestHash,
    expectedRuntimeSha256:verified.runtimeSha256,backupId,healthUrl:health,profile,desktopLifecycle,probeRoot,
    privateBackupConfig:backupConfig,userDataRoot,...(hostBackupScript?{hostBackupScript}:{})});}
   catch(error){assertStateUnchanged(before,state());throw error;}
  }
 if((backupId!==undefined&&backupId!==null&&(typeof backupId!=='string'||!sha256Pattern.test(backupId)))||drained!==true)
  throw new Error('desktop_package_activation_invalid');
 const before=state();
 if(before!==null&&before!==undefined&&(typeof backupId!=='string'||!sha256Pattern.test(backupId)))
  throw new Error('desktop_package_activation_invalid');
 const health=validateHealthUrl(healthUrl);
  if(healthProbe!==undefined&&typeof healthProbe!=='function')throw new Error('desktop_package_health_probe_invalid');
  try{return await releaseOps.activateRelease({installRoot:installPath,releaseId:id,expectedManifestSha256:manifestHash,backupId,drained,healthUrl:health,profile:'standalone',
   ...(healthProbe?{healthProbe}:{}),...(hostBackupScript?{hostBackupScript}:{})});}
  catch(error){assertStateUnchanged(before,state());throw error;}
 }

 async function rollback({restoreReleaseId,backupId,drained,healthUrl,healthProbe}={}){
  const id=validateReleaseId(restoreReleaseId);
  if(profile==='desktop-electron'){
   if(drained!==undefined||typeof backupId!=='string'||!sha256Pattern.test(backupId))throw new Error('desktop_package_activation_invalid');
   const before=state();
   if(!before?.active||!before?.previous||before.previous.releaseId!==id||before.previous.profile!=='desktop-electron')
    throw new Error('desktop_package_activation_invalid');
   const point=verifyRecoveryPoint({backupId,expectedReleaseId:id});
   if(point.profile!=='desktop-electron'||point.manifestSha256!==before.previous.manifestSha256||
    point.runtimeSha256!==before.previous.runtimeSha256||stable(point.target)!==stable(before.previous.target))
    throw new Error('desktop_package_backup_receipt_invalid');
   const health=validateHealthUrl(healthUrl),probeRoot=freshProbeRoot('rollback',id);
   try{return await releaseOps.rollbackRelease({installRoot:installPath,restoreReleaseId:id,backupId,healthUrl:health,profile,
    desktopLifecycle,probeRoot,privateBackupConfig:backupConfig,userDataRoot,...(hostBackupScript?{hostBackupScript}:{})});}
   catch(error){assertStateUnchanged(before,state());throw error;}
  }
  if(typeof backupId!=='string'||!sha256Pattern.test(backupId)||drained!==true)throw new Error('desktop_package_activation_invalid');
  const health=validateHealthUrl(healthUrl),before=state();
  if(healthProbe!==undefined&&typeof healthProbe!=='function')throw new Error('desktop_package_health_probe_invalid');
  try{return await releaseOps.rollbackRelease({installRoot:installPath,restoreReleaseId:id,backupId,drained,healthUrl:health,profile:'standalone',
   ...(healthProbe?{healthProbe}:{}),...(hostBackupScript?{hostBackupScript}:{})});}
  catch(error){assertStateUnchanged(before,state());throw error;}
 }

 async function createRecoveryPoint({releaseId}={}){
  const id=validateReleaseId(releaseId),current=state();
  if(!backupConfig||typeof releaseOps.createRecoveryPoint!=='function')throw new Error('desktop_package_backup_unavailable');
  if(!current?.active||current.active.releaseId!==id)throw new Error('desktop_package_backup_version_mismatch');
  const receipt=await releaseOps.createRecoveryPoint({installRoot:installPath,releaseId:id,privateBackupConfig:backupConfig,
   ...(profile==='desktop-electron'?{userDataRoot}:{}),...(hostBackupScript?{hostBackupScript}:{})});
  if(!receipt||receipt.verified!==true||receipt.releaseId!==id||typeof receipt.backupId!=='string'||!sha256Pattern.test(receipt.backupId)||receipt.recoveryDigest!==receipt.backupId)
   throw new Error('desktop_package_backup_receipt_invalid');
  return receipt;
 }

 function verifyRecoveryPoint({backupId,expectedReleaseId}={}){
  if(typeof backupId!=='string'||!sha256Pattern.test(backupId)||typeof releaseOps.verifyRecoveryPoint!=='function')throw new Error('desktop_package_backup_unavailable');
  const verified=releaseOps.verifyRecoveryPoint({installRoot:installPath,backupId,
   ...(profile==='desktop-electron'?{privateBackupConfig:backupConfig,userDataRoot}:{}),...(hostBackupScript?{hostBackupScript}:{})});
  if(!verified||verified.backupVerified!==true||verified.backupId!==backupId||(expectedReleaseId!==undefined&&verified.releaseId!==expectedReleaseId))
   throw new Error('desktop_package_backup_receipt_invalid');
  return verified;
 }

 async function uninstallOwnedFiles({manifest,expectedManifestSha256}={}){
  const entries=validateOwnedFiles(manifest,expectedManifestSha256),root=canonicalPath(installPath);
  assertDisjoint(root,userDataPath);
  const inspected=entries.map(entry=>({entry,result:inspectOwnedPath(root,entry.path)}));
  const removed=[],preservedModified=[],missing=[];
  for(const {entry,result}of inspected){
   if(result.kind==='missing'){missing.push(entry.path);continue;}
   const bytes=await readFile(result.path);
   if(bytes.length!==entry.bytes||hash(bytes)!==entry.sha256){preservedModified.push(entry.path);continue;}
   await unlink(result.path);removed.push(entry.path);
  }
  return {removed,preservedModified,missing};
 }

 return Object.freeze({stage,activate,rollback,resolveStagedRelease,createRecoveryPoint,verifyRecoveryPoint,uninstallOwnedFiles});
}
