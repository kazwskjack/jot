import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {access,mkdir,readFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,join,resolve,sep} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import Fastify from 'fastify';

const gatewayRoot=process.env.JOT_GATEWAY_ROOT??fileURLToPath(new URL('../../packages/gateway/',import.meta.url));
const targetRoot=process.env.JOT_TARGET_ROOT??fileURLToPath(new URL('../../',import.meta.url));
const importGateway=path=>import(pathToFileURL(join(gatewayRoot,path)).href);
const [{fixture},{TaskCollaborationService},{TaskDelegationService},{NativeChildReservations},{NativeMemberOwnerControls},{registerNativeMemberRoutes},{openProductDatabase}]=await Promise.all([
 importGateway('test/workbench/task-wait-fixture.mjs'),importGateway('src/workbench/task-collaboration.ts'),importGateway('src/workbench/task-delegation.ts'),
 importGateway('src/workbench/native-child-reservations.ts'),importGateway('src/workbench/native-member-owner-controls.ts'),importGateway('src/workbench/native-member-routes.ts'),importGateway('src/db/database.ts')
]);
const clientSource=await build({entryPoints:[fileURLToPath(new URL('./client.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node'});
const client=await import('data:text/javascript;base64,'+Buffer.from(clientSource.outputFiles[0].contents).toString('base64'));

async function gatewayFixture(t){
 const previous=process.cwd();process.chdir(gatewayRoot);
 try{return await fixture(t);}finally{process.chdir(previous);}
}
async function nativeGatewayFixture(t){
 const f=await gatewayFixture(t),member=f.workbench.createAgent('alice',{name:'Native member',workspace_id:'ws',project_id:f.a.project_id});
 const team=f.workbench.createTeam('alice',{name:'Native team',workspace_id:'ws',project_id:f.a.project_id,member_ids:[f.a.agent_id,member.agent_id]});
 const collaboration=new TaskCollaborationService(f.db,f.workbench,f.persistentTasks,new TaskDelegationService(f.db,f.workbench,f.persistentTasks));
 collaboration.save('alice',f.task.task_id,{expected_version:0,enabled:true,team_id:team.team_id,member_ids:[member.agent_id],max_delegations:2,max_active:1});
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(f.runId);
 f.db.prepare('INSERT INTO ga_worker_leases VALUES(?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,expires_at=excluded.expires_at')
  .run(f.runId,'native-worker',1,String(Date.now()+60000),'now');
 const reservations=new NativeChildReservations(f.db,collaboration),spawnRequestHash='a'.repeat(64),executionLease={owner:'native-worker',generation:1};
 const identity={run_id:f.runId,session_ref:'session-fixture',request_id:'native-request',spawn_request_hash:spawnRequestHash,execution_lease:executionLease};
 const reservation=reservations.reserve({...identity,child_session_ref:'native-child',role_ref:member.agent_id,expected_policy_version:1});
 const child=f.workbench.prepareNativeChild('alice',reservation.reservation_id);
 reservations.publish({...identity,publication:{member:{id:child.session_ref,name:'Native member',role:'teammate',status:'inactive',diagnostics:[]}}});
 const adapterCalls=[],adapter={
  listNativeMembers:async sessionId=>{adapterCalls.push(['list',sessionId]);return {members:[{id:child.session_ref,name:'Native member',role:'teammate',status:'running'}],execution_authorized:false};},
  interruptNativeMember:async(sessionId,childSessionId,requestId)=>{adapterCalls.push(['interrupt',sessionId,childSessionId,requestId]);if(requestId==='stop-unknown')throw Error('simulated uncertain adapter result');return {request_id:requestId,status:'accepted',quiescent:false,execution_authorized:false};}
 };
 const controlApp=Fastify({logger:false});registerNativeMemberRoutes(controlApp,new NativeMemberOwnerControls(f.db),adapter);t.after(()=>controlApp.close());
 return {f,member,child,adapterCalls,controlApp};
}
function bridgeFetch(app,calls){
 return async(input,init={})=>{
  const target=new URL(String(input),'http://fixture.invalid'),path=target.pathname.replace(/^\/workbench-api/,'')+target.search;
  const headers=Object.fromEntries(new Headers(init.headers).entries());headers['x-user-id']='alice';headers.origin='https://fixture.invalid';
  calls.push({method:init.method??'GET',path,headers,body:init.body});
  const result=await app.inject({method:init.method??'GET',url:path,headers,payload:init.body});
  const responseHeaders={};for(const [name,value] of Object.entries(result.headers))if(typeof value==='string')responseHeaders[name]=value;
  return new Response(result.body,{status:result.statusCode,headers:responseHeaders});
 };
}
function targetJotFallback(root,candidateRoot){
 const extensions=['','.tsx','.ts','.jsx','.js','.mjs'];
 return {name:'target-jot-fallback',setup(buildApi){buildApi.onResolve({filter:/^\.\//},args=>{
  if(args.path==='./client'&&args.importer===join(candidateRoot,'web/jot/RoleConversation.tsx'))return {path:join(candidateRoot,'web/jot/client.ts')};
  const fallback=join(root,'web/jot',args.path.slice(2));for(const extension of extensions)if(existsSync(fallback+extension))return {path:fallback+extension};
  const local=join(dirname(args.importer),args.path);if(extensions.some(extension=>existsSync(local+extension)))return null;
  return null;
 });}};
}

test.skip('browser UI: native member actions recover the same key and fail closed when storage cannot persist it', {timeout:120000,skip:'R6 sandbox cannot start Playwright Edge or connect its browser to the local synthetic server; browser product evidence remains open'}, async()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url)),scratch=join(root,'test-tmp');await mkdir(scratch,{recursive:true});
 const profile=await import('node:fs/promises').then(fs=>fs.mkdtemp(join(scratch,'native-member-controls-'))),previous={TEMP:process.env.TEMP,TMP:process.env.TMP};
 process.env.TEMP=profile;process.env.TMP=profile;
 const conversationId='role-chat-fixture',runId='parent-run-fixture',csrf='native-members-csrf';
 const state={members:[{child_session_ref:'child-session-a',name:'Writer member',role:'teammate',status:'running'},{child_session_ref:'child-session-b',name:'Reviewer member',role:'teammate',status:'running'}],wakeReceipts:new Map(),interruptReceipts:new Map(),interrupts:[],messages:[],receiptReads:[],requests:[],faults:[],streams:new Set()};
 const bundle=await build({stdin:{contents:'import React from "react";import {createRoot} from "react-dom/client";import RoleConversation from "./web/jot/RoleConversation.tsx";createRoot(document.getElementById("root")).render(<RoleConversation id="role-chat-fixture" ordinary={false} onClose={()=>{}}/>);',resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic'});
 const json=(response,value,status=200)=>{response.writeHead(status,{'content-type':'application/json','x-csrf-token':csrf,'x-workbench-draft-scope':'a'.repeat(64)});response.end(JSON.stringify(value));};
 const body=async request=>{const chunks=[];for await(const chunk of request)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString('utf8'));};
 const server=createServer(async(request,response)=>{try{
  const url=new URL(request.url,'http://localhost'),path=url.pathname.replace(/^\/workbench-api\/v1/,'');
  if(url.pathname==='/'){response.writeHead(200,{'content-type':'text/html'});response.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/bundle.js"></script>');return;}
  if(url.pathname==='/bundle.js'){response.writeHead(200,{'content-type':'application/javascript'});response.end(bundle.outputFiles[0].contents);return;}
  if(url.pathname==='/favicon.ico'){response.writeHead(204);response.end();return;}
  if(path==='/capabilities')return json(response,{api_version:'1',event_schema_version:'1',adapter_version:'synthetic',capabilities:{search:false,fetch:false,browser_interaction:false,file_read:false,file_edit:false,command_execution:false,questions:false,approvals:false,artifact_download:false,resume_checkpoint:false},workbench:{enabled:true,agent_roles:true},limits:{max_upload_bytes:1000000},voice:{enabled:false,status:'disabled',max_bytes:0,max_duration_ms:0,accepted_mime_types:[],languages:[]},models:[]});
  if(path==='/conversations/'+conversationId+'/snapshot')return json(response,{conversation:{conversation_id:conversationId,title:'Synthetic role',workspace_id:'ws',model:{provider:'fixture',model:'synthetic'},mode:'work'},as_of_seq:'0',messages:[],runs:[{run_id:runId,conversation_id:conversationId,input_message_id:'source-message',status:'running',version:7,created_at:'2026-10-26T03:40:00.000Z',updated_at:'2026-10-26T03:40:00.000Z'}],activities:[],sources:[],interactions:[],artifacts:[],stream_cursors:[],history_complete:true});
  if(path==='/conversations/'+conversationId+'/events'){response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});response.write(': synthetic stream\n\n');state.streams.add(response);response.on('close',()=>state.streams.delete(response));return;}
  if(request.method==='GET'&&path==='/runs/'+runId+'/native-members')return json(response,{members:state.members,execution_authorized:false});
  const interruptRead=path.match(/^\/runs\/([^/]+)\/native-members\/([^/]+)\/interrupts\/([^/]+)$/);
  if(request.method==='GET'&&interruptRead){const requestId=decodeURIComponent(interruptRead[3]);state.receiptReads.push({operation:'interrupt',child_session_ref:decodeURIComponent(interruptRead[2]),request_id:requestId});return json(response,{request_id:requestId,status:state.interruptReceipts.get(requestId)??'unknown',quiescent:false,execution_authorized:false});}
  const wakeRead=path.match(/^\/runs\/([^/]+)\/native-members\/([^/]+)\/messages\/([^/]+)$/);
  if(request.method==='GET'&&wakeRead){const requestId=decodeURIComponent(wakeRead[3]);state.receiptReads.push({operation:'wake',child_session_ref:decodeURIComponent(wakeRead[2]),request_id:requestId});return json(response,{request_id:requestId,status:state.wakeReceipts.get(requestId)??'pending'});}
  const interrupt=path.match(/^\/runs\/([^/]+)\/native-members\/([^/]+)\/interrupt$/);
  if(request.method==='POST'&&interrupt){const value=await body(request);state.interrupts.push({path,body:value,key:request.headers['idempotency-key']});state.interruptReceipts.set(value.request_id,'unknown');if(decodeURIComponent(interrupt[2])==='child-session-a'){response.destroy();return;}return json(response,{request_id:value.request_id,status:'unknown',quiescent:false,execution_authorized:false});}
  const message=path.match(/^\/runs\/([^/]+)\/native-members\/([^/]+)\/messages$/);
  if(request.method==='POST'&&message){const value=await body(request);state.messages.push({path,body:value,key:request.headers['idempotency-key']});state.wakeReceipts.set(value.request_id,'pending');return json(response,{accepted:true,command_id:'command-'+value.request_id,run_id:runId,request_id:value.request_id},202);}
  if(path.includes('/goal')||path.endsWith('/cancel'))state.requests.push({method:request.method,path});
  state.faults.push('unexpected '+request.method+' '+path);return json(response,{error:{code:'unexpected_fixture_request',message:'unexpected fixture request'}},500);
 }catch(error){state.faults.push(error instanceof Error?error.message:String(error));if(!response.headersSent)response.writeHead(500);response.end('fixture failure');}});
 let browser,context,page;
 try{
  await new Promise(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));const origin='http://127.0.0.1:'+server.address().port,browserOptions={headless:true,env:{...process.env}};
  if(process.platform==='win32'){browserOptions.executablePath='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';await access(browserOptions.executablePath);}
  browser=await chromium.launch(browserOptions);context=await browser.newContext();await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());page=await context.newPage();await page.goto(origin);
  const panel=page.getByRole('region',{name:'原生协作成员'}),selected=panel.getByLabel('成员');await panel.getByRole('heading',{name:'原生协作成员'}).waitFor({timeout:5000});
  await panel.getByText('Writer member').waitFor();await selected.selectOption('child-session-a');await panel.getByRole('button',{name:'中断选中成员'}).click();await panel.getByText(/中断结果未知或未确认/).waitFor();
  assert.equal(state.interrupts.length,1);assert.equal(state.interrupts[0].path,'/runs/'+runId+'/native-members/child-session-a/interrupt');
  assert.deepEqual(state.interrupts[0].body,{request_id:state.interrupts[0].body.request_id,expected_run_version:7});assert.equal(state.interrupts[0].key,state.interrupts[0].body.request_id);
  await panel.getByRole('button',{name:'检查原中断回执'}).click();await panel.getByText(/中断结果未知或未确认/).waitFor();assert.equal(state.interrupts.length,1);
  assert.equal(await selected.isDisabled(),false);await selected.selectOption('child-session-b');assert.equal(await panel.getByRole('button',{name:'中断选中成员'}).isDisabled(),false);
  await panel.getByRole('button',{name:'中断选中成员'}).click();await panel.getByRole('status').filter({hasText:'Reviewer member'}).getByText(/中断结果未知或未确认/).waitFor();
  assert.equal(state.interrupts.length,2);assert.equal(state.interrupts[1].path,'/runs/'+runId+'/native-members/child-session-b/interrupt');
  await selected.selectOption('child-session-a');assert.equal(await panel.getByRole('button',{name:'中断选中成员'}).isDisabled(),true);
  const interruptedIds=state.interrupts.map(value=>value.body.request_id),readsBeforeReload=state.receiptReads.length;
  await page.reload();await panel.getByRole('heading',{name:'原生协作成员'}).waitFor();
  await panel.getByRole('status').filter({hasText:'Writer member'}).getByText(/中断结果未知或未确认/).waitFor();await panel.getByRole('status').filter({hasText:'Reviewer member'}).getByText(/中断结果未知或未确认/).waitFor();
  assert.equal(await panel.getByRole('status').filter({hasText:'Writer member'}).count(),1);assert.equal(await panel.getByRole('status').filter({hasText:'Reviewer member'}).count(),1);
  assert.equal(state.interrupts.length,2);assert.equal(await selected.isDisabled(),false);
  assert.deepEqual(state.receiptReads.slice(readsBeforeReload).filter(value=>value.operation==='interrupt').map(value=>value.request_id).sort(),interruptedIds.sort());
  state.members[0]={...state.members[0],status:'inactive'};await panel.getByRole('status').filter({hasText:'Writer member'}).getByRole('button',{name:'检查成员状态'}).click();await panel.getByRole('status').filter({hasText:'Writer member'}).getByText(/成员当前空闲/).waitFor();
  assert.equal(state.interrupts.length,2);assert.deepEqual(Object.keys(JSON.parse(await page.evaluate(()=>localStorage.getItem('jot.native-member-actions.v1'))).actions[runId]),['child-session-b']);
  await panel.getByRole('button',{name:'刷新成员列表'}).click();await panel.getByText(/inactive|空闲/).waitFor();
  const continuation=panel.getByLabel('给原成员的继续内容'),continueButton=panel.getByRole('button',{name:'明确继续此成员'});await continuation.fill('   ');assert.equal(await continueButton.isDisabled(),true);
  const explicitText='继续原步骤：核对来源版本';await continuation.fill(explicitText);await continueButton.click();await panel.getByText(/继续内容已排队/).waitFor();
  assert.equal(state.messages.length,1);assert.equal(state.messages[0].path,'/runs/'+runId+'/native-members/child-session-a/messages');assert.equal(state.messages[0].body.text,explicitText);
  assert.equal(state.messages[0].body.expected_run_version,7);assert.equal(state.messages[0].key,state.messages[0].body.request_id);
  const writerStatus=panel.getByRole('status').filter({hasText:'Writer member'});await writerStatus.getByRole('button',{name:'检查原请求状态'}).click();await writerStatus.getByText(/尚未确认/).waitFor();state.wakeReceipts.set(state.messages[0].body.request_id,'unknown');
  await writerStatus.getByRole('button',{name:'检查原请求状态'}).click();await writerStatus.getByText(/未知或未确认/).waitFor();assert.equal(state.messages.length,1);
  const readsBeforeWakeReload=state.receiptReads.length;
  await page.reload();await panel.getByRole('heading',{name:'原生协作成员'}).waitFor();
  await panel.getByRole('status').filter({hasText:'Writer member'}).getByText(/未知或未确认/).waitFor();await panel.getByRole('status').filter({hasText:'Reviewer member'}).getByText(/未知或未确认/).waitFor();
  assert.equal(state.messages.length,1);assert.equal(state.interrupts.length,2);
  assert.deepEqual(state.receiptReads.slice(readsBeforeWakeReload).map(value=>value.request_id).sort(),[state.messages[0].body.request_id,state.interrupts[1].body.request_id].sort());
  await page.evaluate(()=>localStorage.removeItem('jot.native-member-actions.v1'));
  await page.addInitScript(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='jot.native-member-actions.v1')throw new DOMException('quota exceeded','QuotaExceededError');return original.call(this,key,value);};});
  await page.reload();await panel.getByRole('heading',{name:'原生协作成员'}).waitFor();
  await panel.getByLabel('给原成员的继续内容').fill('继续核对来源版本');await panel.getByRole('button',{name:'明确继续此成员'}).click();
  await panel.getByRole('alert').getByText('native_member_action_storage_unavailable').waitFor();assert.equal(state.messages.length,1);
  assert.deepEqual(state.requests,[]);assert.deepEqual(state.faults,[]);
 }catch(error){console.error(JSON.stringify({diagnostic:await page?.locator('body').innerText().catch(()=>''),interrupts:state.interrupts,messages:state.messages,requests:state.requests,faults:state.faults}));throw error;
 }finally{
  await context?.close();await browser?.close();for(const stream of state.streams)stream.end();server.closeAllConnections();await new Promise(resolveClose=>server.close(resolveClose));
  for(const key of ['TEMP','TMP'])if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
  assert.ok(profile.startsWith(resolve(scratch)+sep));await rm(profile,{recursive:true,force:true});
 }
});

