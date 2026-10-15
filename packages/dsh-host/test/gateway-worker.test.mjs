// The model HTTP endpoint is synthetic; Gateway/Worker/DSH services are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
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

async function gatewayCase(t,{role=false,persistent=false}={}){
 role ||= persistent;
 const {buildServer}=await import('../../gateway/src/server.ts');
 const root=await mkdtemp(join(tmpdir(),'jot-gateway-host-')),home=join(root,'home'),workspace=join(root,'workspace');await mkdir(workspace);
 let host,worker,service,succeeded=false;const requests=[];
 const modelKey='sk-'+randomBytes(32).toString('hex'),adapterToken=randomBytes(32).toString('hex'),internalToken=randomBytes(32).toString('hex');
 const model=createServer(async(req,res)=>{try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(req.method,'POST');assert.match(req.url,/\/messages$/);assert.equal(req.headers['x-api-key'],modelKey);
  requests.push(input);res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  const toolEvents=persistent?[
   {type:'content_block_start',index:1,content_block:{type:'tool_use',id:'synthetic-wait-call',name:'jot_workspace',input:{operation:'tasks.propose',arguments_json:JSON.stringify({intent:'wait_user',summary:'Please confirm the next step.'})}}},
   {type:'content_block_stop',index:1},
  ]:[];
  for(const event of [
   {type:'message_start',message:{id:'synthetic-message',role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:5,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
   {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'ACCEPTANCE-OK'}},
   {type:'content_block_stop',index:0},
   ...toolEvents,
   {type:'message_delta',delta:{stop_reason:persistent?'tool_use':'end_turn'},usage:{output_tokens:1}},
   {type:'message_stop'},
  ])res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();
 }catch{res.writeHead(500);res.end('synthetic_protocol_request_rejected');}});
 const modelUrl=await listen(model);
 const route={provider:'deepseek-official',model:'deepseek-flash',revision:'synthetic-rates-1',context_window:1000000,max_output_tokens:256000,rates:{input:1,output:1,cache_read:1,cache_write:1}};
 const policy={revision:1,admission_route:{provider:route.provider,model:route.model},routes:[route],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,{tokens:10000000,nano_usd:null,model_calls:100}]))};
 try{
  service=await buildServer({databasePath:join(root,'gateway.db'),uploadRoot:join(root,'files'),workbenchRoot:join(root,'workspaces'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates',import.meta.url)),workspaces:['jot'],internalChannelToken:internalToken,...(role?{modelBudgetPolicy:policy,workbenchExecutionReady:true}:{})});
  await service.app.listen({host:'127.0.0.1',port:0});const gatewayUrl='http://127.0.0.1:'+service.app.server.address().port;
  const prepared=await createHostProfile({home,...(role?{workbench:{provider:route.provider,model:route.model,origin:gatewayUrl}}:{})}),port=await freePort(),patchPath=join(prepared.directory,'cordis.patch.yml');
  let patch=await readFile(patchPath,'utf8');patch=patch.replace('"port": 18841','"port": '+port).replace('http://127.0.0.1:18831',gatewayUrl).replace('"jotHostReady"','"jotHostReady", "jotHostInspectionReady"');
  const inspection={insert:[{id:'jot-host-inspection',name:pathToFileURL(fileURLToPath(new URL('./inspect-host-plugin.mjs',import.meta.url))).href,config:{receipt:join(root,'composition.json'),sessionPrefix:'jot-host-acceptance-'}}]};
  patch=patch.trim().replace(/\]$/,', '+JSON.stringify({id:'llm-deepseek',config:{baseURL:modelUrl,apiKeyEnv:'DEEPSEEK_API_KEY',reasoningEffort:'high'}})+', '+JSON.stringify(inspection)+']');await writeFile(patchPath,patch);
  host=launch([join(runtime,'dsh/lib/bin.js'),'--profile','jot','--host','127.0.0.1','--port','0','--no-open'],workspace,{...cleanEnv(),DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',JOT_SESSION_ADAPTER_TOKEN:adapterToken,GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:internalToken,DEEPSEEK_API_KEY:modelKey});
  const adapterUrl='http://127.0.0.1:'+port;
  await until(async()=>{assert.equal(host.terminal(),false,'official host exited');try{return (await fetch(adapterUrl+'/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(500)})).status===401;}catch{return false;}});
  const tokenFile=join(root,'adapter.token');await writeFile(tokenFile,adapterToken,{mode:0o600});
  const policyFile=join(root,'budget-policy.json');if(role)await writeFile(policyFile,JSON.stringify(policy));
  const headers={'x-user-id':'acceptance-owner','content-type':'application/json'};
  let conversation_id,messageUrl,messageBody;
  if(role){const response=await fetch(gatewayUrl+'/v1/agents',{method:'POST',headers,body:JSON.stringify({name:'Acceptance role',workspace_id:'jot',instructions:'Reply clearly using the provided evidence.'})});assert.equal(response.status,201);const agent=await response.json();conversation_id=agent.conversation_id;messageUrl='/v1/agents/'+agent.agent_id+'/messages';messageBody={client_message_id:'acceptance-one',text:'Reply with the single word ACCEPTANCE-OK.'};
   if(persistent){const created=await fetch(gatewayUrl+'/v1/persistent-tasks',{method:'POST',headers:{...headers,'idempotency-key':'acceptance-task'},body:JSON.stringify({title:'Wait for confirmation',agent_id:agent.agent_id,objective:'Ask the user to confirm before any further work.',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'},budget:{max_runs:1}})});const task=await created.json();assert.equal(created.status,201,JSON.stringify(task));messageUrl='/v1/persistent-tasks/'+task.task_id+'/run-now';messageBody={};}
  }
  else{const conversation=await fetch(gatewayUrl+'/v1/conversations',{method:'POST',headers,body:JSON.stringify({title:'Synthetic local model acceptance',workspace_id:'jot',model:{provider:'deepseek-official',model:'deepseek-flash'}})});assert.equal(conversation.status,201);({conversation_id}=await conversation.json());messageUrl='/v1/conversations/'+conversation_id+'/messages';messageBody={client_message_id:'acceptance-one',content:[{type:'text',text:'Reply with the single word ACCEPTANCE-OK.'}]};}
  const postMessage=()=>fetch(gatewayUrl+messageUrl,{method:'POST',headers:{...headers,'idempotency-key':'acceptance-one'},body:JSON.stringify(messageBody)});
  const posted=await postMessage();assert.equal(posted.status,202);const accepted=await posted.json(),run_id=accepted.run_id;if(persistent)conversation_id=accepted.conversation_id;
  worker=launch(['--import',new URL('./trace-gateway-fetch.mjs',import.meta.url).href,'--experimental-strip-types',fileURLToPath(new URL('../../gateway/src/harness/main.ts',import.meta.url))],workspace,{...cleanEnv(),JOT_ACCEPTANCE_FETCH_TRACE:join(root,'fetch-status.jsonl'),GENERAL_AGENT_DB:join(root,'gateway.db'),GENERAL_AGENT_FILE_ROOT:join(root,'files'),GENERAL_AGENT_WORKBENCH_ROOT:join(root,'workspaces'),GENERAL_AGENT_WORKSPACES:'jot',GENERAL_AGENT_SESSION_ADAPTER_URL:adapterUrl,GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE:tokenFile,GENERAL_AGENT_HARNESS_CWD:workspace,GENERAL_AGENT_DSH_AGENT_PRESET:'jot-general',GENERAL_AGENT_DSH_SESSION_PREFIX:'jot-host-acceptance',GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:internalToken,GENERAL_AGENT_WORKER_POLL_MS:'250',...(role?{GENERAL_AGENT_MODEL_BUDGET_POLICY_FILE:policyFile,GENERAL_AGENT_WORKBENCH_DSH_AGENT_PRESET:'jot-workbench-budgeted',GENERAL_AGENT_WORKBENCH_EXECUTION_READY:'true',GENERAL_AGENT_WORKER_CONCURRENCY:'2'}:{})});
  const run=await until(async()=>{assert.equal(worker.terminal(),false,'official gateway worker exited');const current=await (await fetch(gatewayUrl+'/v1/runs/'+run_id,{headers})).json();if(['succeeded','failed','interrupted','waiting_user','waiting_approval'].includes(current.status))return current;return false;});
  assert.equal(run.status,persistent?'waiting_user':'succeeded',JSON.stringify(run));assert.equal(requests.length,1);assert.equal(requests[0].model,'deepseek-flash');
  assert.ok(requests[0].dsh_plugin_packages.packages.some(item=>item.name==='jot-dsh-host-preparation'&&item.version==='0.1.0'));
  const composition=JSON.parse(await readFile(join(root,'composition.json'),'utf8'));
  assert.equal(composition.preset,role?'jot-workbench-budgeted':'jot-general');assert.equal(composition.mounted,true);assert.equal(composition.approval,'ask');assert.equal(composition.permission,'workspace-write');assert.equal(composition.sandbox.workspaceRoot,workspace);
  assert.deepEqual(composition.model,{provider:'deepseek-official',model:'deepseek-flash'});
  assert.equal(composition.events.filter(event=>event.sourceRpcId===run_id).length,1);
  const ended=composition.events.findLast(event=>event.type==='turn/end')?.reason;
  if(persistent){assert.equal(ended.kind,'error');assert.equal(ended.error.message,'workbench_goal_stopped');}
  else assert.equal(ended.kind,'completed');
  assert.ok(JSON.stringify(requests[0].messages).includes(persistent?'Ask the user to confirm':'ACCEPTANCE-OK'));
  const snapshot=await (await fetch(gatewayUrl+'/v1/conversations/'+conversation_id+'/snapshot',{headers})).json();
  const replies=snapshot.messages.filter(message=>message.role==='assistant'&&message.status==='complete');assert.equal(replies.length,persistent?0:1);if(!persistent)assert.ok(JSON.stringify(replies[0]).includes('ACCEPTANCE-OK'));
  if(persistent)assert.equal(service.db.prepare("SELECT count(*) n FROM ga_messages WHERE run_id=? AND role='assistant'").get(run_id).n,0);
  if(persistent){const cards=await (await fetch(gatewayUrl+'/v1/conversations/'+conversation_id+'/interactions',{headers})).json();assert.ok(cards.items.length>0);assert.ok(service.db.prepare('SELECT checkpoint_id FROM ga_runs WHERE id=?').get(run_id).checkpoint_id);
   const response=await fetch(adapterUrl+'/v1/sessions/'+composition.sessionId+'/goal-status',{method:'POST',headers:{authorization:'Bearer '+adapterToken,'content-type':'application/json'},body:'{}'});const observed=await response.json();assert.equal(response.status,200,JSON.stringify(observed));assert.equal(observed.state.goal.phase,'paused');assert.equal(observed.state.goal.activation,'disarmed');assert.equal(observed.state.host_status,'idle');assert.equal(observed.state.task.run_status,'waiting_user');
  }
  const retry=await postMessage();
  const retried=await retry.json();assert.equal(retry.status,202,JSON.stringify(retried));assert.equal(retried.run_id,run_id);assert.equal(requests.length,1);
  if(role){const settled=service.db.prepare("SELECT actual_tokens FROM wb_model_budget_attempts WHERE run_id=? AND state='settled'").all(run_id);assert.equal(settled.length,1);assert.equal(Number(settled[0].actual_tokens),6);assert.equal(service.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts WHERE run_id=? AND state IN ('reserved','in_flight','unknown')").get(run_id).n,0);}
  assert.equal(host.output().includes('entry did not activate'),false);
  t.diagnostic(JSON.stringify({officialLauncher:true,realGateway:true,realWorker:true,role,persistent,modelTransport:'synthetic local Messages HTTP',modelRequests:requests.length,replyCount:replies.length,status:run.status,production:false}));succeeded=true;
 }catch(error){await writeFile(join(root,'startup-private.log'),JSON.stringify({host:host?.output(),worker:worker?.output(),modelRequests:requests.length},null,2));throw Error('gateway_host_acceptance_failed; private diagnostics: '+root,{cause:error});}
 finally{await worker?.stop();await host?.stop();if(service){await service.app.close();service.db.close();}model.closeAllConnections();await new Promise(done=>model.close(done));if(succeeded)await rm(root,{recursive:true,force:true});}
}
test('real Gateway and worker commit one reply from an official DSH host through the Messages HTTP transport',{skip:!runtime,timeout:60000},t=>gatewayCase(t));
test('a saved Gateway role runs on the explicit budgeted host composition',{skip:!runtime,timeout:60000},t=>gatewayCase(t,{role:true}));
test('a real persistent task checkpoints its native Goal and waits for the user without publishing success',{skip:!runtime,timeout:60000},t=>gatewayCase(t,{persistent:true}));
