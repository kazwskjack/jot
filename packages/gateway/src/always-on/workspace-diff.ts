import {createHash} from 'node:crypto';
import {canonicalJson} from '../db/canonical-json.ts';
import {validateWorkspaceManifest,workspaceManifestHash} from './workspace-provider.ts';
import type {WorkspaceManifestEntry} from './workspace-provider.ts';

type FileEntry=Extract<WorkspaceManifestEntry,{kind:'file'}>;
export type WorkspaceDiffChange=
 |Readonly<{kind:'add';path:string;after:WorkspaceManifestEntry}>
 |Readonly<{kind:'delete';path:string;before:WorkspaceManifestEntry}>
 |Readonly<{kind:'replace';path:string;before:WorkspaceManifestEntry;after:WorkspaceManifestEntry}>
 |Readonly<{kind:'modify';path:string;before:FileEntry;after:FileEntry;content_changed:boolean;mode_changed:boolean}>
 |Readonly<{kind:'rename';from:string;path:string;before:FileEntry;after:FileEntry;mode_changed:boolean;case_only:boolean}>;
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const order=(a:string,b:string)=>a<b?-1:a>b?1:0;
function freeze<T>(value:T):T{
 if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}

/** Review material only. Callers must obtain both inventories from trusted
 * providers; even a valid diff/receipt does not authorize execution or apply.
 * No filesystem, database, permission, task state or side effect is involved. */
export function createWorkspaceDiff(input:unknown){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='base,base_sha256,result,result_sha256')throw Error('workspace_diff_invalid');
 const value=input as Record<string,unknown>,base=validateWorkspaceManifest(value.base),result=validateWorkspaceManifest(value.result);
 const baseHash=workspaceManifestHash(base),resultHash=workspaceManifestHash(result);
 if(value.base_sha256!==baseHash)throw Error('workspace_diff_base_changed');
 if(value.result_sha256!==resultHash)throw Error('workspace_diff_result_changed');
 if(canonicalJson(base.paths)!==canonicalJson(result.paths))throw Error('workspace_diff_scope_changed');
 const prior=new Map(base.entries.map(entry=>[entry.path,entry])),current=new Map(result.entries.map(entry=>[entry.path,entry]));
 const changes:WorkspaceDiffChange[]=[];
 for(const path of [...new Set([...prior.keys(),...current.keys()])].sort(order)){
  // Ancestors merely locate explicitly selected paths. Their disappearance in
  // an isolated copy does not grant deleting/recreating a shared source parent.
  if(!base.paths.some(selected=>path===selected||path.startsWith(selected+'/')))continue;
  const before=prior.get(path),after=current.get(path);
  if(!before){changes.push({kind:'add',path,after:after!});continue;}
  if(!after){changes.push({kind:'delete',path,before});continue;}
  if(before.kind!==after.kind){changes.push({kind:'replace',path,before,after});continue;}
  if(before.kind==='file'&&after.kind==='file'){
   const content_changed=before.sha256!==after.sha256||before.bytes!==after.bytes,mode_changed=before.executable!==after.executable;
   if(content_changed||mode_changed)changes.push({kind:'modify',path,before,after,content_changed,mode_changed});
  }
 }
 // A matching digest is rename evidence only when each side has a single
 // candidate. Repeated content remains add/delete; do not invent intent.
 const identity=(entry:FileEntry)=>entry.sha256+':'+entry.bytes;
 const added=new Map<string,Array<Extract<WorkspaceDiffChange,{kind:'add'}>>>(),deleted=new Map<string,Array<Extract<WorkspaceDiffChange,{kind:'delete'}>>>();
 for(const change of changes){
  if(change.kind==='add'&&change.after.kind==='file'){const key=identity(change.after),group=added.get(key);if(group)group.push(change);else added.set(key,[change]);}
  if(change.kind==='delete'&&change.before.kind==='file'){const key=identity(change.before),group=deleted.get(key);if(group)group.push(change);else deleted.set(key,[change]);}
 }
 const paired=new Set<WorkspaceDiffChange>(),renames:WorkspaceDiffChange[]=[];
 for(const [key,old] of deleted){const next=added.get(key);if(old.length!==1||next?.length!==1)continue;
  const previous=old[0]!,following=next[0]!,before=previous.before as FileEntry,after=following.after as FileEntry;
  paired.add(previous);paired.add(following);renames.push({kind:'rename',from:previous.path,path:following.path,before,after,mode_changed:before.executable!==after.executable,case_only:previous.path!==following.path&&previous.path.toLowerCase()===following.path.toLowerCase()});
 }
 const payload={protocol:1 as const,base_sha256:baseHash,result_sha256:resultHash,changes:[...changes.filter(change=>!paired.has(change)),...renames].sort((a,b)=>order(a.path,b.path)||order(a.kind,b.kind)),execution_authorized:false as const};
 return freeze({...payload,diff_sha256:hash(payload)});
}
