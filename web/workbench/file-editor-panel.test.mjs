import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToString} from 'react-dom/server';
import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';

const output=new URL('../../.test-tmp/file-editor-panel-tests/',import.meta.url);
await mkdir(output,{recursive:true});
await build({entryPoints:[new URL('./FileEditorPanel.tsx',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],bundle:true,platform:'node',format:'esm',external:['react','react-dom'],outfile:new URL('panel.mjs',output).pathname.replace(/^\/([A-Z]:)/,'$1')});
const {WorkspaceFileEditor}=await import(new URL('panel.mjs',output));

const noop=()=>{};
const state={workspace_id:'ws-one',project_id:'project-one',path:'notes/new.txt',base_path:'notes/new.txt',base_version:0,base_sha256:null,base_content:'',draft_content:'new file text',reviewing:true,apply_confirmed:true,conflict:null};
const render=(change={})=>renderToString(React.createElement(WorkspaceFileEditor,{file:null,state,preview:{kind:'text',text:'',truncated:false},canWrite:true,busy:false,mutationPending:false,historical:false,historyVersion:'',restoreCandidates:[],historyEnabled:false,rangeEnabled:false,historyItems:[],historyNextBeforeVersion:null,historyLoading:false,historyError:'',rangeLoading:false,rangeError:'',rangeRead:null,selectedHistoryVersion:null,onDraft:noop,onRequestApply:noop,onConfirmApply:noop,onSave:noop,onClose:noop,onHistoryVersion:noop,onReadKnownVersion:noop,onLoadHistory:noop,onLoadMoreHistory:noop,onRetryHistory:noop,onReadVersion:noop,onReadVersionByRange:noop,onLoadNextRange:noop,onLoadLatest:noop,onRebase:noop,onRestoreDraft:noop,onDiscardDraft:noop,...change}));

test('the editor lists separate restore and discard actions for each saved file draft',()=>{
 const html=render({state:null,restoreCandidates:[
  {owner_scope:'a'.repeat(64),workspace_id:'ws-one',project_id:'project-one',path:'notes/draft-a.txt',base_version:1},
  {owner_scope:'a'.repeat(64),workspace_id:'ws-one',project_id:'project-one',path:'notes/draft-b.txt',base_version:0},
 ]});
 assert.match(html,/aria-label="可恢复的文件草稿"/);
 assert.match(html,/恢复草稿 notes\/draft-a\.txt/);
 assert.match(html,/丢弃草稿 notes\/draft-a\.txt/);
 assert.match(html,/恢复草稿 notes\/draft-b\.txt/);
 assert.match(html,/丢弃草稿 notes\/draft-b\.txt/);
});

test('a draft path collision offers target restore, a new path, and explicit target discard',()=>{
 const html=render({state:{...state,path:'notes/draft-b.txt',base_version:0},restoreCandidates:[
  {owner_scope:'a'.repeat(64),workspace_id:'ws-one',project_id:'project-one',path:'notes/draft-a.txt',base_version:0},
  {owner_scope:'a'.repeat(64),workspace_id:'ws-one',project_id:'project-one',path:'notes/draft-b.txt',base_version:0},
 ],pathCollision:{source_path:'notes/draft-a.txt',target:{owner_scope:'a'.repeat(64),workspace_id:'ws-one',project_id:'project-one',path:'notes/draft-b.txt',base_version:0}}});
 assert.match(html,/目标路径 <strong>notes\/draft-b\.txt<\/strong> 已有另一份会话草稿/);
 assert.match(html,/恢复目标草稿/);
 assert.match(html,/改用其他路径/);
 assert.match(html,/丢弃目标草稿并继续改名/);
});

test('uncertain file saves keep an enabled retry action while freezing the editor',()=>{
 const html=render({mutationPending:true});
 assert.match(html,/<fieldset class="wb-input-fields" disabled=""/);
 assert.match(html,/<button class="wb-primary" type="submit">重试原保存<\/button>/);
 assert.doesNotMatch(html,/应用保存（v0）/);
});

test('file save remains a normal apply action when no receipt is pending',()=>{
 const html=render();
 assert.match(html,/<button class="wb-primary" type="submit">应用保存（v0）<\/button>/);
});

test('version history and range-read entries are disabled until their server capabilities are advertised',()=>{
 const file={workspace_id:'ws',project_id:'project',path:'notes/a.txt',version:4,size:5,sha256:'a'.repeat(64),content:'text'};
 const noHistory=render({file,state:null});
 assert.match(noHistory,/读取已知版本（1 至 v<!-- -->4<!-- -->）/);
 assert.match(noHistory,/>只读查看已知版本</);
 assert.match(noHistory,/<button type="button" disabled="" title="服务端尚未声明版本历史能力">加载版本历史<\/button>/);
 assert.match(noHistory,/版本目录能力，此入口已禁用/);
 const historyOnly=render({file,state:null,historyEnabled:true,rangeEnabled:false,historyItems:[{workspace_id:'ws',project_id:'project',path:'notes/a.txt',version:3,size:4,sha256:'b'.repeat(64),created_at:'2026-10-21T00:00:00Z'}]});
 assert.match(historyOnly,/<button type="button" disabled="" title="服务端尚未声明范围读取能力">分段读取<\/button>/);
});

test('advertised immutable history renders scoped version metadata, continuation, and enabled range actions',()=>{
 const html=render({file:{workspace_id:'ws',project_id:'project',path:'notes/a.txt',version:4,size:5,sha256:'a'.repeat(64),content:'text'},state:null,historyEnabled:true,rangeEnabled:true,historyItems:[{workspace_id:'ws',project_id:'project',path:'notes/a.txt',version:3,size:4,sha256:'b'.repeat(64),created_at:'2026-10-21T00:00:00Z'}],historyNextBeforeVersion:3});
 assert.match(html,/文件版本列表/);
 assert.match(html,/<strong>v<!-- -->3<\/strong>/);
 assert.match(html,/SHA-256 <code>b{64}<\/code>/);
 assert.match(html,/>只读查看</);
 assert.match(html,/>分段读取</);
 assert.match(html,/>加载更多版本</);
});

test('range preview exposes loaded byte progress, resumable next-range action, and final digest verification',()=>{
 const file={workspace_id:'ws',project_id:'project',path:'notes/a.txt',version:4,size:5,sha256:'a'.repeat(64),content:'abc'};
 const partial=render({file,state:null,historical:true,preview:{kind:'text',text:'abc',truncated:true},rangeRead:{loaded_bytes:3,total_bytes:5,complete:false,verified:false}});
 assert.match(partial,/已加载 3 \/ 5 B/);
 assert.match(partial,/加载下一段（最多 64 KiB）/);
 const complete=render({file,state:null,historical:true,preview:{kind:'text',text:'abcde',truncated:false},rangeRead:{loaded_bytes:5,total_bytes:5,complete:true,verified:true}});
 assert.match(complete,/已读取完整版本并通过 SHA-256 校验/);
});
