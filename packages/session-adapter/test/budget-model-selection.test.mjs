import test from 'node:test';import assert from 'node:assert/strict';
import {createBudgetModelSelector} from '../budget-model-selection.js';
test('host route is copied and Session-local selection never saves the global default',async()=>{
 const route={provider:'budget-fixture',model:'pinned-fixture'},agent={},selected=[],checked=[];
 const host={route,llm:{resolveCallConfig:async(value)=>{assert.deepEqual(value,{provider:'budget-fixture',model:'pinned-fixture'});return {...value};}},agents:{selectForNextRequest:(subject,value)=>selected.push([subject,value])},agentDefaultModel:{saveSelection:()=>{throw Error('global_default_must_not_change')}}};
 const select=createBudgetModelSelector(host);route.model='mutated';await select(agent,async()=>checked.push('checked'));assert.deepEqual(selected,[[agent,{provider:'budget-fixture',model:'pinned-fixture'}]]);assert.equal(checked.length,3);
});
test('an attached budget run uses its frozen queue-admission route instead of the process default',async()=>{
 const agent={},selected=[],calls=[],binding={runId:'accepted-run',sessionRef:'session-ref',executionLease:{owner:'worker',generation:1}};
 const select=createBudgetModelSelector({route:{provider:'fixture',model:'chosen'},bridge:{bindingFor:value=>value===agent?binding:undefined,request:async(...args)=>{calls.push(args);return{route:{provider:'fixture',model:'later'}};}},
  llm:{resolveCallConfig:async route=>({...route})},agents:{selectForNextRequest:(value,route)=>selected.push([value,route])}});
 await select(agent,async()=>{});
 assert.equal(calls.length,1);assert.equal(calls[0][0],'model-budget');assert.equal(calls[0][2].action,'selection');
 assert.deepEqual(selected,[[agent,{provider:'fixture',model:'later'}]]);
});
test('an attached budget route is discarded if its session binding changes during async lookup or resolution',async()=>{
 for(const changeAt of ['lookup','resolution']){
  const agent={},selected=[],bindingA={runId:'run-a',sessionRef:'session-a',executionLease:{owner:'worker',generation:1}},bindingB={runId:'run-b',sessionRef:'session-b',executionLease:{owner:'worker',generation:2}};
  let activeBinding=bindingA;
  const started=Promise.withResolvers();let release;
  const pendingValue=new Promise(resolve=>{release=resolve;});
  const host={route:{provider:'fixture',model:'default'},bridge:{bindingFor:()=>activeBinding,request:async(_kind,binding)=>{assert.equal(binding,bindingA);started.resolve();return changeAt==='lookup'?pendingValue:{route:{provider:'fixture',model:'from-run-a'}};}},
   llm:{resolveCallConfig:async route=>changeAt==='resolution'?pendingValue:({...route})},agents:{selectForNextRequest:(_agent,route)=>selected.push(route)}};
  const pending=createBudgetModelSelector(host)(agent,async()=>{});
  await started.promise;
  activeBinding=bindingB;
  release(changeAt==='lookup'?{route:{provider:'fixture',model:'from-run-a'}}:{provider:'fixture',model:'from-run-a'});
  await assert.rejects(pending,/workbench_model_binding_changed/);
  assert.deepEqual(selected,[]);
 }
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

test('cancelling during provider capability lookup aborts resolution before Session selection',async()=>{
 const controller=new AbortController(),entered=Promise.withResolvers();let selections=0;
 const select=createBudgetModelSelector({route:{provider:'fixture',model:'pinned'},
  llm:{resolveCallConfig:async(route,signal)=>{
   entered.resolve();assert.equal(signal,controller.signal,'forward the original cancellation signal to the official resolver');
   await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
   return route;
  }},agents:{selectForNextRequest:()=>selections++}});
 const pending=select({},async()=>{},controller.signal);
 const rejected=assert.rejects(pending,error=>error.name==='AbortError');
 await entered.promise;controller.abort();await rejected;assert.equal(selections,0);
});
