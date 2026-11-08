import {createHash,randomUUID} from 'node:crypto';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {
 chmodSync,closeSync,existsSync,fstatSync,fsyncSync,futimesSync,lstatSync,mkdirSync,openSync,readdirSync,readFileSync,renameSync,rmSync,rmdirSync,unlinkSync,writeFileSync
} from 'node:fs';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {inspectRelease} from './release-preflight.mjs';
import {createRuntimeManifest,verifyRuntimeManifest,runtimeProtocol,desktopRuntimeProtocol} from './release-runtime-integrity.mjs';
import {launchVerifiedRuntime,verifiedRuntimeEnvironment,bindVerifiedRuntimeResult,queryVerifiedRuntimeExit} from './release-runtime-launcher.mjs';
import {verifyDesktopPortablePackage} from './release-desktop-electron.mjs';
import {createDesktopPortableManifest as buildDesktopPortableManifest,
 stageDesktopPortableRelease as stageDesktopPortableReleaseCandidate} from './provider/portable-package-manifest.mjs';

const protocol=1,maxManifestBytes=16*1024*1024;
const stageLockLeaseMs=2*60*1000,stageLockHeartbeatMs=15*1000;
const stageLockRetryCell=new Int32Array(new SharedArrayBuffer(4));
const packageManifestName='release-manifest.json',runtimeManifestName='release-runtime.json';
const stateRelative='.jot-state/deployment.json';
const releaseIdPattern=/^[a-f0-9]{40,64}-[a-f0-9]{12}-(?:standalone|gateway|desktop-electron)$/,shaPattern=/^[a-f0-9]{64}$/;
const tagPattern=/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const excludedSegments=new Set(['.git','.data','.cache','.test-tmp','node_modules','coverage','target']);
const privateName=/^(?:\.env(?:$|\.)|.*\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|log))$/i;
const dsnRegex=/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|VIEW|COLUMN)\b|\bensureColumn\s*\(|\bmigrate[A-Z][A-Za-z0-9_]*\s*\(|\bPRAGMA\s+(?:user_version|application_id)\b/i;
const isRecord=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>{throw new Error(code);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(isRecord(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 return JSON.stringify(value);
};
const encode=value=>canonical(value)+'\n';
const pathInside=(path,root)=>{
 const rel=relative(resolve(root),resolve(path));
 return rel===''||(rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel));
};
const pathsOverlap=(a,b)=>pathInside(a,b)||pathInside(b,a);
function safeRelative(path){
 if(typeof path!=='string'||!path||path.length>4096||path.includes('\\')||path.startsWith('/')||/^[A-Za-z]:/.test(path)||/[\x00-\x1f\x7f]/.test(path))return false;
 return !path.split('/').some(part=>!part||part==='.'||part==='..');
}
function sourcePathExcluded(path){
 const parts=path.split('/');
 if(parts.some(part=>excludedSegments.has(part)||part.startsWith('.codex')||part.startsWith('.agents')))return true;
 const base=parts[parts.length-1]??'';
 if(privateName.test(base)||parts.some(part=>part==='test'||part==='tests'||part==='__tests__'))return true;
 return /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(base);
}
function git(repo,args,options={}){
 try{return execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:512*1024*1024,...options}).trim();}
 catch{fail('release_git_operation_failed');}
}
function gitBuffer(repo,args){
 try{return execFileSync('git',['-C',repo,...args],{stdio:['ignore','pipe','pipe'],maxBuffer:512*1024*1024});}
 catch{fail('release_git_operation_failed');}
}
function tagCommit(repo,tag){
 if(!tagPattern.test(tag))fail('release_tag_invalid');
 const value=git(repo,['rev-parse','--verify','refs/tags/'+tag+'^{commit}']);
 if(!/^[a-f0-9]{40,64}$/.test(value))fail('release_tag_invalid');
 return value.toLowerCase();
}
function sourceEntries(repo,commit){
 const tree=gitBuffer(repo,['ls-tree','-rz','--full-tree','-r',commit]),result=[];
 for(const raw of tree.toString('utf8').split('\0')){
  if(!raw)continue;
  const tab=raw.indexOf('\t');
  if(tab<0)fail('release_git_tree_invalid');
  const [mode,type,blob]=raw.slice(0,tab).split(' '),path=raw.slice(tab+1);
  if(!safeRelative(path))fail('release_source_path_invalid');
  if(mode==='160000'||type==='commit')fail('release_source_submodule_unsupported');
  if(mode!=='100644'&&mode!=='100755')fail('release_source_file_type_unsupported');
  if(sourcePathExcluded(path))continue;
  if(!/^[a-f0-9]{40,64}$/.test(blob??''))fail('release_git_tree_invalid');
  const bytes=gitBuffer(repo,['cat-file','blob',blob]);
  result.push({path,mode:Number(mode),blob,bytes});
 }
 result.sort((a,b)=>a.path.localeCompare(b.path,'en'));
 if(!result.length)fail('release_source_empty');
 const lower=new Set();
 for(const item of result){const key=item.path.toLowerCase();if(lower.has(key))fail('release_source_case_collision');lower.add(key);}
 return result;
}
function readJsonBytes(bytes,code){
 try{if(!Buffer.isBuffer(bytes)||bytes.length>maxManifestBytes)fail(code);const value=JSON.parse(bytes.toString('utf8'));if(!isRecord(value))fail(code);return value;}
 catch{fail(code);}
}
function packageMetaFromContents(readContent){
 const root=readJsonBytes(readContent('package.json'),'release_root_package_invalid');
 const rootLock=readJsonBytes(readContent('package-lock.json'),'release_root_lock_invalid');
 const gateway=readJsonBytes(readContent('packages/gateway/package.json'),'release_gateway_package_invalid');
 const gatewayLock=readJsonBytes(readContent('packages/gateway/package-lock.json'),'release_gateway_lock_invalid');
 if(root.license!=='Apache-2.0'||gateway.license!=='Apache-2.0')fail('release_license_contract_invalid');
 for(const [manifest,lock]of [[root,rootLock],[gateway,gatewayLock]]){
  const locked=lock?.packages?.[''];
  if(lock.lockfileVersion!==3||!isRecord(locked)||locked.name!==manifest.name||locked.version!==manifest.version
   ||canonical(locked.dependencies??{})!==canonical(manifest.dependencies??{})
   ||canonical(locked.devDependencies??{})!==canonical(manifest.devDependencies??{})
   ||canonical(locked.optionalDependencies??{})!==canonical(manifest.optionalDependencies??{}))fail('release_lock_manifest_mismatch');
 }
 return {
  root:{name:root.name,version:root.version,license:root.license,lockSha256:hash(readContent('package-lock.json'))},
  gateway:{name:gateway.name,version:gateway.version,license:gateway.license,lockSha256:hash(readContent('packages/gateway/package-lock.json'))}
 };
}
function databaseProtocol(files){
 const candidates=[];
 for(const item of files){
  if(item.path==='src/store.mjs'){candidates.push({path:item.path,sha256:item.sha256});continue;}
  if(!item.path.startsWith('packages/gateway/src/'))continue;
  const base=item.path.slice('packages/gateway/src/'.length);
  const named=/\b(?:schema|migration)(?:[-.][a-z0-9_-]+)?\.ts$/i.test(base)||base==='db/database.ts'||base==='db/schema.sql';
  if(named||dsnRegex.test(item.content??''))candidates.push({path:item.path,sha256:item.sha256});
 }
 candidates.sort((a,b)=>a.path.localeCompare(b.path,'en'));
 return {files:candidates,sha256:hash(canonical(candidates))};
}
function desktopDatabaseProtocol(root,manifest){
 const files=[];
 for(const item of manifest.files){
  const prefix='Jot-Desktop/resources/app/';if(!item.path.startsWith(prefix))continue;
  const path=item.path.slice(prefix.length);
  if(!path.startsWith('src/')&&!path.startsWith('packages/desktop/src/'))continue;
  let content;try{content=readFileSync(join(root,'resources','app',...path.split('/')),'utf8');}catch{fail('release_database_protocol_manifest_invalid');}
  files.push({path,sha256:item.sha256,content});
 }
 return databaseProtocol(files);
}
function checkRequiredFiles(paths){
 for(const path of ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','package.json','package-lock.json','src/server.mjs',
  'packages/gateway/package.json','packages/gateway/package-lock.json','packages/gateway/src/main.ts',
  'packages/gateway/src/harness/main.ts','packages/gateway/src/db/schema.sql','packages/gateway/contracts/openapi.json']){
  if(!paths.has(path))fail('release_source_contract_incomplete');
 }
}
async function assertSourcePreflight(root,selectedProfile){
 const profiles=selectedProfile==='all'?['standalone','gateway']:[selectedProfile];
 for(const profile of profiles){
  let result;
  try{result=await inspectRelease({root,profile,stage:'source'});}catch{fail('release_source_preflight_failed');}
  if(!result.ready)fail('release_source_preflight_failed');
 }
}
function verifyCanonicalManifest(root,expectedDigest){
 if(!shaPattern.test(expectedDigest??''))fail('release_manifest_digest_mismatch');
 const path=join(root,packageManifestName);
 let info,raw,manifest;
 try{
  info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>maxManifestBytes)fail('release_manifest_invalid');
  raw=readFileSync(path,'utf8');manifest=JSON.parse(raw);
 }catch{fail('release_manifest_invalid');}
 if(!isRecord(manifest)||raw!==encode(manifest)||hash(canonical(manifest))!==expectedDigest)fail('release_manifest_digest_mismatch');
 if(Object.keys(manifest).sort().join(',')!=='databaseProtocol,files,license,packages,protocol,source'||manifest.protocol!==protocol)fail('release_manifest_invalid');
 if(!isRecord(manifest.source)||Object.keys(manifest.source).sort().join(',')!=='commit,tag'
  ||!tagPattern.test(manifest.source.tag)||!/^[a-f0-9]{40,64}$/.test(manifest.source.commit))fail('release_manifest_invalid');
 if(!isRecord(manifest.license)||manifest.license.root!=='Apache-2.0'||manifest.license.gateway!=='Apache-2.0'
  ||!isRecord(manifest.license.notices)||Object.keys(manifest.license.notices).sort().join(',')!=='LICENSE,NOTICE,THIRD_PARTY_NOTICES.md')fail('release_manifest_invalid');
 if(!isRecord(manifest.packages)||Object.keys(manifest.packages).sort().join(',')!=='gateway,root')fail('release_manifest_invalid');
 if(!Array.isArray(manifest.files)||manifest.files.length<1||!isRecord(manifest.databaseProtocol)
  ||Object.keys(manifest.databaseProtocol).sort().join(',')!=='files,sha256'||!Array.isArray(manifest.databaseProtocol.files)
  ||!shaPattern.test(manifest.databaseProtocol.sha256))fail('release_manifest_invalid');
 let previous='';
 const seen=new Set();
 for(const item of manifest.files){
  if(!isRecord(item)||Object.keys(item).sort().join(',')!=='bytes,mode,path,sha256'||!safeRelative(item.path)||sourcePathExcluded(item.path)
   ||!Number.isSafeInteger(item.bytes)||item.bytes<0||![100644,100755].includes(item.mode)||!shaPattern.test(item.sha256))fail('release_manifest_invalid');
  if(seen.has(item.path)||item.path.localeCompare(previous,'en')<0)fail('release_manifest_invalid');
  seen.add(item.path);previous=item.path;
 }
 for(const path of ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md'])if(!seen.has(path))fail('release_license_contract_invalid');
 return manifest;
}
function walkFiles(root,{installed=false}={}){
 const entries=[];
 const visit=(folder,prefix='')=>{
  let values;
  try{values=readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'));}
  catch{fail('release_package_inventory_mismatch');}
  for(const entry of values){
   const path=prefix?prefix+'/'+entry.name:entry.name;
   if(!safeRelative(path)||entry.isSymbolicLink())fail('release_package_unsafe_entry');
   if(entry.isDirectory()){
    if(installed&&path.split('/').includes('node_modules'))continue;
    if(!installed&&path.split('/').includes('node_modules'))fail('release_package_inventory_mismatch');
    visit(join(folder,entry.name),path);
   }else if(entry.isFile()){
    if(installed&&path.split('/').includes('node_modules'))continue;
    entries.push(path);
   }else fail('release_package_unsafe_entry');
  }
 };
 visit(root);
 return entries.sort((a,b)=>a.localeCompare(b,'en'));
}
function hashFile(path){
 let info;
 try{info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink())fail('release_package_unsafe_entry');}
 catch{fail('release_package_file_missing');}
 const bytes=readFileSync(path);
 return {sha256:hash(bytes),bytes:bytes.length};
}
function setTreeReadOnly(root,readOnly){
 const visit=folder=>{
  let entries;try{entries=readdirSync(folder,{withFileTypes:true});}catch{fail('release_readonly_seal_failed');}
  for(const entry of entries){
   const path=join(folder,entry.name);
   if(entry.isSymbolicLink())continue;
   if(entry.isDirectory()){visit(path);try{chmodSync(path,readOnly?0o555:0o700);}catch{fail('release_readonly_seal_failed');}}
   else if(entry.isFile()){
    let mode;try{mode=lstatSync(path).mode;}catch{fail('release_readonly_seal_failed');}
    const executable=(mode&0o111)!==0;
    try{chmodSync(path,readOnly?(executable?0o555:0o444):(executable?0o700:0o600));}catch{fail('release_readonly_seal_failed');}
   }else fail('release_readonly_seal_failed');
  }
 };
 visit(root);
 try{chmodSync(root,readOnly?0o555:0o700);}catch{fail('release_readonly_seal_failed');}
}
function removeReleaseTree(root){
 try{if(existsSync(root))setTreeReadOnly(root,false);}catch{}
 try{rmSync(root,{recursive:true,force:true});}catch{}
}
function removePublishedTreeIfSame(root,identity){
 if(!identity)return;
 try{if(sameFile(lstatSync(root),identity))removeReleaseTree(root);}catch{}
}
function verifyTreeReadOnly(root){
 const visit=folder=>{
  let entries;try{entries=readdirSync(folder,{withFileTypes:true});}catch{fail('release_tree_not_readonly');}
  for(const entry of entries){
   const path=join(folder,entry.name);
   if(entry.isSymbolicLink())continue;
   let mode;try{mode=lstatSync(path).mode;}catch{fail('release_tree_not_readonly');}
   if((mode&0o222)!==0)fail('release_tree_not_readonly');
   if(entry.isDirectory())visit(path);
   else if(!entry.isFile())fail('release_tree_not_readonly');
  }
 };
 let mode;try{mode=lstatSync(root).mode;}catch{fail('release_tree_not_readonly');}
 if((mode&0o222)!==0)fail('release_tree_not_readonly');
 visit(root);
}
function readCanonicalLegacyRuntimeManifest(root){
 const path=join(root,runtimeManifestName);
 let raw,value;
 try{const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>maxManifestBytes)fail('release_runtime_manifest_invalid');raw=readFileSync(path,'utf8');value=JSON.parse(raw);}
 catch{fail('release_runtime_manifest_invalid');}
 if(!isRecord(value)||Object.keys(value).sort().join(',')!=='files,profile,protocol,sha256'||value.protocol!==protocol
  ||!['standalone','gateway'].includes(value.profile)||raw!==encode(value)||!Array.isArray(value.files)
  ||!shaPattern.test(value.sha256)||hash(canonical(value.files))!==value.sha256)fail('release_runtime_manifest_invalid');
 let prior='';
 for(const file of value.files){
  if(!isRecord(file)||Object.keys(file).sort().join(',')!=='bytes,path,sha256'||!safeRelative(file.path)||sourcePathExcluded(file.path)
   ||!Number.isSafeInteger(file.bytes)||file.bytes<0||!shaPattern.test(file.sha256)||file.path.localeCompare(prior,'en')<0)fail('release_runtime_manifest_invalid');
  prior=file.path;
 }
 return value;
}
function readRuntimeManifestDocument(root){
 const path=join(root,runtimeManifestName);let value,raw;
 try{
  const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>maxManifestBytes)fail('release_runtime_manifest_invalid');
  raw=readFileSync(path,'utf8');value=JSON.parse(raw);if(!isRecord(value))fail('release_runtime_manifest_invalid');
 }catch{fail('release_runtime_manifest_invalid');}
 return {raw,value};
}
function verifyPackageFiles(root,manifest,{installed=false}={}){
 const expected=new Set(manifest.files.map(file=>file.path));expected.add(packageManifestName);
 if(installed)expected.add(runtimeManifestName);
 const actual=walkFiles(root,{installed});
 if(installed){
  for(const path of actual)if(!expected.has(path)&&!path.startsWith('node_modules/')&&!path.startsWith('packages/gateway/node_modules/')
   &&!path.startsWith('dist/')&&!path.startsWith('packages/gateway/dist/'))fail('release_package_inventory_mismatch');
 }else if(actual.length!==expected.size||actual.some(path=>!expected.has(path)))fail('release_package_inventory_mismatch');
 const byPath=new Map(manifest.files.map(file=>[file.path,file]));
 for(const file of manifest.files){const current=hashFile(join(root,...file.path.split('/')));if(current.sha256!==file.sha256||current.bytes!==file.bytes)fail('release_package_file_mismatch');}
 const content=path=>readFileSync(join(root,...path.split('/')));
 const packageMeta=packageMetaFromContents(content);
 if(canonical(packageMeta)!==canonical(manifest.packages))fail('release_lock_manifest_mismatch');
 const notices={};
 for(const name of ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md']){
  const actualFile=byPath.get(name);if(!actualFile||actualFile.sha256!==manifest.license.notices[name])fail('release_license_contract_invalid');
  notices[name]=actualFile.sha256;
 }
 if(canonical(databaseProtocol(manifest.files.map(file=>({...file,content:content(file.path).toString('utf8')}))))!==canonical(manifest.databaseProtocol))fail('release_database_protocol_manifest_invalid');
 return {manifest,packageMeta,manifestSha256:hash(canonical(manifest))};
}
function createManifest(tag,commit,entries){
 const byPath=new Map(entries.map(entry=>[entry.path,entry]));
 const read=path=>{const entry=byPath.get(path);if(!entry)fail('release_source_contract_incomplete');return entry.bytes;};
 const packageMeta=packageMetaFromContents(read);
 const files=entries.map(entry=>({path:entry.path,mode:entry.mode,bytes:entry.bytes.length,sha256:hash(entry.bytes)}));
 const contents=entries.map((entry,index)=>({...files[index],content:entry.bytes.toString('utf8')}));
 const protocolData=databaseProtocol(contents),notices={};
 for(const path of ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md']){const item=files.find(value=>value.path===path);if(!item)fail('release_license_contract_invalid');notices[path]=item.sha256;}
 return {protocol,source:{tag,commit},license:{root:packageMeta.root.license,gateway:packageMeta.gateway.license,notices},packages:packageMeta,databaseProtocol:protocolData,files};
}
export async function createReleasePackage({sourceRoot,tag,expectedCommit,target,signal}){
 const repo=resolve(sourceRoot),destination=resolve(target);
 if(pathsOverlap(repo,destination)||destination===dirname(destination))fail('release_package_target_invalid');
 if(existsSync(destination))fail('release_package_target_exists');
 const repoRoot=resolve(git(repo,['rev-parse','--show-toplevel']));
 const sameRoot=process.platform==='win32'?repoRoot.toLowerCase()===repo.toLowerCase():repoRoot===repo;
 if(!sameRoot)fail('release_source_root_invalid');
 if(gitBuffer(repo,['status','--porcelain=v1','-z','--untracked-files=all']).length)fail('release_source_dirty');
 const commit=tagCommit(repo,tag);
 if(commit!==String(expectedCommit??'').toLowerCase()||git(repo,['rev-parse','HEAD'])!==commit)fail('release_source_commit_mismatch');
 if(!/^[a-f0-9]{40,64}$/.test(commit))fail('release_source_commit_mismatch');
 const listed=sourceEntries(repo,commit),entries=[],paths=new Set();
 for(const item of listed){
  signal?.throwIfAborted?.();
  const source=join(repo,...item.path.split('/'));
  let info;try{info=lstatSync(source);}catch{fail('release_source_file_missing');}
  if(!info.isFile()||info.isSymbolicLink())fail('release_source_file_type_unsupported');
  const workingBytes=readFileSync(source);
  let actualBlob;
  try{actualBlob=execFileSync('git',['-C',repo,'hash-object','--path='+item.path,'--stdin'],{encoding:'utf8',input:workingBytes,maxBuffer:512*1024*1024}).trim();}
  catch{fail('release_git_operation_failed');}
  if(actualBlob!==item.blob)fail('release_source_file_changed');
  paths.add(item.path);entries.push(item);
 }
 checkRequiredFiles(paths);
 const manifest=createManifest(tag,commit,entries),manifestSha256=hash(canonical(manifest));
 mkdirSync(dirname(destination),{recursive:true});
 const temporary=join(dirname(destination),'.release-package-staging-'+randomUUID());
 try{
  mkdirSync(temporary,{recursive:false,mode:0o700});
  for(const entry of entries){
   signal?.throwIfAborted?.();
   const output=join(temporary,...entry.path.split('/'));mkdirSync(dirname(output),{recursive:true,mode:0o700});
   writeFileSync(output,entry.bytes,{flag:'wx',mode:entry.mode===100755?0o755:0o644});
   try{chmodSync(output,entry.mode===100755?0o755:0o644);}catch{}
   const copied=hashFile(output);if(copied.sha256!==hash(entry.bytes)||copied.bytes!==entry.bytes.length)fail('release_package_copy_mismatch');
  }
  writeFileSync(join(temporary,packageManifestName),encode(manifest),{flag:'wx',mode:0o600});
  const result=verifyPackageFiles(temporary,manifest);
  if(result.manifestSha256!==manifestSha256)fail('release_manifest_digest_mismatch');
  renameSync(temporary,destination);
 }catch(error){
  try{rmSync(temporary,{recursive:true,force:true});}catch{}
  if(error?.name==='AbortError')throw error;
  fail(error?.message?.startsWith('release_')?error.message:'release_package_create_failed');
 }
 return {packageRoot:destination,manifestSha256,sourceTag:tag,sourceCommit:commit,releaseId:commit+'-'+manifestSha256.slice(0,12),fileCount:manifest.files.length};
}
export function verifyReleasePackage({packageRoot,expectedManifestSha256,profile='standalone',expectedRuntimeReceiptSha256,
 expectedRuntimeTarget,expectedAppLockSha256,expectedRootLockSha256}){
 if(profile==='desktop-electron')return verifyDesktopPortablePackage({packageRoot,expectedManifestSha256,expectedRuntimeReceiptSha256,
  expectedRuntimeTarget,expectedAppLockSha256,expectedRootLockSha256});
 if(profile!=='standalone'&&profile!=='gateway')fail('release_profile_invalid');
 const root=resolve(packageRoot),manifest=verifyCanonicalManifest(root,expectedManifestSha256);
 const result=verifyPackageFiles(root,manifest);
 return {manifestSha256:result.manifestSha256,sourceTag:manifest.source.tag,sourceCommit:manifest.source.commit,
  license:result.packageMeta.root.license,fileCount:manifest.files.length,manifest};
}
function runtimeInventory(root){
 const paths=walkFiles(root,{installed:true}).filter(path=>path!==packageManifestName&&path!==runtimeManifestName
  &&!path.startsWith('node_modules/')&&!path.startsWith('packages/gateway/node_modules/'));
 return paths.map(path=>({path,...hashFile(join(root,...path.split('/')))}));
}
function verifyBuiltArtifacts(root,profile){
 const paths=profile==='standalone'?['dist/index.html']:[
  'packages/gateway/dist/src/main.js','packages/gateway/dist/src/harness/main.js','packages/gateway/dist/src/file-engine/main.js',
  'packages/gateway/dist/src/db/schema.sql','packages/gateway/dist/contracts/openapi.json'
 ];
 for(const path of paths){
  let info;try{info=lstatSync(join(root,...path.split('/')));}catch{fail('release_build_artifact_missing');}
  if(!info.isFile()||info.isSymbolicLink()||info.size===0)fail('release_build_artifact_missing');
 }
}
function verifyDirectDependencies(root,profile){
 for(const prefix of [profile==='standalone'?'':join('packages','gateway')]){
  let pkg;
  try{pkg=JSON.parse(readFileSync(join(root,prefix,'package.json'),'utf8'));}
  catch{fail('release_runtime_dependency_mismatch');}
  for(const [name,version]of Object.entries(pkg.dependencies??{})){
   if(!/^(?:@[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.-]*$/.test(name)||typeof version!=='string')fail('release_runtime_dependency_mismatch');
   const path=join(root,prefix,'node_modules',...name.split('/'),'package.json');
   let installed;
   try{const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink())fail('release_runtime_dependency_mismatch');installed=JSON.parse(readFileSync(path,'utf8'));}
   catch{fail('release_runtime_dependency_mismatch');}
   if(installed.version!==version)fail('release_runtime_dependency_mismatch');
  }
 }
}
function removeBuildTemporaryDirectory(packageCwd){
 const path=join(packageCwd,'node_modules','.vite-temp');let info;
 try{info=lstatSync(path);}catch(error){if(error?.code==='ENOENT')return;throw error;}
 if(!info.isDirectory()||info.isSymbolicLink())fail('release_runtime_dependency_mismatch');
 rmSync(path,{recursive:true,force:false});
}
function removeEmptyNpmScopes(packageCwd){
 const dependencyRoot=join(packageCwd,'node_modules');let rootInfo;
 try{rootInfo=lstatSync(dependencyRoot);}catch(error){if(error?.code==='ENOENT')return;throw error;}
 if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())fail('release_runtime_dependency_mismatch');
 const visit=directory=>{
  const children=readdirSync(directory,{withFileTypes:true});
  for(const child of children)if(child.isDirectory()&&!child.isSymbolicLink())visit(join(directory,child.name));
  if(basename(directory)!=='node_modules')return;
  for(const child of children){
   if(!child.name.startsWith('@')||!child.isDirectory()||child.isSymbolicLink())continue;
   const scopePath=join(directory,child.name);
   if(readdirSync(scopePath).length===0)rmdirSync(scopePath);
  }
 };
 visit(dependencyRoot);
}
function removeInstalledSubtree(packageCwd,relativePath){
 let path=join(packageCwd,'node_modules');
 for(const segment of relativePath.split('/')){
  path=join(path,segment);let info;
  try{info=lstatSync(path);}catch(error){if(error?.code==='ENOENT')return;throw error;}
  if(!info.isDirectory()||info.isSymbolicLink())fail('release_runtime_dependency_mismatch');
 }
 rmSync(path,{recursive:true,force:false});
}
function removeTestOnlyNpmSubtrees(packageCwd){
 for(const path of ['pino/test/fixtures/transport','secure-json-parse/benchmarks'])removeInstalledSubtree(packageCwd,path);
}
function releaseIdFor(commit,manifestSha,profile){return commit+'-'+manifestSha.slice(0,12)+'-'+profile;}
function readReleaseRoot(installRoot,releaseId){
 if(!releaseIdPattern.test(releaseId??''))fail('release_id_invalid');
 return join(resolve(installRoot),'releases',releaseId);
}
function desktopSourceReceipt(manifest){
 return {sourceCommit:manifest.sourceCommit,sourceTreeSha256:manifest.sourceTreeSha256,appLockSha256:manifest.appLockSha256,
  rootLockSha256:manifest.rootLockSha256,runtimeReceiptSha256:manifest.runtimeReceiptSha256,build:manifest.build,dependencyClosureProven:false};
}
function validDesktopSourceReceipt(value){
 return isRecord(value)&&Object.keys(value).sort().join(',')==='appLockSha256,build,dependencyClosureProven,rootLockSha256,runtimeReceiptSha256,sourceCommit,sourceTreeSha256'
  &&/^[a-f0-9]{40}$/.test(value.sourceCommit??'')&&shaPattern.test(value.sourceTreeSha256??'')
  &&shaPattern.test(value.appLockSha256??'')&&shaPattern.test(value.rootLockSha256??'')&&shaPattern.test(value.runtimeReceiptSha256??'')
  &&isRecord(value.build)&&Object.keys(value.build).sort().join(',')==='nodeVersion,npmVersion,rootLockSha256,viteVersion'
  &&[value.build.nodeVersion,value.build.npmVersion,value.build.viteVersion].every(item=>typeof item==='string'&&item.length>0)
  &&value.build.rootLockSha256===value.rootLockSha256&&value.dependencyClosureProven===false;
}
function assertDesktopStageSourceReceipt(proof,manifest){
 if(proof.target.profile==='desktop-electron'&&(!validDesktopSourceReceipt(proof.sourceReceipt)
  ||canonical(proof.sourceReceipt)!==canonical(desktopSourceReceipt(manifest))))fail('release_stage_proof_invalid');
}
export function verifyInstalledRelease({installRoot,releaseId,expectedManifestSha256,expectedRuntimeSha256,expectedTarget,releaseRoot,requireReadOnly=true}){
 const root=releaseRoot?resolve(releaseRoot):readReleaseRoot(installRoot,releaseId);
 if(requireReadOnly)verifyTreeReadOnly(root);
 const runtimeDocument=readRuntimeManifestDocument(root),runtime=runtimeDocument.value;
 let manifest,profile,runtimeSha256,target,completeRuntimeProof,databaseProtocolSha256,sourceTag,sourceCommit;
 if(runtime.protocol===desktopRuntimeProtocol){
  if(runtime.profile!=='desktop-electron')fail('release_runtime_manifest_invalid');
  const checked=verifyRuntimeManifest({root,expectedRuntimeSha256,expectedSourceManifestSha256:expectedManifestSha256,
   expectedTarget:expectedTarget??runtime.target});
  let portableManifest;
  try{portableManifest=JSON.parse(readFileSync(join(root,'portable-package-manifest.json'),'utf8'));}catch{fail('release_portable_manifest_invalid');}
  const expectedRuntimeTarget={electronVersion:runtime.target.electronVersion,nodeVersion:runtime.target.nodeVersion,
   platform:runtime.target.platform,arch:runtime.target.arch,nodeModuleAbi:runtime.target.abi.node,napiVersion:runtime.target.abi.napi};
  const packageInfo=verifyDesktopPortablePackage({packageRoot:root,expectedManifestSha256,
   expectedRuntimeReceiptSha256:portableManifest.runtimeReceiptSha256,expectedRuntimeTarget,
   expectedAppLockSha256:runtime.sourceLocks.desktop,expectedRootLockSha256:portableManifest.rootLockSha256,allowRuntimeManifest:true});
  if(canonical(packageInfo.target)!==canonical(runtime.target))fail('release_runtime_target_mismatch');
  manifest=packageInfo.manifest;profile='desktop-electron';runtimeSha256=checked.runtimeSha256;target=checked.target;completeRuntimeProof=true;
  const protocolInfo=desktopDatabaseProtocol(root,manifest);databaseProtocolSha256=protocolInfo.sha256;
  sourceTag=null;sourceCommit=manifest.sourceCommit;
 }else if(runtime.protocol===runtimeProtocol){
  manifest=verifyCanonicalManifest(root,expectedManifestSha256);
  verifyPackageFiles(root,manifest,{installed:true});
  const checked=verifyRuntimeManifest({root,expectedRuntimeSha256,expectedSourceManifestSha256:expectedManifestSha256,
   expectedTarget:expectedTarget??runtime.target});
  profile=checked.manifest.profile;runtimeSha256=checked.runtimeSha256;target=checked.target;completeRuntimeProof=true;
  databaseProtocolSha256=manifest.databaseProtocol.sha256;sourceTag=manifest.source.tag;sourceCommit=manifest.source.commit;
 }else if(runtime.protocol===protocol){
  manifest=verifyCanonicalManifest(root,expectedManifestSha256);
  verifyPackageFiles(root,manifest,{installed:true});
  const legacy=readCanonicalLegacyRuntimeManifest(root),files=runtimeInventory(root);
  if(canonical(files)!==canonical(legacy.files)||hash(canonical(files))!==legacy.sha256)fail('release_runtime_hash_mismatch');
  profile=legacy.profile;completeRuntimeProof=false;databaseProtocolSha256=manifest.databaseProtocol.sha256;
  sourceTag=manifest.source.tag;sourceCommit=manifest.source.commit;
 }else fail('release_runtime_manifest_invalid');
 const actualId=releaseIdFor(sourceCommit,expectedManifestSha256,profile);
 if(releaseId&&actualId!==releaseId)fail('release_id_manifest_mismatch');
 if(!completeRuntimeProof)verifyDirectDependencies(root,profile);
 if(profile!=='desktop-electron')verifyBuiltArtifacts(root,profile);
 const verified={releaseId:actualId,manifestSha256:expectedManifestSha256,sourceTag,sourceCommit,
  profile,databaseProtocolSha256,sourceAndBuildFilesVerified:true,
  runtimeDependenciesVerified:completeRuntimeProof,completeRuntimeProof,manifest};
 if(profile==='desktop-electron'){
  verified.sourceReceipt=desktopSourceReceipt(manifest);
  verified.dependencyClosureProven=false;
 }
 if(completeRuntimeProof)return {...verified,runtimeSha256,target};
 return verified;
}
export function readDeploymentState(installRoot){
 const path=join(resolve(installRoot),stateRelative);
 if(!existsSync(path))return null;
 let value;
 try{const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>65536)fail('release_deployment_state_invalid');value=JSON.parse(readFileSync(path,'utf8'));}
 catch{fail('release_deployment_state_invalid');}
 if(!isRecord(value)||Object.keys(value).sort().join(',')!=='active,previous,protocol'||value.protocol!==protocol
  ||!validRef(value.active)||(value.previous!==null&&!validRef(value.previous)))fail('release_deployment_state_invalid');
 return value;
}
function validTargetBinding(target,profile){
 if(profile==='desktop-electron')return isRecord(target)&&Object.keys(target).sort().join(',')==='abi,arch,electronArchiveSha256,electronExecutableSha256,electronVersion,nodeVersion,platform,profile,runtimeKind'
  &&target.profile===profile&&target.runtimeKind==='electron'&&typeof target.platform==='string'&&typeof target.arch==='string'
  &&typeof target.electronVersion==='string'&&/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(target.electronVersion)
  &&typeof target.nodeVersion==='string'&&/^\d+\.\d+\.\d+$/.test(target.nodeVersion)
  &&isRecord(target.abi)&&Object.keys(target.abi).sort().join(',')==='napi,node'
  &&/^\d+$/.test(target.abi.node??'')&&/^\d+$/.test(target.abi.napi??'')
  &&shaPattern.test(target.electronArchiveSha256??'')&&shaPattern.test(target.electronExecutableSha256??'');
 return isRecord(target)&&Object.keys(target).sort().join(',')==='abi,arch,libc,nodeVersion,npmVersion,platform,profile'
  &&target.profile===profile&&typeof target.platform==='string'&&typeof target.arch==='string'&&typeof target.libc==='string'
  &&typeof target.nodeVersion==='string'&&/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(target.nodeVersion)
  &&typeof target.npmVersion==='string'&&/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(target.npmVersion)
  &&isRecord(target.abi)&&Object.keys(target.abi).sort().join(',')==='napi,node'
  &&[target.abi.node,target.abi.napi].every(value=>value===null||typeof value==='string');
}
function validRef(value){
 if(!isRecord(value)||!releaseIdPattern.test(value.releaseId)||!['standalone','gateway','desktop-electron'].includes(value.profile)||!shaPattern.test(value.manifestSha256))return false;
 const keys=Object.keys(value).sort().join(',');
 if(keys==='manifestSha256,profile,releaseId')return true;
 return keys==='manifestSha256,profile,releaseId,runtimeSha256,target'&&shaPattern.test(value.runtimeSha256??'')&&validTargetBinding(value.target,value.profile);
}
function stageProofPath(installRoot,releaseId){return join(resolve(installRoot),'.jot-state','staged-releases',releaseId+'.json');}
function stageLockPath(installRoot){return join(resolve(installRoot),'.jot-state','staging.lock');}
function inspectStageLock(path){
 let info,raw,value;
 try{info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>4096)fail('release_stage_in_progress');}
 catch(error){if(error?.code==='ENOENT')fail('release_stage_lock_temporarily_missing');fail('release_stage_in_progress');}
 try{raw=readFileSync(path,'utf8');}catch(error){if(error?.code==='ENOENT')fail('release_stage_lock_temporarily_missing');fail('release_stage_in_progress');}
 try{value=JSON.parse(raw);}catch{value=undefined;}
 if(!isRecord(value)||raw!==encode(value)||Object.keys(value).sort().join(',')!=='pid,protocol,startedAt,token'
  ||value.protocol!==protocol||!Number.isSafeInteger(value.pid)||value.pid<1||typeof value.startedAt!=='string'
  ||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.startedAt)
  ||typeof value.token!=='string'||!/^[a-f0-9-]{36}$/.test(value.token))value=undefined;
 return {raw,value,info};
}
function sameFile(left,right){return left.dev===right.dev&&left.ino===right.ino;}
function readStageLock(path){
 const current=inspectStageLock(path);if(!current.value)fail('release_stage_lock_invalid');
 return current;
}
function refreshStageLock(path,token){
 for(let attempt=0;attempt<6;attempt++){
  let leaseFd,retry=false;
  try{
   const current=readStageLock(path);if(current.value.token!==token)fail('release_stage_in_progress');
   leaseFd=openSync(path,'r+');
   const opened=fstatSync(leaseFd),confirmedOpen=readStageLock(path);
   if(confirmedOpen.value.token!==token)fail('release_stage_in_progress');
   if(!sameFile(confirmedOpen.info,opened))retry=true;
   else{
    const now=new Date();futimesSync(leaseFd,now,now);
    const confirmed=readStageLock(path);
    if(confirmed.value.token!==token)fail('release_stage_in_progress');
    if(!sameFile(confirmed.info,opened))retry=true;
    else return;
   }
  }catch(error){
   if(error?.code==='ENOENT'||['release_stage_lock_temporarily_missing','release_stage_lock_invalid'].includes(error?.message))retry=true;
   else throw error;
  }finally{if(leaseFd!==undefined)try{closeSync(leaseFd);}catch{}}
  if(retry&&attempt<5)Atomics.wait(stageLockRetryCell,0,0,10);
 }
 fail('release_stage_in_progress');
}
function restoreMovedStageLock(path,stale,contents,mtimeMs){
 let fd;
 try{
  fd=openSync(path,'wx',0o600);writeFileSync(fd,contents);fsyncSync(fd);
  const time=new Date(Math.max(mtimeMs,Date.now()));futimesSync(fd,time,time);closeSync(fd);fd=undefined;
  if(process.platform!=='win32'){try{const dirFd=openSync(dirname(path),'r');fsyncSync(dirFd);closeSync(dirFd);}catch{}}
  unlinkSync(stale);
  return true;
 }catch(error){if(fd!==undefined)try{closeSync(fd);}catch{};if(error?.code==='EEXIST')return false;fail('release_stage_in_progress');}
}
function stageLockOwnerAlive(pid){
 try{process.kill(pid,0);return true;}
 catch(error){if(error?.code==='ESRCH')return false;if(error?.code==='EPERM')return true;fail('release_stage_in_progress');}
}
function acquireStageLock(installRoot){
 const folder=join(resolve(installRoot),'.jot-state'),path=stageLockPath(installRoot);mkdirSync(folder,{recursive:true,mode:0o700});
 for(let attempt=0;attempt<4;attempt++){
  const token=randomUUID(),contents=encode({protocol,pid:process.pid,startedAt:new Date().toISOString(),token});let fd,created=false;
  try{
   fd=openSync(path,'wx',0o600);created=true;writeFileSync(fd,contents);fsyncSync(fd);refreshStageLock(path,token);
   let lost=false,released=false;
   const heartbeat=setInterval(()=>{
    if(released||lost)return;
    try{refreshStageLock(path,token);}catch{lost=true;}
   },stageLockHeartbeatMs);
   heartbeat.unref?.();
   return {
    assert(){if(lost)fail('release_stage_lock_lost');try{refreshStageLock(path,token);}catch{lost=true;fail('release_stage_lock_lost');}},
    release(){
     if(released)return;released=true;clearInterval(heartbeat);
     try{
      const current=readStageLock(path);
      if(current.value.token===token){
       let leaseFd;
       try{
        leaseFd=openSync(path,'r+');const opened=fstatSync(leaseFd),confirmed=readStageLock(path);
        if(confirmed.value.token===token&&sameFile(confirmed.info,opened)){const expired=new Date(0);futimesSync(leaseFd,expired,expired);}
       }finally{if(leaseFd!==undefined)try{closeSync(leaseFd);}catch{}}
      }
     }catch(error){
      if(!['release_stage_lock_in_progress','release_stage_lock_invalid','release_stage_lock_temporarily_missing'].includes(error?.message)
       &&error?.code!=='ENOENT')fail('release_stage_lock_failed');
     }
     finally{try{closeSync(fd);}catch{}}
    }
   };
  }catch(error){
   if(fd!==undefined&&created){try{const expired=new Date(0);futimesSync(fd,expired,expired);}catch{}}
   if(fd!==undefined)try{closeSync(fd);}catch{}
   if(error?.code!=='EEXIST'&&error?.message!=='release_stage_lock_in_progress')fail('release_stage_lock_failed');
   const current=inspectStageLock(path),expired=Date.now()-current.info.mtimeMs>=stageLockLeaseMs;
   const ownerDead=!!current.value&&!stageLockOwnerAlive(current.value.pid);
   if(!expired&&!ownerDead)fail('release_stage_in_progress');
   const stale=path+'.stale-'+randomUUID();
   try{renameSync(path,stale);}catch(renameError){if(renameError?.code==='ENOENT')continue;fail('release_stage_in_progress');}
   let moved,movedInfo;
   try{moved=readFileSync(stale,'utf8');movedInfo=lstatSync(stale);}catch{fail('release_stage_in_progress');}
   const sameClaimedFile=sameFile(current.info,movedInfo),stillExpired=Date.now()-movedInfo.mtimeMs>=stageLockLeaseMs;
   if(moved!==current.raw||!sameClaimedFile||!stillExpired){
    if(!restoreMovedStageLock(path,stale,moved,movedInfo.mtimeMs)&&existsSync(path))continue;
    if(!existsSync(path))fail('release_stage_in_progress');
    continue;
   }
   try{unlinkSync(stale);}catch{fail('release_stage_in_progress');}
  }
 }
 fail('release_stage_in_progress');
}
function readStagedProof(installRoot,releaseId,expectedManifestSha256){
 const path=stageProofPath(installRoot,releaseId);let raw,value;
 let info;try{info=lstatSync(path);}catch{fail('release_stage_proof_missing');}
 if(!info.isFile()||info.isSymbolicLink()||info.size>65536)fail('release_stage_proof_invalid');
 try{raw=readFileSync(path,'utf8');value=JSON.parse(raw);}catch{fail('release_stage_proof_invalid');}
 const desktop=value?.target?.profile==='desktop-electron';
 const expectedKeys=desktop?'manifestSha256,protocol,releaseId,runtimeSha256,sourceReceipt,target':'manifestSha256,protocol,releaseId,runtimeSha256,target';
 if(!isRecord(value)||raw!==encode(value)||Object.keys(value).sort().join(',')!==expectedKeys
  ||value.protocol!==protocol||value.releaseId!==releaseId||value.manifestSha256!==expectedManifestSha256
  ||!shaPattern.test(value.runtimeSha256??'')||!validTargetBinding(value.target,value.target?.profile)
  ||!releaseId.endsWith('-'+value.target.profile)
  ||(desktop&&(!validDesktopSourceReceipt(value.sourceReceipt)
   ||releaseId!==releaseIdFor(value.sourceReceipt.sourceCommit,value.manifestSha256,'desktop-electron'))))fail('release_stage_proof_invalid');
 return value;
}
function writeStagedProof(installRoot,releaseId,manifestSha256,runtimeSha256,target,sourceReceipt){
 const desktop=target?.profile==='desktop-electron';
 if(!shaPattern.test(runtimeSha256??'')||!validTargetBinding(target,target?.profile)||!releaseId.endsWith('-'+target.profile)
  ||(desktop&&!validDesktopSourceReceipt(sourceReceipt))||(!desktop&&sourceReceipt!==undefined))fail('release_stage_proof_invalid');
 const value={protocol,releaseId,manifestSha256,runtimeSha256,target};
 if(desktop)value.sourceReceipt=sourceReceipt;
 const path=stageProofPath(installRoot,releaseId);
 let proofInfo;try{proofInfo=lstatSync(path);}catch(error){if(error?.code!=='ENOENT')fail('release_stage_proof_invalid');}
 if(proofInfo){
  const destination=join(resolve(installRoot),'releases',releaseId),state=readDeploymentState(installRoot);
  if(existsSync(destination)||[state?.active,state?.previous].some(ref=>ref?.releaseId===releaseId))fail('release_stage_identity_conflict');
  if(!proofInfo.isFile()||proofInfo.isSymbolicLink())fail('release_stage_proof_invalid');
  let existing;
  try{existing=readStagedProof(installRoot,releaseId,manifestSha256);}
  catch(error){
   let parsed;try{parsed=JSON.parse(readFileSync(path,'utf8'));}catch{}
   if(parsed?.releaseId===releaseId&&parsed?.protocol===protocol&&shaPattern.test(parsed?.manifestSha256??'')&&parsed.manifestSha256!==manifestSha256)
    fail('release_stage_identity_conflict');
   if(error?.message!=='release_stage_proof_invalid')throw error;
  }
  if(existing&&existing.runtimeSha256===runtimeSha256&&canonical(existing.target)===canonical(target)
   &&canonical(existing.sourceReceipt??null)===canonical(sourceReceipt??null))return;
  try{unlinkSync(path);}catch{fail('release_stage_identity_conflict');}
 }
 writeAtomicExclusive(path,encode(value));
}
function writeAtomicExclusive(path,contents){
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 let fd,created=false;
 try{
  fd=openSync(path,'wx',0o600);created=true;writeFileSync(fd,contents);fsyncSync(fd);closeSync(fd);fd=undefined;
  if(process.platform!=='win32'){try{const dirFd=openSync(dirname(path),'r');fsyncSync(dirFd);closeSync(dirFd);}catch{}}
 }catch(error){
  if(fd!==undefined)try{closeSync(fd);}catch{}
  if(created)try{unlinkSync(path);}catch{}
  if(error?.code==='EEXIST')fail('release_stage_identity_conflict');
  throw error;
 }
}
function writeAtomic(path,contents){
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const temporary=path+'.tmp-'+randomUUID();let fd;
 try{
  fd=openSync(temporary,'wx',0o600);writeFileSync(fd,contents);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temporary,path);
  if(process.platform!=='win32'){try{const dirFd=openSync(dirname(path),'r');fsyncSync(dirFd);closeSync(dirFd);}catch{}}
 }catch(error){if(fd!==undefined)try{closeSync(fd);}catch{};try{rmSync(temporary,{force:true});}catch{};throw error;}
}
function npmCommand(){return process.platform==='win32'?'npm.cmd':'npm';}
function runChild({command,args,cwd,signal,env,capture=false}){
 return new Promise((resolvePromise,rejectPromise)=>{
  if(signal?.aborted)return rejectPromise(new Error('release_stage_cancelled'));
  let child;try{child=spawn(command,args,{cwd,env:env?{...process.env,...env}:process.env,stdio:capture?['ignore','pipe','ignore']:'ignore',windowsHide:true,shell:process.platform==='win32'});}catch{return rejectPromise(new Error('release_stage_command_failed'));}
  const output=[];if(capture)child.stdout?.on('data',chunk=>output.push(Buffer.from(chunk)));
  let settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);if(error)rejectPromise(error);else resolvePromise(value);};
  const abort=()=>{try{child.kill('SIGTERM');}catch{}};
  signal?.addEventListener('abort',abort,{once:true});
  child.once('error',()=>finish(new Error('release_stage_command_failed')));
  child.once('close',(code)=>{if(signal?.aborted)finish(new Error('release_stage_cancelled'));else if(code===0)finish(null,{code,...(capture?{stdout:Buffer.concat(output).toString('utf8')}: {})});else finish(new Error('release_stage_command_failed'));});
 });
}
async function executeCommand(runner,command,args,cwd,signal,env,capture=false,assertLock=()=>{}){
 assertLock();
 signal?.throwIfAborted?.();
 let result;try{result=await runner({command,args,cwd,signal,env,capture});}catch{fail('release_stage_failed');}
 signal?.throwIfAborted?.();
 assertLock();
 return result;
}
async function stageDesktopElectronRelease({packageRoot,expectedManifestSha256,installRoot,userDataRoot,expectedRuntimeReceiptSha256,
 expectedRuntimeTarget,expectedAppLockSha256,expectedRootLockSha256,signal}){
 signal?.throwIfAborted?.();
 if(typeof userDataRoot!=='string'||!isAbsolute(userDataRoot))fail('release_user_data_root_invalid');
 const packageInfo=verifyReleasePackage({packageRoot,expectedManifestSha256,profile:'desktop-electron',expectedRuntimeReceiptSha256,
  expectedRuntimeTarget,expectedAppLockSha256,expectedRootLockSha256}),sourceReceipt=desktopSourceReceipt(packageInfo.manifest),root=resolve(installRoot),dataRoot=resolve(userDataRoot);
 if(pathsOverlap(resolve(packageRoot),root)||pathsOverlap(root,dataRoot)||pathsOverlap(resolve(packageRoot),dataRoot))fail('release_install_root_overlap');
 const releases=join(root,'releases'),releaseId=releaseIdFor(packageInfo.sourceCommit,packageInfo.manifestSha256,'desktop-electron'),destination=join(releases,releaseId);
 mkdirSync(root,{recursive:true,mode:0o700});
 const releaseStageLock=acquireStageLock(root);
 const assertStage=()=>{signal?.throwIfAborted?.();releaseStageLock.assert();};
 const yieldStage=async()=>{assertStage();await new Promise(resolve=>setImmediate(resolve));assertStage();};
 let staging,published=false,publishedInfo;
 try{
  await yieldStage();
  if(existsSync(destination)){
   const proof=readStagedProof(root,releaseId,packageInfo.manifestSha256);
   const existing=verifyInstalledRelease({installRoot:root,releaseId,expectedManifestSha256,expectedRuntimeSha256:proof.runtimeSha256,expectedTarget:proof.target});
   assertDesktopStageSourceReceipt(proof,existing.manifest);
   if(!existing.completeRuntimeProof)fail('release_runtime_proof_required');
   await yieldStage();return {...existing,staged:true,alreadyPresent:true};
  }
  mkdirSync(releases,{recursive:true,mode:0o700});staging=join(releases,'.staging-'+randomUUID());
  mkdirSync(staging,{recursive:false,mode:0o700});
  const portableRoot=resolve(packageRoot),transportPrefix='Jot-Desktop/';
  for(const file of packageInfo.manifest.files){
   await yieldStage();
   const relativePath=file.path.slice(transportPrefix.length),source=join(portableRoot,...relativePath.split('/'));
   const output=join(staging,...relativePath.split('/'));
   mkdirSync(dirname(output),{recursive:true,mode:0o700});
   const actual=hashFile(source);if(actual.sha256!==file.sha256||actual.bytes!==file.size)fail('release_package_file_mismatch');
   const mode=relativePath==='Jot.exe'?0o755:0o644;
   writeFileSync(output,readFileSync(source),{flag:'wx',mode});try{chmodSync(output,mode);}catch{}
   const copied=hashFile(output);if(copied.sha256!==file.sha256||copied.bytes!==file.size)fail('release_stage_copy_mismatch');
  }
  for(const name of ['portable-package-manifest.json','portable-package-manifest.sha256']){
   await yieldStage();
   const source=join(portableRoot,name),output=join(staging,name),contents=readFileSync(source);
   writeFileSync(output,contents,{flag:'wx',mode:0o600});if(hashFile(output).sha256!==hash(contents))fail('release_stage_copy_mismatch');
  }
  await yieldStage();
  const sourceLocks={desktop:packageInfo.appLockSha256};
  const runtime=createRuntimeManifest({root:staging,profile:'desktop-electron',sourceManifestSha256:packageInfo.manifestSha256,
   sourceLocks,target:packageInfo.target});
  writeFileSync(join(staging,runtimeManifestName),encode(runtime.manifest),{flag:'wx',mode:0o600});
  await yieldStage();
  verifyInstalledRelease({installRoot:root,releaseId,expectedManifestSha256,expectedRuntimeSha256:runtime.runtimeSha256,
   expectedTarget:runtime.target,releaseRoot:staging,requireReadOnly:false});
  await yieldStage();
  setTreeReadOnly(staging,true);
  await yieldStage();
  verifyInstalledRelease({installRoot:root,releaseId,expectedManifestSha256,expectedRuntimeSha256:runtime.runtimeSha256,
   expectedTarget:runtime.target,releaseRoot:staging});
  await yieldStage();
  writeStagedProof(root,releaseId,packageInfo.manifestSha256,runtime.runtimeSha256,runtime.target,sourceReceipt);
  await yieldStage();
  const proof=readStagedProof(root,releaseId,packageInfo.manifestSha256);
  assertDesktopStageSourceReceipt(proof,packageInfo.manifest);
  if(proof.runtimeSha256!==runtime.runtimeSha256||canonical(proof.target)!==canonical(runtime.target))fail('release_stage_identity_conflict');
  await yieldStage();
  // Keep publication and its final checks synchronous under the stage lock.
  renameSync(staging,destination);published=true;publishedInfo=lstatSync(destination);
  assertStage();
  const installed=verifyInstalledRelease({installRoot:root,releaseId,expectedManifestSha256,expectedRuntimeSha256:runtime.runtimeSha256,expectedTarget:runtime.target});
  assertDesktopStageSourceReceipt(proof,installed.manifest);
  assertStage();
  return {releaseId,manifestSha256:packageInfo.manifestSha256,sourceTag:null,sourceCommit:packageInfo.sourceCommit,
   profile:'desktop-electron',staged:true,alreadyPresent:false,runtimeSha256:runtime.runtimeSha256,target:runtime.target,
   sourceAndBuildFilesVerified:true,runtimeDependenciesVerified:true,completeRuntimeProof:true,sourceReceipt,dependencyClosureProven:false};
 }catch(error){
  if(published)removePublishedTreeIfSame(destination,publishedInfo);
  if(staging)removeReleaseTree(staging);
  try{if(existsSync(releases)&&readdirSync(releases).length===0)rmSync(releases,{recursive:true,force:true});}catch{}
  if(error?.name==='AbortError')throw error;
  fail(error?.message?.startsWith('release_')?error.message:'release_stage_failed');
 }finally{releaseStageLock.release();}
}
export async function stageRelease({packageRoot,expectedManifestSha256,installRoot,profile='standalone',runCommand=runChild,signal,
 expectedRuntimeReceiptSha256,expectedRuntimeTarget,expectedAppLockSha256,expectedRootLockSha256,userDataRoot}){
 if(profile==='desktop-electron')return stageDesktopElectronRelease({packageRoot,expectedManifestSha256,installRoot,userDataRoot,
  expectedRuntimeReceiptSha256,expectedRuntimeTarget,expectedAppLockSha256,expectedRootLockSha256,signal});
 if(!['standalone','gateway'].includes(profile))fail('release_profile_invalid');
 const packageInfo=verifyReleasePackage({packageRoot,expectedManifestSha256}),root=resolve(installRoot);
 if(pathsOverlap(resolve(packageRoot),root))fail('release_install_root_overlap');
 const releases=join(root,'releases'),releaseId=releaseIdFor(packageInfo.sourceCommit,packageInfo.manifestSha256,profile),destination=join(releases,releaseId);
 mkdirSync(root,{recursive:true,mode:0o700});
 const releaseStageLock=acquireStageLock(root);
 let cache;
 try{
 releaseStageLock.assert();
 if(existsSync(destination)){
  const proof=readStagedProof(root,releaseId,packageInfo.manifestSha256);
  const existing=verifyInstalledRelease({installRoot:root,releaseId,expectedManifestSha256,expectedRuntimeSha256:proof.runtimeSha256,expectedTarget:proof.target});
  if(!existing.completeRuntimeProof)fail('release_runtime_proof_required');
  releaseStageLock.assert();
  return {...existing,staged:true,alreadyPresent:true};
 }
 mkdirSync(releases,{recursive:true,mode:0o700});
 const staging=join(releases,'.staging-'+randomUUID());
 let published=false,publishedInfo;
 try{
  mkdirSync(staging,{recursive:false,mode:0o700});
  for(const file of packageInfo.manifest.files){
   signal?.throwIfAborted?.();
   const source=join(resolve(packageRoot),...file.path.split('/')),output=join(staging,...file.path.split('/'));
   mkdirSync(dirname(output),{recursive:true,mode:0o700});
   const actual=hashFile(source);if(actual.sha256!==file.sha256||actual.bytes!==file.bytes)fail('release_package_file_mismatch');
   writeFileSync(output,readFileSync(source),{flag:'wx',mode:file.mode===100755?0o755:0o644});
   try{chmodSync(output,file.mode===100755?0o755:0o644);}catch{}
   const copied=hashFile(output);if(copied.sha256!==file.sha256||copied.bytes!==file.bytes)fail('release_stage_copy_mismatch');
  }
  writeFileSync(join(staging,packageManifestName),encode(packageInfo.manifest),{flag:'wx',mode:0o600});
  verifyPackageFiles(staging,verifyCanonicalManifest(staging,expectedManifestSha256));
  releaseStageLock.assert();await assertSourcePreflight(staging,profile);releaseStageLock.assert();
  cache=join(root,'.jot-state','npm-cache',releaseId+'-'+randomUUID());mkdirSync(cache,{recursive:true,mode:0o700});
  const npm=npmCommand(),packageCwd=profile==='standalone'?staging:join(staging,'packages/gateway');
  await executeCommand(runCommand,npm,['ci','--no-audit','--no-fund'],packageCwd,signal,{npm_config_cache:cache},false,()=>releaseStageLock.assert());
  await executeCommand(runCommand,npm,['run','build'],packageCwd,signal,undefined,false,()=>releaseStageLock.assert());
  releaseStageLock.assert();removeBuildTemporaryDirectory(packageCwd);releaseStageLock.assert();verifyBuiltArtifacts(staging,profile);
  await executeCommand(runCommand,npm,['prune','--omit=dev'],packageCwd,signal,{npm_config_cache:cache},false,()=>releaseStageLock.assert());
  releaseStageLock.assert();removeEmptyNpmScopes(packageCwd);releaseStageLock.assert();
  removeTestOnlyNpmSubtrees(packageCwd);releaseStageLock.assert();
  const versionResult=await executeCommand(runCommand,npm,['--version'],packageCwd,signal,{npm_config_cache:cache},true,()=>releaseStageLock.assert());
  const npmVersion=String(versionResult?.stdout??'').trim();
  if(!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(npmVersion))fail('release_runtime_target_invalid');
  verifyDirectDependencies(staging,profile);
  const sourceLocks={root:packageInfo.manifest.packages.root.lockSha256,gateway:packageInfo.manifest.packages.gateway.lockSha256};
  releaseStageLock.assert();
  const runtime=createRuntimeManifest({root:staging,profile,sourceManifestSha256:packageInfo.manifestSha256,sourceLocks,npmVersion});
  writeFileSync(join(staging,runtimeManifestName),encode(runtime.manifest),{flag:'wx',mode:0o600});
  verifyInstalledRelease({installRoot:root,releaseId,expectedManifestSha256,expectedRuntimeSha256:runtime.runtimeSha256,expectedTarget:runtime.target,
   releaseRoot:staging,requireReadOnly:false});
  setTreeReadOnly(staging,true);
  verifyInstalledRelease({installRoot:root,releaseId,expectedManifestSha256,expectedRuntimeSha256:runtime.runtimeSha256,expectedTarget:runtime.target,releaseRoot:staging});
  releaseStageLock.assert();
  writeStagedProof(root,releaseId,packageInfo.manifestSha256,runtime.runtimeSha256,runtime.target);
  releaseStageLock.assert();
  const proof=readStagedProof(root,releaseId,packageInfo.manifestSha256);
  if(proof.runtimeSha256!==runtime.runtimeSha256||canonical(proof.target)!==canonical(runtime.target))fail('release_stage_identity_conflict');
  renameSync(staging,destination);
  published=true;
  publishedInfo=lstatSync(destination);
  releaseStageLock.assert();
  const publishedProof=readStagedProof(root,releaseId,packageInfo.manifestSha256);
  if(publishedProof.runtimeSha256!==runtime.runtimeSha256||canonical(publishedProof.target)!==canonical(runtime.target))fail('release_stage_identity_conflict');
  verifyInstalledRelease({installRoot:root,releaseId,expectedManifestSha256,expectedRuntimeSha256:runtime.runtimeSha256,expectedTarget:runtime.target});
  releaseStageLock.assert();
  const finalProof=readStagedProof(root,releaseId,packageInfo.manifestSha256);
  if(finalProof.runtimeSha256!==runtime.runtimeSha256||canonical(finalProof.target)!==canonical(runtime.target))fail('release_stage_identity_conflict');
  return {releaseId,manifestSha256:packageInfo.manifestSha256,sourceTag:packageInfo.sourceTag,sourceCommit:packageInfo.sourceCommit,
   profile,staged:true,alreadyPresent:false,runtimeSha256:runtime.runtimeSha256,target:runtime.target,
   sourceAndBuildFilesVerified:true,runtimeDependenciesVerified:true,completeRuntimeProof:true};
 }catch(error){
  if(published)removePublishedTreeIfSame(destination,publishedInfo);
  removeReleaseTree(staging);
  try{if(existsSync(releases)&&readdirSync(releases).length===0)rmSync(releases,{recursive:true,force:true});}catch{}
  if(error?.name==='AbortError')throw error;
  fail(error?.message?.startsWith('release_')?error.message:'release_stage_failed');
 }
 }finally{if(cache)try{rmSync(cache,{recursive:true,force:true});}catch{};releaseStageLock.release();}
}
export function createDesktopPortableManifest(input={}){
 return buildDesktopPortableManifest({...input,
  verifyPortablePackage:bindings=>verifyReleasePackage({...bindings,profile:'desktop-electron'})});
}

