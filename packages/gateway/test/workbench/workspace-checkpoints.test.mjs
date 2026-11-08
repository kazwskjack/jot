import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {fixture} from '../always-on/discovery-fixture.mjs';
import {upgradeWorkspacePublicationCoordination,upgradeWorkspaceCheckpointCoordination,workspaceCheckpointCoordinationSchema,workspacePublicationSchema} from '../../src/workbench/workspace-coordination-upgrade.ts';
import {reserveWorkspaceOperation,releaseUnstartedWorkspaceOperation} from '../../src/workbench/workspace-coordination.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';

const hash=value=>createHash('sha256').update(value).digest('hex');
const controls=()=>({guard:()=>{},signal:new AbortController().signal});
async function service(f,options={}){
 upgradeWorkspacePublicationCoordination(f.db);upgradeWorkspaceCheckpointCoordination(f.db);
 const {WorkspaceCheckpointService}=await import('../../src/workbench/workspace-checkpoints.ts').catch(()=>({}));
 assert.equal(typeof WorkspaceCheckpointService,'function','owner-scoped WorkspaceCheckpointService is implemented');
 const storageRoot=join(f.root,'checkpoint-storage');mkdirSync(storageRoot,{recursive:true});
 return new WorkspaceCheckpointService(f.db,f.workbench,{storageRoot,...options});
}
function binaryFile(f,path,bytes){
 const root=f.workbench.projectRoot('owner','ws',f.scope.project_id),blobName=`fixture-${path.replace(/[^a-z0-9]/gi,'-')}.bin`,now=new Date().toISOString(),sha256=hash(bytes);
 writeFileSync(join(root,'blobs',blobName),bytes,{flag:'wx',mode:0o600});
 f.db.prepare('INSERT INTO wb_file_versions VALUES(?,?,?,?,?,?,?,?,?)').run('owner','ws',f.scope.project_id,path,1,sha256,bytes.length,blobName,now);
 f.db.prepare('INSERT INTO wb_files VALUES(?,?,?,?,?,?,?,?,?)').run('owner','ws',f.scope.project_id,path,1,sha256,bytes.length,blobName,now);
}
function currentRow(f,path){return f.db.prepare('SELECT * FROM wb_files WHERE owner_id=? AND workspace_id=? AND project_id=? AND path=?').get('owner','ws',f.scope.project_id,path);}
function blobBytes(f,row){return readFileSync(join(f.workbench.projectRoot('owner','ws',f.scope.project_id),'blobs',row.blob_name));}
async function restoreCrashScenario(t,commandKey){
 process.env.TEMP=join(process.cwd(),'.test-tmp');process.env.TMP=process.env.TEMP;
 const f=fixture(t);f.file();const clock={value:Date.parse('2026-02-01T00:00:00.000Z')},checkpoints=await service(f,{now:()=>clock.value,leaseMs:1000});
 const checkpoint=await checkpoints.create('owner','ws',{project_id:f.scope.project_id,paths:['source.md'],command_key:`${commandKey}-create`});
 f.workbench.writeFile('owner','ws',{project_id:f.scope.project_id,path:'source.md',content:'current bytes',expected_version:1});
 const before=currentRow(f,'source.md'),review=await checkpoints.reviewRestore('owner','ws',{project_id:f.scope.project_id,checkpoint_id:checkpoint.checkpoint_id,path:'source.md',command_key:`${commandKey}-review`});
 const input={project_id:f.scope.project_id,checkpoint_id:checkpoint.checkpoint_id,path:'source.md',review_id:review.review_id,review_sha256:review.review_sha256,command_key:commandKey,...controls()};
 return{f,clock,checkpoints,checkpoint,before,review,input};
}
function waitForDurablePhase(child,expectedPhase){
 return new Promise((resolve,reject)=>{
  let pending='',stderr='';const timer=setTimeout(()=>finish(reject,new Error(`timed out waiting for ${expectedPhase}; stderr=${stderr}`)),15_000);
  const finish=(callback,value)=>{clearTimeout(timer);child.stdout.off('data',onStdout);child.stderr.off('data',onStderr);child.off('error',onError);child.off('close',onClose);callback(value);};
  const onStdout=chunk=>{pending+=chunk.toString();const lines=pending.split('\n');pending=lines.pop()??'';for(const line of lines){if(!line)continue;let receipt;try{receipt=JSON.parse(line);}catch{continue;}if(receipt.event==='durable_phase'&&receipt.phase===expectedPhase){finish(resolve,receipt);return;}}};
  const onStderr=chunk=>{stderr+=chunk.toString();};
  const onError=error=>finish(reject,error);
  const onClose=(code,signal)=>finish(reject,new Error(`child exited before ${expectedPhase}: code=${code} signal=${signal}; stderr=${stderr}`));
  child.stdout.on('data',onStdout);child.stderr.on('data',onStderr);child.once('error',onError);child.once('close',onClose);
 });
}
async function killRestoreChildAtPhase(scenario,phase){
 const packageRoot=fileURLToPath(new URL('../../',import.meta.url)),childScript=fileURLToPath(new URL('./checkpoint-restore-child.mjs',import.meta.url));
 const child=spawn(process.execPath,[childScript,join(scenario.f.root,'db.sqlite'),join(scenario.f.root,'checkpoint-storage'),join(scenario.f.root,'workspace'),scenario.f.scope.project_id,scenario.checkpoint.checkpoint_id,scenario.review.review_id,scenario.review.review_sha256,scenario.input.command_key,phase,String(scenario.clock.value),'1000'],{cwd:packageRoot,env:{...process.env,TEMP:join(process.cwd(),'.test-tmp'),TMP:join(process.cwd(),'.test-tmp')},stdio:['ignore','pipe','pipe']});
 let closed=false;const terminated=new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;resolve({code,signal});}));
 try{
  const receipt=await waitForDurablePhase(child,phase);assert.match(receipt.operation_id,/^workspace-checkpoint-restore-/);
  assert.equal(child.kill('SIGKILL'),true,`parent failed to terminate child after ${phase} receipt`);
  const exit=await terminated;assert.ok(exit.code!==0||exit.signal!==null,`child returned normally after parent kill at ${phase}`);
  return{receipt,exit};
 }finally{
  if(!closed){child.kill('SIGKILL');await terminated;}
 }
}

