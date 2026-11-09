import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {GitIndexExecutionResult} from '../../contracts/types.ts';
import type {Row} from './index-journal.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {readCommitExecutionSource} from './commit-records.ts';
import {gitCommitObject} from './commit-metadata.ts';
import {gitCommitEvidence,gitCommitPreparation,type GitCommitEvidence} from './commit-evidence.ts';
import {gitCommitRefPreparation,type GitCommitRefPreparation} from './commit-ref-evidence.ts';
import {readIndexProducerRecord} from './index-producers.ts';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
type RecordRow={evidence_json:string;evidence_sha256:string;lease_owner:string;lease_generation:number};
function requireCommit(row:Row){if(row.action!=='commit'||row.protocol!==5)throw Error('git_execution_evidence_corrupt');}
function recorded(db:DatabaseSync,row:Row,table:'wb_git_index_preparations'|'wb_git_index_dispatches'|'wb_git_index_ref_preparations'){
 requireCommit(row);
 if(table==='wb_git_index_ref_preparations'&&!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))return;
 const record=db.prepare('SELECT * FROM '+table+' WHERE execution_id=?').get(row.execution_id) as RecordRow|undefined;
 if(!record)return;
 const value=JSON.parse(record.evidence_json),producer=readIndexProducerRecord(db,row);
 if(digest(value)!==record.evidence_sha256||!producer||record.lease_owner!==producer.start.lease.owner||record.lease_generation!==producer.start.lease.generation)throw Error('git_execution_evidence_corrupt');
 return value;
}

/** Immutable approved facts only. Current owner, policy and native custody are
 * rechecked separately by the owning execution service before effects. */
export function validateCommitEvidence(db:DatabaseSync,row:Row,evidence:GitCommitEvidence){
 requireCommit(row);
 const source=readCommitExecutionSource(db,row),{metadata,witness}=source,plan=evidence.plan,commit=gitCommitObject(metadata,source.message);
 if(plan.repository_sha256!==row.repository_sha256||plan.source_sha256!==row.witness_sha256||plan.review_sha256!==row.review_sha256
  ||plan.metadata_sha256!==hash(canonicalJson(metadata))||plan.object_format!==metadata.object_format||plan.tree_oid!==metadata.tree_oid
  ||plan.parent_oid!==metadata.parent_oid||plan.target_ref!==metadata.target_ref||plan.index_sha256!==witness.index_sha256
  ||plan.commit_oid!==commit.oid||plan.commit_sha256!==commit.sha256||plan.commit_size!==commit.body.length
  ||JSON.stringify(plan.paths)!==JSON.stringify(source.paths))throw Error('git_execution_evidence_corrupt');
}
export function readCommitObjectPreparation(db:DatabaseSync,row:Row){
 const value=recorded(db,row,'wb_git_index_preparations');if(value===undefined)return;
 const preparation=gitCommitPreparation(value);validateCommitEvidence(db,row,preparation.evidence);return preparation;
}
export function readCommitObjectDispatch(db:DatabaseSync,row:Row){
 const value=recorded(db,row,'wb_git_index_dispatches');if(value===undefined)return;
 const evidence=gitCommitEvidence(value);validateCommitEvidence(db,row,evidence);
 if(JSON.stringify(readCommitObjectPreparation(db,row)?.evidence)!==JSON.stringify(evidence))throw Error('git_execution_evidence_corrupt');
 return evidence;
}
export function readCommitRefPreparation(db:DatabaseSync,row:Row){
 const value=recorded(db,row,'wb_git_index_ref_preparations');if(value===undefined)return;
 const preparation=gitCommitRefPreparation(value);
 if(JSON.stringify(readCommitObjectDispatch(db,row))!==JSON.stringify(preparation.evidence))throw Error('git_execution_evidence_corrupt');
 return preparation;
}
export function commitAppliedResult(db:DatabaseSync,row:Row,preparation:GitCommitRefPreparation):Extract<GitIndexExecutionResult,{action:'commit';state:'applied'}>{
 validateCommitEvidence(db,row,preparation.evidence);
 const {plan}=preparation.evidence;
 return {execution_id:row.execution_id,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,action:'commit',paths:[...plan.paths],
  target_ref:plan.target_ref,expected_old_oid:plan.parent_oid,state:'applied',commit_oid:plan.commit_oid,tree_oid:plan.tree_oid,execution_authorized:false};
}
/** Original journal read, with no installer, lease claim or native IO. */
export function readCommitRecordedResult(db:DatabaseSync,row:Row):GitIndexExecutionResult{
 const preparation=readCommitObjectPreparation(db,row),dispatch=readCommitObjectDispatch(db,row),publication=readCommitRefPreparation(db,row);
 const outcome=db.prepare('SELECT receipt_json,receipt_sha256 FROM wb_git_index_outcomes WHERE execution_id=?').get(row.execution_id) as {receipt_json:string;receipt_sha256:string}|undefined;
 if(outcome){
  const result=JSON.parse(outcome.receipt_json);
  if(!publication||digest(result)!==outcome.receipt_sha256||JSON.stringify(result)!==JSON.stringify(commitAppliedResult(db,row,publication)))throw Error('git_execution_outcome_corrupt');
  return result;
 }
 const {metadata,paths}=readCommitExecutionSource(db,row);
 return {execution_id:row.execution_id,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,action:'commit',paths,
  target_ref:metadata.target_ref,expected_old_oid:metadata.parent_oid,state:preparation||dispatch||publication?'unknown':'pending',execution_authorized:false};
}
