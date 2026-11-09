import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import type {GitCheckoutContent,GitCheckoutPreview} from '../../contracts/types.ts';
import type {GitReadContext} from './inspection.ts';
import {readGit,type GitProcessLimits} from './process.ts';
import {readGitAttributes} from './attributes.ts';

type Changes=NonNullable<GitCheckoutPreview['index_projection']>['changes'];
/** Render through the projected index and a private fallback-attribute worktree. */
export async function readCheckoutContentDigests(options:{executable:string;context:GitReadContext;objects:string;index:string;changes:Changes;fallback:ReadonlyMap<string,Buffer>|null;sparse:boolean;limits:GitProcessLimits&{maxMetadataEntries:number};signal?:AbortSignal}){
 const {executable,context,objects,index,changes,fallback,sparse,limits,signal}=options;
 signal?.throwIfAborted();const deadline=Date.now()+limits.timeoutMs,maximum=64*1024*1024;
 const files=changes.filter(change=>change.after?.mode==='100644'||change.after?.mode==='100755'),facts=new Map<string,GitCheckoutContent>();
 for(const file of files)facts.set(file.path,{size:null,sha256:null,reason:'attribute_source_unconfirmed'});
 if(sparse){for(const file of files)facts.set(file.path,{size:null,sha256:null,reason:'sparse_policy_required'});return facts;}
 if(!files.length||fallback===null)return facts;
 const workspace=join(context.directory,'checkout-content');await mkdir(workspace,{mode:0o700});
 for(const [path,body] of fallback){
  signal?.throwIfAborted();if(Date.now()>=deadline)return facts;
  await mkdir(dirname(join(workspace,path)),{recursive:true});await writeFile(join(workspace,path),body,{mode:0o600,flag:'wx'});
 }
 const paths=new Set(files.map(file=>file.path)),remaining=deadline-Date.now();if(remaining<=0)return facts;
 let effective:Awaited<ReturnType<typeof readGitAttributes>>;
 try{effective=await readGitAttributes({executable,root:workspace,context,objects,index,paths,limits:{...limits,timeoutMs:remaining},...(signal?{signal}:{})});}
 catch(error){signal?.throwIfAborted();if(error instanceof Error&&['git_output_limit','git_read_timeout','git_metadata_limit'].includes(error.message))return facts;throw error;}
 if(effective===null)return facts;
 const filters=new Set(effective.filter(row=>row.name==='filter').map(row=>row.path));
 const conversion=new Set(['text','eol','crlf','ident','filter','working-tree-encoding']),byPath=new Map<string,Array<{name:string;value:string}>>();
 for(const row of effective)if(conversion.has(row.name)){const list=byPath.get(row.path)??[];list.push({name:row.name,value:row.value});byPath.set(row.path,list);}
 let total=0;
 for(const file of files){
  signal?.throwIfAborted();const attrs=byPath.get(file.path)??[],unconfirmed=(reason:NonNullable<GitCheckoutContent['reason']>)=>facts.set(file.path,{size:null,sha256:null,attributes:attrs,reason});
  if(!file.after?.blob?.sha256){unconfirmed('source_unconfirmed');continue;}
  if(filters.has(file.path)){unconfirmed('filter_policy_required');continue;}
  const remaining=deadline-Date.now();if(remaining<=0){unconfirmed('deadline');continue;}
  if(total>=maximum){unconfirmed('output_limit');continue;}
  const digest=createHash('sha256');let size=0;
  try{
   const result=await readGit(executable,workspace,context.directory,['cat-file','--filters',':0:'+file.path],{timeoutMs:remaining,maxOutputBytes:maximum-total},signal,
    join(context.directory,'objects'),undefined,objects,index,chunk=>{size+=chunk.length;digest.update(chunk);});
   total+=size;signal?.throwIfAborted();
   if(result.code!==0){unconfirmed('read_failed');continue;}
   facts.set(file.path,{size,sha256:digest.digest('hex'),attributes:attrs});
  }catch(error){
   signal?.throwIfAborted();const code=error instanceof Error?error.message:'';
   if(code==='git_output_limit'){total=maximum;unconfirmed('output_limit');}
   else if(code==='git_read_timeout')unconfirmed('deadline');
   else throw error;
  }
 }
 return facts;
}
