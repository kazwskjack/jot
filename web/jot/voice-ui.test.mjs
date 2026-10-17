// Actual React composer and browser audio pipeline; ASR responses are explicitly synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import {chromium} from 'playwright';

test('browser voice draft uses actual composer, PCM capture and existing explicit send chain', {timeout:120000}, async()=>{
 const scratch=resolve(process.env.JOT_VOICE_TEST_TMP??tmpdir());
 await mkdir(scratch,{recursive:true});
 const previous={TEMP:process.env.TEMP,TMP:process.env.TMP};process.env.TEMP=scratch;process.env.TMP=scratch;
 const root=fileURLToPath(new URL('../../',import.meta.url));
 const bundle=await build({stdin:{contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import RoleConversation from './web/jot/RoleConversation.tsx';function Harness(){const [view,setView]=useState({id:'ordinary-a',ordinary:true});return <><button onClick={()=>setView({id:'ordinary-b',ordinary:true})}>Fixture switch conversation</button><button onClick={()=>setView({id:'role-a',ordinary:false})}>Fixture switch role</button><RoleConversation {...view} onClose={()=>setView({id:'ordinary-a',ordinary:true})}/></>;}createRoot(document.getElementById('root')).render(<Harness/>);`,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic'});
 const csrf='voice-fixture-csrf',messages=[],uploads=[],deletes=[],faults=[],jobs=new Map(),streams=new Set();
 let scope='a'.repeat(64),behavior='success',browser,context,page;
 const snapshot=id=>({conversation:{conversation_id:id,title:'Synthetic voice fixture'},as_of_seq:'0',messages:[],runs:[],activities:[],sources:[],interactions:[],artifacts:[],stream_cursors:[]});
 const server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://localhost'),path=url.pathname.replace('/workbench-api/v1','');
  const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json','x-csrf-token':csrf,'x-workbench-draft-scope':scope});res.end(JSON.stringify(value));};
  if(url.pathname==='/'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/bundle.js"></script>');return;}
  if(url.pathname==='/bundle.js'){res.writeHead(200,{'content-type':'application/javascript'});res.end(bundle.outputFiles[0].contents);return;}
  if(path==='/capabilities')return json({workspaces:[{workspace_id:'ws',title:'Synthetic',can_read:true,can_write:true}],limits:{max_upload_bytes:10000000},workbench:{enabled:true,agent_roles:true},voice:{enabled:true,status:'ready',max_bytes:2097152,max_duration_ms:60000,accepted_mime_types:['audio/wav'],languages:['zh']}});
  if(path.endsWith('/snapshot'))return json(snapshot(path.split('/')[2]));
  if(path.endsWith('/events')){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': synthetic stream\n\n');streams.add(res);res.on('close',()=>streams.delete(res));return;}
  if(path.endsWith('/goal/resume-readiness'))return json({enabled:false,ready:false,reason:'DISABLED'});
  if(path.endsWith('/goal'))return json({goal:null});
  if(path.endsWith('/voice/transcriptions')&&req.method==='POST'){
   assert.equal(req.headers['x-csrf-token'],csrf);assert.equal(req.headers['x-jot-actor'],'web');assert.match(req.headers['content-type'],/^multipart\/form-data; boundary=/);
   const parts=[];for await(const part of req)parts.push(part);const body=Buffer.concat(parts),form=await new Response(body,{headers:{'content-type':req.headers['content-type']}}).formData();
   assert.match(form.get('client_request_id'),/^[a-f0-9-]{36}$/);const audio=form.get('audio');assert.equal(audio.type,'audio/wav');
   const wav=Buffer.from(await audio.arrayBuffer());assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.toString('ascii',8,12),'WAVE');assert.equal(wav.readUInt16LE(20),1);assert.equal(wav.readUInt16LE(22),1);assert.equal(wav.readUInt32LE(24),16000);assert.equal(wav.readUInt32LE(28),32000);assert.equal(wav.readUInt16LE(32),2);assert.equal(wav.readUInt16LE(34),16);assert.equal(wav.readUInt32LE(40),wav.length-44);assert.ok(wav.length>1000);assert.ok(wav.subarray(44).some(value=>value!==0),'fake browser microphone must supply actual nonzero samples');
   uploads.push({path,bytes:wav.length});if(behavior==='error')return json({error:{code:'VOICE_PROVIDER_UNAVAILABLE'}},503);
   const id=`voice-${uploads.length}`;jobs.set(id,{behavior,polls:0});return json({transcription_id:id,status:'queued'},202);
  }
  if(path.includes('/voice/transcriptions/')){
   const id=path.split('/').at(-1),job=jobs.get(id);assert.ok(job,'unknown voice job');
   if(req.method==='DELETE'){assert.equal(req.headers['x-csrf-token'],csrf);deletes.push(id);return json({transcription_id:id,status:'cancelled'});}
   job.polls++;if(job.behavior==='hold')return json({transcription_id:id,status:'transcribing'});
   if(job.polls===1)return json({transcription_id:id,status:'transcribing'});
   return json({transcription_id:id,status:'succeeded',text:job.behavior==='late'?'LATE SYNTHETIC RESULT':'合成识别文字'});
  }
  if(path.endsWith('/messages')&&req.method==='POST'){
   assert.equal(req.headers['x-csrf-token'],csrf);assert.ok(req.headers['idempotency-key']);const chunks=[];for await(const c of req)chunks.push(c);messages.push({path,body:JSON.parse(Buffer.concat(chunks))});return json({accepted:true,message_id:'synthetic-message',run_id:'synthetic-run',conversation_id:path.split('/')[2]},202);
  }
  if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
  throw Error(`unexpected fixture request ${req.method} ${path}`);
 }catch(error){faults.push(error.message);if(!res.headersSent)res.writeHead(500);res.end('fixture failure');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 try{
  const options={headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'],env:{...process.env,TEMP:scratch,TMP:scratch}};
  if(process.platform==='win32'){const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';await access(edge);options.executablePath=edge;}
  browser=await chromium.launch(options);context=await browser.newContext({viewport:{width:1100,height:820},permissions:['microphone']});
  await context.addInitScript(()=>{
   window.__voiceTracks=[];window.__denyMicrophone=false;
   const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
   navigator.mediaDevices.getUserMedia=async constraints=>{if(window.__denyMicrophone)throw new DOMException('Synthetic permission rejection','NotAllowedError');const stream=await original(constraints);window.__voiceTracks.push(...stream.getTracks());return stream;};
  });
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>faults.push(error.message));await page.goto(origin);
  const start=()=>page.getByRole('button',{name:'开始录音',exact:true}).click();
  const record=async()=>{await start();await page.getByRole('button',{name:'停止并转写',exact:true}).waitFor();await page.waitForTimeout(1800);};
  const stopped=()=>page.waitForFunction(()=>window.__voiceTracks.length>0&&window.__voiceTracks.every(track=>track.readyState==='ended'));
  const draft=()=>page.getByRole('textbox',{name:'对话消息',exact:true});
  const waitJob=async predicate=>{for(let i=0;i<160;i++){const found=[...jobs.values()].find(predicate);if(found)return found;await page.waitForTimeout(25);}assert.fail('accepted voice job did not reach expected poll state');};
  await draft().fill('已有草稿');await record();await page.getByRole('button',{name:'停止并转写',exact:true}).click();await stopped();
  await page.waitForFunction(()=>document.querySelector('textarea')?.value.includes('合成识别文字'));
  assert.equal(await draft().inputValue(),'已有草稿\n合成识别文字');assert.equal(await draft().isEditable(),true);assert.equal(messages.length,0,'transcription must never send a message');assert.ok([...jobs.values()][0].polls>=2,'actual async status polling required');
  await draft().fill('人工修改后的识别文字');await page.getByRole('button',{name:'发送',exact:true}).click();await page.waitForFunction(()=>document.querySelector('textarea')?.value==='');assert.equal(messages.length,1);assert.equal(messages[0].path,'/conversations/ordinary-a/messages');assert.deepEqual(messages[0].body.content,[{type:'text',text:'人工修改后的识别文字'}]);assert.ok(messages[0].body.client_message_id);
  const beforeCancel=uploads.length;await draft().fill('取消后保留');await record();await page.getByRole('button',{name:'取消语音',exact:true}).click();await stopped();assert.equal(uploads.length,beforeCancel);assert.equal(await draft().inputValue(),'取消后保留');
  await page.evaluate(()=>{window.__denyMicrophone=true;});await start();await page.getByRole('alert').filter({hasText:'NotAllowedError'}).waitFor();assert.equal(await draft().inputValue(),'取消后保留');await page.evaluate(()=>{window.__denyMicrophone=false;});
  behavior='error';await record();await page.getByRole('button',{name:'停止并转写',exact:true}).click();await page.getByRole('alert').filter({hasText:'VOICE_PROVIDER_UNAVAILABLE'}).waitFor();await stopped();assert.equal(await draft().inputValue(),'取消后保留');assert.equal(messages.length,1);
  behavior='hold';await record();await page.getByRole('button',{name:'停止并转写',exact:true}).click();await waitJob(job=>job.behavior==='hold'&&job.polls);
  await page.getByRole('button',{name:'取消语音',exact:true}).click();await stopped();await page.waitForTimeout(100);assert.ok(deletes.length>=1,'cancel must request cancellation of accepted transcription');assert.equal(await draft().inputValue(),'取消后保留');
  const lateSwitch=async(name,role)=>{
   behavior='hold';await record();await page.getByRole('button',{name:'停止并转写',exact:true}).click();await waitJob(job=>job.behavior==='hold'&&job.polls);const count=uploads.length;await page.getByRole('button',{name,exact:true}).click();await stopped();
   for(const job of jobs.values())if(job.behavior==='hold')job.behavior='late';await page.waitForTimeout(600);
   const box=page.getByRole('textbox',{name:role?'角色消息':'对话消息',exact:true});assert.ok(!(await box.inputValue()).includes('LATE SYNTHETIC RESULT'));assert.equal(messages.length,1);assert.ok(uploads.length>=count);
  };
  await lateSwitch('Fixture switch conversation',false);await lateSwitch('Fixture switch role',true);
  await record();await page.getByRole('button',{name:'Fixture switch conversation',exact:true}).click();await stopped();
  await draft().fill('用户范围切换前的草稿');behavior='hold';await record();await page.getByRole('button',{name:'停止并转写',exact:true}).click();
  const pending=await waitJob(job=>job.behavior==='hold'&&job.polls);scope='b'.repeat(64);pending.behavior='late';
  await page.getByRole('alert').filter({hasText:'VOICE_SCOPE_CHANGED'}).waitFor();await stopped();assert.equal(await draft().inputValue(),'用户范围切换前的草稿');assert.equal(messages.length,1);
  assert.deepEqual(faults,[]);console.log(JSON.stringify({syntheticASR:true,realBrowserFakeMicrophone:true,actualRoleConversation:true,strict16kMonoPCM16:true,multipartCSRF:true,polling:true,editableRetainedDraft:true,explicitExistingMessageChain:true,cancelAndPermissionFailure:true,lateConversationAndRoleIgnored:true,pendingOwnerScopeChangeRejected:true,allObservedTracksEnded:true,uploads:uploads.length,messages:messages.length}));
 }catch(error){console.error(JSON.stringify({voiceBrowserDiagnostic:await page?.locator('body').innerText().catch(()=>''),faults,uploads,jobs:[...jobs],messages}));throw error;}finally{
  await context?.close();await browser?.close();for(const stream of streams)stream.end();server.closeAllConnections();await new Promise(r=>server.close(r));
  for(const key of ['TEMP','TMP'])if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
 }
});