test('restore reservation requires a separate offline migration and preserves the prior publication schema',t=>{
 const f=fixture(t),source={owner_id:'owner',project_id:f.scope.project_id,operation_kind:'workspace_checkpoint_restore',operation_id:'checkpoint-restore-migration',binding_sha256:'a'.repeat(64)};
 assert.equal(workspaceCheckpointCoordinationSchema(f.db),'legacy');assert.throws(()=>withImmediateTransaction(f.db,()=>reserveWorkspaceOperation(f.db,source)),/workspace_checkpoint_upgrade_required/);
 assert.equal(upgradeWorkspacePublicationCoordination(f.db).state,'upgraded');assert.equal(workspacePublicationSchema(f.db),'publication');
 f.db.prepare('INSERT INTO ga_worker_leases VALUES(?,?,?,?,?)').run('synthetic-drain-check','worker','0',1,'now');const before=f.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
 assert.throws(()=>upgradeWorkspaceCheckpointCoordination(f.db),/workspace_publication_upgrade_busy/);assert.deepEqual(f.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),before);f.db.prepare('DELETE FROM ga_worker_leases WHERE resource_id=?').run('synthetic-drain-check');
 assert.equal(upgradeWorkspaceCheckpointCoordination(f.db).state,'upgraded');assert.equal(workspaceCheckpointCoordinationSchema(f.db),'checkpoint');assert.equal(workspacePublicationSchema(f.db),'publication');assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
 const reserved=withImmediateTransaction(f.db,()=>reserveWorkspaceOperation(f.db,source));assert.equal(reserved.state,'reserved');withImmediateTransaction(f.db,()=>releaseUnstartedWorkspaceOperation(f.db,source));
 assert.throws(()=>f.db.prepare('UPDATE wb_workspace_reservations SET binding_sha256=? WHERE operation_id=?').run('b'.repeat(64),source.operation_id),/immutable/);
});

test('captures owner/project scoped logical bytes, executable metadata and explicitly absent paths',async t=>{
 process.env.TEMP=join(process.cwd(),'.test-tmp');process.env.TMP=process.env.TEMP;const f=fixture(t);f.file();
 const bytes=Buffer.from([0,255,7,128,13,10]);binaryFile(f,'assets/data.bin',bytes);
 const checkpoints=await service(f),checkpoint=await checkpoints.create('owner','ws',{project_id:f.scope.project_id,paths:['source.md','assets/data.bin','assets/missing.bin'],command_key:'checkpoint-create-01',...controls()});
 assert.equal(checkpoint.state,'ready');assert.equal(checkpoint.manifest.protocol,2);
 assert.deepEqual(checkpoint.manifest.entries.find(entry=>entry.path==='assets/data.bin'),{path:'assets/data.bin',kind:'file',sha256:hash(bytes),bytes:bytes.length,executable:false});
 assert.deepEqual(checkpoint.manifest.entries.find(entry=>entry.path==='assets/missing.bin'),{path:'assets/missing.bin',kind:'absent'});
 assert.equal(checkpoint.manifest.entries.some(entry=>entry.path==='source.md'&&entry.kind==='file'),true);
 assert.equal(JSON.stringify(checkpoint).includes(f.root),false);assert.equal(JSON.stringify(checkpoint).includes('blob_name'),false);
 assert.equal(JSON.stringify(checkpoint).includes('assets/data.bin'),true);
});

