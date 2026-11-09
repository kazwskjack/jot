/** Proposed product contract v1. Generated from openapi.yaml; NOT upstream Harness types.
 * Validate network data with JSON Schema before feeding the reducer.
 * Decimal seq is a string; never convert it to JS Number.
 */
export type Error = { error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> }; request_id: string };

export type ModelCompatibility={input_modalities:string[]|null;context_window:number|null;default_max_tokens:number|null;default_reasoning_effort:string|null;digest_revision:'jot-model-metadata-v1';metadata_digest:string;execution_authorized:false};
export type ModelRouteHealth={status:'healthy'|'unhealthy'|'stale'|'unknown';observed_at:number|null;expires_at:number|null};
export type ModelSelection = { provider: string; model: string; reasoning_effort?: string; fallbacks?:Array<{provider:string;model:string}> };

export type CapabilitySet = { search: boolean; fetch: boolean; browser_interaction: boolean; file_read: boolean; file_edit: boolean; command_execution: boolean; questions: boolean; approvals: boolean; artifact_download: boolean; resume_checkpoint: boolean };

export type GitWorkbenchCapability = {configured_projects:string[]} & ({read_only:true}|{read_only:false;index_actions:['stage','unstage'];commit_projects?:string[];branch_projects?:string[];initialization_projects?:string[];reinitialization_projects?:string[]});

export type WorkspaceSelection = {workspace_id:string;version:number;configured:boolean};
export type SelectWorkspace = {workspace_id:string;expected_version:number};
export type Capabilities = { workspace_selection?:WorkspaceSelection; git_workbench?:GitWorkbenchCapability; conversation_commands?:{protocol:1;ordinary_steer:{configured:boolean;delivery:"original";attachments:boolean}}; conversation_modes?:{default:'chat'|'work';work:{supported:true};chat:{ready:boolean}};api_version: string; event_schema_version: string; adapter_version: string; capabilities: CapabilitySet; models: Array<{ provider: string; model: string; reasoning_output: "provider" | "summary" | "none"; supported_reasoning_efforts: Array<string>; health?:ModelRouteHealth;label?:string;compatibility?:ModelCompatibility }>; limits: { max_upload_bytes: number; max_active_runs_per_conversation: 1; max_concurrent_sessions: 5; replay_retention_hours: number; idempotency_retention_hours: number }; voice?: { enabled: boolean; status: "disabled" | "unavailable" | "preparing" | "ready"; max_duration_ms: number; max_bytes: number; accepted_mime_types: string[]; languages: string[] }; workbench?: WorkbenchCapabilities; workspaces: Array<{ workspace_id: string; title: string; can_read: boolean; can_write: boolean }> };

export type VoiceTranscriptionRequest = { client_request_id: string; language?: string; audio: Blob };
export type VoiceTranscription = { transcription_id: string; status: "queued" | "transcribing" | "succeeded" | "failed" | "cancelled"; text?: string; language?: string; error_code?: "transcription_failed" | "result_expired" | "worker_restarted"; created_at: string; updated_at?: string };

export type Project = { project_id: string; title: string; is_default: boolean; version: number; created_at: string; updated_at: string; active_conversation_count?: number; archived_conversation_count?: number };
export type ProjectPage = { items: Project[] };
export type ProjectLifecycle = Project & {archived_at:string|null;deleted_at:string|null};
export type ProjectLifecyclePage = {items:ProjectLifecycle[]};
export type UpdateProjectLifecycle = {action:'archive'|'restore'|'delete';expected_version:number};

export type GitHead = {oid:string|null;branch:string|null;detached:boolean};
export type GitEntry = {path:string;original_path?:string;index_status:string;worktree_status:string;conflicted:boolean;kind:'file'|'directory'|'symlink'|'missing'|'other'};
export type GitRemote = {name:string;kind:'https'|'ssh'|'local'|'other';host?:string};
export type GitSnapshot = {commit_identity_ready?:boolean;project_id:string;snapshot_id:string;repository_sha256:string;head:GitHead;entries:GitEntry[];remotes:GitRemote[];omitted_count:number;read_only:true;execution_authorized:false};
export type GitCheckoutContent={size:number|null;sha256:string|null;attributes?:Array<{name:string;value:string}>;reason?:'source_unconfirmed'|'attribute_source_unconfirmed'|'filter_policy_required'|'read_failed'|'output_limit'|'deadline'|'sparse_policy_required'};
export type GitCheckoutBefore={path:string;kind:'missing'|'blocked'|'file'|'directory'|'symlink'|'other';size:number;mode:number;stat_sha256:string|null;sha256:string|null;ancestors_sha256:string;blocked_by?:string};
export type GitCheckoutDirectoryEntry=GitCheckoutBefore&{parent:string|null;uid:string;gid:string;listing_sha256?:string};
export type GitCheckoutDirectories={state:'not_confirmed';reason:'before_unconfirmed'|'deadline'|'entry_limit'|'path_limit'|'read_unavailable'}|{
 state:'captured';protocol:1;roots:string[];entries:GitCheckoutDirectoryEntry[];
 issues:Array<{path:string;reason:'nested_repository'|'protected_path'|'path_alias'|'content_unconfirmed'|'special_node'}>;complete:boolean;sha256:string;
};
export type GitCheckoutBeforeState={sha256:string;entries:GitCheckoutBefore[]};
export type GitCheckoutPhysical=GitReinitializationDirectory&{stat_sha256:string};
export type GitCheckoutMetadataFile=GitBranchLogFile&{physical?:GitCheckoutPhysical|null};
export type GitCheckoutMetadataLayout={root:GitCheckoutPhysical;git:GitCheckoutPhysical;common:GitCheckoutPhysical;parents:Array<{scope:'git'|'common';path:string;before:GitCheckoutPhysical|null}>};
export type GitCheckoutReferenceChain={nodes:Array<{scope:'git'|'common';path:string;file:GitCheckoutMetadataFile;symbolic_target:string|null}>;oid:string|null};
export type GitCheckoutCreation={state:'not_required'}|{state:'not_confirmed';reason:'platform_policy_required'|'owner_policy_required'|'native_policy_required'}|{state:'observed';file:{mode:number;uid:string;gid:string};directory:{created:boolean;mode:number;uid:string;gid:string};umask:number;policy_sha256:string};
export type GitCheckoutReferenceSource={
 creation?:GitCheckoutCreation;chains?:{head:GitCheckoutReferenceChain;target:GitCheckoutReferenceChain}|null;layout?:GitCheckoutMetadataLayout;protocol:1;source_metadata_sha256:string;head_file:GitCheckoutMetadataFile;head_log:GitCheckoutMetadataFile;
 source_ref:{ref:string;file:GitCheckoutMetadataFile}|null;target_ref:{ref:string;file:GitCheckoutMetadataFile};
 target_log:GitCheckoutMetadataFile;packed_refs:GitCheckoutMetadataFile;
 configuration:{common:GitCheckoutMetadataFile;worktree:GitCheckoutMetadataFile;worktree_enabled:boolean};
 log_policy:Pick<GitBranchLogWitness,'configuration'|'enabled'>;
};
export type GitCheckoutPreview={reference_source?:GitCheckoutReferenceSource;target_ref:string;target_oid:string;source_index_sha256:string|null;working_tree_check:'passed'|'not_confirmed';index_projection:{sha256:string;entries_sha256:string;entry_count:number;directories_before?:GitCheckoutDirectories;worktree_before?:GitCheckoutBeforeState|null;worktree_attribute_before?:GitCheckoutBeforeState|null;attributes?:Array<{path:string;name:string;value:string}>;changes:Array<{path:string;before:{mode:string;oid:string;blob?:{size:number;sha256:string|null}}|null;after:{mode:string;oid:string;blob?:{size:number;sha256:string|null};worktree_content?:GitCheckoutContent}|null}>}|null;execution_authorized:false};
export type GitBranchInventory={project_id:string;snapshot_id:string;repository_sha256:string;head:GitHead;object_format:'sha1'|'sha256';branches:Array<{ref:string;name:string;kind:'local'|'remote';oid:string;object_type:'commit'|'tag'|'tree'|'blob';current:boolean;symbolic_target?:string;checkout_oid?:string|null;worktree_uses?:Array<{worktree:'current'|'other';reason:'head'|'rebase'|'bisect'|'update_refs'}>}>;checkout_preview?:GitCheckoutPreview;read_only:true;execution_authorized:false};
export type GitCheckoutReviewPrepare={request_id:string;action:'checkout-branch';snapshot_id:string;target_ref:string};
export type GitCheckoutReviewControl={request_id:string;expected_version:number;action:'cancel';review_sha256:string};
export type GitCheckoutMetadataPublication={state:'not_confirmed';reason:'layout_required'|'reference_policy_required'|'log_after_required'}|{
 state:'planned';protocol:1;execution_authorized:false;
 directories?:Array<{scope:'git';path:'logs';mode:number;uid:string;gid:string}>;
 files:Array<{scope:'git';path:'HEAD'|'logs/HEAD';operation:'replace'|'append';before:GitCheckoutMetadataFile;after:{sha256:string;size:number};
  permissions:{state:'preserve'|'create';mode:number;uid:string;gid:string}|{state:'creation_policy_required'}}>;
 locks:Array<{scope:'git'|'common';path:string}>;
};
export type GitCheckoutLogAfter={state:'appended';sha256:string;size:number}|{state:'retained';sha256:string|null;size:number}|{state:'not_confirmed';reason:'reference_policy_required'|'identity_unconfigured'|'log_format_required'|'output_limit'};
export type GitCheckoutLogMetadata={protocol:1;committer:GitCommitMetadata['committer'];operator_policy_sha256:string;entry_sha256:string;entry_size:number};
export type GitCheckoutReferencePlan={state:'policy_required';reason:'local_non_commit_target'}|{
 state:'planned';protocol:1;mode:'branch'|'detached';head:GitHead;head_file:{sha256:string;size:number};
 head_log:{append:boolean;old_oid:string;new_oid:string;message:string};
 configuration:{common_sha256:string|null;worktree_sha256:string|null};target_ref_unchanged:true;
};
export type GitCheckoutReviewWitness={metadata_publication?:GitCheckoutMetadataPublication;log_after?:GitCheckoutLogAfter;log_metadata?:GitCheckoutLogMetadata;reference_plan?:GitCheckoutReferencePlan;protocol:1;kind:'checkout_branch';project_id:string;snapshot_id:string;repository_sha256:string;head:GitHead;object_format:'sha1'|'sha256';target:GitBranchInventory['branches'][number]&{checkout_oid:string};preview:GitCheckoutPreview;execution_authorized:false};
export type GitCheckoutReviewIntent={intent_id:string;project_id:string;action:'checkout-branch';snapshot_id:string;target_ref:string;witness:GitCheckoutReviewWitness;review_sha256:string;version:number;state:'prepared'|'cancelled';created_at:string;updated_at:string;execution_authorized:false};
export type GitDiff = {project_id:string;snapshot_id:string;path:string;stage:'working'|'staged';kind:'text'|'binary';patch:string;read_only:true;execution_authorized:false};
export type CreateProject = { title: string };
export type UpdateProject = { expected_version: number; title: string };

