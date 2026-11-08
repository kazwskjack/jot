import test from 'node:test';import assert from 'node:assert/strict';import{createHash}from'node:crypto';import{mkdtempSync,readFileSync,rmSync,writeFileSync}from'node:fs';import{tmpdir}from'node:os';import{join,resolve}from'node:path';
import{buildServer}from'../../src/server.ts';import{OwnerChannelBindings}from'../../src/channels/owner-bindings.ts';
import{verifyChannelAttachmentManifestV2,channelAttachmentManifestDigestV2}from'../../src/channels/attachment-manifest-v2.ts';
test('v2 reference producer verifies real original uploaded bytes and binding without admission; malformed batches have no new artifacts or runs',async t=>{
 const root=mkdtempSync(join(tmpdir(),'channel-manifest-v2-')),token='synthetic-original-service-token';
 const service=await buildServer({databasePath:join(root,'db.sqlite'),workspaces:['ws'],uploadRoot:join(root,'files'),templateRoot:resolve('packages/gateway/file-engine/templates'),internalChannelToken:token});
 t.after(async()=>{await service.app.close();service.db.close();rmSync(root,{recursive:true,force:true});});
 const bindings=new OwnerChannelBindings(service.db,{enabled:['wecom']}),binding=bindings.create('alice','wecom','v2-original-binding');
 const send=payload=>service.app.inject({method:'POST',url:'/internal/v1/channel/messages',headers:{authorization:'Bearer '+token},payload});
 assert.equal((await send({channel:'wecom',principal:'tenant:alice',message_id:'bind-proof',text:'/jot-bind '+binding.code,attachments:[]})).statusCode,202);
 const text={channel:'wecom',principal:'tenant:alice',thread_id:'original-thread',message_id:'original-text',text:'Original v1 text',attachments:[]};const original=await send(text);assert.equal(original.statusCode,202,original.body);const conversation=original.json().conversation_id;
 const parts=[];
 for(let index=0;index<2;index++){
  const bytes=Buffer.from('Synthetic attachment '+index),sha=createHash('sha256').update(bytes).digest('hex'),filename='part-'+index+'.txt';
  const upload=service.artifacts.initUpload(conversation,'alice',{size_bytes:bytes.length,sha256:sha,file_name:filename,media_type:'text/plain'});
  await service.artifacts.writeContent(upload.upload_id,'alice',(async function*(){yield bytes;})());
  const artifact=service.artifacts.complete(upload.upload_id,'alice',{sha256:sha});
  parts.push({index,provider_file_id:'provider-file-'+index,artifact_id:artifact.artifact_id,version:1,sha256:sha,size_bytes:bytes.length,file_name:filename,media_type:'text/plain',kind:'text'});
 }
 const source={protocol:2,owner_id:'alice',channel_binding_id:binding.channel_binding_id,binding_version:1,conversation_id:conversation,event:{channel:'wecom',principal:'tenant:alice',thread_id:'original-thread',message_id:'attachment-event'},text:'Files',attachments:parts};
 const counts=()=>['ga_conversations','ga_channel_message_events','ga_runs','ga_messages','ga_artifacts'].map(table=>Number(service.db.prepare('SELECT count(*) n FROM '+table).get().n));const before=counts();
 const result=await verifyChannelAttachmentManifestV2(service.db,join(root,'files'),source);assert.equal(result.state,'verified_references');assert.equal(result.admission_ready,false);assert.equal(result.execution_authorized,false);assert.equal(result.manifest_sha256,channelAttachmentManifestDigestV2(source));assert.equal('accepted'in result,false);assert.equal(JSON.stringify(result).includes(root),false);assert.deepEqual(counts(),before);
 assert.equal((await verifyChannelAttachmentManifestV2(service.db,join(root,'files'),source)).manifest_sha256,result.manifest_sha256);
 for(const patch of [{owner_id:'bob'},{binding_version:2},{conversation_id:'other'},{attachments:[parts[0],{...parts[1],sha256:'f'.repeat(64)}]},{attachments:[parts[1],parts[0]]},{attachments:[{...parts[0],version:2}]},{attachments:[{...parts[0],file_name:'renamed.txt'}]},{attachments:[parts[0],{...parts[1],provider_file_id:parts[0].provider_file_id}]}]){
  await assert.rejects(()=>verifyChannelAttachmentManifestV2(service.db,join(root,'files'),{...source,...patch}));assert.deepEqual(counts(),before);
 }
 assert.equal((await send(text)).json().message_id,original.json().message_id);
 await assert.rejects(()=>verifyChannelAttachmentManifestV2(service.db,join(root,'files'),{...source,event:{...source.event,message_id:text.message_id}}),/channel_attachment_v1_event_conflict/);
 const aborted=new AbortController();aborted.abort();await assert.rejects(()=>verifyChannelAttachmentManifestV2(service.db,join(root,'files'),source,aborted.signal));assert.deepEqual(counts(),before);
 for(const file_name of ['dir/part.txt','dir\\part.txt'])assert.throws(()=>channelAttachmentManifestDigestV2({...source,attachments:[{...parts[0],file_name}]}),/channel_attachment_manifest_invalid/);
 const stored=service.db.prepare('SELECT server_path FROM ga_artifact_versions WHERE artifact_id=? AND version=1').get(parts[1].artifact_id),path=String(stored.server_path),bytes=readFileSync(path),changed=Buffer.from(bytes);changed[0]^=1;
 try{writeFileSync(path,changed);await assert.rejects(()=>verifyChannelAttachmentManifestV2(service.db,join(root,'files'),source),/attachment_content_unverified/);}finally{writeFileSync(path,bytes);}
 assert.deepEqual(counts(),before);assert.equal(Number(service.db.prepare('SELECT count(*) n FROM ga_artifact_leases').get().n),0);
 assert.equal((await verifyChannelAttachmentManifestV2(service.db,join(root,'files'),source)).manifest_sha256,result.manifest_sha256);
});