test('restores one reviewed logical path as a new immutable version without replaying task or budget history',async t=>{
 process.env.TEMP=join(process.cwd(),'.test-tmp');process.env.TMP=process.env.TEMP;const f=fixture(t);f.file();
 const checkpoints=await service(f),checkpoint=await checkpoints.create('owner','ws',{project_id:f.scope.project_id,paths:['source.md'],command_key:'checkpoint-create-02',...controls()}),beforeBudget=f.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,beforeGoals=f.db.prepare('SELECT count(*) n FROM ga_conversation_goal_controls').get().n;
 f.workbench.writeFile('owner','ws',{project_id:f.scope.project_id,path:'source.md',content:'new current bytes',expected_version:1});
 const review=await checkpoints.reviewRestore('owner','ws',{project_id:f.scope.project_id,checkpoint_id:checkpoint.checkpoint_id,path:'source.md',command_key:'checkpoint-review-01'});
 const receipt=await checkpoints.restore('owner','ws',{project_id:f.scope.project_id,checkpoint_id:checkpoint.checkpoint_id,path:'source.md',review_id:review.review_id,review_sha256:review.review_sha256,command_key:'checkpoint-restore-01',...controls()});
 const current=currentRow(f,'source.md');assert.equal(current.version,3);assert.equal(current.sha256,hash(Buffer.from('PRIVATE fixture')));assert.equal(blobBytes(f,current).toString(),'PRIVATE fixture');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_file_versions WHERE owner_id=? AND project_id=? AND path=?').get('owner',f.scope.project_id,'source.md').n,3);
 assert.equal(receipt.path,'source.md');assert.equal(receipt.execution_authorized,false);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,beforeBudget);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_conversation_goal_controls').get().n,beforeGoals);
 assert.equal(f.db.prepare("SELECT count(*) n FROM wb_workspace_reservations WHERE operation_kind='workspace_checkpoint_restore'").get().n,1);
});

test('restoring an absent checkpoint path removes only the approved current pointer and keeps version history',async t=>{
 process.env.TEMP=join(process.cwd(),'.test-tmp');process.env.TMP=process.env.TEMP;const f=fixture(t);f.file();const checkpoints=await service(f);
 const checkpoint=await checkpoints.create('owner','ws',{project_id:f.scope.project_id,paths:['source.md','gone.txt'],command_key:'checkpoint-create-03',...controls()});
 f.workbench.writeFile('owner','ws',{project_id:f.scope.project_id,path:'gone.txt',content:'later file',expected_version:0});
 const review=await checkpoints.reviewRestore('owner','ws',{project_id:f.scope.project_id,checkpoint_id:checkpoint.checkpoint_id,path:'gone.txt',command_key:'checkpoint-review-02'});
 await checkpoints.restore('owner','ws',{project_id:f.scope.project_id,checkpoint_id:checkpoint.checkpoint_id,path:'gone.txt',review_id:review.review_id,review_sha256:review.review_sha256,command_key:'checkpoint-restore-02',...controls()});
 assert.equal(currentRow(f,'gone.txt'),undefined);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_file_versions WHERE owner_id=? AND project_id=? AND path=?').get('owner',f.scope.project_id,'gone.txt').n,1);
 assert.equal(currentRow(f,'source.md').sha256,hash(Buffer.from('PRIVATE fixture')));
});

