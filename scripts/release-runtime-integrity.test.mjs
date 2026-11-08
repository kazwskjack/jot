import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,renameSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve,toNamespacedPath} from 'node:path';
import {fileURLToPath} from 'node:url';

let integrity={};
try{integrity=await import('./release-runtime-integrity.mjs');}catch{}

const workspace=dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot=join(workspace,'.test-tmp');
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']'
 :value&&typeof value==='object'?'{' +Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}'
 :JSON.stringify(value);
const encode=value=>canonical(value)+'\n';
const put=(root,path,value)=>{const target=join(root,...path.split('/'));mkdirSync(dirname(target),{recursive:true});writeFileSync(target,typeof value==='string'?value:encode(value));};

function fixtureRoot(t){
 const root=join(temporaryRoot,'release-runtime-'+randomUUID());mkdirSync(root,{recursive:true});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const rootPackage={name:'fixture-runtime',version:'1.0.0',license:'Apache-2.0',dependencies:{fastify:'5.12.5'},devDependencies:{'fixture-build-tool':'1.0.0'}};
 const gatewayPackage={name:'@fixture/gateway',version:'1.0.0',license:'Apache-2.0',dependencies:{}};
 const rootLock={name:rootPackage.name,version:rootPackage.version,lockfileVersion:3,packages:{
  '':{name:rootPackage.name,version:rootPackage.version,dependencies:rootPackage.dependencies,devDependencies:rootPackage.devDependencies},
  'node_modules/fastify':{version:'5.12.5',resolved:'https://registry.npmjs.org/fastify/-/fastify-5.12.5.tgz',integrity:'sha512-Zml4dHVyZS1pbnRlZ3JpdHk=',license:'MIT'},
  'node_modules/fixture-build-tool':{version:'1.0.0',resolved:'https://registry.npmjs.org/fixture-build-tool/-/fixture-build-tool-1.0.0.tgz',integrity:'sha512-ZGV2LW9ubHk=',dev:true}
 }};
 const gatewayLock={name:gatewayPackage.name,version:gatewayPackage.version,lockfileVersion:3,packages:{'':{name:gatewayPackage.name,version:gatewayPackage.version,dependencies:{}}}};
 put(root,'package.json',rootPackage);put(root,'package-lock.json',rootLock);
 put(root,'packages/gateway/package.json',gatewayPackage);put(root,'packages/gateway/package-lock.json',gatewayLock);
 put(root,'LICENSE','Apache License\n');put(root,'NOTICE','fixture notice\n');put(root,'THIRD_PARTY_NOTICES.md','fixture package license evidence\n');
 put(root,'src/server.mjs','export const fixture = true;\n');
 put(root,'node_modules/fastify/package.json',{name:'fastify',version:'5.12.5',license:'MIT'});
 put(root,'node_modules/fastify/index.js','export default {};\n');put(root,'node_modules/fastify/LICENSE','MIT fixture license\n');
 const sourceLocks={root:hash(encode(rootLock)),gateway:hash(encode(gatewayLock))};
 const sourceManifest={protocol:1,source:{tag:'v1.0.0',commit:'a'.repeat(40)},license:{root:'Apache-2.0',gateway:'Apache-2.0',notices:{}},
  packages:{root:{lockSha256:sourceLocks.root},gateway:{lockSha256:sourceLocks.gateway}},databaseProtocol:{files:[],sha256:hash('[]')},files:[]};
 const sourceManifestSha256=hash(canonical(sourceManifest));put(root,'release-manifest.json',sourceManifest);
 return {root,sourceLocks,sourceManifestSha256};
}
function createAndWriteRuntime(fixture){
 const created=integrity.createRuntimeManifest({root:fixture.root,profile:'standalone',sourceManifestSha256:fixture.sourceManifestSha256,
  sourceLocks:fixture.sourceLocks,npmVersion:'10.9.2'});
 put(fixture.root,'release-runtime.json',created.manifest);return created;
}
function desktopRuntimeFixture(t){
 const root=join(temporaryRoot,'release-runtime-desktop-'+randomUUID());mkdirSync(root,{recursive:true});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const appLockSha256='4'.repeat(64),runtimeReceiptSha256='3'.repeat(64),executable='electron executable fixture\n';
 const target={profile:'desktop-electron',runtimeKind:'electron',electronVersion:'45.0.0',platform:'win32',arch:'x64',nodeVersion:'24.22.0',
  abi:{node:'150',napi:'10'},electronArchiveSha256:'2'.repeat(64),electronExecutableSha256:hash(executable)};
 const portable={protocol:'jot.desktop.portable.v1',sourceCommit:'a'.repeat(40),appLockSha256,
  runtimeReceiptSha256,appVersion:'0.1.0',target:{platform:'win32',arch:'x64'},electron:{version:target.electronVersion,
   platform:target.platform,arch:target.arch,nodeVersion:target.nodeVersion,nodeModuleAbi:target.abi.node,napiVersion:target.abi.napi,
   archiveSha256:target.electronArchiveSha256,executableSha256:target.electronExecutableSha256}};
 const raw=JSON.stringify(portable,null,2)+'\n',sourceManifestSha256=hash(raw);
 writeFileSync(join(root,'portable-package-manifest.json'),raw);
 writeFileSync(join(root,'portable-package-manifest.sha256'),sourceManifestSha256+'  portable-package-manifest.json\n');
 put(root,'Jot.exe',executable);
 put(root,'resources/app/package.json',{name:'jot-desktop-runtime',version:'0.1.0',type:'module',main:'apps/desktop/main-entry.mjs',dependencies:{fastify:'5.12.5'}});
 put(root,'resources/app/apps/desktop/main-entry.mjs','export const entry=true;\n');
 put(root,'resources/app/node_modules/fastify/package.json',{name:'fastify',version:'5.12.5',license:'MIT'});
 put(root,'resources/app/node_modules/fastify/index.js','export default {};\n');
 put(root,'resources/app/node_modules/fastify/LICENSE','MIT fixture license\n');
 return {root,sourceManifestSha256,sourceLocks:{desktop:appLockSha256},target};
}
function replaceRootLock(fixture,lock){
 put(fixture.root,'package-lock.json',lock);fixture.sourceLocks.root=hash(encode(lock));
 const source=JSON.parse(readFileSync(join(fixture.root,'release-manifest.json'),'utf8'));
 source.packages.root.lockSha256=fixture.sourceLocks.root;fixture.sourceManifestSha256=hash(canonical(source));
 put(fixture.root,'release-manifest.json',source);
}
function verifyRuntime(fixture,created){
 return integrity.verifyRuntimeManifest({root:fixture.root,expectedRuntimeSha256:created.runtimeSha256,
  expectedSourceManifestSha256:fixture.sourceManifestSha256,expectedTarget:created.target});
}
function addSymlinkOrSkip(t,target,path,type){
 try{symlinkSync(target,path,type);}
 catch(error){if(process.platform==='win32'&&['EPERM','EACCES','ENOTSUP','UNKNOWN'].includes(error?.code)){t.skip('Windows symlink creation is unavailable in this account');return false;}throw error;}
 return true;
}

