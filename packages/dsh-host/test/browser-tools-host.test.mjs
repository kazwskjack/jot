import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createServer as createTcpServer} from 'node:net';
import {createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHostProfile} from '../create-profile.mjs';
import {createBrowserToolsPlugin} from '../browser-tools.mjs';
import {SessionControllerClient} from '../../gateway/src/harness/session-controller-client.ts';

const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
const edge=process.env.JOT_BROWSER_TEST_EXECUTABLE??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const listen=server=>new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolveListen('http://127.0.0.1:'+server.address().port));});
async function availablePort(){const server=createTcpServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));const port=server.address().port;await new Promise(done=>server.close(done));return port;}
function findSnapshot(value){
 if(typeof value==='string'){try{return findSnapshot(JSON.parse(value));}catch{return undefined;}}
 if(!value||typeof value!=='object')return undefined;
 if(typeof value.page_revision==='string'&&Array.isArray(value.candidates))return value;
 for(const child of Array.isArray(value)?value:Object.values(value)){const found=findSnapshot(child);if(found)return found;}
}
function sseTool(res,index,name,args){
 const events=[
  {type:'message_start',message:{id:'browser-host-'+index,type:'message',role:'assistant',content:[],model:'deepseek-flash',usage:{input_tokens:20,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'tool_use',id:'browser-call-'+index,name,input:{}}},
  {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(args)}},
  {type:'content_block_stop',index:0},
  {type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:1}},
  {type:'message_stop'},
 ];for(const event of events)res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();
}
function sseText(res,index,text){
 const events=[
  {type:'message_start',message:{id:'browser-host-'+index,type:'message',role:'assistant',content:[],model:'deepseek-flash',usage:{input_tokens:20,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
  {type:'content_block_delta',index:0,delta:{type:'text_delta',text}},
  {type:'content_block_stop',index:0},
  {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},
  {type:'message_stop'},
 ];for(const event of events)res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();
}
function safeStartup(value){return value.replace(/https?:\/\/[^\s"'<>]+/g,'[URL]').replace(/sk-[A-Za-z0-9_-]{16,}/g,'[API_KEY]').replace(/\b[a-f0-9]{32,}\b/g,'[TOKEN]').slice(-6000);}
async function readOperationEvents(path){
 const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare("SELECT type,data FROM events WHERE type LIKE 'browser.operation.%' ORDER BY seq").all().map(row=>({type:row.type,data:JSON.parse(row.data)}));}finally{db.close();}
}
test('real DSH host runs the browser tool through its registry and restores the owner profile after restart',{skip:!runtime||!existsSync(edge),timeout:90000},async t=>{
 const root=await mkdtemp(join(resolve('.test-tmp'),'jot-browser-host-')),home=join(root,'home'),workspace=join(root,'workspace');await mkdir(workspace,{recursive:true});
 const origin='https://browser-fixture.test',fixtureUrl=origin+'/',modelRequests=[],modelFailure=[];let model,host,childDone,childExit,output='',succeeded=false,approvalPath=join(root,'approval-receipts.jsonl');
 const apiKey='sk-'+randomBytes(32).toString('hex'),adapterToken=randomBytes(32).toString('hex');
 model=createServer(async(req,res)=>{try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());modelRequests.push(input);
  assert.match(req.url,/\/messages$/);assert.equal(req.headers['x-api-key'],apiKey);assert.ok(input.tools?.some(tool=>tool.name==='browser_action'),'original DSH registry must expose browser_action');
  const index=modelRequests.length;
  if(index===1||index===5)sseTool(res,index,'browser_action',{url:fixtureUrl,action:'read'});
  else if(index===2){const snapshot=findSnapshot(input.messages);assert.ok(snapshot,'the read result must return through the original DSH tool-result path');const target=snapshot.candidates.find(item=>item.role==='button'&&item.name==='Increment count');assert.ok(target,'the page snapshot must expose the unique fixture control');sseTool(res,index,'browser_action',{url:fixtureUrl,action:'click',candidate_id:target.candidate_id,page_revision:snapshot.page_revision});}
  else if(index===3)sseTool(res,index,'browser_action',{url:fixtureUrl,action:'screenshot'});
  else if(index===4||index===6){if(index===6){const snapshot=findSnapshot(input.messages);assert.match(snapshot?.text??'',/Persistent clicks 1/);}sseText(res,index,'BROWSER-HOST-CANARY-OK');}
  else throw Error('unexpected_model_round');
 }catch(error){modelFailure.push(error);if(!res.headersSent)res.writeHead(500,{'content-type':'text/plain'});res.end('synthetic_model_fixture_failed');}});
 const modelUrl=await listen(model);
 try{
  const profile=await createHostProfile({home,name:'jot-browser',browser:{origins:[origin],executablePath:edge}}),port=await availablePort(),patchPath=join(profile.directory,'cordis.patch.yml');
  const patch=JSON.parse((await readFile(patchPath,'utf8')).replace('!!js process.cwd()','null'));
  const rows=patch.find(row=>row.insert).insert,adapter=rows.find(row=>row.id==='jot-session-adapter');adapter.config.port=port;
  patch.push({id:'llm-deepseek',config:{baseURL:modelUrl,apiKeyEnv:'DEEPSEEK_API_KEY',reasoningEffort:'high'}});
  rows.unshift({id:'jot-browser-tools-acceptance',name:pathToFileURL(resolve('./test/browser-tools-acceptance-plugin.mjs')).href,config:{browser:{dataRoot:join(home,'browser-tools','jot-browser-acceptance'),profileRoot:join(home,'browser-profiles','jot-browser-acceptance'),ownerId:'jot-dsh-owner:jot-browser-acceptance',origins:[origin],executablePath:edge}}});
  await writeFile(patchPath,JSON.stringify(patch,null,2).replace('"workspaceRoot": null','"workspaceRoot": !!js process.cwd()')+'\n');
  const env={};for(const key of ['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATHEXT'])if(process.env[key])env[key]=process.env[key];
  const startHost=async()=>{childExit=undefined;host=spawn(process.execPath,[join(runtime,'dsh/lib/bin.js'),'--profile','jot-browser','--host','127.0.0.1','--port','0','--no-open'],{cwd:workspace,env:{...env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',JOT_SESSION_ADAPTER_TOKEN:adapterToken,DEEPSEEK_API_KEY:apiKey,JOT_BROWSER_TEST_EXECUTABLE:edge,JOT_BROWSER_TEST_ORIGIN:origin,JOT_BROWSER_TEST_APPROVAL_RECEIPT:approvalPath},stdio:['ignore','pipe','pipe'],windowsHide:true});
   childDone=new Promise(resolveDone=>host.once('exit',(code,signal)=>{childExit={code,signal};resolveDone();}));for(const stream of [host.stdout,host.stderr])stream.on('data',chunk=>{output+=chunk.toString();});
   const url='http://127.0.0.1:'+port,deadline=Date.now()+25000;let ready=false,lastProbe;
   while(Date.now()<deadline&&!childExit){try{const response=await fetch(url+'/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(500)});lastProbe={status:response.status};if(response.status===401){ready=true;break;}}catch(error){lastProbe={error:error?.cause?.code??error?.name??'request_failed'};}await new Promise(done=>setTimeout(done,100));}
   if(!ready)await writeFile(join(root,'host-startup-private.json'),JSON.stringify({pid:host.pid,port,exit:childExit,lastProbe,output:safeStartup(output)}));
   assert.equal(ready,true,'official Host adapter readiness deadline; exit='+JSON.stringify(childExit)+'; lastProbe='+JSON.stringify(lastProbe)+'; output='+safeStartup(output));
  };
  const stopHost=async()=>{if(host&&!childExit){host.kill('SIGTERM');await childDone;}host=undefined;};
  await startHost();const client=new SessionControllerClient('http://127.0.0.1:'+port,adapterToken);
  await client.create('browser-session-1',workspace,'jot-general');const first=await client.prompt('browser-session-1','browser-run-1','Read the isolated fixture, click Increment count once, and capture a screenshot.');assert.equal(first.accepted,true);
  const dbPath=join(home,'browser-tools','jot-browser','browser-operations.sqlite'),waitForOps=async count=>{const deadline=Date.now()+30000;while(Date.now()<deadline){if(modelFailure.length)throw modelFailure[0];try{const events=await readOperationEvents(dbPath),done=events.filter(row=>row.type==='browser.operation.succeeded');if(done.length>=count)return{events,done};}catch{}await new Promise(done=>setTimeout(done,50));}assert.fail('browser operation receipts timed out');};
  const completed=await waitForOps(3);assert.deepEqual(completed.done.map(item=>item.data.action),['read','click','screenshot']);assert.ok(completed.done[1].data.result.text.includes('Persistent clicks 1'));
  const screenshot=completed.done[2].data.result;assert.equal(screenshot.mime_type,'image/png');assert.equal(typeof screenshot.artifact_id,'string');assert.match(screenshot.sha256,/^[a-f0-9]{64}$/);
  assert.equal(modelRequests.length,4);assert.equal(modelFailure.length,0);await stopHost();
  const approvals=(await readFile(approvalPath,'utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line));assert.equal(approvals.length,3);assert.ok(approvals.some(row=>row.reason.includes('button Increment count')));assert.ok(approvals.some(row=>row.reason.includes('Save viewport PNG artifact')));
  await startHost();const resumedClient=new SessionControllerClient('http://127.0.0.1:'+port,adapterToken);await resumedClient.create('browser-session-2',workspace,'jot-general');await resumedClient.prompt('browser-session-2','browser-run-2','Read the same page after restarting the Host.');
  const afterRestart=await waitForOps(4);assert.equal(afterRestart.done[3].data.action,'read');assert.match(afterRestart.done[3].data.result.text,/Persistent clicks 1/);
  const modelDeadline=Date.now()+10000;while(modelRequests.length<6&&Date.now()<modelDeadline){if(modelFailure.length)throw modelFailure[0];await new Promise(done=>setTimeout(done,25));}assert.equal(modelRequests.length,6);assert.equal(modelFailure.length,0);
  await stopHost();
  const profileDirectories=afterRestart.events.filter(row=>row.type==='browser.operation.succeeded').length;assert.equal(profileDirectories,4);
  const database=await readOperationEvents(dbPath),receiptSummary=database.filter(row=>row.type==='browser.operation.succeeded').map(row=>({action:row.data.action,status:row.data.status,run_id:row.data.run_id}));
  t.diagnostic(JSON.stringify({officialDshHost:true,originalToolRegistry:true,modelRequests:modelRequests.length,approvedActions:approvals.length,operations:receiptSummary,screenshot:{mime_type:screenshot.mime_type,sha256:screenshot.sha256},ownerProfileRestored:true,production:false}));succeeded=true;
 }catch(error){await writeFile(join(root,'startup-private.log'),output);error.message+='; private DSH fixture retained in '+root;throw error;}
 finally{if(host&&!childExit){host.kill('SIGTERM');await childDone;}if(model){model.closeAllConnections();await new Promise(done=>model.close(done));}if(succeeded)await rm(root,{recursive:true,force:true});}
});

test('browser profile follows trusted Gateway owner across sessions and isolates Gateway owners',async t=>{
 const root=await mkdtemp(join(resolve('.test-tmp'),'jot-browser-profile-owner-')),runtimeRoot=join(root,'runtime'),moduleRoot=join(runtimeRoot,'node_modules','@deepseek-ai','dsh-tools');
 await mkdir(moduleRoot,{recursive:true});await writeFile(join(runtimeRoot,'package.json'),JSON.stringify({type:'module'}));
 await writeFile(join(moduleRoot,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-tools',type:'module',exports:'./index.mjs'}));
 await writeFile(join(moduleRoot,'index.mjs'),'export function defineTool(value){return value;}\n');
 const anchor=join(runtimeRoot,'package.json'),profileRoot=join(root,'profiles'),directories=[],cleanups=[];
 const context=()=>{const services=new Map([['profileContext',{installAnchor:anchor}]]),effects=[];return{services,effects,get(name){return services.get(name);},provide(name,value){services.set(name,value);},approval:{async request(){return'allowed-once';}},effect(callback){effects.push(callback());}};};
 const factory=async({userDataDir})=>{directories.push(userDataDir);let currentUrl='about:blank';const page={url:()=>currentUrl,async goto(url){currentUrl=url;},async evaluate(_fn,arg){if(arg!==undefined)return;return{url:currentUrl,title:'Fixture',text:'Fixture page',controls:[]};}};return{persistentContext:{async close(){},async route(){},pages:()=>[],async newPage(){return page;}}};};
 const runRead=async(ctx,sessionId,runId,ownerId)=>{const tools=new Map(),agent={id:sessionId,ctx:{tools:{register(tool){tools.set(tool.name,tool);return()=>tools.delete(tool.name);}}}},scope=Object.freeze({protocol:1,owner_id:ownerId,run_id:runId,session_ref:sessionId,execution_lease:Object.freeze({owner:'worker-1',generation:1}),assertCurrent:async()=>true}),scopeForAgent=candidate=>{assert.equal(candidate,agent);return scope;};
  const registrar=ctx.get('jotBrowserToolRegistrar'),dispose=registrar.mount({agent,scopeForAgent}),tool=tools.get('browser_action'),args={url:'https://fixture.example/',action:'read'},exec={agent,callId:`call-${runId}`,rootCallId:`root-${runId}`,signal:new AbortController().signal};
  const result=await tool.execute(args,exec);assert.equal(result.text,'Fixture page');return{registrar,agent,scopeForAgent,dispose,tool,args,exec};
 };
 const makePlugin=async ownerId=>{const ctx=context(),plugin=createBrowserToolsPlugin({browserFactory:factory});await plugin.apply(ctx,{dataRoot:join(root,'data',ownerId),profileRoot,ownerId,origins:['https://fixture.example']});cleanups.push(...ctx.effects);return ctx;};
 t.after(async()=>{for(const cleanup of cleanups.reverse())await cleanup?.();await rm(root,{recursive:true,force:true});});
 const configOwner='profile-label-not-gateway-identity',ctx=await makePlugin(configOwner),gatewayOwnerA='gateway-owner-a';
 const ownerAFirst=await runRead(ctx,'session-a1','run-a1',gatewayOwnerA),ownerASecond=await runRead(ctx,'session-a2','run-a2',gatewayOwnerA);
 const ownerAPath=join(profileRoot,createHash('sha256').update(gatewayOwnerA).digest('hex'));
 assert.equal(directories.length,1,'the Gateway owner reuses one profile across sessions');assert.equal(directories[0],ownerAPath);
 const profileBytes=join(ownerAPath,'synthetic-profile.bin');await writeFile(profileBytes,'preserve owner A profile');
 assert.deepEqual(await ownerAFirst.registrar.revokeProfile({agent:ownerAFirst.agent,scopeForAgent:ownerAFirst.scopeForAgent,expectedGeneration:1,signal:ownerAFirst.exec.signal}),{generation:2,status:'revoked'});
 await assert.rejects(ownerAFirst.tool.execute(ownerAFirst.args,ownerAFirst.exec),/browser_profile_revoked/);assert.equal(await readFile(profileBytes,'utf8'),'preserve owner A profile');
 ownerAFirst.dispose();ownerASecond.dispose();
 const gatewayOwnerB='gateway-owner-b',ownerB=await runRead(ctx,'session-b1','run-b1',gatewayOwnerB);ownerB.dispose();
 assert.equal(directories.length,2);assert.equal(directories[1],join(profileRoot,createHash('sha256').update(gatewayOwnerB).digest('hex')));assert.notEqual(directories[0],directories[1]);
});
