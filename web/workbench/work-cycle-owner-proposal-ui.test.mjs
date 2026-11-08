import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {acceptedWorkCycleFixture} from '../../packages/gateway/test/always-on/work-cycle-fixture.mjs';

const projectRoot=resolve(process.env.JOT_M08_PRODUCT_ROOT??fileURLToPath(new URL('../../',import.meta.url)));
const projectRequire=createRequire(join(projectRoot,'package.json'));
const {build}=projectRequire('esbuild');
const {chromium}=projectRequire('playwright');
const agentId='agent-discovery-ui',workspaceId='workspace-ui',projectId='project-ui';
const draftScope='6'.repeat(64),reportSha='a'.repeat(64),planSha='b'.repeat(64);

test('browser rejects stale and unaccepted proposals, then recovers the current work-cycle receipt',async t=>{
 const live=await acceptedWorkCycleFixture(t,{count:1});
 const agentId=live.agent.agent_id,workspaceId=live.scope.workspace_id,projectId=live.scope.project_id;
 const policy={...live.policies.get('owner',live.scope).policy,mode:'discover_and_work'},currentDetail=live.history.detail('owner',live.scope,live.admission.admission_id),current=currentDetail.cycle;
 const tempRoot=mkdtempSync(join(resolve(process.env.TEMP??tmpdir()),'work-cycle-owner-proposal-ui-'));
 let browser;
 t.after(async()=>{await browser?.close();rmSync(tempRoot,{recursive:true,force:true,maxRetries:5,retryDelay:20});});

 const bundle=await build({
  stdin:{
   contents:[
    "import React from 'react';",
    "import {createRoot} from 'react-dom/client';",
    "import {workbenchApi} from './web/workbench/client';",
    "import DiscoveryPolicyPanel from './web/workbench/DiscoveryPolicyPanel';",
    "const agent="+JSON.stringify({...live.agent,name:'Researcher'})+";",
    "void workbenchApi.capabilities().then(()=>createRoot(document.getElementById('root')).render(React.createElement(DiscoveryPolicyPanel,{agent,onClose:()=>{},onChanged:()=>{}}))).catch(error=>{document.getElementById('root').textContent=String(error)});",
   ].join('\n'),
   resolveDir:projectRoot,
   sourcefile:'work-cycle-owner-proposal-ui.tsx',
   loader:'tsx',
  },
  bundle:true,platform:'browser',format:'iife',write:false,logLevel:'silent',
 });
 const pageData={agentId,workspaceId,projectId,draftScope,reportSha,planSha};
 const cycle=(admissionId,revision,accepted,reportId,sha,summary)=>({admission_id:admissionId,occurrence_id:'occurrence-'+admissionId,task_id:'task-ui',signal_revision:revision,created_at:'2026-10-25T00:00:00.000Z',run:{run_id:'run-'+admissionId,status:'succeeded',business_state:'waiting_approval'},report:{report_id:reportId,sha256:sha,outcome:'proposals',summary,plan_count:1},accepted});
 const stale=cycle('admission-stale',current.signal_revision-1,true,'report-stale',reportSha,'Stale source proposal');
 const rejected=cycle('admission-rejected',current.signal_revision+1,false,'report-rejected','e'.repeat(64),'Owner-rejected proposal');rejected.run.business_state='acceptance_rejected';
 assert.ok(stale.signal_revision<current.signal_revision,'the replacement proposal is based on a newer source revision');
 const plan=(id,sha,summary)=>({plan_id:id,sha256:sha,summary,rationale:'The report contains one bounded proposal.',changes:[{path:'source.md',description:'Review the pinned source',steps:['Inspect the source'],verification:['Compare the source hash']}],evidence:[]});
 const details={
  'admission-stale':{cycle:stale,plans:[plan('plan-stale',planSha,'Stale proposal')],report:{report_id:'report-stale',sha256:reportSha,outcome:'proposals',summary:'Stale source proposal',limitations:[],plan_ids:['plan-stale'],evidence:[],coverage:{signal_count:1,fully_read:1}},next_after_plan_id:null,execution_authorized:false},
  [current.admission_id]:currentDetail,
  'admission-rejected':{cycle:rejected,plans:[plan('plan-rejected','f'.repeat(64),'Rejected proposal')],report:{report_id:'report-rejected',sha256:'e'.repeat(64),outcome:'proposals',summary:'Owner-rejected proposal',limitations:[],plan_ids:['plan-rejected'],evidence:[],coverage:{signal_count:1,fully_read:1}},next_after_plan_id:null,execution_authorized:false},
 };
 pageData.cycles=[current,stale,rejected];pageData.details=details;
 const effectCounts=()=>['ga_runs','wb_task_occurrences','wb_model_budget_attempts','wb_budget_allocations'].map(table=>live.db.prepare('SELECT count(*) n FROM '+table).get().n),beforeEffects=effectCounts();
 browser=await chromium.launch({headless:true,...(process.platform==='win32'?{executablePath:process.env.JOT_M08_BROWSER_EXECUTABLE??'C:/Program Files/Google/Chrome/Application/chrome.exe'}:{})});
 const page=await browser.newPage();page.setDefaultTimeout(12000);
 const routeCalls=[],routeReplies=[];
 await page.exposeFunction('__invokeWorkCycleRoute',async request=>{
  const response=await live.server.app.inject({method:request.method,url:request.path.replace('/workbench-api',''),headers:{'x-user-id':'owner','x-csrf-token':request.headers.csrf,origin:'https://fixture.invalid','idempotency-key':request.headers.idempotency},payload:request.body});
  const reply={status:response.statusCode,body:response.json()};routeCalls.push(request);routeReplies.push(reply);return reply;
 });
 await page.setContent('<div id="root"></div>');
 await page.evaluate(data=>{
  let keySequence=0;
  Object.defineProperty(window.crypto,'randomUUID',{configurable:true,value:()=> 'fixture-idempotency-key-'+(++keySequence)});
  window.__workCycleApiRequests=[];
  window.__workCycleApiState={actualRouteCalls:0,lostAck:true};
  const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8',...headers}});
  window.fetch=async(input,init={})=>{
   const path=String(typeof input==='string'?input:input.url).split('?')[0],method=String(init.method??'GET').toUpperCase(),headers=new Headers(init.headers??{}),body=typeof init.body==='string'?JSON.parse(init.body):undefined;
   const request={path,method,body,headers:{idempotency:headers.get('idempotency-key'),csrf:headers.get('x-csrf-token')}};
   window.__workCycleApiRequests.push(request);
    if(path==='/workbench-api/v1/capabilities')return json({workbench:{agent_roles:true}},200,{'x-workbench-draft-scope':data.draftScope,'x-csrf-token':'test-history-dcbf0559'});
   if(path==='/workbench-api/v1/agents/'+data.agentId+'/discovery-policy'&&method==='GET')return json({policy:data.policy,execution_authorized:false});
   const historyPath='/workbench-api/v1/agents/'+data.agentId+'/discovery-history';
   if(path===historyPath&&method==='GET')return json({items:data.cycles,next_before_id:null,execution_authorized:false});
   if(path.startsWith(historyPath+'/')&&method==='GET'){
    const admissionId=path.slice((historyPath+'/').length),detail=data.details[admissionId];
    return detail?json(detail):json({error:{code:'not_found'}},404);
   }
   if(path.endsWith('/discovery-history/admission-stale/work-cycles')&&method==='POST'){
    const oldRevision=data.details['admission-stale'].cycle.signal_revision,currentRevision=data.current.signal_revision;
    return oldRevision<currentRevision?json({error:{code:'WORK_CYCLE_AUTHORITY_REVOKED'}},409):json({error:{code:'fixture_source_not_stale'}},500);
   }
   if(path.endsWith('/discovery-history/'+data.current.admission_id+'/work-cycles')&&method==='POST'){
    const actual=await window.__invokeWorkCycleRoute({path,method,body,headers:request.headers});
    window.__workCycleApiState.actualRouteCalls++;
    if(window.__workCycleApiState.lostAck){window.__workCycleApiState.lostAck=false;throw new TypeError('Failed to fetch');}
    return json(actual.body,actual.status);
   }
   return json({error:{code:'unexpected_fixture_request'}},404);
  };
 },{...pageData,policy,current,stale,rejected});
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.waitForFunction(()=>document.getElementById('root')?.textContent?.trim().length>0);
 const initialText=await page.locator('#root').innerText();
 assert.match(initialText,/项目发现/,JSON.stringify({initialText,requests:await page.evaluate(()=>window.__workCycleApiRequests)}));
 await page.getByRole('heading',{name:'「Researcher」的项目发现'}).waitFor();
 await page.getByRole('heading',{name:'发现周期记录'}).waitFor();
 const historyButtons=page.getByRole('button',{name:'查看本轮方案与报告'});
 await historyButtons.nth(1).click();
 const createButton=page.getByRole('button',{name:'创建此方案的工作周期'});
 await createButton.waitFor();await createButton.click();
 await page.getByText('WORK_CYCLE_AUTHORITY_REVOKED').waitFor();
 assert.equal(await page.evaluate(()=>window.__workCycleApiState.actualRouteCalls),0,'a stale source revision cannot reach the create route');

 await page.getByRole('button',{name:'返回发现记录'}).click();
 await page.getByRole('button',{name:'查看本轮方案与报告'}).nth(0).click();
 await page.getByText(currentDetail.report.summary).waitFor();
 const currentCreate=page.getByRole('button',{name:'创建此方案的工作周期'});
 await currentCreate.click();
 await page.getByText('Failed to fetch').waitFor();
 await currentCreate.click();
 await page.getByText(/已创建工作周期 work-cycle-[^；]+；该方案尚未执行。/).waitFor();
 const afterCreateText=await page.locator('#root').innerText();
 assert.match(afterCreateText,/已创建工作周期 work-cycle-[^；]+；该方案尚未执行。/);

 await page.getByRole('button',{name:'返回发现记录'}).click();
 await page.getByRole('button',{name:'查看本轮方案与报告'}).nth(2).click();
 await page.getByText('Owner-rejected proposal').waitFor();
 assert.match(await page.locator('#root').innerText(),/验收未通过/);
 assert.match(await page.locator('#root').innerText(),/尚未验收/);
 assert.equal(await page.getByRole('button',{name:'创建此方案的工作周期'}).count(),0,'an owner-rejected proposal has no create action');

 const requests=await page.evaluate(()=>window.__workCycleApiRequests);
 const posts=requests.filter(item=>item.method==='POST');
 assert.equal(await page.evaluate(()=>window.__workCycleApiState.actualRouteCalls),2,'the create and retry reach the registered Fastify route');
 assert.equal(routeCalls.length,2);
 assert.deepEqual(routeCalls[0].body,posts[1].body);
 assert.deepEqual(routeCalls[1].body,posts[2].body);
 assert.equal(routeCalls[0].headers.idempotency,posts[1].headers.idempotency);
 assert.deepEqual(routeReplies[0],routeReplies[1],'the real route replays its durable receipt after the browser loses the first reply');
 assert.equal(routeReplies[1].status,200);
 assert.equal(routeReplies[1].body.admission_id,live.admission.admission_id);
 assert.equal(routeReplies[1].body.execution_authorized,false);
 assert.equal(live.db.prepare('SELECT count(*) n FROM wb_discovery_work_cycles').get().n,1);
 const stored=live.db.prepare('SELECT * FROM wb_discovery_work_cycle_commands WHERE owner_id=? AND command_key=?').get('owner',routeCalls[0].headers.idempotency);
 assert.ok(stored,'the idempotency command receipt is durable in SQLite');
 assert.equal(stored.cycle_id,routeReplies[1].body.cycle_id);
 assert.deepEqual(JSON.parse(stored.receipt_json),routeReplies[1].body);
 assert.deepEqual(effectCounts(),beforeEffects,'cycle creation does not start runs or allocate budget');
 assert.equal(posts.length,3,'the UI retries the current command after a lost reply using the same key');
 assert.equal(posts[0].path,'/workbench-api/v1/agents/'+agentId+'/discovery-history/admission-stale/work-cycles');
 assert.deepEqual(posts[0].body,{report_sha256:reportSha,plan_ids:['plan-stale'],expected_policy_version:policy.version,expected_role_version:policy.role_version,expected_role_epoch:policy.role_epoch});
 assert.equal(posts[1].path,'/workbench-api/v1/agents/'+agentId+'/discovery-history/'+current.admission_id+'/work-cycles');
 assert.deepEqual(posts[1].body,{report_sha256:currentDetail.report.sha256,plan_ids:[currentDetail.plans[0].plan_id],expected_policy_version:policy.version,expected_role_version:policy.role_version,expected_role_epoch:policy.role_epoch});
 assert.deepEqual(posts[2].body,posts[1].body);
 assert.equal(posts[1].headers.idempotency,posts[2].headers.idempotency);
 assert.notEqual(posts[0].headers.idempotency,posts[1].headers.idempotency);
 for(const post of posts)assert.equal(post.headers.csrf,'test-history-dcbf0559');
 assert.equal(requests.some(item=>item.path.includes('/execute')||item.path.includes('/runs')),false,'creating a proposal work cycle does not start work');
});