test('creates and verifies a target-bound runtime manifest covering installed package and license bytes',t=>{
 assert.equal(typeof integrity.createRuntimeManifest,'function');
 assert.equal(typeof integrity.verifyRuntimeManifest,'function');
 const fixture=fixtureRoot(t);
 put(fixture.root,'node_modules/fastify/test/fixtures/package.json',{name:'fixture-data',version:'0.0.0'});
 put(fixture.root,'node_modules/fastify/test/fixtures/eval/node_modules/14-files.js','fixture data under package-internal node_modules path\n');
 put(fixture.root,'node_modules/fastify/third_party_notices.txt','MIT and ISC notices\n');
 put(fixture.root,'node_modules/fastify/licenses/MIT.txt','MIT fixture license detail\n');
 const first=integrity.createRuntimeManifest({root:fixture.root,profile:'standalone',sourceManifestSha256:fixture.sourceManifestSha256,
  sourceLocks:fixture.sourceLocks,npmVersion:'10.9.2'});
 const second=integrity.createRuntimeManifest({root:fixture.root,profile:'standalone',sourceManifestSha256:fixture.sourceManifestSha256,
  sourceLocks:fixture.sourceLocks,npmVersion:'10.9.2'});
 assert.equal(first.runtimeSha256,second.runtimeSha256);
 assert.deepEqual(first.manifest.sourceLocks,fixture.sourceLocks);
 assert.equal(first.manifest.target.profile,'standalone');
 assert.equal(first.manifest.target.nodeVersion,process.version);
 assert.ok(first.manifest.files.some(file=>file.path==='node_modules/fastify/index.js'&&file.type==='file'));
 assert.ok(first.manifest.files.some(file=>file.path==='node_modules/fastify/test/fixtures/eval/node_modules/14-files.js'&&file.type==='file'));
 assert.ok(first.manifest.packages.some(pkg=>pkg.name==='fastify'&&pkg.version==='5.12.5'&&pkg.resolved.endsWith('fastify-5.12.5.tgz')
  &&pkg.integrity==='sha512-Zml4dHVyZS1pbnRlZ3JpdHk='&&pkg.license==='MIT'
  &&pkg.licenseFiles.some(file=>file.path==='node_modules/fastify/LICENSE')
  &&pkg.licenseFiles.some(file=>file.path==='node_modules/fastify/third_party_notices.txt')
  &&pkg.licenseFiles.some(file=>file.path==='node_modules/fastify/licenses/MIT.txt')));
 put(fixture.root,'release-runtime.json',first.manifest);
 const verified=integrity.verifyRuntimeManifest({root:fixture.root,expectedRuntimeSha256:first.runtimeSha256,
  expectedSourceManifestSha256:fixture.sourceManifestSha256,expectedTarget:first.target});
 assert.equal(verified.runtimeSha256,first.runtimeSha256);
 assert.deepEqual(verified.target,first.target);
});

