import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {buildServer as buildRoot} from '../src/server.mjs';
import {buildServer as buildGateway} from '../packages/gateway/src/server.ts';
import {HarnessCoordinator} from '../packages/gateway/src/harness/coordinator.ts';
import {withImmediateTransaction} from '../packages/gateway/src/db/database.ts';
import {ContractValidator} from '../packages/gateway/src/contracts/validator.ts';
const stage=process.argv[2]??'complete';if(!['init','content','complete'].includes(stage))throw new Error('Use init, content or complete as the upload stage.');
const directory=fileURLToPath(new URL(`../.test-tmp/upload-chat-browser-${stage}/`,import.meta.url));mkdirSync(directory,{recursive:true});
const gateway=await buildGateway({databasePath:':memory:',workspaces:['shared'],workbenchRoot:directory+'/workspace',uploadRoot:directory+'/uploads',templateRoot:fileURLToPath(new URL('../packages/gateway/file-engine/templates/',import.meta.url)),csrfToken:'test-upload-browser-auth',allowedOrigins:['http://127.0.0.1:3058'],workbenchExecutionReady:true});
const chat=gateway.conversations.create('local-user',{title:'Attachment test',workspace_id:'shared',model:{provider:'harness',model:'automatic'}});
const address=await gateway.app.listen({host:'127.0.0.1',port:0}),service=await buildRoot({database:':memory:',root:directory+'/files',demo:true,workbench:{url:address,owner:'local-user',csrf:'test-upload-browser-auth'}});
let browser,page;const errors=[],completionRequests=[],messageRequests=[];
try{
 await service.app.listen({host:'127.0.0.1',port:3058});browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});page=await browser.newPage({viewport:{width:440,height:956}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 const pattern=stage==='init'?'**/workbench-api/v1/conversations/*/uploads':`**/workbench-api/v1/uploads/*/${stage}`;
 await page.route(pattern,async route=>{completionRequests.push({body:route.request().postData(),key:route.request().headers()['idempotency-key']});const response=await route.fetch();assert.equal(response.status(),stage==='content'?204:201);if(completionRequests.length===1)await route.abort('failed');else await route.fulfill({response});});
 await page.route('**/workbench-api/v1/conversations/*/messages',async route=>{if(route.request().method()!=='POST')return route.continue();messageRequests.push({body:route.request().postData(),key:route.request().headers()['idempotency-key']});const response=await route.fetch();assert.equal(response.status(),202);if(messageRequests.length===1)await route.abort('failed');else await route.fulfill({response});});
 await page.goto('http://127.0.0.1:3058/workbench.html');await page.getByRole('button',{name:'我的对话',exact:true}).click();await page.getByRole('button',{name:'Attachment test',exact:true}).click();
 const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
 await page.getByLabel('添加文件',{exact:true}).setInputFiles([{name:'sample.txt',mimeType:'text/plain',buffer:Buffer.from('Attachment preview fixture.')},{name:'pixel.png',mimeType:'image/png',buffer:pixel}]);await page.getByText('sample.txt · 结果尚未确认',{exact:true}).waitFor();await page.getByText('pixel.png · 等待上传',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'发送',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('region',{name:'Ordinary conversation',exact:true}).getByRole('button',{name:'返回工作台',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'重试原附件 sample.txt',exact:true}).click();await page.getByText('sample.txt · 上传完成',{exact:true}).waitFor();await page.getByRole('button',{name:'重试原附件 pixel.png',exact:true}).click();await page.getByText('pixel.png · 上传完成',{exact:true}).waitFor();assert.equal(gateway.db.prepare('SELECT count(*) n FROM ga_uploads').get().n,2);assert.equal(gateway.db.prepare('SELECT count(*) n FROM ga_artifacts').get().n,2);assert.deepEqual(completionRequests[0],completionRequests[1]);
 await page.getByLabel('对话消息',{exact:true}).fill('Read this attachment');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByRole('button',{name:'重试原消息',exact:true}).waitFor();await page.getByRole('button',{name:'重试原消息',exact:true}).click();
 await page.getByRole('button',{name:'预览 sample.txt',exact:true}).waitFor();assert.deepEqual(messageRequests[0],messageRequests[1]);assert.equal(gateway.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(gateway.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='user'").get().n,1);
 await page.getByRole('button',{name:'预览 sample.txt',exact:true}).click();await page.getByRole('region',{name:'附件预览',exact:true}).getByText('Attachment preview fixture.',{exact:true}).waitFor();await page.getByRole('button',{name:'关闭预览',exact:true}).click();
 await page.getByRole('button',{name:'预览 pixel.png',exact:true}).click();await page.getByRole('img',{name:'pixel.png',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('.jot-file-preview img')?.naturalWidth===1);await page.getByRole('button',{name:'关闭预览',exact:true}).click();
 await page.reload();await page.getByRole('button',{name:'我的对话',exact:true}).click();await page.getByRole('button',{name:'Attachment test',exact:true}).click();await page.getByRole('button',{name:'预览 sample.txt',exact:true}).waitFor();
 // Synthetic host output, using the real fenced coordinator and durable events.
 // This is presentation acceptance, not a model or task completion acceptance.
 const coordinator=new HarnessCoordinator(gateway.db,gateway.runs,gateway.events),lease=coordinator.claimNext('test-output-worker',60000);assert.ok(lease);
 const ids=[];
 for(let index=1;index<=4;index++){
  const source=directory+`/report-${index}.md`;writeFileSync(source,`# Report ${index}\nSynthetic generated output.\n`);
  const group=gateway.artifacts.registerGenerated(lease.run_id,`test-output-${randomUUID()}`,[{path:source,display_name:`report-${index}.md`}]),file=gateway.artifacts.get(group.artifact_ref,'local-user',1);ids.push(group.artifact_ref);
  coordinator.recordArtifact(lease,{artifactId:file.artifact_id,version:1,displayName:file.file_name,mediaType:file.media_type,sizeBytes:file.size_bytes,sha256:file.sha256,localPath:group.parts[0].server_path,kind:'text'});
 }
 assert.equal(await page.getByRole('button',{name:/^下载 report-/}).count(),0);
 const artifactEvents=gateway.events.replay(chat.conversation_id,0,1000).filter(value=>value.type==='run.artifact'),contracts=new ContractValidator();assert.equal(artifactEvents.length,4);assert.equal(contracts.validateResponse(contracts.operationFor('GET','/v1/runs/:runId/artifacts'),200,{items:artifactEvents.map(event=>event.payload)}).valid,true);
 coordinator.recordAssistant(lease,'Generated report fixture.',undefined,ids);assert.equal(await page.getByRole('button',{name:/^下载 report-/}).count(),0);
 withImmediateTransaction(gateway.db,()=>gateway.runs.finalizePublication(lease.run_id,'succeeded',null));
 await page.getByRole('button',{name:'下载 report-1.md',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:/^下载 report-/}).count(),3);await page.getByRole('button',{name:'展开其余 1 个文件',exact:true}).click();assert.equal(await page.getByRole('button',{name:/^下载 report-/}).count(),4);
 const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'下载 report-1.md',exact:true}).click();const download=await downloaded;assert.equal(download.suggestedFilename(),'report-1.md');const downloadedPath=directory+'/downloaded-report-1.md';await download.saveAs(downloadedPath);assert.equal(readFileSync(downloadedPath,'utf8'),'# Report 1\nSynthetic generated output.\n');
 await page.reload();await page.getByRole('button',{name:'我的对话',exact:true}).click();await page.getByRole('button',{name:'Attachment test',exact:true}).click();await page.getByRole('button',{name:'下载 report-1.md',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:/^下载 report-/}).count(),3);assert.equal(await page.getByText('Generated report fixture.',{exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'预览 sample.txt',exact:true}).count(),1);
 assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.screenshot({path:directory+'/uploaded-message.png',fullPage:true});
 console.log(JSON.stringify({result:'PASS',actual_local_gateway:true,upload_stage:stage,upload_receipt_replay:true,message_receipt_replay:true,uploads:2,uploaded_artifacts:2,generated_artifacts:4,runs:1,user_messages:1,multiple_selection_retained:true,text_preview:true,image_preview:true,reload:true,final_reply_downloads:true,max_three:true,expand:true,exact_download_bytes:true,run_artifact_contract:true,page_errors:0,mobile_overflow:false,external_requests:0,model_calls:0}));
}catch(error){console.log(await page?.locator('body').innerText());console.error(error);throw error;}finally{await browser?.close();service.app.server.closeAllConnections();gateway.app.server.closeAllConnections();await service.close();await gateway.app.close();gateway.db.close();}
