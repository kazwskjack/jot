import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
const output=new URL('../../.test-tmp/ui-client-tests/',import.meta.url);
await mkdir(output,{recursive:true});
await build({entryPoints:[new URL('./client.ts',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],bundle:true,platform:'node',format:'esm',outfile:new URL('client.mjs',output).pathname.replace(/^\/([A-Z]:)/,'$1')});
const {workbenchApi}=await import(new URL('client.mjs',output));

test('memory capture recovery reads and reconciles an exact original attempt through the owner BFF',async t=>{
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response('{"recovery_state":"unresolved_usage_held"}');};
 const input={expected_capture_version:4,expected_policy_version:2,expected_epoch:3,attempt_id:'model-original',evidence_ref:'musage-0123456789abcdef'};
 await workbenchApi.memoryCaptureRecovery('agent /1','capture /2',new AbortController().signal);
 await workbenchApi.reconcileMemoryCapture('agent /1','capture /2',input,'capture-reconcile-key');
 assert.equal(calls[0].url,'/workbench-api/v1/agents/agent%20%2F1/memory-captures/capture%20%2F2/recovery');
 assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.body,undefined);
 assert.equal(calls[1].url,'/workbench-api/v1/agents/agent%20%2F1/memory-captures/capture%20%2F2/reconcile');
 assert.equal(calls[1].init.method,'POST');assert.equal(calls[1].init.headers['Idempotency-Key'],'capture-reconcile-key');assert.deepEqual(JSON.parse(calls[1].init.body),input);
 for(const {init} of calls){assert.equal(init.credentials,'same-origin');assert.equal(init.cache,'no-store');}
});

test('Git history discovers original operations through bounded abortable reads without local acceptance metadata',async t=>{
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original});globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response('{"items":[],"next_cursor":null,"execution_authorized":false}')};
 const controller=new AbortController();await workbenchApi.gitHistory('project /1',{},controller.signal);await workbenchApi.gitHistory('project /1',{before:'execution:/ original',limit:10},controller.signal);
 assert.equal(calls[0].url,'/workbench-api/v1/projects/project%20%2F1/git/history');assert.equal(calls[1].url,'/workbench-api/v1/projects/project%20%2F1/git/history?before=execution%3A%2F+original&limit=10');
 for(const {init}of calls){assert.equal(init.method,'GET');assert.equal(init.body,undefined);assert.equal(init.cache,'no-store');assert.equal(init.credentials,'same-origin');assert.ok(init.signal instanceof AbortSignal);assert.equal(init.signal.aborted,false)}
 globalThis.fetch=async(_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));const pending=workbenchApi.gitHistory('project',{},controller.signal);controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(calls.length,2);
});

test('publication recovery receipts have explicit latest and original-command read paths without native dispatch',async t=>{
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original});globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response('{"execution_authorized":false}')};
 const signal=new AbortController().signal;
 await workbenchApi.publicationLatestSettlement('project /1','execution:original',signal);await workbenchApi.publicationSettlementReceipt('project /1','execution:original','request:original',signal);
 assert.equal(calls[0].url,'/workbench-api/v1/projects/project%20%2F1/work-publication-executions/execution%3Aoriginal/settlement');
 assert.equal(calls[1].url,'/workbench-api/v1/projects/project%20%2F1/work-publication-executions/execution%3Aoriginal/settlements/request%3Aoriginal');
 for(const {init} of calls){assert.equal(init.method,'GET');assert.equal(init.body,undefined);assert.equal(init.cache,'no-store');assert.equal(init.credentials,'same-origin');assert.ok(init.signal instanceof AbortSignal)}
});

test('publication acceptance and current outcome remain separate abortable BFF reads',async t=>{
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original});globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response('{"execution_authorized":false}')};
 const signal=new AbortController().signal;await workbenchApi.publicationAcceptance('project /1','original:request',signal);await workbenchApi.publicationStatus('project /1','original:execution',signal);
 assert.equal(calls[0].url,'/workbench-api/v1/projects/project%20%2F1/work-publication-admissions/original%3Arequest');assert.equal(calls[1].url,'/workbench-api/v1/projects/project%20%2F1/work-publication-executions/original%3Aexecution');
 for(const {init} of calls){assert.equal(init.method,'GET');assert.equal(init.body,undefined);assert.equal(init.cache,'no-store');assert.equal(init.credentials,'same-origin');assert.ok(init.signal instanceof AbortSignal)}
});

