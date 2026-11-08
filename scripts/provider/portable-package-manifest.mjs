import {createHash} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,lstatSync,openSync,readdirSync,readFileSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';

const manifestName='portable-package-manifest.json';
const sidecarName='portable-package-manifest.sha256';
const transportPrefix='Jot-Desktop/';
const shaPattern=/^[a-f0-9]{64}$/;
const receiptKeys=['electronVersion','nodeVersion','platform','arch','nodeModuleAbi','napiVersion'];
const fail=code=>{throw new Error(code);};
const isRecord=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const exactKeys=(value,keys)=>isRecord(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');

function regularFile(path,code){
 let info,bytes;
 try{info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink())fail(code);bytes=readFileSync(path);}
 catch{fail(code);}
 return bytes;
}

function writeExclusive(path,bytes){
 let fd,created=false;
 try{fd=openSync(path,'wx',0o600);created=true;writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;}
 catch(error){
  if(fd!==undefined)try{closeSync(fd);}catch{}
  if(created)try{unlinkSync(path);}catch{}
  throw error;
 }
}

function safePayloadPath(path){
 if(typeof path!=='string'||!path||path.includes('\\')||path.startsWith('/')||/^[A-Za-z]:/.test(path)||/[\x00-\x1f\x7f]/.test(path))return false;
 const segments=path.split('/');
 if(segments.some(part=>!part||part==='.'||part==='..'))return false;
 if(segments.some(part=>/^\.env(?:$|\.)/i.test(part)||/\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|log)$/i.test(part)))return false;
 return !segments.some(part=>['.git','.data','.cache','.jot-state','.test-tmp','coverage','logs','profile','user-data'].includes(part.toLowerCase()));
}

function inventoryPackage(root){
 const files=[],folded=new Set();
 const visit=(directory,prefix='')=>{
  let entries;try{entries=readdirSync(directory,{withFileTypes:true});}catch{fail('release_portable_package_unreadable');}
  entries.sort((a,b)=>a.name.localeCompare(b.name,'en'));
  for(const entry of entries){
   const path=prefix?prefix+'/'+entry.name:entry.name,absolute=join(directory,entry.name);let info;
   try{info=lstatSync(absolute);}catch{fail('release_portable_package_unreadable');}
   if(entry.isSymbolicLink()||info.isSymbolicLink())fail('release_portable_link_unsupported');
   if(!safePayloadPath(path))fail('release_portable_package_path_invalid');
   if(info.isDirectory()){visit(absolute,path);continue;}
   if(!info.isFile())fail('release_portable_entry_unsupported');
   const key=path.toLowerCase();if(folded.has(key))fail('release_portable_case_collision');folded.add(key);
   const bytes=readFileSync(absolute);files.push({path,size:bytes.length,sha256:hash(bytes)});
  }
 };
 visit(root);files.sort((a,b)=>a.path.localeCompare(b.path,'en'));return files;
}

function runtimeReceipt(path,expectedSha256){
 if(!shaPattern.test(expectedSha256??''))fail('release_portable_expected_digest_invalid');
 const bytes=regularFile(path,'release_portable_runtime_receipt_invalid');
 if(hash(bytes)!==expectedSha256)fail('release_portable_runtime_receipt_invalid');
 let receipt;try{receipt=JSON.parse(bytes.toString('utf8'));}catch{fail('release_portable_runtime_receipt_invalid');}
 if(!exactKeys(receipt,receiptKeys)||typeof receipt.electronVersion!=='string'||!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(receipt.electronVersion)
  ||typeof receipt.nodeVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(receipt.nodeVersion)
  ||receipt.platform!=='win32'||typeof receipt.arch!=='string'||!/^[a-z0-9_-]+$/i.test(receipt.arch)
  ||typeof receipt.nodeModuleAbi!=='string'||!/^\d+$/.test(receipt.nodeModuleAbi)
  ||typeof receipt.napiVersion!=='string'||!/^\d+$/.test(receipt.napiVersion))fail('release_portable_runtime_receipt_invalid');
 return receipt;
}

