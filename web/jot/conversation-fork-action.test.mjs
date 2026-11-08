import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationForkAction} from './conversation-fork-action.mjs';
import {ConversationForkWriter,conversationForkRetrySource} from './conversation-fork-controller.mjs';

const source={conversation_id:'source-conversation',version:4};
const message={message_id:'source-message',status:'complete'};
const memoryStorage=()=>{const values=new Map();return{values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};};

for(const [code,expected] of [
 ['FORK_SOURCE_CHANGED','来源对话已变化；请刷新后重新选择消息。'],
 ['FORK_BOUNDARY_NOT_FOUND','选中的消息已不存在；请刷新后重新选择消息。'],
])test(`${code} tells the user to refresh and select a new message`,async()=>{
 const error=Object.assign(new Error(code),{status:409}),states=[];
 const writer={pending:false,fork:async()=>{throw error;},retry:async()=>{throw error;}};
 const tree=ConversationForkAction({source,message,writer,onOpenConversation:()=>{},onStateChange:state=>states.push(state)});
 await tree.props.children.props.onClick();
 assert.deepEqual(states.at(-1),{state:'failed',retryable:false,error:expected});
});

test('restored retry survives a newer conversation version and reuses the frozen request',async()=>{
 const storage=memoryStorage(),calls=[],opened=[];let attempt=0;
 const request=async(...args)=>{calls.push(structuredClone(args));if(attempt++===0)throw Error('gateway_reply_lost');return{conversation_id:'target-conversation',fork_id:'fork-1',state:'ready',source:{conversation_id:source.conversation_id,through_message_id:message.message_id,head_sha256:'a'.repeat(64)}};};
 const first=new ConversationForkWriter(request,{storage,sourceConversationId:source.conversation_id});
 await assert.rejects(()=>first.fork(source,message),/gateway_reply_lost/);
 const restored=new ConversationForkWriter(request,{storage,sourceConversationId:source.conversation_id});
 const newerSource={...source,version:source.version+1};
 const retrySource=conversationForkRetrySource(newerSource,restored.pendingSelection,message.message_id);
 const tree=ConversationForkAction({source:retrySource,message,writer:restored,onOpenConversation:(id,receipt)=>opened.push({id,receipt})});
 await tree.props.children.props.onClick();
 assert.deepEqual(calls[1],calls[0]);assert.equal(restored.pending,false);assert.equal(storage.values.size,0);
 assert.equal(opened.length,1);assert.equal(opened[0].id,'target-conversation');
});

test('idempotency conflicts keep the original request retryable and do not expose server text',async()=>{
 const error=Object.assign(new Error('private server detail'),{status:409}),states=[];
 const selection={sourceConversationId:source.conversation_id,expectedVersion:source.version,throughMessageId:message.message_id};
 const writer={pending:true,pendingSelection:selection,fork:async()=>{},retry:async()=>{throw error;}};
 const tree=ConversationForkAction({source,message,writer,onOpenConversation:()=>{},onStateChange:state=>states.push(state)});
 await tree.props.children.props.onClick();
 assert.deepEqual(states.at(-1),{state:'retryable',retryable:true,error:'副本状态未确认；可以重试原请求。'});
});

for(const [code,guidance] of [
 ['FORK_ATTACHMENT_COUNT_INVALID','副本附件数量超过限制；请选择更早的消息边界后重试。'],
 ['FORK_ATTACHMENT_AGGREGATE_SIZE_INVALID','副本附件总大小超过限制；请选择更早的消息边界后重试。']
])test(`${code} releases the known 413 request and explains how to choose a new boundary`,async()=>{
 const states=[];let refreshes=0;
 const writer=new ConversationForkWriter(async()=>{throw Object.assign(Error(code),{status:413});});
 const tree=ConversationForkAction({source,message,writer,onOpenConversation:()=>{},onNoEffect:()=>{refreshes++;},onStateChange:state=>states.push(state)});
 await tree.props.children.props.onClick();
 assert.equal(writer.pending,false);
 assert.equal(refreshes,0,'attachment limit rejection does not need a source refresh');
 assert.deepEqual(states.at(-1),{state:'failed',retryable:false,error:guidance});
});