export type ConversationMode='chat'|'work';
export type Conversation = { mode?:ConversationMode;conversation_id: string; title: string; workspace_id: string; model: ModelSelection; created_at: string; updated_at: string; version: number; project_id: string; pinned: boolean; pinned_at: string | null; archived: boolean; archived_at: string | null };

export type CreateConversation = { mode?:ConversationMode;title?: string; workspace_id: string; model: ModelSelection; project_id?: string };

export type UpdateConversation = { mode?:ConversationMode;expected_version: number; title?: string; model?: ModelSelection; project_id?: string; pinned?: boolean; archived?: boolean };

export type ConversationPage = { items: Array<Conversation>; next_cursor?: string };

export type Run = { run_id: string; conversation_id: string; input_message_id: string | null; goal_control_id?:string; status: "queued" | "starting" | "partial" | "running" | "waiting_user" | "waiting_approval" | "cancelling" | "succeeded" | "failed" | "cancelled" | "interrupted"; version: number; created_at: string; updated_at: string; continuation_of?: string; checkpoint_id?: string; error_code?: string };

export type RuntimePreparationPhase = { phase: string; duration_ms: number; outcome: "succeeded" | "failed" | "cancelled"; offset_ms: number | null };
export type RuntimeUsage = Partial<Record<"input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens" | "total_tokens" | "reasoning_tokens", string>>;
export type RuntimeAttemptDiagnostics = { attempt_id: string; state: string; provider: string | null; model: string | null; retry_index: number | null; ttft_ms: number | null; generation_ms: number | null; usage: RuntimeUsage | null; usage_status: "available" | "partial" | "not_metered" | "unknown"; cost: { nano_usd: string; basis: "configured_rates" } | null; unknown: boolean; unknown_reason: string | null; manual_intervention_required: boolean; missing: Array<string> };
export type RecordedRuntimeReadiness = {collected_at:string;stale:boolean;execution_authorized:false;readiness:{schema_version:1;execution_ready:boolean;components:Array<{component:"db"|"schema"|"host"|"native"|"consumer"|"policy"|"storage"|"driver";status:"ready"|"disabled"|"unknown"|"failed";required:boolean;observed_at?:string;reason:string|null}>;errors:string[]}};
export type RunRuntimeDiagnostics = { schema_version: 1; run_id: string; status: string; queue_ms: number | null; runtime_readiness?: RecordedRuntimeReadiness | null; preparation: { phases: Array<RuntimePreparationPhase>; total_ms: number | null; outcome: string | null }; attempts: Array<RuntimeAttemptDiagnostics>; retry_count: number; manual_intervention_required: boolean; partial: boolean; missing: Array<string> };

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

export type Activity_search = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "search"; detail: { result_artifacts?: ActivityResultArtifact[]; tool_name?: string; action?: string; urls?: string[]; url?: string; queries?: Array<string>; query_count?: number; provider?: string; source_ids: Array<string> } };

export type Activity_browse = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "partial" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "browse"; detail: { result_artifacts?: ActivityResultArtifact[]; tool_name?: string; action?: string; urls?: string[]; operation: "open" | "fetch" | "click" | "type" | "scroll" | "capture" | "navigate" | "interact" | "execute" | "web_operation"; url?: string; source_ids: Array<string>; screenshot_artifact_id?: string; operation_kind?: "read_page" | "browse" | "execute" | "unknown"; request_id?: string; generation?: number; operation_id?: string; operation_status?: string; revision?: number; event_cursor?: number; accepted_count?: number; counts?: Record<string, number>; requested_action_types?: Array<"click" | "expand" | "next_page" | "scroll" | "wait" | "fill">; browse_outcome?: "success" | "pause" | "failure" | "unknown"; action_trace_count?: number; traced_action_types?: Array<"click" | "expand" | "next_page" | "scroll" | "wait" | "fill">; verification_statuses?: string[]; verified_action_types?: Array<"click" | "expand" | "next_page" | "scroll" | "wait" | "fill">; items?: Array<{ item_id: string; position: number; url?: string; status: string; attempt?: number; reason_code?: string; result_ref?: string; action_label?: string }> } };

export type Activity_file_edit = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "file_edit"; detail: { result_artifacts?: ActivityResultArtifact[]; tool_name?: string; action?: string; urls?: string[]; url?: string; artifact_id?: string; display_path: string; operation: "create" | "edit" | "delete"; change_status: "proposed" | "staging" | "applied" | "failed" | "unknown"; before_version?: number; after_version?: number; before_sha256?: string; after_sha256?: string; diff_artifact_id?: string } };

export type Activity_file_read = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "file_read"; detail: { result_artifacts?: ActivityResultArtifact[]; tool_name?: string; action?: string; urls?: string[]; url?: string; artifact_id?: string; display_path: string; version?: number } };

export type Activity_command = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "command"; detail: { result_artifacts?: ActivityResultArtifact[]; tool_name?: string; action?: string; urls?: string[]; url?: string; display_command: string; exit_code?: number; output_artifact_id?: string } };

export type Activity_subagent = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "subagent"; detail: { result_artifacts?: ActivityResultArtifact[]; tool_name?: string; action?: string; urls?: string[]; url?: string; child_run_id: string; native_request_id?: string; child_conversation_id?: string; child_session_ref?: string; role_ref?: string; reservation_id?: string; summary?: string } };
export type Activity_crawl = { activity_id: string; run_id: string; tool_call_id: string; attempt_id?: string; parent_activity_id?: string; status: "pending" | "running" | "waiting" | "succeeded" | "partial" | "failed" | "cancelled" | "unknown"; title: string; started_at: string; ended_at?: string; error_code?: string; kind: "crawl"; detail: { result_artifacts?: ActivityResultArtifact[]; tool_name?: string; action?: string; urls?: string[]; operation: "open" | "fetch" | "read" | "cancel"; batch_id: string; requested_count: number; completed_count: number; failed_count: number } };

export type Activity_compaction = { activity_id:string; run_id:string; attempt_id?:string; kind:"compaction"; status:"running"|"succeeded"|"failed"|"cancelled"|"unknown"; title:string; started_at:string; ended_at?:string; detail:{compaction_id:string;phase:"start"|"end"} };

export type Activity = (Activity_search) | (Activity_browse) | (Activity_file_edit) | (Activity_file_read) | (Activity_command) | (Activity_subagent) | (Activity_crawl) | (Activity_compaction);

export type ActivityHistoryEntry={seq:string;activity:Activity};
export type ActivityHistoryCoverage={from_seq:string;through_seq:string;event_count:string;complete:boolean};
export type ActivityHistoryPage={conversation_id:string;run_id?:string;as_of_seq:string;items:ActivityHistoryEntry[];coverage:ActivityHistoryCoverage;next_before_seq?:string};
export type NativeMemberExecution={root_run_id:string;child_session_ref:string;child_run_id:string;child_conversation_id:string;role_ref:string;child_status:Run['status'];child_version:number;child_as_of_seq:string;execution_authorized:false};
export type NativeMemberExecutionPage={root_run_id:string;items:NativeMemberExecution[];next_cursor?:string;execution_authorized:false};

export type Question = { question_id: string; prompt: string; description?: string; options: Array<{ option_id: string; label: string; description?: string }>; multiple: boolean; allow_custom: boolean };

export type QuestionAnswer = { question_id: string; selected_option_ids: Array<string>; custom_text?: string };

export type QuestionInteraction = { interaction_id: string; run_id: string; tool_call_id: string; version: number; status: "pending" | "answered" | "denied" | "cancelled" | "expired"; created_at: string; expires_at: string; kind: "question"; purpose?: "task_input" | "task_acceptance_review"; questions: Array<Question>; answers?: Array<QuestionAnswer> };

export type ApprovalInteraction = { interaction_id: string; run_id: string; tool_call_id: string; version: number; status: "pending" | "answered" | "denied" | "cancelled" | "expired"; created_at: string; expires_at: string; kind: "approval"; purpose?: "task_review" | "task_completion_review" | "task_reply_review" | "browser_action"; action_digest: string; action_summary: string; risk: "low" | "medium" | "high"; decision?: "approve" | "deny" };

export type Interaction = (QuestionInteraction) | (ApprovalInteraction);

export type QuestionResponse = { expected_version: number; answers: Array<QuestionAnswer> };

export type ApprovalDecision = { expected_version: number; action_digest: string; decision: "approve" | "deny" };

export type InteractionReceipt = { accepted: true; interaction_id: string; run_id: string; status: "answered" | "denied"; version: number };

export type ArtifactBackupStatus = "pending" | "retry" | "verified" | "failed";

export type Artifact = { artifact_id: string; conversation_id: string; run_id?: string; file_name: string; relative_path?: string; media_type: string; size_bytes: number; sha256: string; version: number; status: "quarantined" | "ready" | "rejected" | "deleted"; created_at: string; preview_kind: "text" | "image" | "unsupported"; origin: "upload" | "generated" | "edited"; local_state?: "present" | "deleted" | "restoring"; backup_status?: ArtifactBackupStatus; remote_path?: string; restorable?: boolean };

