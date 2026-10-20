import test from 'node:test';import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,lstat} from 'node:fs/promises';import {join,resolve} from 'node:path';import {fileURLToPath} from 'node:url';import {fork} from 'node:child_process';import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';import {chromium} from 'playwright';
import {publicationReviewFixture} from '../../packages/gateway/test/support/work-publication-fixture.mjs';
import {upgradeWorkspacePublicationCoordination} from '../../packages/gateway/src/workbench/workspace-coordination-upgrade.ts';
import {installWorkPublicationExecutions} from '../../packages/gateway/src/persistent-tasks/work-publication-executions.ts';
import {buildServer as gatewayServer} from '../../packages/gateway/src/server.ts';import {buildServer as bffServer} from '../../src/server.mjs';
import {publicationNativeHostFixture} from '../../packages/gateway/test/support/publication-native-host-fixture.mjs';
import {createNativeGitClient} from '../../packages/gateway/src/git/native-transport-client.ts';

function nativePeer(){
 const child=fork(fileURLToPath(new URL('../../packages/gateway/test/git/fixtures/native-publication-peer.mjs',import.meta.url)),[],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']}),queued=[],waiters=[];let failure,diagnostic='';
 child.stderr.on('data',bytes=>{diagnostic=(diagnostic+bytes).slice(-4096)});
 const reject=e=>{failure=e;for(const w of waiters.splice(0)){clearTimeout(w.timer);w.reject(e)}};
 child.on('message',m=>{if(m.type==='failed'){reject(Error('synthetic_native_peer_failed:'+m.diagnostic));return}const i=waiters.findIndex(w=>w.type===m.type);if(i<0)queued.push(m);else{const w=waiters.splice(i,1)[0];clearTimeout(w.timer);w.done(m)}});
 const exited=new Promise(done=>child.once('exit',code=>{if(code!==0&&code!==73)reject(Error('synthetic_native_peer_exit:'+code+':'+diagnostic));done(code)}));
 const take=type=>{if(failure)return Promise.reject(failure);const i=queued.findIndex(m=>m.type===type);if(i>=0)return Promise.resolve(queued.splice(i,1)[0]);return new Promise((done,reject)=>{const w={type,done,reject};w.timer=setTimeout(()=>reject(Error('synthetic_native_peer_timeout:'+type)),30000);waiters.push(w)})};
 return{child,exited,take,send:(type,value={})=>child.send({type,...value}),async close(){if(child.exitCode===null){if(child.connected)child.send({type:'stop'});let timer;await Promise.race([exited,new Promise(done=>{timer=setTimeout(done,5000)})]);clearTimeout(timer);if(child.exitCode===null){child.kill();await exited}}for(const w of waiters.splice(0)){clearTimeout(w.timer);w.reject(Error('synthetic_peer_closed'))}}};
}

test('mobile original-source review survives lost approval and reload, without claiming unconfigured dispatch applied',async t=>{
 let gateway,bff,browser;t.after(async()=>{await browser?.close();if(bff){bff.app.server.closeAllConnections();await bff.close()}if(gateway){gateway.app.server.closeAllConnections();await gateway.app.close();gateway.db.close()}});
 const f=await publicationReviewFixture(t);upgradeWorkspacePublicationCoordination(f.db);installWorkPublicationExecutions(f.db);
 const publicRoot=join(f.root,'ui-public');await mkdir(publicRoot);const origins=[],csrf='test-publication-ui-csrf-token';
 gateway=await gatewayServer({databasePath:join(f.root,'db.sqlite'),templateRoot:fileURLToPath(new URL('../../packages/gateway/file-engine/templates/',import.meta.url)),workspaces:['ws'],allowedOrigins:origins,csrfToken:csrf,gitRepositories:[{owner_id:'owner',project_id:f.scope.project_id,root:f.rootTarget}]});
 const conversation=f.db.prepare('SELECT conversation_id FROM ga_runs WHERE id=?').get(f.source.run_id).conversation_id;
 const props={conversationId:conversation,runId:f.source.run_id,taskId:f.source.task_id};
 const source="import React,{useState} from 'react';import{createRoot}from'react-dom/client';import Panel from './WorkPublicationPanel';import TasksPanel from './TasksPanel';import{MutationPending}from'./useMutationReceipt';import{request}from'../jot/client';function App(){const[pending,setPending]=useState(false);return location.search?<MutationPending.Provider value={setPending}><button disabled={pending}>切换测试视图</button><TasksPanel caps={{capabilities:{},workbench:{enabled:true,task_triggers:['once']}}} agents={[]} onConversation={()=>{}}/></MutationPending.Provider>:<Panel onBusy={value=>window.publicationLocked=value} {..."+JSON.stringify(props)+"}/>};request('/capabilities').then(()=>createRoot(document.getElementById('root')).render(<App/>));";
 await build({stdin:{contents:source,loader:'tsx',resolveDir:fileURLToPath(new URL('./',import.meta.url))},bundle:true,outfile:join(publicRoot,'bundle.js'),platform:'browser',format:'iife',logLevel:'silent'});
 await writeFile(join(publicRoot,'index.html'),'<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/bundle.js"></script>');
 bff=await bffServer({demo:true,database:join(f.root,'bff.sqlite'),root:join(f.root,'local'),publicRoot,workbench:{url:await gateway.app.listen({host:'127.0.0.1',port:0}),owner:'owner',csrf}});
 const origin=await bff.app.listen({host:'127.0.0.1',port:0});origins.push(origin);
 browser=await chromium.launch({headless:true,...(process.platform==='win32'?{executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'}:{})});const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(origin);await page.getByRole('button',{name:'查看工作区改动',exact:true}).click();await page.getByRole('checkbox',{name:'选择 source.md',exact:true}).check();
 await page.getByRole('button',{name:'生成复核',exact:true}).click();await page.getByRole('checkbox',{name:'已核对所选文件的目标修改',exact:true}).check();
 const approvals=[];let lose=true;await page.route('**/work-publications/*/control',async route=>{const r=route.request();approvals.push({body:r.postDataJSON(),key:r.headers()['idempotency-key']});if(lose){lose=false;await route.fetch();await route.abort('failed')}else await route.continue()});
 await page.getByRole('button',{name:'批准复核',exact:true}).click();await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='重试原请求'&&!b.disabled));assert.equal(await page.evaluate(()=>window.publicationLocked),true);await page.getByRole('button',{name:'重试原请求',exact:true}).click();
 await page.getByRole('button',{name:'受理应用',exact:true}).click();await page.getByText('已受理，尚未应用',{exact:true}).waitFor();
 assert.equal(approvals.length,2);assert.deepEqual(approvals[0],approvals[1]);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_work_publication_executions').get().n,1);
 await page.reload();await page.getByRole('button',{name:'查看工作区改动',exact:true}).click();await page.getByText('已受理，尚未应用',{exact:true}).waitFor();
 await page.getByRole('button',{name:'应用到工作区',exact:true}).click();await page.getByRole('alert').waitFor();
 assert.equal(await page.getByText('这次修改已应用',{exact:true}).count(),0);assert.deepEqual(await readFile(join(f.rootTarget,'source.md')),Buffer.from(f.base));
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_work_publication_journal').get().n,0);
 await page.goto(origin+'/?tasks=1');await page.getByRole('button',{name:'执行记录',exact:true}).first().click();await page.locator('.wb-occurrences button').first().click();await page.getByRole('button',{name:'查看工作区改动',exact:true}).click();await page.getByText('已受理，尚未应用',{exact:true}).waitFor();
 const saved=f.db.prepare('SELECT count(*) n FROM wb_work_publication_executions').get().n;let release;const held=new Promise(done=>{release=done});
 await page.route('**/work-publication-sources/*/history',async route=>{await held;await route.continue().catch(()=>{})});
 await page.getByRole('button',{name:'核对当前记录',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="关闭执行记录"]')?.disabled===true);assert.equal(await page.getByRole('button',{name:'切换测试视图',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'停止等待并核对',exact:true}).click();release();await page.waitForFunction(()=>document.querySelector('[aria-label="关闭执行记录"]')?.disabled===false);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_work_publication_executions').get().n,saved);await page.unrouteAll({behavior:'wait'});
});

test('mobile apply uses the original native Host and explicitly settles process loss without rewriting files',{skip:!process.env.JOT_DSH_RUNTIME_MODULES,timeout:180000},async t=>{
 let gateway,bff,browser;const peers=[];
 t.after(async()=>{await browser?.close();for(const p of peers.reverse())await p.close();if(bff){bff.app.server.closeAllConnections();await bff.close()}if(gateway){gateway.app.server.closeAllConnections();await gateway.app.close();gateway.db.close()}});
 const f=await publicationNativeHostFixture(t);await f.close();const publicRoot=join(f.root,'ui-public');await mkdir(publicRoot);
 const origins=[],csrf='test-publication-native-ui-csrf',token='test-publication-native-ui-source-token',transportToken='test-publication-native-ui-wire-token-0001';
 const bs=String.fromCharCode(92),socket=process.platform==='win32'?[bs,bs,'.',bs,'pipe',bs,'jot-git-publication-ui-',randomUUID()].join(''):join(f.root,'publication.sock');
 gateway=await gatewayServer({databasePath:join(f.root,'db.sqlite'),templateRoot:fileURLToPath(new URL('../../packages/gateway/file-engine/templates/',import.meta.url)),workspaces:['ws'],allowedOrigins:origins,csrfToken:csrf,internalChannelToken:token,nativeGitClient:await createNativeGitClient({socket,token:transportToken}),gitRepositories:[{owner_id:'owner',project_id:f.scope.project_id,root:f.rootTarget}]});
 const gatewayOrigin=await gateway.app.listen({host:'127.0.0.1',port:0}),config={privateRoot:f.root,persistenceRoot:join(f.root,'original-native-host','sessions'),runtime:resolve(process.env.JOT_DSH_RUNTIME_MODULES),origin:gatewayOrigin,channelToken:token,transportToken,database:join(f.root,'db.sqlite'),project:f.scope.project_id,root:f.rootTarget,socket};
 const open=async()=>{const p=nativePeer();peers.push(p);p.send('initialize',{config});assert.equal((await p.take('initialized')).modelCalls,0);p.send('mount',{config});assert.equal((await p.take('mounted')).modelCalls,0);return p};
 let p=await open();p.send('exit-after-apply');await p.take('exit-armed');
 const conversation=f.db.prepare('SELECT conversation_id FROM ga_runs WHERE id=?').get(f.source.run_id).conversation_id,props={conversationId:conversation,runId:f.source.run_id,taskId:f.source.task_id};
 await build({stdin:{contents:"import React from 'react';import{createRoot}from'react-dom/client';import Panel from './WorkPublicationPanel';import{request}from'../jot/client';request('/capabilities').then(()=>createRoot(document.getElementById('root')).render(<Panel {..."+JSON.stringify(props)+"}/>));",loader:'tsx',resolveDir:fileURLToPath(new URL('./',import.meta.url))},bundle:true,outfile:join(publicRoot,'bundle.js'),platform:'browser',format:'iife',logLevel:'silent'});
 await writeFile(join(publicRoot,'index.html'),'<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/bundle.js"></script>');
 bff=await bffServer({demo:true,database:join(f.root,'bff.sqlite'),root:join(f.root,'local'),publicRoot,workbench:{url:gatewayOrigin,owner:'owner',csrf}});const origin=await bff.app.listen({host:'127.0.0.1',port:0});origins.push(origin);
 browser=await chromium.launch({headless:true,...(process.platform==='win32'?{executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'}:{})});const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.setDefaultTimeout(15000);
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());await page.goto(origin);await page.getByRole('button',{name:'查看工作区改动',exact:true}).click();await page.getByText('已受理，尚未应用',{exact:true}).waitFor();
 await page.getByRole('button',{name:'应用到工作区',exact:true}).click();assert.equal(await p.exited,73);await page.getByText('修改已记录，等待完成确认',{exact:true}).waitFor();assert.equal(await page.getByText('这次修改已应用',{exact:true}).count(),0);
 const before=await lstat(join(f.rootTarget,'source.md'),{bigint:true});assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),'Exact reviewed work content');const count=f.db.prepare('SELECT count(*) n FROM wb_work_publication_journal').get().n;
 await page.reload();await page.getByRole('button',{name:'查看工作区改动',exact:true}).click();await page.getByText('修改已记录，等待完成确认',{exact:true}).waitFor();assert.equal(f.db.prepare('SELECT count(*) n FROM wb_work_publication_journal').get().n,count);
 const resource='git-index-binding:'+f.workbench.executionBinding('owner',f.scope.project_id),lease=f.db.prepare('SELECT owner,generation FROM ga_worker_leases WHERE resource_id=?').get(resource);assert.ok(lease);assert.equal(f.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=? AND owner=? AND generation=?').run(String(Date.now()-1),resource,lease.owner,lease.generation).changes,1);
 p=await open();await page.getByRole('checkbox',{name:'我已核对原始记录，确认本次恢复操作不会回滚或重放文件',exact:true}).check();await page.getByRole('button',{name:'确认已记录的应用',exact:true}).click();await page.getByText('这次修改已应用',{exact:true}).waitFor();
 const after=await lstat(join(f.rootTarget,'source.md'),{bigint:true});assert.equal(after.ino,before.ino);assert.equal(after.dev,before.dev);assert.equal(after.mtimeNs,before.mtimeNs);assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),'Exact reviewed work content');assert.equal(f.plain.publicationStatus('owner',f.scope.project_id,f.accepted.execution_id).state,'applied');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);if(process.env.JOT_TEST_SCREENSHOT_DIR)await page.screenshot({path:join(process.env.JOT_TEST_SCREENSHOT_DIR,'publication-applied.png'),fullPage:true});p.send('status');assert.equal((await p.take('status')).modelCalls,0);
});
