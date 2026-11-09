import type {Capabilities} from '../jot/types';
import type {BrowserActionReadinessItem} from '../../packages/gateway/contracts/types';
export type {BrowserActionReadinessItem};
export type {ProjectPage,GitSnapshot,GitDiff,GitBranchInventory,GitEntry} from '../../packages/gateway/contracts/types';
export type {GitReviewPrepare,GitReviewControl,GitReviewIntent} from '../../packages/gateway/contracts/types';
export type {WorkPublicationPrepare,WorkPublicationControl,WorkPublicationReview,WorkPublicationSource} from '../../packages/gateway/contracts/types';
export type {WorkPublicationAdmission,WorkPublicationAcceptance,WorkPublicationStatus} from '../../packages/gateway/contracts/types';
export type {WorkPublicationHistory,WorkPublicationHistoryItem} from '../../packages/gateway/contracts/types';
export type {WorkPublicationSettlementCommand,WorkPublicationSettlementReceipt,WorkPublicationSettlementResult} from '../../packages/gateway/contracts/types';
export type {GitIndexAcceptance,GitIndexExecutionResult} from '../../packages/gateway/contracts/types';
export type {GitIndexAdmissionInput,GitIndexControlInput,GitIndexControlAcceptance,GitIndexInspection,GitIndexControlReceipt} from '../../packages/gateway/contracts/types';
export type {GitIndexDispatchInput,GitIndexProducer,GitIndexStatus,GitIndexResolutionResult} from '../../packages/gateway/contracts/types';
export type {GitIndexHistory,GitIndexHistoryItem} from '../../packages/gateway/contracts/types';
export type {CreateTaskDelegation,TaskDelegationReceipt} from '../../packages/gateway/contracts/types';
export type {SaveTaskCollaboration,TaskCollaboration} from '../../packages/gateway/contracts/types';
export type {ChannelBinding,ChannelBindingChallenge,CreatePushSubscription,PushVapidPublicKey,PushSubscriptionRevocation,RevokePushSubscription,TaskNotificationSettings,UpdateTaskNotifications,TaskNotificationDelivery,TaskNotificationHistoryPage} from '../../packages/gateway/contracts/types';
export type {TaskReadiness,TaskSubtask} from '../../packages/gateway/contracts/types';
export type {TaskModelBudget,TaskModelBudgetView,ModelBudgetSummary,UpdateTaskModelBudget,TaskModelBudgetAttemptUsage,TaskModelBudgetAttempt,TaskModelBudgetAttemptsView,TaskModelBudgetAttemptsUnavailable,TaskModelBudgetAttempts} from '../../packages/gateway/contracts/types';
export type Agent={agent_id:string;name:string;instructions:string;workspace_id:string;project_id:string;conversation_id:string;status:string;version:number;capability_epoch:number;allowed_tools:string[];created_at:string;updated_at:string};
export type DiscoveryPolicy={policy_id:string;scope:{agent_id:string;project_id:string;workspace_id:string};version:number;role_version:number;role_epoch:number;state:'off'|'active'|'paused'|'stopped';effective_state?:'off'|'active'|'paused'|'stopped'|'revoked';mode:'discover_only'|'discover_and_work';cooldown_ms:number;recent_input_ms:number;max_cycles:number|null;execution_authorized:false};
export type DiscoveryPolicyView={policy:DiscoveryPolicy|null;execution_authorized:false};
export type DiscoveryReport={report_id:string;sha256:string;outcome:'proposals'|'no_plan'|'blocked';summary:string;limitations:string[];plan_ids:string[];evidence:{kind:string;reference:string;hash?:string}[];coverage:{signal_count:number;fully_read:number}};
export type DiscoveryPlan={plan_id:string;sha256:string;summary:string;rationale:string;changes:{path:string;description:string;steps:string[];verification:string[]}[];evidence:{kind:string;reference:string;hash?:string}[]};
export type DiscoveryCycle={admission_id:string;occurrence_id:string;task_id:string;signal_revision:number;created_at:string;run:{run_id:string;status:string;business_state:string};report:(Omit<DiscoveryReport,'plan_ids'|'evidence'>&{plan_count:number})|null;accepted:boolean};
export type DiscoveryHistoryPage={items:DiscoveryCycle[];next_before_id:string|null;execution_authorized:false};
export type DiscoveryHistoryDetail={cycle:DiscoveryCycle;plans:DiscoveryPlan[];report:DiscoveryReport|null;next_after_plan_id:string|null;execution_authorized:false};
export type CreateDiscoveryWorkCycle={report_sha256:string;plan_ids:string[];expected_policy_version:number;expected_role_version:number;expected_role_epoch:number};
export type DiscoveryWorkCycle={cycle_id:string;version:number;state:'open'|'closed';admission_id:string;occurrence_id:string;task_id:string;root_run_id:string;report_sha256:string;policy_version:number;role_version:number;role_epoch:number;plans:{plan_id:string;sha256:string;paths:string[]}[];created_at:string;closed_at:string|null;execution_authorized:false};
export type TaskScheduleLimits={default_interval_seconds?:number;min_interval_seconds?:number;max_interval_seconds?:number;dst_gap?:string;dst_fold?:string;missed_triggers?:string};
export type RuntimeDependency='db'|'schema'|'host'|'native'|'consumer'|'policy'|'storage'|'driver';
export type RuntimeDependencyStatus='ready'|'disabled'|'unknown'|'failed';
export type RuntimeDependencyResult={component:RuntimeDependency;status:RuntimeDependencyStatus;required:boolean;reason:string|null};
/** Exact result emitted by packages/gateway/src/events/runtime-readiness.ts; the UI presents it and never recomputes it. */
export type RuntimeReadiness={schema_version:1;execution_ready:boolean;components:RuntimeDependencyResult[];errors:string[]};
export type HostReadinessState='ready'|'starting'|'preparing'|'disabled'|'unavailable'|'unverified'|'unknown'|'not_configured'|'fault'|'unsupported'|'enforced'|'failed';
export type HostReadinessResponse={
 protocol:1;as_of:string|null;state:HostReadinessState;
 scope:{namespace:string;state:'ready'|'partial'|'unknown'|'unavailable';revision:number|null};
 mode:{current:'agent'|'demo'|null;default_conversation:'chat'|'work'|null;state:HostReadinessState;reason_codes:string[]};
 workspace:{selected_id:string|null;items:{workspace_id:string|null;title:string|null;can_read:boolean|null;can_write:boolean|null}[];reason_codes:string[]};
 host:{state:HostReadinessState;reason_codes:string[]};
 worker:{state:HostReadinessState;reason_codes:string[]};
 providers:{provider_id:string|null;selected_model_id:string|null;state:HostReadinessState;model_ids:string[];credential_ref_present:boolean|null;reason_codes:string[]}[];
 voice:{state:HostReadinessState;reason_codes:string[]};
 plugins:{plugin_id:string|null;state:HostReadinessState;reason_codes:string[]}[];
 network_policy:{browser:{state:HostReadinessState;reason_codes:string[]};mcp:{state:HostReadinessState;reason_codes:string[]}};
};
export type HostSettingsValues={mode:'agent'|'demo';workspace_id:string;provider_id:string;model_id:string;credential_ref:string|null;voice_provider_id:string|null;plugin_selection:string[]};
export type HostSettingsSnapshot={namespace?:string;settings_version:number;schema_version:number;schema_fingerprint?:string|null;write_scope?:string|null;settings:HostSettingsValues};
export type HostSettingsWriteValues=Pick<HostSettingsValues,'mode'|'workspace_id'|'provider_id'|'model_id'|'plugin_selection'>;
export type HostSettingsPatch={expected_version:number;expected_schema_fingerprint:string;settings:HostSettingsWriteValues};
export type HostNamespaceSettingsSnapshot={protocol:1;source:'dsh-settings-controller';as_of:string|null;state:'ready'|'partial'|'unknown'|'unavailable';writable:boolean|null;has_document:boolean|null;namespaces:{namespace:string;state:'ready'|'partial'|'unknown';auto_generate:boolean|null;revision:number|null;schema:unknown;value:unknown;applies:string;secrets:{path:(string|number)[];set:boolean}[]}[]};
export type HostSettingsUpdate={settings_version:number;current_version?:number;schema_version:number;activation:'live'|'unknown';active_run_impact:{active_runs:number|null;active_sessions:number|null;current_sessions_restarted:null};migration:{from_schema_version:number|null;to_schema_version:number;state:'not_needed'|'migrated'|'failed'};receipt:{status:'saved'|'conflict'|'reload_failed';reason_code:string|null}};
export type HostSettingsCandidateWriteResult=
 |{status:'saved';namespace:string;settings_version:number;settings:Partial<HostSettingsWriteValues>;activation:{state:'live'|'unknown'};active_run_impact:{state:'known'|'unknown';active_runs:number|null;active_sessions:number|null;current_sessions_restarted:null};migration:{from_schema_version:number|null;to_schema_version:number;state:'not_required'|'migrated'};safe_boundary:{state:'unknown'}}
 |{status:'unknown_pending'|'held'|'rejected'|'stale_scope';reason_code:string}
 |{status:'conflict';current_version?:number};
