import test from 'node:test';import assert from 'node:assert/strict';
import {fork} from 'node:child_process';import {once} from 'node:events';import {readFile,rm} from 'node:fs/promises';import {join,relative,resolve,isAbsolute} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {GitWorkbench} from '../../src/git/service.ts';import {ProjectRepository} from '../../src/projects/repository.ts';
import {WorkPublicationIntents} from '../../src/persistent-tasks/work-publication-intents.ts';import {WorkPublicationExecutions} from '../../src/persistent-tasks/work-publication-executions.ts';

for(const phase of ['before','after'])test('actual producer process exit '+phase+' physical publication remains original unknown evidence without replay',{skip:!process.env.JOT_DSH_RUNTIME_MODULES,timeout:45000},async()=>{
 let child,info,db;
 try{
  child=fork(fileURLToPath(new URL('./fixtures/publication-crash-worker.mjs',import.meta.url)),[],{env:{...process.env,JOT_PUBLICATION_CRASH_PHASE:phase},stdio:['ignore','pipe','pipe','ipc']});
  child.stdout.resume();child.stderr.resume();
  const exited=once(child,'exit');
  info=await new Promise((resolve,reject)=>{const onMessage=value=>{if(value.type==='ready')resolve(value);else if(value.type==='error')reject(Error(value.message))};child.on('message',onMessage);child.once('error',reject);child.once('exit',code=>{if(!info)reject(Error('synthetic_publication_worker_early_exit:'+code))});});
  assert.equal((await exited)[0],73,'the original producer process actually terminated');
  const within=relative(resolve(tmpdir()),resolve(info.root));assert.ok(within&&!isAbsolute(within)&&!within.startsWith('..')&&within.startsWith('jot-discovery-admission-'));
  db=new DatabaseSync(info.database);const git=new GitWorkbench(new ProjectRepository(db),[{owner_id:'owner',project_id:info.project_id,root:info.target}]),intents=new WorkPublicationIntents(db,git),source=new WorkPublicationExecutions(db,git,intents);
  const before=db.prepare('SELECT count(*) n FROM wb_work_publication_journal').get().n;
  await assert.rejects(source.executePublication('owner',info.project_id,info.execution_id),/work_publication_producer_closed/);
  // The process exit is authoritative. Expiring its original fence simulates
  // restart timing, never proof that the unknown file effect did not happen.
  db.prepare('UPDATE ga_worker_leases SET expires_at=?').run(String(Date.now()-1));
  const status=source.publicationStatus('owner',info.project_id,info.execution_id);assert.equal(status.state,'interrupted');assert.equal(status.pending_path,'source.md');assert.deepEqual(status.files,[]);
  assert.equal(await readFile(join(info.target,'source.md'),'utf8'),phase==='before'?info.base:'Exact reviewed work content');
  assert.equal(db.prepare('SELECT count(*) n FROM wb_work_publication_journal').get().n,before);assert.equal(db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0);
  assert.throws(()=>source.releaseUnstartedWorkspace('owner',info.project_id,info.execution_id),/work_publication_producer_unconfirmed/);
 }finally{
  if(child&&child.exitCode===null){const stopped=once(child,'exit');child.kill();await stopped;}
  db?.close();if(info){const within=relative(resolve(tmpdir()),resolve(info.root));assert.ok(within&&!isAbsolute(within)&&!within.startsWith('..')&&within.startsWith('jot-discovery-admission-'));await rm(info.root,{recursive:true,force:true,maxRetries:5,retryDelay:25});}
 }
});
