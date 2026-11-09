import type {DatabaseSync} from 'node:sqlite';

const tables=[
 `CREATE TABLE IF NOT EXISTS wb_workspace_checkpoint_restore_closures(
  owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,command_key TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,request_json TEXT NOT NULL,request_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,workspace_id,project_id,command_key))`,
 `CREATE TABLE IF NOT EXISTS wb_workspace_checkpoint_command_closures(
  owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('create','review')),
  command_key TEXT NOT NULL,request_json TEXT NOT NULL,request_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,workspace_id,project_id,kind,command_key))`,
 `CREATE TABLE IF NOT EXISTS wb_workspace_checkpoint_restore_rejections(
  owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,command_key TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,request_json TEXT NOT NULL,request_sha256 TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason='workspace_checkpoint_review_changed'),created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,workspace_id,project_id,command_key))`,
 `CREATE TABLE IF NOT EXISTS wb_workspace_checkpoint_intents(
  checkpoint_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,
  command_key TEXT NOT NULL,request_sha256 TEXT NOT NULL,source_revision INTEGER NOT NULL CHECK(source_revision>=0),
  root_identity_json TEXT NOT NULL,paths_json TEXT NOT NULL,source_facts_json TEXT NOT NULL,manifest_json TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,UNIQUE(owner_id,workspace_id,project_id,command_key))`,
 `CREATE TABLE IF NOT EXISTS wb_workspace_checkpoint_artifacts(
  snapshot_id TEXT PRIMARY KEY,checkpoint_id TEXT NOT NULL UNIQUE REFERENCES wb_workspace_checkpoint_intents(checkpoint_id),
  record_json TEXT NOT NULL,record_sha256 TEXT NOT NULL,created_at TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS wb_workspace_checkpoint_ready(
  checkpoint_id TEXT PRIMARY KEY REFERENCES wb_workspace_checkpoint_intents(checkpoint_id),
  snapshot_id TEXT NOT NULL UNIQUE REFERENCES wb_workspace_checkpoint_artifacts(snapshot_id),
  receipt_json TEXT NOT NULL,receipt_sha256 TEXT NOT NULL,created_at TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS wb_workspace_checkpoint_restore_reviews(
  review_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL REFERENCES wb_workspace_checkpoint_intents(checkpoint_id),path TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),root_identity_json TEXT NOT NULL,
  before_state_json TEXT NOT NULL,before_state_sha256 TEXT NOT NULL,target_state_json TEXT NOT NULL,target_state_sha256 TEXT NOT NULL,
  review_sha256 TEXT NOT NULL,created_at TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS wb_workspace_checkpoint_restore_review_commands(
  owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,command_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,review_id TEXT NOT NULL REFERENCES wb_workspace_checkpoint_restore_reviews(review_id),
  PRIMARY KEY(owner_id,workspace_id,project_id,command_key),UNIQUE(review_id))`,
 `CREATE TABLE IF NOT EXISTS wb_workspace_checkpoint_path_journal(
  operation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL REFERENCES wb_workspace_checkpoint_intents(checkpoint_id),snapshot_id TEXT NOT NULL,
  path TEXT NOT NULL,review_id TEXT NOT NULL REFERENCES wb_workspace_checkpoint_restore_reviews(review_id),review_sha256 TEXT NOT NULL,
  reservation_id TEXT NOT NULL UNIQUE,binding_sha256 TEXT NOT NULL,expected_revision INTEGER NOT NULL,
  root_identity_json TEXT NOT NULL,before_state_json TEXT NOT NULL,before_state_sha256 TEXT NOT NULL,
  target_state_json TEXT NOT NULL,target_state_sha256 TEXT NOT NULL,target_version INTEGER,
  blob_name TEXT,lease_owner TEXT NOT NULL,lease_generation INTEGER NOT NULL CHECK(lease_generation>0),
  command_key TEXT NOT NULL,request_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,journal_sha256 TEXT NOT NULL,
  UNIQUE(owner_id,workspace_id,project_id,command_key))`,
 `CREATE TABLE IF NOT EXISTS wb_workspace_checkpoint_restore_lease_generations(
  operation_id TEXT NOT NULL REFERENCES wb_workspace_checkpoint_path_journal(operation_id),generation INTEGER NOT NULL CHECK(generation>0),
  lease_owner TEXT NOT NULL,reason TEXT NOT NULL CHECK(reason IN('initial','reconcile')),created_at TEXT NOT NULL,
  PRIMARY KEY(operation_id,generation),UNIQUE(operation_id,lease_owner))`,
 `CREATE TABLE IF NOT EXISTS wb_workspace_checkpoint_restore_outcomes(
  operation_id TEXT PRIMARY KEY REFERENCES wb_workspace_checkpoint_path_journal(operation_id),
  outcome_json TEXT NOT NULL,outcome_sha256 TEXT NOT NULL,created_at TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS wb_workspace_checkpoint_references(
  reference_id TEXT PRIMARY KEY,checkpoint_id TEXT NOT NULL REFERENCES wb_workspace_checkpoint_intents(checkpoint_id),
  owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,
  reference_kind TEXT NOT NULL CHECK(reference_kind IN('review','upload','unknown','rollback')),
  reference_key TEXT NOT NULL,path TEXT,created_at TEXT NOT NULL,
  UNIQUE(checkpoint_id,reference_kind,reference_key))`,
 `CREATE TABLE IF NOT EXISTS wb_workspace_checkpoint_prunes(
  checkpoint_id TEXT PRIMARY KEY REFERENCES wb_workspace_checkpoint_intents(checkpoint_id),
  snapshot_id TEXT NOT NULL,backup_proof_json TEXT NOT NULL,backup_proof_sha256 TEXT NOT NULL,root_identity_json TEXT NOT NULL,created_at TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS wb_workspace_checkpoint_prune_outcomes(
  checkpoint_id TEXT PRIMARY KEY REFERENCES wb_workspace_checkpoint_prunes(checkpoint_id),outcome_json TEXT NOT NULL,outcome_sha256 TEXT NOT NULL,created_at TEXT NOT NULL)`
];
const immutable:ReadonlyArray<Readonly<{table:string;conflict:string}>>=[
 {table:'wb_workspace_checkpoint_command_closures',conflict:'owner_id=NEW.owner_id AND workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND kind=NEW.kind AND command_key=NEW.command_key'},
 {table:'wb_workspace_checkpoint_restore_closures',conflict:'owner_id=NEW.owner_id AND workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND command_key=NEW.command_key'},
 {table:'wb_workspace_checkpoint_restore_rejections',conflict:'owner_id=NEW.owner_id AND workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND command_key=NEW.command_key'},
 {table:'wb_workspace_checkpoint_intents',conflict:'checkpoint_id=NEW.checkpoint_id OR(owner_id=NEW.owner_id AND workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND command_key=NEW.command_key)'},
 {table:'wb_workspace_checkpoint_artifacts',conflict:'snapshot_id=NEW.snapshot_id OR checkpoint_id=NEW.checkpoint_id'},
 {table:'wb_workspace_checkpoint_ready',conflict:'checkpoint_id=NEW.checkpoint_id OR snapshot_id=NEW.snapshot_id'},
 {table:'wb_workspace_checkpoint_restore_reviews',conflict:'review_id=NEW.review_id'},
 {table:'wb_workspace_checkpoint_restore_review_commands',conflict:'(owner_id=NEW.owner_id AND workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND command_key=NEW.command_key) OR review_id=NEW.review_id'},
 {table:'wb_workspace_checkpoint_path_journal',conflict:'operation_id=NEW.operation_id OR(owner_id=NEW.owner_id AND workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND command_key=NEW.command_key) OR reservation_id=NEW.reservation_id'},
 {table:'wb_workspace_checkpoint_restore_lease_generations',conflict:'operation_id=NEW.operation_id AND generation=NEW.generation OR(operation_id=NEW.operation_id AND lease_owner=NEW.lease_owner)'},
 {table:'wb_workspace_checkpoint_restore_outcomes',conflict:'operation_id=NEW.operation_id'},
 {table:'wb_workspace_checkpoint_references',conflict:'reference_id=NEW.reference_id OR(checkpoint_id=NEW.checkpoint_id AND reference_kind=NEW.reference_kind AND reference_key=NEW.reference_key)'},
 {table:'wb_workspace_checkpoint_prunes',conflict:'checkpoint_id=NEW.checkpoint_id'},
 {table:'wb_workspace_checkpoint_prune_outcomes',conflict:'checkpoint_id=NEW.checkpoint_id'}
];