test('restore review goes stale when the selected current path changes',async t=>{
 process.env.TEMP=join(process.cwd(),'.test-tmp');process.env.TMP=process.env.TEMP;const f=fixture(t);f.file();const checkpoints=await service(f),checkpoint=await checkpoints.create('owner','ws',{project_id:f.scope.project_id,paths:['source.md'],command_key:'checkpoint-create-04',...controls()}),review=await checkpoints.reviewRestore('owner','ws',{project_id:f.scope.project_id,checkpoint_id:checkpoint.checkpoint_id,path:'source.md',command_key:'checkpoint-review-03'});
 f.workbench.writeFile('owner','ws',{project_id:f.scope.project_id,path:'source.md',content:'intervening bytes',expected_version:1});
 await assert.rejects(checkpoints.restore('owner','ws',{project_id:f.scope.project_id,checkpoint_id:checkpoint.checkpoint_id,path:'source.md',review_id:review.review_id,review_sha256:review.review_sha256,command_key:'checkpoint-restore-03',...controls()}),/checkpoint_(?:review|current)_changed/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservations WHERE operation_kind=?').get('workspace_checkpoint_restore').n,0);
});

test('a failure after restore intent keeps its reservation and never changes the current pointer',async t=>{
 process.env.TEMP=join(process.cwd(),'.test-tmp');process.env.TMP=process.env.TEMP;const f=fixture(t);f.file();const checkpoints=await service(f),checkpoint=await checkpoints.create('owner','ws',{project_id:f.scope.project_id,paths:['source.md'],command_key:'checkpoint-create-failure',...controls()});
 f.workbench.writeFile('owner','ws',{project_id:f.scope.project_id,path:'source.md',content:'current bytes',expected_version:1});const review=await checkpoints.reviewRestore('owner','ws',{project_id:f.scope.project_id,checkpoint_id:checkpoint.checkpoint_id,path:'source.md',command_key:'checkpoint-review-failure'}),before=currentRow(f,'source.md');
 const failureGuard=context=>{if(context.phase==='verify')throw Error('fixture interruption');};
 await assert.rejects(checkpoints.restore('owner','ws',{project_id:f.scope.project_id,checkpoint_id:checkpoint.checkpoint_id,path:'source.md',review_id:review.review_id,review_sha256:review.review_sha256,command_key:'checkpoint-restore-failure',guard:failureGuard,signal:new AbortController().signal}),/workspace_guard_rejected/);
 assert.deepEqual(currentRow(f,'source.md'),before);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_checkpoint_restore_outcomes').get().n,0);assert.equal(f.db.prepare("SELECT count(*) n FROM wb_workspace_reservations WHERE operation_kind='workspace_checkpoint_restore' AND operation_id IN(SELECT operation_id FROM wb_workspace_checkpoint_path_journal) AND reservation_id NOT IN(SELECT reservation_id FROM wb_workspace_reservation_releases)").get().n,1);
});

test('external mutation of the staged restore bytes is detected before the database commit',async t=>{
 process.env.TEMP=join(process.cwd(),'.test-tmp');process.env.TMP=process.env.TEMP;const f=fixture(t);f.file();let checkpoints;
 checkpoints=await service(f,{onPhase:(phase,identity)=>{if(phase==='restore_blob_renamed'){const journal=f.db.prepare('SELECT blob_name FROM wb_workspace_checkpoint_path_journal WHERE operation_id=?').get(identity.operation_id),blob=join(f.workbench.projectRoot('owner','ws',f.scope.project_id),'blobs',journal.blob_name);writeFileSync(blob,'tampered external bytes');}}});
 const checkpoint=await checkpoints.create('owner','ws',{project_id:f.scope.project_id,paths:['source.md'],command_key:'checkpoint-create-external'});f.workbench.writeFile('owner','ws',{project_id:f.scope.project_id,path:'source.md',content:'current bytes',expected_version:1});const before=currentRow(f,'source.md'),review=await checkpoints.reviewRestore('owner','ws',{project_id:f.scope.project_id,checkpoint_id:checkpoint.checkpoint_id,path:'source.md',command_key:'checkpoint-review-external'});
 await assert.rejects(checkpoints.restore('owner','ws',{project_id:f.scope.project_id,checkpoint_id:checkpoint.checkpoint_id,path:'source.md',review_id:review.review_id,review_sha256:review.review_sha256,command_key:'checkpoint-restore-external',...controls()}),/workspace_checkpoint_blob_changed/);
 assert.deepEqual(currentRow(f,'source.md'),before);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_checkpoint_restore_outcomes').get().n,0);assert.equal(f.db.prepare("SELECT count(*) n FROM wb_workspace_checkpoint_references WHERE reference_kind='unknown'").get().n,1);
});

test('a superseding lease generation prevents the stale restorer from committing',async t=>{
 process.env.TEMP=join(process.cwd(),'.test-tmp');process.env.TMP=process.env.TEMP;const f=fixture(t);f.file();let checkpoints;
 checkpoints=await service(f,{onPhase:(phase,identity)=>{if(phase==='restore_before_transaction')f.db.prepare('UPDATE ga_worker_leases SET owner=?,generation=generation+1,expires_at=? WHERE resource_id=?').run('synthetic-successor',String(Date.now()+60_000),'workspace-checkpoint-restore:'+identity.operation_id);}});
 const checkpoint=await checkpoints.create('owner','ws',{project_id:f.scope.project_id,paths:['source.md'],command_key:'checkpoint-create-lease'});f.workbench.writeFile('owner','ws',{project_id:f.scope.project_id,path:'source.md',content:'current bytes',expected_version:1});const before=currentRow(f,'source.md'),review=await checkpoints.reviewRestore('owner','ws',{project_id:f.scope.project_id,checkpoint_id:checkpoint.checkpoint_id,path:'source.md',command_key:'checkpoint-review-lease'});
 await assert.rejects(checkpoints.restore('owner','ws',{project_id:f.scope.project_id,checkpoint_id:checkpoint.checkpoint_id,path:'source.md',review_id:review.review_id,review_sha256:review.review_sha256,command_key:'checkpoint-restore-lease',...controls()}),/workspace_checkpoint_lease_revoked/);
 assert.deepEqual(currentRow(f,'source.md'),before);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_checkpoint_restore_outcomes').get().n,0);
});

test('a real process exit at the SQLite commit boundary reconciles from the verified blob after lease expiry',async t=>{
 process.env.TEMP=join(process.cwd(),'.test-tmp');process.env.TMP=process.env.TEMP;const f=fixture(t);f.file();const checkpoints=await service(f),checkpoint=await checkpoints.create('owner','ws',{project_id:f.scope.project_id,paths:['source.md'],command_key:'checkpoint-create-crash'});
 f.workbench.writeFile('owner','ws',{project_id:f.scope.project_id,path:'source.md',content:'current bytes',expected_version:1});const before=currentRow(f,'source.md'),review=await checkpoints.reviewRestore('owner','ws',{project_id:f.scope.project_id,checkpoint_id:checkpoint.checkpoint_id,path:'source.md',command_key:'checkpoint-review-crash'}),storageRoot=join(f.root,'checkpoint-storage'),packageRoot=fileURLToPath(new URL('../../',import.meta.url));
 const child=`import {openProductDatabase} from './src/db/database.ts';import {WorkbenchService} from './src/workbench/service.ts';import {WorkspaceCheckpointService} from './src/workbench/workspace-checkpoints.ts';const [dbPath,storageRoot,workspaceRoot,projectId,checkpointId,reviewId,reviewSha]=process.argv.slice(1);const db=openProductDatabase(dbPath),workbench=new WorkbenchService(db,{workspaceIds:['ws'],root:workspaceRoot}),service=new WorkspaceCheckpointService(db,workbench,{storageRoot,onPhase:phase=>{if(phase==='restore_before_commit')process.exit(79)}});await service.restore('owner','ws',{project_id:projectId,checkpoint_id:checkpointId,path:'source.md',review_id:reviewId,review_sha256:reviewSha,command_key:'checkpoint-restore-crash',guard:()=>{},signal:new AbortController().signal});process.exit(80);`;
 const exited=spawnSync(process.execPath,['--input-type=module','-e',child,join(f.root,'db.sqlite'),storageRoot,join(f.root,'workspace'),f.scope.project_id,checkpoint.checkpoint_id,review.review_id,review.review_sha256],{cwd:packageRoot,encoding:'utf8',env:{...process.env,TEMP:join(process.cwd(),'.test-tmp'),TMP:join(process.cwd(),'.test-tmp')}});
 assert.equal(exited.status,79,exited.stderr);assert.deepEqual(currentRow(f,'source.md'),before);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_checkpoint_restore_outcomes').get().n,0);
 const journal=f.db.prepare("SELECT operation_id,blob_name FROM wb_workspace_checkpoint_path_journal WHERE command_key='checkpoint-restore-crash'").get(),blob=join(f.workbench.projectRoot('owner','ws',f.scope.project_id),'blobs',journal.blob_name);assert.equal(existsSync(blob),true);f.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run('0','workspace-checkpoint-restore:'+journal.operation_id);
 const receipt=await checkpoints.reconcileRestore('owner','ws',f.scope.project_id,journal.operation_id,controls());assert.equal(receipt.outcome,'applied');assert.equal(currentRow(f,'source.md').version,3);assert.equal(blobBytes(f,currentRow(f,'source.md')).toString(),'PRIVATE fixture');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases x JOIN wb_workspace_reservations r USING(reservation_id) WHERE r.operation_id=?').get(journal.operation_id).n,1);
});

test('parent kill after durable blob rename preserves the journal and refuses a later legal source epoch change',async t=>{
 const scenario=await restoreCrashScenario(t,'checkpoint-parent-rename-source'),{f,clock,checkpoints,before,input}=scenario;
 const {receipt}=await killRestoreChildAtPhase(scenario,'restore_blob_renamed');
 const journal=f.db.prepare('SELECT operation_id,blob_name,expected_revision FROM wb_workspace_checkpoint_path_journal WHERE command_key=?').get(input.command_key);
 assert.equal(journal.operation_id,receipt.operation_id);assert.ok(existsSync(join(f.workbench.projectRoot('owner','ws',f.scope.project_id),'blobs',journal.blob_name)));
 assert.deepEqual(currentRow(f,'source.md'),before);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_checkpoint_restore_outcomes WHERE operation_id=?').get(journal.operation_id).n,0);
 const lease=f.db.prepare('SELECT expires_at FROM ga_worker_leases WHERE resource_id=?').get('workspace-checkpoint-restore:'+journal.operation_id);
 f.db.prepare('UPDATE wb_project_source_revisions SET revision=revision+1 WHERE owner_id=? AND workspace_id=? AND project_id=?').run('owner','ws',f.scope.project_id);
 const changedRevision=f.db.prepare('SELECT revision FROM wb_project_source_revisions WHERE owner_id=? AND workspace_id=? AND project_id=?').get('owner','ws',f.scope.project_id).revision;
 assert.equal(changedRevision,Number(journal.expected_revision)+1);
 clock.value=Number(lease.expires_at)+1;
 await assert.rejects(checkpoints.reconcileRestore('owner','ws',f.scope.project_id,journal.operation_id,controls()),/workspace_checkpoint_current_changed/);
 assert.equal(f.db.prepare("SELECT count(*) n FROM wb_workspace_checkpoint_references WHERE reference_kind='unknown' AND reference_key=?").get(journal.operation_id).n,1);
 const successor=f.db.prepare('SELECT expires_at FROM ga_worker_leases WHERE resource_id=?').get('workspace-checkpoint-restore:'+journal.operation_id);clock.value=Number(successor.expires_at)+1;
 await assert.rejects(checkpoints.restore('owner','ws',input),/workspace_checkpoint_current_changed/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_checkpoint_path_journal WHERE command_key=?').get(input.command_key).n,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM wb_workspace_reservations WHERE operation_kind='workspace_checkpoint_restore' AND operation_id=?").get(journal.operation_id).n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_file_versions WHERE owner_id=? AND workspace_id=? AND project_id=? AND path=?').get('owner','ws',f.scope.project_id,'source.md').n,2);
 assert.deepEqual(currentRow(f,'source.md'),before);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_checkpoint_restore_outcomes WHERE operation_id=?').get(journal.operation_id).n,0);
});