test('pending native-member action journal isolates child keys and restores legacy and concurrent receipts',async()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),values=new Map(),storage={
  getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)
 };
 const previousNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 let lockQueue=Promise.resolve();const locks={request(_name,_options,callback){const next=lockQueue.then(callback);lockQueue=next.catch(()=>{});return next;}};
 const originalFetch=globalThis.fetch;let sends=0;const dispatched=[];
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:storage});
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks}});
 globalThis.fetch=async()=>{sends++;throw new Error('network should not be reached');};
 try{
  const first={run_id:'parent-run',child_session_ref:'child-a',request_id:'wake-key-1',operation:'wake',state:'submitting'};
  await client.writeNativeMemberPendingAction(first);
  await client.writeNativeMemberPendingAction({...first,state:'unknown'});
  const childB={...first,child_session_ref:'child-b',request_id:'interrupt-key-b',operation:'interrupt'};
  await client.dispatchNativeMemberAction(childB,async()=>{dispatched.push(childB.request_id);return 'sent';});
  assert.deepEqual(dispatched,['interrupt-key-b']);
  assert.deepEqual(client.readNativeMemberPendingActions('parent-run'),[{...first,state:'unknown'},childB]);
  await assert.rejects(client.writeNativeMemberPendingAction({...first,request_id:'wake-key-2'}),/native_member_action_pending/);
  assert.equal(client.readNativeMemberPendingActions('parent-run')[0].request_id,'wake-key-1');
  assert.doesNotMatch([...values.values()].join(' '),/private continuation text/);
  await client.clearNativeMemberPendingAction('parent-run','child-b','interrupt-key-b');
  assert.deepEqual(client.readNativeMemberPendingActions('parent-run'),[{...first,state:'unknown'}]);
  await client.clearNativeMemberPendingAction('parent-run','child-a','wake-key-1');
  assert.deepEqual(client.readNativeMemberPendingActions('parent-run'),[]);
  values.set('jot.native-member-actions.v1',JSON.stringify({version:1,actions:{'parent-run':{...first,state:'unknown'}}}));
  assert.deepEqual(client.readNativeMemberPendingActions('parent-run'),[{...first,state:'unknown'}]);
  await client.clearNativeMemberPendingAction('parent-run','child-a','wake-key-1');
  const otherRun={...first,run_id:'parent-run-b',child_session_ref:'child-b',request_id:'wake-key-b'};
  await Promise.all([client.writeNativeMemberPendingAction({...first,request_id:'wake-key-a'}),client.writeNativeMemberPendingAction(otherRun)]);
  assert.deepEqual(client.readNativeMemberPendingActions('parent-run').map(action=>action.request_id),['wake-key-a']);
  assert.deepEqual(client.readNativeMemberPendingActions('parent-run-b').map(action=>action.request_id),['wake-key-b']);
  await Promise.all([client.clearNativeMemberPendingAction('parent-run','child-a','wake-key-a'),client.clearNativeMemberPendingAction('parent-run-b','child-b','wake-key-b')]);
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
  await assert.rejects(client.dispatchNativeMemberAction(first,async()=>{sends++;return 'sent';}),/native_member_action_lock_unavailable/);
  assert.equal(sends,0);
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks}});
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>null,setItem:()=>{throw new Error('quota exceeded');},removeItem(){}}});
  await assert.rejects(client.dispatchNativeMemberAction(first,()=>client.continueNativeMember('parent-run','child-a',1,'wake-key-1','private continuation text')),/native_member_action_storage_unavailable/);
  assert.equal(sends,0);
 }finally{globalThis.fetch=originalFetch;if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete globalThis.localStorage;if(previousNavigator)Object.defineProperty(globalThis,'navigator',previousNavigator);else delete globalThis.navigator;}
});

