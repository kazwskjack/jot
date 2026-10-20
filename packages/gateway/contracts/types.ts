/** Proposed product contract v1. Generated from openapi.yaml; NOT upstream Harness types.
 * Validate network data with JSON Schema before feeding the reducer.
 * Decimal seq is a string; never convert it to JS Number.
 */
export type Error = { error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> }; request_id: string };

export type ModelSelection = { provider: string; model: string; reasoning_effort?: string };

export type CapabilitySet = { search: boolean; fetch: boolean; browser_interaction: boolean; file_read: boolean; file_edit: boolean; command_execution: boolean; questions: boolean; approvals: boolean; artifact_download: boolean; resume_checkpoint: boolean };

export type GitWorkbenchCapability = {configured_projects:string[];read_only:true};

export type Capabilities = { git_workbench?:GitWorkbenchCapability; conversation_commands?:{protocol:1;ordinary_steer:{configured:boolean;delivery:"original";attachments:boolean}}; conversation_modes?:{default:'chat'|'work';work:{supported:true};chat:{ready:boolean}};api_version: string; event_schema_version: string; adapter_version: string; capabilities: CapabilitySet; models: Array<{ provider: string; model: string; reasoning_output: "provider" | "summary" | "none"; supported_reasoning_efforts: Array<string> }>; limits: { max_upload_bytes: number; max_active_runs_per_conversation: 1; max_concurrent_sessions: 5; replay_retention_hours: number; idempotency_retention_hours: number }; voice?: { enabled: boolean; status: "disabled" | "unavailable" | "preparing" | "ready"; max_duration_ms: number; max_bytes: number; accepted_mime_types: string[]; languages: string[] }; workbench?: WorkbenchCapabilities; workspaces: Array<{ workspace_id: string; title: string; can_read: boolean; can_write: boolean }> };

export type VoiceTranscriptionRequest = { client_request_id: string; language?: string; audio: Blob };
export type VoiceTranscription = { transcription_id: string; status: "queued" | "transcribing" | "succeeded" | "failed" | "cancelled"; text?: string; language?: string; error_code?: "transcription_failed" | "result_expired" | "worker_restarted"; created_at: string; updated_at?: string };

export type Project = { project_id: string; title: string; is_default: boolean; version: number; created_at: string; updated_at: string; active_conversation_count?: number; archived_conversation_count?: number };
export type ProjectPage = { items: Project[] };

export type GitHead = {oid:string|null;branch:string|null;detached:boolean};
export type GitEntry = {path:string;original_path?:string;index_status:string;worktree_status:string;conflicted:boolean;kind:'file'|'directory'|'symlink'|'missing'|'other'};
export type GitRemote = {name:string;kind:'https'|'ssh'|'local'|'other';host?:string};
export type GitSnapshot = {project_id:string;snapshot_id:string;repository_sha256:string;head:GitHead;entries:GitEntry[];remotes:GitRemote[];omitted_count:number;read_only:true;execution_authorized:false};
export type GitDiff = {project_id:string;snapshot_id:string;path:string;stage:'working'|'staged';kind:'text'|'binary';patch:string;read_only:true;execution_authorized:false};
export type CreateProject = { title: string };
export type UpdateProject = { expected_version: number; title: string };

export type ConversationMode='chat'|'work';
export type Conversation = { mode?:ConversationMode;conversation_id: string; title: string; workspace_id: string; model: ModelSelection; created_at: string; updated_at: string; version: number; project_id: string; pinned: boolean; pinned_at: string | null; archived: boolean; archived_at: string | null };

export type CreateConversation = { mode?:ConversationMode;title?: string; workspace_id: string; model: ModelSelection; project_id?: string };

export type UpdateConversation = { mode?:ConversationMode;expected_version: number; title?: string; model?: ModelSelection; project_id?: string; pinned?: boolean; archived?: boolean };

export type ConversationPage = { items: Array<Conversation>; next_cursor?: string };

export type Run = { run_id: string; conversation_id: string; input_message_id: string | null; goal_control_id?:string; status: "queued" | "starting" | "partial" | "running" | "waiting_user" | "waiting_approval" | "cancelling" | "succeeded" | "failed" | "cancelled" | "interrupted"; version: number; created_at: string; updated_at: string; continuation_of?: string; checkpoint_id?: string; error_code?: string };

export type InputBlock = ({ type: "text"; text: string }) | ({ type: "file"; artifact_id: string });

export type SendMessage = { client_message_id: string; content: Array<InputBlock>; client_time_zone?: string };

export type MessageReceipt = { accepted: true; message_id: string; run_id: string; conversation_id: string };

export type SteerRequest = { attachments?: string[]; delivery?: "original"; client_message_id: string; expected_run_version: number; text: string };

export type CancelRequest = { expected_run_version: number; reason?: string };

export type ResumeRequest = { expected_run_version: number; checkpoint_id: string };

export type CommandReceipt = { accepted: true; command_id: string; run_id: string };

export type ResumeReceipt = { accepted: true; run_id: string; continuation_of: string };

export type ContentBlock = { block_id: string; kind: "text" | "reasoning" | "summary"; text: string; source_ids?: Array<string>; exposure?: "provider" | "summary" | "public" };

export type MessageAttachmentRef = { artifact_id: string; version: number; sha256: string; size_bytes: number; media_type: string; file_name: string };

export type Message = { message_id: string; run_id: string | null; role: "user" | "assistant"; status: "streaming" | "complete" | "partial" | "failed"; blocks: Array<ContentBlock>; attachments?: Array<string>; attachment_refs?: Array<MessageAttachmentRef>; created_at: string };

