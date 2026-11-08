import test from 'node:test';
import assert from 'node:assert/strict';
import {createMattermostBotClient} from '../../src/channels/adapters/mattermost-bot-client.ts';
const post={id:'post-file',user_id:'owner-user',channel_id:'dm-one',root_id:'',message:'',file_ids:['file-one'],type:'',delete_at:0,edit_at:0};
function source(options={}){
 const calls=[],bytes=Buffer.from('original'),info={id:'file-one',post_id:post.id,user_id:post.user_id,channel_id:post.channel_id,name:'one.txt',size:bytes.length,mime_type:'text/plain',delete_at:0,update_at:1};let fileInfoReads=0,postReads=0;
 const client=createMattermostBotClient({instance:'https://chat.example.test',botToken:'synthetic-bot-token',maxAttachmentBytes:16,maxAggregateBytes:32},async(input,init)=>{const url=new URL(input);calls.push(url.href);assert.equal(url.origin,'https://chat.example.test');assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer synthetic-bot-token');
  if(url.pathname.endsWith('/users/me'))return Response.json({id:'bot-user'});
  if(url.pathname.endsWith('/files/info'))return Response.json([info]);
  if(url.pathname.endsWith('/file-one/info')){fileInfoReads++;return Response.json(options.foreignDetail?{...info,channel_id:'foreign-dm'}:options.mutate&&fileInfoReads>1?{...info,update_at:2}:info);}
  if(url.pathname.endsWith('/file-one')){if(options.redirect)return new Response('',{status:302,headers:{location:'https://foreign.test/file'}});return new Response(options.oversize?new Uint8Array(17):bytes,{headers:{'content-type':'text/plain'}});}
  if(url.pathname.endsWith('/posts/'+post.id)){postReads++;return Response.json(options.mutatePost&&postReads>3?{...post,file_ids:['other-file']}:post);}
  if(url.pathname.endsWith('/members'))return Response.json(url.searchParams.get('page')==='0'?[{user_id:'bot-user',channel_id:post.channel_id},{user_id:post.user_id,channel_id:post.channel_id}]:[]);
  if(url.pathname.endsWith('/channels/'+post.channel_id))return Response.json({id:post.channel_id,type:'D',delete_at:0});
  throw Error('unexpected:'+url.pathname);
 });return{client,calls,bytes};
}
test('same-instance sealed file read binds original post/uploader/meta and exact bytes',async()=>{
 const f=source(),signal=new AbortController().signal;await f.client.identify(signal);const seal=await f.client.inspectPrivateAttachments(post,signal),parts=await f.client.downloadPrivateAttachments(seal,signal);
 assert.equal(parts.length,1);assert.deepEqual(Buffer.from(parts[0].bytes),f.bytes);assert.equal(parts[0].provider_file_id,'file-one');assert.equal(parts[0].media_type,'text/plain');
 await assert.rejects(()=>f.client.downloadPrivateAttachments({...seal},signal),/mattermost_file_source_unproven/);assert.ok(f.calls.every(url=>url.startsWith('https://chat.example.test/api/v4/')));
});
test('bounded file stream, redirect and changed authoritative metadata fail closed',async()=>{
 for(const options of [{oversize:true},{redirect:true},{mutate:true},{mutatePost:true}]){const f=source(options),signal=new AbortController().signal;await f.client.identify(signal);const seal=await f.client.inspectPrivateAttachments(post,signal);await assert.rejects(()=>f.client.downloadPrivateAttachments(seal,signal));assert.ok(f.calls.every(url=>!url.startsWith('https://foreign.test')));}
});
test('individual original file info cannot contradict the canonical post channel',async()=>{
 const f=source({foreignDetail:true}),signal=new AbortController().signal;await f.client.identify(signal);await assert.rejects(()=>f.client.inspectPrivateAttachments(post,signal),/mattermost_file_metadata_changed/);
 assert.equal(f.calls.some(url=>url.endsWith('/file-one')),false);
});
