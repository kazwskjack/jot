import type {DatabaseSync} from 'node:sqlite';
import type {WorkspaceOperationSource} from '../workbench/workspace-coordination.ts';
import {readIndexExecutionRow,readIndexExecutionRecord,readIndexAdmission,readIndexResult,readIndexPreparation,readIndexDispatch,readIndexControlReceipt,type Control} from './index-journal.ts';
import {readIndexProducerRecord} from './index-producers.ts';

function original(db:DatabaseSync,source:WorkspaceOperationSource,recorded=false){
 if(source.operation_kind!=='git_index')throw Error('workspace_reservation_producer_unsettled');
 const row=recorded?readIndexExecutionRecord(db,source.owner_id,source.project_id,source.operation_id):readIndexExecutionRow(db,source.owner_id,source.project_id,source.operation_id);
 if(row.protocol!==4||row.binding_sha256!==source.binding_sha256)throw Error('workspace_reservation_producer_unsettled');
 readIndexAdmission(db,row);return row;
}
/** Original applied settlement uses the same journal/producer validation as
 * execution. Reading these facts is not native drain or permission to release. */
export function indexAppliedSettlementEvidence(db:DatabaseSync,source:WorkspaceOperationSource){
 try{
  const row=original(db,source),result=readIndexResult(db,row),producer=readIndexProducerRecord(db,row),outcome=db.prepare('SELECT receipt_sha256 FROM wb_git_index_outcomes WHERE execution_id=?').get(row.execution_id),finish=db.prepare('SELECT record_sha256 FROM wb_git_index_producer_finishes WHERE execution_id=?').get(row.execution_id);
  if(result.state!=='applied'||!producer||producer.finish?.state!=='applied'||!outcome||!finish)throw Error();
  return{outcome_sha256:String(outcome.receipt_sha256),producer_sha256:producer.sha256,finish_sha256:String(finish.record_sha256)};
 }catch{throw Error('workspace_reservation_producer_unsettled')}
}
/** Exact original acknowledged disposition. Missing producer finishes remain
 * absent; a recovery Worker cannot impersonate the original producer. */
export function indexResolutionSettlementEvidence(db:DatabaseSync,source:WorkspaceOperationSource,request:string){return resolutionEvidence(db,source,request,false);}
/** Validate already-recorded drain facts after transfer without pretending the
 * old owner is current or granting the new owner its execution/control. */
export function recordedIndexResolutionSettlementEvidence(db:DatabaseSync,source:WorkspaceOperationSource,request:string){return resolutionEvidence(db,source,request,true);}
function resolutionEvidence(db:DatabaseSync,source:WorkspaceOperationSource,request:string,recorded:boolean){
 try{
  if(typeof request!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(request))throw Error();
  const row=original(db,source,recorded),control=db.prepare('SELECT * FROM wb_git_index_controls WHERE execution_id=? AND owner_id=? AND project_id=? AND request_id=?').get(row.execution_id,row.owner_id,row.project_id,request) as Control|undefined;if(!control)throw Error();
  const receipt=readIndexControlReceipt(db,row,control);if(!receipt)throw Error();
  const producer=readIndexProducerRecord(db,row),finish=db.prepare('SELECT record_sha256 FROM wb_git_index_producer_finishes WHERE execution_id=?').get(row.execution_id),saved=db.prepare('SELECT receipt_sha256 FROM wb_git_index_control_receipts WHERE control_id=?').get(control.control_id);
  if(!saved||!producer&&(receipt.result.state!=='not_dispatched'||readIndexPreparation(db,row)||readIndexDispatch(db,row)))throw Error();
  return{control_id:control.control_id,control_request_id:control.request_id,control_sha256:control.request_sha256,receipt_sha256:String(saved.receipt_sha256),producer_sha256:producer?.sha256??null,finish_sha256:finish?String(finish.record_sha256):null,result_state:receipt.result.state,cleanup:receipt.cleanup};
 }catch{throw Error('workspace_reservation_producer_unsettled')}
}