export type OnboardingStep='mode'|'workspace'|'credentials'|'provider_test'|'save'|'complete';
export type OnboardingDraft={mode:'agent'|'demo'|null;workspace_id:string|null;provider_id:string|null;model_id:string|null;credential_ref:string|null};
export type HostOnboardingSnapshot={version:number;schema_version:number;current_step:OnboardingStep;draft:OnboardingDraft;last_receipt_id:string|null;last_error_code:string|null};
export type HostOnboardingPatch={expected_version:number;current_step:OnboardingStep;draft:OnboardingDraft};
export type HostAdminClient={
 credentials?:(signal?:AbortSignal)=>Promise<{enabled:boolean;owner_url?:string}>;
 approveSettingsRead:(signal?:AbortSignal)=>Promise<{approved:true;namespaces:string[]}>;
 namespaceSettings:(namespace:string,signal?:AbortSignal)=>Promise<HostNamespaceSettingsSnapshot>;
 readiness:(namespace:string,signal?:AbortSignal)=>Promise<HostReadinessResponse>;
 settings:(namespace:string,signal?:AbortSignal)=>Promise<HostSettingsSnapshot>;
 saveSettings:(namespace:string,input:HostSettingsPatch,key:string)=>Promise<HostSettingsUpdate|HostSettingsCandidateWriteResult>;
 settingsAttempt:(namespace:string,key:string,signal?:AbortSignal)=>Promise<HostSettingsCandidateWriteResult>;
 onboarding:(signal?:AbortSignal)=>Promise<HostOnboardingSnapshot>;
 saveOnboarding:(input:HostOnboardingPatch,key?:string)=>Promise<HostOnboardingSnapshot>;
};
export type WorkbenchCapabilities={enabled:boolean;plugin_profiles?:boolean;task_reply_policy?:boolean;task_reply_execution?:false;task_create_delivery?:boolean;task_notifications?:boolean;channel_bindings?:boolean;email_bindings?:boolean;wecom_bindings?:boolean;webpush_bindings?:boolean;task_notification_events?:('changed'|'completed'|'failed'|'needs_confirmation')[];execution_ready?:boolean;browser_action_readiness?:BrowserActionReadinessItem[];host_readiness?:boolean;host_readiness_namespaces?:string[];host_settings?:boolean;host_settings_write_namespace?:string;host_settings_read?:boolean;host_settings_read_namespaces?:string[];host_onboarding?:boolean;agent_roles:boolean;independent_teams:boolean;agent_messages:boolean;shared_workspace:boolean;workspace_file_history?:boolean;workspace_file_range?:boolean;memory_scopes:string[];memory_lifecycle?:boolean;memory_import?:boolean;memory_restore?:boolean;memory_consolidation?:boolean;memory_retrieval_traces?:boolean;memory_capture?:boolean;memory_retrieval?:'local_keyword';task_readiness?:boolean;task_prd?:boolean;task_unlimited_runs?:boolean;task_run_limit_protocol?:1;model_budget?:boolean;task_model_budget_limits?:{tokens:number;nano_usd:number|null;model_calls:number};task_triggers:string[];task_schedule_limits?:TaskScheduleLimits;notification_channels:string[];collaboration_modes:{id:string;enabled:boolean;reason?:string}[];allowed_tools?:string[]};
export type Caps=Capabilities&{workbench?:WorkbenchCapabilities};
export type Team={team_id:string;name:string;workspace_id:string;project_id?:string;member_ids?:string[];agent_ids?:string[];version:number;status?:string;created_at:string};
export type TaskTrigger={kind:string;delay_seconds?:number;conversation_id?:string;interval_seconds?:number;url?:string;run_at?:string;time?:string;timezone?:string;weekdays?:number[]};
export type TaskSourceSelection={conversation_id:string;message:{message_id:string;status:string;blocks:{kind:string;text?:string}[]}};
export type Task={source?:{conversation_id:string;message_id:string;content_sha256:string};task_id:string;title:string;agent_id:string;objective:string;trigger:TaskTrigger;budget:{max_runs:number|null};status:string;version:number;runs_used:number;next_due_at:string|null;last_error?:string|null;created_at:string};
export type TaskSchedulePreview={next_due_at:string|null;timezone:string|null};
export type Occurrence={occurrence_id:string;task_id:string;scheduled_for:string;conversation_id:string|null;run_id:string|null;status:string;business_state:string;completion_state?:'awaiting_completion'|'finalizing'|'reconciliation_pending'|'completed';evidence:unknown;created_at:string};
export type MemoryProvenance={kind:string;reference:string};
export type MemoryVersion={restored_from_version?:number;restored_over_version?:number;version:number;content:string;verified:boolean;provenance?:MemoryProvenance[];source_revision?:string|null;expires_at?:string|null;supersedes?:string|null;verified_at?:string|null;status?:'active'|'superseded'|'deleted';created_at:string;updated_at:string};
export type Memory=Omit<MemoryVersion,'verified'|'created_at'>&{memory_id:string;workspace_id?:string;project_id?:string;scope:'project'|'private';agent_id?:string|null;verified?:boolean;created_at?:string;expired?:boolean;history?:MemoryVersion[]};
export type MemoryExport={schema_version:1;workspace_id:string;exported_at:string;items:Memory[]};
export type AgentMessage={message_id:string;sender_agent_id:string;recipient_agent_id:string;text:string;initiator?:string;status?:string;created_at:string};


