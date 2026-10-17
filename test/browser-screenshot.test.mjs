import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {createTools,readArtifact} from '../src/tools.mjs';
import {buildServer} from '../src/server.mjs';

const temp=process.env.JOT_TEST_TMP??tmpdir();
const url='https://example.com/page';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
function browser(){
 const state={launches:0,contexts:0,pages:0,navigations:0,captures:0,current:url,bytes:png,after:()=>{},empty:false};
 const page={url:()=>state.current,goto:async value=>{state.navigations++;state.current=value;},title:async()=> 'Fixture',locator:()=>({innerText:async()=> 'Fixture text'}),screenshot:async options=>{assert.deepEqual(options,{type:'png',fullPage:false,timeout:10000});state.captures++;await state.after();return state.bytes;}};
 const factory=async()=>{state.launches++;return {newContext:async()=>{state.contexts++;return {route:async()=>{},pages:()=>state.empty?[]:[page],newPage:async()=>{state.pages++;return page;},close:async()=>{}};},close:async()=>{}};};
 return {state,factory};
}
async function fixture(t){
 await mkdir(temp,{recursive:true});const root=await mkdtemp(join(temp,'screenshot-'));const store=new Store(join(root,'fixture.db')),fake=browser();
 const tools=createTools({store,root:join(root,'files'),origins:new Set(['https://example.com']),browserEnabled:true,browserFactory:fake.factory});
 const run=store.accept(store.createConversation().id,'Capture page','request-1').run,controller=new AbortController();
 const ctx={run,signal:controller.signal,approve:async()=>{}};
 const action=(action='screenshot',context=ctx)=>tools.execute('browser_action',{url,action},context);
 t.after(async()=>{await tools.close();store.close();await rm(root,{recursive:true,force:true});});
 return {root,store,fake,tools,run,controller,ctx,action,open:()=>action('read')};
}
test('screenshot captures existing page into immutable original run artifact and returns metadata only',async t=>{
 const f=await fixture(t);await f.open();let approval;
 f.ctx.approve=async(description,operation)=>{approval={description,operation};};
 const result=await f.action();
 assert.match(approval.description,/screenshot.*https:\/\/example.com\/page.*PNG/i);
 assert.equal(approval.operation.action,'screenshot');assert.equal(approval.operation.url,url);assert.equal(approval.operation.format,'png');assert.equal(approval.operation.persist,true);
 assert.equal(result.mime_type,'image/png');assert.equal(result.size,png.length);assert.equal(result.sha256,createHash('sha256').update(png).digest('hex'));assert.equal(result.untrusted,true);
 assert.equal(result.name,'browser-screenshot.png');assert.equal(result.url,url);assert.equal(result.data,undefined);assert.equal(result.base64,undefined);assert.equal(result.text,undefined);
 const artifact=f.store.getArtifact(result.artifact_id);assert.equal(artifact.conversation_id,f.run.conversation_id);assert.equal(artifact.run_id,f.run.id);assert.equal(artifact.size,png.length);
 assert.deepEqual(await readFile(artifact.path),png);assert.match(result.artifact_id,/^[a-f0-9-]{36}$/);
 const second=await f.action();assert.notEqual(second.artifact_id,result.artifact_id);assert.deepEqual(await readFile(artifact.path),png);
 assert.equal(f.fake.state.navigations,0);assert.equal(f.fake.state.captures,2);
 await assert.rejects(()=>f.tools.execute('file_read',{artifact_id:result.artifact_id},f.ctx),/unsupported_file_type/);
 const other=f.store.accept(f.store.createConversation().id,'other','other').run;
 await assert.rejects(()=>f.tools.execute('file_read',{artifact_id:result.artifact_id},{...f.ctx,run:other}),/artifact_not_found/);
 assert.ok(!JSON.stringify(f.store.events(f.run.conversation_id,0)).includes(png.toString('base64')));
});
test('screenshot without existing context or page never launches or creates a page',async t=>{
 const f=await fixture(t);await assert.rejects(()=>f.action(),/browser_page_unavailable/);assert.equal(f.fake.state.launches,0);
 await f.open();f.fake.state.empty=true;await assert.rejects(()=>f.action(),/browser_page_unavailable/);assert.equal(f.fake.state.pages,0);assert.equal(f.fake.state.captures,0);
});
test('screenshot denial does not capture or persist',async t=>{
 const f=await fixture(t);await f.open();f.ctx.approve=async()=>{throw Error('user_denied');};await assert.rejects(()=>f.action(),/user_denied/);
 assert.equal(f.fake.state.captures,0);assert.deepEqual(f.store.artifacts(f.run.conversation_id),[]);
});
test('screenshot fences exact current URL before and after capture without navigation',async t=>{
 const f=await fixture(t);await f.open();f.fake.state.current='https://example.com/changed';await assert.rejects(()=>f.action(),/browser_page_changed/);assert.equal(f.fake.state.captures,0);
 f.fake.state.current=url;f.fake.state.after=()=>{f.fake.state.current='https://evil.example/';};await assert.rejects(()=>f.action(),/url_not_allowed|browser_page_changed/);
 assert.equal(f.fake.state.navigations,0);assert.deepEqual(f.store.artifacts(f.run.conversation_id),[]);
});
test('screenshot refuses unapproved origins before capture',async t=>{
 const f=await fixture(t);await f.open();await assert.rejects(()=>f.tools.execute('browser_action',{url:'https://evil.example/',action:'screenshot'},f.ctx),/url_not_allowed/);assert.equal(f.fake.state.captures,0);
});
test('screenshot cancellation and oversized results leave no artifact',async t=>{
 const f=await fixture(t);await f.open();f.fake.state.bytes=Buffer.alloc(1048577);png.copy(f.fake.state.bytes);
 await assert.rejects(()=>f.action(),/file_too_large/);assert.deepEqual(f.store.artifacts(f.run.conversation_id),[]);
 f.fake.state.bytes=png;f.fake.state.after=()=>f.controller.abort();await assert.rejects(()=>f.action(),/cancelled/);assert.deepEqual(f.store.artifacts(f.run.conversation_id),[]);
});
test('screenshot allows exactly one MiB and its bytes remain readable',async t=>{
 const f=await fixture(t);await f.open();f.fake.state.bytes=Buffer.alloc(1048576);png.copy(f.fake.state.bytes);const result=await f.action();
 assert.equal(result.size,1048576);assert.deepEqual(await readArtifact(f.store.getArtifact(result.artifact_id).path,join(f.root,'files')),f.fake.state.bytes);
});
test('screenshot driver failure and non-PNG bytes never publish artifacts',async t=>{
 const f=await fixture(t);await f.open();f.fake.state.after=()=>{throw Error('fixture_capture_failed');};await assert.rejects(()=>f.action(),/fixture_capture_failed/);
 f.fake.state.after=()=>{};f.fake.state.bytes=Buffer.from('not an image');await assert.rejects(()=>f.action(),/browser_screenshot_invalid/);assert.deepEqual(f.store.artifacts(f.run.conversation_id),[]);
});
test('screenshot refuses forged run lineage before capturing',async t=>{
 const f=await fixture(t);await f.open();await assert.rejects(()=>f.action('screenshot',{...f.ctx,run:{...f.run,id:'foreign-run'}}),/artifact_run_mismatch/);assert.equal(f.fake.state.captures,0);assert.deepEqual(f.store.artifacts(f.run.conversation_id),[]);
});
test('screenshot refuses terminal original runs without depending on AbortSignal',async t=>{
 for(const status of ['cancelled','interrupted','failed','succeeded'])await t.test(status,async t=>{
  const f=await fixture(t);await f.open();f.store.state(f.run.id,status);assert.equal(f.controller.signal.aborted,false);
  await assert.rejects(()=>f.action(),/browser_run_inactive/);assert.equal(f.fake.state.captures,0);assert.deepEqual(f.store.artifacts(f.run.conversation_id),[]);
 });
});
test('screenshot rechecks run termination after driver capture before writing PNG',async t=>{
 const f=await fixture(t);await f.open();f.fake.state.after=()=>f.store.state(f.run.id,'cancelled');
 await assert.rejects(()=>f.action(),/browser_run_inactive/);assert.equal(f.controller.signal.aborted,false);assert.equal(f.store.run(f.run.id).status,'cancelled');assert.deepEqual(f.store.artifacts(f.run.conversation_id),[]);
 assert.equal(f.store.events(f.run.conversation_id,0).some(event=>event.type==='artifact.created'),false);
});
test('screenshot removes bytes and rolls back catalog when artifact event persistence fails',async t=>{
 const f=await fixture(t);await f.open();const original=f.store.event.bind(f.store);f.store.event=(...args)=>{if(args[1]==='artifact.created')throw Error('fixture_persist_failure');return original(...args);};
 await assert.rejects(()=>f.action(),/fixture_persist_failure/);assert.deepEqual(f.store.artifacts(f.run.conversation_id),[]);assert.deepEqual(await readdir(join(f.root,'files',f.run.conversation_id)),[]);
});
test('screenshot rolls back bytes and catalog when cancellation arrives during persistence',async t=>{
 const f=await fixture(t);await f.open();const original=f.store.artifact.bind(f.store);f.store.artifact=value=>{original(value);f.controller.abort();};
 await assert.rejects(()=>f.action(),/cancelled/);assert.deepEqual(f.store.artifacts(f.run.conversation_id),[]);assert.deepEqual(await readdir(join(f.root,'files',f.run.conversation_id)),[]);
});
test('standalone API injection delivers original PNG and the model receives only screenshot metadata',async t=>{
 await mkdir(temp,{recursive:true});const root=await mkdtemp(join(temp,'screenshot-api-')),fake=browser(),database=join(root,'test.db');
 const previousBrowser=process.env.JOT_BROWSER,previousOrigins=process.env.JOT_WEB_ORIGINS;process.env.JOT_BROWSER='true';process.env.JOT_WEB_ORIGINS='https://example.com';
 let calls=0,modelResult;
 const provider=async messages=>{calls++;if(calls<=2)return {role:'assistant',content:null,tool_calls:[{id:'call-'+calls,function:{name:'browser_action',arguments:JSON.stringify({url,action:calls===1?'read':'screenshot'})}}]};modelResult=JSON.parse(messages.at(-1).content);return {role:'assistant',content:'Screenshot captured. Download the PNG file.'};};
 let service=await buildServer({database,root:join(root,'files'),provider,browserFactory:fake.factory});
 const restore=()=>{if(previousBrowser===undefined)delete process.env.JOT_BROWSER;else process.env.JOT_BROWSER=previousBrowser;if(previousOrigins===undefined)delete process.env.JOT_WEB_ORIGINS;else process.env.JOT_WEB_ORIGINS=previousOrigins;};
 t.after(async()=>{await service.close();restore();await rm(root,{recursive:true,force:true});});
 const request=async(path,options={})=>{const response=await service.app.inject({url:path,method:options.method??'GET',headers:options.headers,...(options.body?{payload:JSON.parse(options.body)}:{})});return {status:response.statusCode,json:()=>response.json(),arrayBuffer:()=>response.rawPayload,headers:{get:name=>response.headers[name]}};};
 const headers={'x-jot-token':(await (await request('/api/capabilities')).json()).csrf,'content-type':'application/json'};
 const conversation=await (await request('/api/conversations',{method:'POST',headers,body:'{}'})).json();
 const accepted=await (await request(`/api/conversations/${conversation.id}/messages`,{method:'POST',headers,body:JSON.stringify({text:'Capture page',request_id:'capture-1'})})).json();
 for(let count=0;count<200;count++){
  const run=service.store.run(accepted.run.id);if(run.status==='succeeded')break;
  const approval=service.store.snapshot(conversation.id).approval;if(run.status==='waiting_approval'&&approval)await request(`/api/runs/${run.id}/approval`,{method:'POST',headers,body:JSON.stringify({allowed:true,approval_id:approval.approval_id})});
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.equal(service.store.run(accepted.run.id).status,'succeeded');assert.equal(calls,3);assert.equal(fake.state.captures,1);assert.equal(modelResult.mime_type,'image/png');assert.ok(!JSON.stringify(modelResult).includes(png.toString('base64')));
 const artifact=service.store.artifacts(conversation.id)[0];assert.equal(artifact.run_id,accepted.run.id);
 assert.equal((await request(`/api/artifacts/${artifact.id}/download`)).status,403);
 const download=await request(`/api/artifacts/${artifact.id}/download`,{headers});assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),png);assert.match(download.headers.get('content-disposition'),/browser-screenshot.png/);
 await service.close();service=await buildServer({database,root:join(root,'files'),demo:true});const reopenedHeaders={'x-jot-token':(await service.app.inject({url:'/api/capabilities'})).json().csrf};
 const snapshot=(await service.app.inject({url:`/api/conversations/${conversation.id}/snapshot`,headers:reopenedHeaders})).json();assert.equal(snapshot.artifacts[0].id,artifact.id);assert.equal(snapshot.messages.at(-1).run_id,accepted.run.id);
 const reopened=await service.app.inject({url:`/api/artifacts/${artifact.id}/download`,headers:reopenedHeaders});assert.equal(reopened.statusCode,200);assert.deepEqual(reopened.rawPayload,png);
});
