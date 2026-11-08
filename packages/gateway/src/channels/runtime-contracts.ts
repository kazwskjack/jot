import type {FastifyInstance} from 'fastify';
import type {ChannelId} from '../../contracts/types.ts';
import type {readVerifiedChannelBinding} from './authority-proofs.ts';
export type {ChannelId} from '../../contracts/types.ts';

/** Protocol names only. Membership grants no inbound, binding or send authority. */
export const CHANNEL_IDS=Object.freeze([
 'api-server','bluebubbles','cli','dingtalk','discord','email','feishu',
 'homeassistant','matrix','mattermost','qq','signal','slack','sms','telegram',
 'tui','webhook','wecom','wecom-callback','weixin','whatsapp',
] as const satisfies readonly ChannelId[]);
const CHANNEL_SET:ReadonlySet<string>=new Set(CHANNEL_IDS);
const OPAQUE=/^[^\u0000-\u001f\u007f]{1,512}$/u;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
type Row=Record<string,unknown>;
const record=(value:unknown):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:Row,keys:string[])=>Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const opaque=(value:unknown):value is string=>typeof value==='string'&&OPAQUE.test(value)&&value===value.trim();
const fail=(code:string):never=>{throw Error(code);};

export type ProviderAttachmentDescriptor=Readonly<{
 provider_file_id:string;file_name:string;media_type:string;size_bytes?:number;
}>;
export type NormalizedChannelMessage=Readonly<{
 channel:ChannelId;principal:string;thread_id?:string;message_id:string;text:string;
 attachments:readonly ProviderAttachmentDescriptor[];
}>;
/** Bytes downloaded only after the Matrix event was authenticated by its configured client. */
export type ChannelAttachmentForwardInputV2=Readonly<{
 channel:'matrix'|'mattermost';principal:string;thread_id:string;message_id:string;text:string;authenticated:true;
 attachments:readonly Readonly<{provider_file_id:string;file_name:string;media_type:string;size_bytes?:number;bytes:Uint8Array}>[];
}>;
export type ChannelAttachmentRequestDeclarationV2=Readonly<{
 protocol:2;event:Readonly<{channel:'matrix'|'mattermost';principal:string;thread_id:string;message_id:string}>;text:string;
 attachments:readonly Readonly<{index:number;provider_file_id:string;file_name:string;media_type:string;size_bytes:number;sha256:string}>[];
}>;
export type ChannelRuntimeResponse=Readonly<{statusCode:number;body:Readonly<Record<string,unknown>>}>;
export type ChannelAttachmentForwardPort=(input:ChannelAttachmentForwardInputV2,signal?:AbortSignal)=>Promise<ChannelRuntimeResponse>;
export type ChannelIntakeReceipt=
 |Readonly<{accepted:true;message_id:string;run_id:string;conversation_id:string}>
 |Readonly<{accepted:true;kind:'channel_binding';status:'verified'}>;
