import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildServer} from '../../../src/server.ts';

const instance='https://chat.example.test',bot='bot-account',user='owner-user',channel='private-dm';
class Socket extends EventTarget{
 static latest;
 constructor(){super();Socket.latest=this;queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
 send(raw){const value=JSON.parse(raw);assert.equal(value.action,'authentication_challenge');queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({status:'OK',seq_reply:value.seq})})));}
 close(){this.closed=true;}
 posted(post){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({event:'posted',data:{post:JSON.stringify(post)}})}));}
}
export async function setup(t,options={}){
 const parent=resolve('test-tmp');mkdirSync(parent,{recursive:true});const root=options.root??mkdtempSync(join(parent,'mattermost-owner-'));
 const token='synthetic-mattermost-internal-token',csrf='synthetic-mattermost-csrf';
 const product=await buildServer({databasePath:join(root,'db.sqlite'),workspaces:['ws'],internalChannelToken:token,uploadRoot:join(root,'files'),channelAttachmentIntakeV2:true,ordinaryInputRecoveryEnabled:true,conversationGoalClient:{stageVerifiedFile:async()=>assert.fail('no native dispatch'),recoverInput:async()=>assert.fail('no native recovery'),ordinaryRunHistoryReadiness:async()=>({protocol:1,ready:true,execution_authorized:false})},templateRoot:fileURLToPath(new URL('../../../file-engine/templates/',import.meta.url)),
  csrfToken:csrf,allowedOrigins:['https://fixture.invalid'],mattermostOwnerBinding:{instance,botUserId:bot}});
 let service; t.after(async()=>{await service?.uninstall();await product.app.close();product.db.close();const rel=relative(parent,root);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const create=async(owner='alice',key='mattermost-owner-challenge')=>{
  const response=await product.app.inject({method:'POST',url:'/v1/channel-bindings',headers:{'x-user-id':owner,origin:'https://fixture.invalid','x-csrf-token':csrf,'idempotency-key':key},payload:{channel:'mattermost'}});
  assert.equal(response.statusCode,201,response.body);return response.json();};
 const challenge=options.challenge??await create();let post={id:'post-proof',user_id:user,channel_id:channel,root_id:'',message:'/jot-bind '+challenge.code,file_ids:[],type:'',delete_at:0,edit_at:0};
 const fileBytes=Buffer.from('Original Mattermost attachment');
 const controls={fileBytes,fileInfos:[{id:'provider-file',post_id:'file-post',user_id:user,channel_id:channel,name:'one.txt',size:fileBytes.length,mime_type:'text/plain',delete_at:0,update_at:1}],type:'D',members:[bot,user],failPage:false,loseAck:false,unknownBefore:false,malformed:false,pauseMembers:false},http=[],gateway=[];
 const transport=async(input,init)=>{const url=new URL(input);http.push(url.pathname+url.search);assert.equal(url.origin,instance);assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer synthetic-bot-token');
  if(url.pathname.endsWith('/files/info'))return Response.json(controls.fileInfos);
  if(url.pathname.includes('/files/')){const id=url.pathname.split('/files/')[1].split('/')[0],info=controls.fileInfos.find(info=>info.id===id);if(url.pathname.endsWith('/info'))return Response.json(info);if(controls.pauseFile){controls.enteredFile?.();return new Response(new ReadableStream({cancel(){controls.fileCancelled=true;}}),{headers:{'content-type':info.mime_type}});}if(controls.redirect)return new Response('',{status:302,headers:{location:'https://foreign.example/file'}});return new Response(controls.fileBytes,{headers:{'content-type':controls.badType??info.mime_type}});}
  if(url.pathname.endsWith('/users/me'))return Response.json({id:bot});
  if(url.pathname.endsWith('/posts/'+post.id))return Response.json(post);
  const rootId=url.pathname.split('/posts/')[1];if(rootId&&controls.roots?.[rootId])return Response.json(controls.roots[rootId]);
  if(url.pathname.endsWith('/channels/'+channel))return Response.json({id:channel,type:controls.type,delete_at:0});
  if(url.pathname.endsWith('/members')){if(controls.pauseMembers){controls.entered?.();await new Promise((_,reject)=>{if(init.signal.aborted)reject(Error('aborted'));else init.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});}const page=Number(url.searchParams.get('page'));if(controls.failPage&&page===1)throw Error('synthetic_page_unavailable');return Response.json(controls.members.slice(page*2,(page+1)*2).map(user_id=>({user_id,channel_id:channel})));}
  throw Error('unexpected_api:'+url.pathname);
 };
 const gatewayFetch=async(input,init)=>{const url=new URL(input).pathname;gateway.push(url);options.beforeRequest?.(url);if(url==='/internal/v1/channel/messages'&&controls.unknownBefore)throw Error('synthetic_unknown_before_dispatch');if(url==='/internal/v1/channel/messages'&&controls.malformed)return Response.json({accepted:true,message_id:'bad',run_id:'bad',conversation_id:'bad'},{status:202});if(url==='/internal/v1/channel/messages')options.beforeIntake?.();const payload=typeof init.body==='string'?init.body:Buffer.from(await init.body.arrayBuffer());const response=await product.app.inject({method:init.method,url,headers:init.headers,payload});if(url==='/internal/v1/channel/messages')options.afterIntake?.(response);options.afterRequest?.(url,response);if(controls.loseReserveAck&&url==='/internal/v2/channel/attachment-batches'){controls.loseReserveAck=false;throw Error('synthetic_reserve_ack_lost');}if(controls.loseAck&&(url==='/internal/v1/channel/messages'||url.endsWith('/admit'))){controls.loseAck=false;throw Error('synthetic_lost_ack');}return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});};
 const start=async()=>{const {startMattermostOwnerService}=await import('../../../src/channels/mattermost-owner-service.ts');service=await startMattermostOwnerService({GENERAL_AGENT_CHANNEL_ATTACHMENTS_ENABLED:'true',GENERAL_AGENT_ORDINARY_INPUT_RECOVERY_ENABLED:'true',GENERAL_AGENT_MATTERMOST_BASE_URL:instance,GENERAL_AGENT_MATTERMOST_BOT_USER_ID:bot,GENERAL_AGENT_MATTERMOST_BOT_TOKEN:'synthetic-bot-token',GENERAL_AGENT_GATEWAY_INTERNAL_URL:'http://127.0.0.1:18831',GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:token},{db:product.db,fetch:transport,gatewayFetch,socketFactory:()=>new Socket(),memberPageSize:2});await service.idle();return service;};
 return {root,product,challenge,controls,http,gateway,create,start,get service(){return service;},get post(){return post;},set post(value){post=value;},emit:async notification=>{Socket.latest.posted(notification??post);await service.idle();},close:async()=>service.uninstall(),auth:{authorization:'Bearer '+token}};
}
