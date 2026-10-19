import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHostProfile} from '../create-profile.mjs';
import {CHAT_PRESET_REVISION,CHAT_COMPACTION_PRESET_REVISION} from '../chat-preset.mjs';
import {buildServer} from '../../gateway/src/server.ts';
import {HarnessCoordinator} from '../../gateway/src/harness/coordinator.ts';
import {HarnessWorker} from '../../gateway/src/harness/worker.ts';
import {SessionControllerClient} from '../../gateway/src/harness/session-controller-client.ts';
import {OfficialSessionRunner} from '../../gateway/src/harness/official-session-runner.ts';
import {SessionCommandDispatcher} from '../../gateway/src/harness/command-dispatcher.ts';
import {notifyCommittedChatAnswer} from '../../gateway/src/harness/chat-post-answer.ts';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
const listen=async server=>{await new Promise(done=>server.listen(0,'127.0.0.1',done));return'http://127.0.0.1:'+server.address().port;};
async function chatCase(t,{bounded=false,web=false,maintenance=false,accounting=false,compaction=false,lowPressure=false,cancelCompaction=false,checkpoint=false,contextV2=false,replacedSurface=false,recovery=null,automatic=null}={}){
 const root=await mkdtemp(join(tmpdir(),'jot-chat-native-')),home=join(root,'home'),workspace=join(root,'workspace');await mkdir(workspace);
 const token=randomBytes(32).toString('hex'),adapterToken=randomBytes(32).toString('hex'),modelKey='sk-'+randomBytes(32).toString('hex'),requests=[];
 let service,host,exit,done,execution,output='',succeeded=false,modelFailure;
 let faultInjected=false;
 let firstPrepareBlocked=false,releasePrepare;const prepareGate=new Promise(resolve=>releasePrepare=resolve);
 let releaseSupplement;const supplementGate=new Promise(resolve=>releaseSupplement=resolve);
 let expectedContext,expectedQuestion,maintenanceIntent,maintenanceScope;
 const policy={protocol:1,mode:'chat',model:{provider:'deepseek-official',model:'deepseek-flash'},thinking:'disabled',preset_id:'jot-chat',preset_revision:compaction?CHAT_COMPACTION_PRESET_REVISION:CHAT_PRESET_REVISION,context_revision:checkpoint||contextV2?'checkpoint-text-v2':'fixture-context-v1'};
 const model=createServer(async(req,res)=>{try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(req.headers['x-api-key'],modelKey);assert.match(req.url,/\/messages$/);assert.equal(input.thinking.type,'disabled');assert.equal(input.output_config,undefined);
  const compactionRequest=JSON.stringify(input.messages).includes('JOT-CHAT-COMPACTION-CHECKPOINT');
  const accountingRequest=JSON.stringify(input.messages).includes('SYNTHETIC-COMPACTION-ACCOUNTING-PROBE');
  if(accountingRequest){assert.equal(accounting,true);assert.equal((input.tools??[]).length,0);}else{assert.deepEqual(input.tools.map(tool=>tool.name).sort(),['web_fetch','web_search']);assert.match(input.system,/useful solutions/);}requests.push(input);
  if(web&&requests.length===2)await supplementGate;
  if(bounded&&!accountingRequest&&!compactionRequest){const text=input.messages.flatMap(message=>typeof message.content==='string'?[message.content]:(message.content??[]).filter(block=>block.type==='text').map(block=>block.text)).join('\n');assert.ok(text.includes(expectedContext.model_text));assert.ok(text.includes(expectedQuestion));assert.ok(!text.includes('RAW-REASONING-NEVER-SEND'));assert.ok(!text.includes('data:image/png;base64,'));assert.ok(!text.includes('HISTORY-00'));assert.ok(expectedContext.model_text.length<=14000);}
  const planned=web?[
   [['search-a','web_search',{queries:['synthetic one','synthetic two']}],['search-b','web_search',{queries:['synthetic three']}]],
   [['fetch-a','web_fetch',{url:'https://example.com/page'}],['fetch-b','web_fetch',{url:'https://example.com/failed'}],['fetch-duplicate','web_fetch',{url:'https://EXAMPLE.com:443/page#duplicate'}]],
   [['search-again','web_search',{queries:['must never dispatch']}],['fetch-again','web_fetch',{url:'https://example.com/failed'}]],
  ][(requests.length-1)%4]:undefined;
  res.writeHead(200,{'content-type':'text/event-stream'});
  const events=[{type:'message_start',message:{id:'synthetic-chat-'+requests.length,type:'message',role:'assistant',content:[],model:'deepseek-flash',usage:{input_tokens:automatic?(automatic!=='low'&&requests.length===1?950000:10):compaction&&!lowPressure&&!compactionRequest?950000:10,output_tokens:0}}}];
  if(planned)for(const [index,[id,name,args]] of planned.entries())events.push(
   {type:'content_block_start',index,content_block:{type:'tool_use',id,name,input:{}}},
   {type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify(args)}},
   {type:'content_block_stop',index});
  else events.push(
   {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
   {type:'content_block_delta',index:0,delta:{type:'text_delta',text:compactionRequest?'SYNTHETIC-CHECKPOINT-ALPHA':'CHAT-NATIVE-OK'}},
   {type:'content_block_stop',index:0});
  events.push({type:'message_delta',delta:{stop_reason:planned?'tool_use':'end_turn'},usage:{output_tokens:1}},{type:'message_stop'});
  if((cancelCompaction||recovery==='partial'||automatic==='cancel')&&compactionRequest){for(const event of events.slice(0,-2))res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');await new Promise(resolve=>res.once('close',resolve));return;}
  for(const event of events)res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();
 }catch(error){modelFailure=error;res.writeHead(500);res.end('synthetic_request_rejected');}});
 const modelUrl=await listen(model);
 try{
  service=await buildServer({databasePath:join(root,'gateway.db'),workspaces:['ws'],internalChannelToken:token,uploadRoot:join(root,'uploads'),workbenchRoot:join(root,'workspaces'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates/',import.meta.url)),chatModeEnabled:true,
   // Explicit fixture readiness; no production readiness claim is made.
   conversationModeClient:{conversationModeReadiness:async()=>({protocol:1,ready:true,policy})}});
  const matchesPublish=request=>recovery&&!faultInjected&&request.url==='/internal/v1/workbench/chat-compaction-checkpoint'&&request.body?.action==='publish';
  const killOwnedHost=async()=>{assert.ok(host&&!exit);faultInjected=true;assert.equal(host.kill('SIGKILL'),true);await done;assert.ok(exit);};
  if(recovery==='before'||recovery==='new-input')service.app.addHook('preHandler',async(request,reply)=>{if(matchesPublish(request)){await killOwnedHost();return reply.code(503).send({error:'synthetic_exit_before_publish'});}});
  if(recovery==='after')service.app.addHook('onSend',async(request,_reply,payload)=>{if(matchesPublish(request))await killOwnedHost();return payload;});
  if(automatic==='early')service.app.addHook('preHandler',async request=>{if(!firstPrepareBlocked&&request.url==='/internal/v1/workbench/chat-compaction-source'&&request.body?.action==='prepare'){firstPrepareBlocked=true;await prepareGate;}});
  await service.app.listen({host:'127.0.0.1',port:0});const gateway='http://127.0.0.1:'+service.app.server.address().port;
  const prepared=await createHostProfile({home,adapter:fileURLToPath(new URL('./chat-input-adapter.mjs',import.meta.url))});
  const probe=createServer();await listen(probe);const port=probe.address().port;await new Promise(done=>probe.close(done));
  const patchPath=join(prepared.directory,'cordis.patch.yml');let patch=await readFile(patchPath,'utf8');
  const parsed=JSON.parse(patch.replace('!!js process.cwd()','null')),adapter=parsed.find(row=>row.insert).insert.find(row=>row.id==='jot-session-adapter');
  adapter.config={...adapter.config,port,workbenchOrigin:gateway,ordinaryExecutionPolicy:policy,...(bounded||web?{ordinaryChatContext:true}:{}),...(web?{ordinaryChatWeb:true}:{}),chatFixture:{admissions:join(root,'admissions'),receipt:join(root,'composition.json'),...(recovery||automatic?{recovery:true}:{}),...(automatic?{automaticReceipt:join(root,'automatic-receipts.json')}:{}),...(maintenance?{maintenance:true}:{}),...(compaction?{compaction:{requestPath:join(root,'compaction-request.json'),receiptPath:join(root,'compaction-receipt.json')}}:{}),...(accounting?{accounting:{request:join(root,'accounting-request.json'),receipt:join(root,'accounting-receipt.json')}}:{}),...(bounded?{history:join(root,'context-history.json')}:{}),...(web?{webReceipt:join(root,'web-receipt.json')}:{})}};
  adapter.inject.push('jotChatPresetReady');
  parsed.find(row=>row.insert).insert.unshift({id:'preset-jot-chat',...(compaction?{config:{maintenance:true},inject:['jotChatCompactionRuntime']}:{}),name:pathToFileURL(fileURLToPath(new URL('../chat-preset.mjs',import.meta.url))).href});
  if(compaction)parsed.find(row=>row.insert).insert.unshift({id:'chat-maintenance-runtime',name:new URL('../chat-maintenance-runtime.mjs',import.meta.url).href});
  parsed.push({id:'llm-deepseek',config:{baseURL:modelUrl,apiKeyEnv:'DEEPSEEK_API_KEY',reasoningEffort:'high'}});
  if(web)parsed.push({id:'web',config:{searchProvider:'jot-web-fixture',fetchProvider:'jot-web-fixture'}});
  patch=JSON.stringify(parsed,null,2).replace('"workspaceRoot": null','"workspaceRoot": !!js process.cwd()');await writeFile(patchPath,patch);
  const env={};for(const key of ['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATHEXT'])if(process.env[key])env[key]=process.env[key];
  const adapterUrl='http://127.0.0.1:'+port;
  const bootHost=async()=>{exit=undefined;
  host=spawn(process.execPath,[join(runtime,'dsh/lib/bin.js'),'--profile','jot','--host','127.0.0.1','--port','0','--no-open'],{cwd:workspace,env:{...env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',JOT_SESSION_ADAPTER_TOKEN:adapterToken,GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:token,DEEPSEEK_API_KEY:modelKey,...(web?{DSH_WEB_SEARCH_PROVIDER:'jot-web-fixture',DSH_WEB_FETCH_PROVIDER:'jot-web-fixture'}:{})},stdio:['ignore','pipe','pipe'],windowsHide:true});
  done=new Promise(resolve=>host.once('exit',(code,signal)=>{exit={code,signal};resolve();}));for(const stream of [host.stdout,host.stderr])stream.on('data',data=>{output+=data;});
  const deadline=Date.now()+30000;let ready=false;
  while(Date.now()<deadline&&!exit){try{const response=await fetch(adapterUrl+'/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(500)});if(response.status===401){ready=true;break;}}catch{}await new Promise(done=>setTimeout(done,100));}
  assert.equal(ready,true,'official Chat Host readiness deadline');
  };await bootHost();
  const created=await service.app.inject({method:'POST',url:'/v1/conversations',headers:{'x-user-id':'chat-owner'},payload:{workspace_id:'ws',mode:'chat',model:{provider:'deepseek-official',model:'deepseek-flash',reasoning_effort:'high'}}});assert.equal(created.statusCode,201,created.body);
  const conversation=created.json();
  if(bounded)for(let i=0;i<40;i++){const at=new Date(Date.UTC(2020,0,1,0,i)).toISOString();service.db.prepare('INSERT INTO ga_messages(id,conversation_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('context-history-'+String(i).padStart(2,'0'),conversation.conversation_id,i%2?'assistant':'user','complete',JSON.stringify({blocks:[{kind:'reasoning',text:'RAW-REASONING-NEVER-SEND'},{kind:'text',text:'HISTORY-'+String(i).padStart(2,'0')+' '+(i===39?'![image](data:image/png;base64,QUJDREVGRw==) ':'')+'x'.repeat(3000)}],attachments:[]}),at,at);}
  expectedQuestion='Give the synthetic fixture answer.';
  const accepted=await service.app.inject({method:'POST',url:`/v1/conversations/${conversation.conversation_id}/messages`,headers:{'x-user-id':'chat-owner'},payload:{client_message_id:'chat-input',content:[{type:'text',text:expectedQuestion}]}});assert.equal(accepted.statusCode,202,accepted.body);
  if(bounded){expectedContext=JSON.parse(service.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(accepted.json().run_id).chat_context_json);assert.ok(expectedContext.messages.length<=12);service.db.prepare("UPDATE ga_messages SET content_json='[]',updated_at='later-version' WHERE id='context-history-39'").run();}
  const failures=[];const client=new SessionControllerClient(adapterUrl,adapterToken,async(url,options)=>{const response=await fetch(url,options);if(!response.ok)failures.push({path:new URL(url).pathname,status:response.status,body:await response.clone().json()});return response;}),runner=new OfficialSessionRunner(client,{cwd:workspace,agentPreset:'jot-general',chatAgentPreset:'jot-chat'}),coordinator=new HarnessCoordinator(service.db,service.runs,service.events);
  const execute=runner.run.bind(runner);let runnerFailure;runner.run=async input=>{try{return await execute(input);}catch(error){runnerFailure={message:error.message,reason:error.reasonCode};throw error;}};
  const worker=new HarnessWorker(service.db,coordinator,runner,{workerId:'chat-fixture',leaseMs:60000,ordinaryInputRecoveryEnabled:true,ordinarySteeringEnabled:true,...(automatic?{chatPostAnswer:runId=>notifyCommittedChatAnswer(service.db,runId,client,AbortSignal.timeout(10000))}:{})});
  execution=worker.processNext();execution.catch(()=>{});
  if(web){
   const deadline=Date.now()+20000;while(requests.length<2&&Date.now()<deadline&&!exit)await new Promise(done=>setTimeout(done,30));assert.equal(requests.length,2,'first Web group has finished before steering');
   const original=accepted.json().run_id,command=service.commands.steer(original,'chat-owner',{text:'Keep using the existing evidence after this synthetic supplement.',client_message_id:'web-supplement',expected_run_version:service.runs.get(original,'chat-owner').version},'web-supplement');
   const dispatcher=new SessionCommandDispatcher(service.db,service.events,client,id=>worker.isReady(id),undefined,{currentExecutionFor:id=>worker.readyExecutionFor(id)});assert.equal(await dispatcher.processNext(),true);assert.equal(command.run_id,original);releaseSupplement();
  }
  await execution;if(modelFailure)throw modelFailure;
  const run=service.runs.get(accepted.json().run_id,'chat-owner');assert.equal(run.status,'succeeded',JSON.stringify({status:run.status,error:run.error_code,requests:requests.length,failures,runnerFailure}));
  if(automatic){
   const automaticPath=join(root,'automatic-receipts.json'),records=async()=>{try{return JSON.parse(await readFile(automaticPath,'utf8'));}catch{return[];}},wait=async(runId,status)=>{const until=Date.now()+20000;while(Date.now()<until){if(modelFailure)throw modelFailure;const found=(await records()).find(row=>row.run_id===runId&&row.status===status);if(found)return found;await new Promise(resolve=>setTimeout(resolve,40));}assert.fail('automatic completion missing '+status+' '+JSON.stringify(await records()));};
   assert.equal(service.db.prepare("SELECT count(*) n FROM ga_messages WHERE run_id=? AND role='assistant'").get(run.run_id).n,1);
   if(automatic==='low'){const result=await wait(run.run_id,'skipped');assert.equal(result.reason,'LOW_PRESSURE');assert.equal(requests.length,1);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_chat_compaction_attempts').get().n,0);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_chat_compaction_checkpoints').get().n,0);}
   else{
    if(automatic==='high'){await wait(run.run_id,'compacted');assert.equal(requests.length,2);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_chat_compaction_checkpoints').get().n,1);assert.equal(await notifyCommittedChatAnswer(service.db,run.run_id,client),'accepted');await wait(run.run_id,'already_published');assert.equal(requests.length,2);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_chat_compaction_attempts').get().n,1);}
    else if(automatic==='early'){const until=Date.now()+20000;while(!firstPrepareBlocked&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,30));assert.equal(firstPrepareBlocked,true);assert.equal(requests.length,1,'notification is accepted but original source preparation has not completed');}
    else{const until=Date.now()+20000;while(requests.length<2&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,30));assert.equal(requests.length,2,'automatic summary stream is active after the committed answer');}
    expectedQuestion='A new original question after automatic maintenance.';const next=await service.app.inject({method:'POST',url:`/v1/conversations/${conversation.conversation_id}/messages`,headers:{'x-user-id':'chat-owner'},payload:{client_message_id:'automatic-next-input',content:[{type:'text',text:expectedQuestion}]}});assert.equal(next.statusCode,202,next.body);expectedContext=JSON.parse(service.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(next.json().run_id).chat_context_json);
    if(automatic==='high')assert.equal(expectedContext.checkpoint.summary_text,'SYNTHETIC-CHECKPOINT-ALPHA');else assert.equal(expectedContext.checkpoint,null);
    if(automatic==='early')releasePrepare();await worker.processNext();if(modelFailure)throw modelFailure;assert.equal(service.runs.get(next.json().run_id,'chat-owner').status,'succeeded');const skipped=await wait(next.json().run_id,'skipped');assert.equal(skipped.reason,'LOW_PRESSURE');assert.equal(requests.length,automatic==='early'?2:3);assert.equal(service.db.prepare("SELECT count(*) n FROM ga_messages WHERE conversation_id=? AND role='assistant' AND run_id IS NOT NULL").get(conversation.conversation_id).n,2);
    const attempt=service.db.prepare('SELECT * FROM ga_chat_compaction_attempts').get();if(automatic==='high'){assert.equal(attempt.state,'settled');assert.equal(attempt.actual_tokens,'11');assert.equal(JSON.stringify(requests[2].messages).split('SYNTHETIC-CHECKPOINT-ALPHA').length-1,1);}else{await wait(run.run_id,'unconfirmed');if(automatic==='early')assert.equal(attempt,undefined);else{assert.equal(attempt.state,'usage_unknown');assert.equal(attempt.actual_tokens,null);}assert.equal(service.db.prepare('SELECT count(*) n FROM ga_chat_compaction_checkpoints').get().n,0);}
   }
   assert.equal(await readFile(join(root,'compaction-request.json'),'utf8').then(()=>true,()=>false),false,'automatic acceptance never uses the manual request file');const foreground=service.db.prepare("SELECT payload_json FROM ga_events WHERE conversation_id=? AND type IN ('assistant.delta','assistant.settled','activity.upsert','message.created')").all(conversation.conversation_id);assert.ok(foreground.every(row=>!row.payload_json.includes('SYNTHETIC-CHECKPOINT-ALPHA')),'background summary never enters the visible answer or activity stream');t.diagnostic(JSON.stringify({officialLauncher:true,automaticPostAnswer:automatic,modelRequests:requests.length,outcomes:(await records()).map(row=>({status:row.status,reason:row.reason})),production:false}));succeeded=true;return;
  }
  assert.equal(requests.length,web?4:1);assert.equal(await worker.processNext(),null);
  const answers=service.db.prepare("SELECT content_json FROM ga_messages WHERE role='assistant' AND run_id=?").all(run.run_id);assert.equal(answers.length,1);assert.match(answers[0].content_json,/CHAT-NATIVE-OK/);
  assert.deepEqual(JSON.parse(await readFile(join(root,'composition.json'),'utf8')),{preset:'jot-chat',tools:['web_fetch','web_search'],mounted:true});
  const prepareMaintenance=async runId=>{
   const row=service.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(runId),scope={owner_id:'chat-owner',conversation_id:conversation.conversation_id,run_id:runId,session_ref:row.native_session_ref,expected_run_version:row.version};
   const before=service.db.prepare('SELECT total_changes() n').get().n,inspected=await service.app.inject({method:'POST',url:'/internal/v1/workbench/chat-compaction-source',headers:{authorization:'Bearer '+token},payload:{action:'inspect',...scope}});assert.equal(inspected.statusCode,200,inspected.body);assert.equal(service.db.prepare('SELECT total_changes() n').get().n,before);
   const request=()=>service.app.inject({method:'POST',url:'/internal/v1/workbench/chat-compaction-source',headers:{authorization:'Bearer '+token},payload:{action:'prepare',...scope}}),prepared=await request();assert.equal(prepared.statusCode,200,prepared.body);const intent=prepared.json().intent;assert.equal(intent.execution_authorized,false);assert.equal(intent.source.execution_authorized,false);assert.equal(intent.source.answer_message_id,service.db.prepare("SELECT id FROM ga_messages WHERE run_id=? AND role='assistant'").get(runId).id);assert.deepEqual((await request()).json().intent,intent);
   const {session_ref,...history}=scope,changes=service.db.prepare('SELECT total_changes() n').get().n,observed=await fetch(adapterUrl+'/v1/sessions/'+session_ref+'/chat-maintenance-observation',{method:'POST',headers:{authorization:'Bearer '+adapterToken,'content-type':'application/json'},body:JSON.stringify({history,source_sha256:intent.source_sha256})}),value=await observed.json();assert.equal(observed.status,200,JSON.stringify(value));assert.equal(value.kind,'chat_maintenance_observation');assert.equal(value.execution_authorized,false);assert.equal(value.native.source_sha256,intent.source_sha256);assert.equal(value.native.execution_authorized,false);assert.equal(value.pressure.reason,compaction&&!lowPressure?null:'LOW_PRESSURE');assert.equal(value.pressure.execution_authorized,false);assert.equal(value.pressure.threshold_tokens>value.pressure.total_tokens,!compaction||lowPressure);assert.equal(service.db.prepare('SELECT total_changes() n').get().n,changes);return{scope,intent};
  };
  if(maintenance){const prepared=await prepareMaintenance(run.run_id);maintenanceIntent=prepared.intent;maintenanceScope=prepared.scope;assert.equal(requests.length,1);}
  if(web){
   const receipt=JSON.parse(await readFile(join(root,'web-receipt.json'),'utf8'));assert.deepEqual(receipt.search.sort(),['synthetic one','synthetic three','synthetic two']);assert.deepEqual(receipt.fetch.sort(),['https://example.com/failed','https://example.com/page']);assert.ok(receipt.peak>=2);assert.equal(receipt.active,0);
   assert.equal(service.db.prepare('SELECT count(*) n FROM ga_chat_web_groups').get().n,2);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_chat_web_calls').get().n,4);
   const results=requests[3].messages.flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(block=>block.type==='tool_result');for(const id of ['fetch-duplicate','search-again','fetch-again'])assert.equal(results.find(r=>r.tool_use_id===id)?.is_error,true,'must be a native error result: '+id);
   assert.ok(JSON.stringify(requests[2].messages).includes('existing evidence after this synthetic supplement'));for(const id of ['search-again','fetch-again'])assert.ok(JSON.stringify(results.find(r=>r.tool_use_id===id)).includes('CHAT_WEB_ALLOWANCE_CONSUMED'));
   const next=await service.app.inject({method:'POST',url:`/v1/conversations/${conversation.conversation_id}/messages`,headers:{'x-user-id':'chat-owner'},payload:{client_message_id:'web-input-two',content:[{type:'text',text:'A new synthetic question receives its own Web allowance.'}]}});assert.equal(next.statusCode,202,next.body);
   await worker.processNext();if(modelFailure)throw modelFailure;assert.equal(service.runs.get(next.json().run_id,'chat-owner').status,'succeeded');assert.equal(requests.length,8);
   const repeated=JSON.parse(await readFile(join(root,'web-receipt.json'),'utf8'));assert.equal(repeated.search.length,6);assert.equal(repeated.fetch.length,4);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_chat_web_groups').get().n,4);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_chat_web_calls').get().n,8);
   assert.equal(service.db.prepare("SELECT count(*) n FROM ga_messages WHERE run_id=? AND role='assistant'").get(next.json().run_id).n,1);
  }
  if(bounded){
   const firstQuestion=expectedQuestion;expectedQuestion='Answer this second synthetic question.';
   const next=await service.app.inject({method:'POST',url:`/v1/conversations/${conversation.conversation_id}/messages`,headers:{'x-user-id':'chat-owner'},payload:{client_message_id:'chat-input-two',content:[{type:'text',text:expectedQuestion}]}});assert.equal(next.statusCode,202,next.body);
   if(maintenance){const rejected=await service.app.inject({method:'POST',url:'/internal/v1/workbench/chat-compaction-source',headers:{authorization:'Bearer '+token},payload:{action:'read',...maintenanceScope,intent_id:maintenanceIntent.intent_id}});assert.equal(rejected.statusCode,409);const {session_ref,...history}=maintenanceScope,stale=await fetch(adapterUrl+'/v1/sessions/'+session_ref+'/chat-maintenance-observation',{method:'POST',headers:{authorization:'Bearer '+adapterToken,'content-type':'application/json'},body:JSON.stringify({history,source_sha256:maintenanceIntent.source_sha256})});assert.equal(stale.status,409);}
   expectedContext=JSON.parse(service.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(next.json().run_id).chat_context_json);assert.ok(expectedContext.model_text.includes('CHAT-NATIVE-OK'));
   await worker.processNext();if(modelFailure)throw modelFailure;assert.equal(service.runs.get(next.json().run_id,'chat-owner').status,'succeeded');assert.equal(requests.length,2);
   assert.equal(requests[1].system,requests[0].system);assert.deepEqual(requests[1].tools,requests[0].tools);
   const history=JSON.parse(await readFile(join(root,'context-history.json'),'utf8'));assert.equal(history.contexts.length,2);assert.deepEqual(history.user_rpcs,[accepted.json().run_id,next.json().run_id]);assert.ok(history.replace_generation>=1);
   const sent=JSON.stringify(requests[1].messages);assert.equal(sent.split(firstQuestion).length-1,1);assert.equal(service.db.prepare("SELECT count(*) n FROM ga_messages WHERE conversation_id=? AND role='user'").get(conversation.conversation_id).n,22);
   assert.equal(service.db.prepare("SELECT count(*) n FROM ga_messages WHERE conversation_id=? AND role='assistant' AND run_id IS NOT NULL").get(conversation.conversation_id).n,2);
   if(maintenance){const prepared=await prepareMaintenance(next.json().run_id);assert.notEqual(prepared.intent.intent_id,maintenanceIntent.intent_id);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_chat_compaction_intents').get().n,2);assert.equal(requests.length,2);maintenanceIntent=prepared.intent;maintenanceScope=prepared.scope;}
  }
  if(accounting){await writeFile(join(root,'accounting-request.json'),JSON.stringify({scope:maintenanceScope,intent_id:maintenanceIntent.intent_id}));const deadline=Date.now()+20000;let receipt;while(Date.now()<deadline&&!receipt){try{receipt=JSON.parse(await readFile(join(root,'accounting-receipt.json'),'utf8'));}catch{await new Promise(done=>setTimeout(done,40));}}assert.ok(receipt,'explicit SDK accounting probe receipt');assert.equal(receipt.finished,true,JSON.stringify(receipt));assert.equal(receipt.sessionUnchanged,true);assert.equal(receipt.checkpointPublished,false);assert.equal(requests.length,3);const row=service.db.prepare('SELECT * FROM ga_chat_compaction_attempts').get();assert.equal(row.state,'settled');assert.equal(row.actual_tokens,'11');assert.equal(row.intent_id,maintenanceIntent.intent_id);assert.equal(service.db.prepare("SELECT count(*) n FROM ga_messages WHERE conversation_id=? AND role='assistant' AND run_id IS NOT NULL").get(conversation.conversation_id).n,2);}
  if(compaction){
   await writeFile(join(root,'compaction-request.json'),JSON.stringify({scope:maintenanceScope,intent_id:maintenanceIntent.intent_id,source_sha256:maintenanceIntent.source_sha256,...(replacedSurface?{replaceContext:true}:{})}));
   if(recovery){
    if(recovery==='partial'){const ready=Date.now()+20000;while(requests.length<3&&Date.now()<ready)await new Promise(resolve=>setTimeout(resolve,30));assert.equal(requests.length,3,'partial auxiliary stream began');await killOwnedHost();}
    const deadline=Date.now()+20000;while(!exit&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,30));assert.ok(exit,'actual owned Host exit at checkpoint publication');assert.equal(faultInjected,true);await done;
    const oldAttempt=service.db.prepare('SELECT * FROM ga_chat_compaction_attempts').get(),existing=service.db.prepare('SELECT checkpoint_id FROM ga_chat_compaction_checkpoints').get();if(recovery==='partial'){assert.ok(['dispatched','usage_unknown'].includes(oldAttempt.state));assert.equal(oldAttempt.actual_tokens,null);}else{assert.equal(oldAttempt.state,'settled');assert.equal(oldAttempt.actual_tokens,'11');}assert.equal(!!existing,recovery==='after');assert.equal(requests.length,3);
    let newer;if(recovery==='new-input'){newer=await service.app.inject({method:'POST',url:`/v1/conversations/${conversation.conversation_id}/messages`,headers:{'x-user-id':'chat-owner'},payload:{client_message_id:'recovery-newer-input',content:[{type:'text',text:'This newer synthetic input invalidates old publication.'}]}});assert.equal(newer.statusCode,202,newer.body);}
    await rm(join(root,'compaction-request.json'),{force:true});await bootHost();
    const {session_ref,...history}=maintenanceScope,body={history,intent_id:maintenanceIntent.intent_id},recover=()=>fetch(adapterUrl+'/v1/sessions/'+session_ref+'/chat-checkpoint-recovery',{method:'POST',headers:{authorization:'Bearer '+adapterToken,'content-type':'application/json'},body:JSON.stringify(body)});
    const response=await recover(),value=await response.json();
    if(recovery==='partial'||recovery==='new-input'){assert.equal(response.status,409,JSON.stringify(value));assert.equal(requests.length,3);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_chat_compaction_checkpoints').get().n,0);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_chat_compaction_attempts').get().n,1);assert.deepEqual(service.db.prepare('SELECT * FROM ga_chat_compaction_attempts').get(),oldAttempt);assert.equal(service.db.prepare("SELECT count(*) n FROM ga_messages WHERE conversation_id=? AND role='assistant' AND run_id IS NOT NULL").get(conversation.conversation_id).n,2);if(newer)assert.equal(service.runs.get(newer.json().run_id,'chat-owner').status,'queued');t.diagnostic(JSON.stringify({officialLauncher:true,recoveryRefused:recovery,modelRequests:3,replyCount:2,checkpointCount:0,production:false}));succeeded=true;return;}
    assert.equal(response.status,200,JSON.stringify(value));assert.equal(value.status,recovery==='after'?'already_published':'recovered');assert.equal(value.execution_authorized,false);if(existing)assert.equal(value.checkpoint.checkpoint_id,existing.checkpoint_id);
    const duplicate=await recover(),replayed=await duplicate.json();assert.equal(duplicate.status,200,JSON.stringify(replayed));assert.equal(replayed.status,'already_published');assert.deepEqual(replayed.checkpoint,value.checkpoint);assert.equal(requests.length,3);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_chat_compaction_checkpoints').get().n,1);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_chat_compaction_attempts').get().n,1);assert.deepEqual(service.db.prepare('SELECT * FROM ga_chat_compaction_attempts').get(),oldAttempt);
   }
   if(cancelCompaction){
    const ready=Date.now()+20000;while(requests.length<3&&Date.now()<ready)await new Promise(done=>setTimeout(done,30));assert.equal(requests.length,3,'actual auxiliary HTTP stream must be active before new input');
    expectedQuestion='Continue with this new synthetic question after cancelling maintenance.';
    const next=await service.app.inject({method:'POST',url:`/v1/conversations/${conversation.conversation_id}/messages`,headers:{'x-user-id':'chat-owner'},payload:{client_message_id:'chat-cancel-maintenance',content:[{type:'text',text:expectedQuestion}]}});assert.equal(next.statusCode,202,next.body);
    expectedContext=JSON.parse(service.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(next.json().run_id).chat_context_json);
    execution=worker.processNext();await execution;if(modelFailure)throw modelFailure;assert.equal(service.runs.get(next.json().run_id,'chat-owner').status,'succeeded');assert.equal(requests.length,4);
   }
   if(!recovery){const deadline=Date.now()+20000;let receipt;while(Date.now()<deadline&&!receipt){try{receipt=JSON.parse(await readFile(join(root,'compaction-receipt.json'),'utf8'));}catch{await new Promise(done=>setTimeout(done,40));}}
   assert.ok(receipt,'official engine receipt');if(!cancelCompaction){assert.equal(receipt.error,undefined,JSON.stringify(receipt));assert.equal(receipt.status,lowPressure?'skipped':'compacted',JSON.stringify(receipt));assert.equal(requests.length,lowPressure?2:3);}
   if(cancelCompaction){assert.equal(service.db.prepare('SELECT count(*) n FROM ga_chat_compaction_checkpoints').get().n,0);assert.match(receipt.error,/new_input|abort/i);assert.deepEqual(receipt.events.map(e=>e.type),['compaction/start','compaction/end']);assert.ok(receipt.events[1].data.error);assert.equal(receipt.durable,true);const row=service.db.prepare('SELECT * FROM ga_chat_compaction_attempts').get();assert.equal(row.state,'usage_unknown');assert.equal(row.actual_tokens,null);}
   else if(lowPressure){assert.deepEqual(receipt.events,[]);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_chat_compaction_attempts').get().n,0);}
   else{assert.deepEqual(receipt.events.map(e=>e.type),['compaction/start','compaction/summary','user/message','compaction/end']);assert.equal(receipt.events[0].data.turn,null);assert.match(JSON.stringify(receipt.events[1].data.summary),/SYNTHETIC-CHECKPOINT-ALPHA/);assert.equal(receipt.events[2].seq,receipt.events[1].seq+1);assert.equal(receipt.durable,true);assert.equal(receipt.replayValid,true);assert.equal(receipt.checkpointPublished,checkpoint);const row=service.db.prepare('SELECT * FROM ga_chat_compaction_attempts').get();assert.equal(row.state,'settled');assert.equal(row.actual_tokens,'11');assert.equal(requests[2].system,requests[1].system);assert.deepEqual(requests[2].tools,requests[1].tools);}
   }
   assert.equal(service.db.prepare("SELECT count(*) n FROM ga_messages WHERE conversation_id=? AND role='assistant' AND run_id IS NOT NULL").get(conversation.conversation_id).n,cancelCompaction?3:2);
  }
  if(checkpoint){
   assert.equal(service.db.prepare('SELECT count(*) n FROM ga_chat_compaction_checkpoints').get().n,1);
   if(replacedSurface){const {witness:w}=JSON.parse(service.db.prepare('SELECT checkpoint_json FROM ga_chat_compaction_checkpoints').get().checkpoint_json);assert.equal(w.protocol,2);assert.ok(w.shadowed_start>w.shadowed_end);assert.ok(w.shadowed_start_position<w.shadowed_end_position);assert.equal(w.answer_covered,false);}
   expectedQuestion='Use the verified summary for this third synthetic question.';
   const next=await service.app.inject({method:'POST',url:`/v1/conversations/${conversation.conversation_id}/messages`,headers:{'x-user-id':'chat-owner'},payload:{client_message_id:'checkpoint-third-question',content:[{type:'text',text:expectedQuestion}]}});assert.equal(next.statusCode,202,next.body);
   expectedContext=JSON.parse(service.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(next.json().run_id).chat_context_json);assert.equal(expectedContext.algorithm,'checkpoint-text-v2');assert.equal(expectedContext.checkpoint.summary_text,'SYNTHETIC-CHECKPOINT-ALPHA');
   await worker.processNext();if(modelFailure)throw modelFailure;assert.equal(service.runs.get(next.json().run_id,'chat-owner').status,'succeeded');assert.equal(requests.length,4);const text=JSON.stringify(requests[3].messages);assert.equal(text.split('SYNTHETIC-CHECKPOINT-ALPHA').length-1,1);assert.equal(text.split('CHAT-NATIVE-OK').length-1,1,'official retained final answer is carried exactly once');assert.equal(requests[3].system,requests[1].system);assert.deepEqual(requests[3].tools,requests[1].tools);
   if(recovery){const {session_ref,...history}=maintenanceScope,response=await fetch(adapterUrl+'/v1/sessions/'+session_ref+'/chat-checkpoint-recovery',{method:'POST',headers:{authorization:'Bearer '+adapterToken,'content-type':'application/json'},body:JSON.stringify({history,intent_id:maintenanceIntent.intent_id})}),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));assert.equal(value.status,'already_published');assert.equal(value.checkpoint.checkpoint_id,expectedContext.checkpoint.checkpoint_id);assert.equal(requests.length,4);}
   assert.equal(service.db.prepare("SELECT count(*) n FROM ga_messages WHERE conversation_id=? AND role='assistant' AND run_id IS NOT NULL").get(conversation.conversation_id).n,3);
   const parent=expectedContext.checkpoint.checkpoint_id,prepared=await prepareMaintenance(next.json().run_id);await rm(join(root,'compaction-receipt.json'),{force:true});await writeFile(join(root,'compaction-request.json'),JSON.stringify({scope:prepared.scope,intent_id:prepared.intent.intent_id,source_sha256:prepared.intent.source_sha256}));
   const until=Date.now()+20000;let second;while(Date.now()<until&&!second){try{second=JSON.parse(await readFile(join(root,'compaction-receipt.json'),'utf8'));}catch{await new Promise(done=>setTimeout(done,40));}}assert.ok(second);assert.equal(second.error,undefined,JSON.stringify(second));assert.equal(second.checkpointPublished,true);assert.equal(requests.length,5);
   const saved=service.db.prepare('SELECT checkpoint_json FROM ga_chat_compaction_checkpoints ORDER BY rowid DESC').get(),value=JSON.parse(saved.checkpoint_json);assert.equal(value.parent_checkpoint_id,parent);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_chat_compaction_checkpoints').get().n,2);
   expectedQuestion='Use the checkpoint chain for the fourth synthetic question.';const fourth=await service.app.inject({method:'POST',url:`/v1/conversations/${conversation.conversation_id}/messages`,headers:{'x-user-id':'chat-owner'},payload:{client_message_id:'checkpoint-fourth-question',content:[{type:'text',text:expectedQuestion}]}});assert.equal(fourth.statusCode,202,fourth.body);expectedContext=JSON.parse(service.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(fourth.json().run_id).chat_context_json);assert.equal(expectedContext.checkpoint.checkpoint_id,value.checkpoint_id);
   await worker.processNext();if(modelFailure)throw modelFailure;assert.equal(service.runs.get(fourth.json().run_id,'chat-owner').status,'succeeded');assert.equal(requests.length,6);assert.equal(JSON.stringify(requests[5].messages).split('SYNTHETIC-CHECKPOINT-ALPHA').length-1,1);assert.equal(JSON.stringify(requests[5].messages).split('CHAT-NATIVE-OK').length-1,1);assert.equal(service.db.prepare("SELECT count(*) n FROM ga_messages WHERE conversation_id=? AND role='assistant' AND run_id IS NOT NULL").get(conversation.conversation_id).n,4);
  }
  t.diagnostic(JSON.stringify({officialLauncher:true,chatPresetMounted:true,thinking:'disabled',tools:['web_fetch','web_search'],boundedContext:bounded,webAllowance:web,maintenanceSource:maintenance,maintenanceObservation:maintenance,accountingProbe:accounting,compactionExecuted:compaction&&!lowPressure&&!cancelCompaction,compactionCancelled:cancelCompaction,modelRequests:requests.length,replyCount:checkpoint?4:cancelCompaction?3:web||bounded?2:1,production:false,readiness:'scripted-fixture'}));succeeded=true;
 }catch(error){await writeFile(join(root,'startup-private.log'),output);throw Error('chat_native_host_failed; private diagnostics: '+root,{cause:error});}
 finally{releaseSupplement();releasePrepare();if(host&&!exit)host.kill('SIGTERM');if(done)await done;await execution?.catch(()=>{});if(service){await service.app.close();service.db.close();}model.closeAllConnections();await new Promise(done=>model.close(done));if(succeeded)await rm(root,{recursive:true,force:true});}
}
test('actual official Chat preset sends thinking disabled, exposes only web tools and publishes one original answer',{skip:!runtime,timeout:60000},t=>chatCase(t));
test('actual Chat Host uses the accepted bounded context on first and next input without duplicating or erasing transcript messages',{skip:!runtime,timeout:60000},t=>chatCase(t,{bounded:true}));

