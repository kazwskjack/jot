import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join, resolve} from 'node:path';
import {buildServer} from '../../packages/gateway/src/server.ts';
import {HarnessCoordinator} from '../../packages/gateway/src/harness/coordinator.ts';
import {pinRunNativeSession} from '../../packages/gateway/src/harness/run-native-session.ts';
import {ConversationForkWriter} from './conversation-fork-controller.mjs';
import {ConversationForkAction} from './conversation-fork-action.mjs';

const source={conversation_id:'source-conversation',version:4};
const message={message_id:'source-message',status:'complete'};
const memoryStorage=()=>{const values=new Map();return{values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};};
const receipt=selection=>({conversation_id:'target-'+selection.through_message_id,fork_id:'fork-'+selection.through_message_id,state:'ready',source:{conversation_id:selection.sourceConversationId,through_message_id:selection.throughMessageId,head_sha256:'a'.repeat(64)}});

for(const code of ['FORK_SOURCE_CHANGED','FORK_BOUNDARY_NOT_FOUND']){
 test(code+' releases only the no-effect intent so a refreshed message can create a new request',async()=>{
  const calls=[];let attempt=0;
  const writer=new ConversationForkWriter(async(path,method,body,key)=>{
   calls.push({path,method,body,key});
   attempt++;
   if(attempt===1)throw Object.assign(Error(code),{status:409});
   return receipt({sourceConversationId:source.conversation_id,throughMessageId:'refreshed-message'});
  });
  await assert.rejects(()=>writer.fork(source,message),error=>error.status===409&&error.message===code);
  assert.equal(writer.pending,false);
  const refreshed={...source,version:5},nextMessage={message_id:'refreshed-message',status:'complete'};
  await writer.fork(refreshed,nextMessage);
  assert.equal(calls.length,2);
  assert.notEqual(calls[0].key,calls[1].key);
  assert.deepEqual(calls[1].body,{expected_version:5,through_message_id:'refreshed-message'});
  assert.equal(writer.pending,false);
 });
}

test('unknown fork intent survives reload and retries the exact request without sending on restore',async()=>{
 const storage=memoryStorage(),calls=[];let attempt=0;
 const request=async(...args)=>{calls.push(structuredClone(args));if(attempt++===0)throw Error('gateway_reply_lost');return receipt({sourceConversationId:source.conversation_id,throughMessageId:message.message_id});};
 const first=new ConversationForkWriter(request,{storage,sourceConversationId:source.conversation_id});
 await assert.rejects(()=>first.fork(source,message),/gateway_reply_lost/);
 assert.equal(calls.length,1);assert.equal(storage.values.size,1);
 const saved=JSON.parse(storage.values.values().next().value);
 assert.deepEqual([saved.path,saved.method,saved.body,saved.key],calls[0]);
 assert.doesNotMatch(JSON.stringify(saved),/messages|content|attachments/i);
 const restored=new ConversationForkWriter(request,{storage,sourceConversationId:source.conversation_id});
 assert.equal(calls.length,1,'restoring intent must not post automatically');
 assert.deepEqual(restored.pendingSelection,{sourceConversationId:source.conversation_id,expectedVersion:source.version,throughMessageId:message.message_id});
 await restored.retry();
 assert.deepEqual(calls[1],calls[0]);assert.equal(restored.pending,false);assert.equal(storage.values.size,0);
});

test('unavailable session storage prevents the first fork POST',async()=>{
 let posts=0;const storage={getItem:()=>null,setItem(){throw Error('quota');},removeItem(){}};
 const writer=new ConversationForkWriter(async()=>{posts++;return receipt({sourceConversationId:source.conversation_id,throughMessageId:message.message_id});},{storage,sourceConversationId:source.conversation_id});
 await assert.rejects(()=>writer.fork(source,message),error=>error.message==='FORK_INTENT_STORAGE_UNAVAILABLE');
 assert.equal(posts,0);assert.equal(writer.pending,true);
});

test('a known no-effect fork response clears its persisted intent',async()=>{
 const storage=memoryStorage(),failure=Object.assign(Error('FORK_SOURCE_CHANGED'),{status:409});
 const writer=new ConversationForkWriter(async()=>{throw failure;},{storage,sourceConversationId:source.conversation_id});
 await assert.rejects(()=>writer.fork(source,message),error=>error===failure);
 assert.equal(writer.pending,false);assert.equal(storage.values.size,0);
});

