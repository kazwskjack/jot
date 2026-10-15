import type {DatabaseSync} from 'node:sqlite';
import type {ArtifactService} from '../artifacts/service.ts';
import {canonicalJson} from '../db/canonical-json.ts';

export type GeneratedOutput={reference:string;verified:boolean;content_verified?:true;artifact_id?:string;
 run_id?:string;version?:number;sha256?:string;size_bytes?:number;
 parts?:Array<{part_index:number;display_name:string;sha256:string;size_bytes:number;mime_type:string}>};
const readers=new WeakMap<DatabaseSync,ArtifactService>();
const readScopes=new WeakMap<DatabaseSync,{bytes:number;groups:Map<string,ReturnType<ArtifactService['readProducedGroup']>>}>();
/** Synchronous, request-local verified bytes; never reused across owners/requests. */
export function withGeneratedOutputReadScope<T>(db:DatabaseSync,read:()=>T):T{
 if(readScopes.has(db))throw new Error('generated_output_read_scope_conflict');
 readScopes.set(db,{bytes:0,groups:new Map()});try{return read();}finally{readScopes.delete(db);}
}
function producedGroup(db:DatabaseSync,owner:string,runId:string,artifactId:string,version:number){
 const reader=readers.get(db);if(!reader)throw new Error('generated_output_reader_unavailable');
 const key=JSON.stringify([owner,runId,artifactId,version]),cache=readScopes.get(db),prior=cache?.groups.get(key);
 if(prior)return prior;
 // Bound aggregate retained bytes before opening another complete group.
 if(cache){const row=db.prepare('SELECT size_bytes FROM ga_artifact_versions WHERE artifact_id=? AND version=?').get(artifactId,version) as {size_bytes:number}|undefined;
  if(!row||!Number.isSafeInteger(row.size_bytes)||row.size_bytes<0||cache.bytes+row.size_bytes>100*1024*1024)throw new Error('task_review_output_unavailable');}
 const value=reader.readProducedGroup(owner,runId,artifactId,version);
 if(cache){if(cache.bytes+value.size_bytes>100*1024*1024)throw new Error('task_review_output_unavailable');cache.bytes+=value.size_bytes;cache.groups.set(key,value);}return value;
}
export function readFrozenGeneratedPart(db:DatabaseSync,owner:string,output:GeneratedOutput,partIndex:number){
 if(!output.verified||output.content_verified!==true||!output.artifact_id||!output.run_id||!output.version)throw new Error('task_output_source_unverified');
 const value=producedGroup(db,owner,output.run_id,output.artifact_id,output.version);
 if(value.sha256!==output.sha256||value.size_bytes!==output.size_bytes
  ||canonicalJson(value.parts.map(({content,...part})=>part))!==canonicalJson(output.parts))throw new Error('task_completion_state_conflict');
 const part=value.parts.find(part=>part.part_index===partIndex);if(!part)throw new Error('task_output_source_unverified');return part;
}
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
  const content=producedGroup(db,scope.owner_id,row.run_id,row.artifact_id,row.version);
  const output:GeneratedOutput={reference,verified:true,content_verified:true,artifact_id:row.artifact_id,run_id:row.run_id,
   version:row.version,sha256:content.sha256,size_bytes:content.size_bytes,parts:content.parts.map(({content:bytes,...part})=>part)};
  if(prior&&canonicalJson(output)!==canonicalJson(prior))throw new Error('task_completion_state_conflict');return output;
 });
}
