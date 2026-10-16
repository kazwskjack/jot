// Real locked Host, native Goal driver and Gateway journal; synthetic HTTP model.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {createServer} from 'node:http';import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHostProfile} from '../create-profile.mjs';
import {buildServer} from '../../gateway/src/server.ts';import {EventStore} from '../../gateway/src/events/event-store.ts';import {RunRepository} from '../../gateway/src/runs/repository.ts';import {HarnessCoordinator} from '../../gateway/src/harness/coordinator.ts';import {ConversationGoalControls} from '../../gateway/src/conversations/goal-controls.ts';
import {HarnessWorker} from '../../gateway/src/harness/worker.ts';
import {OfficialSessionRunner} from '../../gateway/src/harness/official-session-runner.ts';
import {SessionControllerClient} from '../../gateway/src/harness/session-controller-client.ts';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
const envBase=()=>Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATHEXT'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+server.address().port;}
async function until(fn){const end=Date.now()+30000;while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,100));}throw Error('observed_goal_acceptance_timeout');}
for(const mode of ['direct','worker','refused','crash-flush','crash-applied'])test('official cold Goal resume is observed before activation and does not replay input: '+mode,{skip:!runtime,timeout:120000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'jot-observed-goal-')),home=join(root,'home'),workspace=join(root,'workspace'),receipt=join(root,'observed.json'),seeded=join(root,'seeded.json');await mkdir(workspace);
 const internalToken=randomBytes(32).toString('hex'),adapterToken=randomBytes(32).toString('hex'),modelKey=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');let service,child,terminal=true,ended,output='',follower,publicClient,faulted=false;const requests=[],frames=[];
 const model=createServer(async(req,res)=>{try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());assert.equal(req.headers['x-api-key'],modelKey);requests.push(input);
  const saved=JSON.parse(await readFile(seeded,'utf8')),ordinal=requests.length;
  assert.ok(ordinal<=3,'native continuation must stop after completing its Goal');
  // Inference is admitted only after the original Gateway has its exact receipt.
  assert.equal(service.db.prepare('SELECT state FROM ga_conversation_goal_controls').get().state,'applied');
  const tool=ordinal<3?{type:'tool_use',id:'goal-test-call-'+ordinal,name:ordinal===1?'get_goal':'update_goal',input:ordinal===1?{}:{goal_id:saved.id,revision:saved.revision+1,action:'complete'}}:null;
  const events=[{type:'message_start',message:{id:'synthetic-goal-'+ordinal,role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:5,output_tokens:0}}},
   ...(tool?[{type:'content_block_start',index:0,content_block:tool},{type:'content_block_stop',index:0}]:[{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'OBSERVED-GOAL-OK'}},{type:'content_block_stop',index:0}]),
   {type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}];
  res.writeHead(200,{'content-type':'text/event-stream'});for(const event of events)res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();
 }catch{res.writeHead(500);res.end('synthetic_protocol_rejected');}});
 async function stop(){if(!terminal){child.kill('SIGTERM');await ended;}}
 try{
  service=await buildServer({databasePath:join(root,'gateway.db'),uploadRoot:join(root,'files'),workbenchRoot:join(root,'workspaces'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates',import.meta.url)),workspaces:['ws'],internalChannelToken:internalToken,csrfToken:csrf,allowedOrigins:['https://fixture.invalid'],conversationGoalResumeEnabled:true,conversationGoalClient:{conversationGoal:(...args)=>publicClient.conversationGoal(...args),conversationGoalResumeReadiness:(...args)=>publicClient.conversationGoalResumeReadiness(...args)}});
  // Kill only the isolated official Host at a verified durable boundary. This
  // is process-death evidence, not a timeout interpreted as a stopped process.
  service.app.addHook('preHandler',async(request,reply)=>{if(mode==='crash-flush'&&!faulted&&request.url==='/internal/v1/workbench/conversation-goal-control'&&request.body?.operation==='applied'){faulted=true;await stop();return reply.code(503).send({error:{code:'SYNTHETIC_HOST_STOPPED'}});}});
  service.app.addHook('onSend',async(request,reply,payload)=>{if(mode==='crash-applied'&&!faulted&&reply.statusCode===200&&request.url==='/internal/v1/workbench/conversation-goal-control'&&request.body?.operation==='applied'){faulted=true;await stop();}return payload;});
  await service.app.listen({host:'127.0.0.1',port:0});const gatewayUrl='http://127.0.0.1:'+service.app.server.address().port,modelUrl=await listen(model),profile=await createHostProfile({home});
  const probe=createServer();await listen(probe);const port=probe.address().port;await new Promise(r=>probe.close(r));const adapterUrl='http://127.0.0.1:'+port,patchPath=join(profile.directory,'cordis.patch.yml');
  let patch=await readFile(patchPath,'utf8');patch=patch.replace('"port": 18841','"port": '+port).replace('http://127.0.0.1:18831',gatewayUrl).replace('"voiceEnabled": false','"voiceEnabled": false, "conversationGoalResume": true').replace('"jotHostReady"','"jotHostReady", "jotObservedGoalReady"').trim().replace(/\]$/,', '+JSON.stringify({id:'llm-deepseek',config:{baseURL:modelUrl,apiKeyEnv:'DEEPSEEK_API_KEY',reasoningEffort:'high'}})+', '+JSON.stringify({insert:[{id:'observed-goal-probe',name:pathToFileURL(fileURLToPath(new URL('./observed-goal-plugin.mjs',import.meta.url))).href,config:{receipt,seeded,parkInput:mode==='refused'}}]})+']');await writeFile(patchPath,patch);
  const env={...envBase(),DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',JOT_SESSION_ADAPTER_TOKEN:adapterToken,GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:internalToken,DEEPSEEK_API_KEY:modelKey};
  async function start(){terminal=false;output='';child=spawn(process.execPath,[join(runtime,'dsh/lib/bin.js'),'--profile','jot','--host','127.0.0.1','--port','0','--no-open'],{cwd:workspace,env,stdio:['ignore','pipe','pipe'],windowsHide:true});ended=new Promise(r=>child.once('exit',()=>{terminal=true;r();}));for(const stream of [child.stdout,child.stderr])stream.on('data',d=>output+=d.toString());await until(async()=>{assert.equal(terminal,false,'official Host exited');try{return(await fetch(adapterUrl+'/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(500)})).status===401;}catch{return false;}});}
  const post=(path,body,signal=AbortSignal.timeout(15000))=>fetch(adapterUrl+path,{method:'POST',headers:{authorization:'Bearer '+adapterToken,'content-type':'application/json'},body:JSON.stringify(body),signal});
  await start();assert.equal((await post('/v1/sessions',{session_id:'observed-goal-fixture',cwd:workspace,agent_preset:'jot-general'})).status,201);await stop();await start();
  publicClient=new SessionControllerClient(adapterUrl,adapterToken);
  const headers={'x-user-id':'fixture-owner','x-csrf-token':csrf,origin:'https://fixture.invalid'},created=await service.app.inject({method:'POST',url:'/v1/conversations',headers:{...headers,'idempotency-key':'create-synthetic'},payload:{workspace_id:'ws',model:{provider:'fixture',model:'fixture'}}});assert.equal(created.statusCode,201,created.body);const conversation=created.json().conversation_id;
  service.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(conversation,'fixture-owner','observed-goal-fixture','now','now');const events=new EventStore(service.db),runs=new RunRepository(service.db,events),source=runs.enqueue(conversation,'fixture-owner',{client_message_id:'source-fixture',content:[{type:'text',text:'DO-NOT-REPLAY-ORIGINAL-HUMAN-INPUT'}]});service.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(source.run_id);
  const controls=new ConversationGoalControls(service.db,events,runs),saved=JSON.parse(await readFile(seeded,'utf8')),read=await(await post('/v1/sessions/observed-goal-fixture/conversation-goal',{})).json();assert.equal(read.goal.phase,'paused');assert.equal(requests.length,0);assert.equal(JSON.parse(await readFile(receipt,'utf8')).created,0);
  const publicResume=()=>service.app.inject({method:'POST',url:'/v1/conversations/'+conversation+'/goal',headers:{...headers,'idempotency-key':'resume-synthetic'},payload:{action:'resume',id:saved.id,revision:saved.revision}});
  let accepted;
  if(mode!=='direct'){
   const ready=await service.app.inject({method:'GET',url:'/v1/conversations/'+conversation+'/goal/resume-readiness',headers});assert.equal(ready.statusCode,200);assert.deepEqual(ready.json(),{enabled:true,ready:true,reason:'READY'});
   const response=await publicResume();assert.equal(response.statusCode,202,response.body);accepted=response.json();assert.equal(accepted.accepted,true);assert.equal(requests.length,0,'public admission cannot call the model');
   assert.deepEqual((await publicResume()).json(),accepted,'the public request keeps one atomic acceptance receipt');
  }else accepted=controls.enqueue({ownerId:'fixture-owner',conversationId:conversation,sessionId:'observed-goal-fixture',idempotencyKey:'resume-synthetic',ref:saved},read);
  assert.equal(runs.get(accepted.run_id,'fixture-owner').input_message_id,null,'a legacy input join cannot replay the source message');
  assert.equal(runs.get(accepted.run_id,'fixture-owner').goal_control_id,accepted.control_id);
  const coordinator=new HarnessCoordinator(service.db,runs,events);
  if(mode==='direct'){
  const lease=coordinator.claimNext('fixture-worker',60000);coordinator.start(lease);const control={control_id:accepted.control_id,run_id:accepted.run_id,execution_lease:{owner:lease.owner,generation:lease.generation}};
  assert.equal((await post('/v1/sessions/observed-goal-fixture/goal-resume',{goal_control:control})).status,409);assert.equal(requests.length,0);
  follower=new AbortController();const response=await post('/v1/sessions/observed-goal-fixture/follow',{goal_control:control,max_messages:100,assistant_stream:true},follower.signal);assert.equal(response.status,200);const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
  async function frame(){while(true){const index=pending.indexOf('\n');if(index>=0){const line=pending.slice(0,index).trim();pending=pending.slice(index+1);if(line)return JSON.parse(line);continue;}const chunk=await reader.read();assert.equal(chunk.done,false,'native follower ended too early');pending+=decoder.decode(chunk.value,{stream:true});}}
  assert.equal((await frame()).type,'snapshot');const resumed=await post('/v1/sessions/observed-goal-fixture/goal-resume',{goal_control:control}),ack=await resumed.json();assert.equal(resumed.status,200,JSON.stringify(ack));assert.equal(ack.goal.revision,saved.revision+1);assert.equal(ack.goal.activation,'armed');
  const deadline=setTimeout(()=>follower.abort(),30000);try{while(true){const item=await frame();frames.push(item);if(item.type==='event'&&item.event?.type==='turn/end')break;}}finally{clearTimeout(deadline);}
  assert.equal(requests.length,3);assert.ok(requests.every(x=>!JSON.stringify(x.messages).includes('DO-NOT-REPLAY-ORIGINAL-HUMAN-INPUT')));assert.ok(frames.some(x=>x.event?.type==='goal/change'));assert.ok(JSON.stringify(frames).includes('OBSERVED-GOAL-OK'));
  const final=await(await post('/v1/sessions/observed-goal-fixture/conversation-goal',{})).json();assert.equal(final.goal.phase,'complete');const journal=controls.inspect(accepted.control_id,control.execution_lease);assert.equal(journal.state,'applied');assert.equal(journal.receipt.goal.revision,saved.revision+1);assert.equal(JSON.parse(await readFile(receipt,'utf8')).created,1);
  assert.deepEqual(await(await post('/v1/sessions/observed-goal-fixture/goal-resume',{goal_control:control})).json(),ack);assert.equal(requests.length,3);follower.abort();await reader.cancel().catch(()=>{});await stop();
  }else{
   const runner=new OfficialSessionRunner(publicClient,{cwd:workspace,agentPreset:'jot-general'}),worker=new HarnessWorker(service.db,coordinator,runner,{workerId:'fixture-worker',leaseMs:60000,sessionResolver:()=>{throw Error('continuation must not rebind the native Session');}});
   const outcome=await worker.processNext();assert.equal(outcome.run_id,accepted.run_id);
   if(mode!=='worker'){
    assert.equal(runs.get(accepted.run_id,'fixture-owner').status,'interrupted');assert.equal(requests.length,0);const journal=service.db.prepare('SELECT state,receipt_json FROM ga_conversation_goal_controls WHERE control_id=?').get(accepted.control_id);
    assert.equal(journal.state,mode==='refused'?'rejected':mode==='crash-flush'?'dispatching':'applied');
    if(mode==='refused'){assert.equal(runs.get(accepted.run_id,'fixture-owner').error_code,'GOAL_CONTEXT_RECOVERY_REQUIRED');assert.deepEqual(JSON.parse(journal.receipt_json),{rejected:true,mutation:'not_called',reason_code:'GOAL_CONTEXT_RECOVERY_REQUIRED'});assert.equal(JSON.parse(await readFile(receipt,'utf8')).created,0);}
    else assert.equal(faulted,true,'the isolated Host actually stopped at the selected boundary');
    assert.equal(service.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);assert.equal(service.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='user'").get().n,1);await stop();
   }else{
   assert.equal(runs.get(accepted.run_id,'fixture-owner').status,'succeeded');
   const messages=service.db.prepare('SELECT role,content_json FROM ga_messages WHERE conversation_id=? ORDER BY created_at').all(conversation);assert.equal(messages.filter(x=>x.role==='user').length,1);assert.equal(messages.filter(x=>x.role==='assistant').length,1);assert.ok(messages.some(x=>x.role==='assistant'&&x.content_json.includes('OBSERVED-GOAL-OK')));
   assert.equal(requests.length,3);assert.ok(requests.every(x=>!JSON.stringify(x.messages).includes('DO-NOT-REPLAY-ORIGINAL-HUMAN-INPUT')));
   const journal=service.db.prepare('SELECT state,receipt_json FROM ga_conversation_goal_controls WHERE control_id=?').get(accepted.control_id);assert.equal(journal.state,'applied');assert.equal(JSON.parse(journal.receipt_json).goal.revision,saved.revision+1);
   const final=await(await post('/v1/sessions/observed-goal-fixture/conversation-goal',{})).json();assert.equal(final.goal.phase,'complete');assert.equal(JSON.parse(await readFile(receipt,'utf8')).created,1);assert.deepEqual(controls.enqueue({ownerId:'fixture-owner',conversationId:conversation,sessionId:'observed-goal-fixture',idempotencyKey:'resume-synthetic',ref:saved},final),accepted);assert.equal(requests.length,3);await stop();
   }
   const replay=await publicResume();assert.equal(replay.statusCode,202);assert.deepEqual(replay.json(),accepted,'Host shutdown cannot lose the original atomic receipt');assert.equal(requests.length,mode==='worker'?3:0);
  }
  await start();const persisted=await(await post('/v1/sessions/observed-goal-fixture/conversation-goal',{})).json();assert.equal(persisted.goal.phase,mode==='refused'?'paused':mode.startsWith('crash-')?'active':'complete');assert.equal(persisted.goal.activation,'disarmed');assert.equal(persisted.goal.id,saved.id);assert.equal(JSON.parse(await readFile(receipt,'utf8')).created,0);assert.equal(requests.length,['direct','worker'].includes(mode)?3:0);
  if(mode.startsWith('crash-')){
   const stale={control_id:accepted.control_id,run_id:accepted.run_id,execution_lease:{owner:'fixture-worker',generation:1}};assert.equal((await post('/v1/sessions/observed-goal-fixture/goal-resume',{goal_control:stale})).status,409);assert.equal(JSON.parse(await readFile(receipt,'utf8')).created,0);assert.equal(requests.length,0);
   if(mode==='crash-flush'){const blocked=await service.app.inject({method:'POST',url:'/v1/conversations/'+conversation+'/goal',headers:{...headers,'idempotency-key':'do-not-replace-unknown'},payload:{action:'resume',id:saved.id,revision:persisted.goal.revision}});assert.equal(blocked.statusCode,409);assert.equal(blocked.json().error.code,'GOAL_CONTROL_UNCONFIRMED');}
  }
 }catch(error){if(process.env.JOT_HOST_DIAGNOSTIC_DIR){await mkdir(process.env.JOT_HOST_DIAGNOSTIC_DIR,{recursive:true});await writeFile(join(process.env.JOT_HOST_DIAGNOSTIC_DIR,'observed-goal-failure.json'),JSON.stringify({output,observed:JSON.parse(await readFile(receipt,'utf8')),requests:requests.length,frameTypes:frames.map(x=>x.event?.type||x.type)}),{mode:0o600});}throw error;}
 finally{follower?.abort();await stop();model.closeAllConnections();await new Promise(r=>model.close(r));if(service){await service.app.close();service.db.close();}await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
