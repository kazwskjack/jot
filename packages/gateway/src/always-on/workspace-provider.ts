import {createHash} from 'node:crypto';
import {canonicalJson} from '../db/canonical-json.ts';

export type WorkspaceManifestEntry=Readonly<{path:string;kind:'file';sha256:string;bytes:number;executable:boolean}>|Readonly<{path:string;kind:'directory'}>;
export type WorkspaceManifest=Readonly<{protocol:1;provider:'snapshot-copy';paths:readonly string[];entries:readonly WorkspaceManifestEntry[]}>;
export type WorkspaceCreationReceipt=Readonly<{protocol:1;provider:'snapshot-copy';snapshot_id:string;manifest_sha256:string;file_count:number;directory_count:number;total_bytes:number;created_at:string;status:'ready';execution_authorized:false}>;
/** isolated_root is trusted internal data. Never project it into an API receipt. */
export type WorkspaceSnapshot=Readonly<{isolated_root:string;manifest:WorkspaceManifest;receipt:WorkspaceCreationReceipt}>;
export type WorkspaceInspection=Readonly<{snapshot_id:string;manifest:WorkspaceManifest;manifest_sha256:string;execution_authorized:false}>;
export type WorkspaceGuard=(context:Readonly<{phase:'prepare'|'copy'|'verify'|'publish';snapshot_id:string;relative_path:string|null;execution_authorized:false}>)=>void|Promise<void>;
export type WorkspaceProviderLimits={max_entries?:number;max_total_bytes?:number;max_file_bytes?:number;max_depth?:number};
export type SnapshotWorkspaceInput={sourceRoot:string;storageRoot:string;paths:readonly string[];guard:WorkspaceGuard;signal:AbortSignal;limits?:WorkspaceProviderLimits};
export type WorkspaceInspectionInput={snapshot:WorkspaceSnapshot;guard:WorkspaceGuard;signal:AbortSignal};
/** Private host-only artifact facts. Absolute roots must never enter public API projections. */
export type SnapshotRecoveryRoot=Readonly<{path:string;canonical:string;dev:string;ino:string}>;
export type SnapshotRecoveryRecord=Readonly<{protocol:1;provider:'snapshot-copy';snapshot_id:string;storage_root:SnapshotRecoveryRoot;isolated_root:SnapshotRecoveryRoot;manifest:WorkspaceManifest;receipt:WorkspaceCreationReceipt;selection:readonly Readonly<{path:string;kind:'file'|'directory'}>[];limits:Required<WorkspaceProviderLimits>}>;
export type SnapshotRecoveryStore={commit(record:SnapshotRecoveryRecord):Promise<void>;read(snapshot_id:string):Promise<SnapshotRecoveryRecord|undefined>};
export type SnapshotProviderOptions={recoveryStore?:SnapshotRecoveryStore};
export type WorkspaceRecoveryInput={snapshot_id:string;storageRoot:string;guard:WorkspaceGuard;signal:AbortSignal};
/** Internal trusted versioned source bridge, not a public manifest or read URL. */
export type WorkspaceMaterializationInput={storageRoot:string;manifest:WorkspaceManifest;selection:readonly Readonly<{path:string;kind:'file'|'directory'}>[];read:(path:string)=>AsyncIterable<Uint8Array>;assertCurrent:()=>Promise<void>;guard:WorkspaceGuard;signal:AbortSignal;limits?:WorkspaceProviderLimits};
export interface WorkspaceProvider {create(input:SnapshotWorkspaceInput):Promise<WorkspaceSnapshot>;inspect(input:WorkspaceInspectionInput):Promise<WorkspaceInspection>;recover(input:WorkspaceRecoveryInput):Promise<WorkspaceSnapshot>}

