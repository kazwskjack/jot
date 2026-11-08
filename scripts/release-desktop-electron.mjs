import {createHash} from 'node:crypto';
import {lstatSync,readdirSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';

const manifestName='portable-package-manifest.json';
const sidecarName='portable-package-manifest.sha256';
const transportPrefix='Jot-Desktop/';
const shaPattern=/^[a-f0-9]{64}$/;
const semverPattern=/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const isRecord=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>{throw new Error(code);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(isRecord(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 return JSON.stringify(value);
};
const exactKeys=(value,keys)=>isRecord(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const version=value=>typeof value==='string'&&semverPattern.test(value);
const sameArray=(value,expected)=>Array.isArray(value)&&value.length===expected.length&&value.every((item,index)=>item===expected[index]);

function safePayloadPath(path){
 if(typeof path!=='string'||!path.startsWith(transportPrefix)||path.length<=transportPrefix.length
  ||path.includes('\\')||/^[A-Za-z]:/.test(path)||/[\x00-\x1f\x7f]/.test(path))return false;
 const relativePath=path.slice(transportPrefix.length);
 const segments=relativePath.split('/');
 if(segments.some(part=>!part||part==='.'||part==='..'))return false;
 if(segments.some(part=>/^\.env(?:$|\.)/i.test(part)||/\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|log)$/i.test(part)))return false;
 return !segments.some(part=>['.git','.data','.cache','.jot-state','.test-tmp','coverage','logs','profile','user-data'].includes(part.toLowerCase()));
}

function readRegularFile(path,invalidCode){
 let info,bytes;
 try{info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink())fail(invalidCode);bytes=readFileSync(path);}
 catch{fail(invalidCode);}
 return {bytes,sha256:hash(bytes)};
}

function packageInventory(root){
 const files=[],folded=new Set();
 const visit=(directory,prefix='')=>{
  let entries;try{entries=readdirSync(directory,{withFileTypes:true});}catch{fail('release_portable_package_unreadable');}
  for(const entry of entries){
   const path=prefix?prefix+'/'+entry.name:entry.name,absolute=join(directory,entry.name),info=lstatSync(absolute);
   if(entry.isSymbolicLink()||info.isSymbolicLink())fail('release_portable_link_unsupported');
   if(info.isDirectory()){visit(absolute,path);continue;}
   if(!info.isFile())fail('release_portable_entry_unsupported');
   const key=path.toLowerCase();if(folded.has(key))fail('release_portable_case_collision');folded.add(key);
   const bytes=readFileSync(absolute);files.push({path,size:bytes.length,sha256:hash(bytes)});
  }
 };
 visit(root);files.sort((a,b)=>a.path.localeCompare(b.path,'en'));return files;
}

function checkManifestShape(manifest,{expectedRuntimeReceiptSha256,expectedRuntimeTarget,expectedAppLockSha256,expectedRootLockSha256}){
 if(!exactKeys(manifest,['protocol','status','appVersion','sourceCommit','sourceTreeSha256','target','packageRoot','entry','userData',
  'releaseOpsV2Profile','installOrActivationPerformed','electron','appLockSha256','rootLockSha256','runtimeReceiptSha256','build','files'])
  ||manifest.protocol!=='jot.desktop.portable.v1'||manifest.status!=='candidate'||!version(manifest.appVersion)
  ||typeof manifest.sourceCommit!=='string'||!/^[a-f0-9]{40}$/.test(manifest.sourceCommit)
  ||!shaPattern.test(manifest.sourceTreeSha256??'')||manifest.packageRoot!=='Jot-Desktop/'
  ||manifest.releaseOpsV2Profile!=='not-verified'||manifest.installOrActivationPerformed!==false
  ||!shaPattern.test(manifest.appLockSha256??'')||!shaPattern.test(manifest.rootLockSha256??'')
  ||!shaPattern.test(manifest.runtimeReceiptSha256??'')||manifest.runtimeReceiptSha256!==expectedRuntimeReceiptSha256
  ||!exactKeys(manifest.target,['platform','arch'])||!['win32','linux','darwin'].includes(manifest.target.platform)
  ||typeof manifest.target.arch!=='string'||!/^[a-z0-9_-]+$/i.test(manifest.target.arch)
  ||!exactKeys(manifest.entry,['manifest','main'])||manifest.entry.manifest!=='resources/app/package.json'
  ||manifest.entry.main!=='apps/desktop/main-entry.mjs'
  ||!exactKeys(manifest.userData,['insidePackage','root','preserves'])||manifest.userData.insidePackage!==false
  ||manifest.userData.root!=='%APPDATA%/Jot'||!sameArray(manifest.userData.preserves,['jot.db','files/','desktop-notifications.json'])
  ||!exactKeys(manifest.electron,['version','platform','arch','archiveSha256','executableSha256','inventorySha256','runtimeFiles',
   'nodeVersion','nodeModuleAbi','napiVersion'])||!version(manifest.electron.version)
  ||manifest.electron.platform!==manifest.target.platform||manifest.electron.arch!==manifest.target.arch
  ||!shaPattern.test(manifest.electron.archiveSha256??'')||!shaPattern.test(manifest.electron.executableSha256??'')
  ||!shaPattern.test(manifest.electron.inventorySha256??'')||typeof manifest.electron.nodeVersion!=='string'
  ||!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.electron.nodeVersion)
  ||typeof manifest.electron.nodeModuleAbi!=='string'||!/^[0-9]+$/.test(manifest.electron.nodeModuleAbi)
  ||typeof manifest.electron.napiVersion!=='string'||!/^[0-9]+$/.test(manifest.electron.napiVersion)
  ||!exactKeys(manifest.build,['nodeVersion','npmVersion','viteVersion','rootLockSha256'])
  ||![manifest.build.nodeVersion,manifest.build.npmVersion,manifest.build.viteVersion].every(value=>typeof value==='string'&&value.length>0)
  ||manifest.build.rootLockSha256!==manifest.rootLockSha256||!Array.isArray(manifest.electron.runtimeFiles)
  ||!Array.isArray(manifest.files)||manifest.files.length<1)fail('release_portable_manifest_invalid');

 if(manifest.appLockSha256!==expectedAppLockSha256)fail('release_portable_app_lock_mismatch');
 if(manifest.rootLockSha256!==expectedRootLockSha256)fail('release_portable_root_lock_mismatch');

 if(!exactKeys(expectedRuntimeTarget,['electronVersion','nodeVersion','platform','arch','nodeModuleAbi','napiVersion'])
  ||manifest.electron.version!==expectedRuntimeTarget.electronVersion
  ||manifest.electron.nodeVersion!==expectedRuntimeTarget.nodeVersion
  ||manifest.electron.platform!==expectedRuntimeTarget.platform||manifest.electron.arch!==expectedRuntimeTarget.arch
  ||manifest.electron.nodeModuleAbi!==expectedRuntimeTarget.nodeModuleAbi
  ||manifest.electron.napiVersion!==expectedRuntimeTarget.napiVersion)fail('release_portable_runtime_target_mismatch');

 let prior='',folded=new Set();
 for(const file of manifest.files){
  if(!exactKeys(file,['path','size','sha256'])||!safePayloadPath(file.path)||!Number.isSafeInteger(file.size)||file.size<0
   ||!shaPattern.test(file.sha256??'')||file.path.localeCompare(prior,'en')<0)fail('release_portable_manifest_invalid');
  const key=file.path.toLowerCase();if(folded.has(key))fail('release_portable_case_collision');folded.add(key);prior=file.path;
 }
 prior='';folded=new Set();
 for(const file of manifest.electron.runtimeFiles){
  if(!exactKeys(file,['path','size','sha256'])||typeof file.path!=='string'||!file.path||file.path.includes('\\')
   ||file.path.startsWith('/')||file.path.split('/').some(part=>!part||part==='.'||part==='..')||/[\x00-\x1f\x7f]/.test(file.path)
   ||!Number.isSafeInteger(file.size)||file.size<0||!shaPattern.test(file.sha256??'')||file.path.localeCompare(prior,'en')<0)
   fail('release_portable_electron_inventory_invalid');
  const key=file.path.toLowerCase();if(folded.has(key))fail('release_portable_electron_inventory_invalid');folded.add(key);prior=file.path;
 }
 if(hash(JSON.stringify(manifest.electron.runtimeFiles))!==manifest.electron.inventorySha256)fail('release_portable_electron_inventory_invalid');
}

function runtimeTarget(manifest){
 const electron=manifest.electron;
 return {profile:'desktop-electron',runtimeKind:'electron',electronVersion:electron.version,platform:electron.platform,arch:electron.arch,
  nodeVersion:electron.nodeVersion,abi:{node:electron.nodeModuleAbi,napi:electron.napiVersion},
  electronArchiveSha256:electron.archiveSha256,electronExecutableSha256:electron.executableSha256};
}

export function verifyDesktopPortablePackage({packageRoot,expectedManifestSha256,expectedRuntimeReceiptSha256,expectedRuntimeTarget,
 expectedAppLockSha256,expectedRootLockSha256,allowRuntimeManifest=false}){
 if(!shaPattern.test(expectedManifestSha256??'')||!shaPattern.test(expectedRuntimeReceiptSha256??''))fail('release_portable_expected_digest_invalid');
 if(!shaPattern.test(expectedAppLockSha256??''))fail('release_portable_app_lock_mismatch');
 if(!shaPattern.test(expectedRootLockSha256??''))fail('release_portable_root_lock_mismatch');
 let rootInfo;try{rootInfo=lstatSync(resolve(packageRoot));}catch{fail('release_portable_package_root_invalid');}
 if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())fail('release_portable_package_root_invalid');
 const root=resolve(packageRoot),manifestPath=join(root,manifestName),sidecarPath=join(root,sidecarName);
 const manifestFile=readRegularFile(manifestPath,'release_portable_manifest_invalid');
 if(manifestFile.sha256!==expectedManifestSha256)fail('release_portable_manifest_digest_mismatch');
 const sidecar=readRegularFile(sidecarPath,'release_portable_manifest_invalid');
 if(sidecar.bytes.toString('utf8')!==expectedManifestSha256+'  '+manifestName+'\n')fail('release_portable_manifest_digest_mismatch');
 let manifest;try{manifest=JSON.parse(manifestFile.bytes.toString('utf8'));}catch{fail('release_portable_manifest_invalid');}
 if(JSON.stringify(manifest,null,2)+'\n'!==manifestFile.bytes.toString('utf8'))fail('release_portable_manifest_invalid');
 checkManifestShape(manifest,{expectedRuntimeReceiptSha256,expectedRuntimeTarget,expectedAppLockSha256,expectedRootLockSha256});

 const actual=packageInventory(root),metadata=new Set([manifestName,sidecarName]);
 if(allowRuntimeManifest)metadata.add('release-runtime.json');
 const actualPayload=actual.filter(item=>!metadata.has(item.path));
 const expected=manifest.files.map(item=>({path:item.path.slice(transportPrefix.length),size:item.size,sha256:item.sha256}));
 if(actualPayload.length!==expected.length||actualPayload.some((item,index)=>item.path!==expected[index].path
  ||item.size!==expected[index].size||item.sha256!==expected[index].sha256))fail('release_portable_package_inventory_mismatch');

 const fileMap=new Map(actualPayload.map(item=>[item.path,item]));
 for(const runtime of manifest.electron.runtimeFiles){
  const file=fileMap.get(runtime.path);if(!file||file.size!==runtime.size||file.sha256!==runtime.sha256)fail('release_portable_electron_inventory_invalid');
 }
 if(fileMap.get('Jot.exe')?.sha256!==manifest.electron.executableSha256)fail('release_portable_electron_inventory_invalid');
 for(const path of ['Jot.exe','JOT-LICENSE.txt','LICENSE','LICENSES.chromium.html','THIRD_PARTY_NOTICES.txt',
  'resources/app/package.json','resources/app/apps/desktop/main-entry.mjs',
  'resources/app/apps/desktop/preload.cjs','resources/app/src/server.mjs','resources/app/dist/workbench.html']){
  if(!fileMap.has(path))fail('release_portable_contract_incomplete');
 }
 const appPackagePath=join(root,'resources','app','package.json');
 let appPackage;
 try{appPackage=JSON.parse(readFileSync(appPackagePath,'utf8'));}
 catch{fail('release_portable_contract_incomplete');}
 if(appPackage.type!=='module'||appPackage.main!==manifest.entry.main||appPackage.version!==manifest.appVersion
  ||appPackage.dependencies?.fastify!=='5.12.5'||typeof appPackage.name!=='string')
  fail('release_portable_contract_incomplete');

 return {manifest,manifestSha256:expectedManifestSha256,sourceTag:null,sourceCommit:manifest.sourceCommit,
  sourceTreeSha256:manifest.sourceTreeSha256,profile:'desktop-electron',target:runtimeTarget(manifest),
  runtimeReceiptSha256:manifest.runtimeReceiptSha256,appLockSha256:manifest.appLockSha256,
  license:{jot:'JOT-LICENSE.txt',electron:'LICENSE',chromium:'LICENSES.chromium.html',thirdParty:'THIRD_PARTY_NOTICES.txt'},
  fileCount:manifest.files.length,packageRoot:root,
  files:manifest.files};
}
