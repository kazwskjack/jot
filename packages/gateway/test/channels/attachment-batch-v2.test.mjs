import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildServer} from '../../src/server.ts';
import {OwnerChannelBindings} from '../../src/channels/owner-bindings.ts';
import {ChannelIntakeService} from '../../src/channels/intake.ts';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const stream=bytes=>(async function*(){yield bytes;})();
async function fixture(t){
 const parent=resolve('test-tmp');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'channel-batch-v2-'));
 const config={databasePath:join(root,'db.sqlite'),workspaces:['ws'],uploadRoot:join(root,'files'),templateRoot:resolve('packages/gateway/file-engine/templates')};
 let service=await buildServer(config),bindings=new OwnerChannelBindings(service.db,{enabled:['wecom']}),challenge=bindings.create('alice','wecom','batch-fixture-binding');bindings.acceptProof('wecom','tenant:alice',challenge.code);
 let intake=new ChannelIntakeService(service.db,service.runs,'ws',bindings),closed=false;
 const bytes=[Buffer.from('Synthetic first part'),Buffer.from('Synthetic second part')];
 const request={protocol:2,event:{channel:'wecom',principal:'tenant:alice',thread_id:'new-thread',message_id:'first-files'},text:'Two files',attachments:bytes.map((value,index)=>({index,provider_file_id:'provider-file-'+index,file_name:'part-'+index+'.txt',media_type:'text/plain',size_bytes:value.length,sha256:digest(value)}))};
 t.after(async()=>{if(!closed){await service.app.close();service.db.close();}rmSync(root,{recursive:true,force:true});});
 return{root,get service(){return service;},get intake(){return intake;},bindingId:challenge.channel_binding_id,bytes,request,
  counts:()=>['ga_conversations','ga_artifacts','ga_messages','ga_runs','ga_channel_message_events'].map(table=>Number(service.db.prepare('SELECT count(*) n FROM '+table).get().n)),
  async close(){if(!closed){await service.app.close();service.db.close();closed=true;}},
  async reopen(){if(!closed){await service.app.close();service.db.close();}service=await buildServer(config);closed=false;bindings=new OwnerChannelBindings(service.db,{enabled:['wecom']});intake=new ChannelIntakeService(service.db,service.runs,'ws',bindings);}
 };
}

test('original upload rows reserve a durable first-message batch; partial content creates no conversation/artifact/admission',async t=>{
 const f=await fixture(t),stage=f.intake.reserveAttachmentBatchV2(f.request,f.service.artifacts);assert.deepEqual(f.counts(),[0,0,0,0,0]);
 assert.equal(stage.parts.length,2);assert.equal(stage.state,'staging');
 assert.equal(f.intake.lookupAttachmentBatchV2('alice',f.bindingId,stage.stage_key,f.service.artifacts).state,'stage_observed');
 assert.equal(f.intake.lookupAttachmentBatchV2('alice',f.bindingId,'channel-stage-'+'f'.repeat(64),f.service.artifacts).automatic_replay,false);assert.deepEqual(f.counts(),[0,0,0,0,0]);
 assert.throws(()=>f.service.db.prepare("UPDATE ga_uploads SET filename='changed.txt' WHERE channel_stage_key=?").run(stage.stage_key),/channel_upload_source_immutable/);
 await f.intake.writeAttachmentBatchPartV2('alice',f.bindingId,stage.stage_key,0,stream(f.bytes[0]),f.service.artifacts);
 await assert.rejects(()=>f.intake.writeAttachmentBatchPartV2('alice',f.bindingId,stage.stage_key,1,stream(Buffer.alloc(f.bytes[1].length,120)),f.service.artifacts),/upload_sha256_mismatch/);
 assert.deepEqual(f.counts(),[0,0,0,0,0]);
 await assert.rejects(()=>f.intake.acceptAttachmentBatchV2('alice',f.bindingId,stage.stage_key,f.service.artifacts),/channel_attachment_batch_incomplete/);assert.deepEqual(f.counts(),[0,0,0,0,0]);
 await f.reopen();const recovered=f.intake.reserveAttachmentBatchV2(structuredClone(f.request),f.service.artifacts);
 assert.equal(recovered.stage_key,stage.stage_key);assert.equal(recovered.manifest_sha256,stage.manifest_sha256);assert.deepEqual(recovered.parts.map(p=>p.upload_id),stage.parts.map(p=>p.upload_id));
 assert.throws(()=>f.intake.reserveAttachmentBatchV2({...f.request,text:'Changed'},f.service.artifacts),error=>error.statusCode===409);
 assert.deepEqual(f.counts(),[0,0,0,0,0]);
 await f.intake.writeAttachmentBatchPartV2('alice',f.bindingId,stage.stage_key,1,stream(f.bytes[1]),f.service.artifacts);
 const receipt=await f.intake.acceptAttachmentBatchV2('alice',f.bindingId,stage.stage_key,f.service.artifacts);assert.equal(receipt.state,'admitted');assert.deepEqual(f.counts(),[1,2,1,1,1]);
 assert.deepEqual(await f.intake.acceptAttachmentBatchV2('alice',f.bindingId,stage.stage_key,f.service.artifacts),receipt);assert.deepEqual(f.counts(),[1,2,1,1,1]);
 assert.deepEqual(f.intake.lookupAttachmentReceiptV2('alice',f.bindingId,stage.source),receipt);
 assert.deepEqual(f.intake.lookupAttachmentBatchV2('alice',f.bindingId,stage.stage_key,f.service.artifacts),receipt);
});

