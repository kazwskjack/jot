// Extends the established gateway-worker fixture in isolation: the loopback
// Messages endpoint is scripted; Gateway/Worker/SDK/Goal and file IO are real.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHostProfile} from '../create-profile.mjs';
import {createNativeIsolatedWorkCleanup} from './native-isolated-work-cleanup.mjs';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
async function listen(server){await new Promise(done=>server.listen(0,'127.0.0.1',done));return 'http://127.0.0.1:'+server.address().port;}
async function freePort(){const server=createServer();await listen(server);const port=server.address().port;await new Promise(done=>server.close(done));return port;}
async function until(check){const end=Date.now()+60000;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(done=>setTimeout(done,100));}throw Error('gateway_host_acceptance_timeout');}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
function cleanEnv(){const env={};for(const key of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];env.TEMP=process.env.JOT_TEST_TMP;env.TMP=process.env.JOT_TEST_TMP;return env;}
function launch(args,cwd,env){const child=spawn(process.execPath,args,{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true});let output='',terminal=false,exitCode=null,exitSignal=null;const ended=new Promise(done=>child.once('exit',(code,signal)=>{terminal=true;exitCode=code;exitSignal=signal;done();}));for(const stream of [child.stdout,child.stderr])stream.on('data',value=>{output+=value;});return {child,output:()=>output,terminal:()=>terminal,exit:()=>{const busy=(output.match(/SQLITE_BUSY/gi)||[]).length,locked=(output.match(/SQLITE_LOCKED|database is locked/gi)||[]).length;return{pid:child.pid,exit_code:exitCode,signal:exitSignal,terminal,sqlite_busy_count:busy,sqlite_locked_count:locked};},async stop(){if(!terminal)child.kill('SIGTERM');await ended;}};}

function executionReceipt(value){
 if(typeof value==='string'){try{return executionReceipt(JSON.parse(value));}catch{return;}}
 if(!value||typeof value!=='object')return;
 if(value.execution_receipt?.kind==='tool_receipt')return value.execution_receipt;
 for(const child of Object.values(value)){const found=executionReceipt(child);if(found)return found;}
}
function originalWorkSubtask(value){
 if(typeof value==='string'){try{return originalWorkSubtask(JSON.parse(value));}catch{return;}}
 if(!value||typeof value!=='object')return;
 if(value.title==='Inspect discovery source'&&value.status==='pending'&&typeof value.subtask_id==='string'&&Number.isSafeInteger(value.version))return value;
 for(const child of Object.values(value)){const found=originalWorkSubtask(child);if(found)return found;}
}

const userTexts=input=>input.messages.filter(message=>message.role==='user').flatMap(message=>typeof message.content==='string'?[message.content]:(message.content??[]).filter(part=>part.type==='text').map(part=>part.text));
const occurrences=(text,part)=>text.split(part).length-1;