export type RunArtifact = { run_id: string; conversation_id: string; artifact_id: string; version: number; file_name: string; media_type: string; size_bytes: number; sha256: string; status: string; local_state?: "present" | "deleted" | "restoring"; backup_status?: ArtifactBackupStatus; created_at: string; download_url: string };

export type RunArtifactPage = { items: Array<RunArtifact> };

export type ArtifactBackup = { artifact_id: string; backup_status: ArtifactBackupStatus; local_state: "present" | "deleted" | "restoring"; remote_path?: string; remote_size?: number; verified_at?: string; restorable: boolean; version?: number; restore_protocol?: 2; last_error?: string };

export type ArtifactRestoreReceipt = { accepted: true; artifact_id: string; status: "ready" | "restoring"; version?: number; restore_protocol?: 2 };

export type ArtifactVersionPage = { artifact_id: string; conversation_id: string; current_version: number; items: Artifact[]; next_before_version?: number };

export type ArtifactRestoreRequest = { expected_version?: number };

export type UploadInit = { file_name: string; media_type: string; size_bytes: number; sha256: string };

export type UploadBatchFile = { client_file_id: string; file_name: string; relative_path: string; media_type: string; size_bytes: number; sha256: string };

export type UploadBatchInit = { files: UploadBatchFile[] };

export type UploadBatchReceipt = { batch_id: string; expires_at: string; files: Array<{ client_file_id: string; upload_id: string; max_bytes: number }> };

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
export type AgentEvent = ({schema_version:"1.0";event_id:string;conversation_id:string;run_id:string;seq:string;at:string;type:"runtime.readiness"|"runtime.preparation_timing";payload:Record<string,unknown>}) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "run.state"; payload: Run }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string | null; seq: string; at: string; type: "message.created"; payload: Message }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "assistant.delta"; payload: AssistantDelta }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "assistant.settled"; payload: AssistantSettled }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "activity.upsert"; payload: Activity }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "source.upsert"; payload: Source }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "interaction.requested"; payload: Interaction }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "interaction.resolved"; payload: Interaction }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "artifact.upsert"; payload: Artifact }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "run.artifact"; payload: RunArtifact }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "usage.updated"; payload: Usage }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: "run.error"; payload: RunError }) | ({ schema_version: "1.0"; event_id: string; conversation_id: string; run_id: string; seq: string; at: string; type: ProjectionEventType; payload: ProjectionPayload });

export type StreamReset = { reason: "cursor_expired" | "schema_changed" | "authorization_changed"; snapshot_required: true };

export type StreamCursor = { attempt_id: string; block_id: string; next_delta_index: number };

export type CrawlBatchSummary = { batch_id: string; run_id: string; status: string; requested_count: number; completed_count: number; failed_count: number; cancel_requested: boolean; last_event_seq: number; generation: number; created_at: string; updated_at: string };
export type Snapshot = { conversation: Conversation; as_of_seq: string; messages: Array<Message>; runs: Array<Run>; activities: Array<Activity>; sources: Array<Source>; interactions: Array<Interaction>; artifacts: Array<Artifact>; crawl_batches?: Array<CrawlBatchSummary>; stream_cursors: Array<StreamCursor>; history_complete: boolean; next_history_cursor?: string };

export type MessagePage = { items: Array<Message>; next_cursor?: string };

export type InteractionPage = { items: Array<Interaction> };

/** Workbench and persistent task DTOs mirror registered owner-scoped routes. */
export type BrowserActionReadinessItem = { protocol: 1; run_id: string; workspace_id: string; status: "ready" | "unknown" | "failed"; required: true; observed_at: string; reason?: string; execution_authorized: false };
export type WorkbenchCollaborationMode = ({ id: "single"; enabled: true }) | ({ id: "independent_team"; enabled: true }) | ({ id: "subagents"; enabled: false; reason: "HOST_ADAPTER_NOT_READY" }) | ({ id: "team"; enabled: false; reason: "DSH_EXPERIMENTAL_TEAM_NOT_READY" }) | ({ id: "handoff"; enabled: false; reason: "HOST_ADAPTER_NOT_READY" });
export type WorkbenchCapabilities = {
  plugin_profiles?: boolean;
  host_settings_read?: boolean;
  host_settings_write?: boolean;
  host_settings_write_namespace?: string;
  enabled: boolean; agent_roles: boolean; independent_teams: boolean; agent_messages: boolean; shared_workspace: boolean; workspace_file_history?: boolean; workspace_file_range?: boolean; memory_scopes: Array<"project" | "private">; collaboration_modes: Array<WorkbenchCollaborationMode>; task_triggers: Array<"once" | "interval" | "page_change" | "daily" | "weekly" | "cron" | "delay" | "conversation_message" | "conversation_result">; task_schedule_limits?: WorkbenchTaskScheduleLimits; notification_channels: Array<"in_app">; allowed_tools: Array<"universe_capabilities" | "universe_search" | "browser_action">; execution_ready: boolean; browser_action_readiness?: BrowserActionReadinessItem[]; memory_lifecycle?: boolean; memory_import?: boolean; memory_restore?: boolean; memory_consolidation?: boolean; memory_retrieval_traces?: boolean; memory_capture?: boolean; memory_retrieval?: "local_keyword"; task_readiness?:boolean;task_prd?:boolean; task_unlimited_runs?: boolean; task_run_limit_protocol?: 1; model_budget?: boolean; task_model_budget_limits?: ModelBudgetLimits; task_reply_policy?: boolean; task_reply_execution?: false; task_create_delivery?: boolean; task_notifications?: boolean; channel_bindings?: boolean; email_bindings?: boolean; wecom_bindings?: boolean; matrix_bindings?: boolean; webpush_bindings?: boolean; sms_bindings?: boolean;task_notification_events?:TaskNotificationEventKind[]; mcp_servers?: boolean; host_readiness?:boolean; host_readiness_namespaces?:string[] };
export type AgentRole = { agent_id: string; name: string; instructions: string; workspace_id: string; project_id: string; conversation_id: string; status: "active" | "disabled" | "deleting" | "deleted"; version: number; capability_epoch: number; allowed_tools: Array<"universe_capabilities" | "universe_search" | "browser_action">; created_at: string; updated_at: string };
export type AgentRolePage = { items: Array<AgentRole> };
export type CreateAgentRole = { name: string; instructions?: string; workspace_id?: string; project_id?: string; allowed_tools?: Array<"universe_capabilities" | "universe_search" | "browser_action"> };
export type UpdateAgentRole = { name?: string; instructions?: string; workspace_id?: string; project_id?: string; allowed_tools?: Array<"universe_capabilities" | "universe_search" | "browser_action">; expected_version: number; status?: "active" | "disabled" };
export type AgentDeletionPreview = { agent_id: string; version: number; active_runs: Array<{ run_id: string; status: "queued" | "starting" | "running" | "waiting_user" | "waiting_approval" | "cancelling" }>; persistent_tasks: Array<{ task_id: string; status: "active" | "paused" | "budget_exhausted" }>; private_memory_count: number; pending_message_count: number };
export type AgentDeletionReceipt = { agent_id: string; status: "deleting" | "deleted" };
export type ExpectedVersion = { expected_version: number };

export type McpConnectionConfig =
  | { server_name: string; transport: 'stdio'; command: string; args?: string[]; cwd?: string; env_refs?: Record<string, string>; url?: never; header_refs?: never }
  | { server_name: string; transport: 'streamable-http'; url: string; header_refs?: Record<string, string>; command?: never; args?: never; cwd?: never; env_refs?: never };
