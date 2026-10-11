import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';
import {buildServer} from '../../src/server.ts';
const pythonSource=String.raw`import sys,json
sys.path.insert(0,sys.argv[1])
from web_decision.budget import bind_budget,ticket_client,invoke_provider_call,BudgetFailure
config=json.load(sys.stdin);calls=[]
client=ticket_client(config['origin'],config['grant'])
if config['mode']=='positive':
 def invoke(value):calls.append(1);return {'result':'synthetic'}
 usage=lambda result:{'inputTokens':20,'outputTokens':5,'cacheReadTokens':0,'cacheWriteTokens':0,'totalTokens':25}
 with bind_budget(client):
  first=invoke_provider_call('laya','multilingual','http-fixture',{'task':'synthetic'},invoke,usage)
  second=invoke_provider_call('laya','multilingual','http-fixture',{'task':'synthetic'},invoke,usage)
  assert first==second=={'result':'synthetic'} and len(calls)==1
  try:invoke_provider_call('laya','multilingual','http-fixture',{'task':'changed'},invoke,usage);raise AssertionError('changed payload admitted')
  except BudgetFailure:pass
 try:ticket_client(config['origin'],'0'*64)({'action':'reserve'});raise AssertionError('invalid grant admitted')
 except BudgetFailure:pass
 print(json.dumps({'calls':len(calls),'replayed':True,'invalid_grant_denied':True,'changed_payload_denied':True}))
else:
 try:
  with bind_budget(client):invoke_provider_call('laya','multilingual','after-lease-change',{'task':'new'},lambda r:calls.append(1),lambda r:{})
  raise AssertionError('revoked lease admitted')
 except BudgetFailure:pass
 assert not calls
 print(json.dumps({'calls':0,'revoked_lease_denied':True}))
`;
function client(config){return new Promise((resolve,reject)=>{
 const processChild=spawn(process.env.JOT_PYTHON??(process.platform==='win32'?'python':'python3'),['-c',pythonSource,fileURLToPath(new URL('../../../web-decision/',import.meta.url))],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 let out='',size=0;const errors=new Set();const timer=setTimeout(()=>{processChild.kill();reject(Error('python_budget_client_timeout'));},20000);
 processChild.stdout.on('data',chunk=>{size+=chunk.length;if(size>16384){processChild.kill();reject(Error('python_budget_output_limit'));}else out+=chunk});
 processChild.stderr.on('data',chunk=>{for(const code of chunk.toString().match(/\b(?:SyntaxError|TypeError|AttributeError|NameError|ImportError|ModuleNotFoundError|AssertionError|BudgetFailure|RuntimeError|TimeoutError|PermissionError)\b|\bweb_budget_[a-z_]+\b/g)??[])errors.add(code)});
 processChild.once('error',error=>{clearTimeout(timer);reject(error)});processChild.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error('python_budget_client_failed:'+Array.from(errors).join(',')));try{resolve(JSON.parse(out))}catch{reject(Error('python_budget_result_invalid'))}});
 processChild.stdin.end(JSON.stringify(config));
 });}
test('actual Python ticket client settles through Gateway HTTP and denies replay changes, bad grants and replacement leases',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'jot-budget-http-'));const secret=randomBytes(32).toString('hex');let service;
 try{
  service=await buildServer({databasePath:join(dir,'fixture.sqlite'),workspaces:['shared'],workbenchRoot:join(dir,'workspace'),internalChannelToken:secret,templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),emotion:{env:{}},modelBudgetRoutes:[{provider:'laya',model:'multilingual',revision:'synthetic-http-v1',context_window:100,max_output_tokens:10,rates:{input:1,output:2,cache_read:1,cache_write:1}}]});
  const {app,db,workbench,persistentTasks,modelBudgets}=service,owner='fixture-owner';
  const agent=workbench.createAgent(owner,{name:'Transport fixture'}),task=persistentTasks.create(owner,{title:'Synthetic budget fixture',agent_id:agent.agent_id,objective:'No external model',trigger:{kind:'once'}}),run=persistentTasks.runNow(owner,task.task_id,randomUUID());
  db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);const now=new Date().toISOString();
  db.prepare('INSERT INTO ga_worker_leases VALUES(?,?,?,?,?)').run(run.run_id,'fixture-worker',1,String(Date.now()+120000),now);
  db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(run.conversation_id,owner,'fixture-session',now,now);
  const scope=modelBudgets.createScope(owner,'http-fixture',{tokens:1000,nano_usd:1000,model_calls:3});modelBudgets.bindRun(owner,run.run_id,[scope.scope_id]);
  const minted=await app.inject({method:'POST',url:'/internal/v1/workbench/web-budget-grant',headers:{authorization:'Bearer '+secret},payload:{run_id:run.run_id,session_ref:'fixture-session',execution_lease:{owner:'fixture-worker',generation:1},call_id:'fixture-call',tool_name:'universe_search',request_hash:'a'.repeat(64)}});assert.equal(minted.statusCode,200);
  await app.listen({host:'127.0.0.1',port:0});const config={origin:'http://127.0.0.1:'+app.server.address().port,grant:minted.json().grant,mode:'positive'};
  assert.deepEqual(await client(config),{calls:1,replayed:true,invalid_grant_denied:true,changed_payload_denied:true});
  db.prepare('UPDATE ga_worker_leases SET generation=generation+1').run();assert.deepEqual(await client({...config,mode:'negative'}),{calls:0,revoked_lease_denied:true});
  assert.equal(db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,1);assert.deepEqual(modelBudgets.balance(owner,scope.scope_id).used,{tokens:'25',nano_usd:'30',model_calls:'1'});
 }catch(error){console.error('fixture_failure_code',error.message.startsWith('python_budget_')?error.message:'fixture_assertion_or_setup');throw error;}finally{if(service){await service.app.close();if(service.db.isOpen)service.db.close();}rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
