import {freezeWorkAdmission} from '../always-on/work-admission-records.ts';
import type {WorkspaceManifestEntry} from '../always-on/workspace-provider.ts';
import type {WorkPublicationIntents} from './work-publication-intents.ts';
import type {WorkPublicationSource} from '../../contracts/types.ts';

/** Project only a verified original service read. The private target witness
 * stays in the original database and the original review digest is unchanged.
 * This display object is never an executionSource or an execution grant. */
export function publicationReviewView(value:ReturnType<WorkPublicationIntents['get']>){
 const s=value.source,t=value.target,w=s.work_review;
 const entry=(e:WorkspaceManifestEntry)=>e.kind==='directory'?{path:e.path,kind:e.kind}:{path:e.path,kind:e.kind,sha256:e.sha256,bytes:e.bytes,executable:e.executable};
 const manifest=(m:typeof w.base_manifest)=>({protocol:m.protocol,provider:m.provider,paths:[...m.paths],entries:m.entries.map(entry)});
 return freezeWorkAdmission({intent_id:value.intent_id,project_id:value.project_id,
  source:{source:s.source,workspace_id:s.workspace_id,project_id:s.project_id,agent_id:s.agent_id,task_id:s.task_id,occurrence_id:s.occurrence_id,run_id:s.run_id,
   final_message_id:s.final_message_id,candidate_id:s.candidate_id,certificate_id:s.certificate_id,completion_intent_id:s.completion_intent_id,
   snapshot_sha256:s.snapshot_sha256,candidate_sha256:s.candidate_sha256,native_proof_sha256:s.native_proof_sha256,source_sha256:s.source_sha256,
   files:s.files.map((file:WorkPublicationSource['files'][number])=>({path:file.path,version:file.version,sha256:file.sha256,size_bytes:file.size_bytes,receipt_id:file.receipt_id,producing_run_id:file.producing_run_id})),
   work_review:{protocol:w.protocol,source:w.source,grant_id:w.grant_id,work_occurrence_id:w.work_occurrence_id,cycle_id:w.cycle_id,snapshot_id:w.snapshot_id,
    selected_objective:w.selected_objective,source_sha256:w.source_sha256,source_record_sha256:w.source_record_sha256,plans_sha256:w.plans_sha256,paths_sha256:w.paths_sha256,
    call_set_sha256:w.call_set_sha256,inspection_sha256:w.inspection_sha256,base_manifest:manifest(w.base_manifest),result_manifest:manifest(w.result_manifest),
    diff:structuredClone(w.diff),execution_authorized:false as const}},
  target:{snapshot_id:t.snapshot_id,repository_sha256:t.repository_sha256,head:{oid:t.head.oid,branch:t.head.branch,detached:t.head.detached},index_sha256:t.index_sha256,target_sha256:t.target_sha256},
  changes:value.changes.map((change:any)=>({path:change.path,kind:change.kind,before:change.before?entry(change.before):null,after:entry(change.after),before_text:change.before_text,after_text:change.after_text})),
  paths:[...value.paths],review_sha256:value.review_sha256,version:value.version,state:value.state,created_at:value.created_at,updated_at:value.updated_at,execution_authorized:false as const});
}
