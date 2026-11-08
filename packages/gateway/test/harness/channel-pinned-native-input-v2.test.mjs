import test from 'node:test';import assert from 'node:assert/strict';import{createHash}from'node:crypto';import{mkdirSync,mkdtempSync,rmSync}from'node:fs';import{join,resolve}from'node:path';
import{createPinnedByteStore}from'../../src/artifacts/pinned-byte-source.ts';import{OfficialSessionRunner}from'../../src/harness/official-session-runner.ts';import{SessionControllerClient}from'../../src/harness/session-controller-client.ts';
test('official initial runner uploads sealed exact bytes through original verified-file HTTP and never falls back to paths or retries unknown staging',async t=>{
 const parent=resolve('test-tmp');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'native-pinned-input-')),store=createPinnedByteStore(root);t.after(async()=>{await store.dispose();rmSync(root,{recursive:true,force:true});});
 const bytes=Buffer.from('Synthetic original sealed text'),sha256=createHash('sha256').update(bytes).digest('hex'),writer=await store.begin(sha256,bytes.length);await writer.append(bytes);await writer.seal();
 const snapshot={manifest:{protocol:1,attachments:[{artifact_id:'artifact-synthetic',version:1,sha256,size_bytes:bytes.length,media_type:'text/plain',file_name:'one.txt',kind:'text'}]},sources:store.sources(),dispose:()=>store.dispose()};
 let uploads=0,prompts=0,guardChecks=0,posted,unknown=false;
 const http=new SessionControllerClient('http://127.0.0.1:18841','synthetic-token-must-have-thirty-two-characters',async(_url,init)=>{
  uploads++;const chunks=[];for await(const chunk of init.body)chunks.push(Buffer.from(chunk));assert.deepEqual(Buffer.concat(chunks),bytes);
  if(unknown)throw Error('synthetic_unknown_stage_ack');
  return new Response(JSON.stringify({receipt_id:'receipt-exact',file:{attachmentId:'sha256:'+sha256,bytes:bytes.length,name:'one.txt'}}),{status:200,headers:{'content-type':'application/json'}});
 });
 const client={create:async()=>({}),stageFile:async()=>assert.fail('pinned input must not reopen a path'),stageVerifiedFile:http.stageVerifiedFile.bind(http),prompt:async(_session,_id,parts)=>{prompts++;posted=parts;return{};},async *follow(){yield{type:'snapshot',cursor:0,records:[]};yield{type:'event',event:{type:'assistant/message',seq:1,data:{message:{content:[{type:'text',text:'Synthetic answer'}]}}}};yield{type:'event',event:{type:'turn/end',seq:2,data:{reason:{kind:'completed'}}}};}};
 const input={enabled:true,taskRequestId:'run-fixture',message:'Read',sessionRef:'session-fixture',deferCompletionProbe:true,attachments:[],pinnedAttachments:snapshot,beforeInputDispatch:()=>{guardChecks++;},originalAdmission:{executionLease:{owner:'worker-fixture',generation:1}}};
 const runner=new OfficialSessionRunner(client,{cwd:root,agentPreset:'jot-general'});await runner.run(input);
 assert.equal(uploads,1);assert.equal(prompts,1);assert.ok(guardChecks>=3);assert.equal(posted.at(-1).receipt_id,'receipt-exact');assert.ok(posted.some(part=>part.type==='text'&&part.text.includes('base_version=1')));
 unknown=true;await assert.rejects(()=>runner.run({...input,taskRequestId:'run-unknown'}),/synthetic_unknown_stage_ack/);assert.equal(uploads,2);assert.equal(prompts,1);
 const unsupported=new OfficialSessionRunner({...client,stageVerifiedFile:undefined},{cwd:root,agentPreset:'jot-general'});await assert.rejects(()=>unsupported.run({...input,taskRequestId:'run-no-capability'}),/session_file_upload_unavailable/);assert.equal(prompts,1);
});
