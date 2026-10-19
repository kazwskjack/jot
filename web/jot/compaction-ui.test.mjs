// Real React/controller/SSE boundary; native event frames and the model are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {projectSessionFrame} from '../../packages/gateway/src/harness/session-event-projector.ts';
test('native compaction metadata reaches actual React over SSE and survives reload without summary text',{timeout:45000},async()=>{
 const bundle=await build({stdin:{contents:"import React from 'react';import {createRoot} from 'react-dom/client';import RoleConversation from './RoleConversation';createRoot(document.getElementById('root')).render(React.createElement(RoleConversation,{id:'conv-native',onClose:()=>{}}));",resolveDir:fileURLToPath(new URL('.',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',logLevel:'silent'});
 const streams=new Set(),faults=[];let seq=0,activities={},run={run_id:'run-native',conversation_id:'conv-native',input_message_id:'user-native',status:'running',version:1,created_at:'2026-10-19T00:00:00Z',updated_at:'2026-10-19T00:00:00Z'};
 const snapshot=()=>({conversation:{conversation_id:'conv-native',title:'Synthetic Work',workspace_id:'workspace',mode:'work',model:{provider:'fixture',model:'work'},version:1,created_at:run.created_at,updated_at:run.updated_at},as_of_seq:String(seq),messages:[],runs:[run],activities:Object.values(activities),sources:[],interactions:[],artifacts:[],stream_cursors:[],history_complete:true});
 const server=createServer((req,res)=>{const u=new URL(req.url,'http://localhost'),path=u.pathname.replace('/workbench-api/v1','');const json=value=>{res.writeHead(200,{'content-type':'application/json','x-csrf-token':'synthetic'});res.end(JSON.stringify(value));};
  if(u.pathname==='/'){res.writeHead(200,{'content-type':'text/html'});res.end('<div id="root"></div><script src="/bundle.js"></script>');}
  else if(u.pathname==='/bundle.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(bundle.outputFiles[0].text);}
  else if(path==='/capabilities')json({models:[],limits:{max_upload_bytes:0}});
  else if(path.endsWith('/snapshot'))json(snapshot());
  else if(path.endsWith('/events')){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': fixture stream\n\n');streams.add(res);res.on('close',()=>streams.delete(res));}
  else if(u.pathname==='/favicon.ico'){res.writeHead(204);res.end();}
  else{faults.push('Unexpected '+path);res.writeHead(404);res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;let browser;
 const emit=(type,payload)=>{const e={schema_version:'1.0',event_id:'event-'+(++seq),conversation_id:'conv-native',run_id:run.run_id,seq:String(seq),at:run.updated_at,type,payload};if(type==='activity.upsert')activities[payload.activity_id]=payload;if(type==='run.state')run=payload;for(const s of streams)s.write(`id: ${seq}\nevent: agent\ndata: ${JSON.stringify(e)}\n\n`);return e;};
 try{
  browser=await chromium.launch({headless:true,...(process.platform==='win32'?{executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'}:{}),env:{...process.env}});const context=await browser.newContext({viewport:{width:390,height:844}});await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>faults.push(e.message));await page.goto(origin);await page.getByRole('status').filter({hasText:'已连接'}).waitFor();
  const c={runId:run.run_id,attemptId:'attempt-native',messageId:'stream-native',blockId:'b',deltaIndex:0,at:run.created_at,compaction:{mode:'work',states:new Map()}};
  const frame=(type,id='native')=>({type:'event',event:{type,data:{compactionId:id,turn:null,summary:'PRIVATE_SUMMARY'}}});
  let p=projectSessionFrame(frame('compaction/start'),c);emit(p.type,p.payload);await page.getByText('正在压缩上下文',{exact:true}).waitFor();await page.reload();await page.getByText('正在压缩上下文',{exact:true}).waitFor();
  p=projectSessionFrame(frame('compaction/end'),{...c,at:'2026-10-19T00:00:03Z'});const event=emit(p.type,p.payload);await page.getByText('上下文已整理',{exact:true}).waitFor();for(const s of streams)s.write(`id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`);assert.equal(await page.getByText('上下文已整理',{exact:true}).count(),1);
  p=projectSessionFrame(frame('compaction/start','unfinished'),c);emit(p.type,p.payload);await page.getByText('正在压缩上下文',{exact:true}).waitFor();emit('run.state',{...run,status:'interrupted',version:2});await page.getByText('上下文整理状态待确认',{exact:true}).waitFor();await page.reload();await page.getByText('上下文整理状态待确认',{exact:true}).waitFor();assert.doesNotMatch(await page.locator('body').innerText(),/PRIVATE_SUMMARY/);assert.deepEqual(faults,[]);
 }finally{await browser?.close();for(const s of streams)s.end();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
