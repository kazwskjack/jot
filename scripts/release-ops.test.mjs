import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {chmodSync,existsSync,lstatSync,mkdtempSync,mkdirSync,readdirSync,readFileSync,renameSync,rmSync,utimesSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {
  createReleasePackage,
  verifyReleasePackage,
  stageRelease,
  readDeploymentState,
  activateRelease,
  rollbackRelease,
  createRecoveryPoint,
  verifyRecoveryPoint,
  restoreRecoveryPoint
} from './release-ops.mjs';
import * as releaseOperations from './release-ops.mjs';

const workspace=resolve(fileURLToPath(new URL('..',import.meta.url)));
const fixtures=join(workspace,'.test-tmp');
mkdirSync(fixtures,{recursive:true});
const hostBackupScript=join(workspace,'packages/gateway/src/maintenance/host-backup-main.ts');
const packageManifestName='release-manifest.json',runtimeManifestName='release-runtime.json';
const h=(value)=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']'
 :value&&typeof value==='object'?'{' +Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}'
 :JSON.stringify(value);

function git(cwd,...args){
 return execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
}
function fixtureRoot(t){
 const root=mkdtempSync(join(fixtures,'release-ops-'));
 t.after(()=>{makeWritable(root);rmSync(root,{recursive:true,force:true});});
 const repo=join(root,'repo');mkdirSync(repo);
 gitInit(repo);
 const files={
  '.gitignore':'.env\nnode_modules/\ndist/\n',
  'LICENSE':'Apache License\n',
  'NOTICE':'Jot notices\n',
  'THIRD_PARTY_NOTICES.md':'Existing third-party notices\n',
  'package.json':JSON.stringify({name:'jot-fixture',version:'0.1.0',license:'Apache-2.0',engines:{node:'>=24'},dependencies:{fastify:'5.12.5'},devDependencies:{'fixture-build-tool':'1.0.0'},scripts:{build:'vite build'}},null,2),
  'package-lock.json':JSON.stringify({name:'jot-fixture',version:'0.1.0',lockfileVersion:3,packages:{
   '':{name:'jot-fixture',version:'0.1.0',license:'Apache-2.0',engines:{node:'>=24'},dependencies:{fastify:'5.12.5'},devDependencies:{'fixture-build-tool':'1.0.0'}},
   'node_modules/fastify':{version:'5.12.5',resolved:'https://registry.npmjs.org/fastify/-/fastify-5.12.5.tgz',integrity:'sha512-Zml4dHVyZS1wcm9kdWN0aW9u'},
   'node_modules/fixture-build-tool':{version:'1.0.0',resolved:'https://registry.npmjs.org/fixture-build-tool/-/fixture-build-tool-1.0.0.tgz',integrity:'sha512-Zml4dHVyZS1kZXY=',dev:true}
  }},null,2),
  'src/server.mjs':'export const sourceVersion = "one";\n',
  'web/index.html':'<html>fixture</html>\n',
  'packages/gateway/package.json':JSON.stringify({name:'@jot/gateway-fixture',version:'0.1.0',license:'Apache-2.0',engines:{node:'>=22'},dependencies:{fastify:'5.12.5'},devDependencies:{'fixture-gateway-build-tool':'1.0.0'}},null,2),
  'packages/gateway/package-lock.json':JSON.stringify({name:'@jot/gateway-fixture',version:'0.1.0',lockfileVersion:3,packages:{
   '':{name:'@jot/gateway-fixture',version:'0.1.0',license:'Apache-2.0',engines:{node:'>=22'},dependencies:{fastify:'5.12.5'},devDependencies:{'fixture-gateway-build-tool':'1.0.0'}},
   'node_modules/fastify':{version:'5.12.5',resolved:'https://registry.npmjs.org/fastify/-/fastify-5.12.5.tgz',integrity:'sha512-Zml4dHVyZS1wcm9kdWN0aW9u'},
   'node_modules/fixture-gateway-build-tool':{version:'1.0.0',resolved:'https://registry.npmjs.org/fixture-gateway-build-tool/-/fixture-gateway-build-tool-1.0.0.tgz',integrity:'sha512-Zml4dHVyZS1kZXY=',dev:true}
  }},null,2),
  'packages/gateway/src/main.ts':'export const gateway = true;\n',
  'packages/gateway/src/harness/main.ts':'export const worker = true;\n',
  'packages/gateway/src/db/schema.sql':'CREATE TABLE stable_fixture (id TEXT PRIMARY KEY);\n',
  'packages/gateway/contracts/openapi.json':'{}\n'
 };
 for(const [path,value]of Object.entries(files)){const target=join(repo,path);mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,value);}
 writeFileSync(join(repo,'.env'),'SECRET=fixture-secret\n');
 git(repo,'add','.');
 git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--no-gpg-sign','-m','fixture one');
 const firstCommit=git(repo,'rev-parse','HEAD');
 git(repo,'tag','v1.0.0');
 return {root,repo,firstCommit};
}
function makeWritable(path){
 if(!existsSync(path))return;
 const info=lstatSync(path);
 if(info.isSymbolicLink())return;
 if(info.isDirectory()){for(const entry of readdirSync(path))makeWritable(join(path,entry));chmodSync(path,0o700);}
 else if(info.isFile())chmodSync(path,(info.mode&0o111)?0o700:0o600);
}
function stageLockExpired(path){
 try{return Date.now()-lstatSync(path).mtimeMs>=120_000;}
 catch(error){if(error?.code==='ENOENT')return true;throw error;}
}
function sealReadOnly(path){
 if(!existsSync(path))return;
 const info=lstatSync(path);if(info.isSymbolicLink())return;
 if(info.isDirectory()){for(const entry of readdirSync(path))sealReadOnly(join(path,entry));chmodSync(path,0o555);}
 else if(info.isFile())chmodSync(path,0o444);
}
function legacyRuntimeManifest(releaseRoot,profile){
 const files=[];
 const visit=(folder,prefix='')=>{
  for(const entry of readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
   const path=prefix?prefix+'/'+entry.name:entry.name;
   if(path===packageManifestName||path===runtimeManifestName||path.split('/').includes('node_modules'))continue;
   const absolute=join(folder,entry.name);
   if(entry.isDirectory())visit(absolute,path);
   else if(entry.isFile()){const bytes=readFileSync(absolute);files.push({path,bytes:bytes.length,sha256:h(bytes)});}
  }
 };
 visit(releaseRoot);
 files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
 return {protocol:1,profile,files,sha256:h(canonical(files))};
}
function rewriteAsLegacyRuntime(releaseRoot,profile){
 makeWritable(releaseRoot);
 const manifest=legacyRuntimeManifest(releaseRoot,profile);
 writeFileSync(join(releaseRoot,'release-runtime.json'),canonical(manifest)+'\n');
 sealReadOnly(releaseRoot);
 return manifest;
}
function gitInit(repo){
 execFileSync('git',['init','--quiet',repo],{stdio:'ignore'});
 git(repo,'config','user.name','Fixture');
 git(repo,'config','user.email','fixture@example.invalid');
}
async function packageAt(repo,root,tag,commit,name){
 const target=join(root,name);
 const receipt=await createReleasePackage({sourceRoot:repo,tag,expectedCommit:commit,target});
 return {target,...receipt};
}
function desktopPortableFixture(root,{sourceCommit='a'.repeat(40),sourceTreeSha256='b'.repeat(64),runtimeReceiptSha256='3'.repeat(64)}={}){
 const target=join(root,'desktop-portable');mkdirSync(target,{recursive:true});
 const payload={
  'Jot.exe':'synthetic Electron executable',
  'LICENSE':'Electron license fixture',
  'LICENSES.chromium.html':'Chromium notices fixture',
  'JOT-LICENSE.txt':'Jot license fixture',
  'THIRD_PARTY_NOTICES.txt':'Third-party notices fixture',
  'resources/app/package.json':JSON.stringify({name:'jot-desktop-fixture',version:'0.1.0',type:'module',main:'apps/desktop/main-entry.mjs',dependencies:{fastify:'5.12.5'}}),
  'resources/app/apps/desktop/main-entry.mjs':'export const desktopEntry = true;\n',
  'resources/app/apps/desktop/preload.cjs':'module.exports = {};\n',
  'resources/app/src/server.mjs':'export const serverEntry = true;\n',
  'resources/app/src/store.mjs':'export const storeProtocol = 1;\n',
  'resources/app/dist/workbench.html':'<!doctype html><title>Jot</title>\n',
  'resources/app/node_modules/fastify/package.json':JSON.stringify({name:'fastify',version:'5.12.5',license:'MIT'}),
  'resources/app/node_modules/fastify/index.js':'export default {};\n',
  'resources/app/node_modules/fastify/LICENSE':'MIT fixture license\n'
 };
 for(const [path,content]of Object.entries(payload)){const file=join(target,...path.split('/'));mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,content);}
 const entries=Object.entries(payload).map(([path,content])=>({path:'Jot-Desktop/'+path,size:Buffer.byteLength(content),sha256:h(content)}));
 entries.sort((a,b)=>a.path.localeCompare(b.path,'en'));
 const runtimeFiles=['Jot.exe','LICENSE','LICENSES.chromium.html'].map(path=>{
  const item=entries.find(file=>file.path==='Jot-Desktop/'+path);return {path,size:item.size,sha256:item.sha256};
 });
 const appLockSha256='4'.repeat(64),rootLockSha256='1'.repeat(64);
 const manifest={
  protocol:'jot.desktop.portable.v1',status:'candidate',appVersion:'0.1.0',sourceCommit,sourceTreeSha256,
  target:{platform:'win32',arch:'x64'},packageRoot:'Jot-Desktop/',entry:{manifest:'resources/app/package.json',main:'apps/desktop/main-entry.mjs'},
  userData:{insidePackage:false,root:'%APPDATA%/Jot',preserves:['jot.db','files/','desktop-notifications.json']},
  releaseOpsV2Profile:'not-verified',installOrActivationPerformed:false,
  electron:{version:'45.0.0',platform:'win32',arch:'x64',archiveSha256:'2'.repeat(64),executableSha256:runtimeFiles[0].sha256,
   inventorySha256:h(JSON.stringify(runtimeFiles)),runtimeFiles,nodeVersion:'24.22.0',nodeModuleAbi:'150',napiVersion:'10'},
  appLockSha256,rootLockSha256,runtimeReceiptSha256,
  build:{nodeVersion:'24.13.0',npmVersion:'11.6.2',viteVersion:'8.3.2',rootLockSha256},files:entries
 };
 const raw=JSON.stringify(manifest,null,2)+'\n',manifestSha256=h(raw);
 writeFileSync(join(target,'portable-package-manifest.json'),raw);
 writeFileSync(join(target,'portable-package-manifest.sha256'),manifestSha256+'  portable-package-manifest.json\n');
 return {target,manifestSha256,manifest};
}
async function fakeBuild({command,args,cwd}){
 if(command!=='npm'&&command!=='npm.cmd')throw new Error('unexpected_command');
 if(args[0]==='--version')return {code:0,stdout:'10.9.2\n'};
 if(args[0]==='ci'){
  const lock=JSON.parse(readFileSync(join(cwd,'package-lock.json'),'utf8'));
  for(const [lockedPath,entry]of Object.entries(lock.packages??{})){
   if(!lockedPath.startsWith('node_modules/'))continue;
   const packagePath=join(cwd,...lockedPath.split('/'));
   mkdirSync(packagePath,{recursive:true});
   const name=lockedPath.slice('node_modules/'.length),license=name==='fastify'?'MIT':'Apache-2.0';
   writeFileSync(join(packagePath,'package.json'),JSON.stringify({name,version:entry.version,license}));
   writeFileSync(join(packagePath,'index.js'),'export default {};\n');
   writeFileSync(join(packagePath,'LICENSE'),`${license} fixture license\n`);
  }
 }
 if(args[0]==='prune'&&args[1]==='--omit=dev'){
  const lock=JSON.parse(readFileSync(join(cwd,'package-lock.json'),'utf8'));
  for(const [lockedPath,entry]of Object.entries(lock.packages??{}))if(lockedPath.startsWith('node_modules/')&&(entry.dev===true||entry.devOptional===true))
   rmSync(join(cwd,...lockedPath.split('/')),{recursive:true,force:true});
 }
 if(args[0]==='run'&&args[1]==='build'){
  if(cwd.endsWith(join('packages','gateway'))){
   for(const path of ['dist/src/main.js','dist/src/harness/main.js','dist/src/file-engine/main.js','dist/src/db/schema.sql','dist/contracts/openapi.json']){
    const target=join(cwd,path);mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,'gateway build');
   }
  }else{mkdirSync(join(cwd,'dist'),{recursive:true});writeFileSync(join(cwd,'dist/index.html'),'root build');}
 }
}
async function stageAt(pkg,installRoot,runCommand=fakeBuild){
 return stageRelease({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,runCommand});
}
function releaseCli(args,{env={}}={}){
 const script=join(workspace,'scripts','release-ops.mjs');
 const stdout=execFileSync(process.execPath,[script,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,...env}});
 return JSON.parse(stdout);
}
async function captureReleaseMain(args,bindings){
 const chunks=[],write=process.stdout.write;
 process.stdout.write=function(chunk){chunks.push(String(chunk));return true;};
 try{return {code:await releaseOperations.main(args,bindings),value:JSON.parse(chunks.join(''))};}
 finally{process.stdout.write=write;}
}
function launchFakeHealthServer(profile='standalone'){
 const server=createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  if(profile==='gateway')res.end(JSON.stringify({ok:true,service:'jot-general-agent-bff'}));
  else res.end(JSON.stringify({mode:'demo',conversation_modes:{work:{supported:true},chat:{ready:false}},tools:[]}));
 });
 return new Promise((resolveServer,reject)=>{
  server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>resolveServer({server,url:`http://127.0.0.1:${server.address().port}${profile==='gateway'?'/healthz':'/api/capabilities'}`}));
 });
}
function backupFixture(root){
 const data=join(root,'synthetic-host');
 const roots=[
  {kind:'database',path:join(data,'database')},
  {kind:'workspaces',path:join(data,'workspaces')},
  {kind:'artifacts',path:join(data,'artifacts')},
  {kind:'sessions',path:join(data,'sessions')},
  {kind:'host-config',path:join(data,'host-config')},
  {kind:'notification-archives',path:join(data,'notification-archives')}
 ];
 for(const item of roots)mkdirSync(item.path,{recursive:true});
 const database=join(roots[0].path,'product.sqlite');
 const db=new DatabaseSync(database);
 db.exec('CREATE TABLE state(value TEXT NOT NULL); INSERT INTO state VALUES(\'outcome_unknown\');');
 db.close();
 const privateBackupConfig=join(root,'private-host-backup.json');
 writeFileSync(privateBackupConfig,JSON.stringify({offline:true,database,roots}));
 return {roots,database,privateBackupConfig};
}
function desktopDataFixture(root,userDataRoot){
 const files=join(userDataRoot,'files'),workspaces=join(userDataRoot,'workspaces'),sessions=join(userDataRoot,'sessions'),hostConfig=join(userDataRoot,'host-config');
 for(const path of [userDataRoot,files,workspaces,sessions,hostConfig])mkdirSync(path,{recursive:true});
 const database=join(userDataRoot,'jot.db'),db=new DatabaseSync(database);
 db.exec('CREATE TABLE state(value TEXT NOT NULL); INSERT INTO state VALUES(\'before_update\');');db.close();
 const attachment=join(files,'attachment.bin');writeFileSync(attachment,Buffer.from('user-data attachment canary'));
 const notifications=join(userDataRoot,'desktop-notifications.json');writeFileSync(notifications,JSON.stringify({delivered:['before_update']}));
 const parent=dirname(userDataRoot),entry=relative(parent,notifications).split('\\').join('/');
 const roots=[
  {kind:'database',path:userDataRoot,entries:['jot.db']},
  {kind:'workspaces',path:workspaces},
  {kind:'artifacts',path:files},
  {kind:'sessions',path:sessions},
  {kind:'host-config',path:hostConfig},
  {kind:'notification-archives',path:parent,entries:[entry]}
 ];
 const privateBackupConfig=join(root,'desktop-private-host-backup.json');
 writeFileSync(privateBackupConfig,JSON.stringify({offline:true,database,roots}));
 return {database,attachment,notifications,privateBackupConfig};
}
async function desktopHandoffFixture(t){
 const f=fixtureRoot(t),userDataRoot=join(f.root,'synthetic-profile','AppData','Roaming','Jot'),installRoot=join(f.root,'desktop-install');
 const previousPackage=desktopPortableFixture(f.root),candidatePackage=desktopPortableFixture(join(f.root,'candidate'),
  {sourceCommit:'b'.repeat(40),sourceTreeSha256:'c'.repeat(64)});
 const stageArgs=pkg=>({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,userDataRoot,profile:'desktop-electron',
  expectedAppLockSha256:'4'.repeat(64),expectedRootLockSha256:'1'.repeat(64),expectedRuntimeReceiptSha256:'3'.repeat(64),
  expectedRuntimeTarget:{electronVersion:'45.0.0',nodeVersion:'24.22.0',platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'}});
 const previous=await stageRelease(stageArgs(previousPackage)),candidate=await stageRelease(stageArgs(candidatePackage));
 const lifecycleEvents=[],lifecycle={async drainActive(input){lifecycleEvents.push('drain:'+input.releaseId);return {releaseId:input.releaseId,instanceId:'active-instance',lifecyclePhase:'stopped',
   backendClosedAt:new Date().toISOString()};},async probeRelease(input){lifecycleEvents.push('probe:'+input.releaseId);
   return {releaseId:input.releaseId,instanceId:'probe-'+input.releaseId.slice(0,8),target:input.expectedTarget,
    origin:'http://127.0.0.1:43127',status:'ready',readyAt:new Date().toISOString()};}};
 await activateRelease({installRoot,releaseId:previous.releaseId,expectedManifestSha256:previousPackage.manifestSha256,
  expectedRuntimeSha256:previous.runtimeSha256,profile:'desktop-electron',healthUrl:'http://127.0.0.1:43127/api/capabilities',
  desktopLifecycle:lifecycle,probeRoot:join(f.root,'probe-first'),userDataRoot});
 const data=desktopDataFixture(f.root,userDataRoot),backup=await createRecoveryPoint({installRoot,releaseId:previous.releaseId,
  privateBackupConfig:data.privateBackupConfig,userDataRoot,hostBackupScript});
 await activateRelease({installRoot,releaseId:candidate.releaseId,expectedManifestSha256:candidatePackage.manifestSha256,
  expectedRuntimeSha256:candidate.runtimeSha256,profile:'desktop-electron',backupId:backup.backupId,
  privateBackupConfig:data.privateBackupConfig,userDataRoot,hostBackupScript,healthUrl:'http://127.0.0.1:43127/api/capabilities',
  desktopLifecycle:lifecycle,probeRoot:join(f.root,'probe-update')});
 const operationId='11111111-1111-4111-8111-111111111111';
 const handoff={protocol:1,operationId,profile:'desktop-electron',candidate:{releaseId:candidate.releaseId,manifestSha256:candidatePackage.manifestSha256},
  previous:{releaseId:previous.releaseId,manifestSha256:previousPackage.manifestSha256},
  recovery:{backupId:backup.backupId,releaseId:previous.releaseId},state:'requested'};
 const startup={protocol:1,operationId,candidate:{...handoff.candidate},recovery:{...handoff.recovery},state:'pending'};
 const transitions=[],waitControl={mode:'auto'};
 const store={async readHandoff(){return structuredClone(handoff);},async transitionHandoff({operationId:id,from,to}){
   assert.equal(id,operationId);assert.equal(handoff.state,from);transitions.push([from,to]);handoff.state=to;
   return {operation:{id:operationId,handoff:structuredClone(handoff)}};},
  async readStartup({operationId:id}){assert.equal(id,operationId);return structuredClone(startup);},
  async waitForStartup({operationId:id,candidate:expectedCandidate,recovery:expectedRecovery}){
   assert.equal(id,operationId);assert.deepEqual(expectedCandidate,handoff.candidate);assert.deepEqual(expectedRecovery,handoff.recovery);
   if(waitControl.mode==='never')return new Promise(()=>{});
   if(waitControl.mode==='timeout')return null;
   return startup.state==='healthy'?structuredClone(startup):new Promise(()=>{});
  }};
 return {f,installRoot,userDataRoot,lifecycle,lifecycleEvents,data,previous,candidate,previousPackage,candidatePackage,backup,
  operationId,handoff,startup,store,transitions,waitControl};
}

test('packages only a clean exact Git tag and verifies lock, licence and source hashes',async t=>{
 const f=fixtureRoot(t);
 const pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const checked=verifyReleasePackage({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256});
 assert.equal(checked.sourceTag,'v1.0.0');
 assert.equal(checked.sourceCommit,f.firstCommit);
 assert.equal(checked.license,'Apache-2.0');
 assert.ok(checked.fileCount>=10);
 const manifest=JSON.parse(readFileSync(join(pkg.target,'release-manifest.json'),'utf8'));
 assert.equal(manifest.protocol,1);
 assert.equal(manifest.packages.root.lockSha256,h(readFileSync(join(pkg.target,'package-lock.json'))));
 assert.equal(manifest.packages.gateway.license,'Apache-2.0');
 assert.ok(manifest.files.some(file=>file.path==='THIRD_PARTY_NOTICES.md'));
 assert.ok(!manifest.files.some(file=>file.path==='.env'));
 assert.ok(!JSON.stringify(manifest).includes('fixture-secret'));
 assert.equal(git(f.repo,'status','--porcelain','--untracked-files=all'),'');
});

test('desktop-electron verification binds the actual portable manifest, payload files, and Electron target',t=>{
 const f=fixtureRoot(t),pkg=desktopPortableFixture(f.root);
 const checked=verifyReleasePackage({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,
  expectedAppLockSha256:'4'.repeat(64),expectedRuntimeReceiptSha256:'3'.repeat(64),
  expectedRootLockSha256:'1'.repeat(64),
  expectedRuntimeTarget:{electronVersion:'45.0.0',nodeVersion:'24.22.0',platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'},
  profile:'desktop-electron'});
 assert.equal(checked.profile,'desktop-electron');
 assert.equal(checked.sourceCommit,'a'.repeat(40));
 assert.equal(checked.sourceTag,null);
 assert.equal(checked.runtimeReceiptSha256,'3'.repeat(64));
 assert.deepEqual(checked.target,{profile:'desktop-electron',runtimeKind:'electron',electronVersion:'45.0.0',platform:'win32',arch:'x64',
  nodeVersion:'24.22.0',abi:{node:'150',napi:'10'},electronArchiveSha256:'2'.repeat(64),
  electronExecutableSha256:pkg.manifest.electron.executableSha256});
 assert.equal(checked.fileCount,pkg.manifest.files.length);
});

test('desktop-electron verification rejects extra portable manifest fields',t=>{
 const f=fixtureRoot(t),pkg=desktopPortableFixture(f.root),manifest={...pkg.manifest,sourceTag:'v0.1.0'};
 const raw=JSON.stringify(manifest,null,2)+'\n',digest=h(raw);
 writeFileSync(join(pkg.target,'portable-package-manifest.json'),raw);
 writeFileSync(join(pkg.target,'portable-package-manifest.sha256'),digest+'  portable-package-manifest.json\n');
 assert.throws(()=>verifyReleasePackage({packageRoot:pkg.target,expectedManifestSha256:digest,expectedAppLockSha256:'4'.repeat(64),
  expectedRootLockSha256:'1'.repeat(64),expectedRuntimeReceiptSha256:'3'.repeat(64),expectedRuntimeTarget:{electronVersion:'45.0.0',nodeVersion:'24.22.0',
   platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'},profile:'desktop-electron'}),/release_portable_manifest_invalid/);
});

test('desktop-electron verification rejects payload tampering and mismatched external bindings',t=>{
 const f=fixtureRoot(t),pkg=desktopPortableFixture(f.root),args={packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,
  expectedAppLockSha256:'4'.repeat(64),expectedRootLockSha256:'1'.repeat(64),expectedRuntimeReceiptSha256:'3'.repeat(64),
  expectedRuntimeTarget:{electronVersion:'45.0.0',nodeVersion:'24.22.0',platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'},
  profile:'desktop-electron'};
 assert.throws(()=>verifyReleasePackage({...args,expectedAppLockSha256:'5'.repeat(64)}),/release_portable_app_lock_mismatch/);
 assert.throws(()=>verifyReleasePackage({...args,expectedRuntimeTarget:{...args.expectedRuntimeTarget,nodeModuleAbi:'999'}}),/release_portable_runtime_target_mismatch/);
 writeFileSync(join(pkg.target,'Jot.exe'),'tampered executable');
 assert.throws(()=>verifyReleasePackage(args),/release_portable_package_inventory_mismatch/);
});

test('desktop-electron staging seals the verified portable tree without running npm',async t=>{
 const f=fixtureRoot(t),pkg=desktopPortableFixture(f.root),installRoot=join(f.root,'desktop-install');let commands=0;
 const stageArgs={packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,userDataRoot:join(f.root,'user-data'),profile:'desktop-electron',
  expectedAppLockSha256:'4'.repeat(64),expectedRootLockSha256:'1'.repeat(64),expectedRuntimeReceiptSha256:'3'.repeat(64),
  expectedRuntimeTarget:{electronVersion:'45.0.0',nodeVersion:'24.22.0',platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'},
  runCommand:async()=>{commands++;throw new Error('portable stage must not run npm');}};
 const staged=await stageRelease(stageArgs),releaseRoot=join(installRoot,'releases',staged.releaseId);
 assert.equal(commands,0);
 assert.equal(staged.profile,'desktop-electron');
 assert.equal(staged.completeRuntimeProof,true);
 assert.equal(staged.sourceTag,null);
 assert.match(staged.releaseId,/-desktop-electron$/);
 assert.equal(readFileSync(join(releaseRoot,'portable-package-manifest.sha256'),'utf8'),pkg.manifestSha256+'  portable-package-manifest.json\n');
 const runtime=JSON.parse(readFileSync(join(releaseRoot,'release-runtime.json'),'utf8'));
 assert.equal(runtime.protocol,3);
 assert.equal(runtime.profile,'desktop-electron');
 assert.deepEqual(runtime.sourceLocks,{desktop:'4'.repeat(64)});
 assert.equal(runtime.target.runtimeKind,'electron');
 assert.equal(releaseOperations.verifyInstalledRelease({installRoot,releaseId:staged.releaseId,expectedManifestSha256:pkg.manifestSha256,
  expectedRuntimeSha256:staged.runtimeSha256,expectedTarget:staged.target}).completeRuntimeProof,true);
 const repeated=await stageRelease(stageArgs);
 assert.equal(repeated.alreadyPresent,true);
});

test('desktop-electron stage receipt binds source, build, lock pins, and runtime receipt to the installed manifest',async t=>{
 const f=fixtureRoot(t),pkg=desktopPortableFixture(f.root),installRoot=join(f.root,'desktop-install'),userDataRoot=join(f.root,'user-data');
 const args={packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,userDataRoot,profile:'desktop-electron',
  expectedAppLockSha256:'4'.repeat(64),expectedRootLockSha256:'1'.repeat(64),expectedRuntimeReceiptSha256:'3'.repeat(64),
  expectedRuntimeTarget:{electronVersion:'45.0.0',nodeVersion:'24.22.0',platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'}};
 const staged=await stageRelease(args),proofPath=join(installRoot,'.jot-state','staged-releases',staged.releaseId+'.json');
 const expectedSourceReceipt={sourceCommit:'a'.repeat(40),sourceTreeSha256:'b'.repeat(64),appLockSha256:'4'.repeat(64),
  rootLockSha256:'1'.repeat(64),runtimeReceiptSha256:'3'.repeat(64),
  build:{nodeVersion:'24.13.0',npmVersion:'11.6.2',viteVersion:'8.3.2',rootLockSha256:'1'.repeat(64)},dependencyClosureProven:false};
 const proof=JSON.parse(readFileSync(proofPath,'utf8'));
 assert.deepEqual(staged.sourceReceipt,expectedSourceReceipt);
 assert.deepEqual(staged.dependencyClosureProven,false);
 assert.deepEqual(proof.sourceReceipt,expectedSourceReceipt);
 const installed=releaseOperations.verifyInstalledRelease({installRoot,releaseId:staged.releaseId,expectedManifestSha256:pkg.manifestSha256,
  expectedRuntimeSha256:staged.runtimeSha256,expectedTarget:staged.target});
 assert.deepEqual(installed.sourceReceipt,expectedSourceReceipt);
 assert.equal(installed.dependencyClosureProven,false);

 proof.sourceReceipt.appLockSha256='5'.repeat(64);
 writeFileSync(proofPath,canonical(proof)+'\n');
 await assert.rejects(stageRelease(args),/release_stage_proof_invalid/);
});

test('desktop-electron staging cancellation after metadata never publishes and permits a clean retry',async t=>{
 const f=fixtureRoot(t),pkg=desktopPortableFixture(f.root),installRoot=join(f.root,'desktop-install'),
  userDataRoot=join(f.root,'user-data'),controller=new AbortController();
 mkdirSync(userDataRoot);writeFileSync(join(userDataRoot,'canary'),'retain private data');
 const args={packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,userDataRoot,profile:'desktop-electron',
  expectedAppLockSha256:'4'.repeat(64),expectedRootLockSha256:'1'.repeat(64),expectedRuntimeReceiptSha256:'3'.repeat(64),
  expectedRuntimeTarget:{electronVersion:'45.0.0',nodeVersion:'24.22.0',platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'}};
 await assert.rejects(stageRelease({...args,signal:AbortSignal.abort()}),error=>error?.name==='AbortError');
 assert.equal(existsSync(installRoot),false);
 const original=fs.writeFileSync;let aborted=false;
 fs.writeFileSync=function(path,...rest){
  const result=original.call(this,path,...rest);
  if(String(path).includes('.staging-')&&String(path).endsWith('portable-package-manifest.json')){aborted=true;controller.abort();}
  return result;
 };
 syncBuiltinESMExports();
 try{await assert.rejects(stageRelease({...args,signal:controller.signal}),error=>error?.name==='AbortError');}
 finally{fs.writeFileSync=original;syncBuiltinESMExports();}
 assert.equal(aborted,true);
 assert.equal(readDeploymentState(installRoot),null);
 assert.deepEqual(existsSync(join(installRoot,'releases'))?readdirSync(join(installRoot,'releases')):[],[]);
 assert.equal(stageLockExpired(join(installRoot,'.jot-state','staging.lock')),true);
 assert.equal(readFileSync(join(userDataRoot,'canary'),'utf8'),'retain private data');
 const retried=await stageRelease(args);
 assert.equal(retried.alreadyPresent,false);
 assert.equal(retried.staged,true);
 assert.equal(readDeploymentState(installRoot),null);
});

test('desktop-electron staging removes a partial ENOSPC copy, preserves the verified runtime, and permits retry',async t=>{
 const f=fixtureRoot(t),previousPackage=desktopPortableFixture(f.root),candidatePackage=desktopPortableFixture(join(f.root,'candidate'),
  {sourceCommit:'c'.repeat(40),sourceTreeSha256:'d'.repeat(64)}),installRoot=join(f.root,'desktop-install'),userDataRoot=join(f.root,'user-data');
 mkdirSync(userDataRoot,{recursive:true});writeFileSync(join(userDataRoot,'canary'),'retain private data');
 const stageArgs=pkg=>({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,userDataRoot,profile:'desktop-electron',
  expectedAppLockSha256:'4'.repeat(64),expectedRootLockSha256:'1'.repeat(64),expectedRuntimeReceiptSha256:'3'.repeat(64),
  expectedRuntimeTarget:{electronVersion:'45.0.0',nodeVersion:'24.22.0',platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'}});
 const previous=await stageRelease(stageArgs(previousPackage)),previousRoot=join(installRoot,'releases',previous.releaseId);
 const verify= (pkg,staged)=>releaseOperations.verifyInstalledRelease({installRoot,releaseId:staged.releaseId,
  expectedManifestSha256:pkg.manifestSha256,expectedRuntimeSha256:staged.runtimeSha256,expectedTarget:staged.target});
 assert.equal(verify(previousPackage,previous).completeRuntimeProof,true);
 const executable=join(candidatePackage.target,'Jot.exe'),completeExecutable=readFileSync(executable);
 writeFileSync(executable,completeExecutable.subarray(0,Math.max(1,Math.floor(completeExecutable.length/2))));
 await assert.rejects(stageRelease(stageArgs(candidatePackage)),/release_portable_package_inventory_mismatch/);
 assert.deepEqual(readdirSync(join(installRoot,'releases')),[previous.releaseId]);
 assert.equal(verify(previousPackage,previous).runtimeSha256,previous.runtimeSha256);
 assert.equal(readDeploymentState(installRoot),null);
 writeFileSync(executable,completeExecutable);
 const original=fs.writeFileSync;let partialCopy=false;
 fs.writeFileSync=function(path,data,...rest){
  if(!partialCopy&&String(path).includes('.staging-')&&String(path).endsWith('Jot.exe')){
   original.call(this,path,Buffer.from(data).subarray(0,Math.max(1,Math.floor(Buffer.byteLength(data)/2))),...rest);
   partialCopy=true;throw Object.assign(new Error('disk full'),{code:'ENOSPC'});
  }
  return original.call(this,path,data,...rest);
 };
 syncBuiltinESMExports();
 try{await assert.rejects(stageRelease(stageArgs(candidatePackage)),/release_stage_failed/);}
 finally{fs.writeFileSync=original;syncBuiltinESMExports();}
 assert.equal(partialCopy,true);
 const releases=join(installRoot,'releases');
 assert.deepEqual(readdirSync(releases),[previous.releaseId]);
 assert.equal(verify(previousPackage,previous).runtimeSha256,previous.runtimeSha256);
 assert.equal(existsSync(join(installRoot,'.jot-state','staged-releases',
  candidatePackage.manifest.sourceCommit+'-'+candidatePackage.manifestSha256.slice(0,12)+'-desktop-electron.json')),false);
 assert.equal(readDeploymentState(installRoot),null);
 assert.equal(stageLockExpired(join(installRoot,'.jot-state','staging.lock')),true);
 assert.equal(readFileSync(join(userDataRoot,'canary'),'utf8'),'retain private data');
 const candidate=await stageRelease(stageArgs(candidatePackage)),candidateRoot=join(releases,candidate.releaseId);
 assert.equal(candidate.staged,true);assert.equal(candidate.alreadyPresent,false);
 assert.equal(verify(candidatePackage,candidate).completeRuntimeProof,true);
 assert.equal(verify(previousPackage,previous).completeRuntimeProof,true);
 assert.deepEqual(readdirSync(releases).sort(),[previous.releaseId,candidate.releaseId].sort());
 assert.equal(readFileSync(join(userDataRoot,'canary'),'utf8'),'retain private data');
 assert.equal(existsSync(join(candidateRoot,'canary')),false);
 assert.equal(readDeploymentState(installRoot),null);
});

test('desktop-electron staging cancellation after publication preserves other releases and permits retry',async t=>{
 const f=fixtureRoot(t),pkg=desktopPortableFixture(f.root),installRoot=join(f.root,'desktop-install'),controller=new AbortController();
 const args={packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,userDataRoot:join(f.root,'user-data'),
  profile:'desktop-electron',expectedAppLockSha256:'4'.repeat(64),expectedRootLockSha256:'1'.repeat(64),
  expectedRuntimeReceiptSha256:'3'.repeat(64),expectedRuntimeTarget:{electronVersion:'45.0.0',nodeVersion:'24.22.0',
   platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'}};
 const preserved=join(installRoot,'releases','preserved-release');mkdirSync(preserved,{recursive:true});
 writeFileSync(join(preserved,'canary'),'retain unrelated release');
 const original=fs.renameSync;let publishedPath;
 fs.renameSync=function(source,destination){
  const result=original.call(this,source,destination);
  if(String(source).includes('.staging-')&&String(destination).endsWith('-desktop-electron')){
   publishedPath=destination;controller.abort();
  }
  return result;
 };
 syncBuiltinESMExports();
 try{await assert.rejects(stageRelease({...args,signal:controller.signal}),error=>error?.name==='AbortError');}
 finally{fs.renameSync=original;syncBuiltinESMExports();}
 assert.ok(publishedPath);
 assert.equal(existsSync(publishedPath),false);
 assert.deepEqual(readdirSync(join(installRoot,'releases')),['preserved-release']);
 assert.equal(readFileSync(join(preserved,'canary'),'utf8'),'retain unrelated release');
 assert.equal(stageLockExpired(join(installRoot,'.jot-state','staging.lock')),true);
 assert.equal(readDeploymentState(installRoot),null);
 const retried=await stageRelease(args);
 assert.equal(retried.alreadyPresent,false);
 assert.equal(retried.staged,true);
 assert.equal(readFileSync(join(preserved,'canary'),'utf8'),'retain unrelated release');
});

test('desktop-electron staging yields to caller cancellation without publishing',async t=>{
 const f=fixtureRoot(t),pkg=desktopPortableFixture(f.root),installRoot=join(f.root,'desktop-install'),controller=new AbortController();
 const args={packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,userDataRoot:join(f.root,'user-data'),
  profile:'desktop-electron',expectedAppLockSha256:'4'.repeat(64),expectedRootLockSha256:'1'.repeat(64),
  expectedRuntimeReceiptSha256:'3'.repeat(64),expectedRuntimeTarget:{electronVersion:'45.0.0',nodeVersion:'24.22.0',
   platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'}};
 const pending=stageRelease({...args,signal:controller.signal});
 controller.abort();
 await assert.rejects(pending,error=>error?.name==='AbortError');
 assert.equal(readDeploymentState(installRoot),null);
 assert.deepEqual(existsSync(join(installRoot,'releases'))?readdirSync(join(installRoot,'releases')):[],[]);
 assert.equal(stageLockExpired(join(installRoot,'.jot-state','staging.lock')),true);
 assert.equal((await stageRelease(args)).alreadyPresent,false);
});

test('desktop-electron CLI verifies and stages only with caller-pinned locks and runtime receipt',t=>{
 const f=fixtureRoot(t),receiptPath=join(f.root,'runtime-receipt.json'),installRoot=join(f.root,'desktop-install');
 const receipt={protocol:'jot.desktop.runtime-acceptance.v1',runtimeAcceptancePassed:true,started:true,cleanExit:true,
  electronVersion:'45.0.0',nodeVersion:'24.22.0',
  platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'};
 const receiptBytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n'),runtimeReceiptSha256=h(receiptBytes);
 writeFileSync(receiptPath,receiptBytes);
 const pkg=desktopPortableFixture(f.root,{runtimeReceiptSha256});
 const expectedSourceReceipt={sourceCommit:'a'.repeat(40),sourceTreeSha256:'b'.repeat(64),appLockSha256:'4'.repeat(64),
  rootLockSha256:'1'.repeat(64),runtimeReceiptSha256,
  build:{nodeVersion:'24.13.0',npmVersion:'11.6.2',viteVersion:'8.3.2',rootLockSha256:'1'.repeat(64)},dependencyClosureProven:false};
 const externalArgs=['--profile','desktop-electron','--app-lock-sha','4'.repeat(64),'--root-lock-sha','1'.repeat(64),
  '--runtime-receipt',receiptPath,'--runtime-receipt-sha',runtimeReceiptSha256];
 const verified=releaseCli(['verify','--package',pkg.target,'--sha',pkg.manifestSha256,...externalArgs]);
 assert.equal(verified.profile,'desktop-electron');
 assert.equal(verified.runtimeReceiptSha256,runtimeReceiptSha256);
 assert.equal(verified.sourceTag,null);
 assert.deepEqual(verified.sourceReceipt,expectedSourceReceipt);
 assert.equal(verified.dependencyClosureProven,false);
 const staged=releaseCli(['stage','--package',pkg.target,'--sha',pkg.manifestSha256,'--install-root',installRoot,
  '--user-data-root',join(f.root,'profile','AppData','Roaming','Jot'),...externalArgs],
  {env:{TEMP:f.root,TMP:f.root,TMPDIR:f.root}});
 assert.equal(staged.profile,'desktop-electron');
 assert.equal(staged.completeRuntimeProof,true);
 assert.deepEqual(staged.target.abi,{node:'150',napi:'10'});
 assert.deepEqual(staged.sourceReceipt,expectedSourceReceipt);
 assert.equal(staged.dependencyClosureProven,false);
});

test('desktop-electron failed candidate probe leaves the deployment pointer unchanged',async t=>{
 const f=fixtureRoot(t),pkg=desktopPortableFixture(f.root),installRoot=join(f.root,'desktop-install'),
  userDataRoot=join(f.root,'profile','AppData','Roaming','Jot'),probeRoot=join(f.root,'probe-root');
 const staged=await stageRelease({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,userDataRoot,
  profile:'desktop-electron',expectedAppLockSha256:'4'.repeat(64),expectedRootLockSha256:'1'.repeat(64),
  expectedRuntimeReceiptSha256:'3'.repeat(64),expectedRuntimeTarget:{electronVersion:'45.0.0',nodeVersion:'24.22.0',
   platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'}});
 const lifecycle={async drainActive(){assert.fail('first install must not drain');},async probeRelease(input){
  return {releaseId:input.releaseId,instanceId:'failed-probe',target:{...input.expectedTarget,electronVersion:'44.0.0'},
   origin:'http://127.0.0.1:43127',status:'ready',readyAt:new Date().toISOString()};
 }};
 await assert.rejects(activateRelease({installRoot,releaseId:staged.releaseId,expectedManifestSha256:pkg.manifestSha256,
  expectedRuntimeSha256:staged.runtimeSha256,profile:'desktop-electron',healthUrl:'http://127.0.0.1:43127/api/capabilities',
  desktopLifecycle:lifecycle,probeRoot,userDataRoot}),/release_desktop_probe_receipt_invalid/);
 assert.equal(readDeploymentState(installRoot),null);
});

test('desktop-electron first activation uses a fresh awaited probe and never trusts a drained boolean',async t=>{
 const f=fixtureRoot(t),pkg=desktopPortableFixture(f.root),installRoot=join(f.root,'desktop-install');
 const args={packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,userDataRoot:join(f.root,'user-data'),profile:'desktop-electron',
  expectedAppLockSha256:'4'.repeat(64),expectedRootLockSha256:'1'.repeat(64),expectedRuntimeReceiptSha256:'3'.repeat(64),
  expectedRuntimeTarget:{electronVersion:'45.0.0',nodeVersion:'24.22.0',platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'}};
 const staged=await stageRelease(args),events=[],probeRoot=join(f.root,'probe-root'),readyAt=new Date().toISOString();
 const desktopLifecycle={
  async drainActive(){events.push('drain');throw new Error('first install has no active release');},
  async probeRelease(input){events.push('probe');assert.equal(input.releaseId,staged.releaseId);assert.equal(input.probeRoot,probeRoot);
   return {releaseId:input.releaseId,instanceId:'probe-instance-1',target:input.expectedTarget,origin:'http://127.0.0.1:43127',status:'ready',readyAt};}
 };
 await assert.rejects(activateRelease({installRoot,releaseId:staged.releaseId,expectedManifestSha256:pkg.manifestSha256,
  expectedRuntimeSha256:staged.runtimeSha256,profile:'desktop-electron',drained:true,healthUrl:'http://127.0.0.1:43127/api/capabilities'}),
  /release_consumer_drain_boolean_forbidden/);
 const result=await activateRelease({installRoot,releaseId:staged.releaseId,expectedManifestSha256:pkg.manifestSha256,
  expectedRuntimeSha256:staged.runtimeSha256,profile:'desktop-electron',healthUrl:'http://127.0.0.1:43127/api/capabilities',
  desktopLifecycle,probeRoot,userDataRoot:args.userDataRoot});
 assert.deepEqual(events,['probe']);
 assert.equal(result.activated,true);
 assert.equal(readDeploymentState(installRoot).active.releaseId,staged.releaseId);
 const child=new EventEmitter();child.kill=()=>{};let invocation;
 const run=await releaseOperations.runRelease({installRoot,profile:'desktop-electron',extraArgs:['--jot-runtime-probe'],
  spawnRuntime(command,args,options){invocation={command,args,options};queueMicrotask(()=>child.emit('close',0,null));return child;}});
 assert.equal(invocation.command,join(installRoot,'releases',staged.releaseId,'Jot.exe'));
 assert.deepEqual(invocation.args,['--jot-runtime-probe']);
 assert.equal(run.exitCode,0);
 assert.equal(run.manifestSha256,pkg.manifestSha256);
});

test('desktop-electron launcher handoff verifies exact pointers and records one healthy candidate launch',async t=>{
 const hfx=await desktopHandoffFixture(t),child=new EventEmitter();child.kill=()=>assert.fail('healthy handoff must not kill the candidate');
 hfx.startup.state='healthy';let invocations=0,launch;
 const result=await releaseOperations.continueDesktopLaunchHandoff({installRoot:hfx.installRoot,
  previousLaunch:{exitCode:75,signal:null,releaseId:hfx.previous.releaseId,manifestSha256:hfx.previousPackage.manifestSha256},
  handoffStore:hfx.store,healthUrl:'http://127.0.0.1:43127/api/capabilities',rollbackProbeRoot:join(hfx.f.root,'probe-rollback'),
  desktopLifecycle:hfx.lifecycle,hostBackupScript,privateBackupConfig:hfx.data.privateBackupConfig,userDataRoot:hfx.userDataRoot,
  spawnRuntime(command,args,options){invocations++;launch={command,args,options};setImmediate(()=>child.emit('close',0,null));return child;}});
 assert.equal(invocations,1);
 assert.equal(launch.command,join(hfx.installRoot,'releases',hfx.candidate.releaseId,'Jot.exe'));
 assert.deepEqual(launch.args,[]);
 assert.equal(result.state,'healthy');
 assert.equal(result.candidate.releaseId,hfx.candidate.releaseId);
 assert.deepEqual(hfx.transitions,[['requested','launched'],['launched','healthy']]);
 assert.equal(hfx.handoff.state,'healthy');
 assert.equal(existsSync(join(hfx.installRoot,'.jot-state','launcher-handoff-'+hfx.operationId+'.lock')),false);
});

test('desktop-electron launcher handoff marks pointer mismatch unknown without launching',async t=>{
 const hfx=await desktopHandoffFixture(t);hfx.handoff.candidate.manifestSha256='f'.repeat(64);
 const result=await releaseOperations.continueDesktopLaunchHandoff({installRoot:hfx.installRoot,
  previousLaunch:{exitCode:75,signal:null,releaseId:hfx.previous.releaseId,manifestSha256:hfx.previousPackage.manifestSha256},
  handoffStore:hfx.store,healthUrl:'http://127.0.0.1:43127/api/capabilities',rollbackProbeRoot:join(hfx.f.root,'probe-rollback'),
  desktopLifecycle:hfx.lifecycle,hostBackupScript,privateBackupConfig:hfx.data.privateBackupConfig,userDataRoot:hfx.userDataRoot,
  spawnRuntime(){assert.fail('pointer mismatch must not launch a candidate');}});
 assert.equal(result.state,'unknown');
 assert.equal(result.reason,'release_desktop_handoff_pointer_mismatch');
 assert.deepEqual(hfx.transitions,[['requested','unknown']]);
 assert.equal(readDeploymentState(hfx.installRoot).active.releaseId,hfx.candidate.releaseId);
});

test('desktop-electron launcher handoff timeout leaves a live candidate alone and does not roll back',async t=>{
 const hfx=await desktopHandoffFixture(t),child=new EventEmitter();let killed=false;
 hfx.startup.state='attempted';hfx.waitControl.mode='timeout';hfx.lifecycleEvents.length=0;child.kill=()=>{killed=true;};let spawned;
 const result=await releaseOperations.continueDesktopLaunchHandoff({installRoot:hfx.installRoot,
  previousLaunch:{exitCode:75,signal:null,releaseId:hfx.previous.releaseId,manifestSha256:hfx.previousPackage.manifestSha256},
  handoffStore:hfx.store,healthUrl:'http://127.0.0.1:43127/api/capabilities',rollbackProbeRoot:join(hfx.f.root,'probe-rollback'),
  desktopLifecycle:hfx.lifecycle,hostBackupScript,privateBackupConfig:hfx.data.privateBackupConfig,userDataRoot:hfx.userDataRoot,
  spawnRuntime(command,args,options){spawned={command,args,options};return child;}});
 assert.equal(result.state,'unknown');
 assert.equal(result.reason,'release_desktop_startup_timeout');
 assert.equal(killed,false);
 assert.equal(spawned.command,join(hfx.installRoot,'releases',hfx.candidate.releaseId,'Jot.exe'));
 assert.deepEqual(spawned.args,[]);
 assert.equal(spawned.options.signal,undefined);
 assert.deepEqual(hfx.transitions,[['requested','launched'],['launched','unknown']]);
 assert.deepEqual(hfx.lifecycleEvents,[]);
 assert.equal(readDeploymentState(hfx.installRoot).active.releaseId,hfx.candidate.releaseId);
 assert.equal(existsSync(join(hfx.installRoot,'.jot-state','launcher-handoff-'+hfx.operationId+'.lock')),true);
 child.emit('close',null,'SIGTERM');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(existsSync(join(hfx.installRoot,'.jot-state','launcher-handoff-'+hfx.operationId+'.lock')),false);
});

test('desktop-electron launcher handoff rolls back once only after exact attempted receipt and explicit failure',async t=>{
 const hfx=await desktopHandoffFixture(t),child=new EventEmitter();hfx.startup.state='attempted';hfx.waitControl.mode='never';
 hfx.lifecycleEvents.length=0;child.kill=()=>assert.fail('explicit failed close must already be complete before rollback');
 const result=await releaseOperations.continueDesktopLaunchHandoff({installRoot:hfx.installRoot,
  previousLaunch:{exitCode:75,signal:null,releaseId:hfx.previous.releaseId,manifestSha256:hfx.previousPackage.manifestSha256},
  handoffStore:hfx.store,healthUrl:'http://127.0.0.1:43127/api/capabilities',rollbackProbeRoot:join(hfx.f.root,'probe-rollback'),
  desktopLifecycle:hfx.lifecycle,hostBackupScript,privateBackupConfig:hfx.data.privateBackupConfig,userDataRoot:hfx.userDataRoot,
  spawnRuntime(){queueMicrotask(()=>child.emit('close',23,null));return child;}});
 assert.equal(result.state,'rolled-back');
 assert.equal(result.activeReleaseId,hfx.previous.releaseId);
 assert.deepEqual(hfx.transitions,[['requested','launched'],['launched','rolled-back']]);
 assert.deepEqual(hfx.lifecycleEvents,['drain:'+hfx.candidate.releaseId,'probe:'+hfx.previous.releaseId]);
 assert.equal(readDeploymentState(hfx.installRoot).active.releaseId,hfx.previous.releaseId);
 assert.equal(existsSync(join(hfx.installRoot,'.jot-state','launcher-handoff-'+hfx.operationId+'.lock')),false);
});

test('desktop-electron launcher handoff lets only one concurrent supervisor launch the candidate',async t=>{
 const hfx=await desktopHandoffFixture(t),child=new EventEmitter();hfx.startup.state='attempted';hfx.waitControl.mode='timeout';
 let invocations=0;child.kill=()=>assert.fail('duplicate supervisor must not kill the active candidate');
 const run=()=>releaseOperations.continueDesktopLaunchHandoff({installRoot:hfx.installRoot,
  previousLaunch:{exitCode:75,signal:null,releaseId:hfx.previous.releaseId,manifestSha256:hfx.previousPackage.manifestSha256},
  handoffStore:hfx.store,healthUrl:'http://127.0.0.1:43127/api/capabilities',rollbackProbeRoot:join(hfx.f.root,'probe-rollback'),
  desktopLifecycle:hfx.lifecycle,hostBackupScript,privateBackupConfig:hfx.data.privateBackupConfig,userDataRoot:hfx.userDataRoot,
  spawnRuntime(){invocations++;return child;}});
 const results=await Promise.all([run(),run()]);
 assert.equal(invocations,1);
 assert.ok(results.every(result=>result.state==='unknown'));
 assert.equal(hfx.transitions.filter(([from,to])=>from==='requested'&&to==='launched').length,1);
 child.emit('close',null,'SIGTERM');
 await new Promise(resolve=>setImmediate(resolve));
});

test('desktop-electron launcher handoff rejects a mismatched startup receipt without rollback',async t=>{
 const hfx=await desktopHandoffFixture(t),child=new EventEmitter();hfx.startup.state='attempted';hfx.startup.recovery.backupId='e'.repeat(64);
 hfx.waitControl.mode='never';hfx.lifecycleEvents.length=0;child.kill=()=>assert.fail('candidate already exited');
 const result=await releaseOperations.continueDesktopLaunchHandoff({installRoot:hfx.installRoot,
  previousLaunch:{exitCode:75,signal:null,releaseId:hfx.previous.releaseId,manifestSha256:hfx.previousPackage.manifestSha256},
  handoffStore:hfx.store,healthUrl:'http://127.0.0.1:43127/api/capabilities',rollbackProbeRoot:join(hfx.f.root,'probe-rollback'),
  desktopLifecycle:hfx.lifecycle,hostBackupScript,privateBackupConfig:hfx.data.privateBackupConfig,userDataRoot:hfx.userDataRoot,
  spawnRuntime(){queueMicrotask(()=>child.emit('close',23,null));return child;}});
 assert.equal(result.state,'unknown');
 assert.equal(result.reason,'release_desktop_startup_receipt_unavailable');
 assert.deepEqual(hfx.transitions,[['requested','launched'],['launched','unknown']]);
 assert.deepEqual(hfx.lifecycleEvents,[]);
 assert.equal(readDeploymentState(hfx.installRoot).active.releaseId,hfx.candidate.releaseId);
});

test('desktop supervisor CLI holds before launch when the trusted Host binding is unavailable',async t=>{
 const f=fixtureRoot(t);let launches=0;
 const result=await captureReleaseMain(['supervise','--install-root',join(f.root,'desktop-install'),'--health-url','http://127.0.0.1:43127/api/capabilities',
  '--rollback-probe-root',join(f.root,'probe-rollback'),'--host-backup-script',hostBackupScript,'--config',join(f.root,'private.json'),
  '--user-data-root',join(f.root,'user-data')],{runReleaseCommand:async()=>{launches++;return {exitCode:0,signal:null};}});
 assert.equal(result.code,1);
 assert.deepEqual(result.value,{error:'release_desktop_supervisor_unavailable'});
 assert.equal(launches,0);
});

test('desktop supervisor CLI launches one candidate and one prepared restored release, then reuses its receipt on cold start',async t=>{
 const hfx=await desktopHandoffFixture(t),child=new EventEmitter();child.kill=()=>assert.fail('supervisor must not kill a candidate or restored process');
 const previous={releaseId:hfx.previous.releaseId,manifestSha256:hfx.previousPackage.manifestSha256};
 const recovery={backupId:hfx.backup.backupId,releaseId:hfx.previous.releaseId};
 const nonce='33333333-3333-4333-8333-333333333333',runtimePrevious=readDeploymentState(hfx.installRoot).previous;
 const processContext={pid:4108,execPath:join(hfx.installRoot,'releases',hfx.previous.releaseId,'Jot.exe'),
  releaseRoot:join(hfx.installRoot,'releases',hfx.previous.releaseId)};
 const probeReceipt={instanceId:'restore-probe-1',origin:'http://127.0.0.1:43118/',readyAt:'2026-10-23T02:00:00.000Z',
  releaseId:hfx.previous.releaseId,status:'ready',target:hfx.previous.target};
 const preparedReceipt={protocol:1,operationId:hfx.operationId,generation:1,nonce,previous:runtimePrevious,recovery,state:'prepared',
  processContext:null,probeReceipt:null};
 const restoredReceipt={...preparedReceipt,state:'healthy',processContext,probeReceipt};let storedRestoreReceipt=preparedReceipt;
 let initialRead=true,rollbackRecordCalls=0,prepareCalls=0,restoreWaitCalls=0,runCalls=0,spawnCalls=0;
 hfx.store.readHandoff=async()=>initialRead?null:structuredClone(hfx.handoff);
 hfx.store.markRollback=async input=>{rollbackRecordCalls++;assert.equal(input.operationId,hfx.operationId);assert.equal(input.backupDigest,hfx.backup.backupId);
  return {enabled:true,state:{operation:{id:hfx.operationId,startupStatus:'rolled-back',rollbackTarget:input.after.active}}};};
 hfx.store.prepareRestoredStartup=async input=>{
  prepareCalls++;assert.equal(input.operationId,hfx.operationId);assert.deepEqual(input.previous,runtimePrevious);assert.deepEqual(input.recovery,recovery);
  return {launchAllowed:true,receipt:structuredClone(preparedReceipt)};
 };
 hfx.store.readRestoredStartup=async({operationId})=>{
  assert.equal(operationId,hfx.operationId);return structuredClone(storedRestoreReceipt);
 };
 hfx.store.waitForRestoredStartup=async input=>{
  restoreWaitCalls++;assert.equal(input.operationId,hfx.operationId);assert.deepEqual(input.previous,previous);assert.deepEqual(input.recovery,recovery);
  storedRestoreReceipt=restoredReceipt;return structuredClone(restoredReceipt);
 };
 const bindings={handoffStore:hfx.store,desktopLifecycle:hfx.lifecycle};
 const cliArgs=['supervise','--install-root',hfx.installRoot,'--health-url','http://127.0.0.1:43127/api/capabilities',
  '--rollback-probe-root',join(hfx.f.root,'probe-supervisor-rollback'),'--host-backup-script',hostBackupScript,'--config',hfx.data.privateBackupConfig,
  '--user-data-root',hfx.userDataRoot,'--startup-timeout-ms','1000'];
 const result=await captureReleaseMain(cliArgs,{desktopSupervisorBindingsFactory:async()=>bindings,
  async runReleaseCommand(options){
   runCalls++;
   if(runCalls===1){initialRead=false;hfx.startup.state='attempted';hfx.waitControl.mode='never';
    return {exitCode:75,signal:null,releaseId:hfx.previous.releaseId,manifestSha256:hfx.previousPackage.manifestSha256};}
   return await releaseOperations.runRelease(options);
  },
  spawnRuntime(command,args,options){
   spawnCalls++;assert.equal(options.signal,undefined);
   if(spawnCalls===1){assert.deepEqual(args,[]);assert.equal(command,join(hfx.installRoot,'releases',hfx.candidate.releaseId,'Jot.exe'));setImmediate(()=>child.emit('close',23,null));}
   else{assert.deepEqual(args,[]);assert.equal(options.env.JOT_DESKTOP_RESTORED_STARTUP_NONCE,nonce);
    assert.equal(command,join(hfx.installRoot,'releases',hfx.previous.releaseId,'Jot.exe'));setImmediate(()=>child.emit('close',0,null));}
   return child;
  }});
 assert.equal(result.code,0);
 assert.equal(result.value.state,'restored-healthy');
 assert.equal(rollbackRecordCalls,1);
 assert.equal(prepareCalls,1);
 assert.equal(restoreWaitCalls,1);
 assert.equal(spawnCalls,2);
 assert.equal(readDeploymentState(hfx.installRoot).active.releaseId,hfx.previous.releaseId);

 const cold=await captureReleaseMain(['supervise','--install-root',hfx.installRoot,'--health-url','http://127.0.0.1:43127/api/capabilities',
  '--rollback-probe-root',join(hfx.f.root,'probe-supervisor-rollback-cold'),'--host-backup-script',hostBackupScript,'--config',hfx.data.privateBackupConfig,
  '--user-data-root',hfx.userDataRoot,'--startup-timeout-ms','1000'],{desktopSupervisorBindingsFactory:async()=>bindings,
  async runReleaseCommand(){runCalls++;assert.fail('cold recovery must inspect the original receipt without launching');},
  spawnRuntime(){spawnCalls++;assert.fail('cold recovery must not launch again');}});
 assert.equal(cold.code,0);
 assert.equal(cold.value.state,'restored-healthy');
 assert.equal(rollbackRecordCalls,1);
 assert.equal(prepareCalls,1);
 assert.equal(restoreWaitCalls,2);
 assert.equal(spawnCalls,2);
 assert.equal(runCalls,2);
});

test('desktop supervisor leaves a timed-out restored launch unknown and never replays it after cold start',async t=>{
 const hfx=await desktopHandoffFixture(t),child=new EventEmitter();child.kill=()=>assert.fail('unknown restore must not kill its child');
 const previous={releaseId:hfx.previous.releaseId,manifestSha256:hfx.previousPackage.manifestSha256};
 const recovery={backupId:hfx.backup.backupId,releaseId:hfx.previous.releaseId},runtimePrevious=readDeploymentState(hfx.installRoot).previous;
 const nonce='44444444-4444-4444-8444-444444444444';
 const prepared={protocol:1,operationId:hfx.operationId,generation:1,nonce,previous:runtimePrevious,recovery,state:'prepared',
  processContext:null,probeReceipt:null};
 const attempted={...prepared,state:'attempted',processContext:{pid:4110,execPath:join(hfx.installRoot,'releases',hfx.previous.releaseId,'Jot.exe'),
  releaseRoot:join(hfx.installRoot,'releases',hfx.previous.releaseId)},probeReceipt:null};
 let initialRead=true,stored=prepared,markCalls=0,prepareCalls=0,waitCalls=0,runCalls=0,spawnCalls=0;
 hfx.store.readHandoff=async()=>initialRead?null:structuredClone(hfx.handoff);
 hfx.store.markRollback=async input=>{markCalls++;assert.equal(input.operationId,hfx.operationId);assert.equal(input.backupDigest,hfx.backup.backupId);
  return {enabled:true,state:{operation:{id:hfx.operationId,startupStatus:'rolled-back',rollbackTarget:input.after.active}}};};
 hfx.store.prepareRestoredStartup=async input=>{
  prepareCalls++;assert.equal(input.operationId,hfx.operationId);stored=prepared;return {launchAllowed:true,receipt:structuredClone(prepared)};
 };
 hfx.store.readRestoredStartup=async({operationId})=>{assert.equal(operationId,hfx.operationId);return structuredClone(stored);};
 hfx.store.waitForRestoredStartup=async input=>{
  waitCalls++;assert.equal(input.operationId,hfx.operationId);assert.deepEqual(input.previous,previous);assert.deepEqual(input.recovery,recovery);
  stored=attempted;return null;
 };
 const bindings={handoffStore:hfx.store,desktopLifecycle:hfx.lifecycle};
 const args=['supervise','--install-root',hfx.installRoot,'--health-url','http://127.0.0.1:43127/api/capabilities',
  '--rollback-probe-root',join(hfx.f.root,'probe-supervisor-timeout'),'--host-backup-script',hostBackupScript,
  '--config',hfx.data.privateBackupConfig,'--user-data-root',hfx.userDataRoot,'--startup-timeout-ms','10'];
 const result=await captureReleaseMain(args,{desktopSupervisorBindingsFactory:async()=>bindings,
  async runReleaseCommand(options){
   runCalls++;
   if(runCalls===1){initialRead=false;hfx.startup.state='attempted';hfx.waitControl.mode='never';
    return {exitCode:75,signal:null,releaseId:hfx.previous.releaseId,manifestSha256:hfx.previousPackage.manifestSha256};}
   return await releaseOperations.runRelease(options);
  },
  spawnRuntime(command,_args,options){
   spawnCalls++;assert.equal(options.signal,undefined);
   if(spawnCalls===1){assert.equal(command,join(hfx.installRoot,'releases',hfx.candidate.releaseId,'Jot.exe'));setImmediate(()=>child.emit('close',23,null));}
   else{assert.equal(command,join(hfx.installRoot,'releases',hfx.previous.releaseId,'Jot.exe'));setImmediate(()=>child.emit('close',0,null));}
   return child;
  }});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(result.value.state,'unknown');
 assert.equal(result.value.reason,'release_desktop_restore_startup_timeout');
 assert.equal(markCalls,1);assert.equal(prepareCalls,1);assert.equal(waitCalls,1);assert.equal(spawnCalls,2);

 const cold=await captureReleaseMain(args,{desktopSupervisorBindingsFactory:async()=>bindings,
  async runReleaseCommand(){runCalls++;assert.fail('cold unknown restore must not relaunch');},
  spawnRuntime(){spawnCalls++;assert.fail('cold unknown restore must not spawn');}});
 assert.equal(cold.value.state,'unknown');
 assert.equal(markCalls,1);assert.equal(prepareCalls,1);assert.equal(waitCalls,2);assert.equal(spawnCalls,2);assert.equal(runCalls,2);
});

test('desktop supervisor unknown handoff is inspection-only and never starts a runtime',async t=>{
 const hfx=await desktopHandoffFixture(t);hfx.handoff.state='unknown';let launches=0;
 hfx.store.markRollback=async()=>assert.fail('unknown handoff cannot mark rollback');
 hfx.store.prepareRestoredStartup=async()=>assert.fail('unknown state must not prepare a restored launch');
 hfx.store.readRestoredStartup=async()=>assert.fail('unknown state must not inspect restored startup');
 hfx.store.waitForRestoredStartup=async()=>assert.fail('unknown state must not wait for or infer a restored receipt');
 const result=await captureReleaseMain(['supervise','--install-root',hfx.installRoot,'--health-url','http://127.0.0.1:43127/api/capabilities',
  '--rollback-probe-root',join(hfx.f.root,'probe-supervisor-unknown'),'--host-backup-script',hostBackupScript,'--config',hfx.data.privateBackupConfig,
  '--user-data-root',hfx.userDataRoot],{desktopSupervisorBindingsFactory:async()=>({handoffStore:hfx.store,desktopLifecycle:hfx.lifecycle}),
  async runReleaseCommand(){launches++;return {exitCode:0,signal:null};},spawnRuntime(){launches++;assert.fail('unknown state must not spawn');}});
 assert.equal(result.code,0);
 assert.equal(result.value.state,'unknown');
 assert.equal(launches,0);
});

test('desktop supervisor rejects a restored receipt for another operation and does not replay after rollback',async t=>{
 const hfx=await desktopHandoffFixture(t);
 await rollbackRelease({installRoot:hfx.installRoot,restoreReleaseId:hfx.previous.releaseId,backupId:hfx.backup.backupId,
  profile:'desktop-electron',healthUrl:'http://127.0.0.1:43127/api/capabilities',desktopLifecycle:hfx.lifecycle,
  probeRoot:join(hfx.f.root,'probe-supervisor-invalid-receipt'),hostBackupScript,privateBackupConfig:hfx.data.privateBackupConfig,
  userDataRoot:hfx.userDataRoot});
 hfx.handoff.state='rolled-back';let launches=0;
 hfx.store.markRollback=async()=>assert.fail('cold recovery cannot remark rollback');
 const runtimePrevious=readDeploymentState(hfx.installRoot).active,recovery={backupId:hfx.backup.backupId,releaseId:hfx.previous.releaseId};
 hfx.store.prepareRestoredStartup=async()=>assert.fail('cold recovery must not claim a new restored launch');
 hfx.store.readRestoredStartup=async()=>({protocol:1,operationId:'22222222-2222-4222-8222-222222222222',generation:1,
  nonce:'33333333-3333-4333-8333-333333333333',previous:runtimePrevious,recovery,state:'healthy',
  processContext:{pid:4108,execPath:join(hfx.installRoot,'releases',hfx.previous.releaseId,'Jot.exe'),
   releaseRoot:join(hfx.installRoot,'releases',hfx.previous.releaseId)},
  probeReceipt:{instanceId:'restore-probe-1',origin:'http://127.0.0.1:43118/',readyAt:'2026-10-23T02:00:00.000Z',
   releaseId:hfx.previous.releaseId,status:'ready',target:hfx.previous.target}});
 hfx.store.waitForRestoredStartup=async()=>assert.fail('cold recovery must reject the malformed journal receipt before waiting');
 const result=await captureReleaseMain(['supervise','--install-root',hfx.installRoot,'--health-url','http://127.0.0.1:43127/api/capabilities',
  '--rollback-probe-root',join(hfx.f.root,'probe-supervisor-invalid-receipt-cold'),'--host-backup-script',hostBackupScript,
  '--config',hfx.data.privateBackupConfig,'--user-data-root',hfx.userDataRoot],{
  desktopSupervisorBindingsFactory:async()=>({handoffStore:hfx.store,desktopLifecycle:hfx.lifecycle}),
  async runReleaseCommand(){launches++;assert.fail('invalid old receipt must not launch a runtime');},
  spawnRuntime(){launches++;assert.fail('invalid old receipt must not spawn a runtime');}});
 assert.equal(result.code,0);
 assert.equal(result.value.state,'unknown');
 assert.equal(result.value.reason,'release_desktop_restore_receipt_invalid');
 assert.equal(launches,0);
 assert.equal(hfx.handoff.state,'rolled-back');
});

test('desktop supervisor consumes the real Host store and cold process keeps the original operation',async t=>{
 const hostRoot=process.env.JOT_TEST_DESKTOP_HOST_ROOT;
 if(!hostRoot){t.skip('set JOT_TEST_DESKTOP_HOST_ROOT to the reviewed Host source checkout');return;}
 const hostModule=pathToFileURL(join(resolve(hostRoot),'packages/desktop/src/update-state.mjs')).href;
 const {createUpdateStateStore,createDesktopLauncherHandoffStore}=await import(hostModule);
 const hfx=await desktopHandoffFixture(t),before=readDeploymentState(hfx.installRoot),statePath=join(hfx.installRoot,'.jot-state','update-state.json');
 const {createDesktopLauncherSupervisorBindings}=await import(pathToFileURL(join(resolve(hostRoot),'apps/desktop/launcher-supervisor.mjs')).href);
 assert.throws(()=>createDesktopLauncherSupervisorBindings({installRoot:hfx.installRoot,userDataRoot:hfx.userDataRoot}),
  /desktop_update_launcher_supervisor_unavailable/,'real Host configuration remains disabled without testOnly injection');
 const journal=createUpdateStateStore({statePath,profile:'desktop-electron'}),store=createDesktopLauncherHandoffStore({installRoot:hfx.installRoot});
 const target={product:'jot',channel:'stable',platform:'win32',arch:'x64'},envelopeDigest='a'.repeat(64);
 const receipt=(ref,sequence,digest)=>({...target,profile:'desktop-electron',releaseId:ref.releaseId,
  manifestSha256:ref.manifestSha256,sequence,envelopeDigest:digest});
 await journal.recordReleaseReceipt(receipt(before.previous,'1','b'.repeat(64)));
 await journal.beginOperation({id:hfx.operationId,target,profile:'desktop-electron',envelopeDigest,manifestSha256:before.active.manifestSha256});
 await journal.recordReleaseReceipt(receipt(before.active,'2',envelopeDigest));
 for(const phase of ['downloading','downloaded'])await journal.setPhase(hfx.operationId,phase);
 await journal.recordRecoveryPoint(hfx.operationId,hfx.backup.backupId,before.previous.releaseId);
 for(const phase of ['staged','awaiting-activation','activating'])await journal.setPhase(hfx.operationId,phase);
 await journal.reconcileDeployment(before);
 let runs=0,spawns=0;const pending=[];
 const result=await releaseOperations.superviseDesktopLaunch({installRoot:hfx.installRoot,userDataRoot:hfx.userDataRoot,
  healthUrl:'http://127.0.0.1:43127/api/capabilities',rollbackProbeRoot:join(hfx.f.root,'real-store-probe'),
  hostBackupScript,privateBackupConfig:hfx.data.privateBackupConfig,startupTimeoutMs:2000,
  bindings:{handoffStore:store,desktopLifecycle:hfx.lifecycle},
  async runReleaseCommand(options){
   runs++;if(runs===1){await journal.recordLauncherHandoff(hfx.operationId,hfx.handoff);
    return {exitCode:75,signal:null,...hfx.handoff.previous};}
   return releaseOperations.runRelease(options);
  },spawnRuntime(command,args,options){
   const child=new EventEmitter();child.kill=()=>assert.fail('contract test cannot kill a process');spawns++;
   const candidate=spawns===1;
   pending.push(new Promise((done,reject)=>setImmediate(async()=>{try{
    if(candidate)await journal.claimStartupAttempt(hfx.operationId);
    else{
     const token=await store.readRestoredStartup({operationId:hfx.operationId});
     assert.equal(options.env.JOT_DESKTOP_RESTORED_STARTUP_NONCE,token.nonce);
     const context={pid:process.pid,execPath:command,releaseRoot:dirname(command)};
     const identity={operationId:hfx.operationId,previous:before.previous,recovery:hfx.handoff.recovery,nonce:token.nonce,processContext:context};
     await journal.claimRestoredStartup(identity);
     await journal.confirmRestoredStartup({...identity,probeReceipt:{instanceId:'synthetic-contract-probe',origin:'http://127.0.0.1:43118/',
      readyAt:new Date().toISOString(),releaseId:before.previous.releaseId,status:'ready',target:before.previous.target}});
    }
    child.emit('close',candidate?23:0,null);done();
   }catch(error){child.emit('error',error);reject(error);}})));
   return child;
  }});
 await Promise.all(pending);assert.equal(result.state,'restored-healthy');assert.equal(spawns,2);
 const after=readDeploymentState(hfx.installRoot),saved=readFileSync(statePath,'utf8');
 for(const input of [
  {operationId:'22222222-2222-4222-8222-222222222222',before,after,backupDigest:hfx.backup.backupId},
  {operationId:hfx.operationId,before,after,backupDigest:'f'.repeat(64)},
  {operationId:hfx.operationId,before,after:{...after,active:{...after.active,runtimeSha256:'f'.repeat(64)}},backupDigest:hfx.backup.backupId}
 ])await assert.rejects(store.markRollback(input),/desktop_update_launcher_rollback_scope_invalid/);
 assert.equal(readFileSync(statePath,'utf8'),saved);
 const script=`const ops=await import(process.argv[1]);const host=await import(process.argv[2]);
 const installRoot=process.argv[3];const fail=()=>{throw Error('cold restart must only inspect the existing receipt')};
 const result=await ops.superviseDesktopLaunch({installRoot,startupTimeoutMs:100,
 bindings:{handoffStore:host.createDesktopLauncherHandoffStore({installRoot}),desktopLifecycle:{drainActive:fail,probeRelease:fail}},runReleaseCommand:fail,spawnRuntime:fail});
 process.stdout.write(JSON.stringify(result));`;
 const cold=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script,
  pathToFileURL(resolve('scripts/release-ops.mjs')).href,hostModule,hfx.installRoot],{encoding:'utf8'}));
 assert.equal(cold.state,'restored-healthy');assert.equal(cold.operationId,hfx.operationId);
 assert.equal(cold.receipt.nonce,result.receipt.nonce);assert.equal(readFileSync(statePath,'utf8'),saved);
});

test('desktop-electron recovery point backs up and restores SQLite, files, and notification state',async t=>{
 const f=fixtureRoot(t),pkg=desktopPortableFixture(f.root),installRoot=join(f.root,'desktop-install'),
  userDataRoot=join(f.root,'synthetic-profile','AppData','Roaming','Jot');
 const args={packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,userDataRoot,profile:'desktop-electron',
  expectedAppLockSha256:'4'.repeat(64),expectedRootLockSha256:'1'.repeat(64),expectedRuntimeReceiptSha256:'3'.repeat(64),
  expectedRuntimeTarget:{electronVersion:'45.0.0',nodeVersion:'24.22.0',platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'}};
 const staged=await stageRelease(args),readyAt=new Date().toISOString();
 const desktopLifecycle={async drainActive(){throw new Error('first install');},async probeRelease(input){
  return {releaseId:input.releaseId,instanceId:'probe-instance-1',target:input.expectedTarget,origin:'http://127.0.0.1:43127',status:'ready',readyAt};}};
 await activateRelease({installRoot,releaseId:staged.releaseId,expectedManifestSha256:pkg.manifestSha256,
  expectedRuntimeSha256:staged.runtimeSha256,profile:'desktop-electron',healthUrl:'http://127.0.0.1:43127/api/capabilities',
  desktopLifecycle,probeRoot:join(f.root,'probe-root'),userDataRoot});
 const data=desktopDataFixture(f.root,userDataRoot),point=await createRecoveryPoint({installRoot,releaseId:staged.releaseId,
  privateBackupConfig:data.privateBackupConfig,userDataRoot,hostBackupScript});
 const verified=verifyRecoveryPoint({installRoot,backupId:point.backupId,privateBackupConfig:data.privateBackupConfig,userDataRoot,hostBackupScript});
 assert.equal(verified.profile,'desktop-electron');
 assert.equal(verified.userDataRoot,userDataRoot);
 assert.match(verified.userDataScopeSha256,/^[a-f0-9]{64}$/);
 const db=new DatabaseSync(data.database);db.exec("UPDATE state SET value='after_update'");db.close();
 writeFileSync(data.attachment,'mutated attachment');writeFileSync(data.notifications,JSON.stringify({delivered:['after_update']}));
 for(const path of [data.database,join(userDataRoot,'files'),join(userDataRoot,'workspaces'),join(userDataRoot,'sessions'),join(userDataRoot,'host-config'),data.notifications])
  renameSync(path,path+'.mutated');
 const restored=await restoreRecoveryPoint({installRoot,backupId:point.backupId,privateBackupConfig:data.privateBackupConfig,
  userDataRoot,hostBackupScript});
 assert.equal(restored.restored,true);
 const restoredDb=new DatabaseSync(data.database,{readOnly:true});
 assert.equal(restoredDb.prepare('SELECT value FROM state').get().value,'before_update');restoredDb.close();
 assert.equal(readFileSync(data.attachment,'utf8'),'user-data attachment canary');
 assert.deepEqual(JSON.parse(readFileSync(data.notifications,'utf8')),{delivered:['before_update']});
});

test('desktop-electron recovery CLI binds the private config and user-data scope for every recovery action',async t=>{
 const f=fixtureRoot(t),pkg=desktopPortableFixture(f.root),installRoot=join(f.root,'desktop-install'),
  userDataRoot=join(f.root,'synthetic-profile','AppData','Roaming','Jot'),hostBackupScript=join(f.root,'fake-host-backup.mjs');
 writeFileSync(hostBackupScript,`import {mkdirSync} from 'node:fs';\nimport {dirname} from 'node:path';\nconst [action,first,second,third]=process.argv.slice(2);\nif(action==='create')mkdirSync(second,{recursive:true});\nconsole.log(JSON.stringify(action==='create'?{backup_id:'${'5'.repeat(64)}',verified:true}:action==='verify'?{verified:true}:{restored:true}));\n`);
 const staged=await stageRelease({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,userDataRoot,
  profile:'desktop-electron',expectedAppLockSha256:'4'.repeat(64),expectedRootLockSha256:'1'.repeat(64),
  expectedRuntimeReceiptSha256:'3'.repeat(64),expectedRuntimeTarget:{electronVersion:'45.0.0',nodeVersion:'24.22.0',
   platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'}});
 await activateRelease({installRoot,releaseId:staged.releaseId,expectedManifestSha256:pkg.manifestSha256,
  expectedRuntimeSha256:staged.runtimeSha256,profile:'desktop-electron',healthUrl:'http://127.0.0.1:43127/api/capabilities',
  desktopLifecycle:{async drainActive(){throw new Error('first install');},async probeRelease(input){return {releaseId:input.releaseId,
   instanceId:'cli-probe',target:input.expectedTarget,origin:'http://127.0.0.1:43127',status:'ready',readyAt:new Date().toISOString()};}},
  probeRoot:join(f.root,'probe-root'),userDataRoot});
 const data=desktopDataFixture(f.root,userDataRoot),base=['--install-root',installRoot,'--user-data-root',userDataRoot,
  '--host-backup-script',hostBackupScript],created=releaseCli(['backup',...base,'--config',data.privateBackupConfig]);
 assert.equal(created.verified,true);
 const verified=releaseCli(['verify-backup',...base,'--backup',created.backupId,'--config',data.privateBackupConfig]);
 assert.equal(verified.profile,'desktop-electron');
 assert.equal(verified.userDataRoot,userDataRoot);
 assert.equal(releaseCli(['restore-backup',...base,'--backup',created.backupId,'--config',data.privateBackupConfig]).restored,true);
});

test('desktop-electron update and rollback await drain and probe ports against the existing recovery point',async t=>{
 const f=fixtureRoot(t),userDataRoot=join(f.root,'synthetic-profile','AppData','Roaming','Jot'),installRoot=join(f.root,'desktop-install');
 const first=desktopPortableFixture(f.root),second=desktopPortableFixture(join(f.root,'candidate-two'),{sourceCommit:'b'.repeat(40),sourceTreeSha256:'c'.repeat(64)});
 const stageArgs=pkg=>({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,userDataRoot,profile:'desktop-electron',
  expectedAppLockSha256:'4'.repeat(64),expectedRootLockSha256:'1'.repeat(64),expectedRuntimeReceiptSha256:'3'.repeat(64),
  expectedRuntimeTarget:{electronVersion:'45.0.0',nodeVersion:'24.22.0',platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'}});
 const staged1=await stageRelease(stageArgs(first)),staged2=await stageRelease(stageArgs(second)),events=[];
 const lifecycle={async drainActive(input){events.push('drain:'+input.releaseId);return {releaseId:input.releaseId,instanceId:'active-instance',
  lifecyclePhase:'stopped',backendClosedAt:new Date().toISOString()};},async probeRelease(input){events.push('probe:'+input.releaseId);
  return {releaseId:input.releaseId,instanceId:'fresh-'+events.length,target:input.expectedTarget,origin:'http://127.0.0.1:43127',
   status:'ready',readyAt:new Date().toISOString()};}};
 await activateRelease({installRoot,releaseId:staged1.releaseId,expectedManifestSha256:first.manifestSha256,
  expectedRuntimeSha256:staged1.runtimeSha256,profile:'desktop-electron',healthUrl:'http://127.0.0.1:43127/api/capabilities',
  desktopLifecycle:lifecycle,probeRoot:join(f.root,'probe-first'),userDataRoot});
 const data=desktopDataFixture(f.root,userDataRoot),point=await createRecoveryPoint({installRoot,releaseId:staged1.releaseId,
  privateBackupConfig:data.privateBackupConfig,userDataRoot,hostBackupScript});
 events.length=0;
 await activateRelease({installRoot,releaseId:staged2.releaseId,expectedManifestSha256:second.manifestSha256,
  expectedRuntimeSha256:staged2.runtimeSha256,profile:'desktop-electron',backupId:point.backupId,
  privateBackupConfig:data.privateBackupConfig,userDataRoot,hostBackupScript,
  healthUrl:'http://127.0.0.1:43127/api/capabilities',desktopLifecycle:lifecycle,probeRoot:join(f.root,'probe-update')});
 assert.deepEqual(events,['drain:'+staged1.releaseId,'probe:'+staged2.releaseId]);
 assert.equal(readDeploymentState(installRoot).active.releaseId,staged2.releaseId);
 events.length=0;
 await rollbackRelease({installRoot,restoreReleaseId:staged1.releaseId,backupId:point.backupId,profile:'desktop-electron',
  privateBackupConfig:data.privateBackupConfig,userDataRoot,hostBackupScript,healthUrl:'http://127.0.0.1:43127/api/capabilities',
  desktopLifecycle:lifecycle,probeRoot:join(f.root,'probe-rollback')});
 assert.deepEqual(events,['drain:'+staged2.releaseId,'probe:'+staged1.releaseId]);
 assert.equal(readDeploymentState(installRoot).active.releaseId,staged1.releaseId);
});

test('packages exact Git blob bytes from a CRLF working tree',async t=>{
 const f=fixtureRoot(t);
 const example=join(f.repo,'.env.example');
 writeFileSync(example,Buffer.from('PUBLIC=fixture-value\r\n'));
 writeFileSync(join(f.repo,'.gitattributes'),'*.example text eol=crlf\n');
 git(f.repo,'config','core.autocrlf','true');
 git(f.repo,'add','.gitattributes','.env.example');
 git(f.repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--no-gpg-sign','-m','fixture CRLF source');
 const commit=git(f.repo,'rev-parse','HEAD');
 git(f.repo,'tag','v1.0.1');
 assert.equal(git(f.repo,'status','--porcelain','--untracked-files=all'),'');
 assert.ok(readFileSync(example).includes(Buffer.from('\r\n')));
 const pkg=await packageAt(f.repo,f.root,'v1.0.1',commit,'package-crlf');
 const expected=execFileSync('git',['-C',f.repo,'cat-file','blob',`${commit}:.env.example`],{encoding:null});
 assert.deepEqual(readFileSync(join(pkg.target,'.env.example')),expected);
});

test('rejects dirty checkouts, an incorrect peeled tag hash and invalid tag names',async t=>{
 const f=fixtureRoot(t);
 await assert.rejects(createReleasePackage({sourceRoot:f.repo,tag:'v1.0.0',expectedCommit:'0'.repeat(40),target:join(f.root,'wrong-hash')}),/release_source_commit_mismatch/);
 await assert.rejects(createReleasePackage({sourceRoot:f.repo,tag:'../v1.0.0',expectedCommit:f.firstCommit,target:join(f.root,'unsafe-tag')}),/release_tag_invalid/);
 writeFileSync(join(f.repo,'src/server.mjs'),'dirty source\n');
 await assert.rejects(createReleasePackage({sourceRoot:f.repo,tag:'v1.0.0',expectedCommit:f.firstCommit,target:join(f.root,'dirty')}),/release_source_dirty/);
});

test('verifier rejects a mutated source file, extra file and wrong manifest digest',async t=>{
 const f=fixtureRoot(t);
 const pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 writeFileSync(join(pkg.target,'src/server.mjs'),'tampered');
 assert.throws(()=>verifyReleasePackage({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256}),/release_package_file_mismatch/);
 writeFileSync(join(pkg.target,'src/server.mjs'),'export const sourceVersion = "one";\n');
 writeFileSync(join(pkg.target,'unlisted.bin'),'extra');
 assert.throws(()=>verifyReleasePackage({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256}),/release_package_inventory_mismatch/);
 rmSync(join(pkg.target,'unlisted.bin'));
 assert.throws(()=>verifyReleasePackage({packageRoot:pkg.target,expectedManifestSha256:'f'.repeat(64)}),/release_manifest_digest_mismatch/);
});

test('failed install/build never activates partial staging and successful stage stays immutable',async t=>{
 const f=fixtureRoot(t);
 const pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment');mkdirSync(installRoot);
 await assert.rejects(stageRelease({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,runCommand:async()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}}),/release_stage_failed/);
 assert.equal(readDeploymentState(installRoot),null);
 assert.equal(existsSync(join(installRoot,'releases')),false);
 const calls=[];
 const staged=await stageAt(pkg,installRoot,async input=>{
  calls.push({command:input.command,args:input.args,cwd:input.cwd,env:input.env});
  return fakeBuild(input);
 });
 assert.equal(staged.staged,true);
 assert.ok(calls.some(call=>call.args[0]==='ci'));
 assert.ok(calls.some(call=>call.args[0]==='prune'&&call.args[1]==='--omit=dev'));
 assert.ok(calls.some(call=>call.args[0]==='--version'));
 assert.ok(calls.findIndex(call=>call.args[0]==='ci')<calls.findIndex(call=>call.args[0]==='run'));
 assert.ok(calls.findIndex(call=>call.args[0]==='run')<calls.findIndex(call=>call.args[0]==='prune'));
 assert.ok(calls.findIndex(call=>call.args[0]==='prune')<calls.findIndex(call=>call.args[0]==='--version'));
 const npmCache=calls.find(call=>call.args[0]==='ci').env.npm_config_cache;
 assert.equal(resolve(npmCache,'..'),join(installRoot,'.jot-state','npm-cache'));
 assert.equal(existsSync(npmCache),false);
 assert.ok(!calls.some(call=>call.cwd.endsWith(join('packages','gateway'))));
 assert.equal(readDeploymentState(installRoot),null);
 assert.ok(existsSync(join(installRoot,'releases',staged.releaseId,'release-runtime.json')));
 assert.ok(staged.completeRuntimeProof);
 assert.equal(staged.runtimeDependenciesVerified,true);
 assert.equal(staged.target.npmVersion,'10.9.2');
 const runtime=JSON.parse(readFileSync(join(installRoot,'releases',staged.releaseId,'release-runtime.json'),'utf8'));
 assert.ok(runtime.files.some(file=>file.path==='node_modules/fastify/LICENSE'&&file.type==='file'));
 assert.ok(runtime.packages.some(pkg=>pkg.name==='fastify'&&pkg.license==='MIT'&&pkg.integrity==='sha512-Zml4dHVyZS1wcm9kdWN0aW9u'));
 assert.equal(existsSync(join(installRoot,'releases',staged.releaseId,'node_modules/fixture-build-tool')),false);
 const stageProof=JSON.parse(readFileSync(join(installRoot,'.jot-state','staged-releases',staged.releaseId+'.json'),'utf8'));
 assert.equal(stageProof.runtimeSha256,staged.runtimeSha256);
 assert.deepEqual(stageProof.target,staged.target);
 const existing=await stageAt(pkg,installRoot,async()=>{throw new Error('existing release must not be rebuilt');});
 assert.equal(existing.alreadyPresent,true);
 assert.equal(existing.runtimeSha256,staged.runtimeSha256);
 for(const path of [join(installRoot,'releases',staged.releaseId),join(installRoot,'releases',staged.releaseId,'release-manifest.json'),
  join(installRoot,'releases',staged.releaseId,'release-runtime.json'),join(installRoot,'releases',staged.releaseId,'src/server.mjs'),
  join(installRoot,'releases',staged.releaseId,'node_modules/fastify/package.json')])assert.equal(lstatSync(path).mode&0o222,0);
 const installedDependency=join(installRoot,'releases',staged.releaseId,'node_modules/fastify/package.json');
 chmodSync(installedDependency,0o644);
 await assert.rejects(stageAt(pkg,installRoot),/release_tree_not_readonly/);
 chmodSync(installedDependency,0o444);
 assert.ok(!staged.releaseId.includes('..'));
});
test('Gateway-only staging builds its own package without building the portable runtime',async t=>{
 const f=fixtureRoot(t);
 const pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment');mkdirSync(installRoot);
 const calls=[];
 const staged=await stageRelease({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,profile:'gateway',runCommand:async input=>{
  calls.push(input.cwd);
  return fakeBuild(input);
 }});
 assert.equal(staged.profile,'gateway');
 assert.ok(calls.every(path=>path.endsWith(join('packages','gateway'))));
 assert.ok(existsSync(join(installRoot,'releases',staged.releaseId,'packages/gateway/dist/src/main.js')));
 assert.ok(existsSync(join(installRoot,'releases',staged.releaseId,'packages/gateway/node_modules/fastify/LICENSE')));
 assert.equal(existsSync(join(installRoot,'releases',staged.releaseId,'packages/gateway/node_modules/fixture-gateway-build-tool')),false);
 assert.equal(existsSync(join(installRoot,'releases',staged.releaseId,'dist/index.html')),false);
});

test('staging removes build-only temp and empty npm scope directories before sealing the runtime',async t=>{
 const f=fixtureRoot(t);
 const pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment');mkdirSync(installRoot);
 const staged=await stageAt(pkg,installRoot,async input=>{
  const result=await fakeBuild(input);
  if(input.args[0]==='run'&&input.args[1]==='build')mkdirSync(join(input.cwd,'node_modules','.vite-temp'),{recursive:true});
  if(input.args[0]==='prune')mkdirSync(join(input.cwd,'node_modules','@fixture'),{recursive:true});
  return result;
 });
 const releaseRoot=join(installRoot,'releases',staged.releaseId);
 const runtime=JSON.parse(readFileSync(join(releaseRoot,runtimeManifestName),'utf8'));
 assert.equal(existsSync(join(releaseRoot,'node_modules','.vite-temp')),false);
 assert.equal(existsSync(join(releaseRoot,'node_modules','@fixture')),false);
 assert.equal(runtime.files.some(file=>file.path==='node_modules/.vite-temp'),false);
 assert.equal(runtime.files.some(file=>file.path==='node_modules/@fixture'),false);
});

test('cleans a just-published sealed runtime when host staging-proof storage fails',async t=>{
 const f=fixtureRoot(t),pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment');mkdirSync(installRoot);
 mkdirSync(join(installRoot,'.jot-state'),{recursive:true});writeFileSync(join(installRoot,'.jot-state','staged-releases'),'blocking file');
 const releaseId=pkg.sourceCommit+'-'+pkg.manifestSha256.slice(0,12)+'-standalone';
 await assert.rejects(stageAt(pkg,installRoot),/release_stage_failed/);
 assert.equal(existsSync(join(installRoot,'releases',releaseId)),false);
});

test('recovers a matching staged proof after publication is interrupted',async t=>{
 const f=fixtureRoot(t),pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment');mkdirSync(installRoot);
 const releaseId=pkg.sourceCommit+'-'+pkg.manifestSha256.slice(0,12)+'-standalone';
 const destination=join(installRoot,'releases',releaseId),proofPath=join(installRoot,'.jot-state','staged-releases',releaseId+'.json');
 const blockPublication=async input=>{
  const result=await fakeBuild(input);
  if(input.args[0]==='--version'){mkdirSync(destination,{recursive:true});writeFileSync(join(destination,'occupied'),'interrupt rename');}
  return result;
 };
 await assert.rejects(stageRelease({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,runCommand:blockPublication}),/release_stage_failed/);
 assert.equal(existsSync(proofPath),true);
 rmSync(destination,{recursive:true,force:true});
 const staged=await stageAt(pkg,installRoot);
 assert.equal(staged.completeRuntimeProof,true);
 assert.equal(staged.releaseId,releaseId);
 assert.equal(existsSync(destination),true);
});

test('releases the install-root stage lock after an unpublished proof so a changed target can retry',async t=>{
 const f=fixtureRoot(t),pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment');mkdirSync(installRoot);
 const releaseId=pkg.sourceCommit+'-'+pkg.manifestSha256.slice(0,12)+'-standalone';
 const destination=join(installRoot,'releases',releaseId),proofPath=join(installRoot,'.jot-state','staged-releases',releaseId+'.json');
 const interruptAfterProof=async input=>{
  if(input.args[0]==='--version'){
   mkdirSync(destination,{recursive:true});writeFileSync(join(destination,'occupied'),'interrupt rename');
   return {code:0,stdout:'10.9.2\n'};
  }
  return fakeBuild(input);
 };
 await assert.rejects(stageRelease({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,runCommand:interruptAfterProof}),/release_stage_failed/);
 assert.equal(existsSync(proofPath),true);
 rmSync(destination,{recursive:true,force:true});
 const changedTarget=async input=>input.args[0]==='--version'?{code:0,stdout:'10.9.3\n'}:fakeBuild(input);
 const staged=await stageRelease({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,runCommand:changedTarget});
 assert.equal(staged.target.npmVersion,'10.9.3');
});

test('serializes concurrent staging for one install root and never runs a second installer',async t=>{
 const f=fixtureRoot(t),pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment');mkdirSync(installRoot);
 let startedResolve,releaseGate;
 const started=new Promise(resolveStarted=>{startedResolve=resolveStarted;});
 const gate=new Promise(resolveGate=>{releaseGate=resolveGate;});
 const firstRunner=async input=>{
  if(input.args[0]==='ci'){startedResolve();await gate;}
  return fakeBuild(input);
 };
 const first=stageRelease({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,runCommand:firstRunner});
 await started;
 let secondInvoked=false;
 await assert.rejects(stageRelease({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,
  runCommand:async()=>{secondInvoked=true;}}),/release_stage_in_progress/);
 assert.equal(secondInvoked,false);
 releaseGate();
 const staged=await first;
 assert.equal(staged.completeRuntimeProof,true);
});

test('fences a paused stage after another owner reclaims its expired lease',async t=>{
 const f=fixtureRoot(t),pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment'),lock=join(installRoot,'.jot-state','staging.lock');mkdirSync(installRoot,{recursive:true});
 let startedResolve,releaseGate;
 const started=new Promise(resolveStarted=>{startedResolve=resolveStarted;});
 const gate=new Promise(resolveGate=>{releaseGate=resolveGate;});
 const pausedRunner=async input=>{if(input.args[0]==='ci'){startedResolve();await gate;}return fakeBuild(input);};
 const paused=stageRelease({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,runCommand:pausedRunner});
 await started;
 const expired=new Date(0);utimesSync(lock,expired,expired);
 const current=await stageRelease({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,runCommand:fakeBuild});
 releaseGate();
 await assert.rejects(paused,/release_stage_lock_lost/);
 assert.equal(current.completeRuntimeProof,true);
 assert.equal(existsSync(join(installRoot,'releases',current.releaseId)),true);
 assert.equal(stageLockExpired(lock),true);
});

test('recovers an expired malformed stage lock left during owner-record creation',async t=>{
 const f=fixtureRoot(t),pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment'),lock=join(installRoot,'.jot-state','staging.lock');
 mkdirSync(join(installRoot,'.jot-state'),{recursive:true});writeFileSync(lock,'{"protocol":1,');
 const expired=new Date(0);utimesSync(lock,expired,expired);
 const staged=await stageAt(pkg,installRoot);
 assert.equal(staged.completeRuntimeProof,true);
 assert.equal(stageLockExpired(lock),true);
});

test('reclaims an expired stage lock even when a reused PID still exists',async t=>{
 const f=fixtureRoot(t),pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment'),lock=join(installRoot,'.jot-state','staging.lock');
 mkdirSync(join(installRoot,'.jot-state'),{recursive:true});
 writeFileSync(lock,canonical({protocol:1,pid:process.pid,startedAt:new Date(0).toISOString(),token:'11111111-1111-4111-8111-111111111111'})+'\n');
 const expired=new Date(0);utimesSync(lock,expired,expired);
 const staged=await stageAt(pkg,installRoot);
 assert.equal(staged.completeRuntimeProof,true);
 assert.equal(stageLockExpired(lock),true);
});

test('preserves a heartbeat that races with expired stage-lock recovery',async t=>{
 const f=fixtureRoot(t),pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment'),lock=join(installRoot,'.jot-state','staging.lock');mkdirSync(installRoot,{recursive:true});
 let startedResolve,releaseGate;
 const started=new Promise(resolveStarted=>{startedResolve=resolveStarted;});
 const gate=new Promise(resolveGate=>{releaseGate=resolveGate;});
 const firstRunner=async input=>{if(input.args[0]==='ci'){startedResolve();await gate;}return fakeBuild(input);};
 const first=stageRelease({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,runCommand:firstRunner});
 await started;
 const expired=new Date(0);utimesSync(lock,expired,expired);
 const originalRename=fs.renameSync;
 let simulatedHeartbeat=false;
 fs.renameSync=(source,destination,...args)=>{
  if(source===lock&&destination.startsWith(lock+'.stale-')){const fresh=new Date();utimesSync(lock,fresh,fresh);simulatedHeartbeat=true;}
  return originalRename(source,destination,...args);
 };
 syncBuiltinESMExports();
 t.after(()=>{fs.renameSync=originalRename;syncBuiltinESMExports();});
 await assert.rejects(stageRelease({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,runCommand:fakeBuild}),/release_stage_in_progress/);
 assert.equal(simulatedHeartbeat,true);
 assert.equal(existsSync(lock),true);
 assert.equal(stageLockExpired(lock),false);
 releaseGate();
 const staged=await first;
 assert.equal(staged.completeRuntimeProof,true);
 assert.equal(stageLockExpired(lock),true);
});

test('retries an in-flight heartbeat when recovery briefly replaces its lock file',async t=>{
 const f=fixtureRoot(t),pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment'),lock=join(installRoot,'.jot-state','staging.lock');mkdirSync(installRoot,{recursive:true});
 let startedResolve,releaseGate,heartbeatRaceResolve;
 const started=new Promise(resolveStarted=>{startedResolve=resolveStarted;});
 const gate=new Promise(resolveGate=>{releaseGate=resolveGate;});
 const heartbeatRace=new Promise(resolveRace=>{heartbeatRaceResolve=resolveRace;});
 const originalSetInterval=globalThis.setInterval,originalRead=fs.readFileSync,originalRename=fs.renameSync;
 const originalWrite=fs.writeFileSync,originalUnlink=fs.unlinkSync;
 let injectRace=false,lockReadCount=0,raceInjected=false;
 globalThis.setInterval=function(callback,delay,...args){return originalSetInterval(callback,delay===15000?5:delay,...args);};
 fs.readFileSync=(path,...args)=>{
  const value=originalRead(path,...args);
  if(injectRace&&path===lock&&++lockReadCount===2){
   const stale=lock+'.heartbeat-race',contents=originalRead(lock,'utf8');
   originalRename(lock,stale);originalWrite(lock,contents,{flag:'wx'});
   const fresh=new Date();utimesSync(lock,fresh,fresh);originalUnlink(stale);
   injectRace=false;raceInjected=true;heartbeatRaceResolve();
   return originalRead(path,...args);
  }
  return value;
 };
 syncBuiltinESMExports();
 t.after(()=>{
  releaseGate();globalThis.setInterval=originalSetInterval;fs.readFileSync=originalRead;fs.writeFileSync=originalWrite;fs.renameSync=originalRename;fs.unlinkSync=originalUnlink;syncBuiltinESMExports();
 });
 const pausedRunner=async input=>{if(input.args[0]==='ci'){startedResolve();await gate;}return fakeBuild(input);};
 const paused=stageRelease({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,runCommand:pausedRunner});
 await started;
 injectRace=true;
 await heartbeatRace;
 assert.equal(raceInjected,true);
 releaseGate();
 const staged=await paused;
 assert.equal(staged.completeRuntimeProof,true);
 assert.equal(stageLockExpired(lock),true);
});

test('does not delete a replacement owner lock while releasing the prior lease',async t=>{
 const f=fixtureRoot(t),pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment'),lock=join(installRoot,'.jot-state','staging.lock');mkdirSync(installRoot,{recursive:true});
 const replacement={protocol:1,pid:process.pid,startedAt:new Date().toISOString(),token:'22222222-2222-4222-8222-222222222222'};
 const originalFutimes=fs.futimesSync;let replaced=false;
 fs.futimesSync=(fd,atime,mtime)=>{
  if(!replaced&&new Date(atime).getTime()===0){
   fs.unlinkSync(lock);fs.writeFileSync(lock,canonical(replacement)+'\n',{flag:'wx'});
   const fresh=new Date();utimesSync(lock,fresh,fresh);replaced=true;
  }
  return originalFutimes(fd,atime,mtime);
 };
 syncBuiltinESMExports();
 t.after(()=>{fs.futimesSync=originalFutimes;syncBuiltinESMExports();});
 const staged=await stageAt(pkg,installRoot);
 assert.equal(staged.completeRuntimeProof,true);
 assert.equal(replaced,true);
 assert.equal(readFileSync(lock,'utf8'),canonical(replacement)+'\n');
 assert.equal(stageLockExpired(lock),false);
});

test('deployment pin includes the exact runtime digest and target and rejects a mismatched digest',async t=>{
 const f=fixtureRoot(t),pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment');mkdirSync(installRoot);
 const staged=await stageAt(pkg,installRoot),health=await launchFakeHealthServer();t.after(()=>health.server.close());
 await assert.rejects(activateRelease({installRoot,releaseId:staged.releaseId,expectedManifestSha256:pkg.manifestSha256,
  expectedRuntimeSha256:'f'.repeat(64),drained:true,healthUrl:health.url,profile:'standalone',healthProbe:async()=>true}),/release_runtime_digest_mismatch/);
 assert.equal(readDeploymentState(installRoot),null);
 await activateRelease({installRoot,releaseId:staged.releaseId,expectedManifestSha256:pkg.manifestSha256,
  expectedRuntimeSha256:staged.runtimeSha256,drained:true,healthUrl:health.url,profile:'standalone',healthProbe:async()=>true});
 const active=readDeploymentState(installRoot).active;
 assert.equal(active.runtimeSha256,staged.runtimeSha256);
 assert.deepEqual(active.target,staged.target);
});

test('runRelease launches only the explicitly pinned v2 release through the Host launcher',async t=>{
 const f=fixtureRoot(t),pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment');mkdirSync(installRoot);
 writeFileSync(join(installRoot,'.env'),'');
 const staged=await stageAt(pkg,installRoot);
 await assert.rejects(releaseOperations.runRelease({installRoot,profile:'standalone',releaseId:staged.releaseId,
  expectedManifestSha256:pkg.manifestSha256,expectedRuntimeSha256:'f'.repeat(64),demo:true}),/release_runtime_digest_mismatch/);
 const result=await releaseOperations.runRelease({installRoot,profile:'standalone',releaseId:staged.releaseId,
  expectedManifestSha256:pkg.manifestSha256,expectedRuntimeSha256:staged.runtimeSha256,demo:true});
 assert.equal(result.exitCode,0);
 assert.equal(result.runtimeSha256,staged.runtimeSha256);
 assert.equal(result.releaseId,staged.releaseId);
});

test('same source release ID rejects a stored target mismatch without overwriting the sealed runtime',async t=>{
 const f=fixtureRoot(t),pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment');mkdirSync(installRoot);
 const staged=await stageAt(pkg,installRoot),releaseRoot=join(installRoot,'releases',staged.releaseId);
 const proofPath=join(installRoot,'.jot-state','staged-releases',staged.releaseId+'.json');
 const proof=JSON.parse(readFileSync(proofPath,'utf8'));proof.target.npmVersion='10.9.3';
 writeFileSync(proofPath,canonical(proof)+'\n');
 const sourceBefore=readFileSync(join(releaseRoot,'src/server.mjs'));
 await assert.rejects(stageAt(pkg,installRoot,async()=>{throw new Error('mismatch must fail before rebuilding');}),/release_runtime_target_mismatch/);
 assert.deepEqual(readFileSync(join(releaseRoot,'src/server.mjs')),sourceBefore);
 assert.equal(JSON.parse(readFileSync(proofPath,'utf8')).target.npmVersion,'10.9.3');
});

test('legacy runtime v1 is readable as source/build-only proof and cannot activate, launch, or roll back',async t=>{
 assert.equal(typeof releaseOperations.verifyInstalledRelease,'function');
 const f=fixtureRoot(t),pkg1=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment');mkdirSync(installRoot);
 const old=await stageAt(pkg1,installRoot),oldRoot=join(installRoot,'releases',old.releaseId);
 const oldRuntime= rewriteAsLegacyRuntime(oldRoot,'standalone');
 const checked=releaseOperations.verifyInstalledRelease({installRoot,releaseId:old.releaseId,expectedManifestSha256:pkg1.manifestSha256});
 assert.equal(checked.sourceAndBuildFilesVerified,true);
 assert.equal(checked.runtimeDependenciesVerified,false);
 assert.equal(checked.completeRuntimeProof,false);
 assert.equal(Object.hasOwn(checked,'runtimeVerified'),false);
 const health=await launchFakeHealthServer();t.after(()=>health.server.close());
 await assert.rejects(activateRelease({installRoot,releaseId:old.releaseId,expectedManifestSha256:pkg1.manifestSha256,
  expectedRuntimeSha256:oldRuntime.sha256,drained:true,healthUrl:health.url,profile:'standalone',healthProbe:async()=>true}),/release_runtime_proof_required/);
 await assert.rejects(releaseOperations.runRelease({installRoot,profile:'standalone',releaseId:old.releaseId,
  expectedManifestSha256:pkg1.manifestSha256,expectedRuntimeSha256:oldRuntime.sha256}),/release_runtime_proof_required/);

 writeFileSync(join(f.repo,'src/server.mjs'),'export const sourceVersion = "new v2";\n');
 git(f.repo,'add','src/server.mjs');git(f.repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--no-gpg-sign','-m','fixture v2');
 const commit=git(f.repo,'rev-parse','HEAD');git(f.repo,'tag','v1.0.1');
 const pkg2=await packageAt(f.repo,f.root,'v1.0.1',commit,'package-two'),current=await stageAt(pkg2,installRoot);
 await activateRelease({installRoot,releaseId:current.releaseId,expectedManifestSha256:pkg2.manifestSha256,
  expectedRuntimeSha256:current.runtimeSha256,drained:true,healthUrl:health.url,profile:'standalone',healthProbe:async()=>true});
 const state=readDeploymentState(installRoot);state.previous={releaseId:old.releaseId,manifestSha256:pkg1.manifestSha256,profile:'standalone'};
 writeFileSync(join(installRoot,'.jot-state','deployment.json'),canonical(state)+'\n');
 await assert.rejects(rollbackRelease({installRoot,restoreReleaseId:old.releaseId,backupId:'0'.repeat(64),drained:true,
  healthUrl:health.url,profile:'standalone',healthProbe:async()=>true}),/release_runtime_proof_required/);
});

test('activation requires a verified recovery point for updates and matching migration protocol',async t=>{
 const f=fixtureRoot(t);
 const pkg1=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment');mkdirSync(installRoot);
 const staged1=await stageAt(pkg1,installRoot);
 const health=await launchFakeHealthServer();
 t.after(()=>health.server.close());
 const first=await activateRelease({installRoot,releaseId:staged1.releaseId,expectedManifestSha256:pkg1.manifestSha256,expectedRuntimeSha256:staged1.runtimeSha256,drained:true,healthUrl:health.url,profile:'standalone',healthProbe:async()=>true});
 assert.equal(first.previousReleaseId,null);
 assert.equal(readDeploymentState(installRoot).active.releaseId,staged1.releaseId);
 await assert.rejects(activateRelease({installRoot,releaseId:staged1.releaseId,expectedManifestSha256:pkg1.manifestSha256,expectedRuntimeSha256:staged1.runtimeSha256,drained:false,healthUrl:health.url,profile:'standalone',healthProbe:async()=>true}),/release_consumer_drain_required/);
});

test('real host-backup CLI binds source release identity and restores unknown state without starting services',async t=>{
 const f=fixtureRoot(t);
 const pkg=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment');mkdirSync(installRoot);
 const staged=await stageAt(pkg,installRoot);
 const health=await launchFakeHealthServer();
 t.after(()=>health.server.close());
 await activateRelease({installRoot,releaseId:staged.releaseId,expectedManifestSha256:pkg.manifestSha256,expectedRuntimeSha256:staged.runtimeSha256,drained:true,healthUrl:health.url,profile:'standalone',healthProbe:async()=>true});
 const source=backupFixture(f.root);
 const target=join(f.root,'recovery-one');
 const point=await createRecoveryPoint({installRoot,releaseId:staged.releaseId,privateBackupConfig:source.privateBackupConfig,target,hostBackupScript});
 const verified=verifyRecoveryPoint({installRoot,backupId:point.recoveryDigest,hostBackupScript});
 assert.equal(verified.releaseId,staged.releaseId);
 assert.equal(verified.sourceCommit,f.firstCommit);
 assert.match(verified.databaseProtocolSha256,/^[a-f0-9]{64}$/);
 assert.equal(verified.backupVerified,true);
 assert.ok(!JSON.stringify(point).includes(source.database));
 assert.ok(!JSON.stringify(point).includes('outcome_unknown'));
 for(const root of source.roots)renameSync(root.path,root.path+'.saved');
 const restored=await restoreRecoveryPoint({installRoot,backupId:point.recoveryDigest,privateBackupConfig:source.privateBackupConfig,hostBackupScript});
 assert.equal(restored.restored,true);
 const db=new DatabaseSync(source.database,{readOnly:true});
 assert.equal(db.prepare('SELECT value FROM state').get().value,'outcome_unknown');
 db.close();
 assert.equal(readDeploymentState(installRoot).active.releaseId,staged.releaseId);
});

test('same-protocol update activates only after local health, then explicit rollback leaves data untouched',async t=>{
 const f=fixtureRoot(t);
 const pkg1=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment');mkdirSync(installRoot);
 const staged1=await stageAt(pkg1,installRoot);
 const oldHealth=await launchFakeHealthServer();
 t.after(()=>oldHealth.server.close());
 await activateRelease({installRoot,releaseId:staged1.releaseId,expectedManifestSha256:pkg1.manifestSha256,expectedRuntimeSha256:staged1.runtimeSha256,drained:true,healthUrl:oldHealth.url,profile:'standalone',healthProbe:async()=>true});
 const host=backupFixture(f.root);
 const point=await createRecoveryPoint({installRoot,releaseId:staged1.releaseId,privateBackupConfig:host.privateBackupConfig,target:join(f.root,'recovery'),hostBackupScript});

 writeFileSync(join(f.repo,'src/server.mjs'),'export const sourceVersion = "two";\n');
 git(f.repo,'add','src/server.mjs');
 git(f.repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--no-gpg-sign','-m','fixture two');
 const secondCommit=git(f.repo,'rev-parse','HEAD');
 git(f.repo,'tag','v1.0.1');
 const pkg2=await packageAt(f.repo,f.root,'v1.0.1',secondCommit,'package-two');
  const extra=join(pkg2.target,'unlisted.bin');writeFileSync(extra,'extra');
  try{await assert.rejects(stageAt(pkg2,installRoot),/release_package_inventory_mismatch/);}
  finally{rmSync(extra,{force:true});}
  assert.equal(readDeploymentState(installRoot).active.releaseId,staged1.releaseId);
  const previousProof=releaseOperations.verifyInstalledRelease({installRoot,releaseId:staged1.releaseId,
   expectedManifestSha256:pkg1.manifestSha256,expectedRuntimeSha256:staged1.runtimeSha256});
  assert.equal(previousProof.completeRuntimeProof,true);
  assert.equal(previousProof.runtimeSha256,staged1.runtimeSha256);
  assert.deepEqual(readdirSync(join(installRoot,'releases')),[staged1.releaseId]);
 const staged2=await stageAt(pkg2,installRoot);
 const newHealth=await launchFakeHealthServer();
 t.after(()=>newHealth.server.close());
 const update=await activateRelease({installRoot,releaseId:staged2.releaseId,expectedManifestSha256:pkg2.manifestSha256,expectedRuntimeSha256:staged2.runtimeSha256,backupId:point.backupId,drained:true,healthUrl:newHealth.url,profile:'standalone',healthProbe:async()=>true,hostBackupScript});
 assert.equal(update.previousReleaseId,staged1.releaseId);
 assert.equal(readDeploymentState(installRoot).active.releaseId,staged2.releaseId);
 const rollback=await rollbackRelease({installRoot,restoreReleaseId:staged1.releaseId,backupId:point.backupId,drained:true,healthUrl:oldHealth.url,profile:'standalone',healthProbe:async()=>true,hostBackupScript});
 assert.equal(rollback.activeReleaseId,staged1.releaseId);
 assert.equal(readDeploymentState(installRoot).active.releaseId,staged1.releaseId);
 const db=new DatabaseSync(host.database,{readOnly:true});
 assert.equal(db.prepare('SELECT value FROM state').get().value,'outcome_unknown');
 db.close();
});

test('schema protocol drift, remote health URLs and absent drain acknowledgement are rejected before pointer writes',async t=>{
 const f=fixtureRoot(t);
 const pkg1=await packageAt(f.repo,f.root,'v1.0.0',f.firstCommit,'package-one');
 const installRoot=join(f.root,'deployment');mkdirSync(installRoot);
 const staged1=await stageAt(pkg1,installRoot);
 const health=await launchFakeHealthServer();
 t.after(()=>health.server.close());
 await activateRelease({installRoot,releaseId:staged1.releaseId,expectedManifestSha256:pkg1.manifestSha256,expectedRuntimeSha256:staged1.runtimeSha256,drained:true,healthUrl:health.url,profile:'standalone',healthProbe:async()=>true});
 const host=backupFixture(f.root);
 const point=await createRecoveryPoint({installRoot,releaseId:staged1.releaseId,privateBackupConfig:host.privateBackupConfig,target:join(f.root,'recovery') ,hostBackupScript});
 writeFileSync(join(f.repo,'packages/gateway/src/db/schema.sql'),'DROP TABLE stable_fixture;\n');
 git(f.repo,'add','packages/gateway/src/db/schema.sql');
 git(f.repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--no-gpg-sign','-m','unsafe migration');
 const commit=git(f.repo,'rev-parse','HEAD');git(f.repo,'tag','v1.0.1');
 const pkg2=await packageAt(f.repo,f.root,'v1.0.1',commit,'package-two');
 const staged2=await stageAt(pkg2,installRoot);
 await assert.rejects(activateRelease({installRoot,releaseId:staged2.releaseId,expectedManifestSha256:pkg2.manifestSha256,expectedRuntimeSha256:staged2.runtimeSha256,backupId:point.backupId,drained:true,healthUrl:health.url,profile:'standalone',healthProbe:async()=>true,hostBackupScript}),/release_migration_protocol_changed/);
 assert.equal(readDeploymentState(installRoot).active.releaseId,staged1.releaseId);
 await assert.rejects(activateRelease({installRoot,releaseId:staged2.releaseId,expectedManifestSha256:pkg2.manifestSha256,expectedRuntimeSha256:staged2.runtimeSha256,backupId:point.backupId,drained:true,healthUrl:'https://example.invalid/healthz',profile:'gateway',healthProbe:async()=>true}),/release_health_url_must_be_loopback/);
 assert.equal(verifyReleasePackage({packageRoot:pkg2.target,expectedManifestSha256:pkg2.manifestSha256}).sourceCommit,commit);
});

function fixtureRootWithTestOnlyPackages(t){
 const fixture=fixtureRoot(t);
 for(const prefix of ['','packages/gateway']){
  const packagePath=join(fixture.repo,prefix,'package.json'),lockPath=join(fixture.repo,prefix,'package-lock.json');
  const manifest=JSON.parse(readFileSync(packagePath,'utf8')),lock=JSON.parse(readFileSync(lockPath,'utf8'));
  manifest.dependencies={...manifest.dependencies,pino:'10.3.1','secure-json-parse':'4.1.0'};
  lock.packages[''].dependencies=manifest.dependencies;
  lock.packages['node_modules/pino']={version:'10.3.1',resolved:'https://registry.npmjs.org/pino/-/pino-10.3.1.tgz',integrity:'sha512-Zml4dHVyZS1wcm9kdWN0aW9u'};
  lock.packages['node_modules/secure-json-parse']={version:'4.1.0',resolved:'https://registry.npmjs.org/secure-json-parse/-/secure-json-parse-4.1.0.tgz',integrity:'sha512-Zml4dHVyZS1wcm9kdWN0aW9u'};
  writeFileSync(packagePath,JSON.stringify(manifest,null,2));
  writeFileSync(lockPath,JSON.stringify(lock,null,2));
 }
 git(fixture.repo,'add','.');
 git(fixture.repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--no-gpg-sign','-m','fixture nested test-only dependency trees');
 const commit=git(fixture.repo,'rev-parse','HEAD');git(fixture.repo,'tag','v1.0.1');
 return {...fixture,testOnlyCommit:commit};
}

test('staging removes only the two known test-only dependency subtrees for standalone and gateway',async t=>{
 const f=fixtureRootWithTestOnlyPackages(t),pkg=await packageAt(f.repo,f.root,'v1.0.1',f.testOnlyCommit,'package-with-test-only-trees');
 for(const profile of ['standalone','gateway']){
  const installRoot=join(f.root,`install-${profile}`),modules=profile==='standalone'?'node_modules':'packages/gateway/node_modules';
  const runCommand=async input=>{
   const result=await fakeBuild(input);
   if(input.args[0]==='ci'){
    const pino=join(input.cwd,'node_modules','pino'),transport=join(pino,'test','fixtures','transport');
    const secure=join(input.cwd,'node_modules','secure-json-parse'),benchmarks=join(secure,'benchmarks');
    mkdirSync(transport,{recursive:true});mkdirSync(benchmarks,{recursive:true});
    writeFileSync(join(transport,'package.json'),JSON.stringify({name:'transport',version:'0.0.1'}));
    writeFileSync(join(transport,'index.js'),'export const testFixture = true;\n');
    writeFileSync(join(benchmarks,'package.json'),JSON.stringify({name:'benchmarks',version:'1.0.0'}));
    writeFileSync(join(benchmarks,'index.js'),'export const benchmarkFixture = true;\n');
    mkdirSync(join(pino,'test','fixtures'),{recursive:true});
    writeFileSync(join(pino,'test','fixtures','retained.js'),'export const retained = true;\n');
    mkdirSync(join(secure,'benchmark-data'),{recursive:true});
    writeFileSync(join(secure,'benchmark-data','retained.js'),'export const retained = true;\n');
   }
   return result;
  };
  const staged=await stageRelease({packageRoot:pkg.target,expectedManifestSha256:pkg.manifestSha256,installRoot,profile,runCommand});
  const releaseRoot=join(installRoot,'releases',staged.releaseId),runtime=JSON.parse(readFileSync(join(releaseRoot,runtimeManifestName),'utf8'));
  const removed=[`${modules}/pino/test/fixtures/transport`,`${modules}/secure-json-parse/benchmarks`];
  assert.deepEqual(runtime.files.filter(file=>removed.some(path=>file.path===path||file.path.startsWith(path+'/'))),[]);
  assert.equal(existsSync(join(releaseRoot,modules,'pino','package.json')),true);
  assert.equal(existsSync(join(releaseRoot,modules,'secure-json-parse','package.json')),true);
  assert.equal(existsSync(join(releaseRoot,modules,'pino','test','fixtures','retained.js')),true);
  assert.equal(existsSync(join(releaseRoot,modules,'secure-json-parse','benchmark-data','retained.js')),true);
  assert.equal(h(readFileSync(join(releaseRoot,'package-lock.json'))),runtime.sourceLocks.root);
  assert.equal(h(readFileSync(join(releaseRoot,'packages/gateway/package-lock.json'))),runtime.sourceLocks.gateway);
 }
});
