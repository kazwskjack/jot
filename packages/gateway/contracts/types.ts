/** Proposed product contract v1. Generated from openapi.yaml; NOT upstream Harness types.
 * Validate network data with JSON Schema before feeding the reducer.
 * Decimal seq is a string; never convert it to JS Number.
 */
export type Error = { error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> }; request_id: string };

export type ModelSelection = { provider: string; model: string; reasoning_effort?: string };

export type CapabilitySet = { search: boolean; fetch: boolean; browser_interaction: boolean; file_read: boolean; file_edit: boolean; command_execution: boolean; questions: boolean; approvals: boolean; artifact_download: boolean; resume_checkpoint: boolean };

export type Capabilities = { api_version: string; event_schema_version: string; adapter_version: string; capabilities: CapabilitySet; models: Array<{ provider: string; model: string; reasoning_output: "provider" | "summary" | "none"; supported_reasoning_efforts: Array<string> }>; limits: { max_upload_bytes: number; max_active_runs_per_conversation: 1; max_concurrent_sessions: 5; replay_retention_hours: number; idempotency_retention_hours: number }; voice?: { enabled: boolean; status: "disabled" | "unavailable" | "preparing" | "ready"; max_duration_ms: number; max_bytes: number; accepted_mime_types: string[]; languages: string[] }; workspaces: Array<{ workspace_id: string; title: string; can_read: boolean; can_write: boolean }> };

export type VoiceTranscriptionRequest = { client_request_id: string; language?: string; audio: Blob };
export type VoiceTranscription = { transcription_id: string; status: "queued" | "transcribing" | "succeeded" | "failed" | "cancelled"; text?: string; language?: string; error_code?: "transcription_failed" | "result_expired" | "worker_restarted"; created_at: string; updated_at?: string };

export type Project = { project_id: string; title: string; is_default: boolean; version: number; created_at: string; updated_at: string; active_conversation_count?: number; archived_conversation_count?: number };
export type ProjectPage = { items: Project[] };
export type CreateProject = { title: string };
export type UpdateProject = { expected_version: number; title: string };

export type Conversation = { conversation_id: string; title: string; workspace_id: string; model: ModelSelection; created_at: string; updated_at: string; version: number; project_id: string; pinned: boolean; pinned_at: string | null; archived: boolean; archived_at: string | null };

export type CreateConversation = { title?: string; workspace_id: string; model: ModelSelection; project_id?: string };

export type UpdateConversation = { expected_version: number; title?: string; model?: ModelSelection; project_id?: string; pinned?: boolean; archived?: boolean };

export type ConversationPage = { items: Array<Conversation>; next_cursor?: string };

export type Run = { run_id: string; conversation_id: string; input_message_id: string; status: "queued" | "starting" | "partial" | "running" | "waiting_user" | "waiting_approval" | "cancelling" | "succeeded" | "failed" | "cancelled" | "interrupted"; version: number; created_at: string; updated_at: string; continuation_of?: string; checkpoint_id?: string; error_code?: string };

export type InputBlock = ({ type: "text"; text: string }) | ({ type: "file"; artifact_id: string });

export type SendMessage = { client_message_id: string; content: Array<InputBlock>; client_time_zone?: string };

export type MessageReceipt = { accepted: true; message_id: string; run_id: string; conversation_id: string };

export type SteerRequest = { client_message_id: string; expected_run_version: number; text: string };

export type CancelRequest = { expected_run_version: number; reason?: string };

export type ResumeRequest = { expected_run_version: number; checkpoint_id: string };

export type CommandReceipt = { accepted: true; command_id: string; run_id: string };

export type ResumeReceipt = { accepted: true; run_id: string; continuation_of: string };

export type ContentBlock = { block_id: string; kind: "text" | "reasoning" | "summary"; text: string; source_ids?: Array<string>; exposure?: "provider" | "summary" | "public" };

export type Message = { message_id: string; run_id: string; role: "user" | "assistant"; status: "streaming" | "complete" | "partial" | "failed"; blocks: Array<ContentBlock>; attachments?: Array<string>; created_at: string };

