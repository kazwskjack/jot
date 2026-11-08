import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {buildServer as buildBff} from '../../src/server.mjs';
import {browserTestLaunchOptions} from '../../scripts/browser-test-launch.mjs';

const frozenRoot=process.env.M19_U5_R3_INTEGRATION_ROOT;
assert.ok(frozenRoot,'M19_U5_R3_INTEGRATION_ROOT must identify the read-only frozen Gateway checkout');
const frozenHead='f65e3844a95a9c3a2aeafca27788cfb6713969b7';
const moduleAt=path=>import(pathToFileURL(join(frozenRoot,path)).href);
const {buildServer:buildGateway}=await moduleAt('packages/gateway/src/server.ts');
const {OwnerChannelBindings}=await moduleAt('packages/gateway/src/channels/owner-bindings.ts');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

async function harness(t){
 assert.equal(execFileSync('git',['-C',frozenRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),frozenHead);
 assert.equal(execFileSync('git',['-C',frozenRoot,'status','--porcelain'],{encoding:'utf8'}).trim(),'','frozen Gateway must remain clean');
 const base=resolve('.test-tmp/m19-u5-wizard-http');await mkdir(base,{recursive:true});
 const root=await mkdtemp(join(base,'case-')),publicRoot=join(root,'public'),allowedOrigins=[],gatewayReceipts=[],bffReceipts=[],releases=[];
 const previousTemp={TEMP:process.env.TEMP,TMP:process.env.TMP};process.env.TEMP=root;process.env.TMP=root;
 let gateway,bff,browser,address,port;
 t.after(async()=>{
  try{
  for(const release of releases)release();
  await browser?.close();await bff?.close();await gateway?.app.close();gateway?.db.close();
  const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});
  }finally{for(const key of ['TEMP','TMP'])if(previousTemp[key]===undefined)delete process.env[key];else process.env[key]=previousTemp[key];}
 });
 gateway=await buildGateway({databasePath:join(root,'gateway.sqlite'),workspaces:['ws'],workbenchRoot:join(root,'workbench'),uploadRoot:join(root,'uploads'),templateRoot:join(frozenRoot,'packages/gateway/file-engine/templates'),csrfToken:'synthetic-wizard-csrf-token',internalChannelToken:'synthetic-wizard-internal-token',allowedOrigins});
 gateway.app.addHook('onResponse',async(request,reply)=>{
  const path=request.url.split('?')[0];
  if(request.method!=='GET'&&path!=='/v1/persistent-tasks/preview')gatewayReceipts.push({method:request.method,path,owner:request.headers['x-user-id'],key:request.headers['idempotency-key'],body:structuredClone(request.body),status:reply.statusCode});
 });
 const gatewayAddress=await gateway.app.listen({host:'127.0.0.1',port:0});
 for(const owner of ['alice','bob'])gateway.workbench.createAgent(owner,{name:owner+' fixture role',instructions:'Synthetic UI acceptance role'});
 const channels=new OwnerChannelBindings(gateway.db,{enabled:['wecom']});
 const bindings=['synthetic-wizard-one','synthetic-wizard-two'].map(principal=>{const challenge=channels.create('alice','wecom');channels.acceptProof('wecom',principal,challenge.code);return channels.list('alice').items.find(item=>item.channel_binding_id===challenge.channel_binding_id);});
 await mkdir(publicRoot,{recursive:true});
 const bundle=await build({stdin:{contents:[
  "import '../workbench-entry.css';",
  "import React,{useEffect,useState} from 'react';",
  "import {createRoot} from 'react-dom/client';",
  "import TasksPanel from './TasksPanel.tsx';",
  "import {request} from '../jot/client';",
  "function App(){const [data,setData]=useState(null),[error,setError]=useState('');",
  "async function refresh(){try{const caps=await request('/capabilities'),agents=await request('/agents');setData({caps,agents:agents.items});}catch(e){setError(e.message);}}",
  "useEffect(()=>{void refresh();},[]);return React.createElement(React.Fragment,null,React.createElement('button',{onClick:refresh},'刷新当前账户'),error&&React.createElement('p',{role:'alert'},error),data?React.createElement(TasksPanel,{caps:data.caps,agents:data.agents,onConversation:()=>{}}):React.createElement('p',null,'加载任务入口'));}",
  "createRoot(document.getElementById('root')).render(React.createElement(App));"
 ].join('\n'),resolveDir:dirname(fileURLToPath(import.meta.url)),loader:'tsx'},bundle:true,write:false,outfile:join(publicRoot,'bundle.js'),format:'iife',platform:'browser',logLevel:'silent'});
 for(const output of bundle.outputFiles)await writeFile(output.path,output.contents);
 await writeFile(join(publicRoot,'index.html'),'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script>');
 async function start(owner,listenPort=0){
  bff=await buildBff({demo:true,database:join(root,'bff.sqlite'),root:join(root,'bff-files'),publicRoot,workbench:{url:gatewayAddress,owner,csrf:'synthetic-wizard-csrf-token'}});
  bff.app.addHook('onResponse',async(request,reply)=>{if(request.url.startsWith('/workbench-api/')&&request.method!=='GET')bffReceipts.push({owner,method:request.method,path:request.url,status:reply.statusCode});});
  address=await bff.app.listen({host:'127.0.0.1',port:listenPort});port=Number(new URL(address).port);if(!allowedOrigins.includes(address))allowedOrigins.push(address);
 }
 await start('alice');
 browser=await chromium.launch({headless:true,...await browserTestLaunchOptions(chromium),chromiumSandbox:true});
 async function page(){const context=await browser.newContext({viewport:{width:430,height:932},isMobile:true,hasTouch:true});const page=await context.newPage();page.setDefaultTimeout(10000);await page.goto(address);await page.getByRole('heading',{name:'持续任务',exact:true}).waitFor();return page;}
 async function switchOwner(owner){await bff.close();await start(owner,port);}
 async function refresh(page){await page.getByRole('button',{name:'刷新当前账户',exact:true}).click();}
 function row(title,owner='alice'){return gateway.db.prepare('SELECT * FROM wb_persistent_tasks WHERE owner_id=? AND title=?').get(owner,title);}
 function settings(task){return gateway.db.prepare('SELECT version,bindings_json FROM wb_task_notification_settings WHERE task_id=? AND owner_id=?').get(task.task_id,task.owner_id);}
 async function delayNext(page,path){
  const arrived=deferred(),release=deferred();let used=false;releases.push(release.resolve);
  await page.route('**/workbench-api/v1/'+path,async route=>{
   if(used||route.request().method()==='GET')return route.continue();used=true;
   const response=await route.fetch();arrived.resolve(response);await release.promise;await route.fulfill({response}).catch(()=>{});
  });
  return {arrived:arrived.promise,release:release.resolve};
 }
 return {gateway,gatewayReceipts,bffReceipts,bindings,page,switchOwner,refresh,row,settings,delayNext};
}
async function wizard(page,title,binding=null,file=false){
 await page.getByRole('button',{name:'创建任务',exact:true}).click();
 const form=page.getByRole('form',{name:'创建持续任务',exact:true});
 await form.getByLabel('任务名称',{exact:true}).fill(title);await form.getByLabel('目标与结果要求',{exact:true}).fill('Synthetic owner-approved task output');
 await form.getByRole('button',{name:'下一步',exact:true}).click();
 await form.getByLabel('执行时间（留空立即执行）',{exact:true}).fill('2099-01-01T00:00:00Z');
 await form.getByText(/^首次执行预览：/).waitFor();
 await form.getByRole('button',{name:'下一步',exact:true}).click();await form.getByRole('button',{name:'下一步',exact:true}).click();
 if(binding){await form.getByRole('checkbox',{name:new RegExp('微信企业渠道 '+binding.channel_binding_id.slice(-6))}).check();if(file)await form.getByRole('checkbox',{name:new RegExp('发送本任务已审核的文件输出到.*'+binding.channel_binding_id.slice(-6))}).check();}
 await form.getByRole('button',{name:'下一步',exact:true}).click();await form.getByRole('region',{name:'任务配置总确认',exact:true}).waitFor();return form;
}
async function saved(page){await page.getByText('任务配置已保存。运行状态以执行记录为准。',{exact:true}).waitFor();}
async function openDetail(page,title){const card=page.locator('.wb-task-card').filter({has:page.getByRole('heading',{name:title,exact:true})});await card.getByRole('button',{name:'执行记录',exact:true}).click();return page.getByRole('dialog',{name:title+'执行记录',exact:true});}
async function revoke(dialog,binding){const row=dialog.locator('article').filter({hasText:binding.channel_binding_id.slice(-6)});await row.getByRole('button',{name:'撤销渠道',exact:true}).click();await dialog.getByRole('button',{name:'确认撤销',exact:true}).click();await row.getByText(/已撤销/).waitFor();}

