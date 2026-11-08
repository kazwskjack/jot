import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';
import {Agent} from '../src/agent.mjs';
import {createTools} from '../src/tools.mjs';

test('M11.04 terminal persisted run fences a file write after approval while its signal is still live',{timeout:10000},async t=>{
 const base=fileURLToPath(new URL('../.test-tmp/m11-file-write-run-state/',import.meta.url));await mkdir(base,{recursive:true});
 const root=await mkdtemp(join(base,'case-')),store=new Store(':memory:'),conversation=store.createConversation();
 const run=store.accept(conversation.id,'Write one synthetic file after approval.','m11-state-race').run;
 const callId='m11-file-write-state-race',args={name:'synthetic.txt',text:'Synthetic M11 cancellation fixture only.'},ready=Promise.withResolvers();
 const trace=[];let agent,providerCalls=0;
 const event=store.event.bind(store);
 store.event=(conversationId,type,data)=>{
  const recorded=event(conversationId,type,data);
  if(type==='approval.request')ready.resolve(data);
  if(type==='approval.resolved'&&data.allowed){
   // A durable cancellation arrives after approval, before the local signal.
   // This is a real Store transition, not a replacement tool implementation.
   store.state(run.id,'cancelled');
   trace.push({event:type,persistedStatus:store.run(run.id).status,signalAborted:agent.active.get(run.id).signal.aborted});
  }
  if(type==='file_write.operation.accepted')trace.push({event:type,persistedStatus:store.run(run.id).status,callId:data.call_id});
  return recorded;
 };
 const tools=createTools({store,root});
 agent=new Agent(store,{tools,provider:async()=>{
  providerCalls++;
  return providerCalls===1?{role:'assistant',content:null,tool_calls:[{id:callId,function:{name:'file_write',arguments:JSON.stringify(args)}}]}:{role:'assistant',content:'Synthetic fixture turn ended.'};
 }});
 t.after(async()=>{await agent.close();store.close();});
 const completion=agent.execute(run),approval=await ready.promise;
 assert.equal(agent.approve(run.id,true,approval.approval_id),true);await completion;
 const artifacts=store.artifacts(conversation.id),operations=store.events(conversation.id,0).filter(item=>item.type.startsWith('file_write.operation.'));
 let files=[];try{files=await readdir(join(root,conversation.id));}catch(error){if(error.code!=='ENOENT')throw error;}
 const written=await Promise.all(artifacts.map(async artifact=>({id:artifact.id,text:await readFile(store.getArtifact(artifact.id).path,'utf8')})));
 t.diagnostic(JSON.stringify({entry:'Agent.execute -> permission/approve -> tools.execute(file_write)',runId:run.id,callId,root,trace,providerCalls,operationTypes:operations.map(item=>item.type),artifactCount:artifacts.length,files,written,finalRunStatus:store.run(run.id).status,networkCalls:0}));
 assert.equal(trace[0].persistedStatus,'cancelled');assert.equal(trace[0].signalAborted,false);
 assert.equal(artifacts.length,0,'a durably cancelled run must not publish a new file artifact after approval');
 assert.deepEqual(files,[],'a durably cancelled run must not create file bytes');
 assert.deepEqual(operations,[],'a durably cancelled run must not acquire a new accepted file-write receipt');
 assert.equal(store.run(run.id).status,'cancelled');
 const states=store.events(conversation.id,0).filter(item=>item.type==='run.state').map(item=>item.data.run.status);
 assert.ok(states.slice(states.indexOf('cancelled')).every(status=>status==='cancelled'),'Agent must never reopen or overwrite the cancellation');
 assert.equal(providerCalls,1,'cancellation must not become another model/tool round');
});

test('M11.04 file_write independently checks persistent cancellation after approval',{timeout:10000},async t=>{
 const base=fileURLToPath(new URL('../.test-tmp/m11-file-write-run-state/',import.meta.url));await mkdir(base,{recursive:true});
 const root=await mkdtemp(join(base,'direct-')),store=new Store(':memory:');
 const run=store.accept(store.createConversation().id,'Synthetic write.','direct-state-race').run,tools=createTools({store,root}),signal=new AbortController().signal;
 t.after(async()=>{await tools.close();store.close();});
 await assert.rejects(()=>tools.execute('file_write',{name:'synthetic.txt',text:'Do not write after cancellation.'},{run,callId:'direct-state-race',signal,approve:async()=>{store.state(run.id,'cancelled');}}),/file_write_run_inactive/);
 assert.equal(signal.aborted,false);assert.equal(store.run(run.id).status,'cancelled');assert.deepEqual(store.artifacts(run.conversation_id),[]);
 assert.deepEqual(store.events(run.conversation_id,0).filter(item=>item.type.startsWith('file_write.operation.')),[]);
 assert.deepEqual(await readdir(root),[]);
});

test('M11.04 terminal cancellation preserves inspection of the original successful call without a new write',{timeout:10000},async t=>{
 const base=fileURLToPath(new URL('../.test-tmp/m11-file-write-run-state/',import.meta.url));await mkdir(base,{recursive:true});
 const root=await mkdtemp(join(base,'replay-')),store=new Store(':memory:');
 const run=store.accept(store.createConversation().id,'Synthetic write.','original-call').run,tools=createTools({store,root}),args={name:'original.txt',text:'Original synthetic bytes.'};let approvals=0;
 t.after(async()=>{await tools.close();store.close();});
 const context={run,callId:'original-call',signal:new AbortController().signal,approve:async()=>{approvals++;}};
 const original=await tools.execute('file_write',args,context);store.state(run.id,'cancelled');
 const before=store.events(run.conversation_id,0),files=await readdir(join(root,run.conversation_id));
 const recovered=await tools.execute('file_write',args,context);
 assert.deepEqual(recovered,original);assert.equal(approvals,1);assert.equal(store.run(run.id).status,'cancelled');
 assert.deepEqual(store.events(run.conversation_id,0),before);assert.deepEqual(await readdir(join(root,run.conversation_id)),files);
 assert.equal(await readFile(store.getArtifact(original.artifact_id).path,'utf8'),args.text);
});
