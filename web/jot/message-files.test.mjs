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