test('creates and verifies desktop-electron protocol 3 from the portable manifest and Electron target',t=>{
 const fixture=desktopRuntimeFixture(t);
 const created=integrity.createRuntimeManifest({root:fixture.root,profile:'desktop-electron',sourceManifestSha256:fixture.sourceManifestSha256,
  sourceLocks:fixture.sourceLocks,target:fixture.target});
 assert.equal(created.manifest.protocol,3);
 assert.deepEqual(created.manifest.sourceLocks,{desktop:'4'.repeat(64)});
 assert.equal(created.manifest.lockSha256,'4'.repeat(64));
 assert.deepEqual(created.target,fixture.target);
 assert.ok(created.manifest.files.some(file=>file.path==='portable-package-manifest.json'&&file.type==='file'));
 assert.ok(created.manifest.files.some(file=>file.path==='portable-package-manifest.sha256'&&file.type==='file'));
 put(fixture.root,'release-runtime.json',created.manifest);
 const verified=integrity.verifyRuntimeManifest({root:fixture.root,expectedRuntimeSha256:created.runtimeSha256,
  expectedSourceManifestSha256:fixture.sourceManifestSha256,expectedTarget:fixture.target});
 assert.equal(verified.runtimeSha256,created.runtimeSha256);
 assert.equal(verified.manifest.protocol,3);
});

test('rejects desktop runtimes whose Electron package main entry is missing',t=>{
 const createFixture=desktopRuntimeFixture(t),entryPath='resources/app/apps/desktop/main-entry.mjs';
 unlinkSync(join(createFixture.root,...entryPath.split('/')));
 assert.throws(()=>integrity.createRuntimeManifest({root:createFixture.root,profile:'desktop-electron',
  sourceManifestSha256:createFixture.sourceManifestSha256,sourceLocks:createFixture.sourceLocks,target:createFixture.target}),
 /release_runtime_dependency_mismatch/);

 const verifyFixture=desktopRuntimeFixture(t);
 const created=integrity.createRuntimeManifest({root:verifyFixture.root,profile:'desktop-electron',
  sourceManifestSha256:verifyFixture.sourceManifestSha256,sourceLocks:verifyFixture.sourceLocks,target:verifyFixture.target});
 unlinkSync(join(verifyFixture.root,...entryPath.split('/')));
 const forged={...created.manifest,files:created.manifest.files.filter(file=>file.path!==entryPath)};
 delete forged.sha256;
 forged.sha256=hash(canonical(forged));
 put(verifyFixture.root,'release-runtime.json',forged);
 assert.throws(()=>integrity.verifyRuntimeManifest({root:verifyFixture.root,expectedRuntimeSha256:forged.sha256,
  expectedSourceManifestSha256:verifyFixture.sourceManifestSha256,expectedTarget:verifyFixture.target}),
 /release_runtime_dependency_mismatch/);
});

