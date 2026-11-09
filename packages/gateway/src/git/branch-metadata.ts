import {createHash} from 'node:crypto';
import type {GitCreateBranchWitness,GitBranchMetadata} from '../../contracts/types.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {gitCommitOperatorPolicy,gitCommitSignature,type GitCommitOperatorPolicy} from './commit-metadata.ts';

const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Configured original committer and one captured time for branch reflogs. */
export function branchReviewMetadata(raw:GitCommitOperatorPolicy,witness:GitCreateBranchWitness,timestamp?:string):GitBranchMetadata{
 const policy=gitCommitOperatorPolicy(raw),at=timestamp??new Date(Math.floor(Date.now()/1000)*1000).toISOString();
 if(witness.protocol!==2||!Number.isFinite(Date.parse(at))||new Date(at).toISOString()!==at||!at.endsWith('.000Z'))throw Error('git_branch_metadata_invalid');
 return{protocol:1,committer:{...policy.committer,timestamp:at},operator_policy_sha256:hash({committer:policy.committer}),
  log_policy_sha256:hash(witness.reflog),logs:{
   head:witness.target_oid!==null&&(witness.reflog.enabled||witness.reflog.head.sha256!==null),
   branch:witness.target_oid!==null&&(witness.reflog.enabled||witness.reflog.branch.sha256!==null)
  },...(witness.configuration?{configuration_sha256:hash(witness.configuration),configuration_changed:witness.configuration.changed}:{})};
}

/** Exact frozen checkout/branch log suffix, independent of source identity config. */
export function branchReflogEntry(witness:GitCreateBranchWitness,metadata:GitBranchMetadata,scope:'git'|'common'){
 const oid=witness.target_oid;
 if(oid===null)throw Error('git_branch_reflog_invalid');
 const old=scope==='git'?oid:'0'.repeat(oid.length);
 const message=scope==='git'?'checkout: moving from '+(witness.head.detached?oid:witness.head.branch)+' to '+witness.branch:'branch: Created from HEAD';
 return Buffer.from(old+' '+oid+' '+gitCommitSignature(metadata.committer)+'\t'+message+'\n','utf8');
}
