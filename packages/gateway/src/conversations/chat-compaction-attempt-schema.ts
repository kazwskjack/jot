import type {DatabaseSync} from 'node:sqlite';
export function installChatCompactionAttempts(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS ga_chat_compaction_attempts (
  attempt_id TEXT PRIMARY KEY,intent_id TEXT NOT NULL UNIQUE REFERENCES ga_chat_compaction_intents(intent_id) ON DELETE CASCADE,
  fence_id TEXT NOT NULL UNIQUE,observer_id TEXT NOT NULL,owner_id TEXT NOT NULL,conversation_id TEXT NOT NULL,run_id TEXT NOT NULL,session_id TEXT NOT NULL,
  source_json TEXT NOT NULL,source_sha256 TEXT NOT NULL,request_json TEXT NOT NULL,request_sha256 TEXT NOT NULL,witness_json TEXT NOT NULL,witness_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','usage_unknown','settled','released')),
  expires_at INTEGER NOT NULL,usage_json TEXT,usage_status TEXT NOT NULL DEFAULT 'none' CHECK(usage_status IN ('none','partial','complete')),
  actual_tokens TEXT,reason TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  CHECK((state='settled' AND usage_status='complete' AND actual_tokens IS NOT NULL) OR (state<>'settled' AND actual_tokens IS NULL AND usage_status<>'complete')));
 CREATE TRIGGER IF NOT EXISTS ga_chat_compaction_attempt_identity BEFORE UPDATE ON ga_chat_compaction_attempts
 WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.intent_id IS NOT OLD.intent_id OR NEW.fence_id IS NOT OLD.fence_id OR NEW.observer_id IS NOT OLD.observer_id
 OR NEW.owner_id IS NOT OLD.owner_id OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.run_id IS NOT OLD.run_id OR NEW.session_id IS NOT OLD.session_id
 OR NEW.source_json IS NOT OLD.source_json OR NEW.source_sha256 IS NOT OLD.source_sha256 OR NEW.request_json IS NOT OLD.request_json OR NEW.request_sha256 IS NOT OLD.request_sha256
 OR NEW.witness_json IS NOT OLD.witness_json OR NEW.witness_sha256 IS NOT OLD.witness_sha256 OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
 BEGIN SELECT RAISE(ABORT,'chat_compaction_attempt_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS ga_chat_compaction_attempt_transition BEFORE UPDATE ON ga_chat_compaction_attempts
 WHEN OLD.state IN ('settled','released')
 OR (OLD.state='reserved' AND NEW.state NOT IN ('reserved','dispatched','released'))
 OR (OLD.state IN ('dispatched','usage_unknown') AND NEW.state NOT IN ('dispatched','usage_unknown','settled'))
 OR (OLD.state='usage_unknown' AND NEW.state='dispatched')
 BEGIN SELECT RAISE(ABORT,'chat_compaction_attempt_transition'); END;
 CREATE TABLE IF NOT EXISTS ga_chat_compaction_attempt_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,attempt_id TEXT NOT NULL REFERENCES ga_chat_compaction_attempts(attempt_id) ON DELETE CASCADE,
  state TEXT NOT NULL,reason TEXT,usage_json TEXT,created_at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS ga_chat_compaction_attempt_event_immutable BEFORE UPDATE ON ga_chat_compaction_attempt_events
 BEGIN SELECT RAISE(ABORT,'chat_compaction_attempt_event_immutable'); END;`);
}