test('records nested npm dependency packages at their exact lockfile installation paths',t=>{
 const fixture=fixtureRoot(t);
 rmSync(join(fixture.root,'node_modules'),{recursive:true,force:true});
 const gatewayPackagePath=join(fixture.root,'packages/gateway/package.json');
 const gatewayPackage=JSON.parse(readFileSync(gatewayPackagePath,'utf8'));
 gatewayPackage.dependencies={parent:'1.0.0'};put(fixture.root,'packages/gateway/package.json',gatewayPackage);
 const gatewayLockPath=join(fixture.root,'packages/gateway/package-lock.json');
 const gatewayLock=JSON.parse(readFileSync(gatewayLockPath,'utf8'));
 gatewayLock.packages[''].dependencies={parent:'1.0.0'};
 gatewayLock.packages['node_modules/parent']={version:'1.0.0',resolved:'https://registry.npmjs.org/parent/-/parent-1.0.0.tgz',
  integrity:'sha512-cGFyZW50',dependencies:{nested:'2.0.0'}};
 gatewayLock.packages['node_modules/parent/node_modules/nested']={version:'2.0.0',resolved:'https://registry.npmjs.org/nested/-/nested-2.0.0.tgz',integrity:'sha512-bmVzdGVk'};
 put(fixture.root,'packages/gateway/package-lock.json',gatewayLock);
 put(fixture.root,'packages/gateway/node_modules/parent/package.json',{name:'parent',version:'1.0.0',license:'MIT',dependencies:{nested:'2.0.0'}});
 put(fixture.root,'packages/gateway/node_modules/parent/index.js','export default 1;\n');
 put(fixture.root,'packages/gateway/node_modules/parent/node_modules/nested/package.json',{name:'nested',version:'2.0.0',license:'ISC'});
 put(fixture.root,'packages/gateway/node_modules/parent/node_modules/nested/index.js','export default 2;\n');
 fixture.sourceLocks.gateway=hash(encode(gatewayLock));
 const sourceManifest=JSON.parse(readFileSync(join(fixture.root,'release-manifest.json'),'utf8'));
 sourceManifest.packages.gateway.lockSha256=fixture.sourceLocks.gateway;
 fixture.sourceManifestSha256=hash(canonical(sourceManifest));put(fixture.root,'release-manifest.json',sourceManifest);
 const created=integrity.createRuntimeManifest({root:fixture.root,profile:'gateway',sourceManifestSha256:fixture.sourceManifestSha256,
  sourceLocks:fixture.sourceLocks,npmVersion:'10.9.2'});
 assert.ok(created.manifest.packages.some(pkg=>pkg.installPath==='packages/gateway/node_modules/parent/node_modules/nested'
  &&pkg.name==='nested'&&pkg.version==='2.0.0'));
});

test('rejects package-less importable files and installed packages outside the selected profile lock',t=>{
 const fixture=fixtureRoot(t);
 put(fixture.root,'node_modules/unlocked/index.js','export default 1;\n');
 assert.throws(()=>integrity.createRuntimeManifest({root:fixture.root,profile:'standalone',sourceManifestSha256:fixture.sourceManifestSha256,
  sourceLocks:fixture.sourceLocks,npmVersion:'10.9.2'}),/release_runtime_dependency_mismatch/);
 rmSync(join(fixture.root,'node_modules/unlocked'),{recursive:true,force:true});
 put(fixture.root,'packages/gateway/node_modules/unlocked/index.js','export default 2;\n');
 assert.throws(()=>integrity.createRuntimeManifest({root:fixture.root,profile:'standalone',sourceManifestSha256:fixture.sourceManifestSha256,
  sourceLocks:fixture.sourceLocks,npmVersion:'10.9.2'}),/release_runtime_dependency_mismatch/);
});

test('rejects lockfile-linked packages without complete registry package evidence',t=>{
 const fixture=fixtureRoot(t),lock=JSON.parse(readFileSync(join(fixture.root,'package-lock.json'),'utf8'));
 lock.packages['node_modules/workspace-link']={version:'1.0.0',resolved:'',link:true};replaceRootLock(fixture,lock);
 assert.throws(()=>integrity.createRuntimeManifest({root:fixture.root,profile:'standalone',sourceManifestSha256:fixture.sourceManifestSha256,
  sourceLocks:fixture.sourceLocks,npmVersion:'10.9.2'}),/release_runtime_dependency_mismatch/);
});

test('refuses mutable configuration, user data, and cache paths inside the sealed runtime tree',t=>{
 const fixture=fixtureRoot(t);
 put(fixture.root,'.env','TOKEN=private-fixture-value\n');
 put(fixture.root,'.data/user.json',{value:'mutable'});
 assert.throws(()=>integrity.createRuntimeManifest({root:fixture.root,profile:'standalone',sourceManifestSha256:fixture.sourceManifestSha256,
  sourceLocks:fixture.sourceLocks,npmVersion:'10.9.2'}),/release_runtime_mutable_path/);
});

