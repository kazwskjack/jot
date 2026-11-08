import {createHash} from 'node:crypto';
import {canonicalJson} from '../db/canonical-json.ts';
import {normalizeChannelAttachmentManifestV2,type ChannelAttachmentSourceV2} from './attachment-manifest-v2.ts';
const sha=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export const channelUploadStageKeyV2=(event:ChannelAttachmentSourceV2['event'])=>'channel-stage-'+sha({protocol:2,event});
export const channelUploadIdV2=(key:string,requestHash:string,index:number)=>'upload-channel-'+sha({key,requestHash,index}).slice(0,32);
export const channelUploadArtifactIdV2=(uploadId:string)=>'artifact-'+createHash('sha256').update(`upload:${uploadId}`).digest('hex').slice(0,32);
export function channelStageRequestV2(source:ChannelAttachmentSourceV2){
 return {protocol:2,owner_id:source.owner_id,channel_binding_id:source.channel_binding_id,binding_version:source.binding_version,event:source.event,text:source.text,
  attachments:source.attachments.map(({index,provider_file_id,file_name,media_type,size_bytes,sha256})=>({index,provider_file_id,file_name,media_type,size_bytes,sha256}))};
}
export const channelStageRequestDigestV2=(source:ChannelAttachmentSourceV2)=>sha(channelStageRequestV2(source));
/** Validate provider declarations through the same strict final source parser. */
export function normalizeChannelStageRequestV2(input:unknown,scope:{owner_id:string;channel_binding_id:string;binding_version:number;conversation_id:string}){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='attachments,event,protocol,text')throw Error('channel_attachment_stage_invalid');
 const raw=input as Record<string,unknown>;
 if(raw.protocol!==2||!Array.isArray(raw.attachments))throw Error('channel_attachment_stage_invalid');
 const pins=raw.attachments.map((part,index)=>{
  if(!part||typeof part!=='object'||Array.isArray(part)||Object.keys(part).sort().join(',')!=='file_name,index,media_type,provider_file_id,sha256,size_bytes')throw Error('channel_attachment_stage_invalid');
  const p=part as Record<string,unknown>,mime=p.media_type;
  if(typeof mime!=='string'||!Number.isSafeInteger(p.size_bytes)||Number(p.size_bytes)<1)throw Error('channel_attachment_stage_invalid');
  const kind=mime.startsWith('image/')&&mime!=='image/svg+xml'?'image':mime.startsWith('text/')||['application/json','application/xml'].includes(mime)?'text':mime==='application/pdf'||/officedocument|msword|excel|powerpoint/.test(mime)?'document':'file';
  return {...p,artifact_id:'provisional-'+index,version:1,kind};
 });
 const provisional=normalizeChannelAttachmentManifestV2({...scope,protocol:2,event:raw.event,text:raw.text,attachments:pins}).source;
 const requestHash=channelStageRequestDigestV2(provisional),key=channelUploadStageKeyV2(provisional.event);
 return normalizeChannelAttachmentManifestV2({...provisional,attachments:provisional.attachments.map((part,index)=>({...part,artifact_id:channelUploadArtifactIdV2(channelUploadIdV2(key,requestHash,index))}))}).source;
}
