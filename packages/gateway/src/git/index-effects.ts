import {createHash,randomUUID} from 'node:crypto';
import {constants,lstatSync as nativeLstatSync,realpathSync,readdirSync,openSync,closeSync,readFileSync,fstatSync as nativeFstatSync,renameSync,unlinkSync,linkSync,rmdirSync,type BigIntStats} from 'node:fs';
import {open,lstat,mkdir} from 'node:fs/promises';
import {join,dirname,resolve,relative,sep} from 'node:path';
import {GitRepositoryInspection,type GitReviewWitness,type GitReadContext} from './inspection.ts';
import {readGit} from './process.ts';
import {workspaceRelativePath} from '../always-on/workspace-provider.ts';
import {indexEvidence,indexPreparation,type GitIndexEvidence,type GitIndexPreparation} from './index-evidence.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import type {FinalizedWorkNativePlacement} from '../persistent-tasks/finalized-work-sources.ts';
import type {PublicationNativePlacements} from '../persistent-tasks/publication-native-placements.ts';

type Action='stage'|'unstage';
export type GitIndexPlan=Readonly<{plan_id:string;action:Action;paths:readonly string[];repository_sha256:string;before_index_sha256:string|null;index_sha256:string;execution_authorized:false}>;
type Blob={oid:string;bytes:Buffer;sha256:string;write:boolean};
type Lock={path:string;identity:string};
type Stored={witness:GitReviewWitness;index:Buffer;blobs:Blob[];ref:string|null;metadata:string;directories:Map<string,string>;dot:string;rawRefs:Map<string,string|null>;attributes:Map<string,string|null>;mode:number;dispatch?:GitIndexDispatch;owned?:{locks:Lock[];created:Map<string,string>};state:'ready'|'locking'|'consumed'};
export type GitIndexReceipt={plan_id:string;action:Action;repository_sha256:string;before_index_sha256:string|null;index_sha256:string;paths:string[]};
export type GitIndexDispatch={plan_id:string;action:Action;repository_sha256:string;source_sha256:string;index_sha256:string;index_lock_identity:string};
export type GitNativeWorkspaceObservation=Readonly<{session_ref:string;custody:'resident'|'cold'|'absent';cwd:string|null;header_sha256:string|null}>;
type Authority={authorize:(proof?:GitIndexDispatch)=>void;prepared?:(preparation:GitIndexPreparation)=>void;acquire?:(preparation:GitIndexPreparation,install:()=>void)=>void;dispatch?:(evidence:GitIndexEvidence)=>void;cleanup?:(remove:()=>void)=>void;commit:(publish:()=>GitIndexReceipt,proof:GitIndexDispatch)=>GitIndexReceipt};
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const lstatSync=(path:string)=>nativeLstatSync(path,{bigint:true});
const fstatSync=(fd:number)=>nativeFstatSync(fd,{bigint:true});
const id=(value:{dev:bigint;ino:bigint})=>String(value.dev)+':'+String(value.ino);
const stamp=(s:BigIntStats)=>[id(s),s.size,s.mtimeNs,s.ctimeNs,s.nlink,s.mode].join(':');
const equalPath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const decoded=(value:Buffer)=>new TextDecoder('utf-8',{fatal:true}).decode(value);

/** Internal index-effect kernel. Not mounted as a tool or route. A caller must
 * provide original owner/approval fences and the durable dispatch/receipt txn.
 * Temporary metadata computes bytes; only the original index is published. */
