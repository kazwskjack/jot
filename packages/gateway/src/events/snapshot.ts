import type { DatabaseSync } from 'node:sqlite';
import { ConversationRepository } from '../conversations/repository.ts';
import { decodeStoredContent } from '../messages/content.ts';

export function buildSnapshot(db: DatabaseSync, conversationId: string, ownerId: string) {
  db.exec('BEGIN');
  try {
    const conversation = new ConversationRepository(db).get(conversationId, ownerId);
    const asOf = db.prepare('SELECT next_seq-1 AS seq FROM ga_conversations WHERE id=?').get(conversationId) as { seq: number };
    const messages = db.prepare('SELECT * FROM ga_messages WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 200').all(conversationId)
      .reverse().map((row: any) => {
        const content = decodeStoredContent(row.content_json);
        return { message_id: row.id, run_id: row.run_id, role: row.role, status: row.status,
          blocks: content.blocks, ...(content.attachments.length ? { attachments: content.attachments } : {}), created_at: row.created_at };
      });
    const runs = db.prepare('SELECT * FROM ga_runs WHERE conversation_id=? ORDER BY created_at,id').all(conversationId)
      .map((row: any) => ({ run_id: row.id, conversation_id: row.conversation_id, input_message_id: row.input_message_id,
        status: row.status, version: row.version, created_at: row.created_at, updated_at: row.updated_at }));
    const projectionRows = db.prepare(`SELECT e.type,e.payload_json,r.status
      FROM ga_events e LEFT JOIN ga_runs r ON r.id=e.run_id
      WHERE e.conversation_id=? AND e.seq<=? AND e.type IN ('activity.upsert','assistant.delta')
      ORDER BY e.seq DESC LIMIT 2000`).all(conversationId, asOf.seq) as Array<Record<string, unknown>>;
    const activitiesById = new Map<string, Record<string, unknown>>();
    const cursorByBlock = new Map<string, { attempt_id: string; block_id: string; next_delta_index: number }>();
    for (const row of projectionRows) {
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>; } catch { continue; }
      if (row.type === 'activity.upsert') {
        const id = String(payload.activity_id ?? '');
        if (id && !activitiesById.has(id)) activitiesById.set(id, payload);
        continue;
      }
      if (!['queued', 'starting', 'running', 'waiting_user', 'waiting_approval', 'cancelling'].includes(String(row.status))) continue;
      const attemptId = String(payload.attempt_id ?? ''); const blockId = String(payload.block_id ?? '');
      const deltaIndex = Number(payload.delta_index);
      if (!attemptId || !blockId || !Number.isInteger(deltaIndex) || deltaIndex < 0) continue;
      const key = `${attemptId}\u0000${blockId}`;
      const next = deltaIndex + 1; const current = cursorByBlock.get(key);
      if (!current || next > current.next_delta_index) cursorByBlock.set(key,
        { attempt_id: attemptId, block_id: blockId, next_delta_index: next });
    }
    // A cursor is only useful if its accumulated content is included as well.
    // Rebuild transient messages from the same transaction/sequence boundary.
    const transient=new Map<string,any>();
    const attempts=new Map<string,string>();
    const seen=new Map<string,number>();
    const streamRows=db.prepare(`SELECT e.type,e.payload_json,e.run_id,e.created_at
      FROM ga_events e WHERE e.conversation_id=? AND e.seq<=?
      AND e.type IN ('assistant.delta','assistant.settled')
      AND NOT EXISTS (SELECT 1 FROM ga_messages m WHERE m.run_id=e.run_id AND m.role='assistant' AND m.status='complete')
      ORDER BY e.seq`).all(conversationId,asOf.seq) as Array<any>;
    for(const row of streamRows){
      const p=JSON.parse(row.payload_json);
      if(row.type==='assistant.settled'){
        for(const [key,m] of transient)if(m.run_id===row.run_id&&(p.message.status!=='failed'||attempts.get(key)===p.attempt_id))transient.delete(key);
        if(p.message.status!=='failed'){transient.set(p.message.message_id,p.message);attempts.set(p.message.message_id,p.attempt_id)}
        continue;
      }
      const key=JSON.stringify([p.attempt_id,p.block_id]);
      if(p.delta_index<(seen.get(key)??0))continue;
      seen.set(key,p.delta_index+1);
      let m=transient.get(p.message_id);
      if(!m||attempts.get(p.message_id)!==p.attempt_id)m={message_id:p.message_id,run_id:row.run_id,role:'assistant',status:'streaming',blocks:[],created_at:row.created_at};
      let block=m.blocks.find((b:any)=>b.block_id===p.block_id);
      if(!block){block={block_id:p.block_id,kind:p.kind,text:'',exposure:p.kind==='reasoning'?'provider':'public'};m.blocks.push(block)}
      block.text+=p.text;transient.set(p.message_id,m);attempts.set(p.message_id,p.attempt_id);
    }
    messages.push(...transient.values());
    messages.sort((a:any,b:any)=>a.created_at.localeCompare(b.created_at));
    const artifacts = db.prepare(`SELECT a.id,a.conversation_id,a.kind,a.runtime_ref,a.created_at,
      v.mime_type,v.size_bytes,v.sha256,v.version,v.metadata_json,ar.backup_status,ar.local_state,ar.remote_path
      FROM ga_artifacts a JOIN ga_artifact_versions v ON v.artifact_id=a.id AND v.version=a.current_version
      LEFT JOIN ga_artifact_archives ar ON ar.artifact_id=a.id
      WHERE a.conversation_id=? AND a.owner_id=? ORDER BY a.created_at DESC LIMIT 200`)
      .all(conversationId, ownerId).map((row:any) => {
        const metadata = JSON.parse(String(row.metadata_json || '{}'))
        const origin = metadata.origin === 'upload' ? 'upload' : 'generated'
        return { artifact_id: row.id, conversation_id: row.conversation_id,
          ...(row.runtime_ref ? { run_id: row.runtime_ref } : {}), file_name: metadata.file_name || row.id,
          media_type: row.mime_type, size_bytes: Number(row.size_bytes), sha256: row.sha256,
          version: Number(row.version), status: metadata.status || 'ready', created_at: row.created_at,
          preview_kind: metadata.preview_kind || (String(row.mime_type).startsWith('image/') ? 'image' : 'unsupported'),
          origin, local_state: row.local_state || 'present', backup_status: row.backup_status || 'pending',
          ...(row.remote_path ? { remote_path: row.remote_path } : {}), restorable: Boolean(row.remote_path) }
      })
    const sources = db.prepare(`SELECT id,url,access,runtime_evidence_ref,metadata_json,created_at
      FROM ga_sources WHERE conversation_id=? ORDER BY created_at,id LIMIT 200`).all(conversationId).map((row: any) => {
      const meta = JSON.parse(String(row.metadata_json || '{}'));
      return { source_id: row.id, activity_id: meta.activity_id || '', url: row.url, title: meta.title || '',
        host: meta.host || new URL(String(row.url)).hostname, access: row.access, retrieved_at: meta.retrieved_at || row.created_at,
        ...(meta.excerpt ? { excerpt: meta.excerpt } : {}), ...(meta.error_code ? { error_code: meta.error_code } : {}) };
    });
    const crawl_batches = db.prepare(`SELECT batch_id,run_id,status,requested_count,completed_count,failed_count,
      cancel_requested,last_event_seq,generation,created_at,updated_at FROM ga_crawl_batches
      WHERE conversation_id=? ORDER BY created_at,batch_id LIMIT 100`).all(conversationId).map((row: any) => ({
      ...row, requested_count: Number(row.requested_count), completed_count: Number(row.completed_count),
      failed_count: Number(row.failed_count), cancel_requested: Boolean(row.cancel_requested),
      last_event_seq: Number(row.last_event_seq), generation: Number(row.generation),
    }));
    const value = { conversation, as_of_seq: String(asOf.seq), messages, runs,
      activities: [...activitiesById.values()].reverse(), sources, interactions: [], artifacts, crawl_batches,
      stream_cursors: [...cursorByBlock.values()], history_complete: messages.length < 200 };
    db.exec('COMMIT');
    return value;
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
