import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {createTools} from '../src/tools.mjs';
const cache=process.env.JOT_TEST_TMP??new URL('../../../.cache/jot-tests/',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');

function fakeBrowser(){
  let launches=0,navigations=0,clicks=0;
  const contexts=[];
  const factory=async()=>{launches++;await new Promise(r=>setImmediate(r));return {newContext:async()=>{
    let current='about:blank';const page={url:()=>current,goto:async url=>{navigations++;current=url;},title:async()=>current,locator:selector=>selector==='body'?{innerText:async()=>current}:{count:async()=>1,fill:async()=>{},click:async()=>{clicks++;current='https://example.com/done';}}};
    const context={route:async()=>{},pages:()=>[page],newPage:async()=>page,close:async()=>{}};contexts.push(context);return context;
  },close:async()=>{}};};
  return {factory,stats:()=>({launches,navigations,clicks,contexts:contexts.length})};
}

test('browser operations reuse one launch and never silently navigate back to repeat an action',async()=>{
  const store=new Store(':memory:'),fake=fakeBrowser();
  const tools=createTools({store,root:cache,origins:new Set(['https://example.com']),browserEnabled:true,browserFactory:fake.factory});
  const context=()=>({run:store.accept(store.createConversation().id,'browse',crypto.randomUUID()).run,signal:new AbortController().signal,approve:async()=>{}});
  const a=context(),b=context();
  try {
    await Promise.all([tools.execute('browser_action',{url:'https://example.com/start',action:'read'},a),tools.execute('browser_action',{url:'https://example.com/start',action:'read'},b)]);
    assert.equal(fake.stats().launches,1);
    assert.equal((await tools.execute('browser_action',{url:'https://example.com/start',action:'click',selector:'#submit'},a)).url,'https://example.com/done');
    await assert.rejects(()=>tools.execute('browser_action',{url:'https://example.com/start',action:'click',selector:'#submit'},a),/browser_page_changed/);
    assert.equal(fake.stats().clicks,1);assert.equal(fake.stats().navigations,2);
  }finally{await tools.close();store.close();}
});

test('file tools bind approval to content and create an artifact on its run only',async()=>{
  const store=new Store(':memory:'),root=join(cache,crypto.randomUUID());await mkdir(root,{recursive:true});
  const run=store.accept(store.createConversation().id,'write','1').run;let operation;
  const tools=createTools({store,root});
  try {
    const result=await tools.execute('file_write',{name:'answer.md',text:'hello'},{run,signal:new AbortController().signal,approve:async(description,value)=>operation=value});
    assert.equal(operation.sha256,'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    assert.equal(store.getArtifact(result.artifact_id).run_id,run.id);
    assert.equal((await tools.execute('file_read',{artifact_id:result.artifact_id},{run,signal:new AbortController().signal})).text,'hello');
    const other=store.accept(store.createConversation().id,'read','2').run;
    await assert.rejects(()=>tools.execute('file_read',{artifact_id:result.artifact_id},{run:other,signal:new AbortController().signal}),/artifact_not_found/);
  }finally{await tools.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('file reads cannot follow a stored path outside the configured artifact root',async()=>{
  const store=new Store(':memory:'),root=join(cache,crypto.randomUUID());await mkdir(join(root,'files'),{recursive:true});
  const run=store.accept(store.createConversation().id,'read','1').run,path=join(root,'outside.txt');await writeFile(path,'private');
  store.artifact({id:'bad',conversation_id:run.conversation_id,run_id:run.id,name:'outside.txt',path,size:7});
  const tools=createTools({store,root:join(root,'files')});
  try {await assert.rejects(()=>tools.execute('file_read',{artifact_id:'bad'},{run,signal:new AbortController().signal}),/artifact_path_denied/);}
  finally{store.close();await rm(root,{recursive:true,force:true});}
});
