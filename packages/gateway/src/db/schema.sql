CREATE TABLE IF NOT EXISTS ga_conversations (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  title TEXT NOT NULL, model TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  next_seq INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  project_id TEXT, pinned_at TEXT, archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ga_conversations_owner_updated ON ga_conversations(owner_id,updated_at DESC,id);

CREATE TABLE IF NOT EXISTS ga_projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ga_projects_owner_updated ON ga_projects(owner_id,updated_at DESC,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ga_projects_owner_default ON ga_projects(owner_id) WHERE is_default=1;

CREATE TABLE IF NOT EXISTS ga_harness_session_bindings (
  conversation_id TEXT PRIMARY KEY REFERENCES ga_conversations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ga_harness_session_owner
  ON ga_harness_session_bindings(owner_id,session_id);

CREATE TABLE IF NOT EXISTS ga_channel_bindings (
  channel TEXT NOT NULL, principal TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(channel,principal)
);

CREATE TABLE IF NOT EXISTS ga_messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
  run_id TEXT, role TEXT NOT NULL, status TEXT NOT NULL, content_json TEXT NOT NULL,
  client_message_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(conversation_id,client_message_id)
);
CREATE INDEX IF NOT EXISTS idx_ga_messages_history ON ga_messages(conversation_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS ga_candidate_answers (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE,
  input_message_id TEXT NOT NULL REFERENCES ga_messages(id),
  turn_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_version TEXT NOT NULL,
  status TEXT NOT NULL,
  text TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id,attempt,source,source_version)
);
CREATE INDEX IF NOT EXISTS idx_ga_candidate_answers_run ON ga_candidate_answers(run_id,attempt);

CREATE TABLE IF NOT EXISTS ga_channel_deliveries (
  effect_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  recipient TEXT NOT NULL,
  artifact_ref TEXT,
  payload_json TEXT,
  status TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  provider_receipt_json TEXT,
  last_reason_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ga_channel_deliveries_claim
  ON ga_channel_deliveries(status,lease_expires_at,created_at);

CREATE TABLE IF NOT EXISTS ga_runs (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
  input_message_id TEXT REFERENCES ga_messages(id), status TEXT NOT NULL,
  continuation_of TEXT REFERENCES ga_runs(id), runtime_run_id TEXT,
  runtime_revision INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
  checkpoint_id TEXT, reason_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ga_one_executing_run ON ga_runs(conversation_id)
  WHERE status IN ('starting','running','waiting_user','waiting_approval','cancelling');
CREATE INDEX IF NOT EXISTS idx_ga_runs_queue ON ga_runs(status,created_at,id);

CREATE TABLE IF NOT EXISTS ga_run_commands (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, applied_at TEXT,
  UNIQUE(run_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS ga_interactions (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  status TEXT NOT NULL, version INTEGER NOT NULL, action_digest TEXT,
  request_json TEXT NOT NULL, response_json TEXT, expires_at TEXT, created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS ga_uploads (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, status TEXT NOT NULL, server_path TEXT NOT NULL,
  filename TEXT NOT NULL, declared_size INTEGER NOT NULL, received_size INTEGER NOT NULL DEFAULT 0,
  declared_sha256 TEXT, actual_sha256 TEXT, mime_type TEXT, created_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS ga_artifacts (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, kind TEXT NOT NULL, current_version INTEGER NOT NULL,
  runtime_ref TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ga_artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES ga_artifacts(id) ON DELETE CASCADE, version INTEGER NOT NULL,
  server_path TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  mime_type TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(artifact_id,version)
);
CREATE TABLE IF NOT EXISTS ga_artifact_parts (
  artifact_id TEXT NOT NULL REFERENCES ga_artifacts(id) ON DELETE CASCADE,
  part_index INTEGER NOT NULL,
  server_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(artifact_id,part_index)
);
CREATE TABLE IF NOT EXISTS ga_artifact_archives (
  artifact_id TEXT PRIMARY KEY REFERENCES ga_artifacts(id) ON DELETE CASCADE,
  backup_status TEXT NOT NULL DEFAULT 'pending',
  local_state TEXT NOT NULL DEFAULT 'present',
  remote_path TEXT,
  remote_size INTEGER,
  remote_md5 TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at TEXT,
  verified_at TEXT,
  local_deleted_at TEXT,
  restored_at TEXT,
  last_used_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ga_artifact_archives_backup
  ON ga_artifact_archives(backup_status,next_retry_at,created_at);
CREATE INDEX IF NOT EXISTS idx_ga_artifact_archives_cleanup
  ON ga_artifact_archives(local_state,backup_status,last_used_at);
CREATE TABLE IF NOT EXISTS ga_artifact_leases (
  artifact_id TEXT NOT NULL REFERENCES ga_artifacts(id) ON DELETE CASCADE,
  lease_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(artifact_id,lease_id)
);
CREATE INDEX IF NOT EXISTS idx_ga_artifact_leases_expiry
  ON ga_artifact_leases(expires_at,artifact_id);
CREATE TABLE IF NOT EXISTS ga_run_artifacts (
  run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id,artifact_id,version),
  FOREIGN KEY(artifact_id,version) REFERENCES ga_artifact_versions(artifact_id,version) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ga_run_artifacts_artifact
  ON ga_run_artifacts(artifact_id,version,run_id);
CREATE TABLE IF NOT EXISTS ga_file_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES ga_artifacts(id) ON DELETE CASCADE,
  base_version INTEGER NOT NULL,
  base_sha256 TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_json TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  output_version INTEGER,
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_ga_file_jobs_claim
  ON ga_file_jobs(status,lease_expires_at,created_at);
CREATE TABLE IF NOT EXISTS ga_artifact_requests (
  request_id TEXT PRIMARY KEY,
  runtime_run_id TEXT NOT NULL,
  client_run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL,
  result_refs_json TEXT NOT NULL,
  source_results_json TEXT NOT NULL,
  format TEXT NOT NULL,
  template TEXT NOT NULL,
  status TEXT NOT NULL,
  artifact_ref TEXT,
  receipt_json TEXT,
  last_reason_code TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ga_artifact_requests_claim
  ON ga_artifact_requests(status,lease_expires_at,created_at);
CREATE TABLE IF NOT EXISTS ga_sources (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE, url TEXT NOT NULL,
  access TEXT NOT NULL, runtime_evidence_ref TEXT, metadata_json TEXT NOT NULL,
  runtime_revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ga_events (
  conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, run_id TEXT,
  type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id,seq)
);
CREATE TABLE IF NOT EXISTS ga_web_operation_cursors (
  run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  last_revision INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id,tool_call_id)
);
CREATE TABLE IF NOT EXISTS ga_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  lease_owner TEXT, lease_generation INTEGER, lease_expires_at TEXT,
  created_at TEXT NOT NULL, published_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ga_outbox_claim ON ga_outbox(status,lease_expires_at,id);
CREATE TABLE IF NOT EXISTS ga_worker_leases (
  resource_id TEXT PRIMARY KEY, owner TEXT NOT NULL, generation INTEGER NOT NULL,
  expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ga_idempotency (
  owner_id TEXT NOT NULL, operation TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL, response_status INTEGER, response_json TEXT,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,operation,idempotency_key)
);

CREATE TABLE IF NOT EXISTS ga_voice_transcriptions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
  client_request_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','transcribing','succeeded','failed','cancelled')),
  language TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(owner_id,conversation_id,client_request_id)
);
CREATE INDEX IF NOT EXISTS idx_ga_voice_transcriptions_expiry
  ON ga_voice_transcriptions(expires_at,status);
CREATE TABLE IF NOT EXISTS ga_runtime_bindings (
  run_id TEXT PRIMARY KEY REFERENCES ga_runs(id) ON DELETE CASCADE,
  harness_session_ref TEXT NOT NULL UNIQUE, runtime_run_id TEXT UNIQUE,
  runtime_owner TEXT, fence_epoch INTEGER, last_runtime_revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- Crawl batches are a product projection of the C-side native batch executor.
-- They are deliberately separate from ga_runs: a batch can settle while the
-- Harness run still has to summarize, compare sources, or create a file.
CREATE TABLE IF NOT EXISTS ga_crawl_batches (
  batch_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_count INTEGER NOT NULL,
  completed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
  summary_delivery_effect_id TEXT,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id,batch_id)
);
CREATE INDEX IF NOT EXISTS idx_ga_crawl_batches_run_status
  ON ga_crawl_batches(run_id,status,updated_at);

CREATE TABLE IF NOT EXISTS ga_crawl_items (
  batch_id TEXT NOT NULL REFERENCES ga_crawl_batches(batch_id) ON DELETE CASCADE,
  input_index INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT,
  source_id TEXT,
  result_ref TEXT,
  error_code TEXT,
  excerpt TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(batch_id,input_index),
  UNIQUE(batch_id,item_id)
);
CREATE INDEX IF NOT EXISTS idx_ga_crawl_items_status
  ON ga_crawl_items(batch_id,status,input_index);

CREATE TABLE IF NOT EXISTS ga_crawl_events (
  batch_id TEXT NOT NULL REFERENCES ga_crawl_batches(batch_id) ON DELETE CASCADE,
  event_seq INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(batch_id,event_seq)
);