export type Source = { source_id: string; activity_id: string; url: string; title: string; host: string; access: "discovered" | "snippet" | "fetched" | "read" | "failed"; retrieved_at: string; excerpt?: string; error_code?: string };

export type Activity_search = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "search"; detail: { tool_name?: string; action?: string; urls?: string[]; url?: string; queries: Array<string>; provider?: string; source_ids: Array<string> } };

export type Activity_browse = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "partial" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "browse"; detail: { tool_name?: string; action?: string; urls?: string[]; operation: "open" | "fetch" | "click" | "type" | "scroll" | "capture" | "navigate" | "interact" | "execute" | "web_operation"; url?: string; source_ids: Array<string>; screenshot_artifact_id?: string; operation_kind?: "read_page" | "browse" | "execute" | "unknown"; request_id?: string; generation?: number; operation_id?: string; operation_status?: string; revision?: number; event_cursor?: number; accepted_count?: number; counts?: Record<string, number>; requested_action_types?: Array<"click" | "expand" | "next_page" | "scroll" | "wait" | "fill">; browse_outcome?: "success" | "pause" | "failure" | "unknown"; action_trace_count?: number; traced_action_types?: Array<"click" | "expand" | "next_page" | "scroll" | "wait" | "fill">; verification_statuses?: string[]; verified_action_types?: Array<"click" | "expand" | "next_page" | "scroll" | "wait" | "fill">; items?: Array<{ item_id: string; position: number; url?: string; status: string; attempt?: number; reason_code?: string; result_ref?: string; action_label?: string }> } };

export type Activity_file_edit = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "file_edit"; detail: { tool_name?: string; action?: string; urls?: string[]; url?: string; artifact_id?: string; display_path: string; operation: "create" | "edit" | "delete"; change_status: "proposed" | "staging" | "applied" | "failed" | "unknown"; before_version?: number; after_version?: number; before_sha256?: string; after_sha256?: string; diff_artifact_id?: string } };

export type Activity_file_read = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "file_read"; detail: { tool_name?: string; action?: string; urls?: string[]; url?: string; artifact_id?: string; display_path: string; version?: number } };

export type Activity_command = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "command"; detail: { tool_name?: string; action?: string; urls?: string[]; url?: string; display_command: string; exit_code?: number; output_artifact_id?: string } };

export type Activity_subagent = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "subagent"; detail: { tool_name?: string; action?: string; urls?: string[]; url?: string; child_run_id: string; summary?: string } };
export type Activity_crawl = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "partial" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "crawl"; detail: { tool_name?: string; action?: string; urls?: string[]; operation: "open" | "fetch" | "read" | "cancel"; batch_id: string; requested_count: number; completed_count: number; failed_count: number } };

export type Activity = (Activity_search) | (Activity_browse) | (Activity_file_edit) | (Activity_file_read) | (Activity_command) | (Activity_subagent) | (Activity_crawl);

export type Question = { question_id: string; prompt: string; description?: string; options: Array<{ option_id: string; label: string; description?: string }>; multiple: boolean; allow_custom: boolean };

export type QuestionAnswer = { question_id: string; selected_option_ids: Array<string>; custom_text?: string };

export type QuestionInteraction = { interaction_id: string; run_id: string; tool_call_id: string; version: number; status: "pending" | "answered" | "denied" | "cancelled" | "expired"; created_at: string; expires_at: string; kind: "question"; questions: Array<Question>; answers?: Array<QuestionAnswer> };

export type ApprovalInteraction = { interaction_id: string; run_id: string; tool_call_id: string; version: number; status: "pending" | "answered" | "denied" | "cancelled" | "expired"; created_at: string; expires_at: string; kind: "approval"; action_digest: string; action_summary: string; risk: "low" | "medium" | "high"; decision?: "approve" | "deny" };

export type Interaction = (QuestionInteraction) | (ApprovalInteraction);

export type QuestionResponse = { expected_version: number; answers: Array<QuestionAnswer> };

export type ApprovalDecision = { expected_version: number; action_digest: string; decision: "approve" | "deny" };