test('parent kill in SQLite finalization rolls back and later blob mutation remains unknown',async t=>{
 const scenario=await restoreCrashScenario(t,'checkpoint-parent-finalize-blob'),{f,clock,checkpoints,before,input}=scenario;
 const {receipt}=await killRestoreChildAtPhase(scenario,'restore_before_commit');
 const journal=f.db.prepare('SELECT operation_id,blob_name FROM wb_workspace_checkpoint_path_journal WHERE command_key=?').get(input.command_key),blob=join(f.workbench.projectRoot('owner','ws',f.scope.project_id),'blobs',journal.blob_name);
 assert.equal(journal.operation_id,receipt.operation_id);assert.equal(existsSync(blob),true);assert.deepEqual(currentRow(f,'source.md'),before);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_checkpoint_restore_outcomes WHERE operation_id=?').get(journal.operation_id).n,0);
 writeFileSync(blob,Buffer.from('external blob change after child death'));
 const lease=f.db.prepare('SELECT expires_at FROM ga_worker_leases WHERE resource_id=?').get('workspace-checkpoint-restore:'+journal.operation_id);clock.value=Number(lease.expires_at)+1;
 await assert.rejects(checkpoints.reconcileRestore('owner','ws',f.scope.project_id,journal.operation_id,controls()),/workspace_checkpoint_blob_changed/);
 assert.equal(f.db.prepare("SELECT count(*) n FROM wb_workspace_checkpoint_references WHERE reference_kind='unknown' AND reference_key=?").get(journal.operation_id).n,1);
 const successor=f.db.prepare('SELECT expires_at FROM ga_worker_leases WHERE resource_id=?').get('workspace-checkpoint-restore:'+journal.operation_id);clock.value=Number(successor.expires_at)+1;
 await assert.rejects(checkpoints.restore('owner','ws',input),/workspace_checkpoint_blob_changed/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_checkpoint_path_journal WHERE command_key=?').get(input.command_key).n,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM wb_workspace_reservations WHERE operation_kind='workspace_checkpoint_restore' AND operation_id=?").get(journal.operation_id).n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_file_versions WHERE owner_id=? AND workspace_id=? AND project_id=? AND path=?').get('owner','ws',f.scope.project_id,'source.md').n,2);
 assert.deepEqual(currentRow(f,'source.md'),before);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_checkpoint_restore_outcomes WHERE operation_id=?').get(journal.operation_id).n,0);
});

