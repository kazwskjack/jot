// Actual Gateway, original Worker and installed DSH. Only Messages responses are scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHostProfile} from '../create-profile.mjs';

const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
const scratch=resolve(tmpdir());
const owner='prd-sdk-owner';
const sourceV1='# Goal\nPRD-V1-FROZEN: deliver a source-backed report.\n# Scope\nRead the requirements, then draft for owner review.\n# Acceptance\nCite the exact source; never publish success before owner confirmation.\n# Dependencies\nInspect requirements before drafting the report.\n';
const sourceV2='# Goal\nPRD-V2-MUST-NOT-ENTER: changed after binding.\n';
const sha=value=>createHash('sha256').update(value).digest('hex');
async function listen(server){await new Promise(done=>server.listen(0,'127.0.0.1',done));return 'http://127.0.0.1:'+server.address().port;}
async function freePort(){const s=createServer();await listen(s);const port=s.address().port;await new Promise(done=>s.close(done));return port;}
async function until(check){const deadline=Date.now()+30000;while(Date.now()<deadline){const value=await check();if(value)return value;await new Promise(done=>setTimeout(done,100));}throw Error('prd_native_acceptance_timeout');}
function cleanEnv(){const env={TEMP:scratch,TMP:scratch};for(const key of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];return env;}
function launch(args,cwd,env){
 const child=spawn(process.execPath,args,{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true});let output='',terminal=false;
 const ended=new Promise(done=>{child.once('exit',()=>{terminal=true;done();});child.once('error',error=>{output+=String(error);terminal=true;done();});});
 for(const stream of [child.stdout,child.stderr])stream.on('data',value=>{output+=value;});
 return {output:()=>output,terminal:()=>terminal,async stop(){if(!terminal)child.kill('SIGTERM');await ended;}};
}
function objects(value){
 if(typeof value==='string'){try{return objects(JSON.parse(value));}catch{return [];}}
 if(!value||typeof value!=='object')return [];
 return [value,...Object.values(value).flatMap(objects)];
}
function toolResults(input){return input.messages.flatMap(m=>Array.isArray(m.content)?m.content.filter(b=>b.type==='tool_result'):[]);}
function returnedSubtask(input,title){return toolResults(input).flatMap(objects).find(v=>v.title===title&&typeof v.subtask_id==='string');}
// Diagnostic codes only: never persist headers, arguments, response bodies or identities.
const diagnosticCode=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,95}$/.test(value)?value:null;

