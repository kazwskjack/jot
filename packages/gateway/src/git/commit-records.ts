import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {GitCommitMetadata} from '../../contracts/types.ts';
import type {GitCommitReviewWitness} from './commit-tree.ts';
import {gitCommitOperatorPolicy,commitReviewMetadata} from './commit-metadata.ts';
import {workspaceRelativePath} from '../always-on/workspace-provider.ts';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Selection={action:'commit';paths:string[];snapshot_id:string;message:string;commit_metadata:GitCommitMetadata};

/** Exact approved immutable facts only. Current owner, policy, source, custody
 * and effect permission are rechecked by the original execution service. */
export function readCommitReviewSource(db:DatabaseSync,owner:string,project:string,intent:string,version:number,review:string){
 try{
  const row=db.prepare('SELECT * FROM wb_git_mutation_intents WHERE owner_id=? AND project_id=? AND intent_id=?').get(owner,project,intent);
  const approval=db.prepare("SELECT 1 FROM wb_git_mutation_events WHERE intent_id=? AND version=? AND state='approved'").get(intent,version);
  if(!row||!approval||row.action!=='commit'||row.review_sha256!==review)throw Error();
  const selection=JSON.parse(String(row.selection_json)) as Selection,witness=JSON.parse(String(row.witness_json)) as GitCommitReviewWitness;
  const metadata=selection.commit_metadata;
  if(selection.action!=='commit'||!metadata||!Array.isArray(selection.paths)||!selection.paths.length||selection.paths.length>5000
   ||new Set(selection.paths).size!==selection.paths.length||selection.paths.some(path=>typeof path!=='string'||path.startsWith('-')||workspaceRelativePath(path)!==path)
   ||selection.snapshot_id!==witness.snapshot_id||witness.protocol!==2||!Array.isArray(witness.attributes))throw Error();
  const policy=gitCommitOperatorPolicy({author:{name:metadata.author.name,email:metadata.author.email},committer:{name:metadata.committer.name,email:metadata.committer.email}});
  const expected=commitReviewMetadata(policy,witness,selection.message,metadata.author.timestamp);
  if(JSON.stringify(metadata)!==JSON.stringify(expected)
   ||digest({action:selection.action,paths:selection.paths,message:selection.message,witness,commit_metadata:metadata})!==review)throw Error();
  return {action:'commit' as const,paths:selection.paths,message:selection.message,witness,metadata};
 }catch{throw Error('git_execution_evidence_corrupt');}
}

export function readCommitExecutionSource(db:DatabaseSync,row:{owner_id:string;project_id:string;intent_id:string;review_version:number;review_sha256:string;witness_sha256:string;repository_sha256:string}){
 const source=readCommitReviewSource(db,row.owner_id,row.project_id,row.intent_id,row.review_version,row.review_sha256);
 if(digest(source.witness)!==row.witness_sha256||source.witness.repository_sha256!==row.repository_sha256)throw Error('git_execution_evidence_corrupt');
 return source;
}
