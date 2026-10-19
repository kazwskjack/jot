import test from 'node:test';
import assert from 'node:assert/strict';
import {messageFiles} from './message-files.mjs';
const upload={artifact_id:'input',origin:'upload',status:'ready'},output={artifact_id:'output',run_id:'run',origin:'generated',status:'ready'};
const user={message_id:'user',role:'user',attachments:['input'],status:'complete',run_id:'run',created_at:'1'};
const first={message_id:'first',role:'assistant',status:'complete',run_id:'run',created_at:'2'},final={...first,message_id:'final',created_at:'3'};
const state={messages:{user,first,final},artifacts:{input:upload,output},runs:{run:{status:'succeeded'}}};
test('uploads stay beneath their user message; generated downloads appear only after the final answer',()=>{
 assert.deepEqual(messageFiles(state,user),[upload]);assert.deepEqual(messageFiles(state,first),[]);assert.deepEqual(messageFiles(state,final),[output]);
 assert.deepEqual(messageFiles({...state,runs:{run:{status:'running'}}},final),[]);
});
test('explicit output attachments keep each completed answer separate and failed answers never publish files',()=>{
 const value={...state,messages:{user,first:{...first,attachments:['output']},final}};
 assert.deepEqual(messageFiles(value,value.messages.first),[output]);assert.deepEqual(messageFiles(value,final),[]);
 assert.deepEqual(messageFiles(value,{...final,status:'failed',attachments:['output']}),[]);
});
test('final downloads retain message attachment order across reverse-ordered snapshots',()=>{
 const a={...output,artifact_id:'a'},b={...output,artifact_id:'b'},answer={...final,attachments:['a','b']};
 assert.deepEqual(messageFiles({...state,messages:{answer},artifacts:{b,a}},answer),[a,b]);
});

test('historical upload previews use the sent version even after current metadata changes',()=>{
 const pin={artifact_id:'input',version:1,sha256:'a'.repeat(64),size_bytes:12,media_type:'text/plain',file_name:'sent.txt'};
 const newer={...upload,version:2,sha256:'b'.repeat(64),size_bytes:30,media_type:'image/png',file_name:'new.png',preview_kind:'image'};
 const result=messageFiles({...state,artifacts:{input:newer}},{...user,attachment_refs:[pin]});
 assert.equal(result.length,1);for(const [key,value] of Object.entries(pin))assert.equal(result[0][key],value);
 assert.equal(result[0].preview_kind,'text');
});

test('pinned uploads survive current inventory eviction without borrowing unrelated metadata',()=>{
 const pin={artifact_id:'input',version:1,sha256:'a'.repeat(64),size_bytes:12,media_type:'text/plain',file_name:'sent.txt'};
 const result=messageFiles({...state,artifacts:{}},{...user,attachment_refs:[pin]});
 assert.equal(result.length,1);assert.equal(result[0].version,1);assert.equal(result[0].file_name,'sent.txt');
 assert.equal(result[0].origin,'upload');assert.equal('remote_path' in result[0],false);
});

test('unavailable or inconsistent pins never fall back to a current upload',()=>{
 assert.deepEqual(messageFiles(state,{...user,attachment_refs:[]}),[]);
 assert.deepEqual(messageFiles(state,{...user,attachment_refs:[{artifact_id:'foreign',version:1}]}),[]);
 assert.deepEqual(messageFiles(state,{...user,attachment_refs:[{artifact_id:'input',version:0}]}),[]);
});