/** Original SQLite checkpoint facts and per-path recovery journal. File bytes
 * remain in the bounded snapshot provider; the DB never stores raw content. */
export function installWorkspaceCheckpointSchema(db:DatabaseSync){
 db.exec('SAVEPOINT wb_workspace_checkpoints_install');
 try{
  for(const sql of tables)db.exec(sql+';');
  db.exec(`CREATE TRIGGER IF NOT EXISTS wb_restore_closed_before_journal BEFORE INSERT ON wb_workspace_checkpoint_path_journal
   WHEN EXISTS(SELECT 1 FROM wb_workspace_checkpoint_restore_closures c WHERE c.owner_id=NEW.owner_id AND c.workspace_id=NEW.workspace_id AND c.project_id=NEW.project_id AND c.command_key=NEW.command_key)
   BEGIN SELECT RAISE(ABORT,'workspace_checkpoint_restore_closed'); END;
   CREATE TRIGGER IF NOT EXISTS wb_restore_registered_before_close BEFORE INSERT ON wb_workspace_checkpoint_restore_closures
   WHEN EXISTS(SELECT 1 FROM wb_workspace_checkpoint_path_journal j WHERE j.owner_id=NEW.owner_id AND j.workspace_id=NEW.workspace_id AND j.project_id=NEW.project_id AND j.command_key=NEW.command_key)
    OR EXISTS(SELECT 1 FROM wb_workspace_checkpoint_restore_rejections r WHERE r.owner_id=NEW.owner_id AND r.workspace_id=NEW.workspace_id AND r.project_id=NEW.project_id AND r.command_key=NEW.command_key)
   BEGIN SELECT RAISE(ABORT,'workspace_checkpoint_restore_closed'); END;
   CREATE TRIGGER IF NOT EXISTS wb_restore_closed_before_rejection BEFORE INSERT ON wb_workspace_checkpoint_restore_rejections
   WHEN EXISTS(SELECT 1 FROM wb_workspace_checkpoint_restore_closures c WHERE c.owner_id=NEW.owner_id AND c.workspace_id=NEW.workspace_id AND c.project_id=NEW.project_id AND c.command_key=NEW.command_key)
   BEGIN SELECT RAISE(ABORT,'workspace_checkpoint_restore_closed'); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS wb_restore_rejected_before_journal BEFORE INSERT ON wb_workspace_checkpoint_path_journal
   WHEN EXISTS(SELECT 1 FROM wb_workspace_checkpoint_restore_rejections r WHERE r.owner_id=NEW.owner_id AND r.workspace_id=NEW.workspace_id AND r.project_id=NEW.project_id AND r.command_key=NEW.command_key)
   BEGIN SELECT RAISE(ABORT,'workspace_checkpoint_restore_closed'); END;
   CREATE TRIGGER IF NOT EXISTS wb_restore_journal_before_rejection BEFORE INSERT ON wb_workspace_checkpoint_restore_rejections
   WHEN EXISTS(SELECT 1 FROM wb_workspace_checkpoint_path_journal j WHERE j.owner_id=NEW.owner_id AND j.workspace_id=NEW.workspace_id AND j.project_id=NEW.project_id AND j.command_key=NEW.command_key)
   BEGIN SELECT RAISE(ABORT,'workspace_checkpoint_restore_closed'); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS wb_checkpoint_closed_before_intent BEFORE INSERT ON wb_workspace_checkpoint_intents
   WHEN EXISTS(SELECT 1 FROM wb_workspace_checkpoint_command_closures c WHERE c.owner_id=NEW.owner_id AND c.workspace_id=NEW.workspace_id AND c.project_id=NEW.project_id AND c.kind='create' AND c.command_key=NEW.command_key)
   BEGIN SELECT RAISE(ABORT,'workspace_checkpoint_command_closed'); END;
   CREATE TRIGGER IF NOT EXISTS wb_checkpoint_closed_before_artifact BEFORE INSERT ON wb_workspace_checkpoint_artifacts
   WHEN EXISTS(SELECT 1 FROM wb_workspace_checkpoint_intents i JOIN wb_workspace_checkpoint_command_closures c ON c.owner_id=i.owner_id AND c.workspace_id=i.workspace_id AND c.project_id=i.project_id AND c.kind='create' AND c.command_key=i.command_key WHERE i.checkpoint_id=NEW.checkpoint_id)
   BEGIN SELECT RAISE(ABORT,'workspace_checkpoint_command_closed'); END;
   CREATE TRIGGER IF NOT EXISTS wb_checkpoint_closed_before_ready BEFORE INSERT ON wb_workspace_checkpoint_ready
   WHEN EXISTS(SELECT 1 FROM wb_workspace_checkpoint_intents i JOIN wb_workspace_checkpoint_command_closures c ON c.owner_id=i.owner_id AND c.workspace_id=i.workspace_id AND c.project_id=i.project_id AND c.kind='create' AND c.command_key=i.command_key WHERE i.checkpoint_id=NEW.checkpoint_id)
   BEGIN SELECT RAISE(ABORT,'workspace_checkpoint_command_closed'); END;
   CREATE TRIGGER IF NOT EXISTS wb_checkpoint_closed_before_review BEFORE INSERT ON wb_workspace_checkpoint_restore_review_commands
   WHEN EXISTS(SELECT 1 FROM wb_workspace_checkpoint_command_closures c WHERE c.owner_id=NEW.owner_id AND c.workspace_id=NEW.workspace_id AND c.project_id=NEW.project_id AND c.kind='review' AND c.command_key=NEW.command_key)
   BEGIN SELECT RAISE(ABORT,'workspace_checkpoint_command_closed'); END;
   CREATE TRIGGER IF NOT EXISTS wb_checkpoint_published_before_close BEFORE INSERT ON wb_workspace_checkpoint_command_closures
   WHEN NEW.kind='create' AND EXISTS(SELECT 1 FROM wb_workspace_checkpoint_intents i JOIN wb_workspace_checkpoint_ready r USING(checkpoint_id) WHERE i.owner_id=NEW.owner_id AND i.workspace_id=NEW.workspace_id AND i.project_id=NEW.project_id AND i.command_key=NEW.command_key)
    OR NEW.kind='review' AND EXISTS(SELECT 1 FROM wb_workspace_checkpoint_restore_review_commands c WHERE c.owner_id=NEW.owner_id AND c.workspace_id=NEW.workspace_id AND c.project_id=NEW.project_id AND c.command_key=NEW.command_key)
   BEGIN SELECT RAISE(ABORT,'workspace_checkpoint_command_settled'); END;`);
  for(const {table,conflict} of immutable){const prefix=table;
   db.exec(`CREATE TRIGGER IF NOT EXISTS ${prefix}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'workspace_checkpoint_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${prefix}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'workspace_checkpoint_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${prefix}_no_replace BEFORE INSERT ON ${table}
     WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${conflict}) BEGIN SELECT RAISE(ABORT,'workspace_checkpoint_immutable'); END;`);
  }
  db.exec('RELEASE wb_workspace_checkpoints_install');
 }catch(error){db.exec('ROLLBACK TO wb_workspace_checkpoints_install; RELEASE wb_workspace_checkpoints_install');throw error;}
}
