import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readWorkspaceFileVersions,readWorkspaceFileRange,readWorkspaceFileByRanges} from './file-history-client.mjs';

const hash=value=>createHash('sha256').update(value,'utf8').digest('hex');
const file=(content='body')=>({workspace_id:'ws one',project_id:'project-one',path:'notes/雪.txt',version:9,sha256:hash(content),size:Buffer.byteLength(content)});
const version=(number,content,created_at=`2026-10-21T00:00:0${number}Z`)=>({version:number,sha256:hash(content),size:Buffer.byteLength(content),created_at});
const rangeResponse=(source,offset,content,eof)=>({...source,offset_bytes:offset,returned_bytes:Buffer.byteLength(content),eof,content});

test('version history pages are owner-scoped by the authenticated request and bound to workspace, project, path, digest and descending version cursor',async()=>{
 const source=file('current'),calls=[];
 const page=await readWorkspaceFileVersions({request:async(...args)=>{calls.push(args);return{workspace_id:source.workspace_id,project_id:source.project_id,path:source.path,items:[version(9,'current'),version(8,'older')],next_before_version:8};},enabled:true,...source,current:source});
 const [url,method,body,key,signal]=calls[0],parsed=new URL(url,'https://jot.invalid');
 assert.equal(parsed.pathname,'/workspaces/ws%20one/files/versions');
 assert.equal(parsed.searchParams.get('project_id'),'project-one');
 assert.equal(parsed.searchParams.get('path'),'notes/雪.txt');
 assert.equal(parsed.searchParams.get('before_version'),null);
 assert.equal(parsed.searchParams.get('limit'),'50');
 assert.equal(method,'GET');assert.equal(body,undefined);assert.equal(key,undefined);assert.equal(signal,undefined);
 assert.equal(page.items[0].workspace_id,source.workspace_id);
 assert.equal(page.items[0].project_id,source.project_id);
 assert.equal(page.items[0].path,source.path);
 assert.equal(page.items[0].sha256,source.sha256);
 assert.equal(page.next_before_version,8);
});

test('version history continuation uses the previous page version cursor and enforces the page limit',async()=>{
 const source=file('current'),calls=[];
 const page=await readWorkspaceFileVersions({request:async(url)=>{calls.push(url);return{items:[version(7,'older-7')],next_before_version:null};},enabled:true,...source,before_version:8,limit:1},new AbortController().signal);
 const parsed=new URL(calls[0],'https://jot.invalid');
 assert.equal(parsed.searchParams.get('before_version'),'8');
 assert.equal(parsed.searchParams.get('limit'),'1');
 assert.equal(page.items[0].version,7);
 assert.equal(page.next_before_version,null);
 await assert.rejects(readWorkspaceFileVersions({request:async()=>({items:[],next_before_version:null}),enabled:true,...source,limit:101}),error=>error.code==='workspace_file_history_invalid');
});

test('history entry remains disabled until the server advertises it',async()=>{
 let requested=false;
 await assert.rejects(readWorkspaceFileVersions({request:async()=>{requested=true;return{};},enabled:false,...file()}),error=>error.code==='workspace_file_history_unavailable');
 await assert.rejects(readWorkspaceFileRange({request:async()=>{requested=true;return{};},enabled:false,source:file(),offset_bytes:0}),error=>error.code==='workspace_file_range_unavailable');
 assert.equal(requested,false);
});

test('ranged file reads request at most 64 KiB and continue at UTF-8-safe server byte boundaries',async()=>{
 const content='a'.repeat(65535)+'中Z',source=file(content),calls=[];
 const result=await readWorkspaceFileByRanges({enabled:true,source,request:async(url,method,body,key,signal)=>{
  calls.push({url,method,body,key,signal});
  const parsed=new URL(url,'https://jot.invalid'),offset=Number(parsed.searchParams.get('offset_bytes'));
  assert.equal(parsed.searchParams.get('version'),String(source.version));
  assert.equal(parsed.searchParams.get('sha256'),source.sha256);
  assert.equal(parsed.searchParams.get('limit_bytes'),'65536');
  return offset===0?rangeResponse(source,0,'a'.repeat(65535),false):rangeResponse(source,65535,'中Z',true);
 }});
 assert.equal(result.content,content);
 assert.equal(result.sha256,source.sha256);
 assert.deepEqual(calls.map(call=>Number(new URL(call.url,'https://jot.invalid').searchParams.get('offset_bytes'))),[0,65535]);
 assert.equal(calls.length,2);
});