test('real Gateway routes dedupe same keys and serialize competing same-run journal claims',async t=>{
 const {f,child,adapterCalls,controlApp}=await nativeGatewayFixture(t),calls=[],originalFetch=globalThis.fetch,previousStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),previousNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator'),storageValues=new Map(),lockNames=[];let lockQueue=Promise.resolve();
 const locks={request(name,options,callback){lockNames.push([name,options.mode]);const next=lockQueue.then(callback);lockQueue=next.catch(()=>{});return next;}},storage={getItem:key=>storageValues.get(key)??null,setItem:(key,value)=>storageValues.set(key,String(value)),removeItem:key=>storageValues.delete(key)};
 globalThis.fetch=bridgeFetch(controlApp,calls);
 try{
  const roster=await client.listNativeMembers(f.runId);
  assert.deepEqual(roster,{members:[{child_session_ref:child.session_ref,name:'Native member',role:'teammate',status:'running'}],execution_authorized:false});
  assert.equal(calls[0].path,`/v1/runs/${encodeURIComponent(f.runId)}/native-members`);
  const version=f.runs.get(f.runId,'alice').version;
  await assert.rejects(client.interruptNativeMember(f.runId,'unknown-child',version,'wrong-child'),error=>error.status===404);
  await assert.rejects(client.interruptNativeMember(f.runId,child.session_ref,version+1,'stale-version'),error=>error.status===409);
  const interrupt=await client.interruptNativeMember(f.runId,child.session_ref,version,'stop-once');
  assert.deepEqual(interrupt,{request_id:'stop-once',status:'accepted',quiescent:false,execution_authorized:false});
  const unknownInterrupt=await client.interruptNativeMember(f.runId,child.session_ref,version,'stop-unknown');
  assert.deepEqual(unknownInterrupt,{request_id:'stop-unknown',status:'unknown',quiescent:false,execution_authorized:false});
  const interruptReceipt=await client.readNativeMemberInterruptReceipt(f.runId,child.session_ref,'stop-unknown');
  assert.deepEqual(interruptReceipt,unknownInterrupt);
  await assert.rejects(client.readNativeMemberInterruptReceipt(f.runId,'unknown-child','stop-unknown'),error=>error.status===404);
  assert.deepEqual(await client.interruptNativeMember(f.runId,child.session_ref,version,'stop-unknown'),unknownInterrupt);
  assert.deepEqual(adapterCalls.filter(call=>call[0]==='interrupt'),[
   ['interrupt','session-fixture',child.session_ref,'stop-once'],['interrupt','session-fixture',child.session_ref,'stop-unknown']
  ]);
  const interruptReads=calls.filter(call=>call.method==='GET'&&call.path===`/v1/runs/${encodeURIComponent(f.runId)}/native-members/${encodeURIComponent(child.session_ref)}/interrupts/stop-unknown`);
  assert.equal(interruptReads.length,1);
  assert.equal(calls.filter(call=>call.method==='GET'&&call.path.includes('native-member-controls')).length,0);
  assert.equal(calls.filter(call=>call.method==='POST'&&call.path.endsWith('/interrupt')).length,5);
  const text='Continue the same assigned member task.';
  const wake=await client.continueNativeMember(f.runId,child.session_ref,version,'wake-once',text);
  assert.equal(wake.request_id,'wake-once');assert.equal(wake.accepted,true);
  const pending=await client.readNativeMemberWakeReceipt(f.runId,child.session_ref,'wake-once');
  assert.deepEqual(pending,{request_id:'wake-once',status:'pending'});
  const command=f.db.prepare('SELECT id FROM ga_run_commands WHERE run_id=? AND idempotency_key=?').get(f.runId,'native-member:wake-once');
  assert.ok(command?.id);
  f.db.prepare("UPDATE ga_run_commands SET status='applied' WHERE run_id=? AND idempotency_key=?").run(f.runId,'native-member:wake-once');
  const unknown=await client.readNativeMemberWakeReceipt(f.runId,child.session_ref,'wake-once');
  assert.deepEqual(unknown,{request_id:'wake-once',status:'unknown'});
  const wakeCalls=calls.filter(call=>call.method==='POST'&&call.path.endsWith('/messages'));
  assert.equal(wakeCalls.length,1);assert.equal(wakeCalls[0].path,`/v1/runs/${encodeURIComponent(f.runId)}/native-members/${encodeURIComponent(child.session_ref)}/messages`);
  assert.deepEqual(JSON.parse(wakeCalls[0].body),{request_id:'wake-once',expected_run_version:version,text});
  const receiptReads=calls.filter(call=>call.method==='GET'&&call.path.includes('/messages/'));
  assert.equal(receiptReads.length,2);assert.ok(receiptReads.every(call=>call.path===`/v1/runs/${encodeURIComponent(f.runId)}/native-members/${encodeURIComponent(child.session_ref)}/messages/wake-once`));
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:storage});Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks}});
  const competingKeys=['wake-race-a','wake-race-b'],racePostsBefore=calls.filter(call=>call.method==='POST'&&call.path.endsWith('/messages')).length;
  const competing=await Promise.allSettled(competingKeys.map(request_id=>client.dispatchNativeMemberAction({run_id:f.runId,child_session_ref:child.session_ref,request_id,operation:'wake',state:'submitting'},()=>client.continueNativeMember(f.runId,child.session_ref,version,request_id,'Concurrent continuation'))));
  assert.equal(competing.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(competing.filter(result=>result.status==='rejected'&&/native_member_action_pending/.test(String(result.reason))).length,1);
  const racePosts=calls.filter(call=>call.method==='POST'&&call.path.endsWith('/messages')).slice(racePostsBefore);
  assert.equal(racePosts.length,1);assert.equal(JSON.parse(racePosts[0].body).request_id,'wake-race-a');
  assert.deepEqual(lockNames,[['jot.native-member-actions','exclusive'],['jot.native-member-actions','exclusive']]);
  assert.equal(client.readNativeMemberPendingActions(f.runId)[0].request_id,'wake-race-a');
  const raceCommands=f.db.prepare('SELECT idempotency_key FROM ga_run_commands WHERE run_id=? AND idempotency_key IN (?,?)').all(f.runId,'native-member:wake-race-a','native-member:wake-race-b');
  assert.equal(raceCommands.length,1);assert.equal(raceCommands[0].idempotency_key,'native-member:wake-race-a');await client.clearNativeMemberPendingAction(f.runId,child.session_ref,'wake-race-a');
  const hidden=await controlApp.inject({url:`/v1/runs/${f.runId}/native-members/${child.session_ref}/messages/wake-once`,headers:{'x-user-id':'mallory'}});
  assert.equal(hidden.statusCode,404);
  await f.app.close();const originalDb=f.db;f.db.close();f.db=openProductDatabase(f.fixtureConfig.databasePath);f.app=Fastify({logger:false});
  const recoveredApp=Fastify({logger:false});registerNativeMemberRoutes(recoveredApp,new NativeMemberOwnerControls(f.db));t.after(()=>recoveredApp.close());globalThis.fetch=bridgeFetch(recoveredApp,calls);
  assert.deepEqual(await client.interruptNativeMember(f.runId,child.session_ref,version,'stop-unknown'),unknownInterrupt);
  assert.deepEqual(await client.readNativeMemberInterruptReceipt(f.runId,child.session_ref,'stop-unknown'),unknownInterrupt);
  assert.deepEqual(await client.continueNativeMember(f.runId,child.session_ref,version,'wake-once',text),wake);
  assert.deepEqual(await client.readNativeMemberWakeReceipt(f.runId,child.session_ref,'wake-once'),unknown);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_run_commands WHERE run_id=? AND idempotency_key=?').get(f.runId,'native-member:wake-once').n,1);
  assert.equal(adapterCalls.filter(call=>call[0]==='interrupt'&&call[3]==='stop-unknown').length,1);
 }finally{globalThis.fetch=originalFetch;if(previousStorage)Object.defineProperty(globalThis,'localStorage',previousStorage);else delete globalThis.localStorage;if(previousNavigator)Object.defineProperty(globalThis,'navigator',previousNavigator);else delete globalThis.navigator;}
});

