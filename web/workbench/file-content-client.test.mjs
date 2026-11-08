import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readWorkspaceFile} from './file-content-client.mjs';

const content='const answer = 42;';
const sha256=createHash('sha256').update(content,'utf8').digest('hex');
const response={path:'src/main.ts',version:4,sha256,size:Buffer.byteLength(content),updated_at:'2026-10-21T01:00:00.000Z',content};

test('current-file reads preserve workspace/project scope and verify the selected list version',async()=>{
 const controller=new AbortController(),calls=[];
 const file=await readWorkspaceFile({request:async(...args)=>{calls.push(args);return response;},workspace_id:'ws one',project_id:'project-one',path:'src/main.ts',version:4,sha256},controller.signal);
 assert.deepEqual(file,{...response,workspace_id:'ws one',project_id:'project-one'});
 assert.equal(calls.length,1);
 const [path,method,body,key,signal]=calls[0],url=new URL(path,'https://jot.invalid');
 assert.equal(url.pathname,'/workspaces/ws%20one/files/content');
 assert.equal(url.searchParams.get('project_id'),'project-one');
 assert.equal(url.searchParams.get('path'),'src/main.ts');
 assert.equal(url.searchParams.get('version'),'4');
 assert.equal(method,'GET');assert.equal(body,undefined);assert.equal(key,undefined);assert.equal(signal,controller.signal);
});

test('historical-file reads pin a version and reject a response from another version or digest',async()=>{
 const call=[];
 const historical={...response,version:2,updated_at:'2026-10-20T01:00:00.000Z'};
 const file=await readWorkspaceFile({request:async(path)=>{call.push(path);return historical;},workspace_id:'ws-one',project_id:'project-one',path:'src/main.ts',version:2},new AbortController().signal);
 assert.equal(new URL(call[0],'https://jot.invalid').searchParams.get('version'),'2');
 assert.equal(file.version,2);
 await assert.rejects(readWorkspaceFile({request:async()=>response,workspace_id:'ws-one',project_id:'project-one',path:'src/main.ts',version:2},new AbortController().signal),/workspace_file_source_mismatch/);
 await assert.rejects(readWorkspaceFile({request:async()=>({...response,sha256:'c'.repeat(64)}),workspace_id:'ws-one',project_id:'project-one',path:'src/main.ts',version:4,sha256},new AbortController().signal),/workspace_file_source_mismatch/);
});

test('invalid host paths fail before any file request is made',async()=>{
 let requested=false;
 await assert.rejects(readWorkspaceFile({request:async()=>{requested=true;return response;},workspace_id:'ws-one',project_id:'project-one',path:'C:/private/.env'},new AbortController().signal),/workspace_path_unsafe/);
 assert.equal(requested,false);
});
