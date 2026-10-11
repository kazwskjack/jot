import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,renameSync,mkdirSync,symlinkSync,unlinkSync} from 'node:fs';
import {dirname,join,basename} from 'node:path';
import {completionFixture} from './task-completion-fixture.mjs';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {ArtifactArchiveService} from '../../src/artifacts/archive-service.ts';

async function archivedFixture(t){
 let proof;
 const f=await completionFixture(t,{prepare:f=>{
  proof=withImmediateTransaction(f.db,()=>{
   const written=f.workbench.writeFile('alice','ws',{project_id:f.workbench.contextForRun(f.runId).project_id,path:'archive.md',content:'Original reviewed bytes',expected_version:0},f.runId);
   return new TaskExecutionEvidence(f.db).record(f.runId,'archive-output','files.write',written);
  });
 }});
 const artifact=withImmediateTransaction(f.db,()=>f.artifacts.registerTaskFileVersion({runId:f.runId,receiptId:proof.reference,content:'Original reviewed bytes'}));
 const id=artifact.artifact_id,local=f.db.prepare('SELECT server_path FROM ga_artifact_versions WHERE artifact_id=?').get(id).server_path;
 const remote=new Map();let transfers=0;
 const client={mkdir:async()=>{},upload:async(path,dir,name)=>{transfers++;remote.set(`${dir}/${name}`,readFileSync(path));},
  meta:async path=>{const bytes=remote.get(path);return bytes?{size:bytes.length,md5:createHash('md5').update(bytes).digest('hex')}:null;},
  download:async(path,local)=>writeFileSync(local,remote.get(path))};
 const archive=new ArtifactArchiveService(f.db,f.fixtureConfig.uploadRoot,client);
 return {...f,id,local,remote,archive,transfers:()=>transfers};
}

test('archive refuses a same-size corrupted task delivery instead of backing up and deleting unreviewed bytes',async t=>{
 const f=await archivedFixture(t);writeFileSync(f.local,'Original corrupted byte');
 assert.equal(readFileSync(f.local).length,Buffer.byteLength('Original reviewed bytes'));
 const result=await f.archive.archivePending();assert.equal(result.verified,0);assert.equal(result.failed,1);
 assert.equal(f.transfers(),0);assert.equal(f.db.prepare('SELECT backup_status FROM ga_artifact_archives WHERE artifact_id=?').get(f.id).backup_status,'retry');
 assert.equal(f.archive.cleanupVerified(new Date(Date.now()+48*3600000)).deleted,0);assert.ok(existsSync(f.local));
});

test('archived fixed task output restores original bytes and rejects changed backup contents',async t=>{
 const f=await archivedFixture(t);assert.equal((await f.archive.archivePending()).failed,0);
 // Renderer source group may also be pending in other cases; this fixture has
 // only the immutable task output, and retention is tested without wall waits.
 const future=new Date(Date.now()+48*3600000);assert.equal(f.archive.cleanupVerified(future).deleted,1);
 assert.throws(()=>f.artifacts.download(f.id,'alice',1),/artifact_restore_required/);
 assert.throws(()=>f.artifacts.requestRestore(f.id,'bob'),/artifact_not_found/);
 f.artifacts.requestRestore(f.id,'alice');assert.equal((await f.archive.restorePending()).restored,1);
 assert.equal(f.artifacts.download(f.id,'alice',1).verified_content.toString(),'Original reviewed bytes');
 assert.equal(f.artifacts.preview(f.id,'alice',1).text,'Original reviewed bytes');
 f.archive.cleanupVerified(future);
 for(const path of f.remote.keys())f.remote.set(path,Buffer.from('Original corrupted byte'));
 f.artifacts.requestRestore(f.id,'alice');assert.equal((await f.archive.restorePending()).failed,1);
 assert.throws(()=>f.artifacts.download(f.id,'alice',1),/artifact_restore_required/);
});

test('archive rejects a directory junction pointing outside its authorized artifact root',async t=>{
 const f=await archivedFixture(t),parent=dirname(f.local),outside=join(f.fixtureConfig.workbenchRoot,'junction-target');mkdirSync(outside,{recursive:true});
 const outsideFile=join(outside,basename(f.local));writeFileSync(outsideFile,'Original reviewed bytes');
 renameSync(parent,parent+'-original');symlinkSync(outside,parent,'junction');
 try{
  const result=await f.archive.archivePending();assert.equal(result.verified,0);assert.equal(result.failed,1);assert.equal(f.transfers(),0);
  assert.equal(readFileSync(outsideFile,'utf8'),'Original reviewed bytes');
 }finally{unlinkSync(parent);renameSync(parent+'-original',parent);}
});

for(const operation of ['cleanup','restore'])test(`${operation} cannot delete or overwrite through a directory junction`,async t=>{
 const f=await archivedFixture(t);assert.equal((await f.archive.archivePending()).verified,1);
 const future=new Date(Date.now()+48*3600000);
 if(operation==='restore')assert.equal(f.archive.cleanupVerified(future).deleted,1);
 const parent=dirname(f.local),outside=join(f.fixtureConfig.workbenchRoot,'guarded-target');mkdirSync(outside,{recursive:true});
 const outsideFile=join(outside,basename(f.local));writeFileSync(outsideFile,'Outside sentinel bytes');
 mkdirSync(parent,{recursive:true});renameSync(parent,parent+'-original');symlinkSync(outside,parent,'junction');
 try{
  if(operation==='cleanup')assert.throws(()=>f.archive.cleanupVerified(future),/archive_path_unsafe/);
  else{f.artifacts.requestRestore(f.id,'alice');assert.equal((await f.archive.restorePending()).failed,1);}
  assert.equal(readFileSync(outsideFile,'utf8'),'Outside sentinel bytes');
 }finally{unlinkSync(parent);renameSync(parent+'-original',parent);}
});