test('parent kill after SQLite commit returns the original outcome without replaying the version write',async t=>{
 const scenario=await restoreCrashScenario(t,'checkpoint-parent-committed'),{f,checkpoints,input}=scenario;
 const {receipt}=await killRestoreChildAtPhase(scenario,'restore_committed');
 const journal=f.db.prepare('SELECT operation_id FROM wb_workspace_checkpoint_path_journal WHERE command_key=?').get(input.command_key),outcome=JSON.parse(f.db.prepare('SELECT outcome_json FROM wb_workspace_checkpoint_restore_outcomes WHERE operation_id=?').get(journal.operation_id).outcome_json);
 assert.equal(journal.operation_id,receipt.operation_id);assert.equal(outcome.outcome,'applied');assert.equal(currentRow(f,'source.md').version,3);
 assert.equal(blobBytes(f,currentRow(f,'source.md')).toString(),'PRIVATE fixture');
 const retry=await checkpoints.restore('owner','ws',input);assert.deepEqual(retry,outcome);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_checkpoint_path_journal WHERE command_key=?').get(input.command_key).n,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM wb_workspace_reservations WHERE operation_kind='workspace_checkpoint_restore' AND operation_id=?").get(journal.operation_id).n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_checkpoint_restore_outcomes WHERE operation_id=?').get(journal.operation_id).n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_file_versions WHERE owner_id=? AND workspace_id=? AND project_id=? AND path=?').get('owner','ws',f.scope.project_id,'source.md').n,3);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases x JOIN wb_workspace_reservations r USING(reservation_id) WHERE r.operation_id=?').get(journal.operation_id).n,1);
});

