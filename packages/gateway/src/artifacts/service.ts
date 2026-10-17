import { createHash, randomUUID } from 'node:crypto';
import { basename, join,dirname,resolve,sep } from 'node:path';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync,writeFileSync,lstatSync } from 'node:fs';
import { once } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';
import { detectContentType } from './content-type.ts';
import {sameTaskFileLocation} from '../persistent-tasks/output-content.ts';
import {readIsolatedTaskFileVersion} from '../persistent-tasks/isolated-output-source.ts';
import {taskFileSource,type TaskFileScope,type TaskFileLocation} from '../persistent-tasks/task-file-source.ts';

function rejectTaskOutputSymlinks(path:string):void {
  let current=resolve(path);
  for(;;){if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error('task_output_path_unsafe');const parent=dirname(current);if(parent===current)return;current=parent;}
}

export class ArtifactService {
  private readonly db: DatabaseSync;
  private readonly root: string;
  private readonly incomingRoot: string;
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
    db.exec(`CREATE TRIGGER IF NOT EXISTS ga_task_output_no_identity_update BEFORE UPDATE ON ga_artifacts
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
    if (!this.db.prepare('SELECT 1 FROM ga_conversations WHERE id=? AND owner_id=?').get(conversationId, ownerId)) throw new Error('conversation_not_found');
    const size = Number(input.size_bytes);
    if (!Number.isInteger(size) || size < 1 || size > this.maxBytes) throw new Error('upload_size_invalid');
    const sha = String(input.sha256 || '');
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('upload_sha256_invalid');
    const filename = basename(String(input.file_name || '').replaceAll('\\', '/'));
    if (!filename || filename === '.' || filename === '..') throw new Error('upload_filename_invalid');
    const id = `upload-${randomUUID()}`; const now = new Date();
    const path = join(this.incomingRoot, `${id}.part`);
    this.db.prepare('INSERT INTO ga_uploads(id,conversation_id,owner_id,status,server_path,filename,declared_size,declared_sha256,mime_type,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, conversationId, ownerId, 'created', path, filename, size, sha, String(input.media_type), now.toISOString());
    return { upload_id: id, expires_at: new Date(now.getTime() + 3600000).toISOString(), max_bytes: this.maxBytes };
  }

  async writeContent(uploadId: string, ownerId: string, content: AsyncIterable<Uint8Array>, commitReceipt?:()=>void): Promise<void> {
    const row = this.upload(uploadId, ownerId);
    const writer=randomUUID(),now=new Date().toISOString(),leaseMs=300000,path=join(this.incomingRoot,`${uploadId}.${writer}.part`);
    if (this.db.prepare(`UPDATE ga_uploads SET status='uploading',writer_token=?,writer_lease_until=?,server_path=?,received_size=0,actual_sha256=NULL
      WHERE id=? AND owner_id=? AND (status='created' OR (status='uploading' AND writer_token IS NOT NULL AND writer_lease_until<=?))`)
      .run(writer,new Date(Date.now()+leaseMs).toISOString(),path,uploadId,ownerId,now).changes !== 1) {
      throw new Error('upload_state_conflict');
    }
    const declared = Number(row.declared_size);
    let lost=false;
    const owned=()=>{
      if(lost||!this.db.prepare("SELECT 1 FROM ga_uploads WHERE id=? AND owner_id=? AND status='uploading' AND writer_token=? AND writer_lease_until>?")
        .get(uploadId,ownerId,writer,new Date().toISOString()))throw new Error('upload_writer_lost');
    };
    const heartbeat=setInterval(()=>{try{
      const time=new Date().toISOString();
      if(this.db.prepare("UPDATE ga_uploads SET writer_lease_until=? WHERE id=? AND owner_id=? AND status='uploading' AND writer_token=? AND writer_lease_until>?")
        .run(new Date(Date.now()+leaseMs).toISOString(),uploadId,ownerId,writer,time).changes!==1)lost=true;
    }catch{lost=true;}},20000);heartbeat.unref();
    const digest = createHash('sha256'); const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    let streamError:Error|undefined;
    // A fenced writer can still have buffered writes when it is destroyed.
    // Keep errors observed until close, then remove only its own generation.
    output.on('error',error=>{streamError=error;});
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
        if(this.db.prepare("UPDATE ga_uploads SET status='uploaded',received_size=?,actual_sha256=?,writer_token=NULL,writer_lease_until=NULL WHERE id=? AND writer_token=? AND status='uploading'")
          .run(received,sha,uploadId,writer).changes!==1)throw new Error('upload_writer_lost');
        commitReceipt?.();
      });
    } catch (error) {
      output.destroy();
      if(!output.closed)await new Promise<void>(resolve=>output.once('close',()=>resolve()));
      try { unlinkSync(path); } catch {}
      this.db.prepare("UPDATE ga_uploads SET status='created',received_size=0,actual_sha256=NULL,writer_token=NULL,writer_lease_until=NULL WHERE id=? AND writer_token=? AND status='uploading'").run(uploadId,writer);
      throw error;
    }finally{clearInterval(heartbeat);}
  }

  complete(uploadId: string, ownerId: string, input: Record<string, unknown>) {
    const row = this.upload(uploadId, ownerId);
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
    const metadata = { file_name: row.filename, status: 'ready', preview_kind: previewKind, origin: 'upload' };
    withImmediateTransaction(this.db, () => {
      this.db.prepare('INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(artifactId, conversationId, ownerId, 'upload', 1, now, now);
      this.db.prepare('INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(artifactId, 1, finalPath, requested, receivedSize, mediaType, JSON.stringify(metadata), now);
      this.db.prepare(`INSERT INTO ga_artifact_archives(
        artifact_id,backup_status,local_state,last_used_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?)`).run(artifactId, 'pending', 'present', now, now, now);
      this.db.prepare("UPDATE ga_uploads SET status='completed',completed_at=? WHERE id=?").run(now, uploadId);
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
    return { artifact_id: id, conversation_id: row.conversation_id, file_name: meta.file_name,
      media_type: row.mime_type, size_bytes: Number(row.size_bytes), sha256: row.sha256,
      version: Number(row.version), status: meta.status, created_at: row.created_at,
      preview_kind: meta.preview_kind, origin: meta.origin,
      local_state: archive?.local_state ?? 'present', backup_status: archive?.backup_status ?? 'pending',
      ...(archive?.remote_path ? { remote_path: archive.remote_path } : {}),
      restorable: Boolean(archive?.remote_path) };
  }

  backupStatus(id: string, ownerId: string) {
    const artifact = this.get(id, ownerId)
    const archive = this.db.prepare(`SELECT backup_status,local_state,remote_path,remote_size,verified_at,last_error
      FROM ga_artifact_archives WHERE artifact_id=?`).get(id) as Record<string, unknown> | undefined
    return { artifact_id: id, backup_status: archive?.backup_status ?? 'pending',
      local_state: archive?.local_state ?? 'present', ...(archive?.remote_path ? { remote_path: archive.remote_path } : {}),
      ...(archive?.remote_size !== null && archive?.remote_size !== undefined ? { remote_size: Number(archive.remote_size) } : {}),
      ...(archive?.verified_at ? { verified_at: archive.verified_at } : {}), restorable: artifact.restorable,
      ...(archive?.last_error ? { last_error: String(archive.last_error) } : {}) }
  }

  requestRestore(id: string, ownerId: string) {
    this.get(id, ownerId)
    const row = this.db.prepare('SELECT backup_status,local_state,remote_path FROM ga_artifact_archives WHERE artifact_id=?')
      .get(id) as Record<string, unknown> | undefined
    if (!row || row.backup_status !== 'verified' || !row.remote_path) throw new Error('artifact_not_restorable')
    if (row.local_state === 'present') return { accepted: true, artifact_id: id, status: 'ready' }
    this.db.prepare("UPDATE ga_artifact_archives SET local_state='restoring',updated_at=? WHERE artifact_id=?")
      .run(new Date().toISOString(), id)
    return { accepted: true, artifact_id: id, status: 'restoring' }
  }

  download(id: string, ownerId: string, version?: number) {
    const archive = this.db.prepare('SELECT local_state FROM ga_artifact_archives WHERE artifact_id=?').get(id) as { local_state?: string } | undefined
    if (archive?.local_state && archive.local_state !== 'present') throw new Error('artifact_restore_required')
    const row=this.version(id,ownerId,version);
    const artifact=this.db.prepare('SELECT kind FROM ga_artifacts WHERE id=?').get(id) as {kind:string};
    if(artifact.kind==='task_output_file'){
      rejectTaskOutputSymlinks(String(row.server_path));
      const content=readFileSync(String(row.server_path));
      if(content.length!==Number(row.size_bytes)||createHash('sha256').update(content).digest('hex')!==row.sha256)throw new Error('task_output_content_mismatch');
      return {...row,verified_content:content};
    }
    return row;
  }

  preview(id: string, ownerId: string, version?: number) {
    const kind=this.db.prepare('SELECT kind FROM ga_artifacts WHERE id=?').get(id) as {kind:string}|undefined;
    const row = kind?.kind==='task_output_file'?this.download(id,ownerId,version):this.version(id, ownerId, version); const meta = JSON.parse(String(row.metadata_json));
    if (meta.preview_kind === 'text') {
      const content = row.verified_content instanceof Buffer?row.verified_content.toString('utf8'):readFileSync(String(row.server_path), 'utf8');
      return { artifact_id: id, version: Number(row.version), kind: 'text', text: content.slice(0, 200000), truncated: content.length > 200000 };
    }
    if (meta.preview_kind === 'image') return { artifact_id: id, version: Number(row.version), kind: 'image', image_path: `/v1/artifacts/${id}/download?version=${row.version}`, truncated: false };
    return { artifact_id: id, version: Number(row.version), kind: 'unsupported', truncated: false };
  }

  diff(id: string, ownerId: string, from: number, to: number) {
    const before = this.version(id, ownerId, from); const after = this.version(id, ownerId, to);
    if (!String(before.mime_type).startsWith('text/') || !String(after.mime_type).startsWith('text/')) throw new Error('artifact_diff_unsupported');
    const left = readFileSync(String(before.server_path), 'utf8').split(/\r?\n/);
    const right = readFileSync(String(after.server_path), 'utf8').split(/\r?\n/);
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
  private version(id: string, ownerId: string, version?: number) {
    const row = this.db.prepare(`SELECT v.*,a.conversation_id FROM ga_artifacts a JOIN ga_artifact_versions v ON v.artifact_id=a.id
      WHERE a.id=? AND a.owner_id=? AND v.version=COALESCE(?,a.current_version)`).get(id, ownerId, version ?? null) as Record<string, unknown> | undefined;
    if (!row) throw new Error('artifact_not_found'); return row;
  }
}