test('file lifecycle history uses the original receipt page on the scoped lifecycle-history BFF route',async t=>{
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original});globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({items:[],next_cursor:'next'}))};
 for(const method of ['fileLifecycleHistory','fileLifecyclePreview','applyFileLifecycle','fileLifecycleStatus'])assert.equal(typeof workbenchApi[method],'function',`${method} is available`);
 const signal=new AbortController().signal,rename={project_id:'project /1',path:'old/name.md',target_path:'new/final.md',expected_version:4,preview_sha256:'a'.repeat(64)},remove={project_id:'project /1',path:'removed.md',expected_version:2};
 const history=await workbenchApi.fileLifecycleHistory('main /',rename.project_id,{limit:1,cursor:'next:/ page'},signal);
 await workbenchApi.fileLifecyclePreview('main /','rename',rename,signal);
 await workbenchApi.fileLifecyclePreview('main /','delete',remove,signal);
 await workbenchApi.applyFileLifecycle('main /','rename',rename,'history-command-001',signal);
 await workbenchApi.fileLifecycleStatus('main /',rename.project_id,'history-command-001',signal);
 assert.deepEqual(history,{items:[],next_cursor:'next'});
 assert.equal(calls[0].url,'/workbench-api/v1/workspaces/main%20%2F/files/lifecycle-history?project_id=project%20%2F1&limit=1&cursor=next%3A%2F%20page');
 assert.equal(calls[1].url,'/workbench-api/v1/workspaces/main%20%2F/files/rename-preview?project_id=project%20%2F1&path=old%2Fname.md&target_path=new%2Ffinal.md&expected_version=4');
 assert.equal(calls[2].url,'/workbench-api/v1/workspaces/main%20%2F/files/delete-preview?project_id=project%20%2F1&path=removed.md&expected_version=2');
 assert.equal(calls[3].url,'/workbench-api/v1/workspaces/main%20%2F/files/rename');assert.equal(calls[3].init.method,'POST');
 assert.equal(calls[3].init.headers['Idempotency-Key'],'history-command-001');assert.deepEqual(JSON.parse(calls[3].init.body),rename);
 assert.equal(calls[4].url,'/workbench-api/v1/workspaces/main%20%2F/files/lifecycle-commands/history-command-001?project_id=project%20%2F1');
 for(const [index,{init}] of calls.entries()){assert.equal(init.cache,'no-store');assert.equal(init.credentials,'same-origin');assert.ok(init.signal instanceof AbortSignal);assert.equal(init.signal.aborted,false);if(index!==3){assert.equal(init.method,'GET');assert.equal(init.body,undefined)}}
});

test('project create and rename use the typed owner-scoped endpoints with stable idempotency keys',async t=>{
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original});globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response('{"project_id":"project /1","title":"Research","is_default":false,"version":1,"created_at":"2026-10-24T00:00:00.000Z","updated_at":"2026-10-24T00:00:00.000Z"}')};
 await workbenchApi.createProject({title:'Research'},'project-create-key');
 await workbenchApi.renameProject('project /1',{expected_version:1,title:'Ideas'},'project-rename-key');
 assert.deepEqual(calls.map(call=>call.url),['/workbench-api/v1/projects','/workbench-api/v1/projects/project%20%2F1']);
 assert.deepEqual(calls.map(call=>call.init.method),['POST','PATCH']);
 assert.deepEqual(calls.map(call=>call.init.headers['Idempotency-Key']),['project-create-key','project-rename-key']);
 assert.deepEqual(calls.map(call=>JSON.parse(call.init.body)),[{title:'Research'},{expected_version:1,title:'Ideas'}]);
});

test('completed publication source read encodes the original project and run without mutation',async t=>{
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original});globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response('{"source":"isolated"}')};
 await workbenchApi.publicationSource('project /1','run:original',new AbortController().signal);
 assert.equal(calls[0].url,'/workbench-api/v1/projects/project%20%2F1/work-publication-sources/run%3Aoriginal');assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.body,undefined);assert.equal(calls[0].init.cache,'no-store');assert.equal(calls[0].init.credentials,'same-origin');
});