export type Source = { source_id: string; activity_id: string; url: string; title: string; host: string; access: "discovered" | "snippet" | "fetched" | "read" | "failed"; retrieved_at: string; excerpt?: string; error_code?: string };

export type Activity_search = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "search"; detail: { tool_name?: string; action?: string; urls?: string[]; url?: string; queries: Array<string>; provider?: string; source_ids: Array<string> } };

export type Activity_browse = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "partial" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "browse"; detail: { tool_name?: string; action?: string; urls?: string[]; operation: "open" | "fetch" | "click" | "type" | "scroll" | "capture" | "navigate" | "interact" | "execute" | "web_operation"; url?: string; source_ids: Array<string>; screenshot_artifact_id?: string; operation_kind?: "read_page" | "browse" | "execute" | "unknown"; request_id?: string; generation?: number; operation_id?: string; operation_status?: string; revision?: number; event_cursor?: number; accepted_count?: number; counts?: Record<string, number>; requested_action_types?: Array<"click" | "expand" | "next_page" | "scroll" | "wait" | "fill">; browse_outcome?: "success" | "pause" | "failure" | "unknown"; action_trace_count?: number; traced_action_types?: Array<"click" | "expand" | "next_page" | "scroll" | "wait" | "fill">; verification_statuses?: string[]; verified_action_types?: Array<"click" | "expand" | "next_page" | "scroll" | "wait" | "fill">; items?: Array<{ item_id: string; position: number; url?: string; status: string; attempt?: number; reason_code?: string; result_ref?: string; action_label?: string }> } };

export type Activity_file_edit = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "file_edit"; detail: { tool_name?: string; action?: string; urls?: string[]; url?: string; artifact_id?: string; display_path: string; operation: "create" | "edit" | "delete"; change_status: "proposed" | "staging" | "applied" | "failed" | "unknown"; before_version?: number; after_version?: number; before_sha256?: string; after_sha256?: string; diff_artifact_id?: string } };

export type Activity_file_read = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "file_read"; detail: { tool_name?: string; action?: string; urls?: string[]; url?: string; artifact_id?: string; display_path: string; version?: number } };

export type Activity_command = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "command"; detail: { tool_name?: string; action?: string; urls?: string[]; url?: string; display_command: string; exit_code?: number; output_artifact_id?: string } };

export type Activity_subagent = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "subagent"; detail: { tool_name?: string; action?: string; urls?: string[]; url?: string; child_run_id: string; summary?: string } };
export type Activity_crawl = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "partial" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "crawl"; detail: { tool_name?: string; action?: string; urls?: string[]; operation: "open" | "fetch" | "read" | "cancel"; batch_id: string; requested_count: number; completed_count: number; failed_count: number } };

export type Activity_compaction = { activity_id:string; run_id:string; attempt_id?:string; kind:"compaction"; status:"running"|"succeeded"|"failed"|"cancelled"|"unknown"; title:string; started_at:string; ended_at?:string; detail:{compaction_id:string;phase:"start"|"end"} };

export type Activity = (Activity_search) | (Activity_browse) | (Activity_file_edit) | (Activity_file_read) | (Activity_command) | (Activity_subagent) | (Activity_crawl) | (Activity_compaction);

export type Question = { question_id: string; prompt: string; description?: string; options: Array<{ option_id: string; label: string; description?: string }>; multiple: boolean; allow_custom: boolean };

export type QuestionAnswer = { question_id: string; selected_option_ids: Array<string>; custom_text?: string };

export type QuestionInteraction = { interaction_id: string; run_id: string; tool_call_id: string; version: number; status: "pending" | "answered" | "denied" | "cancelled" | "expired"; created_at: string; expires_at: string; kind: "question"; purpose?: "task_input" | "task_acceptance_review"; questions: Array<Question>; answers?: Array<QuestionAnswer> };

export type ApprovalInteraction = { interaction_id: string; run_id: string; tool_call_id: string; version: number; status: "pending" | "answered" | "denied" | "cancelled" | "expired"; created_at: string; expires_at: string; kind: "approval"; purpose?: "task_review" | "task_completion_review" | "task_reply_review"; action_digest: string; action_summary: string; risk: "low" | "medium" | "high"; decision?: "approve" | "deny" };

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
export type AgentEvent = ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "run.state"; payload: Run }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string | null; seq: string; at: string; type: "message.created"; payload: Message }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "assistant.delta"; payload: AssistantDelta }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "assistant.settled"; payload: AssistantSettled }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "activity.upsert"; payload: Activity }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "source.upsert"; payload: Source }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "interaction.requested"; payload: Interaction }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "interaction.resolved"; payload: Interaction }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "artifact.upsert"; payload: Artifact }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "run.artifact"; payload: RunArtifact }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "usage.updated"; payload: Usage }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "run.error"; payload: RunError }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: ProjectionEventType; payload: ProjectionPayload });

export type StreamReset = { reason: "cursor_expired" | "schema_changed" | "authorization_changed"; snapshot_required: true };

export type StreamCursor = { attempt_id: string; block_id: string; next_delta_index: number };

export type CrawlBatchSummary = { batch_id: string; run_id: string; status: string; requested_count: number; completed_count: number; failed_count: number; cancel_requested: boolean; last_event_seq: number; generation: number; created_at: string; updated_at: string };
export type Snapshot = { conversation: Conversation; as_of_seq: string; messages: Array<Message>; runs: Array<Run>; activities: Array<Activity>; sources: Array<Source>; interactions: Array<Interaction>; artifacts: Array<Artifact>; crawl_batches?: Array<CrawlBatchSummary>; stream_cursors: Array<StreamCursor>; history_complete: boolean; next_history_cursor?: string };

