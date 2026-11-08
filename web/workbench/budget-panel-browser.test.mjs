import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer as createViteServer} from 'vite';
import {buildServer as gatewayServer} from '../../packages/gateway/src/server.ts';
import {buildServer as bffServer} from '../../src/server.mjs';

const projectRoot=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const templateRoot=fileURLToPath(new URL('../../packages/gateway/file-engine/templates/',import.meta.url));
const route={provider:'fixture-provider',model:'fixture-model',revision:'browser-fixture-rates-v1',context_window:100,max_output_tokens:20,
 rates:{input:2,output:10,cache_read:1,cache_write:3}};
const replyRoute={provider:'fixture-provider',model:'fixture-reply-judge',revision:'reply-judge-fixture-rates-v1',context_window:2000,max_output_tokens:300,
 rates:{input:2,output:10,cache_read:1,cache_write:2}};
const limits={tokens:50000,nano_usd:500000,model_calls:100};
const budgetConfig=()=>({revision:1,admission_route:{provider:route.provider,model:route.model},routes:[route,replyRoute],
 limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,{...limits}]))});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};

async function makeTask(server,owner,agent,title){
 return server.persistentTasks.create(owner,{title,agent_id:agent.agent_id,objective:'Synthetic browser acceptance fixture',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});
}
function startRun(server,owner,task,key){
 const run=server.persistentTasks.runNow(owner,task.task_id,key);
 server.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);
 return run.run_id;
}
function addAttempt(server,owner,runId,id,purpose,unknown=false){
 server.modelBudgets.reserve(owner,runId,{attempt_id:id,provider:route.provider,model:route.model,max_tokens:20,purpose});
 server.modelBudgets.dispatch(owner,runId,id);
 server.modelBudgets.settle(owner,runId,id,unknown?{inputTokens:20,outputTokens:5}:{inputTokens:20,outputTokens:5,cacheReadTokens:10,cacheWriteTokens:5,totalTokens:40,reasoningTokens:2});
}
function addPendingAttempt(server,owner,runId,id,purpose,state){
 server.modelBudgets.reserve(owner,runId,{attempt_id:id,provider:route.provider,model:route.model,max_tokens:20,...(purpose?{purpose}:{})});
 if(state!=='reserved')server.modelBudgets.dispatch(owner,runId,id);
 if(state==='unknown')server.modelBudgets.markUnknown(owner,runId,id,'usage_incomplete');
}
function settlePendingAttempt(server,owner,runId,id){
 return server.modelBudgets.settle(owner,runId,id,{inputTokens:20,outputTokens:5,cacheReadTokens:10,cacheWriteTokens:5,totalTokens:40,reasoningTokens:2});
}
function addFoldedCacheReplyAttempt(server,owner,runId,id){
 server.modelBudgets.reserve(owner,runId,{attempt_id:id,provider:replyRoute.provider,model:replyRoute.model,max_tokens:replyRoute.max_output_tokens,purpose:'reply-verification'});
 server.modelBudgets.dispatch(owner,runId,id);
 return server.modelBudgets.settle(owner,runId,id,{inputTokens:80,outputTokens:20,cacheReadTokens:20,cacheWriteTokens:0,totalTokens:120,reasoningTokens:0},
  {protocol:1,source:'reply-judge-client',cacheWrite:'folded-unreported'});
}
function accountingCounts(db){
 return {
  attempts:db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,
  events:db.prepare('SELECT count(*) n FROM wb_model_budget_events').get().n,
  scopes:db.prepare('SELECT count(*) n FROM wb_model_budget_scopes').get().n,
 };
}

