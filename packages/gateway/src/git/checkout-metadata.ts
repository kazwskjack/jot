import {createHash} from 'node:crypto';
import type {GitCheckoutMetadataPublication,GitCheckoutLogMetadata,GitCheckoutReferencePlan,GitCheckoutReviewWitness} from '../../contracts/types.ts';
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
 const terminal=source.chains?.target.nodes.at(-1)?.path;
 const branch=terminal?.startsWith('refs/heads/')?terminal.slice('refs/heads/'.length):target.name;
 const after={oid:target.checkout_oid,branch:local?branch:null,detached:!local};
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
 const entry=checkoutReflogEntry(plan,committer);
 return{protocol:1,committer,operator_policy_sha256:createHash('sha256').update(canonicalJson({committer:policy.committer})).digest('hex'),
  entry_sha256:createHash('sha256').update(entry).digest('hex'),entry_size:entry.length};
}

/** Shared exact suffix for source hashing and subsequent original publication. */
export function checkoutReflogEntry(plan:Extract<GitCheckoutReferencePlan,{state:'planned'}>,committer:GitCheckoutLogMetadata['committer']){
 return Buffer.from(plan.head_log.old_oid+' '+plan.head_log.new_oid+' '+gitCommitSignature(committer)+'\t'+plan.head_log.message+'\n','utf8');
}

/** Fixed original metadata file/lock namespace. Per-file permissions remain review facts. */
export function checkoutMetadataPublication(witness:GitCheckoutReviewWitness):GitCheckoutMetadataPublication{
 const source=witness.preview.reference_source,plan=witness.reference_plan,log=witness.log_after;
 if(!source?.layout||!source.head_file.physical)return{state:'not_confirmed',reason:'layout_required'};
 if(!plan||plan.state!=='planned')return{state:'not_confirmed',reason:'reference_policy_required'};
 if(!source.chains){
  if(witness.target.symbolic_target)return{state:'not_confirmed',reason:'reference_policy_required'};
  const oldHead=Buffer.from('ref: refs/heads/'+witness.head.branch+'\n','utf8');
  if(!witness.head.detached&&createHash('sha256').update(oldHead).digest('hex')!==source.head_file.sha256)return{state:'not_confirmed',reason:'reference_policy_required'};
 }
 if(!log||log.state==='not_confirmed')return{state:'not_confirmed',reason:'log_after_required'};
 type File=Extract<GitCheckoutMetadataPublication,{state:'planned'}>['files'][number];
 const permissions=(file:File['before']):File['permissions']=>file.physical
  ?{state:'preserve',mode:file.physical.mode,uid:file.physical.uid,gid:file.physical.gid}:{state:'creation_policy_required'};
 const files:File[]=[];
 if(log.state==='appended')files.push({scope:'git',path:'logs/HEAD',operation:'append',before:source.head_log,
  after:{sha256:log.sha256,size:log.size},permissions:permissions(source.head_log)});
 files.push({scope:'git',path:'HEAD',operation:'replace',before:source.head_file,after:{...plan.head_file},permissions:permissions(source.head_file)});
 const locks:Extract<GitCheckoutMetadataPublication,{state:'planned'}>['locks']=[
  {scope:'git',path:'index.lock'},{scope:'common',path:'packed-refs.lock'},{scope:'common',path:'config.lock'},
  ...(source.configuration.worktree_enabled?[{scope:'git' as const,path:'config.worktree.lock'}]:[]),
  ...(source.source_ref?[{scope:'common' as const,path:source.source_ref.ref+'.lock'}]:[]),
  {scope:'common',path:witness.target.ref+'.lock'},
  ...(source.chains?[...source.chains.head.nodes,...source.chains.target.nodes].filter(node=>node.path!=='HEAD').map(node=>({scope:node.scope,path:node.path+'.lock'})):[]),
  ...files.map(file=>({scope:file.scope,path:file.path+'.lock'}))
 ];
 const unique=new Map(locks.map(lock=>[lock.scope+'\0'+lock.path,lock]));
 return{state:'planned',protocol:1,execution_authorized:false,files,locks:[...unique.values()]};
}
