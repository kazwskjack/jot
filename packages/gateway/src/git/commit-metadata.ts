import {validGitReference} from './references.ts';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../db/canonical-json.ts';
import type {GitCommitReviewWitness} from './commit-tree.ts';
import type {GitCommitMetadata} from '../../contracts/types.ts';

type Identity={name:string;email:string};
export type GitCommitOperatorPolicy=Readonly<{author:Readonly<Identity>;committer:Readonly<Identity>}>;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const utf8=(value:string)=>Buffer.from(value,'utf8').toString('utf8')===value;

/** Operator configuration only. Source repository config and browser fields
 * cannot supply an identity or an executable configuration reference. */
export function gitCommitOperatorPolicy(value:unknown):GitCommitOperatorPolicy{
 const policy=value as Record<string,unknown>|null;
 if(!policy||typeof policy!=='object'||Array.isArray(policy)||Object.keys(policy).sort().join(',')!=='author,committer')throw Error('git_configuration_invalid');
 const identity=(input:unknown):Readonly<Identity>=>{
  const item=input as Identity|null;
  if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!=='email,name'
   ||typeof item.name!=='string'||!item.name.trim()||item.name.length>255||!utf8(item.name)||/[<>\x00-\x1f\x7f]/.test(item.name)
   ||typeof item.email!=='string'||!item.email||item.email.length>255||!utf8(item.email)||/[<>\s\x00-\x1f\x7f]/.test(item.email))throw Error('git_configuration_invalid');
  return Object.freeze({name:item.name,email:item.email});
 };
 return Object.freeze({author:identity(policy.author),committer:identity(policy.committer)});
}

export function commitReviewMetadata(policy:GitCommitOperatorPolicy,witness:GitCommitReviewWitness,message:string,timestamp?:string):GitCommitMetadata{
 const at=timestamp??new Date(Math.floor(Date.now()/1000)*1000).toISOString();
 const {head,commit_tree:tree}=witness;
 const oid=(value:unknown)=>typeof value==='string'&&new RegExp('^[a-f0-9]{'+(tree?.object_format==='sha1'?40:64)+'}$').test(value);
 if(!tree||!['sha1','sha256'].includes(tree.object_format)||!oid(tree.tree_oid)||!head||head.oid!==null&&!oid(head.oid)
  ||typeof message!=='string'||!message.trim()||message.length>20000||message.includes('\0')||!utf8(message)
  ||!Number.isFinite(Date.parse(at))||new Date(at).toISOString()!==at||!at.endsWith('.000Z'))throw Error('git_commit_metadata_invalid');
 let target:string,state:GitCommitMetadata['head_state'];
 if(head.detached){
  if(head.branch!==null||head.oid===null)throw Error('git_commit_metadata_invalid');
  target='HEAD';state='detached';
 }else{
  if(typeof head.branch!=='string'||!head.branch)throw Error('git_commit_metadata_invalid');
  target='refs/heads/'+head.branch;state=head.oid===null?'unborn':'branch';
  if(!validGitReference(target))throw Error('git_commit_metadata_invalid');
 }
 return {
  protocol:1,encoding:'UTF-8',object_format:tree.object_format,tree_oid:tree.tree_oid,parent_oid:head.oid,target_ref:target,head_state:state,
  author:{...policy.author,timestamp:at},committer:{...policy.committer,timestamp:at},
  operator_policy_sha256:hash(canonicalJson(policy)),message_sha256:hash(message),message_bytes:Buffer.byteLength(message,'utf8'),
 };
}

export const gitCommitSignature=(value:GitCommitMetadata['author'])=>value.name+' <'+value.email+'> '+Date.parse(value.timestamp)/1000+' +0000';

/** Derive the exact reviewed object bytes without a clock or source config. */
export function gitCommitObject(metadata:GitCommitMetadata,message:string){
 if(typeof message!=='string'||!utf8(message)||message.includes('\0')||message.length>20000
  ||hash(message)!==metadata.message_sha256||Buffer.byteLength(message,'utf8')!==metadata.message_bytes)throw Error('git_commit_metadata_invalid');
 const headers=['tree '+metadata.tree_oid,...(metadata.parent_oid===null?[]:['parent '+metadata.parent_oid]),
  'author '+gitCommitSignature(metadata.author),'committer '+gitCommitSignature(metadata.committer)];
 const body=Buffer.concat([Buffer.from(headers.join('\n')+'\n\n','utf8'),Buffer.from(message,'utf8')]);
 const oid=createHash(metadata.object_format).update('commit '+body.length+'\0').update(body).digest('hex');
 return {oid,body,sha256:hash(body)};
}
