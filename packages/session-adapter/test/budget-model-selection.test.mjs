import test from 'node:test';import assert from 'node:assert/strict';
import {createBudgetModelSelector} from '../budget-model-selection.js';
test('host route is copied and Session-local selection never saves the global default',async()=>{
 const route={provider:'budget-fixture',model:'pinned-fixture'},agent={},selected=[],checked=[];
 const host={route,llm:{resolveCallConfig:async(value)=>{assert.deepEqual(value,{provider:'budget-fixture',model:'pinned-fixture'});return {...value};}},agents:{selectForNextRequest:(subject,value)=>selected.push([subject,value])},agentDefaultModel:{saveSelection:()=>{throw Error('global_default_must_not_change')}}};
 const select=createBudgetModelSelector(host);route.model='mutated';await select(agent,async()=>checked.push('checked'));assert.deepEqual(selected,[[agent,{provider:'budget-fixture',model:'pinned-fixture'}]]);assert.equal(checked.length,2);
});
test('revocation or resolved route drift cannot install a model selection',async()=>{
 for(const scenario of ['revoked','drift','cancelled']){
  let calls=0,checks=0;const controller=new AbortController();const select=createBudgetModelSelector({route:{provider:'fixture',model:'pinned'},llm:{resolveCallConfig:async(route)=>{if(scenario==='cancelled')controller.abort();return {...route,...(scenario==='drift'?{model:'other'}:{})};}},agents:{selectForNextRequest:()=>{calls++;}}});
  await assert.rejects(select({},async()=>{if(++checks===2&&scenario==='revoked')throw Error('revoked')},controller.signal));assert.equal(calls,0);
 }
});
test('missing route is disabled and malformed host routing cannot carry credentials',()=>{
 assert.equal(createBudgetModelSelector({}),undefined);
 for(const route of [null,[],{}, {provider:'fixture',model:'pinned',apiKey:'fake'}, {provider:'fixture',model:'bad model'},{provider:'',model:'pinned'}])assert.throws(()=>createBudgetModelSelector({route}),/workbench_model_config_invalid/);
});
