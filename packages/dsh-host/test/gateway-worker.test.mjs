// The model HTTP endpoint is synthetic; Gateway/Worker/DSH services are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHostProfile} from '../create-profile.mjs';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
async function listen(server){await new Promise(done=>server.listen(0,'127.0.0.1',done));return 'http://127.0.0.1:'+server.address().port;}
async function freePort(){const server=createServer();await listen(server);const port=server.address().port;await new Promise(done=>server.close(done));return port;}
async function until(check){const end=Date.now()+30000;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(done=>setTimeout(done,100));}throw Error('gateway_host_acceptance_timeout');}
function cleanEnv(){const env={};for(const key of ['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATHEXT'])if(process.env[key])env[key]=process.env[key];return env;}
function launch(args,cwd,env){const child=spawn(process.execPath,args,{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true});let output='',terminal=false;const ended=new Promise(done=>child.once('exit',()=>{terminal=true;done();}));for(const stream of [child.stdout,child.stderr])stream.on('data',value=>{output+=value;});return {child,output:()=>output,terminal:()=>terminal,async stop(){if(!terminal)child.kill('SIGTERM');await ended;}};}

function executionReceipt(value){
 if(typeof value==='string'){try{return executionReceipt(JSON.parse(value));}catch{return;}}
 if(!value||typeof value!=='object')return;
 if(value.execution_receipt?.kind==='tool_receipt')return value.execution_receipt;
 for(const child of Object.values(value)){const found=executionReceipt(child);if(found)return found;}
}

const userTexts=input=>input.messages.filter(message=>message.role==='user').flatMap(message=>typeof message.content==='string'?[message.content]:(message.content??[]).filter(part=>part.type==='text').map(part=>part.text));
const occurrences=(text,part)=>text.split(part).length-1;

