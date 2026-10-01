import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { withImmediateTransaction } from '../db/database.ts'

export interface HarnessSessionBinding {
  conversation_id: string
  owner_id: string
  session_id: string
}

export class SessionBindingRepository {
  private readonly db: DatabaseSync
  private readonly sessionPrefix: string
  constructor(db: DatabaseSync, sessionPrefix = 'jot') {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(sessionPrefix)) throw new Error('session_prefix_invalid')
    this.db = db
    this.sessionPrefix = sessionPrefix
  }

  getOrCreate(ownerId: string, conversationId: string): HarnessSessionBinding {
    return withImmediateTransaction(this.db, () => {
      const conversation = this.db.prepare('SELECT owner_id FROM ga_conversations WHERE id=? AND owner_id=?')
        .get(conversationId, ownerId)
      if (!conversation) throw new Error('conversation_not_found')
      const existing = this.db.prepare(
        'SELECT conversation_id,owner_id,session_id FROM ga_harness_session_bindings WHERE conversation_id=? AND owner_id=?',
      ).get(conversationId, ownerId) as HarnessSessionBinding | undefined
      const now = new Date().toISOString()
      if (existing?.session_id.startsWith(`${this.sessionPrefix}-`)) return existing
      const sessionId = `${this.sessionPrefix}-${randomUUID()}`
      if (existing) {
        this.db.prepare(
          'UPDATE ga_harness_session_bindings SET session_id=?,updated_at=? WHERE conversation_id=? AND owner_id=?',
        ).run(sessionId, now, conversationId, ownerId)
        return { conversation_id: conversationId, owner_id: ownerId, session_id: sessionId }
      }
      this.db.prepare(
        'INSERT INTO ga_harness_session_bindings(conversation_id,owner_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)',
      ).run(conversationId, ownerId, sessionId, now, now)
      return { conversation_id: conversationId, owner_id: ownerId, session_id: sessionId }
    })
  }

  getOrCreateForConversation(conversationId: string): HarnessSessionBinding {
    const row = this.db.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get(conversationId) as { owner_id: string } | undefined
    if (!row) throw new Error('conversation_not_found')
    return this.getOrCreate(String(row.owner_id), conversationId)
  }
}