test('pruning requires a verified backup and every retained review or rollback reference blocks deletion',async t=>{
 process.env.TEMP=join(process.cwd(),'.test-tmp');process.env.TMP=process.env.TEMP;const f=fixture(t);f.file();let verified=0;const checkpoints=await service(f,{verifyBackupProof:(proof,expected)=>{verified++;return proof?.database_backup==='synthetic-verified'&&proof.snapshot_id===expected.snapshot_id&&proof.manifest_sha256===expected.manifest_sha256;}}),checkpoint=await checkpoints.create('owner','ws',{project_id:f.scope.project_id,paths:['source.md'],command_key:'checkpoint-create-retention'}),snapshot=checkpoint.receipt.snapshot_id;
 await checkpoints.reviewRestore('owner','ws',{project_id:f.scope.project_id,checkpoint_id:checkpoint.checkpoint_id,path:'source.md',command_key:'checkpoint-review-retention'});for(const kind of ['upload','unknown','rollback'])checkpoints.retainReference('owner','ws',f.scope.project_id,checkpoint.checkpoint_id,kind,`retained-${kind}`,'source.md');
 const proof={database_backup:'synthetic-verified',snapshot_id:snapshot,manifest_sha256:checkpoint.manifest_sha256};await assert.rejects(checkpoints.prune('owner','ws',f.scope.project_id,checkpoint.checkpoint_id,proof),/workspace_checkpoint_retained_reference/);assert.equal(verified,0);assert.equal(existsSync(join(f.root,'checkpoint-storage',snapshot)),true);
 const eligible=await checkpoints.create('owner','ws',{project_id:f.scope.project_id,paths:['source.md'],command_key:'checkpoint-create-prunable'}),eligibleSnapshot=eligible.receipt.snapshot_id,goodProof={database_backup:'synthetic-verified',snapshot_id:eligibleSnapshot,manifest_sha256:eligible.manifest_sha256};
 await assert.rejects(checkpoints.prune('owner','ws',f.scope.project_id,eligible.checkpoint_id,{...goodProof,snapshot_id:'workspace-snapshot-invalid'}),/workspace_checkpoint_backup_proof_invalid/);assert.equal(verified,1);assert.equal(existsSync(join(f.root,'checkpoint-storage',eligibleSnapshot)),true);
 const outcome=await checkpoints.prune('owner','ws',f.scope.project_id,eligible.checkpoint_id,goodProof);assert.equal(outcome.state,'pruned');assert.equal(verified,3);assert.equal(existsSync(join(f.root,'checkpoint-storage',eligibleSnapshot)),false);
 const other=f.workbench.createAgent('other',{name:'Other owner'});
 await assert.rejects(checkpoints.reconcilePrune('other','ws',other.project_id,eligible.checkpoint_id),/workspace_checkpoint_not_found/);
});

test('checkpoint keyset pages follow the same created_at and checkpoint_id ordering',async t=>{
 process.env.TEMP=join(process.cwd(),'.test-tmp');process.env.TMP=process.env.TEMP;const f=fixture(t);f.file();let tick=Date.parse('2026-01-01T00:00:00.000Z');const checkpoints=await service(f,{now:()=>tick});
 for(let index=0;index<5;index++){tick+=1000;await checkpoints.create('owner','ws',{project_id:f.scope.project_id,paths:['source.md'],command_key:`checkpoint-page-${index}`,...controls()});}
 const first=checkpoints.list('owner','ws',f.scope.project_id,{limit:2}),second=checkpoints.list('owner','ws',f.scope.project_id,{limit:2,before_checkpoint_id:first.next_before_checkpoint_id}),third=checkpoints.list('owner','ws',f.scope.project_id,{limit:2,before_checkpoint_id:second.next_before_checkpoint_id});
 const ids=[...first.items,...second.items,...third.items].map(item=>item.checkpoint_id);assert.equal(ids.length,5);assert.equal(new Set(ids).size,5);assert.equal(first.items[0].created_at>first.items[1].created_at,true);assert.equal(second.items[0].created_at>second.items[1].created_at,true);
});

test('create command retry returns the original snapshot after source changes',async t=>{
 process.env.TEMP=join(process.cwd(),'.test-tmp');process.env.TMP=process.env.TEMP;const f=fixture(t);f.file();const checkpoints=await service(f),input={project_id:f.scope.project_id,paths:['source.md'],command_key:'checkpoint-retry-stable',...controls()};
 const original=await checkpoints.create('owner','ws',input);f.workbench.writeFile('owner','ws',{project_id:f.scope.project_id,path:'source.md',content:'changed after response loss',expected_version:1});
 const retried=await checkpoints.create('owner','ws',input);assert.equal(retried.checkpoint_id,original.checkpoint_id);assert.equal(retried.manifest_sha256,original.manifest_sha256);assert.equal(retried.source_revision,original.source_revision);
});

test('checkpoint snapshot storage cannot overlap the observed project root',async t=>{
 process.env.TEMP=join(process.cwd(),'.test-tmp');process.env.TMP=process.env.TEMP;const f=fixture(t);f.file();const projectRoot=f.workbench.projectRoot('owner','ws',f.scope.project_id),storageRoot=join(projectRoot,'checkpoint-storage');mkdirSync(storageRoot,{recursive:true});const checkpoints=await service(f,{storageRoot});
 await assert.rejects(checkpoints.create('owner','ws',{project_id:f.scope.project_id,paths:['source.md'],command_key:'checkpoint-overlap-01',...controls()}),/workspace_checkpoint_roots_overlap/);
});