export type MessagePage = { items: Array<Message>; next_cursor?: string };

export type InteractionPage = { items: Array<Interaction> };

/** Workbench and persistent task DTOs mirror registered owner-scoped routes. */
export type WorkbenchCollaborationMode = ({ id: "single"; enabled: true }) | ({ id: "independent_team"; enabled: true }) | ({ id: "subagents"; enabled: false; reason: "HOST_ADAPTER_NOT_READY" }) | ({ id: "team"; enabled: false; reason: "DSH_EXPERIMENTAL_TEAM_NOT_READY" }) | ({ id: "handoff"; enabled: false; reason: "HOST_ADAPTER_NOT_READY" });
export type WorkbenchCapabilities = { enabled: boolean; agent_roles: boolean; independent_teams: boolean; agent_messages: boolean; shared_workspace: boolean; memory_scopes: Array<"project" | "private">; collaboration_modes: Array<WorkbenchCollaborationMode>; task_triggers: Array<"once" | "interval" | "page_change" | "daily" | "weekly" | "conversation_message" | "conversation_result">; task_schedule_limits?: WorkbenchTaskScheduleLimits; notification_channels: Array<"in_app">; allowed_tools: Array<"universe_capabilities" | "universe_search">; execution_ready: boolean; memory_lifecycle?: boolean; memory_restore?: boolean; memory_consolidation?: boolean; memory_retrieval_traces?: boolean; memory_capture?: boolean; memory_retrieval?: "local_keyword"; task_readiness?:boolean;task_prd?:boolean; task_unlimited_runs?: boolean; task_run_limit_protocol?: 1; model_budget?: boolean; task_model_budget_limits?: ModelBudgetLimits; task_reply_policy?: boolean; task_reply_execution?: false; task_create_delivery?: boolean; task_notifications?: boolean; channel_bindings?: boolean; email_bindings?: boolean; wecom_bindings?: boolean;task_notification_events?:TaskNotificationEventKind[] };
export type AgentRole = { agent_id: string; name: string; instructions: string; workspace_id: string; project_id: string; conversation_id: string; status: "active" | "disabled" | "deleting" | "deleted"; version: number; capability_epoch: number; allowed_tools: Array<"universe_capabilities" | "universe_search">; created_at: string; updated_at: string };
export type AgentRolePage = { items: Array<AgentRole> };
export type CreateAgentRole = { name: string; instructions?: string; workspace_id?: string; project_id?: string; allowed_tools?: Array<"universe_capabilities" | "universe_search"> };
export type UpdateAgentRole = { name?: string; instructions?: string; workspace_id?: string; project_id?: string; allowed_tools?: Array<"universe_capabilities" | "universe_search">; expected_version: number; status?: "active" | "disabled" };
export type AgentDeletionPreview = { agent_id: string; version: number; active_runs: Array<{ run_id: string; status: "queued" | "starting" | "running" | "waiting_user" | "waiting_approval" | "cancelling" }>; persistent_tasks: Array<{ task_id: string; status: "active" | "paused" | "budget_exhausted" }>; private_memory_count: number; pending_message_count: number };
export type AgentDeletionReceipt = { agent_id: string; status: "deleting" | "deleted" };
export type ExpectedVersion = { expected_version: number };
export type SendAgentRoleMessage = { text: string; client_message_id: string };
export type IndependentTeam = { team_id: string; name: string; workspace_id: string; project_id: string; status: "active" | "deleted"; version: number; created_at: string; updated_at: string; member_ids: Array<string> };
export type IndependentTeamPage = { items: Array<IndependentTeam> };
export type CreateIndependentTeam = { name: string; workspace_id?: string; project_id?: string; member_ids?: Array<string> };
export type UpdateIndependentTeam = { name?: string; member_ids?: Array<string>; expected_version: number };
export type IndependentTeamDeletion = { team_id: string; status: "deleted" };
export type WorkbenchWorkspace = { workspace_id: string; agents: Array<AgentRole>; teams: Array<IndependentTeam> };
export type AgentMailboxMessage = { message_id: string; workspace_id: string; project_id: string; sender_agent_id: string; recipient_agent_id: string; thread_id: string; root_causation_id: string; reply_to: string | null; text: string; initiator: "user" | "agent"; status: "pending" | "processing" | "completed" | "failed" | "outcome_unknown" | "recipient_deleted" | "sender_deleted" | "budget_exhausted" | "delivered" | "task_revoked"; auto_reply: boolean; run_id: string | null; created_at: string; updated_at: string };
export type AgentMailboxMessagePage = { items: Array<AgentMailboxMessage> };
export type CreateChannelBinding = {channel:'wecom'};
export type RevokeChannelBinding = {expected_version:number};
export type ChannelBinding = {channel_binding_id:string;channel:'wecom'|'email';status:'pending'|'verified'|'revoked'|'expired';version:number;created_at:string;verified_at:string|null;revoked_at:string|null;expires_at?:string};
export type ChannelBindingPage = {items:ChannelBinding[]};
export type ChannelBindingChallenge = {channel_binding_id:string;channel:'wecom';status:'pending';version:number;expires_at:string;requires_new_code:boolean;code?:string};
export type NotificationDeliveryPolicy = {min_interval_seconds:number;max_per_24_hours:number;quiet_hours:null|{start:string;end:string;timezone:string}};
export type TaskNotificationEventKind = 'changed'|'completed'|'failed'|'needs_confirmation';
export type TaskNotificationSettings = {task_id:string;version:number;channel_binding_ids:string[];events:TaskNotificationEventKind[];delivery_policy:NotificationDeliveryPolicy};
export type UpdateTaskNotifications = {expected_version:number;channel_binding_ids:string[];delivery_policy?:NotificationDeliveryPolicy;events?:TaskNotificationEventKind[]};
export type TaskNotificationDelivery = {delivery_id:string;channel:'wecom';status:'pending'|'sending'|'receipt_pending'|'delivered'|'outcome_unknown'|'cancelled'|'failed';reason:string|null;digest_size?:number;created_at:string;updated_at:string};
export type TaskNotificationDeliveryPage = {items:TaskNotificationDelivery[]};
export type TaskNotificationHistoryItem = TaskNotificationDelivery & {source:'execution'|'monitor';occurrence_id:string|null};
export type TaskNotificationHistoryPage = {items:TaskNotificationHistoryItem[];has_more:boolean;next_cursor:string|null};
export type SendAgentMailboxMessage = { sender_agent_id: string; recipient_agent_id: string; text: string; client_message_id: string; auto_reply?: boolean; max_replies?: number; task_run_id?: string };
export type WorkbenchMemory = { memory_id: string; workspace_id: string; project_id: string; scope: "project" | "private"; agent_id: string | null; content: string; verified: boolean; version: number; created_at: string; updated_at: string; provenance?: Array<WorkbenchMemoryProvenance>; source_revision?: string | null; expires_at?: string | null; supersedes?: string | null; verified_at?: string | null; status?: "active" | "superseded" | "deleted"; expired?: boolean; history?: Array<WorkbenchMemoryVersion> };
export type WorkbenchMemoryPage = { items: Array<WorkbenchMemory> };
export type SaveWorkbenchMemory = { scope: "project" | "private"; agent_id?: string; project_id?: string; content: string; verified?: boolean; memory_id?: string; expected_version?: number; provenance?: Array<WorkbenchMemoryProvenance>; source_revision?: string | null; expires_at?: string | null; supersedes?: string | null };
export type WorkbenchMemoryDeletion = { memory_id: string; status: "deleted" };
export type WorkbenchFile = { path: string; version: number; sha256: string; size: number; updated_at: string };
export type WorkbenchFilePage = { items: Array<WorkbenchFile>; next_cursor: string|null };
export type WorkbenchFileListQuery = { project_id: string; limit?: number; cursor?: string };
export type WorkbenchFileContent = { path: string; version: number; sha256: string; size: number; updated_at: string; content: string };
export type WriteWorkbenchFile = { project_id: string; path: string; content: string; expected_version: number };
export type PersistentTaskTrigger = ({ kind: "once"; run_at?: string }) | ({ kind: "interval"; interval_seconds?: number }) | ({ kind: "page_change"; interval_seconds?: number; url: string }) | ({ kind: "daily"; time: string; timezone: string }) | ({ kind: "weekly"; time: string; timezone: string; weekdays: Array<number> }) | ({ kind: "conversation_message" | "conversation_result"; conversation_id: string });
export type PersistentTaskBudget = { max_runs: number | null };
export type CreatePersistentTask = { reply_policy?: TaskReplyPolicy; notification_settings?: CreateTaskNotificationSettings; source?: { conversation_id: string; message_id: string }; title: string; agent_id: string; objective: string; trigger: PersistentTaskTrigger; priority?: number; budget?: PersistentTaskBudget; model_budget?: ModelBudgetLimits };
export type UpdatePersistentTask = { title?: string; agent_id?: string; objective?: string; trigger?: PersistentTaskTrigger; priority?: number; budget?: PersistentTaskBudget; expected_version: number };
export type PersistentTask = { source?: { conversation_id: string; message_id: string; content_sha256: string }; task_id: string; title: string; agent_id: string; objective: string; trigger: PersistentTaskTrigger | ProjectDiscoveryTaskTrigger; priority: number; budget: PersistentTaskBudget; status: "active" | "paused" | "archived" | "budget_exhausted"; version: number; generation: number; schedule_revision: number; runs_used: number; next_due_at: string | null; last_error: string | null; projection_pending: boolean; created_at: string; updated_at: string };
export type PersistentTaskPage = { items: Array<PersistentTask> };
export type TaskEvidence = { kind: string; reference: string; hash?: string };
export type TaskOccurrence = { occurrence_id: string; task_id: string; trigger_key: string; scheduled_for: string; generation: number; conversation_id: string; run_id: string; status: "queued" | "starting" | "running" | "waiting_user" | "waiting_approval" | "cancelling" | "succeeded" | "partial" | "failed" | "cancelled" | "interrupted" | "outcome_unknown"; business_state: "queued" | "starting" | "running" | "waiting_user" | "waiting_approval" | "cancelling" | "succeeded" | "partial" | "failed" | "cancelled" | "interrupted" | "outcome_unknown" | "waiting_review" | "waiting_evidence" | "evidence_recorded" | "input_requested" | "approval_requested" | "acceptance_confirmed" | "acceptance_rejected" | "completed"; completion_state?: "awaiting_completion" | "finalizing" | "reconciliation_pending" | "completed"; evidence: Array<TaskEvidence>; created_at: string; updated_at: string };
export type TaskOccurrencePage = { items: Array<TaskOccurrence> };
export type RunPersistentTaskNow = { client_message_id?: string };
export type CancelTaskOccurrence = { expected_run_version: number; client_message_id?: string };
export type TaskSubtask = { subtask_id: string; task_id: string; title: string; acceptance: string; status: "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled"; priority: number; dependencies: Array<string>; evidence: Array<TaskEvidence>; version: number; created_at: string; updated_at: string };
export type TaskSubtaskPage = { items: Array<TaskSubtask> };
export type UpsertTaskSubtask = { subtask_id?: string; expected_version?: number; title?: string; acceptance?: string; status?: "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled"; priority?: number; dependencies?: Array<string>; evidence?: Array<TaskEvidence> };
export type WorkbenchTaskScheduleLimits = { default_interval_seconds: 300; min_interval_seconds: 60; max_interval_seconds: 31536000; dst_gap: "next_valid_time"; dst_fold: "first_only"; missed_triggers: "coalesce" };
export type PreviewPersistentTask = { trigger: PersistentTaskTrigger };
export type PersistentTaskPreview = { next_due_at: string | null; timezone: string | null };
export type WorkbenchMemoryProvenance = { kind: string; reference: string };
export type WorkbenchMemoryVersion = { restored_from_version?: number; restored_over_version?: number; version: number; content: string; verified: boolean; provenance: Array<WorkbenchMemoryProvenance>; source_revision: string | null; expires_at: string | null; supersedes: string | null; verified_at: string | null; status: "active" | "superseded" | "deleted"; created_at: string; updated_at: string };
export type WorkbenchMemoryExport = { schema_version: 1; workspace_id: string; exported_at: string; items: Array<WorkbenchMemory> };
export type TaskReadinessDisplay = { label: string; readiness_score: number | null; business_status: string; evidence_count: number; completion_confirmed: boolean };
export type TaskReadinessAssessment = { revision: number; assessed_at: string; expires_at: string; scorer_version: string; calibration_version: null; model_raw_score: number | null; readiness_score: number; understanding: number; prerequisites: number; evidence_coverage: number; target_uniqueness: number; capability_health: number; uncertainty_reasons: Array<string> };
export type TaskReadinessView = { display: TaskReadinessDisplay; fresh: boolean; stale_reasons: Array<string>; latest: TaskReadinessAssessment | null };
export type TaskSubtaskReadiness = { subtask_id: string; subtask_version: number; display: TaskReadinessDisplay; fresh: boolean; stale_reasons: Array<string>; latest: TaskReadinessAssessment | null };
export type TaskReadinessCandidate = { task_id: string; subtask_id: string; title: string; priority: number; readiness_score: number; waiting_compensation: number; assessment_revision: number; observation_revision: string; next_action: "execute" | "gather_evidence" | "resolve_uncertainty"; uncertainty_reasons: Array<string> };
export type TaskReadiness = { task_id: string; parent: TaskReadinessView; subtasks: Array<TaskSubtaskReadiness>; next: { items: Array<TaskReadinessCandidate>; blocked: Array<{ subtask_id: string; title: string; reasons: Array<string> }> } };
export type ModelBudgetAmounts = { tokens: string; nano_usd: string; model_calls: string };
export type ModelBudgetAmountLimits = Omit<ModelBudgetAmounts,"nano_usd"> & {nano_usd:string|null};
export type ModelBudgetLimits = { tokens: number; nano_usd: number | null; model_calls: number };
export type ModelBudgetSummary = { kind: "task_total" | "owner_daily" | "project_daily" | "agent_daily"; limits: ModelBudgetAmountLimits; used: ModelBudgetAmounts; held: ModelBudgetAmounts; remaining: ModelBudgetAmountLimits; starts_at: string | null; ends_at: string | null };
export type TaskModelBudgetUnavailable = { configured: false; task_id: string; reason: "BUDGET_POLICY_NOT_CONFIGURED" };
export type TaskModelBudgetView = { configured: true; task_id: string; version: number; root: ModelBudgetSummary; ceiling: ModelBudgetAmountLimits; shared: Array<ModelBudgetSummary>; can_start_next_call: boolean; blocking_reasons: Array<string>; pending_unknown: number; token_accounting: "metered_routes_only"; unmetered_token_calls: number; cost_basis: "configured_rates"; currency: "USD"; as_of: string };
export type TaskModelBudget = TaskModelBudgetUnavailable | TaskModelBudgetView;
export type UpdateTaskModelBudget = { expected_version: number; limits: ModelBudgetLimits };
export type TaskSubtaskQuery = { occurrence_id?: string };

