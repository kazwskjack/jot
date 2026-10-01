import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdirSync} from 'node:fs';

test('persistent conversations remain isolated and messages are idempotent', async () => {
  const {Store} = await import('../src/store.mjs');
  const cache=process.env.JOT_TEST_TMP??fileURLToPath(new URL('../../../.cache/jot-tests/',import.meta.url));mkdirSync(cache,{recursive:true});
  const root = mkdtempSync(join(cache,'jot-test-'));
  let db = new Store(join(root,'test.db'));
  try {
    const a=db.createConversation('A'),b=db.createConversation('B');
    const first=db.accept(a.id,'hello','request-1');
    const duplicate=db.accept(a.id,'hello','request-1');
    assert.equal(duplicate.run.id,first.run.id);
    assert.throws(()=>db.accept(a.id,'different','request-1'),/conflict/);
    assert.equal(db.messages(b.id).length,0);
    db.close(); db=new Store(join(root,'test.db'));
    assert.equal(db.messages(a.id).length,1);
    assert.equal(db.events(a.id,0).length,1);
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

test('Agent executes a tool and commits one final answer', async () => {
  const {Store}=await import('../src/store.mjs');
  const {Agent}=await import('../src/agent.mjs');
  const db=new Store(':memory:'); let turns=0;
  const provider=async ()=>++turns===1?{role:'assistant',content:null,tool_calls:[{id:'t1',type:'function',function:{name:'read_page',arguments:'{"url":"https://example.com"}'}}]}:{role:'assistant',content:'Verified result'};
  try {
    const c=db.createConversation('Tools'),accepted=db.accept(c.id,'read','one');
    const agent=new Agent(db,{provider,tools:{definitions:[],execute:async()=>({text:'Example'})}});
    await agent.execute(accepted.run);
    assert.equal(db.run(accepted.run.id).status,'succeeded');
    assert.equal(db.messages(c.id).filter(m=>m.role==='assistant').length,1);
    assert.equal(turns,2);
  } finally {db.close();}
});

test('cancellation produces cancelled without a false assistant result', async () => {
  const {Store}=await import('../src/store.mjs'); const {Agent}=await import('../src/agent.mjs');
  const db=new Store(':memory:');
  try {
    const c=db.createConversation('Cancel'),{run}=db.accept(c.id,'slow','one');
    const agent=new Agent(db,{provider:async (messages,tools,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})),tools:{definitions:[]}});
    const pending=agent.execute(run); agent.cancel(run.id); await pending;
    assert.equal(db.run(run.id).status,'cancelled');
    assert.equal(db.messages(c.id).length,1);
  } finally {db.close();}
});

test('workspace paths reject traversal and non-allowlisted URLs',async()=>{
  const {safeName,allowedUrl}=await import('../src/tools.mjs');
  assert.throws(()=>safeName('../secret'),/file_name/);
  assert.throws(()=>safeName('nested/file'),/file_name/);
  assert.throws(()=>allowedUrl('http://127.0.0.1',new Set(['https://example.com'])),/url_not_allowed/);
  assert.equal(allowedUrl('https://example.com/a',new Set(['https://example.com'])).hostname,'example.com');
});
