import type {DatabaseSync} from 'node:sqlite';
import type {ArtifactService} from '../artifacts/service.ts';
import {canonicalJson} from '../db/canonical-json.ts';

export type GeneratedOutput={reference:string;verified:boolean;content_verified?:true;artifact_id?:string;
 run_id?:string;version?:number;sha256?:string;size_bytes?:number;
 parts?:Array<{part_index:number;display_name:string;sha256:string;size_bytes:number;mime_type:string}>};
const readers=new WeakMap<DatabaseSync,ArtifactService>();
export function configureGeneratedOutputReader(db:DatabaseSync,artifacts:ArtifactService):void{
 if(readers.has(db))throw new Error('generated_output_reader_already_configured');readers.set(db,artifacts);
}
/** A reference is evidence only when its immutable producer belongs to this
 * same occurrence and conversation. Never infer provenance from run links. */
export function freezeGeneratedOutputs(db:DatabaseSync,scope:{owner_id:string;occurrence_id:string},runId:string,references:string[],pinned?:GeneratedOutput[]):GeneratedOutput[]{
 if(references.length>50||new Set(references).size!==references.length)throw new Error('task_completion_candidate_invalid');
 return references.map((reference,index)=>{
  if(typeof reference!=='string'||!reference.length||reference.length>1000)throw new Error('task_completion_candidate_invalid');
  const prior=pinned?.[index];if(pinned&&(!prior||prior.reference!==reference))throw new Error('task_completion_state_conflict');
  if(prior?.verified===false)return prior;
  const row=db.prepare(`SELECT p.artifact_id,p.version,p.run_id FROM ga_artifact_producers p
   JOIN ga_artifacts a ON a.id=p.artifact_id AND a.owner_id=p.owner_id AND a.conversation_id=p.conversation_id
   JOIN wb_task_run_occurrences o ON o.run_id=p.run_id
   JOIN ga_runs current ON current.id=? AND current.conversation_id=p.conversation_id
   WHERE p.owner_id=? AND o.occurrence_id=? AND (a.id=? OR a.runtime_ref=?)
   ORDER BY p.version DESC`).get(runId,scope.owner_id,scope.occurrence_id,reference,reference) as {artifact_id:string;version:number;run_id:string}|undefined;
  const reader=readers.get(db);
  if(!row||!reader){if(prior?.verified)throw new Error('task_completion_state_conflict');return {reference,verified:false};}
  if(prior&&(row.artifact_id!==prior.artifact_id||row.version!==prior.version||row.run_id!==prior.run_id))throw new Error('task_completion_state_conflict');
  const content=reader.readProducedGroup(scope.owner_id,row.run_id,row.artifact_id,row.version);
  const output:GeneratedOutput={reference,verified:true,content_verified:true,artifact_id:row.artifact_id,run_id:row.run_id,
   version:row.version,sha256:content.sha256,size_bytes:content.size_bytes,parts:content.parts.map(({content:bytes,...part})=>part)};
  if(prior&&canonicalJson(output)!==canonicalJson(prior))throw new Error('task_completion_state_conflict');return output;
 });
}