async function gatewayCase(t,{role=false,persistent=false,resume=false,complete=false,automatic=false,unlimited=false,discovery=false,noPlan=false,discoveryWait=false}={}){
 persistent ||= discovery; complete ||= discovery; unlimited ||= discovery; role ||= persistent;
 const {buildServer}=await import('../../gateway/src/server.ts');
 const root=await mkdtemp(join(tmpdir(),'jot-gateway-host-')),home=join(root,'home'),workspace=join(root,'workspace');await mkdir(workspace);
 let host,worker,service,succeeded=false,modelFailure;const requests=[];
 const modelKey='sk-'+randomBytes(32).toString('hex'),adapterToken=randomBytes(32).toString('hex'),internalToken=randomBytes(32).toString('hex'),csrfToken=randomBytes(32).toString('hex');
 const model=createServer(async(req,res)=>{try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(req.method,'POST');assert.match(req.url,/\/messages$/);assert.equal(req.headers['x-api-key'],modelKey);
  requests.push(input);const ordinal=requests.length;res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  let operation='tasks.propose',argumentsValue={intent:complete?'complete':automatic&&ordinal===1?'continue':resume&&ordinal===2?'wait_approval':'wait_user',summary:ordinal===2?'Please review the next step.':'Please confirm the next step.'};
  if(complete&&!discovery&&ordinal===1){operation='files.write';argumentsValue={path:'acceptance.md',content:'ACCEPTANCE-OK',expected_version:0};}
  if(complete&&!discovery&&ordinal===2){operation='tasks.upsert';const evidence=executionReceipt(input.messages);assert.ok(evidence,'the model must consume a real file operation receipt');argumentsValue={title:'Write the acceptance file',acceptance:'acceptance.md contains exactly ACCEPTANCE-OK.',status:'completed',evidence:[evidence]};}
  if(complete&&!discovery&&ordinal===3)argumentsValue.files=[{path:'acceptance.md',description:'Reviewed report'}];
  if(discovery){
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
  const toolEvents=persistent&&!(automatic&&ordinal===2)?[
   {type:'content_block_start',index:1,content_block:{type:'tool_use',id:'synthetic-wait-call-'+ordinal,name:'jot_workspace',input:{operation,arguments_json:JSON.stringify(argumentsValue)}}},
   {type:'content_block_stop',index:1},
  ]:[];
  for(const event of [
   {type:'message_start',message:{id:'synthetic-message-'+ordinal,role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:5,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
   {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'ACCEPTANCE-OK'}},
   {type:'content_block_stop',index:0},
   ...toolEvents,
   {type:'message_delta',delta:{stop_reason:toolEvents.length?'tool_use':'end_turn'},usage:{output_tokens:1}},
   {type:'message_stop'},
  ])res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();
 }catch(error){modelFailure=error;if(!res.headersSent)res.writeHead(500);res.end('synthetic_protocol_request_rejected');}});
 const modelUrl=await listen(model);
 const route={provider:'deepseek-official',model:'deepseek-flash',revision:'synthetic-rates-1',context_window:1000000,max_output_tokens:256000,rates:{input:1,output:1,cache_read:1,cache_write:1}};
 const policy={revision:1,admission_route:{provider:route.provider,model:route.model},routes:[route],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,{tokens:10000000,nano_usd:null,model_calls:100}]))};
 try{
  service=await buildServer({databasePath:join(root,'gateway.db'),uploadRoot:join(root,'files'),workbenchRoot:join(root,'workspaces'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates',import.meta.url)),workspaces:['jot'],internalChannelToken:internalToken,csrfToken,allowedOrigins:['https://fixture.invalid'],...(role?{modelBudgetPolicy:policy,workbenchExecutionReady:true}:{})});
  await service.app.listen({host:'127.0.0.1',port:0});const gatewayUrl='http://127.0.0.1:'+service.app.server.address().port;
  const prepared=await createHostProfile({home,...(role?{workbench:{provider:route.provider,model:route.model,origin:gatewayUrl}}:{})}),port=await freePort(),patchPath=join(prepared.directory,'cordis.patch.yml');
  let patch=await readFile(patchPath,'utf8');patch=patch.replace('"port": 18841','"port": '+port+(discovery?', "nativeIdleObservation": true':'')).replace('http://127.0.0.1:18831',gatewayUrl).replace('"jotHostReady"','"jotHostReady", "jotHostInspectionReady"');
  const inspection={insert:[{id:'jot-host-inspection',name:pathToFileURL(fileURLToPath(new URL('./inspect-host-plugin.mjs',import.meta.url))).href,config:{receipt:join(root,'composition.json'),sessionPrefix:'jot-host-acceptance-'}}]};
  patch=patch.trim().replace(/\]$/,', '+JSON.stringify({id:'llm-deepseek',config:{baseURL:modelUrl,apiKeyEnv:'DEEPSEEK_API_KEY',reasoningEffort:'high'}})+', '+JSON.stringify(inspection)+']');await writeFile(patchPath,patch);
  host=launch([join(runtime,'dsh/lib/bin.js'),'--profile','jot','--host','127.0.0.1','--port','0','--no-open'],workspace,{...cleanEnv(),DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',JOT_SESSION_ADAPTER_TOKEN:adapterToken,GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:internalToken,DEEPSEEK_API_KEY:modelKey});
  const adapterUrl='http://127.0.0.1:'+port;
  await until(async()=>{assert.equal(host.terminal(),false,'official host exited');try{return (await fetch(adapterUrl+'/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(500)})).status===401;}catch{return false;}});
  const tokenFile=join(root,'adapter.token');await writeFile(tokenFile,adapterToken,{mode:0o600});
  const policyFile=join(root,'budget-policy.json');if(role)await writeFile(policyFile,JSON.stringify(policy));
  const headers={'x-user-id':'acceptance-owner','content-type':'application/json','x-csrf-token':csrfToken,origin:'https://fixture.invalid','idempotency-key':'acceptance-create'};
  let conversation_id,messageUrl,messageBody,roleAgent,discoveryController,discoveryScope,sourceBlob,sourceBytes;
  if(role){const response=await fetch(gatewayUrl+'/v1/agents',{method:'POST',headers,body:JSON.stringify({name:'Acceptance role',workspace_id:'jot',instructions:'Reply clearly using the provided evidence.'})});assert.equal(response.status,201);const agent=await response.json();roleAgent=agent;conversation_id=agent.conversation_id;messageUrl='/v1/agents/'+agent.agent_id+'/messages';messageBody={client_message_id:'acceptance-one',text:'Reply with the single word ACCEPTANCE-OK.'};
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
   const client=new SessionControllerClient(adapterUrl,adapterToken),roleSession='discovery-idle-role';
   await client.create(roleSession,workspace,'jot-general');assert.equal(requests.length,0,'idle role setup must not call the model');
   service.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(roleAgent.conversation_id,'acceptance-owner',roleSession,new Date().toISOString(),new Date().toISOString());
   assert.equal((await client.nativeIdleObservationReadiness()).ready,true);assert.equal((await client.observeNativeIdle(roleSession)).native_idle,'idle');
   service.workbench.writeFile('acceptance-owner','jot',{project_id:roleAgent.project_id,path:'source.md',content:'Discovery source observed for ACCEPTANCE-OK.',expected_version:0});
   if(discoveryWait){
    const version=service.db.prepare('SELECT blob_name FROM wb_file_versions WHERE owner_id=? AND project_id=? AND path=? AND version=1').get('acceptance-owner',roleAgent.project_id,'source.md');
    sourceBlob=join(service.workbench.projectRoot('acceptance-owner','jot',roleAgent.project_id),'blobs',version.blob_name);sourceBytes=await readFile(sourceBlob);
    await writeFile(sourceBlob,'Deliberate isolated-fixture corruption.');
   }
   const policyUrl=gatewayUrl+'/v1/agents/'+roleAgent.agent_id+'/discovery-policy';
   const saved=await fetch(policyUrl,{method:'PATCH',headers:{...headers,'idempotency-key':'discovery-save'},body:JSON.stringify({expected_version:0,expected_role_version:1,expected_role_epoch:1,mode:'discover_only',cooldown_ms:0,recent_input_ms:0,max_cycles:null})});assert.equal(saved.status,200,await saved.clone().text());
   const enabled=await fetch(policyUrl+'/control',{method:'POST',headers:{...headers,'idempotency-key':'discovery-enable'},body:JSON.stringify({action:'enable',expected_version:1,expected_role_version:1,expected_role_epoch:1})});assert.equal(enabled.status,200,await enabled.clone().text());
   discoveryScope={project_id:roleAgent.project_id,workspace_id:'jot',agent_id:roleAgent.agent_id};
   discoveryController=new DiscoveryAdmissionController({db:service.db,workbench:service.workbench,tasks:service.persistentTasks,policies:new DiscoveryPolicies(service.db),
    activity:new ProjectActivityObserver({db:service.db,workbench:service.workbench,native:client,maxAgeMs:5000}),coordinator:new HarnessCoordinator(service.db,service.runs,service.events),budgetPolicy:new WorkbenchBudgetPolicy(service.db,policy),maxAgeMs:5000});
  }
  const postMessage=()=>fetch(gatewayUrl+messageUrl,{method:'POST',headers:{...headers,'idempotency-key':'acceptance-one'},body:JSON.stringify(messageBody)});
  const admitFresh=async()=>{
   // A freshness hold is a normal, non-admitting observation, not permission to
   // accept stale evidence or restart a process. Re-observe within this fixture
   // at most three times; every rejected attempt must preserve execution state.
   let receipt;
   for(let attempt=0;attempt<3;attempt++){
    const state=()=>({runs:service.db.prepare('SELECT count(*) n FROM ga_runs').get().n,admissions:service.db.prepare('SELECT count(*) n FROM wb_discovery_admissions').get().n,
     used:service.persistentTasks.list('acceptance-owner').items[0].runs_used,modelRequests:requests.length,attempts:service.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n});
    const before=state();receipt=await discoveryController.admit('acceptance-owner',discoveryScope);
    if(receipt.reason!=='OBSERVATION_STALE')return receipt;
    assert.deepEqual(state(),before,'expired observations cannot admit runs, spend or reset task usage');
   }
   return receipt;
  };
  let accepted;
  if(discovery){const receipt=await admitFresh();assert.equal(receipt.admitted,true,JSON.stringify(receipt));accepted=service.db.prepare('SELECT run_id,conversation_id FROM wb_task_occurrences WHERE occurrence_id=?').get(receipt.occurrence_id);assert.ok(accepted);}
  else{const posted=await postMessage();assert.equal(posted.status,202);accepted=await posted.json();}
  const run_id=accepted.run_id;if(persistent)conversation_id=accepted.conversation_id;
  const startWorker=()=>launch(['--import',new URL('./trace-gateway-fetch.mjs',import.meta.url).href,'--experimental-strip-types',fileURLToPath(new URL('../../gateway/src/harness/main.ts',import.meta.url))],workspace,{...cleanEnv(),JOT_ACCEPTANCE_FETCH_TRACE:join(root,'fetch-status.jsonl'),GENERAL_AGENT_DB:join(root,'gateway.db'),GENERAL_AGENT_FILE_ROOT:join(root,'files'),GENERAL_AGENT_WORKBENCH_ROOT:join(root,'workspaces'),GENERAL_AGENT_WORKSPACES:'jot',GENERAL_AGENT_SESSION_ADAPTER_URL:adapterUrl,GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE:tokenFile,GENERAL_AGENT_HARNESS_CWD:workspace,GENERAL_AGENT_DSH_AGENT_PRESET:'jot-general',GENERAL_AGENT_DSH_SESSION_PREFIX:'jot-host-acceptance',GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:internalToken,GENERAL_AGENT_WORKER_POLL_MS:'250',...(role?{GENERAL_AGENT_MODEL_BUDGET_POLICY_FILE:policyFile,GENERAL_AGENT_WORKBENCH_DSH_AGENT_PRESET:'jot-workbench-budgeted',GENERAL_AGENT_WORKBENCH_EXECUTION_READY:'true',GENERAL_AGENT_WORKER_CONCURRENCY:'2'}:{})});
  worker=startWorker();
  const run=await until(async()=>{if(modelFailure)throw modelFailure;assert.equal(worker.terminal(),false,'official gateway worker exited');const current=await (await fetch(gatewayUrl+'/v1/runs/'+run_id,{headers})).json();if(['succeeded','failed','interrupted','waiting_user','waiting_approval'].includes(current.status))return current;return false;});
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
  if(discovery){assert.equal((await discoveryController.admit('acceptance-owner',discoveryScope)).admitted,false);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(requests.length,initialCalls);}
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
  if(discoveryWait){
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
   assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,1);assert.equal(requests.length,initialCalls);
   worker=startWorker();
   const waiting=await until(async()=>{if(modelFailure)throw modelFailure;const value=await (await fetch(gatewayUrl+'/v1/runs/'+completionRun,{headers})).json();return ['waiting_approval','waiting_user','failed','interrupted','succeeded'].includes(value.status)&&value;});
   assert.equal(waiting.status,'waiting_approval',JSON.stringify(waiting));completedCalls=7;assert.equal(requests.length,completedCalls);
   const continued=JSON.parse(await readFile(join(root,'composition.json'),'utf8'));assert.equal(continued.sessionId,composition.sessionId);assert.equal(continued.events.filter(e=>e.sourceRpcId===completionRun).length,1);
   const afterWait=await nativeState();assert.equal(afterWait.goal.goal_id,beforeWait.goal.goal_id);assert.ok(afterWait.goal.goal_revision>beforeWait.goal.goal_revision);assert.equal(afterWait.goal.phase,'paused');assert.equal(afterWait.goal.activation,'disarmed');
   assert.equal(occurrences(userTexts(requests[3]).join('\n'),'The original source bytes have been restored.'),1);checkBudget(completionRun,completedCalls);
  }
  if(discovery){
   const report=service.db.prepare('SELECT report_id,payload_sha256,payload_json FROM wb_discovery_reports').get(),plan=service.db.prepare('SELECT plan_id FROM wb_discovery_plans').get();assert.ok(report);if(noPlan)assert.equal(plan,undefined);else assert.ok(plan);
   assert.deepEqual(JSON.parse(report.payload_json).plan_ids,noPlan?[]:[plan.plan_id]);assert.equal(JSON.parse(report.payload_json).outcome,noPlan?'no_plan':'proposals');assert.deepEqual(JSON.parse(report.payload_json).coverage,{signal_count:1,fully_read:1});
   const frozen=JSON.parse(service.db.prepare('SELECT snapshot_json FROM wb_task_completion_candidates WHERE run_id=?').get(completionRun).snapshot_json);assert.equal(frozen.discovery_report.report_id,report.report_id);assert.equal(frozen.discovery_report.sha256,report.payload_sha256);
   assert.equal(service.db.prepare('SELECT count(*) n FROM wb_file_write_runs WHERE run_id=?').get(run_id).n,0);assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_business_certificates').get().n,0);
   const card=(await (await fetch(gatewayUrl+'/v1/conversations/'+conversation_id+'/interactions',{headers})).json()).items[0];assert.equal(card.purpose,'task_acceptance_review');
   if(noPlan){await worker.stop();assert.equal(worker.terminal(),true);}
   const review=await fetch(gatewayUrl+'/v1/interactions/'+card.interaction_id+'/response',{method:'POST',headers:{...headers,'idempotency-key':'accept-discovery'},body:JSON.stringify({expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))})});assert.equal(review.status,202,await review.clone().text());
   if(noPlan){assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_business_certificates').get().n,1);assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_finalizations').get().n,0);const {observeDiscoveryDormancy}=await import('../../gateway/src/always-on/dormancy.ts');assert.equal(observeDiscoveryDormancy(service.db,'acceptance-owner',service.db.prepare('SELECT policy_id FROM wb_discovery_policies').get().policy_id).state,'none','owner review without native publication cannot establish dormancy');worker=startWorker();}
   await until(async()=>{const result=await (await fetch(gatewayUrl+'/v1/runs/'+completionRun,{headers})).json();return result.status==='succeeded';});
   const delivered=await (await fetch(gatewayUrl+'/v1/conversations/'+conversation_id+'/snapshot',{headers})).json();assert.equal(delivered.messages.filter(m=>m.role==='assistant'&&m.status==='complete').length,1);assert.equal(delivered.artifacts.length,0);checkBudget(completionRun,completedCalls);
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
  if(persistent){const task=service.persistentTasks.list('acceptance-owner').items[0];assert.equal(task.budget.max_runs,unlimited?null:1);assert.equal(task.runs_used,1);assert.equal(task.status,unlimited?'active':'budget_exhausted');}
  assert.equal(host.output().includes('entry did not activate'),false);
  const finalSnapshotResponse=await fetch(gatewayUrl+'/v1/conversations/'+conversation_id+'/snapshot',{headers}),finalSnapshot=await finalSnapshotResponse.json();
  assert.equal(finalSnapshotResponse.status,200,JSON.stringify(finalSnapshot.error??{code:'snapshot_unavailable'}));
  t.diagnostic(JSON.stringify({officialLauncher:true,realGateway:true,realWorker:true,role,persistent,resume,complete,automatic,unlimited,discovery,noPlan,modelTransport:'synthetic local Messages HTTP',modelRequests:requests.length,replyCount:finalSnapshot.messages.filter(message=>message.role==='assistant'&&message.status==='complete').length,initialStatus:run.status,status:finalSnapshot.runs.at(-1).status,production:false}));
  let dormancy;
  if(noPlan){
   const beforeTask=service.persistentTasks.list('acceptance-owner').items[0];
   const {observeDiscoveryDormancy}=await import('../../gateway/src/always-on/dormancy.ts'),policyId=service.db.prepare('SELECT policy_id FROM wb_discovery_policies').get().policy_id;
   const changes=service.db.prepare('SELECT total_changes() n').get().n;assert.deepEqual(observeDiscoveryDormancy(service.db,'acceptance-owner',policyId),{protocol:1,state:'accepted',revision:1,execution_authorized:false});assert.equal(observeDiscoveryDormancy(service.db,'foreign-owner',policyId).state,'none');assert.equal(service.db.prepare('SELECT total_changes() n').get().n,changes);
   const sleeping=await discoveryController.admit('acceptance-owner',discoveryScope);assert.equal(sleeping.admitted,false);assert.equal(sleeping.reason,'DORMANT_NO_SIGNAL');
   await worker.stop();assert.equal(worker.terminal(),true);
   service.workbench.writeFile('acceptance-owner','jot',{project_id:roleAgent.project_id,path:'source.md',content:'A new owned source revision.',expected_version:1});
   const awake=await admitFresh();assert.equal(awake.admitted,true,JSON.stringify(awake));
   const afterTask=service.persistentTasks.list('acceptance-owner').items[0];assert.equal(afterTask.task_id,beforeTask.task_id);assert.equal(afterTask.runs_used,2);assert.equal(requests.length,completedCalls);
   dormancy={dormant_reason:sleeping.reason,woke:awake.admitted,same_task:afterTask.task_id===beforeTask.task_id};
  }
  succeeded=true;
  if(discovery)return {admissions:service.db.prepare('SELECT count(*) n FROM wb_discovery_admissions').get().n,plans:service.db.prepare('SELECT count(*) n FROM wb_discovery_plans').get().n,reports:service.db.prepare('SELECT count(*) n FROM wb_discovery_reports').get().n,source_reads:service.db.prepare('SELECT count(*) n FROM wb_discovery_source_reads').get().n,finalizations:service.db.prepare('SELECT count(*) n FROM wb_task_finalizations').get().n,model_requests:requests.length,...(dormancy??{}),...(discoveryWait?{wait_recovered:true}:{})};
 }catch(error){await writeFile(join(root,'startup-private.log'),JSON.stringify({host:host?.output(),worker:worker?.output(),modelRequests:requests.length},null,2));throw Error('gateway_host_acceptance_failed; private diagnostics: '+root,{cause:error});}
 finally{await worker?.stop();await host?.stop();if(service){await service.app.close();service.db.close();}model.closeAllConnections();await new Promise(done=>model.close(done));if(succeeded)await rm(root,{recursive:true,force:true});}
}
test('real Gateway and worker commit one reply from an official DSH host through the Messages HTTP transport',{skip:!runtime,timeout:60000},t=>gatewayCase(t));
test('a saved Gateway role runs on the explicit budgeted host composition',{skip:!runtime,timeout:60000},t=>gatewayCase(t,{role:true}));
test('a real persistent task checkpoints its native Goal and waits for the user without publishing success',{skip:!runtime,timeout:60000},t=>gatewayCase(t,{persistent:true}));

test('real task input and review replies resume the same occurrence and native Goal exactly once',{skip:!runtime,timeout:60000},t=>gatewayCase(t,{persistent:true,resume:true}));

test('a real file task publishes once only after owner criteria acceptance and native Goal completion',{skip:!runtime,timeout:60000},t=>gatewayCase(t,{persistent:true,complete:true}));

test('the original native Goal driver admits another round without a competing Gateway prompt or run',{skip:!runtime,timeout:60000},t=>gatewayCase(t,{persistent:true,automatic:true}));

test('explicit unlimited task replies keep the same occurrence and native Goal without consuming another task run',{skip:!runtime,timeout:60000},t=>gatewayCase(t,{persistent:true,resume:true,unlimited:true}));
test('explicit unlimited file task still requires owner acceptance and native Goal completion',{skip:!runtime,timeout:60000},t=>gatewayCase(t,{persistent:true,complete:true,unlimited:true}));

test('official DSH discovery tools produce a source-backed plan and report before original owner acceptance',{skip:!runtime,timeout:80000},async t=>{
 const proof=await gatewayCase(t,{persistent:true,complete:true,unlimited:true,discovery:true});
 assert.deepEqual(proof,{admissions:1,plans:1,reports:1,source_reads:1,finalizations:1,model_requests:6});
});

test('accepted no-plan discovery stays dormant across Worker restart and new source wakes its original task',{skip:!runtime,timeout:100000},async t=>{
 const proof=await gatewayCase(t,{discovery:true,noPlan:true});
 assert.deepEqual(proof,{admissions:2,plans:0,reports:1,source_reads:1,finalizations:1,model_requests:5,dormant_reason:'DORMANT_NO_SIGNAL',woke:true,same_task:true});
});

test('a discovery source integrity failure waits and resumes its original Goal before accepted reporting',{skip:!runtime,timeout:100000},async t=>{
 const proof=await gatewayCase(t,{discovery:true,noPlan:true,discoveryWait:true});
 assert.deepEqual(proof,{admissions:2,plans:0,reports:1,source_reads:1,finalizations:1,model_requests:7,dormant_reason:'DORMANT_NO_SIGNAL',woke:true,same_task:true,wait_recovered:true});
});
