import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {attachmentKindForMime,validateAttachmentManifest} from '../artifacts/pinned-manifest.ts';
import {decodeStoredContent} from './content.ts';
import {readLiteralMessageReferences} from './content-reference.js';
import {messageReferenceProjection} from './reference-snapshots.ts';

type ImageProof={artifact_id:string;version:number;sha256:string;size_bytes:number};

/** Resolve original reference versions for byte snapshotting, without granting
 * channel authority or changing the original serialized message. */
export function readMessageReferenceAttachmentInput(db:DatabaseSync,runId:string){
 return withImmediateTransaction(db,()=>{
  const row=db.prepare(`SELECT m.*,c.owner_id,r.conversation_id AS run_conversation_id FROM ga_runs r
   JOIN ga_messages m ON m.id=r.input_message_id
   JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=?`).get(runId);
  if(!row||typeof row.id!=='string'||typeof row.content_json!=='string'
   ||typeof row.owner_id!=='string'||typeof row.conversation_id!=='string'){
   throw Error('reference_attachment_input_unproven');
  }
  const content=decodeStoredContent(row.content_json);
  const native=messageReferenceProjection(db,row,row.owner_id).reference_snapshots;
  if(native?.state==='unavailable')throw Error('reference_attachment_input_unproven');
  const references=native?native.items:readLiteralMessageReferences(content.blocks);
  const images=new Map<string,ImageProof>();
  for(const reference of references){
   const image=reference.image_artifact as ImageProof|undefined;
   if(!image)continue;
   const previous=images.get(image.artifact_id);
   if(previous&&canonicalJson(previous)!==canonicalJson(image))throw Error('reference_attachment_input_unproven');
   images.set(image.artifact_id,image);
  }
  if(!images.size)return undefined;
  if(row.run_id!==runId||row.conversation_id!==row.run_conversation_id||row.role!=='user'||row.status!=='complete'){
   throw Error('reference_attachment_input_unproven');
  }
  for(const artifactId of images.keys()){
   if(!content.attachments.includes(artifactId))throw Error('reference_attachment_input_unproven');
  }
  const attachments=content.attachments.map(artifactId=>{
   const image=images.get(artifactId);
   const artifact=db.prepare(`SELECT v.version,v.sha256,v.size_bytes,v.mime_type,v.metadata_json
    FROM ga_artifacts a JOIN ga_artifact_versions v ON v.artifact_id=a.id AND v.version=COALESCE(?,a.current_version)
    WHERE a.id=? AND a.owner_id=? AND a.conversation_id=?`).get(image?.version??null,artifactId,row.owner_id!,row.conversation_id!);
   if(!artifact)throw Error('reference_attachment_input_unproven');
   let metadata:Record<string,unknown>|null;
   try{metadata=JSON.parse(String(artifact.metadata_json));}catch{throw Error('reference_attachment_input_unproven');}
   if(metadata?.status!=='ready'||image&&(metadata.origin!=='upload'||artifact.mime_type!=='image/png'
    ||artifact.sha256!==image.sha256||artifact.size_bytes!==image.size_bytes)){
    throw Error('reference_attachment_input_unproven');
   }
   const mediaType=String(artifact.mime_type);
   return {artifact_id:artifactId,version:artifact.version,sha256:artifact.sha256,size_bytes:artifact.size_bytes,
    media_type:mediaType,file_name:String(metadata.file_name||artifactId),kind:attachmentKindForMime(mediaType)};
  });
  const manifest=validateAttachmentManifest({protocol:1,attachments},{maxCount:10,maxAggregateBytes:200*1024*1024});
  const sourceSha256=createHash('sha256').update(canonicalJson({run_id:runId,message_id:row.id,
   conversation_id:row.conversation_id,owner_id:row.owner_id,content_sha256:createHash('sha256').update(row.content_json).digest('hex'),
   references,manifest})).digest('hex');
  return {manifest,sourceSha256};
 });
}
