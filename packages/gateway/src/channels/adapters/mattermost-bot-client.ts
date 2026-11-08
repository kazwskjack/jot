import {mattermostOwnerAccount,type MattermostOwnerAccount} from '../mattermost-owner-proof.ts';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type RecordValue=Record<string,unknown>;
function object(value:unknown):RecordValue{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('mattermost_source_invalid');return value as RecordValue;}
function normalizedPost(value:unknown,allowRoot=false,allowFiles=false){
 const row=object(value);
 if(typeof row.id!=='string'||!ID.test(row.id)||typeof row.user_id!=='string'||!ID.test(row.user_id)||typeof row.channel_id!=='string'||!ID.test(row.channel_id)
  ||typeof row.message!=='string'||row.message.length>4000||row.root_id!==''&&row.root_id!==undefined&&(!allowRoot||typeof row.root_id!=='string'||!ID.test(row.root_id))||row.type!==''&&row.type!==undefined
  ||row.delete_at!==0&&row.delete_at!==undefined||row.edit_at!==0&&row.edit_at!==undefined||row.file_ids!==undefined&&(!Array.isArray(row.file_ids)||(!allowFiles&&row.file_ids.length)||row.file_ids.length>10||row.file_ids.some(id=>typeof id!=='string'||!ID.test(id))||new Set(row.file_ids).size!==row.file_ids.length))throw Error('mattermost_source_invalid');
 return {id:row.id,user_id:row.user_id,channel_id:row.channel_id,message:row.message,root_id:typeof row.root_id==='string'?row.root_id:'',file_ids:Array.isArray(row.file_ids)?row.file_ids as string[]:[]};
}
/** Read-only authenticated private DM source. No send or public URL port. */
export function createMattermostBotClient(config:{instance:string;botToken:string;memberPageSize?:number;maxAttachmentBytes?:number;maxAggregateBytes?:number},transport:typeof fetch=fetch){
 const origin=new URL(config.instance);if(origin.protocol!=='https:'||origin.origin!==config.instance||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||typeof config.botToken!=='string'||config.botToken.length<16||/[\r\n]/.test(config.botToken))throw Error('mattermost_config_invalid');
 const pageSize=config.memberPageSize??200;if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>200)throw Error('mattermost_config_invalid');
 const maxPart=config.maxAttachmentBytes??104857600,maxTotal=config.maxAggregateBytes??209715200;
 if(!Number.isSafeInteger(maxPart)||maxPart<1||maxPart>104857600||!Number.isSafeInteger(maxTotal)||maxTotal<1||maxTotal>209715200)throw Error('mattermost_config_invalid');
 async function bytes(response:Response,signal:AbortSignal,limit:number){
  if(!response.ok||!response.body){await response.body?.cancel();throw Error('mattermost_source_unavailable');}
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{while(true){signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done)break;size+=next.value.byteLength;if(size>limit)throw Error('mattermost_source_oversize');chunks.push(next.value);}return Buffer.concat(chunks);}
  finally{signal.removeEventListener('abort',abort);try{await reader.cancel();}finally{reader.releaseLock();}}
 }
 async function read(path:string,signal:AbortSignal){
  const combined=AbortSignal.any([signal,AbortSignal.timeout(15000)]),response=await transport(new URL('/api/v4/'+path,origin),{method:'GET',redirect:'error',signal:combined,headers:{authorization:'Bearer '+config.botToken,accept:'application/json'}});
  return JSON.parse((await bytes(response,combined,128*1024)).toString('utf8')) as unknown;
 }
 let account:MattermostOwnerAccount|undefined;
 const client={
  async identify(signal:AbortSignal){const me=object(await read('users/me',signal));if(typeof me.id!=='string'||!ID.test(me.id))throw Error('mattermost_source_invalid');account=mattermostOwnerAccount({instance:config.instance,botUserId:me.id});return account;},
  async verifyPrivateMessage(notification:unknown,signal:AbortSignal,proofOnly=false,allowFiles=false){
   if(!account)throw Error('mattermost_identity_required');
   const announced=normalizedPost(notification,!proofOnly,allowFiles),post=normalizedPost(await read('posts/'+encodeURIComponent(announced.id),signal),!proofOnly,allowFiles);
   if(JSON.stringify(post)!==JSON.stringify(announced)||post.user_id===account.botUserId||(!post.message.trim()&&!post.file_ids.length)||allowFiles&&!post.file_ids.length||proofOnly&&!/^\/jot-bind [A-Za-z0-9_-]{43}$/.test(post.message))throw Error('mattermost_source_invalid');
   const path='channels/'+encodeURIComponent(post.channel_id),channel=object(await read(path,signal));
   if(channel.id!==post.channel_id||channel.type!=='D'||channel.delete_at!==0&&channel.delete_at!==undefined)throw Error('mattermost_private_dm_required');
   const members=new Set<string>();let complete=false;
   for(let page=0;page<50;page++){
    const rows=await read(path+'/members?page='+page+'&per_page='+pageSize,signal);
    if(!Array.isArray(rows)||rows.length>pageSize)throw Error('mattermost_members_unproven');
    if(rows.length===0){complete=true;break;}
    for(const raw of rows){const member=object(raw);if(typeof member.user_id!=='string'||!ID.test(member.user_id)||member.channel_id!==post.channel_id||members.has(member.user_id))throw Error('mattermost_members_unproven');members.add(member.user_id);}
   }
   if(!complete||members.size!==2||!members.has(account.botUserId)||!members.has(post.user_id))throw Error('mattermost_private_dm_required');
   const current=object(await read(path,signal));if(current.id!==channel.id||current.type!=='D'||current.delete_at!==0&&current.delete_at!==undefined)throw Error('mattermost_private_dm_required');
   if(post.root_id){const root=object(await read('posts/'+encodeURIComponent(post.root_id),signal));if(root.id!==post.root_id||root.channel_id!==post.channel_id||root.root_id!==''&&root.root_id!==undefined||root.delete_at!==0&&root.delete_at!==undefined||![account.botUserId,post.user_id].includes(String(root.user_id)))throw Error('mattermost_root_unproven');}
   if(JSON.stringify(normalizedPost(await read('posts/'+encodeURIComponent(post.id),signal),!proofOnly,allowFiles))!==JSON.stringify(post))throw Error('mattermost_source_changed');
   signal.throwIfAborted();const wire=Object.freeze({channel:'mattermost' as const,principal:JSON.stringify([account.instance,account.botUserId,post.user_id]),thread_id:JSON.stringify([post.channel_id,post.root_id]),message_id:post.id,text:post.message.trim(),attachments:[]});
   return wire;
  },
 };
 const sealed=new WeakMap<object,{post:ReturnType<typeof normalizedPost>;infos:Record<string,unknown>[]}>();
 const mime=(value:unknown)=>{if(typeof value!=='string'||value.length>200||/[\u0000-\u001f\u007f]/u.test(value))throw Error('mattermost_file_metadata_invalid');const type=value.split(';')[0]!.trim().toLowerCase();if(!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type))throw Error('mattermost_file_metadata_invalid');return type;};
 const infosFor=async(post:ReturnType<typeof normalizedPost>,signal:AbortSignal)=>{
  const list=await read('posts/'+encodeURIComponent(post.id)+'/files/info',signal);if(!Array.isArray(list)||list.length!==post.file_ids.length)throw Error('mattermost_file_metadata_invalid');const map=new Map<string,Record<string,unknown>>();let total=0;
  for(const value of list){const info=object(value);if(typeof info.id!=='string'||!post.file_ids.includes(info.id)||map.has(info.id)||info.post_id!==post.id||info.user_id!==post.user_id||info.channel_id!==undefined&&info.channel_id!==post.channel_id||info.delete_at!==0&&info.delete_at!==undefined||info.archived===true||typeof info.name!=='string'||!info.name||['.','..'].includes(info.name)||info.name.length>255||/[\\/\u0000-\u001f\u007f]/u.test(info.name)||!Number.isSafeInteger(info.size)||Number(info.size)<1||Number(info.size)>maxPart||!Number.isSafeInteger(info.update_at)||Number(info.update_at)<0)throw Error('mattermost_file_metadata_invalid');mime(info.mime_type);total+=Number(info.size);if(total>maxTotal)throw Error('mattermost_file_metadata_invalid');map.set(info.id,{id:info.id,post_id:info.post_id,user_id:info.user_id,name:info.name,size:info.size,mime_type:info.mime_type,update_at:info.update_at});}
  const ordered=post.file_ids.map(id=>map.get(id)!);for(const info of ordered){const current=object(await read('files/'+encodeURIComponent(String(info.id))+'/info',signal));if(current.channel_id!==undefined&&current.channel_id!==post.channel_id||current.delete_at!==0&&current.delete_at!==undefined||current.archived===true)throw Error('mattermost_file_metadata_changed');for(const key of Object.keys(info))if(current[key]!==info[key])throw Error('mattermost_file_metadata_changed');}
  return ordered;
 };
 return {...client,async inspectPrivateAttachments(notification:unknown,signal:AbortSignal){
  const message=await client.verifyPrivateMessage(notification,signal,false,true),post=normalizedPost(await read('posts/'+encodeURIComponent(message.message_id),signal),true,true);
  if(JSON.stringify(post)!==JSON.stringify(normalizedPost(notification,true,true))||post.message.trim()!==message.text||JSON.stringify([post.channel_id,post.root_id])!==message.thread_id||JSON.stringify([account!.instance,account!.botUserId,post.user_id])!==message.principal)throw Error('mattermost_source_changed');
  const infos=await infosFor(post,signal),seal=Object.freeze({message,fileIds:Object.freeze([...post.file_ids])});sealed.set(seal,{post,infos});return seal;
 },async downloadPrivateAttachments(seal:object,signal:AbortSignal){
  const source=sealed.get(seal);if(!source)throw Error('mattermost_file_source_unproven');const parts:Array<{provider_file_id:string;file_name:string;media_type:string;size_bytes:number;bytes:Uint8Array}>=[];
  for(const info of source.infos){const combined=AbortSignal.any([signal,AbortSignal.timeout(15000)]),response=await transport(new URL('/api/v4/files/'+encodeURIComponent(String(info.id)),origin),{method:'GET',redirect:'error',signal:combined,headers:{authorization:'Bearer '+config.botToken,accept:'application/octet-stream'}});
   try{if(!response.ok)throw Error('mattermost_source_unavailable');if(mime(response.headers.get('content-type'))!==mime(info.mime_type))throw Error('mattermost_file_type_mismatch');}catch(error){await response.body?.cancel();throw error;}const content=await bytes(response,combined,Math.min(maxPart,Number(info.size)));if(content.length!==info.size)throw Error('mattermost_file_size_mismatch');parts.push({provider_file_id:String(info.id),file_name:String(info.name),media_type:mime(info.mime_type),size_bytes:Number(info.size),bytes:new Uint8Array(content)});}
  if(JSON.stringify(await infosFor(source.post,signal))!==JSON.stringify(source.infos)||JSON.stringify(normalizedPost(await read('posts/'+encodeURIComponent(source.post.id),signal),true,true))!==JSON.stringify(source.post))throw Error('mattermost_file_source_changed');
  return parts;
 },verifyPrivateProof:(notification:unknown,signal:AbortSignal)=>client.verifyPrivateMessage(notification,signal,true)};
}