test('a durable receipt returned after a lost acknowledgement opens the fork on exact retry',async()=>{
 const calls=[],states=[],opened=[];let first=true;
 const writer=new ConversationForkWriter(async(path,method,body,key)=>{
  calls.push(structuredClone({path,method,body,key}));
  if(first){first=false;throw Object.assign(Error('gateway_reply_lost'),{status:503});}
  return {conversation_id:'target-conversation',fork_id:'fork-1',state:'ready',source:{conversation_id:source.conversation_id,through_message_id:message.message_id,head_sha256:'a'.repeat(64)}};
 });
 const activate=async()=>{
  const tree=ConversationForkAction({source,message,writer,onOpenConversation:(id,receipt)=>opened.push({id,receipt}),onStateChange:state=>states.push(state)});
  await tree.props.children.props.onClick();
 };
 await activate();
 assert.equal(writer.pending,true);
 assert.equal(states.at(-1).state,'retryable');
 await activate();
 assert.deepEqual(calls[1],calls[0]);
 assert.equal(writer.pending,false);
 assert.equal(states.at(-1).state,'ready');
 assert.equal(opened.length,1);
 assert.equal(opened[0].id,'target-conversation');
});

for(const [code,guidance] of [
 ['FORK_SOURCE_CHANGED','来源对话已变化；请刷新后重新选择消息。'],
 ['FORK_BOUNDARY_NOT_FOUND','选中的消息已不存在；请刷新后重新选择消息。']
])test(`${code} after an unknown retry refreshes before a new boundary gets a new key`,{timeout:5000},async()=>{
 const calls=[],states=[];let attempt=0,refreshes=0,refreshed;
 let startRefresh,finishRefresh;
 const refreshStarted=new Promise(resolve=>{startRefresh=resolve}),refreshGate=new Promise(resolve=>{finishRefresh=resolve});
 const writer=new ConversationForkWriter(async(path,method,body,key)=>{
  calls.push(structuredClone({path,method,body,key}));
  attempt++;
  if(attempt===1)throw Error('connection_lost');
  if(attempt===2)throw Object.assign(Error(code),{status:409});
  return {conversation_id:'target-refreshed',fork_id:'fork-2',state:'ready',source:{conversation_id:source.conversation_id,through_message_id:'refreshed-message',head_sha256:'b'.repeat(64)}};
 });
 const activate=(currentSource,currentMessage)=>{
  const tree=ConversationForkAction({source:currentSource,message:currentMessage,writer,onOpenConversation:()=>{},onNoEffect:async()=>{
   refreshes++;startRefresh();await refreshGate;
   refreshed={source:{...source,version:5},message:{message_id:'refreshed-message',status:'complete'}};
  },onStateChange:state=>states.push(state)});
  return tree.props.children.props.onClick();
 };
 await activate(source,message);
 assert.equal(writer.pending,true);
 assert.equal(refreshes,0,'an unknown result does not release or refresh the frozen request');
 assert.equal(states.at(-1).state,'retryable');
 const knownReject=activate(source,message);
 await refreshStarted;
 let settled=false;const observed=knownReject.then(()=>{settled=true;});
 await Promise.resolve();
 assert.equal(settled,false,'the action holds the writer until the source refresh completes');
 finishRefresh();
 await observed;
 assert.equal(writer.pending,false);
 assert.equal(refreshes,1);
 assert.deepEqual(states.at(-1),{state:'failed',retryable:false,error:guidance});
 await activate(refreshed.source,refreshed.message);
 assert.equal(calls[0].key,calls[1].key,'unknown outcome retries the original request');
 assert.notEqual(calls[2].key,calls[1].key,'known no-effect rejection allows a fresh request');
 assert.deepEqual(calls[2].body,{expected_version:5,through_message_id:'refreshed-message'});
});
