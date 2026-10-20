import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,writeFile,rm,mkdir,copyFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createNativeGitTransport} from '../../../session-adapter/native-git-transport.js';

for(const [name,module] of [['source','../../src/git/native-transport-client.ts'],['compiled','../../dist/src/git/native-transport-client.js']])test(name+' native client uses original authenticated IPC and keeps operator credentials private',async t=>{
 const {createNativeGitClient,loadNativeGitClient}=await import(new URL(module,import.meta.url));
 assert.equal(await loadNativeGitClient({}),undefined);
 const root=await mkdtemp(join(tmpdir(),'jot-native-client-'));await chmod(root,0o700);
 const bs=String.fromCharCode(92),socket=process.platform==='win32'?[bs,bs,'.',bs,'pipe',bs,'jot-git-client-',randomUUID()].join(''):join(root,'git.sock'),token='test-native-client-token-000000000001',seen=[];
 const host=await createNativeGitTransport({socket,token,perform:async(scope,signal)=>{seen.push(scope);assert.ok(signal instanceof AbortSignal);return{execution_id:scope.execution_id,state:'not_started'}}});
 t.after(async()=>{await host.dispose();await rm(root,{recursive:true,force:true})});
 const settings={socket,token},client=await createNativeGitClient(settings);settings.token='changed';assert.equal(JSON.stringify(client),'{}');
 const scope={owner_id:'owner',project_id:'project',execution_id:'execution',operation_kind:'work_publication'};
 assert.equal((await client.execute(scope)).state,'not_started');assert.deepEqual(seen,[scope]);
 const command={request_id:'owner-command',action:'abandon_unknown',expected_journal_sha256:'a'.repeat(64),acknowledge_unknown:true};
 await client.execute({...scope,command});assert.deepEqual(seen[1],{...scope,command});
 await assert.rejects(client.execute({...scope,root:'caller'}),/native_git_transport_input_invalid/);assert.equal(seen.length,2);
 const abort=new AbortController();abort.abort();await assert.rejects(client.execute(scope,abort.signal));assert.equal(seen.length,2);
 const file=join(root,'token');await writeFile(file,token,{mode:0o600});
 const loaded=await loadNativeGitClient({GENERAL_AGENT_NATIVE_GIT_SOCKET:socket,GENERAL_AGENT_NATIVE_GIT_TOKEN_FILE:file});assert.equal((await loaded.execute(scope)).state,'not_started');
 for(const env of [{GENERAL_AGENT_NATIVE_GIT_SOCKET:socket},{GENERAL_AGENT_NATIVE_GIT_TOKEN_FILE:file},{GENERAL_AGENT_NATIVE_GIT_SOCKET:socket,GENERAL_AGENT_NATIVE_GIT_TOKEN_FILE:'relative-token'}])await assert.rejects(loadNativeGitClient(env),/native_git_client_configuration_invalid/);
 await assert.rejects(createNativeGitClient({...settings,token,module:'caller'}),/native_git_transport_config_invalid/);
});

test('compiled client selects the exact sibling package rather than a shadow source-layout path',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jot-client-layout-'));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));
 const compiled=join(root,'gateway','dist','src','git','native-transport-client.js');await mkdir(join(root,'gateway','dist','src','git'),{recursive:true});
 await mkdir(join(root,'session-adapter'));await mkdir(join(root,'gateway','session-adapter'));await writeFile(join(root,'package.json'),'{"type":"module"}');
 await copyFile(new URL('../../dist/src/git/native-transport-client.js',import.meta.url),compiled);
 await copyFile(new URL('../../../session-adapter/native-git-transport.js',import.meta.url),join(root,'session-adapter','native-git-transport.js'));
 await writeFile(join(root,'gateway','session-adapter','native-git-transport.js'),'throw Error("shadow_transport_must_not_load")');
 const {createNativeGitClient}=await import(pathToFileURL(compiled));
 const bs=String.fromCharCode(92),socket=process.platform==='win32'?[bs,bs,'.',bs,'pipe',bs,'jot-git-layout-',randomUUID()].join(''):join(root,'native.sock');
 const client=await createNativeGitClient({socket,token:'test-layout-client-token-0000000001'});assert.equal(JSON.stringify(client),'{}');
});
