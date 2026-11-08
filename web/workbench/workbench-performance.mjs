import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build,preview} from 'vite';
import {chromium} from 'playwright';
import {createHash} from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
if(resolve(process.cwd())!==root)throw new Error(`run_from_project_root:${root}`);
await build({build:{manifest:true}});
const manifest=JSON.parse(await readFile(join(root,'dist/.vite/manifest.json'),'utf8'));
function dynamicAsset(name){
 const entry=Object.entries(manifest).find(([key,value])=>key.includes(name)&&value.isDynamicEntry);
 if(!entry)throw new Error(`dynamic_asset_missing:${name}`);
 return `/${entry[1].file}`;
}
const agentAsset=dynamicAsset('AgentPanel'),teamAsset=dynamicAsset('TeamsPanel'),taskAsset=dynamicAsset('TasksPanel'),gitAsset=dynamicAsset('GitPanel');
const server=await preview({preview:{host:'127.0.0.1',port:0,strictPort:false}});
const address=server.httpServer.address();
if(!address||typeof address==='string')throw new Error('preview_address_unavailable');
const origin=`http://127.0.0.1:${address.port}`;
const executablePath=process.env.JOT_WORKBENCH_CHROME_PATH??(process.platform==='win32'?chromium.executablePath():undefined);
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});
const page=await context.newPage();
const base='const original = 1;\n',remote='const remote = 2;\n';
const digest=value=>createHash('sha256').update(value,'utf8').digest('hex');
const fileState={version:1,content:base},saveRequests=[],saveReceiptKeys=[],apiRequests=[],contentReads=[],createdFiles=[];
let ownerScope='a'.repeat(64);
let agentChunkAttempts=0,teamChunkAttempts=0,agentRetryAttempts=0,teamRetryAttempts=0;
let markAgentChunkStarted;
const agentChunkStarted=new Promise(resolve=>{markAgentChunkStarted=resolve;});
const apiPrefix='/workbench-api/v1';
const capabilities={
 api_version:'1',event_schema_version:'1',adapter_version:'1',capabilities:{},models:[],
 limits:{max_upload_bytes:1048576,max_active_runs_per_conversation:1,replay_retention_hours:24,idempotency_retention_hours:24},
 workspaces:[{workspace_id:'ws-one',title:'测试工作区',can_read:true,can_write:true}],
 workbench:{enabled:true,agent_roles:true,independent_teams:true,agent_messages:true,shared_workspace:true,memory_scopes:['project','private'],task_triggers:[],notification_channels:[],collaboration_modes:[],allowed_tools:[]},
 git_workbench:{configured_projects:[],read_only:true,index_actions:[]}
};
const agent={agent_id:'agent-one',name:'研究员',instructions:'',workspace_id:'ws-one',project_id:'project-one',conversation_id:'conversation-one',status:'active',version:1,capability_epoch:1,allowed_tools:[],created_at:'2026-10-21T00:00:00.000Z',updated_at:'2026-10-21T00:00:00.000Z'};
const agents=[agent,{...agent,agent_id:'agent-two',name:'另一项目研究员',project_id:'project-two'}];
const otherProjectContent='const otherProject = true;\n';