test('rejects a non-file occupying the runtime manifest path instead of omitting it',t=>{
 const fixture=fixtureRoot(t);mkdirSync(join(fixture.root,'release-runtime.json'));
 assert.throws(()=>integrity.createRuntimeManifest({root:fixture.root,profile:'standalone',sourceManifestSha256:fixture.sourceManifestSha256,
  sourceLocks:fixture.sourceLocks,npmVersion:'10.9.2'}),/release_runtime_manifest_invalid/);
});

test('fails closed on changed, missing, extra, and unreadable runtime files',t=>{
 const fixture=fixtureRoot(t),created=createAndWriteRuntime(fixture),entry=join(fixture.root,'node_modules/fastify/index.js');
 writeFileSync(entry,'changed bytes\n');assert.throws(()=>verifyRuntime(fixture,created),/release_runtime_hash_mismatch/);
 writeFileSync(entry,'export default {};\n');
 put(fixture.root,'node_modules/fastify/extra.bin','extra\n');assert.throws(()=>verifyRuntime(fixture,created),/release_runtime_hash_mismatch/);
 rmSync(join(fixture.root,'node_modules/fastify/extra.bin'));
 rmSync(entry);assert.throws(()=>verifyRuntime(fixture,created),/release_runtime_hash_mismatch/);
 writeFileSync(entry,'export default {};\n');
 const lock=join(fixture.root,'package-lock.json'),moved=join(fixture.root,'package-lock.saved');
 renameSync(lock,moved);mkdirSync(lock);assert.throws(()=>verifyRuntime(fixture,created),/release_runtime_lock_mismatch/);
 rmSync(lock,{recursive:true,force:true});renameSync(moved,lock);
});

test('rejects runtime manifest target tampering, case collisions, and unknown entry types',t=>{
 const fixture=fixtureRoot(t),created=createAndWriteRuntime(fixture),path=join(fixture.root,'release-runtime.json');
 assert.throws(()=>integrity.verifyRuntimeManifest({root:fixture.root,expectedRuntimeSha256:created.runtimeSha256,
  expectedSourceManifestSha256:fixture.sourceManifestSha256,expectedTarget:{...created.target,npmVersion:'10.9.3'}}),/release_runtime_target_mismatch/);
 const rewrite=files=>{
  const {sha256,...manifest}=created.manifest;manifest.files=files;manifest.sha256=hash(canonical(manifest));
  writeFileSync(path,encode(manifest));return manifest.sha256;
 };
 const duplicate=[...created.manifest.files,{path:'license',type:'file',bytes:0,sha256:'0'.repeat(64)}].sort((a,b)=>a.path.localeCompare(b.path,'en'));
 const duplicateDigest=rewrite(duplicate);
 assert.throws(()=>integrity.verifyRuntimeManifest({root:fixture.root,expectedRuntimeSha256:duplicateDigest,
  expectedSourceManifestSha256:fixture.sourceManifestSha256,expectedTarget:created.target}),/release_runtime_case_collision/);
 const unsupported=created.manifest.files.map(file=>file.path==='src/server.mjs'?{path:file.path,type:'socket'}:file);
 const unsupportedDigest=rewrite(unsupported);
 assert.throws(()=>integrity.verifyRuntimeManifest({root:fixture.root,expectedRuntimeSha256:unsupportedDigest,
  expectedSourceManifestSha256:fixture.sourceManifestSha256,expectedTarget:created.target}),/release_runtime_manifest_invalid/);
});

test('records and rechecks internal symlink targets while rejecting links outside the release root',t=>{
 const fixture=fixtureRoot(t),inside=join(fixture.root,'node_modules/fastify/alias.js');
 if(!addSymlinkOrSkip(t,'index.js',inside,'file'))return;
 const created=createAndWriteRuntime(fixture);
 assert.ok(created.manifest.files.some(file=>file.path==='node_modules/fastify/alias.js'&&file.type==='symlink'&&file.target==='index.js'));
 verifyRuntime(fixture,created);
 unlinkSync(inside);symlinkSync('LICENSE',inside,'file');
 assert.throws(()=>verifyRuntime(fixture,created),/release_runtime_hash_mismatch/);
 const outside=join(fixture.root,'outside.txt');writeFileSync(outside,'outside\n');
 unlinkSync(inside);symlinkSync(outside,inside,'file');
 assert.throws(()=>integrity.createRuntimeManifest({root:fixture.root,profile:'standalone',sourceManifestSha256:fixture.sourceManifestSha256,
  sourceLocks:fixture.sourceLocks,npmVersion:'10.9.2'}),/release_runtime_symlink_escape/);
});

