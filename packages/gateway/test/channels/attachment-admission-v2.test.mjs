// Isolated original-module fixture; see exact execution evidence in the receipt.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {buildServer} from '../../src/server.ts';
import {OwnerChannelBindings} from '../../src/channels/owner-bindings.ts';
import {ChannelIntakeService} from '../../src/channels/intake.ts';

test('private original v2 admission uses one event receipt, immutable manifest and no automatic unknown replay',async t=>{
 const base=resolve('test-tmp');mkdirSync(base,{recursive:true});
 const root=mkdtempSync(join(base,'channel-v2-admission-'));
 const service=await buildServer({databasePath:join(root,'db.sqlite'),workspaces:['ws'],uploadRoot:join(root,'files'),templateRoot:resolve('packages/gateway/file-engine/templates')});
 t.after(async()=>{await service.app.close();service.db.close();rmSync(root,{recursive:true,force:true});});
 const bindings=new OwnerChannelBindings(service.db,{enabled:['wecom']});
 const binding=bindings.create('alice','wecom','private-v2-admission');
 bindings.acceptProof('wecom','tenant:alice',binding.code);
 const intake=new ChannelIntakeService(service.db,service.runs,'ws',bindings);
 const v1={channel:'wecom',principal:'tenant:alice',thread_id:'thread-1',message_id:'text-1',text:'Original text',attachments:[]};
 const original=intake.accept(v1),bytes=Buffer.from('Synthetic exact uploaded bytes');
 const sha256=createHash('sha256').update(bytes).digest('hex');
 const upload=service.artifacts.initUpload(original.conversation_id,'alice',{file_name:'one.txt',media_type:'text/plain',size_bytes:bytes.length,sha256});
 await service.artifacts.writeContent(upload.upload_id,'alice',(async function*(){yield bytes;})());
 const artifact=service.artifacts.complete(upload.upload_id,'alice',{sha256});
 const source={protocol:2,owner_id:'alice',channel_binding_id:binding.channel_binding_id,binding_version:1,conversation_id:original.conversation_id,event:{channel:'wecom',principal:'tenant:alice',thread_id:'thread-1',message_id:'file-1'},text:'File',attachments:[{index:0,provider_file_id:'provider-file-1',artifact_id:artifact.artifact_id,version:1,sha256,size_bytes:bytes.length,file_name:'one.txt',media_type:'text/plain',kind:'text'}]};
 const counts=()=>['ga_conversations','ga_artifacts','ga_messages','ga_runs','ga_channel_message_events'].map(table=>Number(service.db.prepare('SELECT count(*) n FROM '+table).get().n));
 const before=counts();
 assert.deepEqual(intake.lookupAttachmentReceiptV2('alice',binding.channel_binding_id,source),{protocol:2,state:'not_observed',original_admission:'unproven',automatic_replay:false});
 assert.deepEqual(counts(),before);
 const receipt=await intake.acceptAttachmentsV2(source,service.artifacts);
 assert.equal(receipt.state,'admitted');assert.equal(receipt.receipt.accepted,true);
 const admitted=counts();assert.deepEqual(admitted,[before[0],before[1],before[2]+1,before[3]+1,before[4]+1]);
 const content=JSON.parse(String(service.db.prepare('SELECT content_json FROM ga_messages WHERE id=?').get(receipt.receipt.message_id).content_json));
 assert.equal(content.protocol,2);assert.equal('attachments' in content,false);assert.equal(content.attachment_manifest.attachments[0].version,1);
 assert.deepEqual(await intake.acceptAttachmentsV2(structuredClone(source),service.artifacts),receipt);
 assert.deepEqual(intake.lookupAttachmentReceiptV2('alice',binding.channel_binding_id,source),receipt);assert.deepEqual(counts(),admitted);
 for(const changed of [{...source,text:'Changed'},{...source,attachments:[{...source.attachments[0],provider_file_id:'other-file'}]}]){
  await assert.rejects(()=>intake.acceptAttachmentsV2(changed,service.artifacts),error=>error.message==='channel_attachment_event_conflict'&&error.statusCode===409);
  assert.equal(intake.lookupAttachmentReceiptV2('alice',binding.channel_binding_id,changed).automatic_replay,false);assert.deepEqual(counts(),admitted);
 }
 await assert.rejects(()=>intake.acceptAttachmentsV2({...source,event:{...source.event,message_id:'text-1'}},service.artifacts),/channel_attachment_event_conflict/);
 assert.equal(intake.accept(v1).message_id,original.message_id);
 const path=String(service.db.prepare('SELECT server_path FROM ga_artifact_versions WHERE artifact_id=? AND version=1').get(artifact.artifact_id).server_path),saved=readFileSync(path),broken=Buffer.from(saved);broken[0]^=1;
 try{
  writeFileSync(path,broken);
  // An admitted retry is receipt-only even when source bytes subsequently disappear/change.
  assert.deepEqual(await intake.acceptAttachmentsV2(source,service.artifacts),receipt);
  await assert.rejects(()=>intake.acceptAttachmentsV2({...source,event:{...source.event,message_id:'bad-bytes'}},service.artifacts),/attachment_content_unverified/);
 }finally{writeFileSync(path,saved);}
 assert.deepEqual(counts(),admitted);assert.equal(Number(service.db.prepare('SELECT count(*) n FROM ga_artifact_leases').get().n),0);
 const raced={...source,event:{...source.event,message_id:'raced-event'}};
 const racers=await Promise.all([intake.acceptAttachmentsV2(raced,service.artifacts),intake.acceptAttachmentsV2(structuredClone(raced),service.artifacts)]);
 assert.deepEqual(racers[0],racers[1]);
 const racedCounts=counts();assert.deepEqual(racedCounts,[admitted[0],admitted[1],admitted[2]+1,admitted[3]+1,admitted[4]+1]);
 const lost={...source,event:{...source.event,message_id:'lost-after-commit'}};
 const snapshot=service.artifacts.snapshotPinnedInput.bind(service.artifacts);
 service.artifacts.snapshotPinnedInput=async(...args)=>{const value=await snapshot(...args);return{...value,async dispose(){await value.dispose();throw Error('synthetic_lost_after_commit');}};};
 try{await assert.rejects(()=>intake.acceptAttachmentsV2(lost,service.artifacts),/synthetic_lost_after_commit/);}finally{service.artifacts.snapshotPinnedInput=snapshot;}
 const recovered=intake.lookupAttachmentReceiptV2('alice',binding.channel_binding_id,lost);assert.equal(recovered.state,'admitted');
 const lostCounts=counts();assert.deepEqual(lostCounts,[racedCounts[0],racedCounts[1],racedCounts[2]+1,racedCounts[3]+1,racedCounts[4]+1]);
 assert.deepEqual(await intake.acceptAttachmentsV2(lost,service.artifacts),recovered);assert.deepEqual(counts(),lostCounts);
 service.db.prepare('UPDATE ga_owner_channel_bindings SET version=version+1 WHERE channel_binding_id=?').run(binding.channel_binding_id);
 await assert.rejects(()=>intake.acceptAttachmentsV2(source,service.artifacts));assert.equal(intake.lookupAttachmentReceiptV2('alice',binding.channel_binding_id,source).automatic_replay,false);assert.deepEqual(counts(),lostCounts);
});
