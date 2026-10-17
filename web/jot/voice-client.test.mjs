import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {fileURLToPath} from 'node:url';
const output=await build({entryPoints:[fileURLToPath(new URL('./client.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false});
const {request,transcribeVoice}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].contents).toString('base64'));
const scope='a'.repeat(64),caps=()=>Response.json({},{headers:{'x-csrf-token':'fixture-csrf','x-workbench-draft-scope':scope}});
test('voice uses the existing same-origin multipart and returns text without a message POST',async t=>{
 const prior=globalThis.fetch;t.after(()=>{globalThis.fetch=prior;});const calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url,init});if(url.endsWith('/capabilities'))return caps();if(init.method==='POST')return Response.json({transcription_id:'voice-1',status:'queued'},{status:202});return Response.json({status:'succeeded',text:'草稿文字'});};
 await request('/capabilities');assert.equal(await transcribeVoice('chat/a',new Uint8Array([1,2]),new AbortController().signal),'草稿文字');
 const post=calls[1];assert.equal(post.url,'/workbench-api/v1/conversations/chat%2Fa/voice/transcriptions');assert.equal(post.init.credentials,'same-origin');assert.equal(post.init.headers['X-CSRF-Token'],'fixture-csrf');assert.equal(post.init.headers['Content-Type'],undefined);assert.equal(post.init.body.get('audio').type,'audio/wav');assert.equal(calls.some(x=>x.url.endsWith('/messages')),false);
});
test('failed provider job preserves the actual API reason',async t=>{
 const prior=globalThis.fetch;t.after(()=>{globalThis.fetch=prior;});globalThis.fetch=async(url,init)=>url.endsWith('/capabilities')?caps():init.method==='POST'?Response.json({transcription_id:'voice-2'},{status:202}):Response.json({status:'failed',error_code:'worker_restarted'});
 await request('/capabilities');await assert.rejects(()=>transcribeVoice('chat',new Uint8Array([1]),new AbortController().signal),/worker_restarted/);
});
test('cancellation suppresses a late success and requests cancellation of the original job',async t=>{
 const prior=globalThis.fetch;t.after(()=>{globalThis.fetch=prior;});const abort=new AbortController(),calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url,init});if(url.endsWith('/capabilities'))return caps();if(init.method==='POST')return Response.json({transcription_id:'voice-3'},{status:202});if(init.method==='DELETE')return Response.json({status:'cancelled'});abort.abort();return Response.json({status:'succeeded',text:'必须忽略'});};
 await request('/capabilities');await assert.rejects(()=>transcribeVoice('chat',new Uint8Array([1]),abort.signal),error=>error.name==='AbortError');assert.equal(calls.filter(x=>x.init.method==='DELETE').length,1);assert.ok(calls.at(-1).url.endsWith('/voice-3'));
});
test('HTTP failures retain backend status and code',async t=>{
 const prior=globalThis.fetch;t.after(()=>{globalThis.fetch=prior;});globalThis.fetch=async url=>url.endsWith('/capabilities')?caps():Response.json({error:{code:'VOICE_BUSY'}},{status:429});await request('/capabilities');await assert.rejects(()=>transcribeVoice('chat',new Uint8Array([1]),new AbortController().signal),error=>error.status===429&&error.message==='VOICE_BUSY');
});
test('changed owner scope never polls or cancels a job using the new owner credentials',async t=>{
 const prior=globalThis.fetch;t.after(()=>{globalThis.fetch=prior;});let changed=false;const calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url,init});if(url.endsWith('/capabilities'))return Response.json({},{headers:{'x-csrf-token':'fixture-csrf','x-workbench-draft-scope':changed?'b'.repeat(64):scope}});if(init.method==='POST'){changed=true;await request('/capabilities');return Response.json({transcription_id:'old-owner-job'},{status:202});}throw Error('unexpected old-owner request');};
 await request('/capabilities');await assert.rejects(()=>transcribeVoice('chat',new Uint8Array([1]),new AbortController().signal),/VOICE_SCOPE_CHANGED/);assert.equal(calls.filter(x=>x.url.endsWith('/old-owner-job')).length,0);
});
test('whole-request timeout also bounds an upload that never returns a job receipt',async t=>{
 const prior=globalThis.fetch;t.after(()=>{globalThis.fetch=prior;});globalThis.fetch=async url=>url.endsWith('/capabilities')?caps():new Promise(()=>{});await request('/capabilities');
 t.mock.timers.enable({apis:['setTimeout']});
 globalThis.fetch=async(_url,init)=>new Promise((_,reject)=>{init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});
 const result=transcribeVoice('chat',new Uint8Array([1]),new AbortController().signal);const refused=assert.rejects(result,/VOICE_TRANSCRIPTION_TIMEOUT/);t.mock.timers.tick(120001);await refused;
});