for(const code of ['FORK_ATTACHMENT_COUNT_INVALID','FORK_ATTACHMENT_AGGREGATE_SIZE_INVALID']){
 test(code+' releases a known 413 no-effect request after an unknown retry',async()=>{
  const calls=[];let attempt=0;
  const writer=new ConversationForkWriter(async(path,method,body,key)=>{
   calls.push({path,method,body,key});
   attempt++;
   if(attempt===1)throw Error('connection_lost');
   if(attempt===2)throw Object.assign(Error(code),{status:413});
   return receipt({sourceConversationId:source.conversation_id,throughMessageId:'smaller-boundary'});
  });
  await assert.rejects(()=>writer.fork(source,message),/connection_lost/);
  assert.equal(writer.pending,true);
  await assert.rejects(()=>writer.retry(),error=>error.status===413&&error.message===code);
  assert.equal(writer.pending,false);
  const smaller={...source,version:5},nextMessage={message_id:'smaller-boundary',status:'complete'};
  await writer.fork(smaller,nextMessage);
  assert.deepEqual(calls[0],calls[1]);
  assert.notEqual(calls[2].key,calls[1].key);
  assert.deepEqual(calls[2].body,{expected_version:5,through_message_id:'smaller-boundary'});
 });
}

for(const [code,status] of [['IDEMPOTENCY_CONFLICT',409],['IDEMPOTENCY_IN_PROGRESS',409],['FORK_SOURCE_UNAVAILABLE',503]]){
 test(code+' retains the frozen fork intent because the effect is not known to be absent',async()=>{
  const calls=[];const failure=Object.assign(Error(code),{status});
  const writer=new ConversationForkWriter(async(path,method,body,key)=>{calls.push({path,method,body,key});throw failure;});
  await assert.rejects(()=>writer.fork(source,message),error=>error===failure);
  assert.equal(writer.pending,true);
  await assert.rejects(()=>writer.retry(),error=>error===failure);
  assert.equal(calls.length,2);
  assert.deepEqual(calls[1],calls[0]);
  assert.equal(writer.pending,true);
 });
}