export class GitIndexEffects extends GitRepositoryInspection{
 private readonly plans=new WeakMap<GitIndexPlan,Stored>();
 /** Original HOST-PRIVATE source/target association only. It must be retained
  * inside actual native family custody and an original producer lease before
  * any effect. A serialized placement or this check grants no file permission. */
 retainPublicationNativeWorkspaceRoots(raw:FinalizedWorkNativePlacement,input:readonly GitNativeWorkspaceObservation[],rawFamily?:PublicationNativePlacements){
  const invalid=()=>{throw Error('git_publication_native_workspace_association_required');};
  if(!raw||typeof raw!=='object'||!Array.isArray(input)||input.length>256)invalid();
  const placement=structuredClone(raw),{placement_sha256,...facts}=placement;
  if(Object.keys(placement).sort().join(',')!=='completed_checkpoint,execution_authorized,isolated_root,owner_id,placement_sha256,project_id,protocol,record_sha256,session_ref,snapshot_id,source_sha256,storage_root'
   ||placement.protocol!==1||placement.execution_authorized!==false||hash(canonicalJson(facts))!==placement_sha256
   ||!['owner_id','project_id','session_ref','snapshot_id'].every(key=>typeof placement[key as keyof typeof placement]==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(placement[key as keyof typeof placement] as string))
   ||!['source_sha256','record_sha256','placement_sha256'].every(key=>typeof placement[key as keyof typeof placement]==='string'&&/^[a-f0-9]{64}$/.test(placement[key as keyof typeof placement] as string)))invalid();
  const roots=[placement.storage_root,placement.isolated_root];
  for(const root of roots)if(!root||Object.keys(root).sort().join(',')!=='canonical,dev,ino,path'||typeof root.path!=='string'||typeof root.canonical!=='string'
   ||resolve(root.path)!==root.path||resolve(root.canonical)!==root.canonical||![root.dev,root.ino].every(value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,127})$/.test(value)))invalid();
  if(!equalPath(join(placement.storage_root.path,placement.snapshot_id),placement.isolated_root.path))invalid();
  const observations=structuredClone(input),producer=observations.filter(member=>member?.session_ref===placement.session_ref);
  if(producer.length!==1)invalid();const original=producer[0]!;
  if(Object.keys(original).sort().join(',')!=='custody,cwd,header_sha256,session_ref'||!['resident','cold'].includes(original.custody)||typeof original.cwd!=='string'
   ||!equalPath(original.cwd,placement.isolated_root.path)||typeof original.header_sha256!=='string'||!/^[a-f0-9]{64}$/.test(original.header_sha256))invalid();
  let target:()=>void;
  if(rawFamily===undefined){try{target=this.retainNativeWorkspaceRoots(observations.filter(member=>member.session_ref!==placement.session_ref));}catch{invalid();}}
  else{
   const family=structuredClone(rawFamily),{placements_sha256,...familyFacts}=family;
   if(Object.keys(family).sort().join(',')!=='binding_sha256,execution_authorized,family_sha256,members,owner_id,placements_sha256,project_id,protocol'
    ||family.protocol!==1||family.execution_authorized!==false||family.owner_id!==placement.owner_id||family.project_id!==placement.project_id
    ||!['binding_sha256','family_sha256','placements_sha256'].every(key=>typeof family[key as keyof typeof family]==='string'&&/^[a-f0-9]{64}$/.test(family[key as keyof typeof family] as string))
    ||hash(canonicalJson(familyFacts))!==placements_sha256||!Array.isArray(family.members)||family.members.length!==observations.length)invalid();
   const seen=new Set<string>(),ordinary:GitNativeWorkspaceObservation[]=[];
   for(const [index,member] of observations.entries()){
    const expected=family.members[index]!;
    if(!member||Object.keys(member).sort().join(',')!=='custody,cwd,header_sha256,session_ref'||typeof member.session_ref!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(member.session_ref)||seen.has(member.session_ref)
     ||!expected||Object.keys(expected).sort().join(',')!=='evidence_sha256,placement,session_ref'||expected.session_ref!==member.session_ref||typeof expected.evidence_sha256!=='string'||!/^[a-f0-9]{64}$/.test(expected.evidence_sha256))invalid();seen.add(member.session_ref);
    if(member.custody==='absent'){if(member.cwd!==null||member.header_sha256!==null)invalid();}
    else if(!['resident','cold'].includes(member.custody)||typeof member.cwd!=='string'||member.cwd!==resolve(member.cwd)||typeof member.header_sha256!=='string'||!/^[a-f0-9]{64}$/.test(member.header_sha256))invalid();
    if(expected.placement===null){if(member.session_ref===placement.session_ref)invalid();ordinary.push(member);continue;}
    const historical=expected.placement;
    if(!historical||Object.keys(historical).sort().join(',')!=='isolated_root,record_sha256,snapshot_id,storage_root'||typeof historical.snapshot_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(historical.snapshot_id)||typeof historical.record_sha256!=='string'||!/^[a-f0-9]{64}$/.test(historical.record_sha256))invalid();
    for(const root of [historical.storage_root,historical.isolated_root])if(!root||Object.keys(root).sort().join(',')!=='canonical,dev,ino,path'||typeof root.path!=='string'||typeof root.canonical!=='string'
     ||resolve(root.path)!==root.path||resolve(root.canonical)!==root.canonical||![root.dev,root.ino].every(value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,127})$/.test(value)))invalid();
    if(!equalPath(join(historical.storage_root.path,historical.snapshot_id),historical.isolated_root.path))invalid();
    if(member.session_ref===placement.session_ref&&canonicalJson(historical)!==canonicalJson({snapshot_id:placement.snapshot_id,storage_root:placement.storage_root,isolated_root:placement.isolated_root,record_sha256:placement.record_sha256}))invalid();
    // An absent member is fenced by the original native persistence/factory
    // barrier, not a reason to recreate a removed historical snapshot. A live
    // or cold member must retain its exact original physical root identities.
    if(member.custody!=='absent'){if(!equalPath(member.cwd!,historical.isolated_root.path))invalid();roots.push(historical.storage_root,historical.isolated_root);}
   }
   try{target=this.retainNativeWorkspaceRoots(ordinary);}catch{invalid();}
  }
  const check=()=>{try{
   target!();for(const root of roots)if(this.directorySync(root.path)!==root.dev+':'+root.ino||!equalPath(realpathSync(root.path),root.canonical))throw Error();
  }catch{throw Error('git_publication_native_workspace_changed');}};
  check();return check;
 }
 /** Host-only root association, not execution authority. The original caller
  * must retain actual native custody and recheck these physical identities. */
 retainNativeWorkspaceRoots(input:readonly GitNativeWorkspaceObservation[]){
  if(!Array.isArray(input)||input.length>256)throw Error('git_native_workspace_association_required');
  const seen=new Set<string>(),paths:string[]=[];
  for(const member of input){
   if(!member||Object.keys(member).sort().join(',')!=='custody,cwd,header_sha256,session_ref'||typeof member.session_ref!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(member.session_ref)||seen.has(member.session_ref))throw Error('git_native_workspace_association_required');seen.add(member.session_ref);
   if(member.custody==='absent'){if(member.cwd!==null||member.header_sha256!==null)throw Error('git_native_workspace_association_required');continue;}
   if(!['resident','cold'].includes(member.custody)||typeof member.cwd!=='string'||!member.cwd||member.cwd.includes('\0')||typeof member.header_sha256!=='string'||!/^[a-f0-9]{64}$/.test(member.header_sha256)
    ||!equalPath(resolve(member.cwd),this.root)||!equalPath(member.cwd,resolve(member.cwd)))throw Error('git_native_workspace_association_required');
   paths.push(member.cwd);
  }
  const rootIdentity=this.directorySync(this.root);
  const check=()=>{try{if(this.directorySync(this.root)!==rootIdentity||paths.some(path=>this.directorySync(path)!==rootIdentity))throw Error();}catch{throw Error('git_native_workspace_changed');}};
  check();return check;
 }
 private cleanupAtomically(remove:()=>void,atomic?:((remove:()=>void)=>void)){
  let called=false,active=true;const apply=()=>{if(!active||called)throw Error('git_index_cleanup_invalid');called=true;remove();};
  try{if(atomic){if(atomic.constructor.name==='AsyncFunction')throw Error('git_execution_authority_missing');const result=atomic(apply) as unknown;if(result&&typeof(result as {then?:unknown}).then==='function')throw Error('git_execution_authority_missing');}else apply();if(!called)throw Error('git_execution_authority_missing');}finally{active=false;}
 }
 private directorySync(path:string){let current=path;while(true){const s=lstatSync(current);if(!s.isDirectory()||s.isSymbolicLink())throw Error('git_repository_changed');const parent=dirname(current);if(parent===current)break;current=parent;}if(!equalPath(realpathSync(path),path))throw Error('git_repository_changed');return id(lstatSync(path));}
 private raw(path:string,max=32*1024*1024,links=1):Buffer|null{
  try{this.directorySync(dirname(path));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}let before;try{before=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==BigInt(links)||before.size>max)throw Error('git_path_unavailable');
  const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{if(stamp(fstatSync(fd))!==stamp(before))throw Error('git_review_changed');const value=readFileSync(fd);if(value.length>max||stamp(fstatSync(fd))!==stamp(before)||stamp(lstatSync(path))!==stamp(before))throw Error('git_review_changed');return value;}finally{closeSync(fd);}
 }
 private dotWitness(){const dot=join(this.root,'.git'),s=lstatSync(dot);if(s.isSymbolicLink())throw Error('git_repository_changed');return s.isDirectory()?'directory:'+id(s):'file:'+hash(this.raw(dot,4096)!);}
 /** Keep every non-object metadata file pinned. Ignore only exact owned locks
  * and newly created lock-parent directories; directory identities still hold.
  * Content-addressed object bytes are checked separately, never treated as refs. */
 protected sourceMetadata(locks:ReadonlySet<string>=new Set(),created:ReadonlySet<string>=new Set()){
  const facts:string[]=[];let entries=0;const objects=join(this.commonDirectory,'objects');
  for(const root of [...new Set([this.gitDirectory,this.commonDirectory])]){const queue=[root];while(queue.length){const folder=queue.pop()!;for(const entry of readdirSync(folder,{withFileTypes:true})){if(++entries>100000)throw Error('git_metadata_limit');const path=join(folder,entry.name);if(locks.has(path)||equalPath(path,objects))continue;const s=lstatSync(path);if(s.isSymbolicLink()||!s.isFile()&&!s.isDirectory())throw Error('git_repository_changed');if(s.isDirectory()){if(!created.has(path))facts.push(path+':dir:'+id(s)+':'+s.mode);queue.push(path);}else facts.push(path+':file:'+stamp(s));}}}
  return hash(facts.sort().join('\n'));
 }
 private async controlled(context:GitReadContext,args:string[],input?:Buffer,signal?:AbortSignal,sourceObjects=false){
  const objects=join(this.commonDirectory,'objects'),result=await readGit(this.executable!,this.root,context.directory,args,{maxOutputBytes:32*1024*1024,timeoutMs:5000},signal,sourceObjects?objects:join(context.directory,'objects'),input,sourceObjects?undefined:objects);
  if(result.code!==0)throw Error('git_index_prepare_failed');return result.bytes;
 }
 async prepareIndex(input:GitReviewWitness,action:Action,signal?:AbortSignal):Promise<GitIndexPlan>{
  if(!input||input.protocol!==2||!Array.isArray(input.attributes)||!['stage','unstage'].includes(action))throw Error('git_index_plan_invalid');const witness=structuredClone(input),paths=witness.files.map(file=>file.path);
  if(JSON.stringify(await this.freeze(witness.snapshot_id,paths,signal))!==JSON.stringify(witness))throw Error('git_review_changed');
  const context=await this.context(signal);try{
   const snapshot=await this.inspectContext(context,signal);if(snapshot.snapshot_id!==witness.snapshot_id)throw Error('git_review_changed');
   const refResult=await this.run(context,['symbolic-ref','--quiet','HEAD'],signal,true),ref=refResult.code===1?null:decoded(refResult.bytes).trim();if(ref!==null&&(!ref.startsWith('refs/heads/')||workspaceRelativePath(ref)!==ref))throw Error('git_index_reference_unsupported');
   const rawRefs=new Map<string,string|null>();for(const path of [join(this.gitDirectory,'HEAD'),join(this.commonDirectory,'packed-refs'),...(ref?[join(this.commonDirectory,ref)]:[])]){const value=this.raw(path);rawRefs.set(path,value===null?null:hash(value));}
   const directories=new Map<string,string>();for(const path of [...new Set([this.root,this.gitDirectory,this.commonDirectory,join(this.commonDirectory,'objects')])])directories.set(path,await this.directory(path));
   const metadata=this.sourceMetadata(),dot=this.dotWitness(),blobs:Blob[]=[],attributes=new Map<string,string|null>();let total=0;
   for(const path of paths){let folder=dirname(join(this.root,path));while(true){const attribute=join(folder,'.gitattributes'),value=this.raw(attribute,1024*1024);attributes.set(attribute,value===null?null:hash(value));if(equalPath(folder,this.root))break;const parent=dirname(folder);if(parent===folder||relative(this.root,parent).startsWith('..'))throw Error('git_repository_changed');folder=parent;}}
   const remember=(oid:string,bytes:Buffer,write:boolean)=>{if(createHash(oid.length===64?'sha256':'sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')!==oid)throw Error('git_index_object_mismatch');if(!blobs.some(blob=>blob.oid===oid)){total+=bytes.length;if(total>64*1024*1024)throw Error('git_output_limit');blobs.push({oid,bytes,sha256:hash(bytes),write});}};
   await this.controlled(context,['update-index','--no-split-index'],undefined,signal);
   const modeResult=await this.run(context,['config','--bool','--get','core.filemode'],signal,true),filemode=modeResult.code===1||decoded(modeResult.bytes).trim()!=='false';
   for(const path of paths){
    const entry=snapshot.entries.find(row=>row.path===path);if(!entry||entry.conflicted)throw Error('git_selection_invalid');
    if(action==='unstage'&&entry.original_path&&!paths.includes(entry.original_path))throw Error('git_rename_review_incomplete');
    if(action==='stage'){
     if(entry.worktree_status===' ')throw Error('git_selection_invalid');
     const selected=witness.files.find(file=>file.path===path)!;
     if(selected.kind==='missing'){await this.controlled(context,['update-index','--force-remove','--',path],undefined,signal);continue;}
     const attributes=decoded(await this.run(context,['check-attr','-z','filter','--',path],signal).then(result=>result.bytes)).split('\0');if(!['unspecified','unset'].includes(attributes[2]??''))throw Error('git_filter_requires_explicit_support');
     const raw=this.raw(join(this.root,path));if(raw===null||hash(raw)!==selected.sha256)throw Error('git_review_changed');
     const oid=decoded(await this.controlled(context,['hash-object','-w','--stdin','--path='+path],raw,signal)).trim();if(!/^[a-f0-9]{40,64}$/.test(oid))throw Error('git_index_prepare_failed');
     const canonical=await this.controlled(context,['cat-file','blob',oid],undefined,signal);remember(oid,canonical,true);
     const current=decoded((await this.run(context,['ls-files','--stage','-z','--',path],signal)).bytes),old=/^(100644|100755) /.exec(current)?.[1],mode=filemode?(selected.mode&0o111?'100755':'100644'):(old??'100644');
     await this.controlled(context,['update-index','--add','--cacheinfo',mode+','+oid+','+path],undefined,signal);
    }else{
     if([' ','?'].includes(entry.index_status))throw Error('git_selection_invalid');
     const original=witness.head.oid===null?'':decoded((await this.run(context,['ls-tree','-z',witness.head.oid,'--',path],signal)).bytes),match=/^(100644|100755|120000) blob ([a-f0-9]{40,64})\t/.exec(original);
     if(original&&!match)throw Error('git_index_entry_unsupported');
     if(match){const oid=match[2]!;remember(oid,await this.controlled(context,['cat-file','blob',oid],undefined,signal),false);await this.controlled(context,['update-index','--add','--cacheinfo',match[1]+','+oid+','+path],undefined,signal);}else await this.controlled(context,['update-index','--force-remove','--',path],undefined,signal);
    }
   }
   const index=await this.bytes(join(context.directory,'index'),32*1024*1024);if(this.sourceMetadata()!==metadata||JSON.stringify(await this.freeze(witness.snapshot_id,paths,signal))!==JSON.stringify(witness))throw Error('git_review_changed');
   const plan=Object.freeze({plan_id:'git-index-'+randomUUID(),action,paths:Object.freeze([...paths]),repository_sha256:witness.repository_sha256,before_index_sha256:witness.index_sha256,index_sha256:hash(index),execution_authorized:false as const});
   let mode=0o600;try{mode=Number(lstatSync(join(this.gitDirectory,'index')).mode&0o777n);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   for(const [path,expected] of attributes){const value=this.raw(path,1024*1024);if((value===null?null:hash(value))!==expected)throw Error('git_review_changed');}
   this.plans.set(plan,{witness,index,blobs,ref,metadata,directories,dot,rawRefs,attributes,mode,state:'ready'});return plan;
  }finally{await context.dispose();}
 }
 private assertSource(stored:Stored,locks:Lock[],created:Map<string,string>,indexPath=join(this.gitDirectory,'index.lock')){
  for(const [path,identity] of stored.directories)if(this.directorySync(path)!==identity)throw Error('git_repository_changed');if(this.dotWitness()!==stored.dot)throw Error('git_repository_changed');
  for(const [path,identity] of created)if(this.directorySync(path)!==identity)throw Error('git_repository_changed');
  for(const lock of locks){const s=lstatSync(lock.path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||id(s)!==lock.identity)throw Error('git_repository_changed');const bytes=this.raw(lock.path);if(bytes===null||hash(bytes)!==(equalPath(lock.path,indexPath)?hash(stored.index):hash(Buffer.alloc(0))))throw Error('git_review_changed');}
  const lockedIndex=this.raw(indexPath);if(lockedIndex===null||hash(lockedIndex)!==hash(stored.index))throw Error('git_review_changed');
  if(this.sourceMetadata(new Set(locks.map(lock=>lock.path)),new Set(created.keys()))!==stored.metadata)throw Error('git_review_changed');
  for(const [path,expected] of stored.rawRefs){const value=this.raw(path);if((value===null?null:hash(value))!==expected)throw Error('git_review_changed');}
  for(const [path,expected] of stored.attributes){const value=this.raw(path,1024*1024);if((value===null?null:hash(value))!==expected)throw Error('git_review_changed');}
  const index=this.raw(join(this.gitDirectory,'index'));if((index===null?null:hash(index))!==stored.witness.index_sha256)throw Error('git_review_changed');
  const alternates=this.raw(join(this.commonDirectory,'objects','info','alternates'),1024*1024);if(alternates?.length)throw Error('git_repository_changed');
  for(const selected of stored.witness.files){const value=this.raw(join(this.root,selected.path));if(selected.kind==='missing'){if(value!==null)throw Error('git_review_changed');}else if(value===null||hash(value)!==selected.sha256||Number(lstatSync(join(this.root,selected.path)).mode&0o777n)!==selected.mode)throw Error('git_review_changed');}
 }
 private async parent(path:string,created:Map<string,string>){
  const base=this.commonDirectory,rel=relative(base,path);if(rel.startsWith('..')||resolve(base,rel)!==path)throw Error('git_repository_changed');let current=base;
  for(const part of rel.split(sep).filter(Boolean)){current=join(current,part);try{await this.directory(current);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;try{await mkdir(current,{mode:0o700});created.set(current,await this.directory(current));}catch(next){if((next as NodeJS.ErrnoException).code!=='EEXIST')throw next;await this.directory(current);}}}
 }
 private evidence(plan:GitIndexPlan,stored:Stored):GitIndexEvidence{
  if(!stored.dispatch||!stored.owned)throw Error('git_index_evidence_invalid');
  return indexEvidence({protocol:1,plan,source_sha256:hash(JSON.stringify(stored.witness)),index_lock_identity:stored.dispatch.index_lock_identity,
   directories:{root:stored.directories.get(this.root),git:stored.directories.get(this.gitDirectory),common:stored.directories.get(this.commonDirectory),objects:stored.directories.get(join(this.commonDirectory,'objects'))},dot_witness:stored.dot,
   refs:{ref:stored.ref,head_sha256:stored.rawRefs.get(join(this.gitDirectory,'HEAD')),packed_sha256:stored.rawRefs.get(join(this.commonDirectory,'packed-refs')),branch_sha256:stored.ref?stored.rawRefs.get(join(this.commonDirectory,stored.ref)):null},
   blobs:stored.blobs.map(blob=>({oid:blob.oid,sha256:blob.sha256,size:blob.bytes.length})),
   locks:stored.owned.locks.map(lock=>{const scope=equalPath(lock.path,join(this.gitDirectory,'index.lock'))||equalPath(lock.path,join(this.gitDirectory,'HEAD.lock'))?'git':'common';return{scope,path:relative(scope==='git'?this.gitDirectory:this.commonDirectory,lock.path).split(sep).join('/'),identity:lock.identity,sha256:scope==='git'&&equalPath(lock.path,join(this.gitDirectory,'index.lock'))?plan.index_sha256:hash(Buffer.alloc(0))};}),
   parents:[...stored.owned.created].map(([path,identity])=>({path:relative(this.commonDirectory,path).split(sep).join('/'),identity}))});
 }
 async applyIndex(plan:GitIndexPlan,authority:Authority,signal?:AbortSignal):Promise<GitIndexReceipt>{
  const stored=this.plans.get(plan);if(!stored)throw Error('git_index_plan_invalid');if(stored.state!=='ready')throw Error('git_index_plan_consumed');
  if(!authority||typeof authority.authorize!=='function'||typeof authority.commit!=='function'||authority.commit.constructor.name==='AsyncFunction')throw Error('git_execution_authority_missing');
  signal?.throwIfAborted();stored.state='locking';const locks:Lock[]=[],pending:Lock[]=[],created=new Map<string,string>();let context:GitReadContext|undefined,published=false,failure:unknown;
  try{
   if((await this.anchors(signal)).repository!==plan.repository_sha256)throw Error('git_repository_changed');
   const targets=[join(this.gitDirectory,'index.lock'),join(this.gitDirectory,'HEAD.lock'),join(this.commonDirectory,'packed-refs.lock'),...(stored.ref?[join(this.commonDirectory,stored.ref+'.lock')]:[])];
   // Fail before scratch creation if a conventional Git lock already exists.
   for(const path of targets)try{lstatSync(path);throw Error('git_repository_busy');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   for(const path of targets){
    signal?.throwIfAborted();if(stored.ref&&equalPath(path,join(this.commonDirectory,stored.ref+'.lock')))await this.parent(dirname(path),created);
    const base=equalPath(path,targets[0]!)||equalPath(path,targets[1]!)?this.gitDirectory:this.commonDirectory,scratch=join(base,'jot-index-lock-'+randomUUID()+'.pending');
    const handle=await open(scratch,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),stored.mode);
    try{const s=await handle.stat({bigint:true});pending.push({path:scratch,identity:id(s)});if(equalPath(path,targets[0]!))await handle.writeFile(stored.index);await handle.sync();}finally{await handle.close();}
   }
   this.assertSource(stored,pending,created,pending[0]!.path);
   stored.dispatch={plan_id:plan.plan_id,action:plan.action,repository_sha256:plan.repository_sha256,source_sha256:hash(JSON.stringify(stored.witness)),index_sha256:plan.index_sha256,index_lock_identity:pending[0]!.identity};
   stored.owned={locks:targets.map((path,i)=>({path,identity:pending[i]!.identity})),created:new Map(created)};
   const preparation=indexPreparation({protocol:1,evidence:this.evidence(plan,stored),pending:pending.map((file,i)=>{const target=stored.owned!.locks[i]!,scope=i<2?'git':'common';return{scope,target:relative(scope==='git'?this.gitDirectory:this.commonDirectory,target.path).split(sep).join('/'),path:relative(scope==='git'?this.gitDirectory:this.commonDirectory,file.path),identity:file.identity,sha256:i===0?plan.index_sha256:hash(Buffer.alloc(0))};})});
   const synchronous=(fn:Function|undefined,...args:unknown[])=>{if(!fn)return;if(fn.constructor.name==='AsyncFunction')throw Error('git_execution_authority_missing');const result=fn(...args);if(result&&typeof result.then==='function')throw Error('git_execution_authority_missing');};
   authority.authorize(stored.dispatch);synchronous(authority.prepared,preparation);
   let installed=false;
   const install=()=>{
    if(installed)throw Error('git_index_plan_consumed');installed=true;signal?.throwIfAborted();authority.authorize(stored.dispatch);this.assertSource(stored,pending,created,pending[0]!.path);
    for(let i=0;i<targets.length;i++){
     signal?.throwIfAborted();authority.authorize(stored.dispatch);const file=pending[i]!,path=targets[i]!;
     this.directorySync(dirname(path));
     // Exclusive hard link preserves the already-journaled inode; rename could
     // overwrite another writer, and a copy would produce an unproven inode.
     try{linkSync(file.path,path);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('git_repository_busy');throw error;}
     locks.push({path,identity:file.identity});unlinkSync(file.path);
    }
   };
   if(authority.acquire)synchronous(authority.acquire,preparation,install);else install();
   if(!installed)throw Error('git_execution_authority_missing');
   this.assertSource(stored,locks,created);const proof:GitIndexDispatch={plan_id:plan.plan_id,action:plan.action,repository_sha256:plan.repository_sha256,source_sha256:hash(JSON.stringify(stored.witness)),index_sha256:plan.index_sha256,index_lock_identity:locks.find(lock=>equalPath(lock.path,join(this.gitDirectory,'index.lock')))!.identity};authority.authorize(proof);stored.dispatch=proof;
   stored.owned={locks:locks.map(lock=>({...lock})),created:new Map(created)};
   if(authority.dispatch){if(authority.dispatch.constructor.name==='AsyncFunction')throw Error('git_execution_authority_missing');const result=authority.dispatch(this.evidence(plan,stored)) as unknown;if(result&&typeof (result as {then?:unknown}).then==='function')throw Error('git_index_dispatch_invalid');}
   context=await this.context(signal);
   for(const blob of stored.blobs){signal?.throwIfAborted();authority.authorize(proof);if(blob.write){stored.state='consumed';const oid=decoded(await this.controlled(context,['hash-object','-w','--stdin','--no-filters'],blob.bytes,signal,true)).trim();if(oid!==blob.oid)throw Error('git_index_object_mismatch');}const actual=await this.controlled(context,['cat-file','blob',blob.oid],undefined,signal,true);if(hash(actual)!==blob.sha256)throw Error('git_index_object_mismatch');}
   this.assertSource(stored,locks,created);signal?.throwIfAborted();
   const result=authority.commit(()=>{
    if(published)throw Error('git_index_plan_consumed');signal?.throwIfAborted();authority.authorize(proof);this.assertSource(stored,locks,created);
    stored.state='consumed';renameSync(join(this.gitDirectory,'index.lock'),join(this.gitDirectory,'index'));published=true;
    if(hash(this.raw(join(this.gitDirectory,'index'))!)!==plan.index_sha256)throw Error('git_index_outcome_unknown');
    return{plan_id:plan.plan_id,action:plan.action,repository_sha256:plan.repository_sha256,before_index_sha256:plan.before_index_sha256,index_sha256:plan.index_sha256,paths:[...plan.paths]};
   },proof);if(!published||result&&typeof (result as unknown as {then?:unknown}).then==='function')throw Error('git_index_commit_invalid');return result;
  }catch(error){failure=error;throw error;}finally{
   if(stored.state==='locking')stored.state='ready';const failures:unknown[]=[];try{await context?.dispose();}catch(error){failures.push(error);}
   let cleanupStarted=false;try{this.cleanupAtomically(()=>{cleanupStarted=true;
   for(const lock of [...locks,...pending].reverse()){try{const s=lstatSync(lock.path),known=[...locks,...pending].filter(file=>file.identity===lock.identity).filter(file=>{try{return id(lstatSync(file.path))===lock.identity;}catch{return false;}}).length,expected=lock.identity===pending[0]?.identity?hash(stored.index):hash(Buffer.alloc(0));if(!s.isFile()||s.isSymbolicLink()||s.nlink!==BigInt(known)||id(s)!==lock.identity)throw Error('git_index_lock_unverified');const bytes=this.raw(lock.path,32*1024*1024,known);if(bytes===null||hash(bytes)!==expected)throw Error('git_index_lock_unverified');unlinkSync(lock.path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')failures.push(error);}}
   for(const [path,identity] of [...created].reverse())try{if(this.directorySync(path)===identity)rmdirSync(path);}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes((error as NodeJS.ErrnoException).code??''))failures.push(error);}if(failures.length)throw Error('git_index_cleanup_unknown',{cause:failure});
   },authority.cleanup);}catch(error){if(!cleanupStarted&&failure)throw failure;throw error;}
  }
 }
 async observeIndex(plan:GitIndexPlan,signal?:AbortSignal){
  const stored=this.plans.get(plan);if(!stored)throw Error('git_index_plan_invalid');
  if(stored.dispatch)return this.observeEvidence(this.evidence(plan,stored),signal);
  if((await this.anchors(signal)).repository!==plan.repository_sha256)throw Error('git_repository_changed');const bytes=this.raw(join(this.gitDirectory,'index')),current=bytes===null?null:hash(bytes);return{state:current===plan.before_index_sha256?'not_observed':'unknown',index_sha256:current,execution_authorized:false as const};
 }
 /** Rebuild observation only. Persisted JSON can never become a writable plan. */
 async observeEvidence(input:unknown,signal?:AbortSignal){
  const evidence=indexEvidence(input),plan=evidence.plan;
  if((await this.anchors(signal)).repository!==plan.repository_sha256)throw Error('git_repository_changed');
  for(const [path,expected] of [[this.root,evidence.directories.root],[this.gitDirectory,evidence.directories.git],[this.commonDirectory,evidence.directories.common],[join(this.commonDirectory,'objects'),evidence.directories.objects]])if(this.directorySync(path!)!==expected)throw Error('git_repository_changed');if(this.dotWitness()!==evidence.dot_witness)throw Error('git_repository_changed');
  const bytes=this.raw(join(this.gitDirectory,'index')),current=bytes===null?null:hash(bytes),result=(state:'applied'|'not_observed'|'unknown')=>({state,index_sha256:current,execution_authorized:false as const});
  if(current!==plan.index_sha256)return result(current===plan.before_index_sha256?'not_observed':'unknown');
  if(id(lstatSync(join(this.gitDirectory,'index')))!==evidence.index_lock_identity)return result('unknown');
  for(const [path,expected] of [[join(this.gitDirectory,'HEAD'),evidence.refs.head_sha256],[join(this.commonDirectory,'packed-refs'),evidence.refs.packed_sha256],...(evidence.refs.ref?[[join(this.commonDirectory,evidence.refs.ref),evidence.refs.branch_sha256]]:[])] as Array<[string,string|null]>){const value=this.raw(path);if((value===null?null:hash(value))!==expected)return result('unknown');}
  const context=await this.context(signal);try{for(const blob of evidence.blobs){let actual:Buffer;try{actual=await this.controlled(context,['cat-file','blob',blob.oid],undefined,signal,true);}catch{signal?.throwIfAborted();return result('unknown');}if(actual.length!==blob.size||hash(actual)!==blob.sha256)return result('unknown');}const after=this.raw(join(this.gitDirectory,'index'));return result(after!==null&&hash(after)===current&&id(lstatSync(join(this.gitDirectory,'index')))===evidence.index_lock_identity?'applied':'unknown');}finally{await context.dispose();}
 }
 /** Trusted original recovery must fence the prior Worker before calling this.
  * Only exact persisted owned files are removable; no timestamp-based cleanup. */
 async cleanupPreparation(input:unknown,guard:()=>void,signal?:AbortSignal,atomic?:((remove:()=>void)=>void)){
  const preparation=indexPreparation(input),evidence=preparation.evidence;
  if(typeof guard!=='function'||guard.constructor.name==='AsyncFunction')throw Error('git_execution_authority_missing');
  const check=()=>{signal?.throwIfAborted();const result=guard() as unknown;if(result&&typeof(result as {then?:unknown}).then==='function')throw Error('git_execution_authority_missing');for(const [path,expected] of [[this.root,evidence.directories.root],[this.gitDirectory,evidence.directories.git],[this.commonDirectory,evidence.directories.common],[join(this.commonDirectory,'objects'),evidence.directories.objects]])if(this.directorySync(path!)!==expected)throw Error('git_repository_changed');if(this.dotWitness()!==evidence.dot_witness)throw Error('git_repository_changed');};
  check();if((await this.anchors(signal)).repository!==evidence.plan.repository_sha256)throw Error('git_repository_changed');check();
  const groups=preparation.pending.map(file=>({file,paths:[join(file.scope==='git'?this.gitDirectory:this.commonDirectory,file.path),join(file.scope==='git'?this.gitDirectory:this.commonDirectory,file.target)]}));
  const verify=(group:typeof groups[number])=>{
   const present:string[]=[];
   for(const path of group.paths){let stat;try{stat=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    if(!stat.isFile()||stat.isSymbolicLink()||id(stat)!==group.file.identity)throw Error('git_index_lock_unverified');present.push(path);
   }
   for(const path of present){const bytes=this.raw(path,32*1024*1024,present.length);if(bytes===null||hash(bytes)!==group.file.sha256)throw Error('git_index_lock_unverified');}
   return present;
  };
  // Check all pairs before deleting any. A third unknown hard link, changed
  // bytes or foreign conventional lock is never an owned cleanup target.
  this.cleanupAtomically(()=>{
  for(const group of groups){check();verify(group);}
  for(const group of groups.reverse())for(const path of verify(group)){check();if(!verify(group).includes(path))continue;unlinkSync(path);}
  for(const parent of [...evidence.parents].reverse()){check();const path=join(this.commonDirectory,parent.path);try{if(this.directorySync(path)!==parent.identity)throw Error('git_index_lock_unverified');rmdirSync(path);}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes((error as NodeJS.ErrnoException).code??''))throw error;}}
  },atomic);
 }
 async cleanupEvidence(input:unknown,guard:()=>void,signal?:AbortSignal,atomic?:((remove:()=>void)=>void)){
  const evidence=indexEvidence(input);if(typeof guard!=='function'||guard.constructor.name==='AsyncFunction')throw Error('git_execution_authority_missing');
  const check=()=>{signal?.throwIfAborted();const value=guard() as unknown;if(value&&typeof(value as {then?:unknown}).then==='function')throw Error('git_execution_authority_missing');for(const [path,expected] of [[this.root,evidence.directories.root],[this.gitDirectory,evidence.directories.git],[this.commonDirectory,evidence.directories.common],[join(this.commonDirectory,'objects'),evidence.directories.objects]])if(this.directorySync(path!)!==expected)throw Error('git_repository_changed');if(this.dotWitness()!==evidence.dot_witness)throw Error('git_repository_changed');};
  check();if((await this.anchors(signal)).repository!==evidence.plan.repository_sha256)throw Error('git_repository_changed');check();
  this.cleanupAtomically(()=>{
  for(const lock of [...evidence.locks].reverse()){check();const path=join(lock.scope==='git'?this.gitDirectory:this.commonDirectory,lock.path),bytes=this.raw(path);if(bytes===null)continue;const s=lstatSync(path);if(id(s)!==lock.identity||hash(bytes)!==lock.sha256)throw Error('git_index_lock_unverified');unlinkSync(path);}
  for(const parent of [...evidence.parents].reverse()){check();const path=join(this.commonDirectory,parent.path);try{if(this.directorySync(path)!==parent.identity)throw Error('git_index_lock_unverified');rmdirSync(path);}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes((error as NodeJS.ErrnoException).code??''))throw error;}}
  },atomic);
 }
}
