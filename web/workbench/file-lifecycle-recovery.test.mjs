import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
import {readPendingFileLifecycleCommand,readPendingFileLifecycleDialog,persistPendingFileLifecycleCommand,clearPendingFileLifecycleCommand,reconcileFileLifecycleCommand} from './file-lifecycle-flow.mjs';

const output=new URL('../../.test-tmp/file-lifecycle-recovery-tests/',import.meta.url);await mkdir(output,{recursive:true});
await build({entryPoints:[new URL('./WorkspaceFileLifecycleReview.tsx',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],bundle:true,platform:'node',format:'esm',external:['react','react-dom'],outfile:new URL('review.mjs',output).pathname.replace(/^\/([A-Z]:)/,'$1')});
const {WorkspaceFileLifecycleReview}=await import(new URL('review.mjs',output));

const scope={owner_scope:'owner-1',workspace_id:'ws-1',project_id:'project-1'};
const command={action:'rename',workspace_id:'ws-1',project_id:'project-1',path:'docs/old.md',source_sha256:'a'.repeat(64),target_path:'docs/new.md',target_version:1,expected_version:2,preview_sha256:'b'.repeat(64),command_key:'lifecycle-recovery-001',body:{project_id:'project-1',path:'docs/old.md',target_path:'docs/new.md',expected_version:2,preview_sha256:'b'.repeat(64)}};
const memoryStorage=()=>{const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key),values};};

test('reload restores the exact pending lifecycle command only in its owner/workspace/project scope',()=>{
 const storage=memoryStorage();
 assert.equal(persistPendingFileLifecycleCommand(storage,scope,command),true);
 assert.deepEqual(readPendingFileLifecycleCommand(storage,scope),command);
 assert.equal(readPendingFileLifecycleCommand(storage,{...scope,owner_scope:'owner-2'}),null);
 assert.equal(readPendingFileLifecycleCommand(storage,{...scope,project_id:'project-2'}),null);
});

test('pending storage rejects extra command metadata and stores only scoped identities',()=>{
 const storage=memoryStorage();
 const sentinel='PRIVATE_FILE_CONTENT_SENTINEL';
 assert.equal(persistPendingFileLifecycleCommand(storage,scope,{...command,content:sentinel}),false);
 assert.equal(persistPendingFileLifecycleCommand(storage,scope,{...command,metadata:{content:sentinel}}),false);
 assert.equal(storage.values.size,0);
 const extendedScope={...scope,content:sentinel,metadata:{content:sentinel}};
 assert.equal(persistPendingFileLifecycleCommand(storage,extendedScope,command),true);
 const [key,raw]=[...storage.values.entries()][0];
 const record=JSON.parse(raw);
 assert.deepEqual(Object.keys(record).sort(),['command','owner_scope','project_id','schema','workspace_id'].sort());
 assert.doesNotMatch(raw,new RegExp(sentinel));
 assert.deepEqual(readPendingFileLifecycleCommand(storage,scope),command);
 storage.setItem(key,JSON.stringify({...record,command:{...command,content:sentinel}}));
 assert.equal(readPendingFileLifecycleCommand(storage,scope),null);
 storage.setItem(key,JSON.stringify({...record,content:sentinel}));
 assert.equal(readPendingFileLifecycleCommand(storage,scope),null);
});

test('reload rebuilds only the source file identity needed by the review dialog',()=>{
 const storage=memoryStorage();assert.equal(persistPendingFileLifecycleCommand(storage,scope,command),true);
 const dialog=readPendingFileLifecycleDialog(storage,scope);
 assert.deepEqual(dialog,{action:'rename',file:{path:'docs/old.md',version:2,sha256:'a'.repeat(64)},resumeCommand:command});
 assert.equal('content' in dialog.file,false);
});

test('malformed command metadata cannot overwrite an existing pending operation',()=>{
 const storage=memoryStorage();
 assert.equal(persistPendingFileLifecycleCommand(storage,scope,command),true);
 assert.equal(persistPendingFileLifecycleCommand(storage,scope,{...command,body:{...command.body,target_path:'other.md'}}),false);
 assert.equal(persistPendingFileLifecycleCommand(storage,scope,{...command,command_key:'lifecycle-recovery-002'}),false);
 assert.deepEqual(readPendingFileLifecycleCommand(storage,scope),command);
});

test('restored not-applied command queries status with its original key/body and does not submit',async()=>{
 const storage=memoryStorage();assert.equal(persistPendingFileLifecycleCommand(storage,scope,command),true);
 const restored=readPendingFileLifecycleCommand(storage,scope);let statusCalls=0;const observed=[];
 const result=await reconcileFileLifecycleCommand(restored,async input=>{statusCalls++;observed.push(input);return {state:'not_applied'};});
 assert.equal(result.state,'not_applied');assert.equal(statusCalls,1);assert.deepEqual(observed,[command]);
 assert.deepEqual(readPendingFileLifecycleCommand(storage,scope),command);
});

test('restored review shows status recovery instead of the initial confirm action',()=>{
 const html=renderToStaticMarkup(React.createElement(WorkspaceFileLifecycleReview,{workspace:scope.workspace_id,project:scope.project_id,
  ownerScope:scope.owner_scope,file:{path:command.path,version:command.expected_version,sha256:command.source_sha256},action:command.action,
  canWrite:true,resumeCommand:command,onClose(){},onApplied(){}}));
 assert.match(html,/重新查询操作状态/);
 assert.doesNotMatch(html,/确认重命名/);
});

test('only the matching command can clear the stored lifecycle intent',()=>{
 const storage=memoryStorage();assert.equal(persistPendingFileLifecycleCommand(storage,scope,command),true);
 assert.equal(clearPendingFileLifecycleCommand(storage,scope,'another-command'),false);
 assert.deepEqual(readPendingFileLifecycleCommand(storage,scope),command);
 assert.equal(clearPendingFileLifecycleCommand(storage,scope,command.command_key),true);
 assert.equal(readPendingFileLifecycleCommand(storage,scope),null);
});