test('wizard HTTP caller normalizes legacy consent and preserves unknown POST across revoke and owner scope',{timeout:120000},async t=>{
 const h=await harness(t),page=await h.page(),[binding,second]=h.bindings;
 await wizard(page,'legacy task',binding);
 await page.evaluate(()=>{const key=Object.keys(sessionStorage).find(key=>key.startsWith('jot-task-draft/v1/'));const draft=JSON.parse(sessionStorage.getItem(key));delete draft.form.notification_settings.artifact_delivery_binding_ids;delete draft.form.notification_settings.artifact_delivery_binding_versions;sessionStorage.setItem(key,JSON.stringify(draft));});
 await page.reload();const legacy=page.getByRole('form',{name:'创建持续任务',exact:true});await legacy.getByRole('region',{name:'任务配置总确认',exact:true}).waitFor();await legacy.getByRole('button',{name:'上一步',exact:true}).click();assert.equal(await legacy.getByRole('checkbox',{name:new RegExp('发送本任务已审核的文件输出到.*'+binding.channel_binding_id.slice(-6))}).isChecked(),false);await legacy.getByRole('button',{name:'下一步',exact:true}).click();
 await legacy.getByRole('button',{name:'确认并保存任务',exact:true}).click();await saved(page);
 const legacyTask=h.row('legacy task'),legacySettings=h.settings(legacyTask);assert.notEqual(JSON.parse(legacySettings.bindings_json)[0].artifact_delivery,true);
 const legacyPost=h.gatewayReceipts.find(item=>item.path==='/v1/persistent-tasks'&&item.body.title==='legacy task');assert.deepEqual(legacyPost.body.notification_settings.artifact_delivery_binding_ids,[]);assert.equal(legacyPost.status,201);
 t.diagnostic('legacy persisted draft passed through running BFF/Gateway with empty artifact consent');

 const form=await wizard(page,'unknown file task',binding,true);let lose=true;
 await page.route('**/workbench-api/v1/persistent-tasks',async route=>{if(!lose||route.request().method()!=='POST')return route.continue();lose=false;const response=await route.fetch();assert.equal(response.status(),201);return route.fulfill({status:504,contentType:'application/json',body:'{"error":{"code":"synthetic-response-lost"}}'});});
 await form.getByRole('button',{name:'确认并保存任务',exact:true}).click();await page.getByText('保存结果尚未确认。重试保留原任务内容；确认前请不要重复创建。',{exact:true}).waitFor();
 const original=h.gatewayReceipts.find(item=>item.path==='/v1/persistent-tasks'&&item.body.title==='unknown file task');assert.equal(JSON.parse(h.settings(h.row('unknown file task')).bindings_json)[0].artifact_delivery,true);
 await page.reload();await page.getByRole('button',{name:'重试原任务',exact:true}).waitFor();
 const receipt=await page.evaluate(()=>{const key=Object.keys(sessionStorage).find(key=>key.startsWith('jot-task-draft/v1/'));return {key,command:JSON.parse(sessionStorage.getItem(key)).command};});
 assert.equal(receipt.command.key,original.key);assert.deepEqual(receipt.command.body,original.body);

 const peer=await h.page(),dialog=await openDetail(peer,'legacy task');await dialog.getByRole('button',{name:'设置任务通知',exact:true}).click();
 await dialog.getByRole('checkbox',{name:new RegExp('发送本任务已审核的文件输出到.*'+binding.channel_binding_id.slice(-6))}).check();
 await dialog.getByRole('button',{name:'保存通知设置',exact:true}).click();await dialog.getByText('任务通知设置已保存，原有结果和消耗保持不变。',{exact:true}).waitFor();
 assert.equal(JSON.parse(h.settings(legacyTask).bindings_json)[0].artifact_delivery,true);
 const notification=h.gatewayReceipts.find(item=>item.method==='PATCH'&&item.path==='/v1/persistent-tasks/'+legacyTask.task_id+'/notifications');assert.deepEqual(notification.body.artifact_delivery_binding_ids,[binding.channel_binding_id]);assert.equal(notification.status,200);

 const stale=await h.page();await wizard(stale,'stale binding task',second,true);
 await revoke(dialog,binding);await revoke(dialog,second);
 await stale.getByRole('button',{name:'确认并保存任务',exact:true}).click();await stale.getByRole('alert').waitFor();assert.equal(h.row('stale binding task'),undefined);
 const rejected=h.gatewayReceipts.find(item=>item.path==='/v1/persistent-tasks'&&item.body.title==='stale binding task');assert.ok(rejected.status>=400&&rejected.status<500);assert.deepEqual(rejected.body.notification_settings.artifact_delivery_binding_ids,[second.channel_binding_id]);
 await peer.close();await stale.close();
 t.diagnostic('actual notification PATCH grants file consent; actual UI revokes both bindings; stale fresh POST is rejected atomically');

 await h.switchOwner('bob');await h.refresh(page);await page.getByText('账户范围已变化。原保存回执仍保留；请切回创建时的账户范围后重试。',{exact:true}).waitFor();
 assert.equal(await page.getByRole('form',{name:'创建持续任务',exact:true}).count(),0);
 assert.equal(await page.locator('.wb-task-card').filter({hasText:'legacy task'}).count(),0,'owner switch must not retain previous owner task cards');
 assert.deepEqual(await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)).command,receipt.key),receipt.command);
 assert.equal(h.gatewayReceipts.filter(item=>item.owner==='bob'&&item.path==='/v1/persistent-tasks').length,0);
 await h.switchOwner('alice');await h.refresh(page);await page.getByRole('button',{name:'重试原任务',exact:true}).click();await saved(page);
 const attempts=h.gatewayReceipts.filter(item=>item.path==='/v1/persistent-tasks'&&item.body.title==='unknown file task');
 assert.equal(attempts.length,2);assert.equal(attempts[1].key,attempts[0].key);assert.deepEqual(attempts[1].body,attempts[0].body);assert.equal(attempts[1].status,201);
 assert.equal(h.gateway.db.prepare("SELECT count(*) n FROM wb_persistent_tasks WHERE owner_id='alice' AND title='unknown file task'").get().n,1);
 assert.equal(h.gateway.db.prepare("SELECT count(*) n FROM wb_task_notification_settings WHERE owner_id='bob'").get().n,0);
 assert.ok(h.bffReceipts.some(item=>item.method==='POST'&&item.path==='/workbench-api/v1/persistent-tasks'&&item.status===201));
 t.diagnostic('same-tab recovery and owner return replay the identical POST body/key after binding revocation; no duplicate task or Bob grant');
});

