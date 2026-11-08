import test from 'node:test';
import assert from 'node:assert/strict';
import {build as buildEsbuild} from 'esbuild';
import {chromium} from 'playwright';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TaskSaveReceipt} from './task-save.mjs';

const api=await import('./checkpoint-restore-draft.mjs').catch(error=>{if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;return {}});
const scope='a'.repeat(64),url='/workspaces/ws/checkpoints/checkpoint-1/restore';
const body={project_id:'project-1',path:'notes/a.md',review_id:'review-1',review_sha256:'b'.repeat(64)};
const memory=()=>{const data=new Map();return{data,getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)}};

test('lost restore response and busy retry retain the same scoped command across reload',async()=>{
 assert.equal(typeof api.CheckpointRestoreDraftStore,'function');assert.equal(typeof api.checkpointRestoreTransport,'function');
 const storage=memory(),calls=[];
 const send=api.checkpointRestoreTransport(async(path,method,input,key)=>{calls.push({path,method,input,key});if(calls.length===1)throw Error('synthetic_lost_response');if(calls.length===2)throw Object.assign(Error('WORKSPACE_CHECKPOINT_RESTORE_BUSY'),{status:409});return{operation_id:'original-operation',outcome:'applied'};});
 const first=new TaskSaveReceipt(()=> 'original-key',new api.CheckpointRestoreDraftStore(()=>storage,scope,'ws'));
 await assert.rejects(first.submit(send,url,'POST',body),/synthetic_lost_response/);
 const store=new api.CheckpointRestoreDraftStore(()=>storage,scope,'ws'),restored=new TaskSaveReceipt(()=> 'must-not-replace-key',store);
 assert.equal(restored.pending,true);assert.equal(calls.length,1,'loading a draft must not send anything');
 await assert.rejects(restored.submit(send,'/wrong','DELETE',{wrong:true}),/WORKSPACE_CHECKPOINT_RESTORE_BUSY/);
 assert.equal(restored.pending,true);assert.equal(store.read().command.key,'original-key');
 const result=await restored.submit(send,'/wrong','POST',{});assert.equal(result.operation_id,'original-operation');
 assert.deepEqual(calls,[calls[0],calls[0],calls[0]]);assert.equal(restored.pending,false);assert.equal(storage.data.size,0);
});

test('restore drafts are scope bound metadata and reject malformed or replaced pending hints',()=>{
 assert.equal(typeof api.CheckpointRestoreDraftStore,'function');
 const storage=memory(),store=new api.CheckpointRestoreDraftStore(()=>storage,scope,'ws');
 const command={path:url,method:'POST',body,key:'original-key'};store.saveCommand(command);
 assert.equal(new api.CheckpointRestoreDraftStore(()=>storage,'c'.repeat(64),'ws').read(),null);
 assert.equal(new api.CheckpointRestoreDraftStore(()=>storage,scope,'other-workspace').read(),null);
 assert.throws(()=>store.saveCommand({...command,body:{...body,path:'../outside'}}),/CHECKPOINT_RESTORE_DRAFT_INVALID/);
 assert.throws(()=>store.saveCommand({...command,key:null}),/CHECKPOINT_RESTORE_DRAFT_INVALID/);
 assert.throws(()=>store.saveCommand({...command,key:'replacement-key'}),/CHECKPOINT_RESTORE_DRAFT_CONFLICT/);
 const [name]=storage.data.keys();storage.data.set(name,'tampered');
 const damaged=new api.CheckpointRestoreDraftStore(()=>storage,scope,'ws');assert.equal(damaged.read(),null);assert.equal(damaged.issue,'CHECKPOINT_RESTORE_DRAFT_INVALID');
 assert.throws(()=>damaged.saveCommand(command),/CHECKPOINT_RESTORE_DRAFT_INVALID/);assert.equal(storage.data.get(name),'tampered');
});

test('storage failure prevents dispatch and restore errors never stand in for a journal outcome',async()=>{
 assert.equal(typeof api.CheckpointRestoreDraftStore,'function');
 let sends=0;const storage=memory();storage.setItem=()=>{throw Error('synthetic_storage_denied')};
 const receipt=new TaskSaveReceipt(()=> 'key',new api.CheckpointRestoreDraftStore(()=>storage,scope,'ws'));
 await assert.rejects(receipt.submit(async()=>{sends++;},url,'POST',body),/synthetic_storage_denied/);assert.equal(sends,0);
 const retained=memory(),store=new api.CheckpointRestoreDraftStore(()=>retained,scope,'ws'),rejected=new TaskSaveReceipt(()=> 'key',store);
 await assert.rejects(rejected.submit(api.checkpointRestoreTransport(async()=>{throw Object.assign(Error('PROJECT_NOT_FOUND'),{status:404});}),url,'POST',body),/PROJECT_NOT_FOUND/);
 assert.equal(rejected.pending,true);assert.equal(retained.data.size,1,'an error alone cannot prove the original restore has no journal or effect');
 const ordinary=new TaskSaveReceipt(()=> 'ordinary-key',new api.CheckpointRestoreDraftStore(()=>memory(),scope,'ws'));
 await assert.rejects(ordinary.submit(api.checkpointRestoreTransport(async()=>{throw Object.assign(Error('VERSION_CONFLICT'),{status:409});}),'/workspaces/ws/files','PUT',{}),/VERSION_CONFLICT/);
 assert.equal(ordinary.pending,false,'other file commands retain their existing rejection semantics');
});