test('publication review uses the encoded owner BFF read without sending approval or file authority',async t=>{
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original});globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response('{"execution_authorized":false}')};
 const abort=new AbortController();await workbenchApi.publicationReview('project /1','review:original',abort.signal);
 assert.equal(calls[0].url,'/workbench-api/v1/projects/project%20%2F1/work-publications/review%3Aoriginal');assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.body,undefined);assert.equal(calls[0].init.cache,'no-store');
 globalThis.fetch=async(_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));const pending=workbenchApi.publicationReview('project','review',abort.signal);abort.abort();await assert.rejects(pending,{name:'AbortError'});
});

test('Git accepted receipt and current outcome use distinct read-only no-store requests with original IDs',async t=>{
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original});globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response('{"execution_authorized":false}')};const abort=new AbortController();
 await workbenchApi.gitAcceptance('project /1','original:request',abort.signal);await workbenchApi.gitExecution('project /1','original:execution',abort.signal);
 assert.equal(calls[0].url,'/workbench-api/v1/projects/project%20%2F1/git/admissions/original%3Arequest');assert.equal(calls[1].url,'/workbench-api/v1/projects/project%20%2F1/git/executions/original%3Aexecution');
 for(const {init}of calls){assert.equal(init.method,'GET');assert.equal(init.body,undefined);assert.equal(init.cache,'no-store');assert.equal(init.credentials,'same-origin');assert.ok(init.signal instanceof AbortSignal)}
 globalThis.fetch=async(_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));const pending=workbenchApi.gitExecution('project','execution',abort.signal);abort.abort();await assert.rejects(pending,{name:'AbortError'});
});

test('file list pages encode scope and cursor and use authenticated read-only BFF requests',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response('{"items":[],"next_cursor":null}');};
 assert.equal(typeof workbenchApi.files,'function');
 const signal=new AbortController().signal;
 await workbenchApi.files('ws /1','project /2',{cursor:'token+/=',limit:25},signal);
 assert.equal(calls[0].url,'/workbench-api/v1/workspaces/ws%20%2F1/files?project_id=project%20%2F2&limit=25&cursor=token%2B%2F%3D');
 assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.credentials,'same-origin');assert.equal(calls[0].init.cache,'no-store');assert.equal(calls[0].init.body,undefined);
});

test('original Git index admissions preserve exact command bodies and keys while evidence reads remain no-store and cancellable',async t=>{
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original});globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response('{"execution_authorized":false}')};
 const command={request_id:'original',expected_version:2,review_sha256:'a'.repeat(64)},control={request_id:'original-control',expected_state_sha256:'b'.repeat(64),acknowledge_unknown:true},abort=new AbortController();
 await workbenchApi.gitAdmit('project','intent',command,'unchanged-admission-key',abort.signal);await workbenchApi.gitAdmit('project','intent',command,'unchanged-admission-key',abort.signal);
 await workbenchApi.gitAdmitControl('project','execution',control,'unchanged-control-key',abort.signal);
 assert.equal(calls[0].url,'/workbench-api/v1/projects/project/git/intents/intent/admissions');assert.equal(calls[0].init.body,JSON.stringify(command));assert.equal(calls[0].init.headers['Idempotency-Key'],'unchanged-admission-key');assert.equal(calls[1].init.body,calls[0].init.body);assert.equal(calls[1].init.headers['Idempotency-Key'],calls[0].init.headers['Idempotency-Key']);
 assert.equal(calls[2].url,'/workbench-api/v1/projects/project/git/executions/execution/controls');assert.equal(calls[2].init.body,JSON.stringify(control));assert.equal(calls[2].init.headers['Idempotency-Key'],'unchanged-control-key');
 await workbenchApi.gitInspection('project','execution',abort.signal);await workbenchApi.gitControlAcceptance('project','execution','original-control',abort.signal);await workbenchApi.gitControlReceipt('project','execution','original-control',abort.signal);
 assert.deepEqual(calls.slice(3).map(c=>c.url),['inspection','control-admissions/original-control','controls/original-control'].map(path=>'/workbench-api/v1/projects/project/git/executions/execution/'+path));
 for(const {init}of calls){assert.equal(init.cache,'no-store');assert.equal(init.credentials,'same-origin');assert.ok(init.signal instanceof AbortSignal)}
 for(const {init}of calls.slice(3)){assert.equal(init.method,'GET');assert.equal(init.body,undefined)}
 globalThis.fetch=async(_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));const pending=workbenchApi.gitInspection('project','execution',abort.signal);abort.abort();await assert.rejects(pending,{name:'AbortError'});
});

