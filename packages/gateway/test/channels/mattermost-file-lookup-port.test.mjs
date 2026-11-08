import test from 'node:test';
import assert from 'node:assert/strict';
import {createChannelAttachmentForwardV2} from '../../src/channels/attachment-forward-v2.ts';
const request={protocol:2,event:{channel:'mattermost',principal:'["https://chat.test","bot","user"]',thread_id:'["dm",""]',message_id:'post-file'},text:'Read file',attachments:[{index:0,provider_file_id:'file-one',file_name:'one.txt',media_type:'text/plain',size_bytes:8,sha256:'a'.repeat(64)}]};
test('read-only original file declaration lookup never dispatches or requires raw bytes',async()=>{
 for(const state of ['not_observed','unproven']){
  const calls=[],port=createChannelAttachmentForwardV2({url:'http://127.0.0.1:18831',token:'synthetic-internal-token',fetch:async(input,init)=>{calls.push([new URL(input).pathname,init.method,JSON.parse(init.body)]);return Response.json({protocol:2,state,original_admission:'unproven',automatic_replay:false});}});
  const result=await port.lookupOriginalRequest(request);assert.equal(result.statusCode,503);assert.deepEqual(calls,[['/internal/v2/channel/attachment-batches/lookup','POST',request]]);
 }
});

 test('lookup accepts only the original validated admitted receipt for both declared channels',async()=>{
  for(const declaration of [request,{...request,event:{channel:'matrix',principal:'@user:example.org',thread_id:'!room:example.org',message_id:'$file:example.org'}}]){
   const calls=[],receipt={accepted:true,message_id:'msg-original',run_id:'run-original',conversation_id:'conv-original'};
   const port=createChannelAttachmentForwardV2({url:'http://127.0.0.1:18831',token:'synthetic-internal-token',fetch:async(input,init)=>{calls.push(new URL(input).pathname);assert.deepEqual(JSON.parse(init.body),declaration);return Response.json({protocol:2,state:'admitted',event_sha256:'b'.repeat(64),manifest_sha256:'b'.repeat(64),receipt});}});
   const result=await port.lookupOriginalRequest(declaration);assert.equal(result.statusCode,202);assert.deepEqual(calls,['/internal/v2/channel/attachment-batches/lookup']);
  }
 });
 test('invalid declarations never reach the lookup transport or byte preparation',async()=>{
  let calls=0;const port=createChannelAttachmentForwardV2({url:'http://127.0.0.1:18831',token:'synthetic-internal-token',fetch:async()=>{calls++;assert.fail('invalid declaration escaped');}});
  for(const invalid of [{...request,owner_id:'mallory'},{...request,text:'/jot-bind secret'},{...request,attachments:[{...request.attachments[0],bytes:[1,2]}]},{...request,attachments:[{...request.attachments[0],size_bytes:104857601}]},{...request,event:{...request.event,principal:'foreign-user'}},{...request,attachments:[{...request.attachments[0],index:1}]}])assert.equal((await port.lookupOriginalRequest(invalid)).statusCode,503);
  assert.equal(calls,0);
 });