test('bound PRD v1 reaches original DSH task; native workspace tools preserve dependencies, budgets and wait_user',
 {skip:runtime?false:'JOT_DSH_RUNTIME_MODULES is unset: no installed-SDK evidence',timeout:100000},async t=>{
 process.env.TEMP=scratch;process.env.TMP=scratch;await mkdir(scratch,{recursive:true});
 const root=await mkdtemp(join(scratch,'task-prd-native-')),workspace=join(root,'workspace');await mkdir(workspace);
 t.diagnostic('Private fixture: '+root);
 const {buildServer}=await import('../../gateway/src/server.ts');
 const requests=[];let modelFailure,service,host,worker,firstSubtask,secondSubtask,nextReceipt,preview,binding,runId,taskId;
 const internalFailures=[],originalReasons=new WeakMap(),guardSnapshots=new Map();
 let guardDifferences=[];
 const key=randomBytes(32).toString('hex'),adapterToken=randomBytes(32).toString('hex'),internalToken=randomBytes(32).toString('hex'),csrfToken=randomBytes(32).toString('hex');
 const model=createServer(async(req,res)=>{try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(req.method,'POST');assert.match(req.url,/\/messages$/);assert.equal(req.headers['x-api-key'],key);
  requests.push(input);const ordinal=requests.length;
  assert.ok(ordinal<=4,'script must stop after tasks.propose; no fallback planner');
  let operation,argumentsValue;
  if(ordinal===1){
   const text=input.messages.filter(m=>m.role==='user').flatMap(m=>typeof m.content==='string'?[m.content]:(m.content??[]).filter(b=>b.type==='text').map(b=>b.text)).join('\n');
   assert.ok(text.includes(preview.objective),'actual provider input must contain the complete frozen objective');
   assert.ok(text.includes(sourceV1));assert.ok(text.includes(sha(sourceV1)));assert.ok(text.includes('requirements.md'));
   assert.equal(text.includes('PRD-V2-MUST-NOT-ENTER'),false);
   assert.ok(input.dsh_plugin_packages.packages.some(p=>p.name==='jot-dsh-host-preparation'&&p.version==='0.1.0'));
   assert.ok(input.tools.some(tool=>tool.name==='jot_workspace'),'actual provider schema includes the dynamically mounted workspace tool');
   operation='tasks.upsert';argumentsValue={title:'Inspect PRD requirements',acceptance:'Cite requirements.md at frozen v1.',status:'pending',priority:80};
  }else if(ordinal===2){
   firstSubtask=returnedSubtask(input,'Inspect PRD requirements');assert.ok(firstSubtask,'consume first actual native tool result');
   operation='tasks.upsert';argumentsValue={title:'Draft report after inspection',acceptance:'Owner reviews report after inspection.',status:'pending',dependencies:[firstSubtask.subtask_id]};
  }else if(ordinal===3){
   secondSubtask=returnedSubtask(input,'Draft report after inspection');assert.ok(secondSubtask);assert.deepEqual(secondSubtask.dependencies,[firstSubtask.subtask_id]);
   operation='tasks.next';argumentsValue={};
  }else{
   nextReceipt=toolResults(input).flatMap(objects).find(v=>Array.isArray(v.items)&&Array.isArray(v.blocked)&&v.blocked.some(b=>b.subtask_id===secondSubtask.subtask_id));
   assert.ok(nextReceipt,'tasks.next must return the actual blocked dependency');
   assert.equal(nextReceipt.items.length,0,'no readiness assessment or authorization has been fabricated');
   assert.ok(nextReceipt.blocked.some(v=>v.subtask_id===firstSubtask.subtask_id));
   assert.ok(nextReceipt.blocked.find(v=>v.subtask_id===secondSubtask.subtask_id).reasons.length);
   operation='tasks.propose';argumentsValue={intent:'wait_user',summary:'Please confirm the frozen PRD and inspection plan before execution.'};
  }
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  for(const event of [
   {type:'message_start',message:{id:'prd-script-'+ordinal,role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:5,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
   {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'PRD local scripted acceptance'}},
   {type:'content_block_stop',index:0},
   {type:'content_block_start',index:1,content_block:{type:'tool_use',id:'prd-tool-'+ordinal,name:'jot_workspace',input:{operation,arguments_json:JSON.stringify(argumentsValue)}}},
   {type:'content_block_stop',index:1},
   {type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:1}},
   {type:'message_stop'},
  ])res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();
 }catch(error){modelFailure=error;if(!res.headersSent)res.writeHead(500);res.end('prd_script_rejected');}});
 const modelUrl=await listen(model);
 try{
  const route={provider:'deepseek-official',model:'deepseek-flash',revision:'prd-scripted-rates-1',context_window:1000000,max_output_tokens:256000,rates:{input:1,output:1,cache_read:1,cache_write:1}};
  const policy={revision:1,admission_route:{provider:route.provider,model:route.model},routes:[route],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(scope=>[scope,{tokens:10000000,nano_usd:null,model_calls:100}]))};
  const uploadRoot=join(root,'uploads');
  service=await buildServer({databasePath:join(root,'gateway.db'),uploadRoot,workbenchRoot:join(root,'workspaces'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates',import.meta.url)),workspaces:['jot'],internalChannelToken:internalToken,csrfToken,allowedOrigins:['https://fixture.invalid'],modelBudgetPolicy:policy,workbenchExecutionReady:true});
  service.app.addHook('onError',async(request,_reply,error)=>{
   if(['/internal/v1/workbench/tool','/internal/v1/workbench/guard'].includes(request.routeOptions.url))
    originalReasons.set(request,diagnosticCode(error.message));
  });
  service.app.addHook('onSend',async(request,reply,payload)=>{
   const endpoint=request.routeOptions.url;
   if(!['/internal/v1/workbench/tool','/internal/v1/workbench/guard'].includes(endpoint))return payload;
   let response;try{response=JSON.parse(Buffer.isBuffer(payload)?payload.toString():String(payload));}catch{}
   if(endpoint.endsWith('/guard')&&reply.statusCode<400&&response?.context){
    const current=response.context,prior=guardSnapshots.get(request.body?.run_id);
    if(prior){
     guardDifferences=['owner_id','agent_id','workspace_id','project_id','capability_epoch'].filter(field=>prior[field]!==current[field]);
     if(!!prior.model_budget!==!!current.model_budget)guardDifferences.push('model_budget_presence');
    }else guardSnapshots.set(request.body?.run_id,current);
   }
   if(reply.statusCode>=400){
    const failure={status:reply.statusCode,error_code:diagnosticCode(response?.error?.code),operation:diagnosticCode(request.body?.operation)??(endpoint.endsWith('/guard')?'guard':null),call_id:diagnosticCode(request.body?.call_id),original_reason:originalReasons.get(request)??null,guard_differences:guardDifferences};
    internalFailures.push(failure);
    await writeFile(join(root,'internal-tool-failures-private.json'),JSON.stringify(internalFailures,null,2));
   }
   return payload;
  });
  await service.app.listen({host:'127.0.0.1',port:0});const gatewayUrl='http://127.0.0.1:'+service.app.server.address().port;
  const headers={'x-user-id':owner,'content-type':'application/json','x-csrf-token':csrfToken,origin:'https://fixture.invalid'};
  const post=async(path,body,id,status=200)=>{const r=await fetch(gatewayUrl+path,{method:'POST',headers:{...headers,'idempotency-key':id},body:JSON.stringify(body)}),result=await r.json();assert.equal(r.status,status,JSON.stringify(result));return result;};
  const agent=await post('/v1/agents',{name:'PRD SDK role',workspace_id:'jot',instructions:'Use exact source evidence; wait for explicit confirmation.'},'prd-role',201);
  let task=await post('/v1/persistent-tasks',{title:'Original PRD task',agent_id:agent.agent_id,objective:'Original task objective: prepare an owner-reviewed report.',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'},budget:{max_runs:3}},'prd-original',201);taskId=task.task_id;
  task=await post('/v1/persistent-tasks/'+taskId+'/pause',{expected_version:task.version},'prd-pause');
  const source=service.workbench.writeFile(owner,'jot',{project_id:agent.project_id,path:'requirements.md',content:sourceV1,expected_version:0});
  const selection={kind:'logical_file',path:source.path,version:source.version,sha256:source.sha256};assert.equal(selection.version,1);assert.equal(selection.sha256,sha(sourceV1));
  const prepared=await createHostProfile({home:join(root,'home'),workbench:{provider:route.provider,model:route.model,origin:gatewayUrl}}),port=await freePort(),patchPath=join(prepared.directory,'cordis.patch.yml');
  let patch=await readFile(patchPath,'utf8');patch=patch.replace('"port": 18841','"port": '+port).replace('http://127.0.0.1:18831',gatewayUrl).replace('"jotHostReady"','"jotHostReady", "jotHostInspectionReady"');
  const inspection={insert:[{id:'jot-host-inspection',name:new URL('./inspect-host-plugin.mjs',import.meta.url).href,config:{receipt:join(root,'composition.json'),sessionPrefix:'jot-prd-sdk-'}}]};
  patch=patch.trim().replace(/\]$/,', '+JSON.stringify({id:'llm-deepseek',config:{baseURL:modelUrl,apiKeyEnv:'DEEPSEEK_API_KEY',reasoningEffort:'high'}})+', '+JSON.stringify(inspection)+']');await writeFile(patchPath,patch);
  host=launch([join(runtime,'dsh/lib/bin.js'),'--profile','jot','--host','127.0.0.1','--port','0','--no-open'],workspace,{...cleanEnv(),DSH_HOME:join(root,'home'),DSH_TELEMETRY_DISABLED:'1',JOT_SESSION_ADAPTER_TOKEN:adapterToken,GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:internalToken,DEEPSEEK_API_KEY:key});
  const adapterUrl='http://127.0.0.1:'+port;
  await until(async()=>{assert.equal(host.terminal(),false,'installed DSH exited');try{return (await fetch(adapterUrl+'/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(500)})).status===401;}catch{return false;}});
  const tokenFile=join(root,'adapter.token'),policyFile=join(root,'budget-policy.json');await writeFile(tokenFile,adapterToken);await writeFile(policyFile,JSON.stringify(policy));
  worker=launch(['--experimental-strip-types',fileURLToPath(new URL('../../gateway/src/harness/main.ts',import.meta.url))],workspace,{...cleanEnv(),GENERAL_AGENT_DB:join(root,'gateway.db'),GENERAL_AGENT_FILE_ROOT:uploadRoot,GENERAL_AGENT_WORKBENCH_ROOT:join(root,'workspaces'),GENERAL_AGENT_WORKSPACES:'jot',GENERAL_AGENT_SESSION_ADAPTER_URL:adapterUrl,GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE:tokenFile,GENERAL_AGENT_HARNESS_CWD:workspace,GENERAL_AGENT_DSH_AGENT_PRESET:'jot-general',GENERAL_AGENT_DSH_SESSION_PREFIX:'jot-prd-sdk',GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:internalToken,GENERAL_AGENT_WORKER_POLL_MS:'250',GENERAL_AGENT_MODEL_BUDGET_POLICY_FILE:policyFile,GENERAL_AGENT_WORKBENCH_DSH_AGENT_PRESET:'jot-workbench-budgeted',GENERAL_AGENT_WORKBENCH_EXECUTION_READY:'true',GENERAL_AGENT_WORKER_CONCURRENCY:'2'});
  const cold=()=>({tasks:service.db.prepare('SELECT task_id,runs_used,max_runs FROM wb_persistent_tasks').all(),runs:service.db.prepare('SELECT id FROM ga_runs').all(),occurrences:service.db.prepare('SELECT occurrence_id FROM wb_task_occurrences').all(),allocations:service.db.prepare('SELECT * FROM wb_budget_allocations').all(),attempts:service.db.prepare('SELECT * FROM wb_model_budget_attempts').all(),calls:requests.length});
  assert.ok(service.taskPrd,'the public Gateway must expose its registered TaskPrdService');
  const prd=service.taskPrd,before=cold();
  preview=prd.preview(owner,taskId,{source:selection});assert.equal(preview.execution_authorized,false);assert.equal(preview.content,sourceV1);assert.ok(preview.objective.includes(sourceV1));assert.deepEqual(cold(),before);
  await new Promise(done=>setTimeout(done,650));assert.equal(requests.length,0,'unconfirmed preview with live original Worker cannot call a model');
  binding=prd.bind(owner,taskId,{source:selection,preview_sha256:preview.preview_sha256},'prd-bind');assert.equal(binding.execution_authorized,false);assert.equal(binding.task_id,taskId);assert.deepEqual(cold(),before);
  assert.deepEqual(prd.bind(owner,taskId,{source:selection,preview_sha256:preview.preview_sha256},'prd-bind'),binding);assert.deepEqual(cold(),before);
  task=service.persistentTasks.get(owner,taskId);assert.equal(task.status,'paused');assert.equal(task.objective,preview.objective);
  service.workbench.writeFile(owner,'jot',{project_id:agent.project_id,path:'requirements.md',content:sourceV2,expected_version:1});
  await new Promise(done=>setTimeout(done,650));assert.deepEqual(cold(),before,'binding and source mutation cannot dispatch or rebuild budgets');
  task=await post('/v1/persistent-tasks/'+taskId+'/resume',{expected_version:task.version},'prd-explicit-resume');assert.equal(task.task_id,taskId);
  const accepted=await post('/v1/persistent-tasks/'+taskId+'/run-now',{},'prd-explicit-run',202);runId=accepted.run_id;
  const occurrenceBefore=service.db.prepare('SELECT occurrence_id,task_id,run_id FROM wb_task_occurrences').all();assert.equal(occurrenceBefore.length,1);assert.equal(occurrenceBefore[0].task_id,taskId);assert.equal(occurrenceBefore[0].run_id,runId);
  const allocationsBefore=service.db.prepare('SELECT * FROM wb_budget_allocations').all();assert.equal(allocationsBefore.length,1);
  const scopes=JSON.parse(allocationsBefore[0].allocation_json).scopes;assert.equal(scopes.filter(s=>s.key.startsWith('task-total:')).length,1);assert.equal(scopes.filter(s=>s.key.startsWith('occurrence:')).length,1);
  const stopped=await until(async()=>{if(modelFailure)throw modelFailure;assert.equal(worker.terminal(),false,'original Worker exited');const value=await (await fetch(gatewayUrl+'/v1/runs/'+runId,{headers})).json();return ['waiting_user','waiting_approval','failed','interrupted','succeeded'].includes(value.status)&&value;});
  assert.equal(stopped.status,'waiting_user',JSON.stringify(stopped));assert.equal(requests.length,4);
  assert.deepEqual(service.db.prepare('SELECT occurrence_id,task_id,run_id FROM wb_task_occurrences').all(),occurrenceBefore);
  assert.deepEqual(service.db.prepare('SELECT * FROM wb_budget_allocations').all(),allocationsBefore,'original occurrence and task-total scope IDs remain unchanged');
  assert.deepEqual(service.db.prepare('SELECT id FROM ga_runs').all().map(r=>r.id),[runId]);
  task=service.persistentTasks.get(owner,taskId);assert.equal(task.objective,preview.objective);assert.equal(task.runs_used,1);assert.equal(task.budget.max_runs,3);assert.equal(service.persistentTasks.list(owner).items.length,1);
  const subtasks=service.persistentTasks.subtasks(owner,taskId).items;assert.equal(subtasks.length,2);assert.deepEqual(subtasks.find(s=>s.subtask_id===secondSubtask.subtask_id).dependencies,[firstSubtask.subtask_id]);
  assert.deepEqual(nextReceipt,service.persistentTasks.readiness(owner,taskId).next);
  const composition=JSON.parse(await readFile(join(root,'composition.json'),'utf8'));assert.equal(composition.preset,'jot-workbench-budgeted');assert.equal(composition.mounted,true);assert.equal(composition.approval,'ask');assert.equal(composition.permission,'workspace-write');
  assert.equal(composition.events.filter(e=>e.sourceRpcId===runId).length,1);
  const goalResponse=await fetch(adapterUrl+'/v1/sessions/'+composition.sessionId+'/goal-status',{method:'POST',headers:{authorization:'Bearer '+adapterToken,'content-type':'application/json'},body:'{}'}),native=(await goalResponse.json()).state;
  assert.equal(goalResponse.status,200);assert.ok(native.goal.goal_id);assert.equal(native.goal.phase,'paused');assert.equal(native.goal.activation,'disarmed');assert.equal(native.host_status,'idle');assert.equal(native.task.run_status,'waiting_user');
  assert.ok(service.db.prepare('SELECT checkpoint_id FROM ga_runs WHERE id=?').get(runId).checkpoint_id);
  assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_finalizations').get().n,0);assert.equal(service.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
  const balances=service.modelBudgets.balancesForRun(owner,runId);assert.ok(balances.length);for(const balance of balances){assert.equal(balance.used.tokens,'24');assert.equal(balance.used.model_calls,'4');assert.equal(balance.held.tokens,'0');assert.equal(balance.held.model_calls,'0');}
  assert.equal(service.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts WHERE run_id=? AND state='settled'").get(runId).n,4);assert.equal(service.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts WHERE state IN ('reserved','in_flight','unknown')").get().n,0);
  const stable={runs:service.db.prepare('SELECT * FROM ga_runs').all(),allocations:service.db.prepare('SELECT * FROM wb_budget_allocations').all(),calls:requests.length};
  assert.deepEqual(await post('/v1/persistent-tasks/'+taskId+'/run-now',{},'prd-explicit-run',202),accepted);
  await new Promise(done=>setTimeout(done,750));assert.deepEqual({runs:service.db.prepare('SELECT * FROM ga_runs').all(),allocations:service.db.prepare('SELECT * FROM wb_budget_allocations').all(),calls:requests.length},stable);
  const installed=JSON.parse(await readFile(join(runtime,'dsh/package.json'),'utf8'));
  const proof={officialLauncher:true,realGateway:true,realWorker:true,installedSDK:installed.version,modelTransport:'scripted local Messages HTTP; no real-provider quality or money evidence',modelRequests:requests.length,internalFailureCount:internalFailures.length,taskId,runId,occurrenceId:occurrenceBefore[0].occurrence_id,nativeGoalId:native.goal.goal_id,budgetScopes:scopes,sourceVersion:binding.source.version,sourceSha256:binding.content_sha256,objectiveSha256:sha(preview.objective),subtasks:subtasks.length,next:nextReceipt,status:stopped.status,production:false};
  await writeFile(join(root,'proof.json'),JSON.stringify(proof,null,2));t.diagnostic(JSON.stringify(proof));
 }catch(error){
  const lastToolResults=requests.at(-1)?toolResults(requests.at(-1)):[];
  if(internalFailures.length||JSON.stringify(lastToolResults).includes('workbench_run_forbidden'))
   await writeFile(join(root,'forbidden-diagnosis-private.json'),JSON.stringify({internalFailures,guard_differences:guardDifferences,native_forbidden:JSON.stringify(lastToolResults).includes('workbench_run_forbidden')},null,2));
  await writeFile(join(root,'failure-private.json'),JSON.stringify({error:String(error),cause:String(error.cause??''),host:host?.output(),worker:worker?.output(),calls:requests.length,lastToolResults},null,2));throw error;
 }
 finally{await worker?.stop();await host?.stop();if(service){await service.app.close();service.db.close();}model.closeAllConnections();await new Promise(done=>model.close(done));}
});
