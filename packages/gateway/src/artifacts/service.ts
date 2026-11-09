import { createHash, randomUUID } from 'node:crypto';
import { basename, join,dirname,resolve,sep } from 'node:path';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync,writeFileSync,lstatSync,opendirSync } from 'node:fs';
import { once } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction, withReadTransaction } from '../db/database.ts';
import { canonicalJson } from '../db/canonical-json.ts';
import { detectContentType } from './content-type.ts';
import {artifactArchiveReferences,artifactArchiveManifest} from './archive-references.ts';
import {currentFileHashes} from './file-integrity.ts';
import {sameTaskFileLocation} from '../persistent-tasks/output-content.ts';
import {readIsolatedTaskFileVersion} from '../persistent-tasks/isolated-output-source.ts';
import {taskFileSource,type TaskFileScope,type TaskFileLocation} from '../persistent-tasks/task-file-source.ts';
import {AttachmentResolver} from './resolver.ts';
import {normalizeChannelAttachmentManifestV2,channelAttachmentManifestDigestV2,type ChannelAttachmentSourceV2} from '../channels/attachment-manifest-v2.ts';
import {channelUploadStageKeyV2,channelUploadIdV2,channelUploadArtifactIdV2,channelStageRequestDigestV2} from '../channels/attachment-stage-v2.ts';

export interface PinnedArtifactCleanupInput {
  run_id: string;
  kind: 'artifact';
  schema_version: 1;
  owner_id: string;
  conversation_id: string;
  artifact_id: string;
  version: number;
  sha256: string;
  size_bytes: number;
  manifest_sha256: string;
  manifest: Array<{ part_index: number; display_name: string; sha256: string; size_bytes: number; mime_type: string }>;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

const UPLOAD_RETENTION_MS=24*60*60*1000,UPLOAD_WRITER_LEASE_MS=300000,UPLOAD_BATCH_MAX_FILES=500,UPLOAD_BATCH_MAX_BYTES=2*1024*1024*1024,UPLOAD_BATCH_MAX_ACTIVE=3;

type UploadBatchFile={client_file_id:string;file_name:string;relative_path:string;media_type:string;size_bytes:number;sha256:string};

function uploadBatchFiles(input:Record<string,unknown>,maxBytes:number):{files:UploadBatchFile[];total:number}{
  if(!Array.isArray(input.files)||input.files.length<1)throw new Error('upload_batch_invalid');
  if(input.files.length>UPLOAD_BATCH_MAX_FILES)throw new Error('upload_batch_limit_exceeded');
  const ids=new Set<string>(),paths=new Set<string>();let total=0;
  const files=input.files.map((value):UploadBatchFile=>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('upload_batch_invalid');
    const file=value as Record<string,unknown>,clientFileId=String(file.client_file_id??''),fileName=String(file.file_name??''),relativePath=String(file.relative_path??''),mediaType=String(file.media_type??''),size=Number(file.size_bytes),sha256=String(file.sha256??'');
    if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(clientFileId)||ids.has(clientFileId))throw new Error('upload_batch_invalid');
    if(!fileName||fileName.length>255||fileName==='.'||fileName==='..'||/[\\/\u0000-\u001f\u007f]/.test(fileName))throw new Error('upload_batch_invalid');
    const parts=relativePath.split('/'),pathKey=relativePath.toLowerCase();
    if(!relativePath||relativePath.length>1024||/^[A-Za-z]:/.test(relativePath)||parts.some(part=>!part||part==='.'||part==='..'||part.length>255||/[\\\u0000-\u001f\u007f]/.test(part))||parts.at(-1)!==fileName||paths.has(pathKey))throw new Error('upload_batch_invalid');
    if(!Number.isSafeInteger(size)||size<1||size>maxBytes)throw new Error('upload_size_invalid');
    if(!mediaType||mediaType.length>255||/[\u0000-\u001f\u007f]/.test(mediaType))throw new Error('upload_batch_invalid');
    if(!/^[a-f0-9]{64}$/.test(sha256))throw new Error('upload_sha256_invalid');
    ids.add(clientFileId);paths.add(pathKey);total+=size;
    return {client_file_id:clientFileId,file_name:fileName,relative_path:relativePath,media_type:mediaType,size_bytes:size,sha256};
  });
  if(total>UPLOAD_BATCH_MAX_BYTES)throw new Error('upload_batch_limit_exceeded');
  return {files,total};
}

function rejectTaskOutputSymlinks(path:string):void {
  let current=resolve(path);
  for(;;){if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error('task_output_path_unsafe');const parent=dirname(current);if(parent===current)return;current=parent;}
}

