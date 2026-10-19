import {createPinnedByteStore,type PinnedByteSource} from './pinned-byte-source.ts';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import type {ResolvedAttachment} from './resolver.ts';

export type PinnedAttachment=Readonly<{artifact_id:string;version:number;sha256:string;size_bytes:number;media_type:string;file_name:string;kind:ResolvedAttachment['kind']}>;
export type AttachmentManifest=Readonly<{protocol:1;attachments:readonly PinnedAttachment[]}>;
type Limits={maxCount:number;maxAggregateBytes:number;leaseMs:number};
const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const keys='artifact_id,file_name,kind,media_type,sha256,size_bytes,version';
function fail():never{throw Error('attachment_manifest_invalid');}
const equalPath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const inside=(root:string,path:string)=>!equalPath(root,path)&&(process.platform==='win32'?path.toLowerCase().startsWith((root+sep).toLowerCase()):path.startsWith(root+sep));
const kind=(mime:string):ResolvedAttachment['kind']=>mime.startsWith('image/')&&mime!=='image/svg+xml'?'image':mime.startsWith('text/')||['application/json','application/xml'].includes(mime)?'text':mime==='application/pdf'||/officedocument|msword|excel|powerpoint/.test(mime)?'document':'file';

/** Serializable source identity only. No paths, file receipts or native admission. */
export function validateAttachmentManifest(input:unknown,limits:Pick<Limits,'maxCount'|'maxAggregateBytes'>):AttachmentManifest{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='attachments,protocol')fail();
 const value=input as Record<string,unknown>;
 if(value.protocol!==1||!Array.isArray(value.attachments)||!value.attachments.length||value.attachments.length>limits.maxCount)fail();
 let total=0;const seen=new Set<string>();const entries:PinnedAttachment[]=[];
 for(const raw of value.attachments){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!==keys)fail();
  const row=raw as Record<string,unknown>;
  if(typeof row.artifact_id!=='string'||!id.test(row.artifact_id)||seen.has(row.artifact_id)||!Number.isSafeInteger(row.version)||Number(row.version)<1||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256)||!Number.isSafeInteger(row.size_bytes)||Number(row.size_bytes)<0||typeof row.media_type!=='string'||!row.media_type||row.media_type.length>200||typeof row.file_name!=='string'||!row.file_name||row.file_name.length>255||row.kind!==kind(row.media_type))fail();
  total+=Number(row.size_bytes);if(!Number.isSafeInteger(total)||total>limits.maxAggregateBytes)throw Error('attachment_aggregate_size_invalid');seen.add(row.artifact_id);
  entries.push(Object.freeze({artifact_id:row.artifact_id,version:Number(row.version),sha256:row.sha256,size_bytes:Number(row.size_bytes),media_type:row.media_type,file_name:row.file_name,kind:row.kind as ResolvedAttachment['kind']}));
 }
 return Object.freeze({protocol:1,attachments:Object.freeze(entries)});
}

export function manifestFromAttachments(values:ResolvedAttachment[],limits:Pick<Limits,'maxCount'|'maxAggregateBytes'>):AttachmentManifest{
 return validateAttachmentManifest({protocol:1,attachments:values.map(row=>({artifact_id:row.artifactId,version:row.version,sha256:row.sha256,size_bytes:row.sizeBytes,media_type:row.mediaType,file_name:row.displayName,kind:row.kind}))},limits);
}

/** Read/hash exact bytes without holding a SQLite writer. Returning a path is
 * not a byte-staging receipt; a later uploader must preserve its byte witness. */
async function verifyBytes(root:string,path:string,pin:PinnedAttachment,signal?:AbortSignal,consume?:(bytes:Buffer)=>Promise<void>){
 signal?.throwIfAborted();let file;
 try{
  const anchor=await realpath(root);let parent=dirname(path);
  while(!equalPath(parent,root)){if(!inside(root,parent))throw Error();const entry=await lstat(parent);if(!entry.isDirectory()||entry.isSymbolicLink())throw Error();parent=dirname(parent);}
  const leaf=await lstat(path);if(!leaf.isFile()||leaf.isSymbolicLink())throw Error();
  const canonical=await realpath(path);if(!inside(anchor,canonical))throw Error();
  file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const before=await file.stat();
  if(!before.isFile()||before.dev!==leaf.dev||before.ino!==leaf.ino||before.size!==pin.size_bytes)throw Error();
  let size=0;const hash=createHash('sha256');for await(const bytes of file.createReadStream({autoClose:false,start:0})){signal?.throwIfAborted();size+=bytes.length;if(size>pin.size_bytes)throw Error();hash.update(bytes);if(consume)await consume(bytes);}
  signal?.throwIfAborted();const after=await file.stat(),current=await lstat(path);
  if(size!==pin.size_bytes||hash.digest('hex')!==pin.sha256||!current.isFile()||current.isSymbolicLink()||!equalPath(await realpath(path),canonical)||!equalPath(await realpath(root),anchor)||['dev','ino','size','mtimeMs','ctimeMs'].some(key=>before[key as keyof typeof before]!==after[key as keyof typeof after]||after[key as keyof typeof after]!==current[key as keyof typeof current]))throw Error();
 }catch{signal?.throwIfAborted();throw Error('attachment_content_unverified');}finally{await file?.close();}
}