export type FileOperationRequest = { conversation_id: string; operation: "document.inspect" | "document.read" | "writer.replace_text" | "writer.set_table_cell" | "calc.set_cells" | "calc.recalculate" | "pdf.reorder_pages" | "pdf.rotate_pages"; base_version: number; base_sha256: string; target?: Record<string, unknown>; expected?: Record<string, unknown>; change?: Record<string, unknown>; save_as?: { format: "docx" | "xlsx" | "xls" | "pdf"; new_version: true } };

export type FileJob = { job_id: string; artifact_ref: string; operation: string; status: "queued" | "running" | "completed" | "failed"; base_version: number; output_version: number | null; result: Record<string, unknown> | null; error_code: string | null; created_at: string; updated_at: string };

export type WorkbenchFileReadQuery = { project_id: string; path: string; version?: number };


export type CreateTaskDelegation = { occurrence_id: string; subtask_id: string; expected_subtask_version: number; recipient_agent_id: string; client_message_id: string };
export type TaskDelegationReceipt = { delegation_id: string; message_id: string; occurrence_id: string; subtask_id: string; subtask_version: number; recipient_agent_id: string };

export type SaveTaskCollaboration = {expected_version:number;enabled:false} | {expected_version:number;enabled:true;team_id:string;member_ids:string[];max_delegations:number;max_active:1|2};
export type TaskCollaboration = {version:number;enabled:boolean;team_id:string|null;member_ids:string[];max_delegations:number;max_active:number};