export type {TaskReplyHistoryItem,TaskReplyHistoryPage} from '../../packages/gateway/contracts/types';

export type MemoryHistoryPage={memory_id:string;current_version:number;next_before_version:number|null;items:MemoryVersion[]};

export type {MemoryConsolidation,MemoryConsolidationPage} from '../../packages/gateway/contracts/types';

export type {MemoryRetrieval,MemoryRetrievalPage} from '../../packages/gateway/contracts/types';
export type {MemoryCapturePolicy,MemoryCapture,MemoryCapturePage,MemoryCaptureRecovery,MemoryCaptureReconcileInput,MemoryCaptureReconciliation} from '../../packages/gateway/contracts/types';
export type {WorkspaceCheckpoint,WorkspaceCheckpointPage,WorkspaceCheckpointRestoreReview,WorkspaceCheckpointRestoreStatus,WorkspaceCheckpointRestoreReceipt,CreateWorkspaceCheckpoint,CreateWorkspaceCheckpointRestoreReview,RestoreWorkspaceCheckpoint,ReconcileWorkspaceCheckpointRestore} from '../../packages/gateway/contracts/types';
export interface WorkspaceFile {path:string;version:number;size:number;sha256:string;updated_at?:string}
export interface WorkspaceFilePage {items:WorkspaceFile[];next_cursor:string|null}
export interface WorkspaceFileListOptions {limit?:number;cursor?:string}
export interface WorkspaceFileVersion extends Omit<WorkspaceFile,'updated_at'> {created_at:string;workspace_id:string;project_id:string}
export interface WorkspaceFileVersionPage {workspace_id:string;project_id:string;path:string;items:WorkspaceFileVersion[];next_before_version:number|null}
import type {WorkbenchFileLifecycleReceipt} from '../../packages/gateway/contracts/types';
export type WorkbenchFileLifecycleHistoryItem=WorkbenchFileLifecycleReceipt;
export type WorkbenchFileLifecycleHistoryPage={items:WorkbenchFileLifecycleHistoryItem[];next_cursor:string|null};
export type {WorkbenchFileLifecycleHistoryQuery,WorkbenchFileLifecyclePreview,WorkbenchFileLifecycleReceipt,WorkbenchFileLifecycleStatus,PreviewWorkbenchFileRename,PreviewWorkbenchFileDelete,ApplyWorkbenchFileRename,ApplyWorkbenchFileDelete} from '../../packages/gateway/contracts/types';
