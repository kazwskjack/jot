import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {buildServer} from '../../src/server.ts';

const scratch=resolve(process.env.JOT_TEST_TMP??tmpdir());
mkdirSync(scratch,{recursive:true});
const hash=value=>createHash('sha256').update(value,'utf8').digest('hex');
const query=values=>new URLSearchParams(Object.entries(values).filter(([,value])=>value!==undefined).map(([key,value])=>[key,String(value)])).toString();

async function fixture(t){
 const root=mkdtempSync(join(scratch,'jot-file-history-http-')),csrf='file-history-http-test-csrf-token';
 const gateway=await buildServer({databasePath:join(root,'fixture.sqlite'),workspaces:['ws-one'],workbenchRoot:join(root,'workspace'),csrfToken:csrf,allowedOrigins:['http://127.0.0.1']});
 let nextRangeGate;
 gateway.app.addHook('onSend',async(request,reply,payload)=>{const gate=nextRangeGate;if(gate&&request.url.includes('/files/content?')&&request.url.includes('offset_bytes=')){nextRangeGate=undefined;gate.enter();reply.raw.once('close',gate.disconnect);await Promise.race([gate.released,gate.disconnected,new Promise(resolve=>setTimeout(resolve,1500))]);}return payload;});
 const holdNextRangeReply=()=>{let enter,disconnect,release;const entered=new Promise(resolve=>{enter=resolve;}),disconnected=new Promise(resolve=>{disconnect=resolve;}),released=new Promise(resolve=>{release=resolve;});nextRangeGate={enter,disconnect,disconnected,released};return {entered,disconnected,release};};
 const agent=gateway.workbench.createAgent('alice',{name:'Version reader',workspace_id:'ws-one'}),origin=await gateway.app.listen({host:'127.0.0.1',port:0});
 const headers=(owner='alice',method='GET')=>({'x-user-id':owner,...(method==='GET'?{}:{origin:'http://127.0.0.1','x-csrf-token':csrf,'content-type':'application/json','idempotency-key':randomUUID()})});
 const request=(path,{method='GET',owner='alice',body,signal}={})=>fetch(origin+path,{method,headers:headers(owner,method),...(body===undefined?{}:{body:JSON.stringify(body)}),...(signal?{signal}:{})});
 t.after(async()=>{await gateway.app.close();gateway.db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 return {gateway,agent,origin,request,holdNextRangeReply,write:(path,content,expected_version,owner='alice')=>request('/v1/workspaces/ws-one/files',{method:'PUT',owner,body:{project_id:agent.project_id,path,content,expected_version}})};
}

test('registered capabilities and real loopback routes expose immutable history and bounded UTF-8 ranges without changing legacy reads',async t=>{
 const f=await fixture(t),path='notes/雪😀.txt',firstContent='x'.repeat(65535)+'中😀z';
 const firstWrite=await f.write(path,firstContent,0);assert.equal(firstWrite.status,200);const firstFile=await firstWrite.json();
 const secondWrite=await f.write(path,'current v2',1);assert.equal(secondWrite.status,200,await secondWrite.text());

 const capsResponse=await f.request('/v1/capabilities');assert.equal(capsResponse.status,200);const caps=(await capsResponse.json()).workbench;
 assert.equal(caps.workspace_file_history,true);assert.equal(caps.workspace_file_range,true);

 const legacy=await f.request('/v1/workspaces/ws-one/files/content?'+query({project_id:f.agent.project_id,path}));
 assert.equal(legacy.status,200);const legacyValue=await legacy.json();
 assert.deepEqual({...legacyValue,updated_at:undefined},{path,version:2,sha256:hash('current v2'),size:Buffer.byteLength('current v2'),updated_at:undefined,content:'current v2'});
 assert.match(legacyValue.updated_at,/^\d{4}-\d\d-\d\dT/);
 const pinnedLegacyResponse=await f.request('/v1/workspaces/ws-one/files/content?'+query({project_id:f.agent.project_id,path,version:1}));assert.equal(pinnedLegacyResponse.status,200);const pinnedLegacy=await pinnedLegacyResponse.json();
 assert.deepEqual({path:pinnedLegacy.path,version:pinnedLegacy.version,sha256:pinnedLegacy.sha256,size:pinnedLegacy.size},{path,version:1,sha256:firstFile.sha256,size:Buffer.byteLength(firstContent)});
 assert.match(pinnedLegacy.updated_at,/^\d{4}-\d\d-\d\dT/);assert.equal(hash(pinnedLegacy.content),firstFile.sha256,'the legacy pinned full-body response retains the complete selected version');

 const unchanged=f.gateway.db.prepare('SELECT total_changes() AS count').get().count;
 const firstPageResponse=await f.request('/v1/workspaces/ws-one/files/versions?'+query({project_id:f.agent.project_id,path,limit:1}));
 assert.equal(firstPageResponse.status,200);const firstPage=await firstPageResponse.json();
 assert.equal(firstPage.workspace_id,'ws-one');assert.equal(firstPage.project_id,f.agent.project_id);assert.equal(firstPage.path,path);
 assert.deepEqual(firstPage.items.map(({created_at,...item})=>item),[{workspace_id:'ws-one',project_id:f.agent.project_id,path,version:2,sha256:hash('current v2'),size:Buffer.byteLength('current v2')}]);
 assert.match(firstPage.items[0].created_at,/^\d{4}-\d\d-\d\dT/);assert.equal(firstPage.next_before_version,2);

 const firstRangeResponse=await f.request('/v1/workspaces/ws-one/files/content?'+query({project_id:f.agent.project_id,path,version:1,sha256:firstFile.sha256,offset_bytes:0,limit_bytes:65536}));
 assert.equal(firstRangeResponse.status,200);const firstRange=await firstRangeResponse.json();
 assert.deepEqual({workspace_id:firstRange.workspace_id,project_id:firstRange.project_id,path:firstRange.path,version:firstRange.version,sha256:firstRange.sha256,size:firstRange.size,offset_bytes:firstRange.offset_bytes,returned_bytes:firstRange.returned_bytes,eof:firstRange.eof},{workspace_id:'ws-one',project_id:f.agent.project_id,path,version:1,sha256:firstFile.sha256,size:Buffer.byteLength(firstContent),offset_bytes:0,returned_bytes:65535,eof:false});
 assert.equal(firstRange.content,'x'.repeat(65535));
 const splitScalar=await f.request('/v1/workspaces/ws-one/files/content?'+query({project_id:f.agent.project_id,path,version:1,sha256:firstFile.sha256,offset_bytes:65536,limit_bytes:65536}));assert.equal(splitScalar.status,400,'range starts cannot point into a multi-byte UTF-8 scalar');
 assert.equal(f.gateway.db.prepare('SELECT total_changes() AS count').get().count,unchanged,'history and range GETs must not mutate SQLite');

 const thirdWrite=await f.write(path,'current v3',2);assert.equal(thirdWrite.status,200,await thirdWrite.text());
 const afterThirdWrite=f.gateway.db.prepare('SELECT total_changes() AS count').get().count;
 const nextRangeResponse=await f.request('/v1/workspaces/ws-one/files/content?'+query({project_id:f.agent.project_id,path,version:1,sha256:firstFile.sha256,offset_bytes:firstRange.offset_bytes+firstRange.returned_bytes,limit_bytes:65536}));
 assert.equal(nextRangeResponse.status,200);const nextRange=await nextRangeResponse.json();
 assert.equal(nextRange.content,'中😀z');assert.equal(nextRange.eof,true);assert.equal(nextRange.returned_bytes,Buffer.byteLength('中😀z'));
 assert.equal(hash(firstRange.content+nextRange.content),firstFile.sha256,'version 1 bytes remain fixed while the current logical file advances');

 const olderPageResponse=await f.request('/v1/workspaces/ws-one/files/versions?'+query({project_id:f.agent.project_id,path,before_version:firstPage.next_before_version,limit:1}));
 assert.equal(olderPageResponse.status,200);const olderPage=await olderPageResponse.json();
 assert.deepEqual(olderPage.items.map(item=>item.version),[1]);assert.equal(olderPage.next_before_version,null);
 const latest=await f.request('/v1/workspaces/ws-one/files/content?'+query({project_id:f.agent.project_id,path}));assert.equal((await latest.json()).content,'current v3');
 const gate=f.holdNextRangeReply(),cancel=new AbortController(),cancelledRead=f.request('/v1/workspaces/ws-one/files/content?'+query({project_id:f.agent.project_id,path,version:1,sha256:firstFile.sha256,offset_bytes:0,limit_bytes:65536}),{signal:cancel.signal});await gate.entered;cancel.abort();await assert.rejects(cancelledRead,{name:'AbortError'});assert.equal(await Promise.race([gate.disconnected.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),1500))]),true,'the HTTP server observes the aborted client');gate.release();
 assert.equal(f.gateway.db.prepare('SELECT total_changes() AS count').get().count,afterThirdWrite,'follow-up history and current-file GETs remain read-only');
});

