import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RunRepository } from '../runs/repository.ts';
import { withImmediateTransaction } from '../db/database.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class ChannelIntakeService {
  private readonly db: DatabaseSync;
  private readonly runs: RunRepository;
  private readonly workspaceId: string;
  constructor(db: DatabaseSync, runs: RunRepository, workspaceId: string) {
    this.db = db;
    this.runs = runs;
    this.workspaceId = workspaceId;
  }

  accept(input: Record<string, unknown>) {
    const channel = String(input.channel ?? '').trim().toLowerCase();
    const principal = String(input.principal ?? '').trim();
    const messageId = String(input.message_id ?? '').trim();
    const text = String(input.text ?? '').trim();
    if (!ID.test(channel) || !ID.test(principal) || !ID.test(messageId) || !text || text.length > 4000) {
      throw new Error('channel_message_invalid');
    }
    const ownerId = `channel:${channel}:${principal}`;
    const conversationId = this.conversation(channel, principal, ownerId);
    return this.runs.enqueue(conversationId, ownerId, {
      client_message_id: `${channel}:${messageId}`,
      content: [{ type: 'text', text }],
    });
  }

  private conversation(channel: string, principal: string, ownerId: string): string {
    return withImmediateTransaction(this.db, () => {
      const existing = this.db.prepare('SELECT conversation_id FROM ga_channel_bindings WHERE channel=? AND principal=?')
        .get(channel, principal) as { conversation_id: string } | undefined;
      if (existing) return existing.conversation_id;
      const id = `conv-${randomUUID()}`;
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, ownerId, this.workspaceId, `${channel}:${principal}`, JSON.stringify({ provider: 'harness', model: 'automatic' }), 1, now, now);
      this.db.prepare('INSERT INTO ga_channel_bindings(channel,principal,conversation_id,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(channel, principal, id, now, now);
      return id;
    });
  }
}
