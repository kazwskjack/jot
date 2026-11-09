import {gitReinitializationPreparation,gitReinitializationRefPreparation,gitReinitializationEvidence,gitReinitializationReceipt,type GitReinitializationPreparation,type GitReinitializationEvidence} from './reinitialization-evidence.ts';
import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../db/canonical-json.ts';
import {readIndexProducerRecord} from './index-producers.ts';
import {gitInitializationPreparation,gitInitializationEvidence,gitInitializationReceipt,type GitInitializationPreparation,type GitInitializationEvidence} from './initialization-evidence.ts';
import type {GitInitializationExecutionFacts,GitInitializationPendingResult,GitInitializationClosedResult,GitInitializationAppliedResult} from '../../contracts/types.ts';
import type {Row,Disposition} from './index-journal.ts';
import {readGitInitializationExecutionSource} from './initialization-records.ts';

export function initializationExecutionFacts(db:DatabaseSync,row:Row):GitInitializationExecutionFacts{
 if(row.action!=='init'||![7,8].includes(row.protocol))throw Error('git_execution_evidence_corrupt');
 const {witness}=readGitInitializationExecutionSource(db,row);
 return{action:'init',initial_branch:witness.initial_branch,object_format:witness.object_format,
  internal_ignore:{path:'.pilotdeck/.gitignore',before_sha256:witness.internal_ignore?.sha256??null,after_sha256:witness.ignore_after.sha256,
   size:witness.ignore_after.size,changed:witness.ignore_after.changed}};
}
export function initializationClosedResult(db:DatabaseSync,row:Row,disposition:Disposition):GitInitializationClosedResult{
 return{execution_id:row.execution_id,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,
  ...initializationExecutionFacts(db,row),paths:[],state:disposition.kind,disposition_id:disposition.control_id,execution_authorized:false};
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

export function validateInitializationPreparation(db:DatabaseSync,row:Row,preparation:GitInitializationPreparation|GitReinitializationPreparation){
 if(row.action!=='init'||![7,8].includes(row.protocol))throw Error('git_execution_evidence_corrupt');
 const {witness}=readGitInitializationExecutionSource(db,row),{plan}=preparation;
 if((preparation.protocol===2)!==(row.protocol===8))throw Error('git_execution_evidence_corrupt');
 if(plan.source_sha256!==row.witness_sha256||plan.review_sha256!==row.review_sha256
  ||plan.witness.repository_sha256!==row.repository_sha256||canonicalJson(plan.witness)!==canonicalJson(witness))throw Error('git_execution_evidence_corrupt');
}
function recordedInitializationEvidence(db:DatabaseSync,row:Row,table:'wb_git_index_preparations'|'wb_git_index_dispatches'|'wb_git_index_ref_preparations'){
 if(row.action!=='init'||![7,8].includes(row.protocol))throw Error('git_execution_evidence_corrupt');
 const record=db.prepare('SELECT evidence_json,evidence_sha256,lease_owner,lease_generation FROM '+table+' WHERE execution_id=?').get(row.execution_id) as
  {evidence_json:string;evidence_sha256:string;lease_owner:string;lease_generation:number}|undefined;
 if(!record)return;
 const value=JSON.parse(record.evidence_json),producer=readIndexProducerRecord(db,row);
 if(digest(value)!==record.evidence_sha256||!producer||record.lease_owner!==producer.start.lease.owner
  ||record.lease_generation!==producer.start.lease.generation)throw Error('git_execution_evidence_corrupt');
 return value as unknown;
}
/** Private allocation preparation precedes native Git. Dispatch carries its
 * generated metadata and must retain the exact original preparation. */
export function readInitializationPreparation(db:DatabaseSync,row:Row){
 const value=recordedInitializationEvidence(db,row,'wb_git_index_preparations');
 if(value===undefined)return;
 const preparation=row.protocol===8?gitReinitializationPreparation(value):gitInitializationPreparation(value);
 validateInitializationPreparation(db,row,preparation);return preparation;
}
/** The second allocation retains the exact original first preparation and
 * producer lease. It is read-only input for interrupted pre-dispatch cleanup. */
export function readInitializationRefPreparation(db:DatabaseSync,row:Row){
 if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='wb_git_index_ref_preparations'").get())return;
 const value=recordedInitializationEvidence(db,row,'wb_git_index_ref_preparations');
 if(value===undefined)return;
 if(row.protocol!==8)throw Error('git_execution_evidence_corrupt');
 const reference=gitReinitializationRefPreparation(value);
 validateInitializationPreparation(db,row,reference.preparation);
 if(canonicalJson(reference.preparation)!==canonicalJson(readInitializationPreparation(db,row)))throw Error('git_execution_evidence_corrupt');
 return reference;
}
export function readInitializationDispatch(db:DatabaseSync,row:Row){
 const value=recordedInitializationEvidence(db,row,'wb_git_index_dispatches');
 if(value===undefined)return;
 const evidence=row.protocol===8?gitReinitializationEvidence(value):gitInitializationEvidence(value);
 validateInitializationPreparation(db,row,evidence.preparation);
 if(canonicalJson(evidence.preparation)!==canonicalJson(readInitializationPreparation(db,row)))throw Error('git_execution_evidence_corrupt');
 if(evidence.protocol===2&&canonicalJson(evidence.ref_preparation)!==canonicalJson(readInitializationRefPreparation(db,row)??null))throw Error('git_execution_evidence_corrupt');
 return evidence;
}
export function initializationAppliedResult(db:DatabaseSync,row:Row,evidence:GitInitializationEvidence|GitReinitializationEvidence):GitInitializationAppliedResult{
 validateInitializationPreparation(db,row,evidence.preparation);
 return{execution_id:row.execution_id,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,
  ...initializationExecutionFacts(db,row),paths:[],state:'applied',evidence_sha256:hash(canonicalJson(evidence)),execution_authorized:false};
}
/** Physical directory proof stays private in the same immutable outcome row.
 * Reading it grants no native custody, lease or repository rebind authority. */
export function readInitializationOutcome(db:DatabaseSync,row:Row){
 const evidence=readInitializationDispatch(db,row);
 const outcome=db.prepare('SELECT receipt_json,receipt_sha256 FROM wb_git_index_outcomes WHERE execution_id=?').get(row.execution_id) as
  {receipt_json:string;receipt_sha256:string}|undefined;
 if(!outcome)return;
 try{
  const value=JSON.parse(outcome.receipt_json);
  if(!evidence||digest(value)!==outcome.receipt_sha256||!value||typeof value!=='object'||Array.isArray(value)
   ||Object.keys(value).sort().join(',')!=='execution_id,protocol,publication,request_sha256,result'
   ||value.protocol!==1||value.execution_id!==row.execution_id||value.request_sha256!==row.request_sha256
   ||JSON.stringify(value.result)!==JSON.stringify(initializationAppliedResult(db,row,evidence)))throw Error();
  const publication=evidence.protocol===2?gitReinitializationReceipt(value.publication,evidence):gitInitializationReceipt(value.publication,evidence);
  return{result:value.result as GitInitializationAppliedResult,publication,sha256:outcome.receipt_sha256};
 }catch{throw Error('git_execution_outcome_corrupt');}
}
export function readInitializationRecordedResult(db:DatabaseSync,row:Row):GitInitializationPendingResult|GitInitializationAppliedResult{
 const facts=initializationExecutionFacts(db,row),preparation=readInitializationPreparation(db,row),dispatch=readInitializationDispatch(db,row);
 readInitializationRefPreparation(db,row);
 const outcome=readInitializationOutcome(db,row);
 if(outcome)return outcome.result;
 return{execution_id:row.execution_id,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,
  ...facts,paths:[],state:preparation||dispatch?'unknown':'pending',execution_authorized:false};
}