await page.route(`**${apiPrefix}/**`,async route=>{
 const url=new URL(route.request().url()),path=url.pathname.slice(apiPrefix.length),method=route.request().method();
 apiRequests.push({method,path,search:url.search});
 const headers={'content-type':'application/json','x-csrf-token':'browser-test-token','x-workbench-draft-scope':ownerScope};
 const respond=(body,status=200)=>route.fulfill({status,headers,body:JSON.stringify(body)});
 if(path==='/capabilities')return respond(capabilities);
 if(path==='/agents')return respond({items:agents});
 if(path==='/workspaces/ws-one/agent-messages')return respond({items:[]});
 if(path==='/workspaces/ws-one/files'&&method==='GET'){
  if(url.searchParams.get('project_id')==='project-two')return respond({items:[{path:'src/other.ts',version:1,size:Buffer.byteLength(otherProjectContent),sha256:digest(otherProjectContent),updated_at:'2026-10-21T01:00:00.000Z'}],next_cursor:null});
  return respond({items:[{path:'src/main.ts',version:fileState.version,size:Buffer.byteLength(fileState.content),sha256:digest(fileState.content),updated_at:'2026-10-21T01:00:00.000Z'}],next_cursor:null});
 }
 if(path==='/workspaces/ws-one/files/content'&&method==='GET'){
  contentReads.push(url.searchParams.get('path'));
  if(url.searchParams.get('project_id')==='project-two')return respond({path:url.searchParams.get('path'),version:1,sha256:digest(otherProjectContent),size:Buffer.byteLength(otherProjectContent),updated_at:'2026-10-21T01:00:00.000Z',content:otherProjectContent});
  const version=Number(url.searchParams.get('version')??fileState.version);
  const content=version===fileState.version?fileState.content:version===1?base:remote;
  return respond({path:url.searchParams.get('path'),version,sha256:digest(content),size:Buffer.byteLength(content),updated_at:`2026-10-21T0${version}:00:00.000Z`,content});
 }
 if(path==='/workspaces/ws-one/files'&&method==='PUT'){
  const input=route.request().postDataJSON();saveRequests.push(input);saveReceiptKeys.push(route.request().headers()['idempotency-key']);
  if(saveRequests.length===1){fileState.version=2;fileState.content=remote;return respond({error:{code:'version_conflict'}},409);}
  if(saveRequests.length===3)return route.abort('failed');
  if(input.path==='notes/new.txt'){
   if(input.expected_version!==0)return respond({error:{code:'version_conflict'}},409);
   createdFiles.push(input);return respond({path:input.path,version:1,sha256:digest(input.content),size:Buffer.byteLength(input.content)});
  }
  if(input.expected_version!==fileState.version)return respond({error:{code:'version_conflict'}},409);
  fileState.version++;fileState.content=input.content;
  return respond({path:input.path,version:fileState.version,sha256:digest(input.content),size:Buffer.byteLength(input.content)});
 }
 return respond({error:{code:'TEST_ROUTE_NOT_FOUND',path,method}},404);
});

await page.route(`**${agentAsset}`,async route=>{
 agentChunkAttempts++;
 if(agentChunkAttempts===1){markAgentChunkStarted();await new Promise(resolve=>setTimeout(resolve,300));return route.abort('failed');}
 return route.continue();
});
await page.route(`**${teamAsset}`,async route=>{
 teamChunkAttempts++;
 if(teamChunkAttempts===1)return route.abort('failed');
 return route.continue();
});
const assetRequests=[];
page.on('request',request=>{const pathname=new URL(request.url()).pathname;if(/\.(?:js|css)$/.test(pathname))assetRequests.push(pathname);});
const start=Date.now();
const navigationPromise=page.goto(`${origin}/workbench.html`);
await page.getByRole('button',{name:'Agent 角色',exact:true}).waitFor({timeout:15000});
const shellVisibleAt=await page.evaluate(()=>performance.now());
const agentLoading=page.getByRole('status').filter({hasText:'正在加载 Agent 角色'});
await agentLoading.waitFor({timeout:15000});
const agentLoadingVisibleAt=await page.evaluate(()=>performance.now());
await agentChunkStarted;
assert.equal(await agentLoading.isVisible(),true,'the first Agent chunk must expose its real React loading fallback while the chunk request is pending');
await navigationPromise;
await page.getByRole('alert').filter({hasText:'Agent 角色 暂时无法加载'}).waitFor({timeout:15000});
const failedAt=Date.now()-start;
const firstTerminalAt=await page.evaluate(()=>performance.now());
const navigationTiming=await page.evaluate(()=>{
 const navigation=performance.getEntriesByType('navigation')[0],fcp=performance.getEntriesByName('first-contentful-paint')[0];
 return {dom_content_loaded_ms:navigation?.domContentLoadedEventEnd??null,load_ms:navigation?.loadEventEnd??null,fcp_ms:fcp?.startTime??null};
});
assert.ok(Number.isFinite(navigationTiming.fcp_ms),'real Chrome must report first contentful paint');
const initialEntries=await page.evaluate(()=>performance.getEntriesByType('resource').filter(entry=>/\.(?:js|css)(?:\?|$)/.test(new URL(entry.name).pathname)).map(entry=>({path:new URL(entry.name).pathname,transfer:entry.transferSize,encoded:entry.encodedBodySize,decoded:entry.decodedBodySize})));
assert.ok(!initialEntries.some(entry=>entry.path.includes('/task-save-')&&!entry.path.includes('task-save-receipt-')),'task workflow implementation must stay out of initial workbench resources');
assert.ok(!initialEntries.some(entry=>entry.path===taskAsset),'TasksPanel code must stay out of initial workbench resources');
assert.ok(!initialEntries.some(entry=>entry.path===teamAsset),'TeamsPanel code must stay out of initial workbench resources');
const retryChunkRequest=page.waitForRequest(request=>new URL(request.url()).pathname===agentAsset,{timeout:3000}).catch(()=>null);
await page.getByRole('button',{name:'重新加载 Agent 角色'}).click();
assert.ok(await retryChunkRequest,'retry after a failed lazy chunk must issue a fresh browser request');
await page.getByRole('button',{name:'创建角色'}).waitFor({timeout:15000});
assert.equal(agentChunkAttempts,2,'failed panel chunk must be requested again after retry');
agentRetryAttempts=agentChunkAttempts;
const afterRetryEntries=await page.evaluate(()=>performance.getEntriesByType('resource').filter(entry=>/\.(?:js|css)(?:\?|$)/.test(new URL(entry.name).pathname)).map(entry=>({path:new URL(entry.name).pathname,transfer:entry.transferSize,encoded:entry.encodedBodySize,decoded:entry.decodedBodySize})));
assert.ok(afterRetryEntries.some(entry=>entry.path===agentAsset),'Agent panel chunk must load after retry');
const retryMs=Date.now()-start;

