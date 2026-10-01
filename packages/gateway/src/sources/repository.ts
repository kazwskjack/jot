import type { DatabaseSync } from 'node:sqlite';

export class SourceRepository {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  project(input: Record<string, unknown>) {
    const access = String(input.access);
    if (['fetched', 'read'].includes(access) && !input.runtime_evidence_ref) throw new Error('source_evidence_required');
    const parsed = new URL(String(input.url));
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('source_url_invalid');
    const metadata = {
      activity_id: String(input.activity_id || `activity-${input.source_id}`),
      title: String(input.title || ''), host: parsed.hostname,
      retrieved_at: String(input.retrieved_at || new Date().toISOString()),
      excerpt: typeof input.excerpt === 'string' ? input.excerpt.slice(0, 8000) : undefined,
      error_code: typeof input.error_code === 'string' ? input.error_code : undefined,
    };
    this.db.prepare(`INSERT INTO ga_sources(id,conversation_id,run_id,url,access,runtime_evidence_ref,metadata_json,runtime_revision,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url,access=excluded.access,
      runtime_evidence_ref=excluded.runtime_evidence_ref,metadata_json=excluded.metadata_json,
      runtime_revision=excluded.runtime_revision,updated_at=excluded.updated_at
      WHERE excluded.runtime_revision>ga_sources.runtime_revision`)
      .run(String(input.source_id), String(input.conversation_id), String(input.run_id), parsed.href, access,
        input.runtime_evidence_ref ? String(input.runtime_evidence_ref) : null, JSON.stringify(metadata),
        Number(input.runtime_revision), metadata.retrieved_at, metadata.retrieved_at);
    return this.getInternal(String(input.source_id));
  }

  get(id: string, ownerId: string) {
    const allowed = this.db.prepare('SELECT s.id FROM ga_sources s JOIN ga_conversations c ON c.id=s.conversation_id WHERE s.id=? AND c.owner_id=?')
      .get(id, ownerId);
    if (!allowed) throw new Error('source_not_found');
    return this.getInternal(id);
  }

  private getInternal(id: string) {
    const row = this.db.prepare('SELECT * FROM ga_sources WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('source_not_found');
    const meta = JSON.parse(String(row.metadata_json));
    const value: Record<string, unknown> = { source_id: row.id, activity_id: meta.activity_id, url: row.url,
      title: meta.title, host: meta.host, access: row.access, retrieved_at: meta.retrieved_at };
    if (meta.excerpt) value.excerpt = meta.excerpt;
    if (meta.error_code) value.error_code = meta.error_code;
    return value;
  }
}