test('validates internal, escaping, and cyclic link targets through the same path policy used by inventory',t=>{
 assert.equal(typeof integrity.validateRuntimeSymlink,'function');
 assert.equal(typeof integrity.assertNoDirectorySymlinkCycles,'function');
 const root=resolve(temporaryRoot,'link-policy-root'),parent=join(root,'node_modules/fastify'),link=join(parent,'alias.js');
 const normalize=value=>value.startsWith('\\\\?\\')?value.slice(4):value;
 const realpath=value=>{
  const path=normalize(value);
  if(path.toLowerCase()===root.toLowerCase())return root;
  if(path.toLowerCase()===parent.toLowerCase())return parent;
  return path;
 };
 const fileStat={isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false};
 const directoryStat={isFile:()=>false,isDirectory:()=>true,isSymbolicLink:()=>false};
 assert.equal(integrity.validateRuntimeSymlink({root,path:'node_modules/fastify/alias.js',target:'index.js',realpath,lstat:()=>fileStat}),'index.js');
 assert.throws(()=>integrity.validateRuntimeSymlink({root,path:'node_modules/fastify/alias.js',target:'../../../../outside.txt',realpath,lstat:()=>fileStat}),/release_runtime_symlink_escape/);
 assert.throws(()=>integrity.validateRuntimeSymlink({root,path:'node_modules/fastify/loop',target:'.',realpath,lstat:()=>directoryStat}),/release_runtime_symlink_cycle/);
 const cycleRoot=resolve(temporaryRoot,'directory-link-cycle'),a=join(cycleRoot,'a'),b=join(cycleRoot,'b');
 const key=value=>normalize(value).toLowerCase(),symlinkStat={isFile:()=>false,isDirectory:()=>false,isSymbolicLink:()=>true};
 const readdir=path=>key(path)===key(cycleRoot)?[{name:'a'},{name:'b'}]
  :key(path)===key(a)?[{name:'link'}]:key(path)===key(b)?[{name:'link'}]:[];
 const lstat=path=>[key(a),key(b)].includes(key(path))?directoryStat
  :[key(join(a,'link')),key(join(b,'link'))].includes(key(path))?symlinkStat:fileStat;
 const readlink=path=>key(path)===key(join(a,'link'))?'../b':'../a';
 const stat=()=>directoryStat;
 const cycleRealpath=path=>normalize(path);
 assert.throws(()=>integrity.assertNoDirectorySymlinkCycles({root:cycleRoot,readdir,lstat,readlink,realpath:cycleRealpath,stat}),/release_runtime_symlink_cycle/);
});

test('rejects a directory symlink that resolves back into its own ancestor',t=>{
 const fixture=fixtureRoot(t),directory=join(fixture.root,'node_modules/fastify'),loop=join(directory,'loop');
 if(!addSymlinkOrSkip(t,directory,loop,'junction'))return;
 assert.throws(()=>integrity.createRuntimeManifest({root:fixture.root,profile:'standalone',sourceManifestSha256:fixture.sourceManifestSha256,
  sourceLocks:fixture.sourceLocks,npmVersion:'10.9.2'}),/release_runtime_symlink_cycle/);
});

test('inventories and verifies runtime files whose Windows paths exceed MAX_PATH',t=>{
 const fixture=fixtureRoot(t),parts=Array.from({length:14},()=>`long-segment-${'x'.repeat(12)}`),longRelative=parts.join('/')+'/payload.bin';
 const target=toNamespacedPath(resolve(fixture.root,...parts,'payload.bin'));mkdirSync(dirname(target),{recursive:true});writeFileSync(target,'long path payload\n');
 assert.ok(join(fixture.root,longRelative).length>260);
 const created=createAndWriteRuntime(fixture);
 assert.ok(created.manifest.files.some(file=>file.path===longRelative&&file.type==='file'));
 assert.equal(verifyRuntime(fixture,created).runtimeSha256,created.runtimeSha256);
});