await page.getByRole('button',{name:'角色团队'}).click();
await page.getByRole('alert').filter({hasText:'角色团队 暂时无法加载'}).waitFor({timeout:15000});
const retryTeamChunkRequest=page.waitForRequest(request=>new URL(request.url()).pathname===teamAsset,{timeout:3000}).catch(()=>null);
await page.getByRole('button',{name:'重新加载 角色团队'}).click();
assert.ok(await retryTeamChunkRequest,'retry after a Teams chunk failure must preserve the selected view and fetch a fresh chunk');
await page.getByRole('heading',{name:'角色团队'}).waitFor({timeout:15000});
assert.equal(teamChunkAttempts,2,'Teams chunk should be retried after a full page reload');
teamRetryAttempts=teamChunkAttempts;
await page.getByRole('button',{name:'共享工作区'}).click();
await page.getByRole('heading',{name:'共享工作区'}).waitFor({timeout:15000});
await page.getByRole('button',{name:'共同文件'}).click();
await page.getByRole('button',{name:/src\/main\.ts/}).waitFor({timeout:15000});
await page.getByRole('button',{name:/src\/main\.ts/}).click();
await page.getByLabel('文本草稿').waitFor({timeout:15000});
await page.getByLabel('文本草稿').fill('const local = 3;\n');
await page.reload();
await page.getByRole('button',{name:'创建角色'}).waitFor({timeout:15000});
await page.getByRole('button',{name:'共享工作区'}).click();
await page.getByRole('button',{name:'共同文件'}).click();
await page.getByRole('button',{name:'恢复草稿'}).waitFor({timeout:15000});
await page.getByRole('button',{name:'恢复草稿'}).click();
await page.getByLabel('文本草稿').waitFor({timeout:15000});
assert.equal(await page.getByLabel('文本草稿').inputValue(),'const local = 3;\n','reload recovery must restore the saved same-scope draft');
await page.getByRole('button',{name:'检查修改'}).click();
await page.getByText('保存前检查',{exact:true}).waitFor();
await page.getByRole('button',{name:'确认应用保存'}).click();
await page.getByRole('button',{name:'应用保存（v1）'}).click();
await page.getByText(/版本冲突：本地草稿已保留/).waitFor({timeout:15000});
assert.equal(await page.getByLabel('文本草稿').inputValue(),'const local = 3;\n','conflict must preserve local draft');
assert.match(await page.getByLabel('安全文本预览').textContent()??'',/const remote = 2;/);
await page.getByRole('button',{name:'保留草稿并以最新版本为基础'}).click();
await page.getByRole('button',{name:'检查修改'}).click();
await page.getByRole('button',{name:'确认应用保存'}).click();
await page.getByRole('button',{name:'应用保存（v2）'}).click();
await page.getByText(/v3 · \d+ B/).waitFor({timeout:15000});
assert.equal(saveRequests.length,2);
assert.equal(saveRequests[0].expected_version,1);
assert.equal(saveRequests[1].expected_version,2,'rebased retry must target the latest version');
assert.equal(fileState.version,3);