test('workspace directory binary import and download preserve bytes and pinned path identity',async t=>{
 assert.equal(typeof workbenchApi.importWorkspaceFileBinary,'function','workspace binary import API is available');
 assert.equal(typeof workbenchApi.readWorkspaceFileBinary,'function','workspace binary download API is available');
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original;});
 const bytes=new Uint8Array([0,255,65,128]),file=new File([bytes],'photo.bin',{type:'application/octet-stream'}),digest='a'.repeat(64),signal=new AbortController().signal;
 const receipt={workspace_id:'ws /1',project_id:'project /2',path:'images/photo.bin',version:3,sha256:digest,size:4,source:{kind:'directory_import',relative_path:'images/photo.bin'}};
 globalThis.fetch=async(url,init)=>{calls.push({url,init});return init.method==='PUT'?new Response(JSON.stringify(receipt),{headers:{'content-type':'application/json'}}):new Response(bytes,{headers:{'content-type':'application/octet-stream'}})};
 assert.deepEqual(await workbenchApi.importWorkspaceFileBinary('ws /1','project /2','images/photo.bin',2,file,'dir-import-key-0001',signal),receipt);
 assert.deepEqual([...await workbenchApi.readWorkspaceFileBinary('ws /1','project /2','images/photo.bin',3,digest,signal)],[0,255,65,128]);
 assert.equal(calls[0].url,'/workbench-api/v1/workspaces/ws%20%2F1/files/binary?project_id=project%20%2F2&path=images%2Fphoto.bin&expected_version=2');
 assert.equal(calls[0].init.method,'PUT');assert.equal(calls[0].init.body,file);assert.equal(calls[0].init.headers['Content-Type'],'application/octet-stream');assert.equal(calls[0].init.headers['Idempotency-Key'],'dir-import-key-0001');
 assert.equal(calls[1].url,`/workbench-api/v1/workspaces/ws%20%2F1/files/binary?project_id=project%20%2F2&path=images%2Fphoto.bin&version=3&sha256=${digest}`);
 assert.equal(calls[1].init.method,'GET');assert.equal(calls[1].init.body,undefined);assert.equal(calls[1].init.credentials,'same-origin');assert.equal(calls[1].init.cache,'no-store');
});

test('explicit Git dispatch and resolution retain original keys and never infer native completion from the client',async t=>{
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original});globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response('{"execution_authorized":false}')};const abort=new AbortController(),command={request_id:'original-control',expected_state_sha256:'c'.repeat(64),acknowledge_unknown:true};
 await workbenchApi.gitStatus('project','execution',abort.signal);await workbenchApi.gitDispatch('project','execution','explicit-dispatch-key',abort.signal);await workbenchApi.gitResolve('project','execution',command,'explicit-resolution-key',abort.signal);
 assert.equal(calls[0].url,'/workbench-api/v1/projects/project/git/executions/execution/status');assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.body,undefined);
 assert.equal(calls[1].url,'/workbench-api/v1/projects/project/git/executions/execution/dispatch');assert.equal(calls[1].init.method,'POST');assert.equal(calls[1].init.body,'{}');assert.equal(calls[1].init.headers['Idempotency-Key'],'explicit-dispatch-key');
 assert.equal(calls[2].url,'/workbench-api/v1/projects/project/git/executions/execution/resolve');assert.equal(calls[2].init.body,JSON.stringify(command));assert.equal(calls[2].init.headers['Idempotency-Key'],'explicit-resolution-key');
 for(const {init}of calls){assert.equal(init.cache,'no-store');assert.equal(init.credentials,'same-origin');assert.ok(init.signal instanceof AbortSignal)}
 globalThis.fetch=async(_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));const pending=workbenchApi.gitDispatch('project','execution','same-original-key',abort.signal);abort.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(calls.length,3);
});

