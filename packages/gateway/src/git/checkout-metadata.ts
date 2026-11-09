import {createHash} from 'node:crypto';
import type {GitCheckoutLogMetadata,GitCheckoutReferencePlan,GitCheckoutReviewWitness} from '../../contracts/types.ts';
import {validGitReference} from './references.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {gitCommitOperatorPolicy,gitCommitSignature,type GitCommitOperatorPolicy} from './commit-metadata.ts';

/** Deterministic reference effects for an explicitly selected existing full ref. */
export function checkoutReferencePlan(witness:GitCheckoutReviewWitness):GitCheckoutReferencePlan{
 const {head,target,preview}=witness,source=preview.reference_source;
 const oid=new RegExp('^[a-f0-9]{'+(witness.object_format==='sha1'?40:64)+'}$');
 if(!source||!validGitReference(target.ref)||!oid.test(target.oid)||!oid.test(target.checkout_oid)
  ||source.target_ref.ref!==target.ref||preview.target_ref!==target.ref||preview.target_oid!==target.checkout_oid
  ||head.oid!==null&&!oid.test(head.oid)||head.detached&&(head.branch!==null||head.oid===null)
  ||!head.detached&&(typeof head.branch!=='string'||!validGitReference('refs/heads/'+head.branch)))throw Error('git_checkout_evidence_invalid');
 const local=target.kind==='local',prefix=local?'refs/heads/':'refs/remotes/';
 if(!target.ref.startsWith(prefix)||target.name!==target.ref.slice(prefix.length))throw Error('git_checkout_evidence_invalid');
 if(local&&(target.object_type!=='commit'||target.oid!==target.checkout_oid))return{state:'policy_required',reason:'local_non_commit_target'};
 const after={oid:target.checkout_oid,branch:local?target.name:null,detached:!local};
 const body=Buffer.from(local?'ref: '+target.ref+'\n':target.checkout_oid+'\n','utf8');
 const from=head.detached?head.oid:head.branch,to=local?target.name:target.ref;
 return{state:'planned',protocol:1,mode:local?'branch':'detached',head:after,
  head_file:{sha256:createHash('sha256').update(body).digest('hex'),size:body.length},
  head_log:{append:source.log_policy.enabled||source.head_log.sha256!==null,
   old_oid:head.oid??'0'.repeat(target.checkout_oid.length),new_oid:target.checkout_oid,message:'checkout: moving from '+from+' to '+to},
  configuration:{common_sha256:source.configuration.common.sha256,worktree_sha256:source.configuration.worktree.sha256},target_ref_unchanged:true};
}

/** Capture the original configured log identity and one second-resolution UTC time. */
export function checkoutLogMetadata(raw:GitCommitOperatorPolicy,witness:GitCheckoutReviewWitness,timestamp?:string):GitCheckoutLogMetadata{
 const policy=gitCommitOperatorPolicy(raw),plan=checkoutReferencePlan(witness);
 const at=timestamp??new Date(Math.floor(Date.now()/1000)*1000).toISOString();
 if(plan.state!=='planned'||!plan.head_log.append||!Number.isFinite(Date.parse(at))||new Date(at).toISOString()!==at||!at.endsWith('.000Z'))throw Error('git_checkout_evidence_invalid');
 const committer={...policy.committer,timestamp:at};
 const entry=Buffer.from(plan.head_log.old_oid+' '+plan.head_log.new_oid+' '+gitCommitSignature(committer)+'\t'+plan.head_log.message+'\n','utf8');
 return{protocol:1,committer,operator_policy_sha256:createHash('sha256').update(canonicalJson({committer:policy.committer})).digest('hex'),
  entry_sha256:createHash('sha256').update(entry).digest('hex'),entry_size:entry.length};
}