export type McpTool = { tool_id: string; public_name: string; raw_name: string; description: string; source: 'mcp_server'; source_untrusted: true; input_schema: Record<string, unknown>; approved: boolean };
export type McpConnection = {
  connection_id: string; server_name: string; transport: 'stdio' | 'streamable-http'; version: number; enabled: boolean;
  state: 'configured' | 'disconnected' | 'connecting' | 'reloading' | 'ready' | 'error' | 'removing' | 'removed';
  active_generation: number; pending_generation: number | null; credentials_configured: boolean; last_error_code: string | null; tools: McpTool[];
};
export type McpConnectionPage = { items: McpConnection[] };
export type McpUnknownOperation = {operation_id:string;state:'unknown';updated_at:string};
export type McpUnknownOperationPage = {items:McpUnknownOperation[]};
export type McpConfigStage = { expected_version: number; config: McpConnectionConfig };
export type McpEnabledUpdate = { expected_version: number; enabled: boolean };
export type McpToolGrant = { expected_version: number; tool_ids: string[] };
export type McpExpectedVersion = { expected_version: number };
export type SendAgentRoleMessage = { text: string; client_message_id: string };
export type IndependentTeam = { team_id: string; name: string; workspace_id: string; project_id: string; status: "active" | "deleted"; version: number; created_at: string; updated_at: string; member_ids: Array<string> };
export type IndependentTeamPage = { items: Array<IndependentTeam> };
export type CreateIndependentTeam = { name: string; workspace_id?: string; project_id?: string; member_ids?: Array<string> };
export type UpdateIndependentTeam = { name?: string; member_ids?: Array<string>; expected_version: number };
export type IndependentTeamDeletion = { team_id: string; status: "deleted" };
export type WorkbenchWorkspace = { workspace_id: string; agents: Array<AgentRole>; teams: Array<IndependentTeam> };
export type AgentMailboxMessage = { message_id: string; workspace_id: string; project_id: string; sender_agent_id: string; recipient_agent_id: string; thread_id: string; root_causation_id: string; reply_to: string | null; text: string; initiator: "user" | "agent"; status: "pending" | "processing" | "completed" | "failed" | "outcome_unknown" | "recipient_deleted" | "sender_deleted" | "budget_exhausted" | "delivered" | "task_revoked"; auto_reply: boolean; run_id: string | null; created_at: string; updated_at: string };
export type AgentMailboxMessagePage = { items: Array<AgentMailboxMessage> };
export type CreateChannelBinding = {channel:'wecom'|'matrix'|'mattermost'|'sms'};
export type RevokeChannelBinding = {expected_version:number};
export type RevokePushSubscription = {expected_version:number;local_endpoint?:string};
export type ChannelBinding = {channel_binding_id:string;channel:'wecom'|'matrix'|'mattermost'|'email'|'webpush'|'sms';status:'pending'|'verified'|'revoked'|'expired';version:number;created_at:string;verified_at:string|null;revoked_at:string|null;expires_at?:string};
export type PushSubscriptionRevocation = {binding:ChannelBinding;local_subscription_matches:boolean};
export type ChannelBindingPage = {items:ChannelBinding[]};
export type PushVapidPublicKey = {public_key:string;generation:string};
export type CreatePushSubscription = {endpoint:string;keys:{p256dh:string;auth:string}};
export type ChannelBindingChallenge = {channel_binding_id:string;channel:'wecom'|'matrix'|'mattermost'|'sms';status:'pending';version:number;expires_at:string;requires_new_code:boolean;code?:string};
export type NotificationDeliveryPolicy = {min_interval_seconds:number;max_per_24_hours:number;quiet_hours:null|{start:string;end:string;timezone:string}};
export type TaskNotificationEventKind = 'changed'|'completed'|'failed'|'needs_confirmation';
export type TaskNotificationSettings = {task_id:string;version:number;channel_binding_ids:string[];artifact_delivery_binding_ids:string[];events:TaskNotificationEventKind[];delivery_policy:NotificationDeliveryPolicy};
export type UpdateTaskNotifications = {expected_version:number;channel_binding_ids:string[];artifact_delivery_binding_ids?:string[];delivery_policy?:NotificationDeliveryPolicy;events?:TaskNotificationEventKind[]};
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
export type WorkbenchFileVersion = { workspace_id: string; project_id: string; path: string; version: number; sha256: string; size: number; created_at: string };
export type WorkbenchFileVersionPage = { workspace_id: string; project_id: string; path: string; items: Array<WorkbenchFileVersion>; next_before_version: number|null };
export type WorkbenchFileRange = { workspace_id: string; project_id: string; path: string; version: number; sha256: string; size: number; offset_bytes: number; returned_bytes: number; eof: boolean; content: string };
export type WriteWorkbenchFile = { project_id: string; path: string; content: string; expected_version: number };
export type WorkbenchFileLifecycleReference = Record<string,string|number|null>;
export type WorkbenchFileLifecycleSource = {path:string;version:number;sha256:string;size:number;updated_at:string};
export type WorkbenchFileLifecyclePreview =
 | {action:"rename";source:WorkbenchFileLifecycleSource;source_refs:Array<WorkbenchFileLifecycleReference>;target:{path:string;version:number};target_refs:Array<WorkbenchFileLifecycleReference>;preview_sha256:string}
 | {action:"delete";source:WorkbenchFileLifecycleSource;source_refs:Array<WorkbenchFileLifecycleReference>;preview_sha256:string};
export type WorkbenchFileLifecycleReceipt =
 | {protocol:1;action:"rename";command_key:string;project_id:string;workspace_id:string;source:WorkbenchFileLifecycleSource;source_refs:Array<WorkbenchFileLifecycleReference>;target:{path:string;version:number;sha256:string;size:number};target_refs:Array<WorkbenchFileLifecycleReference>;preview_sha256:string;applied_at:string}
 | {protocol:1;action:"delete";command_key:string;project_id:string;workspace_id:string;source:WorkbenchFileLifecycleSource;source_refs:Array<WorkbenchFileLifecycleReference>;preview_sha256:string;applied_at:string};
export type WorkbenchFileLifecycleStatus = {state:"not_applied"}|{state:"applied";receipt:WorkbenchFileLifecycleReceipt};
export type WorkbenchFileLifecycleHistoryPage = {items:Array<WorkbenchFileLifecycleReceipt>;next_cursor:string|null};
export type WorkbenchFileLifecycleHistoryQuery = {project_id:string;limit?:number;cursor?:string};
export type PreviewWorkbenchFileRename = {project_id:string;path:string;target_path:string;expected_version:number};
export type PreviewWorkbenchFileDelete = {project_id:string;path:string;expected_version:number};
export type ApplyWorkbenchFileRename = PreviewWorkbenchFileRename&{preview_sha256:string};
export type ApplyWorkbenchFileDelete = PreviewWorkbenchFileDelete&{preview_sha256:string};
export type PersistentTaskMisfirePolicy = "coalesce" | "skip" | "catch_up";
export type PersistentTaskTrigger = ({ kind: "once"; run_at?: string }) | ({ kind: "interval"; interval_seconds?: number }) | ({ kind: "page_change"; interval_seconds?: number; url: string }) | ({ kind: "daily"; time: string; timezone: string; missed_triggers?: PersistentTaskMisfirePolicy }) | ({ kind: "weekly"; time: string; timezone: string; weekdays: Array<number>; missed_triggers?: PersistentTaskMisfirePolicy }) | ({ kind: "cron"; expression: string; timezone: string; missed_triggers?: PersistentTaskMisfirePolicy }) | ({ kind: "delay"; delay_seconds: number }) | ({ kind: "conversation_message" | "conversation_result"; conversation_id: string });
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
export type WorkbenchTaskScheduleLimits = { default_interval_seconds: 300; min_interval_seconds: 60; max_interval_seconds: 31536000; dst_gap: "next_valid_time"; dst_fold: "first_only"; missed_triggers: "coalesce"; misfire_policies: PersistentTaskMisfirePolicy[] };
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
export type TaskModelBudgetAttemptUsage = { status: 'settled' | 'unknown' | 'unavailable' | 'not_metered'; input_tokens: string | null; output_tokens: string | null; cache_read_tokens: string | null; cache_write_tokens: string | null; reasoning_tokens: string | null; total_tokens: string | null };
export type TaskModelBudgetAttempt = { attempt_ref: string; purpose: 'compaction' | 'session-title' | 'emotion' | 'web-decision' | 'reply-verification' | 'memory-extraction' | 'memory-reasoning' | null; state: 'reserved' | 'in_flight' | 'unknown' | 'settled' | 'released'; created_at: string; updated_at: string; reserved: { tokens: string; nano_usd: string; model_calls: '1' }; settled: { tokens: string | null; nano_usd: string | null; model_calls: '1' | null }; cost_basis: 'configured_rates'; usage: TaskModelBudgetAttemptUsage };
export type TaskModelBudgetAttemptsView = { configured: true; task_id: string; items: Array<TaskModelBudgetAttempt>; next_cursor: string | null; truncated: boolean; cost_basis: 'configured_rates'; currency: 'USD' };
export type TaskModelBudgetAttemptsUnavailable = { configured: false; task_id: string; reason: 'BUDGET_POLICY_NOT_CONFIGURED'; items: Array<TaskModelBudgetAttempt>; next_cursor: null };
export type TaskModelBudgetAttempts = TaskModelBudgetAttemptsView | TaskModelBudgetAttemptsUnavailable;
export type UpdateTaskModelBudget = { expected_version: number; limits: ModelBudgetLimits };
export type TaskSubtaskQuery = { occurrence_id?: string };

export type FileOperationRequest = { conversation_id: string; operation: "document.inspect" | "document.read" | "writer.replace_text" | "writer.set_table_cell" | "calc.set_cells" | "calc.recalculate" | "pdf.reorder_pages" | "pdf.rotate_pages"; base_version: number; base_sha256: string; target?: Record<string, unknown>; expected?: Record<string, unknown>; change?: Record<string, unknown>; save_as?: { format: "docx" | "xlsx" | "xls" | "pdf"; new_version: true } };

export type FileJob = { job_id: string; artifact_ref: string; operation: string; status: "queued" | "running" | "completed" | "failed"; base_version: number; output_version: number | null; result: Record<string, unknown> | null; error_code: string | null; created_at: string; updated_at: string };

export type WorkbenchFileReadQuery = { project_id: string; path: string; version?: number };

export type WorkspaceCheckpointManifestEntry = {path:string;kind:'file';sha256:string;bytes:number;executable:boolean}|{path:string;kind:'directory'}|{path:string;kind:'absent'};
export type WorkspaceCheckpointManifest = {protocol:2;provider:'snapshot-copy';paths:string[];entries:WorkspaceCheckpointManifestEntry[]};
export type WorkspaceCheckpointReceipt = {protocol:1;checkpoint_id:string;project_id:string;workspace_id:string;source_revision:number;snapshot_id:string;manifest_sha256:string;created_at:string;status:'ready';execution_authorized:false;restore_authorized:false};
export type WorkspaceCheckpoint = {checkpoint_id:string;project_id:string;workspace_id:string;source_revision:number;paths:string[];manifest:WorkspaceCheckpointManifest;manifest_sha256:string;receipt:WorkspaceCheckpointReceipt;state:'ready'|'pruned';created_at:string;execution_authorized:false;restore_authorized:false};
export type WorkspaceCheckpointPage = {items:WorkspaceCheckpoint[];next_before_checkpoint_id:string|null;execution_authorized:false;restore_authorized:false};
export type CreateWorkspaceCheckpoint = {project_id:string;paths:string[]};
export type WorkspaceCheckpointPathState = {path:string;kind:'file';version:number;sha256:string;size:number;executable:false}|{path:string;kind:'absent'};
export type CreateWorkspaceCheckpointRestoreReview = {project_id:string;path:string};
export type WorkspaceCheckpointRestoreReview = {review_id:string;checkpoint_id:string;project_id:string;workspace_id:string;path:string;expected_revision:number;before:WorkspaceCheckpointPathState;target:WorkspaceCheckpointPathState;review_sha256:string;created_at:string;execution_authorized:false;restore_authorized:false};
export type RestoreWorkspaceCheckpoint = {project_id:string;path:string;review_id:string;review_sha256:string};
export type WorkspaceCheckpointRestoreReceipt = {protocol:1;operation_id:string;checkpoint_id:string;path:string;outcome:'applied'|'not_applied';target_state_sha256:string;result_version:number|null;source_revision:number;execution_authorized:false;restore_authorized:false};
export type WorkspaceCheckpointRestoreUnresolved = {operation_id:string;checkpoint_id:string;path:string;state:'unresolved';execution_authorized:false;restore_authorized:false};
export type WorkspaceCheckpointRestoreStatus = WorkspaceCheckpointRestoreReceipt|WorkspaceCheckpointRestoreUnresolved;
export type ReconcileWorkspaceCheckpointRestore = {project_id:string};