test('discovery policy read uses the encoded owned role route and never sends an enable command',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let call;
 globalThis.fetch=async(url,init)=>{call={url,init};return new Response('{"policy":null,"execution_authorized":false}');};
 const controller=new AbortController();const value=await workbenchApi.discoveryPolicy('role /1',controller.signal);
 assert.equal(call.url,'/workbench-api/v1/agents/role%20%2F1/discovery-policy');assert.equal(call.init.method,'GET');assert.equal(call.init.body,undefined);assert.equal(call.init.credentials,'same-origin');assert.equal(value.policy,null);
});

test('discovery history and proposal pagination remain read-only original role/admission routes',async t=>{
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response('{"execution_authorized":false}');};
 await workbenchApi.discoveryHistory('role /1','admission /2');await workbenchApi.discoveryHistoryDetail('role /1','admission /2','plan /3');
 assert.equal(calls[0].url,'/workbench-api/v1/agents/role%20%2F1/discovery-history?before_id=admission%20%2F2');
 assert.equal(calls[1].url,'/workbench-api/v1/agents/role%20%2F1/discovery-history/admission%20%2F2?after_plan_id=plan%20%2F3');
 for(const {init} of calls){assert.equal(init.method,'GET');assert.equal(init.body,undefined);assert.equal(init.credentials,'same-origin');assert.equal(init.cache,'no-store');}
});
test('task delegation posts only the frozen step request and retains its client key',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let call;
 globalThis.fetch=async(url,init)=>{call={url,init};return new Response('{}');};
 const input={occurrence_id:'o',subtask_id:'s',expected_subtask_version:2,recipient_agent_id:'member',client_message_id:'same-key'};
 await workbenchApi.delegateTask('task /1',input);
 assert.equal(call.url,'/workbench-api/v1/persistent-tasks/task%20%2F1/delegations');assert.equal(call.init.headers['Idempotency-Key'],'same-key');assert.deepEqual(JSON.parse(call.init.body),input);
});

test('task message history uses only an encoded occurrence filter on the authenticated workspace endpoint',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let call;
 globalThis.fetch=async(url,init)=>{call={url,init};return new Response('{"items":[]}',{headers:{'content-type':'application/json'}});};
 await workbenchApi.taskMessages('ws /1','occurrence /2');
 assert.equal(call.url,'/workbench-api/v1/workspaces/ws%20%2F1/agent-messages?occurrence_id=occurrence%20%2F2');
 assert.equal(call.init.credentials,'same-origin');assert.equal(call.init.method,'GET');assert.equal(call.init.body,undefined);
});
test('workbench requests use the existing BFF security contract and version checks',async t=>{
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(url.endsWith('/capabilities')?{workbench:{enabled:true}}:{}),{headers:{'content-type':'application/json','x-csrf-token':'test-csrf'}});};
 await workbenchApi.capabilities();
 await workbenchApi.saveAgent({name:'角色',expected_version:3},'a /b','stable-edit');
 const call=calls[1];assert.equal(call.url,'/workbench-api/v1/agents/a%20%2Fb');assert.equal(call.init.method,'PATCH');assert.equal(call.init.credentials,'same-origin');assert.equal(call.init.headers['X-CSRF-Token'],'test-csrf');assert.equal(call.init.headers['Idempotency-Key'],'stable-edit');assert.deepEqual(JSON.parse(call.init.body),{name:'角色',expected_version:3});
 await workbenchApi.saveMemory('shared /1',{scope:'private',agent_id:'a',content:'来源',expected_version:4},'memory');
 assert.equal(calls[2].url,'/workbench-api/v1/workspaces/shared%20%2F1/memory');assert.equal(calls[2].init.method,'POST');assert.deepEqual(JSON.parse(calls[2].init.body),{scope:'private',agent_id:'a',content:'来源',expected_version:4,memory_id:'memory'});
});
test('run-now retains the supplied idempotency key and server errors reject',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({error:{message:'运行预算已用尽'}}),{status:409,headers:{'content-type':'application/json'}});};
 await assert.rejects(()=>workbenchApi.taskAction({task_id:'t',version:7},'run-now','same-run'),/运行预算已用尽/);
 assert.equal(calls[0].url,'/workbench-api/v1/persistent-tasks/t/run-now');assert.equal(calls[0].init.headers['Idempotency-Key'],'same-run');assert.deepEqual(JSON.parse(calls[0].init.body),{client_message_id:'same-run'});
});

