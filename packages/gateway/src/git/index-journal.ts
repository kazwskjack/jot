import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {GitIndexAcceptance,GitIndexExecutionResult} from '../../contracts/types.ts';
import {indexEvidence,indexPreparation,type GitIndexEvidence,type GitIndexPreparation} from './index-evidence.ts';
import {readRecordedGitMutationIntent} from './intent-reads.ts';

/** Original journal readers shared by execution and settlement. No constructor,
 * installer, lease, filesystem action, migration or new authority lives here. */
export type Row={execution_id:string;owner_id:string;project_id:string;intent_id:string;request_id:string;request_sha256:string;review_version:number;review_sha256:string;action:'stage'|'unstage';witness_sha256:string;repository_sha256:string;created_at:string;protocol:number;binding_sha256:string|null};
export type Dispatch={evidence_json:string;evidence_sha256:string};
export type Outcome={receipt_json:string;receipt_sha256:string};
export type Acceptance=GitIndexAcceptance;
export type ExecutionResult=GitIndexExecutionResult;
export type AppliedResult=Extract<ExecutionResult,{state:'applied'}>;
export type ClosedResult=Extract<ExecutionResult,{disposition_id:string}>;
export type Control={control_id:string;execution_id:string;owner_id:string;project_id:string;request_id:string;request_sha256:string;expected_state_sha256:string;created_at:string};
export type Disposition={execution_id:string;control_id:string;kind:'not_dispatched'|'abandoned_unknown';snapshot_sha256:string;created_at:string};
export type Cleanup='verified'|'unverified'|'not_recorded'|'not_attempted';
export type ControlReceipt={control_id:string;execution_id:string;request_id:string;state:'completed';result:AppliedResult|ClosedResult;cleanup:Cleanup;execution_authorized:false};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SHA=/^[a-f0-9]{64}$/;

export function readIndexExecutionRow(db:DatabaseSync,owner:string,project:string,id:string):Row{if(!db.prepare('SELECT 1 FROM ga_projects WHERE id=? AND owner_id=?').get(project,owner))throw Error('project_not_found');return readIndexExecutionRecord(db,owner,project,id);}
/** Original immutable record identity, not current-owner read/effect authority. */
export function readIndexExecutionRecord(db:DatabaseSync,owner:string,project:string,id:string):Row{const row=db.prepare('SELECT * FROM wb_git_index_executions WHERE execution_id=? AND owner_id=? AND project_id=?').get(id,owner,project) as Row|undefined;if(!row)throw Error('git_execution_not_found');if(![1,2,3,4].includes(row.protocol)||row.protocol>=3&&(typeof row.binding_sha256!=='string'||!SHA.test(row.binding_sha256))||row.protocol<3&&row.binding_sha256!==null)throw Error('git_execution_evidence_corrupt');return row;}

export function readIndexPreparation(db:DatabaseSync,row:Row):GitIndexPreparation|undefined{
  const record=db.prepare('SELECT * FROM wb_git_index_preparations WHERE execution_id=?').get(row.execution_id) as Dispatch|undefined;if(!record)return;
  const value=JSON.parse(record.evidence_json);if(digest(value)!==record.evidence_sha256)throw Error('git_execution_evidence_corrupt');const preparation=indexPreparation(value);validateIndexEvidence(db,row,preparation.evidence);return preparation;
 }

export function validateIndexEvidence(db:DatabaseSync,row:Row,evidence:GitIndexEvidence){
  const review=readRecordedGitMutationIntent(db,row.owner_id,row.project_id,row.intent_id);
  if(evidence.source_sha256!==row.witness_sha256||evidence.plan.repository_sha256!==row.repository_sha256||evidence.plan.action!==row.action||JSON.stringify(evidence.plan.paths)!==JSON.stringify(review.paths))throw Error('git_execution_evidence_corrupt');
 }

export function readIndexDispatch(db:DatabaseSync,row:Row):GitIndexEvidence|undefined{
  const record=db.prepare('SELECT * FROM wb_git_index_dispatches WHERE execution_id=?').get(row.execution_id) as Dispatch|undefined;if(!record)return;
  const value=JSON.parse(record.evidence_json);if(digest(value)!==record.evidence_sha256)throw Error('git_execution_evidence_corrupt');const evidence=indexEvidence(value);validateIndexEvidence(db,row,evidence);if(row.protocol>=2&&JSON.stringify(readIndexPreparation(db,row)?.evidence)!==JSON.stringify(evidence))throw Error('git_execution_evidence_corrupt');return evidence;
 }

export function indexAppliedResult(db:DatabaseSync,row:Row,evidence:GitIndexEvidence){return{execution_id:row.execution_id,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,action:row.action,paths:[...evidence.plan.paths],state:'applied' as const,before_index_sha256:evidence.plan.before_index_sha256,index_sha256:evidence.plan.index_sha256,execution_authorized:false as const};}