export class ArtifactService {
  private readonly channelFinalizing=new Set<string>();
  private readonly db: DatabaseSync;
  private readonly root: string;
  private readonly incomingRoot: string;
  private readonly activeUploadWriters = new Map<string, () => void>();
  private readonly uploadRoot: string;
  private readonly generatedRoot: string;
  private readonly editedRoot: string;
  private readonly maxBytes: number;
  constructor(db: DatabaseSync, root: string, maxBytes = 104857600) {
    this.db = db; this.root = root; this.maxBytes = maxBytes;
    this.incomingRoot = join(root, 'incoming');
    this.uploadRoot = join(root, 'ready', 'uploads');
    this.generatedRoot = join(root, 'ready', 'generated');
    this.editedRoot = join(root, 'ready', 'edited');
    for (const directory of [root, this.incomingRoot, this.uploadRoot, this.generatedRoot, this.editedRoot,
      join(root, 'sessions'), join(root, 'restore-cache'), join(root, 'quarantine')]) {
      mkdirSync(directory, { recursive: true });
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ga_artifact_history ON ga_artifacts(conversation_id,created_at,id);
      CREATE TRIGGER IF NOT EXISTS ga_task_output_no_identity_update BEFORE UPDATE ON ga_artifacts
      WHEN OLD.kind='task_output_file' AND (NEW.id!=OLD.id OR NEW.owner_id!=OLD.owner_id OR NEW.conversation_id!=OLD.conversation_id OR NEW.kind!=OLD.kind OR NEW.current_version!=OLD.current_version)
      BEGIN SELECT RAISE(ABORT,'task_output_artifact_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ga_task_output_no_content_update BEFORE UPDATE ON ga_artifact_versions
      WHEN EXISTS(SELECT 1 FROM ga_artifacts a WHERE a.id=OLD.artifact_id AND a.kind='task_output_file')
       AND (NEW.artifact_id!=OLD.artifact_id OR NEW.version!=OLD.version OR NEW.server_path!=OLD.server_path OR NEW.sha256!=OLD.sha256 OR NEW.size_bytes!=OLD.size_bytes OR NEW.mime_type!=OLD.mime_type
        OR json_extract(NEW.metadata_json,'$.file_name') IS NOT json_extract(OLD.metadata_json,'$.file_name')
        OR json_extract(NEW.metadata_json,'$.origin') IS NOT json_extract(OLD.metadata_json,'$.origin')
        OR json_extract(NEW.metadata_json,'$.task_file') IS NOT json_extract(OLD.metadata_json,'$.task_file'))
      BEGIN SELECT RAISE(ABORT,'task_output_artifact_immutable'); END;`);
  }

  usesDatabase(db: DatabaseSync): boolean { return this.db === db; }

  /** Durable reservation in original ga_uploads; no conversation/artifact yet. */
  reserveChannelUploadBatch(input:unknown){
    if(!this.db.isTransaction)throw Error('channel_authority_transaction_required');
    const {source}=normalizeChannelAttachmentManifestV2(input),key=channelUploadStageKeyV2(source.event),requestHash=channelStageRequestDigestV2(source);
    const previous=this.readChannelUploadBatch(key);
    if(previous){
      if(previous.request_sha256!==requestHash||canonicalJson(previous.source)!==canonicalJson(source))throw Object.assign(Error('channel_attachment_event_conflict'),{statusCode:409});
      if(previous.state==='expired'||previous.state!=='finalized'&&Date.parse(previous.expires_at)<=Date.now())throw Error('channel_attachment_stage_expired');
      return previous;
    }
    const now=new Date().toISOString(),expires=new Date(Date.now()+3600000).toISOString();
    for(const part of source.attachments){
      const id=channelUploadIdV2(key,requestHash,part.index);
      if(part.artifact_id!==channelUploadArtifactIdV2(id))throw Error('channel_attachment_stage_invalid');
      this.db.prepare(`INSERT INTO ga_uploads(id,conversation_id,owner_id,status,server_path,filename,declared_size,declared_sha256,mime_type,created_at,
        channel_stage_key,channel_request_sha256,channel_source_json,channel_part_index,channel_expires_at)
        VALUES(?,NULL,?,'created',?,?,?,?,?,?,?,?,?,?,?)`).run(id,source.owner_id,join(this.incomingRoot,id+'.part'),part.file_name,part.size_bytes,part.sha256,part.media_type,now,key,requestHash,canonicalJson(source),part.index,expires);
    }
    return this.readChannelUploadBatch(key)!;
  }

  readChannelUploadBatch(key:string){
    if(typeof key!=='string'||!/^channel-stage-[a-f0-9]{64}$/.test(key))throw Error('channel_attachment_stage_invalid');
    const rows=this.db.prepare('SELECT * FROM ga_uploads WHERE channel_stage_key=? ORDER BY channel_part_index').all(key);
    if(!rows.length)return undefined;
    const first=rows[0]!,source=normalizeChannelAttachmentManifestV2(JSON.parse(String(first.channel_source_json))).source;
    const requestHash=channelStageRequestDigestV2(source),sourceJson=canonicalJson(source),expires=String(first.channel_expires_at);
    if(channelUploadStageKeyV2(source.event)!==key||rows.length!==source.attachments.length||!Number.isFinite(Date.parse(expires)))throw Error('channel_attachment_stage_unproven');
    const parts=source.attachments.map((part,index)=>{
      const row=rows[index]!,id=channelUploadIdV2(key,requestHash,index);
      if(row.id!==id||row.owner_id!==source.owner_id||row.channel_part_index!==index||row.channel_request_sha256!==requestHash||row.channel_source_json!==sourceJson||row.channel_expires_at!==expires
        ||row.filename!==part.file_name||row.declared_size!==part.size_bytes||row.declared_sha256!==part.sha256||row.mime_type!==part.media_type||part.artifact_id!==channelUploadArtifactIdV2(id)
        ||row.conversation_id!==null&&row.conversation_id!==source.conversation_id||!['created','uploading','uploaded','completed','expired','expired_clean'].includes(String(row.status)))throw Error('channel_attachment_stage_unproven');
      return Object.freeze({...part,upload_id:id});
    });
    const completed=rows.filter(row=>row.status==='completed').length;
    if(completed&&completed!==rows.length)throw Error('channel_attachment_stage_unproven');
    const expired=rows.filter(row=>row.status==='expired'||row.status==='expired_clean').length;if(expired&&expired!==rows.length)throw Error('channel_attachment_stage_unproven');
    const state=expired?'expired' as const:completed===rows.length?'finalized' as const:rows.every(row=>row.status==='uploaded')?'staged' as const:'staging' as const;
    return Object.freeze({protocol:2 as const,state,stage_key:key,request_sha256:requestHash,manifest_sha256:channelAttachmentManifestDigestV2(source),source,parts:Object.freeze(parts),expires_at:expires});
  }

  async writeChannelUploadPart(key:string,index:number,content:AsyncIterable<Uint8Array>,signal?:AbortSignal){
    const stage=this.readChannelUploadBatch(key);
    if(!stage||!Number.isSafeInteger(index)||!stage.parts[index]||stage.state==='finalized'||stage.state==='expired'||Date.parse(stage.expires_at)<=Date.now())throw Error('channel_attachment_stage_unavailable');
    const part=stage.parts[index]!,row=this.upload(part.upload_id,stage.source.owner_id);
    const stream=(async function*(){for await(const bytes of content){signal?.throwIfAborted();yield bytes;}signal?.throwIfAborted();})();
    if(row.status==='uploaded'){
      let size=0;const hash=createHash('sha256');for await(const chunk of stream){size+=chunk.length;if(size>part.size_bytes)throw Error('upload_size_mismatch');hash.update(chunk);}
      if(size!==part.size_bytes||hash.digest('hex')!==part.sha256)throw Error('upload_sha256_mismatch');return;
    }
    await this.writeContent(part.upload_id,stage.source.owner_id,stream,()=>{
      if(this.upload(part.upload_id,stage.source.owner_id).actual_sha256!==part.sha256)throw Error('upload_sha256_mismatch');
    });
  }

  /** Verify all original upload files before creating any admission objects. */
  prepareChannelUploadBatch(key:string,signal?:AbortSignal){
    if(this.db.isTransaction)throw Error('attachment_verification_transaction_forbidden');
    const stage=this.readChannelUploadBatch(key);
    if(!stage||stage.state!=='staged')throw Error('channel_attachment_batch_incomplete');
    if(Date.parse(stage.expires_at)<=Date.now())throw Error('channel_attachment_stage_expired');
    for(const part of stage.parts){
      signal?.throwIfAborted();const row=this.upload(part.upload_id,stage.source.owner_id),finalPath=join(this.uploadRoot,part.artifact_id),path=existsSync(finalPath)?finalPath:String(row.server_path);
      const same=(a:string,b:string)=>process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b);
      if(!same(path,finalPath)&&!same(dirname(path),this.incomingRoot))throw Error('channel_attachment_stage_path_invalid');
      rejectTaskOutputSymlinks(path);const stat=lstatSync(path);
      if(!stat.isFile()||stat.size!==part.size_bytes||row.received_size!==part.size_bytes||row.actual_sha256!==part.sha256)throw Error('upload_content_mismatch');
      const bytes=readFileSync(path);if(bytes.length!==part.size_bytes||createHash('sha256').update(bytes).digest('hex')!==part.sha256)throw Error('upload_content_mismatch');
      if(detectContentType(path,part.media_type).mediaType!==part.media_type)throw Error('channel_attachment_media_mismatch');
    }
    signal?.throwIfAborted();return stage;
  }

  /** Original complete() calls are nested in the caller's single admission txn.
   * Its stable rename mapping also recovers files moved before a DB rollback. */
  finalizeChannelUploadBatch(key:string,conversationId:string){
    if(!this.db.isTransaction)throw Error('channel_authority_transaction_required');
    const stage=this.readChannelUploadBatch(key);
    if(!stage||stage.state!=='staged'||stage.source.conversation_id!==conversationId||Date.parse(stage.expires_at)<=Date.now())throw Error('channel_attachment_batch_incomplete');
    for(const part of stage.parts){
      this.db.prepare('UPDATE ga_uploads SET conversation_id=? WHERE id=? AND conversation_id IS NULL').run(conversationId,part.upload_id);
      this.channelFinalizing.add(part.upload_id);
      try{
        const result=this.complete(part.upload_id,stage.source.owner_id,{sha256:part.sha256});
        if(result.artifact_id!==part.artifact_id||result.sha256!==part.sha256||result.size_bytes!==part.size_bytes||result.media_type!==part.media_type)throw Error('channel_attachment_stage_unproven');
      }finally{this.channelFinalizing.delete(part.upload_id);}
    }
    return stage.source;
  }

  /** Bounded original-upload retention. Keep immutable expired rows as source
   * tombstones; delete only unregistered, fenced batch bytes under own roots. */
  cleanupExpiredChannelUploads(limit=20,now=Date.now()){
    if(this.db.isTransaction||!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isFinite(now))throw Error('channel_attachment_cleanup_invalid');
    const cutoff=new Date(now).toISOString(),retry=new Date(now+60000).toISOString(),keys=this.db.prepare("SELECT DISTINCT channel_stage_key FROM ga_uploads WHERE channel_stage_key IS NOT NULL AND channel_expires_at<=? AND status NOT IN('completed','expired_clean') AND (channel_cleanup_after IS NULL OR channel_cleanup_after<=?) ORDER BY channel_stage_key LIMIT ?").all(cutoff,cutoff,limit);
    let expired=0,removed=0,blocked=0;
    for(const row of keys){
      let files:string[];
      try{files=withImmediateTransaction(this.db,()=>{
        const key=String(row.channel_stage_key),stage=this.readChannelUploadBatch(key);if(!stage||stage.state==='finalized')return[];
        if(this.db.prepare("SELECT 1 FROM ga_uploads WHERE channel_stage_key=? AND status='uploading' AND writer_lease_until>? LIMIT 1").get(key,cutoff))throw Error('channel_attachment_cleanup_writer_live');
        const event=stage.source.event;
        if(this.db.prepare('SELECT 1 FROM ga_channel_message_events WHERE channel=? AND principal=? AND provider_thread_id=? AND provider_message_id=?').get(event.channel,event.principal,event.thread_id,event.message_id))throw Error('channel_attachment_cleanup_admission_observed');
        const candidates:string[]=[];
        for(const part of stage.parts){
          if(this.db.prepare('SELECT 1 FROM ga_artifacts WHERE id=?').get(part.artifact_id))throw Error('channel_attachment_cleanup_artifact_observed');
          const upload=this.upload(part.upload_id,stage.source.owner_id),incoming=resolve(String(upload.server_path)),final=resolve(this.uploadRoot,part.artifact_id);
          const same=(a:string,b:string)=>process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b);
          if(!same(dirname(incoming),this.incomingRoot)&&!same(incoming,final))throw Error('channel_attachment_stage_path_invalid');
          candidates.push(incoming,final);
        }
        this.db.prepare("UPDATE ga_uploads SET status='expired',writer_token=NULL,writer_lease_until=NULL WHERE channel_stage_key=?").run(key);
        if(stage.state!=='expired')expired++;return [...new Set(candidates)];
      });}catch{blocked++;this.db.prepare("UPDATE ga_uploads SET channel_cleanup_after=? WHERE channel_stage_key=? AND status<>'completed'").run(retry,String(row.channel_stage_key));continue;}
      let failed=false;
      for(const path of files){try{if(!existsSync(path))continue;rejectTaskOutputSymlinks(path);if(!lstatSync(path).isFile())throw Error('channel_attachment_stage_path_invalid');unlinkSync(path);removed++;}catch{blocked++;failed=true;}}
      if(failed)this.db.prepare("UPDATE ga_uploads SET channel_cleanup_after=? WHERE channel_stage_key=? AND status='expired'").run(retry,String(row.channel_stage_key));
      else this.db.prepare("UPDATE ga_uploads SET status='expired_clean',channel_cleanup_after=NULL WHERE channel_stage_key=? AND status='expired'").run(String(row.channel_stage_key));
    }
    return Object.freeze({protocol:2 as const,expired_batches:expired,removed_files:removed,blocked});
  }

  /** Existing exact-version snapshot primitive, not a durable upload reservation.
   * Own transient lease and unlinked byte descriptors remain live until dispose. */
  async snapshotPinnedInput(ownerId:string,conversationId:string,manifest:unknown,signal?:AbortSignal){
    if(this.db.isTransaction)throw Error('attachment_verification_transaction_forbidden');
    if(!this.db.prepare('SELECT 1 FROM ga_conversations WHERE id=? AND owner_id=?').get(conversationId,ownerId))throw Error('conversation_not_found');
    const resolver=new AttachmentResolver(this.db,this.root),lease=`channel-v2-snapshot-${randomUUID()}`;
    try{
      const snapshot=await resolver.snapshotPinnedForMessage(ownerId,conversationId,manifest,lease,this.incomingRoot,signal);
      return Object.freeze({manifest:snapshot.manifest,sources:snapshot.sources,async dispose(){
        try{await snapshot.dispose();}finally{resolver.releaseLease(lease);}
      }});
    }catch(error){resolver.releaseLease(lease);throw error;}
  }

  /** Copies only a trusted task write receipt's exact UTF8 bytes. Publication
   * is still the caller's separate business/Goal transaction, never this API. */
  registerTaskFileVersion(input:{runId:string;receiptId:string;content:string;deliveryRunId?:string;location?:TaskFileLocation}):ReturnType<ArtifactService['get']>{
    if(!this.db.isTransaction)throw new Error('task_output_transaction_required');
    let source=this.db.prepare(`SELECT e.*,r.conversation_id,'workspace' AS source FROM wb_task_file_execution_receipts e
      JOIN ga_runs r ON r.id=e.run_id JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=e.owner_id
      JOIN wb_task_run_occurrences o ON o.run_id=e.run_id
      JOIN wb_file_versions v ON v.owner_id=e.owner_id AND v.workspace_id=e.workspace_id AND v.project_id=e.project_id
       AND v.path=e.path AND v.version=e.version AND v.sha256=e.sha256 AND v.size=e.size
      WHERE e.run_id=? AND e.receipt_id=?`).get(input.runId,input.receiptId) as Record<string,string|number>|undefined;
    if(input.deliveryRunId!==undefined){
      const frozen=this.db.prepare('SELECT snapshot_json FROM wb_task_completion_candidates WHERE run_id=?').get(input.deliveryRunId) as {snapshot_json:string}|undefined;
      if(!frozen)throw new Error('task_output_source_unverified');
      const scope=JSON.parse(frozen.snapshot_json) as TaskFileScope&{workspace_file_outputs?:Array<Record<string,unknown>>;file_outputs?:Array<Record<string,unknown>>};
      const native=taskFileSource(this.db,scope,input.receiptId,input.deliveryRunId),pin=[...(scope.workspace_file_outputs??[]),...(scope.file_outputs??[])].find(output=>output.receipt_id===input.receiptId);
      if(!native||(!native.native&&native.source!=='isolated')||native.run_id!==input.runId||!pin?.verified||pin.content_verified!==true||pin.path!==native.path||pin.version!==native.version||pin.sha256!==native.sha256||pin.size!==native.size
        ||(pin.source===undefined?native.source!=='workspace':pin.source!==native.source)
        ||(native.source==='isolated'&&(pin.cycle_id!==native.cycle_id||pin.snapshot_id!==native.snapshot_id||pin.isolated_receipt_id!==native.isolated_receipt_id)))throw new Error('task_output_source_unverified');
      const {native:kind,...value}=native;source=value;
      if(native.source==='isolated'){
        const stored=readIsolatedTaskFileVersion(this.db,native);
        if(stored.content!==input.content)throw new Error('task_output_content_mismatch');
      }
    }
    if(!source)throw new Error('task_output_source_unverified');
    if(source.source==='isolated'&&!input.location)throw new Error('task_output_source_unverified');
    if(input.location&&!sameTaskFileLocation(input.location,source as unknown as TaskFileLocation))throw new Error('task_output_source_unverified');
    if(typeof input.content!=='string')throw new Error('task_output_content_mismatch');
    const raw=Buffer.from(input.content,'utf8'),digest=createHash('sha256').update(raw).digest('hex');
    if(digest!==source.sha256||raw.length!==source.size)throw new Error('task_output_content_mismatch');
    const identity=source.source==='isolated'?JSON.stringify(['task-isolated-file',input.deliveryRunId,input.runId,input.receiptId,source.cycle_id,source.snapshot_id,source.isolated_receipt_id]):input.deliveryRunId===undefined?`task-file:${input.runId}:${input.receiptId}`:`task-native-file:${input.deliveryRunId}:${input.runId}:${input.receiptId}`;
    const id=`artifact-${createHash('sha256').update(identity).digest('hex').slice(0,32)}`;
    const taskFile={...(source.source==='isolated'?{source:'isolated',cycle_id:source.cycle_id,snapshot_id:source.snapshot_id,isolated_receipt_id:source.isolated_receipt_id}:{}),run_id:input.runId,receipt_id:input.receiptId,path:source.path,version:source.version,sha256:digest,...(input.deliveryRunId===undefined?{}:{delivery_run_id:input.deliveryRunId})};
    const prior=this.db.prepare('SELECT * FROM ga_artifacts WHERE id=?').get(id) as Record<string,unknown>|undefined;
    if(prior){
      if(prior.owner_id!==source.owner_id||prior.conversation_id!==source.conversation_id||prior.kind!=='task_output_file'||prior.current_version!==1)throw new Error('task_output_artifact_conflict');
      const stored=this.db.prepare('SELECT sha256,size_bytes,metadata_json FROM ga_artifact_versions WHERE artifact_id=? AND version=1').get(id) as {sha256:string;size_bytes:number;metadata_json:string}|undefined;
      let metadata:Record<string,unknown>|undefined;
      try{metadata=JSON.parse(stored?.metadata_json??'null') as Record<string,unknown>;}catch{throw new Error('task_output_artifact_conflict');}
      const saved=metadata?.task_file;
      if(!stored||stored.sha256!==digest||stored.size_bytes!==raw.length||!saved||typeof saved!=='object'||Array.isArray(saved)
        ||Object.keys(saved).length!==Object.keys(taskFile).length||Object.entries(taskFile).some(([key,value])=>(saved as Record<string,unknown>)[key]!==value))throw new Error('task_output_artifact_conflict');
      this.download(id,String(source.owner_id),1);return this.get(id,String(source.owner_id),1);
    }
    const directory=join(this.generatedRoot,id),destination=join(directory,'version-1.data');
    rejectTaskOutputSymlinks(destination);mkdirSync(directory,{recursive:true,mode:0o700});rejectTaskOutputSymlinks(destination);
    if(existsSync(destination)){
      const previous=readFileSync(destination);if(previous.length!==raw.length||createHash('sha256').update(previous).digest('hex')!==digest)throw new Error('task_output_content_mismatch');
    }else{
      const pending=join(directory,`pending-${randomUUID()}.data`);
      try{writeFileSync(pending,raw,{flag:'wx',mode:0o600});renameSync(pending,destination);}finally{if(existsSync(pending))unlinkSync(pending);}
    }
    const now=new Date().toISOString(),name=basename(String(source.path)),mime=name.endsWith('.md')?'text/markdown':'text/plain';
    this.db.prepare('INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id,source.conversation_id!,source.owner_id!,'task_output_file',1,now,now);
    this.db.prepare('INSERT INTO ga_artifact_versions VALUES(?,?,?,?,?,?,?,?)').run(id,1,destination,digest,raw.length,mime,
      JSON.stringify({file_name:name,status:'ready',origin:'generated',preview_kind:'text',task_file:taskFile}),now);
    this.db.prepare('INSERT INTO ga_artifact_archives(artifact_id,backup_status,local_state,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(id,'pending','present',now,now,now);
    return this.get(id,String(source.owner_id),1);
  }

  /** Materialize one reviewed binary part. Group hashes are never used as
   * individual file hashes. Caller commits message/link/event in the same TX. */
  registerTaskGeneratedPart(input:{owner:string;runId:string;artifactId:string;version:number;partIndex:number}):ReturnType<ArtifactService['get']>{
    if(!this.db.isTransaction)throw new Error('task_output_transaction_required');
    const source=this.readProducedGroup(input.owner,input.runId,input.artifactId,input.version);
    const part=source.parts.find(value=>value.part_index===input.partIndex);if(!part)throw new Error('task_output_source_unverified');
    const id=`artifact-${createHash('sha256').update(`task-generated:${input.runId}:${input.artifactId}:${input.version}:${input.partIndex}`).digest('hex').slice(0,32)}`;
    const prior=this.db.prepare('SELECT * FROM ga_artifacts WHERE id=?').get(id) as Record<string,unknown>|undefined;
    if(prior){
      if(prior.owner_id!==input.owner||prior.conversation_id!==source.conversation_id||prior.kind!=='task_output_file'||prior.current_version!==1)throw new Error('task_output_artifact_conflict');
      this.download(id,input.owner,1);return this.get(id,input.owner,1);
    }
    const directory=join(this.generatedRoot,id),destination=join(directory,'version-1.data');
    rejectTaskOutputSymlinks(destination);mkdirSync(directory,{recursive:true,mode:0o700});rejectTaskOutputSymlinks(destination);
    if(existsSync(destination)){
      const previous=readFileSync(destination);if(previous.length!==part.size_bytes||createHash('sha256').update(previous).digest('hex')!==part.sha256)throw new Error('task_output_content_mismatch');
    }else{
      const pending=join(directory,`pending-${randomUUID()}.data`);
      try{writeFileSync(pending,part.content,{flag:'wx',mode:0o600});renameSync(pending,destination);}finally{if(existsSync(pending))unlinkSync(pending);}
    }
    const now=new Date().toISOString();
    this.db.prepare('INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id,source.conversation_id,input.owner,'task_output_file',1,now,now);
    this.db.prepare('INSERT INTO ga_artifact_versions VALUES(?,?,?,?,?,?,?,?)').run(id,1,destination,part.sha256,part.size_bytes,part.mime_type,
      JSON.stringify({file_name:part.display_name,status:'ready',origin:'generated',preview_kind:part.mime_type.startsWith('text/')?'text':'unsupported',task_file:{run_id:input.runId,artifact_id:input.artifactId,version:input.version,part_index:input.partIndex,sha256:part.sha256}}),now);
    this.db.prepare('INSERT INTO ga_artifact_archives(artifact_id,backup_status,local_state,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(id,'pending','present',now,now,now);
    return this.get(id,input.owner,1);
  }

  registerEditedVersion(input: { artifactId: string; ownerId: string; conversationId: string;
    baseVersion: number; baseSha256: string; sourcePath: string; displayName?: string;
    engine: Record<string, unknown>; checks: Record<string, unknown>; warnings?: string[] }): Record<string, unknown> {
    const artifact = this.db.prepare(`SELECT a.current_version,v.sha256,v.mime_type,v.metadata_json
      FROM ga_artifacts a JOIN ga_artifact_versions v ON v.artifact_id=a.id AND v.version=a.current_version
      WHERE a.id=? AND a.owner_id=? AND a.conversation_id=?`).get(
        input.artifactId, input.ownerId, input.conversationId) as Record<string, unknown> | undefined;
    if (!artifact) throw new Error('UNAUTHORIZED_FILE');
    if (Number(artifact.current_version) !== input.baseVersion || String(artifact.sha256) !== input.baseSha256) {
      throw new Error('STALE_FILE_VERSION');
    }
    if (!existsSync(input.sourcePath)) throw new Error('OUTPUT_CHECK_FAILED');
    const raw = readFileSync(input.sourcePath); if (!raw.length || raw.length > this.maxBytes) throw new Error('OUTPUT_CHECK_FAILED');
    const detected = detectContentType(input.sourcePath, String(artifact.mime_type));
    if (detected.kind !== 'document') throw new Error('OUTPUT_CHECK_FAILED');
    const outputSha256 = createHash('sha256').update(raw).digest('hex');
    const version = input.baseVersion + 1; const now = new Date().toISOString();
    const directory = join(this.editedRoot, input.artifactId); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const extension = detected.mediaType === 'application/pdf' ? '.pdf'
      : detected.mediaType.includes('spreadsheetml') ? '.xlsx'
      : detected.mediaType.includes('ms-excel') ? '.xls' : '.docx';
    const destination = join(directory, `version-${version}${extension}`);
    copyFileSync(input.sourcePath, destination);
    const previous = JSON.parse(String(artifact.metadata_json || '{}')) as Record<string, unknown>;
    const metadata = { ...previous, status: 'ready', origin: 'file_engine',
      file_name: basename(input.displayName || `${String(previous.file_name || input.artifactId)}-v${version}${extension}`),
      base_version: input.baseVersion, engine: input.engine, checks: input.checks, warnings: input.warnings ?? [] };
    try {
      withImmediateTransaction(this.db, () => {
        const current = this.db.prepare('SELECT current_version FROM ga_artifacts WHERE id=?').get(input.artifactId) as { current_version: number };
        if (Number(current.current_version) !== input.baseVersion) throw new Error('STALE_FILE_VERSION');
        this.db.prepare(`INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(input.artifactId, version, destination, outputSha256, raw.length,
            detected.mediaType, JSON.stringify(metadata), now);
        this.db.prepare('UPDATE ga_artifacts SET current_version=?,updated_at=? WHERE id=? AND current_version=?')
          .run(version, now, input.artifactId, input.baseVersion);
        this.db.prepare(`UPDATE ga_artifact_archives SET backup_status='pending',local_state='present',last_used_at=?,updated_at=?
          WHERE artifact_id=?`).run(now, now, input.artifactId);
      });
    } catch (error) { try { unlinkSync(destination); } catch {} throw error; }
    return { artifact_ref: input.artifactId, version, sha256: outputSha256, size_bytes: raw.length,
      media_type: detected.mediaType, checks: input.checks };
  }

  listForRun(runId: string, ownerId: string): { items: Record<string, unknown>[] } {
    const run = this.db.prepare(`SELECT r.id FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
      WHERE r.id=? AND c.owner_id=?`).get(runId, ownerId);
    if (!run) throw new Error('run_not_found');
    const items = this.db.prepare(`SELECT ra.run_id,a.conversation_id,ra.artifact_id,ra.version,ra.created_at,
      v.sha256,v.size_bytes,v.mime_type,v.metadata_json,COALESCE(ar.local_state,'present') local_state,
      COALESCE(ar.backup_status,'pending') backup_status
      FROM ga_run_artifacts ra
      JOIN ga_artifacts a ON a.id=ra.artifact_id
      JOIN ga_artifact_versions v ON v.artifact_id=ra.artifact_id AND v.version=ra.version
      LEFT JOIN ga_artifact_archives ar ON ar.artifact_id=ra.artifact_id
      WHERE ra.run_id=? ORDER BY ra.created_at,ra.artifact_id,ra.version`).all(runId).map((row: any) => {
        const metadata = JSON.parse(String(row.metadata_json || '{}'));
        return { run_id: row.run_id, conversation_id: row.conversation_id,
          artifact_id: row.artifact_id, version: Number(row.version),
          file_name: metadata.file_name || row.artifact_id, media_type: row.mime_type,
          size_bytes: Number(row.size_bytes), sha256: row.sha256, status: metadata.status || 'ready',
          local_state: row.local_state, backup_status: row.backup_status, created_at: row.created_at,
          download_url: `/v1/artifacts/${row.artifact_id}/download?version=${row.version}` };
      });
    return { items };
  }

  registerBrowserScreenshot(input:{ownerId:string;runId:string;callId:string;artifactId:string;content:Buffer;sha256:string}){
    if(!this.db.isTransaction)throw Error('browser_artifact_transaction_required');
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.artifactId)
      ||!Buffer.isBuffer(input.content)||input.content.length<8||input.content.length>1048576
      ||!input.content.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      ||createHash('sha256').update(input.content).digest('hex')!==input.sha256)throw Error('browser_artifact_invalid');
    const run=this.db.prepare('SELECT r.conversation_id FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=? AND c.owner_id=?')
      .get(input.runId,input.ownerId) as {conversation_id:string}|undefined;
    if(!run)throw Error('run_not_found');
    const runtimeRef='browser-screenshot:'+createHash('sha256').update(JSON.stringify([input.runId,input.callId])).digest('hex');
    const prior=this.db.prepare(`SELECT a.id,a.owner_id,a.conversation_id,a.runtime_ref,v.sha256,v.size_bytes,v.server_path FROM ga_artifacts a
      JOIN ga_artifact_versions v ON v.artifact_id=a.id AND v.version=1 WHERE a.id=? OR a.runtime_ref=?`).all(input.artifactId,runtimeRef) as Array<Record<string,unknown>>;
    const directory=join(this.generatedRoot,input.artifactId),destination=join(directory,'version-1.png');
    rejectTaskOutputSymlinks(destination);
    if(prior.length){
      const item=prior[0]!;
      if(prior.length!==1||item.id!==input.artifactId||item.owner_id!==input.ownerId||item.conversation_id!==run.conversation_id
        ||item.runtime_ref!==runtimeRef||item.sha256!==input.sha256||Number(item.size_bytes)!==input.content.length||item.server_path!==destination
        ||!this.db.prepare('SELECT 1 FROM ga_run_artifacts WHERE run_id=? AND artifact_id=? AND version=1').get(input.runId,input.artifactId))throw Error('browser_artifact_conflict');
      const bytes=readFileSync(destination);
      if(bytes.length!==input.content.length||createHash('sha256').update(bytes).digest('hex')!==input.sha256)throw Error('browser_artifact_content_changed');
      return this.get(input.artifactId,input.ownerId,1);
    }
    mkdirSync(directory,{recursive:true,mode:0o700});rejectTaskOutputSymlinks(destination);
    if(existsSync(destination)){
      const bytes=readFileSync(destination);
      if(bytes.length!==input.content.length||createHash('sha256').update(bytes).digest('hex')!==input.sha256)throw Error('browser_artifact_content_changed');
    }else{
      const pending=join(directory,'pending-'+randomUUID()+'.png');
      try{writeFileSync(pending,input.content,{flag:'wx',mode:0o600});renameSync(pending,destination);}finally{if(existsSync(pending))unlinkSync(pending);}
    }
    const now=new Date().toISOString();
    this.db.prepare('INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,runtime_ref,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?)')
      .run(input.artifactId,run.conversation_id,input.ownerId,'browser_screenshot',runtimeRef,now,now);
    this.db.prepare('INSERT INTO ga_artifact_versions VALUES(?,1,?,?,?,?,?,?)').run(input.artifactId,destination,input.sha256,input.content.length,'image/png',
      JSON.stringify({file_name:'browser-screenshot.png',status:'ready',origin:'generated',preview_kind:'image'}),now);
    this.db.prepare('INSERT INTO ga_artifact_archives(artifact_id,backup_status,local_state,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(input.artifactId,'pending','present',now,now,now);
    this.db.prepare('INSERT INTO ga_run_artifacts VALUES(?, ?,1,?)').run(input.runId,input.artifactId,now);
    return this.get(input.artifactId,input.ownerId,1);
  }

  registerTemplateInstance(input: { ownerId: string; conversationId: string; callId: string;
    templateId: string; templateVersion: string; templateSha256: string; format: 'docx' | 'xlsx'; sourcePath: string }): Record<string, unknown> {
    if (!this.db.prepare('SELECT 1 FROM ga_conversations WHERE id=? AND owner_id=?')
      .get(input.conversationId, input.ownerId)) throw new Error('conversation_not_found');
    const artifactId = `artifact-${createHash('sha256').update(
      `template:${input.ownerId}:${input.conversationId}:${input.callId}`
    ).digest('hex').slice(0, 32)}`;
    const existing = this.db.prepare('SELECT id FROM ga_artifacts WHERE id=? AND owner_id=? AND conversation_id=?')
      .get(artifactId, input.ownerId, input.conversationId) as { id?: string } | undefined;
    if (existing?.id) return this.get(existing.id, input.ownerId, 1);
    const raw = readFileSync(input.sourcePath);
    const digest = createHash('sha256').update(raw).digest('hex');
    if (digest !== input.templateSha256) throw new Error('TEMPLATE_HASH_MISMATCH');
    const mediaType = input.format === 'docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const directory = join(this.generatedRoot, artifactId); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = join(directory, `version-1.${input.format}`); copyFileSync(input.sourcePath, destination);
    const now = new Date().toISOString();
    const metadata = { file_name: `${input.templateId}.${input.format}`, status: 'ready', origin: 'trusted_template',
      template_id: input.templateId, template_version: input.templateVersion, preview_kind: 'unsupported' };
    try {
      withImmediateTransaction(this.db, () => {
        this.db.prepare('INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
          .run(artifactId, input.conversationId, input.ownerId, 'template_instance', 1, now, now);
        this.db.prepare('INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(artifactId, 1, destination, digest, raw.length, mediaType, JSON.stringify(metadata), now);
        this.db.prepare('INSERT INTO ga_artifact_archives(artifact_id,backup_status,local_state,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
          .run(artifactId, 'pending', 'present', now, now, now);
      });
    } catch (error) { try { unlinkSync(destination); } catch {} throw error; }
    return this.get(artifactId, input.ownerId, 1);
  }

  initUpload(conversationId: string, ownerId: string, input: Record<string, unknown>) {
    const filename=basename(String(input.file_name||'').replaceAll('\\','/'));
    if(!filename||filename==='.'||filename==='..')throw new Error('upload_filename_invalid');
    const receipt=this.initUploadBatch(conversationId,ownerId,{files:[{client_file_id:'legacy-file',file_name:filename,
      relative_path:String(input.relative_path||filename),media_type:String(input.media_type||''),size_bytes:input.size_bytes,sha256:input.sha256}]});
    return {upload_id:receipt.files[0]!.upload_id,expires_at:receipt.expires_at,max_bytes:this.maxBytes};
  }

  initUploadBatch(conversationId:string,ownerId:string,input:Record<string,unknown>){
    const {files,total}=uploadBatchFiles(input,this.maxBytes);
    return withImmediateTransaction(this.db,()=>{
      if(!this.db.prepare('SELECT 1 FROM ga_conversations WHERE id=? AND owner_id=?').get(conversationId,ownerId))throw new Error('conversation_not_found');
      const now=new Date(),createdAt=now.toISOString(),expiresAt=new Date(now.getTime()+UPLOAD_RETENTION_MS).toISOString();
      const active=Number((this.db.prepare(`SELECT count(*) n FROM ga_upload_batches WHERE owner_id=? AND conversation_id=?
        AND status='active' AND expires_at>?`).get(ownerId,conversationId,createdAt) as {n:number}).n);
      if(active>=UPLOAD_BATCH_MAX_ACTIVE)throw new Error('upload_batch_concurrency_limit');
      const batchId=`upload-batch-${randomUUID()}`;
      this.db.prepare('INSERT INTO ga_upload_batches(id,conversation_id,owner_id,status,manifest_json,total_size,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(batchId,conversationId,ownerId,'active',JSON.stringify(files),total,createdAt,expiresAt);
      const insert=this.db.prepare(`INSERT INTO ga_uploads(id,conversation_id,owner_id,status,server_path,filename,declared_size,declared_sha256,mime_type,created_at,
        batch_id,client_file_id,relative_path,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const receipts=files.map(file=>{
        const uploadId=`upload-${randomUUID()}`;
        insert.run(uploadId,conversationId,ownerId,'created',join(this.incomingRoot,`${uploadId}.part`),file.file_name,file.size_bytes,file.sha256,file.media_type,createdAt,
          batchId,file.client_file_id,file.relative_path,expiresAt);
        return {client_file_id:file.client_file_id,upload_id:uploadId,max_bytes:this.maxBytes};
      });
      return {batch_id:batchId,expires_at:expiresAt,files:receipts};
    });
  }

  async writeContent(uploadId: string, ownerId: string, content: AsyncIterable<Uint8Array>, commitReceipt?:()=>void): Promise<void> {
    const row = this.upload(uploadId, ownerId);
    this.assertUploadLive(row);
    const writer=randomUUID(),now=new Date().toISOString(),leaseMs=UPLOAD_WRITER_LEASE_MS,path=join(this.incomingRoot,`${uploadId}.${writer}.part`);
    if (this.db.prepare(`UPDATE ga_uploads SET status='uploading',writer_token=?,writer_lease_until=?,server_path=?,received_size=0,actual_sha256=NULL
      WHERE id=? AND owner_id=? AND (status='created' OR (status='uploading' AND writer_token IS NOT NULL AND writer_lease_until<=?))`)
      .run(writer,new Date(Date.now()+leaseMs).toISOString(),path,uploadId,ownerId,now).changes !== 1) {
      throw new Error('upload_state_conflict');
    }
    const declared = Number(row.declared_size);
    let lost=false;
    const owned=()=>{
      const time=new Date().toISOString(),current=this.db.prepare(`SELECT status,writer_token,writer_lease_until,expires_at,batch_id FROM ga_uploads WHERE id=? AND owner_id=?`)
        .get(uploadId,ownerId) as Record<string,unknown>|undefined;
      if(current?.expires_at&&Date.parse(String(current.expires_at))<=Date.parse(time)){
        this.expireUploadBatch(String(current.batch_id),time);
        throw new Error('upload_expired');
      }
      if(lost||current?.status!=='uploading'||current.writer_token!==writer||!current.writer_lease_until||String(current.writer_lease_until)<=time
        ||!current.expires_at||String(current.expires_at)<=time)throw new Error('upload_writer_lost');
    };
    const digest = createHash('sha256'); const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    let streamError:Error|undefined;
    // A fenced writer can still have buffered writes when it is destroyed.
    // Keep errors observed until close, then remove only its own generation.
    output.on('error',error=>{streamError=error;});
    const input=content as AsyncIterable<Uint8Array>&{destroy?:(error?:Error)=>unknown};
    const stopWriter=()=>{
      lost=true;const error=new Error('upload_writer_lost');
      try{input.destroy?.(error);}catch{}
      output.destroy(error);
    };
    this.activeUploadWriters.set(uploadId,stopWriter);
    const heartbeat=setInterval(()=>{try{
      const time=new Date().toISOString();
      if(this.db.prepare("UPDATE ga_uploads SET writer_lease_until=? WHERE id=? AND owner_id=? AND status='uploading' AND writer_token=? AND writer_lease_until>? AND expires_at>?")
        .run(new Date(Date.now()+leaseMs).toISOString(),uploadId,ownerId,writer,time,time).changes!==1){
        const current=this.db.prepare('SELECT batch_id,expires_at FROM ga_uploads WHERE id=? AND owner_id=?').get(uploadId,ownerId) as {batch_id?:string;expires_at?:string}|undefined;
        if(current?.batch_id&&current.expires_at&&current.expires_at<=time)this.expireUploadBatch(current.batch_id,time);
        stopWriter();
      }
    }catch{stopWriter();}},20000);heartbeat.unref();
    let received = 0;
    try {
      for await (const value of content) {
        owned();
        if(streamError)throw streamError;
        const chunk = Buffer.from(value); received += chunk.length;
        if (received > declared || received > this.maxBytes) throw new Error('upload_size_mismatch');
        digest.update(chunk);
        if (!output.write(chunk)) await once(output, 'drain');
      }
      if (received !== declared) throw new Error('upload_size_mismatch');
      if(streamError)throw streamError;
      output.end();
      await once(output, 'finish');
      const sha=digest.digest('hex');
      withImmediateTransaction(this.db,()=>{
        owned();
        if(this.db.prepare("UPDATE ga_uploads SET status='uploaded',received_size=?,actual_sha256=?,writer_token=NULL,writer_lease_until=NULL WHERE id=? AND writer_token=? AND status='uploading' AND expires_at>?")
          .run(received,sha,uploadId,writer,new Date().toISOString()).changes!==1)throw new Error('upload_writer_lost');
        commitReceipt?.();
      });
    } catch (error) {
      output.destroy();
      if(!output.closed)await new Promise<void>(resolve=>output.once('close',()=>resolve()));
      try { unlinkSync(path); } catch {}
      this.db.prepare("UPDATE ga_uploads SET status='created',received_size=0,actual_sha256=NULL,writer_token=NULL,writer_lease_until=NULL WHERE id=? AND writer_token=? AND status='uploading'").run(uploadId,writer);
      this.db.prepare("UPDATE ga_uploads SET writer_token=NULL,writer_lease_until=NULL WHERE id=? AND writer_token=? AND status='cancelled'").run(uploadId,writer);
      const current=this.db.prepare('SELECT status,batch_id,expires_at FROM ga_uploads WHERE id=? AND owner_id=?').get(uploadId,ownerId) as {status?:string;batch_id?:string;expires_at?:string}|undefined;
      if(current&&(current.status==='expired'||current.expires_at&&current.expires_at<=new Date().toISOString())){
        this.expireUploadBatch(String(current.batch_id??''),new Date().toISOString());
        throw new Error('upload_expired');
      }
      throw error;
    }finally{
      clearInterval(heartbeat);
      if(this.activeUploadWriters.get(uploadId)===stopWriter)this.activeUploadWriters.delete(uploadId);
      const terminal=this.db.prepare('SELECT status FROM ga_uploads WHERE id=? AND owner_id=?').get(uploadId,ownerId) as {status?:string}|undefined;
      if(terminal?.status==='cancelled')this.cleanupCancelledUpload(uploadId,ownerId);
      if(terminal?.status==='expired')this.cleanupExpiredUpload(uploadId,ownerId);
    }
  }

  cancelUpload(uploadId:string,ownerId:string):void {
    const row=this.upload(uploadId,ownerId);
    this.assertUploadLive(row);
    if(row.status==='cancelled')return;
    if(!['created','uploading','uploaded'].includes(String(row.status)))throw new Error('upload_state_conflict');
    const outerTransaction=this.db.isTransaction;
    withImmediateTransaction(this.db,()=>{
      if(this.db.prepare("UPDATE ga_uploads SET status='cancelled',writer_token=NULL,writer_lease_until=NULL WHERE id=? AND owner_id=? AND status=?")
        .run(uploadId,ownerId,String(row.status)).changes!==1)throw new Error('upload_state_conflict');
      this.settleUploadBatch(String(row.batch_id));
    });
    if(!outerTransaction)this.finishCancelledUpload(uploadId,ownerId);
  }

  finishCancelledUpload(uploadId:string,ownerId:string):void { this.activeUploadWriters.get(uploadId)?.();this.cleanupCancelledUpload(uploadId,ownerId); }

  finishCancelledBatch(batchId:string,ownerId:string):void {
    const rows=this.db.prepare("SELECT id,owner_id FROM ga_uploads WHERE batch_id=? AND owner_id=? AND status='cancelled'").all(batchId,ownerId) as Array<{id:string;owner_id:string}>;
    for(const row of rows)this.finishCancelledUpload(row.id,row.owner_id);
  }

  cleanupCancelledUpload(uploadId:string,ownerId:string):void {
    const row=this.upload(uploadId,ownerId);
    if(row.status!=='cancelled'||row.writer_token||this.activeUploadWriters.has(uploadId))return;
    const path=resolve(String(row.server_path));
    if(dirname(path)!==resolve(this.incomingRoot))throw new Error('upload_state_conflict');
    try{unlinkSync(path);}catch(error){if(!['ENOENT','EBUSY','EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  }

  cancelUploadBatch(batchId:string,ownerId:string):void {
    const batch=this.db.prepare('SELECT * FROM ga_upload_batches WHERE id=? AND owner_id=?').get(batchId,ownerId) as Record<string,unknown>|undefined;
    if(!batch)throw new Error('upload_batch_not_found');
    if(batch.status==='expired')throw new Error('upload_expired');
    if(batch.status==='cancelled'||batch.status==='settled')return;
    const now=new Date().toISOString();
    if(String(batch.expires_at)<=now){this.expireUploadBatch(batchId,now);throw new Error('upload_expired');}
    const outerTransaction=this.db.isTransaction;
    const children=withImmediateTransaction(this.db,()=>{
      const rows=this.db.prepare("SELECT id,owner_id FROM ga_uploads WHERE batch_id=? AND status IN ('created','uploading','uploaded')").all(batchId) as Array<{id:string;owner_id:string}>;
      if(this.db.prepare("UPDATE ga_upload_batches SET status='cancelled',closed_at=? WHERE id=? AND owner_id=? AND status='active'")
        .run(now,batchId,ownerId).changes!==1)throw new Error('upload_state_conflict');
      this.db.prepare("UPDATE ga_uploads SET status='cancelled',writer_token=NULL,writer_lease_until=NULL WHERE batch_id=? AND status IN ('created','uploading','uploaded')")
        .run(batchId);
      return rows;
    });
    if(!outerTransaction)for(const child of children)this.finishCancelledUpload(child.id,child.owner_id);
  }

  cleanupExpiredUploads(now=new Date()):number {
    const time=now.toISOString();
    const batches=this.db.prepare("SELECT id FROM ga_upload_batches WHERE status='active' AND expires_at<=?").all(time) as Array<{id:string}>;
    for(const batch of batches)this.expireUploadBatch(batch.id,time);
    const expired=this.db.prepare("SELECT id,owner_id FROM ga_uploads WHERE status='expired'").all() as Array<{id:string;owner_id:string}>;
    for(const row of expired)this.cleanupExpiredUpload(row.id,row.owner_id);
    const cancelled=this.db.prepare("SELECT id,owner_id FROM ga_uploads WHERE status='cancelled'").all() as Array<{id:string;owner_id:string}>;
    for(const row of cancelled)this.cleanupCancelledUpload(row.id,row.owner_id);
    this.cleanupOrphanedUploadGenerations(now);
    return batches.length;
  }

  assertUploadInitReceiptLive(uploadId:string,ownerId:string):void {
    const row=this.upload(uploadId,ownerId);
    this.assertUploadBatchInitReceiptLive(String(row.batch_id??''),ownerId);
  }

  assertUploadBatchInitReceiptLive(batchId:string,ownerId:string):void {
    const batch=this.db.prepare('SELECT status,expires_at FROM ga_upload_batches WHERE id=? AND owner_id=?').get(batchId,ownerId) as {status?:string;expires_at?:string}|undefined;
    if(!batch)throw new Error('upload_batch_not_found');
    const now=new Date().toISOString();
    if(batch.status==='expired'||!batch.expires_at||batch.expires_at<=now){
      this.expireUploadBatch(batchId,now);
      throw new Error('upload_expired');
    }
  }

  assertUploadReceiptLive(uploadId:string,ownerId:string):void { this.assertUploadLive(this.upload(uploadId,ownerId)); }

  private cleanupExpiredUpload(uploadId:string,ownerId:string):void {
    const row=this.db.prepare('SELECT status,writer_token,server_path FROM ga_uploads WHERE id=? AND owner_id=?').get(uploadId,ownerId) as Record<string,unknown>|undefined;
    if(row?.status!=='expired'||row.writer_token||this.activeUploadWriters.has(uploadId))return;
    const path=resolve(String(row.server_path));
    if(dirname(path)!==resolve(this.incomingRoot))throw new Error('upload_state_conflict');
    try{unlinkSync(path);}catch(error){if(!['ENOENT','EBUSY','EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  }

  private cleanupOrphanedUploadGenerations(now:Date):void {
    const incomingRoot=resolve(this.incomingRoot),staleBefore=now.getTime()-UPLOAD_WRITER_LEASE_MS,directory=opendirSync(incomingRoot);
    try{
      for(;;){
        const entry=directory.readSync();if(!entry)break;
        if(!entry.isFile())continue;
        const match=/^(upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.part$/.exec(entry.name);
        if(!match)continue;
        const uploadId=match[1]!,path=resolve(incomingRoot,entry.name);
        if(dirname(path)!==incomingRoot||this.activeUploadWriters.has(uploadId))continue;
        let stat;try{stat=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
        if(!stat.isFile()||stat.mtimeMs>staleBefore)continue;
        const row=this.db.prepare('SELECT status,server_path,writer_lease_until FROM ga_uploads WHERE id=?').get(uploadId) as Record<string,unknown>|undefined;
        if(!row||typeof row.server_path!=='string'||resolve(row.server_path)===path)continue;
        if(row.status==='uploading'){
          const leaseUntil=Date.parse(String(row.writer_lease_until??''));
          if(!Number.isFinite(leaseUntil)||leaseUntil>now.getTime())continue;
        }
        try{unlinkSync(path);}catch(error){if(!['ENOENT','EBUSY','EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
      }
    }finally{directory.closeSync();}
  }

  private expireUploadBatch(batchId:string,now:string):void {
    if(this.db.isTransaction)return;
    const batch=this.db.prepare("SELECT status,expires_at FROM ga_upload_batches WHERE id=?").get(batchId) as {status?:string;expires_at?:string}|undefined;
    if(!batch||batch.status!=='active'||!batch.expires_at||batch.expires_at>now)return;
    const children=withImmediateTransaction(this.db,()=>{
      const rows=this.db.prepare("SELECT id,owner_id FROM ga_uploads WHERE batch_id=? AND status IN ('created','uploading','uploaded')").all(batchId) as Array<{id:string;owner_id:string}>;
      if(this.db.prepare("UPDATE ga_upload_batches SET status='expired',closed_at=? WHERE id=? AND status='active' AND expires_at<=?")
        .run(now,batchId,now).changes!==1)return [];
      this.db.prepare("UPDATE ga_uploads SET status='expired',writer_token=NULL,writer_lease_until=NULL WHERE batch_id=? AND status IN ('created','uploading','uploaded')")
        .run(batchId);
      return rows;
    });
    for(const child of children)this.activeUploadWriters.get(child.id)?.();
    for(const child of children)this.cleanupExpiredUpload(child.id,child.owner_id);
  }

  private settleUploadBatch(batchId:string):void {
    if(!batchId)return;
    const now=new Date().toISOString();
    this.db.prepare(`UPDATE ga_upload_batches SET status='settled',closed_at=? WHERE id=? AND status='active'
      AND NOT EXISTS(SELECT 1 FROM ga_uploads WHERE batch_id=? AND status IN ('created','uploading','uploaded'))`)
      .run(now,batchId,batchId);
  }

  complete(uploadId: string, ownerId: string, input: Record<string, unknown>) {
    const row = this.upload(uploadId, ownerId);
    if(row.channel_stage_key&&!this.channelFinalizing.has(uploadId))throw Error('channel_attachment_batch_finalization_required');
    this.assertUploadLive(row);
    if (!['uploaded','completed'].includes(String(row.status))) throw new Error('upload_state_conflict');
    const requested = String(input.sha256 || '');
    if (requested !== row.declared_sha256 || requested !== row.actual_sha256) throw new Error('upload_sha256_mismatch');
    if (Number(row.received_size) !== Number(row.declared_size)) throw new Error('upload_size_mismatch');
    // Stable destination survives a crash after rename but before DB commit.
    // Old uploads without this mapping remain conflicts, never guessed matches.
    const artifactId = `artifact-${createHash('sha256').update(`upload:${uploadId}`).digest('hex').slice(0,32)}`; const now = new Date().toISOString();
    if(row.status==='completed'){
      const prior=this.db.prepare('SELECT id FROM ga_artifacts WHERE id=? AND owner_id=? AND conversation_id=? AND kind=?').get(artifactId,ownerId,String(row.conversation_id),'upload');
      if(!prior)throw new Error('upload_state_conflict');
      const artifact=this.get(artifactId,ownerId,1);
      if(artifact.sha256!==requested||artifact.size_bytes!==Number(row.declared_size))throw new Error('upload_content_mismatch');
      return artifact;
    }
    const conversationId = String(row.conversation_id);
    const receivedSize = Number(row.received_size);
    const finalPath = join(this.uploadRoot, artifactId);
    const sourcePath=existsSync(finalPath)?finalPath:String(row.server_path);
    rejectTaskOutputSymlinks(sourcePath);rejectTaskOutputSymlinks(finalPath);
    const sourceStat=lstatSync(sourcePath);
    if(!sourceStat.isFile()||sourceStat.size!==receivedSize||sourceStat.size>this.maxBytes)throw new Error('upload_content_mismatch');
    const sourceBytes=readFileSync(sourcePath);
    if(sourceBytes.length!==receivedSize||createHash('sha256').update(sourceBytes).digest('hex')!==requested)throw new Error('upload_content_mismatch');
    const detected = detectContentType(sourcePath, String(row.mime_type));
    const mediaType = detected.mediaType;
    const previewKind = detected.previewKind;
    if(sourcePath!==finalPath)renameSync(sourcePath, finalPath);
    const metadata = { file_name: row.filename, relative_path: row.relative_path, status: 'ready', preview_kind: previewKind, origin: 'upload' };
    withImmediateTransaction(this.db, () => {
      this.db.prepare('INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(artifactId, conversationId, ownerId, 'upload', 1, now, now);
      this.db.prepare('INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(artifactId, 1, finalPath, requested, receivedSize, mediaType, JSON.stringify(metadata), now);
      this.db.prepare(`INSERT INTO ga_artifact_archives(
        artifact_id,backup_status,local_state,last_used_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?)`).run(artifactId, 'pending', 'present', now, now, now);
      this.db.prepare("UPDATE ga_uploads SET status='completed',completed_at=? WHERE id=?").run(now, uploadId);
      this.settleUploadBatch(String(row.batch_id));
    });
    return this.get(artifactId, ownerId, 1);
  }

  registerGenerated(runId: string, runtimeRef: string,
    documents: Array<{ path: string; display_name: string }>): Record<string, any> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(runtimeRef)) {
      throw new Error('generated_artifact_runtime_ref_invalid');
    }
    const existing = this.db.prepare('SELECT id FROM ga_artifacts WHERE runtime_ref=?')
      .get(runtimeRef) as { id?: string } | undefined;
    if (existing?.id) {
      const producer=this.db.prepare(`SELECT p.run_id FROM ga_artifact_producers p
        JOIN ga_runs r ON r.id=p.run_id AND r.conversation_id=p.conversation_id
        JOIN ga_conversations c ON c.id=p.conversation_id AND c.owner_id=p.owner_id
        WHERE p.artifact_id=? AND p.version=1`).get(existing.id) as {run_id:string}|undefined;
      if(!producer)throw new Error('generated_artifact_producer_unverified');
      if(producer.run_id!==runId)throw new Error('generated_artifact_producer_conflict');
      return this.generatedGroup(existing.id);
    }
    if (!Array.isArray(documents) || documents.length < 1 || documents.length > 50) {
      throw new Error('generated_artifact_documents_invalid');
    }
    const run = this.db.prepare(`SELECT r.conversation_id,c.owner_id FROM ga_runs r
      JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=?`).get(runId) as
      { conversation_id?: string; owner_id?: string } | undefined;
    if (!run?.conversation_id || !run.owner_id) throw new Error('generated_artifact_run_not_found');
    const conversationId = run.conversation_id;
    const ownerId = run.owner_id;
    const artifactId = `artifact-${createHash('sha256').update(runtimeRef).digest('hex').slice(0, 32)}`;
    const artifactRoot = join(this.generatedRoot, artifactId);
    mkdirSync(artifactRoot, { recursive: false, mode: 0o700 });
    const parts: Array<Record<string, any>> = [];
    try {
      for (let index = 0; index < documents.length; index += 1) {
        const document = documents[index]!;
        const source = String(document.path || '');
        if (!source || !existsSync(source)) throw new Error('generated_artifact_source_missing');
        const size = statSync(source).size;
        if (size < 1 || size > 19 * 1024 * 1024) throw new Error('generated_artifact_part_size_invalid');
        const raw = readFileSync(source);
        const sha256 = createHash('sha256').update(raw).digest('hex');
        const extension = source.toLowerCase().endsWith('.pdf') ? '.pdf'
          : source.toLowerCase().endsWith('.md') ? '.md' : '.docx';
        const destination = join(artifactRoot, `part-${String(index + 1).padStart(3, '0')}${extension}`);
        try { renameSync(source, destination); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
          copyFileSync(source, destination); unlinkSync(source);
        }
        const displayName = basename(String(document.display_name || `Universe报告_第${index + 1}卷${extension}`)
          .replaceAll('\\', '/'));
        parts.push({ part_index: index + 1, server_path: destination,
          display_name: displayName || `Universe报告_第${index + 1}卷${extension}`,
          sha256, size_bytes: size,
          mime_type: extension === '.docx'
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : extension === '.pdf' ? 'application/pdf' : 'text/markdown' });
      }
      const now = new Date().toISOString();
      const total = parts.reduce((sum, item) => sum + Number(item.size_bytes), 0);
      const groupSha = createHash('sha256').update(JSON.stringify(
        parts.map(item => [item.part_index, item.sha256, item.size_bytes])
      )).digest('hex');
      withImmediateTransaction(this.db, () => {
        this.db.prepare(`INSERT INTO ga_artifacts(
          id,conversation_id,owner_id,kind,current_version,runtime_ref,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?)`).run(artifactId, conversationId, ownerId,
          'generated_document_group', 1, runtimeRef, now, now);
        const first = parts[0]!;
        this.db.prepare(`INSERT INTO ga_artifact_versions(
          artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at
        ) VALUES(?,?,?,?,?,?,?,?)`).run(artifactId, 1, first.server_path, groupSha, total,
          first.mime_type, JSON.stringify({ status: 'ready', origin: 'runtime',
            file_name: first.display_name, display_name: first.display_name,
            part_count: parts.length }), now);
        const insert = this.db.prepare(`INSERT INTO ga_artifact_parts(
          artifact_id,part_index,server_path,display_name,sha256,size_bytes,mime_type,metadata_json,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?)`);
        for (const part of parts) insert.run(artifactId, part.part_index, part.server_path,
          part.display_name, part.sha256, part.size_bytes, part.mime_type,
          JSON.stringify({ status: 'ready', origin: 'runtime' }), now);
        this.db.prepare('INSERT INTO ga_artifact_producers VALUES(?,?,?,?,?,?,?)').run(artifactId,1,runId,ownerId,conversationId,
          JSON.stringify(parts.map(({part_index,display_name,sha256,size_bytes,mime_type})=>({part_index,display_name,sha256,size_bytes,mime_type}))),now);
        this.db.prepare(`INSERT INTO ga_artifact_archives(
          artifact_id,backup_status,local_state,last_used_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,?)`).run(artifactId, 'pending', 'present', now, now, now);
      });
      return this.generatedGroup(artifactId);
    } catch (error) {
      for (const part of parts) { try { unlinkSync(String(part.server_path)); } catch {} }
      throw error;
    }
  }

  /** Internal fixed-version content reader. A producer receipt is mandatory;
   * existing files and caller supplied IDs alone never grant task provenance. */
  readProducedGroup(owner:string,runId:string,artifactId:string,version:number){
    if(!Number.isSafeInteger(version)||version<1)throw new Error('generated_artifact_producer_unverified');
    const source=this.db.prepare(`SELECT p.content_manifest_json,p.conversation_id,v.sha256,v.size_bytes,v.server_path,v.mime_type,
      v.metadata_json,COALESCE(ar.local_state,'present') local_state FROM ga_artifact_producers p
      JOIN ga_artifacts a ON a.id=p.artifact_id AND a.owner_id=p.owner_id AND a.conversation_id=p.conversation_id
      JOIN ga_artifact_versions v ON v.artifact_id=p.artifact_id AND v.version=p.version
      JOIN ga_runs r ON r.id=p.run_id AND r.conversation_id=p.conversation_id
      JOIN ga_conversations c ON c.id=p.conversation_id AND c.owner_id=p.owner_id
      LEFT JOIN ga_artifact_archives ar ON ar.artifact_id=p.artifact_id
      WHERE p.artifact_id=? AND p.version=? AND p.run_id=? AND p.owner_id=? AND a.kind='generated_document_group'`)
      .get(artifactId,version,runId,owner) as Record<string,unknown>|undefined;
    if(!source)throw new Error('generated_artifact_producer_unverified');
    try{
      const manifest=JSON.parse(String(source.content_manifest_json)) as Array<{part_index:number;display_name:string;sha256:string;size_bytes:number;mime_type:string}>;
      const rows=this.db.prepare('SELECT * FROM ga_artifact_parts WHERE artifact_id=? ORDER BY part_index').all(artifactId) as Array<Record<string,unknown>>;
      if(!manifest.length||manifest.length>50||rows.length!==manifest.length||source.local_state!=='present'
        ||!['ready','delivered'].includes(JSON.parse(String(source.metadata_json)).status))throw new Error('source_invalid');
      let total=0;const root=resolve(this.generatedRoot);
      const parts=manifest.map((part,index)=>{
        const row=rows[index]!,path=resolve(String(row.server_path));
        if(part.part_index!==index+1||row.part_index!==part.part_index||row.display_name!==part.display_name
          ||row.sha256!==part.sha256||row.size_bytes!==part.size_bytes||row.mime_type!==part.mime_type
          ||!path.startsWith(root+sep)||path===root)throw new Error('source_invalid');
        rejectTaskOutputSymlinks(path);
        const stat=statSync(path);total+=stat.size;
        if(!stat.isFile()||stat.size!==part.size_bytes||part.size_bytes<1||part.size_bytes>19*1024*1024||total>this.maxBytes)throw new Error('source_invalid');
        const content=readFileSync(path);
        if(content.length!==part.size_bytes||createHash('sha256').update(content).digest('hex')!==part.sha256)throw new Error('content_mismatch');
        return {...part,content};
      });
      const sha256=createHash('sha256').update(JSON.stringify(manifest.map(part=>[part.part_index,part.sha256,part.size_bytes]))).digest('hex');
      if(total!==source.size_bytes||sha256!==source.sha256||resolve(String(source.server_path))!==resolve(String(rows[0]!.server_path))
        ||source.mime_type!==manifest[0]!.mime_type)throw new Error('content_mismatch');
      return {artifact_id:artifactId,version,run_id:runId,conversation_id:String(source.conversation_id),sha256,size_bytes:total,parts};
    }catch{throw new Error('generated_artifact_content_mismatch');}
  }

  generatedGroup(artifactId: string): Record<string, any> {
    const artifact = this.db.prepare('SELECT * FROM ga_artifacts WHERE id=?').get(artifactId) as
      Record<string, any> | undefined;
    if (!artifact) throw new Error('artifact_not_found');
    const version = this.db.prepare('SELECT * FROM ga_artifact_versions WHERE artifact_id=? AND version=1')
      .get(artifactId) as Record<string, any>;
    const parts = this.db.prepare('SELECT * FROM ga_artifact_parts WHERE artifact_id=? ORDER BY part_index')
      .all(artifactId) as Array<Record<string, any>>;
    return { artifact_ref: artifactId, runtime_ref: artifact.runtime_ref,
      size_bytes: Number(version.size_bytes), sha256: String(version.sha256), parts };
  }

  /** Mark only the pinned source version and manifest after its provider/runtime receipt was accepted. */
  markPinnedDeliveredAndDelete(runId: string, value: unknown): Record<string, unknown> {
    const pinKeys = ['artifact_id', 'conversation_id', 'kind', 'manifest', 'manifest_sha256',
      'owner_id', 'run_id', 'schema_version', 'sha256', 'size_bytes', 'version'].sort().join(',');
    const manifestKeys = ['display_name', 'mime_type', 'part_index', 'sha256', 'size_bytes'].sort().join(',');
    if (typeof runId !== 'string' || !runId.trim() || !isRecord(value) || value.run_id !== runId
      || Object.keys(value).sort().join(',') !== pinKeys || value.kind !== 'artifact'
      || value.schema_version !== 1 || typeof value.owner_id !== 'string' || !value.owner_id
      || typeof value.conversation_id !== 'string' || !value.conversation_id
      || typeof value.artifact_id !== 'string' || !value.artifact_id
      || !Number.isSafeInteger(value.version) || value.version < 1
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
      || !Number.isSafeInteger(value.size_bytes) || value.size_bytes < 1 || value.size_bytes > 104857600
      || typeof value.manifest_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifest_sha256)
      || !Array.isArray(value.manifest) || !value.manifest.length || value.manifest.length > 50) {
      throw new Error('channel_delivery_artifact_pin_invalid');
    }
    const manifest = value.manifest.map((part: unknown, index: number) => {
      if (!isRecord(part) || Object.keys(part).sort().join(',') !== manifestKeys
        || part.part_index !== index + 1 || typeof part.display_name !== 'string'
        || !part.display_name || part.display_name.length > 255 || /[\u0000-\u001f\u007f\\/]/u.test(part.display_name)
        || typeof part.mime_type !== 'string' || !part.mime_type || part.mime_type.length > 200
        || /[\u0000-\u001f\u007f]/u.test(part.mime_type)
        || typeof part.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(part.sha256)
        || !Number.isSafeInteger(part.size_bytes) || part.size_bytes < 1 || part.size_bytes > 104857600) {
        throw new Error('channel_delivery_artifact_pin_invalid');
      }
      return { part_index: Number(part.part_index), display_name: part.display_name,
        sha256: part.sha256, size_bytes: Number(part.size_bytes), mime_type: part.mime_type };
    });
    const totalBytes = manifest.reduce((sum, part) => sum + part.size_bytes, 0);
    if (totalBytes !== value.size_bytes || totalBytes > 104857600
      || createHash('sha256').update(canonicalJson(manifest)).digest('hex') !== value.manifest_sha256) {
      throw new Error('channel_delivery_artifact_pin_invalid');
    }

    return withImmediateTransaction(this.db, () => {
      const source = this.db.prepare(`SELECT a.owner_id,a.conversation_id,a.kind,v.version,v.sha256,v.size_bytes,
          v.mime_type,v.metadata_json
        FROM ga_artifacts a JOIN ga_artifact_versions v ON v.artifact_id=a.id
        JOIN ga_runs r ON r.id=? AND r.conversation_id=a.conversation_id
        JOIN ga_conversations c ON c.id=a.conversation_id AND c.owner_id=a.owner_id
        WHERE a.id=? AND a.owner_id=? AND a.conversation_id=? AND v.version=?`)
        .get(runId, value.artifact_id, value.owner_id, value.conversation_id, value.version) as
        Record<string, any> | undefined;
      const association = this.db.prepare(`SELECT 1 FROM ga_run_artifacts
        WHERE run_id=? AND artifact_id=? AND version=?`).get(runId, value.artifact_id, value.version);
      if (!source || !association || source.owner_id !== value.owner_id
        || source.conversation_id !== value.conversation_id || Number(source.version) !== value.version
        || !['task_output_file', 'generated_document_group'].includes(String(source.kind))
        || source.sha256 !== value.sha256 || Number(source.size_bytes) !== value.size_bytes) {
        throw new Error('channel_delivery_artifact_authority_missing');
      }

      let actualManifest: Array<Record<string, unknown>>;
      let partRows: Array<Record<string, any>> = [];
      if (source.kind === 'task_output_file') {
        const verified = this.download(value.artifact_id, value.owner_id, value.version);
        let metadata: Record<string, any>;
        try { metadata = JSON.parse(String(verified.metadata_json)); }
        catch { throw new Error('channel_delivery_artifact_source_mismatch'); }
        const taskFile = metadata.task_file;
        const displayName = metadata.file_name ?? metadata.filename ?? metadata.display_name;
        if (!Buffer.isBuffer(verified.verified_content) || verified.verified_content.length !== value.size_bytes
          || Number(verified.version) !== value.version || verified.sha256 !== value.sha256
          || Number(verified.size_bytes) !== value.size_bytes || verified.mime_type !== source.mime_type
          || typeof displayName !== 'string' || !displayName
          || !isRecord(taskFile) || typeof taskFile.run_id !== 'string' || !taskFile.run_id.trim()
          || taskFile.sha256 !== value.sha256 || !['ready', 'delivered'].includes(String(metadata.status))) {
          throw new Error('channel_delivery_artifact_source_mismatch');
        }
        actualManifest = [{ part_index: 1, display_name: displayName, sha256: String(verified.sha256),
          size_bytes: Number(verified.size_bytes), mime_type: String(verified.mime_type) }];
      } else {
        const produced = this.readProducedGroup(value.owner_id, runId, value.artifact_id, value.version);
        if (produced.artifact_id !== value.artifact_id || produced.version !== value.version
          || produced.run_id !== runId || produced.conversation_id !== value.conversation_id
          || produced.sha256 !== value.sha256 || Number(produced.size_bytes) !== value.size_bytes) {
          throw new Error('channel_delivery_artifact_source_mismatch');
        }
        actualManifest = produced.parts.map((part: Record<string, unknown>) => ({ part_index: part.part_index,
          display_name: part.display_name, sha256: part.sha256, size_bytes: part.size_bytes, mime_type: part.mime_type }));
        partRows = this.db.prepare(`SELECT part_index,metadata_json FROM ga_artifact_parts
          WHERE artifact_id=? ORDER BY part_index`).all(value.artifact_id) as Array<Record<string, any>>;
        if (partRows.length !== actualManifest.length) throw new Error('channel_delivery_artifact_source_mismatch');
        for (const row of partRows) {
          let partMetadata: Record<string, any>;
          try { partMetadata = JSON.parse(String(row.metadata_json)); }
          catch { throw new Error('channel_delivery_artifact_source_mismatch'); }
          if (!['ready', 'delivered'].includes(String(partMetadata.status))) {
            throw new Error('channel_delivery_artifact_source_mismatch');
          }
        }
      }
      if (canonicalJson(actualManifest) !== canonicalJson(manifest)
        || createHash('sha256').update(canonicalJson(actualManifest)).digest('hex') !== value.manifest_sha256) {
        throw new Error('channel_delivery_artifact_manifest_mismatch');
      }

      const now = new Date().toISOString();
      let metadata: Record<string, any>;
      try { metadata = JSON.parse(String(source.metadata_json)); }
      catch { throw new Error('channel_delivery_artifact_source_mismatch'); }
      metadata.status = 'delivered';
      metadata.delivered_at = now;
      const changed = this.db.prepare(`UPDATE ga_artifact_versions SET metadata_json=?
        WHERE artifact_id=? AND version=?`).run(JSON.stringify(metadata), value.artifact_id, value.version).changes;
      if (changed !== 1) throw new Error('channel_delivery_artifact_source_mismatch');
      if (source.kind === 'generated_document_group') {
        const updatePart = this.db.prepare(`UPDATE ga_artifact_parts SET metadata_json=?
          WHERE artifact_id=? AND part_index=?`);
        for (let index = 0; index < partRows.length; index += 1) {
          const partMetadata = JSON.parse(String(partRows[index]!.metadata_json)) as Record<string, any>;
          partMetadata.status = 'delivered';
          partMetadata.delivered_at = now;
          const partChanged = updatePart.run(JSON.stringify(partMetadata), value.artifact_id,
            Number(partRows[index]!.part_index)).changes;
          if (partChanged !== 1) throw new Error('channel_delivery_artifact_source_mismatch');
        }
      }
      this.db.prepare('UPDATE ga_artifacts SET updated_at=? WHERE id=?').run(now, value.artifact_id);
      this.db.prepare(`UPDATE ga_artifact_archives SET backup_status=CASE
        WHEN backup_status='verified' THEN backup_status ELSE 'pending' END,updated_at=? WHERE artifact_id=?`)
        .run(now, value.artifact_id);
      return { artifact_ref: value.artifact_id, version: value.version,
        deleted_files: 0, retained_parts: partRows.length, status: 'delivered_backup_pending' };
    });
  }

  markDeliveredAndDelete(reference: string): Record<string, unknown> {
    const artifact = this.db.prepare('SELECT id FROM ga_artifacts WHERE id=? OR runtime_ref=? LIMIT 1')
      .get(reference, reference) as { id?: string } | undefined;
    if (!artifact?.id) throw new Error('delivery_artifact_not_found');
    const artifactId = artifact.id;
    const parts = this.db.prepare(`SELECT part_index,server_path,metadata_json FROM ga_artifact_parts
      WHERE artifact_id=? ORDER BY part_index`).all(artifactId) as Array<Record<string, unknown>>;
    const version = this.db.prepare(`SELECT version,server_path,metadata_json FROM ga_artifact_versions
      WHERE artifact_id=? ORDER BY version`).all(artifactId) as Array<Record<string, unknown>>;
    const now = new Date().toISOString();
    withImmediateTransaction(this.db, () => {
      const updatePart = this.db.prepare(`UPDATE ga_artifact_parts SET metadata_json=?
        WHERE artifact_id=? AND part_index=?`);
      for (const part of parts) {
        const metadata = JSON.parse(String(part.metadata_json || '{}')) as Record<string, unknown>;
        metadata.status = 'delivered'; metadata.delivered_at = now;
        updatePart.run(JSON.stringify(metadata), artifactId, Number(part.part_index));
      }
      const updateVersion = this.db.prepare(`UPDATE ga_artifact_versions SET metadata_json=?
        WHERE artifact_id=? AND version=?`);
      for (const item of version) {
        const metadata = JSON.parse(String(item.metadata_json || '{}')) as Record<string, unknown>;
        metadata.status = 'delivered'; metadata.delivered_at = now;
        updateVersion.run(JSON.stringify(metadata), artifactId, Number(item.version));
      }
      this.db.prepare('UPDATE ga_artifacts SET updated_at=? WHERE id=?').run(now, artifactId);
      this.db.prepare(`UPDATE ga_artifact_archives SET backup_status=CASE
        WHEN backup_status='verified' THEN backup_status ELSE 'pending' END,updated_at=? WHERE artifact_id=?`)
        .run(now, artifactId);
    });
    return { artifact_ref: artifactId, deleted_files: 0,
      retained_parts: parts.length, status: 'delivered_backup_pending' };
  }

  get(id: string, ownerId: string, version?: number) {
    const row = this.version(id, ownerId, version);
    const meta = JSON.parse(String(row.metadata_json));
    const archive = this.db.prepare('SELECT backup_status,local_state,remote_path FROM ga_artifact_archives WHERE artifact_id=?')
      .get(id) as Record<string, unknown> | undefined;
    const available=existsSync(String(row.server_path));
    const localState=available ? 'present' : archive?.local_state==='restoring' ? 'restoring' : 'deleted';
    const partCount=row.artifact_kind==='generated_document_group'&&Number(row.version)===1
      ? Number((this.db.prepare('SELECT COUNT(*) count FROM ga_artifact_parts WHERE artifact_id=?').get(id) as {count:number}).count) : 0;
    return { artifact_id: id, conversation_id: row.conversation_id, file_name: meta.file_name,
      ...(typeof meta.relative_path==='string'?{relative_path:meta.relative_path}:{}),
      media_type: row.mime_type, size_bytes: Number(row.size_bytes), sha256: row.sha256,
      version: Number(row.version), status: meta.status==='delivered'?'ready':meta.status, created_at: row.created_at,
      ...(partCount>0?{part_count:partCount}:{}),
      preview_kind: partCount>0?'unsupported':meta.preview_kind??'unsupported', origin: meta.origin === 'file_engine' ? 'edited' : ['runtime','trusted_template'].includes(meta.origin) ? 'generated' : meta.origin,
      local_state: localState, backup_status: archive?.backup_status ?? 'pending',
      ...(archive?.remote_path ? { remote_path: archive.remote_path } : {}),
      restorable: Boolean(archive?.remote_path) };
  }

  parts(id:string,ownerId:string,version=1) {
    if(version!==1)throw Error('invalid_artifact_part_request');
    return withReadTransaction(this.db,()=>{
      const group=this.version(id,ownerId,version),meta=JSON.parse(String(group.metadata_json));
      if(group.artifact_kind!=='generated_document_group'||!['ready','delivered'].includes(meta.status))throw Error('artifact_not_found');
      const rows=this.db.prepare(`SELECT * FROM ga_artifact_parts WHERE artifact_id=? ORDER BY part_index`)
        .all(id) as Array<Record<string,unknown>>;
      if(!rows.length||rows.length>50||meta.part_count!==rows.length)throw Error('artifact_parts_invalid');
      const manifest=rows.map((row,index)=>{
        if(Number(row.part_index)!==index+1||typeof row.display_name!=='string'||typeof row.mime_type!=='string'
          ||!Number.isSafeInteger(row.size_bytes)||Number(row.size_bytes)<1||Number(row.size_bytes)>19*1024*1024
          ||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256)
          ||!['ready','delivered'].includes(JSON.parse(String(row.metadata_json)).status))throw Error('artifact_parts_invalid');
        return {part_index:Number(row.part_index),sha256:row.sha256,size_bytes:Number(row.size_bytes)};
      });
      if(manifest.reduce((sum,part)=>sum+part.size_bytes,0)!==Number(group.size_bytes)
        ||createHash('sha256').update(JSON.stringify(manifest.map(part=>[part.part_index,part.sha256,part.size_bytes]))).digest('hex')!==group.sha256)throw Error('artifact_parts_invalid');
      const archive=this.db.prepare('SELECT local_state FROM ga_artifact_archives WHERE artifact_id=?').get(id) as {local_state?:string}|undefined;
      return {artifact_id:id,conversation_id:group.conversation_id,version,sha256:String(group.sha256),items:rows.map(row=>{
        const mime=String(row.mime_type);
        return {artifact_id:id,conversation_id:group.conversation_id,version,part_index:Number(row.part_index),file_name:String(row.display_name),
          media_type:mime,size_bytes:Number(row.size_bytes),sha256:String(row.sha256),status:'ready',created_at:String(row.created_at),origin:'generated',
          preview_kind:mime.startsWith('text/')||['application/json','application/xml'].includes(mime)?'text':mime.startsWith('image/')?'image':'unsupported',
          local_state:existsSync(String(row.server_path))?'present':archive?.local_state==='restoring'?'restoring':'deleted'};
      })};
    });
  }

  part(id:string,ownerId:string,index:number,version=1) {
    if(!Number.isSafeInteger(index)||index<1||index>50)throw Error('invalid_artifact_part_request');
    const group=this.parts(id,ownerId,version),part=group.items.find(item=>item.part_index===index);
    if(!part)throw Error('artifact_not_found');
    return part;
  }

  downloadPart(id:string,ownerId:string,index:number,version=1) {
    const source=withReadTransaction(this.db,()=>{
      const part=this.part(id,ownerId,index,version);
      const row=this.db.prepare('SELECT server_path FROM ga_artifact_parts WHERE artifact_id=? AND part_index=?')
        .get(id,index) as {server_path:string};
      return {part,path:row.server_path};
    });
    const boundary=resolve(this.generatedRoot),path=resolve(source.path);
    if(path===boundary||!path.startsWith(boundary+sep))throw Error('artifact_part_path_escape');
    rejectTaskOutputSymlinks(source.path);
    if(!existsSync(source.path))throw Error('artifact_restore_required');
    const hash=currentFileHashes(source.path);
    if(!hash||hash.size!==source.part.size_bytes||hash.sha256!==source.part.sha256)throw Error('artifact_part_content_mismatch');
    return {server_path:source.path,mime_type:source.part.media_type,metadata_json:JSON.stringify({file_name:source.part.file_name})};
  }

  history(conversationId:string,ownerId:string,query:{cursor?:unknown;run_id?:unknown;limit?:unknown}={}) {
    const identifier=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
    const cursor=query.cursor,runId=query.run_id,limit=query.limit===undefined?20:Number(query.limit);
    if(Object.keys(query).some(key=>!['cursor','run_id','limit'].includes(key))
      ||cursor!==undefined&&(typeof cursor!=='string'||!identifier.test(cursor))
      ||runId!==undefined&&(typeof runId!=='string'||!identifier.test(runId))
      ||query.limit!==undefined&&typeof query.limit!=='string'&&typeof query.limit!=='number'
      ||!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('invalid_artifact_history_query');
    return withReadTransaction(this.db,()=>{
      if(!this.db.prepare('SELECT 1 FROM ga_conversations WHERE id=? AND owner_id=?').get(conversationId,ownerId))throw Error('conversation_not_found');
      if(runId!==undefined&&!this.db.prepare('SELECT 1 FROM ga_runs WHERE id=? AND conversation_id=?').get(runId,conversationId))throw Error('run_not_found');
      const belongsToRun=`(? IS NULL OR EXISTS(SELECT 1 FROM ga_run_artifacts ra WHERE ra.artifact_id=a.id AND ra.run_id=?)
        OR EXISTS(SELECT 1 FROM ga_artifact_producers p WHERE p.artifact_id=a.id AND p.run_id=? AND p.owner_id=a.owner_id AND p.conversation_id=a.conversation_id))`;
      const boundary=cursor===undefined?undefined:this.db.prepare(`SELECT a.id,a.created_at FROM ga_artifacts a
        WHERE a.id=? AND a.conversation_id=? AND a.owner_id=? AND ${belongsToRun}`)
        .get(cursor,conversationId,ownerId,runId??null,runId??null,runId??null) as {id:string;created_at:string}|undefined;
      if(cursor!==undefined&&!boundary)throw Error('invalid_artifact_history_query');
      const rows=this.db.prepare(`SELECT a.id,a.created_at FROM ga_artifacts a WHERE a.conversation_id=? AND a.owner_id=? AND ${belongsToRun}
        AND (? IS NULL OR a.created_at<? OR (a.created_at=? AND a.id<?))
        ORDER BY a.created_at DESC,a.id DESC LIMIT ?`)
        .all(conversationId,ownerId,runId??null,runId??null,runId??null,boundary?.id??null,boundary?.created_at??null,boundary?.created_at??null,boundary?.id??null,limit+1) as Array<{id:string;created_at:string}>;
      const selected=rows.slice(0,limit);
      const pinned=runId===undefined?undefined:this.db.prepare(`SELECT MAX(version) version FROM (
        SELECT version FROM ga_run_artifacts WHERE artifact_id=? AND run_id=?
        UNION ALL SELECT version FROM ga_artifact_producers WHERE artifact_id=? AND run_id=? AND owner_id=? AND conversation_id=?)`);
      const items=selected.map(row=>{
        const version=pinned?.get(row.id,runId!,row.id,runId!,ownerId,conversationId) as {version:number}|undefined;
        if(pinned&&(!version||!Number.isSafeInteger(version.version)||version.version<1))throw Error('artifact_not_found');
        return {created_at:row.created_at,artifact:this.get(row.id,ownerId,version?.version)};
      });
      return {conversation_id:conversationId,...(runId!==undefined?{run_id:runId}:{}),items,
        ...(rows.length>limit?{next_cursor:selected.at(-1)!.id}:{})};
    });
  }

  versions(id: string, ownerId: string, query: {limit?: unknown; before_version?: unknown} = {}) {
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    const before = query.before_version === undefined ? undefined : Number(query.before_version);
    if ([query.limit,query.before_version].some(value => value !== undefined && (typeof value !== 'number' && typeof value !== 'string' || typeof value === 'string' && !/^[1-9][0-9]*$/.test(value)))
      || Object.keys(query).some(key => key !== 'limit' && key !== 'before_version')
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
      || before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new Error('invalid_artifact_version_query');
    return withReadTransaction(this.db, () => {
      const current = this.get(id, ownerId);
      if (before !== undefined) {
        if (before > current.version) throw new Error('invalid_artifact_version_query');
        this.version(id, ownerId, before);
      }
      const rows = this.db.prepare(`SELECT version FROM ga_artifact_versions
        WHERE artifact_id=? AND version<=? AND (? IS NULL OR version<?)
        ORDER BY version DESC LIMIT ?`).all(id, current.version, before ?? null, before ?? null, limit + 1) as Array<{version: number}>;
      const selected = rows.slice(0, limit);
      return {artifact_id: id, conversation_id: current.conversation_id, current_version: current.version,
        items: selected.map(row => this.get(id, ownerId, Number(row.version))),
        ...(rows.length > limit ? {next_before_version: Number(selected.at(-1)!.version)} : {})};
    });
  }

  private restoreTarget(id:string,ownerId:string,query:{version?:unknown;sha256?:unknown;part_index?:unknown}={}) {
    const version=query.version===undefined?undefined:Number(query.version),partIndex=query.part_index===undefined?undefined:Number(query.part_index);
    if([query.version,query.part_index].some(value=>value!==undefined&&(typeof value!=='number'&&typeof value!=='string'||typeof value==='string'&&!/^[1-9][0-9]*$/.test(value)))
      ||Object.keys(query).some(key=>!['version','sha256','part_index'].includes(key))
      ||version!==undefined&&(!Number.isSafeInteger(version)||version<1)
      ||partIndex!==undefined&&(!Number.isSafeInteger(partIndex)||partIndex<1||partIndex>50||version!==1)
      ||query.sha256!==undefined&&(typeof query.sha256!=='string'||!/^[a-f0-9]{64}$/.test(query.sha256)))throw Error('invalid_artifact_restore_query');
    const file=partIndex===undefined?this.get(id,ownerId,version):this.part(id,ownerId,partIndex,version);
    const source=this.version(id,ownerId,Number(file.version));
    if(Number(source.version)>Number(source.current_version))throw Error('artifact_not_found');
    if(query.sha256!==undefined&&query.sha256!==file.sha256)throw Error('version_conflict');
    let paths:string[];
    if(partIndex!==undefined){
      const row=this.db.prepare('SELECT server_path FROM ga_artifact_parts WHERE artifact_id=? AND part_index=?').get(id,partIndex) as {server_path:string};
      paths=[resolve(row.server_path)];
    }else if(source.artifact_kind==='generated_document_group'&&Number(source.version)===1){
      this.parts(id,ownerId,1);
      paths=(this.db.prepare('SELECT server_path FROM ga_artifact_parts WHERE artifact_id=? ORDER BY part_index').all(id) as Array<{server_path:string}>).map(row=>resolve(row.server_path));
    }else paths=[resolve(String(source.server_path))];
    const all=artifactArchiveReferences(this.db,id),selected=new Set(paths),references=all.filter(file=>selected.has(file.server_path));
    if(!references.length||references.length!==selected.size)throw Error('artifact_not_found');
    return {file,all,references,partIndex};
  }

  backupStatus(id: string, ownerId: string,query:{version?:unknown;sha256?:unknown;part_index?:unknown;restore_protocol?:unknown}={}) {
    const {restore_protocol,...selected}=query;
    const protocol=restore_protocol===undefined?2:Number(restore_protocol);
    if(restore_protocol!==undefined&&typeof restore_protocol!=='string'&&typeof restore_protocol!=='number'||![2,3].includes(protocol)
      ||protocol===2&&Object.keys(selected).length)throw Error('invalid_artifact_restore_query');
    return withReadTransaction(this.db, () => {
      const head=this.get(id,ownerId),target=this.restoreTarget(id,ownerId,selected);
      const archive=this.db.prepare(`SELECT backup_status,local_state,remote_path,remote_size,verified_at,last_error,remote_md5
        FROM ga_artifact_archives WHERE artifact_id=?`).get(id) as Record<string,unknown>|undefined;
      const verified=typeof archive?.remote_path==='string'&&archive.remote_path.startsWith('/jot_file/')
        &&(archive.backup_status==='verified'||protocol===3&&Boolean(archive.verified_at));
      const allVersions=verified&&Boolean(artifactArchiveManifest(target.all,String(archive?.remote_md5)));
      const manifest=verified?artifactArchiveManifest(target.all,String(archive?.remote_md5),[]):null;
      const covered=new Set(manifest?.map(file=>file.local_path)??[]);
      const required=protocol===2?artifactArchiveReferences(this.db,id,'current'):target.references;
      const missing=required.filter(file=>!existsSync(file.server_path));
      const restorable=Boolean(manifest)&&required.every(file=>covered.has(file.server_path));
      const localState=archive?.local_state==='restoring'?'restoring':missing.length?'deleted':'present';
      return {artifact_id:id,version:head.version,restore_protocol:protocol,all_versions_archived:allVersions,
        ...(protocol===3?{requested_version:target.file.version,requested_sha256:target.file.sha256,
          ...(target.partIndex!==undefined?{part_index:target.partIndex}:{}),archive_local_state:archive?.local_state??'present',
          selected_file_count:target.references.length,missing_file_count:missing.length,
          unarchived_file_count:target.references.filter(file=>!covered.has(file.server_path)).length}:{}),
        backup_status:archive?.backup_status??'pending',local_state:localState,
        ...(archive?.remote_path?{remote_path:archive.remote_path}:{}),
        ...(archive?.remote_size!==null&&archive?.remote_size!==undefined?{remote_size:Number(archive.remote_size)}:{}),
        ...(archive?.verified_at?{verified_at:archive.verified_at}:{}),restorable,
        ...(archive?.last_error?{last_error:'archive_operation_failed'}:{})};
    });
  }

  requestRestore(id: string, ownerId: string, expectedVersion?: number,selection?:{version:unknown;sha256:unknown;part_index?:unknown}) {
    if(expectedVersion!==undefined&&(!Number.isSafeInteger(expectedVersion)||expectedVersion<1)
      ||selection!==undefined&&(expectedVersion===undefined||selection.version===undefined||selection.sha256===undefined))throw Error('invalid_artifact_restore');
    return withImmediateTransaction(this.db, () => {
      const head=this.get(id,ownerId);
      if(expectedVersion!==undefined&&head.version!==expectedVersion)throw Error('version_conflict');
      const target=this.restoreTarget(id,ownerId,selection??{});
      const row=this.db.prepare('SELECT backup_status,local_state,remote_path,remote_md5,verified_at FROM ga_artifact_archives WHERE artifact_id=?')
        .get(id) as Record<string,unknown>|undefined;
      const verified=row&&(row.backup_status==='verified'||selection!==undefined&&Boolean(row.verified_at));
      const required=selection===undefined?artifactArchiveReferences(this.db,id,'current'):target.references;
      if(!verified||typeof row?.remote_path!=='string'||!row.remote_path.startsWith('/jot_file/')||!artifactArchiveManifest(target.all,String(row.remote_md5),required))throw Error('artifact_not_restorable');
      const needsRestore=selection!==undefined||row.local_state!=='present'||required.some(file=>!existsSync(file.server_path));
      const status=needsRestore?'restoring':'ready';
      if(needsRestore&&row.local_state!=='restoring')this.db.prepare("UPDATE ga_artifact_archives SET local_state='restoring',last_error=NULL,updated_at=? WHERE artifact_id=?")
        .run(new Date().toISOString(),id);
      return {accepted:true,artifact_id:id,status,
        ...(selection!==undefined?{version:head.version,restore_protocol:3,requested_version:target.file.version,requested_sha256:target.file.sha256,
          ...(target.partIndex!==undefined?{part_index:target.partIndex}:{})}:expectedVersion!==undefined?{version:head.version,restore_protocol:2}:{})};
    });
  }

  download(id: string, ownerId: string, version?: number) {
    const row=this.version(id,ownerId,version);
    if(row.artifact_kind==='generated_document_group'&&Number(row.version)===1)throw Error('invalid_artifact_part_selection');
    rejectTaskOutputSymlinks(String(row.server_path));
    if (!existsSync(String(row.server_path))) throw new Error('artifact_restore_required');
    const artifact=this.db.prepare('SELECT kind FROM ga_artifacts WHERE id=?').get(id) as {kind:string};
    if(artifact.kind==='task_output_file'){
      const content=readFileSync(String(row.server_path));
      if(content.length!==Number(row.size_bytes)||createHash('sha256').update(content).digest('hex')!==row.sha256)throw new Error('task_output_content_mismatch');
      return {...row,verified_content:content};
    }
    const hash=currentFileHashes(String(row.server_path));
    if(!hash||hash.size!==Number(row.size_bytes)||hash.sha256!==row.sha256)throw Error('artifact_content_mismatch');
    return row;
  }

  preview(id: string, ownerId: string, version?: number) {
    const source=this.version(id,ownerId,version);
    const meta=JSON.parse(String(source.metadata_json));
    if((source.artifact_kind==='generated_document_group'&&Number(source.version)===1)||!['text','image'].includes(meta.preview_kind))return {artifact_id:id,version:Number(source.version),kind:'unsupported',truncated:false};
    const row = this.download(id,ownerId,version);
    if (meta.preview_kind === 'text') {
      const content = row.verified_content instanceof Buffer?row.verified_content.toString('utf8'):readFileSync(String(row.server_path), 'utf8');
      return { artifact_id: id, version: Number(row.version), kind: 'text', text: content.slice(0, 200000), truncated: content.length > 200000 };
    }
    if (meta.preview_kind === 'image') return { artifact_id: id, version: Number(row.version), kind: 'image', image_path: `/v1/artifacts/${id}/download?version=${row.version}`, truncated: false };
    return { artifact_id: id, version: Number(row.version), kind: 'unsupported', truncated: false };
  }

  diff(id: string, ownerId: string, from: number, to: number) {
    const before = this.download(id, ownerId, from); const after = this.download(id, ownerId, to);
    if (!String(before.mime_type).startsWith('text/') || !String(after.mime_type).startsWith('text/')) throw new Error('artifact_diff_unsupported');
    const left = (before.verified_content instanceof Buffer ? before.verified_content.toString('utf8') : readFileSync(String(before.server_path),'utf8')).split(/\r?\n/);
    const right = (after.verified_content instanceof Buffer ? after.verified_content.toString('utf8') : readFileSync(String(after.server_path),'utf8')).split(/\r?\n/);
    const lines = [`--- version-${from}`, `+++ version-${to}`];
    const maximum = Math.max(left.length, right.length);
    for (let index = 0; index < maximum; index += 1) {
      if (left[index] === right[index]) continue;
      if (left[index] !== undefined) lines.push(`-${left[index]}`);
      if (right[index] !== undefined) lines.push(`+${right[index]}`);
    }
    const full = lines.join('\n');
    return { artifact_id: id, from_version: from, to_version: to,
      unified_diff: full.slice(0, 200000), truncated: full.length > 200000 };
  }

  private upload(id: string, ownerId: string) {
    const row = this.db.prepare('SELECT * FROM ga_uploads WHERE id=? AND owner_id=?').get(id, ownerId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('upload_not_found'); return row;
  }
  private assertUploadLive(row:Record<string,unknown>):void {
    if(row.status==='completed')return;
    const now=new Date().toISOString();
    if(row.status==='expired'||!row.expires_at||String(row.expires_at)<=now){
      this.expireUploadBatch(String(row.batch_id??''),now);
      throw new Error('upload_expired');
    }
    const batch=this.db.prepare('SELECT status FROM ga_upload_batches WHERE id=?').get(String(row.batch_id??'')) as {status?:string}|undefined;
    if(batch?.status==='expired')throw new Error('upload_expired');
  }
  private version(id: string, ownerId: string, version?: number) {
    const row = this.db.prepare(`SELECT v.*,a.conversation_id,a.current_version,a.kind artifact_kind FROM ga_artifacts a JOIN ga_artifact_versions v ON v.artifact_id=a.id
      WHERE a.id=? AND a.owner_id=? AND v.version=COALESCE(?,a.current_version)`).get(id, ownerId, version ?? null) as Record<string, unknown> | undefined;
    if (!row) throw new Error('artifact_not_found'); return row;
  }
}