export function stageDesktopPortableRelease(input={}){
 return stageDesktopPortableReleaseCandidate({...input,stageRelease});
}

function statePath(installRoot){return join(resolve(installRoot),stateRelative);}
function backupRoot(installRoot){return join(resolve(installRoot),'.jot-state','recovery-points');}
function recordPath(installRoot,recoveryDigest){
 if(!shaPattern.test(recoveryDigest??''))fail('release_recovery_point_invalid');
 return join(backupRoot(installRoot),recoveryDigest);
}
function hostBackupProgram(installRoot,releaseId,override){
 if(override){const path=resolve(override);if(!existsSync(path))fail('release_backup_tool_missing');return path;}
 if(releaseId.endsWith('-desktop-electron'))fail('release_backup_tool_missing');
 const root=readReleaseRoot(installRoot,releaseId),compiled=join(root,'packages/gateway/dist/src/maintenance/host-backup-main.js');
 const source=join(root,'packages/gateway/src/maintenance/host-backup-main.ts');
 if(existsSync(compiled))return compiled;if(existsSync(source))return source;fail('release_backup_tool_missing');
}
function callHostBackup(script,args,cwd){
 const result=spawnSync(process.execPath,[script,...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true,maxBuffer:1024*1024});
 if(result.error||result.status!==0)fail('release_backup_operation_failed');
 try{const value=JSON.parse((result.stdout??'').trim());if(!isRecord(value))fail('release_backup_receipt_invalid');return value;}
 catch{fail('release_backup_receipt_invalid');}
}
function backupReceipt(script,action,bundle,digest,configPath,cwd){
 const args=action==='create'?[action,configPath,bundle]:action==='verify'?[action,bundle,digest]:['restore',configPath,bundle,digest];
 const receipt=callHostBackup(script,args,cwd);
 if(action==='create'&&(!shaPattern.test(receipt.backup_id??'')||receipt.verified!==true))fail('release_backup_receipt_invalid');
 if(action==='verify'&&receipt.verified!==true)fail('release_backup_receipt_invalid');
 if(action==='restore'&&receipt.restored!==true)fail('release_backup_receipt_invalid');
 return receipt;
}
function desktopUserDataScope(privateBackupConfig,userDataRoot){
 if(typeof privateBackupConfig!=='string'||typeof userDataRoot!=='string'||!isAbsolute(userDataRoot))fail('release_user_data_scope_invalid');
 let config;
 try{const info=lstatSync(privateBackupConfig);if(!info.isFile()||info.isSymbolicLink()||info.size>65536)fail('release_user_data_scope_invalid');
  config=JSON.parse(readFileSync(privateBackupConfig,'utf8'));}catch{fail('release_user_data_scope_invalid');}
 if(!isRecord(config)||Object.keys(config).sort().join(',')!=='database,offline,roots'||config.offline!==true
  ||typeof config.database!=='string'||!Array.isArray(config.roots)||config.roots.length!==6)fail('release_user_data_scope_invalid');
 const root=resolve(userDataRoot),database=resolve(config.database),kinds=['artifacts','database','host-config','notification-archives','sessions','workspaces'];
 const roots=[],selected=[];
 for(const item of config.roots){
  const keys=item&&Object.keys(item).sort().join(',');
  if(!item||!['kind,path','entries,kind,path'].includes(keys)||!kinds.includes(item.kind)||typeof item.path!=='string')fail('release_user_data_scope_invalid');
  const path=resolve(item.path),entries=keys==='entries,kind,path'?item.entries:undefined;
  if(entries!==undefined&&(!Array.isArray(entries)||!entries.length||entries.some(entry=>typeof entry!=='string'||!entry
   ||entry.includes('\\')||entry.startsWith('/')||entry.split('/').some(part=>!part||part==='.'||part==='..'))))fail('release_user_data_scope_invalid');
  const normalizedEntries=entries?[...entries].sort((a,b)=>a.localeCompare(b,'en')):null;
  roots.push({kind:item.kind,path,...(normalizedEntries?{entries:normalizedEntries}:{})});
  if(normalizedEntries){for(const entry of normalizedEntries){
   const selectedPath=resolve(path,...entry.split('/'));
   if(!pathInside(selectedPath,root))fail('release_user_data_scope_invalid');
   selected.push(selectedPath);
  }}else{
   if(!pathInside(path,root))fail('release_user_data_scope_invalid');
   selected.push(path);
  }
 }
 if(new Set(roots.map(item=>item.kind)).size!==kinds.length||new Set(roots.map(item=>item.path)).size!==roots.length
  ||!pathInside(database,root)||database!==resolve(root,'jot.db'))fail('release_user_data_scope_invalid');
 const covers=(target)=>roots.some(item=>{
  if(!item.entries)return pathInside(target,item.path);
  return item.entries.some(entry=>pathInside(target,resolve(item.path,...entry.split('/'))));
 });
 if(!covers(database)||!covers(resolve(root,'files'))||!covers(resolve(root,'desktop-notifications.json')))
  fail('release_user_data_scope_incomplete');
 for(let i=0;i<selected.length;i++)for(let j=i+1;j<selected.length;j++){
  if(pathsOverlap(selected[i],selected[j]))fail('release_user_data_scope_overlap');
 }
 roots.sort((a,b)=>a.kind.localeCompare(b.kind,'en'));
 return {userDataRoot:root,userDataScopeSha256:hash(canonical({userDataRoot:root,database,roots}))};
}
export async function createRecoveryPoint({installRoot,releaseId,privateBackupConfig,userDataRoot,hostBackupScript:override}){
 const current=readDeploymentState(installRoot);
 if(!current||current.active.releaseId!==releaseId)fail('release_backup_active_version_mismatch');
 const installed=verifyInstalledRelease({installRoot,releaseId,expectedManifestSha256:current.active.manifestSha256,
  expectedRuntimeSha256:current.active.runtimeSha256,expectedTarget:current.active.target});
 const userDataScope=installed.profile==='desktop-electron'?desktopUserDataScope(privateBackupConfig,userDataRoot):null;
 const script=hostBackupProgram(installRoot,releaseId,override),root=backupRoot(installRoot);
 mkdirSync(root,{recursive:true,mode:0o700});
 const staging=join(root,'.staging-'+randomUUID()),bundle=join(staging,'bundle');
 try{
  mkdirSync(staging,{recursive:false,mode:0o700});
  const created=backupReceipt(script,'create',bundle,'',resolve(privateBackupConfig),resolve(installRoot));
  backupReceipt(script,'verify',bundle,created.backup_id,'',resolve(installRoot));
  const record={protocol,releaseId,profile:installed.profile,manifestSha256:installed.manifestSha256,sourceTag:installed.sourceTag,sourceCommit:installed.sourceCommit,
   databaseProtocolSha256:installed.databaseProtocolSha256,backupDigest:created.backup_id};
  if(userDataScope)Object.assign(record,userDataScope);
  if(installed.completeRuntimeProof){record.runtimeSha256=installed.runtimeSha256;record.target=installed.target;}
  const recoveryDigest=hash(canonical(record)),destination=join(root,recoveryDigest);
  if(existsSync(destination))fail('release_recovery_point_exists');
  writeFileSync(join(staging,'recovery-point.json'),encode(record),{flag:'wx',mode:0o600});renameSync(staging,destination);
  return {backupId:recoveryDigest,recoveryDigest,hostBackupDigest:created.backup_id,releaseId,sourceTag:installed.sourceTag,sourceCommit:installed.sourceCommit,
   ...(installed.completeRuntimeProof?{runtimeSha256:installed.runtimeSha256,target:installed.target}:{}),verified:true};
 }catch(error){
  try{rmSync(staging,{recursive:true,force:true});}catch{}
  if(error?.message?.startsWith('release_'))throw error;
  fail('release_backup_operation_failed');
 }
}
export function verifyRecoveryPoint({installRoot,backupId,privateBackupConfig,userDataRoot,hostBackupScript:override}){
 const root=recordPath(installRoot,backupId),path=join(root,'recovery-point.json');
 let raw,record;
 try{const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>65536)fail('release_recovery_point_invalid');raw=readFileSync(path,'utf8');record=JSON.parse(raw);}
 catch{fail('release_recovery_point_invalid');}
 const recordKeys=Object.keys(record??{}).sort().join(','),legacyKeys='backupDigest,databaseProtocolSha256,manifestSha256,profile,protocol,releaseId,sourceCommit,sourceTag';
 const v2Keys='backupDigest,databaseProtocolSha256,manifestSha256,profile,protocol,releaseId,runtimeSha256,sourceCommit,sourceTag,target';
 const desktopKeys=[...v2Keys.split(','),'userDataRoot','userDataScopeSha256'].sort().join(',');
 const hasDesktopScope=recordKeys===desktopKeys,hasRuntimeProof=recordKeys===v2Keys||hasDesktopScope;
 if(!isRecord(record)||raw!==encode(record)||(recordKeys!==legacyKeys&&!hasRuntimeProof)
  ||record.protocol!==protocol||hash(canonical(record))!==backupId||!shaPattern.test(record.backupDigest)||!shaPattern.test(record.manifestSha256)
  ||!releaseIdPattern.test(record.releaseId)||!['standalone','gateway','desktop-electron'].includes(record.profile)
  ||(record.profile==='desktop-electron'?(record.sourceTag!==null||!hasDesktopScope):(!tagPattern.test(record.sourceTag)||hasDesktopScope))
  ||!/^[a-f0-9]{40,64}$/.test(record.sourceCommit)
  ||!shaPattern.test(record.databaseProtocolSha256)||(hasRuntimeProof&&(!shaPattern.test(record.runtimeSha256)||!validTargetBinding(record.target,record.profile))))fail('release_recovery_point_invalid');
 if(hasDesktopScope){
  const scope=desktopUserDataScope(privateBackupConfig,userDataRoot);
  if(scope.userDataRoot!==record.userDataRoot||scope.userDataScopeSha256!==record.userDataScopeSha256)fail('release_user_data_scope_mismatch');
 }
 const installed=verifyInstalledRelease({installRoot,releaseId:record.releaseId,expectedManifestSha256:record.manifestSha256,
  expectedRuntimeSha256:record.runtimeSha256,expectedTarget:record.target});
 if(installed.profile!==record.profile||installed.sourceTag!==record.sourceTag||installed.sourceCommit!==record.sourceCommit
  ||installed.databaseProtocolSha256!==record.databaseProtocolSha256||hasRuntimeProof!==installed.completeRuntimeProof)fail('release_recovery_release_mismatch');
 const script=hostBackupProgram(installRoot,record.releaseId,override);
 backupReceipt(script,'verify',join(root,'bundle'),record.backupDigest,'',resolve(installRoot));
 return {backupId,recoveryDigest:backupId,hostBackupDigest:record.backupDigest,releaseId:record.releaseId,sourceTag:record.sourceTag,
  sourceCommit:record.sourceCommit,profile:record.profile,manifestSha256:record.manifestSha256,
  databaseProtocolSha256:record.databaseProtocolSha256,...(hasRuntimeProof?{runtimeSha256:record.runtimeSha256,target:record.target}:{}),
  ...(hasDesktopScope?{userDataRoot:record.userDataRoot,userDataScopeSha256:record.userDataScopeSha256}:{}),backupVerified:true};
}
export async function restoreRecoveryPoint({installRoot,backupId,privateBackupConfig,userDataRoot,hostBackupScript:override}){
 const verified=verifyRecoveryPoint({installRoot,backupId,privateBackupConfig,userDataRoot,hostBackupScript:override}),script=hostBackupProgram(installRoot,verified.releaseId,override);
 const current=readDeploymentState(installRoot);
 if(!current)fail('release_deployment_not_active');
 const active=verifyInstalledRelease({installRoot,releaseId:current.active.releaseId,expectedManifestSha256:current.active.manifestSha256,
  expectedRuntimeSha256:current.active.runtimeSha256,expectedTarget:current.active.target});
 if(active.databaseProtocolSha256!==verified.databaseProtocolSha256)fail('release_migration_protocol_changed');
 const result=backupReceipt(script,'restore',join(recordPath(installRoot,backupId),'bundle'),verified.hostBackupDigest,resolve(privateBackupConfig),resolve(installRoot));
 return {backupId,recoveryDigest:backupId,restored:result.restored===true};
}
function checkProfile(profile){if(!['standalone','gateway','desktop-electron'].includes(profile))fail('release_profile_invalid');}
async function probeHealth(profile,url){
 const parsed=validateHealthUrl(profile,url);
 let response;try{response=await fetch(parsed,{method:'HEAD',headers:{accept:'application/json'},signal:AbortSignal.timeout(5000),cache:'no-store',redirect:'manual'});}
 catch{fail('release_health_check_failed');}
 if(!response.ok)fail('release_health_check_failed');
 try{await response.body?.cancel();}catch{fail('release_health_check_failed');}
}
function validateHealthUrl(profile,url){
 checkProfile(profile);
 let parsed;try{parsed=new URL(url);}catch{fail('release_health_url_invalid');}
 if(parsed.protocol!=='http:'||parsed.username||parsed.password||parsed.search||parsed.hash
  ||!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname))fail('release_health_url_must_be_loopback');
 const expectedPath=profile==='standalone'||profile==='desktop-electron'?'/api/capabilities':'/healthz';
 if(parsed.pathname!==expectedPath)fail('release_health_path_invalid');
 return parsed;
}
function assertCompatible(previous,candidate){if(previous.databaseProtocolSha256!==candidate.databaseProtocolSha256)fail('release_migration_protocol_changed');}
function requireRecovery(installRoot,backupId,expectedReleaseId,hostBackupScript,privateBackupConfig,userDataRoot){
 if(!backupId)fail('release_verified_backup_required');
 const point=verifyRecoveryPoint({installRoot,backupId,hostBackupScript,privateBackupConfig,userDataRoot});
 if(point.releaseId!==expectedReleaseId)fail('release_backup_version_mismatch');
 return point;
}
function validUtcTimestamp(value){return typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value));}
function validateDesktopDrainReceipt(value,releaseId){
 if(!isRecord(value)||Object.keys(value).sort().join(',')!=='backendClosedAt,instanceId,lifecyclePhase,releaseId'
  ||value.releaseId!==releaseId||typeof value.instanceId!=='string'||!value.instanceId
  ||value.lifecyclePhase!=='stopped'||!validUtcTimestamp(value.backendClosedAt))fail('release_desktop_drain_receipt_invalid');
 return value;
}
function validateDesktopProbeReceipt(value,candidate,probeRoot){
 if(!isRecord(value)||Object.keys(value).sort().join(',')!=='instanceId,origin,readyAt,releaseId,status,target'
  ||value.releaseId!==candidate.releaseId||typeof value.instanceId!=='string'||!value.instanceId
  ||value.status!=='ready'||!validUtcTimestamp(value.readyAt)||canonical(value.target)!==canonical(candidate.target))
  fail('release_desktop_probe_receipt_invalid');
 let origin;try{origin=new URL(value.origin);}catch{fail('release_desktop_probe_receipt_invalid');}
 if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)
  fail('release_desktop_probe_receipt_invalid');
 if(typeof probeRoot!=='string'||!isAbsolute(probeRoot)||pathsOverlap(probeRoot,readReleaseRoot(candidate.installRoot,candidate.releaseId)))
  fail('release_desktop_probe_root_invalid');
 return value;
}
function validateDesktopProbeRoot(probeRoot,installRoot,userDataRoot){
 if(typeof probeRoot!=='string'||!isAbsolute(probeRoot)||typeof userDataRoot!=='string'||!isAbsolute(userDataRoot)
  ||pathsOverlap(probeRoot,installRoot)||pathsOverlap(probeRoot,userDataRoot)||pathsOverlap(installRoot,userDataRoot)
  ||existsSync(probeRoot))fail('release_desktop_probe_root_invalid');
}
async function activateDesktopElectron({installRoot,releaseId,expectedManifestSha256,expectedRuntimeSha256,backupId,healthUrl,
 desktopLifecycle,probeRoot,signal,hostBackupScript,privateBackupConfig,userDataRoot,drained}){
 if(drained!==undefined)fail('release_consumer_drain_boolean_forbidden');
 if(!isRecord(desktopLifecycle)||typeof desktopLifecycle.probeRelease!=='function'||typeof desktopLifecycle.drainActive!=='function')
  fail('release_desktop_lifecycle_required');
 validateDesktopProbeRoot(probeRoot,resolve(installRoot),userDataRoot);
 validateHealthUrl('desktop-electron',healthUrl);
 const candidate=verifyInstalledRelease({installRoot,releaseId,expectedManifestSha256,expectedRuntimeSha256});
 if(!candidate.completeRuntimeProof||candidate.profile!=='desktop-electron')fail('release_profile_mismatch');
 const current=readDeploymentState(installRoot);
 if(current?.active.releaseId===releaseId)fail('release_already_active');
 if(current){
  const previous=verifyInstalledRelease({installRoot,releaseId:current.active.releaseId,expectedManifestSha256:current.active.manifestSha256,
   expectedRuntimeSha256:current.active.runtimeSha256,expectedTarget:current.active.target});
  if(previous.profile!=='desktop-electron')fail('release_profile_mismatch');
  assertCompatible(previous,candidate);
  const point=requireRecovery(installRoot,backupId,current.active.releaseId,hostBackupScript,privateBackupConfig,userDataRoot);
  if(point.manifestSha256!==current.active.manifestSha256||point.runtimeSha256!==current.active.runtimeSha256
   ||canonical(point.target)!==canonical(current.active.target))fail('release_backup_version_mismatch');
  let drain;try{drain=await desktopLifecycle.drainActive({releaseId:current.active.releaseId,signal});}catch{fail('release_desktop_drain_failed');}
  validateDesktopDrainReceipt(drain,current.active.releaseId);
 }
 let probe;try{probe=await desktopLifecycle.probeRelease({releaseId,releaseRoot:readReleaseRoot(installRoot,releaseId),
  expectedTarget:candidate.target,healthUrl,probeRoot,signal});}catch{fail('release_desktop_probe_failed');}
 validateDesktopProbeReceipt(probe,{...candidate,installRoot},probeRoot);
 const next={protocol,active:{releaseId,manifestSha256:expectedManifestSha256,profile:candidate.profile,
  runtimeSha256:candidate.runtimeSha256,target:candidate.target},previous:current?.active??null};
 writeAtomic(statePath(installRoot),encode(next));
 return {previousReleaseId:current?.active.releaseId??null,activeReleaseId:releaseId,activated:true,probeInstanceId:probe.instanceId};
}
async function rollbackDesktopElectron({installRoot,restoreReleaseId,backupId,healthUrl,desktopLifecycle,probeRoot,signal,hostBackupScript,
 privateBackupConfig,userDataRoot,drained}){
 if(drained!==undefined)fail('release_consumer_drain_boolean_forbidden');
 if(!isRecord(desktopLifecycle)||typeof desktopLifecycle.probeRelease!=='function'||typeof desktopLifecycle.drainActive!=='function')
  fail('release_desktop_lifecycle_required');
 validateDesktopProbeRoot(probeRoot,resolve(installRoot),userDataRoot);
 validateHealthUrl('desktop-electron',healthUrl);
 const current=readDeploymentState(installRoot);
 if(!current||!current.previous||current.previous.releaseId!==restoreReleaseId)fail('release_rollback_target_invalid');
 const active=verifyInstalledRelease({installRoot,releaseId:current.active.releaseId,expectedManifestSha256:current.active.manifestSha256,
  expectedRuntimeSha256:current.active.runtimeSha256,expectedTarget:current.active.target});
 const target=verifyInstalledRelease({installRoot,releaseId:restoreReleaseId,expectedManifestSha256:current.previous.manifestSha256,
  expectedRuntimeSha256:current.previous.runtimeSha256,expectedTarget:current.previous.target});
 if(!active.completeRuntimeProof||!target.completeRuntimeProof||active.profile!=='desktop-electron'||target.profile!=='desktop-electron')
  fail('release_runtime_proof_required');
 assertCompatible(active,target);
 const point=requireRecovery(installRoot,backupId,restoreReleaseId,hostBackupScript,privateBackupConfig,userDataRoot);
 if(point.manifestSha256!==target.manifestSha256||point.runtimeSha256!==target.runtimeSha256
  ||canonical(point.target)!==canonical(target.target))fail('release_backup_version_mismatch');
 let drain;try{drain=await desktopLifecycle.drainActive({releaseId:current.active.releaseId,signal});}catch{fail('release_desktop_drain_failed');}
 validateDesktopDrainReceipt(drain,current.active.releaseId);
 let probe;try{probe=await desktopLifecycle.probeRelease({releaseId:restoreReleaseId,releaseRoot:readReleaseRoot(installRoot,restoreReleaseId),
  expectedTarget:target.target,healthUrl,probeRoot,signal});}catch{fail('release_desktop_probe_failed');}
 validateDesktopProbeReceipt(probe,{...target,installRoot},probeRoot);
 writeAtomic(statePath(installRoot),encode({protocol,active:current.previous,previous:current.active}));
 return {previousReleaseId:current.active.releaseId,activeReleaseId:restoreReleaseId,activated:true,rolledBack:true,probeInstanceId:probe.instanceId};
}
export async function activateRelease({installRoot,releaseId,expectedManifestSha256,expectedRuntimeSha256,backupId,drained,healthUrl,profile,healthProbe=probeHealth,hostBackupScript,desktopLifecycle,probeRoot,signal,privateBackupConfig,userDataRoot}){
 if(profile==='desktop-electron')return activateDesktopElectron({installRoot,releaseId,expectedManifestSha256,expectedRuntimeSha256,backupId,
  healthUrl,desktopLifecycle,probeRoot,signal,hostBackupScript,privateBackupConfig,userDataRoot,drained});
 if(drained!==true)fail('release_consumer_drain_required');
 validateHealthUrl(profile,healthUrl);
 const candidate=verifyInstalledRelease({installRoot,releaseId,expectedManifestSha256,expectedRuntimeSha256});
 if(!candidate.completeRuntimeProof)fail('release_runtime_proof_required');
 const current=readDeploymentState(installRoot);
 if(candidate.profile!==profile)fail('release_profile_mismatch');
 if(current?.active.releaseId===releaseId)fail('release_already_active');
 if(current){
  const previous=verifyInstalledRelease({installRoot,releaseId:current.active.releaseId,expectedManifestSha256:current.active.manifestSha256,
   expectedRuntimeSha256:current.active.runtimeSha256,expectedTarget:current.active.target});
  assertCompatible(previous,candidate);
  const point=requireRecovery(installRoot,backupId,current.active.releaseId,hostBackupScript);
  if(point.manifestSha256!==current.active.manifestSha256||(current.active.runtimeSha256
   &&(point.runtimeSha256!==current.active.runtimeSha256||canonical(point.target)!==canonical(current.active.target))))fail('release_backup_version_mismatch');
 }
 await healthProbe(profile,healthUrl);
 const next={protocol,active:{releaseId,manifestSha256:expectedManifestSha256,profile:candidate.profile,
  runtimeSha256:candidate.runtimeSha256,target:candidate.target},previous:current?.active??null};
 writeAtomic(statePath(installRoot),encode(next));
 return {previousReleaseId:current?.active.releaseId??null,activeReleaseId:releaseId,activated:true};
}
export async function rollbackRelease({installRoot,restoreReleaseId,backupId,drained,healthUrl,profile,healthProbe=probeHealth,hostBackupScript,desktopLifecycle,probeRoot,signal,privateBackupConfig,userDataRoot}){
 if(profile==='desktop-electron')return rollbackDesktopElectron({installRoot,restoreReleaseId,backupId,healthUrl,desktopLifecycle,probeRoot,signal,
  hostBackupScript,privateBackupConfig,userDataRoot,drained});
 if(drained!==true)fail('release_consumer_drain_required');
 validateHealthUrl(profile,healthUrl);
 const current=readDeploymentState(installRoot);
 if(!current||!current.previous||current.previous.releaseId!==restoreReleaseId)fail('release_rollback_target_invalid');
 const active=verifyInstalledRelease({installRoot,releaseId:current.active.releaseId,expectedManifestSha256:current.active.manifestSha256,
  expectedRuntimeSha256:current.active.runtimeSha256,expectedTarget:current.active.target});
 const target=verifyInstalledRelease({installRoot,releaseId:restoreReleaseId,expectedManifestSha256:current.previous.manifestSha256,
  expectedRuntimeSha256:current.previous.runtimeSha256,expectedTarget:current.previous.target});
 if(!active.completeRuntimeProof||!target.completeRuntimeProof)fail('release_runtime_proof_required');
 if(target.profile!==profile)fail('release_profile_mismatch');
 assertCompatible(active,target);
 const point=requireRecovery(installRoot,backupId,restoreReleaseId,hostBackupScript);
 if(point.manifestSha256!==target.manifestSha256||point.runtimeSha256!==target.runtimeSha256
  ||canonical(point.target)!==canonical(target.target))fail('release_backup_version_mismatch');
 await healthProbe(profile,healthUrl);
 writeAtomic(statePath(installRoot),encode({protocol,active:current.previous,previous:current.active}));
 return {previousReleaseId:current.active.releaseId,activeReleaseId:restoreReleaseId,activated:true,rolledBack:true};
}
const desktopOperationIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const desktopHandoffStates=new Set(['requested','launched','healthy','rolled-back','unknown']);
const desktopStartupStates=new Set(['pending','attempted','healthy']);
function exactRecordKeys(value,keys){return isRecord(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');}
function normalizeDesktopHandoff(value){
 if(!exactRecordKeys(value,['protocol','operationId','profile','candidate','previous','recovery','state'])||value.protocol!==1
  ||!desktopOperationIdPattern.test(value.operationId??'')||value.profile!=='desktop-electron'||!desktopHandoffStates.has(value.state)
  ||!exactRecordKeys(value.candidate,['releaseId','manifestSha256'])||!exactRecordKeys(value.previous,['releaseId','manifestSha256'])
  ||!exactRecordKeys(value.recovery,['backupId','releaseId'])||!releaseIdPattern.test(value.candidate.releaseId??'')
  ||!releaseIdPattern.test(value.previous.releaseId??'')||!releaseIdPattern.test(value.recovery.releaseId??'')
  ||!shaPattern.test(value.candidate.manifestSha256??'')||!shaPattern.test(value.previous.manifestSha256??'')
  ||!shaPattern.test(value.recovery.backupId??'')||value.candidate.releaseId===value.previous.releaseId
  ||value.recovery.releaseId!==value.previous.releaseId)fail('release_desktop_handoff_invalid');
 return value;
}
function normalizeDesktopStartup(value,handoff){
 if(!exactRecordKeys(value,['protocol','operationId','candidate','recovery','state'])||value.protocol!==1
  ||value.operationId!==handoff.operationId||!desktopStartupStates.has(value.state)
  ||!exactRecordKeys(value.candidate,['releaseId','manifestSha256'])||!exactRecordKeys(value.recovery,['backupId','releaseId'])
  ||canonical(value.candidate)!==canonical(handoff.candidate)||canonical(value.recovery)!==canonical(handoff.recovery))
  fail('release_desktop_startup_receipt_invalid');
 return value;
}
function desktopHandoffClaimPath(installRoot,operationId){
 if(typeof installRoot!=='string'||!installRoot||!isAbsolute(installRoot))fail('release_desktop_handoff_install_root_invalid');
 const root=resolve(installRoot),stateRoot=join(root,'.jot-state');
 try{mkdirSync(stateRoot,{recursive:true,mode:0o700});}catch{fail('release_desktop_handoff_claim_unavailable');}
 let info;try{info=lstatSync(stateRoot);}catch{fail('release_desktop_handoff_claim_unavailable');}
 if(!info.isDirectory()||info.isSymbolicLink())fail('release_desktop_handoff_claim_unavailable');
 return join(stateRoot,'launcher-handoff-'+operationId+'.lock');
}
function desktopHandoffClaimPresent(installRoot,operationId){
 const path=desktopHandoffClaimPath(installRoot,operationId);
 try{lstatSync(path);return true;}catch(error){if(error?.code==='ENOENT')return false;return true;}
}
function acquireDesktopHandoffClaim(installRoot,operationId){
 const path=desktopHandoffClaimPath(installRoot,operationId),raw=encode({protocol:1,operationId,pid:process.pid,token:randomUUID()});
 let fd,created=false,identity;
 try{
  fd=openSync(path,'wx',0o600);created=true;writeFileSync(fd,raw,'utf8');fsyncSync(fd);identity=fstatSync(fd);closeSync(fd);fd=undefined;
 }catch(error){
  if(fd!==undefined)try{closeSync(fd);}catch{}
  if(created)try{unlinkSync(path);}catch{}
  if(error?.code==='EEXIST')fail('release_desktop_handoff_claim_exists');
  fail('release_desktop_handoff_claim_unavailable');
 }
 let released=false;
 return {release(){
  if(released)return;released=true;
  try{
   const current=lstatSync(path);
   if(!current.isFile()||current.isSymbolicLink()||!sameFile(current,identity)||readFileSync(path,'utf8')!==raw)return;
   unlinkSync(path);
  }catch{}
 }};
}
function matchesDesktopRef(ref,identity){
 return isRecord(ref)&&ref.profile==='desktop-electron'&&ref.releaseId===identity.releaseId&&ref.manifestSha256===identity.manifestSha256;
}
function assertDesktopRuntimeRef({installRoot,ref,identity}){
 if(!matchesDesktopRef(ref,identity)||!shaPattern.test(ref.runtimeSha256??'')||!validTargetBinding(ref.target,'desktop-electron'))
  fail('release_desktop_handoff_pointer_mismatch');
 const installed=verifyInstalledRelease({installRoot,releaseId:ref.releaseId,expectedManifestSha256:ref.manifestSha256,
  expectedRuntimeSha256:ref.runtimeSha256,expectedTarget:ref.target});
 if(!installed.completeRuntimeProof||installed.profile!=='desktop-electron'||installed.runtimeSha256!==ref.runtimeSha256
  ||canonical(installed.target)!==canonical(ref.target))fail('release_desktop_handoff_runtime_mismatch');
 return installed;
}
function sameHandoffWithState(left,right,state){
 if(!left||!right)return false;
 try{return canonical({...left,state})===canonical({...right,state});}catch{return false;}
}
async function transitionDesktopHandoff(store,handoff,from,to){
 const changed=await store.transitionHandoff({operationId:handoff.operationId,from,to});
 let won=changed===true;
 if(!won&&isRecord(changed?.operation?.handoff)){
  try{const recorded=normalizeDesktopHandoff(changed.operation.handoff);won=recorded.state===to&&sameHandoffWithState(recorded,handoff,to);}catch{}
 }
 if(!won)return false;
 const readback=normalizeDesktopHandoff(await store.readHandoff());
 return readback.state===to&&sameHandoffWithState(readback,handoff,to);
}
async function markDesktopHandoffUnknown(store,handoff,from=handoff?.state){
 if(!handoff||!['requested','launched'].includes(from))return false;
 try{return await transitionDesktopHandoff(store,handoff,from,'unknown');}catch{return false;}
}
function desktopHandoffOutcome(state,handoff,details={}){
 return {state,operationId:handoff?.operationId??null,candidate:handoff?.candidate??null,
  previous:handoff?.previous??null,recovery:handoff?.recovery??null,...details};
}
export async function continueDesktopLaunchHandoff({installRoot,previousLaunch,handoffStore,healthUrl,rollbackProbeRoot,desktopLifecycle,
 hostBackupScript,privateBackupConfig,userDataRoot,startupTimeoutMs=30000,signal,spawnRuntime,launchBinding}){
 if(!isRecord(handoffStore)||typeof handoffStore.readHandoff!=='function'||typeof handoffStore.transitionHandoff!=='function'
  ||typeof handoffStore.readStartup!=='function'||typeof handoffStore.waitForStartup!=='function')fail('release_desktop_handoff_store_required');
 let handoff;
 try{handoff=normalizeDesktopHandoff(await handoffStore.readHandoff());}
 catch{return desktopHandoffOutcome('unknown',null,{reason:'release_desktop_handoff_unavailable'});}
 if(handoff.state==='healthy'||handoff.state==='rolled-back'||handoff.state==='unknown')return desktopHandoffOutcome(handoff.state,handoff);
 if(handoff.state!=='requested'){
  if(handoff.state==='launched'){
   let claimed=true;try{claimed=desktopHandoffClaimPresent(installRoot,handoff.operationId);}catch{}
   if(claimed)return desktopHandoffOutcome('unknown',handoff,{reason:'release_desktop_handoff_already_launched'});
  }
  await markDesktopHandoffUnknown(handoffStore,handoff,'launched');
  return desktopHandoffOutcome('unknown',handoff,{reason:'release_desktop_handoff_replay_forbidden'});
 }
 if(!isRecord(previousLaunch)||previousLaunch.exitCode!==75||previousLaunch.signal!==null
  ||launchBinding&&queryVerifiedRuntimeExit(previousLaunch).exitObserved!==true
  ||previousLaunch.releaseId!==handoff.previous.releaseId||previousLaunch.manifestSha256!==handoff.previous.manifestSha256){
  await markDesktopHandoffUnknown(handoffStore,handoff,'requested');
  return desktopHandoffOutcome('unknown',handoff,{reason:'release_desktop_handoff_exit_mismatch'});
 }
 if(!Number.isSafeInteger(startupTimeoutMs)||startupTimeoutMs<1||startupTimeoutMs>10*60*1000){
  await markDesktopHandoffUnknown(handoffStore,handoff,'requested');
  return desktopHandoffOutcome('unknown',handoff,{reason:'release_desktop_startup_timeout_invalid'});
 }
 let candidate,previous,point;
 try{
  validateHealthUrl('desktop-electron',healthUrl);
  if(!isRecord(desktopLifecycle)||typeof desktopLifecycle.probeRelease!=='function'||typeof desktopLifecycle.drainActive!=='function')
   fail('release_desktop_lifecycle_required');
  const deployment=readDeploymentState(installRoot);
  if(!deployment||!matchesDesktopRef(deployment.active,handoff.candidate)||!matchesDesktopRef(deployment.previous,handoff.previous))
   fail('release_desktop_handoff_pointer_mismatch');
  candidate=assertDesktopRuntimeRef({installRoot,ref:deployment.active,identity:handoff.candidate});
  previous=assertDesktopRuntimeRef({installRoot,ref:deployment.previous,identity:handoff.previous});
  assertCompatible(previous,candidate);
  point=verifyRecoveryPoint({installRoot,backupId:handoff.recovery.backupId,hostBackupScript,privateBackupConfig,userDataRoot});
  if(point.backupId!==handoff.recovery.backupId||point.releaseId!==handoff.recovery.releaseId||point.profile!=='desktop-electron'
   ||point.manifestSha256!==previous.manifestSha256||point.runtimeSha256!==previous.runtimeSha256
   ||canonical(point.target)!==canonical(previous.target)||point.backupVerified!==true)
   fail('release_desktop_handoff_recovery_mismatch');
 }catch(error){
  await markDesktopHandoffUnknown(handoffStore,handoff,'requested');
  return desktopHandoffOutcome('unknown',handoff,{reason:error?.message?.startsWith('release_')?error.message:'release_desktop_handoff_validation_failed'});
 }
 if(signal?.aborted){
  await markDesktopHandoffUnknown(handoffStore,handoff,'requested');
  return desktopHandoffOutcome('unknown',handoff,{reason:'release_desktop_handoff_cancelled_before_launch'});
 }
 let handoffClaim;
 try{handoffClaim=acquireDesktopHandoffClaim(installRoot,handoff.operationId);}
 catch(error){
  return desktopHandoffOutcome('unknown',handoff,{reason:error?.message==='release_desktop_handoff_claim_exists'
   ?'release_desktop_handoff_already_claimed':'release_desktop_handoff_claim_unavailable'});
 }
 let launched=false;
 try{launched=await transitionDesktopHandoff(handoffStore,handoff,'requested','launched');}catch{}
 if(!launched){
  handoffClaim.release();
  await markDesktopHandoffUnknown(handoffStore,handoff,'requested');
  return desktopHandoffOutcome('unknown',handoff,{reason:'release_desktop_handoff_launch_claim_lost'});
 }
 const launchedHandoff={...handoff,state:'launched'};
 let launchPromise;
 try{
  const root=readReleaseRoot(installRoot,candidate.releaseId),runtimeEnv=verifiedRuntimeEnvironment({envFile:join(resolve(installRoot),'.env')});
  launchPromise=launchVerifiedRuntime({root,cwd:resolve(installRoot),expectedRuntimeSha256:candidate.runtimeSha256,
   expectedSourceManifestSha256:candidate.manifestSha256,expectedTarget:candidate.target,entryRelative:'Jot.exe',args:[],env:runtimeEnv,
   runtimeKind:'electron',...(launchBinding?{launchBinding}:{}),...(spawnRuntime?{spawnRuntime}:{})});
 }catch(error){
  handoffClaim.release();
  await markDesktopHandoffUnknown(handoffStore,launchedHandoff,'launched');
  return desktopHandoffOutcome('unknown',launchedHandoff,{reason:error?.message?.startsWith('release_')?error.message:'release_desktop_candidate_launch_failed'});
 }
 const exitPromise=launchPromise.then(value=>({kind:'exit',value}),error=>({kind:'launch-error',error}));
 const startupController=new AbortController();
 const forwardAbort=()=>startupController.abort(signal?.reason);
 if(signal?.aborted)forwardAbort();else signal?.addEventListener('abort',forwardAbort,{once:true});
 const startupPromise=Promise.resolve().then(()=>handoffStore.waitForStartup({operationId:handoff.operationId,candidate:handoff.candidate,
  recovery:handoff.recovery,timeoutMs:startupTimeoutMs,signal:startupController.signal})).then(value=>({kind:'startup',value}),error=>({kind:'startup-error',error}));
 const first=await Promise.race([exitPromise,startupPromise]);
 if(first.kind==='startup'&&first.value!==null){
  let receipt;
  try{receipt=normalizeDesktopStartup(first.value,handoff);if(receipt.state!=='healthy')fail('release_desktop_startup_receipt_invalid');}
  catch(error){startupController.abort();signal?.removeEventListener('abort',forwardAbort);
   void exitPromise.then(()=>handoffClaim.release());
   await markDesktopHandoffUnknown(handoffStore,launchedHandoff,'launched');
   return desktopHandoffOutcome('unknown',launchedHandoff,{reason:error?.message?.startsWith('release_')?error.message:'release_desktop_startup_receipt_invalid'});}
  let healthy=false;
  try{healthy=await transitionDesktopHandoff(handoffStore,launchedHandoff,'launched','healthy');}catch{}
  if(!healthy){startupController.abort();signal?.removeEventListener('abort',forwardAbort);
   void exitPromise.then(()=>handoffClaim.release());
   await markDesktopHandoffUnknown(handoffStore,launchedHandoff,'launched');
   return desktopHandoffOutcome('unknown',launchedHandoff,{reason:'release_desktop_handoff_health_claim_lost'});}
  startupController.abort();signal?.removeEventListener('abort',forwardAbort);
  const exited=await exitPromise;
  handoffClaim.release();
  if(exited.kind==='exit')return desktopHandoffOutcome('healthy',{...launchedHandoff,state:'healthy'},
   {launch:exited.value,exitCode:exited.value.exitCode,signal:exited.value.signal});
  return desktopHandoffOutcome('healthy',{...launchedHandoff,state:'healthy'},
   {reason:'release_desktop_candidate_exit_unknown'});
 }
 startupController.abort();signal?.removeEventListener('abort',forwardAbort);
 if(first.kind==='startup'){
  void exitPromise.then(()=>handoffClaim.release());
  await markDesktopHandoffUnknown(handoffStore,launchedHandoff,'launched');
  return desktopHandoffOutcome('unknown',launchedHandoff,{reason:'release_desktop_startup_timeout'});
 }
 if(first.kind==='launch-error'){
  handoffClaim.release();
  await markDesktopHandoffUnknown(handoffStore,launchedHandoff,'launched');
  return desktopHandoffOutcome('unknown',launchedHandoff,{reason:'release_desktop_candidate_launch_failed'});
 }
 if(first.kind==='startup-error'){
  void exitPromise.then(()=>handoffClaim.release());
  await markDesktopHandoffUnknown(handoffStore,launchedHandoff,'launched');
  return desktopHandoffOutcome('unknown',launchedHandoff,{reason:'release_desktop_startup_receipt_unavailable'});
 }
 const result=first.value,explicitNonzero=Number.isSafeInteger(result.exitCode)&&result.exitCode!==0&&result.signal===null
  &&(!launchBinding||queryVerifiedRuntimeExit(result).exitObserved===true);
 let startup;
 try{startup=normalizeDesktopStartup(await handoffStore.readStartup({operationId:handoff.operationId}),handoff);}
 catch{
  handoffClaim.release();
  await markDesktopHandoffUnknown(handoffStore,launchedHandoff,'launched');
  return desktopHandoffOutcome('unknown',launchedHandoff,{reason:'release_desktop_startup_receipt_unavailable',launch:result});
 }
 if(startup.state==='healthy'){
  let healthy=false;
  try{healthy=await transitionDesktopHandoff(handoffStore,launchedHandoff,'launched','healthy');}catch{}
  handoffClaim.release();
  if(healthy)return desktopHandoffOutcome('healthy',{...launchedHandoff,state:'healthy'},{launch:result,exitCode:result.exitCode,signal:result.signal});
  await markDesktopHandoffUnknown(handoffStore,launchedHandoff,'launched');
  return desktopHandoffOutcome('unknown',launchedHandoff,{reason:'release_desktop_handoff_health_claim_lost',launch:result});
 }
 if(!explicitNonzero||startup.state!=='attempted'){
  handoffClaim.release();
  await markDesktopHandoffUnknown(handoffStore,launchedHandoff,'launched');
  return desktopHandoffOutcome('unknown',launchedHandoff,{reason:'release_desktop_candidate_exit_unproven',launch:result});
 }
 try{
  const currentHandoff=normalizeDesktopHandoff(await handoffStore.readHandoff());
  if(currentHandoff.state!=='launched'||!sameHandoffWithState(currentHandoff,launchedHandoff,'launched'))
   fail('release_desktop_handoff_state_changed');
  const current=readDeploymentState(installRoot);
  if(!current||!matchesDesktopRef(current.active,handoff.candidate)||!matchesDesktopRef(current.previous,handoff.previous))
   fail('release_desktop_handoff_pointer_mismatch');
  assertDesktopRuntimeRef({installRoot,ref:current.active,identity:handoff.candidate});
  const verifiedPrevious=assertDesktopRuntimeRef({installRoot,ref:current.previous,identity:handoff.previous});
  const verifiedPoint=verifyRecoveryPoint({installRoot,backupId:handoff.recovery.backupId,hostBackupScript,privateBackupConfig,userDataRoot});
  if(verifiedPoint.backupId!==handoff.recovery.backupId||verifiedPoint.releaseId!==handoff.recovery.releaseId
   ||verifiedPoint.profile!=='desktop-electron'||verifiedPoint.manifestSha256!==verifiedPrevious.manifestSha256
   ||verifiedPoint.runtimeSha256!==verifiedPrevious.runtimeSha256||canonical(verifiedPoint.target)!==canonical(verifiedPrevious.target)
   ||verifiedPoint.backupVerified!==true)fail('release_desktop_handoff_recovery_mismatch');
  const rollback=await rollbackRelease({installRoot,restoreReleaseId:handoff.previous.releaseId,backupId:handoff.recovery.backupId,
   healthUrl,profile:'desktop-electron',desktopLifecycle,probeRoot:rollbackProbeRoot,hostBackupScript,privateBackupConfig,userDataRoot});
  const restored=readDeploymentState(installRoot);
  if(rollback.rolledBack!==true||!matchesDesktopRef(restored?.active,handoff.previous)||!matchesDesktopRef(restored?.previous,handoff.candidate))
   fail('release_desktop_handoff_rollback_unverified');
  const actualPrevious=assertDesktopRuntimeRef({installRoot,ref:restored.active,identity:handoff.previous});
  assertDesktopRuntimeRef({installRoot,ref:restored.previous,identity:handoff.candidate});
  if(actualPrevious.runtimeSha256!==previous.runtimeSha256||canonical(actualPrevious.target)!==canonical(previous.target))
   fail('release_desktop_handoff_rollback_unverified');
  let recorded=false;
  try{recorded=await transitionDesktopHandoff(handoffStore,launchedHandoff,'launched','rolled-back');}catch{}
  if(!recorded)fail('release_desktop_handoff_rollback_receipt_failed');
  handoffClaim.release();
  return desktopHandoffOutcome('rolled-back',{...launchedHandoff,state:'rolled-back'},
   {launch:result,rollback,activeReleaseId:handoff.previous.releaseId});
 }catch(error){
  handoffClaim.release();
  await markDesktopHandoffUnknown(handoffStore,launchedHandoff,'launched');
  return desktopHandoffOutcome('unknown',launchedHandoff,{reason:error?.message?.startsWith('release_')?error.message:'release_desktop_handoff_rollback_failed',launch:result});
 }
}
function parseOptions(args){
 const values=new Map();
 if(!args.length)fail('release_arguments_invalid');
 const action=args[0];
 for(let i=1;i<args.length;i++){
  const key=args[i];
  if(!key.startsWith('--')||values.has(key))fail('release_arguments_invalid');
  if(key==='--drained'||key==='--demo'){values.set(key,true);continue;}
  const value=args[++i];if(!value||value.startsWith('--'))fail('release_arguments_invalid');values.set(key,value);
 }
 const shared=['--host-backup-script'];
 const desktopPins=['--app-lock-sha','--root-lock-sha','--runtime-receipt','--runtime-receipt-sha'];
 const allowed={
  package:['--source','--tag','--commit','--target'],
  verify:['--package','--sha','--profile',...desktopPins],
  stage:['--package','--sha','--install-root','--profile','--user-data-root',...desktopPins],
  backup:['--install-root','--config','--user-data-root',...shared],
  'verify-backup':['--install-root','--backup','--config','--user-data-root',...shared],
  'restore-backup':['--install-root','--backup','--config','--user-data-root',...shared],
  activate:['--install-root','--release','--sha','--runtime-sha','--backup','--profile','--health-url','--drained'],
  rollback:['--install-root','--release','--backup','--profile','--health-url','--drained'],
  run:['--install-root','--profile','--release','--sha','--runtime-sha','--demo'],
  supervise:['--install-root','--health-url','--rollback-probe-root','--host-backup-script','--config','--user-data-root','--startup-timeout-ms'],
  'supervise-query':['--install-root','--operation']
 };
 if(!allowed[action]||[...values.keys()].some(key=>!allowed[action].includes(key)))fail('release_arguments_invalid');
 return {action,values};
}
function required(values,key){const value=values.get(key);if(typeof value!=='string'||!value)fail('release_arguments_invalid');return value;}
function desktopCliBindings(values,profile){
 const flags=['--app-lock-sha','--root-lock-sha','--runtime-receipt','--runtime-receipt-sha'];
 if(profile!=='desktop-electron'){
  if(flags.some(flag=>values.has(flag)))fail('release_arguments_invalid');
  return {};
 }
 const expectedAppLockSha256=required(values,'--app-lock-sha'),expectedRootLockSha256=required(values,'--root-lock-sha');
 const expectedRuntimeReceiptSha256=required(values,'--runtime-receipt-sha'),receiptPath=resolve(required(values,'--runtime-receipt'));
 if(!shaPattern.test(expectedAppLockSha256)||!shaPattern.test(expectedRootLockSha256)||!shaPattern.test(expectedRuntimeReceiptSha256))
  fail('release_arguments_invalid');
 let info,bytes;
 try{info=lstatSync(receiptPath);if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)fail('release_runtime_receipt_invalid');bytes=readFileSync(receiptPath);}
 catch{fail('release_runtime_receipt_invalid');}
 if(hash(bytes)!==expectedRuntimeReceiptSha256)fail('release_runtime_receipt_digest_mismatch');
 let receipt;try{receipt=JSON.parse(bytes.toString('utf8'));}catch{fail('release_runtime_receipt_invalid');}
 if(!isRecord(receipt)||receipt.protocol!=='jot.desktop.runtime-acceptance.v1'||receipt.runtimeAcceptancePassed!==true
  ||receipt.started!==true||receipt.cleanExit!==true||typeof receipt.electronVersion!=='string'||typeof receipt.nodeVersion!=='string'
  ||typeof receipt.platform!=='string'||typeof receipt.arch!=='string'||typeof receipt.nodeModuleAbi!=='string'
  ||typeof receipt.napiVersion!=='string')fail('release_runtime_receipt_invalid');
 return {expectedAppLockSha256,expectedRootLockSha256,expectedRuntimeReceiptSha256,
  expectedRuntimeTarget:{electronVersion:receipt.electronVersion,nodeVersion:receipt.nodeVersion,platform:receipt.platform,
   arch:receipt.arch,nodeModuleAbi:receipt.nodeModuleAbi,napiVersion:receipt.napiVersion}};
}
function runtimePreflight(root,installRoot,profile,demo,env){
 if(profile==='standalone'&&demo)return;
 const trustedPreflight=join(dirname(fileURLToPath(import.meta.url)),'release-preflight.mjs');
 const args=[trustedPreflight,'--json','--profile',profile,'--stage','runtime','--root',root,'--cwd',resolve(installRoot)];
 const result=spawnSync(process.execPath,args,{cwd:installRoot,env,encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true,maxBuffer:1024*1024});
 if(result.error||result.status!==0)fail('release_runtime_preflight_failed');
 try{const value=JSON.parse(result.stdout);if(value.ready!==true)fail('release_runtime_preflight_failed');}
 catch{fail('release_runtime_preflight_failed');}
}
export async function runRelease({installRoot,profile,releaseId,expectedManifestSha256,expectedRuntimeSha256,expectedTarget,extraArgs=[],demo=false,
 signal,spawnRuntime,restoredStartupNonce,launchBinding}){
 if(!['standalone','gateway','harness','file-worker','desktop-electron'].includes(profile))fail('release_profile_invalid');
 if(demo&&profile!=='standalone')fail('release_demo_role_invalid');
 if(launchBinding!==undefined&&profile!=='desktop-electron')fail('release_desktop_supervisor_unavailable');
 if(restoredStartupNonce!==undefined&&(profile!=='desktop-electron'||!desktopOperationIdPattern.test(restoredStartupNonce)))
  fail('release_desktop_restore_nonce_invalid');
 const state=readDeploymentState(installRoot),ref=releaseId?{releaseId,manifestSha256:expectedManifestSha256,
  runtimeSha256:expectedRuntimeSha256,target:expectedTarget}:state?.active;
 if(!ref)fail('release_deployment_not_active');
 if(!shaPattern.test(ref.manifestSha256??''))fail('release_manifest_digest_mismatch');
 const runtimeProfile=profile==='standalone'?'standalone':profile==='desktop-electron'?'desktop-electron':'gateway';
 const chosen=ref.releaseId;
 const installed=verifyInstalledRelease({installRoot,releaseId:chosen,expectedManifestSha256:ref.manifestSha256,
  expectedRuntimeSha256:ref.runtimeSha256,expectedTarget:ref.target});
 if(!installed.completeRuntimeProof)fail('release_runtime_proof_required');
 if(installed.profile!==runtimeProfile)fail('release_profile_mismatch');
 const root=readReleaseRoot(installRoot,chosen);
 const runtimeEnv=verifiedRuntimeEnvironment({envFile:join(resolve(installRoot),'.env')});
 if(profile!=='desktop-electron')runtimePreflight(root,installRoot,runtimeProfile,demo===true,runtimeEnv);
 const entryRelative=profile==='desktop-electron'?'Jot.exe':profile==='standalone'?'src/server.mjs'
  :profile==='gateway'?'packages/gateway/dist/src/main.js'
  :profile==='harness'?'packages/gateway/dist/src/harness/main.js'
  :'packages/gateway/dist/src/file-engine/main.js';
 const args=[...(demo?['--demo']:[]),...extraArgs];
 const result=await launchVerifiedRuntime({root,cwd:resolve(installRoot),expectedRuntimeSha256:installed.runtimeSha256,
  expectedSourceManifestSha256:installed.manifestSha256,expectedTarget:installed.target,entryRelative,args,env:runtimeEnv,signal,
  ...(restoredStartupNonce!==undefined?{desktopRestoreNonce:restoredStartupNonce}:{}),
  ...(launchBinding!==undefined?{launchBinding}:{}),
  ...(profile==='desktop-electron'?{runtimeKind:'electron'}:{}),...(spawnRuntime?{spawnRuntime}:{})});
 if(launchBinding)return bindVerifiedRuntimeResult(result,{releaseId:installed.releaseId,manifestSha256:installed.manifestSha256});
 return {...result,releaseId:installed.releaseId,manifestSha256:installed.manifestSha256};
}
function assertDesktopSupervisorBindings(bindings){
 const store=bindings?.handoffStore,lifecycle=bindings?.desktopLifecycle;
 if(!isRecord(store)||['readHandoff','transitionHandoff','readStartup','waitForStartup','markRollback','prepareRestoredStartup','readRestoredStartup','waitForRestoredStartup']
  .some(key=>typeof store[key]!=='function')||!isRecord(lifecycle)||typeof lifecycle.drainActive!=='function'||typeof lifecycle.probeRelease!=='function')
  fail('release_desktop_supervisor_unavailable');
 return {handoffStore:store,desktopLifecycle:lifecycle};
}
function samePathValue(left,right){
 try{const a=resolve(left),b=resolve(right);return process.platform==='win32'?a.toLocaleLowerCase('en-US')===b.toLocaleLowerCase('en-US'):a===b;}catch{return false;}
}
function normalizeRestoredStartupRecord(value,handoff,installRoot,installed,allowedStates){
 if(!exactRecordKeys(value,['protocol','operationId','generation','nonce','previous','recovery','state','processContext','probeReceipt'])||value.protocol!==1
  ||value.operationId!==handoff.operationId||canonical(value.recovery)!==canonical(handoff.recovery)
  ||!Number.isSafeInteger(value.generation)||value.generation<1||!desktopOperationIdPattern.test(value.nonce??'')
  ||!allowedStates.includes(value.state)||!exactRecordKeys(value.previous,['releaseId','manifestSha256','profile','runtimeSha256','target'])
  ||value.previous.releaseId!==installed.releaseId||value.previous.manifestSha256!==installed.manifestSha256
  ||value.previous.profile!=='desktop-electron'||value.previous.runtimeSha256!==installed.runtimeSha256
  ||canonical(value.previous.target)!==canonical(installed.target))fail('release_desktop_restore_receipt_invalid');
 const noProcess=value.state==='prepared'||value.state==='unknown'&&value.processContext===null;
 if(noProcess){
  if(value.probeReceipt!==null)fail('release_desktop_restore_receipt_invalid');
 }else{
  const context=value.processContext,expectedRoot=readReleaseRoot(installRoot,installed.releaseId),expectedExecutable=join(expectedRoot,'Jot.exe');
  if(!exactRecordKeys(context,['pid','execPath','releaseRoot'])||!Number.isSafeInteger(context.pid)||context.pid<1
   ||!samePathValue(context.execPath,expectedExecutable)||!samePathValue(context.releaseRoot,expectedRoot))fail('release_desktop_restore_receipt_invalid');
 }
 if(value.state==='healthy'){
  const probe=value.probeReceipt;
  if(!exactRecordKeys(probe,['instanceId','origin','readyAt','releaseId','status','target'])||typeof probe.instanceId!=='string'||!probe.instanceId
   ||probe.releaseId!==installed.releaseId||probe.status!=='ready'||!validUtcTimestamp(probe.readyAt)
   ||canonical(probe.target)!==canonical(installed.target))fail('release_desktop_restore_receipt_invalid');
  let origin;try{origin=new URL(probe.origin);}catch{fail('release_desktop_restore_receipt_invalid');}
  if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)
   fail('release_desktop_restore_receipt_invalid');
 }else if(value.probeReceipt!==null)fail('release_desktop_restore_receipt_invalid');
 return value;
}
function desktopSupervisorUnknown(reason,handoff=null){return {state:'unknown',reason,...(handoff?{operationId:handoff.operationId}: {})};}
async function awaitRestoredStartup({installRoot,handoffStore,handoff,installed,startupTimeoutMs,signal,token}){
 let persisted;
 try{
  persisted=await handoffStore.readRestoredStartup({operationId:handoff.operationId});
  if(!persisted)return desktopSupervisorUnknown('release_desktop_restore_receipt_unavailable',handoff);
  try{persisted=normalizeRestoredStartupRecord(persisted,handoff,installRoot,installed,['prepared','attempted','healthy','unknown']);}
  catch{return desktopSupervisorUnknown('release_desktop_restore_receipt_invalid',handoff);}
  if(persisted.state==='unknown')return desktopSupervisorUnknown('release_desktop_restore_receipt_unknown',handoff);
  if(token&&(persisted.generation!==token.generation||persisted.nonce!==token.nonce))
   return desktopSupervisorUnknown('release_desktop_restore_receipt_changed',handoff);
 }catch{return desktopSupervisorUnknown('release_desktop_restore_receipt_unavailable',handoff);}
 let receipt;
 try{receipt=await handoffStore.waitForRestoredStartup({operationId:handoff.operationId,previous:handoff.previous,
  recovery:handoff.recovery,timeoutMs:startupTimeoutMs,signal});}
 catch{return desktopSupervisorUnknown('release_desktop_restore_receipt_unavailable',handoff);}
 if(receipt===null)return desktopSupervisorUnknown('release_desktop_restore_startup_timeout',handoff);
 try{
  receipt=normalizeRestoredStartupRecord(receipt,handoff,installRoot,installed,['healthy']);
  if(receipt.generation!==persisted.generation||receipt.nonce!==persisted.nonce)fail('release_desktop_restore_receipt_invalid');
  return {state:'restored-healthy',operationId:handoff.operationId,receipt};
 }
 catch{return desktopSupervisorUnknown('release_desktop_restore_receipt_invalid',handoff);}
}
async function launchRestoredDesktop({installRoot,handoffStore,handoff,startupTimeoutMs,signal,spawnRuntime,runReleaseCommand,launchBinding}){
 let deployment,installed,prepared,token;
 try{
  deployment=readDeploymentState(installRoot);
  if(!matchesDesktopRef(deployment?.active,handoff.previous)||!matchesDesktopRef(deployment?.previous,handoff.candidate))
   fail('release_desktop_handoff_pointer_mismatch');
  installed=assertDesktopRuntimeRef({installRoot,ref:deployment.active,identity:handoff.previous});
  const before={protocol:deployment.protocol,active:deployment.previous,previous:deployment.active};
  const marked=await handoffStore.markRollback({operationId:handoff.operationId,before,after:deployment,backupDigest:handoff.recovery.backupId});
  if(marked?.enabled!==true||marked.state?.operation?.id!==handoff.operationId||marked.state.operation.startupStatus!=='rolled-back'
   ||canonical(marked.state.operation.rollbackTarget)!==canonical(deployment.active))fail('release_desktop_restore_rollback_unrecorded');
  prepared=await handoffStore.prepareRestoredStartup({operationId:handoff.operationId,previous:deployment.active,recovery:handoff.recovery});
  if(!exactRecordKeys(prepared,['launchAllowed','receipt'])||typeof prepared.launchAllowed!=='boolean')fail('release_desktop_restore_claim_invalid');
  token=normalizeRestoredStartupRecord(prepared.receipt,handoff,installRoot,installed,['prepared']);
 }catch{return desktopSupervisorUnknown('release_desktop_restore_claim_unavailable',handoff);}
 if(!prepared.launchAllowed)return await awaitRestoredStartup({installRoot,handoffStore,handoff,installed,startupTimeoutMs,signal,token});
 const launchPromise=Promise.resolve().then(()=>runReleaseCommand({installRoot,profile:'desktop-electron',releaseId:installed.releaseId,
  expectedManifestSha256:installed.manifestSha256,expectedRuntimeSha256:installed.runtimeSha256,expectedTarget:installed.target,
  restoredStartupNonce:token.nonce,
  ...(launchBinding?{launchBinding}:{}),
  ...(spawnRuntime?{spawnRuntime}:{})})).then(value=>({kind:'exit',value}),error=>({kind:'error',error}));
 const startupPromise=awaitRestoredStartup({installRoot,handoffStore,handoff,installed,startupTimeoutMs,signal,token})
  .then(value=>({kind:'startup',value}),()=>({kind:'startup',value:desktopSupervisorUnknown('release_desktop_restore_receipt_unavailable',handoff)}));
 const first=await Promise.race([launchPromise,startupPromise]);
 if(first.kind==='startup'){
  if(first.value.state!=='restored-healthy')return first.value;
  const launch=await launchPromise;
  if(launch.kind==='error')return desktopSupervisorUnknown('release_desktop_restore_launch_failed',handoff);
  return {...first.value,launch:launch.value};
 }
 if(first.kind==='error'){
  void startupPromise;
  return desktopSupervisorUnknown('release_desktop_restore_launch_failed',handoff);
 }
 const startup=await startupPromise;
 return startup.value.state==='restored-healthy'?{...startup.value,launch:first.value}:startup.value;
}
export async function superviseDesktopLaunch({installRoot,healthUrl,rollbackProbeRoot,hostBackupScript,privateBackupConfig,userDataRoot,
 startupTimeoutMs=30000,signal,bindings,runReleaseCommand=runRelease,spawnRuntime}={}){
 if(typeof installRoot!=='string'||!isAbsolute(installRoot)||!Number.isSafeInteger(startupTimeoutMs)||startupTimeoutMs<1||startupTimeoutMs>10*60*1000)
  fail('release_desktop_supervisor_arguments_invalid');
 const {handoffStore,desktopLifecycle}=assertDesktopSupervisorBindings(bindings);
 const launchBinding=bindings.launchBinding;
 let existing=null;
 try{const raw=await handoffStore.readHandoff();if(raw!==null)existing=normalizeDesktopHandoff(raw);}
 catch{return desktopSupervisorUnknown('release_desktop_handoff_unavailable');}
 if(existing?.state==='unknown')return desktopSupervisorUnknown('release_desktop_handoff_unknown',existing);
 if(existing?.state==='rolled-back'){
  let deployment,installed;
  try{
   deployment=readDeploymentState(installRoot);
   if(!matchesDesktopRef(deployment?.active,existing.previous)||!matchesDesktopRef(deployment?.previous,existing.candidate))
    fail('release_desktop_handoff_pointer_mismatch');
   installed=assertDesktopRuntimeRef({installRoot,ref:deployment.active,identity:existing.previous});
  }catch{return desktopSupervisorUnknown('release_desktop_restore_target_invalid',existing);}
  return await awaitRestoredStartup({installRoot,handoffStore,handoff:existing,installed,startupTimeoutMs,signal});
 }
 if(existing&&(existing.state==='requested'||existing.state==='launched')){
  try{return await continueDesktopLaunchHandoff({installRoot,previousLaunch:null,handoffStore,healthUrl,rollbackProbeRoot,desktopLifecycle,
   hostBackupScript,privateBackupConfig,userDataRoot,startupTimeoutMs,signal,spawnRuntime,launchBinding});}
  catch{return desktopSupervisorUnknown('release_desktop_handoff_unavailable',existing);}
 }
 if(existing&&existing.state!=='healthy')return desktopSupervisorUnknown('release_desktop_handoff_invalid',existing);
 validateHealthUrl('desktop-electron',healthUrl);
 validateDesktopProbeRoot(rollbackProbeRoot,resolve(installRoot),userDataRoot);
 const launch=await runReleaseCommand({installRoot,profile:'desktop-electron',...(launchBinding?{launchBinding}:{}),...(spawnRuntime?{spawnRuntime}:{})});
 if(launch?.exitCode!==75||launch?.signal!==null)return {state:'normal',launch};
 let handoffResult;
 try{handoffResult=await continueDesktopLaunchHandoff({installRoot,previousLaunch:launch,handoffStore,healthUrl,rollbackProbeRoot,
  desktopLifecycle,hostBackupScript,privateBackupConfig,userDataRoot,startupTimeoutMs,signal,spawnRuntime,launchBinding});}
 catch{return desktopSupervisorUnknown('release_desktop_handoff_unavailable');}
 if(handoffResult.state==='rolled-back'){
  const handoff={protocol:1,operationId:handoffResult.operationId,profile:'desktop-electron',candidate:handoffResult.candidate,
   previous:handoffResult.previous,recovery:handoffResult.recovery,state:'rolled-back'};
  return await launchRestoredDesktop({installRoot,handoffStore,handoff,startupTimeoutMs,signal,spawnRuntime,runReleaseCommand,launchBinding});
 }
 return handoffResult;
}
async function loadDesktopSupervisorBindings(options){
 const modulePath=resolve(dirname(fileURLToPath(import.meta.url)),'..','apps','desktop','launcher-supervisor.mjs');
 let info;try{info=lstatSync(modulePath);}catch{fail('release_desktop_supervisor_unavailable');}
 if(!info.isFile()||info.isSymbolicLink())fail('release_desktop_supervisor_unavailable');
 let loaded;try{loaded=await import(pathToFileURL(modulePath).href);}catch{fail('release_desktop_supervisor_unavailable');}
 if(typeof loaded.createDesktopLauncherSupervisorBindings!=='function')fail('release_desktop_supervisor_unavailable');
 let bindings;try{bindings=await loaded.createDesktopLauncherSupervisorBindings(options);}catch{fail('release_desktop_supervisor_unavailable');}
 // Only the fixed product factory may supply the real parent-side authority/session binding.
 // A legacy/test lifecycle callback pair alone cannot enable the normal production path.
 if(!isRecord(bindings)||typeof bindings.launchBinding?.attachVerifiedChild!=='function')fail('release_desktop_supervisor_unavailable');
 return bindings;
}
export async function queryDesktopSupervisor({installRoot,operationId,handoffStore}={}){
 if(typeof installRoot!=='string'||!isAbsolute(installRoot)||!desktopOperationIdPattern.test(operationId??''))fail('release_arguments_invalid');
 const held=reason=>({state:'held',reason,operationId,liveAuthority:false,childExitObserved:false});
 if(typeof handoffStore?.readHandoff!=='function'||typeof handoffStore?.readRestoredStartup!=='function')return held('release_desktop_handoff_unavailable');
 try{
  const raw=await handoffStore.readHandoff(),handoff=raw===null?null:normalizeDesktopHandoff(raw);
  if(handoff&&handoff.operationId!==operationId)return held('release_desktop_operation_mismatch');
  const supervisorDrain=typeof handoffStore.readSupervisorDrain==='function'?await handoffStore.readSupervisorDrain({operationId}):null;
  if(supervisorDrain!==null&&(!exactRecordKeys(supervisorDrain,['protocol','scope','requestId','state','receipt'])||supervisorDrain.protocol!==1
   ||supervisorDrain.scope?.operationId!==operationId||!desktopOperationIdPattern.test(supervisorDrain.requestId??'')
   ||!['dispatched','unknown','stopped'].includes(supervisorDrain.state)))return held('release_desktop_handoff_unavailable');
  if(!handoff&&!supervisorDrain)return held('release_desktop_handoff_unavailable');
  let receipt=null;
  if(handoff?.state==='rolled-back'){
   const deployment=readDeploymentState(installRoot);
   if(!matchesDesktopRef(deployment?.active,handoff.previous)||!matchesDesktopRef(deployment?.previous,handoff.candidate))return held('release_desktop_restore_target_invalid');
   const installed=assertDesktopRuntimeRef({installRoot,ref:deployment.active,identity:handoff.previous});
   const stored=await handoffStore.readRestoredStartup({operationId});
   if(stored!==null)receipt=normalizeRestoredStartupRecord(stored,handoff,installRoot,installed,['prepared','attempted','healthy','unknown']);
  }
  return {...held('release_desktop_no_inherited_session'),handoff,restoredStartup:receipt,supervisorDrain,
   supervisorDrainQueryAvailable:typeof handoffStore.readSupervisorDrain==='function'};
 }catch{return held('release_desktop_handoff_unavailable');}
}
async function loadDesktopQueryStore(installRoot){
 // Read-only capability selection: no owner resolution, session construction, mutation or reconnect.
 const modulePath=resolve(dirname(fileURLToPath(import.meta.url)),'..','packages','desktop','src','update-state.mjs');
 try{const info=lstatSync(modulePath);if(!info.isFile()||info.isSymbolicLink())return null;
  const loaded=await import(pathToFileURL(modulePath).href);
  const store=loaded.createDesktopLauncherHandoffStore({installRoot});
  let readSupervisorDrain;
  if(typeof loaded.createUpdateStateStore==='function'){
   const journal=loaded.createUpdateStateStore({statePath:join(resolve(installRoot),'.jot-state','update-state.json'),profile:'desktop-electron'});
   if(typeof journal.read==='function'&&typeof journal.readSupervisorDrain==='function'){
    const contract=await import(pathToFileURL(join(dirname(modulePath),'host-supervisor-contract.mjs')).href);
    if(typeof contract.normalizeSupervisorDrain==='function')readSupervisorDrain=async({operationId})=>{
     const loadedState=await journal.read(),operation=loadedState.state?.operation;
     if(!loadedState.enabled||operation?.id!==operationId)fail('release_desktop_operation_mismatch');
     const original=operation.supervisorDrain;if(!original)return null;
     // Scope/request come only from the original durable operation; they grant no live authority.
     return contract.normalizeSupervisorDrain(await journal.readSupervisorDrain({scope:original.scope,requestId:original.requestId}));
    };
   }
  }
  return {readHandoff:store.readHandoff,readRestoredStartup:store.readRestoredStartup,...(readSupervisorDrain?{readSupervisorDrain}:{})};
 }catch{return null;}
}
async function cli(args,runtimeBindings={}){
 const {action,values}=parseOptions(args);
 if(action==='supervise-query'){
  const installRoot=required(values,'--install-root'),operationId=required(values,'--operation');
  return await queryDesktopSupervisor({installRoot,operationId,handoffStore:await loadDesktopQueryStore(installRoot)});
 }
 if(action==='package')return await createReleasePackage({sourceRoot:required(values,'--source'),tag:required(values,'--tag'),expectedCommit:required(values,'--commit'),target:required(values,'--target')});
 if(action==='verify'){
  const profile=values.get('--profile')??'standalone';
  const value=verifyReleasePackage({packageRoot:required(values,'--package'),expectedManifestSha256:required(values,'--sha'),profile,
   ...desktopCliBindings(values,profile)});
  if(profile==='desktop-electron')return {manifestSha256:value.manifestSha256,sourceTag:value.sourceTag,sourceCommit:value.sourceCommit,
   profile:value.profile,target:value.target,runtimeReceiptSha256:value.runtimeReceiptSha256,appLockSha256:value.appLockSha256,
   sourceReceipt:desktopSourceReceipt(value.manifest),dependencyClosureProven:false,fileCount:value.fileCount};
  return {manifestSha256:value.manifestSha256,sourceTag:value.sourceTag,sourceCommit:value.sourceCommit,license:value.license,fileCount:value.fileCount};
 }
 if(action==='stage'){
  const profile=values.get('--profile')??'standalone';
  return await stageRelease({packageRoot:required(values,'--package'),expectedManifestSha256:required(values,'--sha'),
   installRoot:required(values,'--install-root'),profile,...desktopCliBindings(values,profile),
   ...(profile==='desktop-electron'?{userDataRoot:required(values,'--user-data-root')}:{})});
 }
 if(action==='backup'){
  const installRoot=required(values,'--install-root'),state=readDeploymentState(installRoot);
  if(!state)fail('release_deployment_not_active');
  return await createRecoveryPoint({installRoot,releaseId:state.active.releaseId,privateBackupConfig:required(values,'--config'),
   userDataRoot:values.get('--user-data-root'),hostBackupScript:values.get('--host-backup-script')});
 }
 if(action==='verify-backup')return verifyRecoveryPoint({installRoot:required(values,'--install-root'),backupId:required(values,'--backup'),
  privateBackupConfig:values.get('--config'),userDataRoot:values.get('--user-data-root'),hostBackupScript:values.get('--host-backup-script')});
 if(action==='restore-backup')return await restoreRecoveryPoint({installRoot:required(values,'--install-root'),backupId:required(values,'--backup'),
  privateBackupConfig:required(values,'--config'),userDataRoot:values.get('--user-data-root'),hostBackupScript:values.get('--host-backup-script')});
 if(action==='activate')return await activateRelease({installRoot:required(values,'--install-root'),releaseId:required(values,'--release'),expectedManifestSha256:required(values,'--sha'),
  expectedRuntimeSha256:required(values,'--runtime-sha'),
  backupId:values.get('--backup'),drained:values.get('--drained')===true,healthUrl:required(values,'--health-url'),profile:required(values,'--profile')});
 if(action==='rollback')return await rollbackRelease({installRoot:required(values,'--install-root'),restoreReleaseId:required(values,'--release'),backupId:required(values,'--backup'),
  drained:values.get('--drained')===true,healthUrl:required(values,'--health-url'),profile:required(values,'--profile')});
 if(action==='run')return await runRelease({installRoot:required(values,'--install-root'),profile:required(values,'--profile'),
  releaseId:values.get('--release'),expectedManifestSha256:values.get('--sha'),expectedRuntimeSha256:values.get('--runtime-sha'),demo:values.get('--demo')===true});
 if(action==='supervise'){
  const options={installRoot:required(values,'--install-root'),healthUrl:required(values,'--health-url'),
   rollbackProbeRoot:required(values,'--rollback-probe-root'),hostBackupScript:required(values,'--host-backup-script'),
   privateBackupConfig:required(values,'--config'),userDataRoot:required(values,'--user-data-root'),
   startupTimeoutMs:values.has('--startup-timeout-ms')?Number(required(values,'--startup-timeout-ms')):30000};
  const factory=runtimeBindings.desktopSupervisorBindingsFactory??loadDesktopSupervisorBindings;
  const bindings=await factory(options);
  return await superviseDesktopLaunch({...options,bindings,runReleaseCommand:runtimeBindings.runReleaseCommand??runRelease,
   spawnRuntime:runtimeBindings.spawnRuntime});
 }
 fail('release_arguments_invalid');
}
export async function main(args=process.argv.slice(2),runtimeBindings={}){
 try{const result=await cli(args,runtimeBindings);process.stdout.write(JSON.stringify(result)+'\n');return 0;}
 catch(error){const code=typeof error?.message==='string'&&error.message.startsWith('release_')?error.message:'release_operation_failed';
  process.stdout.write(JSON.stringify({error:code})+'\n');return code==='release_arguments_invalid'?2:1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await main();