test('workbench client bundle retains its requestBytes dependency',async()=>{
 const candidateRoot=fileURLToPath(new URL('../../',import.meta.url)),workbenchPath=join(targetRoot,'web/workbench/client.ts');
 const [workbenchSource,clientSource]=await Promise.all([readFile(workbenchPath,'utf8'),readFile(join(candidateRoot,'web/jot/client.ts'),'utf8')]);
 assert.match(workbenchSource,/import\s*\{\s*request\s*,\s*requestBytes\s*\}\s*from\s*['"]\.\.\/jot\/client['"]/);
 assert.match(clientSource,/export async function requestBytes\(/);
 const result=await build({entryPoints:[workbenchPath],bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'candidate-jot-client',setup(buildApi){buildApi.onResolve({filter:/^\.\.\/jot\/client$/},()=>({path:join(candidateRoot,'web/jot/client.ts')}));}}]});
 assert.ok(result.outputFiles[0].contents.byteLength>0);
});

test('RoleConversation with native member controls bundles without browser execution',async()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url));
 const result=await build({entryPoints:[join(root,'web/jot/RoleConversation.tsx')],bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',plugins:[targetJotFallback(targetRoot,root)]});
 assert.ok(result.outputFiles[0].contents.byteLength>0);
});

test('Jot Workbench mounts original-member controls without changing the parent Goal, budget or authority',async()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url));
 const [entry,html,role]=await Promise.all([
  readFile(join(root,'web/workbench-entry.tsx'),'utf8'),readFile(join(root,'web/workbench.html'),'utf8'),readFile(join(root,'web/jot/RoleConversation.tsx'),'utf8')
 ]);
 assert.match(html,/<title>Jot · 工作台<\/title>/);
 assert.match(html,/src="\/workbench-entry\.tsx"/);
 assert.match(entry,/import RoleConversation from '\.\/jot\/RoleConversation'/);
 assert.match(entry,/<RoleConversation ordinary=/);
 const start=role.indexOf('function NativeMemberControls'),end=role.indexOf('function ConversationContent',start);
 assert.ok(start>=0&&end>start);
 const controls=role.slice(start,end);
  assert.ok(role.includes('<NativeMemberControls key={`native-member-controls:${run.run_id}`} run={run}/>'));
  assert.ok(role.includes('<RunDiagnostics key={diagnosticRun.run_id} run={diagnosticRun}/>'));
 assert.match(controls,/aria-label="原生协作成员"/);
 assert.match(controls,/以下操作只作用于所选原成员，不更改父目标、授权或预算/);
 assert.match(controls,/中断选中成员/);
 assert.match(controls,/明确继续此成员/);
 assert.match(controls,/interruptNativeMember\(run\.run_id,member\.child_session_ref,run\.version/);
 assert.match(controls,/continueNativeMember\(run\.run_id,member\.child_session_ref,run\.version/);
 assert.match(controls,/readNativeMemberInterruptReceipt\(action\.runId,action\.member\.child_session_ref,action\.requestId/);
 assert.match(controls,/isNativeMemberObservedStopped\(value,action\.member\.child_session_ref\)/);
 assert.match(controls,/检查原中断回执/);
 assert.match(controls,/sameMemberLocked/);
});

test('unknown interrupt resolves only when the same member is observed inactive',()=>{
 const roster={execution_authorized:false,members:[
  {child_session_ref:'child-a',name:'Writer',role:'teammate',status:'running'},
  {child_session_ref:'child-b',name:'Reviewer',role:'teammate',status:'inactive'}
 ]};
 assert.equal(client.isNativeMemberObservedStopped(roster,'child-a'),false);
 assert.equal(client.isNativeMemberObservedStopped(roster,'missing-child'),false);
 assert.equal(client.isNativeMemberObservedStopped({...roster,members:[{...roster.members[0],status:'inactive'}]},'child-a'),true);
});