test('a separate process crash after the first original rename rolls back admission and resumes the same durable upload batch',async t=>{
 const f=await fixture(t),stage=f.intake.reserveAttachmentBatchV2(f.request,f.service.artifacts);
 for(let i=0;i<2;i++)await f.intake.writeAttachmentBatchPartV2('alice',f.bindingId,stage.stage_key,i,stream(f.bytes[i]),f.service.artifacts);
 await f.close();
 const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/attachment-batch-crash-child.mjs',import.meta.url)),f.root,f.bindingId,stage.stage_key],{cwd:process.cwd(),stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
 const timer=setTimeout(()=>child.kill(),30000);let code;try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});}finally{clearTimeout(timer);}
 assert.equal(code,73,output);await f.reopen();assert.deepEqual(f.counts(),[0,0,0,0,0]);
 assert.equal(f.intake.reserveAttachmentBatchV2(f.request,f.service.artifacts).manifest_sha256,stage.manifest_sha256);
 const receipt=await f.intake.acceptAttachmentBatchV2('alice',f.bindingId,stage.stage_key,f.service.artifacts);assert.equal(receipt.state,'admitted');assert.deepEqual(f.counts(),[1,2,1,1,1]);
});

test('durable v2 reservation cannot collide with or rewrite an accepted original v1 event',async t=>{
 const f=await fixture(t),v1={channel:f.request.event.channel,principal:f.request.event.principal,thread_id:f.request.event.thread_id,message_id:f.request.event.message_id,text:'Original text only',attachments:[]};
 const original=f.intake.accept(v1),before=f.counts();assert.throws(()=>f.intake.reserveAttachmentBatchV2(f.request,f.service.artifacts),error=>error.statusCode===409);
 assert.deepEqual(f.counts(),before);assert.equal(Number(f.service.db.prepare('SELECT count(*) n FROM ga_uploads').get().n),0);assert.deepEqual(f.intake.accept(v1),original);
});

test('original batch finalization rolls back first conversation and every artifact after a later completion failure, then resumes stable original files',async t=>{
 const f=await fixture(t),stage=f.intake.reserveAttachmentBatchV2(f.request,f.service.artifacts);
 for(let i=0;i<2;i++)await f.intake.writeAttachmentBatchPartV2('alice',f.bindingId,stage.stage_key,i,stream(f.bytes[i]),f.service.artifacts);
 const complete=f.service.artifacts.complete.bind(f.service.artifacts);let calls=0;
 f.service.artifacts.complete=(...args)=>{if(++calls===2)throw Error('synthetic_second_completion_failure');return complete(...args);};
 try{await assert.rejects(()=>f.intake.acceptAttachmentBatchV2('alice',f.bindingId,stage.stage_key,f.service.artifacts),/synthetic_second_completion_failure/);}finally{f.service.artifacts.complete=complete;}
 assert.deepEqual(f.counts(),[0,0,0,0,0]);assert.equal(Number(f.service.db.prepare('SELECT count(*) n FROM ga_uploads WHERE conversation_id IS NOT NULL').get().n),0);
 await f.reopen();const results=await Promise.all([f.intake.acceptAttachmentBatchV2('alice',f.bindingId,stage.stage_key,f.service.artifacts),f.intake.acceptAttachmentBatchV2('alice',f.bindingId,stage.stage_key,f.service.artifacts)]);
 assert.deepEqual(results[0],results[1]);assert.deepEqual(f.counts(),[1,2,1,1,1]);
});