test('history pagination stays below its exclusive cursor and rejects owner, path, stale digest and range-bound violations',async t=>{
 const f=await fixture(t),path='src/a.txt';
 const v1=await f.write(path,'one',0);assert.equal(v1.status,200);const version1=await v1.json();
 const v2=await f.write(path,'two',1);assert.equal(v2.status,200);
 const base='/v1/workspaces/ws-one/files/versions?',common={project_id:f.agent.project_id,path};
 const pageResponse=await f.request(base+query({...common,limit:1}));assert.equal(pageResponse.status,200);const page=await pageResponse.json();assert.equal(page.items[0].version,2);assert.equal(page.next_before_version,2);
 assert.equal((await f.request(base+query({...common,limit:100}))).status,200,'history page limit accepts its documented maximum');
 const v3=await f.write(path,'three',2);assert.equal(v3.status,200);
 const older=await f.request(base+query({...common,before_version:page.next_before_version,limit:1}));assert.equal(older.status,200);assert.deepEqual((await older.json()).items.map(item=>item.version),[1]);

 const denied=await f.request(base+query({...common,limit:10}),{owner:'bob'});assert.equal(denied.status,404);
 const badPath=await f.request(base+query({project_id:f.agent.project_id,path:'../outside.txt',limit:10}));assert.equal(badPath.status,422);
 for(const invalid of [{limit:101},{before_version:0},{before_version:'01'}])assert.equal((await f.request(base+query({...common,...invalid}))).status,400);
 const range='/v1/workspaces/ws-one/files/content?';
 const rangeValues={...common,version:1,sha256:version1.sha256,offset_bytes:0,limit_bytes:65536};
 assert.equal((await f.request(range+query({...rangeValues,sha256:'0'.repeat(64)}))).status,409);
 assert.equal((await f.request(range+query({project_id:f.agent.project_id,path,sha256:version1.sha256,offset_bytes:0,limit_bytes:65536}))).status,400,'range requests require a pinned immutable version');
 assert.equal((await f.request(range+query({project_id:f.agent.project_id,path,version:1,offset_bytes:0,limit_bytes:65536}))).status,400,'range requests require an expected digest');
 assert.equal((await f.request(range+query({...rangeValues,limit_bytes:65537}))).status,400);
 assert.equal((await f.request(range+query({...rangeValues,offset_bytes:version1.size+1}))).status,400);
 assert.equal((await f.request(range+query({project_id:f.agent.project_id,path,version:1,sha256:version1.sha256,offset_bytes:0}))).status,400,'range requests require both byte offset and limit');
});
