import type {Capabilities} from '../jot/types';
export type {CreateTaskDelegation,TaskDelegationReceipt} from '../../packages/gateway/contracts/types';
export type {SaveTaskCollaboration,TaskCollaboration} from '../../packages/gateway/contracts/types';
export type {ChannelBinding,ChannelBindingChallenge,TaskNotificationSettings,UpdateTaskNotifications,TaskNotificationDelivery,TaskNotificationHistoryPage} from '../../packages/gateway/contracts/types';
export type {TaskReadiness,TaskSubtask} from '../../packages/gateway/contracts/types';
export type {TaskModelBudget,TaskModelBudgetView,ModelBudgetSummary,UpdateTaskModelBudget} from '../../packages/gateway/contracts/types';
export type Agent={agent_id:string;name:string;instructions:string;workspace_id:string;project_id:string;conversation_id:string;status:string;version:number;capability_epoch:number;allowed_tools:string[];created_at:string;updated_at:string};
export type TaskScheduleLimits={default_interval_seconds?:number;min_interval_seconds?:number;max_interval_seconds?:number;dst_gap?:string;dst_fold?:string;missed_triggers?:string};
export type WorkbenchCapabilities={enabled:boolean;task_reply_policy?:boolean;task_reply_execution?:false;task_create_delivery?:boolean;task_notifications?:boolean;channel_bindings?:boolean;email_bindings?:boolean;wecom_bindings?:boolean;task_notification_events?:('changed'|'completed'|'failed'|'needs_confirmation')[];execution_ready?:boolean;agent_roles:boolean;independent_teams:boolean;agent_messages:boolean;shared_workspace:boolean;memory_scopes:string[];memory_lifecycle?:boolean;memory_restore?:boolean;memory_consolidation?:boolean;memory_retrieval_traces?:boolean;memory_capture?:boolean;memory_retrieval?:'local_keyword';task_readiness?:boolean;task_unlimited_runs?:boolean;task_run_limit_protocol?:1;model_budget?:boolean;task_model_budget_limits?:{tokens:number;nano_usd:number|null;model_calls:number};task_triggers:string[];task_schedule_limits?:TaskScheduleLimits;notification_channels:string[];collaboration_modes:{id:string;enabled:boolean;reason?:string}[];allowed_tools?:string[]};
export type Caps=Capabilities&{workbench?:WorkbenchCapabilities};
export type Team={team_id:string;name:string;workspace_id:string;project_id?:string;member_ids?:string[];agent_ids?:string[];version:number;status?:string;created_at:string};
export type TaskTrigger={kind:string;conversation_id?:string;interval_seconds?:number;url?:string;run_at?:string;time?:string;timezone?:string;weekdays?:number[]};
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
export type {MemoryCapturePolicy,MemoryCapture,MemoryCapturePage} from '../../packages/gateway/contracts/types';
