import {createHash,randomUUID} from 'node:crypto';
import {constants,lstatSync,realpathSync,readdirSync,openSync,closeSync,fstatSync,readFileSync,writeFileSync,fsyncSync,fchmodSync,mkdirSync,renameSync,linkSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {GitIndexEffects} from './index-effects.ts';
import type {GitPublicationTargetWitness} from './inspection.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {workspaceRelativePath} from '../always-on/workspace-provider.ts';
import {freezeWorkAdmission} from '../always-on/work-admission-records.ts';

type Row=Record<string,any>;
type FileFact={kind:'file';identity:string;stat_sha256:string;sha256:string;size:number;mode:number};
export type PublicationStep={plan_id:string;step_id:string;phase:'directory'|'stage'|'publish';path:string;scratch?:string;sha256?:string;size?:number};
export type PublicationEffect=PublicationStep&{fact:FileFact|{kind:'directory';identity:string}};
export type PublicationPlan=Readonly<{protocol:1;plan_id:string;target_sha256:string;repository_sha256:string;files:readonly {path:string;kind:'add'|'modify';scratch:string;sha256:string;size:number;mode:number}[];execution_authorized:false}>;
export type PublicationReceipt=Readonly<{protocol:1;plan_id:string;target_sha256:string;state:'applied';files:readonly {path:string;sha256:string;size:number;identity:string;stat_sha256:string;mode:number}[];execution_authorized:false}>;
export type PublicationAuthority={authorize:()=>void;prepared:(plan:PublicationPlan)=>void;intent:(step:PublicationStep)=>void;apply:(step:PublicationStep,operation:()=>PublicationEffect)=>PublicationEffect;completed:(result:PublicationReceipt)=>void};
type Stored={state:'ready'|'consumed';witness:GitPublicationTargetWitness;bytes:Map<string,Buffer>;facts:Map<string,FileFact|null>;parents:Map<string,string|null>;directories:Map<string,string>;metadata:string;dot:string;scratch:Map<string,FileFact>};
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const digest=(value:unknown)=>hash(canonicalJson(value));
const stat=(path:string)=>lstatSync(path,{bigint:true});
const identity=(s:{dev:bigint;ino:bigint})=>s.dev+':'+s.ino;
const stamp=(s:ReturnType<typeof stat>)=>[identity(s),s.size,s.mtimeNs,s.ctimeNs,s.nlink].join(':');
const same=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function fail(code:string):never{throw Error('git_publication_'+code);}
function sync<T>(operation:()=>T):T{const value=operation();if(value&&typeof(value as {then?:unknown}).then==='function'){Promise.resolve(value).catch(()=>{});fail('authority_invalid');}return value;}

/** Configured file-publication kernel. Original source bytes, owner review,
 * native custody, Worker lease and durable intent/receipt transactions belong
 * to the original coordinator. This class mounts no route or task runner.
 * Failed/unknown effects are retained for original recovery, never replayed or
 * silently rolled back. Git index, refs and source snapshots are never written. */
export class GitPublicationEffects extends GitIndexEffects{
 private readonly publicationPlans=new WeakMap<PublicationPlan,Stored>();
 private directoryIdentity(path:string){
  for(let current=path;;current=dirname(current)){const s=stat(current);if(!s.isDirectory()||s.isSymbolicLink())fail('target_changed');if(dirname(current)===current)break;}
  if(!same(realpathSync(path),path))fail('target_changed');return identity(stat(path));
 }
 private fileFact(path:string):FileFact|null{
  let before;try{before=stat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>32n*1024n*1024n)fail('target_changed');
  this.directoryIdentity(dirname(path));const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{if(stamp(fstatSync(fd,{bigint:true}))!==stamp(before))fail('target_changed');const bytes=readFileSync(fd);if(bytes.length!==Number(before.size)||stamp(fstatSync(fd,{bigint:true}))!==stamp(before)||stamp(stat(path))!==stamp(before))fail('target_changed');
   return{kind:'file',identity:identity(before),stat_sha256:hash(stamp(before)),sha256:hash(bytes),size:bytes.length,mode:Number(before.mode&0o777n)};
  }finally{closeSync(fd);}
 }
 private metadataWitness(){
  const values:string[]=[];let count=0;
  for(const root of [...new Set([this.gitDirectory,this.commonDirectory])]){const queue=[root];while(queue.length){const path=queue.pop()!;for(const name of readdirSync(path)){if(++count>100000)fail('metadata_limit');const child=join(path,name),s=stat(child);if(s.isSymbolicLink()||!s.isFile()&&!s.isDirectory())fail('target_changed');values.push(child+':'+stamp(s)+':'+s.mode);if(s.isDirectory())queue.push(child);}}}
  return hash(values.sort().join('\n'));
 }
 private publicationDotWitness(){const path=join(this.root,'.git'),s=stat(path);if(s.isSymbolicLink())fail('target_changed');return s.isDirectory()?'directory:'+identity(s):'file:'+digest(this.fileFact(path));}
 private relativeCurrent(path:string){
  let folder=this.root;const parts=path.split('/');
  for(let index=0;index<parts.length;index++){const names=readdirSync(folder);if(names.length>100000||index>0&&names.some(name=>name.toLowerCase()==='.git'))fail('target_changed');
   const part=parts[index]!,matches=names.filter(name=>name.normalize('NFC').toLowerCase()===part.normalize('NFC').toLowerCase());
   if(matches.length>1||matches.length===1&&matches[0]!==part)fail('target_changed');if(!matches.length)return;
   const selected=join(folder,part),s=stat(selected);if(s.isSymbolicLink()||index<parts.length-1&&!s.isDirectory())fail('target_changed');folder=selected;
  }
 }
 private checkPublication(stored:Stored){
  for(const [path,id] of stored.directories)if(this.directoryIdentity(path)!==id)fail('target_changed');
  if(this.publicationDotWitness()!==stored.dot||this.metadataWitness()!==stored.metadata)fail('target_changed');
  for(const [path,id] of stored.parents){this.relativeCurrent(path);let actual:string|null;try{actual=this.directoryIdentity(join(this.root,path));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;actual=null;}if(actual!==id)fail('target_changed');}
  for(const [path,fact] of stored.facts){this.relativeCurrent(path);if(canonicalJson(this.fileFact(join(this.root,path)))!==canonicalJson(fact))fail('target_changed');}
  for(const [path,fact] of stored.scratch)if(canonicalJson(this.fileFact(join(this.root,path)))!==canonicalJson(fact))fail('target_changed');
  for(const attribute of stored.witness.attributes){this.relativeCurrent(attribute.path);if((this.fileFact(join(this.root,attribute.path))?.sha256??null)!==attribute.sha256)fail('target_changed');}
 }
 async preparePublication(raw:GitPublicationTargetWitness,changes:readonly Row[],materials:ReadonlyMap<string,Buffer>,signal?:AbortSignal):Promise<PublicationPlan>{
  signal?.throwIfAborted();if(!raw||!Array.isArray(changes)||!changes.length||changes.length>100||!(materials instanceof Map))fail('plan_invalid');
  const witness=structuredClone(raw),{target_sha256,...payload}=witness;if(witness.protocol!==1||witness.kind!=='publication_target'||witness.execution_authorized!==false||digest(payload)!==target_sha256)fail('plan_invalid');
  const paths=changes.map(change=>workspaceRelativePath(change.path));if(canonicalJson(paths)!==canonicalJson(witness.files.map(file=>file.path))||materials.size!==paths.length)fail('plan_invalid');
  const bytes=new Map<string,Buffer>();let total=0;const id='work-publication-plan-'+randomUUID();
  const files=changes.map(change=>{
   const before=witness.files.find(file=>file.path===change.path)!,body=materials.get(change.path);if(!Buffer.isBuffer(body))fail('plan_invalid');const copied=Buffer.from(body);
   if(!change.after||change.after.kind!=='file'||change.after.path!==change.path||change.after.executable!==false||hash(copied)!==change.after.sha256||copied.length!==change.after.bytes||copied.length>32*1024*1024||(total+=copied.length)>64*1024*1024)fail('source_changed');
   if(change.kind==='add'){if(change.before!==null||before.kind!=='missing')fail('source_changed');}
   else if(change.kind==='modify'){if(change.before?.kind!=='file'||before.kind!=='file'||change.before.sha256!==before.sha256||change.before.bytes!==before.size)fail('source_changed');}else fail('source_unsupported');
   bytes.set(change.path,copied);const folder=dirname(change.path),scratch=(folder==='.'?'':folder+'/')+'.jot-publication-'+randomUUID()+'.tmp';
   return{path:change.path as string,kind:change.kind as 'add'|'modify',scratch,sha256:hash(copied),size:copied.length,mode:before.kind==='file'?before.mode:0o644};
  });
  const current=await this.publicationTarget(paths,signal);if(canonicalJson(current.witness)!==canonicalJson(witness))fail('target_changed');signal?.throwIfAborted();
  const parents=new Map<string,string|null>(),facts=new Map<string,FileFact|null>();
  for(const file of witness.files){facts.set(file.path,this.fileFact(join(this.root,file.path)));const parts=file.path.split('/');parts.pop();for(let n=1;n<=parts.length;n++){const parent=parts.slice(0,n).join('/');if(parents.has(parent))continue;try{parents.set(parent,this.directoryIdentity(join(this.root,parent)));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;parents.set(parent,null);}}}
  for(const file of witness.files){const fact=facts.get(file.path);if(file.kind==='missing'?fact!==null:!fact||fact.stat_sha256!==file.stat_sha256||fact.sha256!==file.sha256||fact.mode!==file.mode)fail('target_changed');}
  const stored:Stored={state:'ready',witness,bytes,facts,parents,directories:new Map([...new Set([this.root,this.gitDirectory,this.commonDirectory])].map(path=>[path,this.directoryIdentity(path)])),metadata:this.metadataWitness(),dot:this.publicationDotWitness(),scratch:new Map()};
  this.checkPublication(stored);const plan=freezeWorkAdmission({protocol:1 as const,plan_id:id,target_sha256,repository_sha256:witness.repository_sha256,files,execution_authorized:false as const});this.publicationPlans.set(plan,stored);return plan;
 }
 async applyPublication(plan:PublicationPlan,authority:PublicationAuthority,signal?:AbortSignal):Promise<PublicationReceipt>{
  const stored=this.publicationPlans.get(plan);if(!stored)fail('plan_invalid');if(stored.state!=='ready')fail('plan_consumed');
  if(!authority||!['authorize','prepared','intent','apply','completed'].every(key=>typeof authority[key as keyof PublicationAuthority]==='function'&&authority[key as keyof PublicationAuthority].constructor.name!=='AsyncFunction'))fail('authority_invalid');
  stored.state='consumed';const guard=()=>{signal?.throwIfAborted();sync(()=>authority.authorize());this.checkPublication(stored);};
  const step=async(evidence:PublicationStep,effect:()=>PublicationEffect)=>{
   guard();sync(()=>authority.intent(freezeWorkAdmission(evidence)));guard();let active=true,called=false,original:PublicationEffect|undefined;
   const perform=()=>{if(!active||called)fail('authority_invalid');called=true;guard();return original=freezeWorkAdmission(effect());};
   try{const result=sync(()=>authority.apply(evidence,perform));if(!called||!original||canonicalJson(result)!==canonicalJson(original))fail('authority_invalid');}
   finally{active=false;}
   await new Promise<void>(done=>setImmediate(done));guard();
  };
  guard();sync(()=>authority.prepared(plan));guard();
  for(const [path,id] of [...stored.parents].sort(([a],[b])=>a.split('/').length-b.split('/').length||a.localeCompare(b))){if(id!==null)continue;
   const evidence:PublicationStep={plan_id:plan.plan_id,step_id:'directory:'+path,phase:'directory',path};
   await step(evidence,()=>{mkdirSync(join(this.root,path),{mode:0o700});const identity=this.directoryIdentity(join(this.root,path));stored.parents.set(path,identity);return{...evidence,fact:{kind:'directory',identity}};});
  }
  for(const file of plan.files){
   const stage:PublicationStep={plan_id:plan.plan_id,step_id:'stage:'+file.path,phase:'stage',path:file.path,scratch:file.scratch,sha256:file.sha256,size:file.size};
   await step(stage,()=>{const path=join(this.root,file.scratch);this.relativeCurrent(file.scratch);const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),file.mode);
    try{writeFileSync(fd,stored.bytes.get(file.path)!);fchmodSync(fd,file.mode);fsyncSync(fd);}finally{closeSync(fd);}const fact=this.fileFact(path);if(!fact||fact.sha256!==file.sha256||fact.size!==file.size)fail('target_changed');stored.scratch.set(file.scratch,fact);return{...stage,fact};});
   const publish:PublicationStep={...stage,step_id:'publish:'+file.path,phase:'publish'};
   await step(publish,()=>{const scratch=join(this.root,file.scratch),target=join(this.root,file.path),owned=stored.scratch.get(file.scratch)!;
    if(file.kind==='add'){linkSync(scratch,target);unlinkSync(scratch);}else renameSync(scratch,target);
    const fact=this.fileFact(target);if(!fact||fact.identity!==owned.identity||fact.sha256!==file.sha256||fact.size!==file.size)fail('target_changed');stored.scratch.delete(file.scratch);stored.facts.set(file.path,fact);return{...publish,fact};});
  }
  guard();const result:PublicationReceipt=freezeWorkAdmission({protocol:1,plan_id:plan.plan_id,target_sha256:plan.target_sha256,state:'applied',files:plan.files.map(file=>({path:file.path,...stored.facts.get(file.path)!})).map(({kind,...file})=>file),execution_authorized:false});
  sync(()=>authority.completed(result));guard();return result;
 }
}
