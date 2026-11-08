import test from 'node:test';
import assert from 'node:assert/strict';
import {createMatrixAdapter,createMatrixProvider} from '../../src/channels/adapters/matrix.ts';
import {ChannelARuntime} from '../../src/channels/adapters/channel-a-runtime.ts';

const room='!private-room:example.org';
const bot='@bot:example.org';
const sender='@alice:example.org';
const code='A'.repeat(43);
const bindingEvent={type:'m.room.message',sender,event_id:'$bind:example.org',
 content:{msgtype:'m.text',body:`/jot-bind ${code}`}};
function privateState(extra=[]){return [
 {type:'m.room.join_rules',state_key:'',content:{join_rule:'invite'}},
 {type:'m.room.history_visibility',state_key:'',content:{history_visibility:'joined'}},
 {type:'m.room.member',state_key:bot,content:{membership:'join'}},
 {type:'m.room.member',state_key:sender,content:{membership:'join'}},
 ...extra,
];}
function fakeFetch(state,options={}){
 return async input=>{
  const url=new URL(input);
  if(url.pathname.endsWith('/account/whoami'))return Response.json({user_id:bot});
  if(url.pathname.endsWith('/sync'))return Response.json({next_batch:'syt_next',rooms:{join:{[room]:{timeline:{events:[bindingEvent]}}}}});
  if(url.pathname.endsWith(`/rooms/${encodeURIComponent(room)}/state`)){
   if(options.stateError)return new Response('',{status:503});
   return Response.json(state);
  }
  throw Error(`unexpected_matrix_request:${url.pathname}`);
 };
}
async function poll(state,options={}){
 const client=createMatrixAdapter({baseUrl:'https://matrix.example.org',accessToken:'synthetic-token'},fakeFetch(state,options));
 await client.whoAmI();
 const forwarded=[];
 const runtime=new ChannelARuntime({channels:{matrix:{client}},forward:async message=>{
  forwarded.push(message);return {statusCode:202,body:{accepted:true,kind:'channel_binding',status:'verified'}};
 }});
 runtime.start();
 try{return {batch:await runtime.pollMatrix(),forwarded};}
 finally{await runtime.uninstall();}
}

test('Matrix proof is forwarded only from a joined invite-only pair room with joined-only history',async()=>{
 const result=await poll(privateState());
 assert.equal(result.forwarded.length,1);
 assert.equal(result.forwarded[0].channel,'matrix');
 assert.equal(result.forwarded[0].principal,sender);
 assert.equal(result.batch.receipts[0].status,'verified');
 assert.equal(result.batch.terminalRefusals,undefined);
});

test('Matrix proof from a public room or room with another joined member is terminally refused',async()=>{
 for(const state of [
  privateState().map(event=>event.type==='m.room.join_rules'?{...event,content:{join_rule:'public'}}:event),
  privateState([{type:'m.room.member',state_key:'@mallory:example.org',content:{membership:'join'}}]),
  privateState([{type:'m.room.member',state_key:'@former:example.org',content:{membership:'leave'}}]),
 ]){
  const result=await poll(state);
  assert.equal(result.forwarded.length,0);
  assert.deepEqual(result.batch.terminalRefusals.map(item=>[item.status_code,item.error_code]),
   [[403,'CHANNEL_BINDING_PRIVATE_ROOM_REQUIRED']]);
 }
});

test('Matrix room-state service failure leaves proof forwarding unattempted and the poll batch retryable',async()=>{
 const client=createMatrixAdapter({baseUrl:'https://matrix.example.org',accessToken:'synthetic-token'},fakeFetch(privateState(),{stateError:true}));
 await client.whoAmI();
 let forwarded=0;
 const runtime=new ChannelARuntime({channels:{matrix:{client}},forward:async()=>{forwarded++;return {statusCode:202,body:{accepted:true,kind:'channel_binding',status:'verified'}};}});
 runtime.start();
 try{await assert.rejects(()=>runtime.pollMatrix(),/matrix_room_state_unavailable/);assert.equal(forwarded,0);}
 finally{await runtime.uninstall();}
});

test('Matrix delivery requires the durable effect transaction and returns the homeserver receipt',async()=>{
 const requests=[];
 const provider=createMatrixProvider({baseUrl:'https://matrix.example.org',accessToken:'synthetic-token'},async(input,init)=>{
  requests.push({url:new URL(input).href,init});return Response.json({event_id:'$reply:example.org'});
 });
 await assert.rejects(()=>provider.send('Reply',room),/matrix_delivery_context_invalid/);
 const context={effectId:'reply-delivery-0123456789abcdef',generation:1,idempotencyKey:'reply-delivery-0123456789abcdef'};
 assert.deepEqual(await provider.send('Reply',room,context),{provider_message_id:'$reply:example.org'});
 assert.equal(requests.length,1);assert.equal(requests[0].init.method,'PUT');
 assert.ok(requests[0].url.endsWith('/rooms/!private-room%3Aexample.org/send/m.room.message/reply-delivery-0123456789abcdef'));
 assert.deepEqual(JSON.parse(requests[0].init.body),{msgtype:'m.text',body:'Reply'});
});