export type CreateEmailBinding = {address:string};
export type ConfirmEmailBinding = {code:string};
export type EmailBindingChallenge = {channel_binding_id:string;channel:'email';status:'pending'|'consumed'|'verified'|'replaced';delivery_status:'sending'|'accepted'|'outcome_unknown';expires_at:string};
export type EmailBindingVerified = {channel_binding_id:string;channel:'email';status:'verified';version:number};

export type CreateTaskNotificationSettings = {channel_binding_ids:string[];delivery_policy?:NotificationDeliveryPolicy;events?:TaskNotificationEventKind[]};

export type TaskReplyPolicy = {mode:"report"}|{mode:"draft"|"review"|"bounded_auto_reply";target:{kind:"conversation";conversation_id:string}|{kind:"channel";channel_binding_id:string};direction:{topic:string;tone:string;evidence_required:true;forbidden:string[]};limits:{max_per_24_hours:number;min_interval_seconds:number;expires_at:string};quiet_hours:NotificationDeliveryPolicy["quiet_hours"]};
export type TaskReplyPolicySettings = {task_id:string;version:number;policy:TaskReplyPolicy};
export type UpdateTaskReplyPolicy = {expected_version:number;policy:TaskReplyPolicy};

export type TaskReplyHistoryItem = {draft_id:string;run_id:string;conversation_id:string;occurrence_id:string;mode:"draft"|"review"|"bounded_auto_reply";text:string;target:{kind:"conversation";conversation_id:string}|{kind:"channel";channel_binding_id:string};status:"draft"|"pending_review"|"review_expired"|"review_denied"|"waiting_dispatch"|"deferred"|"queued"|"sending"|"receipt_pending"|"delivered"|"cancelled"|"outcome_unknown"|"blocked";reason:string|null;not_before:string|null;interaction_id:string|null;message_id:string|null;delivery_id:string|null;created_at:string;updated_at:string};
export type TaskReplyHistoryPage = {items:TaskReplyHistoryItem[];has_more:boolean;next_cursor:string|null};