export type ChannelMatrixTerminalRefusal=Readonly<{provider_message_id:string;source_sha256:string;status_code:number;error_code:string}>;
const MATRIX_TERMINAL_REFUSALS:Readonly<Record<string,readonly number[]>>=Object.freeze({
 'CHANNEL_BINDING_NOT_VERIFIED':[409],
 'CHANNEL_BINDING_PRIVATE_ROOM_REQUIRED':[403],
 'CHANNEL_BINDING_PROOF_INVALID':[422],
 'CHANNEL_PRINCIPAL_ALREADY_BOUND':[409],
 'CHANNEL_MESSAGE_INVALID':[422],
 'CHANNEL_ATTACHMENTS_INVALID':[422],
 'CHANNEL_ATTACHMENT_STAGING_MISSING':[422],
 'CHANNEL_CACHED_EVENT_SOURCE_MISMATCH':[409],
 'CHANNEL_CACHED_EVENT_BINDING_MISMATCH':[409],
 'CHANNEL_AUTHORITY_BINDING_MISSING':[409],
 'CHANNEL_CACHED_THREAD_MISMATCH':[409],
 'CHANNEL_CACHED_EVENT_IDENTITY_INVALID':[422],
 'CHANNEL_MESSAGE_ENQUEUE_INVALID':[422],
 'IDEMPOTENCY_CONFLICT':[409],
 'VERSION_CONFLICT':[409],
});
const MATRIX_EVENT_ID=/^\$[A-Za-z0-9._=:+/-]{1,255}$/;
const SHA256=/^[a-f0-9]{64}$/;
export function isTerminalChannelMatrixRefusal(statusCode:number,errorCode:string):boolean{
 return (MATRIX_TERMINAL_REFUSALS[errorCode]??[]).includes(statusCode);
}
export function validateChannelMatrixTerminalRefusal(value:unknown):ChannelMatrixTerminalRefusal{
 if(!record(value)||!exact(value,['provider_message_id','source_sha256','status_code','error_code'])
  ||typeof value.provider_message_id!=='string'||!MATRIX_EVENT_ID.test(value.provider_message_id)
  ||typeof value.source_sha256!=='string'||!SHA256.test(value.source_sha256)
  ||!Number.isInteger(value.status_code)||typeof value.error_code!=='string'
  ||!isTerminalChannelMatrixRefusal(Number(value.status_code),value.error_code))return fail('matrix_terminal_refusal_invalid');
 return value as ChannelMatrixTerminalRefusal;
}
/** Derived only inside the original Gateway transaction; never caller input. */
export type ChannelHostOwnerContext=ReturnType<typeof readVerifiedChannelBinding>;
export const CHANNEL_HOST_WRITE_ROUTE='/internal/v1/channel/messages' as const;
export type ChannelForwardErrorCode=typeof ORIGINAL_INTAKE_ERROR_CODES[number]|typeof LOCAL_FORWARD_ERROR_CODES[number];
export type ChannelForwardResult=Readonly<{
 statusCode:number;body:ChannelIntakeReceipt|Readonly<{error:Readonly<{code:ChannelForwardErrorCode}>}>;
}>;
/** One incoming-admission port. This is not a provider, credential loader or Host tool-write receipt. */
export type ChannelHostWritePort=(message:NormalizedChannelMessage,signal?:AbortSignal)=>Promise<ChannelForwardResult>;
export type ChannelForward=ChannelHostWritePort;
export type ChannelHostWritePortOptions=Readonly<{url:string;token:string;fetch?:typeof fetch;timeoutMs?:number}>;
export type ChannelIntakeRecoveryState=
 |Readonly<{state:'acknowledged';receipt:ChannelIntakeReceipt}>
 |Readonly<{state:'refused'|'unknown';http_status:number;code:ChannelForwardErrorCode;original_admission:'unproven';
   recovery:'lookup_original_event_only';lookup_handler:'not_exposed';automatic_replay:false}>;
export type ChannelMatrixPollResult=Readonly<{nextBatch:string;receipts:readonly ChannelIntakeReceipt[];
 terminalRefusals?:readonly ChannelMatrixTerminalRefusal[]}>;
export type ChannelRuntimeHandle=Readonly<{
 start():void|Promise<void>;stop():Promise<void>;uninstall():Promise<void>;
 pollMatrix?(since?:string):Promise<ChannelMatrixPollResult>;
}>;
/** Config is supplied by the protocol's real validator, not an unknown map. */
export type ChannelRuntimeOptions<Config>=Readonly<{
 channels:Config;forward:ChannelForward;attachmentForward?:ChannelAttachmentForwardPort;
 lookupMatrixTerminalRefusal?:(providerMessageId:string,sourceSha256:string)=>ChannelMatrixTerminalRefusal|null;
}>;
export type RegisterChannelRoutes<Config,Runtime extends ChannelRuntimeHandle=ChannelRuntimeHandle>=
 (app:FastifyInstance,options:ChannelRuntimeOptions<Config>)=>Runtime|Promise<Runtime>;

/** Empty by default. Parsing is configuration validation, never activation. */
export function parseChannelRuntimeIds(value:unknown):ChannelId[]{
 if(value===undefined||value==='')return [];
 if(typeof value!=='string')return fail('channel_configuration_invalid');
 const ids=value.split(',').map(id=>id.trim());
 if(ids.length>CHANNEL_IDS.length||new Set(ids).size!==ids.length||ids.some(id=>!CHANNEL_SET.has(id)))return fail('channel_configuration_invalid');
 return ids as ChannelId[];
}

