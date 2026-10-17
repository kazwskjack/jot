import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {inspectRelease} from './release-preflight.mjs';

const script=resolve('scripts/release-preflight.mjs');
async function fixture(t){
 const base=resolve('.test-tmp/release-preflight');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'case-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const put=async(path,value='fixture')=>{await mkdir(resolve(root,path,'..'),{recursive:true});await writeFile(join(root,path),typeof value==='object'?JSON.stringify(value):value);};
 const manifests={'package.json':{name:'jot-ai-bot',version:'0.1.0',engines:{node:'>=24'},dependencies:{fastify:'5.12.5'}},'packages/gateway/package.json':{name:'@jot/gateway',version:'0.1.0',engines:{node:'>=22'},dependencies:{fastify:'5.12.5'}},'packages/dsh-host/package.json':{name:'jot-dsh-host-preparation',version:'0.1.0',engines:{node:'>=24'}}};
 for(const [path,value]of Object.entries(manifests))await put(path,value);
 for(const prefix of ['', 'packages/gateway/'])await put(prefix+'package-lock.json',{lockfileVersion:3,packages:{'':manifests[prefix+'package.json']}});
 await put('packages/dsh-host/runtime-package-lock.json',{lockfileVersion:3,packages:{'':{dependencies:{'@deepseek-ai/dsh':'0.2.0-rc.2'}},'node_modules/@deepseek-ai/dsh':{version:'0.2.0-rc.2',bin:{dsh:'lib/bin.js'}}}});
 for(const path of ['src/server.mjs','packages/gateway/src/main.ts','packages/gateway/src/harness/main.ts','packages/gateway/contracts/openapi.json','packages/dsh-host/create-profile.mjs','packages/dsh-host/standard-preset.mjs','packages/session-adapter/index.js'])await put(path);
 await put('packages/dsh-host/create-profile.mjs',"const manifest={dependencies:{'@deepseek-ai/dsh':'0.2.0-rc.2'}};return {runtimeVersion:'0.2.0-rc.2'};");
 await put('packages/dsh-host/standard-preset.mjs',"if(manifest.version!=='0.2.0-rc.2')throw Error('jot_host_runtime_version_mismatch');");
 return {root,put};
}
const check=(result,id)=>result.checks.find(row=>row.id===id);
test('source stage is deterministic, profile-specific and does not require runtime configuration',async t=>{
 const {root}=await fixture(t);const options={root,profile:'gateway',stage:'source',env:{},nodeVersion:'22.0.0'};
 const result=await inspectRelease(options);assert.equal(result.ready,true);assert.equal(check(result,'node.engine').code,'ENGINE_MATCH');assert.deepEqual(await inspectRelease(options),result);
 assert.equal((await inspectRelease({...options,profile:'standalone'})).ready,false);
});
test('runtime fails for absent nonempty build products and requires an explicit absolute existing cwd',async t=>{
 const {root}=await fixture(t);let result=await inspectRelease({root,profile:'standalone',stage:'runtime',env:{},nodeVersion:'24.0.0',cwd:'relative'});
 assert.equal(check(result,'runtime.cwd').code,'ABSOLUTE_DIRECTORY_REQUIRED');assert.equal(check(result,'build.web').code,'FILE_MISSING_OR_EMPTY');assert.equal(result.ready,false);
 result=await inspectRelease({root,profile:'standalone',stage:'runtime',env:{},nodeVersion:'24.0.0',cwd:join(root,'missing')});assert.equal(check(result,'runtime.cwd').status,'fail');
});
test('configured standalone runtime does not read env files, create databases or disclose values',async t=>{
 const {root,put}=await fixture(t);await put('dist/index.html');await put('node_modules/fastify/package.json',{version:'5.12.5'});
 const sentinel=['sensitive','fixture', 'value'].join('-');await put('.env',sentinel);
 const env={JOT_MODEL_URL:`https://${sentinel}.invalid/v1`,JOT_MODEL:sentinel,JOT_MODEL_KEY:sentinel,UNRELATED_SECRET:sentinel};
 const before=await readdir(root);const result=await inspectRelease({root,profile:'standalone',stage:'runtime',cwd:root,env,nodeVersion:'24.0.0'});
 assert.equal(result.ready,true);assert.ok(!JSON.stringify(result).includes(sentinel));assert.deepEqual(await readdir(root),before);assert.ok(!(await readdir(root)).includes('.data'));
});
test('gateway runtime distinguishes required settings, paths and loopback adapter without reading token',async t=>{
 const {root,put}=await fixture(t);for(const path of ['packages/gateway/dist/src/main.js','packages/gateway/dist/src/harness/main.js','packages/gateway/dist/src/db/schema.sql','packages/gateway/dist/contracts/openapi.json'])await put(path);
 await put('packages/gateway/node_modules/fastify/package.json',{version:'5.12.5'});await put('private-token','never read this');await mkdir(join(root,'files'));
 const env={GENERAL_AGENT_CSRF_TOKEN:'x'.repeat(20),GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:'y'.repeat(32),GENERAL_AGENT_ALLOWED_ORIGINS:'http://localhost:3030',GENERAL_AGENT_WORKSPACES:'ws',GENERAL_AGENT_DB:join(root,'not-created.db'),GENERAL_AGENT_FILE_ROOT:join(root,'files'),GENERAL_AGENT_HARNESS_CWD:root,GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE:join(root,'private-token'),GENERAL_AGENT_SESSION_ADAPTER_URL:'http://127.0.0.1:18841'};
 let result=await inspectRelease({root,profile:'gateway',stage:'runtime',cwd:root,env,nodeVersion:'22.0.0'});assert.equal(result.ready,true);
 result=await inspectRelease({root,profile:'gateway',stage:'runtime',cwd:root,env:{...env,GENERAL_AGENT_SESSION_ADAPTER_URL:'https://remote.invalid'},nodeVersion:'22.0.0'});assert.equal(check(result,'config.adapter_url').status,'fail');
 result=await inspectRelease({root,profile:'gateway',stage:'runtime',cwd:root,env:{},nodeVersion:'22.0.0'});assert.equal(check(result,'config.csrf').status,'fail');assert.ok(!JSON.stringify(result).includes(root));
});
test('manifest engine cannot be bypassed with an unsupported range or invalid node version',async t=>{
 const {root,put}=await fixture(t);await put('package.json',{engines:{node:'arbitrary'}});
 assert.equal(check(await inspectRelease({root,profile:'standalone',nodeVersion:'99.0.0'}),'node.engine').code,'ENGINE_CONTRACT_UNSUPPORTED');
 assert.equal((await inspectRelease({root,profile:'gateway',nodeVersion:'not-a-version'})).ready,false);
});
test('lock drift and malformed manifest fail closed without echoing file content',async t=>{
 const {root,put}=await fixture(t);await put('package-lock.json',{lockfileVersion:3,packages:{'':{version:'different'}}});
 assert.equal(check(await inspectRelease({root,profile:'standalone',nodeVersion:'24.0.0'}),'source.lock').status,'fail');
 await put('package.json','private malformed input');const result=await inspectRelease({root,profile:'standalone',nodeVersion:'24.0.0'});assert.equal(result.ready,false);assert.ok(!JSON.stringify(result).includes('private malformed input'));
});
test('Host requires prepared pinned profile and installed official launcher rather than gateway dist',async t=>{
 const {root,put}=await fixture(t);const host=join(root,'prepared');await put('prepared/package.json',{dependencies:{'@deepseek-ai/dsh':'0.2.0-rc.2'}});await put('prepared/package-lock.json',{lockfileVersion:3,packages:{'':{dependencies:{'@deepseek-ai/dsh':'0.2.0-rc.2'}},'node_modules/@deepseek-ai/dsh':{version:'0.2.0-rc.2',bin:{dsh:'lib/bin.js'}}}});await put('prepared/cordis.yml');await put('prepared/cordis.patch.yml');await put('prepared/node_modules/@deepseek-ai/dsh/package.json',{version:'0.2.0-rc.2',bin:{dsh:'lib/bin.js'}});await put('prepared/node_modules/@deepseek-ai/dsh/lib/bin.js');
 const options={root,profile:'host',stage:'runtime',cwd:root,hostProfileDir:host,nodeVersion:'24.0.0',env:{JOT_SESSION_ADAPTER_TOKEN:'z'.repeat(32)}};
 assert.equal((await inspectRelease(options)).ready,true);
 await put('prepared/node_modules/@deepseek-ai/dsh/package.json',{version:'wrong',bin:{dsh:'lib/bin.js'}});assert.equal(check(await inspectRelease(options),'host.installed_version').status,'fail');
});
test('CLI gives machine-readable errors and exit 2 for unknown profile/options without reflection',()=>{
 for(const args of [['--profile','secret-invalid-profile'],['--private-option','sensitive-value']]){const run=spawnSync(process.execPath,[script,...args,'--json'],{encoding:'utf8'});assert.equal(run.status,2);const result=JSON.parse(run.stdout);assert.equal(result.error,'INVALID_ARGUMENTS');assert.ok(!run.stdout.includes('sensitive'));assert.equal(run.stderr,'');}
});
test('CLI exits 1 for unmet checks and 0 for a source fixture with stable profile metadata',async t=>{
 const {root}=await fixture(t);
 const source=spawnSync(process.execPath,[script,'--root',root,'--profile','gateway','--json'],{encoding:'utf8'});assert.equal(source.status,0);assert.equal(JSON.parse(source.stdout).scope,'offline_structure_only');
 const runtime=spawnSync(process.execPath,[script,'--root',root,'--stage','runtime','--cwd',root,'--json'],{encoding:'utf8',env:{}});assert.equal(runtime.status,1);assert.equal(JSON.parse(runtime.stdout).ready,false);assert.equal(runtime.stderr,'');
 for(const args of [['--stage','unsupported'],['--json','--json'],['--profile']]){const run=spawnSync(process.execPath,[script,...args],{encoding:'utf8'});assert.equal(run.status,2);}
});
test('Host refuses a modified prepared lock while feature configuration fails closed for steering',async t=>{
 const {root,put}=await fixture(t);await mkdir(join(root,'prepared'));await put('prepared/package-lock.json',{lockfileVersion:3,packages:{}});
 const host=await inspectRelease({root,profile:'host',stage:'runtime',hostProfileDir:join(root,'prepared'),cwd:root,env:{},nodeVersion:'24.0.0'});assert.equal(check(host,'host.lock').status,'fail');
 const gateway=await inspectRelease({root,profile:'gateway',stage:'runtime',cwd:root,nodeVersion:'22.0.0',env:{GENERAL_AGENT_ORDINARY_STEERING_ENABLED:'true'}});assert.equal(check(gateway,'config.recovery_switches').status,'fail');
});
test('untrusted dependency names cannot address a parent manifest',async t=>{
 const {root,put}=await fixture(t);await mkdir(join(root,'node_modules'));await put('package.json',{name:'fixture',version:'0.1.0',engines:{node:'>=24'},dependencies:{'..':'0.1.0'}});
 const result=await inspectRelease({root,profile:'standalone',stage:'runtime',cwd:root,env:{},nodeVersion:'24.0.0'});assert.equal(check(result,'dependency.1').status,'fail');
});
test('final reconciliation requires both original input recovery and steering',async t=>{
 const {root}=await fixture(t);const base={root,profile:'gateway',stage:'runtime',cwd:root,nodeVersion:'22.0.0'};
 for(const env of [{GENERAL_AGENT_ORDINARY_FINAL_RECONCILIATION_ENABLED:'true'},{GENERAL_AGENT_ORDINARY_FINAL_RECONCILIATION_ENABLED:'true',GENERAL_AGENT_ORDINARY_INPUT_RECOVERY_ENABLED:'true'}])assert.equal(check(await inspectRelease({...base,env}),'config.recovery_switches').status,'fail');
 const env={GENERAL_AGENT_ORDINARY_FINAL_RECONCILIATION_ENABLED:'true',GENERAL_AGENT_ORDINARY_INPUT_RECOVERY_ENABLED:'true',GENERAL_AGENT_ORDINARY_STEERING_ENABLED:'true'};assert.equal(check(await inspectRelease({...base,env}),'config.recovery_switches').status,'pass');
});
test('host source lock must match actual preparer/preset contract rather than any self-consistent new pin',async t=>{
 const {root,put}=await fixture(t);const lock={lockfileVersion:3,packages:{'':{dependencies:{'@deepseek-ai/dsh':'9.9.9'}},'node_modules/@deepseek-ai/dsh':{version:'9.9.9',bin:{dsh:'lib/bin.js'}}}};await put('packages/dsh-host/runtime-package-lock.json',lock);
 const result=await inspectRelease({root,profile:'host',nodeVersion:'24.0.0',env:{}});assert.equal(check(result,'source.lock').status,'fail');
});
test('host source root dependency and preset guard drift fail closed without evaluating source modules',async t=>{
 const {root,put}=await fixture(t);await put('packages/dsh-host/standard-preset.mjs',"throw Error('must never execute');if(manifest.version!=='9.9.9')throw Error('jot_host_runtime_version_mismatch');");
 assert.equal(check(await inspectRelease({root,profile:'host',nodeVersion:'24.0.0'}),'source.lock').status,'fail');
});
