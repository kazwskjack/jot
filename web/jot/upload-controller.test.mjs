import test from 'node:test';
import assert from 'node:assert/strict';
import {UploadController} from './upload-controller.mjs';
const file=()=>new File(['attachment fixture'],'sample.txt',{type:'text/plain'});
const artifact=sha=>({artifact_id:'artifact-fixture',conversation_id:'chat-fixture',version:1,origin:'upload',status:'ready',sha256:sha,size_bytes:18,file_name:'sample.txt',media_type:'text/plain'});
for(const failedStage of ['init','content','complete'])test(`lost ${failedStage} receipt retries the same file, request and key`,async()=>{
 const calls=[];let failed=false,sha;
 const upload=new UploadController('chat-fixture',{request:async(path,method,body,key)=>{
  calls.push({path,method,body,key});const stage=path.endsWith('/content')?'content':path.endsWith('/complete')?'complete':'init';
  if(stage==='init')sha=body.sha256;
  if(stage===failedStage&&!failed){failed=true;throw new Error('receipt_lost');}
  return stage==='init'?{upload_id:'upload-fixture',max_bytes:1000,expires_at:new Date(Date.now()+3600000).toISOString()}:stage==='complete'?artifact(sha):undefined;
 }});
 const entry=upload.add(file(),1000);await assert.rejects(()=>upload.upload(entry.id),/receipt_lost/);
 assert.equal(entry.status,'uncertain');assert.throws(()=>upload.remove(entry.id),/upload_unconfirmed/);
 await upload.upload(entry.id);assert.equal(entry.status,'ready');assert.deepEqual(upload.references(),['artifact-fixture']);
 const stageCalls=calls.filter(call=>failedStage==='init'?call.path.endsWith('/uploads'):call.path.endsWith(`/${failedStage}`));
 assert.equal(stageCalls.length,2);assert.deepEqual(stageCalls[0],stageCalls[1]);assert.equal(calls.filter(call=>call.path.endsWith('/uploads')).length,failedStage==='init'?2:1);
});
test('invalid completion receipt never attaches a different conversation or bytes',async()=>{
 const upload=new UploadController('chat-fixture',{request:async(path,method,body)=>path.endsWith('/uploads')?{upload_id:'upload-fixture',max_bytes:1000,expires_at:new Date(Date.now()+3600000).toISOString()}:path.endsWith('/complete')?{...artifact(body.sha256),conversation_id:'someone-else'}:undefined});
 const entry=upload.add(file(),1000);await assert.rejects(()=>upload.upload(entry.id),/upload_receipt_invalid/);assert.equal(entry.status,'uncertain');assert.throws(()=>upload.references(),/upload_not_ready/);
});
test('size limits are checked before reading bytes or making requests',()=>{
 const upload=new UploadController('chat-fixture',{request:()=>assert.fail('must not request')});
 assert.throws(()=>upload.add(file(),10),/upload_size_invalid/);assert.throws(()=>upload.add(new File([],'empty'),1000),/upload_size_invalid/);
 assert.throws(()=>upload.add(file(),undefined),/upload_limit_unavailable/);assert.equal(upload.entries.length,0);
});
test('timeouts and in-progress responses retain the original stage; definite denials can be removed',async()=>{
 for(const status of [408,409,403]){
  const upload=new UploadController('chat-fixture',{request:async()=>{throw Object.assign(new Error('denied'),{status});}}),entry=upload.add(file(),1000);
  await assert.rejects(()=>upload.upload(entry.id));assert.equal(entry.status,status===403?'rejected':'uncertain');
  if(status===403){upload.remove(entry.id);assert.equal(upload.entries.length,0);}else assert.throws(()=>upload.remove(entry.id),/upload_unconfirmed/);
 }
});
test('one in-flight upload cannot be replaced or uploaded twice',async()=>{
 let unblock,calls=0;const hold=new Promise(resolve=>unblock=resolve);
 const upload=new UploadController('chat-fixture',{request:async(path,method,body)=>{calls++;if(path.endsWith('/uploads')){await hold;return {upload_id:'upload-fixture',max_bytes:1000,expires_at:new Date(Date.now()+3600000).toISOString()};}if(path.endsWith('/complete'))return artifact(body.sha256);}});
 const entry=upload.add(file(),1000),running=upload.upload(entry.id);await new Promise(resolve=>setTimeout(resolve,10));
 await assert.rejects(()=>upload.upload(entry.id),/upload_busy/);assert.throws(()=>upload.remove(entry.id),/upload_unconfirmed/);unblock();await running;assert.equal(calls,3);
 upload.clearSent();assert.equal(upload.entries.length,0);
});
