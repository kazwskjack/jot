import test from 'node:test';import assert from 'node:assert/strict';
import{createHash}from'node:crypto';import{mkdtempSync,mkdirSync,rmSync,writeFileSync}from'node:fs';import{join,resolve}from'node:path';
import{buildServer}from'../../src/server.ts';import{OwnerChannelBindings}from'../../src/channels/owner-bindings.ts';import{ChannelIntakeService}from'../../src/channels/intake.ts';
import{HarnessWorker}from'../../src/harness/worker.ts';import{HarnessCoordinator}from'../../src/harness/coordinator.ts';import{AttachmentResolver}from'../../src/artifacts/resolver.ts';
test('initial channel v2 consumer supplies original version bytes, refuses missing capability, and never reopens a mutable artifact path',async t=>{
 const parent=resolve('test-tmp');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'channel-initial-v2-'));
 const service=await buildServer({databasePath:join(root,'db.sqlite'),workspaces:['ws'],uploadRoot:join(root,'files'),templateRoot:resolve('packages/gateway/file-engine/templates')});
 t.after(async()=>{await service.app.close();service.db.close();rmSync(root,{recursive:true,force:true});});
 const bindings=new OwnerChannelBindings(service.db,{enabled:['wecom']}),challenge=bindings.create('alice','wecom','initial-v2-binding');bindings.acceptProof('wecom','tenant:alice',challenge.code);
 const intake=new ChannelIntakeService(service.db,service.runs,'ws',bindings),bytes=Buffer.from('Exact original version one'),sha256=createHash('sha256').update(bytes).digest('hex');
 const request={protocol:2,event:{channel:'wecom',principal:'tenant:alice',thread_id:'thread',message_id:'files'},text:'Read this file',attachments:[{index:0,provider_file_id:'file',file_name:'one.txt',media_type:'text/plain',size_bytes:bytes.length,sha256}]};
 const stage=intake.reserveAttachmentBatchV2(request,service.artifacts);await intake.writeAttachmentBatchPartV2('alice',challenge.channel_binding_id,stage.stage_key,0,(async function*(){yield bytes;})(),service.artifacts);const receipt=await intake.acceptAttachmentBatchV2('alice',challenge.channel_binding_id,stage.stage_key,service.artifacts);
 const pin=stage.source.attachments[0],stored=service.db.prepare('SELECT server_path FROM ga_artifact_versions WHERE artifact_id=? AND version=1').get(pin.artifact_id);
 assert.equal(service.runs.message(receipt.receipt.message_id).attachment_refs[0].version,1);
 assert.equal(JSON.parse(String(service.db.prepare("SELECT payload_json FROM ga_events WHERE run_id=? AND type='message.created'").get(receipt.receipt.run_id).payload_json)).attachment_refs[0].version,1);
 const newer=join(root,'files','newer.txt');writeFileSync(newer,'Newer version must not be sent');const now=new Date().toISOString();
 service.db.prepare('INSERT INTO ga_artifact_versions VALUES(?,?,?,?,?,?,?,?)').run(pin.artifact_id,2,newer,'f'.repeat(64),30,'text/plain',JSON.stringify({file_name:'newer.txt',status:'ready'}),now);service.db.prepare('UPDATE ga_artifacts SET current_version=2 WHERE id=?').run(pin.artifact_id);
 let calls=0;const runner={pinnedInputProtocol:1,recoverInput:async()=>assert.fail('first delivery is not a recovery'),async run(input){
  calls++;assert.ok(input.originalAdmission);assert.equal(input.attachments.length,0);assert.equal(input.pinnedAttachments.manifest.attachments[0].version,1);
  writeFileSync(String(stored.server_path),'Changed after snapshot');const chunks=[];for await(const chunk of input.pinnedAttachments.sources[0].stream())chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),bytes);
  return{observed:true,completed:false,reason_code:'DSH_CHAT_ANSWER',runtime_status:'not_required',final_text:'Synthetic local answer'};
 }};
 const worker=new HarnessWorker(service.db,new HarnessCoordinator(service.db,service.runs,service.events),runner,{workerId:'v2-worker',leaseMs:30000,ordinaryInputRecoveryEnabled:true,attachmentResolver:new AttachmentResolver(service.db,join(root,'files'))});
 await worker.processNext();assert.equal(calls,1);assert.equal(service.runs.get(receipt.receipt.run_id,'alice').status,'succeeded');assert.equal(Number(service.db.prepare('SELECT count(*) n FROM ga_artifact_leases').get().n),0);
 const second=intake.reserveAttachmentBatchV2({...request,event:{...request.event,message_id:'missing-consumer'}},service.artifacts);
 await intake.writeAttachmentBatchPartV2('alice',challenge.channel_binding_id,second.stage_key,0,(async function*(){yield bytes;})(),service.artifacts);
 const secondReceipt=await intake.acceptAttachmentBatchV2('alice',challenge.channel_binding_id,second.stage_key,service.artifacts);
 const disabled=new HarnessWorker(service.db,new HarnessCoordinator(service.db,service.runs,service.events),{run:async()=>assert.fail('unsupported consumer must never dispatch')},{workerId:'disabled-v2',leaseMs:30000,attachmentResolver:new AttachmentResolver(service.db,join(root,'files'))});
 assert.equal(await disabled.processNext(),null);assert.equal(service.runs.get(secondReceipt.receipt.run_id,'alice').status,'queued');
 const cancelled=new HarnessWorker(service.db,new HarnessCoordinator(service.db,service.runs,service.events),{pinnedInputProtocol:1,recoverInput:async()=>assert.fail('not a retry'),run:async input=>{
  service.db.prepare("UPDATE ga_runs SET status='cancelling' WHERE id=?").run(secondReceipt.receipt.run_id);
  assert.throws(()=>input.beforeInputDispatch(),/channel_attachment_input_cancelled/);throw Error('synthetic_cancel_before_dispatch');
 }},{workerId:'cancelled-v2',leaseMs:30000,ordinaryInputRecoveryEnabled:true,attachmentResolver:new AttachmentResolver(service.db,join(root,'files'))});
 assert.equal((await cancelled.processNext()).runtime_status,'cancel_requested');assert.equal(service.runs.get(secondReceipt.receipt.run_id,'alice').status,'cancelling');assert.equal(Number(service.db.prepare('SELECT count(*) n FROM ga_artifact_leases').get().n),0);
});
