import {captureMessageReferenceSnapshots,messageReferenceProjection} from '../messages/reference-snapshots.ts';
import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {decodeStoredContent} from '../messages/content.ts';
import {validateForkAttachmentSet,validateFrozenForkAttachments} from './fork-attachment-limits.ts';

type Row=Record<string,unknown>;
export type ForkAttachment={artifact_id:string;version:number;sha256:string;size_bytes:number;media_type:string;file_name:string};
export type ForkSource={session_id:string;session_created_at:number;head_seq:number;head_sha256:string;message_attachments:Record<string,ForkAttachment[]>;role_refs:Array<{agent_id:string;version:number;capability_epoch:number}>};
export type ForkSourceScope={owner_id:string;conversation_id:string;session_id:string;conversation_version:number;through_message_id:string;messages:readonly Row[]};
type Ports={readSource:(scope:ForkSourceScope,signal?:AbortSignal)=>Promise<ForkSource>;verifyAttachments?:(scope:ForkSourceScope,pins:readonly ForkAttachment[],signal?:AbortSignal)=>Promise<void>;prepareAttachments?:(scope:ForkSourceScope,pins:readonly ForkAttachment[],key:string,signal?:AbortSignal)=>Promise<{remap(pin:ForkAttachment):ForkAttachment;commit(target:string):void}>};
const valid=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
const plain=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:unknown,s:string):v is Row=>plain(v)&&Object.keys(v).sort().join(',')===s.split(',').sort().join(',');
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v,(_k,x)=>plain(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x)).digest('hex');
const sourceChanged=():never=>{throw Error('fork_source_changed');};
function assertForkMessageContent(value:unknown){
 let parsed:unknown;try{parsed=typeof value==='string'?JSON.parse(value):value;}catch{throw Error('fork_message_projection_unsupported');}
 if(Array.isArray(parsed)){if(parsed.some(item=>!plain(item)))throw Error('fork_message_projection_unsupported');return;}
 if(!keys(parsed,'blocks,attachments')||!Array.isArray(parsed.blocks)||!parsed.blocks.every(plain)||!Array.isArray(parsed.attachments)||!parsed.attachments.every(item=>typeof item==='string'))throw Error('fork_message_projection_unsupported');
}
function readWithCancellation<T>(operation:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
 const pending=Promise.resolve().then(()=>{signal?.throwIfAborted();return operation();});if(!signal)return pending;
 return new Promise((resolve,reject)=>{const cleanup=()=>signal.removeEventListener('abort',abort),abort=()=>{cleanup();reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});pending.then(value=>{cleanup();signal.aborted?reject(signal.reason):resolve(value);},error=>{cleanup();reject(error);});if(signal.aborted)abort();});
}

/** Candidate migration fragment. Its registration in the original database
 * opener is a separately reserved shared-file change; no second database. */
