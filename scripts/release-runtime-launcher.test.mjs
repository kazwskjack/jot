import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRuntimeManifest} from './release-runtime-integrity.mjs';
import {verifiedRuntimeEnvironment} from './release-runtime-launcher.mjs';

let launcher={};
try{launcher=await import('./release-runtime-launcher.mjs');}catch{}

const workspace=dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot=join(workspace,'.test-tmp');
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']'
 :value&&typeof value==='object'?'{' +Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}'
 :JSON.stringify(value);
const encode=value=>canonical(value)+'\n';
const put=(root,path,value)=>{const target=join(root,...path.split('/'));mkdirSync(dirname(target),{recursive:true});writeFileSync(target,typeof value==='string'?value:encode(value));};

function launchFixture(t){
 const root=mkdtempSync(join(temporaryRoot,'release-launcher-'+randomUUID()));
 const marker=join(temporaryRoot,'launcher-started-'+randomUUID()+'.txt');
 t.after(()=>{rmSync(root,{recursive:true,force:true});rmSync(marker,{force:true});});
 const rootPackage={name:'launcher-fixture',version:'1.0.0',license:'Apache-2.0',dependencies:{}};
 const gatewayPackage={name:'@fixture/gateway',version:'1.0.0',license:'Apache-2.0',dependencies:{}};
 const rootLock={name:rootPackage.name,version:rootPackage.version,lockfileVersion:3,packages:{'':{name:rootPackage.name,version:rootPackage.version,dependencies:{}}}};
 const gatewayLock={name:gatewayPackage.name,version:gatewayPackage.version,lockfileVersion:3,packages:{'':{name:gatewayPackage.name,version:gatewayPackage.version,dependencies:{}}}};
 put(root,'package.json',rootPackage);put(root,'package-lock.json',rootLock);
 put(root,'packages/gateway/package.json',gatewayPackage);put(root,'packages/gateway/package-lock.json',gatewayLock);
 put(root,'LICENSE','Apache fixture\n');put(root,'NOTICE','notice fixture\n');put(root,'THIRD_PARTY_NOTICES.md','no package deps\n');
 put(root,'src/entry.mjs',`import {writeFileSync} from 'node:fs';\nwriteFileSync(process.argv[2], 'started');\n`);
 const sourceLocks={root:hash(encode(rootLock)),gateway:hash(encode(gatewayLock))};
 const source={protocol:1,source:{tag:'v1.0.0',commit:'b'.repeat(40)},license:{root:'Apache-2.0',gateway:'Apache-2.0',notices:{}},
  packages:{root:{lockSha256:sourceLocks.root},gateway:{lockSha256:sourceLocks.gateway}},databaseProtocol:{files:[],sha256:hash('[]')},files:[]};
 put(root,'release-manifest.json',source);
 const sourceManifestSha256=hash(canonical(source));
 const created=createRuntimeManifest({root,profile:'standalone',sourceManifestSha256,sourceLocks,npmVersion:'10.9.2'});
 put(root,'release-runtime.json',created.manifest);
 return {root,marker,sourceManifestSha256,created};
}
function desktopLaunchFixture(t){
 const root=mkdtempSync(join(temporaryRoot,'release-launcher-desktop-'+randomUUID()));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const appLockSha256='4'.repeat(64),executable='Electron binary fixture\n';
 const target={profile:'desktop-electron',runtimeKind:'electron',electronVersion:'45.0.0',platform:'win32',arch:'x64',nodeVersion:'24.22.0',
  abi:{node:'150',napi:'10'},electronArchiveSha256:'2'.repeat(64),electronExecutableSha256:hash(executable)};
 const source={protocol:'jot.desktop.portable.v1',sourceCommit:'c'.repeat(40),appLockSha256,runtimeReceiptSha256:'3'.repeat(64),
  appVersion:'0.1.0',target:{platform:'win32',arch:'x64'},electron:{version:target.electronVersion,platform:target.platform,arch:target.arch,
   nodeVersion:target.nodeVersion,nodeModuleAbi:target.abi.node,napiVersion:target.abi.napi,archiveSha256:target.electronArchiveSha256,
   executableSha256:target.electronExecutableSha256}};
 const raw=JSON.stringify(source,null,2)+'\n',sourceManifestSha256=hash(raw);
 writeFileSync(join(root,'portable-package-manifest.json'),raw);
 writeFileSync(join(root,'portable-package-manifest.sha256'),sourceManifestSha256+'  portable-package-manifest.json\n');
 put(root,'Jot.exe',executable);
 put(root,'resources/app/package.json',{name:'jot-desktop-runtime',version:'0.1.0',type:'module',main:'apps/desktop/main-entry.mjs',dependencies:{fastify:'5.12.5'}});
 put(root,'resources/app/apps/desktop/main-entry.mjs','export const main=true;\n');
 put(root,'resources/app/node_modules/fastify/package.json',{name:'fastify',version:'5.12.5',license:'MIT'});
 put(root,'resources/app/node_modules/fastify/index.js','export default {};\n');
 const created=createRuntimeManifest({root,profile:'desktop-electron',sourceManifestSha256,sourceLocks:{desktop:appLockSha256},target});
 put(root,'release-runtime.json',created.manifest);
 return {root,sourceManifestSha256,created,target};
}