export function normalizeChannelRuntimeMessage(value:unknown):NormalizedChannelMessage{
 if(!record(value))return fail('channel_message_invalid');
 const keys=Object.keys(value);
 if(keys.some(key=>!['channel','principal','thread_id','message_id','text','attachments'].includes(key))
  ||typeof value.channel!=='string'||!CHANNEL_SET.has(value.channel)||!opaque(value.principal)||!opaque(value.message_id)
  ||(value.thread_id!==undefined&&value.thread_id!==''&&!opaque(value.thread_id))
  ||typeof value.text!=='string'||!value.text.trim()||value.text.trim().length>4000
  ||(value.attachments!==undefined&&!Array.isArray(value.attachments)))return fail('channel_message_invalid');
 const attachments=value.attachments??[];
 if(!Array.isArray(attachments)||attachments.length>10)return fail('channel_attachments_invalid');
 for(const item of attachments){
  if(!record(item)||Object.keys(item).some(key=>!['provider_file_id','file_name','media_type','size_bytes'].includes(key))
   ||!opaque(item.provider_file_id)||typeof item.file_name!=='string'||!item.file_name||item.file_name.length>255
   ||/[\\/\u0000-\u001f\u007f]/u.test(item.file_name)||typeof item.media_type!=='string'||!item.media_type||item.media_type.length>200
   ||/[\u0000-\u001f\u007f]/u.test(item.media_type)
   ||(item.size_bytes!==undefined&&(!Number.isSafeInteger(item.size_bytes)||Number(item.size_bytes)<0||Number(item.size_bytes)>104857600)))return fail('channel_attachments_invalid');
 }
 // Original Artifact/message/run custody is required before nonempty intake.
 if(attachments.length)return fail('channel_attachment_staging_missing');
 return Object.freeze({channel:value.channel as ChannelId,principal:value.principal,
  thread_id:value.thread_id===undefined?'':String(value.thread_id),message_id:value.message_id,text:value.text.trim(),attachments:Object.freeze([])});
}

const ORIGINAL_INTAKE_ERROR_CODES=[
 'UNAUTHORIZED','CHANNEL_BINDING_NOT_VERIFIED','CHANNEL_BINDING_PROOF_INVALID','CHANNEL_BINDING_UNAVAILABLE',
 'CHANNEL_PRINCIPAL_ALREADY_BOUND','CHANNEL_MESSAGE_INVALID','CHANNEL_ATTACHMENTS_INVALID','CHANNEL_ATTACHMENT_STAGING_MISSING',
 'CHANNEL_CACHED_EVENT_SOURCE_MISMATCH','CHANNEL_CACHED_EVENT_BINDING_MISMATCH','CHANNEL_AUTHORITY_BINDING_MISSING',
 'CHANNEL_CACHED_THREAD_MISMATCH','CHANNEL_CACHED_EVENT_IDENTITY_INVALID','CHANNEL_MESSAGE_ENQUEUE_INVALID',
 'IDEMPOTENCY_CONFLICT','VERSION_CONFLICT',
 ] as const;
const LOCAL_FORWARD_ERROR_CODES=['CHANNEL_FORWARD_CANCELLED','CHANNEL_FORWARD_TIMEOUT','CHANNEL_INTAKE_UNAVAILABLE','CHANNEL_INTAKE_RESPONSE_INVALID'] as const;
const ERROR_CODES:ReadonlySet<string>=new Set(ORIGINAL_INTAKE_ERROR_CODES);
const ALL_ERROR_CODES:ReadonlySet<string>=new Set([...ORIGINAL_INTAKE_ERROR_CODES,...LOCAL_FORWARD_ERROR_CODES]);
const knownError=(value:unknown):value is ChannelForwardErrorCode=>typeof value==='string'&&ALL_ERROR_CODES.has(value);
const denied=(statusCode:number,code:ChannelForwardErrorCode):ChannelForwardResult=>({statusCode,body:{error:{code}}});
function receipt(value:unknown):value is ChannelIntakeReceipt{
 if(!record(value)||value.accepted!==true)return false;
 if(exact(value,['accepted','kind','status']))return value.kind==='channel_binding'&&value.status==='verified';
 return exact(value,['accepted','message_id','run_id','conversation_id'])
  &&['message_id','run_id','conversation_id'].every(key=>typeof value[key]==='string'&&ID.test(value[key]));
}