test('actual Chat Host enforces durable Web groups before official parallel search/fetch effects and still publishes one answer',{skip:!runtime,timeout:60000},t=>chatCase(t,{web:true}));

test('actual completed Chat answers prepare immutable maintenance sources without inference, publication or foreground lease reuse',{skip:!runtime,timeout:60000},t=>chatCase(t,{bounded:true,maintenance:true}));
test('actual official Chat auxiliary call uses native maintenance and independent exact usage accounting without another answer',{skip:!runtime,timeout:60000},t=>chatCase(t,{bounded:true,maintenance:true,accounting:true}));

test('actual official Chat engine compacts inside original maintenance with thinking off, native events and settled usage',{skip:!runtime,timeout:60000},t=>chatCase(t,{bounded:true,maintenance:true,compaction:true}));
test('actual official Chat engine skips low pressure without native maintenance or auxiliary model calls',{skip:!runtime,timeout:60000},t=>chatCase(t,{bounded:true,maintenance:true,compaction:true,lowPressure:true}));

test('actual official Chat maintenance cancels and drains before a new original input, retaining unknown usage without a stale summary',{skip:!runtime,timeout:60000},t=>chatCase(t,{bounded:true,maintenance:true,compaction:true,cancelCompaction:true}));

test('actual official Chat checkpoint is published once and consumed by the next original bounded request',{skip:!runtime,timeout:60000},t=>chatCase(t,{bounded:true,maintenance:true,compaction:true,checkpoint:true}));

