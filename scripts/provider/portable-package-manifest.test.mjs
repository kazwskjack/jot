import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFileSync,existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {createDesktopPortableManifest as createPortableManifestForTest,
 stageDesktopPortableRelease as stagePortableReleaseForTest} from './portable-package-manifest.mjs';
import {createDesktopPortableManifest,stageDesktopPortableRelease} from './release-ops-v2.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const temporaryRoot=join(process.cwd(),'.test-tmp');

function fixture(t,{extraReceiptKey=false,platform='win32'}={}){
 mkdirSync(temporaryRoot,{recursive:true});
 const root=mkdtempSync(join(temporaryRoot,'jot-portable-provider-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const packageRoot=join(root,'Jot-Desktop');mkdirSync(packageRoot);
 const payload={
  'Jot.exe':'fixture electron executable',
  'LICENSE':'Electron license fixture',
  'LICENSES.chromium.html':'Chromium notices fixture',
  'JOT-LICENSE.txt':'Jot license fixture',
  'THIRD_PARTY_NOTICES.txt':'Third-party notices fixture',
  'resources/app/package.json':JSON.stringify({name:'jot-desktop-fixture',version:'0.1.0',type:'module',main:'apps/desktop/main-entry.mjs',dependencies:{fastify:'5.12.5'}}),
  'resources/app/apps/desktop/main-entry.mjs':'export const desktopEntry = true;\n',
  'resources/app/apps/desktop/preload.cjs':'module.exports = {};\n',
  'resources/app/src/server.mjs':'export const serverEntry = true;\n',
  'resources/app/dist/workbench.html':'<!doctype html><title>Jot</title>\n',
  'resources/app/node_modules/fastify/package.json':JSON.stringify({name:'fastify',version:'5.12.5',license:'MIT'}),
  'resources/app/node_modules/fastify/index.js':'export default {};\n',
  'resources/app/node_modules/fastify/LICENSE':'MIT fixture license\n'
 };
 for(const [path,content]of Object.entries(payload)){
  const file=join(packageRoot,...path.split('/'));mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,content);
 }
 const runtimeReceipt={electronVersion:'45.0.0',nodeVersion:'24.22.0',platform,arch:'x64',nodeModuleAbi:'150',napiVersion:'10',...(extraReceiptKey?{unexpected:true}:{})};
 const runtimeReceiptPath=join(root,'runtime-receipt.json');
 const runtimeReceiptBytes=Buffer.from(JSON.stringify(runtimeReceipt)+'\n');writeFileSync(runtimeReceiptPath,runtimeReceiptBytes);
 const electronArchivePath=join(root,'electron.zip');writeFileSync(electronArchivePath,'fixture Electron archive');
 return {
  root,packageRoot,payload,runtimeReceiptPath,expectedRuntimeReceiptSha256:hash(runtimeReceiptBytes),electronArchivePath,
  expectedElectronArchiveSha256:hash(readFileSync(electronArchivePath)),
  electronRuntimePaths:['Jot.exe','LICENSE','LICENSES.chromium.html'],
  expectedAppLockSha256:'4'.repeat(64),expectedRootLockSha256:'1'.repeat(64),
  sourceCommit:'a'.repeat(40),sourceTreeSha256:'b'.repeat(64),
  build:{nodeVersion:'24.13.0',npmVersion:'11.6.2',viteVersion:'8.3.2'}
 };
}

test('loads as an isolated provider module without root release scripts',async t=>{
 mkdirSync(temporaryRoot,{recursive:true});
 const root=mkdtempSync(join(temporaryRoot,'jot-provider-isolated-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const modulePath=join(root,'scripts','provider','portable-package-manifest.mjs');
 mkdirSync(join(root,'scripts','provider'),{recursive:true});
 copyFileSync(new URL('./portable-package-manifest.mjs',import.meta.url),modulePath);
 await assert.doesNotReject(()=>import(pathToFileURL(modulePath).href+'?isolated='+Date.now()));
});

test('creates and verifies the exact portable manifest from pinned runtime and package bytes',t=>{
 const args=fixture(t),result=createDesktopPortableManifest(args);
 const manifest=JSON.parse(readFileSync(join(args.packageRoot,'portable-package-manifest.json'),'utf8'));
 const expectedRuntimeFiles=args.electronRuntimePaths.map(path=>({path,size:Buffer.byteLength(args.payload[path]),sha256:hash(args.payload[path])})).sort((a,b)=>a.path.localeCompare(b.path,'en'));
 assert.equal(result.manifestSha256,hash(readFileSync(join(args.packageRoot,'portable-package-manifest.json'))));
 assert.equal(readFileSync(join(args.packageRoot,'portable-package-manifest.sha256'),'utf8'),result.manifestSha256+'  portable-package-manifest.json\n');
 assert.deepEqual(Object.keys(manifest).sort(),[
  'protocol','status','appVersion','sourceCommit','sourceTreeSha256','target','packageRoot','entry','userData',
  'releaseOpsV2Profile','installOrActivationPerformed','electron','appLockSha256','rootLockSha256','runtimeReceiptSha256','build','files'
 ].sort());
 assert.deepEqual(manifest.files.map(file=>file.path),Object.keys(args.payload).map(path=>'Jot-Desktop/'+path).sort((a,b)=>a.localeCompare(b,'en')));
 assert.equal(manifest.runtimeReceiptSha256,args.expectedRuntimeReceiptSha256);
 assert.equal(manifest.electron.archiveSha256,hash(readFileSync(args.electronArchivePath)));
 assert.deepEqual(manifest.electron.runtimeFiles,expectedRuntimeFiles);
 assert.equal(manifest.electron.inventorySha256,hash(JSON.stringify(expectedRuntimeFiles)));
 assert.equal(manifest.installOrActivationPerformed,false);
 assert.equal(result.verification.fileCount,Object.keys(args.payload).length);
 assert.equal(result.verification.profile,'desktop-electron');
});

test('provider manifest builder forwards externally pinned bindings to its verifier seam',t=>{
 const args=fixture(t),calls=[];
 const result=createPortableManifestForTest({...args,verifyPortablePackage:input=>{
  calls.push(input);return {verified:true,profile:'desktop-electron',manifestSha256:input.expectedManifestSha256};
 }});
 assert.equal(result.verification.verified,true);
 assert.equal(calls.length,1);
 assert.equal(calls[0].expectedManifestSha256,result.manifestSha256);
 assert.equal(calls[0].expectedRuntimeReceiptSha256,args.expectedRuntimeReceiptSha256);
 assert.equal(calls[0].expectedAppLockSha256,args.expectedAppLockSha256);
 assert.equal(calls[0].expectedRootLockSha256,args.expectedRootLockSha256);
 assert.deepEqual(calls[0].expectedRuntimeTarget,{electronVersion:'45.0.0',nodeVersion:'24.22.0',platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'});
});

test('rejects an unexpected runtime receipt field and leaves no manifest behind',t=>{
 const args=fixture(t,{extraReceiptKey:true});
 assert.throws(()=>createDesktopPortableManifest(args),/release_portable_runtime_receipt_invalid/);
 assert.equal(existsSync(join(args.packageRoot,'portable-package-manifest.json')),false);
 assert.equal(existsSync(join(args.packageRoot,'portable-package-manifest.sha256')),false);
});

test('rejects non-Windows receipts because the portable manifest pins the Windows user-data root',t=>{
 const args=fixture(t,{platform:'linux'});
 assert.throws(()=>createDesktopPortableManifest(args),/release_portable_runtime_receipt_invalid/);
 assert.equal(existsSync(join(args.packageRoot,'portable-package-manifest.json')),false);
 assert.equal(existsSync(join(args.packageRoot,'portable-package-manifest.sha256')),false);
});

test('requires an absolute package root instead of defaulting to the process directory',t=>{
 const args=fixture(t);args.packageRoot='relative-only';
 assert.throws(()=>createDesktopPortableManifest(args),/release_portable_manifest_input_invalid/);
});

test('does not overwrite an existing manifest',t=>{
 const args=fixture(t),path=join(args.packageRoot,'portable-package-manifest.json');
 writeFileSync(path,'keep this file');
 assert.throws(()=>createDesktopPortableManifest(args),/release_portable_manifest_exists/);
 assert.equal(readFileSync(path,'utf8'),'keep this file');
});

test('rejects an Electron archive that does not match its external digest pin',t=>{
 const args=fixture(t);args.expectedElectronArchiveSha256='f'.repeat(64);
 assert.throws(()=>createDesktopPortableManifest(args),/release_portable_electron_archive_mismatch/);
 assert.equal(existsSync(join(args.packageRoot,'portable-package-manifest.json')),false);
});

test('stages the externally pinned portable candidate through the versioned read-only installer',async t=>{
 const args=fixture(t),candidate=createDesktopPortableManifest(args),installRoot=join(args.root,'install');
 const userDataRoot=join(args.root,'private-user-data');
 const staged=await stageDesktopPortableRelease({packageRoot:args.packageRoot,expectedManifestSha256:candidate.manifestSha256,
  installRoot,userDataRoot,expectedRuntimeReceiptSha256:args.expectedRuntimeReceiptSha256,
  expectedRuntimeTarget:{electronVersion:'45.0.0',nodeVersion:'24.22.0',platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'},
  expectedAppLockSha256:args.expectedAppLockSha256,expectedRootLockSha256:args.expectedRootLockSha256});
 assert.equal(staged.staged,true);
 assert.equal(staged.profile,'desktop-electron');
 assert.equal(staged.manifestSha256,candidate.manifestSha256);
 assert.equal(staged.completeRuntimeProof,true);
 assert.equal(existsSync(userDataRoot),false);
});

test('provider stage adapter requires an explicit ReleaseOps stage caller',async t=>{
 const args=fixture(t),candidate=createPortableManifestForTest({...args,verifyPortablePackage:input=>({profile:'desktop-electron',manifestSha256:input.expectedManifestSha256})}),calls=[];
 const staged=await stagePortableReleaseForTest({packageRoot:args.packageRoot,expectedManifestSha256:candidate.manifestSha256,
  installRoot:join(args.root,'install'),userDataRoot:join(args.root,'user-data'),expectedRuntimeReceiptSha256:args.expectedRuntimeReceiptSha256,
  expectedRuntimeTarget:{electronVersion:'45.0.0',nodeVersion:'24.22.0',platform:'win32',arch:'x64',nodeModuleAbi:'150',napiVersion:'10'},
  expectedAppLockSha256:args.expectedAppLockSha256,expectedRootLockSha256:args.expectedRootLockSha256,
  stageRelease:async input=>{calls.push(input);return {staged:true,profile:input.profile};}});
 assert.equal(staged.staged,true);
 assert.equal(calls.length,1);
 assert.equal(calls[0].profile,'desktop-electron');
 assert.equal(calls[0].expectedManifestSha256,candidate.manifestSha256);
});