/** Validate the original intake acknowledgement; never synthesize receipt facts. */
export function validateChannelIntakeReceipt(value:unknown):ChannelIntakeReceipt{
 if(!receipt(value))return fail('channel_intake_receipt_invalid');
 return value;
}

/** Describes the current recovery gap; does not query, replay or write anything. */
export function channelIntakeRecoveryState(result:ChannelForwardResult):ChannelIntakeRecoveryState{
 if(result.statusCode===202)return {state:'acknowledged',receipt:validateChannelIntakeReceipt(result.body)};
 const body=result.body;
 if(!Number.isInteger(result.statusCode)||result.statusCode<400||result.statusCode>599
  ||!record(body)||!('error' in body)||!record(body.error)||!knownError(body.error.code))return fail('channel_intake_result_invalid');
 return {state:result.statusCode<500?'refused':'unknown',http_status:result.statusCode,code:body.error.code,
  original_admission:'unproven',recovery:'lookup_original_event_only',lookup_handler:'not_exposed',automatic_replay:false};
}

/** One fixed transport to the original service-bearer intake.
 * It supplies no owner headers, listener, store, approval or provider authority.
 */
export function createChannelForward(options:ChannelHostWritePortOptions):ChannelHostWritePort{
 if(!record(options)||Object.keys(options).some(key=>!['url','token','fetch','timeoutMs'].includes(key))
  ||options.fetch!==undefined&&typeof options.fetch!=='function')return fail('channel_forward_configuration_invalid');
 let url:URL;
 try{url=new URL(options.url);}catch{return fail('channel_forward_configuration_invalid');}
 const timeoutMs=options.timeoutMs??30000;
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)
  ||url.username||url.password||url.pathname!=='/'||url.search||url.hash
  ||typeof options.token!=='string'||options.token.length<16||/[\r\n]/.test(options.token)
  ||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)return fail('channel_forward_configuration_invalid');
 const endpoint=url.origin+CHANNEL_HOST_WRITE_ROUTE,token=options.token,send=options.fetch??fetch;
 return async(input,signal)=>{
  let message:NormalizedChannelMessage;
  try{message=normalizeChannelRuntimeMessage(input);}
  catch(error){
   const code=error instanceof Error?error.message:'';
   return denied(422,code==='channel_attachment_staging_missing'?'CHANNEL_ATTACHMENT_STAGING_MISSING'
    :code==='channel_attachments_invalid'?'CHANNEL_ATTACHMENTS_INVALID':'CHANNEL_MESSAGE_INVALID');
  }
  if(signal?.aborted)return denied(503,'CHANNEL_FORWARD_CANCELLED');
  const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),timeoutMs);
  const combined=signal?AbortSignal.any([signal,timeout.signal]):timeout.signal;
  try{
   const response=await send(endpoint,{method:'POST',headers:{'authorization':'Bearer '+token,'content-type':'application/json'},
    body:JSON.stringify(message),signal:combined,redirect:'error'});
   let value:unknown;
   try{value=await response.json();}catch{
    if(combined.aborted)throw Error('channel_forward_aborted');
    return denied(502,'CHANNEL_INTAKE_RESPONSE_INVALID');
   }
   if(response.status===202)return receipt(value)?{statusCode:202,body:value}:denied(502,'CHANNEL_INTAKE_RESPONSE_INVALID');
   if(response.status>=400&&response.status<500&&record(value)&&record(value.error)
    &&knownError(value.error.code)&&ERROR_CODES.has(value.error.code))return denied(response.status,value.error.code);
   return denied(502,'CHANNEL_INTAKE_UNAVAILABLE');
  }catch{
   if(signal?.aborted)return denied(503,'CHANNEL_FORWARD_CANCELLED');
   return timeout.signal.aborted?denied(504,'CHANNEL_FORWARD_TIMEOUT'):denied(503,'CHANNEL_INTAKE_UNAVAILABLE');
  }finally{clearTimeout(timer);}
 };
}
