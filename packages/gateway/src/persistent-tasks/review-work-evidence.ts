import {createHash} from 'node:crypto';
import {canonicalJson} from '../db/canonical-json.ts';
import {createWorkspaceDiff} from '../always-on/workspace-diff.ts';
import {validateWorkspaceManifest,workspaceManifestHash} from '../always-on/workspace-provider.ts';
import {freezeWorkAdmission} from '../always-on/work-admission-records.ts';
import type {FrozenIsolatedWorkEvidence} from '../always-on/work-inspections.ts';

const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Projection only, after the owning pending-review service validates the exact
 * original candidate. No root lookup, source selection, publication or approval. */
export function projectWorkReviewEvidence(value:unknown){
 if(value===undefined)return undefined;
 try{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error();
  const evidence=value as FrozenIsolatedWorkEvidence,{inspection_sha256,...payload}=evidence;
  if(evidence.protocol!==1||hash(payload)!==inspection_sha256
   ||typeof evidence.selected_objective!=='string'||!evidence.selected_objective||evidence.selected_objective.length>65536)throw Error();
  for(const key of ['grant_id','work_occurrence_id','cycle_id','snapshot_id'] as const)
   if(typeof evidence[key]!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(evidence[key]))throw Error();
  for(const key of ['source_sha256','source_record_sha256','plans_sha256','paths_sha256','call_set_sha256','binding_sha256'] as const)
   if(typeof evidence[key]!=='string'||!/^[a-f0-9]{64}$/.test(evidence[key]))throw Error();
  const base=validateWorkspaceManifest(evidence.base_manifest),result=validateWorkspaceManifest(evidence.result_manifest);
  if(workspaceManifestHash(base)!==evidence.base_manifest_sha256||workspaceManifestHash(result)!==evidence.result_manifest_sha256)throw Error();
  const diff=createWorkspaceDiff({base,base_sha256:evidence.base_manifest_sha256,result,result_sha256:evidence.result_manifest_sha256});
  if(canonicalJson(diff)!==canonicalJson(evidence.diff))throw Error();
  return freezeWorkAdmission({protocol:1 as const,source:'isolated' as const,grant_id:evidence.grant_id,
   work_occurrence_id:evidence.work_occurrence_id,cycle_id:evidence.cycle_id,snapshot_id:evidence.snapshot_id,
   selected_objective:evidence.selected_objective,source_sha256:evidence.source_sha256,
   source_record_sha256:evidence.source_record_sha256,plans_sha256:evidence.plans_sha256,paths_sha256:evidence.paths_sha256,
   call_set_sha256:evidence.call_set_sha256,inspection_sha256,base_manifest:base,result_manifest:result,diff,
   execution_authorized:false as const});
 }catch{throw Error('task_review_output_unavailable');}
}
