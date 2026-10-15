import type {DatabaseSync} from 'node:sqlite';
import type {ArtifactService} from '../artifacts/service.ts';
import type {EventStore} from '../events/event-store.ts';
import type {currentTaskCompletionCandidate} from './completion-candidates.ts';
import {verifyTaskOutputContent} from './output-content.ts';
import {configureGeneratedOutputReader} from './generated-output-content.ts';

type Frozen=ReturnType<typeof currentTaskCompletionCandidate>;
const publishers=new WeakMap<DatabaseSync,{artifacts:ArtifactService;events:EventStore}>();
export function configureTaskOutputDelivery(db:DatabaseSync,artifacts:ArtifactService,events:EventStore):void {
 if(publishers.has(db))throw new Error('task_output_delivery_already_configured');
 publishers.set(db,{artifacts,events});
 configureGeneratedOutputReader(db,artifacts);
}
/** Only owned, frozen, content-verified outputs have a delivery adapter. */
export function taskOutputsDeliverable(db:DatabaseSync,frozen:Frozen):boolean {
 const refs=frozen.candidate.artifact_refs??[],groups=frozen.snapshot.artifact_outputs??[];
 if(refs.length&&(!publishers.has(db)||groups.length!==refs.length||!groups.every((group,index)=>
  group.reference===refs[index]&&group.verified&&group.content_verified===true&&typeof group.artifact_id==='string'
  &&typeof group.run_id==='string'&&Number.isSafeInteger(group.version)&&Number(group.version)>0
  &&typeof group.sha256==='string'&&Number.isSafeInteger(group.size_bytes)&&!!group.parts?.length)))return false;
 for(const [files,outputs] of [[frozen.candidate.presented_files??[],frozen.snapshot.file_outputs??[]],
   [frozen.candidate.workspace_files??[],frozen.snapshot.workspace_file_outputs??[]]] as const){
  if(files.length&&(!publishers.has(db)||outputs.length!==files.length||!outputs.every((output,index)=>
   output.path===files[index]?.path&&output.verified&&output.content_verified===true
   &&Number.isSafeInteger(output.version)&&Number(output.version)>0&&typeof output.receipt_id==='string'
   &&typeof output.sha256==='string'&&Number.isSafeInteger(output.size))))return false;
 }
 return true;
}
export function publishTaskOutputs(db:DatabaseSync,frozen:Frozen,runId:string,conversationId:string):string[]{
 if(!db.isTransaction)throw new Error('task_output_transaction_required');
 if(!taskOutputsDeliverable(db,frozen))throw new Error('task_acceptance_outputs_unverified');
 const outputs=[...(frozen.snapshot.file_outputs??[]),...(frozen.snapshot.workspace_file_outputs??[])],groups=frozen.snapshot.artifact_outputs??[];if(!outputs.length&&!groups.length)return [];
 const publisher=publishers.get(db)!;
 const context=JSON.parse(frozen.snapshot.frozen_context) as {workspace_id:string;project_id:string};
 const ids:string[]=[];
 const link=(artifact:ReturnType<ArtifactService['get']>)=>{
  const id=String(artifact.artifact_id),version=Number(artifact.version);
  const changed=db.prepare('INSERT OR IGNORE INTO ga_run_artifacts(run_id,artifact_id,version,created_at) VALUES(?,?,?,?)')
   .run(runId,id,version,new Date().toISOString()).changes;
  if(changed)publisher.events.append(conversationId,runId,'artifact.upsert',{...artifact,run_id:runId});
  if(!ids.includes(id))ids.push(id);
 };
 for(const output of outputs){
  const source=db.prepare(`SELECT e.run_id FROM wb_task_file_execution_receipts e
   JOIN wb_task_run_occurrences o ON o.run_id=e.run_id JOIN ga_runs r ON r.id=e.run_id
   WHERE e.receipt_id=? AND e.owner_id=? AND o.occurrence_id=? AND r.conversation_id=?`).get(
    output.receipt_id!,frozen.snapshot.owner_id,frozen.snapshot.occurrence_id,conversationId) as {run_id:string}|undefined;
  if(!source)throw new Error('task_output_source_unverified');
  const content=verifyTaskOutputContent(db,{owner:frozen.snapshot.owner_id,workspace:context.workspace_id,
   project:context.project_id,path:output.path,version:output.version!,runId},{sha256:output.sha256!,size:output.size!});
  const artifact=publisher.artifacts.registerTaskFileVersion({runId:source.run_id,receiptId:output.receipt_id!,content:content.content});
  link(artifact);
 }
 for(const group of groups){
  const source=db.prepare(`SELECT 1 FROM wb_task_run_occurrences o JOIN ga_runs r ON r.id=o.run_id
   JOIN ga_conversations c ON c.id=r.conversation_id
   WHERE o.run_id=? AND o.occurrence_id=? AND r.conversation_id=? AND c.owner_id=?`).get(group.run_id!,frozen.snapshot.occurrence_id,conversationId,frozen.snapshot.owner_id);
  if(!source)throw new Error('task_output_source_unverified');
  for(const part of group.parts!)link(publisher.artifacts.registerTaskGeneratedPart({owner:frozen.snapshot.owner_id,
   runId:group.run_id!,artifactId:group.artifact_id!,version:group.version!,partIndex:part.part_index}));
  db.prepare('DELETE FROM ga_artifact_leases WHERE artifact_id=? AND lease_id=?').run(group.artifact_id!,`task-review:${runId}`);
 }
 return ids;
}
