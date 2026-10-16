import {randomUUID,createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,realpath,readdir,mkdir,open} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute,sep,join,parse} from 'node:path';
import type {BigIntStats} from 'node:fs';
import {canonicalJson} from '../db/canonical-json.ts';
import {workspaceRelativePath,workspaceSelection,validateWorkspaceManifest,workspaceManifestHash,type WorkspaceProvider,type SnapshotWorkspaceInput,type WorkspaceSnapshot,type WorkspaceManifestEntry,type WorkspaceGuard,type WorkspaceInspectionInput,type WorkspaceInspection} from './workspace-provider.ts';

type Limits={max_entries:number;max_total_bytes:number;max_file_bytes:number;max_depth:number};
type Root={path:string;canonical:string;dev:bigint;ino:bigint};
type Entry={path:string;kind:'file'|'directory';stat:BigIntStats;canonical:string};
type Issued={root:Root;paths:readonly string[];selection:Map<string,'file'|'directory'>;limits:Limits;receipt:string};
const defaults:Limits={max_entries:50000,max_total_bytes:2*1024**3,max_file_bytes:1024**3,max_depth:100};
const failure=(code:string)=>Error(code);
function limitsOf(value:SnapshotWorkspaceInput['limits']):Limits{
 if(value!==undefined&&(!value||typeof value!=='object'||Object.keys(value).some(k=>!Object.hasOwn(defaults,k))))throw failure('workspace_limit_invalid');
 const result={...defaults,...value};for(const n of Object.values(result))if(!Number.isSafeInteger(n)||n<1)throw failure('workspace_limit_invalid');if(result.max_entries>100000)throw failure('workspace_limit_invalid');return result;
}
function metadata(s:BigIntStats){return [s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');}
function inside(a:string,b:string){const rel=relative(a,b);return rel===''||rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);}
async function safe(path:string){let current=resolve(path);for(;;){const stat=await lstat(current,{bigint:true});if(stat.isSymbolicLink())throw failure('workspace_path_unsafe');const parent=dirname(current);if(parent===current)break;current=parent;}return resolve(path);}
async function rootOf(value:string):Promise<Root>{if(typeof value!=='string'||!isAbsolute(value)||resolve(value)===parse(resolve(value)).root)throw failure('workspace_root_invalid');const path=await safe(value),stat=await lstat(path,{bigint:true});if(!stat.isDirectory())throw failure('workspace_root_invalid');return {path,canonical:await realpath(path),dev:stat.dev,ino:stat.ino};}
async function assertRoot(root:Root){await safe(root.path);const stat=await lstat(root.path,{bigint:true});if(!stat.isDirectory()||stat.dev!==root.dev||stat.ino!==root.ino||await realpath(root.path)!==root.canonical)throw failure('workspace_root_changed');}
async function entryOf(root:Root,path:string):Promise<Entry>{workspaceRelativePath(path);await assertRoot(root);const absolute=join(root.path,...path.split('/'));await safe(absolute);const stat=await lstat(absolute,{bigint:true}),canonical=await realpath(absolute);if(!inside(root.canonical,canonical)||!stat.isFile()&&!stat.isDirectory()||stat.isFile()&&stat.nlink!==1n)throw failure('workspace_path_unsafe');return {path,kind:stat.isDirectory()?'directory':'file',stat,canonical};}
function same(a:Entry,b:Entry){return a.path===b.path&&a.kind===b.kind&&a.canonical===b.canonical&&metadata(a.stat)===metadata(b.stat);}
function key(path:string){return path.normalize('NFC').toLowerCase();}
async function check(guard:WorkspaceGuard,signal:AbortSignal,phase:Parameters<WorkspaceGuard>[0]['phase'],snapshot_id:string,relative_path:string|null){
 if(signal.aborted)throw failure('workspace_cancelled');try{await guard(Object.freeze({phase,snapshot_id,relative_path,execution_authorized:false}));}catch{throw failure('workspace_guard_rejected');}if(signal.aborted)throw failure('workspace_cancelled');
}
function controls(guard:WorkspaceGuard,signal:AbortSignal){if(typeof guard!=='function'||!(signal instanceof AbortSignal))throw failure('workspace_controls_required');}
async function inventory(root:Root,paths:readonly string[],limits:Limits,guard:WorkspaceGuard,signal:AbortSignal,id:string,selection?:Map<string,'file'|'directory'>):Promise<Entry[]>{
 const values=new Map<string,Entry>(),folded=new Map<string,string>();let bytes=0;
 const add=async(path:string,recurse:boolean)=>{
  await check(guard,signal,'prepare',id,path);if(path.split('/').length>limits.max_depth)throw failure('workspace_limit');
  const collision=folded.get(key(path));if(collision&&collision!==path)throw failure('workspace_path_collision');if(values.has(path))return;
  const entry=await entryOf(root,path);if(selection&&paths.some(p=>p.startsWith(path+'/'))&&entry.kind!=='directory')throw failure('workspace_scope_changed');values.set(path,entry);folded.set(key(path),path);if(values.size>limits.max_entries)throw failure('workspace_limit');
  if(entry.kind==='file'){const n=Number(entry.stat.size);if(!Number.isSafeInteger(n)||n>limits.max_file_bytes||(bytes+=n)>limits.max_total_bytes)throw failure('workspace_limit');}
  else if(recurse)for(const child of (await readdir(join(root.path,...path.split('/')))).sort())await add(path+'/'+child,true);
 };
 if(selection){
  const allowed=(path:string)=>paths.some(p=>path===p||p.startsWith(path+'/')||selection.get(p)==='directory'&&path.startsWith(p+'/'));
  const walk=async(prefix:string)=>{for(const name of (await readdir(prefix?join(root.path,...prefix.split('/')):root.path)).sort()){const path=prefix?prefix+'/'+name:name;if(!allowed(path))throw failure('workspace_scope_changed');await add(path,false);if(values.get(path)?.kind==='directory')await walk(path);}};await assertRoot(root);await walk('');
 }else for(const path of paths){const parts=path.split('/');for(let n=1;n<parts.length;n++)await add(parts.slice(0,n).join('/'),false);await add(path,true);}
 return [...values.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
function identities(entries:Entry[]){return canonicalJson(entries.map(e=>({path:e.path,kind:e.kind,canonical:e.canonical,metadata:metadata(e.stat)})));}
async function hashFile(root:Root,entry:Entry,guard:WorkspaceGuard,signal:AbortSignal,id:string):Promise<string>{
 if(!same(entry,await entryOf(root,entry.path)))throw failure('workspace_source_changed');const handle=await open(entry.canonical,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{if(metadata(await handle.stat({bigint:true}))!==metadata(entry.stat))throw failure('workspace_source_changed');const hash=createHash('sha256');let bytes=0;
  for await(const chunk of handle.createReadStream({autoClose:false,highWaterMark:65536,signal})){await check(guard,signal,'verify',id,entry.path);hash.update(chunk);bytes+=chunk.length;}
  if(bytes!==Number(entry.stat.size)||metadata(await handle.stat({bigint:true}))!==metadata(entry.stat)||!same(entry,await entryOf(root,entry.path)))throw failure('workspace_source_changed');return hash.digest('hex');
 }finally{await handle.close();}
}
async function copyFile(source:Root,target:Root,entry:Entry,guard:WorkspaceGuard,signal:AbortSignal,id:string):Promise<WorkspaceManifestEntry>{
 await check(guard,signal,'copy',id,entry.path);if(!same(entry,await entryOf(source,entry.path)))throw failure('workspace_source_changed');await assertRoot(target);
 const destination=join(target.path,...entry.path.split('/'));await safe(dirname(destination));const sourceHandle=await open(entry.canonical,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let targetHandle;
 try{if(metadata(await sourceHandle.stat({bigint:true}))!==metadata(entry.stat))throw failure('workspace_source_changed');const executable=!!(entry.stat.mode&0o100n);targetHandle=await open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),executable?0o700:0o600);
  const hash=createHash('sha256');let bytes=0;
  for await(const chunk of sourceHandle.createReadStream({autoClose:false,highWaterMark:65536,signal})){await check(guard,signal,'copy',id,entry.path);hash.update(chunk);bytes+=chunk.length;if(bytes>Number(entry.stat.size))throw failure('workspace_source_changed');let offset=0;while(offset<chunk.length){const written=await targetHandle.write(chunk,offset,chunk.length-offset);if(!written.bytesWritten)throw failure('workspace_copy_failed');offset+=written.bytesWritten;}}
  await targetHandle.sync();if(bytes!==Number(entry.stat.size)||metadata(await sourceHandle.stat({bigint:true}))!==metadata(entry.stat)||!same(entry,await entryOf(source,entry.path)))throw failure('workspace_source_changed');
  return {path:entry.path,kind:'file',sha256:hash.digest('hex'),bytes,executable};
 }finally{await sourceHandle.close();await targetHandle?.close();}
}

/** Produces isolated artifacts only. No planner, task admission or apply authority.
 * This is a bounded observed snapshot, not a filesystem-wide atomic freeze.
 * Known private paths are excluded; arbitrary secret content is not detected. */
export class SnapshotCopyWorkspaceProvider implements WorkspaceProvider{
 private readonly issued=new WeakMap<WorkspaceSnapshot,Issued>();
 async create(input:SnapshotWorkspaceInput):Promise<WorkspaceSnapshot>{
  const id='workspace-snapshot-'+randomUUID();let created=false;
  try{
   controls(input.guard,input.signal);const limits=limitsOf(input.limits),paths=workspaceSelection(input.paths);await check(input.guard,input.signal,'prepare',id,null);
   const source=await rootOf(input.sourceRoot),storage=await rootOf(input.storageRoot);for(const part of source.path.slice(parse(source.path).root.length).split(sep))workspaceRelativePath(part);if(inside(source.canonical,storage.canonical)||inside(storage.canonical,source.canonical))throw failure('workspace_roots_overlap');
   const entries=await inventory(source,paths,limits,input.guard,input.signal,id),selection=new Map(paths.map(path=>[path,entries.find(e=>e.path===path)!.kind]));
   await assertRoot(storage);const isolated=join(storage.path,id);await mkdir(isolated,{mode:0o700});created=true;const target=await rootOf(isolated),output:WorkspaceManifestEntry[]=[];
   for(const entry of entries){await check(input.guard,input.signal,'copy',id,entry.path);await assertRoot(target);
    if(entry.kind==='directory'){await safe(dirname(join(target.path,...entry.path.split('/'))));await mkdir(join(target.path,...entry.path.split('/')),{mode:0o700});output.push({path:entry.path,kind:'directory'});}
    else output.push(await copyFile(source,target,entry,input.guard,input.signal,id));
   }
   await check(input.guard,input.signal,'verify',id,null);if(identities(entries)!==identities(await inventory(source,paths,limits,input.guard,input.signal,id)))throw failure('workspace_source_changed');
   const outputs=new Map(output.map(entry=>[entry.path,entry]));
   for(const entry of entries.filter(e=>e.kind==='file'))if(await hashFile(source,entry,input.guard,input.signal,id)!==(outputs.get(entry.path) as {sha256:string}).sha256)throw failure('workspace_source_changed');
   await check(input.guard,input.signal,'publish',id,null);if(identities(entries)!==identities(await inventory(source,paths,limits,input.guard,input.signal,id)))throw failure('workspace_source_changed');
   const manifest=validateWorkspaceManifest({protocol:1,provider:'snapshot-copy',paths,entries:output});
   const targetEntries=await inventory(target,paths,limits,input.guard,input.signal,id,selection);if(targetEntries.length!==entries.length)throw failure('workspace_copy_verification_failed');
   for(const entry of targetEntries){const expected=outputs.get(entry.path);if(!expected||expected.kind!==entry.kind||entry.kind==='file'&&(expected.kind!=='file'||!!(entry.stat.mode&0o100n)!==expected.executable||await hashFile(target,entry,input.guard,input.signal,id)!==expected.sha256))throw failure('workspace_copy_verification_failed');}
   if(identities(entries)!==identities(await inventory(source,paths,limits,input.guard,input.signal,id))||identities(targetEntries)!==identities(await inventory(target,paths,limits,input.guard,input.signal,id,selection)))throw failure('workspace_source_changed');
   const receipt=Object.freeze({protocol:1 as const,provider:'snapshot-copy' as const,snapshot_id:id,manifest_sha256:workspaceManifestHash(manifest),file_count:output.filter(e=>e.kind==='file').length,directory_count:output.filter(e=>e.kind==='directory').length,total_bytes:output.reduce((sum,e)=>sum+(e.kind==='file'?e.bytes:0),0),created_at:new Date().toISOString(),status:'ready' as const,execution_authorized:false as const});
   const result=Object.freeze({isolated_root:isolated,manifest,receipt});this.issued.set(result,{root:target,paths,selection,limits,receipt:canonicalJson(receipt)});return result;
  }catch(error){const code=error instanceof Error&&/^workspace_[a-z_]+$/.test(error.message)?error.message:input?.signal?.aborted?'workspace_cancelled':'workspace_snapshot_failed';const safeError=Object.assign(failure(code),{snapshot_id:id,residual_possible:created});throw safeError;}
 }
 async inspect(input:WorkspaceInspectionInput):Promise<WorkspaceInspection>{
  try{
  controls(input.guard,input.signal);const issued=this.issued.get(input.snapshot);if(!issued||canonicalJson(input.snapshot.receipt)!==issued.receipt||workspaceManifestHash(input.snapshot.manifest)!==input.snapshot.receipt.manifest_sha256||input.snapshot.isolated_root!==issued.root.path)throw failure('workspace_snapshot_untrusted');
  const id=input.snapshot.receipt.snapshot_id;await check(input.guard,input.signal,'verify',id,null);await assertRoot(issued.root);
  const before=await inventory(issued.root,issued.paths,issued.limits,input.guard,input.signal,id,issued.selection),entries:WorkspaceManifestEntry[]=[];
  for(const entry of before)entries.push(entry.kind==='directory'?{path:entry.path,kind:'directory'}:{path:entry.path,kind:'file',sha256:await hashFile(issued.root,entry,input.guard,input.signal,id),bytes:Number(entry.stat.size),executable:!!(entry.stat.mode&0o100n)});
  await check(input.guard,input.signal,'publish',id,null);if(identities(before)!==identities(await inventory(issued.root,issued.paths,issued.limits,input.guard,input.signal,id,issued.selection)))throw failure('workspace_source_changed');
  const manifest=validateWorkspaceManifest({protocol:1,provider:'snapshot-copy',paths:issued.paths,entries});return Object.freeze({snapshot_id:id,manifest,manifest_sha256:workspaceManifestHash(manifest),execution_authorized:false});
  }catch(error){throw failure(error instanceof Error&&/^workspace_[a-z_]+$/.test(error.message)?error.message:input?.signal?.aborted?'workspace_cancelled':'workspace_inspection_failed');}
 }
}
