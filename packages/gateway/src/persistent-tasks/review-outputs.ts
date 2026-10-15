import type {DatabaseSync} from 'node:sqlite';
import {currentTaskCompletionCandidate} from './completion-candidates.ts';
import {taskOutputsDeliverable} from './output-delivery.ts';
import {verifyTaskOutputContent} from './output-content.ts';
import {readFrozenGeneratedPart,withGeneratedOutputReadScope} from './generated-output-content.ts';

type Frozen=ReturnType<typeof currentTaskCompletionCandidate>;
type Output={source:'workspace'|'native'|'generated';file_name:string;version:number;size_bytes:number;sha256:string;mime_type:string;read:()=>Buffer};
const unavailable=new Set(['task_completion_state_conflict','budget_usage_unknown','task_completion_output_integrity_failed','task_output_reader_unavailable','task_output_source_unverified','task_auxiliary_pending','generated_artifact_producer_unverified','generated_artifact_content_mismatch','generated_output_reader_unavailable']);

/** Owned pending review access, not a business certificate or final delivery. */
export class TaskReviewOutputs{
 private db:DatabaseSync;
 constructor(db:DatabaseSync){this.db=db;}
 private frozen(owner:string,id:string){
  const row=this.db.prepare(`SELECT i.status,i.expires_at,i.kind,w.purpose,w.run_id,w.checkpoint_id,w.expected_run_version
   FROM ga_interactions i JOIN ga_conversations c ON c.id=i.conversation_id
   JOIN wb_task_wait_interactions w ON w.interaction_id=i.id AND w.run_id=i.run_id
   WHERE i.id=? AND c.owner_id=?`).get(id,owner) as {status:string;expires_at:string;kind:string;purpose:string;run_id:string;checkpoint_id:string;expected_run_version:number}|undefined;
  if(!row||row.kind!=='question'||row.purpose!=='task_acceptance_review')throw new Error('task_review_output_not_found');
  if(row.status!=='pending')throw new Error('task_review_output_unavailable');
  if(!Number.isFinite(Date.parse(row.expires_at))||Date.parse(row.expires_at)<=Date.now())throw new Error('task_review_output_expired');
  const frozen=currentTaskCompletionCandidate(this.db,owner,row.run_id);
  if(frozen.snapshot.checkpoint_id!==row.checkpoint_id||frozen.snapshot.run_version!==row.expected_run_version||!taskOutputsDeliverable(this.db,frozen))throw new Error('task_review_output_unavailable');
  return {frozen,runId:row.run_id};
 }
 private outputs(frozen:Frozen,runId:string):Output[]{
  const context=JSON.parse(frozen.snapshot.frozen_context) as {workspace_id:string;project_id:string},outputs:Output[]=[];
  for(const [source,files] of [['native',frozen.snapshot.file_outputs??[]],['workspace',frozen.snapshot.workspace_file_outputs??[]]] as const){
   for(const file of files){
    if(!file.verified||!file.version||!file.sha256||file.size===undefined)throw new Error('task_review_output_unavailable');
    outputs.push({source,file_name:file.path,version:file.version,size_bytes:file.size,sha256:file.sha256,mime_type:file.path.endsWith('.md')?'text/markdown':'text/plain',
     read:()=>Buffer.from(verifyTaskOutputContent(this.db,{owner:frozen.snapshot.owner_id,workspace:context.workspace_id,project:context.project_id,path:file.path,version:file.version!,runId},{sha256:file.sha256!,size:file.size!}).content,'utf8')});
   }
  }
  for(const group of frozen.snapshot.artifact_outputs??[]){
   for(const part of group.parts??[]){outputs.push({source:'generated',file_name:part.display_name,version:group.version!,size_bytes:part.size_bytes,sha256:part.sha256,mime_type:part.mime_type,
    read:()=>readFrozenGeneratedPart(this.db,frozen.snapshot.owner_id,group,part.part_index).content});}
  }
  return outputs;
 }
 private read<T>(owner:string,id:string,operation:(outputs:Output[])=>T):T{
  // WAL deferred snapshot: authorize and read one consistent version without
  // reserving the writer lock used by the separate task Worker.
  if(this.db.isTransaction)throw new Error('task_review_output_unavailable');
  this.db.exec('BEGIN');
  try{const value=withGeneratedOutputReadScope(this.db,()=>{const {frozen,runId}=this.frozen(owner,id);return operation(this.outputs(frozen,runId));});this.db.exec('COMMIT');return value;}
  catch(error){if(error instanceof Error&&unavailable.has(error.message))throw new Error('task_review_output_unavailable');throw error;}
  finally{if(this.db.isTransaction)this.db.exec('ROLLBACK');}
 }
 list(owner:string,id:string){return this.read(owner,id,outputs=>({items:outputs.map(({read,...value},output_index)=>({...value,output_index,download_url:`/v1/interactions/${encodeURIComponent(id)}/outputs/${output_index}`}))}));}
 content(owner:string,id:string,index:string){
  if(!/^(0|[1-9][0-9]{0,3})$/.test(index))throw new Error('invalid_task_review_output_index');
  return this.read(owner,id,outputs=>{const value=outputs[Number(index)];if(!value)throw new Error('task_review_output_not_found');return {file_name:value.file_name,content:value.read()};});
 }
}
