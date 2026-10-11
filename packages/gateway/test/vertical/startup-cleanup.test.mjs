import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,unlinkSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {buildServer} from '../../src/server.ts';
test('failed server initialization closes its real SQLite connection before returning the error',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'jot-startup-failure-'));const created=new Set(),closed=new Set();const exec=DatabaseSync.prototype.exec,close=DatabaseSync.prototype.close;
 DatabaseSync.prototype.exec=function(...args){created.add(this);return exec.apply(this,args)};
 DatabaseSync.prototype.close=function(...args){const result=close.apply(this,args);closed.add(this);return result};
 try{
  await assert.rejects(buildServer({databasePath:join(dir,'fixture.sqlite'),workspaces:['fixture'],workbenchRoot:join(dir,'workspace'),templateRoot:join(dir,'missing-templates'),emotion:{env:{}}}));
  assert.ok(created.size>0);assert.equal(closed.size,created.size);assert.ok([...created].every(db=>!db.isOpen));
  unlinkSync(join(dir,'fixture.sqlite'));
 }finally{
  DatabaseSync.prototype.exec=exec;DatabaseSync.prototype.close=close;
  for(const db of created)if(db.isOpen)close.call(db);
  rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
});
