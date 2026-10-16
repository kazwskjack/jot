// Built UI -> original BFF -> real isolated Gateway/SQLite. Synthetic tasks only.
import assert from 'node:assert/strict';
import {mkdirSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {buildServer as buildRoot} from '../src/server.mjs';
import {buildServer as buildGateway} from '../packages/gateway/src/server.ts';
const directory=fileURLToPath(new URL(`../.test-tmp/unlimited-task-ui-${randomUUID()}/`,import.meta.url));mkdirSync(directory,{recursive:true});
let gateway,root,browser,page;const errors=[],commands=[],origin='http://127.0.0.1:3064';
try{
 gateway=await buildGateway({databasePath:directory+'/gateway.sqlite',workspaces:['shared'],workbenchRoot:directory+'/workspaces',uploadRoot:directory+'/uploads',templateRoot:fileURLToPath(new URL('../packages/gateway/file-engine/templates/',import.meta.url)),csrfToken:'test-unlimited-task-auth',allowedOrigins:[origin],workbenchExecutionReady:false});
 const gatewayUrl=await gateway.app.listen({host:'127.0.0.1',port:0});
 const agent=gateway.workbench.createAgent('local-user',{name:'Synthetic watcher',instructions:'Only isolated test tasks',workspace_id:'shared'});
 root=await buildRoot({database:':memory:',root:directory+'/portable',demo:true,workbench:{url:gatewayUrl,owner:'local-user',csrf:'test-unlimited-task-auth'}});await root.app.listen({host:'127.0.0.1',port:3064});
 browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});page=await browser.newPage({viewport:{width:440,height:956}});page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.route('**/workbench-api/v1/persistent-tasks',async route=>{
  if(route.request().method()!=='POST')return route.continue();
  commands.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});
  const response=await route.fetch();assert.equal(response.status(),201);
  if(commands.length===1)await route.abort('failed');else await route.fulfill({response});
 });
 const tasks=async()=>page.getByRole('navigation',{name:'Agent 工作台',exact:true}).getByRole('button',{name:'持续任务',exact:true}).click();
 const next=()=>page.getByRole('button',{name:'下一步',exact:true}).click();
 const preview=()=>page.getByText(/首次执行预览：/).waitFor();
 await page.goto(origin+'/workbench.html');await tasks();await page.getByRole('button',{name:'创建任务',exact:true}).click();
 await page.getByLabel('任务名称',{exact:true}).fill('Unlimited fixture');await page.getByLabel('执行角色',{exact:true}).selectOption(agent.agent_id);await page.getByLabel('目标与结果要求',{exact:true}).fill('Observe synthetic input only');
 await next();await page.getByLabel(/^触发方式/).selectOption('interval');await preview();await next();
 assert.equal(await page.getByLabel('最多运行次数',{exact:true}).inputValue(),'100');
 await page.getByRole('checkbox',{name:'不限运行次数',exact:true}).check();await next();await next();
 await page.getByRole('region',{name:'任务配置总确认'}).getByText('不限次数',{exact:true}).waitFor();
 await page.getByRole('button',{name:'确认并保存任务',exact:true}).click();await page.getByRole('button',{name:'重试原任务',exact:true}).waitFor();
 assert.equal(gateway.db.prepare('SELECT count(*) n FROM wb_persistent_tasks').get().n,1);
 await page.reload();await tasks();await page.getByRole('button',{name:'重试原任务',exact:true}).click();
 const card=page.locator('.wb-task-card').filter({hasText:'Unlimited fixture'});await card.getByText('已运行 0 次 · 不限次数',{exact:true}).waitFor();
 assert.equal(commands.length,2);assert.deepEqual(commands[1],commands[0]);assert.equal(JSON.parse(commands[0].body).budget.max_runs,null);
 let task=gateway.persistentTasks.list('local-user').items[0];assert.equal(task.budget.max_runs,null);
 await card.getByRole('button',{name:'编辑',exact:true}).click();await next();await preview();await next();
 assert.equal(await page.getByRole('checkbox',{name:'不限运行次数',exact:true}).isChecked(),true);
 await page.getByRole('checkbox',{name:'不限运行次数',exact:true}).uncheck();await page.getByLabel('最多运行次数',{exact:true}).fill('5');await next();await next();
 await page.getByRole('button',{name:'确认并保存任务',exact:true}).click();await card.getByText('已运行 0 / 5',{exact:true}).waitFor();
 task=gateway.persistentTasks.list('local-user').items[0];assert.equal(task.budget.max_runs,5);assert.equal(gateway.db.prepare('SELECT count(*) n FROM wb_persistent_tasks').get().n,1);
 await page.route('**/workbench-api/v1/capabilities',async route=>{const response=await route.fetch(),body=await response.json();delete body.workbench.task_unlimited_runs;delete body.workbench.task_run_limit_protocol;await route.fulfill({response,json:body});});
 await page.reload();await tasks();await card.getByRole('button',{name:'编辑',exact:true}).click();await next();await preview();await next();
 assert.equal(await page.getByRole('checkbox',{name:'不限运行次数',exact:true}).count(),0);assert.equal(await page.getByLabel('最多运行次数',{exact:true}).inputValue(),'5');
 assert.equal(gateway.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({unlimited_create:true,lost_reply_reload:true,exact_body_and_key:true,single_task:true,finite_edit:true,capability_absence_hides_unlimited:true,model_runs:0,page_errors:0}));
}catch(error){if(page)console.error((await page.locator('body').innerText()).slice(-2500));throw error;}
finally{await browser?.close();root?.app.server.closeAllConnections();gateway?.app.server.closeAllConnections();await root?.close();await gateway?.app.close();gateway?.db.close();rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:30});}