export type CreateTaskDelegation = { occurrence_id: string; subtask_id: string; expected_subtask_version: number; recipient_agent_id: string; client_message_id: string };
export type TaskDelegationReceipt = { delegation_id: string; message_id: string; occurrence_id: string; subtask_id: string; subtask_version: number; recipient_agent_id: string };

export type SaveTaskCollaboration = {expected_version:number;enabled:false} | {expected_version:number;enabled:true;team_id:string;member_ids:string[];max_delegations:number;max_active:1|2};
export type TaskCollaboration = {version:number;enabled:boolean;team_id:string|null;member_ids:string[];max_delegations:number;max_active:number};

export type CreateEmailBinding = {address:string};
export type ConfirmEmailBinding = {code:string};
export type EmailBindingChallenge = {channel_binding_id:string;channel:'email';status:'pending'|'consumed'|'verified'|'replaced';delivery_status:'sending'|'accepted'|'outcome_unknown';expires_at:string};
export type EmailBindingVerified = {channel_binding_id:string;channel:'email';status:'verified';version:number};

export type CreateTaskNotificationSettings = {channel_binding_ids:string[];artifact_delivery_binding_ids?:string[];delivery_policy?:NotificationDeliveryPolicy;events?:TaskNotificationEventKind[]};

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

export type MemoryContextDelivery = {status:'delivered_to_session';source_retrieval_id:string;context_hash:string};
export type MemoryRetrievalSummary = {retrieval_id:string;workspace_id:string;agent_id:string;project_id:string;run_id:string;source_run_id:string|null;kind:'context_snapshot'|'continuation_snapshot'|'tool_query';query:string;method:'scope_order'|'keyword'|'adapter'|'reasoning_provider'|'inherited';fallback_reason:'adapter_failed'|'invalid_adapter_result'|'reasoning_provider_failed'|'invalid_reasoning_provider_result'|null;candidate_count:number;candidate_pool_truncated?:boolean;context_chars:number|null;excluded:{query_miss:number;result_limit:number;context_limit:number;duplicate:number;context_budget:number;provider_unselected?:number;selected_source_stale?:number};result_count:number;created_at:string;context_delivery?:MemoryContextDelivery};
export type MemoryRetrievalReference = {scope:'project'|'private';memory_id:string;version:number;rank:number;reason:'scope_order'|'keyword_match'|'adapter_rank'|'adapter_tail'|'reasoning_provider'|'inherited';keyword_score:number|null;matched_terms:string[];content_chars:number;truncated:boolean;provenance_truncated:boolean;available:boolean;content_preview?:string;provenance?:WorkbenchMemoryProvenance[]};
export type MemoryRetrieval = MemoryRetrievalSummary&{references:MemoryRetrievalReference[]};
export type MemoryRetrievalPage = {items:MemoryRetrievalSummary[];next_before_id:string|null};

export type MemoryCapturePolicy ={agent_id:string;mode:'off'|'suggest';include_assistant:boolean;include_automation:boolean;version:number;current:boolean;updated_at:string|null};
export type MemoryDreamPolicy ={owner_id:string;workspace_id:string;project_id:string;agent_id:string;enabled:boolean;interval_seconds:number;next_due_at:string|null;policy_version:number;epoch:number;updated_at:string};
export type MemoryCaptureSummary ={processing?:{status:string;reason_code:string|null}|null;capture_id:string;agent_id:string;workspace_id:string;project_id:string;source_run_id:string;source_conversation_id:string;run_kind:'chat'|'task'|'native_team'|'internal_mailbox';policy_version:number;policy_current:boolean;status:'watching'|'ready'|'proposed'|'applied'|'rejected'|'no_notes'|'no_source'|'source_failed'|'stale';version:number;source_count:number;notes_count:number;created_at:string;updated_at:string};
export type MemoryCaptureSource ={source_id:string;message_id:string;block_id:string;block_index:number;role:'user'|'assistant';origin:'human'|'agent'|'automation';content_sha256:string;truncated:boolean;available:boolean;text?:string};
export type MemoryCapture =MemoryCaptureSummary&{info:{captured_chars:number;truncated_blocks:number;omitted_blocks:number;excluded_blocks:number;source_status:string|null}|null;sources:MemoryCaptureSource[];proposal:{summary:string;notes:{content:string;source_ids:string[]}[]}|null;proposal_unavailable:boolean;results:{memory_id:string;version:number;reused:boolean}[]|null};
export type MemoryCapturePage ={items:MemoryCaptureSummary[];next_before_id:string|null};
export type MemoryCaptureRecovery = {capture_binding?:{capture_id:string;agent_id:string;workspace_id:string;project_id:string;version:number;policy_version:number;epoch:number};capture_status:MemoryCaptureSummary['status'];processor_run_status:'queued'|'starting'|'running'|'waiting_user'|'waiting_approval'|'succeeded'|'partial'|'failed'|'interrupted'|'cancelled'|'cancelling'|'not_started'|'unavailable'|'unknown';proposal_available:boolean;usage_state:'no_attempt'|'settled'|'released'|'held_unknown'|'held_in_flight'|'held_mixed'|'unresolved'|'unavailable';recovery_state:'committed_proposal_settled'|'usage_settled_without_proposal'|'no_notes_settled'|'closed_capture_usage_settled'|'unresolved_usage_held'|'source_or_policy_stale'|'budget_bound_exceeded'|'no_recovery_needed';reconciliation_evidence:{attempt_id:string;evidence_ref:string;policy_version:number;epoch:number}[]};
export type MemoryCaptureReconcileInput = {expected_capture_version:number;expected_policy_version:number;expected_epoch:number;attempt_id:string;evidence_ref:string};
export type MemoryCaptureReconciliation = {state:'committed_proposal_settled'|'usage_settled_without_proposal'|'no_notes_settled'|'closed_capture_usage_settled'|'budget_bound_exceeded'|'usage_reconciled_held';run_id:string;reconciled_attempt_id:string;evidence_sha256:string};

export type UpdateMemoryCapturePolicy = {expected_version:number;mode:"off"|"suggest";include_assistant?:boolean;include_automation?:boolean};
export type UpdateMemoryDreamPolicy = {expected_version:number;enabled?:boolean;interval_seconds?:number};
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
export type CreateDiscoveryWorkCycle = {report_sha256:string;plan_ids:string[];expected_policy_version:number;expected_role_version:number;expected_role_epoch:number};
export type DiscoveryWorkCyclePlan = {plan_id:string;sha256:string;paths:string[]};
export type DiscoveryWorkCycle = {cycle_id:string;version:number;state:'open'|'closed';admission_id:string;occurrence_id:string;task_id:string;root_run_id:string;report_sha256:string;policy_version:number;role_version:number;role_epoch:number;plans:DiscoveryWorkCyclePlan[];created_at:string;closed_at:string|null;execution_authorized:false};

export type ProjectDiscoveryTaskTrigger = {kind:"project_discovery";policy_id:string};

export type TaskPrdSelection = {kind:"logical_file";path:string;version:number;sha256:string}|{kind:"upload";artifact_id:string;version:number;sha256:string};
export type TaskPrdSource = TaskPrdSelection & {name:string;size:number};
export type TaskPrdPreviewRequest = {research?:boolean;append?:boolean;num_tasks?:number;source:TaskPrdSelection};
export type TaskPrdBindRequest = {research?:boolean;append?:boolean;num_tasks?:number;source:TaskPrdSelection;preview_sha256:string};
export type TaskPrdReceipt = {research?:true;append?:true;append_source?:Pick<TaskPrdAppendSource,"task_count"|"sha256">;num_tasks?:number;binding_id:string;task_id:string;task_version:number;revision:number;source:TaskPrdSource;content_sha256:string;objective_sha256:string;created_at:string;execution_authorized:false};
export type TaskPrdPreview = {research?:true;append?:true;append_source?:TaskPrdAppendSource;num_tasks?:number;task_id:string;task_version:number;role:{agent_id:string;version:number;capability_epoch:number};source:TaskPrdSource;content:string;objective:string;source_delivery?:"reference";source_instructions?:string;preview_sha256:string;execution_authorized:false};
export type TaskmasterMcpStatus = {connection_id:string;server_name:string;version:number;enabled:boolean;state:string;active_generation:number;pending_generation:number|null;approved_tool_count:number};
export type TaskPrdTaskmasterStatus = {registry_available:boolean;connections:TaskmasterMcpStatus[]};
export type TaskPrdSources = {task_id:string;task_version:number;readiness:{ready:boolean;reasons:string[]};sources:TaskPrdSource[];truncated:boolean;binding:TaskPrdReceipt|null;taskmaster?:TaskPrdTaskmasterStatus};

