// Actual installed official LlmRuntime; capability lookup is local and scripted.
// No provider network request, native Session or inference-performance claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createBudgetModelSelector} from '../budget-model-selection.js';

test('actual installed resolver propagates cancellation before installing a Session-local model',{
 timeout:10000,skip:!process.env.JOT_DSH_RUNTIME_MODULES,
},async()=>{
 const runtime=resolve(process.env.JOT_DSH_RUNTIME_MODULES);
 const manifest=JSON.parse(await readFile(join(runtime,'dsh-llm/package.json'),'utf8'));
 assert.equal(manifest.version,'0.2.1-rc.2');
 const {Context}=await import(pathToFileURL(join(runtime,'cordis/lib/index.js')));
 const {default:LlmRuntime,LlmAdapter}=await import(pathToFileURL(join(runtime,'dsh-llm/lib/index.js')));
 const ctx=new Context(),controller=new AbortController(),entered=Promise.withResolvers();
 let selected=0,streamed=0,observedSignal;
 try{
  await ctx.plugin(LlmRuntime);
  class LocalResolver extends LlmAdapter{
   async *stream(){streamed++;throw Error('inference_must_not_start');}
   resolveModel(provider,model,signal){
    assert.equal(provider,'local-resolution');assert.equal(model,'fixture');
    observedSignal=signal;entered.resolve();
    return new Promise((accept,reject)=>{
     if(!signal)return reject(Error('resolver_signal_missing'));
     if(signal.aborted)return reject(signal.reason);
     signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    });
   }
  }
  ctx.llm.registerAdapter(['local-resolution'],new LocalResolver());
  const select=createBudgetModelSelector({route:{provider:'local-resolution',model:'fixture'},llm:ctx.llm,agents:{selectForNextRequest:()=>selected++}});
  const pending=select({},async()=>{},controller.signal),reason=new Error('fixture_owner_cancelled');
  const cancelled=assert.rejects(pending,error=>error===reason);
  await entered.promise;assert.equal(observedSignal,controller.signal);controller.abort(reason);await cancelled;
  assert.equal(selected,0);assert.equal(streamed,0);
 }finally{controller.abort();await ctx.fiber.dispose();}
});