test('restore request disposition closes stale command without replay',async t=>{
 const {f,checkpoints,checkpoint,input}=await restoreCrashScenario(t,'restore-disposition');
 const query={project_id:input.project_id,path:input.path,review_id:input.review_id,review_sha256:input.review_sha256};
 assert.equal(checkpoints.restoreRequestStatus('owner','ws',checkpoint.checkpoint_id,input.command_key,query).state,'unobserved');
 f.workbench.writeFile('owner','ws',{project_id:f.scope.project_id,path:'source.md',content:'changed after review',expected_version:2});
 await assert.rejects(checkpoints.restore('owner','ws',input),/workspace_checkpoint_review_changed/);
 const before=f.db.prepare('SELECT total_changes() n').get().n;
 const status=checkpoints.restoreRequestStatus('owner','ws',checkpoint.checkpoint_id,input.command_key,query);
 assert.equal(status.state,'terminal_rejected');assert.equal(status.no_effect,true);
 assert.equal(status.command_sha256,hash(JSON.stringify({checkpoint_id:input.checkpoint_id,command_key:input.command_key,path:input.path,project_id:input.project_id,review_id:input.review_id,review_sha256:input.review_sha256,workspace_id:'ws'})));
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_checkpoint_path_journal').get().n,0);
 await assert.rejects(checkpoints.restore('owner','ws',input),/workspace_checkpoint_review_changed/);
 assert.throws(()=>checkpoints.restoreRequestStatus('owner','ws',checkpoint.checkpoint_id,input.command_key,{...query,path:'other.md'}),/idempotency_conflict/);
 assert.throws(()=>checkpoints.restoreRequestStatus('stranger','ws',checkpoint.checkpoint_id,input.command_key,query));
 assert.equal(currentRow(f,'source.md').version,3);
});

test('restore request journal remains pending after source changes',async t=>{
 const {f,checkpoints,checkpoint,input}=await restoreCrashScenario(t,'restore-pending-status');
 await assert.rejects(checkpoints.restore('owner','ws',{...input,guard:()=>{throw Error('fixture_guard_blocked')}}),/workspace_guard_rejected/);
 const query={project_id:input.project_id,path:input.path,review_id:input.review_id,review_sha256:input.review_sha256};
 assert.equal(checkpoints.restoreRequestStatus('owner','ws',checkpoint.checkpoint_id,input.command_key,query).state,'recorded_pending');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_checkpoint_restore_rejections').get().n,0);
});


test('restore request route is scoped read-only and rejects query substitution',async t=>{
 const {f,checkpoints,checkpoint,input}=await restoreCrashScenario(t,'restore-route-status');
 const {default:Fastify}=await import('fastify');const {registerWorkbenchRoutes}=await import('../../src/workbench/routes.ts');const app=Fastify();t.after(()=>app.close());
 registerWorkbenchRoutes(app,f.workbench,()=> 'owner',undefined,checkpoints);
 const query={project_id:input.project_id,path:input.path,review_id:input.review_id,review_sha256:input.review_sha256},url=`/v1/workspaces/ws/checkpoints/${checkpoint.checkpoint_id}/restore-requests/${input.command_key}?${new URLSearchParams(query)}`;
 const before=f.db.prepare('SELECT total_changes() n').get().n;const response=await app.inject({method:'GET',url});
 assert.equal(response.statusCode,200);assert.equal(response.json().state,'unobserved');assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);assert.match(response.headers['cache-control'],/no-store/);
 assert.notEqual((await app.inject({method:'GET',url:url+'&root=/tmp'})).statusCode,200);
});


test('two original DB producers converge on one immutable no-effect rejection',async t=>{
 const {f,checkpoints,checkpoint,input}=await restoreCrashScenario(t,'restore-rejection-race');
 f.workbench.writeFile('owner','ws',{project_id:f.scope.project_id,path:'source.md',content:'stale before both producers',expected_version:2});
 const source=`import {openProductDatabase} from './src/db/database.ts';import {WorkbenchService} from './src/workbench/service.ts';import {WorkspaceCheckpointService} from './src/workbench/workspace-checkpoints.ts';const [dbPath,root,storage,payload]=process.argv.slice(1);const db=openProductDatabase(dbPath),workbench=new WorkbenchService(db,{workspaceIds:['ws'],root});const service=new WorkspaceCheckpointService(db,workbench,{storageRoot:storage});try{await service.restore('owner','ws',JSON.parse(payload));console.log('unexpected_success');}catch(e){console.log(e.message);}finally{db.close();}`;
 const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',source,join(f.root,'db.sqlite'),join(f.root,'workspace'),join(f.root,'checkpoint-storage'),JSON.stringify({...input,guard:undefined,signal:undefined})],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null)child.kill()});let output='',errors='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>errors+=d);child.on('error',reject);child.on('exit',code=>code===0?resolve(output.trim()):reject(Error(errors)));});
 assert.deepEqual(await Promise.all([run(),run()]),['workspace_checkpoint_review_changed','workspace_checkpoint_review_changed']);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_checkpoint_restore_rejections').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_checkpoint_path_journal').get().n,0);
 assert.equal(currentRow(f,'source.md').version,3);
 const query={project_id:input.project_id,path:input.path,review_id:input.review_id,review_sha256:input.review_sha256};assert.equal(checkpoints.restoreRequestStatus('owner','ws',checkpoint.checkpoint_id,input.command_key,query).state,'terminal_rejected');
});