test('actual official Chat v2 cancellation cannot publish a stale checkpoint while the next question succeeds',{skip:!runtime,timeout:60000},t=>chatCase(t,{bounded:true,maintenance:true,compaction:true,cancelCompaction:true,contextV2:true}));

test('actual official Chat checkpoint follows surface order after a prior native context replacement',{skip:!runtime,timeout:60000},t=>chatCase(t,{bounded:true,maintenance:true,compaction:true,checkpoint:true,replacedSurface:true}));

for(const phase of ['before','after'])test('actual official Chat recovers the original checkpoint after Host exit '+phase+' publication',{skip:!runtime,timeout:90000},t=>chatCase(t,{bounded:true,maintenance:true,compaction:true,checkpoint:true,recovery:phase}));
for(const phase of ['partial','new-input'])test('actual official Chat refuses Host exit recovery for '+phase,{skip:!runtime,timeout:90000},t=>chatCase(t,{bounded:true,maintenance:true,compaction:true,contextV2:true,recovery:phase}));
for(const mode of ['high','low','cancel','early'])test('actual official Chat automatically starts post-answer maintenance: '+mode,{skip:!runtime,timeout:60000},t=>chatCase(t,{bounded:true,maintenance:true,compaction:true,contextV2:true,automatic:mode}));
