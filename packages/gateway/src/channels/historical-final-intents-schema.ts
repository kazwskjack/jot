import type {DatabaseSync} from 'node:sqlite';
export function installHistoricalFinalDeliveryIntents(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS ga_historical_final_delivery_batches(
  run_id TEXT PRIMARY KEY REFERENCES ga_runs(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,message_id TEXT NOT NULL,text TEXT NOT NULL,content_sha256 TEXT NOT NULL,
  publication_source_sha256 TEXT NOT NULL,answer_sha256 TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS ga_historical_final_delivery_intents(
  intent_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES ga_historical_final_delivery_batches(run_id) ON DELETE CASCADE,
  destination TEXT NOT NULL,recipient TEXT NOT NULL,target_json TEXT NOT NULL,
  UNIQUE(run_id,destination,recipient));
 CREATE TABLE IF NOT EXISTS ga_historical_final_delivery_states(
  intent_id TEXT PRIMARY KEY REFERENCES ga_historical_final_delivery_intents(intent_id) ON DELETE CASCADE,
  status TEXT NOT NULL,effect_id TEXT,decision_json TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS ga_historical_final_delivery_grants(
  effect_id TEXT PRIMARY KEY REFERENCES ga_channel_deliveries(effect_id) ON DELETE CASCADE,
  intent_id TEXT NOT NULL REFERENCES ga_historical_final_delivery_intents(intent_id) ON DELETE CASCADE,
  payload_sha256 TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_historical_delivery_intents_run ON ga_historical_final_delivery_intents(run_id);
 CREATE TRIGGER IF NOT EXISTS historical_delivery_batch_no_update BEFORE UPDATE ON ga_historical_final_delivery_batches
 BEGIN SELECT RAISE(ABORT,'historical_delivery_intent_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS historical_delivery_batch_no_replace BEFORE INSERT ON ga_historical_final_delivery_batches
 WHEN EXISTS(SELECT 1 FROM ga_historical_final_delivery_batches WHERE run_id=NEW.run_id)
 BEGIN SELECT RAISE(ABORT,'historical_delivery_intent_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS historical_delivery_batch_no_delete BEFORE DELETE ON ga_historical_final_delivery_batches
 WHEN EXISTS(SELECT 1 FROM ga_runs WHERE id=OLD.run_id) AND EXISTS(SELECT 1 FROM ga_conversations WHERE id=OLD.conversation_id)
 BEGIN SELECT RAISE(ABORT,'historical_delivery_intent_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS historical_delivery_target_no_update BEFORE UPDATE ON ga_historical_final_delivery_intents
 BEGIN SELECT RAISE(ABORT,'historical_delivery_intent_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS historical_delivery_target_no_replace BEFORE INSERT ON ga_historical_final_delivery_intents
 WHEN EXISTS(SELECT 1 FROM ga_historical_final_delivery_intents WHERE intent_id=NEW.intent_id OR (run_id=NEW.run_id AND destination=NEW.destination AND recipient=NEW.recipient))
 BEGIN SELECT RAISE(ABORT,'historical_delivery_intent_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS historical_delivery_target_no_delete BEFORE DELETE ON ga_historical_final_delivery_intents
 WHEN EXISTS(SELECT 1 FROM ga_historical_final_delivery_batches b JOIN ga_runs r ON r.id=b.run_id JOIN ga_conversations c ON c.id=b.conversation_id WHERE b.run_id=OLD.run_id)
 BEGIN SELECT RAISE(ABORT,'historical_delivery_intent_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS historical_delivery_grant_no_update BEFORE UPDATE ON ga_historical_final_delivery_grants
 BEGIN SELECT RAISE(ABORT,'historical_delivery_intent_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS historical_delivery_grant_no_replace BEFORE INSERT ON ga_historical_final_delivery_grants
 WHEN EXISTS(SELECT 1 FROM ga_historical_final_delivery_grants WHERE effect_id=NEW.effect_id)
 BEGIN SELECT RAISE(ABORT,'historical_delivery_intent_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS historical_delivery_grant_no_delete BEFORE DELETE ON ga_historical_final_delivery_grants
 WHEN EXISTS(SELECT 1 FROM ga_historical_final_delivery_intents i JOIN ga_historical_final_delivery_batches b ON b.run_id=i.run_id JOIN ga_runs r ON r.id=b.run_id JOIN ga_conversations c ON c.id=b.conversation_id WHERE i.intent_id=OLD.intent_id)
 BEGIN SELECT RAISE(ABORT,'historical_delivery_intent_immutable'); END;`);
}