test('does not start payload code when the externally pinned runtime digest is wrong',async t=>{
 assert.equal(typeof launcher.launchVerifiedRuntime,'function');
 const fixture=launchFixture(t);
 await assert.rejects(launcher.launchVerifiedRuntime({root:fixture.root,cwd:fixture.root,entryRelative:'src/entry.mjs',args:[fixture.marker],
  expectedRuntimeSha256:'f'.repeat(64),expectedSourceManifestSha256:fixture.sourceManifestSha256,expectedTarget:fixture.created.target}),/release_runtime_digest_mismatch/);
 assert.equal(existsSync(fixture.marker),false);
});

test('starts a verified payload only after the v2 runtime proof passes',async t=>{
 assert.equal(typeof launcher.launchVerifiedRuntime,'function');
 const fixture=launchFixture(t);
 const result=await launcher.launchVerifiedRuntime({root:fixture.root,cwd:fixture.root,entryRelative:'src/entry.mjs',args:[fixture.marker],
  expectedRuntimeSha256:fixture.created.runtimeSha256,expectedSourceManifestSha256:fixture.sourceManifestSha256,expectedTarget:fixture.created.target});
 assert.equal(result.exitCode,0);
 assert.equal(result.runtimeSha256,fixture.created.runtimeSha256);
 assert.equal(readFileSync(fixture.marker,'utf8'),'started');
});

test('launches a verified Electron release by its pinned executable instead of host Node',async t=>{
 const fixture=desktopLaunchFixture(t),child=new EventEmitter();child.kill=()=>{};let invocation;
 const pending=launcher.launchVerifiedRuntime({root:fixture.root,cwd:fixture.root,entryRelative:'Jot.exe',runtimeKind:'electron',
  expectedRuntimeSha256:fixture.created.runtimeSha256,expectedSourceManifestSha256:fixture.sourceManifestSha256,
  expectedTarget:fixture.target,spawnRuntime(command,args,options){invocation={command,args,options};queueMicrotask(()=>child.emit('close',0,null));return child;}});
 const result=await pending;
 assert.equal(invocation.command,join(fixture.root,'Jot.exe'));
 assert.deepEqual(invocation.args,[]);
 assert.equal(result.exitCode,0);
 assert.equal(result.target.runtimeKind,'electron');
});

test('only an explicit verified restore nonce reaches the Electron Host environment',async t=>{
 const fixture=desktopLaunchFixture(t),nonce='33333333-3333-4333-8333-333333333333';let first,second;
 const launch=async({desktopRestoreNonce}={})=>{
  const child=new EventEmitter();child.kill=()=>{};let captured;
  const pending=launcher.launchVerifiedRuntime({root:fixture.root,cwd:fixture.root,entryRelative:'Jot.exe',runtimeKind:'electron',
   expectedRuntimeSha256:fixture.created.runtimeSha256,expectedSourceManifestSha256:fixture.sourceManifestSha256,
   expectedTarget:fixture.target,env:{JOT_DESKTOP_RESTORED_STARTUP_NONCE:'spoofed-from-parent'},
   ...(desktopRestoreNonce===undefined?{}:{desktopRestoreNonce}),spawnRuntime(command,args,options){
    captured={command,args,env:options.env};queueMicrotask(()=>child.emit('close',0,null));return child;
   }});
  await pending;
  return captured;
 };
 first=await launch();
 second=await launch({desktopRestoreNonce:nonce});
 assert.equal(first.env.JOT_DESKTOP_RESTORED_STARTUP_NONCE,undefined);
 assert.equal(second.env.JOT_DESKTOP_RESTORED_STARTUP_NONCE,nonce);
 assert.deepEqual(second.args,[]);
});

