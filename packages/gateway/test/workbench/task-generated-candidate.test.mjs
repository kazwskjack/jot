import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {completionFixture,candidate} from './task-completion-fixture.mjs';
import {currentTaskCompletionCandidate} from '../../src/persistent-tasks/completion-candidates.ts';
import {ArtifactArchiveService} from '../../src/artifacts/archive-service.ts';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

test('task review freezes generated document parts from the producing occurrence and detects changed bytes',async t=>{
 const value={...candidate,artifact_refs:[]};let artifact;
 const f=await completionFixture(t,{candidate:value,prepare:f=>{
  const root=f.workbench.projectRoot('alice','ws',f.workbench.contextForRun(f.runId).project_id);mkdirSync(root,{recursive:true});
  const path=join(root,'candidate-report.md');writeFileSync(path,'Reviewed generated document');
  artifact=f.artifacts.registerGenerated(f.runId,'candidate-rendered-report',[{path,display_name:'report.md'}]);
  value.artifact_refs.push('candidate-rendered-report');
 }});
 const frozen=currentTaskCompletionCandidate(f.db,'alice',f.runId);
 const output=frozen.snapshot.artifact_outputs?.[0];
 assert.ok(output?.verified,'the candidate must freeze actual producer provenance');
 assert.equal(output.reference,'candidate-rendered-report');assert.equal(output.artifact_id,artifact.artifact_ref);
 assert.equal(output.run_id,f.runId);assert.equal(output.version,1);assert.equal(output.content_verified,true);
 assert.equal(output.parts[0].display_name,'report.md');assert.ok(!JSON.stringify(output).includes('server_path'));
 const card=(await f.list())[0];assert.match(card.questions[0].description,/report\.md.*v1.*SHA256/);
 const physical=f.db.prepare('SELECT server_path FROM ga_artifact_parts WHERE artifact_id=?').get(artifact.artifact_ref);
 writeFileSync(physical.server_path,'Replacement bytes must not pass owner review');
 assert.throws(()=>currentTaskCompletionCandidate(f.db,'alice',f.runId),/generated_artifact_content_mismatch/);
});

test('unknown artifact reference stays explicitly unverified and cannot gain provenance from later registration',async t=>{
 const f=await completionFixture(t,{candidate:{...candidate,artifact_refs:['missing-renderer-reference']}});
 const frozen=currentTaskCompletionCandidate(f.db,'alice',f.runId);
 assert.deepEqual(frozen.snapshot.artifact_outputs,[{reference:'missing-renderer-reference',verified:false}]);
 const root=f.workbench.projectRoot('alice','ws',f.workbench.contextForRun(f.runId).project_id);mkdirSync(root,{recursive:true});
 const path=join(root,'late.md');writeFileSync(path,'Too late to authorize the frozen candidate');
 f.artifacts.registerGenerated(f.runId,'missing-renderer-reference',[{path,display_name:'late.md'}]);
 assert.deepEqual(currentTaskCompletionCandidate(f.db,'alice',f.runId).snapshot.artifact_outputs,[{reference:'missing-renderer-reference',verified:false}]);
});

test('another conversation generated document cannot become this occurrence output even with the same owner',async t=>{
 const value={...candidate,artifact_refs:[]};
 const f=await completionFixture(t,{candidate:value,prepare:f=>{
  const c=f.conversations.create('alice',{workspace_id:'ws',model:{provider:'fixture',model:'bounded'}});
  const other=f.runs.enqueue(c.conversation_id,'alice',{client_message_id:'unrelated-renderer',content:[{type:'text',text:'Unrelated report'}]});
  const root=f.workbench.projectRoot('alice','ws',f.workbench.contextForRun(f.runId).project_id);mkdirSync(root,{recursive:true});
  const path=join(root,'unrelated.md');writeFileSync(path,'Owned but unrelated');
  const group=f.artifacts.registerGenerated(other.run_id,'unrelated-rendered-group',[{path,display_name:'unrelated.md'}]);value.artifact_refs.push(group.artifact_ref);
 }});
 assert.deepEqual(currentTaskCompletionCandidate(f.db,'alice',f.runId).snapshot.artifact_outputs,[{reference:value.artifact_refs[0],verified:false}]);
});

test('pending generated document review retains the original artifact through the cleanup window',async t=>{
 const value={...candidate,artifact_refs:[]};let group;
 const f=await completionFixture(t,{candidate:value,prepare:f=>{
  const root=f.workbench.projectRoot('alice','ws',f.workbench.contextForRun(f.runId).project_id);mkdirSync(root,{recursive:true});
  const path=join(root,'pending-review.md');writeFileSync(path,'Original pending review');
  group=f.artifacts.registerGenerated(f.runId,'pending-review-source',[{path,display_name:'pending-review.md'}]);value.artifact_refs.push(group.artifact_ref);
 }});
 const remote=new Map(),archive=new ArtifactArchiveService(f.db,f.fixtureConfig.uploadRoot,{mkdir:async()=>{},upload:async(path,dir,name)=>remote.set(`${dir}/${name}`,readFileSync(path)),
  meta:async path=>{const data=remote.get(path);return data?{size:data.length,md5:createHash('md5').update(data).digest('hex')}:null;},download:async()=>{throw new Error('unexpected_download');}});
 assert.equal((await archive.archivePending()).verified,1);
 assert.equal(archive.cleanupVerified(new Date(Date.now()+48*3600000)).deleted,0);
 assert.equal(currentTaskCompletionCandidate(f.db,'alice',f.runId).snapshot.artifact_outputs[0].verified,true);
});