await page.getByRole('button',{name:/src\/main\.ts/}).click();
await page.getByLabel('文本草稿').fill('const uncertain = true;\n');
await page.getByRole('button',{name:'检查修改'}).click();
await page.getByRole('button',{name:'确认应用保存'}).click();
await page.getByRole('button',{name:'应用保存（v3）'}).click();
await page.waitForFunction(()=>{const button=Array.from(document.querySelectorAll('button')).find(item=>item.textContent?.includes('重试原保存'));return Boolean(button&&!button.disabled);},null,{timeout:15000});
assert.equal(await page.getByLabel('文本草稿').isDisabled(),true,'an uncertain save must freeze edits until its original receipt is retried');
assert.equal(await page.getByRole('button',{name:'重试原保存'}).isEnabled(),true,'the same frozen receipt must remain retryable');
await page.getByRole('button',{name:'重试原保存'}).click();
await page.getByText(/v4 · \d+ B/).waitFor({timeout:15000});
assert.equal(saveRequests.length,4);
assert.deepEqual(saveRequests[3],saveRequests[2],'retry must replay the original file body');
assert.equal(saveReceiptKeys[3],saveReceiptKeys[2],'retry must replay the original idempotency key');
assert.equal(saveRequests[2].expected_version,3);
assert.equal(fileState.version,4);

await page.getByRole('button',{name:'新建共同文件'}).click();
await page.getByLabel('项目内相对路径').fill('notes/new.txt');
await page.getByLabel('文本草稿').fill('new file draft');
await page.getByText('未保存草稿已保存在此标签页会话中。').waitFor({timeout:15000});
await page.reload();
await page.getByRole('button',{name:'创建角色'}).waitFor({timeout:15000});
await page.getByRole('button',{name:'共享工作区'}).click();
await page.getByRole('button',{name:'共同文件'}).click();
await page.getByRole('button',{name:'恢复草稿'}).waitFor({timeout:15000});
const contentReadsBeforeNewFileRestore=contentReads.length;
await page.getByRole('button',{name:'恢复草稿'}).click();
await page.getByLabel('文本草稿').waitFor({timeout:15000});
assert.equal(await page.getByLabel('文本草稿').inputValue(),'new file draft');
assert.ok(!contentReads.slice(contentReadsBeforeNewFileRestore).includes('notes/new.txt'),'a version-zero draft must restore without requesting nonexistent file content');
await page.getByRole('button',{name:'检查修改'}).click();
await page.getByRole('button',{name:'确认应用保存'}).click();
await page.getByRole('button',{name:'应用保存（v0）'}).click();
await page.getByLabel('文本草稿').waitFor({state:'detached',timeout:15000});
assert.equal(createdFiles.length,1);
assert.equal(createdFiles[0].expected_version,0);
assert.equal(createdFiles[0].content,'new file draft');
assert.equal(saveRequests.length,5);

await page.getByRole('button',{name:/src\/main\.ts/}).click();
await page.getByLabel('文本草稿').fill('const scoped draft = true;\n');
await page.getByText('未保存草稿已保存在此标签页会话中。',{exact:true}).waitFor({timeout:15000});
await page.locator('select').nth(1).selectOption('project-two');
await page.getByText(/此标签页还保存着其他工作区 \/ 项目的草稿/).waitFor({timeout:15000});
assert.equal(await page.getByRole('button',{name:'新建共同文件'}).isEnabled(),true,'a foreign project draft remains recoverable while the selected project stays editable');
await page.locator('select').nth(1).selectOption('project-one');
await page.getByRole('button',{name:'恢复草稿 src/main.ts'}).waitFor({timeout:15000});
await page.getByRole('button',{name:'恢复草稿 src/main.ts'}).click();
assert.equal(await page.getByLabel('文本草稿').inputValue(),'const scoped draft = true;\n','switching scope must preserve the original project draft');