test('another tab cannot replace the original pending restore and have its hint erased by completion',()=>{
 const storage=memory(),store=new api.CheckpointRestoreDraftStore(()=>storage,scope,'ws');
 store.saveCommand({path:url,method:'POST',body,key:'original-key'});
 const [name]=storage.data.keys(),replacement=JSON.parse(storage.data.get(name));replacement.command.key='other-key';storage.data.set(name,JSON.stringify(replacement));
 assert.equal(store.read(),null);assert.equal(store.issue,'CHECKPOINT_RESTORE_DRAFT_CONFLICT');
 assert.throws(()=>store.complete(),/CHECKPOINT_RESTORE_DRAFT_CONFLICT/);assert.equal(JSON.parse(storage.data.get(name)).command.key,'other-key');
});

test('ordinary file saves keep their existing volatile receipt without persisting file contents',()=>{
 const storage=memory(),store=new api.CheckpointRestoreDraftStore(()=>storage,scope,'ws');
 store.saveCommand({path:'/workspaces/ws/files',method:'PUT',body:{project_id:'project-1',path:'note.txt',content:'private draft',expected_version:1},key:'file-key'});
 assert.equal(storage.data.size,0);assert.equal(store.read(),null);
});


test('recovery reads only the frozen scoped command and absence never clears its hint',async()=>{
 const storage=memory(),store=new api.CheckpointRestoreDraftStore(storage,scope,'ws');
 const command={path:url,method:'POST',body,key:'original-key'};store.saveCommand(command);
 const calls=[];
 const value=await api.readCheckpointRestoreCommand(command,'ws',async(...args)=>{calls.push(args);return {state:'unobserved',command_key:command.key,request_sha256:'c'.repeat(64)}});
 assert.equal(value.state,'unobserved');assert.equal(calls.length,1);assert.equal(calls[0].length,1,'no mutation method or payload');
 const parsed=new URL(calls[0][0],'https://fixture.invalid');assert.match(parsed.pathname,/restore-requests\/original-key$/);assert.deepEqual(Object.fromEntries(parsed.searchParams),body);
 assert.equal(store.read().command.key,command.key);
 await assert.rejects(api.readCheckpointRestoreCommand(command,'ws',async()=>({state:'terminal_rejected',no_effect:true,reason:'workspace_checkpoint_review_changed',command_key:'foreign-key',request_sha256:'c'.repeat(64)})),/STATUS_INVALID/);
 assert.equal(store.read().command.key,command.key);
});

test('recovery accepts a terminal no-effect disposition but rejects an unlinked settled receipt',async()=>{
 const command={path:url,method:'POST',body,key:'original-key'},base={command_key:command.key,request_sha256:'c'.repeat(64)};
 const status=await api.readCheckpointRestoreCommand(command,'ws',async()=>({...base,state:'terminal_rejected',no_effect:true,reason:'workspace_checkpoint_review_changed'}));
 assert.equal(status.no_effect,true);
 await assert.rejects(api.readCheckpointRestoreCommand(command,'ws',async()=>({...base,state:'settled',receipt:{protocol:1,checkpoint_id:'foreign',path:body.path,outcome:'applied'}})),/STATUS_INVALID/);
});