async function preparePinnedManifest(db:DatabaseSync,rootInput:string,limits:Limits,owner:string,conversation:string,input:unknown,leaseId:string,signal?:AbortSignal,snapshotRoot?:string){
 if(db.isTransaction)throw Error('attachment_verification_transaction_forbidden');
 if(typeof leaseId!=='string'||!id.test(leaseId))throw Error('attachment_lease_invalid');
 const manifest=validateAttachmentManifest(input,limits),root=resolve(rootInput);signal?.throwIfAborted();
 const read=(pin:PinnedAttachment)=>{
  const row=db.prepare(`SELECT v.server_path,v.sha256,v.size_bytes,v.mime_type,v.metadata_json,COALESCE(ar.local_state,'present') local_state
   FROM ga_artifacts a JOIN ga_artifact_versions v ON v.artifact_id=a.id AND v.version=? LEFT JOIN ga_artifact_archives ar ON ar.artifact_id=a.id
   WHERE a.id=? AND a.owner_id=? AND a.conversation_id=?`).get(pin.version,pin.artifact_id,owner,conversation);
  if(!row)throw Error('artifact_not_found');let metadata:Record<string,unknown>;try{metadata=JSON.parse(String(row.metadata_json));}catch{throw Error('attachment_manifest_changed');}
  if(!metadata||metadata.status!=='ready'||row.sha256!==pin.sha256||Number(row.size_bytes)!==pin.size_bytes||row.mime_type!==pin.media_type||String(metadata.file_name||pin.artifact_id)!==pin.file_name)throw Error('attachment_manifest_changed');
  if(row.local_state!=='present')throw Error('attachment_restore_required');
  const path=resolve(String(row.server_path));if(!inside(root,path))throw Error('attachment_path_denied');return{row,path};
 };
 const selected=manifest.attachments.map(pin=>({pin,...read(pin)}));
 const store=snapshotRoot===undefined?undefined:createPinnedByteStore(snapshotRoot);
 try{
 for(const item of selected){const writer=await store?.begin(item.pin.sha256,item.pin.size_bytes,signal);await verifyBytes(root,item.path,item.pin,signal,writer?.append);await writer?.seal();}
 const attachments=withImmediateTransaction(db,()=>{
  signal?.throwIfAborted();for(const item of selected){const current=read(item.pin);if(JSON.stringify(current.row)!==JSON.stringify(item.row)||current.path!==item.path)throw Error('attachment_manifest_changed');}
  const now=new Date(),expires=new Date(now.getTime()+limits.leaseMs).toISOString(),save=db.prepare('INSERT OR REPLACE INTO ga_artifact_leases(artifact_id,lease_id,expires_at,created_at) VALUES(?,?,?,?)');
  for(const item of selected)save.run(item.pin.artifact_id,leaseId,expires,now.toISOString());
  return selected.map(({pin,path})=>({artifactId:pin.artifact_id,version:pin.version,displayName:pin.file_name,mediaType:pin.media_type,sizeBytes:pin.size_bytes,sha256:pin.sha256,kind:pin.kind,localPath:path}));
 });
 return{attachments,manifest,sources:store?.sources(),dispose:store?()=>store.dispose():undefined};
 }catch(error){await store?.dispose();throw error;}
}

export async function resolvePinnedManifest(db:DatabaseSync,root:string,limits:Limits,owner:string,conversation:string,input:unknown,leaseId:string,signal?:AbortSignal):Promise<ResolvedAttachment[]>{
 return(await preparePinnedManifest(db,root,limits,owner,conversation,input,leaseId,signal)).attachments;
}

export type PinnedAttachmentSnapshot=Readonly<{manifest:AttachmentManifest;sources:readonly PinnedByteSource[];dispose():Promise<void>}>;
export async function snapshotPinnedManifest(db:DatabaseSync,root:string,limits:Limits,owner:string,conversation:string,input:unknown,leaseId:string,snapshotRoot:string,signal?:AbortSignal):Promise<PinnedAttachmentSnapshot>{
 if(typeof snapshotRoot!=='string')throw Error('attachment_snapshot_root_invalid');
 const value=await preparePinnedManifest(db,root,limits,owner,conversation,input,leaseId,signal,snapshotRoot);
 return Object.freeze({manifest:value.manifest,sources:value.sources!,dispose:value.dispose!});
}

/** Catalog source facts only; performs no disk read, native send or execution. */
export function inspectPinnedAttachmentManifest(db:DatabaseSync,owner:string,conversation:string,input:unknown):AttachmentManifest{
 const manifest=validateAttachmentManifest(input,{maxCount:10,maxAggregateBytes:200*1024*1024});
 for(const pin of manifest.attachments){
  const row=db.prepare(`SELECT v.sha256,v.size_bytes,v.mime_type,v.metadata_json,COALESCE(ar.local_state,'present') local_state FROM ga_artifacts a
   JOIN ga_artifact_versions v ON v.artifact_id=a.id AND v.version=? LEFT JOIN ga_artifact_archives ar ON ar.artifact_id=a.id
   WHERE a.id=? AND a.owner_id=? AND a.conversation_id=?`).get(pin.version,pin.artifact_id,owner,conversation);
  if(!row||row.local_state!=='present')throw Error('attachment_manifest_changed');let metadata:Record<string,unknown>;try{metadata=JSON.parse(String(row.metadata_json));}catch{throw Error('attachment_manifest_changed');}
  if(!metadata||metadata.status!=='ready'||row.sha256!==pin.sha256||Number(row.size_bytes)!==pin.size_bytes||row.mime_type!==pin.media_type||String(metadata.file_name||pin.artifact_id)!==pin.file_name)throw Error('attachment_manifest_changed');
 }
 return manifest;
}