test('real Chrome budget panel refreshes changed ledger rows without losing pages, rejects foreign lineage and cancels stale cursors',{timeout:120000},async t=>{
 const tempRoot=await mkdtemp(join(projectRoot,'test-tmp/budget-panel-browser-'));
 let gateway,bff,vite,browser,context,pendingGate;
 const origins=[],httpReads=[],pageErrors=[];
 t.after(async()=>{
  pendingGate?.release.resolve();
  await browser?.close();
  await vite?.close();
  if(bff){bff.app.server.closeAllConnections();await bff.close();}
  if(gateway){gateway.app.server.closeAllConnections();await gateway.app.close();gateway.db.close();}
   const child=relative(projectRoot,tempRoot);assert.ok(child&&!child.startsWith('..')&&resolve(tempRoot).startsWith(resolve(projectRoot)+sep));
  await rm(tempRoot,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 });

 await mkdir(join(tempRoot,'public'));
 const csrf='fixture-budget-browser-csrf-token';
 gateway=await gatewayServer({databasePath:join(tempRoot,'gateway.sqlite'),workspaces:['ws'],workbenchRoot:join(tempRoot,'files'),templateRoot,
  csrfToken:csrf,allowedOrigins:[],internalChannelToken:'fixture-budget-browser-internal-token',modelBudgetPolicy:budgetConfig()});
 const ownerAgent=gateway.workbench.createAgent('alice',{name:'Task owner'});
 const taskA=await makeTask(gateway,'alice',ownerAgent,'Budget task A');
 const taskB=await makeTask(gateway,'alice',ownerAgent,'Budget task B');
 const foreignAgent=gateway.workbench.createAgent('bob',{name:'Foreign owner'});
 const foreignTask=await makeTask(gateway,'bob',foreignAgent,'Foreign budget task');
 const runA=startRun(gateway,'alice',taskA,'budget-browser-run-a');
 for(let index=0;index<18;index++){
  addAttempt(gateway,'alice',runA,`attempt-${String(index).padStart(2,'0')}`,'compaction');
  await new Promise(done=>setTimeout(done,2));
 }
 addPendingAttempt(gateway,'alice',runA,'attempt-18-reserved','session-title','reserved');
 await new Promise(done=>setTimeout(done,3));
 addPendingAttempt(gateway,'alice',runA,'attempt-19-in-flight','web-decision','in_flight');
 await new Promise(done=>setTimeout(done,3));
 addPendingAttempt(gateway,'alice',runA,'attempt-20-unknown','emotion','unknown');
 const runB=startRun(gateway,'alice',taskB,'budget-browser-run-b');
 addAttempt(gateway,'alice',runB,'task-b-only','emotion');
 const replyUsage=addFoldedCacheReplyAttempt(gateway,'alice',runB,'task-b-reply-verification');
 assert.equal(replyUsage.state,'settled');assert.deepEqual(replyUsage.actual,{tokens:'120',nano_usd:'380'});
 const runForeign=startRun(gateway,'bob',foreignTask,'budget-browser-run-foreign');
 addAttempt(gateway,'bob',runForeign,'foreign-only','reply-verification');

 let holdNextPage=false,failNextAttemptPage=false;
 gateway.app.addHook('onRequest',async request=>{
  if(request.url.includes('/model-budget'))httpReads.push({method:request.method,url:request.url});
 });
 gateway.app.addHook('onSend',async(request,reply,payload)=>{
  if(failNextAttemptPage&&request.params?.taskId===taskA.task_id&&request.url.includes('/model-budget/attempts')&&request.query?.cursor==='20'){
   failNextAttemptPage=false;reply.code(503);return JSON.stringify({error:'fixture_attempt_read_failed'});
  }
  if(holdNextPage&&request.params?.taskId===taskA.task_id&&request.url.includes('/model-budget/attempts')&&request.query?.cursor==='20'){
   holdNextPage=false;const gate=pendingGate;gate.reached.resolve();await gate.release.promise;gate.finished.resolve();
  }
  return payload;
 });
 const gatewayOrigin=await gateway.app.listen({host:'127.0.0.1',port:0});
 bff=await bffServer({demo:true,database:':memory:',root:join(tempRoot,'bff-files'),publicRoot:join(tempRoot,'public'),
  workbench:{url:gatewayOrigin,owner:'alice',csrf}});
 const bffOrigin=await bff.app.listen({host:'127.0.0.1',port:0});

 const fixtureDirectory=relative(projectRoot,tempRoot).replaceAll('\\','/');
 await writeFile(join(tempRoot,'index.html'),`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/${fixtureDirectory}/app.tsx"></script>`);
 await writeFile(join(tempRoot,'app.tsx'),`import React,{useState} from 'react';
import{createRoot}from'react-dom/client';
import TaskBudgetPanel from '../../web/workbench/TaskBudgetPanel.tsx';
import{request}from'../../web/jot/client.ts';
function App(){const[taskId,setTaskId]=useState(${JSON.stringify(taskA.task_id)});return <><button onClick={()=>setTaskId(${JSON.stringify(taskB.task_id)})}>切换到任务 B</button><button onClick={()=>setTaskId(${JSON.stringify(taskA.task_id)})}>切换到任务 A</button><button onClick={()=>setTaskId(${JSON.stringify(foreignTask.task_id)})}>切换到外部任务</button><TaskBudgetPanel taskId={taskId}/></>}
request('/capabilities').then(()=>createRoot(document.getElementById('root')!).render(<App/>));`);
 vite=await createViteServer({configFile:false,root:projectRoot,logLevel:'error',appType:'mpa',
  server:{host:'127.0.0.1',port:0,strictPort:true,proxy:{'/workbench-api':{target:bffOrigin,changeOrigin:true}}}});
 await vite.listen();
 const address=vite.httpServer?.address();assert.ok(address&&typeof address!=='string');
 const origin=`http://127.0.0.1:${address.port}`;
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 context=await browser.newContext({viewport:{width:1200,height:900}});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>pageErrors.push(error.message));
 await page.goto(`${origin}/${fixtureDirectory}/index.html`);

 const budgetPanel=page.getByRole('region',{name:'模型预算与消耗'}),history=page.getByRole('region',{name:'模型调用记录'}),rows=history.locator('.wb-ledger-item');
 await page.waitForFunction(()=>document.querySelectorAll('[aria-label="模型调用记录"] .wb-ledger-item').length===20);
 await budgetPanel.getByText('正在加载调用记录…',{exact:true}).waitFor({state:'detached'});
 assert.equal(await rows.count(),20,'first response should render only this task’s first 20 ledger rows');
 assert.match(await history.innerText(),/费用按配置费率核算（非供应商账单）/);
 assert.equal(await history.getByText('回复核验',{exact:true}).count(),0,'another task’s rows must not enter this task lineage');
 const reservedRow=rows.nth(18),inFlightRow=rows.nth(19);
 assert.match(await reservedRow.innerText(),/已预留/);
 assert.match(await inFlightRow.innerText(),/执行中/);
 assert.equal(await history.getByText('用量未知；不会按 0 估算',{exact:true}).count(),0,'the unknown attempt is on the next page');

 await history.getByRole('button',{name:'加载更多调用'}).click();
 await page.waitForFunction(()=>document.querySelectorAll('[aria-label="模型调用记录"] .wb-ledger-item').length===21);
 await budgetPanel.getByText('正在加载调用记录…',{exact:true}).waitFor({state:'detached'});
 assert.equal(await rows.count(),21,'loading the next cursor should retain the prior page and append the next row');
 const unknownRow=rows.nth(20);
 assert.match(await unknownRow.innerText(),/结果未知/);
 assert.equal(await history.getByText('用量未知；不会按 0 估算',{exact:true}).count(),1);
 assert.equal(await history.getByText('结算：未知（用量未确认）',{exact:true}).count(),3,'all three unsettled ledger states must stay visibly unknown');
 assert.equal(await history.getByText('回复核验',{exact:true}).count(),0,'task B remains excluded after pagination');

 settlePendingAttempt(gateway,'alice',runA,'attempt-20-unknown');
 gateway.modelBudgets.dispatch('alice',runA,'attempt-18-reserved');
 settlePendingAttempt(gateway,'alice',runA,'attempt-18-reserved');
 settlePendingAttempt(gateway,'alice',runA,'attempt-19-in-flight');
 const baseline=accountingCounts(gateway.db);
 const attemptReadsBeforeRefresh=httpReads.filter(item=>item.url.includes(`/persistent-tasks/${taskA.task_id}/model-budget/attempts`)).length;
 await page.getByRole('button',{name:'刷新预算'}).click();
 await reservedRow.getByText('已结算',{exact:true}).waitFor();
 await inFlightRow.getByText('已结算',{exact:true}).waitFor();
 await unknownRow.getByText('已结算',{exact:true}).waitFor();
 assert.equal(await rows.count(),21,'refresh must preserve both previously loaded pages without duplicate rows');
 assert.match(await reservedRow.innerText(),/总 Token\s+40/);
 assert.match(await inFlightRow.innerText(),/总 Token\s+40/);
 assert.match(await unknownRow.innerText(),/总 Token\s+40/);
 assert.equal(await history.getByText('用量未知；不会按 0 估算',{exact:true}).count(),0,'the same original attempts are now settled with known usage');
 const refreshReads=httpReads.filter(item=>item.url.includes(`/persistent-tasks/${taskA.task_id}/model-budget/attempts`)).slice(attemptReadsBeforeRefresh);
 assert.ok(refreshReads.some(item=>item.url.includes('?limit=20')&&!item.url.includes('cursor=')),'refresh must reread the first loaded page');
 assert.ok(refreshReads.some(item=>item.url.includes('cursor=20')),'refresh must reread the other loaded page');
 assert.deepEqual(accountingCounts(gateway.db),baseline,'real browser GET pagination must not reserve, settle, add attempts or mutate scopes');

 await page.getByRole('button',{name:'切换到任务 B'}).click();
 await page.getByRole('region',{name:'模型调用记录'}).getByText('回复核验',{exact:true}).waitFor();
 const taskBHistory=page.getByRole('region',{name:'模型调用记录'});
 assert.equal(await taskBHistory.locator('.wb-ledger-item').count(),2);
 const replyRow=taskBHistory.locator('.wb-ledger-item').filter({hasText:'回复核验'});assert.equal(await replyRow.count(),1);
 assert.match(await replyRow.innerText(),/已结算；部分用量分桶未知/);
 assert.match(await replyRow.innerText(),/输入 Token\s+未知/);
 assert.match(await replyRow.innerText(),/缓存写入 Token\s+未知/);
 assert.match(await replyRow.innerText(),/总 Token\s+120/);
 assert.equal(await taskBHistory.getByText('上下文压缩',{exact:true}).count(),0,'changing task must not retain task A’s page');
 const foreignResponse=await page.evaluate(async taskId=>{
  const response=await fetch(`/workbench-api/v1/persistent-tasks/${encodeURIComponent(taskId)}/model-budget/attempts?limit=20`);
  return response.status;
 },foreignTask.task_id);
 assert.equal(foreignResponse,404,'the authenticated BFF owner cannot read another owner’s attempt lineage');
 assert.deepEqual(accountingCounts(gateway.db),baseline,'foreign and same-owner history reads remain side-effect free');

 await page.reload();
 await page.waitForFunction(()=>document.querySelectorAll('[aria-label="模型调用记录"] .wb-ledger-item').length===20);
 await budgetPanel.getByText('正在加载调用记录…',{exact:true}).waitFor({state:'detached'});
 failNextAttemptPage=true;
 await page.getByRole('region',{name:'模型调用记录'}).getByRole('button',{name:'加载更多调用'}).click();
 const readFailure=budgetPanel.getByRole('alert').filter({hasText:'调用记录读取失败'});
 await readFailure.waitFor();
 await readFailure.getByRole('button',{name:'重试'}).click();
 await readFailure.waitFor({state:'detached'});
 await page.waitForFunction(()=>document.querySelectorAll('[aria-label="模型调用记录"] .wb-ledger-item').length===21);
 await budgetPanel.getByText('正在加载调用记录…',{exact:true}).waitFor({state:'detached'});
 const gate={reached:deferred(),release:deferred(),finished:deferred()};pendingGate=gate;holdNextPage=true;
 const staleRequestFailed=page.waitForEvent('requestfailed',{predicate:request=>request.url().includes(`/workbench-api/v1/persistent-tasks/${taskA.task_id}/model-budget/attempts?limit=20&cursor=20`)});
 await page.getByRole('button',{name:'刷新预算'}).click();
 await gate.reached.promise;
 await page.getByRole('button',{name:'切换到任务 B'}).click();
 await page.getByRole('region',{name:'模型调用记录'}).getByText('情绪分析',{exact:true}).waitFor();
 await staleRequestFailed;
 gate.release.resolve();await gate.finished.promise;pendingGate=null;
 assert.equal(await page.getByRole('region',{name:'模型调用记录'}).locator('.wb-ledger-item').count(),2);
 assert.equal(await page.getByRole('region',{name:'模型调用记录'}).getByText('用量未知；不会按 0 估算',{exact:true}).count(),0,'the aborted old cursor page must not overwrite task B');
 assert.deepEqual(accountingCounts(gateway.db),baseline,'cancelling the stale GET and loading task B does not mutate the ledger');
 assert.ok(httpReads.filter(item=>item.url.includes('/model-budget')).every(item=>item.method==='GET'));
 assert.deepEqual(pageErrors,[],'the real React page should not throw browser errors');
});