export function readIndexDisposition(db:DatabaseSync,row:Row):Disposition|undefined{
  const d=db.prepare('SELECT * FROM wb_git_index_dispositions WHERE execution_id=?').get(row.execution_id) as Disposition|undefined;if(!d)return;
  const control=db.prepare('SELECT * FROM wb_git_index_controls WHERE control_id=?').get(d.control_id) as Control|undefined;
  if(!control||control.execution_id!==row.execution_id||control.owner_id!==row.owner_id||control.project_id!==row.project_id||control.expected_state_sha256!==d.snapshot_sha256||control.request_sha256!==digest({execution_id:row.execution_id,request_id:control.request_id,expected_state_sha256:control.expected_state_sha256,acknowledge_unknown:true})||!['not_dispatched','abandoned_unknown'].includes(d.kind)||d.kind==='not_dispatched'&&(row.protocol===1||db.prepare('SELECT 1 FROM wb_git_index_dispatches WHERE execution_id=?').get(row.execution_id)))throw Error('git_execution_evidence_corrupt');
  const saved=db.prepare('SELECT * FROM wb_git_index_control_receipts WHERE control_id=?').get(d.control_id) as Outcome|undefined;if(!saved)throw Error('git_execution_outcome_corrupt');const receipt=JSON.parse(saved.receipt_json);
  if(digest(receipt)!==saved.receipt_sha256||!['verified','unverified','not_recorded','not_attempted'].includes(receipt.cleanup)||JSON.stringify(receipt)!==JSON.stringify(indexControlReceipt(db,control,indexClosedResult(db,row,d),receipt.cleanup)))throw Error('git_execution_outcome_corrupt');return d;
 }

export function indexClosedResult(db:DatabaseSync,row:Row,d:Disposition):ClosedResult{const review=readRecordedGitMutationIntent(db,row.owner_id,row.project_id,row.intent_id);return{execution_id:row.execution_id,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,action:row.action,paths:review.paths,state:d.kind,disposition_id:d.control_id,execution_authorized:false};}

export function readIndexExecutionResult(db:DatabaseSync,owner:string,project:string,id:string):ExecutionResult{return readIndexRecordedResult(db,readIndexExecutionRow(db,owner,project,id));}

/** Shared original result validation on an already selected immutable record.
 * No current-owner capability is created by inspecting historical drain facts. */
export function readIndexRecordedResult(db:DatabaseSync,row:Row):ExecutionResult{
  const evidence=readIndexDispatch(db,row),outcome=db.prepare('SELECT * FROM wb_git_index_outcomes WHERE execution_id=?').get(row.execution_id) as Outcome|undefined,disposition=readIndexDisposition(db,row);
  if(outcome&&disposition)throw Error('git_execution_outcome_corrupt');
  if(outcome){const result=JSON.parse(outcome.receipt_json);if(!evidence||digest(result)!==outcome.receipt_sha256||JSON.stringify(result)!==JSON.stringify(indexAppliedResult(db,row,evidence)))throw Error('git_execution_outcome_corrupt');return result as ReturnType<typeof indexAppliedResult>;}
  if(disposition)return indexClosedResult(db,row,disposition);
  const review=readRecordedGitMutationIntent(db,row.owner_id,row.project_id,row.intent_id);return{execution_id:row.execution_id,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,action:row.action,paths:review.paths,state:evidence||readIndexPreparation(db,row)||row.protocol===1?'unknown' as const:'pending' as const,execution_authorized:false as const};
 }

export function indexAcceptance(db:DatabaseSync,row:Row):Acceptance{return{execution_id:row.execution_id,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,action:row.action,accepted:true,execution_authorized:false};}

export function readIndexAdmission(db:DatabaseSync,row:Row):Acceptance{
  const saved=db.prepare('SELECT * FROM wb_git_index_admissions WHERE execution_id=?').get(row.execution_id) as Outcome|undefined;if(!saved)throw Error('git_admission_not_found');const value=JSON.parse(saved.receipt_json);
  if(row.request_sha256!==digest({intent_id:row.intent_id,request_id:row.request_id,expected_version:row.review_version,review_sha256:row.review_sha256})||digest(value)!==saved.receipt_sha256||JSON.stringify(value)!==JSON.stringify(indexAcceptance(db,row)))throw Error('git_admission_receipt_corrupt');return value as Acceptance;
 }

export function indexControlReceipt(db:DatabaseSync,control:Control,result:AppliedResult|ClosedResult,cleanup:Cleanup):ControlReceipt{return{control_id:control.control_id,execution_id:control.execution_id,request_id:control.request_id,state:'completed',result,cleanup,execution_authorized:false};}

export function validateIndexControl(db:DatabaseSync,row:Row,control:Control){
  if(control.execution_id!==row.execution_id||control.owner_id!==row.owner_id||control.project_id!==row.project_id||control.request_sha256!==digest({execution_id:row.execution_id,request_id:control.request_id,expected_state_sha256:control.expected_state_sha256,acknowledge_unknown:true}))throw Error('git_execution_evidence_corrupt');
 }

export function readIndexControlReceipt(db:DatabaseSync,row:Row,control:Control):ControlReceipt|undefined{
  validateIndexControl(db,row,control);
  const saved=db.prepare('SELECT * FROM wb_git_index_control_receipts WHERE control_id=?').get(control.control_id) as Outcome|undefined;if(!saved)return;
  const value=JSON.parse(saved.receipt_json),result=readIndexRecordedResult(db,row);
  if(result.state==='pending'||result.state==='unknown'||!['verified','unverified','not_recorded','not_attempted'].includes(value.cleanup)||digest(value)!==saved.receipt_sha256||JSON.stringify(value)!==JSON.stringify(indexControlReceipt(db,control,result as AppliedResult|ClosedResult,value.cleanup)))throw Error('git_execution_outcome_corrupt');return value as ControlReceipt;
 }

export function readIndexResult(db:DatabaseSync,row:Row){return readIndexExecutionResult(db,row.owner_id,row.project_id,row.execution_id);}
