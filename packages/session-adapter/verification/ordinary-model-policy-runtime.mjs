// Actual Gateway, native Controller and AgentLoop; inference is locally scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
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
import {createOrdinaryInputAdmissions} from '../ordinary-input-admissions.js';
import {apply} from '../index.js';

for(const scenario of ['explicit','provider-default','unsupported','worker'])test('actual ordinary model policy: '+scenario,{
 timeout:30000,skip:!process.env.JOT_DSH_RUNTIME_MODULES,
},async()=>{
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
  service=await buildServer({databasePath:':memory:',workspaces:['ws'],internalChannelToken:token,workbenchRoot:join(root,'workspaces'),uploadRoot:join(root,'uploads'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates/',import.meta.url)),modelCatalogClient:{modelCatalog:signal=>new SessionControllerClient(adapterUrl,adapterToken).modelCatalog(signal)}});
  const headers={'x-user-id':owner},selected={provider:'local-scripted',model:'chosen',...(scenario==='provider-default'?{}:{reasoning_effort:'high'})},expectedEffort=scenario==='provider-default'?'low':'high';
  const created=await service.app.inject({method:'POST',url:'/v1/conversations',headers,payload:{workspace_id:'ws',title:'Model fixture',model:selected}});
  assert.equal(created.statusCode,201);const conversation=created.json();
  const input=await service.app.inject({method:'POST',url:`/v1/conversations/${conversation.conversation_id}/messages`,headers,payload:{client_message_id:'original-input',content:[{type:'text',text:'Give the synthetic fixture answer.'}]}});
  assert.equal(input.statusCode,202);const runId=input.json().run_id;
  // A later stored conversation value must not change the already accepted input.
  service.db.prepare('UPDATE ga_conversations SET model=? WHERE id=?').run(JSON.stringify({...selected,model:'later',reasoning_effort:'low'}),conversation.conversation_id);
  const session=new SessionBindingRepository(service.db).getOrCreate(owner,conversation.conversation_id);
  const coordinator=new HarnessCoordinator(service.db,service.runs,new EventStore(service.db));
  let lease;if(scenario!=='worker'){lease=coordinator.claimNext('model-fixture-worker',60000);assert.equal(lease.run_id,runId);coordinator.start(lease);}
  const gateway=await service.app.listen({host:'127.0.0.1',port:0});
  class Uploads extends modules.cordis.Service{constructor(ctx){super(ctx,'fileUploads');}registerAgentResolver(){return()=>{};}bindPrompt(){return{commit(){},[Symbol.dispose](){}};}}
  class Workspace extends modules.cordis.Service{constructor(ctx){super(ctx,'workspaceRegistry');this.archivedSessionIds=[];}list(){return [];}}
  const controller=await import(pathToFileURL(join(runtime,'dsh-api-session-controller/lib/index.js')));
  const requests=[],finished=Promise.withResolvers();let providerDefault='low',available=scenario!=='unsupported';
  class Scripted extends modules['dsh-llm'].LlmAdapter{
   async listModels(provider){return ['chosen','later'].map(id=>({provider,id,name:id}));}
   async resolveModel(provider,model){if(!available&&model==='chosen')throw Error('fixture_model_unavailable');return{provider,id:model,name:model,reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}],defaultEffort:providerDefault}};}
   async *stream(options){requests.push({provider:options.provider,model:options.model,effort:options.reasoningEffort});yield{type:'text-delta',index:0,text:'Synthetic model answer.'};yield{type:'finish',reason:{kind:'stop'}};finished.resolve();}
  }
  const boot=async restore=>{
   ctx=new modules.cordis.Context();ctx.provide('profileContext',{installAnchor:join(runtime,'dsh/package.json')});
   for(const name of names.filter(name=>!['cordis','dsh-attachment','dsh-agent-preset-registry'].includes(name)))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(root,'sessions'),compression:'none'}:name==='dsh-attachment-local'?{dshHome:join(root,'attachment-home')}:name==='dsh-agent-default-model'?{provider:'local-scripted',model:'default'}:{});
   ctx.sessionProjections.register(modules['dsh-agent-preset-registry'].agentPresetProjectionDefinition);
   await ctx.plugin(Uploads);await ctx.plugin(Workspace);await ctx.plugin(controller.default,{nativeOpen:false});
   ctx.llm.registerAdapter(['local-scripted'],new Scripted());
   if(!restore)handle=await ctx.agents.create({sessionId:session.session_id,meta:{cwd:root,agentPreset:'jot-general'},agentOptions:{provider:'local-scripted',model:'default'}});
   const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
   process.env[tokenEnv]=adapterToken;process.env[bridgeEnv]=token;
   const listening=Promise.withResolvers();ctx.on('jot-session-adapter/ready',()=>listening.resolve());
   apply(ctx,{host:'127.0.0.1',port,tokenEnv,workbenchTokenEnv:bridgeEnv,workbenchOrigin:gateway,ordinaryModelSelection:true,
    ordinaryInputAdmission:{admissions:createOrdinaryInputAdmissions({root:join(root,'admissions')}),profile:{read:async()=>({protocol:1,profile_id:'model-fixture',preset_id:'jot-general',audit_id:'scripted-audit',fingerprint:'a'.repeat(64)})}},
   });
   await listening.promise;adapterUrl=`http://127.0.0.1:${port}`;
  };
  await boot(false);
  const catalog=await service.app.inject({method:'GET',url:'/v1/capabilities',headers});assert.equal(catalog.statusCode,200);assert.equal(requests.length,0);
  assert.deepEqual(catalog.json().models,!available?[]:['chosen','later'].map(model=>({provider:'local-scripted',model,reasoning_output:'none',supported_reasoning_efforts:['low','high']})));
  const post=body=>fetch(`${adapterUrl}/v1/sessions/${session.session_id}/prompts`,{method:'POST',headers:{authorization:`Bearer ${adapterToken}`,'content-type':'application/json'},body:JSON.stringify(body)});
  const unscoped=await post({request_id:'unowned-request',text:'Not admitted'});assert.equal(unscoped.status,409);await unscoped.body?.cancel();assert.equal(requests.length,0);
  if(scenario==='worker'){
   const transport=[];const client=new SessionControllerClient(adapterUrl,adapterToken,async(url,options)=>{const response=await fetch(url,options);if(!response.ok)transport.push({path:new URL(url).pathname,status:response.status,body:await response.clone().json(),request:JSON.parse(options.body)});return response;}),runner=new OfficialSessionRunner(client,{cwd:root,agentPreset:'jot-general'});
   let failure;const run=runner.run.bind(runner);runner.run=async input=>{try{return await run(input);}catch(error){failure={message:error.message,status:error.status,reason:error.reasonCode};throw error;}};
   const worker=new HarnessWorker(service.db,coordinator,runner,{workerId:'actual-model-worker',leaseMs:60000,ordinaryInputRecoveryEnabled:true,ordinarySteeringEnabled:true,
    sessionResolver:conversationId=>new SessionBindingRepository(service.db).getOrCreateForConversation(conversationId).session_id});
   const outcome=await worker.processNext();assert.equal(outcome.run_id,runId);
   assert.equal(service.runs.get(runId,owner).status,'succeeded',JSON.stringify({outcome,failure,requests,transport,header:handle.agent.session.header,session}));
   assert.deepEqual(requests,[{provider:'local-scripted',model:'chosen',effort:'high'}]);
   const answers=service.db.prepare("SELECT content_json FROM ga_messages WHERE role='assistant' AND run_id=?").all(runId);assert.equal(answers.length,1);assert.ok(answers[0].content_json.includes('Synthetic model answer.'));
   assert.equal(await worker.processNext(),null);assert.equal(requests.length,1);return;
  }
  const original={request_id:runId,text:'Give the synthetic fixture answer.',ordinary_input:{run_id:runId,execution_lease:{owner:lease.owner,generation:lease.generation}}};
  const response=await post(original);
  assert.equal(response.status,202,JSON.stringify(await response.json()));
  if(scenario==='unsupported'){
   await handle.agent.whenIdle();assert.equal(requests.length,0);
   const pending=[...handle.agent.inbox.nextStep,...handle.agent.inbox.nextTurn];assert.equal(pending.length,1);assert.equal(pending[0].source.rpcId,runId);
   assert.equal(service.db.prepare('SELECT model_resolution_json FROM ga_runs WHERE id=?').get(runId).model_resolution_json,null);
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
  const next=service.runs.enqueue(conversation.conversation_id,owner,{client_message_id:'next-model-input',content:[{type:'text',text:'Synthetic next request.'}]});
  const nextLease=coordinator.claimNext('next-model-worker',60000);assert.equal(nextLease.run_id,next.run_id);coordinator.start(nextLease);
  const warm=await post({request_id:next.run_id,text:'Synthetic next request.',ordinary_input:{run_id:next.run_id,execution_lease:{owner:nextLease.owner,generation:nextLease.generation}}});
  assert.equal(warm.status,202,JSON.stringify(await warm.json()));await handle.agent.whenIdle();
  assert.equal(requests.length,3);assert.deepEqual(requests.at(-1),{provider:'local-scripted',model:'later',effort:'low'});
 }finally{
  if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();
  delete process.env[tokenEnv];delete process.env[bridgeEnv];
  if(service){await service.app.close();service.db.close();}
  const child=relative(base,root);assert.ok(child&&!isAbsolute(child)&&!child.startsWith('..'));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 }
});