export type GitInitializationFile={identity:string;sha256:string;size:number;mode:number};
export type GitReinitializationConfiguration={protocol:1;before_sha256:string|null;filemode_false_sha256:string;filemode_true_sha256:string;worktree_sha256:string|null};
export type GitReinitializationDirectory={identity:string;mode:number;uid:string;gid:string};
export type GitReinitializationLayout={protocol:1;root:GitReinitializationDirectory;git:GitReinitializationDirectory;common:GitReinitializationDirectory;directories:Array<{path:string;before:GitReinitializationDirectory|null}>};
export type GitInitializationExisting={layout?:GitReinitializationLayout;configuration?:GitReinitializationConfiguration;source_metadata_sha256:string;git_directory_identity:string;common_directory_identity:string;dot_file:GitInitializationFile|null;head:GitHead;common_config:GitInitializationFile|null;worktree_config:GitInitializationFile|null;worktree_config_enabled:boolean};
export type GitReinitializationReviewFacts={layout_sha256?:string;configuration?:GitReinitializationConfiguration;head:GitHead;source_metadata_sha256:string;common_config_sha256:string|null;worktree_config_sha256:string|null;worktree_config_enabled:boolean};
export type GitInitializationWitness={kind:'initialize_repository';snapshot_id:string;repository_sha256:string;root_identity:string;internal_directory_identity:string|null;internal_ignore:GitInitializationFile|null;initial_branch:string;object_format:'sha1'|'sha256';ignore_after:{sha256:string;size:number;changed:boolean};execution_authorized:false}&({protocol:1}|{protocol:2;existing:GitInitializationExisting});
export type GitInitializationStatus={project_id:string;read_only:true;execution_authorized:false}&({git_present:true}|{git_present:false;snapshot_id:string;repository_sha256:string;internal_ignore:{path:'.pilotdeck/.gitignore';sha256:string|null;size:number}});
export type GitInitializationReviewPrepare={request_id:string;action:'init';snapshot_id:string;initial_branch:string;object_format:'sha1'|'sha256'};
export type GitInitializationReviewIntent={reinitialization?:GitReinitializationReviewFacts;intent_id:string;project_id:string;action:'init';snapshot_id:string;initial_branch:string;object_format:'sha1'|'sha256';internal_ignore:{path:'.pilotdeck/.gitignore';before_sha256:string|null;after_sha256:string;size:number;changed:boolean};review_sha256:string;version:number;state:'prepared'|'approved'|'cancelled';created_at:string;updated_at:string;execution_authorized:false};
export type GitBranchLogFile={sha256:string|null;size:number};
export type GitBranchLogWitness={configuration:'default'|'true'|'false'|'always';enabled:boolean;head:GitBranchLogFile;branch:GitBranchLogFile};
export type GitBranchConfigurationWitness={before_sha256:string|null;after_sha256:string|null;changed:boolean};
export type GitCreateBranchWitness={kind:'create_branch';snapshot_id:string;repository_sha256:string;source_metadata_sha256:string;index_sha256:string|null;object_format:'sha1'|'sha256';head:GitHead;branch:string;target_ref:string;target_oid:string|null;execution_authorized:false} & ({protocol:1}|{protocol:2;reflog:GitBranchLogWitness;configuration?:GitBranchConfigurationWitness});
export type GitBranchMetadata={protocol:1;committer:GitCommitMetadata['committer'];operator_policy_sha256:string;log_policy_sha256:string;logs:{head:boolean;branch:boolean};configuration_sha256?:string;configuration_changed?:boolean};
export type GitBranchReviewPrepare={request_id:string;action:'create-branch';branch:string;snapshot_id:string};
export type GitBranchReviewIntent={intent_id:string;project_id:string;action:'create-branch';branch:string;target_ref:string;target_oid:string|null;head:GitHead;branch_metadata?:GitBranchMetadata;object_format:'sha1'|'sha256';snapshot_id:string;review_sha256:string;version:number;state:'prepared'|'approved'|'cancelled';created_at:string;updated_at:string;execution_authorized:false};
export type GitReviewPrepare = {request_id:string;action:"stage"|"unstage"|"commit"|"discard"|"delete-untracked";paths:string[];snapshot_id:string;message?:string};
export type GitReviewControl = {request_id:string;expected_version:number;action:"approve"|"cancel";review_sha256:string};
export type GitReviewIntent = {intent_id:string;project_id:string;action:GitReviewPrepare["action"];paths:string[];message?:string;commit_metadata?:GitCommitMetadata;snapshot_id:string;review_sha256:string;version:number;state:"prepared"|"approved"|"cancelled";created_at:string;updated_at:string;execution_authorized:false};

export type GitIndexAcceptanceBase = {execution_id:string;project_id:string;intent_id:string;request_id:string;accepted:true;execution_authorized:false};
export type GitInitializationExecutionFacts=Pick<GitInitializationReviewIntent,'action'|'initial_branch'|'object_format'|'internal_ignore'>;
export type GitInitializationAcceptance=GitIndexAcceptanceBase & GitInitializationExecutionFacts;
export type GitInitializationPendingResult=Omit<GitIndexAcceptanceBase,'accepted'> & GitInitializationExecutionFacts & {paths:[];state:'pending'|'unknown'};
export type GitInitializationAppliedResult=Omit<GitIndexAcceptanceBase,'accepted'> & GitInitializationExecutionFacts & {paths:[];state:'applied';evidence_sha256:string};
export type GitInitializationClosedResult=Omit<GitIndexAcceptanceBase,'accepted'> & GitInitializationExecutionFacts & {paths:[];state:'not_dispatched'|'abandoned_unknown';disposition_id:string};
export type GitBranchExecutionFacts={action:'create-branch';branch:string;target_ref:string;target_oid:string|null;head:GitHead;branch_metadata?:GitBranchMetadata};
export type GitBranchAcceptance=GitIndexAcceptanceBase & GitBranchExecutionFacts;
export type GitBranchPendingResult=Omit<GitIndexAcceptanceBase,'accepted'> & GitBranchExecutionFacts & {paths:[];state:'pending'|'unknown'};
export type GitBranchAppliedResult=Omit<GitIndexAcceptanceBase,'accepted'> & GitBranchExecutionFacts & {paths:[];state:'applied';preparation_sha256:string};
export type GitBranchClosedResult=Omit<GitIndexAcceptanceBase,'accepted'> & GitBranchExecutionFacts & {paths:[];state:'not_dispatched'|'abandoned_unknown';disposition_id:string};
export type GitIndexAcceptance = GitIndexAcceptanceBase & ({action:"stage"|"unstage"}|{action:"commit";target_ref:string;expected_old_oid:string|null}|GitBranchExecutionFacts|GitInitializationExecutionFacts);
export type GitIndexExecutionResult =
 | (Omit<GitIndexAcceptanceBase,"accepted"> & {action:"stage"|"unstage";paths:string[]} & ({state:"pending"|"unknown"}|{state:"applied";before_index_sha256:string|null;index_sha256:string}|{state:"not_dispatched"|"abandoned_unknown";disposition_id:string}))
 | (Omit<GitIndexAcceptanceBase,"accepted"> & {action:"commit";paths:string[];target_ref:string;expected_old_oid:string|null} & ({state:"pending"|"unknown"}|{state:"applied";commit_oid:string;tree_oid:string}|{state:"not_dispatched"|"abandoned_unknown";disposition_id:string}))
 | GitBranchPendingResult | GitBranchClosedResult | GitBranchAppliedResult | GitInitializationPendingResult | GitInitializationClosedResult | GitInitializationAppliedResult;

export type WorkPublicationPrepare = {request_id:string;source_run_id:string;source_sha256:string;paths:string[]};
export type WorkPublicationControl = GitReviewControl;
export type WorkPublicationSource = {source:'isolated';workspace_id:string;project_id:string;agent_id:string;task_id:string;occurrence_id:string;run_id:string;
 final_message_id:string;candidate_id:string;certificate_id:string;completion_intent_id:string;snapshot_sha256:string;candidate_sha256:string;native_proof_sha256:string;source_sha256:string;files:Array<{path:string;version:number;sha256:string;size_bytes:number;receipt_id:string;producing_run_id:string}>;
 deletions?:Array<{path:string;version:number;previous_sha256:string;previous_size:number;receipt_id:string;producing_run_id:string}>;work_review:TaskWorkReview};
export type WorkPublicationTarget = {snapshot_id:string;repository_sha256:string;head:GitSnapshot['head'];index_sha256:string|null;target_sha256:string};
export type WorkPublicationChange = {path:string;kind:'add'|'modify';before:WorkReviewEntry|null;after:WorkReviewEntry;before_text:string|null;after_text:string}
 | {path:string;kind:'delete';before:Extract<WorkReviewEntry,{kind:'file'}>;after:null;before_text:string;after_text:null};
export type WorkPublicationReview = {intent_id:string;project_id:string;source:WorkPublicationSource;target:WorkPublicationTarget;changes:WorkPublicationChange[];paths:string[];
 review_sha256:string;version:number;state:'prepared'|'approved'|'cancelled';created_at:string;updated_at:string;execution_authorized:false};

export type WorkPublicationAdmission = {request_id:string;expected_version:number;review_sha256:string};
export type WorkPublicationAcceptance = {protocol:1;execution_id:string;operation_kind:'work_publication';project_id:string;intent_id:string;request_id:string;
 review_version:number;review_sha256:string;source_sha256:string;target_sha256:string;state:'accepted';accepted_at:string;execution_authorized:false};
export type WorkPublicationStatus = {execution_id:string;project_id:string;intent_id:string;request_id:string;state:'not_started'|'running'|'interrupted'|'unknown'|'prepared'|'cancelled_before_preparation'|'failed_before_preparation'|'applied'|'abandoned_unknown'|'applied_pending_settlement'|'abandon_pending_settlement';
 files:Array<{path:string;sha256:string;size:number}|{path:string;kind:'absent'}>;pending_path:string|null;journal_sha256:string|null;execution_authorized:false};

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

export type ChannelId = 'api-server'|'bluebubbles'|'cli'|'dingtalk'|'discord'|'email'|'feishu'|'homeassistant'|'matrix'|'mattermost'|'qq'|'signal'|'slack'|'sms'|'telegram'|'tui'|'webhook'|'wecom'|'wecom-callback'|'weixin'|'whatsapp';

export type WorkspaceCheckpointRestoreRequestStatus = {command_key:string;request_sha256:string;command_sha256:string;execution_authorized:false;restore_authorized:false}&({state:'unobserved'}|{state:'recorded_pending';operation_id:string}|{state:'settled';operation_id:string;receipt:WorkspaceCheckpointRestoreReceipt}|{state:'terminal_rejected';no_effect:true;reason:'workspace_checkpoint_review_changed'});
export type ForkConversationInput = { expected_version: number; through_message_id: string };
export type ConversationForkReceipt = { conversation_id: string; fork_id: string; source: { conversation_id: string; through_message_id: string; head_sha256: string }; state: "ready" };

