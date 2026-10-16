import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
const output=new URL('../../.test-tmp/ui-client-tests/',import.meta.url);
await mkdir(output,{recursive:true});
await build({entryPoints:[new URL('./client.ts',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],bundle:true,platform:'node',format:'esm',outfile:new URL('client.mjs',output).pathname.replace(/^\/([A-Z]:)/,'$1')});
const {workbenchApi}=await import(new URL('client.mjs',output));

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

test('task checkpoint resume sends only the current public run version and checkpoint with a reusable write key',async t=>{
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({accepted:true,run_id:'child',continuation_of:'run /1'}),{headers:{'content-type':'application/json'}});};
 assert.equal(typeof workbenchApi.resumeTaskRun,'function');
 const receipt=await workbenchApi.resumeTaskRun({run_id:'run /1',version:4,checkpoint_id:'saved',session_id:'must-not-send',goal_id:'must-not-send'},'stable-resume');
 assert.equal(receipt.run_id,'child');assert.equal(calls[0].url,'/workbench-api/v1/runs/run%20%2F1/resume');
 assert.equal(calls[0].init.method,'POST');assert.equal(calls[0].init.credentials,'same-origin');assert.equal(calls[0].init.headers['Idempotency-Key'],'stable-resume');
 assert.deepEqual(JSON.parse(calls[0].init.body),{expected_run_version:4,checkpoint_id:'saved'});
});
