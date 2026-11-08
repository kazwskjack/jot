import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {buildServer} from '../../src/server.ts';
import {startMatrixChannelService} from '../../src/channels/matrix-service.ts';

test('Matrix provider enrollment and attachment admission recover original receipt after cursor commit interruption',async t=>{
 const parent=resolve('test-tmp');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'matrix-gateway-'));
 const token='synthetic-matrix-gateway-internal-token',room='!private:example.org',sender='@alice:example.org',bot='@bot:example.org';
 const product=await buildServer({databasePath:join(root,'db.sqlite'),workspaces:['ws'],uploadRoot:join(root,'files'),
  templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),internalChannelToken:token,
  matrixOwnerBindingEnabled:true,csrfToken:'synthetic-csrf-strong-token',allowedOrigins:['https://fixture.invalid'],
  channelAttachmentIntakeV2:true,ordinaryInputRecoveryEnabled:true,conversationGoalClient:{stageVerifiedFile:async()=>assert.fail('no Host upload in ingress test'),recoverInput:async()=>assert.fail('no Host execution in ingress test'),ordinaryRunHistoryReadiness:async()=>({protocol:1,ready:true,execution_authorized:false})}});
 let service; t.after(async()=>{await service?.close();await product.app.close();product.db.close();rmSync(root,{recursive:true,force:true});});
 const enrollment=await product.app.inject({method:'POST',url:'/v1/channel-bindings',headers:{'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':'synthetic-csrf-strong-token','idempotency-key':'matrix-enrollment'},payload:{channel:'matrix'}});
 assert.equal(enrollment.statusCode,201,enrollment.body);const challenge=enrollment.json();
 let phase='bind';const bytes=Buffer.from('Matrix original attachment'),requests=[];
 const matrixFetch=async input=>{const url=new URL(input);
  if(url.pathname.endsWith('/account/whoami'))return Response.json({user_id:bot});
  if(url.pathname.endsWith('/state'))return Response.json([{type:'m.room.join_rules',state_key:'',content:{join_rule:'invite'}},{type:'m.room.history_visibility',state_key:'',content:{history_visibility:'joined'}},...[bot,sender].map(state_key=>({type:'m.room.member',state_key,content:{membership:'join'}}))]);
  if(url.pathname.includes('/download/'))return new Response(bytes,{headers:{'content-type':'text/plain'}});
  if(url.pathname.endsWith('/sync'))return Response.json({next_batch:phase==='bind'?'cursor-bind':'cursor-'+phase,rooms:{join:{[room]:{timeline:{events:[{type:'m.room.message',sender,event_id:'$'+phase+':example.org',content:phase==='bind'?{msgtype:'m.text',body:'/jot-bind '+challenge.code}:{msgtype:'m.file',body:'one.txt',url:'mxc://matrix.example.org/file',info:{mimetype:'text/plain',size:bytes.length}}}]}}}}});
  throw Error('unexpected_matrix_request:'+url.pathname);
 };
 const gatewayFetch=async(input,init)=>{const path=new URL(input).pathname;requests.push([init.method,path]);const payload=typeof init.body==='string'?init.body:Buffer.from(await init.body.arrayBuffer());
  const response=await product.app.inject({method:init.method,url:path,headers:init.headers,payload});return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});};
 const env={GENERAL_AGENT_MATRIX_BASE_URL:'https://matrix.example.org',GENERAL_AGENT_MATRIX_ACCESS_TOKEN:'synthetic-token',GENERAL_AGENT_GATEWAY_INTERNAL_URL:'http://127.0.0.1:18831',GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:token,GENERAL_AGENT_CHANNEL_ATTACHMENTS_ENABLED:'true',GENERAL_AGENT_ORDINARY_INPUT_RECOVERY_ENABLED:'true'};
 const start=()=>startMatrixChannelService(env,{db:product.db,matrixFetch,gatewayFetch});
 service=await start();await service.poll();assert.equal(service.cursor(),'cursor-bind');
 assert.equal(product.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
 phase='file';product.db.exec("CREATE TRIGGER synthetic_cursor_crash BEFORE UPDATE ON ga_matrix_poll_cursors BEGIN SELECT RAISE(ABORT,'synthetic_cursor_commit_interrupted'); END");
 await assert.rejects(()=>service.poll(),/synthetic_cursor_commit_interrupted/);assert.equal(service.cursor(),'cursor-bind');
 const original=product.db.prepare('SELECT run_id,message_id,conversation_id FROM ga_channel_message_events').get();assert.ok(original?.run_id);
 await service.close();product.db.exec('DROP TRIGGER synthetic_cursor_crash');requests.length=0;
 service=await start();const recovered=await service.poll();assert.equal(service.cursor(),'cursor-file');assert.deepEqual(recovered.receipts,[{accepted:true,...original}]);
 assert.deepEqual(requests,[['POST','/internal/v2/channel/attachment-batches/lookup']]);
 assert.equal(product.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 assert.equal(product.db.prepare('SELECT count(*) n FROM ga_artifacts').get().n,1);
 const foreign=await product.app.inject({method:'POST',url:'/internal/v1/channel/messages',headers:{authorization:'Bearer '+token},payload:{channel:'matrix',principal:sender,thread_id:'!foreign:example.org',message_id:'$foreign:example.org',text:'foreign'}});
 assert.notEqual(foreign.statusCode,202);assert.equal(product.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 const declaration={protocol:2,event:{channel:'matrix',principal:sender,thread_id:room,message_id:'$pending:example.org'},text:'one.txt',attachments:[{index:0,provider_file_id:'mxc://matrix.example.org/file',file_name:'one.txt',media_type:'text/plain',size_bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]};
 const auth={authorization:'Bearer '+token},prefix='/internal/v2/channel/attachment-batches';
 const wrongRoom={...declaration,event:{...declaration.event,thread_id:'!foreign:example.org'}};
 assert.notEqual((await product.app.inject({method:'POST',url:prefix,headers:auth,payload:wrongRoom})).statusCode,201);
 assert.equal((await product.app.inject({method:'POST',url:prefix+'/lookup',headers:auth,payload:wrongRoom})).json().state,'unproven');
 const reserved=await product.app.inject({method:'POST',url:prefix,headers:auth,payload:declaration});assert.equal(reserved.statusCode,201,reserved.body);
 phase='pending';requests.length=0;
 for(let i=0;i<2;i++){await assert.rejects(()=>service.poll(),/CHANNEL_ATTACHMENT_ADMISSION_UNKNOWN/);assert.equal(service.cursor(),'cursor-file');}
 assert.deepEqual(requests,[['POST',prefix+'/lookup'],['POST',prefix+'/lookup']]);
 assert.equal(product.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 assert.equal(product.db.prepare('SELECT count(*) n FROM ga_channel_message_events').get().n,1);
 assert.equal(product.db.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get(original.conversation_id).owner_id,'alice');
});