export type PluginProfileBundle = {name:string; installed?:boolean; enabled?:boolean; version?:string};
export type PluginProfileBundlePage = {bundles:PluginProfileBundle[]};
export type PluginProfileInstall = {spec:string; enabled:boolean};
export type PluginProfileEnable = {enabled:boolean};
export type PluginProfileEvidence = {
  protocol:1; snapshot_id:string; consistency:'sampled'; before:'captured'; after:'captured'|'unavailable';
  bundle:{name:string;version:string;manifest_sha256:string;license:string|null;license_file_sha256:string|null;integrity:string|null}|null;
};
export type PluginProfileResult = {
  evidence?:PluginProfileEvidence|null;
  application:'applied'|'restart-required'|'overridden'|'failed'|'cancelled'; changed:boolean;
  stage?:string; bundle?:string; version?:string; restartReason?:string; failedAt?:string;
  error?:{code:string}; packageResult?:{exitCode:number;kind?:string;timedOut?:boolean};
};
export type PluginProfileOperation = {
  route_operation:string; request_sha256:string;
  operation_id:string; operation:'plugin.bundle.install'|'plugin.bundle.enable'|'plugin.bundle.remove';
} & ({state:'settled';response:PluginProfileResult;response_status:200}
  | {state:'reserved'|'dispatched'|'unknown';response?:never;response_status?:never});

export type WorkbenchSkillCatalogScope = {conversation_id:string;workspace_id:string;project_id:string;agent_id:string;run_id:string;capability_epoch:number};
export type OrdinarySkillCatalogScope = {kind:'ordinary';conversation_id:string;workspace_id:string;project_id:string|null;run_id:string;session_ref:string;mode:'work'|'chat';run_version:number;conversation_version:number};
export type RunSkillCatalogScope = WorkbenchSkillCatalogScope | OrdinarySkillCatalogScope;
export type NativeCommandDescriptor = import('../../skills/catalog-contract.js').CommandManifest;
export type NativeCommandCatalog = import('../../skills/catalog-contract.js').SkillCommandCatalog;
export type RunSkillCatalogObservation = import('../../skills/catalog-contract.js').SkillCatalogObservation & {viewScope:RunSkillCatalogScope};
export type RunSkillResourceObservation = import('../../skills/catalog-contract.js').SkillResourceView & {viewScope:RunSkillCatalogScope};
export type RunSkillDefinitionObservation = import('../../skills/catalog-contract.js').SkillDefinitionView & {viewScope:RunSkillCatalogScope};
export type RunSkillDirectoryObservation = import('../../skills/catalog-contract.js').SkillDirectoryView & {viewScope:RunSkillCatalogScope};
export type RunSkillReadResponse = RunSkillCatalogObservation | RunSkillResourceObservation | RunSkillDefinitionObservation | RunSkillDirectoryObservation;

export type SkillSourceManifest = import('../../skills/catalog-contract.js').SkillSourceManifest;

export type NativeCommandQuery = import('../../skills/command-query.js').NativeCommandQuery;
export type NativeCommandQueryResult = import('../../skills/command-query.js').NativeCommandQueryResult;
export type NativeCommandQueryAccepted = {accepted:true;request_id:string;run_id:string};
export type NativeCommandQuerySummary = {request_id:string;run_id:string;name:'permission'|'goal';state:'prepared'|'dispatched'|'settled'|'rejected'|'unknown';updated_at:string};
export type NativeCommandQueryOperation = NativeCommandQuerySummary & {result?:NativeCommandQueryResult};
export type NativeCommandQueryPage = {items:NativeCommandQuerySummary[]};

export type NativeCommandQueryClose = {name:'permission'|'goal'};

export type NativeCommandQueryReconcile = Record<string,never>;

export type NativePlanModeRequest = import('../../skills/plan-mode-command.js').NativePlanMode;
export type NativePlanModeSummary = Omit<NativeCommandQuerySummary,'name'> & {name:'plan';enabled:boolean|null};
export type NativePlanModeOperation = NativePlanModeSummary & {result?:NativeCommandQueryResult};
export type NativePlanModePage = {items:NativePlanModeSummary[]};
export type NativePlanModeAccepted = NativeCommandQueryAccepted;
export type NativePlanModeClose = {name:'plan'};
export type NativePlanModeReconcile = Record<string,never>;

export type TaskmasterInstallation = {protocol:1;owner_id:string;profile_id:string;scope:"owner_profile"|"host_path"|"profile_and_path";status:"available"|"missing";version:string|null;license:string|null;manifest_sha256:string|null;cli_entry_sha256:string|null;reason_code:"package_not_installed"|null;observed_at:string;execution_authorized:false};
export type TaskPrdInstallation = {task_id:string;task_version:number;installation:TaskmasterInstallation};

export type TaskPrdProjectFile = {path:".taskmaster/config.json"|".taskmaster/tasks/tasks.json";state:"missing"|"too_large"|"invalid"|"ready";size:number;sha256:string|null;content:string|null;task_count:number|null;tags:string[]};
export type TaskPrdProject = {directory_state?:"missing"|"present";task_id:string;task_version:number;project_id:string;repository_sha256:string;source_sha256:string;files:TaskPrdProjectFile[];execution_authorized:false;role?:{agent_id:string;version:number;capability_epoch:number};target?:{path:".taskmaster/tasks/tasks.json";version:number;sha256:string|null;size:number};import_preview_sha256?:string};

export type TaskPrdImportSource = {
  kind:"taskmaster_project_import";relative_path:".taskmaster/tasks/tasks.json";
  task_id:string;task_version:number;preview_sha256:string;source_sha256:string;repository_sha256:string;
};
export type TaskPrdImportRequest = {preview_sha256:string};
export type TaskPrdImport = {
  task_id:string;task_version:number;preview_sha256:string;execution_authorized:false;
  file:{protocol:1;workspace_id:string;project_id:string;path:".taskmaster/tasks/tasks.json";version:number;sha256:string;size:number;source:TaskPrdImportSource;updated_at:string};
};

export type TaskPrdTemplateId = "task-request"|"web-app"|"api"|"mobile-app"|"data-analysis";
export type TaskPrdTemplate = {id:TaskPrdTemplateId;name:string;category:string;description:string;content:string;placeholders:string[]};
export type TaskPrdTemplates = {task_id:string;task_version:number;templates:TaskPrdTemplate[]};
export type TaskPrdTemplateRequest = {template_id:TaskPrdTemplateId;file_name:string;values?:Record<string,string>};
export type TaskPrdTemplatePreview = {
 task_id:string;task_version:number;role:TaskPrdPreview["role"];
 template:{id:TaskPrdTemplateId;name:string;category:string;sha256:string};
 target:{path:string;version:number;sha256:string|null;size:number};
 content:string;content_sha256:string;preview_sha256:string;execution_authorized:false;
};
export type TaskPrdTemplateApplyRequest = TaskPrdTemplateRequest&{preview_sha256:string};
export type TaskPrdTemplateSource = {
 kind:"prd_template";relative_path:string;task_id:string;task_version:number;preview_sha256:string;
 request_sha256:string;template_id:TaskPrdTemplateId;template_sha256:string;
};
export type TaskPrdTemplateApply = {
 task_id:string;task_version:number;preview_sha256:string;execution_authorized:false;
 file:{protocol:1;workspace_id:string;project_id:string;path:string;version:number;sha256:string;size:number;source:TaskPrdTemplateSource;updated_at:string};
};

export type TaskPrdProjectDocumentEntry = {name:string;path:string;size:number;state:"available"|"missing"|"too_large"};
export type TaskPrdProjectDocuments = {
 task_id:string;task_version:number;project_id:string;repository_sha256:string;source_sha256:string;
 directory_state:"missing"|"present";total:number;unsupported_count:number;files:TaskPrdProjectDocumentEntry[];next_after:string|null;execution_authorized:false;
};
export type TaskPrdProjectDocumentRequest = {file_name:string};
export type TaskPrdProjectDocumentPreview = {
 task_id:string;task_version:number;project_id:string;workspace_id:string;role:TaskPrdPreview["role"];
 repository_sha256:string;source_sha256:string;preview_sha256:string;execution_authorized:false;
 file:{path:string;state:"ready"|"missing"|"too_large"|"invalid";size:number;sha256:string|null;content:string|null};
 target:TaskPrdTemplatePreview["target"];
};
export type TaskPrdProjectDocumentImportRequest = TaskPrdProjectDocumentRequest&{preview_sha256:string};
export type TaskPrdProjectDocumentSource = {
 kind:"taskmaster_prd_import";relative_path:string;task_id:string;task_version:number;preview_sha256:string;request_sha256:string;source_sha256:string;repository_sha256:string;
};
export type TaskPrdProjectDocumentImport = Omit<TaskPrdTemplateApply,"file">&{
 file:Omit<TaskPrdTemplateApply["file"],"source">&{source:TaskPrdProjectDocumentSource};
};

export type TaskPrdWorkPlan = {
 research_evidence?:Array<{kind:"tool_receipt";reference:string;hash:string}>;
 protocol:1;plan_id:string;task_id:string;task_version:number;objective_sha256:string;
 role:TaskPrdPreview["role"]&{workspace_id:string;project_id:string};source:{binding_id:string;content_sha256:string;size:number};
 occurrence_id:string;root_run_id:string;run_id:string;call_id:string;summary:string;rationale:string;
 changes:Array<{path:string;description:string;steps:string[];verification:string[]}>;
 evidence:Array<{kind:"tool_receipt";reference:string;hash:string}>;subtasks:TaskSubtask[];ledger_sha256:string;sha256:string;
 created_at:string;accepted:false;execution_authorized:false;
};
export type TaskPrdWorkPlanSummary = Pick<TaskPrdWorkPlan,"plan_id"|"sha256"|"task_version"|"occurrence_id"|"run_id"|"summary"|"created_at"|"accepted"|"execution_authorized">&{binding_id:string;path_count:number;subtask_count:number};
export type TaskPrdWorkPlanPage = {task_id:string;items:TaskPrdWorkPlanSummary[];next_before_id:string|null;execution_authorized:false};

export type TaskPrdWorkPlanAcceptanceRequest={
 plan_id:string;preview_sha256:string;expected_task_version:number;expected_role_version:number;expected_role_epoch:number;
};
export type TaskPrdWorkPlanAcceptance={
 protocol:1;acceptance_id:string;task_id:string;plan_id:string;plan_sha256:string;request_sha256:string;sha256:string;
 task_version:number;task_generation:number;role:TaskPrdWorkPlan["role"];source:TaskPrdWorkPlan["source"];ledger_sha256:string;
 occurrence_id:string;root_run_id:string;planning_current_run_id:string;created_at:string;accepted:true;execution_authorized:false;
};
export type TaskPrdWorkPlanAcceptanceState={task_id:string;plan_id:string;acceptance:TaskPrdWorkPlanAcceptance|null;execution_authorized:false};

