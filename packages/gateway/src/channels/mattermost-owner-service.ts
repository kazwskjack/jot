import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {createMattermostBotClient} from './adapters/mattermost-bot-client.ts';
import {installMattermostOwnerProof,mattermostProofDigest} from './mattermost-owner-proof.ts';
import {createChannelForward} from './runtime-contracts.ts';
import {installMattermostTextControl,freezeMattermostText,currentMattermostTextSource,proveMattermostTextObservation,requireNoMattermostTextPost,type MattermostTextWire} from './mattermost-text-control.ts';
import {installMattermostAttachmentControl,readMattermostAttachmentBinding,currentMattermostAttachmentObservation,freezeMattermostAttachments,proveMattermostAttachmentObservation} from './mattermost-attachment-control.ts';
import {createChannelAttachmentForwardV2} from './attachment-forward-v2.ts';
import {channelAttachmentIntakeConfiguration} from './attachment-config-v2.ts';
import {createHash} from 'node:crypto';
import type {ChannelAttachmentRequestDeclarationV2} from './runtime-contracts.ts';
type Socket=Pick<WebSocket,'addEventListener'|'removeEventListener'|'send'|'close'>;
type Dependencies={db:DatabaseSync;fetch?:typeof fetch;gatewayFetch?:typeof fetch;socketFactory?:(url:string)=>Socket;memberPageSize?:number};
/** Original worker lifetime for proofs, text and opt-in files; no listener or separate daemon. */
export async function startMattermostOwnerService(env:Readonly<Record<string,string|undefined>>,deps:Dependencies){
 const instance=env.GENERAL_AGENT_MATTERMOST_BASE_URL,botToken=env.GENERAL_AGENT_MATTERMOST_BOT_TOKEN;
 if(instance===undefined&&botToken===undefined)return undefined;
 const url=env.GENERAL_AGENT_GATEWAY_INTERNAL_URL,token=env.GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN;
 if(!instance||!botToken||!url||!token||!env.GENERAL_AGENT_MATTERMOST_BOT_USER_ID)throw Error('mattermost_service_config_required');
 const controller=new AbortController(),signal=controller.signal;
 const client=createMattermostBotClient({instance,botToken,...(deps.memberPageSize!==undefined?{memberPageSize:deps.memberPageSize}:{})},deps.fetch),account=await client.identify(signal);
 if(account.botUserId!==env.GENERAL_AGENT_MATTERMOST_BOT_USER_ID)throw Error('mattermost_account_mismatch');
 const forward=createChannelForward({url,token,...(deps.gatewayFetch?{fetch:deps.gatewayFetch}:{})});
 installMattermostOwnerProof(deps.db);
 installMattermostTextControl(deps.db);
 installMattermostAttachmentControl(deps.db);
 const attachmentsEnabled=channelAttachmentIntakeConfiguration(env).channelAttachmentIntakeV2;
 const attachmentPort=createChannelAttachmentForwardV2({url,token,...(deps.gatewayFetch?{fetch:deps.gatewayFetch}:{})});
 const gateway=deps.gatewayFetch??fetch;
 let active=true,authenticated=false,pending=Promise.resolve(),lastError:string|undefined;
 const check=()=>{if(!active||signal.aborted)throw Error('mattermost_service_stopped');};
 const lookup=async(input:{principal:string;thread_id:string;message_id:string;source_sha256:string})=>{
  check();const response=await gateway(new URL('/internal/v1/channel/mattermost/proof-receipt',url),{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(input)});
  check();if(response.status!==200)throw Error('mattermost_proof_unknown');const result=await response.json();if(result?.state!=='observed'||result?.receipt?.accepted!==true||result?.receipt?.kind!=='channel_binding'||result?.receipt?.status!=='verified')throw Error('mattermost_proof_unknown');
 };
 const consume=async(notification:unknown)=>{
  check();const message=await client.verifyPrivateProof(notification,signal);check();
  const digest=mattermostProofDigest(message),input={principal:message.principal,thread_id:message.thread_id,message_id:message.message_id,source_sha256:digest};
  const previous=withImmediateTransaction(deps.db,()=>{
   requireNoMattermostTextPost(deps.db,account,message.message_id);
   const row=deps.db.prepare('SELECT * FROM ga_mattermost_ingress_observations WHERE instance=? AND bot_user_id=? AND post_id=?').get(account.instance,account.botUserId,message.message_id);
   if(row){if(row.source_sha256!==digest||row.principal!==message.principal||row.provider_thread_id!==message.thread_id)throw Error('mattermost_event_source_conflict');return true;}
   deps.db.prepare('INSERT INTO ga_mattermost_ingress_observations(instance,bot_user_id,post_id,principal,provider_thread_id,source_sha256,created_at) VALUES(?,?,?,?,?,?,?)').run(account.instance,account.botUserId,message.message_id,message.principal,message.thread_id,digest,Math.floor(Date.now()/1000));return false;
  });
  if(previous){await lookup(input);return;}
  check();const result=await forward(message,signal);check();
  if(result.statusCode===202){
   const body=result.body as Record<string,unknown>;
   if(Object.keys(body).sort().join(',')!=='accepted,kind,status'||body.accepted!==true||body.kind!=='channel_binding'||body.status!=='verified')throw Error('mattermost_binding_receipt_invalid');
   return;
  }
  if(result.statusCode>=500){await lookup(input);return;}
  throw Error('mattermost_proof_refused');
 };
 const lookupText=async(source:MattermostTextWire)=>{
  check();currentMattermostTextSource(deps.db,account,source.message_id);
  const response=await gateway(new URL('/internal/v1/channel/mattermost/event-receipt',url),{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(source)});
  check();currentMattermostTextSource(deps.db,account,source.message_id);
  if(response.status!==200)throw Error('mattermost_text_unknown');const result=await response.json();
  if(result?.state!=='observed'||result?.automatic_replay!==false||Object.keys(result).sort().join(',')!=='automatic_replay,receipt,state')throw Error('mattermost_text_unknown');
  const receipt=result.receipt;
  if(!receipt||Object.keys(receipt).sort().join(',')!=='accepted,conversation_id,message_id,run_id'||receipt.accepted!==true||!['message_id','run_id','conversation_id'].every(key=>typeof receipt[key]==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(receipt[key])))throw Error('mattermost_text_receipt_invalid');
 };
 const consumeText=async(notification:unknown)=>{
  check();const message=await client.verifyPrivateMessage(notification,signal);check();
  const frozen=freezeMattermostText(deps.db,account,message);
  if(frozen.previous){await lookupText(frozen.source);return;}
  check();currentMattermostTextSource(deps.db,account,message.message_id);
  const result=await forward(frozen.source,signal);check();currentMattermostTextSource(deps.db,account,message.message_id);
  if(result.statusCode>=500){await lookupText(frozen.source);return;}
  const receipt=result.body as Record<string,unknown>;
  if(result.statusCode!==202||Object.keys(receipt).sort().join(',')!=='accepted,conversation_id,message_id,run_id'||receipt.accepted!==true||!['message_id','run_id','conversation_id'].every(key=>typeof receipt[key]==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(receipt[key] as string)))throw Error('mattermost_text_receipt_invalid');
 };
 const lookupAttachment=async(source:ChannelAttachmentRequestDeclarationV2)=>{
  check();currentMattermostAttachmentObservation(deps.db,account,source.event.message_id);
  const result=await attachmentPort.lookupOriginalRequest(source,signal);check();currentMattermostAttachmentObservation(deps.db,account,source.event.message_id);
  if(result.statusCode!==202)throw Error('mattermost_attachment_unknown');
 };
 const consumeAttachment=async(notification:Record<string,unknown>)=>{
  check();const previous=currentMattermostAttachmentObservation(deps.db,account,String(notification.id));
  if(previous){
   const principal=JSON.stringify([account.instance,account.botUserId,notification.user_id]),thread=JSON.stringify([notification.channel_id,notification.root_id??'']);
   if(notification.id!==previous.event.message_id||principal!==previous.event.principal||thread!==previous.event.thread_id||typeof notification.message!=='string'||notification.message.trim()!==previous.text
    ||JSON.stringify(notification.file_ids)!==JSON.stringify(previous.attachments.map(part=>part.provider_file_id))||notification.edit_at!==0&&notification.edit_at!==undefined||notification.delete_at!==0&&notification.delete_at!==undefined)throw Error('mattermost_attachment_source_conflict');
   await lookupAttachment(previous);return;
  }
  if(!attachmentsEnabled)throw Error('channel_attachment_staging_missing');
  const sealed=await client.inspectPrivateAttachments(notification,signal);check();const expected=readMattermostAttachmentBinding(deps.db,account,sealed.message);
  const parts=await client.downloadPrivateAttachments(sealed,signal);check();
  const declaration:ChannelAttachmentRequestDeclarationV2={protocol:2,event:{channel:'mattermost',principal:sealed.message.principal,thread_id:sealed.message.thread_id,message_id:sealed.message.message_id},text:sealed.message.text,
   attachments:parts.map(({bytes,...part},index)=>({index,...part,sha256:createHash('sha256').update(bytes).digest('hex')}))};
  const frozen=freezeMattermostAttachments(deps.db,account,declaration,expected);
  if(frozen.previous){await lookupAttachment(frozen.source);return;}
  check();currentMattermostAttachmentObservation(deps.db,account,declaration.event.message_id);
  const result=await attachmentPort({...sealed.message,channel:'mattermost',authenticated:true,attachments:parts},signal);
  check();currentMattermostAttachmentObservation(deps.db,account,declaration.event.message_id);
  if(result.statusCode!==202)throw Error('mattermost_attachment_unknown');
 };
 const socketUrl=new URL('/api/v4/websocket',instance);socketUrl.protocol='wss:';
 const socket=(deps.socketFactory??(value=>new WebSocket(value)))(socketUrl.href);
 let resolveReady:()=>void,rejectReady:(reason:unknown)=>void;
 const ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
 const onOpen=()=>{if(active)socket.send(JSON.stringify({seq:1,action:'authentication_challenge',data:{token:botToken}}));};
 const onMessage=(event:Event)=>{
  if(!active)return;
  try{
   const raw=(event as MessageEvent).data;if(typeof raw!=='string'||Buffer.byteLength(raw)>128*1024)throw Error('mattermost_event_invalid');const value=JSON.parse(raw);
   if(!authenticated){if(value.seq_reply===1&&value.status==='OK'){authenticated=true;resolveReady();}else if(value.seq_reply===1)rejectReady(Error('mattermost_socket_unauthorized'));return;}
   if(value.event!=='posted')return;
   const post=typeof value.data?.post==='string'?JSON.parse(value.data.post):undefined;
   if(typeof post?.message!=='string')return;
   pending=pending.then(()=>post.message.startsWith('/jot-bind')?consume(post):Array.isArray(post.file_ids)&&post.file_ids.length?consumeAttachment(post):consumeText(post)).catch(error=>{lastError=/^[a-z0-9_]+$/.test(String(error?.message))?error.message:'mattermost_service_failed';});
  }catch{lastError='mattermost_event_invalid';}
 };
 const onClose=()=>{active=false;controller.abort();rejectReady(Error('mattermost_socket_closed'));};
 socket.addEventListener('open',onOpen);socket.addEventListener('message',onMessage);socket.addEventListener('close',onClose);socket.addEventListener('error',onClose);
 const timer=setTimeout(()=>rejectReady(Error('mattermost_socket_auth_timeout')),10000);timer.unref?.();
 try{await ready;}catch(error){active=false;controller.abort();socket.close();throw error;}finally{clearTimeout(timer);}
 const stop=async()=>{active=false;controller.abort();socket.close();await pending;};
 // Recover existing boundaries without relying on provider event replay. This
 // read-only work shares the callback lifetime and never blocks the delivery loop.
 try{
  const bound=deps.db.prepare('SELECT created_at,post_id FROM ga_mattermost_ingress_observations WHERE instance=? AND bot_user_id=? ORDER BY created_at DESC,post_id DESC LIMIT 1').get(account.instance,account.botUserId);
  if(bound)pending=pending.then(async()=>{
   let time=-1,key='';
   while(active){
    check();const rows=deps.db.prepare(`SELECT principal,provider_thread_id,post_id,source_sha256,created_at FROM ga_mattermost_ingress_observations
     WHERE instance=? AND bot_user_id=? AND (created_at>? OR (created_at=? AND post_id>?))
     AND (created_at<? OR (created_at=? AND post_id<=?)) ORDER BY created_at,post_id LIMIT 32`)
     .all(account.instance,account.botUserId,time,time,key,bound.created_at!,bound.created_at!,bound.post_id!);
    if(!rows.length)break;
    for(const row of rows){try{await lookup({principal:String(row.principal),thread_id:String(row.provider_thread_id),message_id:String(row.post_id),source_sha256:String(row.source_sha256)});}catch{lastError='mattermost_proof_unknown';}}
    const last=rows.at(-1)!;time=Number(last.created_at);key=String(last.post_id);
   }
  }).catch(()=>{lastError='mattermost_proof_unknown';});
  const textBound=deps.db.prepare('SELECT created_at,post_id FROM ga_mattermost_text_observations WHERE instance=? AND bot_user_id=? ORDER BY created_at DESC,post_id DESC LIMIT 1').get(account.instance,account.botUserId);
  if(textBound)pending=pending.then(async()=>{
   let time=-1,key='';
   while(active){
    check();const rows=deps.db.prepare(`SELECT * FROM ga_mattermost_text_observations WHERE instance=? AND bot_user_id=?
     AND (created_at>? OR (created_at=? AND post_id>?)) AND (created_at<? OR (created_at=? AND post_id<=?)) ORDER BY created_at,post_id LIMIT 32`)
     .all(account.instance,account.botUserId,time,time,key,textBound.created_at!,textBound.created_at!,textBound.post_id!);
    if(!rows.length)break;
    for(const row of rows){try{await lookupText(proveMattermostTextObservation(deps.db,account,row));}catch{lastError='mattermost_text_unknown';}}
    const last=rows.at(-1)!;time=Number(last.created_at);key=String(last.post_id);
   }
  }).catch(()=>{lastError='mattermost_text_unknown';});
  const fileBound=deps.db.prepare('SELECT created_at,post_id FROM ga_mattermost_attachment_observations WHERE instance=? AND bot_user_id=? ORDER BY created_at DESC,post_id DESC LIMIT 1').get(account.instance,account.botUserId);
  if(fileBound)pending=pending.then(async()=>{
   let time=-1,key='';
   while(active){
    check();const rows=deps.db.prepare(`SELECT * FROM ga_mattermost_attachment_observations WHERE instance=? AND bot_user_id=?
     AND (created_at>? OR (created_at=? AND post_id>?)) AND (created_at<? OR (created_at=? AND post_id<=?)) ORDER BY created_at,post_id LIMIT 32`)
     .all(account.instance,account.botUserId,time,time,key,fileBound.created_at!,fileBound.created_at!,fileBound.post_id!);
    if(!rows.length)break;
    for(const row of rows){try{await lookupAttachment(proveMattermostAttachmentObservation(deps.db,account,row));}catch{lastError='mattermost_attachment_unknown';}}
    const last=rows.at(-1)!;time=Number(last.created_at);key=String(last.post_id);
   }
  }).catch(()=>{lastError='mattermost_attachment_unknown';});
 }catch(error){await stop();throw error;}
 return {running:()=>active&&authenticated,idle:()=>pending,lastError:()=>lastError,stop,async uninstall(){await stop();socket.removeEventListener('open',onOpen);socket.removeEventListener('message',onMessage);socket.removeEventListener('close',onClose);socket.removeEventListener('error',onClose);}};
}
