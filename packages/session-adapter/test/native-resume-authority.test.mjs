import test from 'node:test';import assert from 'node:assert/strict';
import {WorkbenchBridge} from '../workbench.js';
const binding={runId:'run',sessionRef:'session',executionLease:{owner:'worker',generation:1}};
const context=()=>({name:'Reviewer',instructions:'Review sources',kind:'task',run_id:'run',owner_id:'owner',agent_id:'role',workspace_id:'ws',project_id:'project',capability_epoch:1,allowed_tools:[],model_budget:{protocol:1,enforced:true},task_binding:{task_id:'task',occurrence_id:'occ',task_version:1,generation:1,title:'Review',objective:'Review sources',root_run_id:'run',continuation_of:null}});
function fixture(){let current=context(),mapping=null;const calls=[];const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:18831',token:'test-token-32-characters-fixture',fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);assert.equal(body.run_id,'run');assert.equal(body.session_ref,'session');assert.deepEqual(body.execution_lease,binding.executionLease);calls.push(new URL(url).pathname);return Response.json(url.endsWith('/guard')?{context:current}:{binding:mapping});}});return {bridge,calls,setContext:value=>current=value,setMapping:value=>mapping=value};}
test('cold authorization reads current Gateway authority without model admission or Goal mutation',async()=>{
 const f=fixture(),result=await f.bridge.authorizeNativeResume(binding);assert.equal(result.scope.owner_id,'owner');assert.deepEqual(result.binding.executionLease,binding.executionLease);assert.equal(result.mapping,null);assert.deepEqual(f.calls,['/internal/v1/workbench/guard','/internal/v1/workbench/goal-binding']);
 await assert.rejects(f.bridge.authorizeNativeResume({...binding,executionLease:undefined}));assert.equal(f.calls.length,2);
 f.setMapping({goal_id:'goal',goal_revision:2});assert.deepEqual((await f.bridge.authorizeNativeResume(binding)).mapping,{goal_id:'goal',goal_revision:2});
});
test('foreign task roots, child continuations, absent budgets and malformed Goal mappings deny cold restoration',async()=>{
 for(const patch of [{kind:'chat'},{model_budget:null},{run_id:'other'},{task_binding:{...context().task_binding,root_run_id:'other'}},{task_binding:{...context().task_binding,continuation_of:'parent'}}]){const f=fixture();f.setContext({...context(),...patch});await assert.rejects(f.bridge.authorizeNativeResume(binding));assert.equal(f.calls.length,1);}
 const f=fixture();f.setMapping({goal_id:'goal',goal_revision:1,extra:'private'});await assert.rejects(f.bridge.authorizeNativeResume(binding),/goal_invalid/);
});
