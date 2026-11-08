import test from 'node:test';import assert from 'node:assert/strict';import{createHash}from'node:crypto';import{mkdirSync,mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync}from'node:fs';import{join,resolve}from'node:path';import{pathToFileURL}from'node:url';
import{buildServer}from'../../src/server.ts';import{OwnerChannelBindings}from'../../src/channels/owner-bindings.ts';import{ChannelIntakeService}from'../../src/channels/intake.ts';import{HarnessCoordinator}from'../../src/harness/coordinator.ts';
import{enableChannelAttachmentProtocolV2,channelAttachmentProtocolV2Installed,downgradeUnusedChannelAttachmentProtocolV2}from'../../src/channels/attachment-protocol-migration-v2.ts';
import{channelAttachmentIntakeConfiguration}from'../../src/channels/attachment-config-v2.ts';
async function fixture(t){
 const parent=resolve('test-tmp');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'channel-protocol-v2-'));
 const config={databasePath:join(root,'db.sqlite'),workspaces:['ws'],uploadRoot:join(root,'files'),templateRoot:resolve('packages/gateway/file-engine/templates')};const service=await buildServer(config),bindings=new OwnerChannelBindings(service.db,{enabled:['wecom']}),challenge=bindings.create('alice','wecom','protocol-v2-binding');bindings.acceptProof('wecom','tenant:alice',challenge.code);
 t.after(async()=>{await service.app.close();service.db.close();rmSync(root,{recursive:true,force:true});});
 const intake=new ChannelIntakeService(service.db,service.runs,'ws',bindings),bytes=Buffer.from('Synthetic retention bytes'),sha256=createHash('sha256').update(bytes).digest('hex');
 const request={protocol:2,event:{channel:'wecom',principal:'tenant:alice',thread_id:'thread',message_id:'files'},text:'File',attachments:[{index:0,provider_file_id:'file',file_name:'one.txt',media_type:'text/plain',size_bytes:bytes.length,sha256}]};
 return{root,config,service,bindings,bindingId:challenge.channel_binding_id,intake,bytes,request,async stage(){const stage=intake.reserveAttachmentBatchV2(request,service.artifacts);await intake.writeAttachmentBatchPartV2('alice',challenge.channel_binding_id,stage.stage_key,0,(async function*(){yield bytes;})(),service.artifacts);return stage;}};
}
test('v2 schema refuses the exact old authority module; unused downgrade is explicit and used provenance cannot be discarded',async t=>{
 const f=await fixture(t),legacy={channel:'wecom',principal:'tenant:alice',thread_id:'thread',message_id:'legacy-text',text:'Original v1 text',attachments:[]},original=f.intake.accept(legacy);assert.equal(channelAttachmentProtocolV2Installed(f.service.db),false);enableChannelAttachmentProtocolV2(f.service.db);
 assert.equal(f.service.db.prepare('SELECT content_protocol FROM ga_channel_message_events WHERE message_id=?').get(original.message_id).content_protocol,1);assert.deepEqual(f.intake.accept(legacy),original);
 // Canonical LF source (blob 32bbd3cf...), independent of a
 // private candidate Git object or a non-shallow CI checkout.
 const old=readFileSync(new URL('./fixtures/authority-migration-v1.ts.fixture',import.meta.url),'utf8').replaceAll('\r\n','\n'),path=join(f.root,'old-authority.ts');
 assert.equal(createHash('sha256').update(old).digest('hex'),'c1831103b17bc3a3da37c251b5db3fd4716183de2a4bf51d9cd61b48446cd93f');
 assert.ok(old.includes("from '../db/database.ts'"));writeFileSync(path,old.replace("from '../db/database.ts'",'from '+JSON.stringify(new URL('../../src/db/database.ts',import.meta.url).href)));
 const module=await import(pathToFileURL(path).href);assert.throws(()=>module.installChannelAuthorityMigration(f.service.db),/channel_authority_schema_mismatch/);
 assert.equal(downgradeUnusedChannelAttachmentProtocolV2(f.service.db).state,'downgraded_unused');assert.doesNotThrow(()=>module.installChannelAuthorityMigration(f.service.db));
 await f.stage();assert.throws(()=>downgradeUnusedChannelAttachmentProtocolV2(f.service.db),/channel_attachment_downgrade_requires_v2_reader/);assert.equal(channelAttachmentProtocolV2Installed(f.service.db),true);
});
test('original lease generation rejects old-reader insert and reclaim; a capable reader alone claims the same v2 run',async t=>{
 const f=await fixture(t),stage=await f.stage(),receipt=await f.intake.acceptAttachmentBatchV2('alice',f.bindingId,stage.stage_key,f.service.artifacts),db=f.service.db,coordinator=new HarnessCoordinator(db,f.service.runs,f.service.events);
 assert.equal(coordinator.claimNext('unsupported-reader',30000),null);
 const oldSql=`INSERT INTO ga_worker_leases(resource_id,owner,generation,expires_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,expires_at=excluded.expires_at,updated_at=excluded.updated_at`;
 assert.doesNotThrow(()=>db.prepare(oldSql).run('synthetic-non-run-control','control-owner',1,String(Date.now()+30000),new Date().toISOString()));
 assert.throws(()=>db.prepare(oldSql).run(receipt.receipt.run_id,'old-reader',1,String(Date.now()+30000),new Date().toISOString()),/channel_attachment_reader_upgrade_required/);
 const first=coordinator.claimNext('capable-reader',30000,2);assert.equal(first.run_id,receipt.receipt.run_id);db.prepare("UPDATE ga_worker_leases SET expires_at='0' WHERE resource_id=?").run(first.run_id);
 assert.throws(()=>db.prepare(oldSql).run(first.run_id,'old-reader',2,String(Date.now()+30000),new Date().toISOString()),/channel_attachment_reader_upgrade_required/);
 const second=coordinator.claimNext('capable-recovery',30000,2);assert.equal(second.generation,2);assert.equal(db.prepare('SELECT channel_protocol_generation FROM ga_worker_leases WHERE resource_id=?').get(first.run_id).channel_protocol_generation,2);
});
test('expired original staging bytes are cleaned with live-writer backoff and immutable tombstones; no admission object is created',async t=>{
 const f=await fixture(t),stage=await f.stage(),db=f.service.db,upload=db.prepare('SELECT server_path FROM ga_uploads WHERE channel_stage_key=?').get(stage.stage_key),path=String(upload.server_path),future=Date.now()+7200000;assert.equal(existsSync(path),true);
 db.prepare("UPDATE ga_uploads SET status='uploading',writer_token='synthetic-live',writer_lease_until=? WHERE channel_stage_key=?").run(new Date(future+120000).toISOString(),stage.stage_key);
 assert.equal(f.service.artifacts.cleanupExpiredChannelUploads(20,future).blocked,1);assert.equal(existsSync(path),true);
 db.prepare("UPDATE ga_uploads SET status='uploaded',writer_token=NULL,writer_lease_until=NULL WHERE channel_stage_key=?").run(stage.stage_key);
 assert.equal(f.service.artifacts.cleanupExpiredChannelUploads(20,future+61000).expired_batches,1);assert.equal(existsSync(path),false);assert.equal(f.service.artifacts.readChannelUploadBatch(stage.stage_key).state,'expired');
 assert.equal(f.service.artifacts.cleanupExpiredChannelUploads(20,future+122000).expired_batches,0);
 assert.throws(()=>f.intake.reserveAttachmentBatchV2(f.request,f.service.artifacts),/channel_attachment_stage_expired/);assert.equal(f.intake.lookupAttachmentBatchRequestV2(f.request,f.service.artifacts).automatic_replay,false);
 for(const table of ['ga_conversations','ga_artifacts','ga_messages','ga_runs','ga_channel_message_events'])assert.equal(Number(db.prepare('SELECT count(*) n FROM '+table).get().n),0);
 assert.equal(Number(db.prepare('SELECT count(*) n FROM ga_uploads').get().n),1);
});
test('configured ingress is disabled by default and requires original recovery/readiness before creating a product database',async t=>{
 assert.equal(channelAttachmentIntakeConfiguration({}).channelAttachmentIntakeV2,false);assert.throws(()=>channelAttachmentIntakeConfiguration({GENERAL_AGENT_CHANNEL_ATTACHMENTS_ENABLED:'yes'}),/configuration_invalid/);assert.throws(()=>channelAttachmentIntakeConfiguration({GENERAL_AGENT_CHANNEL_ATTACHMENTS_ENABLED:'true'}),/original_recovery_required/);
 const f=await fixture(t),missing=join(f.root,'must-not-open.sqlite');
 await assert.rejects(()=>buildServer({...f.config,databasePath:missing,channelAttachmentIntakeV2:true,ordinaryInputRecoveryEnabled:true,internalChannelToken:'synthetic-internal-token-long'}),/native_recovery_unavailable/);assert.equal(existsSync(missing),false);
 assert.equal((await f.service.app.inject({method:'POST',url:'/internal/v2/channel/attachment-batches',payload:f.request})).statusCode,404);
});

