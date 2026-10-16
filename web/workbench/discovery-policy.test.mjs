import test from 'node:test';
import assert from 'node:assert/strict';
import {discoveryPolicyForm,discoveryPolicyInput,discoveryControlInput,discoveryPolicyMatches,discoveryScope} from './discovery-policy.mjs';
import {TaskSaveReceipt} from './task-save.mjs';
const agent={agent_id:'reader',project_id:'project',workspace_id:'shared',version:3,capability_epoch:2,status:'active'};
const policy={policy_id:'policy',scope:{agent_id:'reader',project_id:'project',workspace_id:'shared'},version:4,role_version:3,role_epoch:2,state:'paused',effective_state:'paused',mode:'discover_only',cooldown_ms:300000,recent_input_ms:60000,max_cycles:null,execution_authorized:false};
test('first save only proposes discovery, defaults to unlimited cycles and carries exact role/CAS versions',()=>{
 const form=discoveryPolicyForm(null);
 assert.deepEqual(form,{cooldown_seconds:'300',recent_input_seconds:'60',max_cycles:''});
 assert.deepEqual(discoveryPolicyInput(agent,null,form),{expected_version:0,expected_role_version:3,expected_role_epoch:2,mode:'discover_only',cooldown_ms:300000,recent_input_ms:60000,max_cycles:null});
 assert.deepEqual(discoveryPolicyForm({...policy,max_cycles:8}),{...form,max_cycles:'8'});
});
test('saving edited settings uses policy version, validates whole safe values and does not grant execution',()=>{
 assert.equal(discoveryPolicyInput(agent,policy,{cooldown_seconds:'0',recent_input_seconds:'2',max_cycles:'5'}).expected_version,4);
 for(const field of ['cooldown_seconds','recent_input_seconds','max_cycles'])for(const value of ['-1','1.5','Infinity','1e3','9007199254740992'])assert.throws(()=>discoveryPolicyInput(agent,policy,{...discoveryPolicyForm(policy),[field]:value}));
 assert.throws(()=>discoveryPolicyInput(agent,policy,{...discoveryPolicyForm(policy),max_cycles:'0'}));
 const input=discoveryPolicyInput(agent,policy,discoveryPolicyForm(policy));assert.deepEqual(Object.keys(input).sort(),['expected_version','expected_role_epoch','expected_role_version','mode','cooldown_ms','recent_input_ms','max_cycles'].sort());
});
test('enable explicitly binds current role, pause/stop use policy CAS, revoked roles need a fresh save',()=>{
 assert.deepEqual(discoveryControlInput(agent,policy,'enable'),{action:'enable',expected_version:4,expected_role_version:3,expected_role_epoch:2});
 for(const action of ['pause','stop'])assert.deepEqual(discoveryControlInput(agent,policy,action),{action,expected_version:4});
 for(const changed of [{...agent,status:'disabled'},{...agent,version:4},{...agent,capability_epoch:3}])assert.throws(()=>discoveryControlInput(changed,policy,'enable'));
 assert.throws(()=>discoveryControlInput(agent,null,'enable'));assert.throws(()=>discoveryControlInput(agent,policy,'run-now'));
});
test('cross-role policy responses and unavailable or changed owner scope never qualify for a command',()=>{
 assert.equal(discoveryPolicyMatches(policy,agent),true);
 for(const key of ['agent_id','project_id','workspace_id'])assert.equal(discoveryPolicyMatches({...policy,scope:{...policy.scope,[key]:'foreign'}},agent),false);
 assert.throws(()=>discoveryPolicyInput({...agent,agent_id:'foreign'},policy,discoveryPolicyForm(policy)));
 assert.throws(()=>discoveryControlInput({...agent,project_id:'foreign'},policy,'pause'));
 const scope='a'.repeat(64);assert.notEqual(discoveryScope(scope,agent),discoveryScope('b'.repeat(64),agent));assert.notEqual(discoveryScope(scope,agent),discoveryScope(scope,{...agent,agent_id:'other'}));
 assert.throws(()=>discoveryScope('',agent));
});
test('response loss retries exactly the original policy command/key; CAS rejection releases it',async()=>{
 let keys=0;const receipt=new TaskSaveReceipt(()=>`key-${++keys}`),calls=[];
 const request=async(...args)=>{calls.push(args);if(calls.length===1)throw Error('connection lost');return policy;};
 const input=discoveryControlInput(agent,policy,'enable');await assert.rejects(receipt.submit(request,'/agents/reader/discovery-policy/control','POST',input));assert.equal(receipt.pending,true);
 await receipt.submit(request,'/agents/other/discovery-policy/control','POST',{action:'stop'});assert.deepEqual(calls[1],calls[0]);assert.equal(keys,1);assert.equal(receipt.pending,false);
 await assert.rejects(receipt.submit(async()=>{throw Object.assign(Error('VERSION_CONFLICT'),{status:409});},'/agents/reader/discovery-policy','PATCH',{}));assert.equal(receipt.pending,false);
});