test('scoped memory export uses the authenticated GET request and preserves lifecycle filters',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let call;
 globalThis.fetch=async(url,init)=>{call={url,init};return new Response(JSON.stringify({schema_version:1,workspace_id:'ws',exported_at:'2026-10-02T00:00:00Z',items:[]}),{headers:{'content-type':'application/json'}});};
 assert.equal(typeof workbenchApi.exportMemory,'function');
 const exported=await workbenchApi.exportMemory('ws /1','?scope=private&agent_id=a%2F1&include_expired=true&q=source');
 assert.equal(call.url,'/workbench-api/v1/workspaces/ws%20%2F1/memory/export?scope=private&agent_id=a%2F1&include_expired=true&q=source');
 assert.equal(call.init.method,'GET');assert.equal(call.init.credentials,'same-origin');assert.equal(call.init.body,undefined);assert.equal(exported.schema_version,1);
});

test('task budget reads and edits keep the budget CAS and stable BFF write key',async t=>{
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({configured:false,task_id:'t',reason:'BUDGET_POLICY_NOT_CONFIGURED'}),{headers:{'content-type':'application/json'}});};
 assert.equal(typeof workbenchApi.taskModelBudget,'function');assert.equal(typeof workbenchApi.updateTaskModelBudget,'function');
 const controller=new AbortController();await workbenchApi.taskModelBudget('task /1',controller.signal);
 assert.equal(calls[0].url,'/workbench-api/v1/persistent-tasks/task%20%2F1/model-budget');assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.body,undefined);
 const input={expected_version:3,limits:{tokens:200,nano_usd:2000,model_calls:2}};await workbenchApi.updateTaskModelBudget('task /1',input,'stable-budget-edit');
 assert.equal(calls[1].init.method,'PATCH');assert.equal(calls[1].init.headers['Idempotency-Key'],'stable-budget-edit');assert.deepEqual(JSON.parse(calls[1].init.body),input);assert.equal(calls[1].init.credentials,'same-origin');
});

test('task budget attempt history uses the owner-scoped GET page and forwards cancellation',async t=>{
 const original=globalThis.fetch;let call;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,init)=>{call={url,init};return new Response(JSON.stringify({configured:true,task_id:'t',items:[],next_cursor:null,cost_basis:'configured_rates',currency:'USD'}),{headers:{'content-type':'application/json'}});};
 assert.equal(typeof workbenchApi.taskModelBudgetAttempts,'function');
 const controller=new AbortController(),page=await workbenchApi.taskModelBudgetAttempts('task /1','20',controller.signal);
 assert.equal(call.url,'/workbench-api/v1/persistent-tasks/task%20%2F1/model-budget/attempts?limit=20&cursor=20');
 assert.equal(call.init.method,'GET');assert.equal(call.init.credentials,'same-origin');assert.equal(call.init.body,undefined);assert.equal(call.init.signal.aborted,false);assert.equal(page.cost_basis,'configured_rates');
});

test('task checkpoint resume sends only the current public run version and checkpoint with a reusable write key',async t=>{
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({accepted:true,run_id:'child',continuation_of:'run /1'}),{headers:{'content-type':'application/json'}});};
 assert.equal(typeof workbenchApi.resumeTaskRun,'function');
 const receipt=await workbenchApi.resumeTaskRun({run_id:'run /1',version:4,checkpoint_id:'saved',session_id:'must-not-send',goal_id:'must-not-send'},'stable-resume');
 assert.equal(receipt.run_id,'child');assert.equal(calls[0].url,'/workbench-api/v1/runs/run%20%2F1/resume');
 assert.equal(calls[0].init.method,'POST');assert.equal(calls[0].init.credentials,'same-origin');assert.equal(calls[0].init.headers['Idempotency-Key'],'stable-resume');
 assert.deepEqual(JSON.parse(calls[0].init.body),{expected_run_version:4,checkpoint_id:'saved'});
});
