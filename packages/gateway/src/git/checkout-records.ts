import {checkoutLogMetadata,checkoutReferencePlan} from './checkout-metadata.ts';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../db/canonical-json.ts';
import {validGitReference} from './references.ts';
import type {GitCheckoutReviewPrepare,GitCheckoutReviewWitness} from '../../contracts/types.ts';
import type {GitBranchIntentRecord} from './branch-records.ts';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/,SHA=/^[a-f0-9]{64}$/;
export const checkoutDigest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export function normalizeGitCheckoutReview(value:unknown):GitCheckoutReviewPrepare{
 const input=value as GitCheckoutReviewPrepare;
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='action,request_id,snapshot_id,target_ref'
  ||typeof input.request_id!=='string'||!ID.test(input.request_id)||input.action!=='checkout-branch'
  ||typeof input.snapshot_id!=='string'||!SHA.test(input.snapshot_id)||!validGitReference(input.target_ref)||!/^refs\/(?:heads|remotes)\//.test(input.target_ref))throw Error('git_checkout_invalid');
 return{request_id:input.request_id,action:input.action,snapshot_id:input.snapshot_id,target_ref:input.target_ref};
}
/** Decode original immutable source with the shared contract and semantic bindings. */
export function readGitCheckoutIntentSource(row:GitBranchIntentRecord,validate:(value:unknown)=>boolean){
 try{
  const input=normalizeGitCheckoutReview(JSON.parse(row.selection_json)),witness=JSON.parse(row.witness_json) as GitCheckoutReviewWitness;
  if(!validate(witness)||row.action!==input.action||row.request_id!==input.request_id||checkoutDigest(input)!==row.request_sha256
   ||witness.project_id!==row.project_id||witness.snapshot_id!==input.snapshot_id||witness.target.ref!==input.target_ref
   ||witness.preview.target_ref!==input.target_ref||witness.preview.target_oid!==witness.target.checkout_oid
   ||(witness.target.kind==='local')!==input.target_ref.startsWith('refs/heads/'))throw Error();
  const oid=new RegExp('^[a-f0-9]{'+(witness.object_format==='sha1'?40:64)+'}$');
  if(!oid.test(witness.target.oid)||!oid.test(witness.target.checkout_oid)||witness.head.oid!==null&&!oid.test(witness.head.oid)
   ||witness.head.detached&&(witness.head.branch!==null||witness.head.oid===null)
   ||!witness.head.detached&&(typeof witness.head.branch!=='string'||!validGitReference('refs/heads/'+witness.head.branch)))throw Error();
  for(const change of witness.preview.index_projection?.changes??[])for(const entry of [change.before,change.after])if(entry&&!oid.test(entry.oid))throw Error();
  const source=witness.preview.reference_source;
  if(source){
   if(source.target_ref.ref!==input.target_ref||source.head_file.sha256===null||source.head_file.size===0
    ||(source.source_ref===null)!==witness.head.detached
    ||source.source_ref&&source.source_ref.ref!=='refs/heads/'+witness.head.branch
    ||!source.configuration.worktree_enabled&&(source.configuration.worktree.sha256!==null||source.configuration.worktree.size!==0)
    ||source.log_policy.configuration==='false'&&source.log_policy.enabled
    ||['true','always'].includes(source.log_policy.configuration)&&!source.log_policy.enabled)throw Error();
   const files=[source.head_file,source.head_log,source.target_ref.file,source.target_log,source.packed_refs,
    source.configuration.common,source.configuration.worktree,...(source.source_ref?[source.source_ref.file]:[])];
   for(const fact of files){
    if(fact.sha256===null&&fact.size!==0||fact.physical!==undefined&&(fact.physical===null)!==(fact.sha256===null))throw Error();
    if(source.layout&&fact.physical===undefined)throw Error();
   }
   if(source.layout){
    const names=[{scope:'git',path:'HEAD'},{scope:'git',path:'logs/HEAD'},{scope:'common',path:input.target_ref},
     {scope:'common',path:'logs/'+input.target_ref},{scope:'common',path:'packed-refs'},{scope:'common',path:'config'},
     ...(source.source_ref?[{scope:'common',path:source.source_ref.ref}]:[]),
     ...(source.configuration.worktree_enabled?[{scope:'git',path:'config.worktree'}]:[])];
    const expected=new Set<string>();
    for(const name of names){
     const parts=name.path.split('/');
     for(let count=1;count<parts.length;count++)expected.add(name.scope+'\0'+parts.slice(0,count).join('/'));
    }
    if(canonicalJson(source.layout.parents.map(parent=>parent.scope+'\0'+parent.path))!==canonicalJson([...expected].sort()))throw Error();
   }
  }
  if(witness.reference_plan&&canonicalJson(witness.reference_plan)!==canonicalJson(checkoutReferencePlan(witness)))throw Error();
  if(witness.log_metadata){
   const metadata=witness.log_metadata,actor={name:metadata.committer.name,email:metadata.committer.email};
   if(!witness.reference_plan||canonicalJson(checkoutLogMetadata({author:actor,committer:actor},witness,metadata.committer.timestamp))!==canonicalJson(metadata))throw Error();
  }
  const after=witness.log_after,plan=witness.reference_plan;
  if(after){
   if(!source||!plan)throw Error();
   const append=plan.state==='planned'&&plan.head_log.append,metadata=witness.log_metadata;
   if(after.state==='appended'){
    if(!append||!metadata||after.size!==source.head_log.size+metadata.entry_size)throw Error();
   }else if(after.state==='retained'){
    if(plan.state!=='planned'||append||after.sha256!==source.head_log.sha256||after.size!==source.head_log.size)throw Error();
   }else if(after.reason==='reference_policy_required'){
    if(plan.state!=='policy_required')throw Error();
   }else if(after.reason==='identity_unconfigured'){
    if(!append||metadata)throw Error();
   }else{
    if(!append||!metadata||after.reason==='log_format_required'&&source.head_log.size===0
     ||after.reason==='output_limit'&&source.head_log.size+metadata.entry_size<=32*1024*1024)throw Error();
   }
  }
  if(checkoutDigest({action:input.action,target_ref:input.target_ref,witness})!==row.review_sha256)throw Error();
  return{input,witness};
 }catch{throw Error('git_checkout_evidence_invalid');}
}
