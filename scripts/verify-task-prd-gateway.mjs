// Actual React + registered Gateway/SQLite. HTTP relay only supplies the fixture
// owner and deliberately loses one committed bind response. No provider runs.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {buildServer} from '../packages/gateway/src/server.ts';

const repo=resolve(import.meta.dirname,'..'),root=await mkdtemp(join(tmpdir(),'task-prd-gateway-'));
const owner='prd-browser-owner',csrf=randomBytes(32).toString('hex'),content='# Goal\nDeliver a source-backed report.\n# Scope\nRead only.\n# Acceptance\nCite the exact version.\n# Dependencies\nInspect before delivery.\n';
let gateway,browser,javascript='',css='',loseNextBind=true;const binds=[],errors=[];
const relay=createServer(async(req,res)=>{try{
 if(req.url.startsWith('/workbench-api/')){
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks).toString(),url=req.url.slice('/workbench-api'.length);
  if(req.method==='POST'&&url.endsWith('/prd/bind'))binds.push({body:JSON.parse(body),key:req.headers['idempotency-key']});
  const result=await gateway.app.inject({method:req.method,url,headers:{'x-user-id':owner,origin,'x-csrf-token':req.headers['x-csrf-token']??'','idempotency-key':req.headers['idempotency-key']??'',...(body?{'content-type':'application/json'}:{})},...(body?{payload:body}:{})});
  if(loseNextBind&&url.endsWith('/prd/bind')&&result.statusCode===200){loseNextBind=false;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'INTERNAL_ERROR',message:'INTERNAL_ERROR',retryable:true},request_id:'fixture-lost-response'}));return;}
  res.statusCode=result.statusCode;for(const name of ['content-type','x-csrf-token','x-workbench-draft-scope'])if(result.headers[name])res.setHeader(name,result.headers[name]);res.end(result.body);return;
 }
 if(req.url==='/panel.js'){res.setHeader('content-type','application/javascript');res.end(javascript);return;}
 if(req.url==='/panel.css'){res.setHeader('content-type','text/css');res.end(css);return;}
 res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/panel.css"><main class="wb-layout"><div class="wb-content" id="root"></div></main><script type="module" src="/panel.js"></script>');
 }catch(error){errors.push(String(error));res.writeHead(500);res.end();}});
await new Promise(done=>relay.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+relay.address().port;
try{
 gateway=await buildServer({databasePath:join(root,'db.sqlite'),uploadRoot:join(root,'uploads'),workbenchRoot:join(root,'files'),workspaces:['ws'],templateRoot:fileURLToPath(new URL('../packages/gateway/file-engine/templates/',import.meta.url)),csrfToken:csrf,allowedOrigins:[origin]});
 const role=gateway.workbench.createAgent(owner,{name:'Original PRD role'}),created=gateway.persistentTasks.create(owner,{title:'Original PRD task',agent_id:role.agent_id,objective:'Prepare an owner-reviewed report.',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'},budget:{max_runs:3}});
 const task=gateway.persistentTasks.pause(owner,created.task_id,created.version),source=gateway.workbench.writeFile(owner,'ws',{project_id:role.project_id,path:'requirements.md',content,expected_version:0});
 const compiled=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import Panel from './web/workbench/TaskPrdPanel.tsx';import{request}from'./web/jot/client.ts';import'./web/workbench/workbench.css';function App(){const[task,setTask]=React.useState(${JSON.stringify(task)});return <Panel task={task} executionReady={true} onBound={()=>void request('/persistent-tasks/'+encodeURIComponent(task.task_id)).then(setTask)}/>;}await request('/capabilities');createRoot(document.getElementById('root')).render(<App/>);`,sourcefile:'prd-gateway-browser.tsx',loader:'tsx',resolveDir:repo},bundle:true,write:false,outdir:join(root,'bundle'),format:'esm',target:'es2022',logLevel:'silent'});
 javascript=compiled.outputFiles.find(file=>file.path.endsWith('.js')).text;css=compiled.outputFiles.find(file=>file.path.endsWith('.css'))?.text??'';
 const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATHEXT','LOCALAPPDATA','APPDATA','USERPROFILE'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
 browser=await chromium.launch({headless:true,env,...(process.platform==='win32'?{channel:'msedge'}:{})});const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin);const panel=page.getByRole('region',{name:'PRD 绑定原任务'}),select=panel.getByRole('combobox');await select.selectOption('0');await panel.getByRole('button',{name:'只读预览'}).click();await panel.getByRole('checkbox').waitFor();
 assert.equal(await panel.getByLabel('PRD 原文').textContent(),content);assert.ok((await panel.getByLabel('完整任务目标').textContent()).includes(content));assert.equal(gateway.db.prepare('SELECT count(*) n FROM wb_task_prd_bindings').get().n,0);assert.equal(gateway.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);assert.equal(gateway.db.prepare('SELECT count(*) n FROM ga_idempotency').get().n,0);
 const confirm=panel.getByRole('button',{name:'确认绑定原暂停任务',exact:true});assert.equal(await confirm.isDisabled(),true);await panel.getByRole('checkbox').check();await confirm.click();const retry=panel.getByRole('button',{name:'重试原绑定请求'});await retry.waitFor();
 assert.equal(gateway.db.prepare('SELECT count(*) n FROM wb_task_prd_bindings').get().n,1);assert.equal(await select.isDisabled(),true);
 gateway.workbench.writeFile(owner,'ws',{project_id:role.project_id,path:'requirements.md',content:'Changed source after committed binding.',expected_version:1});
 page.once('dialog',dialog=>dialog.accept());await page.reload();await retry.waitFor();assert.equal(binds.length,1,'reload cannot resend an unknown mutation automatically');await retry.click();await panel.getByText('已冻结绑定到原任务；任务保持暂停。').waitFor();assert.deepEqual(binds[0],binds[1]);
 const current=gateway.persistentTasks.get(owner,task.task_id);assert.equal(current.status,'paused');assert.ok(current.objective.includes(content));assert.equal(current.runs_used,0);assert.equal(current.budget.max_runs,3);assert.equal(gateway.persistentTasks.list(owner).items.length,1);assert.equal(gateway.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);assert.equal(gateway.db.prepare('SELECT count(*) n FROM ga_idempotency').get().n,0);assert.deepEqual(errors,[]);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:join(root,'prd-gateway-mobile.png'),fullPage:true});
 const proof={realReact:true,realGateway:true,realSQLite:true,syntheticApi:false,fixtureOwnerRelay:true,sourceVersion:source.version,sourceSha256:source.sha256,taskId:task.task_id,readOnlyPreview:true,committedResponseLoss:true,sameTabReloadNoAutoReplay:true,sameBodyKeyRetry:true,sourceEditCannotChangeFrozenObjective:true,newRuns:0,newTasks:0,bindings:1,originalRunBudgetPreserved:true,production:false,errors};await writeFile(join(root,'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify({root,...proof}));
}finally{await browser?.close();relay.closeAllConnections();await new Promise(done=>relay.close(done));if(gateway){await gateway.app.close();gateway.db.close();}}
