import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {createTools} from '../src/tools.mjs';
const cache=process.env.JOT_TEST_TMP??new URL('../../../.cache/jot-tests/',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');

async function persistentWriteFixture(){
  const root=join(cache,`file-write-${crypto.randomUUID()}`);await mkdir(root,{recursive:true});
  const database=join(root,'store.sqlite'),store=new Store(database),conversation=store.createConversation();
  const run=store.accept(conversation.id,'write a synthetic file','write-request').run;store.close();
  return {root,database,conversationId:conversation.id,runId:run.id,callId:'write-call-1'};
}

function runWriteChild(fixture,fault,args={name:'answer.md',text:'hello from child'}){
  const script=`
    const {Store}=await import(process.env.W05_STORE);
    const {createTools}=await import(process.env.W05_TOOLS);
    const store=new Store(process.env.W05_DATABASE),run=store.run(process.env.W05_RUN_ID),fault=process.env.W05_FAULT;
    const originalArtifact=store.artifact.bind(store),originalExec=store.db.exec.bind(store.db);
    let commits=0;
    if(fault==='accepted')store.db.exec=sql=>{const result=originalExec(sql);if(String(sql).trim().toUpperCase()==='COMMIT'&&++commits===1)process.exit(72);return result;};
    if(fault==='artifact')store.artifact=artifact=>{const result=originalArtifact(artifact);process.exit(73);return result;};
    if(fault==='commit')store.db.exec=sql=>{const result=originalExec(sql);if(String(sql).trim().toUpperCase()==='COMMIT'&&++commits===2)process.exit(74);return result;};
    const tools=createTools({store,root:process.env.W05_ROOT});
    await tools.execute('file_write',JSON.parse(process.env.W05_ARGS),{run,callId:process.env.W05_CALL_ID,signal:new AbortController().signal,approve:async()=>{}});
    store.close();
  `;
  return spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',windowsHide:true,env:{...process.env,W05_STORE:new URL('../src/store.mjs',import.meta.url).href,W05_TOOLS:new URL('../src/tools.mjs',import.meta.url).href,W05_DATABASE:fixture.database,W05_ROOT:fixture.root,W05_RUN_ID:fixture.runId,W05_CALL_ID:fixture.callId,W05_ARGS:JSON.stringify(args),W05_FAULT:fault}});
}

async function filesIn(path){try{return await readdir(path);}catch(error){if(error.code==='ENOENT')return [];throw error;}}

function fakeBrowser(){
  let launches=0,navigations=0,clicks=0;
  const contexts=[];
  const factory=async()=>{launches++;await new Promise(r=>setImmediate(r));return {newContext:async()=>{
    let current='about:blank',candidateIds=[];
    const page={url:()=>current,goto:async url=>{navigations++;current=url;},title:async()=>current,
      evaluate:async(_fn,ids)=>{if(Array.isArray(ids)){candidateIds=ids;return;}return {url:current,title:current,text:current,controls:[{index:0,tag:'button',role:'button',name:'Submit',type:'',disabled:false,visible:true}]}},
      locator:selector=>{
        if(selector==='body')return {innerText:async()=>current};
        const id=/data-jot-candidate="([a-f0-9]+)"/.exec(selector)?.[1],index=candidateIds.indexOf(id);
        return {count:async()=>index>=0?1:0,isVisible:async()=>index>=0,isEnabled:async()=>index>=0,
          fill:async()=>{},click:async()=>{clicks++;current='https://example.com/done';},scrollIntoViewIfNeeded:async()=>{}};
      }};
    const context={route:async()=>{},pages:()=>[page],newPage:async()=>page,close:async()=>{}};contexts.push(context);return context;
  },close:async()=>{}};};
  return {factory,stats:()=>({launches,navigations,clicks,contexts:contexts.length})};
}

test('browser operations reuse one launch and never silently navigate back to repeat an action',async()=>{
  const store=new Store(':memory:'),fake=fakeBrowser();
  const tools=createTools({store,root:cache,origins:new Set(['https://example.com']),browserEnabled:true,browserFactory:fake.factory});
  const runA=store.accept(store.createConversation().id,'browse-a','request-a').run,runB=store.accept(store.createConversation().id,'browse-b','request-b').run;
  let call=0;const context=run=>({run,callId:`call-${++call}`,signal:new AbortController().signal,approve:async()=>{}});
  try {
    const readA=context(runA),readB=context(runB);
    const [pageA]=await Promise.all([tools.execute('browser_action',{url:'https://example.com/start',action:'read'},readA),tools.execute('browser_action',{url:'https://example.com/start',action:'read'},readB)]);
    assert.equal(fake.stats().launches,1);
    const args={url:pageA.url,action:'click',candidate_id:pageA.candidates[0].candidate_id,page_revision:pageA.page_revision};
    assert.equal((await tools.execute('browser_action',args,context(runA))).url,'https://example.com/done');
    const retry=await tools.execute('browser_action',args,context(runA));assert.equal(retry.error,'browser_page_changed');
    assert.equal(fake.stats().clicks,1);assert.equal(fake.stats().navigations,2);
  }finally{await tools.close();store.close();}
});

test('file tools bind approval to content and create an artifact on its run only',async()=>{
  const store=new Store(':memory:'),root=join(cache,crypto.randomUUID());await mkdir(root,{recursive:true});
  const run=store.accept(store.createConversation().id,'write','1').run;let operation;
  const tools=createTools({store,root});
  try {
    const result=await tools.execute('file_write',{name:'answer.md',text:'hello'},{run,callId:'write-one',signal:new AbortController().signal,approve:async(description,value)=>operation=value});
    assert.equal(operation.sha256,'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    assert.equal(store.getArtifact(result.artifact_id).run_id,run.id);
    assert.equal((await tools.execute('file_read',{artifact_id:result.artifact_id},{run,signal:new AbortController().signal})).text,'hello');
    const other=store.accept(store.createConversation().id,'read','2').run;
    await assert.rejects(()=>tools.execute('file_read',{artifact_id:result.artifact_id},{run:other,signal:new AbortController().signal}),/artifact_not_found/);
  }finally{await tools.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('file_write reuses the original call receipt and rejects the same call ID with changed content',async()=>{
  const store=new Store(':memory:'),root=join(cache,crypto.randomUUID());await mkdir(root,{recursive:true});
  const run=store.accept(store.createConversation().id,'write once','1').run,tools=createTools({store,root});let approvals=0;
  const invoke=(text='hello')=>tools.execute('file_write',{name:'answer.md',text},{run,callId:'same-write',signal:new AbortController().signal,approve:async()=>{approvals++;}});
  try{
    const first=await invoke(),retry=await invoke();
    assert.equal(retry.artifact_id,first.artifact_id);assert.equal(retry.file_receipt.status,'succeeded');
    assert.equal(approvals,1);assert.equal(store.artifacts(run.conversation_id).length,1);
    assert.equal((await tools.execute('file_read',{artifact_id:first.artifact_id},{run,signal:new AbortController().signal})).text,'hello');
    const events=store.events(run.conversation_id,0).filter(event=>event.type.startsWith('file_write.operation.'));
    assert.deepEqual(events.map(event=>event.type),['file_write.operation.accepted','file_write.operation.succeeded']);
    await assert.rejects(()=>invoke('different payload'),/invalid_tool_call_reused/);
    await assert.rejects(()=>tools.execute('file_write',{name:'answer.md',text:'hello',ignored:'different input'},{run,callId:'same-write',signal:new AbortController().signal,approve:async()=>{approvals++;}}),/invalid_tool_arguments/);
    assert.equal(approvals,1);assert.equal(store.artifacts(run.conversation_id).length,1);
  }finally{await tools.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('file_write denial and cancellation leave no accepted operation or file',async()=>{
  const store=new Store(':memory:'),root=join(cache,crypto.randomUUID());await mkdir(root,{recursive:true});
  const run=store.accept(store.createConversation().id,'write maybe','1').run,tools=createTools({store,root});
  try{
    await assert.rejects(()=>tools.execute('file_write',{name:'denied.txt',text:'no'},{run,callId:'denied-call',signal:new AbortController().signal,approve:async()=>{throw new Error('user_denied');}}),/user_denied/);
    const controller=new AbortController();
    await assert.rejects(()=>tools.execute('file_write',{name:'cancelled.txt',text:'no'},{run,callId:'cancelled-call',signal:controller.signal,approve:async()=>{controller.abort();}}),/cancelled/);
    assert.deepEqual(store.events(run.conversation_id,0).filter(event=>event.type.startsWith('file_write.operation.')),[]);
    assert.equal(store.artifacts(run.conversation_id).length,0);assert.deepEqual(await filesIn(join(root,run.conversation_id)),[]);
  }finally{await tools.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('file_write accepted before a child-process exit is inspect-only and never replayed',async()=>{
  const fixture=await persistentWriteFixture();
  try{
    const child=runWriteChild(fixture,'accepted');assert.equal(child.status,72,child.stderr);
    const store=new Store(fixture.database),run=store.run(fixture.runId),tools=createTools({store,root:fixture.root});let approvals=0;
    const context={run,callId:fixture.callId,signal:new AbortController().signal,approve:async()=>{approvals++;}};
    try{
      const first=await tools.execute('file_write',{name:'answer.md',text:'hello from child'},context);
      const second=await tools.execute('file_write',{name:'answer.md',text:'hello from child'},context);
      assert.equal(first.error,'file_write_outcome_unknown');assert.equal(second.error,'file_write_outcome_unknown');
      assert.equal(approvals,0);assert.equal(store.artifacts(run.conversation_id).length,0);
      assert.deepEqual(await filesIn(join(fixture.root,fixture.conversationId)),[]);
      assert.deepEqual(store.events(run.conversation_id,0).filter(event=>event.type.startsWith('file_write.operation.')).map(event=>event.type),['file_write.operation.accepted','file_write.operation.unknown']);
    }finally{await tools.close();store.close();}
  }finally{await rm(fixture.root,{recursive:true,force:true});}
});

test('file_write reconciles the exact artifact after a child exits between file effect and SQLite commit',async()=>{
  const fixture=await persistentWriteFixture();
  try{
    const child=runWriteChild(fixture,'artifact');assert.equal(child.status,73,child.stderr);
    const store=new Store(fixture.database),run=store.run(fixture.runId),tools=createTools({store,root:fixture.root});let approvals=0;
    const context={run,callId:fixture.callId,signal:new AbortController().signal,approve:async()=>{approvals++;}};
    try{
      const result=await tools.execute('file_write',{name:'answer.md',text:'hello from child'},context);
      assert.equal(result.file_receipt.status,'succeeded');assert.equal(approvals,0);
      assert.equal(store.artifacts(run.conversation_id).length,1);
      assert.equal((await tools.execute('file_read',{artifact_id:result.artifact_id},{run,signal:new AbortController().signal})).text,'hello from child');
      const events=store.events(run.conversation_id,0).filter(event=>event.type.startsWith('file_write.operation.'));
      assert.deepEqual(events.map(event=>event.type),['file_write.operation.accepted','file_write.operation.succeeded']);
      const repeat=await tools.execute('file_write',{name:'answer.md',text:'hello from child'},context);
      assert.equal(repeat.artifact_id,result.artifact_id);assert.equal(store.artifacts(run.conversation_id).length,1);
    }finally{await tools.close();store.close();}
  }finally{await rm(fixture.root,{recursive:true,force:true});}
});

test('file_write returns its committed original artifact after a child exits before acknowledging it',async()=>{
  const fixture=await persistentWriteFixture();
  try{
    const child=runWriteChild(fixture,'commit');assert.equal(child.status,74,child.stderr);
    const store=new Store(fixture.database),run=store.run(fixture.runId),tools=createTools({store,root:fixture.root});let approvals=0;
    const context={run,callId:fixture.callId,signal:new AbortController().signal,approve:async()=>{approvals++;}};
    try{
      const result=await tools.execute('file_write',{name:'answer.md',text:'hello from child'},context);
      assert.equal(result.file_receipt.status,'succeeded');assert.equal(approvals,0);
      assert.equal(store.artifacts(run.conversation_id).length,1);
      assert.equal((await tools.execute('file_read',{artifact_id:result.artifact_id},{run,signal:new AbortController().signal})).text,'hello from child');
      assert.equal((await tools.execute('file_write',{name:'answer.md',text:'hello from child'},context)).artifact_id,result.artifact_id);
      assert.equal(store.artifacts(run.conversation_id).length,1);
    }finally{await tools.close();store.close();}
  }finally{await rm(fixture.root,{recursive:true,force:true});}
});

test('file reads cannot follow a stored path outside the configured artifact root',async()=>{
  const store=new Store(':memory:'),root=join(cache,crypto.randomUUID());await mkdir(join(root,'files'),{recursive:true});
  const run=store.accept(store.createConversation().id,'read','1').run,path=join(root,'outside.txt');await writeFile(path,'private');
  store.artifact({id:'bad',conversation_id:run.conversation_id,run_id:run.id,name:'outside.txt',path,size:7});
  const tools=createTools({store,root:join(root,'files')});
  try {await assert.rejects(()=>tools.execute('file_read',{artifact_id:'bad'},{run,signal:new AbortController().signal}),/artifact_path_denied/);}
  finally{store.close();await rm(root,{recursive:true,force:true});}
});
