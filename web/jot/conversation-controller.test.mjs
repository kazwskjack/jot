import test from 'node:test';
import assert from 'node:assert/strict';
import {RoleChatController} from './conversation-controller.mjs';
const snapshot={conversation:{conversation_id:'role-1'},as_of_seq:'0',messages:[],runs:[],activities:[],sources:[],interactions:[],artifacts:[],stream_cursors:[]};
test('existing run.artifact events become generated files without reconnecting or inventing an uploaded origin',()=>{
 const controller=new RoleChatController('role-1',{});controller.restore(snapshot);
 controller.apply({schema_version:'1.0',conversation_id:'role-1',seq:'1',run_id:'r',type:'run.artifact',payload:{run_id:'r',conversation_id:'role-1',artifact_id:'output',version:1,file_name:'report.md',media_type:'text/markdown',size_bytes:5,sha256:'0'.repeat(64),status:'ready',created_at:'now',download_url:'/v1/artifacts/output/download?version=1'}});
 assert.equal(controller.state.seq,'1');assert.equal(controller.state.artifacts.output.run_id,'r');assert.equal(controller.state.artifacts.output.origin,'generated');
});
test('lost send receipt retries the frozen message and key rather than changing the task',async()=>{
 const calls=[];let fail=true;const controller=new RoleChatController('role-1',{request:async(path,method,body,key)=>{calls.push({path,body,key});if(fail){fail=false;throw new Error('connection_lost');}return {accepted:true,run_id:'r'};},snapshot:async()=>snapshot,follow:async()=>{}});
 await assert.rejects(()=>controller.send('original text'),/connection_lost/);assert.equal(controller.pendingMessage,true);
 await controller.send('different draft');assert.deepEqual(calls[1],calls[0]);assert.equal(calls[0].body.content[0].text,'original text');assert.equal(controller.pendingMessage,false);
});
test('a rejected request is not retained as an uncertain accepted message',async()=>{
 const controller=new RoleChatController('role-1',{request:async()=>{throw Object.assign(new Error('denied'),{status:403});}});
 await assert.rejects(()=>controller.send('message'),/denied/);assert.equal(controller.pendingMessage,false);
});

test('attachment-only messages and unknown sends freeze the exact uploaded file references',async()=>{
 const calls=[];let fail=true;const controller=new RoleChatController('role-1',{request:async(path,method,body,key)=>{calls.push(structuredClone({body,key}));if(fail){fail=false;throw new Error('connection_lost');}return {accepted:true};}});
 await assert.rejects(()=>controller.send('', ['test-uploaded-file']),/connection_lost/);assert.equal(controller.pendingMessage,true);
 await controller.send('different draft',['different-file']);assert.deepEqual(calls[0],calls[1]);assert.deepEqual(calls[0].body.content,[{type:'file',artifact_id:'test-uploaded-file'}]);
});

test('invalid or duplicate attachment references cannot create a pending send',async()=>{
 let calls=0;const controller=new RoleChatController('role-1',{request:async()=>{calls++;return {};}});
 for(const refs of [[null],[''],['file','file']])await assert.rejects(()=>controller.send('message',refs),/invalid_attachments/);
 assert.equal(calls,0);assert.equal(controller.pendingMessage,false);
});
test('events stay in their role conversation and final answers replace the streaming shell',()=>{
 const controller=new RoleChatController('role-1',{});controller.restore(snapshot);
 const frame=(seq,type,payload)=>({seq:String(seq),schema_version:'1.0',conversation_id:'role-1',run_id:'r',at:'now',type,payload});
 const first=frame(1,'assistant.delta',{message_id:'stream-r',block_id:'b',kind:'text',attempt_id:'a',delta_index:0,text:'Hello'});
 controller.apply(first);controller.apply(first);assert.equal(controller.state.messages['stream-r'].blocks[0].text,'Hello');
 controller.apply(frame(2,'message.created',{message_id:'final-r',run_id:'r',role:'assistant',status:'complete',blocks:[{block_id:'final',kind:'text',text:'Hello'}],created_at:'now'}));
 assert.equal(Object.keys(controller.state.messages).length,1);assert.throws(()=>controller.apply({...first,seq:'3',conversation_id:'another'}),/WRONG_CONVERSATION/);
 controller.restore(snapshot);assert.equal(controller.state.seq,'2');assert.equal(Object.keys(controller.state.messages).length,1);
});
test('a sequence gap reloads authoritative state before the next stream and stop aborts it',async()=>{
 let snapshots=0,streams=0;let secondStream;
 const reached=new Promise(resolve=>secondStream=resolve);
 const controller=new RoleChatController('role-1',{snapshot:async()=>({...snapshot,as_of_seq:String(snapshots++?5:0)}),follow:async(id,after,receive,signal)=>{
  streams++;if(streams===1){receive({schema_version:'1.0',conversation_id:id,run_id:'r',seq:'2',type:'run.state',payload:{run_id:'r'}});return;}
  assert.equal(after,'5');secondStream();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
 }});
 const running=controller.start();await reached;controller.stop();await running;assert.equal(snapshots,2);assert.equal(streams,2);
});
