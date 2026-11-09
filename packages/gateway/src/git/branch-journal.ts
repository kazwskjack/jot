import type {DatabaseSync} from 'node:sqlite';
import type {GitBranchExecutionFacts,GitBranchPendingResult,GitBranchClosedResult} from '../../contracts/types.ts';
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
/** Read only the original never-dispatched phase until native branch effects
 * have a typed decoder. An unfamiliar effect cannot become index evidence. */
export function readBranchPendingResult(db:DatabaseSync,row:Row):GitBranchPendingResult{
 const facts=branchExecutionFacts(db,row);
 for(const table of ['wb_git_index_preparations','wb_git_index_dispatches','wb_git_index_outcomes']){
  if(db.prepare('SELECT 1 FROM '+table+' WHERE execution_id=?').get(row.execution_id))throw Error('git_branch_execution_unavailable');
 }
 if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='wb_git_index_ref_preparations'").get()
  &&db.prepare('SELECT 1 FROM wb_git_index_ref_preparations WHERE execution_id=?').get(row.execution_id))throw Error('git_branch_execution_unavailable');
 return{execution_id:row.execution_id,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,
  ...facts,paths:[],state:'pending',execution_authorized:false};
}
