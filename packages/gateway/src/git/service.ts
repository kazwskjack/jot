import {isAbsolute,resolve,join} from 'node:path';
import type {ProjectRepository} from '../projects/repository.ts';
import {GitRepositoryInspection} from './inspection.ts';

export type GitRepositoryBinding={owner_id:string;project_id:string;root:string;git_directory?:string;common_directory?:string};
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
export class GitWorkbench{
 private readonly repositories=new Map<string,GitRepositoryInspection>();
 private readonly projects:ProjectRepository;
 constructor(projects:ProjectRepository,bindings:readonly GitRepositoryBinding[]=[],executable?:string){
  this.projects=projects;
  if(!Array.isArray(bindings)||bindings.length>100||executable!==undefined&&(typeof executable!=='string'||!isAbsolute(executable)))throw Error('git_configuration_invalid');
  const roots=new Set<string>();
  for(const raw of bindings){
   if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['owner_id','project_id','root','git_directory','common_directory'].includes(key))||typeof raw.owner_id!=='string'||!ID.test(raw.owner_id)||typeof raw.project_id!=='string'||!ID.test(raw.project_id)||typeof raw.root!=='string'||!isAbsolute(raw.root))throw Error('git_configuration_invalid');
   for(const path of [raw.git_directory,raw.common_directory])if(path!==undefined&&(typeof path!=='string'||!isAbsolute(path)))throw Error('git_configuration_invalid');
   const key=raw.owner_id+'\0'+raw.project_id,common=resolve(raw.common_directory??raw.git_directory??join(raw.root,'.git')),identity=process.platform==='win32'?common.toLowerCase():common;
   if(this.repositories.has(key)||roots.has(identity))throw Error('git_configuration_invalid');roots.add(identity);
   this.repositories.set(key,new GitRepositoryInspection({root:raw.root,...(raw.git_directory?{gitDirectory:raw.git_directory}:{}),...(raw.common_directory?{commonDirectory:raw.common_directory}:{}),...(executable?{executable}:{})}));
  }
 }
 capability(owner:string){
  const configured_projects:string[]=[];for(const key of this.repositories.keys()){const [candidate,project]=key.split('\0');if(candidate!==owner)continue;try{this.projects.assertOwned(project!,owner);configured_projects.push(project!);}catch{}}
  return{configured_projects:configured_projects.sort(),read_only:true as const};
 }
 private repository(owner:string,project:string){this.projects.assertOwned(project,owner);const repository=this.repositories.get(owner+'\0'+project);if(!repository)throw Error('git_repository_unconfigured');return repository;}
 async inspect(owner:string,project:string,signal?:AbortSignal){const result=await this.repository(owner,project).inspect(signal);this.projects.assertOwned(project,owner);return{project_id:project,...result};}
 async freeze(owner:string,project:string,snapshotId:string,paths:readonly string[],signal?:AbortSignal){const result=await this.repository(owner,project).freeze(snapshotId,paths,signal);this.projects.assertOwned(project,owner);return result;}
 async diff(owner:string,project:string,input:{snapshot_id:string;path:string;stage:'working'|'staged'},signal?:AbortSignal){const result=await this.repository(owner,project).diff(input,signal);this.projects.assertOwned(project,owner);return{project_id:project,...result};}
}