test('late owner HTTP responses cannot publish old binding challenge or task-save success',{timeout:120000},async t=>{
 const h=await harness(t),page=await h.page();
 let form=await wizard(page,'alice detail');const aliceDraftKey=await page.evaluate(()=>Object.keys(sessionStorage).find(key=>key.startsWith('jot-task-draft/v1/')));await form.getByRole('button',{name:'确认并保存任务',exact:true}).click();await saved(page);
 const aliceTask=h.row('alice detail'),oldPause=await page.locator('.wb-task-card').filter({hasText:'alice detail'}).getByRole('button',{name:'暂停',exact:true}).elementHandle();
 const dialog=await openDetail(page,'alice detail'),oldSettings=await dialog.getByRole('button',{name:'设置任务通知',exact:true}).elementHandle(),bindingDelay=await h.delayNext(page,'channel-bindings');
 await dialog.getByRole('button',{name:'生成微信绑定码',exact:true}).click();await bindingDelay.arrived;
 assert.ok(h.gatewayReceipts.some(item=>item.owner==='alice'&&item.path==='/v1/channel-bindings'&&item.status===201));
 await h.switchOwner('bob');await h.refresh(page);await page.waitForFunction(()=>!document.querySelector('[aria-label="alice detail执行记录"]'));bindingDelay.release();
 await page.getByRole('button',{name:'创建任务',exact:true}).waitFor();
 assert.equal(await oldPause.evaluate(button=>{button.click();return button.isConnected;}),false);assert.equal(await oldSettings.evaluate(button=>{button.click();return button.isConnected;}),false);
 assert.equal(h.gatewayReceipts.filter(item=>item.owner==='bob'&&item.path.includes(aliceTask.task_id)).length,0,'detached old task buttons must not issue a Bob command');
 const denied=await page.evaluate(async({id,version})=>{const bootstrap=await fetch('/workbench-api/v1/capabilities'),response=await fetch('/workbench-api/v1/persistent-tasks/'+id+'/pause',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':bootstrap.headers.get('x-csrf-token'),'Idempotency-Key':'synthetic-bob-stale-task-denied'},body:JSON.stringify({expected_version:version})});return {status:response.status,body:await response.text()};},{id:aliceTask.task_id,version:aliceTask.version});
 assert.equal(denied.status,404,denied.body);assert.equal(h.row('alice detail').status,aliceTask.status);assert.equal(h.row('alice detail').version,aliceTask.version);
 assert.ok(h.gatewayReceipts.some(item=>item.owner==='bob'&&item.path==='/v1/persistent-tasks/'+aliceTask.task_id+'/pause'&&item.status===404));
 assert.equal(await page.getByRole('group',{name:'微信绑定验证',exact:true}).count(),0);
 assert.equal(await page.getByText('/jot-bind ',{exact:false}).count(),0);
 t.diagnostic('owner switch removes old detail/button DOM; detached old buttons issue no request; Bob stale task command through running BFF/Gateway is denied 404 without changing Alice task; delayed binding-code response cannot refill UI');

 form=await wizard(page,'bob late save');const createDelay=await h.delayNext(page,'persistent-tasks');
 await form.getByRole('button',{name:'确认并保存任务',exact:true}).click();await createDelay.arrived;assert.ok(h.row('bob late save','bob'));const bobDraftKey=await page.evaluate(()=>Object.keys(sessionStorage).find(key=>key.startsWith('jot-task-draft/v1/')&&JSON.parse(sessionStorage.getItem(key)).command?.body.title==='bob late save'));assert.notEqual(bobDraftKey,aliceDraftKey);
 await h.switchOwner('alice');await h.refresh(page);await page.getByText('账户范围已变化。原保存回执仍保留；请切回创建时的账户范围后重试。',{exact:true}).waitFor();createDelay.release();
 await page.waitForFunction(()=>!document.querySelector('button[type="submit"]:disabled'));
 assert.equal(await page.getByText('任务配置已保存。运行状态以执行记录为准。',{exact:true}).count(),0,'late Bob result must not show save success in Alice scope');
 assert.equal(await page.locator('.wb-task-card').filter({hasText:'bob late save'}).count(),0);
 form=await wizard(page,'alice after late save');const aliceDelay=await h.delayNext(page,'persistent-tasks');await form.getByRole('button',{name:'确认并保存任务',exact:true}).click();await aliceDelay.arrived;const namespaces=await page.evaluate(({alice,bob})=>({alice:JSON.parse(sessionStorage.getItem(alice)),bob:JSON.parse(sessionStorage.getItem(bob))}),{alice:aliceDraftKey,bob:bobDraftKey});assert.equal(namespaces.alice.command.body.title,'alice after late save');assert.equal(namespaces.bob.command,null);aliceDelay.release();await saved(page);assert.ok(h.row('alice after late save'));assert.equal(h.row('alice after late save','bob'),undefined);
 t.diagnostic('late task-save completion does not overwrite current owner UI; current owner can then create via its own draft namespace');
});

test('late owner task-card action does not update the current owner notice',{timeout:60000},async t=>{
 const h=await harness(t),page=await h.page(),form=await wizard(page,'alice card action');
 await form.getByRole('button',{name:'确认并保存任务',exact:true}).click();await saved(page);
 const task=h.row('alice card action'),delay=await h.delayNext(page,'persistent-tasks/'+task.task_id+'/pause');
 await page.locator('.wb-task-card').filter({hasText:'alice card action'}).getByRole('button',{name:'暂停',exact:true}).click();await delay.arrived;
 assert.equal(h.row('alice card action').status,'paused');
 await h.switchOwner('bob');await h.refresh(page);await page.waitForFunction(()=>!document.querySelector('.wb-task-card'));delay.release();
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='创建任务'&&!button.disabled));
 assert.equal(await page.getByText('任务状态已更新。',{exact:true}).count(),0,'old owner task action must not publish a status notice in the current scope');
 assert.equal(h.gatewayReceipts.filter(item=>item.owner==='bob'&&item.path.includes(task.task_id)).length,0);
});