export function workspaceRelativePath(value:unknown):string{
 if(typeof value!=='string'||!value||value.length>4096||value.startsWith('/')||/[\\:\x00-\x1f\x7f]/.test(value)
  ||value.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$|[<>"|?*]/.test(p)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p)))throw Error('workspace_path_unsafe');
 for(const part of value.split('/'))if(/^(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.codex|\.agents|\.config|\.kube|\.docker|\.mozilla|\.pki|\.npmrc|\.netrc|\.pypirc|credentials(?:\..*)?|secrets?(?:\..*)?|cookies(?:\.sqlite)?|login data|local state|web data|key[34]\.db|logins\.json|browser[-_ ]?profiles?|chrome[-_ ]?profiles?|chromium[-_ ]?profiles?|chromium|google-chrome|user data|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i.test(part)||/^\.env(?:\.|$)/i.test(part)||/\.(?:pem|key|p12|pfx|jks)$/i.test(part))throw Error('workspace_private_path');
 return value;
}
const fold=(value:string)=>value.normalize('NFC').toLowerCase();
export function workspaceSelection(value:unknown):readonly string[]{
 if(!Array.isArray(value)||!value.length||value.length>50000)throw Error('workspace_paths_invalid');
 const paths=value.map(workspaceRelativePath).sort(),seen=new Set<string>(),parents=new Set<string>();
 for(const path of paths){const key=fold(path),parts=key.split('/');if(seen.has(key)||parents.has(key))throw Error('workspace_path_collision');
  parts.pop();const prefixes:string[]=[];while(parts.length){const prefix=parts.join('/');if(seen.has(prefix))throw Error('workspace_path_collision');prefixes.push(prefix);parts.pop();}
  seen.add(key);for(const prefix of prefixes)parents.add(prefix);
 }
 return Object.freeze(paths);
}
/** Shape and scope validation grants no filesystem or application authority. */
export function validateWorkspaceManifest(value:unknown):WorkspaceManifest{
 const m=value as WorkspaceManifest;
 if(!m||typeof m!=='object'||Object.keys(m).sort().join(',')!=='entries,paths,protocol,provider'||m.protocol!==1||m.provider!=='snapshot-copy'||!Array.isArray(m.entries)||m.entries.length>100000)throw Error('workspace_manifest_invalid');
 const paths=workspaceSelection(m.paths),seen=new Set<string>(),entries:WorkspaceManifestEntry[]=[];
 for(const entry of m.entries){if(!entry||typeof entry!=='object')throw Error('workspace_manifest_invalid');const path=workspaceRelativePath(entry.path),key=fold(path);
  if(seen.has(key)||!paths.some(p=>path===p||path.startsWith(p+'/')||p.startsWith(path+'/')))throw Error('workspace_manifest_invalid');seen.add(key);
  // Ancestors only describe the structure needed to reach an explicit scope.
  // Their presence is not permission to replace an unselected parent directory.
  if(paths.some(p=>p.startsWith(path+'/'))&&entry.kind!=='directory')throw Error('workspace_manifest_invalid');
  if(entry.kind==='directory'&&Object.keys(entry).sort().join(',')==='kind,path')entries.push(Object.freeze({path,kind:'directory'}));
  else if(entry.kind==='file'&&Object.keys(entry).sort().join(',')==='bytes,executable,kind,path,sha256'&&/^[a-f0-9]{64}$/.test(entry.sha256)&&Number.isSafeInteger(entry.bytes)&&entry.bytes>=0&&typeof entry.executable==='boolean')entries.push(Object.freeze({path,kind:'file',sha256:entry.sha256,bytes:entry.bytes,executable:entry.executable}));
  else throw Error('workspace_manifest_invalid');
 }
 const map=new Map(entries.map(e=>[e.path,e]));for(const entry of entries){const parts=entry.path.split('/');parts.pop();while(parts.length){if(map.get(parts.join('/'))?.kind!=='directory')throw Error('workspace_manifest_invalid');parts.pop();}}
 entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 return Object.freeze({protocol:1,provider:'snapshot-copy',paths,entries:Object.freeze(entries)});
}
export function workspaceManifestHash(manifest:WorkspaceManifest):string{return createHash('sha256').update(canonicalJson(validateWorkspaceManifest(manifest))).digest('hex');}
