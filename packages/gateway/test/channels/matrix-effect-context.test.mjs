import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {createMatrixProvider} from '../../src/channels/adapters/matrix.ts';
import {fixture,registerTaskOutput,enqueuePinned,workerFor} from './fixtures/matrix-file-context-support.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function file(t){const parent=resolve('test-tmp');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'matrix-effect-'));t.after(()=>{const rel=relative(parent,root);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(root,{recursive:true,force:true});});const bytes=Buffer.from('Pinned part bytes'),path=join(root,'part.txt');writeFileSync(path,bytes);return{root,bytes,path};}
const config={baseUrl:'https://matrix.example.test',accessToken:'synthetic-context-token'};
test('Matrix sendFile rejects absent or text-only context before any upload request',async t=>{
 const f=file(t),calls=[];const provider=createMatrixProvider(config,async(input,init)=>{calls.push([String(input),init.method]);return Response.json({content_uri:'mxc://matrix.example.test/file',event_id:'$receipt:example.test'});});
 for(const context of [undefined,{effectId:'effect-1',generation:1,idempotencyKey:'effect-1'}])await assert.rejects(()=>provider.sendFile(f.path,'!room:example.test','part.txt',context),/matrix_delivery_context_invalid/);
 assert.equal(calls.length,0);
});
test('Matrix immutable part keys are stable across lease generations, distinct by part, and bind bytes before upload',async t=>{
 const {fileDeliveryContext}=await import('../../src/channels/delivery-effect-context.ts');const f=file(t),calls=[];
 const provider=createMatrixProvider(config,async(input,init)=>{calls.push([new URL(input).pathname,init.method]);return Response.json(init.method==='POST'?{content_uri:'mxc://matrix.example.test/file'}:{event_id:'$receipt:example.test'});});
 const part={artifactId:'artifact-fixed',version:1,manifestSha256:'a'.repeat(64),partIndex:1,partSha256:sha(f.bytes),partSizeBytes:f.bytes.length,displayName:'part.txt'};
 const one=fileDeliveryContext('effect-1',1,part),reopened=fileDeliveryContext('effect-1',2,part),two=fileDeliveryContext('effect-1',1,{...part,partIndex:2});
 assert.equal(one.idempotencyKey,reopened.idempotencyKey);assert.notEqual(one.idempotencyKey,two.idempotencyKey);
 await provider.sendFile(f.path,'!room:example.test','part.txt',one);await provider.sendFile(f.path,'!room:example.test','part.txt',two);
 const sends=calls.filter(([,method])=>method==='PUT').map(([url])=>url);assert.equal(sends.length,2);assert.notEqual(sends[0],sends[1]);assert.ok(sends[0].endsWith('/'+one.idempotencyKey));
 calls.length=0;for(const context of [{...one,generation:0},{...one,generation:'1'},{...one,idempotencyKey:'effect-1'},{...one,filePart:{...one.filePart,partSha256:'f'.repeat(64)}}])await assert.rejects(()=>provider.sendFile(f.path,'!room:example.test','part.txt',context));
 for(const change of [{displayName:'other.txt'},{partSizeBytes:f.bytes.length+1},{partSha256:'f'.repeat(64)}])await assert.rejects(()=>provider.sendFile(f.path,'!room:example.test','part.txt',fileDeliveryContext('effect-1',1,{...part,...change})),/matrix_attachment_source_mismatch/);
 writeFileSync(f.path,Buffer.alloc(f.bytes.length,0));await assert.rejects(()=>provider.sendFile(f.path,'!room:example.test','part.txt',one),/matrix_attachment_source_mismatch/);assert.equal(calls.length,0);
});
test('Matrix text keeps the original effect transaction and rejects missing or foreign context',async()=>{
 const calls=[],provider=createMatrixProvider(config,async(input,init)=>{calls.push([String(input),init.method]);return Response.json({event_id:'$text:example.test'});});
 for(const context of [undefined,{effectId:'effect-text',generation:0,idempotencyKey:'effect-text'},{effectId:'effect-text',generation:1,idempotencyKey:'other'}])await assert.rejects(()=>provider.send('Text','!room:example.test',context),/matrix_delivery_context_invalid/);
 assert.equal(calls.length,0);await provider.send('Text','!room:example.test',{effectId:'effect-text',generation:1,idempotencyKey:'effect-text'});assert.equal(calls.length,1);assert.ok(calls[0][0].endsWith('/effect-text'));
});
test('legacy three-argument file providers still complete the original authorized worker path',async t=>{
 const f=fixture(t,'legacy-three-arg-context-'),output=registerTaskOutput(f),effect=enqueuePinned(f,output.artifactId);let sends=0;
 const worker=workerFor(f,{sendFile:async(path,recipient,name)=>{assert.equal(recipient,'provider-user');assert.equal(name,output.name);assert.deepEqual(readFileSync(path),output.bytes);sends++;return{provider_message_id:'legacy-receipt'};}});
 await worker.processNext();assert.equal(sends,1);assert.equal(f.delivery.get(effect.effect_id).status,'delivered');
});
test('original pinned worker supplies manifest/part context and preserves legacy providers and receipt-only recovery',async t=>{
 const f=fixture(t,'matrix-worker-context-'),a=join(f.root,'a.txt'),b=join(f.root,'b.txt');writeFileSync(a,'first');writeFileSync(b,'second');
 const group=f.artifacts.registerGenerated('run-a','context-group',[{path:a,display_name:'first.txt'},{path:b,display_name:'second.txt'}]);f.db.prepare('INSERT INTO ga_run_artifacts(run_id,artifact_id,version,created_at) VALUES(?,?,?,?)').run('run-a',group.artifact_ref,1,'now');
 const effect=enqueuePinned(f,group.artifact_ref),sent=[];let receiptCalls=0;
 const worker=workerFor(f,{sendFile:async(path,recipient,name,context)=>{assert.equal(context.effectId,effect.effect_id);assert.equal(context.generation,1);assert.equal(context.filePart.artifactId,group.artifact_ref);assert.equal(context.filePart.partSha256,sha(readFileSync(path)));sent.push(context);return{provider_message_id:'part-'+sent.length};}},{},{registerDeliveryReceipt:async()=>({ok:++receiptCalls>1})});
 await worker.processNext();assert.equal(f.delivery.get(effect.effect_id).status,'receipt_pending');assert.equal(sent.length,2);assert.notEqual(sent[0].idempotencyKey,sent[1].idempotencyKey);assert.deepEqual(sent.map(c=>c.filePart.partIndex),[1,2]);
 await worker.processNext();assert.equal(sent.length,2);assert.equal(f.delivery.get(effect.effect_id).status,'delivered');
});
test('original worker keeps ambiguous file effects unknown and does not resend any part',async t=>{
 const f=fixture(t,'matrix-worker-unknown-'),output=registerTaskOutput(f);const effect=enqueuePinned(f,output.artifactId);let sends=0;
 const worker=workerFor(f,{sendFile:async(_path,_recipient,_name,context)=>{assert.ok(context.filePart);sends++;throw Error('network_ambiguous');}});
 await worker.processNext();assert.equal(f.delivery.get(effect.effect_id).status,'outcome_unknown');assert.equal(await worker.processNext(),false);assert.equal(sends,1);
});
