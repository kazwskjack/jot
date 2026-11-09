import {branchReviewMetadata} from './branch-metadata.ts';
import type {GitCreateBranchWitness} from '../../contracts/types.ts';
import {gitCommitOperatorPolicy,commitReviewMetadata,type GitCommitOperatorPolicy} from './commit-metadata.ts';
import type {GitCommitReviewWitness} from './commit-tree.ts';
import {isAbsolute,resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../db/canonical-json.ts';
import type {ProjectRepository} from '../projects/repository.ts';
import type {GitCommitSource} from './commit-effects.ts';
import type {GitBranchSource} from './branch-effects.ts';
import {GitInitializationEffects,type GitInitializationSource} from './initialization-effects.ts';

export type GitRepositoryBinding={owner_id:string;project_id:string;root:string;git_directory?:string;common_directory?:string;commit_identity?:GitCommitOperatorPolicy};
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
export class GitWorkbench{
 private readonly repositories=new Map<string,GitInitializationEffects>();
 private readonly commitPolicies=new Map<string,GitCommitOperatorPolicy>();
 private readonly executionBindings=new Map<string,string>();
 private readonly projects:ProjectRepository;
 constructor(projects:ProjectRepository,bindings:readonly GitRepositoryBinding[]=[],executable?:string){
  this.projects=projects;
  if(!Array.isArray(bindings)||bindings.length>100||executable!==undefined&&(typeof executable!=='string'||!isAbsolute(executable)))throw Error('git_configuration_invalid');
  const roots=new Set<string>();
  for(const raw of bindings){
   if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['owner_id','project_id','root','git_directory','common_directory','commit_identity'].includes(key))||typeof raw.owner_id!=='string'||!ID.test(raw.owner_id)||typeof raw.project_id!=='string'||!ID.test(raw.project_id)||typeof raw.root!=='string'||!isAbsolute(raw.root))throw Error('git_configuration_invalid');
   for(const path of [raw.git_directory,raw.common_directory])if(path!==undefined&&(typeof path!=='string'||!isAbsolute(path)))throw Error('git_configuration_invalid');
   const key=raw.owner_id+'\0'+raw.project_id,common=resolve(raw.common_directory??raw.git_directory??join(raw.root,'.git')),identity=process.platform==='win32'?common.toLowerCase():common;
   if(this.repositories.has(key)||roots.has(identity))throw Error('git_configuration_invalid');roots.add(identity);
   this.repositories.set(key,new GitInitializationEffects({root:raw.root,...(raw.git_directory?{gitDirectory:raw.git_directory}:{}),...(raw.common_directory?{commonDirectory:raw.common_directory}:{}),...(executable?{executable}:{})}));
   if(raw.commit_identity!==undefined)this.commitPolicies.set(key,gitCommitOperatorPolicy(raw.commit_identity));
   this.executionBindings.set(key,createHash('sha256').update('git-common-binding:v1\0'+identity).digest('hex'));
  }
 }
 capability(owner:string,nativeIndexConfigured=false,commitSchemaConfigured=false,branchSchemaConfigured=false,initializationSchemaConfigured=false,reinitializationSchemaConfigured=false){
  const configured_projects:string[]=[];for(const key of this.repositories.keys()){const [candidate,project]=key.split('\0');if(candidate!==owner)continue;try{this.projects.assertOwned(project!,owner);configured_projects.push(project!);}catch{}}
  configured_projects.sort();
  if(!nativeIndexConfigured||!configured_projects.length)return {configured_projects,read_only:true as const};
  const commit_projects=commitSchemaConfigured?configured_projects.filter(project=>this.commitPolicies.has(owner+'\0'+project)):[];
  const branch_projects=branchSchemaConfigured?configured_projects.filter(project=>this.commitPolicies.has(owner+'\0'+project)):[];
  const initialization_projects=initializationSchemaConfigured?configured_projects.filter(project=>this.repositories.get(owner+'\0'+project)!.initializationConfigured()):[];
  const reinitialization_projects=reinitializationSchemaConfigured?configured_projects:[];
  return {configured_projects,read_only:false as const,index_actions:['stage','unstage'] as ['stage','unstage'],...(commit_projects.length?{commit_projects}:{}),...(branch_projects.length?{branch_projects}:{}),...(initialization_projects.length?{initialization_projects}:{}),...(reinitialization_projects.length?{reinitialization_projects}:{})};
 }
 private repository(owner:string,project:string){this.projects.assertOwned(project,owner);const repository=this.repositories.get(owner+'\0'+project);if(!repository)throw Error('git_repository_unconfigured');return repository;}
 /** Trusted execution service only; not a route, tool or permission grant. */
 indexEffects(owner:string,project:string){return this.repository(owner,project);}
 /** Host-private preparation, with current original project and identity policy. */
 async prepareCommit(owner:string,project:string,raw:GitCommitSource,signal?:AbortSignal){
  const source=structuredClone(raw);
  const authorize=()=>{
   const current=this.commitMetadata(owner,project,source.witness,source.message,source.metadata.author.timestamp);
   if(canonicalJson(current)!==canonicalJson(source.metadata))throw Error('git_execution_revoked');
  };
  authorize();
  const result=await this.repository(owner,project).prepareCommit(source,signal);
  authorize();signal?.throwIfAborted();return result;
 }
 /** Original owner and configured actor policy fence the host-private plan. */
 async prepareCreateBranch(owner:string,project:string,raw:GitBranchSource,signal?:AbortSignal){
  const source=structuredClone(raw);
  const authorize=()=>{
   const current=this.branchMetadata(owner,project,source.witness,source.metadata.committer.timestamp);
   if(canonicalJson(current)!==canonicalJson(source.metadata))throw Error('git_execution_revoked');
  };
  authorize();const result=await this.repository(owner,project).prepareCreateBranch(source,signal);
  authorize();signal?.throwIfAborted();return result;
 }
 /** Read-only original plan preparation. Source-volume scratch belongs only
  * to the subsequent native producer attempt after original approval/admission. */
 async prepareInitialization(owner:string,project:string,raw:GitInitializationSource,signal?:AbortSignal){
  const source=structuredClone(raw),result=await this.repository(owner,project).prepareInitialization(source,signal);
  this.repository(owner,project);signal?.throwIfAborted();return result;
 }
 /** Configured exclusion scope, independent of snapshot/program encodings.
  * It grants no filesystem authority and never exposes the configured path. */
 executionBinding(owner:string,project:string){this.repository(owner,project);return this.executionBindings.get(owner+'\0'+project)!;}
 async inspect(owner:string,project:string,signal?:AbortSignal){const result=await this.repository(owner,project).inspect(signal);this.projects.assertOwned(project,owner);return{project_id:project,...result,commit_identity_ready:this.commitPolicies.has(owner+'\0'+project)};}
 async taskmasterFiles(owner:string,project:string,signal?:AbortSignal){const result=await this.repository(owner,project).taskmasterFiles(signal);this.projects.assertOwned(project,owner);return result;}
 async taskmasterPrdFiles(owner:string,project:string,after:string|undefined,signal?:AbortSignal){const result=await this.repository(owner,project).taskmasterPrdFiles(after,signal);this.projects.assertOwned(project,owner);return result;}
 async taskmasterPrdFile(owner:string,project:string,fileName:string,signal?:AbortSignal){const result=await this.repository(owner,project).taskmasterPrdFile(fileName,signal);this.projects.assertOwned(project,owner);return result;}
 async freeze(owner:string,project:string,snapshotId:string,paths:readonly string[],signal?:AbortSignal){const result=await this.repository(owner,project).freeze(snapshotId,paths,signal);this.projects.assertOwned(project,owner);return result;}
 commitMetadata(owner:string,project:string,witness:GitCommitReviewWitness,message:string,timestamp?:string){
  this.repository(owner,project);const policy=this.commitPolicies.get(owner+'\0'+project);
  if(!policy)throw Error('git_commit_identity_unconfigured');
  return commitReviewMetadata(policy,witness,message,timestamp);
 }
 async freezeCommit(owner:string,project:string,snapshotId:string,paths:readonly string[],signal?:AbortSignal){const result=await this.repository(owner,project).freezeCommit(snapshotId,paths,signal);this.projects.assertOwned(project,owner);signal?.throwIfAborted();return result;}
 async publicationTarget(owner:string,project:string,paths:readonly string[],signal?:AbortSignal){const result=await this.repository(owner,project).publicationTarget(paths,signal);this.projects.assertOwned(project,owner);signal?.throwIfAborted();return result;}
 branchMetadata(owner:string,project:string,witness:GitCreateBranchWitness,timestamp?:string){
  this.repository(owner,project);const policy=this.commitPolicies.get(owner+'\0'+project);
  if(!policy)throw Error('git_branch_identity_unconfigured');return branchReviewMetadata(policy,witness,timestamp);
 }
 async freezeCreateBranch(owner:string,project:string,snapshotId:string,branch:string,signal?:AbortSignal){const result=await this.repository(owner,project).freezeCreateBranch(snapshotId,branch,signal);this.projects.assertOwned(project,owner);signal?.throwIfAborted();return result;}
 async initialization(owner:string,project:string,signal?:AbortSignal){
  const result=await this.repository(owner,project).initialization(signal);
  this.projects.assertOwned(project,owner);signal?.throwIfAborted();return{project_id:project,...result};
 }
 async freezeInitialization(owner:string,project:string,snapshotId:string,initialBranch:string,objectFormat:'sha1'|'sha256',signal?:AbortSignal){
  const result=await this.repository(owner,project).freezeInitialization(snapshotId,initialBranch,objectFormat,signal);
  this.projects.assertOwned(project,owner);signal?.throwIfAborted();return result;
 }
 async branches(owner:string,project:string,snapshotId:string,signal?:AbortSignal,targetRef?:string){const result=await this.repository(owner,project).branches(snapshotId,signal,targetRef);this.projects.assertOwned(project,owner);signal?.throwIfAborted();return {project_id:project,...result};}
 async diff(owner:string,project:string,input:{snapshot_id:string;path:string;stage:'working'|'staged'},signal?:AbortSignal){const result=await this.repository(owner,project).diff(input,signal);this.projects.assertOwned(project,owner);return{project_id:project,...result};}
}
