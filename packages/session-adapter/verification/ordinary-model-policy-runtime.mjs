// Actual Gateway, native Controller and AgentLoop; inference is locally scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {buildServer} from '../../gateway/src/server.ts';
import {SessionBindingRepository} from '../../gateway/src/harness/session-bindings.ts';
import {HarnessCoordinator} from '../../gateway/src/harness/coordinator.ts';
import {EventStore} from '../../gateway/src/events/event-store.ts';
import {SessionControllerClient} from '../../gateway/src/harness/session-controller-client.ts';
import {OfficialSessionRunner} from '../../gateway/src/harness/official-session-runner.ts';
import {HarnessWorker} from '../../gateway/src/harness/worker.ts';
import {inspectOrdinaryRunHistory} from '../../gateway/src/conversations/ordinary-run-history.ts';
import {createOrdinaryInputAdmissions} from '../ordinary-input-admissions.js';
import {apply} from '../index.js';
import {ModelBudgetLedger} from '../../gateway/src/workbench/model-budget.ts';
import {withImmediateTransaction} from '../../gateway/src/db/database.ts';

for(const scenario of ['explicit','provider-default','unsupported','worker','worker-pinned','worker-mode-switch','worker-chat','worker-fallback','worker-budgeted-fallback','worker-budgeted-chat-root','worker-budgeted-chat-root-no-fallback','image-supported','image-unsupported'])test('actual ordinary model policy: '+scenario,{
 timeout:30000,skip:!process.env.JOT_DSH_RUNTIME_MODULES,
},async()=>{
 const budgetedFallback=scenario==='worker-budgeted-fallback',budgetedChatRoot=scenario==='worker-budgeted-chat-root',budgetedChatRootNoFallback=scenario==='worker-budgeted-chat-root-no-fallback',budgetedChatRootCase=budgetedChatRoot||budgetedChatRootNoFallback,budgetedWorkbench=budgetedFallback||budgetedChatRootCase,fallbackScenario=scenario==='worker-fallback'||budgetedWorkbench;
 const runtime=resolve(process.env.JOT_DSH_RUNTIME_MODULES),modules={};
 const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop','dsh-goal','dsh-goal-round-driver','dsh-typert-registry','dsh-fs','dsh-attachment','dsh-attachment-local','dsh-file-reference','dsh-agent-default-model','dsh-api-remote-access','dsh-agent-preset-registry'];
 for(const name of names){
  const manifest=JSON.parse(await readFile(join(runtime,name,'package.json'),'utf8'));
  if(name!=='cordis')assert.equal(manifest.version,'0.2.1-rc.2');
  modules[name]=await import(pathToFileURL(join(runtime,name,'lib/index.js')));
 }
 const base=resolve('.test-tmp/ordinary-model-policy');await mkdir(base,{recursive:true});
 const root=await mkdtemp(join(base,'case-')),tokenEnv='JOT_MODEL_TEST_'+process.pid,bridgeEnv='JOT_MODEL_BRIDGE_'+process.pid;
 const owner='model-fixture',token=randomBytes(32).toString('hex'),adapterToken=randomBytes(32).toString('hex');
 let service,ctx,handle,adapterUrl;
 try{
  // Readiness is scripted. worker-chat executes a real SDK Agent with explicit
  // fixture services; it does not claim a mounted production Chat preset.
  const isChat=scenario==='worker-chat',chatPolicy={protocol:1,mode:'chat',model:{provider:'local-scripted',model:'chosen'},thinking:'disabled',preset_id:'jot-chat',preset_revision:'fixture-v1',context_revision:'fixture-v1'};
  const modeClient={conversationModeReadiness:async()=>({protocol:1,ready:true,policy:chatPolicy}),observeNativeIdle:(session,signal)=>new SessionControllerClient(adapterUrl,adapterToken).observeNativeIdle(session,signal),conversationGoal:(session,body,signal)=>new SessionControllerClient(adapterUrl,adapterToken).conversationGoal(session,body,signal)};
  const modelCatalogClient={modelCatalog:signal=>new SessionControllerClient(adapterUrl,adapterToken).modelCatalog(signal),trustedModelMetadataReadiness:signal=>new SessionControllerClient(adapterUrl,adapterToken).trustedModelMetadataReadiness(signal),trustedModelMetadata:(route,signal)=>new SessionControllerClient(adapterUrl,adapterToken).trustedModelMetadata(route,signal)};
  const budgetRoutes=['chosen','later'].map(model=>({provider:'local-scripted',model,revision:'fixture-rates-v1',context_window:100,max_output_tokens:20,rates:{input:2,output:model==='chosen'?10:1,cache_read:1,cache_write:3}}));
  const budgetLimits={tokens:5000,nano_usd:budgetedChatRootCase?1100:50000,model_calls:20},modelBudgetPolicy=budgetedWorkbench?{revision:1,admission_route:{provider:'local-scripted',model:'chosen'},routes:budgetRoutes,limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,budgetLimits]))}:undefined;
  service=await buildServer({databasePath:':memory:',workspaces:['ws'],internalChannelToken:token,...(scenario==='worker-mode-switch'||isChat?{chatModeEnabled:true,conversationModeClient:modeClient}:{}),...(modelBudgetPolicy?{modelBudgetPolicy}:{}),workbenchRoot:join(root,'workspaces'),uploadRoot:join(root,'uploads'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates/',import.meta.url)),modelCatalogClient});
  const bridgePaths=[];if(budgetedChatRoot)service.app.addHook('onRequest',async request=>{if(request.url.startsWith('/internal/v1/workbench/'))bridgePaths.push(request.url.split('?')[0]);});
  const headers={'x-user-id':owner},selected={provider:'local-scripted',model:'chosen',...(scenario==='provider-default'?{}:{reasoning_effort:'high'}),...(fallbackScenario&&!budgetedChatRootNoFallback?{fallbacks:[{provider:'local-scripted',model:'later'}]}:{})},expectedEffort=isChat?'off':budgetedWorkbench||scenario==='provider-default'?'low':'high';
  const role=budgetedWorkbench?service.workbench.createAgent(owner,{name:'Budgeted fallback fixture',workspace_id:'ws'}):undefined;
  const task=budgetedFallback?service.persistentTasks.create(owner,{title:'Budgeted model fallback fixture',objective:'Produce the synthetic fixture answer.',agent_id:role.agent_id,trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}}):undefined;
  const occurrence=task?service.persistentTasks.runNow(owner,task.task_id,'model-budget-fallback'):undefined;
  let conversation;
  if(role){conversation=service.conversations.get(role.conversation_id,owner);service.db.prepare('UPDATE ga_conversations SET model=? WHERE id=?').run(JSON.stringify(selected),conversation.conversation_id);}
  else{const created=await service.app.inject({method:'POST',url:'/v1/conversations',headers,payload:{workspace_id:'ws',title:'Model fixture',model:selected,...(isChat?{mode:'chat'}:{})}});assert.equal(created.statusCode,201);conversation=created.json();}
  const sessionConversationId=budgetedFallback?service.runs.get(occurrence.run_id,owner).conversation_id:conversation.conversation_id;
  const session=isChat?{session_id:service.db.prepare("SELECT session_id FROM ga_conversation_mode_sessions WHERE owner_id=? AND conversation_id=? AND mode='chat'").get(owner,conversation.conversation_id).session_id}:new SessionBindingRepository(service.db).getOrCreate(owner,sessionConversationId);
  const gateway=await service.app.listen({host:'127.0.0.1',port:0});
  class Uploads extends modules.cordis.Service{constructor(ctx){super(ctx,'fileUploads');}registerAgentResolver(){return()=>{};}bindPrompt(){return{commit(){},[Symbol.dispose](){}};}}
  class Workspace extends modules.cordis.Service{constructor(ctx){super(ctx,'workspaceRegistry');this.archivedSessionIds=[];}list(){return [];}}
  const controller=await import(pathToFileURL(join(runtime,'dsh-api-session-controller/lib/index.js')));
  const requests=[],finished=Promise.withResolvers();let providerDefault='low',available=scenario!=='unsupported';
  class Scripted extends modules['dsh-llm'].LlmAdapter{
   async listModels(provider){return ['chosen','later'].map(id=>({provider,id,name:id}));}
   async resolveModel(provider,model){if(!available&&model==='chosen')throw Error('fixture_model_unavailable');return{provider,id:model,name:model,...(scenario==='image-supported'?{inputModalities:['text','image']}:{}),reasoning:{efforts:[...(isChat?[{id:'off',name:'Off'}]:[]),{id:'low',name:'Low'},{id:'high',name:'High'}],defaultEffort:providerDefault}};}
   async *stream(options){requests.push({provider:options.provider,model:options.model,effort:options.reasoningEffort});const modelCalls=requests.filter(request=>request.model===options.model).length;if(fallbackScenario&&options.model==='chosen'&&!(budgetedChatRoot&&modelCalls>1)){yield{type:'finish',reason:{kind:'error',failure:{code:'SYNTHETIC_PROVIDER_FAILURE'}}};finished.resolve();return;}yield{type:'text-delta',index:0,text:'Synthetic model answer.'};if(budgetedWorkbench)yield{type:'usage',usage:{inputTokens:20,outputTokens:5,cacheReadTokens:10,cacheWriteTokens:5,totalTokens:40}};yield{type:'finish',reason:{kind:'stop'}};finished.resolve();}
  }
  const boot=async restore=>{
   ctx=new modules.cordis.Context();ctx.provide('profileContext',{installAnchor:join(runtime,'dsh/package.json')});
   for(const name of names.filter(name=>!['cordis','dsh-attachment','dsh-agent-preset-registry'].includes(name)))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(root,'sessions'),compression:'none'}:name==='dsh-attachment-local'?{dshHome:join(root,'attachment-home')}:name==='dsh-agent-default-model'?{provider:'local-scripted',model:'default'}:{});
   ctx.sessionProjections.register(modules['dsh-agent-preset-registry'].agentPresetProjectionDefinition);
   if(budgetedWorkbench){const preset=await import(pathToFileURL(resolve('packages/dsh-host/standard-preset.mjs')));await ctx.plugin(preset.default??preset,{budgeted:true});}
   await ctx.plugin(Uploads);await ctx.plugin(Workspace);await ctx.plugin(controller.default,{nativeOpen:false});
   ctx.llm.registerAdapter(['local-scripted'],new Scripted());
   if(!restore){handle=await ctx.agents.create({sessionId:session.session_id,meta:{cwd:root,agentPreset:isChat?'jot-chat':budgetedWorkbench?'jot-workbench-budgeted':'jot-general'},agentOptions:{provider:'local-scripted',model:'default'}});}
   const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
   process.env[tokenEnv]=adapterToken;process.env[bridgeEnv]=token;
   const listening=Promise.withResolvers();ctx.on('jot-session-adapter/ready',()=>listening.resolve());
   apply(ctx,{host:'127.0.0.1',port,tokenEnv,workbenchTokenEnv:bridgeEnv,workbenchOrigin:gateway,ordinaryModelSelection:true,nativeIdleObservation:true,...(budgetedWorkbench?{workbenchModel:{provider:'local-scripted',model:'chosen'}}:{}),
    ...(isChat?{ordinaryExecutionPolicy:chatPolicy}:{}),
    ordinaryInputAdmission:{admissions:createOrdinaryInputAdmissions({root:join(root,'admissions')}),profile:{read:async()=>({protocol:1,profile_id:'model-fixture',preset_id:isChat?'jot-chat':'jot-general',audit_id:'scripted-audit',fingerprint:'a'.repeat(64)})}},
   });
   await listening.promise;adapterUrl=`http://127.0.0.1:${port}`;
  };
  await boot(false);
  if(scenario==='image-supported'||scenario==='image-unsupported'){
   const sharp=createRequire(join(runtime,'dsh-attachment-local','package.json'))('sharp');
   const data=await sharp({create:{width:1,height:1,channels:3,background:'#fff'}}).png().toBuffer();
   const attachment=await ctx.attachments.saveImage({data,mediaType:'image/png',name:'gateway-dsh-capability-fixture.png'});
   handle.agent.session.append('user/message',modules['dsh-llm'].createUserMessage({source:{kind:'user'},content:[{type:'image',attachment}]}),{surfaceOp:'append'});
   assert.ok(handle.agent.session.deriveMessages().some(message=>message.content?.some(block=>block.type==='image')));
  }
  if(budgetedChatRoot){assert.equal(requests.length,0);}else{const catalog=await service.app.inject({method:'GET',url:'/v1/capabilities',headers});assert.equal(catalog.statusCode,200);assert.equal(requests.length,0);assert.deepEqual(catalog.json().models,!available?[]:['chosen','later'].map(model=>({provider:'local-scripted',model,reasoning_output:'none',supported_reasoning_efforts:[...(isChat?['off']:[]),'low','high'],health:{status:'unknown',observed_at:null,expires_at:null}})));}
  const input=budgetedWorkbench?undefined:await service.app.inject({method:'POST',url:`/v1/conversations/${conversation.conversation_id}/messages`,headers,payload:{client_message_id:'original-input',content:[{type:'text',text:'Give the synthetic fixture answer.'}]}});
  if(scenario==='unsupported'){
   assert.equal(input.statusCode,503,input.body);assert.deepEqual(input.json(),{error:{code:'MODEL_METADATA_UNAVAILABLE'}});
   assert.equal(service.db.prepare('SELECT count(*) AS n FROM ga_runs WHERE conversation_id=?').get(conversation.conversation_id).n,0);assert.equal(requests.length,0);
   return;
  }
  if(input)assert.equal(input.statusCode,202,input.body);const runId=budgetedFallback?occurrence.run_id:budgetedChatRootCase?service.workbench.enqueueAgentMessage(owner,role.agent_id,{text:'Give the synthetic fixture answer.',client_message_id:'original-input'}).run_id:input.json().run_id;
  if(budgetedChatRoot||budgetedChatRootNoFallback)assert.deepEqual(JSON.parse(service.db.prepare('SELECT model_policy_json FROM ga_runs WHERE id=?').get(runId).model_policy_json).model.fallbacks,budgetedChatRoot?[{provider:'local-scripted',model:'later'}]:undefined);
  // A later stored conversation value must not change the already accepted input.
  if(!fallbackScenario)service.db.prepare('UPDATE ga_conversations SET model=? WHERE id=?').run(JSON.stringify({...selected,model:'later',reasoning_effort:'low'}),conversation.conversation_id);
  const coordinator=new HarnessCoordinator(service.db,service.runs,new EventStore(service.db));
  let lease;if(!scenario.startsWith('worker')){lease=coordinator.claimNext('model-fixture-worker',60000);assert.equal(lease.run_id,runId);coordinator.start(lease);}
  const post=body=>fetch(`${adapterUrl}/v1/sessions/${session.session_id}/prompts`,{method:'POST',headers:{authorization:`Bearer ${adapterToken}`,'content-type':'application/json'},body:JSON.stringify(body)}),postEndpoint=(endpoint,body)=>fetch(`${adapterUrl}/v1/sessions/${session.session_id}/${endpoint}`,{method:'POST',headers:{authorization:`Bearer ${adapterToken}`,'content-type':'application/json'},body:JSON.stringify(body)});
  const unscoped=await post({request_id:'unowned-request',text:'Not admitted'});assert.equal(unscoped.status,409);await unscoped.body?.cancel();assert.equal(requests.length,0);
  if(scenario.startsWith('worker')){
   if(scenario==='worker-pinned')service.db.prepare('UPDATE ga_harness_session_bindings SET session_id=? WHERE conversation_id=?').run('later-native-fixture',conversation.conversation_id);
   const transport=[];const client=new SessionControllerClient(adapterUrl,adapterToken,async(url,options)=>{const response=await fetch(url,options);if(!response.ok)transport.push({path:new URL(url).pathname,status:response.status,body:await response.clone().json(),request:JSON.parse(options.body)});return response;}),runner=new OfficialSessionRunner(client,{cwd:root,agentPreset:'jot-general',...(isChat?{chatAgentPreset:'jot-chat'}:{}),...(budgetedWorkbench?{workbenchAgentPreset:'jot-workbench-budgeted'}:{})});
   let failure;const run=runner.run.bind(runner);runner.run=async input=>{try{return await run(input);}catch(error){failure={message:error.message,status:error.status,reason:error.reasonCode};throw error;}};
   const worker=new HarnessWorker(service.db,coordinator,runner,{workerId:'actual-model-worker',leaseMs:60000,ordinaryInputRecoveryEnabled:true,ordinarySteeringEnabled:true,...(budgetedWorkbench?{executionGuard:{assertRunActive:run=>{service.workbench.assertRunActive(run);service.persistentTasks.assertRunActive(run);},contextForRun:run=>service.workbench.contextForRun(run)}}:{}),
    sessionResolver:conversationId=>{if(scenario==='worker-pinned')throw Error('current_pointer_must_not_be_read');return new SessionBindingRepository(service.db).getOrCreateForConversation(conversationId).session_id;}});
   const outcome=await worker.processNext();assert.equal(outcome.run_id,runId);
   if(fallbackScenario){
    await handle.agent.whenIdle();const primaryTerminalStatus=service.runs.get(runId,owner).status;assert.ok(['failed','interrupted'].includes(primaryTerminalStatus),'a primary provider error must not be published as success');
    assert.deepEqual(requests,[{provider:'local-scripted',model:'chosen',effort:expectedEffort}],JSON.stringify({message:'a failed accepted run must not switch providers or replay itself',outcome,failure,transport,run:service.runs.get(runId,owner),header:handle.agent.session.header,session,budgetedFallback}));
    if(!budgetedWorkbench){const accepted=JSON.parse(service.db.prepare('SELECT model_policy_json FROM ga_runs WHERE id=?').get(runId).model_policy_json);assert.deepEqual(accepted.model.fallbacks,[{provider:'local-scripted',model:'later'}]);}
    if(!budgetedWorkbench){const failedCatalog=await service.app.inject({method:'GET',url:'/v1/capabilities',headers});assert.equal(failedCatalog.json().models.find(model=>model.model==='chosen').health.status,'unhealthy');assert.equal(failedCatalog.json().models.find(model=>model.model==='later').health.status,'unknown');}
    assert.equal(await worker.processNext(),null,'the failed run must not be retried before a new accepted input');
    if(budgetedFallback){
     assert.equal(requests.length,1,'the failed DSH stream must not replay itself');
     const unknown=service.db.prepare("SELECT attempt_id,state FROM wb_model_budget_attempts WHERE run_id=? AND state='unknown' AND attempt_id<>'queue-admission'").get(runId);assert.ok(unknown,'the actual DSH Workbench stream must leave incomplete usage unknown');
     const ledger=new ModelBudgetLedger(service.db,{routes:budgetRoutes}),reconciled=ledger.settle(owner,runId,unknown.attempt_id,{inputTokens:20,outputTokens:5,cacheReadTokens:10,cacheWriteTokens:5,totalTokens:40});assert.equal(reconciled.state,'settled');
     const receipt=service.db.prepare('SELECT state,actual_tokens,actual_nano_usd FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id=?').get(runId,unknown.attempt_id);
     assert.deepEqual({state:receipt.state,actual_tokens:receipt.actual_tokens,actual_nano_usd:receipt.actual_nano_usd},{state:'settled',actual_tokens:'40',actual_nano_usd:'115'});
     return;
    }
    if(budgetedChatRootNoFallback){
     const ledger=new ModelBudgetLedger(service.db,{routes:budgetRoutes}),unknown=service.db.prepare("SELECT attempt_id FROM wb_model_budget_attempts WHERE run_id=? AND state='unknown' AND attempt_id<>'queue-admission'").get(runId);assert.ok(unknown);
     ledger.settle(owner,runId,unknown.attempt_id,{inputTokens:20,outputTokens:5,cacheReadTokens:10,cacheWriteTokens:5,totalTokens:40});
     const runsBefore=service.db.prepare('SELECT count(*) AS n FROM ga_runs').get().n;
     assert.throws(()=>withImmediateTransaction(service.db,()=>{const next=service.runs.enqueue(conversation.conversation_id,owner,{client_message_id:'no-authorized-fallback',content:[{type:'text',text:'This must remain blocked without an accepted fallback.'}]});service.workbench.inheritChatRun(owner,runId,next.run_id);}),/model_budget_exhausted/);
     assert.equal(service.db.prepare('SELECT count(*) AS n FROM ga_runs').get().n,runsBefore,'without an accepted fallback, admission must roll back');
     assert.equal(requests.length,1,'no route may be dispatched after the rejected admission');
     return;
    }
    if(budgetedChatRoot){
     const ledger=new ModelBudgetLedger(service.db,{routes:budgetRoutes});
     const rootScopeFor=run=>service.db.prepare(`SELECT s.scope_id,s.scope_key FROM wb_model_budget_bindings b JOIN json_each(b.scopes_json) ids ON 1=1 JOIN wb_model_budget_scopes s ON s.scope_id=ids.value WHERE b.owner_id=? AND b.run_id=? AND s.scope_key LIKE 'chat-root:%'`).get(owner,run);
     const originalScope=rootScopeFor(runId);assert.ok(originalScope,'the real DSH run must bind a durable chat-root budget scope');
     const unknown=service.db.prepare("SELECT attempt_id,state FROM wb_model_budget_attempts WHERE run_id=? AND state='unknown' AND attempt_id<>'queue-admission'").get(runId);assert.ok(unknown,'the failed actual DSH call must retain unknown usage');
     const runsBefore=service.db.prepare('SELECT count(*) AS n FROM ga_runs').get().n;
     const admitSameRoot=(clientId,text)=>withImmediateTransaction(service.db,()=>{
      const next=service.runs.enqueue(conversation.conversation_id,owner,{client_message_id:clientId,content:[{type:'text',text}]});
      service.workbench.inheritChatRun(owner,runId,next.run_id);
      return next;
     });
     assert.throws(()=>admitSameRoot('blocked-while-unknown','This continuation must wait for usage reconciliation.'),/budget_usage_unknown/);
     assert.equal(service.db.prepare('SELECT count(*) AS n FROM ga_runs').get().n,runsBefore,'an unknown-usage rejection must roll back the candidate run');
     assert.equal(requests.length,1,'unknown usage must prevent another DSH provider call');
     const ordinaryProbe=await postEndpoint('input-resume',{ordinary_input:{run_id:runId,execution_lease:{owner:'actual-model-worker',generation:1}}});
     assert.equal(ordinaryProbe.status,422);assert.deepEqual(await ordinaryProbe.json(),{error:'ordinary_input_binding_invalid'});
     assert.equal(requests.length,1,'a rejected ordinary marker must not prompt or switch the Workbench session');
     const reconciled=ledger.settle(owner,runId,unknown.attempt_id,{inputTokens:20,outputTokens:5,cacheReadTokens:10,cacheWriteTokens:5,totalTokens:40});assert.equal(reconciled.state,'settled');
     const receipt=service.db.prepare('SELECT state,actual_tokens,actual_nano_usd FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id=?').get(runId,unknown.attempt_id);
     assert.deepEqual({state:receipt.state,actual_tokens:receipt.actual_tokens,actual_nano_usd:receipt.actual_nano_usd},{state:'settled',actual_tokens:'40',actual_nano_usd:'115'});
     const fresh=admitSameRoot('accepted-after-reconcile','A new accepted request after usage reconciliation.');
     assert.equal(JSON.parse(service.db.prepare("SELECT route_json FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id='queue-admission'").get(fresh.run_id).route_json).model,'later');
     const freshScope=rootScopeFor(fresh.run_id);assert.ok(freshScope);assert.equal(freshScope.scope_id,originalScope.scope_id,'the accepted run must retain the original chat root');
     assert.equal(service.runs.get(runId,owner).status,primaryTerminalStatus,'reconciliation must not rewrite the terminal run');
     const freshOutcome=await worker.processNext();assert.equal(freshOutcome.run_id,fresh.run_id);
     await handle.agent.whenIdle();assert.equal(service.runs.get(fresh.run_id,owner).status,'succeeded');
     assert.deepEqual(requests,[{provider:'local-scripted',model:'chosen',effort:expectedEffort},{provider:'local-scripted',model:'later',effort:expectedEffort}],JSON.stringify({message:'the budgeted Workbench selector must choose the authorized fallback when the primary cannot fit its budget',failure,transport,bridgePaths}));
     assert.ok(bridgePaths.some(path=>path.endsWith('/model-budget')),'the actual DSH stream must pass through the Workbench model-budget bridge');
     assert.ok(!bridgePaths.some(path=>path.includes('ordinary-model-policy')),'the Workbench session has no ordinary model-policy selection hook');
     const attempts=service.db.prepare("SELECT a.run_id,a.route_json,a.state,a.actual_tokens,a.actual_nano_usd FROM wb_model_budget_attempts a WHERE a.run_id IN (?,?) AND a.attempt_id<>'queue-admission' ORDER BY a.rowid").all(runId,fresh.run_id);
     assert.equal(attempts.length,2,JSON.stringify(attempts));
     for(const [index,row] of attempts.entries()){const route=JSON.parse(row.route_json);assert.equal(route.model,index===0?'chosen':'later');assert.equal(row.state,'settled');assert.equal(row.actual_tokens,'40');assert.equal(row.actual_nano_usd,index===0?'115':'70');}
     assert.deepEqual(ledger.balance(owner,originalScope.scope_id).used,{tokens:'80',nano_usd:'185',model_calls:'2'});
     assert.deepEqual(ledger.balance(owner,originalScope.scope_id).held,{tokens:'0',nano_usd:'0',model_calls:'0'});
     service.workbench.reconcileBudgets();
     return;
    }
    let fallbackRunId;
    if(budgetedFallback)fallbackRunId=service.workbench.enqueueAgentMessage(owner,role.agent_id,{text:'A new accepted request after the primary was reconciled.',client_message_id:'fallback-input'}).run_id;
    else{const next=await service.app.inject({method:'POST',url:`/v1/conversations/${conversation.conversation_id}/messages`,headers,payload:{client_message_id:'fallback-input',content:[{type:'text',text:'A new accepted request after the primary failed.'}]}});assert.equal(next.statusCode,202,next.body);fallbackRunId=next.json().run_id;}
    const fallbackOutcome=await worker.processNext();assert.equal(fallbackOutcome.run_id,fallbackRunId);
    assert.equal(service.runs.get(fallbackRunId,owner).status,'succeeded');
    assert.deepEqual(requests,[{provider:'local-scripted',model:'chosen',effort:expectedEffort},{provider:'local-scripted',model:'later',effort:expectedEffort}]);
    const resolved=JSON.parse(service.db.prepare('SELECT model_resolution_json FROM ga_runs WHERE id=?').get(fallbackRunId).model_resolution_json);
    assert.equal(resolved.provider,'local-scripted');assert.equal(resolved.model,'later');assert.equal(resolved.reasoning_effort,expectedEffort);
    const fallbackCatalog=await service.app.inject({method:'GET',url:'/v1/capabilities',headers});
    assert.equal(fallbackCatalog.json().models.find(model=>model.model==='chosen').health.status,'unhealthy');
    assert.equal(fallbackCatalog.json().models.find(model=>model.model==='later').health.status,'healthy');
    return;
   }
   assert.equal(service.runs.get(runId,owner).status,'succeeded',JSON.stringify({outcome,run:service.runs.get(runId,owner),failure,requests,transport,header:handle.agent.session.header,events:handle.agent.session.snapshotEvents(0),session}));
   assert.deepEqual(requests,[{provider:'local-scripted',model:'chosen',effort:expectedEffort}]);
   const answers=service.db.prepare("SELECT content_json FROM ga_messages WHERE role='assistant' AND run_id=?").all(runId);assert.equal(answers.length,1);assert.ok(answers[0].content_json.includes('Synthetic model answer.'));
   assert.equal(await worker.processNext(),null);assert.equal(requests.length,1);
   if(scenario==='worker-mode-switch'){
    await handle.agent.whenIdle();const id=conversation.conversation_id,current=service.conversations.get(id,owner);
    const changed=await service.app.inject({method:'PATCH',url:`/v1/conversations/${id}`,headers,payload:{expected_version:current.version,mode:'chat'}});assert.equal(changed.statusCode,200,changed.body);
    const mappings=service.db.prepare('SELECT mode,session_id FROM ga_conversation_mode_sessions WHERE conversation_id=? ORDER BY mode').all(id);assert.equal(mappings.length,2);assert.equal(mappings[1].session_id,session.session_id);assert.notEqual(mappings[0].session_id,session.session_id);
    assert.equal(ctx.agents.get(mappings[0].session_id),undefined);
    const history=inspectOrdinaryRunHistory(service.db,{run_id:runId,conversation_id:id,owner_id:owner,session_ref:session.session_id,expected_run_version:service.runs.get(runId,owner).version});assert.equal(history.session_id,session.session_id);
    const restored=await service.app.inject({method:'PATCH',url:`/v1/conversations/${id}`,headers,payload:{expected_version:changed.json().version,mode:'work'}});assert.equal(restored.statusCode,200,restored.body);
    assert.equal(service.db.prepare('SELECT session_id FROM ga_harness_session_bindings WHERE conversation_id=?').get(id).session_id,session.session_id);assert.equal(requests.length,1);
   }
   return;
  }
  const original={request_id:runId,text:'Give the synthetic fixture answer.',ordinary_input:{run_id:runId,execution_lease:{owner:lease.owner,generation:lease.generation}}};
  const response=await post(original);
  assert.equal(response.status,202,JSON.stringify(await response.json()));
  if(scenario==='image-unsupported'){
   await handle.agent.whenIdle();
   assert.equal(requests.length,0,'a DSH route without image modality must not stream the active image request');
   return;
  }
  await Promise.race([finished.promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('native_model_request_missing')),10000);timer.unref();})]);
  assert.deepEqual(requests,[{provider:'local-scripted',model:'chosen',effort:expectedEffort}],JSON.stringify({resolution:service.db.prepare('SELECT model_resolution_json FROM ga_runs WHERE id=?').get(runId),selections:handle.agent.session.snapshotEvents(0).filter(event=>event.type==='model/selection').map(event=>event.data)}));
  await handle.agent.whenIdle();
  providerDefault='high';
  const replay=await post(original);assert.equal(replay.status,202);await replay.body?.cancel();await handle.agent.whenIdle();assert.equal(requests.length,1);
  const text='Synthetic steering supplement.',command=service.commands.steer(runId,owner,{text,client_message_id:'model-supplement',expected_run_version:service.runs.get(runId,owner).version},'model-steering');
  const steered=await post({request_id:command.command_id,text,mode:'steer',ordinary_steer:{run_id:runId,command_id:command.command_id,execution_lease:original.ordinary_input.execution_lease}});
  assert.equal(steered.status,202,JSON.stringify(await steered.json()));await handle.agent.whenIdle();
  assert.deepEqual(requests.at(-1),{provider:'local-scripted',model:'chosen',effort:expectedEffort});assert.equal(requests.length,2);
  // Fixture-only settlement: this probe verifies request routing, not final publication.
  service.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(runId);
  const next=await service.app.inject({method:'POST',url:`/v1/conversations/${conversation.conversation_id}/messages`,headers,payload:{client_message_id:'next-model-input',content:[{type:'text',text:'Synthetic next request.'}]}});
  assert.equal(next.statusCode,202,next.body);const nextRunId=next.json().run_id;
  const nextLease=coordinator.claimNext('next-model-worker',60000);assert.equal(nextLease.run_id,nextRunId);coordinator.start(nextLease);
  const warm=await post({request_id:nextRunId,text:'Synthetic next request.',ordinary_input:{run_id:nextRunId,execution_lease:{owner:nextLease.owner,generation:nextLease.generation}}});
  assert.equal(warm.status,202,JSON.stringify(await warm.json()));await handle.agent.whenIdle();
  assert.equal(requests.length,3);assert.deepEqual(requests.at(-1),{provider:'local-scripted',model:'later',effort:'low'});
 }finally{
  if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();
  delete process.env[tokenEnv];delete process.env[bridgeEnv];
  if(service){await service.app.close();service.db.close();}
  const child=relative(base,root);assert.ok(child&&!isAbsolute(child)&&!child.startsWith('..'));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 }
});