export function installConversationForks(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS ga_conversation_forks (
  fork_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,source_conversation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,request_sha256 TEXT NOT NULL,
  target_conversation_id TEXT NOT NULL UNIQUE REFERENCES ga_conversations(id),target_session_id TEXT NOT NULL UNIQUE,
  manifest_json TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL,
  UNIQUE(owner_id,source_conversation_id,idempotency_key));
 CREATE TABLE IF NOT EXISTS ga_conversation_fork_messages (
  target_message_id TEXT PRIMARY KEY REFERENCES ga_messages(id),fork_id TEXT NOT NULL REFERENCES ga_conversation_forks(fork_id),
  source_message_id TEXT NOT NULL,position INTEGER NOT NULL,source_content_sha256 TEXT NOT NULL,
  attachment_refs_json TEXT NOT NULL,UNIQUE(fork_id,position),UNIQUE(fork_id,source_message_id));
 CREATE TRIGGER IF NOT EXISTS ga_conversation_fork_immutable BEFORE UPDATE ON ga_conversation_forks
 BEGIN SELECT RAISE(ABORT,'conversation_fork_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS ga_conversation_fork_message_immutable BEFORE UPDATE ON ga_conversation_fork_messages
 BEGIN SELECT RAISE(ABORT,'conversation_fork_immutable'); END;
 `);}

/** Original SQLite owns identity, transcript, lineage and idempotency. Native
 * history/bytes are read outside the writer, then source CAS is repeated inside
 * the one transaction creating the complete fork. No native prompt or model call. */
export class ConversationForks{
 private readonly db:DatabaseSync;
 private readonly ports:Ports;
 constructor(db:DatabaseSync,ports:Ports){this.db=db;this.ports=ports;}
 private source(owner:string,conversation:string,version:number,through:string){
  const c=this.db.prepare('SELECT * FROM ga_conversations WHERE id=? AND owner_id=?').get(conversation,owner) as Row|undefined;
  if(!c)throw Error('conversation_not_found');if(c.archived_at!==null||Number(c.version)!==version)sourceChanged();
  if(!this.db.prepare('SELECT 1 FROM ga_projects WHERE id=? AND owner_id=?').get(String(c.project_id),owner))sourceChanged();
  const native=this.db.prepare('SELECT session_id,owner_id FROM ga_conversation_mode_sessions WHERE conversation_id=? AND mode=?').get(conversation,String(c.mode))
   ??(c.mode==='work'?this.db.prepare('SELECT session_id,owner_id FROM ga_harness_session_bindings WHERE conversation_id=?').get(conversation):undefined);
  if(!native||native.owner_id!==owner||!valid(native.session_id))throw Error('fork_source_session_missing');
  const rows=this.db.prepare(`SELECT m.* FROM ga_messages m
   LEFT JOIN ga_ordinary_final_publications f ON f.run_id=m.run_id AND f.conversation_id=m.conversation_id
   WHERE m.conversation_id=? ORDER BY CASE WHEN m.id=f.message_id THEN f.created_at ELSE m.created_at END ASC,
   CASE WHEN m.id=f.message_id THEN 1 ELSE 0 END ASC,CASE WHEN f.run_id IS NOT NULL THEN m.rowid END ASC,m.id ASC`).all(conversation) as Row[];
  const end=rows.findIndex(row=>row.id===through);if(end<0)throw Error('fork_boundary_not_found');const selected=rows.slice(0,end+1);
  if(selected.some(row=>!valid(row.id)||!['user','assistant'].includes(String(row.role))||row.status!=='complete'))throw Error('fork_source_unsettled');
  for(const row of selected)assertForkMessageContent(row.content_json);
  return{conversation:c,messages:selected,sessionId:String(native.session_id)};
 }
 recoverReceipt(owner:string,conversation:string,input:unknown,key:string){
  if(!valid(owner)||!valid(conversation)||!keys(input,'expected_version,through_message_id')||!Number.isSafeInteger(input.expected_version)||Number(input.expected_version)<1||!valid(input.through_message_id)||!/^[\x21-\x7e]{8,128}$/.test(key))return undefined;
  if(!this.db.prepare('SELECT 1 FROM ga_conversations WHERE id=? AND owner_id=?').get(conversation,owner))return undefined;
  return this.existing(owner,conversation,key,hash(input));
 } private existing(owner:string,conversation:string,key:string,requestHash:string){
  const row=this.db.prepare('SELECT request_sha256,receipt_json,target_conversation_id,manifest_json,manifest_sha256 FROM ga_conversation_forks WHERE owner_id=? AND source_conversation_id=? AND idempotency_key=?').get(owner,conversation,key);
  if(!row)return undefined;if(row.request_sha256!==requestHash)throw Error('fork_idempotency_conflict');
  const frozen=JSON.parse(String(row.manifest_json));if(hash(frozen)!==row.manifest_sha256)throw Error('fork_manifest_corrupt');validateFrozenForkAttachments(frozen);
  if(!this.db.prepare('SELECT 1 FROM ga_conversations WHERE id=? AND owner_id=?').get(String(row.target_conversation_id),owner))throw Error('fork_target_unavailable');return JSON.parse(String(row.receipt_json)) as Row;
 }
 async fork(owner:string,conversation:string,input:unknown,key:string,signal?:AbortSignal){
  signal?.throwIfAborted();if(!valid(owner)||!valid(conversation)||!keys(input,'expected_version,through_message_id')||!Number.isSafeInteger(input.expected_version)||Number(input.expected_version)<1||!valid(input.through_message_id)||!/^[\x21-\x7e]{8,128}$/.test(key))throw Error('fork_input_invalid');
  // Always check current source owner before returning an old idempotency receipt.
  if(!this.db.prepare('SELECT 1 FROM ga_conversations WHERE id=? AND owner_id=?').get(conversation,owner))throw Error('conversation_not_found');
  const requestHash=hash(input),old=this.existing(owner,conversation,key,requestHash);if(old)return old;
  const original=this.source(owner,conversation,Number(input.expected_version),input.through_message_id),sourceHash=hash(original);
  const scope:ForkSourceScope={owner_id:owner,conversation_id:conversation,session_id:original.sessionId,conversation_version:Number(input.expected_version),through_message_id:input.through_message_id,messages:structuredClone(original.messages)};
  const proof=structuredClone(await readWithCancellation(()=>this.ports.readSource(structuredClone(scope),signal),signal));signal?.throwIfAborted();
  if(!keys(proof,'session_id,session_created_at,head_seq,head_sha256,message_attachments,role_refs')||proof.session_id!==scope.session_id||!Number.isSafeInteger(proof.session_created_at)||Number(proof.session_created_at)<0||!Number.isSafeInteger(proof.head_seq)||Number(proof.head_seq)<0||!/^([a-f0-9]{64})$/.test(String(proof.head_sha256))||!plain(proof.message_attachments)||!Array.isArray(proof.role_refs))sourceChanged();
  if(Object.keys(proof.message_attachments).sort().join(',')!==scope.messages.map(row=>String(row.id)).sort().join(','))throw Error('fork_attachment_provenance_required');
  const allPins:ForkAttachment[]=[],messages=scope.messages.map(row=>{
   const content=decodeStoredContent(String(row.content_json)),attachments=proof.message_attachments[String(row.id)];
   if(!Array.isArray(attachments)||JSON.stringify(attachments.map(pin=>pin.artifact_id))!==JSON.stringify(content.attachments))throw Error('fork_attachment_provenance_required');
   for(const pin of attachments){if(!keys(pin,'artifact_id,version,sha256,size_bytes,media_type,file_name')||!valid(pin.artifact_id)||!Number.isSafeInteger(pin.version)||Number(pin.version)<1||!/^[a-f0-9]{64}$/.test(String(pin.sha256))||!Number.isSafeInteger(pin.size_bytes)||Number(pin.size_bytes)<0||typeof pin.media_type!=='string'||!pin.media_type||typeof pin.file_name!=='string'||!pin.file_name)throw Error('fork_attachment_provenance_required');allPins.push(pin as ForkAttachment);}
   // Retain structured blocks as literal material. The target transcript stores
   // the exact original JSON; no block is promoted to a system/tool instruction.
   const text=content.blocks.every(block=>(block.kind??block.type)==='text'&&typeof block.text==='string')?content.blocks.map(block=>String(block.text)).join('\n\n'):JSON.stringify(content.blocks);
   return{message_id:String(row.id),role:String(row.role),text,content_sha256:createHash('sha256').update(JSON.stringify({text,attachments})).digest('hex'),attachments};
  });
  const roleIds=new Set();for(const ref of proof.role_refs){if(!keys(ref,'agent_id,version,capability_epoch')||!valid(ref.agent_id)||roleIds.has(ref.agent_id)||!Number.isSafeInteger(ref.version)||Number(ref.version)<1||!Number.isSafeInteger(ref.capability_epoch)||Number(ref.capability_epoch)<1)sourceChanged();roleIds.add(ref.agent_id);}
  const frozenPins=validateForkAttachmentSet(allPins);
  if(frozenPins.length){const verify=this.ports.verifyAttachments;if(!verify)throw Error('fork_attachment_bytes_unverified');await readWithCancellation(()=>verify(structuredClone(scope),structuredClone(frozenPins),signal),signal);signal?.throwIfAborted();}
  const clones=frozenPins.length&&this.ports.prepareAttachments?await this.ports.prepareAttachments(scope,frozenPins,key,signal):null;
  if(allPins.length&&!clones)throw Error('fork_attachment_clone_required');
  return withImmediateTransaction(this.db,()=>{
   signal?.throwIfAborted();const concurrent=this.existing(owner,conversation,key,requestHash);if(concurrent)return concurrent;
   if(hash(this.source(owner,conversation,scope.conversation_version,scope.through_message_id))!==sourceHash)sourceChanged();
   const forkId='fork-'+randomUUID(),target='conv-'+randomUUID(),session=(original.conversation.mode==='chat'?'jot-chat-':'jot-')+randomUUID(),now=new Date().toISOString();
   const inherited=messages.map(message=>message.attachments.length?{...message,source_attachments:message.attachments,attachments:message.attachments.map(pin=>clones!.remap(pin))}:message);
   const manifest={protocol:1,fork_id:forkId,owner_id:owner,source:{conversation_id:conversation,session_id:scope.session_id,session_created_at:proof.session_created_at,conversation_version:scope.conversation_version,head_seq:proof.head_seq,head_sha256:proof.head_sha256,through_message_id:scope.through_message_id},target:{conversation_id:target,session_id:session},messages:inherited,role_refs:proof.role_refs};
   const receipt={conversation_id:target,fork_id:forkId,source:{conversation_id:conversation,through_message_id:scope.through_message_id,head_sha256:proof.head_sha256},state:'ready'};
   this.db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at,project_id,mode) VALUES(?,?,?,?,?,1,?,?,?,?)').run(target,owner,String(original.conversation.workspace_id),String(original.conversation.title)+' (fork)',String(original.conversation.model),now,now,String(original.conversation.project_id),String(original.conversation.mode));
   if(original.conversation.mode==='work')this.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(target,owner,session,now,now);
   this.db.prepare('INSERT INTO ga_conversation_mode_sessions(conversation_id,owner_id,mode,session_id,created_at) VALUES(?,?,?,?,?)').run(target,owner,String(original.conversation.mode),session,now);
   this.db.prepare('INSERT INTO ga_conversation_forks VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(forkId,owner,conversation,key,requestHash,target,session,JSON.stringify(manifest),hash(manifest),JSON.stringify(receipt),now);
   clones?.commit(target);
   for(const [position,row]of original.messages.entries()){
    const newId=`message-${forkId}-${String(position).padStart(12,'0')}`;
    const pins=proof.message_attachments[String(row.id)]!,refs=pins.map(pin=>clones!.remap(pin));
    const original=decodeStoredContent(String(row.content_json)),content=refs.length?JSON.stringify({...original,attachments:refs.map(pin=>pin.artifact_id)}):String(row.content_json);
    this.db.prepare('INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,created_at,updated_at) VALUES(?,?,NULL,?,?,?,?,?)').run(newId,target,String(row.role),'complete',content,String(row.created_at),String(row.updated_at));
    this.db.prepare('INSERT INTO ga_conversation_fork_messages VALUES(?,?,?,?,?,?)').run(newId,forkId,String(row.id),position,createHash('sha256').update(content).digest('hex'),JSON.stringify(refs));
    const referenceSnapshots=messageReferenceProjection(this.db,row,owner).reference_snapshots;
    if(referenceSnapshots?.state==='unavailable')sourceChanged();
    captureMessageReferenceSnapshots(this.db,target,newId,referenceSnapshots?.items);
   }
   signal?.throwIfAborted();return receipt;
  });
 }
 context(owner:string,conversation:string,session:string){
  const row=this.db.prepare('SELECT f.* FROM ga_conversation_forks f JOIN ga_conversations c ON c.id=f.target_conversation_id AND c.owner_id=f.owner_id WHERE f.owner_id=? AND f.target_conversation_id=? AND f.target_session_id=?').get(owner,conversation,session);
  if(!row)return null;const manifest=JSON.parse(String(row.manifest_json));if(hash(manifest)!==row.manifest_sha256)throw Error('fork_manifest_corrupt');validateFrozenForkAttachments(manifest);return manifest;
 }
}
