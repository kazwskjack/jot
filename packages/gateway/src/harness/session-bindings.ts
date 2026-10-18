import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { withImmediateTransaction } from '../db/database.ts'
import {WorkAdmissionRecords} from '../always-on/work-admission-records.ts'
import {ensureModeSession} from '../conversations/mode-sessions.ts'

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
      const frozen=this.db.prepare("SELECT owner_id,session_id FROM ga_conversation_mode_sessions WHERE conversation_id=? AND mode='work'").get(conversationId)
      if(frozen){
        if(frozen.owner_id!==ownerId||existing&&existing.session_id!==frozen.session_id)throw Error('conversation_mode_session_missing')
        if(!existing)throw Error('work_session_recovery_required')
        return{conversation_id:conversationId,owner_id:ownerId,session_id:String(frozen.session_id)}
      }
      const work=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='wb_task_occurrences' AND type='table'").get()
        &&this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='wb_task_current_occurrences' AND type IN('table','view')").get()
        ?this.db.prepare("SELECT run_id,root_run_id FROM wb_task_current_occurrences WHERE conversation_id=? AND trigger_key LIKE 'discovery-work:%'").get(conversationId) as {run_id:string;root_run_id:string}|undefined:undefined
      // A prefix migration is ordinary Session policy, never permission to
      // replace an admitted work Goal's saved execution identity.
      if(work){
        if(existing)return existing
        const admission=new WorkAdmissionRecords(this.db).guard(ownerId,work.run_id)
        const hasTable=(name:string)=>!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type IN('table','view')").get(name)
        const history=work.run_id!==admission.run_id||work.root_run_id!==admission.run_id
          ||!!this.db.prepare('SELECT 1 FROM ga_runs WHERE id=? AND (continuation_of IS NOT NULL OR checkpoint_id IS NOT NULL)').get(work.run_id)
          ||!!this.db.prepare('SELECT 1 FROM ga_session_checkpoints WHERE conversation_id=?').get(conversationId)
          ||(hasTable('wb_native_goal_bindings')&&!!this.db.prepare('SELECT 1 FROM wb_native_goal_bindings WHERE occurrence_id=?').get(admission.occurrence_id))
          ||(hasTable('wb_isolated_file_intents')&&!!this.db.prepare('SELECT 1 FROM wb_isolated_file_intents WHERE cycle_id=?').get(admission.cycle_id))
        if(history)throw Error('work_session_recovery_required')
      }
      const now = new Date().toISOString()
      if (existing?.session_id.startsWith(`${this.sessionPrefix}-`)){ensureModeSession(this.db,ownerId,conversationId,'work');return existing}
      const sessionId = `${this.sessionPrefix}-${randomUUID()}`
      if (existing) {
        this.db.prepare(
          'UPDATE ga_harness_session_bindings SET session_id=?,updated_at=? WHERE conversation_id=? AND owner_id=?',
        ).run(sessionId, now, conversationId, ownerId)
        ensureModeSession(this.db,ownerId,conversationId,'work');return { conversation_id: conversationId, owner_id: ownerId, session_id: sessionId }
      }
      this.db.prepare(
        'INSERT INTO ga_harness_session_bindings(conversation_id,owner_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)',
      ).run(conversationId, ownerId, sessionId, now, now)
      ensureModeSession(this.db,ownerId,conversationId,'work')
      return { conversation_id: conversationId, owner_id: ownerId, session_id: sessionId }
    })
  }

  getOrCreateForConversation(conversationId: string): HarnessSessionBinding {
    const row = this.db.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get(conversationId) as { owner_id: string } | undefined
    if (!row) throw new Error('conversation_not_found')
    return this.getOrCreate(String(row.owner_id), conversationId)
  }
}