test('loads the mutable host env file and keeps application arguments after the verified entry',async t=>{
 assert.equal(typeof launcher.launchVerifiedRuntime,'function');
 const fixture=launchFixture(t);
 const envPath=join(temporaryRoot,'launcher-env-'+randomUUID()+'.env');
 t.after(()=>rmSync(envPath,{force:true}));
 writeFileSync(envPath,'RUNTIME_LAUNCHER_TEST_VALUE=from-env-file\n');
 put(fixture.root,'src/entry.mjs',`import {writeFileSync} from 'node:fs';\nwriteFileSync(process.argv[2], process.env.RUNTIME_LAUNCHER_TEST_VALUE ?? 'missing');\n`);
 fixture.created=createRuntimeManifest({root:fixture.root,profile:'standalone',sourceManifestSha256:fixture.sourceManifestSha256,
  sourceLocks:{root:hash(encode({name:'launcher-fixture',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'launcher-fixture',version:'1.0.0',dependencies:{}}}})),
   gateway:hash(encode({name:'@fixture/gateway',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'@fixture/gateway',version:'1.0.0',dependencies:{}}}}))},npmVersion:'10.9.2'});
 put(fixture.root,'release-runtime.json',fixture.created.manifest);
 const result=await launcher.launchVerifiedRuntime({root:fixture.root,cwd:fixture.root,entryRelative:'src/entry.mjs',
  envFile:envPath,args:[fixture.marker],expectedRuntimeSha256:fixture.created.runtimeSha256,
  expectedSourceManifestSha256:fixture.sourceManifestSha256,expectedTarget:fixture.created.target});
 assert.equal(result.exitCode,0);
 assert.equal(readFileSync(fixture.marker,'utf8'),'from-env-file');
});

test('removes inherited NODE_OPTIONS from the child runtime environment',()=>{
 const env=verifiedRuntimeEnvironment({env:{NODE_OPTIONS:'--require=untrusted.cjs',RUNTIME_LAUNCHER_TEST:'present'}});
 assert.equal(env.NODE_OPTIONS,undefined);
 assert.equal(env.RUNTIME_LAUNCHER_TEST,'present');
});

test('rejects NODE_OPTIONS from the mutable host env file before spawning Node',async t=>{
 const fixture=launchFixture(t),envPath=join(temporaryRoot,'launcher-node-options-'+randomUUID()+'.env');
 const preloadPath=join(temporaryRoot,'launcher-node-preload-'+randomUUID()+'.cjs');
 const preloadMarker=join(temporaryRoot,'launcher-node-preloaded-'+randomUUID()+'.txt');
 t.after(()=>{rmSync(envPath,{force:true});rmSync(preloadPath,{force:true});rmSync(preloadMarker,{force:true});});
 writeFileSync(preloadPath,`require('node:fs').writeFileSync(${JSON.stringify(preloadMarker)}, 'executed');\n`);
 writeFileSync(envPath,`NODE_OPTIONS=--require=${preloadPath}\n`);
 await assert.rejects(launcher.launchVerifiedRuntime({root:fixture.root,cwd:fixture.root,entryRelative:'src/entry.mjs',args:[fixture.marker],
  envFile:envPath,expectedRuntimeSha256:fixture.created.runtimeSha256,
  expectedSourceManifestSha256:fixture.sourceManifestSha256,expectedTarget:fixture.created.target}),/release_runtime_env_file_invalid/);
 assert.equal(existsSync(preloadMarker),false);
 assert.equal(existsSync(fixture.marker),false);
});

test('does not spawn a payload when the launch was already cancelled',async t=>{
 assert.equal(typeof launcher.launchVerifiedRuntime,'function');
 const fixture=launchFixture(t),controller=new AbortController();controller.abort();let spawned=false;
 await assert.rejects(launcher.launchVerifiedRuntime({root:fixture.root,cwd:fixture.root,entryRelative:'src/entry.mjs',args:[fixture.marker],
  expectedRuntimeSha256:fixture.created.runtimeSha256,expectedSourceManifestSha256:fixture.sourceManifestSha256,
  expectedTarget:fixture.created.target,signal:controller.signal,spawnRuntime(){spawned=true;throw new Error('must not spawn');}}),/release_runtime_start_cancelled/);
 assert.equal(spawned,false);
 assert.equal(existsSync(fixture.marker),false);
});