export type TaskReviewOutput = {output_index:number;source:"workspace"|"native"|"generated";file_name:string;version:number;size_bytes:number;sha256:string;mime_type:string;download_url:string};
export type WorkReviewEntry = {path:string;kind:'directory'}|{path:string;kind:'file';sha256:string;bytes:number;executable:boolean};
export type WorkReviewManifest = {protocol:1;provider:'snapshot-copy';paths:string[];entries:WorkReviewEntry[]};
export type WorkReviewChange = {kind:'add'|'delete'|'replace'|'modify'|'rename';path:string;from?:string;before?:WorkReviewEntry;after?:WorkReviewEntry;content_changed?:boolean;mode_changed?:boolean;case_only?:boolean};
export type WorkReviewDiff = {protocol:1;base_sha256:string;result_sha256:string;diff_sha256:string;execution_authorized:false;changes:WorkReviewChange[]};
export type TaskWorkReview = {protocol:1;source:'isolated';grant_id:string;work_occurrence_id:string;cycle_id:string;snapshot_id:string;
 selected_objective:string;source_sha256:string;source_record_sha256:string;plans_sha256:string;paths_sha256:string;call_set_sha256:string;inspection_sha256:string;
 base_manifest:WorkReviewManifest;result_manifest:WorkReviewManifest;
 diff:WorkReviewDiff;execution_authorized:false};
export type TaskReviewOutputPage = {items:TaskReviewOutput[];work_review?:TaskWorkReview};

export type RestoreWorkbenchMemory = { expected_version: number; source_version: number };
export type WorkbenchMemoryHistory = { memory_id: string; current_version: number; next_before_version: number | null; items: Array<WorkbenchMemoryVersion> };

export type MemoryConsolidationChange = {action:'rewrite';memory_id:string;content:string}|{action:'supersede';memory_id:string;replacement_id:string};
export type MemoryConsolidation = {consolidation_id:string;workspace_id:string;project_id:string;scope:'project'|'private';agent_id:string|null;status:'draft'|'proposed'|'applied'|'rolled_back'|'rejected';version:number;source_kind:'agent'|'user';sources:WorkbenchMemory[];proposal:{summary:string;changes:MemoryConsolidationChange[]}|null;results:{memory_id:string;version:number;status:'active'|'superseded'}[]|null;rollback_results:{memory_id:string;version:number;status:'active'|'superseded'}[]|null;created_at:string;updated_at:string};
export type MemoryConsolidationPage = {items:(Omit<MemoryConsolidation,'sources'|'proposal'|'results'|'rollback_results'>&{source_count:number;summary:string|null;change_count:number})[]};

export type StageMemoryConsolidation = {project_id:string;scope:'project'|'private';agent_id?:string|null;memory_ids:string[]};
export type MemoryConsolidationProposal = {summary:string;changes:MemoryConsolidationChange[]};
export type ProposeMemoryConsolidation = MemoryConsolidationProposal&{expected_version:number};
export type MemoryConsolidationCommand = {expected_version:number};
export type MemoryConsolidationResult = {memory_id:string;version:number;status:'active'|'superseded'};
export type MemoryConsolidationSummary = Omit<MemoryConsolidation,'sources'|'proposal'|'results'|'rollback_results'>&{source_count:number;summary:string|null;change_count:number};

export type MemoryRetrievalSummary = {retrieval_id:string;workspace_id:string;agent_id:string;project_id:string;run_id:string;source_run_id:string|null;kind:'context_snapshot'|'continuation_snapshot'|'tool_query';query:string;method:'scope_order'|'keyword'|'adapter'|'inherited';fallback_reason:'adapter_failed'|'invalid_adapter_result'|null;candidate_count:number;context_chars:number|null;excluded:{query_miss:number;result_limit:number;context_limit:number;duplicate:number;context_budget:number};result_count:number;created_at:string};
export type MemoryRetrievalReference = {scope:'project'|'private';memory_id:string;version:number;rank:number;reason:'scope_order'|'keyword_match'|'adapter_rank'|'adapter_tail'|'inherited';keyword_score:number|null;matched_terms:string[];content_chars:number;truncated:boolean;provenance_truncated:boolean;available:boolean;content_preview?:string;provenance?:WorkbenchMemoryProvenance[]};
export type MemoryRetrieval = MemoryRetrievalSummary&{references:MemoryRetrievalReference[]};
export type MemoryRetrievalPage = {items:MemoryRetrievalSummary[];next_before_id:string|null};

