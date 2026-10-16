// Actual built form/button interactions -> original BFF -> isolated Gateway.
// Synthetic owned role only. No Worker, model, user browser or production IO.
import assert from 'node:assert/strict';import {mkdirSync,rmSync} from 'node:fs';import {randomUUID} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';import {buildServer as buildRoot} from '../src/server.mjs';import {buildServer as buildGateway} from '../packages/gateway/src/server.ts';
const directory=fileURLToPath(new URL(`../.test-tmp/discovery-task-ui-${randomUUID()}/`,import.meta.url)),origin='http://127.0.0.1:3065';mkdirSync(directory,{recursive:true});let gateway,root,browser;const errors=[],commands=[];
try{
 gateway=await buildGateway({databasePath:directory+'/gateway.sqlite',workspaces:['shared'],workbenchRoot:directory+'/workspaces',uploadRoot:directory+'/uploads',templateRoot:fileURLToPath(new URL('../packages/gateway/file-engine/templates/',import.meta.url)),csrfToken:'test-discovery-task-auth',allowedOrigins:[origin],workbenchExecutionReady:false});const gatewayUrl=await gateway.app.listen({host:'127.0.0.1',port:0});
 const agent=gateway.workbench.createAgent('local-user',{name:'Synthetic discovery role',workspace_id:'shared'});
 root=await buildRoot({database:':memory:',root:directory+'/portable',demo:true,workbench:{url:gatewayUrl,owner:'local-user',csrf:'test-discovery-task-auth'}});await root.app.listen({host:'127.0.0.1',port:3065});
 browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage({viewport:{width:440,height:956}});page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 const path=`/workbench-api/v1/agents/${agent.agent_id}/discovery-policy`;
 let lostSave=false;
 await page.route('**'+path+'**',async route=>{
  const request=route.request();if(!['PATCH','POST'].includes(request.method()))return route.continue();
  commands.push({path:new URL(request.url()).pathname,method:request.method(),key:request.headers()['idempotency-key'],body:request.postDataJSON()});
  const response=await route.fetch();assert.equal(response.status(),200,await response.text());
  // Deliver to the real server first; losing this response is not a rejection.
  if(request.method()==='PATCH'&&!lostSave){lostSave=true;return route.abort('failed');}
  return route.fulfill({response});
 });
 await page.goto(origin+'/workbench.html');
 const panel=page.getByRole('region',{name:`项目发现：${agent.name}`,exact:true}),form=page.getByRole('form',{name:'项目发现策略',exact:true});
 const open=async()=>{await page.getByRole('button',{name:`项目发现 ${agent.name}`,exact:true}).click();await panel.getByRole('button',{name:'重新读取策略',exact:true}).waitFor();};
 const settled=async(label,version)=>{await panel.getByRole('status').filter({hasText:new RegExp(`^${label} · 策略版本 ${version}$`)}).waitFor();await panel.getByRole('button',{name:'保存策略',exact:true}).waitFor({state:'visible'});};
 await open();await panel.getByRole('status').filter({hasText:/^默认关闭$/}).waitFor();assert.equal(await panel.getByRole('button',{name:'启用策略',exact:true}).count(),0);
 await form.getByLabel('两轮之间的冷却时间（整秒）',{exact:true}).fill('90');await form.getByLabel('用户输入后的等待时间（整秒）',{exact:true}).fill('20');await form.getByLabel('最多发现轮次',{exact:true}).fill('');
 await form.getByRole('button',{name:'保存策略',exact:true}).click();await panel.getByText('原请求结果待确认，请重试原请求；暂不能发起其他修改。',{exact:true}).waitFor();
 assert.equal(await form.getByLabel('最多发现轮次',{exact:true}).isDisabled(),true);assert.equal(await panel.getByRole('button',{name:'关闭项目发现',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('navigation',{name:'Agent 工作台',exact:true}).getByRole('button',{name:'持续任务',exact:true}).isDisabled(),true);
 assert.equal(gateway.db.prepare('SELECT count(*) n FROM wb_discovery_policy_revisions').get().n,1);assert.equal(gateway.db.prepare('SELECT count(*) n FROM wb_persistent_tasks').get().n,0);
 await panel.getByRole('button',{name:'重试原请求',exact:true}).click();await settled('默认关闭',1);assert.deepEqual(commands[1],commands[0]);assert.equal(gateway.db.prepare('SELECT count(*) n FROM wb_discovery_policy_revisions').get().n,1);
 assert.deepEqual(commands[0].body,{expected_version:0,expected_role_version:1,expected_role_epoch:1,mode:'discover_only',cooldown_ms:90000,recent_input_ms:20000,max_cycles:null});
 await panel.getByRole('button',{name:'启用策略',exact:true}).click();await settled('策略已启用',2);
 const binding=gateway.db.prepare('SELECT task_id FROM wb_discovery_task_bindings').get(),taskId=binding.task_id;
 await panel.getByRole('button',{name:'暂停策略',exact:true}).click();await settled('已暂停',3);
 await panel.getByRole('button',{name:'恢复策略',exact:true}).click();await settled('策略已启用',4);assert.equal(gateway.db.prepare('SELECT task_id FROM wb_discovery_task_bindings').get().task_id,taskId);
 await panel.getByRole('button',{name:'停止策略',exact:true}).click();await settled('已停止',5);
 await page.reload();await open();await settled('已停止',5);assert.equal(await form.getByLabel('两轮之间的冷却时间（整秒）',{exact:true}).inputValue(),'90');assert.equal(await form.getByLabel('用户输入后的等待时间（整秒）',{exact:true}).inputValue(),'20');assert.equal(await form.getByLabel('最多发现轮次',{exact:true}).inputValue(),'');
 assert.equal(gateway.db.prepare('SELECT count(*) n FROM wb_discovery_policy_revisions').get().n,5);assert.equal(commands.length,6);assert.deepEqual(commands.slice(2).map(command=>command.body.action),['enable','pause','enable','stop']);
 await panel.getByRole('button',{name:'关闭项目发现',exact:true}).click();const tasks=async()=>{await page.getByRole('navigation',{name:'Agent 工作台',exact:true}).getByRole('button',{name:'持续任务',exact:true}).click();};await tasks();
 const card=page.locator('.wb-task-card').filter({has:page.getByRole('heading',{name:'项目发现',exact:true})});await card.getByText('通过项目发现策略管理',{exact:true}).waitFor();await card.getByText(/项目发现策略/).first().waitFor();for(const name of ['立即运行','编辑','暂停','恢复','归档'])assert.equal(await card.getByRole('button',{name,exact:true}).count(),0);assert.equal(await card.getByRole('button',{name:'执行记录',exact:true}).count(),1);
 const csrf=(await page.request.get(origin+'/workbench-api/v1/capabilities')).headers()['x-csrf-token'];assert.ok(csrf);
 const refused=await page.request.post(origin+`/workbench-api/v1/persistent-tasks/${taskId}/run-now`,{headers:{'x-csrf-token':csrf,'idempotency-key':'synthetic-refused-manual'},data:{}});assert.equal(refused.status(),409);
 assert.equal(gateway.persistentTasks.get('local-user',taskId).status,'paused');assert.equal(gateway.db.prepare('SELECT count(*) n FROM wb_persistent_tasks').get().n,1);assert.equal(gateway.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,0);assert.equal(gateway.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({built_ui:true,actual_policy_form:true,original_bff:true,saved_off:true,explicit_enable:true,managed_controls:true,pause_resume_stop:true,reload_persisted:true,lost_response_same_command:true,policy_revisions:5,single_fixed_task:true,occurrences:0,model_runs:0,page_errors:0}));
}finally{await browser?.close();root?.app.server.closeAllConnections();gateway?.app.server.closeAllConnections();await root?.close();await gateway?.app.close();gateway?.db.close();rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:30});}
