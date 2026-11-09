import {createHash} from 'node:crypto';
import {canonicalJson} from '../db/canonical-json.ts';
import {gitBranchPreparation,type GitBranchPreparation} from './branch-evidence.ts';
import {branchReflogEntry} from './branch-metadata.ts';
import {readIndexProducerRecord} from './index-producers.ts';
import type {DatabaseSync} from 'node:sqlite';
import type {GitBranchExecutionFacts,GitBranchPendingResult,GitBranchClosedResult,GitBranchAppliedResult} from '../../contracts/types.ts';
import type {Row,Disposition} from './index-journal.ts';
import {readGitCreateBranchExecutionSource} from './branch-records.ts';

export function branchExecutionFacts(db:DatabaseSync,row:Row):GitBranchExecutionFacts{
 if(row.action!=='create-branch'||row.protocol!==6)throw Error('git_execution_evidence_corrupt');
 const {branch,witness,metadata}=readGitCreateBranchExecutionSource(db,row);
 return{action:'create-branch',branch,target_ref:witness.target_ref,target_oid:witness.target_oid,head:witness.head,...(metadata?{branch_metadata:metadata}:{})};
}
export function branchClosedResult(db:DatabaseSync,row:Row,disposition:Disposition):GitBranchClosedResult{
 return{execution_id:row.execution_id,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,
  ...branchExecutionFacts(db,row),paths:[],state:disposition.kind,disposition_id:disposition.control_id,execution_authorized:false};
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

export function validateBranchPreparation(db:DatabaseSync,row:Row,preparation:GitBranchPreparation){
 if(row.action!=='create-branch'||row.protocol!==6)throw Error('git_execution_evidence_corrupt');
 const source=readGitCreateBranchExecutionSource(db,row),{witness,metadata,branch}=source,{plan}=preparation;
 if(witness.protocol!==2||!witness.configuration||!metadata||plan.repository_sha256!==row.repository_sha256
  ||plan.source_sha256!==row.witness_sha256||plan.review_sha256!==row.review_sha256||plan.metadata_sha256!==hash(canonicalJson(metadata))
  ||plan.branch!==branch||plan.target_ref!==witness.target_ref||plan.target_oid!==witness.target_oid||plan.object_format!==witness.object_format
  ||plan.index_sha256!==witness.index_sha256||plan.source_ref!==(witness.head.detached?null:'refs/heads/'+witness.head.branch)
  ||plan.configuration_changed!==witness.configuration.changed||canonicalJson(plan.logs)!==canonicalJson(metadata.logs))throw Error('git_execution_evidence_corrupt');
 for(const file of preparation.files){
  if(file.path==='HEAD'){
   if(file.after.sha256!==hash('ref: '+witness.target_ref+'\n')||file.after.size!==Buffer.byteLength('ref: '+witness.target_ref+'\n','utf8'))throw Error('git_execution_evidence_corrupt');
  }else if(file.path===witness.target_ref){
   if(file.before!==null||file.after.sha256!==hash(witness.target_oid+'\n')||file.after.size!==witness.target_oid!.length+1)throw Error('git_execution_evidence_corrupt');
  }else if(file.path==='config'){
   if((file.before?.sha256??null)!==witness.configuration.before_sha256||file.after.sha256!==witness.configuration.after_sha256)throw Error('git_execution_evidence_corrupt');
  }else{
   const original=file.scope==='git'?witness.reflog.head:witness.reflog.branch;
   if((file.before?.sha256??null)!==original.sha256||(file.before?.size??0)!==original.size
    ||file.after.size!==original.size+branchReflogEntry(witness,metadata,file.scope).length)throw Error('git_execution_evidence_corrupt');
  }
 }
}
function recordedBranchPreparation(db:DatabaseSync,row:Row,table:'wb_git_index_preparations'|'wb_git_index_dispatches'){
 const record=db.prepare('SELECT evidence_json,evidence_sha256,lease_owner,lease_generation FROM '+table+' WHERE execution_id=?').get(row.execution_id) as
  {evidence_json:string;evidence_sha256:string;lease_owner:string;lease_generation:number}|undefined;
 if(!record)return;
 const value=JSON.parse(record.evidence_json),producer=readIndexProducerRecord(db,row);
 if(digest(value)!==record.evidence_sha256||!producer||record.lease_owner!==producer.start.lease.owner
  ||record.lease_generation!==producer.start.lease.generation)throw Error('git_execution_evidence_corrupt');
 const preparation=gitBranchPreparation(value);validateBranchPreparation(db,row,preparation);return preparation;
}
export function readBranchPreparation(db:DatabaseSync,row:Row){return recordedBranchPreparation(db,row,'wb_git_index_preparations');}
export function readBranchDispatch(db:DatabaseSync,row:Row){
 const dispatch=recordedBranchPreparation(db,row,'wb_git_index_dispatches');
 if(dispatch&&canonicalJson(dispatch)!==canonicalJson(readBranchPreparation(db,row)))throw Error('git_execution_evidence_corrupt');
 return dispatch;
}
/** Original branch evidence stays in the original preparation/dispatch namespace. */
export function branchAppliedResult(db:DatabaseSync,row:Row,preparation:GitBranchPreparation):GitBranchAppliedResult{
 validateBranchPreparation(db,row,preparation);
 return{execution_id:row.execution_id,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,
  ...branchExecutionFacts(db,row),paths:[],state:'applied',preparation_sha256:hash(canonicalJson(preparation)),execution_authorized:false};
}
export function readBranchRecordedResult(db:DatabaseSync,row:Row):GitBranchPendingResult|GitBranchAppliedResult{
 const facts=branchExecutionFacts(db,row),preparation=readBranchPreparation(db,row),dispatch=readBranchDispatch(db,row);
 if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='wb_git_index_ref_preparations'").get()
  &&db.prepare('SELECT 1 FROM wb_git_index_ref_preparations WHERE execution_id=?').get(row.execution_id))throw Error('git_execution_evidence_corrupt');
 const outcome=db.prepare('SELECT receipt_json,receipt_sha256 FROM wb_git_index_outcomes WHERE execution_id=?').get(row.execution_id) as {receipt_json:string;receipt_sha256:string}|undefined;
 if(outcome){
  const value=JSON.parse(outcome.receipt_json);
  if(!dispatch||digest(value)!==outcome.receipt_sha256||JSON.stringify(value)!==JSON.stringify(branchAppliedResult(db,row,dispatch)))throw Error('git_execution_outcome_corrupt');
  return value;
 }
 return{execution_id:row.execution_id,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,
  ...facts,paths:[],state:preparation||dispatch?'unknown':'pending',execution_authorized:false};
}