test('empty immutable files still make one zero-length range request and verify their digest',async()=>{
 const source=file(''),calls=[];
 const result=await readWorkspaceFileByRanges({enabled:true,source,request:async(url)=>{calls.push(url);return rangeResponse(source,0,'',true);}});
 assert.equal(result.content,'');
 assert.equal(calls.length,1);
});

test('a range response must echo the requested identity, offset, digest, size and valid UTF-8 byte count',async()=>{
 const source=file('中文'),valid=rangeResponse(source,0,'中文',true);
 const result=await readWorkspaceFileRange({enabled:true,source,offset_bytes:0,request:async()=>valid});
 assert.equal(result.content,'中文');
 await assert.rejects(readWorkspaceFileRange({enabled:true,source,offset_bytes:0,request:async()=>({...valid,path:'other.txt'})}),error=>error.code==='workspace_file_source_mismatch');
 await assert.rejects(readWorkspaceFileRange({enabled:true,source,offset_bytes:0,request:async()=>{const{workspace_id,project_id,path,...rest}=valid;return rest;}}),error=>error.code==='workspace_file_source_mismatch');
 await assert.rejects(readWorkspaceFileRange({enabled:true,source,offset_bytes:0,request:async()=>({...valid,sha256:'f'.repeat(64)})}),error=>error.code==='workspace_file_stale');
 await assert.rejects(readWorkspaceFileRange({enabled:true,source,offset_bytes:0,request:async()=>({...valid,version:source.version-1})}),error=>error.code==='workspace_file_stale');
 await assert.rejects(readWorkspaceFileRange({enabled:true,source,offset_bytes:0,request:async()=>({...valid,size:source.size+1})}),error=>error.code==='workspace_file_stale');
 await assert.rejects(readWorkspaceFileRange({enabled:true,source,offset_bytes:0,request:async()=>({...valid,offset_bytes:1})}),error=>error.code==='workspace_file_range_invalid');
 await assert.rejects(readWorkspaceFileRange({enabled:true,source,offset_bytes:0,request:async()=>({...valid,returned_bytes:1})}),error=>error.code==='workspace_file_range_invalid');
 await assert.rejects(readWorkspaceFileRange({enabled:true,source,offset_bytes:0,request:async()=>({...valid,content:'\ud800'})}),error=>error.code==='workspace_file_range_invalid');
 let requested=false;
 await assert.rejects(readWorkspaceFileRange({enabled:true,source,offset_bytes:0,limit_bytes:65537,request:async()=>{requested=true;return valid;}}),error=>error.code==='workspace_file_range_invalid');
 assert.equal(requested,false);
});

test('stale digest conflicts and deleted or unauthorized versions produce recoverable, non-leaking errors',async()=>{
 const source=file('body');
 await assert.rejects(readWorkspaceFileRange({enabled:true,source,offset_bytes:0,request:async()=>{throw Object.assign(new Error('private server detail'),{status:409});}}),error=>error.code==='workspace_file_stale'&&!error.message.includes('private server detail'));
 for(const status of [403,404]){
  await assert.rejects(readWorkspaceFileRange({enabled:true,source,offset_bytes:0,request:async()=>{throw Object.assign(new Error('private server detail'),{status});}}),error=>error.code==='workspace_file_unavailable'&&!error.message.includes('private server detail'));
 }
 for(const status of [401,403,404]){
  await assert.rejects(readWorkspaceFileVersions({enabled:true,...source,request:async()=>{throw Object.assign(new Error('private server detail'),{status});}}),error=>error.code==='workspace_file_unavailable'&&!error.message.includes('private server detail'));
 }
});

test('history pages reject stale digests, mismatched paths, unordered entries and invalid continuation cursors',async()=>{
 const source=file('current');
 await assert.rejects(readWorkspaceFileVersions({enabled:true,...source,current:source,request:async()=>({items:[version(9,'different')],next_before_version:null})}),error=>error.code==='workspace_file_stale');
 await assert.rejects(readWorkspaceFileVersions({enabled:true,...source,request:async()=>({workspace_id:source.workspace_id,project_id:source.project_id,path:'other.txt',items:[],next_before_version:null})}),error=>error.code==='workspace_file_source_mismatch');
 await assert.rejects(readWorkspaceFileVersions({enabled:true,...source,request:async()=>({items:[version(8,'8'),version(9,'9')],next_before_version:null})}),error=>error.code==='workspace_file_history_invalid');
 await assert.rejects(readWorkspaceFileVersions({enabled:true,...source,request:async()=>({items:[version(8,'8')],next_before_version:9})}),error=>error.code==='workspace_file_history_invalid');
 await assert.rejects(readWorkspaceFileVersions({enabled:true,...source,request:async()=>({items:[version(8,'8')]})}),error=>error.code==='workspace_file_history_invalid');
});