/** Create the exact candidate manifest consumed by ReleaseOps; caller supplies trusted source/lock/runtime pins. */
export function createDesktopPortableManifest({packageRoot,sourceCommit,sourceTreeSha256,runtimeReceiptPath,
 expectedRuntimeReceiptSha256,electronArchivePath,expectedElectronArchiveSha256,electronRuntimePaths,
 expectedAppLockSha256,expectedRootLockSha256,build,verifyPortablePackage}={}){
 if(typeof verifyPortablePackage!=='function')fail('release_portable_verifier_required');
 if(typeof packageRoot!=='string'||!isAbsolute(packageRoot)||typeof runtimeReceiptPath!=='string'||!isAbsolute(runtimeReceiptPath)
  ||typeof electronArchivePath!=='string'||!isAbsolute(electronArchivePath)
  ||typeof sourceCommit!=='string'||!/^[a-f0-9]{40}$/.test(sourceCommit)||!shaPattern.test(sourceTreeSha256??'')
  ||!shaPattern.test(expectedAppLockSha256??'')||!shaPattern.test(expectedRootLockSha256??'')
  ||!shaPattern.test(expectedElectronArchiveSha256??'')
  ||!exactKeys(build,['nodeVersion','npmVersion','viteVersion'])||Object.values(build).some(value=>typeof value!=='string'||!value))
  fail('release_portable_manifest_input_invalid');
 if(!Array.isArray(electronRuntimePaths)||electronRuntimePaths.length<3
  ||!['Jot.exe','LICENSE','LICENSES.chromium.html'].every(path=>electronRuntimePaths.includes(path))
  ||electronRuntimePaths.some(path=>!safePayloadPath(path)||path.startsWith('resources/app/'))
  ||new Set(electronRuntimePaths.map(path=>path.toLowerCase())).size!==electronRuntimePaths.length)
  fail('release_portable_electron_inventory_invalid');
 const root=resolve(packageRoot??'');let rootInfo;
 try{rootInfo=lstatSync(root);}catch{fail('release_portable_package_root_invalid');}
 if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())fail('release_portable_package_root_invalid');
 const manifestPath=join(root,manifestName),sidecarPath=join(root,sidecarName);
 if(existsSync(manifestPath)||existsSync(sidecarPath))fail('release_portable_manifest_exists');
 const receipt=runtimeReceipt(runtimeReceiptPath,expectedRuntimeReceiptSha256);
 const receiptRelative=relative(root,resolve(runtimeReceiptPath));
 if(receiptRelative===''||(!receiptRelative.startsWith('..'+sep)&&!isAbsolute(receiptRelative)))fail('release_portable_runtime_receipt_invalid');
 const archiveBytes=regularFile(electronArchivePath,'release_portable_electron_archive_invalid');
 const archiveSha256=hash(archiveBytes);if(archiveSha256!==expectedElectronArchiveSha256)fail('release_portable_electron_archive_mismatch');
 const archivePath=resolve(electronArchivePath);
 const archiveRelative=relative(root,archivePath);
 if(archiveRelative===''||(!archiveRelative.startsWith('..'+sep)&&!isAbsolute(archiveRelative)))fail('release_portable_electron_archive_invalid');
 const files=inventoryPackage(root),appPackageFile=files.find(file=>file.path==='resources/app/package.json');
 if(!appPackageFile)fail('release_portable_contract_incomplete');
 let appPackage;try{appPackage=JSON.parse(readFileSync(join(root,'resources','app','package.json'),'utf8'));}catch{fail('release_portable_contract_incomplete');}
 if(typeof appPackage.version!=='string')fail('release_portable_contract_incomplete');
 const fileMap=new Map(files.map(file=>[file.path,file]));
 const runtimeFiles=electronRuntimePaths.map(path=>{
  const file=fileMap.get(path);if(!file)fail('release_portable_electron_inventory_invalid');
  return {path:file.path,size:file.size,sha256:file.sha256};
 }).sort((a,b)=>a.path.localeCompare(b.path,'en'));
 const executable=files.find(file=>file.path==='Jot.exe');
 if(!executable)fail('release_portable_contract_incomplete');
 const runtimeTarget={electronVersion:receipt.electronVersion,nodeVersion:receipt.nodeVersion,platform:receipt.platform,
  arch:receipt.arch,nodeModuleAbi:receipt.nodeModuleAbi,napiVersion:receipt.napiVersion};
 const manifest={
  protocol:'jot.desktop.portable.v1',status:'candidate',appVersion:appPackage.version,sourceCommit,sourceTreeSha256,
  target:{platform:receipt.platform,arch:receipt.arch},packageRoot:transportPrefix,
  entry:{manifest:'resources/app/package.json',main:'apps/desktop/main-entry.mjs'},
  userData:{insidePackage:false,root:'%APPDATA%/Jot',preserves:['jot.db','files/','desktop-notifications.json']},
  releaseOpsV2Profile:'not-verified',installOrActivationPerformed:false,
  electron:{version:receipt.electronVersion,platform:receipt.platform,arch:receipt.arch,archiveSha256,
   executableSha256:executable.sha256,inventorySha256:hash(JSON.stringify(runtimeFiles)),runtimeFiles,
   nodeVersion:receipt.nodeVersion,nodeModuleAbi:receipt.nodeModuleAbi,napiVersion:receipt.napiVersion},
  appLockSha256:expectedAppLockSha256,rootLockSha256:expectedRootLockSha256,runtimeReceiptSha256:expectedRuntimeReceiptSha256,
  build:{...build,rootLockSha256:expectedRootLockSha256},
  files:files.map(file=>({path:transportPrefix+file.path,size:file.size,sha256:file.sha256}))
 };
 const raw=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),manifestSha256=hash(raw);
 let manifestCreated=false,sidecarCreated=false;
 try{
  writeExclusive(manifestPath,raw);manifestCreated=true;
  writeExclusive(sidecarPath,Buffer.from(manifestSha256+'  '+manifestName+'\n'));sidecarCreated=true;
  const verification=verifyPortablePackage({packageRoot:root,expectedManifestSha256:manifestSha256,
   expectedRuntimeReceiptSha256,expectedRuntimeTarget:runtimeTarget,expectedAppLockSha256,expectedRootLockSha256});
  if(verification?.profile!=='desktop-electron'||verification.manifestSha256!==manifestSha256)
   fail('release_portable_verifier_mismatch');
  return {manifest,manifestSha256,packageRoot:root,verification};
 }catch(error){
  if(sidecarCreated)try{rmSync(sidecarPath);}catch{}
  if(manifestCreated)try{rmSync(manifestPath);}catch{}
  throw error;
 }
}

/** Stage only a candidate bound to its external manifest/runtime/lock pins. */
export async function stageDesktopPortableRelease({packageRoot,expectedManifestSha256,installRoot,userDataRoot,
 expectedRuntimeReceiptSha256,expectedRuntimeTarget,expectedAppLockSha256,expectedRootLockSha256,signal,stageRelease}={}){
 if(typeof stageRelease!=='function')fail('release_portable_stage_api_required');
 if(!shaPattern.test(expectedManifestSha256??'')||!shaPattern.test(expectedRuntimeReceiptSha256??'')
  ||!exactKeys(expectedRuntimeTarget,['electronVersion','nodeVersion','platform','arch','nodeModuleAbi','napiVersion'])
  ||!shaPattern.test(expectedAppLockSha256??'')||!shaPattern.test(expectedRootLockSha256??''))
  fail('release_portable_expected_digest_invalid');
 return stageRelease({packageRoot,expectedManifestSha256,installRoot,userDataRoot,profile:'desktop-electron',signal,
  expectedRuntimeReceiptSha256,expectedRuntimeTarget,expectedAppLockSha256,expectedRootLockSha256});
}