export async function nativeIsolatedWorkCase(t,{role=false,persistent=false,resume=false,complete=false,automatic=false,unlimited=false,discovery=false,noPlan=false,discoveryWait=false,workWait=false,maintenanceDriven=false,gateScenario='positive',cleanupOnly=false}={}){
 persistent ||= discovery; complete ||= discovery; unlimited ||= discovery; role ||= persistent;
 assert.equal(JSON.parse(await readFile(join(runtime,'dsh-api-session-controller/package.json'),'utf8')).version,'0.2.1-rc.2','acceptance requires the reviewed locked SDK');
 const {buildServer}=await import('../../gateway/src/server.ts');
 if(!process.env.JOT_TEST_TMP)throw Error('native_work_fixture_tmp_required');
 const root=await mkdtemp(join(process.env.JOT_TEST_TMP,'jot-native-isolated-work-')),home=join(root,'home'),workspace=join(root,'workspace');await mkdir(workspace);
  let host,worker,service,succeeded=false,modelFailure,workStarted=false,workStage=0,workSubtask,acceptedModelHeld=false,barrierArrivals=0,fixtureCheckpoint='fixture_setup',raceLeaseEvidence,cleanupOnlyResult;const requests=[],ambientRequests=[],workerProcesses=[],internalFacts=[],busyProbeArrived=deferred(),releaseBusyProbe=deferred(),acceptedModelArrived=deferred(),releaseAcceptedModel=deferred();const originalErrors=new WeakMap();
 const modelKey='sk-'+randomBytes(32).toString('hex'),adapterToken=randomBytes(32).toString('hex'),internalToken=randomBytes(32).toString('hex'),csrfToken=randomBytes(32).toString('hex');
 const model=createServer(async(req,res)=>{try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());
   assert.equal(req.method,'POST');assert.match(req.url,/\/messages$/);assert.equal(req.headers['x-api-key'],modelKey);
    const busyProbe=gateScenario==='busy-native'&&ambientRequests.length===0&&requests.length===0;
    const foregroundProbe=gateScenario==='recent-foreground-input'&&ambientRequests.length===0&&requests.length===0;
    if(busyProbe){
     ambientRequests.push(input);busyProbeArrived.resolve();await releaseBusyProbe.promise;if(res.destroyed)return;
     res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
     for(const event of [{type:'message_start',message:{id:'synthetic-busy-probe',role:'assistant',model:input.model??'deepseek-flash',content:[],usage:{input_tokens:5,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'BUSY-PROBE-COMPLETE'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}])res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();return;
    }
    assert.equal(input.model,'deepseek-flash');assert.equal(input.thinking?.type,'enabled');assert.equal(input.output_config?.effort,'high');
    if(foregroundProbe)ambientRequests.push(input);else requests.push(input);
    const ordinal=requests.length+ambientRequests.length;
   if((gateScenario==='lease-invalidated'||gateScenario==='inflight-worker-exit'||gateScenario==='task-pause-inflight'||gateScenario==='task-archive-inflight'||gateScenario==='two-process-admission-race')&&!acceptedModelHeld){acceptedModelHeld=true;acceptedModelArrived.resolve();await releaseAcceptedModel.promise;if(res.destroyed)return;}
   if((gateScenario==='inflight-worker-exit'||gateScenario==='unknown-no-replay'||gateScenario==='unknown-no-replay-cold-restart')&&ordinal===1){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});res.write('event: message_start\ndata: '+JSON.stringify({type:'message_start',message:{id:'synthetic-unknown-outcome',role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:5,output_tokens:0}}})+'\n\n');res.end();return;}
   res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  let operation='tasks.propose',argumentsValue={intent:complete?'complete':automatic&&ordinal===1?'continue':resume&&ordinal===2?'wait_approval':'wait_user',summary:ordinal===2?'Please review the next step.':'Please confirm the next step.'};
  if(complete&&!discovery&&ordinal===1){operation='files.write';argumentsValue={path:'acceptance.md',content:'ACCEPTANCE-OK',expected_version:0};}
  if(complete&&!discovery&&ordinal===2){operation='tasks.upsert';const evidence=executionReceipt(input.messages);assert.ok(evidence,'the model must consume a real file operation receipt');argumentsValue={title:'Write the acceptance file',acceptance:'acceptance.md contains exactly ACCEPTANCE-OK.',status:'completed',evidence:[evidence]};}
  if(complete&&!discovery&&ordinal===3)argumentsValue.files=[{path:'acceptance.md',description:'Reviewed report'}];
   if(discovery&&!workStarted&&!foregroundProbe){
   const source=executionReceipt(input.messages);
   const actions=[['discovery.context',{}],['discovery.source',{revision:1}],['tasks.upsert',{title:'Inspect discovery source',acceptance:'Use the pinned source to support a proposal.',status:'completed',evidence:source?[source]:[]}],
    ['discovery.plan',{summary:'Clarify the source',rationale:'The inspected source supports a wording improvement.',changes:[{path:'source.md',description:'Clarify wording',steps:['Review wording'],verification:['Compare with the pinned source']}],evidence:source?[source]:[]}],
    ['discovery.report',{outcome:'proposals',summary:'One source-backed proposal for review.',limitations:[],plan_ids:[],evidence:source?[source]:[]}],['tasks.propose',{intent:'complete',summary:'Review the recorded discovery report.'}]];
   if(noPlan){actions.splice(3,1);actions[2][1].acceptance='Inspect the pinned source and state supported conclusions.';actions[3][1].outcome='no_plan';actions[3][1].summary='No supported improvement in the inspected source.';}
   if(discoveryWait){
    // The second real tool call reads a deliberately corrupted fixture blob.
    // It must not attest a successful source read or create a report.
    actions.splice(2,0,['tasks.propose',{intent:'wait_user',summary:'The source failed its integrity check. Please restore the original source bytes.'}],['discovery.source',{revision:1}]);
    if(ordinal===3){const replies=input.messages.flatMap(m=>Array.isArray(m.content)?m.content.filter(b=>b.type==='tool_result'):[]);assert.ok(JSON.stringify(replies).includes('discovery_source_integrity_failed'),'the wait must follow the actual failed source tool response');}
   }
   assert.ok(ordinal<=actions.length,'discovery must not loop past its scripted synthetic responses');[operation,argumentsValue]=actions[ordinal-1];
  }
  if(workStarted){
   workSubtask??=originalWorkSubtask(input.messages);
   const stage=++workStage,receipt=executionReceipt(input.messages),actions=[
    ['tasks.subtasks',{}],
    ['files.write',{path:'source.md',content:'ISOLATED-NATIVE-WORK-OK',expected_version:0}],
    ...(workWait?[['tasks.propose',{intent:'wait_user',summary:'Please confirm the isolated wording before final review.'}]]:[]),
    ['tasks.upsert',{subtask_id:workSubtask?.subtask_id,expected_version:workSubtask?.version,title:'Clarify the selected source',acceptance:'source.md contains exactly ISOLATED-NATIVE-WORK-OK.',status:'completed',evidence:receipt?[receipt]:[]}],
    ['tasks.propose',{intent:'complete',summary:'Review the isolated source result.',files:[{path:'source.md',description:'Selected isolated work output'}]}],
   ];
   assert.ok(stage<=actions.length,'native work cannot repeat a completed scripted write');
   if(stage===actions.length-1){assert.ok(receipt,'work completion must consume the original real isolated write receipt');assert.ok(workSubtask,'the native model must read the original pending task board before updating it');}
   if(workWait&&stage===4)assert.ok(userTexts(input).join('\n').includes('Proceed with the same isolated wording.'),'the original owner reply must reach the cold resumed Session');
   [operation,argumentsValue]=actions[stage-1];
  }
    const toolEvents=persistent&&!foregroundProbe&&!(automatic&&ordinal===2)?[
   {type:'content_block_start',index:1,content_block:{type:'tool_use',id:'synthetic-wait-call-'+ordinal,name:'jot_workspace',input:{operation,arguments_json:JSON.stringify(argumentsValue)}}},
   {type:'content_block_stop',index:1},
  ]:[];
  for(const event of [
   {type:'message_start',message:{id:'synthetic-message-'+ordinal,role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:5,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text:foregroundProbe?'FOREGROUND-PROBE-COMPLETE':'ACCEPTANCE-OK'}},
   {type:'content_block_stop',index:0},
   ...toolEvents,
   {type:'message_delta',delta:{stop_reason:toolEvents.length?'tool_use':'end_turn'},usage:{output_tokens:1}},
   {type:'message_stop'},
  ])res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();
 }catch(error){modelFailure=error;if(!res.headersSent)res.writeHead(500);res.end('synthetic_protocol_request_rejected');}});
 const modelUrl=await listen(model);
 const route={provider:'deepseek-official',model:'deepseek-flash',revision:'synthetic-rates-1',context_window:1000000,max_output_tokens:256000,rates:{input:1,output:1,cache_read:1,cache_write:1}};
 const policy={revision:1,admission_route:{provider:route.provider,model:route.model},routes:[route],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,{tokens:10000000,nano_usd:null,model_calls:100}]))};
  const fixtureCleanup=createNativeIsolatedWorkCleanup({
   get workerProcesses(){return workerProcesses;},get host(){return host;},get service(){return service;},get succeeded(){return succeeded;},get cleanupOnlyResult(){return cleanupOnlyResult;},
   root,model,releaseBusyProbe,releaseAcceptedModel,
  });
  const {cleanupAwait,finishWorkers}=fixtureCleanup;
  try{
  await mkdir(join(root,'cycle-artifacts'),{recursive:true});
  service=await buildServer({databasePath:join(root,'gateway.db'),uploadRoot:join(root,'files'),workbenchRoot:join(root,'workspaces'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates',import.meta.url)),workspaces:['jot'],nativeWorkRoot:join(root,'cycle-artifacts'),internalChannelToken:internalToken,csrfToken,allowedOrigins:['https://fixture.invalid'],...(role?{modelBudgetPolicy:policy,workbenchExecutionReady:true}:{})});
  service.app.addHook('onError',async(request,_reply,error)=>{originalErrors.set(request,error.message);});
  service.app.addHook('onSend',async(request,reply,payload)=>{
   if(!request.routeOptions.url?.startsWith('/internal/v1/workbench/'))return payload;
   let body;try{body=JSON.parse(Buffer.isBuffer(payload)?payload.toString():String(payload));}catch{return payload;}
   const context=body?.context;
   if(context?.work_binding||reply.statusCode>=400){internalFacts.push({endpoint:request.routeOptions.url,status:reply.statusCode,error:originalErrors.get(request),run_id:request.body?.run_id,...(context?{work_binding:context.work_binding,native_workspace:context.native_workspace,task_binding:context.task_binding,model_budget:context.model_budget}:{}),attempts:service.db.prepare('SELECT run_id,attempt_id,state FROM wb_model_budget_attempts ORDER BY created_at').all()});await writeFile(join(root,'internal-work-facts-private.json'),JSON.stringify(internalFacts,null,2));}
   return payload;
  });
  await service.app.listen({host:'127.0.0.1',port:0});fixtureCheckpoint='gateway_ready';const gatewayUrl='http://127.0.0.1:'+service.app.server.address().port;
  const prepared=await createHostProfile({home,...(role?{workbench:{provider:route.provider,model:route.model,origin:gatewayUrl}}:{})}),port=await freePort(),patchPath=join(prepared.directory,'cordis.patch.yml');
  let patch=await readFile(patchPath,'utf8');patch=patch.replace('"port": 18841','"port": '+port+(discovery?', "nativeIdleObservation": true':'')).replace('http://127.0.0.1:18831',gatewayUrl).replace('"jotHostReady"','"jotHostReady", "jotHostInspectionReady"');
  const inspection={insert:[{id:'jot-host-inspection',name:pathToFileURL(fileURLToPath(new URL('./inspect-host-plugin.mjs',import.meta.url))).href,config:{receipt:join(root,'composition.json'),sessionPrefix:'jot-host-acceptance-'}},{id:'jot-native-session-absence-inspection',name:new URL('./native-session-absence-plugin.mjs',import.meta.url).href,config:{receipt:join(root,'native-absence-private.json')}}]};
  patch=patch.trim().replace(/\]$/,', '+JSON.stringify({id:'llm-deepseek',config:{baseURL:modelUrl,apiKeyEnv:'DEEPSEEK_API_KEY',reasoningEffort:'high'}})+', '+JSON.stringify(inspection)+']');await writeFile(patchPath,patch);
  host=launch([join(runtime,'dsh/lib/bin.js'),'--profile','jot','--host','127.0.0.1','--port','0','--no-open'],workspace,{...cleanEnv(),DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',JOT_SESSION_ADAPTER_TOKEN:adapterToken,GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:internalToken,DEEPSEEK_API_KEY:modelKey});
  const adapterUrl='http://127.0.0.1:'+port;
  let adapterProbe={attempts:0};
  fixtureCheckpoint='official_session_adapter_readiness';
  try{await until(async()=>{assert.equal(host.terminal(),false,'official host exited');try{const response=await fetch(adapterUrl+'/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(500)});adapterProbe={attempts:adapterProbe.attempts+1,status:response.status};return response.status===401;}catch(error){adapterProbe={attempts:adapterProbe.attempts+1,error:error?.cause?.code??error?.name??'adapter_probe_failed'};return false;}});fixtureCheckpoint='official_session_adapter_ready';}
  catch(error){t.diagnostic(JSON.stringify({m08_08_failure:'official_session_adapter_not_ready',probe:adapterProbe}));throw Error('official_session_adapter_not_ready:'+JSON.stringify(adapterProbe),{cause:error});}
  const absence=JSON.parse(await readFile(join(root,'native-absence-private.json'),'utf8'));assert.equal(absence.official_absence,true);assert.equal(absence.code,null);assert.equal(absence.cached,false);assert.equal(absence.agent,false);
  const tokenFile=join(root,'adapter.token');await writeFile(tokenFile,adapterToken,{mode:0o600});
  const policyFile=join(root,'budget-policy.json');if(role)await writeFile(policyFile,JSON.stringify(policy));
  const headers={'x-user-id':'acceptance-owner','content-type':'application/json','x-csrf-token':csrfToken,origin:'https://fixture.invalid','idempotency-key':'acceptance-create'};
  let conversation_id,messageUrl,messageBody,roleAgent,foregroundConversationId,discoveryController,discoveryClient,discoveryRoleSession,discoveryPolicyUrl,discoveryPolicyId,discoveryScope,sourceBlob,sourceBytes;const observationTimings=[],observationBarrierDir=join(root,'observation-barrier');
  if(role){const response=await fetch(gatewayUrl+'/v1/agents',{method:'POST',headers,body:JSON.stringify({name:'Acceptance role',workspace_id:'jot',instructions:'Reply clearly using the provided evidence.'})});assert.equal(response.status,201);const agent=await response.json();roleAgent=agent;conversation_id=agent.conversation_id;messageUrl='/v1/agents/'+agent.agent_id+'/messages';messageBody={client_message_id:'acceptance-one',text:'Reply with the single word ACCEPTANCE-OK.'};
   if(gateScenario==='recent-foreground-input'){
    const created=await fetch(gatewayUrl+'/v1/conversations',{method:'POST',headers:{...headers,'idempotency-key':'foreground-conversation'},body:JSON.stringify({title:'Foreground activity acceptance',workspace_id:'jot',project_id:agent.project_id,model:{provider:'deepseek-official',model:'deepseek-flash'}})});assert.equal(created.status,201,await created.clone().text());foregroundConversationId=(await created.json()).conversation_id;
   }
   if(persistent&&!discovery){const created=await fetch(gatewayUrl+'/v1/persistent-tasks',{method:'POST',headers:{...headers,'idempotency-key':'acceptance-task'},body:JSON.stringify({title:'Wait for confirmation',agent_id:agent.agent_id,objective:complete?'Write acceptance.md containing ACCEPTANCE-OK and request owner acceptance.':'Ask the user to confirm before any further work.',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'},budget:{max_runs:unlimited?null:1}})});const task=await created.json();assert.equal(created.status,201,JSON.stringify(task));messageUrl='/v1/persistent-tasks/'+task.task_id+'/run-now';messageBody={};}
  }
  else{const conversation=await fetch(gatewayUrl+'/v1/conversations',{method:'POST',headers,body:JSON.stringify({title:'Synthetic local model acceptance',workspace_id:'jot',model:{provider:'deepseek-official',model:'deepseek-flash'}})});assert.equal(conversation.status,201);({conversation_id}=await conversation.json());messageUrl='/v1/conversations/'+conversation_id+'/messages';messageBody={client_message_id:'acceptance-one',content:[{type:'text',text:'Reply with the single word ACCEPTANCE-OK.'}]};}
  if(discovery){
   const {SessionControllerClient}=await import('../../gateway/src/harness/session-controller-client.ts');
   const {ProjectActivityObserver}=await import('../../gateway/src/always-on/project-activity.ts');
   const {DiscoveryAdmissionController}=await import('../../gateway/src/always-on/admission.ts');
   const {DiscoveryPolicies}=await import('../../gateway/src/always-on/discovery-policy.ts');
   const {WorkbenchBudgetPolicy}=await import('../../gateway/src/workbench/model-budget-policy.ts');
   const {HarnessCoordinator}=await import('../../gateway/src/harness/coordinator.ts');
     const client=new SessionControllerClient(adapterUrl,adapterToken),roleSession='discovery-idle-role';discoveryClient=client;discoveryRoleSession=roleSession;
     await client.create(roleSession,workspace,'jot-general');assert.equal(requests.length,0,'idle role setup must not call the model');
     service.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(roleAgent.conversation_id,'acceptance-owner',roleSession,new Date().toISOString(),new Date().toISOString());
     assert.equal((await client.nativeIdleObservationReadiness()).ready,true);assert.equal((await client.observeNativeIdle(roleSession)).native_idle,'idle');
   service.workbench.writeFile('acceptance-owner','jot',{project_id:roleAgent.project_id,path:'source.md',content:'Discovery source observed for ACCEPTANCE-OK.',expected_version:0});
   if(discoveryWait){
    const version=service.db.prepare('SELECT blob_name FROM wb_file_versions WHERE owner_id=? AND project_id=? AND path=? AND version=1').get('acceptance-owner',roleAgent.project_id,'source.md');
    sourceBlob=join(service.workbench.projectRoot('acceptance-owner','jot',roleAgent.project_id),'blobs',version.blob_name);sourceBytes=await readFile(sourceBlob);
    await writeFile(sourceBlob,'Deliberate isolated-fixture corruption.');
   }
    const policyUrl=gatewayUrl+'/v1/agents/'+roleAgent.agent_id+'/discovery-policy';discoveryPolicyUrl=policyUrl;
     const saved=await fetch(policyUrl,{method:'PATCH',headers:{...headers,'idempotency-key':'discovery-save'},body:JSON.stringify({expected_version:0,expected_role_version:1,expected_role_epoch:1,mode:'discover_only',cooldown_ms:gateScenario==='cooldown'?60000:0,recent_input_ms:gateScenario==='recent-foreground-input'?60000:0,max_cycles:null})});assert.equal(saved.status,200,await saved.clone().text());
    const enabled=await fetch(policyUrl+'/control',{method:'POST',headers:{...headers,'idempotency-key':'discovery-enable'},body:JSON.stringify({action:'enable',expected_version:1,expected_role_version:1,expected_role_epoch:1})});assert.equal(enabled.status,200,await enabled.clone().text());
    discoveryPolicyId=service.db.prepare('SELECT policy_id FROM wb_discovery_policies WHERE owner_id=? AND agent_id=?').get('acceptance-owner',roleAgent.agent_id).policy_id;
   discoveryScope={project_id:roleAgent.project_id,workspace_id:'jot',agent_id:roleAgent.agent_id};
    if(!maintenanceDriven){
     const native={nativeIdleObservationReadiness:signal=>client.nativeIdleObservationReadiness(signal),observeNativeIdle:async(id,signal)=>{const start=Date.now(),monotonic=performance.now(),fact=await client.observeNativeIdle(id,signal),end=Date.now();observationTimings.push({phase:'native',wall_before:start,wall_after:end,host_observed_at:fact.observed_at,elapsed_monotonic_ms:performance.now()-monotonic,age_ms:end-fact.observed_at});return fact;}};
     const activity=new ProjectActivityObserver({db:service.db,workbench:service.workbench,native,maxAgeMs:5000,now:()=>{const wall=Date.now();observationTimings.push({phase:'clock',wall});return wall;}}),observe=activity.observe.bind(activity);
     activity.observe=async(...args)=>{const start=Date.now(),fact=await observe(...args);observationTimings.push({phase:'activity',elapsed_ms:Date.now()-start,age_ms:Date.now()-fact.observed_at,reason:fact.reason,session_count:fact.facts.session_count});return fact;};
     discoveryController=new DiscoveryAdmissionController({db:service.db,workbench:service.workbench,tasks:service.persistentTasks,policies:new DiscoveryPolicies(service.db),activity,coordinator:new HarnessCoordinator(service.db,service.runs,service.events),budgetPolicy:new WorkbenchBudgetPolicy(service.db,policy),maxAgeMs:5000});
    }
  }
  const postMessage=()=>fetch(gatewayUrl+messageUrl,{method:'POST',headers:{...headers,'idempotency-key':'acceptance-one'},body:JSON.stringify(messageBody)});
  if(gateScenario==='recent-foreground-input')messageBody={client_message_id:'foreground-probe',text:'FOREGROUND-PROBE: recent owner input must hold discovery admission.'};
  const admitFresh=async()=>{
   assert.equal(maintenanceDriven,false,'maintenance-driven acceptance must never call DiscoveryAdmissionController directly');
   // A freshness hold is a normal, non-admitting observation, not permission to
   // accept stale evidence or restart a process. Re-observe within this fixture
   // at most three times; every rejected attempt must preserve execution state.
   let receipt;
   for(let attempt=0;attempt<3;attempt++){
    const state=()=>({runs:service.db.prepare('SELECT count(*) n FROM ga_runs').get().n,admissions:service.db.prepare('SELECT count(*) n FROM wb_discovery_admissions').get().n,
     used:service.persistentTasks.list('acceptance-owner').items[0].runs_used,modelRequests:requests.length,attempts:service.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n});
    const before=state();receipt=await discoveryController.admit('acceptance-owner',discoveryScope);
    if(receipt.reason!=='OBSERVATION_STALE')return receipt;
    t.diagnostic(JSON.stringify({freshness_hold:true,observations:observationTimings.splice(0)}));
    assert.deepEqual(state(),before,'expired observations cannot admit runs, spend or reset task usage');
   }
   return receipt;
  };
  const fetchTrace=join(root,'fetch-status.jsonl');
  const startWorker=(workerId)=>{const started=launch(['--import',new URL('./trace-gateway-fetch.mjs',import.meta.url).href,'--experimental-strip-types',fileURLToPath(new URL('../../gateway/src/harness/main.ts',import.meta.url))],workspace,{...cleanEnv(),JOT_ACCEPTANCE_FETCH_TRACE:fetchTrace,...(['pause-during-observation','stop-during-observation','pause-cold-restart','stop-cold-restart','two-process-admission-race','worker-cleanup-only'].includes(gateScenario)?{JOT_ACCEPTANCE_OBSERVATION_BARRIER_DIR:observationBarrierDir,...(['two-process-admission-race','worker-cleanup-only'].includes(gateScenario)?{JOT_ACCEPTANCE_OBSERVATION_BARRIER_PARTICIPANTS:gateScenario==='two-process-admission-race'?'2':'3'}:{})}:{}),GENERAL_AGENT_DB:join(root,'gateway.db'),GENERAL_AGENT_NATIVE_WORK_ROOT:join(root,'cycle-artifacts'),GENERAL_AGENT_FILE_ROOT:join(root,'files'),GENERAL_AGENT_WORKBENCH_ROOT:join(root,'workspaces'),GENERAL_AGENT_WORKSPACES:'jot',GENERAL_AGENT_SESSION_ADAPTER_URL:adapterUrl,GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE:tokenFile,GENERAL_AGENT_HARNESS_CWD:workspace,GENERAL_AGENT_DSH_AGENT_PRESET:'jot-general',GENERAL_AGENT_DSH_SESSION_PREFIX:'jot-host-acceptance',GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:internalToken,GENERAL_AGENT_WORKER_POLL_MS:'250',...(gateScenario==='inflight-worker-exit'?{GENERAL_AGENT_WORKER_LEASE_MS:'60000'}:{}),...(maintenanceDriven?{GENERAL_AGENT_DISCOVERY_ADMISSION_ENABLED:'true'}:{}),...(role?{GENERAL_AGENT_MODEL_BUDGET_POLICY_FILE:policyFile,GENERAL_AGENT_WORKBENCH_DSH_AGENT_PRESET:'jot-workbench-budgeted',GENERAL_AGENT_WORKBENCH_EXECUTION_READY:'true',GENERAL_AGENT_WORKER_CONCURRENCY:'2'}:{}),...(workerId?{GENERAL_AGENT_WORKER_ID:workerId,JOT_ACCEPTANCE_WORKER_ID:workerId}:{})});workerProcesses.push(started);return started;};
  const discoveryCounts=()=>{
   const admissions=service.db.prepare('SELECT count(*) n FROM wb_discovery_admissions WHERE policy_id=?').get(discoveryPolicyId).n;
   const occurrences=service.db.prepare('SELECT count(*) n FROM wb_task_occurrences o JOIN wb_discovery_admissions a ON a.occurrence_id=o.occurrence_id WHERE a.policy_id=?').get(discoveryPolicyId).n;
   const runs=service.db.prepare('SELECT count(*) n FROM ga_runs r JOIN wb_task_occurrences o ON o.run_id=r.id JOIN wb_discovery_admissions a ON a.occurrence_id=o.occurrence_id WHERE a.policy_id=?').get(discoveryPolicyId).n;
    const attempts=service.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts b JOIN wb_task_occurrences o ON o.run_id=b.run_id JOIN wb_discovery_admissions a ON a.occurrence_id=o.occurrence_id WHERE a.policy_id=? AND b.state IN ('in_flight','unknown','settled')").get(discoveryPolicyId).n;
   return{admissions:Number(admissions),occurrences:Number(occurrences),runs:Number(runs),attempts:Number(attempts)};
  };
  const policyControl=async(action,key)=>{const current=service.db.prepare('SELECT version FROM wb_discovery_policies WHERE policy_id=?').get(discoveryPolicyId);const response=await fetch(discoveryPolicyUrl+'/control',{method:'POST',headers:{...headers,'idempotency-key':key},body:JSON.stringify({action,expected_version:current.version})});assert.equal(response.status,200,await response.clone().text());return response.json();};
  const traceRows=async()=>{try{return(await readFile(fetchTrace,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{return[];}};
  let accepted;
  if(cleanupOnly){
   assert.equal(discovery,true);assert.equal(maintenanceDriven,true);assert.equal(noPlan,true);
   await mkdir(observationBarrierDir,{recursive:true});
   const releasePath=join(observationBarrierDir,'release'),started=[1,2,3].map(round=>startWorker('cleanup-'+round));
   const arrivals=await cleanupAwait('cleanup-only.idle-observation-arrivals',until(async()=>{
    const values=await Promise.all(started.map(async handle=>{try{const value=JSON.parse(await readFile(join(observationBarrierDir,`arrived-${handle.child.pid}.json`),'utf8'));return value.pid===handle.child.pid?value:false;}catch{return false;}}));
    return values.every(Boolean)?values:false;
   }),()=>({worker_handles:started.map(handle=>({pid:handle.child.pid,terminal:handle.terminal()}))}));
   assert.equal(arrivals.length,3);assert.ok(arrivals.every(value=>value.path.endsWith('/idle-observation')&&value.status===200&&value.native_idle==='idle'));
   await policyControl('pause','cleanup-only-pause');await writeFile(releasePath,'continue');
   await delay(2200);assert.deepEqual(discoveryCounts(),{admissions:0,occurrences:0,runs:0,attempts:0});assert.equal(requests.length,0);
   const counts=discoveryCounts();assert.deepEqual(counts,{admissions:0,occurrences:0,runs:0,attempts:0});assert.equal(requests.length,0);
   succeeded=true;cleanupOnlyResult={...counts,model_requests:requests.length,process_count:workerProcesses.length,process_exit_count:0,sqlite_busy_count:0,sqlite_locked_count:0};return cleanupOnlyResult;
  }
  if(discovery&&maintenanceDriven){
   if(['pause-during-observation','stop-during-observation','pause-cold-restart','stop-cold-restart'].includes(gateScenario)){
    await mkdir(observationBarrierDir,{recursive:true});worker=startWorker();
    const arrived=await until(async()=>{try{return JSON.parse(await readFile(join(observationBarrierDir,'arrived.json'),'utf8'));}catch{return false;}});assert.ok(arrived.path.endsWith('/idle-observation'));assert.equal(arrived.native_idle,'idle');
    const action=gateScenario.startsWith('pause')?'pause':'stop';await policyControl(action,gateScenario);
    await writeFile(join(observationBarrierDir,'release'),'continue');
    if(gateScenario.endsWith('cold-restart')){
     const before=service.db.prepare('SELECT state,version FROM wb_discovery_policies WHERE policy_id=?').get(discoveryPolicyId);assert.equal(before.state,action==='pause'?'paused':'stopped');
     await worker.stop();worker=startWorker();await delay(3300);
     const after=service.db.prepare('SELECT state,version FROM wb_discovery_policies WHERE policy_id=?').get(discoveryPolicyId);assert.deepEqual(after,before);
     assert.deepEqual(discoveryCounts(),{admissions:0,occurrences:0,runs:0,attempts:0});assert.equal(requests.length,0);
     const evidence=await finishWorkers();t.diagnostic(JSON.stringify({maintenance_driven:true,gate:gateScenario,observation:arrived,policy:after,maintenance_observations:3,discoveryCounts:discoveryCounts()}));
     succeeded=true;return{gate:gateScenario,admissions:0,occurrences:0,runs:0,model_requests:requests.length,process_count:evidence.length,process_exit_count:evidence.filter(process=>process.terminal).length,sqlite_busy_count:evidence.reduce((n,process)=>n+process.sqlite_busy_count,0),sqlite_locked_count:evidence.reduce((n,process)=>n+process.sqlite_locked_count,0)};
    }
    await delay(2200);assert.deepEqual(discoveryCounts(),{admissions:0,occurrences:0,runs:0,attempts:0});assert.equal(requests.length,0);
    t.diagnostic(JSON.stringify({maintenance_driven:true,gate:gateScenario,observation:arrived,discoveryCounts:discoveryCounts()}));succeeded=true;return{gate:gateScenario,admissions:0,occurrences:0,runs:0};
   }
   if(gateScenario==='busy-native'){
    await discoveryClient.prompt(discoveryRoleSession,'busy-probe-request','BUSY-PROBE: hold this official Session until the fixture releases it.','queue');
    await Promise.race([busyProbeArrived.promise,delay(15000).then(()=>{throw Error('fixture_busy_probe_not_reached');})]);worker=startWorker();
    const busyTrace=await until(async()=>{const rows=await traceRows();return rows.find(row=>row.path?.endsWith('/idle-observation')&&row.native_idle==='busy')||false;});
     assert.deepEqual(discoveryCounts(),{admissions:0,occurrences:0,runs:0,attempts:0});await policyControl('pause','pause-after-native-busy');releaseBusyProbe.resolve();await delay(1200);
    assert.deepEqual(discoveryCounts(),{admissions:0,occurrences:0,runs:0,attempts:0});t.diagnostic(JSON.stringify({maintenance_driven:true,gate:gateScenario,native_observation:busyTrace,ambient_requests:ambientRequests.length}));succeeded=true;return{gate:gateScenario,admissions:0,native_idle:'busy'};
   }
   if(gateScenario==='recent-foreground-input'){
     const posted=await fetch(gatewayUrl+'/v1/conversations/'+foregroundConversationId+'/messages',{method:'POST',headers:{...headers,'idempotency-key':'foreground-probe'},body:JSON.stringify({client_message_id:'foreground-probe',content:[{type:'text',text:'FOREGROUND-PROBE: recent owner input must hold discovery admission.'}]})});assert.equal(posted.status,202,await posted.clone().text());const foreground=await posted.json();worker=startWorker();
    const finished=await until(async()=>{const run=await(await fetch(gatewayUrl+'/v1/runs/'+foreground.run_id,{headers})).json();return ['succeeded','failed','interrupted'].includes(run.status)&&run;});assert.equal(finished.status,'succeeded',JSON.stringify(finished));
     await delay(1500);assert.ok((await traceRows()).some(row=>row.native_idle==='idle'),'recent-input gate must observe the settled native Session as idle');assert.deepEqual(discoveryCounts(),{admissions:0,occurrences:0,runs:0,attempts:0});assert.equal(ambientRequests.length,1);
    await policyControl('pause','pause-after-foreground-input');await delay(1200);assert.deepEqual(discoveryCounts(),{admissions:0,occurrences:0,runs:0,attempts:0});
    t.diagnostic(JSON.stringify({maintenance_driven:true,gate:gateScenario,foreground_run:foreground.run_id,discoveryCounts:discoveryCounts()}));succeeded=true;return{gate:gateScenario,admissions:0,foreground_run_status:finished.status};
   }
   if(gateScenario==='two-process-admission-race'){
    await mkdir(observationBarrierDir,{recursive:true});const first=startWorker('m08-08-admission-a');worker=startWorker('m08-08-admission-b');
    const arrivals=await until(async()=>{const files=(await readdir(observationBarrierDir)).filter(name=>/^arrived-\d+\.json$/.test(name));if(files.length<2)return false;return Promise.all(files.sort().map(async name=>JSON.parse(await readFile(join(observationBarrierDir,name),'utf8'))));});
    assert.equal(arrivals.length,2);assert.equal(new Set(arrivals.map(item=>item.pid)).size,2);assert.equal(new Set(arrivals.map(item=>item.worker_id)).size,2);assert.ok(arrivals.every(item=>item.native_idle==='idle'));barrierArrivals=arrivals.length;
    await writeFile(join(observationBarrierDir,'release'),'continue');await delay(2200);const counts=discoveryCounts();assert.equal(counts.admissions,1);assert.equal(counts.occurrences,1);assert.equal(counts.runs,1);
    await Promise.race([acceptedModelArrived.promise,delay(15000).then(()=>{throw Error('fixture_race_model_request_not_reached');})]);assert.equal(requests.length,1,'only one competing Worker may dispatch the admitted run');
    const raceAdmission=await until(()=>service.db.prepare('SELECT admission_id,occurrence_id FROM wb_discovery_admissions WHERE policy_id=?').get(discoveryPolicyId));const racedRunId=service.db.prepare('SELECT run_id FROM wb_task_occurrences WHERE occurrence_id=?').get(raceAdmission.occurrence_id).run_id;const lease=await until(()=>service.db.prepare('SELECT owner,generation FROM ga_worker_leases WHERE resource_id=?').get(racedRunId));assert.ok(['m08-08-admission-a','m08-08-admission-b'].includes(lease.owner));raceLeaseEvidence={worker_id:lease.owner,generation:lease.generation};releaseAcceptedModel.resolve();
    t.diagnostic(JSON.stringify({maintenance_driven:true,gate:gateScenario,barrier_arrivals:arrivals,lease:raceLeaseEvidence,discoveryCounts:counts}));
   }else{fixtureCheckpoint='maintenance_worker_start';worker=startWorker();}
   if(gateScenario==='inflight-worker-exit'||gateScenario==='lease-invalidated'||gateScenario==='unknown-no-replay'||gateScenario==='unknown-no-replay-cold-restart'){
    fixtureCheckpoint='discovery_admission_wait';const admission=await until(()=>service.db.prepare('SELECT admission_id,occurrence_id,signal_revision FROM wb_discovery_admissions WHERE policy_id=?').get(discoveryPolicyId));assert.equal(admission.signal_revision,1);
    accepted=service.db.prepare('SELECT o.run_id,o.conversation_id,a.occurrence_id FROM wb_task_occurrences o JOIN wb_discovery_admissions a ON a.occurrence_id=o.occurrence_id WHERE a.admission_id=?').get(admission.admission_id);assert.ok(accepted);
    if(gateScenario==='inflight-worker-exit'){
     await Promise.race([acceptedModelArrived.promise,delay(15000).then(()=>{throw Error('inflight_model_not_reached');})]);
     const lease=service.db.prepare('SELECT owner,generation,expires_at FROM ga_worker_leases WHERE resource_id=?').get(accepted.run_id);assert.ok(lease);assert.ok(Number(lease.expires_at)>Date.now());
     const identity={...accepted},before=discoveryCounts();assert.deepEqual(before,{admissions:1,occurrences:1,runs:1,attempts:1});
     await worker.stop();worker=startWorker('m08-inflight-replacement');await delay(1500);
     assert.equal(requests.length,1);assert.deepEqual(discoveryCounts(),before);
     assert.deepEqual(service.db.prepare('SELECT owner,generation,expires_at FROM ga_worker_leases WHERE resource_id=?').get(accepted.run_id),lease,'a live lease must fence the replacement');
     await delay(Math.max(0,Number(lease.expires_at)-Date.now()+300));
     await until(()=>Number(service.db.prepare('SELECT generation FROM ga_worker_leases WHERE resource_id=?').get(accepted.run_id)?.generation)>Number(lease.generation));releaseAcceptedModel.resolve();
     const recovered=await until(()=>{const value=service.runs.get(accepted.run_id,'acceptance-owner');return ['interrupted','failed','waiting_user','waiting_approval','succeeded'].includes(value?.status)&&value;});
     assert.equal(requests.length,1,'ambiguous in-flight model call must not be replayed');assert.deepEqual(discoveryCounts(),before);
     assert.equal(recovered.status,'interrupted');assert.equal(recovered.error_code,'OUTCOME_UNKNOWN');
     const occurrence=service.db.prepare('SELECT run_id,conversation_id,occurrence_id FROM wb_task_occurrences WHERE occurrence_id=?').get(identity.occurrence_id);assert.deepEqual({...occurrence},identity);
     releaseAcceptedModel.resolve();const evidence=await finishWorkers();
     t.diagnostic(JSON.stringify({gate:gateScenario,identity,original_lease:lease,recovered_status:recovered.status,error_code:recovered.error_code,counts:discoveryCounts(),model_requests:requests.length,processes:evidence}));
     succeeded=true;return {model_requests:requests.length,admissions:1,occurrences:1,runs:1,process_count:evidence.length,run_status:recovered.status};
    }
    if(gateScenario==='lease-invalidated'){
     await acceptedModelArrived.promise;const lease=service.db.prepare('SELECT owner,generation FROM ga_worker_leases WHERE resource_id=?').get(accepted.run_id);assert.ok(lease,'original worker must hold its coordinator lease before policy cancellation');
     await policyControl('pause','pause-inflight-worker');await until(()=>service.runs.get(accepted.run_id,'acceptance-owner')?.status==='cancelling');releaseAcceptedModel.resolve();
     const stopped=await until(async()=>{const run=await(await fetch(gatewayUrl+'/v1/runs/'+accepted.run_id,{headers})).json();return ['interrupted','cancelled','failed','succeeded'].includes(run.status)&&run;});assert.notEqual(stopped.status,'succeeded',JSON.stringify(stopped));await delay(2200);
     assert.equal(service.db.prepare('SELECT count(*) n FROM ga_worker_leases WHERE resource_id=?').get(accepted.run_id).n,0);assert.deepEqual(discoveryCounts().admissions,1);assert.equal(requests.length,1);
     t.diagnostic(JSON.stringify({maintenance_driven:true,gate:gateScenario,run_status:stopped.status,reason_code:stopped.reason_code,lease_generation:lease.generation,model_requests:requests.length}));succeeded=true;return{gate:gateScenario,run_status:stopped.status,admissions:1};
    }
    const stopped=await until(async()=>{const run=await(await fetch(gatewayUrl+'/v1/runs/'+accepted.run_id,{headers})).json();return ['interrupted','failed','succeeded'].includes(run.status)&&run;});
     assert.equal(stopped.error_code,'OUTCOME_UNKNOWN',JSON.stringify(stopped));await delay(2200);assert.deepEqual(discoveryCounts(),{admissions:1,occurrences:1,runs:1,attempts:1});assert.equal(requests.length,1);
    if(gateScenario==='unknown-no-replay-cold-restart'){
     const beforeStates=service.db.prepare('SELECT state FROM wb_model_budget_attempts WHERE run_id=?').all(accepted.run_id).map(row=>row.state).sort();assert.equal(beforeStates.filter(state=>state==='unknown').length,1);assert.ok(beforeStates.every(state=>state==='unknown'||state==='released'));
     await worker.stop();worker=startWorker();await delay(3300);assert.deepEqual(discoveryCounts(),{admissions:1,occurrences:1,runs:1,attempts:1});assert.equal(requests.length,1);
     const afterRun=await (await fetch(gatewayUrl+'/v1/runs/'+accepted.run_id,{headers})).json();assert.equal(afterRun.error_code,'OUTCOME_UNKNOWN');const afterStates=service.db.prepare('SELECT state FROM wb_model_budget_attempts WHERE run_id=?').all(accepted.run_id).map(row=>row.state).sort();assert.deepEqual(afterStates,beforeStates);
     assert.equal(service.db.prepare('SELECT count(*) n FROM wb_discovery_reports').get().n,0);assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_finalizations').get().n,0);
     const evidence=await finishWorkers();t.diagnostic(JSON.stringify({maintenance_driven:true,gate:gateScenario,run_status:afterRun.status,reason_code:afterRun.error_code,occurrence_status:service.db.prepare('SELECT status FROM wb_task_occurrences WHERE occurrence_id=?').get(accepted.occurrence_id).status,model_requests:requests.length,unknown_attempts:1,maintenance_observations:3}));
     succeeded=true;return{gate:gateScenario,run_status:afterRun.status,reason_code:afterRun.error_code,admissions:1,occurrences:1,runs:1,model_requests:requests.length,process_count:evidence.length,process_exit_count:evidence.filter(process=>process.terminal).length,sqlite_busy_count:evidence.reduce((n,process)=>n+process.sqlite_busy_count,0),sqlite_locked_count:evidence.reduce((n,process)=>n+process.sqlite_locked_count,0)};
    }
    t.diagnostic(JSON.stringify({maintenance_driven:true,gate:gateScenario,run_status:stopped.status,reason_code:stopped.reason_code,occurrence_status:service.db.prepare('SELECT status FROM wb_task_occurrences WHERE occurrence_id=?').get(accepted.occurrence_id).status,model_requests:requests.length}));succeeded=true;return{gate:gateScenario,run_status:stopped.status,reason_code:stopped.reason_code,admissions:1};
   }
   const admission=await until(()=>service.db.prepare('SELECT admission_id,occurrence_id,signal_revision FROM wb_discovery_admissions WHERE policy_id=?').get(discoveryPolicyId));assert.equal(admission.signal_revision,1);
   accepted=service.db.prepare('SELECT o.run_id,o.conversation_id,a.occurrence_id FROM wb_task_occurrences o JOIN wb_discovery_admissions a ON a.occurrence_id=o.occurrence_id WHERE a.admission_id=?').get(admission.admission_id);assert.ok(accepted);
  }else if(discovery){const receipt=await admitFresh();assert.equal(receipt.admitted,true,JSON.stringify(receipt));accepted=service.db.prepare('SELECT run_id,conversation_id,occurrence_id FROM wb_task_occurrences WHERE occurrence_id=?').get(receipt.occurrence_id);assert.ok(accepted);}
  else{const posted=await postMessage();assert.equal(posted.status,202);accepted=await posted.json();}
  const run_id=accepted.run_id;if(persistent)conversation_id=accepted.conversation_id;
  if(!worker){fixtureCheckpoint='original_worker_start';worker=startWorker();}
  if(persistent&&['task-pause-inflight','task-archive-inflight'].includes(gateScenario)){
   await Promise.race([acceptedModelArrived.promise,delay(30000).then(()=>{throw Error('task_model_request_not_reached');})]);
   const task=service.persistentTasks.list('acceptance-owner').items[0],controlAction=gateScenario==='task-pause-inflight'?'pause':'archive',expectedTaskStatus=controlAction==='pause'?'paused':'archived',before=service.db.prepare("SELECT count(*) n FROM ga_run_commands WHERE run_id=? AND kind='cancel'").get(run_id).n;
   const controlled=await fetch(gatewayUrl+'/v1/persistent-tasks/'+task.task_id+'/'+controlAction,{method:'POST',headers:{...headers,'idempotency-key':'task-'+controlAction+'-inflight'},body:JSON.stringify({expected_version:task.version})});assert.equal(controlled.status,200,await controlled.clone().text());const controlReceipt=await controlled.json();assert.equal(controlReceipt.status,expectedTaskStatus);
   const cancelling=await until(()=>['cancelling','cancelled'].includes(service.runs.get(run_id,'acceptance-owner')?.status));assert.equal(cancelling,true);
   const cancellation=service.db.prepare("SELECT id,status,idempotency_key FROM ga_run_commands WHERE run_id=? AND kind='cancel'").get(run_id);assert.ok(cancellation);assert.equal(before,0);
   await until(async()=>{const value=service.db.prepare('SELECT status FROM ga_run_commands WHERE id=?').get(cancellation.id);return value?.status==='applied'&&service.runs.get(run_id,'acceptance-owner')?.status==='cancelled';});
    releaseAcceptedModel.resolve();await delay(1600);
    const pastDueAt=new Date(Date.now()-60000).toISOString();service.db.prepare('UPDATE wb_persistent_tasks SET next_due_at=? WHERE task_id=?').run(pastDueAt,task.task_id);
    await worker.stop();worker=startWorker('m09.05-control-restart');await delay(1800);
    await service.persistentTasks.tick();await service.persistentTasks.tick();
   const commands=service.db.prepare("SELECT id,status,idempotency_key FROM ga_run_commands WHERE run_id=? AND kind='cancel'").all(run_id),recoveredRun=service.runs.get(run_id,'acceptance-owner');
   assert.equal(recoveredRun.status,'cancelled');
   assert.equal(commands.length,1);assert.equal(commands[0].id,cancellation.id);assert.equal(commands[0].status,'applied');assert.equal(requests.length,1);
   assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_occurrences WHERE task_id=?').get(task.task_id).n,1);
   assert.equal(service.db.prepare('SELECT count(*) n FROM ga_runs WHERE conversation_id=?').get(conversation_id).n,1);
   const occurrence=service.db.prepare('SELECT occurrence_id,run_id,status FROM wb_task_current_occurrences WHERE task_id=?').get(task.task_id);assert.equal(occurrence.run_id,run_id);
   assert.equal(service.persistentTasks.list('acceptance-owner').items[0].status,expectedTaskStatus);
   const sessionId=JSON.parse(await readFile(join(root,'composition.json'),'utf8')).sessionId;
   const sdkCancelRequests=(await readFile(fetchTrace,'utf8')).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.path==='/v1/sessions/'+sessionId+'/cancel');assert.equal(sdkCancelRequests.length,1);assert.equal(sdkCancelRequests[0].status,202);
    const evidence=await finishWorkers();t.diagnostic(JSON.stringify({gate:gateScenario,task_id:task.task_id,run_id,occurrence,control_action:controlAction,control_status:controlReceipt.status,run_status:recoveredRun.status,cancel_command:commands[0].id,cancel_status:commands[0].status,sdk_cancel_requests:sdkCancelRequests.length,model_requests:requests.length,past_due_at:pastDueAt,worker_restarts:1,workers:evidence}));
    succeeded=true;return{task_status:expectedTaskStatus,control_action:controlAction,run_status:recoveredRun.status,cancel_commands:commands.length,cancel_status:commands[0].status,sdk_cancel_requests:sdkCancelRequests.length,model_requests:requests.length,occurrences:1,worker_restarts:1,process_count:evidence.length};
  }
  fixtureCheckpoint='original_run_wait';const run=await until(async()=>{if(modelFailure)throw modelFailure;assert.equal(worker.terminal(),false,'official gateway worker exited');const current=await (await fetch(gatewayUrl+'/v1/runs/'+run_id,{headers})).json();if(['succeeded','failed','interrupted','waiting_user','waiting_approval'].includes(current.status))return current;return false;});
  assert.equal(run.status,complete&&!discoveryWait?'waiting_approval':persistent?'waiting_user':'succeeded',JSON.stringify(run));const initialCalls=discoveryWait?3:discovery?(noPlan?5:6):complete||automatic?3:1;assert.equal(requests.length,initialCalls);assert.equal(requests[0].model,'deepseek-flash');
  assert.ok(requests[0].dsh_plugin_packages.packages.some(item=>item.name==='jot-dsh-host-preparation'&&item.version==='0.1.0'));
  const composition=JSON.parse(await readFile(join(root,'composition.json'),'utf8'));
  assert.equal(composition.preset,role?'jot-workbench-budgeted':'jot-general');assert.equal(composition.mounted,true);assert.equal(composition.approval,'ask');assert.equal(composition.permission,'workspace-write');assert.equal(composition.sandbox.workspaceRoot,workspace);
  assert.deepEqual(composition.model,{provider:'deepseek-official',model:'deepseek-flash'});
  assert.equal(composition.events.filter(event=>event.sourceRpcId===run_id).length,1);
  const ended=composition.events.findLast(event=>event.type==='turn/end')?.reason;
  if(persistent){assert.equal(ended.kind,'error');assert.equal(ended.error.message,'workbench_goal_stopped');}
  else assert.equal(ended.kind,'completed');
  assert.ok(JSON.stringify(requests[0].messages).includes(discovery?'discovery_signal_batch':complete?'Write acceptance.md':persistent?'Ask the user to confirm':'ACCEPTANCE-OK'));
  const snapshotResponse=await fetch(gatewayUrl+'/v1/conversations/'+conversation_id+'/snapshot',{headers}),snapshot=await snapshotResponse.json();assert.equal(snapshotResponse.status,200,JSON.stringify(snapshot));assert.ok(Array.isArray(snapshot.messages),'snapshot response must contain messages');
  const replies=snapshot.messages.filter(message=>message.role==='assistant'&&message.status==='complete');assert.equal(replies.length,persistent?0:1);if(!persistent)assert.ok(JSON.stringify(replies[0]).includes('ACCEPTANCE-OK'));
  if(persistent)assert.equal(service.db.prepare("SELECT count(*) n FROM ga_messages WHERE run_id=? AND role='assistant'").get(run_id).n,0);
  if(persistent){const cards=await (await fetch(gatewayUrl+'/v1/conversations/'+conversation_id+'/interactions',{headers})).json();assert.ok(cards.items.length>0);assert.ok(service.db.prepare('SELECT checkpoint_id FROM ga_runs WHERE id=?').get(run_id).checkpoint_id);
   const response=await fetch(adapterUrl+'/v1/sessions/'+composition.sessionId+'/goal-status',{method:'POST',headers:{authorization:'Bearer '+adapterToken,'content-type':'application/json'},body:'{}'});const observed=await response.json();assert.equal(response.status,200,JSON.stringify(observed));assert.equal(observed.state.goal.phase,'paused');assert.equal(observed.state.goal.activation,'disarmed');assert.equal(observed.state.host_status,'idle');assert.equal(observed.state.task.run_status,complete&&!discoveryWait?'waiting_approval':'waiting_user');
   if(automatic){const changes=composition.events.filter(event=>event.goalRound!==undefined);assert.equal(changes[0].goalRound,0);assert.equal(observed.state.goal.rounds_started,changes[0].goalRound+1);const ends=composition.events.filter(event=>event.type==='turn/end');assert.equal(ends.length,2);assert.equal(ends[0].reason.kind,'completed');assert.equal(service.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_run_commands').get().n,0);}
  }
  if(discovery&&maintenanceDriven){await delay(2200);assert.equal(discoveryCounts().admissions,1);assert.equal(discoveryCounts().occurrences,1);assert.equal(requests.length,initialCalls);}
  else if(discovery){assert.equal((await discoveryController.admit('acceptance-owner',discoveryScope)).admitted,false);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(requests.length,initialCalls);}
  else{const retry=await postMessage();const retried=await retry.json();assert.equal(retry.status,202,JSON.stringify(retried));assert.equal(retried.run_id,run_id);assert.equal(requests.length,initialCalls);}
  const checkBudget=(runId,calls)=>{const balances=service.modelBudgets.balancesForRun('acceptance-owner',runId);assert.ok(balances.length>0);for(const balance of balances){assert.equal(balance.used.tokens,String(calls*6));assert.equal(balance.used.model_calls,String(calls));assert.equal(balance.held.tokens,'0');assert.equal(balance.held.model_calls,'0');}};
  if(role){const settled=service.db.prepare("SELECT actual_tokens FROM wb_model_budget_attempts WHERE run_id=? AND state='settled'").all(run_id);assert.equal(settled.length,initialCalls);assert.ok(settled.every(value=>Number(value.actual_tokens)===6));assert.equal(service.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts WHERE run_id=? AND state IN ('reserved','in_flight','unknown')").get(run_id).n,0);checkBudget(run_id,initialCalls);}
  if(complete&&!discovery){
   const card=(await (await fetch(gatewayUrl+'/v1/conversations/'+conversation_id+'/interactions',{headers})).json()).items[0];assert.equal(card.purpose,'task_acceptance_review');assert.equal(card.questions.length,1);
   const file=service.db.prepare('SELECT owner_id,workspace_id,project_id,path FROM wb_files WHERE path=?').get('acceptance.md');assert.ok(file);assert.equal(service.workbench.readFile(file.owner_id,file.workspace_id,file.project_id,file.path).content,'ACCEPTANCE-OK');
   assert.equal(service.artifacts.listForRun(run_id,'acceptance-owner').items.length,0);
   // A later authorized owner edit must not replace the already reviewed version.
   service.workbench.writeFile(file.owner_id,file.workspace_id,{project_id:file.project_id,path:file.path,content:'Later owner replacement',expected_version:1});
   const reviewUrl=gatewayUrl+'/v1/interactions/'+card.interaction_id+'/outputs';
   const previewList=await fetch(reviewUrl,{headers});assert.equal(previewList.status,200);const previewFiles=(await previewList.json()).items;assert.equal(previewFiles.length,1);assert.equal(previewFiles[0].version,1);
   const previewBytes=await fetch(reviewUrl+'/0',{headers});assert.equal(previewBytes.status,200);assert.equal(await previewBytes.text(),'ACCEPTANCE-OK');assert.equal(previewFiles[0].sha256,createHash('sha256').update('ACCEPTANCE-OK').digest('hex'));
   assert.equal((await fetch(reviewUrl+'/0',{headers:{...headers,'x-user-id':'foreign-owner'}})).status,404);assert.equal(service.artifacts.listForRun(run_id,'acceptance-owner').items.length,0);
   assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_execution_receipts').get().n,1);assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_business_certificates').get().n,0);
   const post=(extraHeaders={})=>fetch(gatewayUrl+'/v1/interactions/'+card.interaction_id+'/response',{method:'POST',headers:{...headers,'idempotency-key':'accept-business-criteria',...extraHeaders},body:JSON.stringify({expected_version:card.version,answers:card.questions.map(question=>({question_id:question.question_id,selected_option_ids:['accept'],custom_text:''}))})});
   assert.equal((await post({'x-user-id':'foreign-owner'})).status,404);assert.equal((await post({origin:'https://untrusted.invalid'})).status,403);
   assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_business_certificates').get().n,0);assert.equal(service.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
   const acceptedReview=await post(),review=await acceptedReview.json();assert.equal(acceptedReview.status,202,JSON.stringify(review));
   assert.equal((await fetch(reviewUrl+'/0',{headers})).status,409);
   const finished=await until(async()=>{const value=await (await fetch(gatewayUrl+'/v1/runs/'+run_id,{headers})).json();return value.status==='succeeded'&&value;});assert.equal(finished.status,'succeeded');assert.equal(requests.length,3);
   const retriedReview=await post();assert.equal(retriedReview.status,202);assert.deepEqual(await retriedReview.json(),review);
   const delivered=await (await fetch(gatewayUrl+'/v1/conversations/'+conversation_id+'/snapshot',{headers})).json();const published=delivered.messages.filter(message=>message.role==='assistant'&&message.status==='complete');assert.equal(published.length,1);assert.ok(JSON.stringify(published[0].blocks).includes('ACCEPTANCE-OK'));checkBudget(run_id,3);
   assert.equal(delivered.artifacts.length,1);const artifact=delivered.artifacts[0];assert.deepEqual(published[0].attachments,[artifact.artifact_id]);assert.equal(artifact.run_id,run_id);assert.equal(artifact.version,1);assert.equal(artifact.sha256,createHash('sha256').update('ACCEPTANCE-OK').digest('hex'));
   const downloaded=await fetch(gatewayUrl+'/v1/artifacts/'+artifact.artifact_id+'/download?version=1',{headers});assert.equal(downloaded.status,200);assert.equal(await downloaded.text(),'ACCEPTANCE-OK');
   assert.equal((await fetch(gatewayUrl+'/v1/artifacts/'+artifact.artifact_id+'/download?version=1',{headers:{...headers,'x-user-id':'foreign-owner'}})).status,404);
   assert.equal(service.db.prepare('SELECT count(*) n FROM ga_run_artifacts WHERE run_id=?').get(run_id).n,1);
   assert.equal(service.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_finalizations').get().n,1);
   const proof=JSON.parse(service.db.prepare('SELECT proof_json FROM wb_task_native_completions').get().proof_json);assert.equal(proof.goal.phase,'complete');assert.equal(proof.goal.activation,'disarmed');assert.equal(proof.checkpoint.session_ref,composition.sessionId);
  }
  let completionRun=run_id,completedCalls=initialCalls;
  const budgetScopeIds=runId=>{const row=service.db.prepare('SELECT scopes_json FROM wb_model_budget_bindings WHERE run_id=?').get(runId);assert.ok(row,'each run must retain a model budget binding');return JSON.parse(row.scopes_json).sort();};
  const originalBudgetScopeIds=discoveryWait?budgetScopeIds(run_id):null;
  if(discoveryWait){
   const originalTaskId=service.db.prepare('SELECT task_id FROM wb_task_occurrences WHERE run_id=?').get(run_id).task_id;
   assert.equal(service.db.prepare('SELECT count(*) n FROM wb_discovery_reports').get().n,0);
   assert.equal(service.db.prepare('SELECT count(*) n FROM wb_discovery_source_reads').get().n,0);
   assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_completion_candidates').get().n,0);
   const card=(await (await fetch(gatewayUrl+'/v1/conversations/'+conversation_id+'/interactions',{headers})).json()).items[0];assert.equal(card.purpose,'task_input');
   const nativeState=async()=>{const response=await fetch(adapterUrl+'/v1/sessions/'+composition.sessionId+'/goal-status',{method:'POST',headers:{authorization:'Bearer '+adapterToken,'content-type':'application/json'},body:'{}'});assert.equal(response.status,200);return (await response.json()).state;};
   const beforeWait=await nativeState();assert.equal(beforeWait.goal.phase,'paused');assert.equal(beforeWait.host_status,'idle');
   await worker.stop();assert.equal(worker.terminal(),true);await writeFile(sourceBlob,sourceBytes);
   const answer=()=>fetch(gatewayUrl+'/v1/interactions/'+card.interaction_id+'/response',{method:'POST',headers:{...headers,'idempotency-key':'restore-discovery-source'},body:JSON.stringify({expected_version:card.version,answers:[{question_id:'task-input',selected_option_ids:[],custom_text:'The original source bytes have been restored. Retry the pinned source.'}]})});
   const answered=await answer(),receipt=await answered.json();assert.equal(answered.status,202,JSON.stringify(receipt));const replay=await answer();assert.equal(replay.status,202);assert.deepEqual(await replay.json(),receipt);
   const children=service.db.prepare('SELECT id,checkpoint_id FROM ga_runs WHERE continuation_of=?').all(run_id);assert.equal(children.length,1);completionRun=children[0].id;assert.ok(children[0].checkpoint_id);
   assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,1);assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_occurrences WHERE task_id=?').get(originalTaskId).n,1);assert.equal(service.persistentTasks.list('acceptance-owner').items[0].task_id,originalTaskId);assert.equal(requests.length,initialCalls);assert.deepEqual(budgetScopeIds(completionRun),originalBudgetScopeIds,'cold continuation must retain the original task budget scope set');
   fixtureCheckpoint='cold_continuation_worker_start';worker=startWorker();
   fixtureCheckpoint='cold_continuation_run_wait';const waiting=await until(async()=>{if(modelFailure)throw modelFailure;const value=await (await fetch(gatewayUrl+'/v1/runs/'+completionRun,{headers})).json();return ['waiting_approval','waiting_user','failed','interrupted','succeeded'].includes(value.status)&&value;});
   assert.equal(waiting.status,'waiting_approval',JSON.stringify(waiting));fixtureCheckpoint='cold_continuation_waiting_approval';completedCalls=7;assert.equal(requests.length,completedCalls);assert.equal(service.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts WHERE run_id=? AND state='settled'").get(completionRun).n,completedCalls-initialCalls);assert.equal(service.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts WHERE run_id=? AND state IN ('reserved','in_flight','unknown')").get(completionRun).n,0);
   const continued=JSON.parse(await readFile(join(root,'composition.json'),'utf8'));assert.equal(continued.sessionId,composition.sessionId);assert.equal(continued.events.filter(e=>e.sourceRpcId===completionRun).length,1);
   const afterWait=await nativeState();assert.equal(afterWait.goal.goal_id,beforeWait.goal.goal_id);assert.ok(afterWait.goal.goal_revision>beforeWait.goal.goal_revision);assert.equal(afterWait.goal.phase,'paused');assert.equal(afterWait.goal.activation,'disarmed');
   assert.equal(occurrences(userTexts(requests[3]).join('\n'),'The original source bytes have been restored.'),1);checkBudget(completionRun,completedCalls);
  }
  if(discovery){
   const report=service.db.prepare('SELECT report_id,payload_sha256,payload_json FROM wb_discovery_reports').get(),plan=service.db.prepare('SELECT plan_id FROM wb_discovery_plans').get();assert.ok(report);if(noPlan)assert.equal(plan,undefined);else assert.ok(plan);
   assert.deepEqual(JSON.parse(report.payload_json).plan_ids,noPlan?[]:[plan.plan_id]);assert.equal(JSON.parse(report.payload_json).outcome,noPlan?'no_plan':'proposals');assert.deepEqual(JSON.parse(report.payload_json).coverage,{signal_count:1,fully_read:1});
   const frozen=JSON.parse(service.db.prepare('SELECT snapshot_json FROM wb_task_completion_candidates WHERE run_id=?').get(completionRun).snapshot_json);assert.equal(frozen.discovery_report.report_id,report.report_id);assert.equal(frozen.discovery_report.sha256,report.payload_sha256);
   assert.equal(service.db.prepare('SELECT count(*) n FROM wb_file_write_runs WHERE run_id=?').get(run_id).n,0);assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_business_certificates').get().n,0);
   const initialInteractionsResponse=await fetch(gatewayUrl+'/v1/conversations/'+conversation_id+'/interactions',{headers});assert.equal(initialInteractionsResponse.status,200);const initialInteractions=await initialInteractionsResponse.json();assert.ok(Array.isArray(initialInteractions.items));assert.equal(initialInteractions.items.length,1);const card=initialInteractions.items[0];assert.equal(card.status,'pending');assert.equal(card.purpose,'task_acceptance_review');assert.equal(card.run_id,completionRun);const initialInteractionRow=service.db.prepare('SELECT conversation_id,run_id,status FROM ga_interactions WHERE id=?').get(card.interaction_id);assert.ok(initialInteractionRow);assert.equal(initialInteractionRow.conversation_id,conversation_id);assert.equal(initialInteractionRow.run_id,completionRun);assert.equal(initialInteractionRow.status,'pending');
   if(noPlan){await worker.stop();assert.equal(worker.terminal(),true);}
   const review=await fetch(gatewayUrl+'/v1/interactions/'+card.interaction_id+'/response',{method:'POST',headers:{...headers,'idempotency-key':'accept-discovery'},body:JSON.stringify({expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))})});assert.equal(review.status,202,await review.clone().text());
   if(noPlan){assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_business_certificates').get().n,1);assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_finalizations').get().n,0);const {observeDiscoveryDormancy}=await import('../../gateway/src/always-on/dormancy.ts');assert.equal(observeDiscoveryDormancy(service.db,'acceptance-owner',service.db.prepare('SELECT policy_id FROM wb_discovery_policies').get().policy_id).state,'none','owner review without native publication cannot establish dormancy');worker=startWorker();}
   await until(async()=>{const result=await (await fetch(gatewayUrl+'/v1/runs/'+completionRun,{headers})).json();return result.status==='succeeded';});
   const delivered=await (await fetch(gatewayUrl+'/v1/conversations/'+conversation_id+'/snapshot',{headers})).json();assert.equal(delivered.messages.filter(m=>m.role==='assistant'&&m.status==='complete').length,1);assert.equal(delivered.artifacts.length,0);checkBudget(completionRun,completedCalls);
   const historyUrl=gatewayUrl+'/v1/agents/'+roleAgent.agent_id+'/discovery-history';
   const historyResponse=await fetch(historyUrl,{headers}),history=await historyResponse.json();assert.equal(historyResponse.status,200,JSON.stringify(history.error));assert.equal(history.execution_authorized,false);assert.equal(history.items.length,1);
   assert.equal(history.items[0].accepted,true,'history must recognize actual native SDK completion, not only fixture status');assert.equal(history.items[0].run.run_id,completionRun);assert.equal(history.items[0].report.report_id,report.report_id);assert.equal(history.items[0].report.sha256,report.payload_sha256);
   const detailResponse=await fetch(historyUrl+'/'+history.items[0].admission_id,{headers}),detail=await detailResponse.json();assert.equal(detailResponse.status,200,JSON.stringify(detail.error));assert.equal(detail.cycle.accepted,true);assert.equal(detail.report.report_id,report.report_id);assert.equal(detail.plans.length,noPlan?0:1);assert.equal(detail.execution_authorized,false);
   assert.equal((await fetch(historyUrl,{headers:{...headers,'x-user-id':'foreign-owner'}})).status,404);
   if(gateScenario==='two-process-admission-race'){
    assert.equal(noPlan,true);assert.equal(service.db.prepare('SELECT count(*) n FROM wb_discovery_reports').get().n,1);assert.equal(service.db.prepare('SELECT count(*) n FROM wb_discovery_plans').get().n,0);
    const interactionUrl=gatewayUrl+'/v1/conversations/'+conversation_id+'/interactions';const pendingInteractionsResponse=await fetch(interactionUrl,{headers});assert.equal(pendingInteractionsResponse.status,200);const pendingInteractions=await pendingInteractionsResponse.json();assert.deepEqual(pendingInteractions,{items:[]});const allInteractionsResponse=await fetch(interactionUrl+'?status=all',{headers});assert.equal(allInteractionsResponse.status,200);const allInteractions=await allInteractionsResponse.json();assert.ok(Array.isArray(allInteractions.items));const answeredCards=allInteractions.items.filter(item=>item.interaction_id===card.interaction_id);assert.equal(answeredCards.length,1);const answeredCard=answeredCards[0];assert.equal(answeredCard.purpose,'task_acceptance_review');assert.equal(answeredCard.status,'answered');assert.equal(answeredCard.run_id,history.items[0].run.run_id);const resolvedInteractionRow=service.db.prepare('SELECT conversation_id,run_id,status FROM ga_interactions WHERE id=?').get(answeredCard.interaction_id);assert.ok(resolvedInteractionRow);assert.equal(resolvedInteractionRow.conversation_id,conversation_id);assert.equal(resolvedInteractionRow.run_id,history.items[0].run.run_id);assert.equal(resolvedInteractionRow.status,'answered');const associatedRun=service.db.prepare('SELECT conversation_id,status FROM ga_runs WHERE id=?').get(resolvedInteractionRow.run_id);assert.ok(associatedRun);assert.equal(associatedRun.conversation_id,conversation_id);assert.equal(associatedRun.status,'succeeded');t.diagnostic(JSON.stringify({m08_08_review_interaction_lifecycle:{initial_http:initialInteractionsResponse.status,initial_status:card.status,post_accept_pending_http:pendingInteractionsResponse.status,pending_count:pendingInteractions.items.length,all_http:allInteractionsResponse.status,all_count:allInteractions.items.length,resolved_status:answeredCard.status,run_status:associatedRun.status,conversation_matches_run:associatedRun.conversation_id===resolvedInteractionRow.conversation_id}}));
    const raceAdmission=service.db.prepare('SELECT admission_id,occurrence_id,signal_revision FROM wb_discovery_admissions WHERE admission_id=?').get(history.items[0].admission_id);const evidence=await finishWorkers();t.diagnostic(JSON.stringify({maintenance_driven:true,gate:gateScenario,barrier_arrivals:barrierArrivals,lease:raceLeaseEvidence,admission_id:raceAdmission.admission_id,occurrence_id:raceAdmission.occurrence_id,signal_revision:raceAdmission.signal_revision,run_id:history.items[0].run.run_id,report_id:history.items[0].report.report_id,report_sha256:history.items[0].report.sha256,model_requests:requests.length}));
    succeeded=true;return{admissions:1,occurrences:1,runs:1,reports:1,model_requests:requests.length,barrier_arrivals:barrierArrivals,lease_owner:raceLeaseEvidence.worker_id,lease_generation:raceLeaseEvidence.generation,process_count:evidence.length,process_exit_count:evidence.filter(process=>process.terminal).length,sqlite_busy_count:evidence.reduce((n,process)=>n+process.sqlite_busy_count,0),sqlite_locked_count:evidence.reduce((n,process)=>n+process.sqlite_locked_count,0)};
   }
   if(!noPlan){
    const {WorkCycles}=await import('../../gateway/src/always-on/work-cycles.ts'),cycles=new WorkCycles(service.db);
    const admission=service.db.prepare('SELECT * FROM wb_discovery_admissions WHERE admission_id=?').get(detail.cycle.admission_id);
    const counts=()=>['ga_runs','wb_task_occurrences','wb_model_budget_attempts','wb_budget_allocations'].map(table=>service.db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
    const before=counts(),calls=requests.length,request={admission_id:admission.admission_id,report_sha256:report.payload_sha256,plan_ids:detail.plans.map(p=>p.plan_id),expected_policy_version:admission.policy_version,expected_role_version:admission.role_version,expected_role_epoch:admission.role_epoch};
    const cycle=cycles.create('acceptance-owner',discoveryScope,request,'sdk-owned-artifact');
    assert.equal(cycle.execution_authorized,false);assert.equal(cycle.task_id,admission.task_id);assert.equal(cycle.occurrence_id,admission.occurrence_id);
    assert.deepEqual(cycles.guard('acceptance-owner',discoveryScope,cycle.cycle_id),cycle);
    assert.deepEqual(new WorkCycles(service.db).create('acceptance-owner',discoveryScope,request,'sdk-owned-artifact'),cycle);
    const {LogicalWorkCycleWorkspaceManager}=await import('../../gateway/src/always-on/logical-work-cycle-workspace.ts'),storageRoot=join(root,'cycle-artifacts');await mkdir(storageRoot,{recursive:true});
    const options={db:service.db,workbench:service.workbench,storageRoot},manager=new LogicalWorkCycleWorkspaceManager(options),control={signal:new AbortController().signal};
    const prepared=await manager.prepare('acceptance-owner',discoveryScope,cycle.cycle_id,control);
    assert.equal(await readFile(join(prepared.snapshot.isolated_root,'source.md'),'utf8'),'Discovery source observed for ACCEPTANCE-OK.');
    assert.deepEqual(prepared.plan_paths,['source.md']);assert.equal(prepared.execution_authorized,false);
    const restored=await new LogicalWorkCycleWorkspaceManager(options).prepare('acceptance-owner',discoveryScope,cycle.cycle_id,control);
    assert.equal(restored.snapshot.receipt.snapshot_id,prepared.snapshot.receipt.snapshot_id);assert.equal(restored.snapshot.isolated_root,prepared.snapshot.isolated_root);
    const base=await manager.verifyBase('acceptance-owner',discoveryScope,cycle.cycle_id,control);assert.equal(base.file_count,1);assert.equal(base.execution_authorized,false);
    assert.deepEqual(counts(),before);assert.equal(requests.length,calls,'artifact resource creation never dispatches a model');
    await worker.stop();
    const {WorkGrants}=await import('../../gateway/src/always-on/work-grants.ts');
    const {WorkAdmissionController}=await import('../../gateway/src/always-on/work-admission.ts');
    const {DiscoveryPolicies}=await import('../../gateway/src/always-on/discovery-policy.ts');
    const {WorkbenchBudgetPolicy}=await import('../../gateway/src/workbench/model-budget-policy.ts');
    const {ProjectActivityObserver}=await import('../../gateway/src/always-on/project-activity.ts');
    const {HarnessCoordinator}=await import('../../gateway/src/harness/coordinator.ts');
    const {SessionControllerClient}=await import('../../gateway/src/harness/session-controller-client.ts');
    const {selectedWorkObjective}=await import('../../gateway/src/always-on/work-run-workspace.ts');
    const {WorkAdmissionRecords}=await import('../../gateway/src/always-on/work-admission-records.ts');
    const budgetPolicy=new WorkbenchBudgetPolicy(service.db,policy),grants=new WorkGrants(service.db,budgetPolicy),native=new SessionControllerClient(adapterUrl,adapterToken);
    const grant=grants.authorize('acceptance-owner',discoveryScope,cycle.cycle_id,{expected_cycle_version:cycle.version,expected_policy_version:cycle.policy_version,expected_role_version:cycle.role_version,expected_role_epoch:cycle.role_epoch,snapshot_id:prepared.snapshot.receipt.snapshot_id,source_sha256:prepared.source_sha256},'select-sdk-native-work');
    const activity=new ProjectActivityObserver({db:service.db,workbench:service.workbench,native,maxAgeMs:5000}),workAdmission=new WorkAdmissionController({db:service.db,tasks:service.persistentTasks,policies:new DiscoveryPolicies(service.db),workspace:manager,activity,coordinator:new HarnessCoordinator(service.db,service.runs,service.events),budgetPolicy,maxAgeMs:5000});
    let admitted;
    for(let attempt=0;attempt<3;attempt++){admitted=await workAdmission.admit('acceptance-owner',discoveryScope,grant.grant_id,new AbortController().signal);if(admitted.reason!=='OBSERVATION_STALE')break;}
    assert.equal(admitted.admitted,true,JSON.stringify(admitted));const work=admitted.admission;
    assert.notEqual(work.run_id,run_id);assert.notEqual(work.conversation_id,conversation_id);assert.equal(work.task_id,admission.task_id);
    assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,2);assert.equal(service.persistentTasks.get('acceptance-owner',work.task_id).runs_used,2);
    const sourceBefore=service.db.prepare('SELECT * FROM wb_file_versions WHERE owner_id=? AND project_id=?').all('acceptance-owner',roleAgent.project_id);
    workStarted=true;worker=startWorker();
    const getRun=id=>fetch(gatewayUrl+'/v1/runs/'+id,{headers}).then(r=>r.json());
    let activeRun=work.run_id;
    const firstStop=await until(async()=>{if(modelFailure)throw modelFailure;assert.equal(worker.terminal(),false,worker.output());const value=await getRun(activeRun);return ['waiting_user','waiting_approval','failed','interrupted','succeeded'].includes(value.status)&&value;});
    assert.equal(firstStop.status,workWait?'waiting_user':'waiting_approval',JSON.stringify(firstStop));
    const workSession=service.db.prepare('SELECT session_id FROM ga_harness_session_bindings WHERE conversation_id=?').get(work.conversation_id).session_id;
    const observed=JSON.parse(await readFile(join(root,'composition.json'),'utf8')),nativeWork=observed.sessions[workSession];assert.ok(nativeWork);
    assert.equal(nativeWork.header.cwd,prepared.snapshot.isolated_root);assert.equal(nativeWork.header.agentPreset,'jot-workbench-budgeted');assert.equal(nativeWork.sandbox.workspaceRoot,prepared.snapshot.isolated_root);assert.equal(nativeWork.permission,'workspace-write');assert.equal(nativeWork.approval,'ask');
    const nativeGoal=nativeWork.goals.find(item=>item.goal?.objective)?.goal;assert.ok(nativeGoal);
    const originalTask=service.db.prepare('SELECT title FROM wb_persistent_tasks WHERE task_id=?').get(work.task_id),role=service.workbench.contextForRun(work.run_id);
    const objective=selectedWorkObjective(detail.plans),scope={owner_id:'acceptance-owner',agent_id:discoveryScope.agent_id,workspace_id:discoveryScope.workspace_id,project_id:discoveryScope.project_id,capability_epoch:role.capability_epoch,run_id:work.run_id,session_ref:workSession,task_id:work.task_id,occurrence_id:work.occurrence_id,task_version:work.task_version,generation:work.task_generation,objective,title:originalTask.title};
    assert.equal(nativeGoal.objective,objective+'\n\n[jot-occurrence:'+createHash('sha256').update(JSON.stringify(scope)).digest('hex')+']');
    assert.notEqual(nativeGoal.id,composition.sessions[composition.sessionId].goals.find(item=>item.goal)?.goal.id);
    const originalGoal=service.db.prepare('SELECT goal_id FROM wb_native_goal_bindings WHERE run_id=?').get(work.run_id).goal_id;assert.equal(originalGoal,nativeGoal.id);
    assert.equal(await readFile(join(prepared.snapshot.isolated_root,'source.md'),'utf8'),'ISOLATED-NATIVE-WORK-OK');
    assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_isolated_file_execution_receipts').get().n,1);
    assert.equal(service.db.prepare('SELECT count(*) n FROM wb_file_write_runs WHERE run_id=?').get(work.run_id).n,0);
    assert.deepEqual(service.db.prepare('SELECT * FROM wb_file_versions WHERE owner_id=? AND project_id=?').all('acceptance-owner',roleAgent.project_id),sourceBefore);
    if(workWait){
     const waitCards=(await (await fetch(gatewayUrl+'/v1/conversations/'+work.conversation_id+'/interactions',{headers})).json()).items,card=waitCards[0];assert.equal(card.purpose,'task_input');
     await worker.stop();await host.stop();
     const answer=()=>fetch(gatewayUrl+'/v1/interactions/'+card.interaction_id+'/response',{method:'POST',headers:{...headers,'idempotency-key':'cold-isolated-work-answer'},body:JSON.stringify({expected_version:card.version,answers:[{question_id:'task-input',selected_option_ids:[],custom_text:'Proceed with the same isolated wording.'}]})});
     const response=await answer(),answerReceipt=await response.json();assert.equal(response.status,202,JSON.stringify(answerReceipt));const replay=await answer();assert.equal(replay.status,202);assert.deepEqual(await replay.json(),answerReceipt);
     const continuation=service.db.prepare('SELECT id,checkpoint_id FROM ga_runs WHERE continuation_of=?').all(work.run_id);assert.equal(continuation.length,1);activeRun=continuation[0].id;assert.ok(continuation[0].checkpoint_id);
     assert.deepEqual(new WorkAdmissionRecords(service.db).guard('acceptance-owner',activeRun),work);
     host=launch([join(runtime,'dsh/lib/bin.js'),'--profile','jot','--host','127.0.0.1','--port','0','--no-open'],workspace,{...cleanEnv(),DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',JOT_SESSION_ADAPTER_TOKEN:adapterToken,GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:internalToken,DEEPSEEK_API_KEY:modelKey});
     await until(async()=>{assert.equal(host.terminal(),false,host.output());try{return (await fetch(adapterUrl+'/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(500)})).status===401;}catch{return false;}});
     assert.equal(requests.length,9);worker=startWorker();
     const continued=await until(async()=>{if(modelFailure)throw modelFailure;const value=await getRun(activeRun);return ['waiting_approval','waiting_user','failed','interrupted','succeeded'].includes(value.status)&&value;});assert.equal(continued.status,'waiting_approval',JSON.stringify(continued));
     assert.equal(service.db.prepare('SELECT session_id FROM ga_harness_session_bindings WHERE conversation_id=?').get(work.conversation_id).session_id,workSession);
     assert.equal(service.db.prepare('SELECT goal_id FROM wb_native_goal_bindings WHERE run_id=?').get(work.run_id).goal_id,originalGoal);
     assert.equal(service.db.prepare('SELECT count(*) n FROM wb_isolated_file_results WHERE version IS NOT NULL').get().n,1);
     const coldObserved=JSON.parse(await readFile(join(root,'composition.json'),'utf8')).sessions[workSession];assert.equal(coldObserved.header.cwd,prepared.snapshot.isolated_root);assert.equal(coldObserved.header.agentPreset,'jot-workbench-budgeted');
     assert.ok(coldObserved.goals.filter(item=>item.goal?.id===originalGoal).length>1);assert.ok(coldObserved.goals.filter(item=>item.goal?.id===originalGoal).every(item=>item.goal.objective===nativeGoal.objective));
    }
    const reviewCards=(await (await fetch(gatewayUrl+'/v1/conversations/'+work.conversation_id+'/interactions',{headers})).json()).items,reviewCard=reviewCards[0];assert.equal(reviewCard.purpose,'task_acceptance_review');
    const preview=await fetch(gatewayUrl+'/v1/interactions/'+reviewCard.interaction_id+'/outputs/0',{headers});assert.equal(preview.status,200);assert.equal(await preview.text(),'ISOLATED-NATIVE-WORK-OK');
    const workReview=await fetch(gatewayUrl+'/v1/interactions/'+reviewCard.interaction_id+'/response',{method:'POST',headers:{...headers,'idempotency-key':'accept-sdk-isolated-output'},body:JSON.stringify({expected_version:reviewCard.version,answers:reviewCard.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))})});assert.equal(workReview.status,202,await workReview.clone().text());
    await until(async()=>{if(modelFailure)throw modelFailure;const value=await getRun(activeRun);return value.status==='succeeded';});
    const deliveredWork=await (await fetch(gatewayUrl+'/v1/conversations/'+work.conversation_id+'/snapshot',{headers})).json();assert.equal(deliveredWork.artifacts.length,1);assert.equal(deliveredWork.messages.filter(m=>m.role==='assistant'&&m.status==='complete').length,1);
    // Deliberate fixture drift after canonical completion must not replace the
    // immutable accepted artifact bytes or its original isolated version.
    await writeFile(join(prepared.snapshot.isolated_root,'source.md'),'LATER-MUTABLE-TREE-DRIFT');
    const artifact=deliveredWork.artifacts[0],download=await fetch(gatewayUrl+'/v1/artifacts/'+artifact.artifact_id+'/download?version=1',{headers});assert.equal(download.status,200);assert.equal(await download.text(),'ISOLATED-NATIVE-WORK-OK');
    assert.equal(Buffer.from(service.db.prepare('SELECT bytes FROM wb_isolated_file_results WHERE version=1').get().bytes).toString('utf8'),'ISOLATED-NATIVE-WORK-OK');
    const completion=JSON.parse(service.db.prepare('SELECT n.proof_json FROM wb_task_native_completions n JOIN wb_task_completion_intents i ON i.intent_id=n.intent_id WHERE i.run_id=?').get(activeRun).proof_json);assert.equal(completion.goal.phase,'complete');assert.equal(completion.goal.goal_id,originalGoal);assert.equal(completion.checkpoint.session_ref,workSession);
    assert.equal(service.db.prepare('SELECT count(*) n FROM wb_discovery_admissions').get().n,1);assert.equal(service.db.prepare('SELECT count(*) n FROM wb_discovery_work_admissions').get().n,1);assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,2);assert.equal(workStage,workWait?5:4);
    const total=service.db.prepare('SELECT used_model_calls,used_tokens FROM wb_model_budget_scopes WHERE scope_id=?').get(grant.task_budget_scope_id);assert.equal(Number(total.used_model_calls),requests.length);assert.equal(Number(total.used_tokens),requests.length*6);
    assert.equal(service.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts WHERE state IN ('unknown','in_flight','reserved')").get().n,0);
    conversation_id=work.conversation_id;

   }
   assert.equal(service.workbench.readFile('acceptance-owner','jot',roleAgent.project_id,'source.md').content,'Discovery source observed for ACCEPTANCE-OK.');
  }
  if(resume){
   let parent=run_id,priorGoal;
   for(const [index,purpose,nextStatus] of [[0,'task_input','waiting_approval'],[1,'task_review','waiting_user']]){
    const cards=await (await fetch(gatewayUrl+'/v1/conversations/'+conversation_id+'/interactions',{headers})).json();
    assert.equal(cards.items.length,1);const card=cards.items[0];assert.equal(card.purpose,purpose);assert.equal(card.run_id,parent);
    const goalResponse=await fetch(adapterUrl+'/v1/sessions/'+composition.sessionId+'/goal-status',{method:'POST',headers:{authorization:'Bearer '+adapterToken,'content-type':'application/json'},body:'{}'});
    const before=(await goalResponse.json()).state;assert.equal(goalResponse.status,200);priorGoal=before.goal;
    const endpoint='/v1/interactions/'+card.interaction_id+(index===0?'/response':'/decision');
    const payload=index===0?{expected_version:card.version,answers:[{question_id:card.questions[0].question_id,selected_option_ids:[],custom_text:'Use the Markdown format, preserving the original scope.'}]}:{expected_version:card.version,action_digest:card.action_digest,decision:'approve'};
    const post=()=>fetch(gatewayUrl+endpoint,{method:'POST',headers:{...headers,'idempotency-key':'resume-check-'+index},body:JSON.stringify(payload)});
    const answered=await post();const receipt=await answered.json();assert.equal(answered.status,202,JSON.stringify(receipt));
    const replay=await post();assert.equal(replay.status,202);assert.deepEqual(await replay.json(),receipt);
    const continuation=service.db.prepare('SELECT id,conversation_id,continuation_of FROM ga_runs WHERE continuation_of=?').all(parent);
    assert.equal(continuation.length,1);const child=continuation[0];assert.equal(child.conversation_id,conversation_id);
    const stopped=await until(async()=>{const value=await (await fetch(gatewayUrl+'/v1/runs/'+child.id,{headers})).json();return ['waiting_user','waiting_approval','failed','interrupted','succeeded'].includes(value.status)&&value;});
    assert.equal(stopped.status,nextStatus,JSON.stringify(stopped));assert.equal(requests.length,index+2);
    const observed=JSON.parse(await readFile(join(root,'composition.json'),'utf8'));
    assert.equal(observed.sessionId,composition.sessionId);assert.equal(observed.events.filter(event=>event.sourceRpcId===child.id).length,1);
    assert.equal(observed.events.filter(event=>event.sourceRpcId===run_id).length,1);
    const text=userTexts(requests[index+1]).join('\n');assert.equal(occurrences(text,'持续任务：Wait for confirmation'),1);assert.equal(occurrences(text,'Use the Markdown format, preserving the original scope.'),1);
    const status=await fetch(adapterUrl+'/v1/sessions/'+composition.sessionId+'/goal-status',{method:'POST',headers:{authorization:'Bearer '+adapterToken,'content-type':'application/json'},body:'{}'});const after=(await status.json()).state;
    assert.equal(status.status,200);assert.equal(after.goal.goal_id,priorGoal.goal_id);assert.ok(after.goal.goal_revision>priorGoal.goal_revision);assert.equal(after.goal.phase,'paused');assert.equal(after.goal.activation,'disarmed');assert.equal(after.host_status,'idle');
    assert.ok(service.db.prepare('SELECT checkpoint_id FROM ga_runs WHERE id=?').get(child.id).checkpoint_id);
    assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,1);assert.equal(service.db.prepare('SELECT runs_used FROM wb_persistent_tasks').get().runs_used,1);
    assert.equal(service.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts WHERE state='settled'").get().n,index+2);
    assert.equal(service.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts WHERE state IN ('reserved','in_flight','unknown')").get().n,0);
    checkBudget(child.id,index+2);
    assert.equal(service.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
    parent=child.id;
   }
   assert.ok(JSON.stringify(requests[1].messages).includes('Use the Markdown format'));
   assert.equal(service.db.prepare('SELECT count(*) n FROM ga_runs').get().n,3);
  }
  if(persistent){const task=service.persistentTasks.list('acceptance-owner').items[0];assert.equal(task.budget.max_runs,unlimited?null:1);assert.equal(task.runs_used,maintenanceDriven&&noPlan?1:2);assert.equal(task.status,unlimited?'active':'budget_exhausted');}
  assert.equal(host.output().includes('entry did not activate'),false);
  const finalSnapshotResponse=await fetch(gatewayUrl+'/v1/conversations/'+conversation_id+'/snapshot',{headers}),finalSnapshot=await finalSnapshotResponse.json();
  assert.equal(finalSnapshotResponse.status,200,JSON.stringify(finalSnapshot.error??{code:'snapshot_unavailable'}));
  t.diagnostic(JSON.stringify({officialLauncher:true,realGateway:true,realWorker:true,nativeIsolatedWork:true,workWait,role,persistent,resume,complete,automatic,unlimited,discovery,noPlan,modelTransport:'synthetic local Messages HTTP',modelRequests:requests.length,replyCount:finalSnapshot.messages.filter(message=>message.role==='assistant'&&message.status==='complete').length,initialStatus:run.status,status:finalSnapshot.runs.at(-1).status,production:false}));
  let dormancy;
  if(noPlan){
   const beforeTask=service.persistentTasks.list('acceptance-owner').items[0];
   const {observeDiscoveryDormancy}=await import('../../gateway/src/always-on/dormancy.ts'),policyId=service.db.prepare('SELECT policy_id FROM wb_discovery_policies').get().policy_id;
   const changes=service.db.prepare('SELECT total_changes() n').get().n;assert.deepEqual(observeDiscoveryDormancy(service.db,'acceptance-owner',policyId),{protocol:1,state:'accepted',revision:1,execution_authorized:false});assert.equal(observeDiscoveryDormancy(service.db,'foreign-owner',policyId).state,'none');assert.equal(service.db.prepare('SELECT total_changes() n').get().n,changes);
    if(maintenanceDriven){
     await delay(2200);assert.equal(discoveryCounts().admissions,1,'unchanged accepted source must remain deduplicated across maintenance ticks');
     let woke=false;
     if(gateScenario==='cooldown'){service.workbench.writeFile('acceptance-owner','jot',{project_id:roleAgent.project_id,path:'source.md',content:'A new owned source revision inside cooldown.',expected_version:1});await delay(2200);assert.equal(discoveryCounts().admissions,1,'new source revision must remain held by the original cooldown gate');}
     const afterTask=service.persistentTasks.list('acceptance-owner').items[0];assert.equal(afterTask.task_id,beforeTask.task_id);assert.equal(afterTask.runs_used,1);assert.equal(requests.length,completedCalls);
     dormancy={dormant_reason:'DORMANT_NO_SIGNAL',woke,same_task:afterTask.task_id===beforeTask.task_id};
    }else{
     const sleeping=await admitFresh();assert.equal(sleeping.admitted,false);assert.equal(sleeping.reason,'DORMANT_NO_SIGNAL');
     await worker.stop();assert.equal(worker.terminal(),true);
     service.workbench.writeFile('acceptance-owner','jot',{project_id:roleAgent.project_id,path:'source.md',content:'A new owned source revision.',expected_version:1});
     const awake=await admitFresh();assert.equal(awake.admitted,true,JSON.stringify(awake));
     const afterTask=service.persistentTasks.list('acceptance-owner').items[0];assert.equal(afterTask.task_id,beforeTask.task_id);assert.equal(afterTask.runs_used,2);assert.equal(requests.length,completedCalls);
     dormancy={dormant_reason:sleeping.reason,woke:awake.admitted,same_task:afterTask.task_id===beforeTask.task_id};
    }
  }
  const processEvidence=await finishWorkers();
  succeeded=true;
  if(discovery){const result={admissions:service.db.prepare('SELECT count(*) n FROM wb_discovery_admissions').get().n,occurrences:service.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,runs:service.db.prepare('SELECT count(*) n FROM ga_runs WHERE conversation_id=?').get(conversation_id).n,process_count:processEvidence.length,process_exit_count:processEvidence.filter(process=>process.terminal).length,sqlite_busy_count:processEvidence.reduce((n,process)=>n+process.sqlite_busy_count,0),sqlite_locked_count:processEvidence.reduce((n,process)=>n+process.sqlite_locked_count,0),barrier_arrivals:barrierArrivals,plans:service.db.prepare('SELECT count(*) n FROM wb_discovery_plans').get().n,reports:service.db.prepare('SELECT count(*) n FROM wb_discovery_reports').get().n,source_reads:service.db.prepare('SELECT count(*) n FROM wb_discovery_source_reads').get().n,finalizations:service.db.prepare('SELECT count(*) n FROM wb_task_finalizations').get().n,model_requests:requests.length,...(dormancy??{}),...(discoveryWait?{wait_recovered:true}:{})};t.diagnostic(JSON.stringify({m08_08_fixture_return:result}));return result;}
  }catch(error){const message=error instanceof Error?error.message:'';const code=/SQLITE_BUSY/i.test(message)?'SQLITE_BUSY':/SQLITE_LOCKED|database is locked/i.test(message)?'SQLITE_LOCKED':message==='gateway_host_acceptance_timeout'?'acceptance_timeout':error?.code==='EACCES'?'EACCES':'fixture_failure';t.diagnostic(JSON.stringify({m08_08_failure:{checkpoint:fixtureCheckpoint,code}}));await writeFile(join(root,'startup-private.log'),JSON.stringify({host:host?.output(),worker:worker?.output(),modelRequests:requests.length},null,2));throw Error('gateway_host_acceptance_failed; private diagnostics: '+root,{cause:error});}
  finally{await fixtureCleanup.run();}
}
