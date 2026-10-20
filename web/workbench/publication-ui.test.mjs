import test from 'node:test';
import assert from 'node:assert/strict';
import {publicationSelection,publicationStatusPresentation,publicationRecoveryCommand,publicationMutationCanRetry,publicationOccurrence,publicationHistorySelection} from './publication-ui.mjs';

const sha='a'.repeat(64),other='b'.repeat(64),scope={project_id:'project',run_id:'run',task_id:'task'};
function source(){return{...scope,source:'isolated',source_sha256:sha,files:[{path:'source.md',version:1,sha256:sha,size_bytes:8}],work_review:{execution_authorized:false,diff:{changes:[{kind:'modify',path:'source.md',mode_changed:false,after:{kind:'file',path:'source.md',sha256:sha,bytes:8,executable:false}}]}}}}
const status=(state='interrupted')=>({execution_id:'execution',project_id:'project',state,journal_sha256:sha});

test('refreshing the first history page retains a selected older original review without duplicating its option',()=>{
 const recent={intent_id:'recent'},older={intent_id:'older'};
 assert.deepEqual(publicationHistorySelection([recent],[recent,older],'older'),[recent,older]);
 assert.deepEqual(publicationHistorySelection([recent,older],[older],'older'),[recent,older]);
 assert.deepEqual(publicationHistorySelection([recent],[older],undefined),[recent]);
});

test('publication entry requires the completed original task occurrence and stable source IDs',()=>{
 const row={status:'succeeded',completion_state:'completed',conversation_id:'conversation',run_id:'run'};
 assert.deepEqual(publicationOccurrence('task',row),{taskId:'task',conversationId:'conversation',runId:'run'});
 for(const bad of [{...row,status:'partial'},{...row,completion_state:'awaiting_completion'},{...row,run_id:''},{...row,conversation_id:undefined},null])assert.equal(publicationOccurrence('task',bad),null);
 assert.equal(publicationOccurrence('../other',row),null);
});

test('only exact original text-file proofs become proposed publication choices',()=>{
 assert.deepEqual(publicationSelection(source(),scope),['source.md']);
 for(const mutate of [s=>s.run_id='other',s=>s.project_id='foreign',s=>s.task_id='other',s=>s.files[0].sha256=other,s=>s.files[0].path='../escape']){const value=source();mutate(value);assert.throws(()=>publicationSelection(value,scope),/PUBLICATION_SOURCE_UNCONFIRMED/)}
 const unsupported=source();unsupported.work_review.diff.changes[0].mode_changed=true;assert.deepEqual(publicationSelection(unsupported,scope),[]);
});

test('acceptance, applied-pending and actual completion have distinct presentation',()=>{
 assert.equal(publicationStatusPresentation('not_started').label,'已受理，尚未应用');assert.equal(publicationStatusPresentation('applied_pending_settlement').complete,false);assert.equal(publicationStatusPresentation('applied').complete,true);
 assert.equal(publicationStatusPresentation('unrecognized').blocked,true);assert.equal(publicationStatusPresentation('running').canRecover,false);
});

test('unknown effects need explicit acknowledgement and a real original journal digest',()=>{
 const input={request_id:'command',action:'abandon_unknown',acknowledge_unknown:true};
 assert.deepEqual(publicationRecoveryCommand(status(),input),{...input,expected_journal_sha256:sha});
 for(const [value,request] of [[status('running'),input],[{...status(),journal_sha256:null},input],[status(),{...input,acknowledge_unknown:false}],[status(),{...input,action:'confirm_recorded'}],[status('not_started'),input]])assert.throws(()=>publicationRecoveryCommand(value,request),/PUBLICATION_RECOVERY_UNCONFIRMED/);
});

test('a recorded pending command retains its original identity and CAS rather than using the newest digest',()=>{
 const receipt={execution_id:'execution',project_id:'project',request_id:'original-command',action:'abandon_unknown',expected_journal_sha256:sha,acknowledge_unknown:true,disposition_sha256:other,execution_authorized:false};
 const current={...status('abandon_pending_settlement'),journal_sha256:other},input={request_id:'replacement',action:'abandon_unknown',acknowledge_unknown:true};
 assert.deepEqual(publicationRecoveryCommand(current,input,receipt),{request_id:'original-command',action:'abandon_unknown',expected_journal_sha256:sha,acknowledge_unknown:true});
 for(const changed of [{...receipt,execution_id:'other'},{...receipt,project_id:'foreign'},{...receipt,disposition_sha256:sha}])assert.throws(()=>publicationRecoveryCommand(current,input,changed),/PUBLICATION_RECOVERY_UNCONFIRMED/);
 assert.throws(()=>publicationRecoveryCommand(current,input),/PUBLICATION_RECOVERY_UNCONFIRMED/);
});

test('a recorded applied effect can be proposed for confirmation but not abandoned',()=>{
 const input={request_id:'confirm',action:'confirm_recorded',acknowledge_unknown:true};
 assert.equal(publicationRecoveryCommand(status('applied_pending_settlement'),input).action,'confirm_recorded');
 assert.throws(()=>publicationRecoveryCommand(status('applied_pending_settlement'),{...input,action:'abandon_unknown'}),/PUBLICATION_RECOVERY_UNCONFIRMED/);
});

test('only atomic review and acceptance commands offer exact-request retry',()=>{
 for(const kind of ['prepare','approve','cancel','admit'])assert.equal(publicationMutationCanRetry(kind),true);
 for(const kind of ['dispatch','settle','unknown'])assert.equal(publicationMutationCanRetry(kind),false);
});
