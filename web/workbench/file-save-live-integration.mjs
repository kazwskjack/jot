import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build as buildVite} from 'vite';
import {chromium} from 'playwright';
import {buildServer as buildGateway} from '../../packages/gateway/src/server.ts';
import {buildServer as buildJot} from '../../src/server.mjs';

const repositoryRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
if(resolve(process.cwd())!==repositoryRoot)throw new Error(`run_from_project_root:${repositoryRoot}`);
const scratch=resolve(process.env.JOT_TEST_TMP??join(repositoryRoot,'.test-tmp','m21-03-real-save'));
mkdirSync(scratch,{recursive:true});
const fixtureRoot=mkdtempSync(join(scratch,'jot-m21-03-real-save-'));
const workspace='ws-one',ownerA='owner-a',ownerB='owner-b',csrf='m21-03-live-gateway-csrf-token';
const digest=value=>createHash('sha256').update(value,'utf8').digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const esc=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
let gateway,jot,browser;

try{
 await buildVite({build:{manifest:true}});
 const allowedOrigins=[];
 gateway=await buildGateway({databasePath:join(fixtureRoot,'gateway.sqlite'),workspaces:[workspace],workbenchRoot:join(fixtureRoot,'workspace'),templateRoot:join(repositoryRoot,'packages/gateway/file-engine/templates'),csrfToken:csrf,allowedOrigins});
 const projectOne=gateway.projects.ensureDefault(ownerA).project_id;
 const projectTwo=gateway.projects.create(ownerA,{title:'Live Save Project Two'}).project_id;
 const projectB=gateway.projects.ensureDefault(ownerB).project_id;
 gateway.workbench.createAgent(ownerA,{name:'Live Save Project One',workspace_id:workspace,project_id:projectOne});
 gateway.workbench.createAgent(ownerA,{name:'Live Save Project Two',workspace_id:workspace,project_id:projectTwo});
 gateway.workbench.createAgent(ownerB,{name:'Owner B Project',workspace_id:workspace,project_id:projectB});
 assert.ok(projectOne&&projectTwo&&projectB&&projectOne!==projectTwo&&projectOne!==projectB);
 const currentWrites=[],gatewayTransportWrites=[];
 gateway.app.addHook('preHandler',async request=>{
  if(request.method==='PUT'&&request.url.split('?')[0]==='/v1/workspaces/'+workspace+'/files')currentWrites.push({owner:String(request.headers['x-user-id']??''),body:structuredClone(request.body),key:String(request.headers['idempotency-key']??''),status:null});
 });
 const gatewayOrigin=await gateway.app.listen({host:'127.0.0.1',port:0});

 const sources={
  'src/edit.ts':'const editBase = 1;\n',
  'src/load-latest.ts':'const latestBase = 1;\n',
  'src/rebase.ts':'const rebaseBase = 1;\n',
  'src/receipt.ts':'const receiptBase = 1;\n',
  'src/project-race.ts':'const projectBase = 1;\n',
  'src/owner-pending.ts':'const ownerBase = 1;\n',
 };
 for(const [path,content] of Object.entries(sources)){
  const target=path==='src/project-race.ts'?projectOne:path==='src/owner-pending.ts'?projectOne:path==='src/receipt.ts'?projectOne:projectOne;
  gateway.workbench.writeFile(ownerA,workspace,{project_id:target,path,content,expected_version:0});
 }
 const ownerBContent='export const ownerB = true;\n';
 gateway.workbench.writeFile(ownerB,workspace,{project_id:projectB,path:'src/owner-b.ts',content:ownerBContent,expected_version:0});

 let activeOwner=ownerA,dropNextResponse=false,ownerSaveGate=null,projectRace=null;
 const gateFetch=async(url,init={})=>{
  const headers=new Headers(init.headers),method=String(init.method??'GET').toUpperCase(),parsedUrl=new URL(url);
  headers.set('x-user-id',activeOwner);
  let body;
  if(typeof init.body==='string')try{body=JSON.parse(init.body);}catch{}
  const isFileWrite=method==='PUT'&&parsedUrl.pathname==='/v1/workspaces/'+workspace+'/files';
  if(isFileWrite)gatewayTransportWrites.push({owner:activeOwner,body:structuredClone(body),key:headers.get('idempotency-key')});
  if(isFileWrite&&projectRace&&!projectRace.used&&body?.path==='src/project-race.ts'){
   const race=projectRace;race.used=true;race.entered.resolve({body:structuredClone(body),key:headers.get('idempotency-key')});
   await Promise.race([race.beforeSend.promise,new Promise((_,reject)=>init.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}))]);
  }
  if(isFileWrite&&ownerSaveGate&&!ownerSaveGate.used&&body?.path==='src/owner-pending.ts'){
   const hold=ownerSaveGate;hold.used=true;hold.entered.resolve({body:structuredClone(body),key:headers.get('idempotency-key')});
   await Promise.race([hold.beforeSend.promise,new Promise((_,reject)=>init.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}))]);
  }
  const response=await fetch(url,{...init,headers});
  if(isFileWrite&&projectRace?.used&&body?.path==='src/project-race.ts'&&projectRace.response.status===null){
   const race=projectRace;race.response.status=response.status;race.responseReached.resolve({status:response.status});await race.releaseResponse.promise;
  }
  if(isFileWrite&&dropNextResponse&&response.ok){
   dropNextResponse=false;await response.arrayBuffer();
   const key=headers.get('idempotency-key');droppedReceipt.resolve({status:response.status,body:structuredClone(body),key});
   throw new TypeError('synthetic_response_drop_after_gateway_commit');
  }
  return response;
 };
 const droppedReceipt=deferred();
 jot=await buildJot({demo:true,root:join(fixtureRoot,'jot-files'),database:join(fixtureRoot,'jot.sqlite'),publicRoot:join(repositoryRoot,'dist'),workbench:{url:gatewayOrigin,owner:ownerA,csrf,fetch:gateFetch}});
 const jotOrigin=await jot.app.listen({host:'127.0.0.1',port:0});
 allowedOrigins.push(jotOrigin);
 const executablePath=process.env.JOT_WORKBENCH_CHROME_PATH??(process.platform==='win32'?chromium.executablePath():undefined);
 browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
 const context=await browser.newContext({viewport:{width:1180,height:920}}),page=await context.newPage();
 const uiWrites=[];
 page.on('request',request=>{
  const url=new URL(request.url());
  if(request.method()==='PUT'&&url.pathname==='/workbench-api/v1/workspaces/'+workspace+'/files')uiWrites.push({body:request.postDataJSON(),key:request.headers()['idempotency-key']});
 });
 const ownerACapabilityResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/workbench-api/v1/capabilities',{timeout:15_000});
 await page.goto(`${jotOrigin}/workbench.html`);
 const ownerAScope=(await (await ownerACapabilityResponse).allHeaders())['x-workbench-draft-scope'];
 assert.match(ownerAScope??'',/^[a-f0-9]{64}$/,'the BFF returns owner A capability draft scope');
 await page.getByRole('button',{name:'共享工作区'}).click();
 await page.getByRole('heading',{name:'共享工作区'}).waitFor({timeout:15_000});
 await page.getByRole('button',{name:'共同文件'}).click();
 await page.locator('select').nth(1).waitFor({timeout:15_000});
 const projectSelect=page.locator('select').nth(1);
 await projectSelect.selectOption(projectOne);

 const waitDraftPersisted=()=>page.getByText('未保存草稿已保存在此标签页会话中。',{exact:true}).waitFor({timeout:15_000});
 const createDraft=async(path,content)=>{
  await page.getByRole('button',{name:'新建共同文件'}).click();
  await page.getByLabel('项目内相对路径').fill(path);
  await page.getByLabel('文本草稿').fill(content);
  await waitDraftPersisted();
 };
 const openFile=async(path)=>{
  await page.getByRole('button',{name:new RegExp(esc(path))}).click();
  await page.getByLabel('文本草稿').waitFor({timeout:15_000});
 };
 const editAndReview=async(path,content,baseVersion)=>{
  await openFile(path);
  await page.getByLabel('文本草稿').fill(content);
  await waitDraftPersisted();
  await page.getByRole('button',{name:'检查修改'}).click();
  await page.getByText('保存前检查',{exact:true}).waitFor({timeout:15_000});
  await page.getByRole('button',{name:'确认应用保存'}).click();
  await page.getByRole('button',{name:`应用保存（v${baseVersion}）`}).waitFor({timeout:15_000});
  assert.match(await page.locator('.wb-file-review').innerText(),new RegExp(`expected_version: ${baseVersion}`));
 };
 const applyReviewed=async(baseVersion)=>{
  await page.getByRole('button',{name:`应用保存（v${baseVersion}）`}).click();
 };
 const rowsFor=(owner,project,path)=>({
  current:gateway.db.prepare('SELECT owner_id,workspace_id,project_id,path,version,sha256,size FROM wb_files WHERE owner_id=? AND workspace_id=? AND project_id=? AND path=?').get(owner,workspace,project,path),
  versions:gateway.db.prepare('SELECT owner_id,workspace_id,project_id,path,version,sha256,size FROM wb_file_versions WHERE owner_id=? AND workspace_id=? AND project_id=? AND path=? ORDER BY version').all(owner,workspace,project,path),
 });
 const verifiedSqliteRows=[];
 const assertVersions=(owner,project,path,contents)=>{
  const {current,versions}=rowsFor(owner,project,path);
  assert.ok(current,`current SQLite file row exists for ${owner}/${project}/${path}`);
  assert.equal(current.owner_id,owner);assert.equal(current.workspace_id,workspace);assert.equal(current.project_id,project);
  assert.equal(current.path,path);assert.ok(!path.startsWith('/')&&!/^[A-Za-z]:/.test(path),'stored path is project-relative');
  assert.equal(current.version,contents.length);assert.equal(current.sha256,digest(contents.at(-1)));assert.equal(current.size,Buffer.byteLength(contents.at(-1),'utf8'));
  assert.deepEqual(versions.map(row=>row.version),contents.map((_,index)=>index+1));
  assert.deepEqual(versions.map(row=>row.sha256),contents.map(digest));
  assert.deepEqual(versions.map(row=>row.size),contents.map(content=>Buffer.byteLength(content,'utf8')));
  assert.ok(versions.every(row=>row.owner_id===owner&&row.workspace_id===workspace&&row.project_id===project&&row.path===path));
  verifiedSqliteRows.push({current,versions});
  return {current,versions};
 };
 const gatewayWrite=async(owner,project,path,content,expectedVersion)=>{
  const key=`live-write-${randomUUID()}`;
  const response=await fetch(`${gatewayOrigin}/v1/workspaces/${workspace}/files`,{method:'PUT',headers:{'content-type':'application/json','x-user-id':owner,'x-csrf-token':csrf,origin:jotOrigin,'idempotency-key':key},body:JSON.stringify({project_id:project,path,content,expected_version:expectedVersion})});
  const payload=await response.json();
  assert.equal(response.status,200,`real Gateway HTTP write succeeds: ${JSON.stringify(payload)}`);
  return {payload,key};
 };

 // UI create from version zero: review, explicit confirmation, real BFF/Gateway PUT.
 const createPath='src/new.ts',createContent='export const greeting = "你好 😀";\n';
 await createDraft(createPath,createContent);
 await page.getByRole('button',{name:'检查修改'}).click();
 await page.getByText('保存前检查',{exact:true}).waitFor({timeout:15_000});
 await page.getByRole('button',{name:'确认应用保存'}).click();
 await page.getByRole('button',{name:'应用保存（v0）'}).waitFor({timeout:15_000});
 assert.match(await page.locator('.wb-file-review').innerText(),/expected_version: 0/);
 await applyReviewed(0);
 await page.getByLabel('文本草稿').waitFor({state:'detached',timeout:15_000});
 assert.equal(uiWrites[0].body.expected_version,0);
 assert.equal(currentWrites.at(-1).body.expected_version,0);
 assert.equal(currentWrites.at(-1).owner,ownerA);
 assertVersions(ownerA,projectOne,createPath,[createContent]);

 // Ordinary update/save of a v1 file through the browser and current Jot proxy.
 const editPath='src/edit.ts',editOne=sources[editPath],editTwo='const editBase = 2;\n';
 await editAndReview(editPath,editTwo,1);await applyReviewed(1);
 await page.getByLabel('文本草稿').waitFor({state:'detached',timeout:15_000});
 assert.equal(uiWrites.at(-1).body.expected_version,1);
 assertVersions(ownerA,projectOne,editPath,[editOne,editTwo]);

 // External version 2 arrives over the actual Gateway HTTP endpoint. A stale UI save must conflict and preserve both sides.
 const loadPath='src/load-latest.ts',loadOne=sources[loadPath],loadTwo='const latestBase = 2;\n',loadLocal='const latestLocal = "keep me";\n';
 await openFile(loadPath);await page.getByLabel('文本草稿').fill(loadLocal);await waitDraftPersisted();
 await gatewayWrite(ownerA,projectOne,loadPath,loadTwo,1);
 await page.getByRole('button',{name:'检查修改'}).click();await page.getByText('保存前检查',{exact:true}).waitFor();
 await page.getByRole('button',{name:'确认应用保存'}).click();await applyReviewed(1);
 await page.getByText('版本冲突：本地草稿已保留，请比较服务端最新版本。',{exact:true}).waitFor({timeout:15_000});
 assert.equal(await page.getByLabel('文本草稿').inputValue(),loadLocal);
 assert.match(await page.getByLabel('安全文本预览').textContent()??'',/const latestBase = 2/);
 await page.getByRole('button',{name:'载入最新内容'}).click();
 assert.equal(await page.getByLabel('文本草稿').inputValue(),loadTwo,'load latest is an explicit user action and discards the stale local text only after selection');
 assertVersions(ownerA,projectOne,loadPath,[loadOne,loadTwo]);

 // Rebase is another explicit path: keep local, bind v2, inspect and confirm again, then write v3.
 const rebasePath='src/rebase.ts',rebaseOne=sources[rebasePath],rebaseTwo='const rebaseBase = 2;\n',rebaseLocal='const rebaseLocal = "preserved";\n',rebaseThree=rebaseLocal;
 await openFile(rebasePath);await page.getByLabel('文本草稿').fill(rebaseLocal);await waitDraftPersisted();
 await gatewayWrite(ownerA,projectOne,rebasePath,rebaseTwo,1);
 await page.getByRole('button',{name:'检查修改'}).click();await page.getByText('保存前检查',{exact:true}).waitFor();
 await page.getByRole('button',{name:'确认应用保存'}).click();await applyReviewed(1);
 await page.getByText('版本冲突：本地草稿已保留，请比较服务端最新版本。',{exact:true}).waitFor({timeout:15_000});
 assert.equal(await page.getByLabel('文本草稿').inputValue(),rebaseLocal);
 assert.match(await page.getByLabel('安全文本预览').textContent()??'',/const rebaseBase = 2/);
 await page.getByRole('button',{name:'保留草稿并以最新版本为基础'}).click();
 assert.equal(await page.getByLabel('文本草稿').inputValue(),rebaseLocal);
 await page.getByRole('button',{name:'检查修改'}).click();await page.getByText('保存前检查',{exact:true}).waitFor();
 await page.getByRole('button',{name:'确认应用保存'}).click();await applyReviewed(2);
 await page.getByLabel('文本草稿').waitFor({state:'detached',timeout:15_000});
 assert.equal(uiWrites.at(-1).body.expected_version,2);
 assertVersions(ownerA,projectOne,rebasePath,[rebaseOne,rebaseTwo,rebaseThree]);

 // The test BFF consumes the successful real response, then drops it. Retry must reuse the exact receipt key and body.
 const receiptPath='src/receipt.ts',receiptOne=sources[receiptPath],receiptTwo='const receiptBase = "retried once";\n';
 await editAndReview(receiptPath,receiptTwo,1);
 const recordStart=gatewayTransportWrites.length,committedStart=currentWrites.length;dropNextResponse=true;
 await applyReviewed(1);
 const dropped=await droppedReceipt.promise;
 assert.equal(dropped.status,200);assert.equal(dropped.body.expected_version,1);
 await page.getByRole('button',{name:'重试原保存'}).waitFor({state:'visible',timeout:15_000});
 assert.equal(await page.getByLabel('文本草稿').isDisabled(),true,'unknown write freezes further edits while the receipt is pending');
 assert.equal(await page.getByRole('button',{name:'重试原保存'}).isEnabled(),true);
 await page.getByRole('button',{name:'重试原保存'}).click();
 await page.getByLabel('文本草稿').waitFor({state:'detached',timeout:15_000});
 const receiptCalls=gatewayTransportWrites.slice(recordStart),committedReceiptCalls=currentWrites.slice(committedStart);
 assert.equal(receiptCalls.length,2,'the Jot BFF sent the original write and one real same-key HTTP replay to Gateway');
 assert.deepEqual(receiptCalls[1].body,receiptCalls[0].body);
 assert.equal(receiptCalls[1].key,receiptCalls[0].key);
 assert.equal(receiptCalls[0].key,dropped.key);
 assert.equal(committedReceiptCalls.length,1,'Gateway idempotency replay returns the saved receipt without rerunning the file mutation');
 assertVersions(ownerA,projectOne,receiptPath,[receiptOne,receiptTwo]);

 // Leave a recoverable project-two draft, then test that a delayed project-one 409 cannot repaint project two.
 await projectSelect.selectOption(projectTwo);
 const projectDraftPath='src/project-two-draft.ts',projectDraft='export const projectTwoDraft = true;\n';
 await createDraft(projectDraftPath,projectDraft);
 await projectSelect.selectOption(projectOne);
 await page.getByRole('button',{name:/src\/project-race\.ts/}).waitFor({timeout:15_000});
 await openFile('src/project-race.ts');
 const raceLocal='const localProjectOneDraft = true;\n';
 await page.getByLabel('文本草稿').fill(raceLocal);await waitDraftPersisted();
 await page.getByRole('button',{name:'检查修改'}).click();await page.getByText('保存前检查',{exact:true}).waitFor();
 await page.getByRole('button',{name:'确认应用保存'}).click();
 const race={used:false,response:{status:null},entered:deferred(),beforeSend:deferred(),responseReached:deferred(),releaseResponse:deferred()};projectRace=race;
 await applyReviewed(1);
 const held=await race.entered.promise;
 assert.equal(held.body.expected_version,1);
 const raceRemote='const projectOneRemote = 2;\n';
 await gatewayWrite(ownerA,projectOne,'src/project-race.ts',raceRemote,1);
 await page.getByRole('button',{name:'切回草稿项目'}).click();
 await page.waitForFunction(project=>Array.from(document.querySelectorAll('select')).some(select=>select.value===project),projectTwo,{timeout:15_000});
 race.beforeSend.resolve();
 const lateConflict=await race.responseReached.promise;
 assert.equal(lateConflict.status,409,'the delayed browser command is a real Gateway version conflict');
 const browserConflict=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/workbench-api/v1/workspaces/'+workspace+'/files'&&response.status()===409;},{timeout:15_000});
 race.releaseResponse.resolve();
 await browserConflict;
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await projectSelect.inputValue(),projectTwo);
 assert.equal(await page.getByLabel('文件来源').getByText('src/project-race.ts',{exact:true}).count(),0,'late project-one conflict cannot render a project-one file in project two');
 assert.equal(await page.getByLabel('安全文本预览').count(),0,'late project-one conflict cannot repaint the project-two preview');
 assert.equal(await page.getByText('版本冲突：本地草稿已保留，请比较服务端最新版本。',{exact:true}).count(),0,'late project-one conflict cannot publish its error in project two');
 await page.getByLabel('可恢复的文件草稿').getByText(projectDraftPath,{exact:false}).waitFor({timeout:15_000});
 assertVersions(ownerA,projectOne,'src/project-race.ts',[sources['src/project-race.ts'],raceRemote]);
 projectRace=null;

 // A pending owner-A save raises the browser's beforeunload guard. Accept it, switch the BFF identity, and reload through Jot.
 await projectSelect.selectOption(projectOne);
 await page.getByRole('button',{name:/src\/owner-pending\.ts/}).waitFor({timeout:15_000});
 await editAndReview('src/owner-pending.ts','const ownerPendingLocal = true;\n',1);
 const ownerGate={used:false,entered:deferred(),beforeSend:deferred()};ownerSaveGate=ownerGate;
 await applyReviewed(1);
 const ownerHeld=await ownerGate.entered.promise;
 assert.equal(ownerHeld.body.expected_version,1);
 let ownerDialogAccepted=false;
 page.once('dialog',async dialog=>{assert.equal(dialog.type(),'beforeunload');activeOwner=ownerB;ownerDialogAccepted=true;await dialog.accept();});
 const ownerBCapabilityResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/workbench-api/v1/capabilities',{timeout:15_000});
 await page.reload();
 assert.equal(ownerDialogAccepted,true,'switching owner while a save is pending requires explicit browser beforeunload acceptance');
 const ownerBScope=(await (await ownerBCapabilityResponse).allHeaders())['x-workbench-draft-scope'];
 assert.match(ownerBScope??'',/^[a-f0-9]{64}$/,'the BFF returns owner B capability draft scope');
 assert.notEqual(ownerBScope,ownerAScope,'capability scope changes across Gateway owners');
 ownerSaveGate=null;
 await page.getByRole('button',{name:'共享工作区'}).click();
 await page.getByRole('heading',{name:'共享工作区'}).waitFor({timeout:15_000});
 await page.getByRole('button',{name:'共同文件'}).click();
 await page.locator('select').nth(1).waitFor({timeout:15_000});
 await page.getByRole('button',{name:/src\/owner-b\.ts/}).waitFor({timeout:15_000});
 assert.equal(await page.getByRole('button',{name:/src\/owner-pending\.ts/}).count(),0,'owner B cannot see owner A files or drafts after capability scope changes');
 assert.equal(await page.getByRole('list',{name:'可恢复的文件草稿'}).count(),0,'owner A session drafts are not adopted by owner B');
 const ownerBRequests=currentWrites.filter(item=>item.owner===ownerB);
 assert.equal(ownerBRequests.length,0,'the aborted owner-A request never crosses into owner B');
 const ownerBFile=rowsFor(ownerB,projectB,'src/owner-b.ts').current;
 assert.equal(ownerBFile.sha256,digest(ownerBContent));assert.equal(ownerBFile.path,'src/owner-b.ts');

 console.log('LIVE_FILE_SAVE_UI_OK: real Chrome -> Jot BFF -> Gateway HTTP -> SQLite; v0 create, ordinary edit, explicit 409/load-latest, explicit rebase/reconfirm, and dropped-response same-key replay');
 console.log('LIVE_FILE_SCOPE_UI_OK: delayed real Gateway 409 cannot cross project scope; owner switch accepts beforeunload and isolates capability scope/files/drafts');
 console.log(JSON.stringify({gateway_file_writes:currentWrites.map(item=>({owner:item.owner,path:item.body.path,expected_version:item.body.expected_version,key:item.key})),verified_sqlite_rows:verifiedSqliteRows,verified_owner_b_row:rowsFor(ownerB,projectB,'src/owner-b.ts').current,versions:{create:[1],edit:[1,2],loadLatest:[1,2],rebase:[1,2,3],droppedReceipt:[1,2],projectRace:[1,2]},lost_response:{gateway_committed_status:dropped.status,retry_reused_key:true,retry_reused_body:true,version_rows:2},scope:{projectTwo:projectDraftPath,ownerB:ownerB,ownerB_project:projectB,ownerB_drafts:0}},null,2));
 await context.close();
}finally{
 if(browser)await browser.close().catch(()=>{});
 if(jot)await jot.close().catch(()=>{});
 if(gateway){await gateway.app.close().catch(()=>{});gateway.db.close();}
 rmSync(fixtureRoot,{recursive:true,force:true,maxRetries:5,retryDelay:20});
}