test('finalized uploads never invent a receipt, and an old reader remains fenced when the original event link is missing',async t=>{
 const f=await fixture(t),stage=await f.stage(),receipt=await f.intake.acceptAttachmentBatchV2('alice',f.bindingId,stage.stage_key,f.service.artifacts),db=f.service.db;
 // Synthetic corruption probe, never a product repair or accepted-message edit.
 db.prepare('DELETE FROM ga_channel_message_events WHERE run_id=?').run(receipt.receipt.run_id);
 assert.equal(f.service.artifacts.readChannelUploadBatch(stage.stage_key).state,'finalized');
 const unknown=f.intake.lookupAttachmentBatchRequestV2(f.request,f.service.artifacts);assert.equal(unknown.state,'stage_observed');assert.equal(unknown.automatic_replay,false);assert.equal('receipt' in unknown,false);
 await assert.rejects(()=>f.intake.acceptAttachmentBatchV2('alice',f.bindingId,stage.stage_key,f.service.artifacts),/channel_attachment_batch_incomplete/);
 const coordinator=new HarnessCoordinator(db,f.service.runs,f.service.events);assert.equal(coordinator.claimNext('unsupported',30000),null);
 assert.throws(()=>db.prepare('INSERT INTO ga_worker_leases(resource_id,owner,generation,expires_at,updated_at) VALUES(?,?,?,?,?)').run(receipt.receipt.run_id,'old',1,String(Date.now()+30000),new Date().toISOString()),/channel_attachment_reader_upgrade_required/);
 assert.equal(Number(db.prepare('SELECT count(*) n FROM ga_runs').get().n),1);assert.equal(Number(db.prepare('SELECT count(*) n FROM ga_channel_message_events').get().n),0);
});

test('downgrade refuses a retained v2 message when original event and upload receipt rows are unavailable',async t=>{
 const f=await fixture(t),stage=await f.stage(),receipt=await f.intake.acceptAttachmentBatchV2('alice',f.bindingId,stage.stage_key,f.service.artifacts),db=f.service.db;
 // Synthetic lost-link probe only; no automatic product cleanup does this.
 db.prepare('DELETE FROM ga_channel_message_events WHERE run_id=?').run(receipt.receipt.run_id);db.prepare('DELETE FROM ga_uploads WHERE channel_stage_key=?').run(stage.stage_key);
 assert.throws(()=>downgradeUnusedChannelAttachmentProtocolV2(db),/channel_attachment_downgrade_requires_v2_reader/);assert.equal(channelAttachmentProtocolV2Installed(db),true);
 assert.equal(Number(db.prepare('SELECT count(*) n FROM ga_messages WHERE id=?').get(receipt.receipt.message_id).n),1);
});
