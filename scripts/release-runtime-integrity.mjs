import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readlinkSync,readdirSync,realpathSync,statSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,relative,resolve,toNamespacedPath} from 'node:path';

export const runtimeProtocol=2;
export const desktopRuntimeProtocol=3;
const runtimeManifestName='release-runtime.json';
const shaPattern=/^[a-f0-9]{64}$/;
const lockNames=['gateway','root'];
const licenseFilePattern=/^(?:licen[cs]es?|copying|notices?|third[._ -]?party[._ -]?notices?)(?:[._ -].*)?$/i;
const licenseDirectoryPattern=/^licen[cs]es?$/i;
const mutableRuntimeSegments=new Set(['.cache','.data','.jot-state','.test-tmp','coverage','logs','uploads','workspaces']);
const privateRuntimeName=/^(?:\.env(?:$|\.)|.*\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|log))$/i;
const isRecord=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>{throw new Error(code);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(isRecord(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 return JSON.stringify(value);
};
const encode=value=>canonical(value)+'\n';
const posix=value=>value.split(/[\\/]+/).join('/');
const fsPath=value=>toNamespacedPath(resolve(value));
const pathInside=(path,root)=>{
 const rel=relative(resolve(root),resolve(path));
 return rel===''||(rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../')&&!isAbsolute(rel));
};
const lockPath=profile=>profile==='standalone'?'package-lock.json':'packages/gateway/package-lock.json';
const packageJsonPath=profile=>profile==='standalone'?'package.json':'packages/gateway/package.json';
const packageInstallRoot=profile=>profile==='standalone'?'':'packages/gateway';

function safePath(path){
 if(typeof path!=='string'||!path||path.length>4096||path.includes('\\')||path.startsWith('/')||/^[A-Za-z]:/.test(path)||/[\x00-\x1f\x7f]/.test(path))return false;
 return !path.split('/').some(part=>!part||part==='.'||part==='..');
}
function assertRuntimeRoot(root){
 let info;try{info=lstatSync(fsPath(root));}catch{fail('release_runtime_root_invalid');}
 if(!info.isDirectory()||info.isSymbolicLink())fail('release_runtime_root_invalid');
 return resolve(root);
}
function readBytes(path,code){
 try{return readFileSync(fsPath(path));}catch{fail(code);}
}
function readJson(path,code){
 try{
  const raw=readBytes(path,code),value=JSON.parse(raw.toString('utf8'));
  if(!isRecord(value))fail(code);
  return {raw,value};
 }catch{fail(code);}
}
function sourceState(root,expectedSha,sourceLocks){
 if(!shaPattern.test(expectedSha??''))fail('release_runtime_source_manifest_mismatch');
 const {raw,value}=readJson(join(root,'release-manifest.json'),'release_runtime_source_manifest_mismatch');
 if(raw.toString('utf8')!==encode(value)||hash(canonical(value))!==expectedSha)fail('release_runtime_source_manifest_mismatch');
 const declared={root:value?.packages?.root?.lockSha256,gateway:value?.packages?.gateway?.lockSha256};
 if(!isRecord(sourceLocks)||Object.keys(sourceLocks).sort().join(',')!=='gateway,root'
  ||lockNames.some(name=>!shaPattern.test(sourceLocks[name]??'')||sourceLocks[name]!==declared[name]))fail('release_runtime_source_manifest_mismatch');
 for(const name of lockNames){
  const actual=hash(readBytes(join(root,name==='root'?'package-lock.json':'packages/gateway/package-lock.json'),'release_runtime_lock_mismatch'));
  if(actual!==sourceLocks[name])fail('release_runtime_lock_mismatch');
 }
 return value;
}
function desktopSourceState(root,expectedSha,sourceLocks){
 if(!shaPattern.test(expectedSha??'')||!isRecord(sourceLocks)||Object.keys(sourceLocks).join(',')!=='desktop'
  ||!shaPattern.test(sourceLocks.desktop??''))fail('release_runtime_source_manifest_mismatch');
 const {raw,value}=readJson(join(root,'portable-package-manifest.json'),'release_runtime_source_manifest_mismatch');
 const sidecar=readBytes(join(root,'portable-package-manifest.sha256'),'release_runtime_source_manifest_mismatch').toString('utf8');
 if(raw.toString('utf8')!==JSON.stringify(value,null,2)+'\n'||hash(raw)!==expectedSha
  ||sidecar!==expectedSha+'  portable-package-manifest.json\n'||value.protocol!=='jot.desktop.portable.v1'
  ||value.appLockSha256!==sourceLocks.desktop)fail('release_runtime_source_manifest_mismatch');
 return value;
}
function targetBinding(profile,npmVersion){
 if(!['standalone','gateway'].includes(profile)||typeof npmVersion!=='string'||!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(npmVersion))fail('release_runtime_target_invalid');
 let libc='unknown';
 try{
  const header=process.report?.getReport?.().header??{};
  if(process.platform==='linux')libc=header.glibcVersionRuntime?`glibc-${header.glibcVersionRuntime}`:'linux-libc-unknown';
  else if(process.platform==='win32')libc='msvc';
  else if(process.platform==='darwin')libc='darwin-libsystem';
 }catch{}
 return {profile,platform:process.platform,arch:process.arch,abi:{node:process.versions.modules??null,napi:process.versions.napi??null},
  nodeVersion:process.version,npmVersion,libc};
}
function sortEntries(entries){return entries.sort((a,b)=>a.path.localeCompare(b.path,'en'));}
function validDesktopTarget(target){
 return isRecord(target)&&Object.keys(target).sort().join(',')==='abi,arch,electronArchiveSha256,electronExecutableSha256,electronVersion,nodeVersion,platform,profile,runtimeKind'
  &&target.profile==='desktop-electron'&&target.runtimeKind==='electron'&&typeof target.platform==='string'&&typeof target.arch==='string'
  &&/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(target.electronVersion??'')
  &&/^\d+\.\d+\.\d+$/.test(target.nodeVersion??'')&&isRecord(target.abi)
  &&Object.keys(target.abi).sort().join(',')==='napi,node'&&/^\d+$/.test(target.abi.node??'')&&/^\d+$/.test(target.abi.napi??'')
  &&shaPattern.test(target.electronArchiveSha256??'')&&shaPattern.test(target.electronExecutableSha256??'');
}
function bindDesktopTarget(target,source){
 const electron=source?.electron;
 return validDesktopTarget(target)&&isRecord(source?.target)&&source.target.platform===target.platform&&source.target.arch===target.arch
  &&isRecord(electron)&&electron.version===target.electronVersion&&electron.platform===target.platform&&electron.arch===target.arch
  &&electron.nodeVersion===target.nodeVersion&&electron.nodeModuleAbi===target.abi.node&&electron.napiVersion===target.abi.napi
  &&electron.archiveSha256===target.electronArchiveSha256&&electron.executableSha256===target.electronExecutableSha256
  &&shaPattern.test(source.runtimeReceiptSha256??'');
}
export function validateRuntimeSymlink({root,path,target:rawTarget,realpath=realpathSync,lstat=lstatSync}){
 if(typeof rawTarget!=='string'||!rawTarget||rawTarget.length>4096||/[\x00-\x1f\x7f]/.test(rawTarget))fail('release_runtime_symlink_invalid');
 const linkPath=join(root,...path.split('/'));
 const candidate=resolve(dirname(linkPath),rawTarget);
 if(!pathInside(candidate,root))fail('release_runtime_symlink_escape');
 let realRoot,realTarget,targetInfo,parentReal;
 try{
  realRoot=realpath(resolve(root));realTarget=realpath(resolve(candidate));
  targetInfo=lstat(fsPath(candidate));parentReal=realpath(resolve(dirname(linkPath)));
 }catch{fail('release_runtime_symlink_invalid');}
 if(!pathInside(realTarget,realRoot))fail('release_runtime_symlink_escape');
 if(targetInfo.isDirectory()&&pathInside(parentReal,realTarget))fail('release_runtime_symlink_cycle');
 if(!targetInfo.isFile()&&!targetInfo.isDirectory()&&!targetInfo.isSymbolicLink())fail('release_runtime_entry_unsupported');
 return rawTarget;
}
export function assertNoDirectorySymlinkCycles({root,readdir=readdirSync,lstat=lstatSync,readlink=readlinkSync,realpath=realpathSync,stat=statSync}){
 const pathKey=value=>{
  const resolved=resolve(value).replace(/^\\\\\?\\/,'');
  return process.platform==='win32'?resolved.toLowerCase():resolved;
 };
 const visit=(directory,ancestry=[])=>{
  let realDirectory,children;
  try{realDirectory=realpath(resolve(directory));children=readdir(fsPath(directory),{withFileTypes:true});}
  catch{fail('release_runtime_inventory_unreadable');}
  const key=pathKey(realDirectory);if(ancestry.includes(key))fail('release_runtime_symlink_cycle');
  const next=[...ancestry,key];
  for(const child of children){
   const absolute=join(directory,child.name);let info;
   try{info=lstat(fsPath(absolute));}catch{fail('release_runtime_inventory_unreadable');}
   if(info.isSymbolicLink()){
    let rawTarget,targetInfo;
    try{rawTarget=readlink(fsPath(absolute));targetInfo=stat(fsPath(resolve(dirname(absolute),rawTarget)));}
    catch{fail('release_runtime_symlink_invalid');}
    if(targetInfo.isDirectory())visit(resolve(dirname(absolute),rawTarget),next);
   }else if(info.isDirectory())visit(absolute,next);
  }
 };
 visit(root);
}
function resolveSymlink(root,path,rawTarget){return validateRuntimeSymlink({root,path,target:rawTarget});}
function runtimeInventory(root){
 const entries=[],casePaths=new Set(),rootPath=assertRuntimeRoot(root);
 const addCase=path=>{
  const key=path.toLowerCase();if(casePaths.has(key))fail('release_runtime_case_collision');casePaths.add(key);
 };
 const visit=(folder,prefix='')=>{
  let children;
  try{children=readdirSync(fsPath(folder),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'));}
  catch{fail('release_runtime_inventory_unreadable');}
  for(const child of children){
   const path=prefix?prefix+'/'+child.name:child.name;
   if(!safePath(path))fail('release_runtime_path_invalid');
   addCase(path);
   const absolute=join(folder,child.name);let info;
   try{info=lstatSync(fsPath(absolute));}catch{fail('release_runtime_inventory_unreadable');}
   if(path===runtimeManifestName){if(!info.isFile()||info.isSymbolicLink())fail('release_runtime_manifest_invalid');continue;}
   const dependencyPath=path.startsWith('node_modules/')||path.startsWith('packages/gateway/node_modules/');
   const segments=path.split('/');
   if(!dependencyPath&&(segments.some(part=>mutableRuntimeSegments.has(part))||privateRuntimeName.test(basename(path))))fail('release_runtime_mutable_path');
   if(info.isSymbolicLink()){
    let target;try{target=readlinkSync(fsPath(absolute));}catch{fail('release_runtime_inventory_unreadable');}
    entries.push({path,type:'symlink',target:resolveSymlink(rootPath,path,target)});
   }else if(info.isDirectory()){
    entries.push({path,type:'directory'});visit(absolute,path);
   }else if(info.isFile()){
    const bytes=readBytes(absolute,'release_runtime_inventory_unreadable');entries.push({path,type:'file',bytes:bytes.length,sha256:hash(bytes)});
   }else fail('release_runtime_entry_unsupported');
  }
 };
 visit(rootPath);
 assertNoDirectorySymlinkCycles({root:rootPath});
 return sortEntries(entries);
}
function parsePackageJson(root,path){
 const {value}=readJson(join(root,...path.split('/')),'release_runtime_dependency_mismatch');
 if(typeof value.name!=='string'||typeof value.version!=='string')fail('release_runtime_dependency_mismatch');
 return value;
}
function packageEvidence(root,profile,files){
 const packageRoot=packageInstallRoot(profile),manifestPath=packageJsonPath(profile),lockFile=lockPath(profile);
 const manifest=parsePackageJson(root,manifestPath),lock=readJson(join(root,lockFile),'release_runtime_dependency_mismatch').value;
 const lockRoot=lock?.packages?.[''];
 if(lock?.lockfileVersion!==3||!isRecord(lockRoot)||lockRoot.name!==manifest.name||lockRoot.version!==manifest.version
  ||canonical(lockRoot.dependencies??{})!==canonical(manifest.dependencies??{})
  ||canonical(lockRoot.devDependencies??{})!==canonical(manifest.devDependencies??{})
  ||canonical(lockRoot.optionalDependencies??{})!==canonical(manifest.optionalDependencies??{}))fail('release_runtime_dependency_mismatch');
 const nodeModulesPath=packageRoot?packageRoot+'/node_modules':'node_modules';
 const packagesByPath=new Map();
 const packagePaths=new Set();
 const packageSegment='(?:@[^/]+/[^/]+|[^/]+)';
 const packageJsonPattern=new RegExp('^'+nodeModulesPath.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/'+packageSegment+'(?:/node_modules/'+packageSegment+')*/package\\.json$');
 for(const item of files){
  if(item.type!=='file'||!packageJsonPattern.test(item.path))continue;
  const installPath=item.path.slice(0,-'/package.json'.length);
  const value=parsePackageJson(root,item.path);
  const relativeLockPath=installPath.slice(packageRoot?packageRoot.length+1:0);
  const locked=lock.packages?.[relativeLockPath];
  if(!isRecord(locked)||locked.link===true||locked.dev===true||locked.devOptional===true||locked.version!==value.version)fail('release_runtime_dependency_mismatch');
  const licenseFiles=files.filter(file=>{
   if(file.type!=='file'||!file.path.startsWith(installPath+'/'))return false;
   const relativePath=file.path.slice(installPath.length+1),segments=relativePath.split('/');
   if(segments.includes('node_modules'))return false;
   return licenseFilePattern.test(basename(file.path))||segments.some(segment=>licenseDirectoryPattern.test(segment));
  }).map(file=>({path:file.path,bytes:file.bytes,sha256:file.sha256}));
  packagePaths.add(installPath);
  packagesByPath.set(installPath,{name:value.name,version:value.version,installPath,resolved:locked.resolved??null,
   integrity:locked.integrity??null,license:value.license??null,optional:locked.optional===true,licenseFiles});
 }
 for(const [lockedPath,locked]of Object.entries(lock.packages??{})){
  if(lockedPath.startsWith('node_modules/')&&locked.link===true)fail('release_runtime_dependency_mismatch');
  if(!lockedPath.startsWith('node_modules/')||locked.dev===true||locked.devOptional===true||locked.optional===true)continue;
  const installPath=packageRoot?packageRoot+'/'+lockedPath:lockedPath;
  if(!packagesByPath.has(installPath))fail('release_runtime_dependency_mismatch');
 }
 const moduleRoots=new Set([nodeModulesPath,...[...packagePaths].map(path=>path+'/node_modules')]);
 const otherProfileNodeModules=packageRoot?'node_modules':'packages/gateway/node_modules';
 if(files.some(item=>item.path===otherProfileNodeModules||item.path.startsWith(otherProfileNodeModules+'/')))
  fail('release_runtime_dependency_mismatch');
 for(const item of files){
  const segments=item.path.split('/');
  for(let index=0;index<segments.length;index++){
   if(segments[index]!=='node_modules')continue;
   const modulesRoot=segments.slice(0,index+1).join('/');
   if(!moduleRoots.has(modulesRoot))continue;
   const first=segments[index+1];if(first===undefined)continue;
   if(first==='.bin'||(first==='.package-lock.json'&&index+2===segments.length))continue;
   const scoped=first.startsWith('@'),parts=scoped?2:1;
   if(scoped&&segments[index+2]===undefined){
    const scopePath=segments.slice(0,index+2).join('/');
    if(![...packagePaths].some(path=>path.startsWith(scopePath+'/')))fail('release_runtime_dependency_mismatch');
    continue;
   }
   const packagePath=segments.slice(0,index+1+parts).join('/');
   if(!packagePaths.has(packagePath))fail('release_runtime_dependency_mismatch');
  }
 }
 for(const [name,version]of Object.entries(manifest.dependencies??{})){
  if(typeof version!=='string'||!name)fail('release_runtime_dependency_mismatch');
  const direct=packageRoot?`${packageRoot}/node_modules/${name}`:`node_modules/${name}`;
  if(!packagesByPath.has(direct))fail('release_runtime_dependency_mismatch');
 }
 for(const [name,version]of Object.entries(manifest.optionalDependencies??{})){
  if(typeof version!=='string'||!name)fail('release_runtime_dependency_mismatch');
 }
 const result=[...packagesByPath.values()].sort((a,b)=>a.installPath.localeCompare(b.installPath,'en'));
 return result;
}
function desktopPackageEvidence(root,files){
 const appRoot='resources/app',modulesRoot=appRoot+'/node_modules';
 const app=parsePackageJson(root,appRoot+'/package.json');
 if(app.type!=='module'||app.main!=='apps/desktop/main-entry.mjs'||typeof app.name!=='string'||typeof app.version!=='string')
  fail('release_runtime_dependency_mismatch');
 if(!files.some(file=>file.type==='file'&&file.path===appRoot+'/'+app.main))fail('release_runtime_dependency_mismatch');
 const packagePaths=new Set(),packagesByPath=new Map();
 const packageJsonPattern=/^resources\/app\/node_modules\/(?:@[^/]+\/[^/]+|[^/]+)(?:\/node_modules\/(?:@[^/]+\/[^/]+|[^/]+))*\/package\.json$/;
 for(const file of files){
  if(file.type!=='file'||!packageJsonPattern.test(file.path))continue;
  const installPath=file.path.slice(0,-'/package.json'.length),value=parsePackageJson(root,file.path);
  if(!safePath(installPath)||typeof value.name!=='string'||typeof value.version!=='string')fail('release_runtime_dependency_mismatch');
  const licenseFiles=files.filter(item=>item.type==='file'&&item.path.startsWith(installPath+'/')
   &&licenseFilePattern.test(basename(item.path))).map(item=>({path:item.path,bytes:item.bytes,sha256:item.sha256}));
  packagePaths.add(installPath);
  packagesByPath.set(installPath,{name:value.name,version:value.version,installPath,resolved:null,integrity:null,
   license:value.license??null,optional:false,licenseFiles});
 }
 const moduleRoots=new Set([modulesRoot,...[...packagePaths].map(path=>path+'/node_modules')]);
 for(const file of files){
  const segments=file.path.split('/');
  for(let index=0;index<segments.length;index++){
   if(segments[index]!=='node_modules')continue;
   const base=segments.slice(0,index+1).join('/');if(!moduleRoots.has(base))continue;
   const first=segments[index+1];if(first===undefined)continue;
   if(first==='.bin'||first==='.package-lock.json')continue;
   const scoped=first.startsWith('@'),parts=scoped?2:1;
   if(scoped&&segments[index+2]===undefined){
    const scopePath=segments.slice(0,index+2).join('/');
    if(![...packagePaths].some(path=>path.startsWith(scopePath+'/')))fail('release_runtime_dependency_mismatch');
    continue;
   }
   const packagePath=segments.slice(0,index+1+parts).join('/');
   if(!packagePaths.has(packagePath))fail('release_runtime_dependency_mismatch');
  }
 }
 for(const [name,version]of Object.entries(app.dependencies??{})){
  if(typeof version!=='string'||!name||packagesByPath.get(modulesRoot+'/'+name)?.version!==version)fail('release_runtime_dependency_mismatch');
 }
 return [...packagesByPath.values()].sort((a,b)=>a.installPath.localeCompare(b.installPath,'en'));
}
function validateManifest(manifest,expectedRuntimeSha256,expectedSourceManifestSha256,expectedTarget){
 const keys='files,lockSha256,packages,profile,protocol,sha256,sourceLocks,sourceManifestSha256,target';
 if(!isRecord(manifest)||Object.keys(manifest).sort().join(',')!==keys||manifest.protocol!==runtimeProtocol
  ||!['standalone','gateway'].includes(manifest.profile)||manifest.target?.profile!==manifest.profile
  ||!shaPattern.test(manifest.sourceManifestSha256??'')||!shaPattern.test(manifest.sha256??'')
  ||!shaPattern.test(manifest.lockSha256??'')||!isRecord(manifest.sourceLocks)||Object.keys(manifest.sourceLocks).sort().join(',')!=='gateway,root'
  ||lockNames.some(name=>!shaPattern.test(manifest.sourceLocks[name]??''))||!Array.isArray(manifest.files)||!Array.isArray(manifest.packages))fail('release_runtime_manifest_invalid');
 const {sha256,...content}=manifest;
 if(hash(canonical(content))!==sha256||expectedRuntimeSha256!==sha256)fail('release_runtime_digest_mismatch');
 if(expectedSourceManifestSha256!==manifest.sourceManifestSha256)fail('release_runtime_source_manifest_mismatch');
 if(canonical(expectedTarget)!==canonical(manifest.target))fail('release_runtime_target_mismatch');
 let prior='',casePaths=new Set();
 for(const item of manifest.files){
  if(!isRecord(item)||!safePath(item.path)||item.path===runtimeManifestName||item.path.localeCompare(prior,'en')<0)fail('release_runtime_manifest_invalid');
  const key=item.path.toLowerCase();if(casePaths.has(key))fail('release_runtime_case_collision');casePaths.add(key);prior=item.path;
  if(item.type==='file'){
   if(Object.keys(item).sort().join(',')!=='bytes,path,sha256,type'||!Number.isSafeInteger(item.bytes)||item.bytes<0||!shaPattern.test(item.sha256))fail('release_runtime_manifest_invalid');
  }else if(item.type==='directory'){
   if(Object.keys(item).sort().join(',')!=='path,type')fail('release_runtime_manifest_invalid');
  }else if(item.type==='symlink'){
   if(Object.keys(item).sort().join(',')!=='path,target,type'||typeof item.target!=='string'||!item.target||item.target.length>4096)fail('release_runtime_manifest_invalid');
  }else fail('release_runtime_manifest_invalid');
 }
 if(!manifest.files.some(file=>file.path==='release-manifest.json'&&file.type==='file'))fail('release_runtime_manifest_invalid');
 if(!manifest.packages.every(item=>isRecord(item)&&Object.keys(item).sort().join(',')==='installPath,integrity,license,licenseFiles,name,optional,resolved,version'
  &&typeof item.name==='string'&&typeof item.version==='string'&&safePath(item.installPath)&&Array.isArray(item.licenseFiles)))fail('release_runtime_manifest_invalid');
}

function validateDesktopManifest(manifest,expectedRuntimeSha256,expectedSourceManifestSha256,expectedTarget){
 const keys='files,lockSha256,packages,profile,protocol,sha256,sourceLocks,sourceManifestSha256,target';
 if(!isRecord(manifest)||Object.keys(manifest).sort().join(',')!==keys||manifest.protocol!==desktopRuntimeProtocol
  ||manifest.profile!=='desktop-electron'||!shaPattern.test(manifest.sourceManifestSha256??'')
  ||!shaPattern.test(manifest.sha256??'')||!shaPattern.test(manifest.lockSha256??'')
  ||!isRecord(manifest.sourceLocks)||Object.keys(manifest.sourceLocks).join(',')!=='desktop'
  ||!shaPattern.test(manifest.sourceLocks.desktop??'')||manifest.lockSha256!==manifest.sourceLocks.desktop
  ||!validDesktopTarget(manifest.target)||!Array.isArray(manifest.files)||!Array.isArray(manifest.packages))fail('release_runtime_manifest_invalid');
 const {sha256,...content}=manifest;
 if(hash(canonical(content))!==sha256||expectedRuntimeSha256!==sha256)fail('release_runtime_digest_mismatch');
 if(expectedSourceManifestSha256!==manifest.sourceManifestSha256)fail('release_runtime_source_manifest_mismatch');
 if(canonical(expectedTarget)!==canonical(manifest.target))fail('release_runtime_target_mismatch');
 let prior='',casePaths=new Set();
 for(const item of manifest.files){
  if(!isRecord(item)||!safePath(item.path)||item.path===runtimeManifestName||item.path.localeCompare(prior,'en')<0)fail('release_runtime_manifest_invalid');
  const key=item.path.toLowerCase();if(casePaths.has(key))fail('release_runtime_case_collision');casePaths.add(key);prior=item.path;
  if(item.type==='file'){
   if(Object.keys(item).sort().join(',')!=='bytes,path,sha256,type'||!Number.isSafeInteger(item.bytes)||item.bytes<0||!shaPattern.test(item.sha256))fail('release_runtime_manifest_invalid');
  }else if(item.type==='directory'){
   if(Object.keys(item).sort().join(',')!=='path,type')fail('release_runtime_manifest_invalid');
  }else if(item.type==='symlink'){
   if(Object.keys(item).sort().join(',')!=='path,target,type'||typeof item.target!=='string'||!item.target||item.target.length>4096)fail('release_runtime_manifest_invalid');
  }else fail('release_runtime_manifest_invalid');
 }
 for(const path of ['portable-package-manifest.json','portable-package-manifest.sha256','Jot.exe','resources/app/package.json'])
  if(!manifest.files.some(file=>file.path===path&&file.type==='file'))fail('release_runtime_manifest_invalid');
 if(!manifest.packages.every(item=>isRecord(item)&&Object.keys(item).sort().join(',')==='installPath,integrity,license,licenseFiles,name,optional,resolved,version'
  &&typeof item.name==='string'&&typeof item.version==='string'&&safePath(item.installPath)&&Array.isArray(item.licenseFiles)))fail('release_runtime_manifest_invalid');
}

export function createRuntimeManifest({root,profile,sourceManifestSha256,sourceLocks,npmVersion,target}){
 const runtimeRoot=assertRuntimeRoot(root);
 if(profile==='desktop-electron'){
  const source=desktopSourceState(runtimeRoot,sourceManifestSha256,sourceLocks);
  if(!bindDesktopTarget(target,source))fail('release_runtime_target_invalid');
  const files=runtimeInventory(runtimeRoot),packages=desktopPackageEvidence(runtimeRoot,files),lockSha256=sourceLocks.desktop;
  const manifest={protocol:desktopRuntimeProtocol,profile,sourceManifestSha256,sourceLocks,lockSha256,target,packages,files};
  const runtimeSha256=hash(canonical(manifest));
  return {manifest:{...manifest,sha256:runtimeSha256},runtimeSha256,target,source};
 }
 const source=sourceState(runtimeRoot,sourceManifestSha256,sourceLocks),runtimeTarget=targetBinding(profile,npmVersion);
 const expectedLock=profile==='standalone'?sourceLocks.root:sourceLocks.gateway;
 const files=runtimeInventory(runtimeRoot),packages=packageEvidence(runtimeRoot,profile,files);
 const manifest={protocol:runtimeProtocol,profile,sourceManifestSha256,sourceLocks,lockSha256:expectedLock,target:runtimeTarget,packages,files};
 const runtimeSha256=hash(canonical(manifest));
 return {manifest:{...manifest,sha256:runtimeSha256},runtimeSha256,target:runtimeTarget,source};
}

export function verifyRuntimeManifest({root,expectedRuntimeSha256,expectedSourceManifestSha256,expectedTarget}){
 const runtimeRoot=assertRuntimeRoot(root),manifestPath=join(runtimeRoot,runtimeManifestName);
 const {raw, value:manifest}=readJson(manifestPath,'release_runtime_manifest_invalid');
 if(raw.toString('utf8')!==encode(manifest))fail('release_runtime_manifest_invalid');
 if(manifest.protocol===desktopRuntimeProtocol){
  validateDesktopManifest(manifest,expectedRuntimeSha256,expectedSourceManifestSha256,expectedTarget);
  const source=desktopSourceState(runtimeRoot,expectedSourceManifestSha256,manifest.sourceLocks);
  if(!bindDesktopTarget(manifest.target,source))fail('release_runtime_target_mismatch');
  const files=runtimeInventory(runtimeRoot);
  if(canonical(files)!==canonical(manifest.files))fail('release_runtime_hash_mismatch');
  const packages=desktopPackageEvidence(runtimeRoot,files);
  if(canonical(packages)!==canonical(manifest.packages))fail('release_runtime_dependency_mismatch');
  return {manifest,runtimeSha256:manifest.sha256,target:manifest.target,source};
 }
 validateManifest(manifest,expectedRuntimeSha256,expectedSourceManifestSha256,expectedTarget);
 const source=sourceState(runtimeRoot,expectedSourceManifestSha256,manifest.sourceLocks);
 const expectedLock=manifest.profile==='standalone'?manifest.sourceLocks.root:manifest.sourceLocks.gateway;
 if(manifest.lockSha256!==expectedLock)fail('release_runtime_lock_mismatch');
 const targetNow=targetBinding(manifest.profile,manifest.target.npmVersion);
 if(canonical(targetNow)!==canonical(manifest.target))fail('release_runtime_target_mismatch');
 const files=runtimeInventory(runtimeRoot);
 if(canonical(files)!==canonical(manifest.files))fail('release_runtime_hash_mismatch');
 const packages=packageEvidence(runtimeRoot,manifest.profile,files);
 if(canonical(packages)!==canonical(manifest.packages))fail('release_runtime_dependency_mismatch');
 const sourceFiles=new Map(manifest.files.filter(item=>item.type==='file').map(item=>[item.path,item]));
 for(const file of source.files??[]){
  const runtimeFile=sourceFiles.get(file.path);
  if(!runtimeFile||runtimeFile.bytes!==file.bytes||runtimeFile.sha256!==file.sha256)fail('release_runtime_source_manifest_mismatch');
 }
 return {manifest,runtimeSha256:manifest.sha256,target:manifest.target,source};
}