test('FORK_CANCELLED preserves the exact pending source message and role until explicit retry creates one inert branch',{timeout:30000},async t=>{
 const scratch=resolve('.test-tmp');await mkdir(scratch,{recursive:true});const root=await mkdtemp(join(scratch,'m02-05-fork-cancelled-'));
 let service;const sessionId='native-fork-cancelled-session',csrf='m02-05-fork-cancelled-csrf',sourceReads=[];let sourceRunId='';
 t.after(async()=>{if(service){await service.app.close();if(service.db.isOpen)service.db.close();}await rm(root,{recursive:true,force:true});});
 service=await buildServer({databasePath:join(root,'gateway.sqlite'),uploadRoot:join(root,'uploads'),workbenchRoot:join(root,'workspaces'),workspaces:['ws'],
  templateRoot:fileURLToPath(new URL('../../packages/gateway/file-engine/templates/',import.meta.url)),csrfToken:csrf,allowedOrigins:['https://fixture.invalid'],
  conversationForkSourceClient:{inspectConversationForkSource:async requested=>{
   sourceReads.push(requested);assert.equal(requested,sessionId);
   return{meta:{id:sessionId,version:4,createdAt:123,origin:'main',isSeeded:false},inheritedEventCount:0,
    events:[{seq:0,time:1,type:'user/message',data:{source:{kind:'user',rpcId:sourceRunId}}}]};
  }}
 });
 const source=service.conversations.create('ui-owner',{workspace_id:'ws',title:'Original source',model:{provider:'fixture',model:'fixture'}});
 const now=new Date().toISOString();service.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(source.conversation_id,'ui-owner',sessionId,now,now);
 const input=service.runs.enqueue(source.conversation_id,'ui-owner',{client_message_id:'client-source-fork-cancelled',content:[{type:'text',text:'Original transcript body'}]});
 sourceRunId=input.run_id;const coordinator=new HarnessCoordinator(service.db,service.runs,service.events),lease=coordinator.claimNext('fork-cancelled-worker',30000);assert.ok(lease);
 coordinator.start(lease);pinRunNativeSession(service.db,input.run_id,{owner:lease.owner,generation:lease.generation},sessionId);
 service.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(input.run_id);
 const originalMessage=service.runs.message(input.message_id),selection={conversation_id:source.conversation_id,version:source.version};
 assert.equal(originalMessage.role,'user');assert.equal(originalMessage.status,'complete');

 const storage=memoryStorage(),calls=[];let cancelOnce=true;
 const request=async(path,method,body,key)=>{
  calls.push({path,method,body:structuredClone(body),key});
  if(cancelOnce){cancelOnce=false;throw Object.assign(Error('FORK_CANCELLED'),{status:409});}
  const response=await service.app.inject({method,url:`/v1${path}`,headers:{'x-user-id':'ui-owner','x-jot-actor':'web','x-csrf-token':csrf,origin:'https://fixture.invalid','idempotency-key':key},payload:body});
  if(response.statusCode!==201)throw Object.assign(Error(response.json().error?.code??'fork_request_failed'),{status:response.statusCode});
  return response.json();
 };
 const states=[],opened=[],sourceMessage={message_id:input.message_id,role:originalMessage.role,status:originalMessage.status};
 const action=writer=>ConversationForkAction({source:selection,message:sourceMessage,writer,onOpenConversation:(id,value)=>opened.push({id,value}),onStateChange:state=>states.push(state)});
 const first=new ConversationForkWriter(request,{storage,sourceConversationId:source.conversation_id});
 await action(first).props.children.props.onClick();
 assert.equal(first.pending,true);assert.equal(calls.length,1);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_conversation_forks').get().n,0);
 assert.deepEqual(states.at(-1),{state:'retryable',retryable:true,error:'副本状态未确认；可以重试原请求。'});
 const saved=JSON.parse(storage.values.get(`jot:conversation-fork:${encodeURIComponent(source.conversation_id)}`));
 assert.deepEqual([saved.sourceConversationId,saved.path,saved.method,saved.body,saved.key],
  [source.conversation_id,`/conversations/${encodeURIComponent(source.conversation_id)}/fork`,'POST',
   {expected_version:source.version,through_message_id:input.message_id},calls[0].key]);
 assert.deepEqual(first.pendingSelection,{sourceConversationId:source.conversation_id,expectedVersion:source.version,throughMessageId:input.message_id});

 const restored=new ConversationForkWriter(request,{storage,sourceConversationId:source.conversation_id});
 assert.equal(calls.length,1,'restoring a cancelled intent does not automatically resend it');
 assert.deepEqual(restored.pendingSelection,{sourceConversationId:source.conversation_id,expectedVersion:source.version,throughMessageId:input.message_id});
 await action(restored).props.children.props.onClick();
 assert.equal(calls.length,2);assert.deepEqual(calls[1],calls[0],'explicit retry repeats the exact path, method, source boundary, body and key');
 assert.equal(restored.pending,false);assert.equal(storage.values.size,0);assert.equal(states.at(-1).state,'ready');
 const durableReceipt=JSON.parse(service.db.prepare('SELECT receipt_json FROM ga_conversation_forks WHERE source_conversation_id=?').get(source.conversation_id).receipt_json);
 assert.equal(opened.length,1);assert.equal(opened[0].id,durableReceipt.conversation_id);assert.deepEqual(opened[0].value,durableReceipt);
 assert.equal(opened[0].value.source.conversation_id,source.conversation_id);assert.equal(opened[0].value.source.through_message_id,input.message_id);

 const fork=service.db.prepare('SELECT * FROM ga_conversation_forks WHERE source_conversation_id=?').get(source.conversation_id);assert.ok(fork);
 const manifest=JSON.parse(fork.manifest_json),target=String(fork.target_conversation_id);
 assert.equal(manifest.source.conversation_id,source.conversation_id);assert.equal(manifest.source.through_message_id,input.message_id);
 assert.deepEqual(manifest.messages.map(item=>({message_id:item.message_id,role:item.role})),[{message_id:input.message_id,role:originalMessage.role}]);
 const targetMessages=service.db.prepare('SELECT id,run_id,role,status FROM ga_messages WHERE conversation_id=?').all(target);
 assert.deepEqual(targetMessages.map(({run_id,role,status})=>({run_id,role,status})),[{run_id:null,role:'user',status:'complete'}]);
 assert.equal(service.db.prepare('SELECT count(*) n FROM ga_runs WHERE conversation_id=?').get(target).n,0,'the branch has no copied execution run');
 assert.equal(service.db.prepare('SELECT count(*) n FROM ga_worker_leases WHERE resource_id IN (SELECT id FROM ga_runs WHERE conversation_id=?)').get(target).n,0,'the branch has no copied execution lease');
 assert.equal(service.db.prepare('SELECT count(*) n FROM ga_interactions WHERE conversation_id=?').get(target).n,0,'the branch has no copied approval interaction');
 assert.equal(service.db.prepare('SELECT count(*) n FROM ga_conversation_goal_controls WHERE conversation_id=?').get(target).n,0,'the branch has no copied execution-control authority');

 const readsBeforeForeign=sourceReads.length,foreign=await service.app.inject({method:'POST',url:`/v1/conversations/${source.conversation_id}/fork`,
  headers:{'x-user-id':'other-owner','x-jot-actor':'web','x-csrf-token':csrf,origin:'https://fixture.invalid','idempotency-key':'foreign-fork-key'},
  payload:{expected_version:source.version,through_message_id:input.message_id}});
 assert.equal(foreign.statusCode,404);assert.equal(sourceReads.length,readsBeforeForeign);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_conversation_forks').get().n,1);
});
