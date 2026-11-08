import test from 'node:test';import assert from 'node:assert/strict';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {build} from 'esbuild';import {mkdir} from 'node:fs/promises';
const output=new URL('../../.test-tmp/file-list-panel-tests/',import.meta.url);await mkdir(output,{recursive:true});
await build({entryPoints:[new URL('./SharedWorkspace.tsx',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],bundle:true,platform:'node',format:'esm',external:['react','react-dom'],outfile:new URL('panel.mjs',output).pathname.replace(/^\/([A-Z]:)/,'$1')});
const {WorkspaceFileListing,WorkspaceFileLifecycleHistoryListing,submitFileLifecycleCommand,WorkspaceDirectoryControls,importWorkspaceDirectory,exportWorkspaceDirectory}=await import(new URL('panel.mjs',output));
const render=(page,actions={})=>renderToStaticMarkup(React.createElement(WorkspaceFileListing,{page,disabled:false,onOpen(){},onMore(){},onRefresh(){},...actions}));
test('file UI renders every loaded path and offers explicit continuation until the last page',()=>{
 const items=Array.from({length:405},(_,i)=>({path:`file-${i}.txt`,version:1,size:1,sha256:'a'.repeat(64)}));
 items.push({path:'src/main.ts',version:2,size:10,sha256:'b'.repeat(64)},{path:'src/nested/readme.md',version:1,size:20,sha256:'c'.repeat(64)});
 const html=render({items,next_cursor:'next',loading:false,error:''});assert.match(html,/已加载 407 个文件/);assert.match(html,/加载更多文件/);assert.match(html,/file-403.txt/);assert.match(html,/role="tree"/);
 assert.match(html,/role="tree"/);assert.match(html,/role="treeitem" aria-level="1" aria-expanded="true"/);assert.match(html,/src\/nested\/readme\.md/);assert.match(html,/aria-level="3"/);
 assert.doesNotMatch(render({items,next_cursor:null,loading:false,error:''}),/加载更多文件/);
 assert.match(render({items,next_cursor:'next',loading:true,error:''}),/disabled=""/);
});

test('active file rows keep the tree and expose separate rename and delete actions',()=>{
 const html=render({items:[{path:'notes/source.md',version:2,size:8,sha256:'a'.repeat(64)}],next_cursor:null,loading:false,error:''},{onRename(){},onDelete(){},onDownload(){}});
 assert.match(html,/role="tree"/);assert.match(html,/data-tree-kind="file"/);assert.match(html,/notes\/source\.md/);
 assert.match(html,/重命名/);assert.match(html,/删除/);assert.match(html,/下载原始文件/);
});

test('directory import preserves relative paths and verifies each source receipt',async()=>{
 assert.equal(typeof importWorkspaceDirectory,'function');
 const digest='ac7fa209c616517439d0e93add6855a02d7c4340f990084224ea290315ee3bd1',bytes=Uint8Array.from([0,255,65,128]);
 const file=(path,name)=>{const value=new File([bytes],name,{type:'application/octet-stream'});Object.defineProperty(value,'webkitRelativePath',{value:path});return value;};
 const files=[file('bundle/keep.bin','keep.bin'),file('bundle/sub/new.bin','new.bin')],calls=[],progress=[];
 const result=await importWorkspaceDirectory(files,{existingFiles:[{path:'bundle/keep.bin',version:2,size:4,sha256:digest}],
  workspace:'ws-1',project:'p-1',makeKey:()=>`directory-import-${calls.length+1}`,onProgress:item=>progress.push(item.status),
  api:{importWorkspaceFileBinary:async(workspace,project,path,expected,file,key)=>{calls.push({workspace,project,path,expected,file,key});return {workspace_id:workspace,project_id:project,path,version:3,sha256:digest,size:4,source:{kind:'directory_import',relative_path:path}};}}
 });
 assert.equal(calls.length,1);assert.equal(calls[0].path,'bundle/sub/new.bin');assert.equal(calls[0].expected,0);assert.equal(calls[0].key,'directory-import-1');
 assert.deepEqual(result.receipts.map(item=>item.path),['bundle/sub/new.bin']);assert.deepEqual(result.unchanged,['bundle/keep.bin']);assert.deepEqual(progress,['unchanged','uploading','imported']);
});

test('directory export verifies pinned bytes before writing their original nested paths',async()=>{
 assert.equal(typeof exportWorkspaceDirectory,'function');
 const bytes=Uint8Array.from([0,255,65,128]),digest='ac7fa209c616517439d0e93add6855a02d7c4340f990084224ea290315ee3bd1',written=new Map();
 const directory=(path='')=>({
  async getDirectoryHandle(name){return directory(path?`${path}/${name}`:name);},
  async getFileHandle(name){const target=path?`${path}/${name}`:name;return {async createWritable(){return {async write(value){written.set(target,new Uint8Array(value));},async close(){}};}};},
 });
 const paths=await exportWorkspaceDirectory([{path:'assets/sub/photo.bin',version:3,size:4,sha256:digest}],{
  workspace:'ws-1',project:'p-1',directory:directory(),api:{readWorkspaceFileBinary:async()=>bytes},
 });
 assert.deepEqual(paths,['assets/sub/photo.bin']);assert.deepEqual([...written.get('assets/sub/photo.bin')],[0,255,65,128]);
 await assert.rejects(exportWorkspaceDirectory([{path:'bad.bin',version:3,size:4,sha256:'0'.repeat(64)}],{
  workspace:'ws-1',project:'p-1',directory:directory(),api:{readWorkspaceFileBinary:async()=>bytes},
 }),/workspace_binary_download_mismatch/);
 assert.equal(written.has('bad.bin'),false,'a digest mismatch is rejected before writing bytes');
});

test('directory import rejects file/directory path collisions before uploading',async()=>{
 const digest='ac7fa209c616517439d0e93add6855a02d7c4340f990084224ea290315ee3bd1',bytes=Uint8Array.from([0,255,65,128]),file=new File([bytes],'child.bin');
 Object.defineProperty(file,'webkitRelativePath',{value:'bundle/a/child.bin'});
 let uploads=0;
 await assert.rejects(importWorkspaceDirectory([file],{workspace:'ws-1',project:'p-1',existingFiles:[{path:'bundle/a',version:1,size:4,sha256:digest}],
  api:{importWorkspaceFileBinary:async()=>{uploads++;return {workspace_id:'ws-1',project_id:'p-1',path:'bundle/a/child.bin',version:1,sha256:digest,size:4,source:{kind:'directory_import',relative_path:'bundle/a/child.bin'}};}}
 }),/workspace_directory_path_conflict/);
 assert.equal(uploads,0);
});

test('directory export rejects file/directory path collisions before downloading or writing',async()=>{
 const digest='ac7fa209c616517439d0e93add6855a02d7c4340f990084224ea290315ee3bd1',bytes=Uint8Array.from([0,255,65,128]);let downloads=0,writes=0;
 const directory=()=>({async getDirectoryHandle(){return directory();},async getFileHandle(){return {async createWritable(){writes++;return {async write(){},async close(){}};}};}});
 await assert.rejects(exportWorkspaceDirectory([
  {path:'bundle/a',version:1,size:4,sha256:digest},{path:'bundle/a/child.bin',version:1,size:4,sha256:digest}
 ],{workspace:'ws-1',project:'p-1',directory:directory(),api:{readWorkspaceFileBinary:async()=>{downloads++;return bytes;}}}),/workspace_directory_path_conflict/);
 assert.equal(downloads,0);assert.equal(writes,0);
});

test('directory export rejects case-insensitive file aliases before downloading or writing',async()=>{
 const digest='ac7fa209c616517439d0e93add6855a02d7c4340f990084224ea290315ee3bd1';let downloads=0,writes=0;
 const directory=()=>({async getDirectoryHandle(){return directory();},async getFileHandle(){return {async createWritable(){writes++;return {async write(){},async close(){}};}};}});
 await assert.rejects(exportWorkspaceDirectory([
  {path:'A.bin',version:1,size:4,sha256:digest},{path:'a.bin',version:1,size:4,sha256:digest}
 ],{workspace:'ws-1',project:'p-1',directory:directory(),api:{readWorkspaceFileBinary:async()=>{downloads++;return Uint8Array.from([0,255,65,128]);}}}),/workspace_directory_path_conflict/);
 assert.equal(downloads,0);assert.equal(writes,0);
});

test('directory export rejects case-insensitive file/directory aliases before downloading or writing',async()=>{
 const digest='ac7fa209c616517439d0e93add6855a02d7c4340f990084224ea290315ee3bd1';let downloads=0,writes=0;
 const directory=()=>({async getDirectoryHandle(){return directory();},async getFileHandle(){return {async createWritable(){writes++;return {async write(){},async close(){}};}};}});
 await assert.rejects(exportWorkspaceDirectory([
  {path:'Bundle',version:1,size:4,sha256:digest},{path:'bundle/child.bin',version:1,size:4,sha256:digest}
 ],{workspace:'ws-1',project:'p-1',directory:directory(),api:{readWorkspaceFileBinary:async()=>{downloads++;return Uint8Array.from([0,255,65,128]);}}}),/workspace_directory_path_conflict/);
 assert.equal(downloads,0);assert.equal(writes,0);
});

test('directory export does not start a local write when its download finishes after cancellation',async()=>{
 const bytes=Uint8Array.from([0,255,65,128]),digest='ac7fa209c616517439d0e93add6855a02d7c4340f990084224ea290315ee3bd1',controller=new AbortController();let handles=0,writes=0,closes=0,aborts=0;
 const directory=()=>({async getDirectoryHandle(){return directory();},async getFileHandle(){handles++;return {async createWritable(){return {async write(){writes++;},async close(){closes++;},async abort(){aborts++;}};}};}});
 await assert.rejects(exportWorkspaceDirectory([{path:'bundle/photo.bin',version:1,size:4,sha256:digest}],{
  workspace:'ws-1',project:'p-1',directory:directory(),signal:controller.signal,
  api:{readWorkspaceFileBinary:async()=>{controller.abort();return bytes;}}
 }),error=>error?.name==='AbortError');
 assert.equal(handles,0);assert.equal(writes,0);assert.equal(closes,0);assert.equal(aborts,0);
});

test('directory export aborts an open local writer when cancellation arrives during write',async()=>{
 const bytes=Uint8Array.from([0,255,65,128]),digest='ac7fa209c616517439d0e93add6855a02d7c4340f990084224ea290315ee3bd1',controller=new AbortController();let writes=0,closes=0,aborts=0,committed=false;
 const directory=()=>({async getDirectoryHandle(){return directory();},async getFileHandle(){return {async createWritable(){return {async write(){writes++;controller.abort();},async close(){closes++;committed=true;},async abort(){aborts++;}};}};}});
 await assert.rejects(exportWorkspaceDirectory([{path:'bundle/photo.bin',version:1,size:4,sha256:digest}],{
  workspace:'ws-1',project:'p-1',directory:directory(),signal:controller.signal,api:{readWorkspaceFileBinary:async()=>bytes}
 }),error=>error?.name==='AbortError');
 assert.equal(writes,1);assert.equal(closes,0);assert.equal(aborts,1);assert.equal(committed,false);
});

test('directory export aborts a newly opened local writer when cancellation arrives during creation',async()=>{
 const bytes=Uint8Array.from([0,255,65,128]),digest='ac7fa209c616517439d0e93add6855a02d7c4340f990084224ea290315ee3bd1',controller=new AbortController();let closes=0,aborts=0;
 const directory=()=>({async getDirectoryHandle(){return directory();},async getFileHandle(){return {async createWritable(){controller.abort();return {async write(){},async close(){closes++;},async abort(){aborts++;}};}};}});
 await assert.rejects(exportWorkspaceDirectory([{path:'bundle/photo.bin',version:1,size:4,sha256:digest}],{
  workspace:'ws-1',project:'p-1',directory:directory(),signal:controller.signal,api:{readWorkspaceFileBinary:async()=>bytes}
 }),error=>error?.name==='AbortError');
 assert.equal(closes,0);assert.equal(aborts,1);
});

test('directory controls expose accessible folder import and folder export actions',()=>{
 assert.equal(typeof WorkspaceDirectoryControls,'function');
 const html=renderToStaticMarkup(React.createElement(WorkspaceDirectoryControls,{disabled:false,importing:false,exporting:false,onImport(){},onExport(){}}));
 assert.match(html,/导入目录/);assert.match(html,/webkitdirectory/);assert.match(html,/导出项目目录/);
});

test('lifecycle history is a separate paginated list of original receipts with paths and traceable commands',()=>{
 assert.equal(typeof WorkspaceFileLifecycleHistoryListing,'function');
 const item={protocol:1,action:'rename',command_key:'history-command-001',project_id:'project-1',workspace_id:'ws-1',
  source:{path:'old/name.md',version:2,sha256:'a'.repeat(64),size:8,updated_at:'2026-10-23T08:00:00.000Z'},source_refs:[],
  target:{path:'new/final.md',version:1,sha256:'a'.repeat(64),size:8},target_refs:[],preview_sha256:'b'.repeat(64),applied_at:'2026-10-23T08:01:00.000Z'};
 const html=renderToStaticMarkup(React.createElement(WorkspaceFileLifecycleHistoryListing,{page:{items:[item],next_cursor:'next',loading:false,error:''},onMore(){},onRefresh(){},onPreviewSource(){}}));
 assert.match(html,/文件操作历史/);assert.match(html,/old\/name\.md/);assert.match(html,/new\/final\.md/);assert.match(html,/history-command-001/);assert.match(html,/b{64}/);assert.match(html,/预览历史版本/);assert.match(html,/加载更多历史/);assert.doesNotMatch(html,/role="tree"/);assert.doesNotMatch(html,/receipt_sha256/);
});

test('lost lifecycle apply acknowledgement reconciles by status without replaying the mutation',async()=>{
 assert.equal(typeof submitFileLifecycleCommand,'function');
 const command={action:'rename',workspace_id:'ws-1',project_id:'project-1',path:'old/name.md',source_sha256:'a'.repeat(64),target_path:'new/final.md',target_version:1,expected_version:2,preview_sha256:'b'.repeat(64),command_key:'history-command-001',body:{project_id:'project-1',path:'old/name.md',target_path:'new/final.md',expected_version:2,preview_sha256:'b'.repeat(64)}};
 const receipt={protocol:1,action:'rename',command_key:command.command_key,project_id:command.project_id,workspace_id:command.workspace_id,
  source:{path:command.path,version:2,sha256:'a'.repeat(64),size:8,updated_at:'2026-10-23T08:00:00.000Z'},source_refs:[],
  target:{path:command.target_path,version:1,sha256:'a'.repeat(64),size:8},target_refs:[],preview_sha256:command.preview_sha256,applied_at:'2026-10-23T08:01:00.000Z'};
 let applyCalls=0,statusCalls=0;
 const result=await submitFileLifecycleCommand(command,{apply:async input=>{applyCalls++;assert.deepEqual(input,command);throw new Error('request timed out')},status:async input=>{statusCalls++;assert.equal(input.command_key,command.command_key);return {state:'applied',receipt}}});
 assert.deepEqual(result,{state:'applied',receipt,reconciled:true});assert.equal(applyCalls,1);assert.equal(statusCalls,1);
});

test('not-applied and unreadable lifecycle status never trigger an automatic second apply',async()=>{
 assert.equal(typeof submitFileLifecycleCommand,'function');
 const command={action:'delete',workspace_id:'ws-1',project_id:'project-1',path:'removed.md',source_sha256:'a'.repeat(64),expected_version:1,preview_sha256:'b'.repeat(64),command_key:'history-delete-001',body:{project_id:'project-1',path:'removed.md',expected_version:1,preview_sha256:'b'.repeat(64)}};
 let applyCalls=0,statusCalls=0;
 const notApplied=await submitFileLifecycleCommand(command,{apply:async()=>{applyCalls++;throw new Error('connection lost')},status:async()=>{statusCalls++;return {state:'not_applied'}}});
 assert.equal(notApplied.state,'not_applied');assert.equal(applyCalls,1);assert.equal(statusCalls,1);
 const unknown=await submitFileLifecycleCommand(command,{apply:async()=>{applyCalls++;throw new Error('connection lost')},status:async()=>{statusCalls++;throw new Error('status unavailable')}});
 assert.equal(unknown.state,'unknown');assert.equal(applyCalls,2);assert.equal(statusCalls,2);
 const corrupt=await submitFileLifecycleCommand(command,{apply:async()=>{applyCalls++;throw new Error('connection lost')},status:async()=>{statusCalls++;return {state:'applied',receipt:{protocol:1,action:'delete',command_key:command.command_key,project_id:command.project_id,workspace_id:command.workspace_id}}}});
 assert.equal(corrupt.state,'unknown');assert.equal(applyCalls,3);assert.equal(statusCalls,3);
});