test('checkpoint restore review traps focus and safely dismisses the pending original command',{timeout:90_000},async()=>{
 const repositoryRoot=resolve(fileURLToPath(new URL('../..',import.meta.url))),componentPath=resolve(repositoryRoot,'web/workbench/CheckpointRestoreRecovery.tsx');
 const entry=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Recovery from ${JSON.stringify(componentPath)};
 const review={checkpoint_id:'checkpoint-1',path:'notes/a.md',review_id:'review-1',review_sha256:'b'.repeat(64),before:{kind:'absent'},target:{kind:'absent'}};
 function App(){const [open,setOpen]=useState(false),[pending,setPending]=useState(false);window.__showReview=()=>setOpen(true);return React.createElement(React.Fragment,null,
  React.createElement('section',{'aria-label':'项目文件检查点'},React.createElement('h3',{id:'fallback'},'项目检查点'),React.createElement('button',{id:'opener',onClick:()=>setOpen(true)},'检查恢复内容'),
   React.createElement(Recovery,{workspace:'ws',project:'project',review:open?review:null,canWrite:true,onClose:()=>{window.__closed=(window.__closed??0)+1;setOpen(false)},onPending:value=>{setPending(value);window.__restorePending=value},onApplied:()=>{}}),
   React.createElement('span',{id:'pending-value'},String(pending))));}
 createRoot(document.getElementById('root')).render(React.createElement(App));`;
 const bundle=await buildEsbuild({stdin:{sourcefile:'m14-checkpoint-restore-ui.tsx',resolveDir:repositoryRoot,loader:'tsx',contents:entry},absWorkingDir:repositoryRoot,bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',logLevel:'silent',plugins:[{name:'mock-jot-client',setup(build){build.onResolve({filter:/\.\.\/jot\/client$/},()=>({path:'mock-jot-client',namespace:'restore-ui'}));build.onLoad({filter:/.*/,namespace:'restore-ui'},()=>({contents:'export const taskDraftScope=()=>window.__scope;export const request=(...args)=>window.__request(...args);',loader:'js'}));}}]});
 const browser=await chromium.launch({headless:true,executablePath:process.env.JOT_WORKBENCH_CHROME_PATH??'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
 try{
  const page=await browser.newPage(),browserErrors=[];page.on('pageerror',error=>browserErrors.push(error.message));page.on('console',message=>{if(message.type()==='error')browserErrors.push(message.text())});await page.setContent('<main><div id="root"></div></main>');
  await page.evaluate(()=>{window.__scope='a'.repeat(64);Object.defineProperty(window.crypto,'randomUUID',{configurable:true,value:()=> 'synthetic-restore-id'});window.__store=new Map();Object.defineProperty(window,'sessionStorage',{configurable:true,value:{getItem:key=>window.__store.get(key)??null,setItem:(key,value)=>window.__store.set(key,value),removeItem:key=>window.__store.delete(key)}});window.__calls=[];window.__dispatchCount=0;window.__getCount=0;window.__getResolvers=[];window.__request=(path,method,body,key)=>{window.__calls.push({path,method:method??null,key:key??null});if(method==='POST'){window.__dispatchCount++;window.__originalKey=key;return new Promise(resolve=>{window.__resolvePost=resolve})}window.__getCount++;return new Promise(resolve=>window.__getResolvers.push(resolve))};});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const dialog=page.getByRole('alertdialog');await page.getByRole('button',{name:'检查恢复内容'}).click();await dialog.waitFor();
  assert.equal(await dialog.getAttribute('aria-modal'),'true');
  await page.waitForFunction(()=>document.activeElement?.id==='restore-cancel');
  await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement?.id),'restore-confirm');
  await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement?.id),'restore-cancel');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});await page.waitForFunction(()=>document.activeElement?.id==='opener');
  assert.equal(await page.evaluate(()=>window.__dispatchCount),0);
  await page.evaluate(()=>window.__showReview());await dialog.waitFor();await page.evaluate(()=>document.getElementById('opener').remove());await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  await page.waitForFunction(()=>document.activeElement?.id==='fallback');
  await page.evaluate(()=>window.__showReview());await dialog.waitFor();await page.getByRole('button',{name:'确认恢复此路径'}).click();
  await page.getByText(/原恢复命令待确认/).waitFor({timeout:5000});await page.waitForFunction(()=>window.__dispatchCount===1&&window.__store.size===1);
  assert.equal(await page.evaluate(()=>window.__getCount),0);assert.equal(await page.evaluate(()=>document.activeElement?.id),'restore-pending');
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'继续查看原恢复回执'}).waitFor();await page.waitForFunction(()=>document.activeElement?.textContent==='继续查看原恢复回执');
  assert.equal(await page.evaluate(()=>window.__store.size),1);assert.equal(await page.evaluate(()=>window.__dispatchCount),1);
  await page.getByRole('button',{name:'继续查看原恢复回执'}).click();await page.waitForFunction(()=>document.activeElement?.id==='restore-pending');
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'继续查看原恢复回执'}).waitFor();
  await page.evaluate(()=>window.__resolvePost({accepted:true}));await page.waitForFunction(()=>window.__getCount===1);
  await page.getByRole('button',{name:'继续查看原恢复回执'}).click();await page.waitForFunction(()=>document.activeElement?.id==='restore-pending');
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'继续查看原恢复回执'}).waitFor();
  await page.evaluate(()=>window.__getResolvers[0]({state:'unobserved',command_key:window.__originalKey,request_sha256:'c'.repeat(64)}));
  assert.equal(await page.evaluate(()=>window.__store.size),1);assert.equal(await page.evaluate(()=>window.__dispatchCount),1);assert.equal(await page.evaluate(()=>window.__getCount),1);
  await page.getByRole('button',{name:'继续查看原恢复回执'}).click();await page.getByText(/尚未观察到原请求终态/).waitFor();
  assert.equal(await page.evaluate(()=>window.__store.size),1);assert.equal(await page.evaluate(()=>window.__dispatchCount),1);
  assert.ok((await page.evaluate(()=>window.__calls)).some(call=>call.path.includes('/restore-requests/')));
 }finally{await browser.close();}
});
