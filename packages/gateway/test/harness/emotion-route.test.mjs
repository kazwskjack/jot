import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {resolve,join} from 'node:path';
import {buildServer} from '../../src/server.ts';
test('emotion endpoint checks owner and conversation/run binding without writing idempotency rows',async()=>{
 const directory=mkdtempSync(join(resolve('.'),'emotion-test-'));
 const s=await buildServer({databasePath:join(directory,'db.sqlite'),workspaces:['ws']});
 try{
  const c=s.conversations.create('owner',{workspace_id:'ws',model:{provider:'test',model:'test'}});
  const other=s.conversations.create('owner',{workspace_id:'ws',model:{provider:'test',model:'test'}});
  const run=s.runs.enqueue(c.conversation_id,'owner',{client_message_id:'test',content:[{type:'text',text:'hello'}]});
  const url=`/v1/conversations/${c.conversation_id}/emotion?run_id=${run.run_id}`;
  const ok=await s.app.inject({method:'GET',url,headers:{'x-user-id':'owner'}});
  assert.equal(ok.statusCode,200);assert.equal(ok.json().run_id,run.run_id);assert.equal(ok.json().event,'accepted');
  assert.ok((await s.app.inject({method:'GET',url,headers:{'x-user-id':'other'}})).statusCode>=400);
  assert.equal((await s.app.inject({method:'GET',url:`/v1/conversations/${other.conversation_id}/emotion?run_id=${run.run_id}`,headers:{'x-user-id':'owner'}})).statusCode,404);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM ga_idempotency').get().n,0);
 }finally{await s.app.close();s.db.close();assert.ok(directory.startsWith(resolve('.')+'\\emotion-test-'));rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
