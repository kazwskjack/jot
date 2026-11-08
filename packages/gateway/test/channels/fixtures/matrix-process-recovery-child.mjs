import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {buildServer} from '../../../src/server.ts';
import {startMatrixChannelService} from '../../../src/channels/matrix-service.ts';

const [root,mode]=process.argv.slice(2);
assert.ok(root&&['crash','recover','pending'].includes(mode));
const token='synthetic-matrix-process-token-32',room='!private:example.org',sender='@alice:example.org',bot='@bot:example.org';
const bytes=Buffer.from('Durable Matrix process recovery'),prefix='/internal/v2/channel/attachment-batches',requests=[];
const product=await buildServer({databasePath:join(root,'db.sqlite'),workspaces:['ws'],uploadRoot:join(root,'files'),
 templateRoot:fileURLToPath(new URL('../../../file-engine/templates/',import.meta.url)),internalChannelToken:token,
 matrixOwnerBindingEnabled:true,csrfToken:'synthetic-process-csrf-token',allowedOrigins:['https://fixture.invalid'],
 channelAttachmentIntakeV2:true,ordinaryInputRecoveryEnabled:true,conversationGoalClient:{stageVerifiedFile:async()=>assert.fail('no native dispatch'),recoverInput:async()=>assert.fail('no native recovery'),ordinaryRunHistoryReadiness:async()=>({protocol:1,ready:true,execution_authorized:false})}});
let phase=mode==='crash'?'bind':mode==='recover'?'file':'pending',challenge,service;
const output=value=>writeSync(1,JSON.stringify({pid:process.pid,...value})+'\n');
const original=()=>product.db.prepare('SELECT run_id,message_id,conversation_id,content_protocol FROM ga_channel_message_events').get();
const counts=()=>['ga_runs','ga_artifacts','ga_channel_message_events'].map(table=>Number(product.db.prepare('SELECT count(*) n FROM '+table).get().n));
try{
 if(mode==='crash'){
  const response=await product.app.inject({method:'POST',url:'/v1/channel-bindings',headers:{'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':'synthetic-process-csrf-token','idempotency-key':'matrix-process-enrollment'},payload:{channel:'matrix'}});
  assert.equal(response.statusCode,201,response.body);challenge=response.json();
 }
 const matrixFetch=async input=>{const url=new URL(input);
  if(url.pathname.endsWith('/account/whoami'))return Response.json({user_id:bot});
  if(url.pathname.endsWith('/state'))return Response.json([{type:'m.room.join_rules',state_key:'',content:{join_rule:'invite'}},{type:'m.room.history_visibility',state_key:'',content:{history_visibility:'joined'}},...[bot,sender].map(state_key=>({type:'m.room.member',state_key,content:{membership:'join'}}))]);
  if(url.pathname.includes('/download/'))return new Response(bytes,{headers:{'content-type':'text/plain'}});
  if(url.pathname.endsWith('/sync'))return Response.json({next_batch:'cursor-'+phase,rooms:{join:{[room]:{timeline:{events:[{type:'m.room.message',sender,event_id:'$'+phase+':example.org',content:phase==='bind'?{msgtype:'m.text',body:'/jot-bind '+challenge.code}:{msgtype:'m.file',body:'one.txt',url:'mxc://matrix.example.org/file',info:{mimetype:'text/plain',size:bytes.length}}}]}}}}});
  throw Error('unexpected_provider_request:'+url.pathname);
 };
 const gatewayFetch=async(input,init)=>{const url=new URL(input).pathname;requests.push([init.method,url]);
  const payload=typeof init.body==='string'?init.body:Buffer.from(await init.body.arrayBuffer());
  const response=await product.app.inject({method:init.method,url,headers:init.headers,payload});
  if(mode==='crash'&&url.endsWith('/admit')&&response.statusCode===202){
   assert.equal(service.cursor(),'cursor-bind');assert.deepEqual(counts(),[1,1,1]);
   output({checkpoint:'admission_committed_before_cursor',original:original(),cursor:service.cursor(),counts:counts()});
   // Deliberately bypass finally/SQLite close: next process must reopen durable data.
   process.exit(77);
  }
  return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
 };
 const env={GENERAL_AGENT_MATRIX_BASE_URL:'https://matrix.example.org',GENERAL_AGENT_MATRIX_ACCESS_TOKEN:'synthetic-token',GENERAL_AGENT_GATEWAY_INTERNAL_URL:'http://127.0.0.1:18831',GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:token,GENERAL_AGENT_CHANNEL_ATTACHMENTS_ENABLED:'true',GENERAL_AGENT_ORDINARY_INPUT_RECOVERY_ENABLED:'true'};
 service=await startMatrixChannelService(env,{db:product.db,matrixFetch,gatewayFetch});
 if(mode==='crash'){await service.poll();phase='file';await service.poll();assert.fail('fault injection not reached');}
 const prior=original();assert.equal(prior.content_protocol,2);assert.deepEqual(counts(),[1,1,1]);
 assert.equal(product.db.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get(prior.conversation_id).owner_id,'alice');
 if(mode==='recover'){
  assert.equal(service.cursor(),'cursor-bind');const batch=await service.poll();
  const {content_protocol,...receipt}=prior;assert.deepEqual(batch.receipts,[{accepted:true,...receipt}]);
  assert.deepEqual(requests,[['POST',prefix+'/lookup']]);assert.equal(service.cursor(),'cursor-file');
  const declaration={protocol:2,event:{channel:'matrix',principal:sender,thread_id:room,message_id:'$pending:example.org'},text:'one.txt',attachments:[{index:0,provider_file_id:'mxc://matrix.example.org/file',file_name:'one.txt',media_type:'text/plain',size_bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]};
  const reserved=await product.app.inject({method:'POST',url:prefix,headers:{authorization:'Bearer '+token},payload:declaration});assert.equal(reserved.statusCode,201,reserved.body);
  output({checkpoint:'recovered_receipt_and_reserved_pending',original:prior,cursor:service.cursor(),requests,stage_key:reserved.json().stage_key});
 }else{
  assert.equal(service.cursor(),'cursor-file');
  const uploads=()=>product.db.prepare('SELECT id,status,received_size,channel_stage_key,channel_request_sha256 FROM ga_uploads ORDER BY id').all();
  const beforeUploads=uploads();
  for(let i=0;i<2;i++)await assert.rejects(()=>service.poll(),/CHANNEL_ATTACHMENT_ADMISSION_UNKNOWN/);
  assert.deepEqual(requests,[['POST',prefix+'/lookup'],['POST',prefix+'/lookup']]);assert.equal(service.cursor(),'cursor-file');
  const foreign=await product.app.inject({method:'POST',url:'/internal/v1/channel/messages',headers:{authorization:'Bearer '+token},payload:{channel:'matrix',principal:sender,thread_id:'!foreign:example.org',message_id:'$foreign:example.org',text:'foreign'}});assert.notEqual(foreign.statusCode,202);
  assert.deepEqual(counts(),[1,1,1]);assert.deepEqual(original(),prior);
  assert.deepEqual(uploads(),beforeUploads);
  output({checkpoint:'pending_after_process_reopen',original:prior,cursor:service.cursor(),requests,counts:counts(),stage_keys:beforeUploads.map(row=>row.channel_stage_key)});
 }
}finally{await service?.close();await product.app.close();product.db.close();}
