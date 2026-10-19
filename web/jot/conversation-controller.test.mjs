import test from 'node:test';
import assert from 'node:assert/strict';
import {RoleChatController} from './conversation-controller.mjs';
const snapshot={conversation:{conversation_id:'role-1'},as_of_seq:'0',messages:[],runs:[],activities:[],sources:[],interactions:[],artifacts:[],stream_cursors:[]};

test('pending server reservations retain the original message and malformed success cannot erase the draft receipt',async()=>{
 const calls=[];let reply=Object.assign(Error('IDEMPOTENCY_IN_PROGRESS'),{status:409});const c=new RoleChatController('role-1',{request:async(path,method,body,key)=>{calls.push(structuredClone({path,method,body,key}));if(reply instanceof Error)throw reply;return reply;}});
 await assert.rejects(()=>c.send('Original message'));assert.equal(c.pendingMessage,true);
 reply={accepted:true,message_id:'server-message',run_id:'original-run',conversation_id:'foreign'};await assert.rejects(()=>c.send('Changed message'),/发送结果尚未确认/);assert.equal(c.pendingMessage,true);
 reply={accepted:true,message_id:'server-message',run_id:'original-run',conversation_id:'role-1'};await c.send('Another changed message');assert.deepEqual(calls[1],calls[0]);assert.deepEqual(calls[2],calls[0]);assert.equal(c.pendingMessage,false);
});
test('existing run.artifact events become generated files without reconnecting or inventing an uploaded origin',()=>{
 const controller=new RoleChatController('role-1',{});controller.restore(snapshot);
 controller.apply({schema_version:'1.0',conversation_id:'role-1',seq:'1',run_id:'r',type:'run.artifact',payload:{run_id:'r',conversation_id:'role-1',artifact_id:'output',version:1,file_name:'report.md',media_type:'text/markdown',size_bytes:5,sha256:'0'.repeat(64),status:'ready',created_at:'now',download_url:'/v1/artifacts/output/download?version=1'}});
 assert.equal(controller.state.seq,'1');assert.equal(controller.state.artifacts.output.run_id,'r');assert.equal(controller.state.artifacts.output.origin,'generated');
});
test('lost send receipt retries the frozen message and key rather than changing the task',async()=>{
 const calls=[];let fail=true;const controller=new RoleChatController('role-1',{request:async(path,method,body,key)=>{calls.push({path,body,key});if(fail){fail=false;throw new Error('connection_lost');}return {accepted:true,run_id:'r',message_id:'message-r',conversation_id:'role-1'};},snapshot:async()=>snapshot,follow:async()=>{}});
 await assert.rejects(()=>controller.send('original text'),/connection_lost/);assert.equal(controller.pendingMessage,true);
 await controller.send('different draft');assert.deepEqual(calls[1],calls[0]);assert.equal(calls[0].body.content[0].text,'original text');assert.equal(controller.pendingMessage,false);
});
test('a rejected request is not retained as an uncertain accepted message',async()=>{
 const controller=new RoleChatController('role-1',{request:async()=>{throw Object.assign(new Error('denied'),{status:403});}});
 await assert.rejects(()=>controller.send('message'),/denied/);assert.equal(controller.pendingMessage,false);
});
test('ordinary Goal send freezes the native instruction on lost receipt and default messages stay unchanged',async()=>{
 const calls=[];let fail=true;const c=new RoleChatController('ordinary',{request:async(path,method,body,key)=>{calls.push(structuredClone({body,key}));if(fail){fail=false;throw Error('lost');}return {accepted:true,run_id:'r',message_id:'message-r',conversation_id:'ordinary'};}});
 await assert.rejects(()=>c.send('Find sources',[],{goalMode:true}));assert.match(calls[0].body.content[0].text,/create_goal/);
 await c.send('Changed draft',[],{goalMode:false});assert.deepEqual(calls[0],calls[1]);await c.send('Normal message');assert.equal(calls[2].body.content[0].text,'Normal message');
});

test('attachment-only messages and unknown sends freeze the exact uploaded file references',async()=>{
 const calls=[];let fail=true;const controller=new RoleChatController('role-1',{request:async(path,method,body,key)=>{calls.push(structuredClone({body,key}));if(fail){fail=false;throw new Error('connection_lost');}return {accepted:true,run_id:'r',message_id:'message-r',conversation_id:'role-1'};}});
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


test('original supplement retries its frozen run/version/key after terminal state and capability changes',async()=>{
 const calls=[];let reply=Error('lost');const c=new RoleChatController('role-1',{request:async(path,method,body,key)=>{calls.push(structuredClone({path,method,body,key}));if(reply instanceof Error)throw reply;return reply;}});
 c.state={runs:{r:{run_id:'r',conversation_id:'role-1',status:'running',version:3}}};
 await assert.rejects(()=>c.send('Original supplement',[],{originalTask:true,steeringConfigured:true}));assert.equal(c.pendingMessage,true);assert.equal(calls[0].path,'/runs/r/steer');assert.deepEqual(calls[0].body,{delivery:'original',text:'Original supplement',client_message_id:calls[0].body.client_message_id,expected_run_version:3});
 c.state.runs.r.status='succeeded';reply={accepted:true,command_id:'cmd-one',run_id:'wrong'};await assert.rejects(()=>c.send('Changed'),/发送结果尚未确认/);assert.equal(c.pendingMessage,true);
 reply=Object.assign(Error('IDEMPOTENCY_IN_PROGRESS'),{status:409});await assert.rejects(()=>c.send('Changed'));assert.equal(c.pendingMessage,true);
 reply={accepted:true,command_id:'cmd-one',run_id:'r'};await c.send('Changed');assert.equal(c.pendingMessage,false);for(const call of calls)assert.deepEqual(call,calls[0]);
});
for(const scenario of ['unconfigured','queued','attachments','foreign'])test('ordinary active supplement refuses '+scenario+' without creating another message',async()=>{
 let calls=0;const c=new RoleChatController('role-1',{request:async()=>{calls++;}});c.state={runs:{r:{run_id:'r',conversation_id:scenario==='foreign'?'another':'role-1',status:scenario==='queued'?'queued':'running',version:3}}};
 await assert.rejects(()=>c.send('Supplement',scenario==='attachments'?['image']:[],{originalTask:true,steeringConfigured:scenario!=='unconfigured'}));assert.equal(calls,0);assert.equal(c.pendingMessage,false);
});

for(const text of ['Original supplement',''])test('enabled attachment supplement freezes its original target, upload IDs and HTTP retry: '+(text?'mixed':'file only'),async()=>{const calls=[];let fail=true;const c=new RoleChatController('role-1',{request:async(path,method,body,key)=>{calls.push(structuredClone({path,method,body,key}));if(fail)throw Error('lost original receipt');return{accepted:true,command_id:'cmd-one',run_id:'r'};}});c.state={runs:{r:{run_id:'r',conversation_id:'role-1',status:'running',version:3}}};const attachments=['original-file'];await assert.rejects(()=>c.send(text,attachments,{originalTask:true,steeringConfigured:true,attachmentSteeringConfigured:true}));assert.equal(c.pendingMessage,true);assert.deepEqual(calls[0].body.attachments,['original-file']);assert.equal(calls[0].body.delivery,'original');assert.equal(calls[0].path,'/runs/r/steer');assert.equal(calls[0].body.text,text);attachments[0]='changed-file';c.state.runs.r.status='succeeded';fail=false;await c.send('changed',['different-file'],{originalTask:true,steeringConfigured:false,attachmentSteeringConfigured:false});assert.equal(c.pendingMessage,false);assert.deepEqual(calls[1],calls[0]);});
