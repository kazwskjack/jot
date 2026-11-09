import {createHash} from 'node:crypto';
import {join} from 'node:path';
import type {GitCommitMetadata} from '../../contracts/types.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {workspaceRelativePath} from '../always-on/workspace-provider.ts';
import {commitReviewMetadata,gitCommitOperatorPolicy} from './commit-metadata.ts';
import {readCommitTreeObjects,type GitCommitReviewWitness,type GitCommitTreeObject} from './commit-tree.ts';
import {GitPublicationEffects} from './publication-effects.ts';
import {readGit} from './process.ts';

export type GitCommitSource={paths:readonly string[];message:string;review_sha256:string;witness:GitCommitReviewWitness;metadata:GitCommitMetadata};
export type GitCommitMaterial={
 witness:GitCommitReviewWitness;
 metadata:GitCommitMetadata;
 review_sha256:string;
 source_sha256:string;
 paths:readonly string[];
 tree_objects:readonly GitCommitTreeObject[];
 commit_object:{oid:string;body:Buffer;sha256:string};
 execution_authorized:false;
};
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const signature=(value:GitCommitMetadata['author'])=>value.name+' <'+value.email+'> '+Date.parse(value.timestamp)/1000+' +0000';

/** Host-private material only. Original owner, Worker/native custody and write
 * locks are required by the subsequent original effect coordinator. */
export class GitCommitEffects extends GitPublicationEffects{
 async prepareCommit(raw:GitCommitSource,signal?:AbortSignal):Promise<GitCommitMaterial>{
  signal?.throwIfAborted();
  if(!raw||!Array.isArray(raw.paths)||!raw.paths.length||raw.paths.length>100
   ||new Set(raw.paths).size!==raw.paths.length||!/^([a-f0-9]{64})$/.test(raw.review_sha256)
   ||raw.paths.some(path=>typeof path!=='string'||path.startsWith('-')||workspaceRelativePath(path)!==path))throw Error('git_commit_plan_invalid');
  const source=structuredClone(raw),{witness,metadata,message,paths}=source;
  const policy=gitCommitOperatorPolicy({author:{name:metadata.author.name,email:metadata.author.email},committer:{name:metadata.committer.name,email:metadata.committer.email}});
  const expected=commitReviewMetadata(policy,witness,message,metadata.author.timestamp);
  if(canonicalJson(expected)!==canonicalJson(metadata)
   ||hash(JSON.stringify({action:'commit',paths,message,witness,commit_metadata:metadata}))!==source.review_sha256
   ||canonicalJson(await this.freezeCommit(witness.snapshot_id,paths,signal))!==canonicalJson(witness))throw Error('git_commit_review_changed');
  const context=await this.context(signal);
  try{
   if(context.index!==witness.index_sha256||(await this.inspectContext(context,signal)).snapshot_id!==witness.snapshot_id)throw Error('git_commit_review_changed');
   const tree_objects=await readCommitTreeObjects(this.executable!,this.root,context,join(this.commonDirectory,'objects'),this.limits,witness.commit_tree,signal);
   const headers=[
    'tree '+metadata.tree_oid,
    ...(metadata.parent_oid===null?[]:['parent '+metadata.parent_oid]),
    'author '+signature(metadata.author),
    'committer '+signature(metadata.committer),
   ];
   // The reviewed message is appended byte-for-byte, including its original end.
   const body=Buffer.concat([Buffer.from(headers.join('\n')+'\n\n','utf8'),Buffer.from(message,'utf8')]);
   const oid=createHash(metadata.object_format).update('commit '+body.length+'\0').update(body).digest('hex');
   const written=await readGit(this.executable!,this.root,context.directory,['hash-object','-t','commit','-w','--stdin'],{...this.limits,maxOutputBytes:4096},signal,join(context.directory,'objects'),body);
   if(written.code!==0||written.bytes.toString('ascii').trim()!==oid)throw Error('git_commit_object_mismatch');
   const retained=await readGit(this.executable!,this.root,context.directory,['cat-file','commit',oid],{...this.limits,maxOutputBytes:64*1024},signal,join(context.directory,'objects'));
   if(retained.code!==0||!retained.bytes.equals(body))throw Error('git_commit_object_mismatch');
   if((await this.inspectContext(context,signal)).snapshot_id!==witness.snapshot_id
    ||canonicalJson(await this.freezeCommit(witness.snapshot_id,paths,signal))!==canonicalJson(witness))throw Error('git_commit_review_changed');
   signal?.throwIfAborted();
   return {witness,metadata,review_sha256:source.review_sha256,source_sha256:hash(JSON.stringify(witness)),paths,
    tree_objects,commit_object:{oid,body,sha256:hash(body)},execution_authorized:false};
  }finally{await context.dispose();}
 }
}
