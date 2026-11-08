import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {access,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve,sep} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('../../',import.meta.url));
const runId='parent-run-browser-fixture',conversationId='role-chat-browser-fixture',csrf='native-members-browser-csrf';
const catalogSha256='9e290a7a61544feb5d6a2ebd3e70fffc521dbddb9c354434df8590af183652ff';

test('browser renders one native-member control section and does not redispatch an unknown interrupt', {timeout:120000}, async()=>{
 const scratch=join(root,'test-tmp');await mkdir(scratch,{recursive:true});
 const profile=await mkdtemp(join(scratch,'native-member-render-')),
  previous={TEMP:process.env.TEMP,TMP:process.env.TMP};
 process.env.TEMP=profile;process.env.TMP=profile;
 const state={members:[{child_session_ref:'child-session-a',name:'Writer member',role:'teammate',status:'running'}],
  interrupts:[],receiptReads:[],businessEffects:new Map(),streams:new Set(),faults:[]};
 const bundle=await build({stdin:{contents:'import React from "react";import {createRoot} from "react-dom/client";import RoleConversation from "./web/jot/RoleConversation.tsx";createRoot(document.getElementById("root")).render(<RoleConversation id="role-chat-browser-fixture" ordinary={false} onClose={()=>{}}/>);',
  resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic'});
 const json=(response,value,status=200)=>{response.writeHead(status,{'content-type':'application/json','x-csrf-token':csrf,'x-workbench-draft-scope':'a'.repeat(64)});response.end(JSON.stringify(value));};
 const body=async request=>{const chunks=[];for await(const chunk of request)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString('utf8'));};
 const server=createServer(async(request,response)=>{try{
  const url=new URL(request.url,'http://localhost'),path=url.pathname.replace(/^\/workbench-api\/v1/,'' );
  if(url.pathname==='/'){response.writeHead(200,{'content-type':'text/html'});response.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/bundle.js"></script>');return;}
  if(url.pathname==='/bundle.js'){response.writeHead(200,{'content-type':'application/javascript'});response.end(bundle.outputFiles[0].contents);return;}
  if(url.pathname==='/favicon.ico'){response.writeHead(204);response.end();return;}
  if(path==='/capabilities')return json(response,{api_version:'1',event_schema_version:'1',adapter_version:'synthetic',
   capabilities:{search:false,fetch:false,browser_interaction:false,file_read:false,file_edit:false,command_execution:false,questions:false,approvals:false,artifact_download:false,resume_checkpoint:false},
   workbench:{enabled:true,agent_roles:true},limits:{max_upload_bytes:1000000},
   voice:{enabled:false,status:'disabled',max_bytes:0,max_duration_ms:0,accepted_mime_types:[],languages:[]},models:[]});
  if(path==='/conversations/'+conversationId+'/snapshot')return json(response,{conversation:{conversation_id:conversationId,title:'Synthetic role',workspace_id:'ws',model:{provider:'fixture',model:'synthetic'},mode:'work'},
   as_of_seq:'0',messages:[],runs:[{run_id:runId,conversation_id:conversationId,input_message_id:'source-message',status:'running',version:7,created_at:'2026-10-26T03:40:00.000Z',updated_at:'2026-10-26T03:40:00.000Z'}],
   activities:[],sources:[],interactions:[],artifacts:[],stream_cursors:[],history_complete:true});
  if(path==='/conversations/'+conversationId+'/events'){response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});response.write(': synthetic stream\n\n');state.streams.add(response);response.on('close',()=>state.streams.delete(response));return;}
  if(request.method==='GET'&&path==='/runs/'+runId+'/native-members')return json(response,{members:state.members,execution_authorized:false});
  if(request.method==='GET'&&path==='/runs/'+runId+'/skills')return json(response,{protocol:1,complete:true,items:[],catalogSha256,execution_authorized:false,
   viewScope:{conversation_id:conversationId,workspace_id:'ws',project_id:'project-fixture',agent_id:'agent-fixture',run_id:runId,capability_epoch:1}});
  const receipt=path.match(/^\/runs\/([^/]+)\/native-members\/([^/]+)\/interrupts\/([^/]+)$/);
  if(request.method==='GET'&&receipt){const requestId=decodeURIComponent(receipt[3]);state.receiptReads.push(requestId);
   return json(response,{request_id:requestId,status:'unknown',quiescent:false,execution_authorized:false});}
  const interrupt=path.match(/^\/runs\/([^/]+)\/native-members\/([^/]+)\/interrupt$/);
  if(request.method==='POST'&&interrupt){const value=await body(request),requestId=value.request_id;
   state.interrupts.push({path,body:value,key:request.headers['idempotency-key']});
   if(!state.businessEffects.has(requestId))state.businessEffects.set(requestId,1);
   response.writeHead(202,{'content-type':'application/json','x-csrf-token':csrf,'x-workbench-draft-scope':'a'.repeat(64)});
   response.write('{"request_id":');response.destroy();return;}
  state.faults.push('unexpected '+request.method+' '+path);return json(response,{error:{code:'unexpected_fixture_request'}} ,500);
 }catch(error){state.faults.push(error instanceof Error?error.message:String(error));if(!response.headersSent)response.writeHead(500);response.end('fixture failure');}});
 let browser,context,page;
 try{
  await new Promise(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));
  const origin='http://127.0.0.1:'+server.address().port,browserOptions={headless:true,env:{...process.env}};
  if(process.platform==='win32'){browserOptions.executablePath='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';await access(browserOptions.executablePath);}
  browser=await chromium.launch(browserOptions);context=await browser.newContext();
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  page=await context.newPage();await page.goto(origin);
  const controls=page.locator('.jot-native-member-controls');
  await controls.first().getByRole('heading',{name:'原生协作成员'}).waitFor({timeout:10000});
  assert.equal(await controls.count(),1,'one active run should render one native-member control section');
  const panel=controls.first(),selected=panel.getByLabel('成员',{exact:true});
  await panel.getByRole('list').getByText('Writer member').waitFor();await selected.selectOption('child-session-a');
  await panel.getByRole('button',{name:'中断选中成员'}).click();
  const writer=()=>panel.getByRole('status').filter({hasText:'Writer member'});
  await writer().getByText(/中断结果未知或未确认/).waitFor();
  assert.ok(state.interrupts.length>=1);const requestId=state.interrupts[0].body.request_id;
  assert.ok(state.interrupts.every(value=>value.body.request_id===requestId&&value.key===requestId));
  assert.equal(state.businessEffects.get(requestId),1,'same-key transport attempts map to one business effect');
  await writer().getByRole('button',{name:'检查原中断回执'}).click();await writer().getByText(/中断结果未知或未确认/).waitFor();
  assert.deepEqual([...state.businessEffects.keys()],[requestId],'receipt inspection must not create another interrupt identity');
  await page.reload();await controls.first().getByRole('heading',{name:'原生协作成员'}).waitFor();
  await panel.getByRole('status').filter({hasText:'Writer member'}).getByText(/中断结果未知或未确认/).waitFor();
  assert.equal(await controls.count(),1);assert.deepEqual([...state.businessEffects.keys()],[requestId],'cold UI recovery must not redispatch the stored request');
  assert.ok(state.receiptReads.every(value=>value===requestId),'receipt checks must use the original request identity');
  assert.equal(state.businessEffects.get(requestId),1);assert.deepEqual(state.faults,[]);
 }catch(error){console.error(JSON.stringify({diagnostic:await page?.locator('body').innerText().catch(()=>''),interrupts:state.interrupts,receiptReads:state.receiptReads,faults:state.faults}));throw error;
 }finally{
  for(const stream of state.streams)stream.end();server.closeAllConnections();
  await context?.close();await browser?.close();await new Promise(resolveClose=>server.close(resolveClose));
  for(const key of ['TEMP','TMP'])if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
  assert.ok(profile.startsWith(resolve(scratch)+sep));await rm(profile,{recursive:true,force:true});
 }
});
