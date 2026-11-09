import type {DatabaseSync} from 'node:sqlite';
import type {GitInitializationExecutionFacts,GitInitializationPendingResult,GitInitializationClosedResult} from '../../contracts/types.ts';
import type {Row,Disposition} from './index-journal.ts';
import {readGitInitializationExecutionSource} from './initialization-records.ts';

export function initializationExecutionFacts(db:DatabaseSync,row:Row):GitInitializationExecutionFacts{
 if(row.action!=='init'||row.protocol!==7)throw Error('git_execution_evidence_corrupt');
 const {witness}=readGitInitializationExecutionSource(db,row);
 return{action:'init',initial_branch:witness.initial_branch,object_format:witness.object_format,
  internal_ignore:{path:'.pilotdeck/.gitignore',before_sha256:witness.internal_ignore?.sha256??null,after_sha256:witness.ignore_after.sha256,
   size:witness.ignore_after.size,changed:witness.ignore_after.changed}};
}
export function initializationClosedResult(db:DatabaseSync,row:Row,disposition:Disposition):GitInitializationClosedResult{
 return{execution_id:row.execution_id,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,
  ...initializationExecutionFacts(db,row),paths:[],state:disposition.kind,disposition_id:disposition.control_id,execution_authorized:false};
}
/** Read the original never-dispatched phase until typed native initialization
 * effects exist. Unknown records cannot be reinterpreted as index evidence. */
export function readInitializationPendingResult(db:DatabaseSync,row:Row):GitInitializationPendingResult{
 const facts=initializationExecutionFacts(db,row);
 for(const table of ['wb_git_index_preparations','wb_git_index_dispatches','wb_git_index_outcomes']){
  if(db.prepare('SELECT 1 FROM '+table+' WHERE execution_id=?').get(row.execution_id))throw Error('git_initialization_execution_unavailable');
 }
 if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='wb_git_index_ref_preparations'").get()
  &&db.prepare('SELECT 1 FROM wb_git_index_ref_preparations WHERE execution_id=?').get(row.execution_id))throw Error('git_initialization_execution_unavailable');
 return{execution_id:row.execution_id,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,
  ...facts,paths:[],state:'pending',execution_authorized:false};
}
