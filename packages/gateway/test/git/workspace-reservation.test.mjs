import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {readdirSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';
import {openProductDatabase,withImmediateTransaction} from '../../src/db/database.ts';
import {ProjectRepository} from '../../src/projects/repository.ts';import {GitWorkbench} from '../../src/git/service.ts';
import {GitMutationIntents} from '../../src/git/intents.ts';import {GitIndexExecutions} from '../../src/git/index-executions.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';import {EventStore} from '../../src/events/event-store.ts';
import {RunRepository} from '../../src/runs/repository.ts';import {HarnessCoordinator} from '../../src/harness/coordinator.ts';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'jot-project-reservation-')),repo=join(root,'repo'),database=join(root,'state.sqlite');await mkdir(repo);
 const git=(...args)=>execFileSync('git',['-c','user.name=Test Contributor','-c','user.email=test@example.invalid',...args],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 git('init','--initial-branch=main');git('config','core.autocrlf','false');await writeFile(join(repo,'note.txt'),'before\n');git('add','.');git('commit','-m','Synthetic workspace fixture');await writeFile(join(repo,'note.txt'),'after\n');
 const db=openProductDatabase(database),projects=new ProjectRepository(db),project=projects.create('owner',{title:'Synthetic'}).project_id;
 const workbench=new WorkbenchService(db,{workspaceIds:['ws'],root:join(root,'shared')}),events=new EventStore(db),runs=new RunRepository(db,events),coordinator=new HarnessCoordinator(db,runs,events);
 const kernel=new GitWorkbench(projects,[{owner_id:'owner',project_id:project,root:repo}]),intents=new GitMutationIntents(db,projects,kernel),executions=new GitIndexExecutions(db,projects,kernel,intents);
 const snapshot=await kernel.inspect('owner',project),review=await intents.prepare('owner',project,{request_id:'prepare',action:'stage',paths:['note.txt'],snapshot_id:snapshot.snapshot_id}),approved=await intents.control('owner',project,review.intent_id,{request_id:'approve',action:'approve',expected_version:1,review_sha256:review.review_sha256});
 const accepted=withImmediateTransaction(db,()=>executions.admit('owner',project,approved.intent_id,{request_id:'execute',expected_version:approved.version,review_sha256:approved.review_sha256}));
 t.after(async()=>{db.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 function enqueue(id='conversation',owner='owner',target=project){db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at,project_id) VALUES(?,?,?,?,?,?,?,?,?)').run(id,owner,'ws','Synthetic','{}',1,'now','now',target);return runs.enqueue(id,owner,{client_message_id:id,content:[{type:'text',text:'Synthetic input'}]});}
 return {root,repo,database,db,project,projects,workbench,runs,coordinator,executions,accepted,enqueue,
  reserve:()=>executions.reserveWorkspace('owner',project,accepted.execution_id),
  release:()=>executions.releaseUnstartedWorkspace('owner',project,accepted.execution_id)};
}

test('original admission can reserve project coordination but never grants physical execution',async t=>{
 const f=await fixture(t),before=await readFile(join(f.repo,'.git/index')),reservation=f.reserve();
 assert.equal(reservation.execution_authorized,false);assert.equal(reservation.project_id,f.project);assert.equal(reservation.state,'reserved');assert.deepEqual(f.reserve(),reservation);
 await assert.rejects(f.executions.perform('owner',f.project,f.accepted.execution_id),/workspace_coordination_required/);
 assert.equal(f.executions.producer('owner',f.project,f.accepted.execution_id).state,'not_started');assert.deepEqual(await readFile(join(f.repo,'.git/index')),before);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);
});

test('original Worker skips a reserved project and can still claim another project',async t=>{
 const f=await fixture(t);f.enqueue();f.reserve();assert.equal(f.coordinator.claimNext('worker',5000),null);
 const other=f.projects.create('owner',{title:'Other'}).project_id,second=f.enqueue('other','owner',other);
 assert.equal(f.coordinator.claimNext('worker',5000).run_id,second.run_id);assert.equal(f.runs.get(f.db.prepare("SELECT id FROM ga_runs WHERE conversation_id='conversation'").get().id,'owner').status,'queued');
});

test('existing original Worker ownership blocks reservation even after lease expiry',async t=>{
 const f=await fixture(t);f.enqueue();const lease=f.coordinator.claimNext('worker',100);assert.ok(lease);
 f.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run('0',lease.run_id);
 assert.throws(f.reserve,/workspace_project_busy/,'expired lease does not prove native producer stopped');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservations').get().n,0);
});

test('a concurrent DB writer cannot admit a Worker through an uncommitted reservation',async t=>{
 const f=await fixture(t);f.enqueue();const second=openProductDatabase(f.database),events=new EventStore(second),runs=new RunRepository(second,events),worker=new HarnessCoordinator(second,runs,events);
 try{
  withImmediateTransaction(f.db,()=>{f.reserve();assert.throws(()=>worker.claimNext('other-worker',5000),/database is locked/);});
  assert.equal(worker.claimNext('other-worker',5000),null);assert.equal(second.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);
 }finally{second.close();}
});

test('shared writes are fenced before immutable blob creation across independent DB handles',async t=>{
 const f=await fixture(t);f.workbench.writeFile('owner','ws',{project_id:f.project,path:'report.txt',content:'original',expected_version:0});
 const before=readdirSync(join(f.root,'shared'),{recursive:true}).sort();f.reserve();const second=openProductDatabase(f.database);
 try{const writer=new WorkbenchService(second,{workspaceIds:['ws'],root:join(f.root,'shared')});assert.throws(()=>writer.writeFile('owner','ws',{project_id:f.project,path:'report.txt',content:'conflict',expected_version:1}),/workspace_coordination_required/);}finally{second.close();}
 assert.deepEqual(readdirSync(join(f.root,'shared'),{recursive:true}).sort(),before);assert.equal(f.workbench.readFile('owner','ws',f.project,'report.txt').content,'original');
});

test('a refused first write creates no source root or blob directory',async t=>{
 const f=await fixture(t),before=readdirSync(join(f.root,'shared'),{recursive:true}).sort();f.reserve();
 assert.throws(()=>f.workbench.writeFile('owner','ws',{project_id:f.project,path:'first.txt',content:'blocked',expected_version:0}),/workspace_coordination_required/);
 assert.deepEqual(readdirSync(join(f.root,'shared'),{recursive:true}).sort(),before);
});

test('direct original run activation cannot bypass the project reservation',async t=>{
 const f=await fixture(t),run=f.enqueue();f.reserve();
 assert.throws(()=>f.db.prepare("UPDATE ga_runs SET status='starting' WHERE id=?").run(run.run_id),/workspace_coordination_required/);
 assert.equal(f.runs.get(run.run_id,'owner').status,'queued');
});

test('legacy unbound project input cannot be claimed through an owned reservation',async t=>{
 const f=await fixture(t);f.enqueue('legacy','owner',null);f.reserve();assert.equal(f.coordinator.claimNext('worker',5000),null);
});

test('an active legacy run with no project binding must drain before reservation',async t=>{
 const f=await fixture(t);f.enqueue('legacy','owner',null);assert.ok(f.coordinator.claimNext('worker',5000));
 assert.throws(f.reserve,/workspace_project_busy/);
});

test('rollback leaves neither reservation nor release and reopening never expires a hold',async t=>{
 const f=await fixture(t);assert.throws(()=>withImmediateTransaction(f.db,()=>{f.reserve();throw Error('rollback');}),/rollback/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservations').get().n,0);
 const value=f.reserve(),second=openProductDatabase(f.database);try{assert.equal(second.prepare('SELECT reservation_id FROM wb_workspace_reservations').get().reservation_id,value.reservation_id);assert.equal(second.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0);}finally{second.close();}
});

test('pre-dispatch release restores normal shared writes and original claim without rearming the reservation',async t=>{
 const f=await fixture(t);f.enqueue();f.reserve();const released=f.release();assert.equal(released.state,'released_unstarted');assert.deepEqual(f.release(),released);
 assert.throws(f.reserve,/workspace_reservation_closed/);assert.ok(f.coordinator.claimNext('worker',5000));
 assert.equal(f.workbench.writeFile('owner','ws',{project_id:f.project,path:'later.txt',content:'allowed',expected_version:0}).version,1);
});

test('owner changes cannot borrow or release an original workspace reservation',async t=>{
 const f=await fixture(t);assert.throws(()=>f.executions.reserveWorkspace('foreign',f.project,f.accepted.execution_id),/project_not_found/);
 f.reserve();f.db.prepare('UPDATE ga_projects SET owner_id=? WHERE id=?').run('replacement',f.project);
 assert.throws(f.release,/project_not_found/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0);
});

test('reservation and release journals cannot be updated, deleted or replaced',async t=>{
 const f=await fixture(t);f.reserve();f.release();
 for(const table of ['wb_workspace_reservations','wb_workspace_reservation_releases']){
  assert.throws(()=>f.db.exec('DELETE FROM '+table),/workspace_coordination_immutable/);
  assert.throws(()=>f.db.exec('INSERT OR REPLACE INTO '+table+' SELECT * FROM '+table),/workspace_coordination_immutable/);
 }
});

test('replacement cannot change reservation identity through the unique original operation',async t=>{
 const f=await fixture(t),reserved=f.reserve();
 assert.throws(()=>f.db.prepare(`INSERT OR REPLACE INTO wb_workspace_reservations
  SELECT ?,owner_id,project_id,operation_kind,operation_id,binding_sha256,created_at,record_sha256 FROM wb_workspace_reservations
  WHERE reservation_id=?`).run('replacement-reservation',reserved.reservation_id),/workspace_coordination_immutable/);
 assert.equal(f.db.prepare('SELECT reservation_id FROM wb_workspace_reservations').get().reservation_id,reserved.reservation_id);
 assert.throws(()=>f.workbench.writeFile('owner','ws',{project_id:f.project,path:'blocked.txt',content:'blocked',expected_version:0}),/workspace_coordination_required/);
});
