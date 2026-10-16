import type {DatabaseSync} from 'node:sqlite';
export function installOrdinaryFinalPublications(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS ga_ordinary_final_publications (
  run_id TEXT PRIMARY KEY REFERENCES ga_runs(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,session_id TEXT NOT NULL,message_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,source_json TEXT NOT NULL,
  proof_sha256 TEXT NOT NULL,proof_json TEXT NOT NULL,
  post_source_sha256 TEXT NOT NULL,post_source_json TEXT NOT NULL,
  outputs_json TEXT NOT NULL,created_at TEXT NOT NULL
 );
 CREATE TRIGGER IF NOT EXISTS ga_ordinary_final_publication_update BEFORE UPDATE ON ga_ordinary_final_publications
 BEGIN SELECT RAISE(ABORT,'ordinary_final_publication_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS ga_ordinary_final_publication_replace BEFORE INSERT ON ga_ordinary_final_publications
 WHEN EXISTS(SELECT 1 FROM ga_ordinary_final_publications WHERE run_id=NEW.run_id)
 BEGIN SELECT RAISE(ABORT,'ordinary_final_publication_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS ga_ordinary_final_publication_delete BEFORE DELETE ON ga_ordinary_final_publications
 WHEN EXISTS(SELECT 1 FROM ga_runs WHERE id=OLD.run_id) AND EXISTS(SELECT 1 FROM ga_conversations WHERE id=OLD.conversation_id)
 BEGIN SELECT RAISE(ABORT,'ordinary_final_publication_immutable'); END;
 `);}