export type TaskPrdWorkCycle=Omit<DiscoveryWorkCycle,"admission_id"|"report_sha256"|"policy_version">&{
 admission_id:null;report_sha256:null;policy_version:null;
 origin:{kind:"task_prd";acceptance_id:string;acceptance_sha256:string;plan_id:string;plan_sha256:string};
};
export type TaskPrdWorkCycleCommand={action:"create";plan_id:string;preview_sha256:string}|{action:"close";plan_id:string;preview_sha256:string;cycle_id:string;expected_version:number};
export type TaskPrdWorkCycleState={task_id:string;plan_id:string;cycle:TaskPrdWorkCycle|null;execution_authorized:false};

export type TaskPrdWorkHandoffRequest={plan_id:string;cycle_id:string;preview_sha256:string;run_id:string;expected_run_version:number};
export type TaskPrdWorkHandoffReceipt={protocol:1;task_id:string;plan_id:string;cycle_id:string;run_id:string;command_id:string;accepted:true;execution_authorized:false};
export type TaskPrdWorkHandoffState={
 task_id:string;plan_id:string;cycle_id:string|null;available:boolean;planning:{run_id:string;status:string;version:number}|null;
 command_id:string|null;requested:boolean;settled:boolean;reasons:string[];execution_authorized:false;
};

export type TaskPrdWorkPreparationRequest={plan_id:string;cycle_id:string;preview_sha256:string;expected_cycle_version:number};
export type TaskPrdWorkGrantRequest={plan_id:string;cycle_id:string;preview_sha256:string};
export type TaskPrdWorkPreparation={
 protocol:1;task_id:string;plan_id:string;cycle_id:string;cycle_version:number;acceptance_sha256:string;snapshot_id:string;
 source_sha256:string;manifest_sha256:string;source_record_sha256:string;snapshot_record_sha256:string;review_sha256:string;
 role_version:number;role_epoch:number;file_count:number;total_bytes:number;paths:string[];created_at:string;execution_authorized:false;source_bytes_verified:false;
};
export type TaskPrdWorkGrant={
 protocol:1;task_id:string;plan_id:string;cycle_id:string;grant_id:string;grant_sha256:string;review_sha256:string;snapshot_id:string;source_sha256:string;
 paths:string[];role_version:number;role_epoch:number;created_at:string;execution_authorized:false;source_bytes_verified:false;
};
export type TaskPrdWorkResources={task_id:string;plan_id:string;cycle_id:string|null;available:boolean;preparation:TaskPrdWorkPreparation|null;grant:TaskPrdWorkGrant|null;preparation_uncertain:boolean;reasons:string[];execution_authorized:false};

export type TaskPrdWorkAdmissionRequest={plan_id:string;cycle_id:string;grant_id:string;preview_sha256:string};
export type TaskPrdWorkAdmissionReceipt={protocol:1;task_id:string;plan_id:string;cycle_id:string;grant_id:string;grant_sha256:string;created_at:string;accepted:true;execution_authorized:false};
export type TaskPrdWorkAdmissionState={task_id:string;plan_id:string;available:boolean;request:TaskPrdWorkAdmissionReceipt|null;
 admission:{grant_id:string;occurrence_id:string;run_id:string;conversation_id:string;created_at:string}|null;reason:string|null;execution_authorized:false};

export type TaskmasterRuntimeVersionRequest={profile_id:string;manifest_sha256:string;cli_entry_sha256:string};
export type TaskmasterRuntimeVersion={protocol:1;owner_id:string;profile_id:string;manifest_sha256:string;cli_entry_sha256:string;declared_version:string;
 status:"observed"|"failed";runtime_version:string|null;stdout_sha256:string;exit_code:number|null;
 reason_code:"cli_failed"|"version_output_unconfirmed"|"cancelled"|"timeout"|"output_limit"|"spawn_failed"|"cleanup_unconfirmed"|null;observed_at:string;execution_authorized:false};
export type TaskPrdRuntimeVersion={task_id:string;task_version:number;runtime:TaskmasterRuntimeVersion};

export type TaskPrdAppendSource={task_count:number;sha256:string;subtasks:TaskSubtask[]};

export type WorkbenchMemoryImportTarget = {scope:"project"|"private";project_id:string;agent_id:string|null};
export type WorkbenchMemoryImportItem = {
 source_memory_id:string;source_version:number;source_history_versions:number[];source_content:string;
 source_provenance:Array<{kind:string;reference:string}>;source_revision:string|null;source_expires_at:string|null;
 target_key:string;target_expected_version:number;status:"ready"|"skipped"|"conflict";reason:string|null;source_local:boolean;
};
export type WorkbenchMemoryImportReceipt = {
 source_file?:WorkbenchMemoryImportFileSource;
 page?:WorkbenchMemoryImportPage;totals?:{total:number;created:number;skipped:number};
 mode?:"replace_scope";replacement?:WorkbenchMemoryReplacementReceipt;
 source_bundle?:WorkbenchMemoryImportBundle;
 import_id:string;status:"applied";version:number;target:WorkbenchMemoryImportTarget;applied_at:string;
 items:Array<(Omit<WorkbenchMemoryImportItem,"status">&{status:"skipped"})|{source_memory_id:string;source_version:number;memory_id:string;version:number;status:"created"}>;
};
export type WorkbenchMemoryImportPreview = {
 source_file?:WorkbenchMemoryImportFileSource;
 page?:WorkbenchMemoryImportPage;
 mode?:"replace_scope";replacement?:WorkbenchMemoryReplacement;
 source_bundle?:WorkbenchMemoryImportBundle;
 schema_version:1;document_workspace_id:string;target:WorkbenchMemoryImportTarget;
 counts:{total:number;ready:number;skipped:number;conflict:number};items:WorkbenchMemoryImportItem[];
 import_id:string;input_sha256:string;version:number;status:"previewed"|"applied";created_at:string;updated_at:string;
 receipt?:WorkbenchMemoryImportReceipt;
};

export type WorkbenchMemoryImportBundle = {
 format_version:"clawxmemory-memory-snapshot.v4";sha256:string;file_count:number;global_file_count:number;memory_file_count:number;
 source_only_file_count:number;deprecated_file_count:number;total_utf8_bytes:number;execution_authorized:false;
 metadata:{exported_at:string|null;last_indexed_at:string|null;last_dream_at:string|null;last_dream_status:string|null;
 last_dream_summary_chars:number;case_trace_count:number;index_trace_count:number;dream_trace_count:number};
};
export type WorkbenchMemoryImportBundleSource = {
 import_id:string;input_sha256:string;sha256:string;bundle?:Record<string,unknown>;source_file?:WorkbenchMemoryImportFileSource;execution_authorized:false;
};

export type WorkbenchMemoryReplacementItem = {memory_id:string;version:number;content_sha256:string;content_chars:number;verified:boolean;expires_at:string|null};
export type WorkbenchMemoryReplacement = {scope_sha256:string;count:number;page?:WorkbenchMemoryImportPage;items:WorkbenchMemoryReplacementItem[]};
export type WorkbenchMemoryReplacementReceipt = {scope_sha256:string;count:number;page?:WorkbenchMemoryImportPage;items:Array<{memory_id:string;from_version:number;result_version:number;status:"deleted"}>};

export type WorkbenchMemoryImportReplacementSource = {import_id:string;preview_version:number;memory_id:string;version:number;sha256:string;memory:WorkbenchMemory;execution_authorized:false};

export type WorkbenchMemoryImportPage = {offset:number;limit:number;total:number;next_offset:number|null};

export type WorkbenchMemoryImportFileSelection = {kind:"workspace_file";path:string;version:number;sha256:string;size:number};
export type WorkbenchMemoryImportFileSource = WorkbenchMemoryImportFileSelection&{workspace_id:string;project_id:string};

export type WorkbenchMemoryImportHistorySection = "metadata"|"case"|"index"|"dream";
export type WorkbenchMemoryImportSourceHistory = {
 import_id:string;input_sha256:string;sha256:string;execution_authorized:false;
 section:WorkbenchMemoryImportHistorySection;content_sha256:string;text:string;page:WorkbenchMemoryImportPage;
};


export type BrainPublicationInput = {project_id:string;page_id:string;title:string;summary:string;memory_ids:string[]};
export type BrainPublicationSummary = {
 publication_id:string;workspace_id:string;project_id:string;page_id:string;title:string;summary:string;
 status:'proposed'|'applied'|'rejected';version:number;created_at:string;updated_at:string;
};
export type BrainPublication = BrainPublicationSummary & {
 brain_root:string;current:boolean;
 sources:{memory_id:string;version:number;content:string|null;verified:boolean}[];
 files:{path:string;expected_version:number;before_content:string|null;content:string}[];
 results:WorkbenchFile[]|null;
};
export type BrainPublicationPage = {items:BrainPublicationSummary[];next_before_id:string|null};


export type GitCommitIdentity = {name:string;email:string;timestamp:string};
export type GitCommitMetadata = {
 protocol:1;encoding:'UTF-8';object_format:'sha1'|'sha256';tree_oid:string;parent_oid:string|null;
 target_ref:string;head_state:'branch'|'unborn'|'detached';author:GitCommitIdentity;committer:GitCommitIdentity;
 operator_policy_sha256:string;message_sha256:string;message_bytes:number;
};

export type NativeMemberParentRun = Pick<Run, "run_id" | "conversation_id" | "created_at" | "status" | "version">;
export type NativeMemberParentPage = {conversation_id: string; items: NativeMemberParentRun[]; next_cursor?: string; execution_authorized: false};

export type InteractionHistoryPage={conversation_id:string;run_id?:string;items:Interaction[];next_cursor?:string;execution_authorized:false};

export type ActivityResultArtifact={artifact_id:string;version:number;sha256:string};
