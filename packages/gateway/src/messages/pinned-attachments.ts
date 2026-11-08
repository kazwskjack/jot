import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {attachmentKindForMime,validateAttachmentManifest,type AttachmentManifest} from '../artifacts/pinned-manifest.ts';
import {readAcceptedChannelAttachmentInputV2} from '../channels/attachment-input-v2.ts';

export type MessageAttachmentRef={artifact_id:string;version:number;sha256:string;size_bytes:number;media_type:string;file_name:string};

/** Public metadata only; never exposes staging paths, receipts or execution authority. */
export function pinnedAttachmentRefs(manifest:AttachmentManifest):MessageAttachmentRef[]{
 return manifest.attachments.map(({artifact_id,version,sha256,size_bytes,media_type,file_name})=>({artifact_id,version,sha256,size_bytes,media_type,file_name}));
}

/** Project the original accepted supplement, without changing its serialized
 * message or consulting current_version. An empty list explicitly forbids the
 * UI from substituting current bytes when original provenance is unavailable. */
export function messageAttachmentProjection(db:DatabaseSync,row:Record<string,unknown>):{attachment_refs?:MessageAttachmentRef[]}{
 const forkLineageInstalled=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ga_conversation_fork_messages'").get());
 if(forkLineageInstalled&&typeof row.id==='string'&&typeof row.conversation_id==='string'&&typeof row.content_json==='string'){
  const lineage=db.prepare(`SELECT fm.attachment_refs_json,fm.source_content_sha256
   FROM ga_conversation_fork_messages fm JOIN ga_conversation_forks f ON f.fork_id=fm.fork_id
   JOIN ga_conversations c ON c.id=f.target_conversation_id AND c.owner_id=f.owner_id
   WHERE fm.target_message_id=? AND c.id=?`).get(row.id,row.conversation_id) as Record<string,unknown>|undefined;
  if(lineage){
   if(lineage.source_content_sha256!==createHash('sha256').update(row.content_json).digest('hex'))return{attachment_refs:[]};
   try{
    const refs=JSON.parse(String(lineage.attachment_refs_json));
    if(!Array.isArray(refs))return{attachment_refs:[]};
    const manifest=validateAttachmentManifest({protocol:1,attachments:refs.map(pin=>({...pin,kind:attachmentKindForMime(String(pin.media_type??''))}))},{maxCount:10,maxAggregateBytes:200*1024*1024});
    return{attachment_refs:pinnedAttachmentRefs(manifest)};
   }catch{return{attachment_refs:[]};}
  }
 }
 if(row.role==='user'&&typeof row.id==='string'&&row.id.startsWith('msg-')){
  try{const accepted=readAcceptedChannelAttachmentInputV2(db,String(row.run_id));return accepted?{attachment_refs:pinnedAttachmentRefs(accepted.pinned)}:{};}catch{return{attachment_refs:[]};}
 }
 if(row.role!=='user'||typeof row.id!=='string'||!row.id.startsWith('message-'))return{};
 const unavailable={attachment_refs:[]};
 const command=db.prepare(`SELECT cmd.kind,cmd.status,cmd.payload_json FROM ga_run_commands cmd
  JOIN ga_runs r ON r.id=cmd.run_id JOIN ga_conversations c ON c.id=r.conversation_id
  WHERE cmd.id=? AND cmd.run_id=? AND c.id=?`).get(row.id.slice(8),String(row.run_id),String(row.conversation_id));
 if(!command||command.kind!=='steer'||command.status!=='applied'||row.status!=='complete')return unavailable;
 try{
  const payload=JSON.parse(String(command.payload_json));
  if(!payload||Array.isArray(payload)||payload.content_protocol!==1)return unavailable;
  if(Object.keys(payload).sort().join(',')!=='attachment_manifest,client_message_id,content_protocol,expected_run_version,text'
   ||payload.client_message_id!==row.client_message_id||typeof payload.text!=='string'||payload.text.length>100000
   ||!Number.isSafeInteger(payload.expected_run_version)||payload.expected_run_version<1)return unavailable;
  const manifest=validateAttachmentManifest(payload.attachment_manifest,{maxCount:10,maxAggregateBytes:200*1024*1024});
  const original=JSON.stringify({blocks:payload.text.trim()?[{block_id:row.id+':text',kind:'text',text:payload.text}]:[],attachments:manifest.attachments.map(pin=>pin.artifact_id)});
  if(row.content_json!==original)return unavailable;
  return{attachment_refs:pinnedAttachmentRefs(manifest)};
 }catch{return unavailable;}
}