export type MemoryCapturePolicy ={agent_id:string;mode:'off'|'suggest';include_assistant:boolean;include_automation:boolean;version:number;current:boolean;updated_at:string|null};
export type MemoryCaptureSummary ={processing?:{status:string;reason_code:string|null}|null;capture_id:string;agent_id:string;workspace_id:string;project_id:string;source_run_id:string;source_conversation_id:string;run_kind:'chat'|'task'|'native_team'|'internal_mailbox';policy_version:number;policy_current:boolean;status:'watching'|'ready'|'proposed'|'applied'|'rejected'|'no_notes'|'no_source'|'source_failed'|'stale';version:number;source_count:number;notes_count:number;created_at:string;updated_at:string};
export type MemoryCaptureSource ={source_id:string;message_id:string;block_id:string;block_index:number;role:'user'|'assistant';origin:'human'|'agent'|'automation';content_sha256:string;truncated:boolean;available:boolean;text?:string};
export type MemoryCapture =MemoryCaptureSummary&{info:{captured_chars:number;truncated_blocks:number;omitted_blocks:number;excluded_blocks:number;source_status:string|null}|null;sources:MemoryCaptureSource[];proposal:{summary:string;notes:{content:string;source_ids:string[]}[]}|null;proposal_unavailable:boolean;results:{memory_id:string;version:number;reused:boolean}[]|null};
export type MemoryCapturePage ={items:MemoryCaptureSummary[];next_before_id:string|null};

export type UpdateMemoryCapturePolicy = {expected_version:number;mode:"off"|"suggest";include_assistant?:boolean;include_automation?:boolean};
export type MemoryCaptureCollection = {ready:number;skipped:number};
export type MemoryCaptureCommand = {expected_version:number};
export type EmptyObject = Record<string,never>;

export type ConversationGoalView = {goal: {id:string;revision:number;objective:string;phase:'active'|'paused'|'blocked'|'complete';activation:'armed'|'disarmed';maxGoalRounds?:number;roundsStarted?:number;createdAt?:number;updatedAt?:number;blockedReason?:{code:string;message:string}}|null};
export type ConversationGoalCommand = {action:'pause'|'resume'|'stop';id:string;revision:number};

export type ConversationGoalAccepted = {accepted:true;control_id:string;run_id:string;conversation_id:string};
export type ConversationGoalResumeReadiness = {enabled:boolean;ready:boolean;reason:'READY'|'DISABLED'|'NO_SESSION'|'RUN_BUSY'|'UNCONFIRMED_CONTROL'|'HOST_UNAVAILABLE'};

export type DiscoveryPolicySave = {expected_version:number;expected_role_version:number;expected_role_epoch:number;mode:'discover_only'|'discover_and_work';cooldown_ms:number;recent_input_ms:number;max_cycles:number|null};
export type DiscoveryPolicyControl = {action:'enable';expected_version:number;expected_role_version:number;expected_role_epoch:number}|{action:'pause'|'stop';expected_version:number};
export type DiscoveryPolicyReceipt = {policy_id:string;scope:{project_id:string;workspace_id:string;agent_id:string};version:number;role_version:number;role_epoch:number;state:'off'|'active'|'paused'|'stopped';mode:'discover_only'|'discover_and_work';cooldown_ms:number;recent_input_ms:number;max_cycles:number|null;execution_authorized:false};
export type DiscoveryPolicyStatus = {policy:(DiscoveryPolicyReceipt&{effective_state:DiscoveryPolicyReceipt['state']|'revoked'})|null;execution_authorized:false};

export type ProjectDiscoveryTaskTrigger = {kind:"project_discovery";policy_id:string};

export type TaskPrdSelection = {kind:"logical_file";path:string;version:number;sha256:string}|{kind:"upload";artifact_id:string;version:number;sha256:string};
export type TaskPrdSource = TaskPrdSelection & {name:string;size:number};
export type TaskPrdPreviewRequest = {source:TaskPrdSelection};
export type TaskPrdBindRequest = {source:TaskPrdSelection;preview_sha256:string};
export type TaskPrdReceipt = {binding_id:string;task_id:string;task_version:number;revision:number;source:TaskPrdSource;content_sha256:string;objective_sha256:string;created_at:string;execution_authorized:false};
export type TaskPrdPreview = {task_id:string;task_version:number;role:{agent_id:string;version:number;capability_epoch:number};source:TaskPrdSource;content:string;objective:string;preview_sha256:string;execution_authorized:false};
export type TaskPrdSources = {task_id:string;task_version:number;readiness:{ready:boolean;reasons:string[]};sources:TaskPrdSource[];truncated:boolean;binding:TaskPrdReceipt|null};

export type GitReviewPrepare = {request_id:string;action:"stage"|"unstage"|"commit"|"discard"|"delete-untracked";paths:string[];snapshot_id:string;message?:string};
export type GitReviewControl = {request_id:string;expected_version:number;action:"approve"|"cancel";review_sha256:string};
export type GitReviewIntent = {intent_id:string;project_id:string;action:GitReviewPrepare["action"];paths:string[];message?:string;snapshot_id:string;review_sha256:string;version:number;state:"prepared"|"approved"|"cancelled";created_at:string;updated_at:string;execution_authorized:false};