export type InteractionReceipt = { accepted: true; interaction_id: string; run_id: string; status: "answered" | "denied"; version: number };

export type ArtifactBackupStatus = "pending" | "retry" | "verified" | "failed";

export type Artifact = { artifact_id: string; conversation_id: string; run_id?: string; file_name: string; media_type: string; size_bytes: number; sha256: string; version: number; status: "quarantined" | "ready" | "rejected" | "deleted"; created_at: string; preview_kind: "text" | "image" | "unsupported"; origin: "upload" | "generated" | "edited"; local_state?: "present" | "deleted" | "restoring"; backup_status?: ArtifactBackupStatus; remote_path?: string; restorable?: boolean };

export type RunArtifact = { run_id: string; conversation_id: string; artifact_id: string; version: number; file_name: string; media_type: string; size_bytes: number; sha256: string; status: string; local_state?: "present" | "deleted" | "restoring"; backup_status?: ArtifactBackupStatus; created_at: string; download_url: string };

export type RunArtifactPage = { items: Array<RunArtifact> };

export type ArtifactBackup = { artifact_id: string; backup_status: ArtifactBackupStatus; local_state: "present" | "deleted" | "restoring"; remote_path?: string; remote_size?: number; verified_at?: string; restorable: boolean };

export type ArtifactRestoreReceipt = { accepted: true; artifact_id: string; status: "ready" | "restoring" };

export type UploadInit = { file_name: string; media_type: string; size_bytes: number; sha256: string };

export type UploadReceipt = { upload_id: string; expires_at: string; max_bytes: number };

export type UploadComplete = { sha256: string };

export type Preview = { artifact_id: string; version: number; kind: "text" | "image" | "unsupported"; text?: string; image_path?: string; truncated: boolean };

export type Diff = { artifact_id: string; from_version: number; to_version: number; unified_diff: string; truncated: boolean };

export type Usage = { run_id: string; input_tokens?: number; output_tokens?: number; reasoning_tokens?: number; cache_read_tokens?: number; measured_at: string };

export type AssistantDelta = { message_id: string; block_id: string; kind: "text" | "reasoning" | "summary"; attempt_id: string; delta_index: number; text: string };

export type AssistantSettled = { message: Message; attempt_id: string };

export type RunError = { run_id: string; code: string; message: string; retryable: boolean; reconciliation_required: boolean };

export type ProjectionEventType = "goal.updated" | "progress.updated" | "runtime.outcome" | "checkpoint.upsert" | "delivery.upsert" | "response.upsert";
export interface ProjectionPayload { revision: number; value: Record<string, unknown> }
export type AgentEvent = ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "run.state"; payload: Run }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "message.created"; payload: Message }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "assistant.delta"; payload: AssistantDelta }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "assistant.settled"; payload: AssistantSettled }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "activity.upsert"; payload: Activity }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "source.upsert"; payload: Source }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "interaction.requested"; payload: Interaction }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "interaction.resolved"; payload: Interaction }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "artifact.upsert"; payload: Artifact }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "run.artifact"; payload: RunArtifact }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "usage.updated"; payload: Usage }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "run.error"; payload: RunError }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: ProjectionEventType; payload: ProjectionPayload });

export type StreamReset = { reason: "cursor_expired" | "schema_changed" | "authorization_changed"; snapshot_required: true };

export type StreamCursor = { attempt_id: string; block_id: string; next_delta_index: number };

export type CrawlBatchSummary = { batch_id: string; run_id: string; status: string; requested_count: number; completed_count: number; failed_count: number; cancel_requested: boolean; last_event_seq: number; generation: number; created_at: string; updated_at: string };
export type Snapshot = { conversation: Conversation; as_of_seq: string; messages: Array<Message>; runs: Array<Run>; activities: Array<Activity>; sources: Array<Source>; interactions: Array<Interaction>; artifacts: Array<Artifact>; crawl_batches?: Array<CrawlBatchSummary>; stream_cursors: Array<StreamCursor>; history_complete: boolean; next_history_cursor?: string };

export type MessagePage = { items: Array<Message>; next_cursor?: string };

export type InteractionPage = { items: Array<Interaction> };