const beforeGit=new Set(assetRequests);
const gitStart=Date.now();
await page.getByRole('button',{name:'Git 工作台'}).click();
await page.getByText('尚未绑定项目仓库').waitFor({timeout:15000});
const gitMs=Date.now()-gitStart;
const gitPaths=[...new Set(assetRequests)].filter(path=>!beforeGit.has(path));
assert.ok(gitPaths.includes(gitAsset),'Git chunk must load when its panel is selected');
assert.ok(!initialEntries.some(entry=>entry.path===gitAsset),'Git chunk must not load with the initial Agent panel');
const afterGitEntries=await page.evaluate(()=>performance.getEntriesByType('resource').filter(entry=>/\.(?:js|css)(?:\?|$)/.test(new URL(entry.name).pathname)).map(entry=>({path:new URL(entry.name).pathname,transfer:entry.transferSize,encoded:entry.encodedBodySize,decoded:entry.decodedBodySize})));
const gitAssetEntries=afterGitEntries.filter(entry=>gitPaths.includes(entry.path));
const overflow=await page.evaluate(()=>({viewport:window.innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
assert.ok(overflow.document<=overflow.viewport&&overflow.body<=overflow.viewport,`390px view overflows: ${JSON.stringify(overflow)}`);
const summarize=entries=>({js_transfer_bytes:entries.filter(entry=>entry.path.endsWith('.js')).reduce((sum,entry)=>sum+(entry.transfer||0),0),js_encoded_bytes:entries.filter(entry=>entry.path.endsWith('.js')).reduce((sum,entry)=>sum+(entry.encoded||0),0),js_decoded_bytes:entries.filter(entry=>entry.path.endsWith('.js')).reduce((sum,entry)=>sum+(entry.decoded||0),0),css_transfer_bytes:entries.filter(entry=>entry.path.endsWith('.css')).reduce((sum,entry)=>sum+(entry.transfer||0),0),css_encoded_bytes:entries.filter(entry=>entry.path.endsWith('.css')).reduce((sum,entry)=>sum+(entry.encoded||0),0),css_decoded_bytes:entries.filter(entry=>entry.path.endsWith('.css')).reduce((sum,entry)=>sum+(entry.decoded||0),0),paths:[...new Set(entries.map(entry=>entry.path))]});
const shellAssets=initialEntries.filter(entry=>entry.path!==agentAsset);
const agentAssetEntries=afterRetryEntries.filter(entry=>entry.path===agentAsset);
console.log(JSON.stringify({viewport:390,first_screen:{shell_navigation_visible_ms:shellVisibleAt,fcp_ms:navigationTiming.fcp_ms,dom_content_loaded_ms:navigationTiming.dom_content_loaded_ms,load_event_ms:navigationTiming.load_ms,agent_loading_fallback_visible_ms:agentLoadingVisibleAt,initial_panel_terminal:'error',initial_panel_terminal_ms:firstTerminalAt,agent_error_wall_ms:failedAt},first_view_retry_success_ms:retryMs,git_view_ms:gitMs,lazy_retry_attempts:{agent:agentRetryAttempts,teams:teamRetryAttempts},initial_shell_assets:summarize(shellAssets),initial_agent_chunk_request:agentAsset,after_retry_assets:summarize(afterRetryEntries),agent_chunk_after_retry:agentAssetEntries,git_assets:gitPaths,git_chunk_after_selection:gitAssetEntries,version_conflict:{attempted_expected_versions:saveRequests.map(item=>item.expected_version),final_version:fileState.version},horizontal_overflow:overflow},null,2));

await context.close();
await browser.close();
await new Promise((resolveClose,reject)=>server.httpServer.close(error=>error?reject(error):resolveClose()));