export type GitIndexAcceptance = {execution_id:string;project_id:string;intent_id:string;request_id:string;action:"stage"|"unstage";accepted:true;execution_authorized:false};
export type GitIndexExecutionResult = Omit<GitIndexAcceptance,"accepted"> & {paths:string[]} & ({state:"pending"|"unknown"}|{state:"applied";before_index_sha256:string|null;index_sha256:string}|{state:"not_dispatched"|"abandoned_unknown";disposition_id:string});

export type WorkPublicationPrepare = {request_id:string;source_run_id:string;source_sha256:string;paths:string[]};
export type WorkPublicationControl = GitReviewControl;
export type WorkPublicationSource = {source:'isolated';workspace_id:string;project_id:string;agent_id:string;task_id:string;occurrence_id:string;run_id:string;
 final_message_id:string;candidate_id:string;certificate_id:string;completion_intent_id:string;snapshot_sha256:string;candidate_sha256:string;native_proof_sha256:string;source_sha256:string;files:Array<{path:string;version:number;sha256:string;size_bytes:number;receipt_id:string;producing_run_id:string}>;work_review:TaskWorkReview};
export type WorkPublicationTarget = {snapshot_id:string;repository_sha256:string;head:GitSnapshot['head'];index_sha256:string|null;target_sha256:string};
export type WorkPublicationChange = {path:string;kind:'add'|'modify';before:WorkReviewEntry|null;after:WorkReviewEntry;before_text:string|null;after_text:string};
export type WorkPublicationReview = {intent_id:string;project_id:string;source:WorkPublicationSource;target:WorkPublicationTarget;changes:WorkPublicationChange[];paths:string[];
 review_sha256:string;version:number;state:'prepared'|'approved'|'cancelled';created_at:string;updated_at:string;execution_authorized:false};

export type WorkPublicationAdmission = {request_id:string;expected_version:number;review_sha256:string};
export type WorkPublicationAcceptance = {protocol:1;execution_id:string;operation_kind:'work_publication';project_id:string;intent_id:string;request_id:string;
 review_version:number;review_sha256:string;source_sha256:string;target_sha256:string;state:'accepted';accepted_at:string;execution_authorized:false};
export type WorkPublicationStatus = {execution_id:string;project_id:string;intent_id:string;request_id:string;state:'not_started'|'running'|'interrupted'|'unknown'|'prepared'|'cancelled_before_preparation'|'failed_before_preparation'|'applied'|'abandoned_unknown'|'applied_pending_settlement'|'abandon_pending_settlement';
 files:Array<{path:string;sha256:string;size:number}>;pending_path:string|null;journal_sha256:string|null;execution_authorized:false};

export type WorkPublicationDispatch = Record<string,never>;
export type WorkPublicationSettlementCommand = {request_id:string;action:'confirm_recorded'|'abandon_unknown';expected_journal_sha256:string;acknowledge_unknown:true};
export type WorkPublicationSettlementReceipt = WorkPublicationSettlementCommand & {execution_id:string;project_id:string;disposition_sha256:string;recorded_at:string;execution_authorized:false};
export type WorkPublicationSettlementResult = {receipt:WorkPublicationSettlementReceipt;status:WorkPublicationStatus};
export type WorkPublicationHistoryItem = Pick<WorkPublicationReview,'intent_id'|'project_id'|'paths'|'review_sha256'|'version'|'state'|'created_at'|'updated_at'|'execution_authorized'> & {source_run_id:string;source_sha256:string;acceptance:WorkPublicationAcceptance|null;status:WorkPublicationStatus|null};
export type WorkPublicationHistory = {project_id:string;source_run_id:string;items:WorkPublicationHistoryItem[];next_cursor:string|null};

export type GitIndexAdmissionInput = {request_id:string;expected_version:number;review_sha256:string};
export type GitIndexControlInput = {request_id:string;expected_state_sha256:string;acknowledge_unknown:true};
export type GitIndexControlAcceptance = {control_id:string;execution_id:string;project_id:string;request_id:string;expected_state_sha256:string;accepted:true;execution_authorized:false};
export type GitIndexInspection = {execution:GitIndexExecutionResult;state_sha256:string;requires_unknown_acknowledgement:boolean;execution_authorized:false};
export type GitIndexControlReceipt = {control_id:string;execution_id:string;request_id:string;execution_authorized:false} & ({state:"pending"}|{state:"completed";result:Exclude<GitIndexExecutionResult,{state:"pending"|"unknown"}>;cleanup:"verified"|"unverified"|"not_recorded"|"not_attempted"});

export type GitIndexDispatchInput = Record<string,never>;
export type GitIndexProducer = {execution_id:string;execution_authorized:false;state:"not_started"|"legacy_untracked"|"running"|"interrupted"|"failed_before_preparation"|"cancelled_before_preparation"|"prepared"|"unknown"|"applied"};
export type GitIndexStatus = GitIndexInspection & {producer:GitIndexProducer;workspace_state:"not_reserved"|"reserved"|"released_unstarted"|"released_settled";control:GitIndexControlAcceptance|null;control_receipt:GitIndexControlReceipt|null};
export type GitIndexResolutionResult = {receipt:Extract<GitIndexControlReceipt,{state:"completed"}>;status:GitIndexStatus};

export type GitIndexHistoryItem = {created_at:string;acceptance:GitIndexAcceptance;status:GitIndexStatus};
export type GitIndexHistory = {project_id:string;items:GitIndexHistoryItem[];next_cursor:string|null;execution_authorized:false};
