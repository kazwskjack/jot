import type {BrainPublication,BrainPublicationPage} from '../../packages/gateway/contracts/types';
import type {WorkbenchMemoryImportTarget,WorkbenchMemoryImportPreview,WorkbenchMemoryImportBundleSource,WorkbenchMemoryImportHistorySection,WorkbenchMemoryImportSourceHistory,WorkbenchMemoryImportReplacementSource} from '../../packages/gateway/contracts/types';
import {createHostAdminClient} from './host-admin-client.mjs';
import type {MemoryRetrieval,MemoryRetrievalPage} from './types';
import type {ProjectPage,GitSnapshot,GitDiff} from './types';
import type {GitReviewIntent} from './types';
import type {WorkPublicationReview,WorkPublicationSource,WorkPublicationAcceptance,WorkPublicationStatus,WorkPublicationSettlementReceipt,WorkPublicationHistory} from './types';
import type {GitIndexAcceptance,GitIndexExecutionResult} from './types';
import type {GitIndexAdmissionInput,GitIndexControlInput,GitIndexControlAcceptance,GitIndexInspection,GitIndexControlReceipt} from './types';
import type {GitIndexStatus,GitIndexResolutionResult} from './types';
import type {GitIndexHistory} from './types';
import type {DiscoveryPolicyView} from './types';
import type {DiscoveryHistoryPage,DiscoveryHistoryDetail,CreateDiscoveryWorkCycle,DiscoveryWorkCycle} from './types';
import type {MemoryCapturePolicy,MemoryCapture,MemoryCapturePage,MemoryCaptureRecovery,MemoryCaptureReconcileInput,MemoryCaptureReconciliation} from './types';
import type {MemoryConsolidation,MemoryConsolidationPage} from './types';
import {request,requestBytes,hostBootstrapRequest} from '../jot/client';
import type {WorkspaceFilePage,WorkspaceFileListOptions} from './types';
import type {WorkbenchFileLifecycleHistoryPage,WorkbenchFileLifecycleHistoryQuery,WorkbenchFileLifecyclePreview,WorkbenchFileLifecycleReceipt,WorkbenchFileLifecycleStatus,PreviewWorkbenchFileRename,PreviewWorkbenchFileDelete,ApplyWorkbenchFileRename,ApplyWorkbenchFileDelete} from './types';
import type {MemoryHistoryPage} from './types';
import type {CreateProject,Project,UpdateProject,ProjectLifecycle,ProjectLifecyclePage,UpdateProjectLifecycle,WorkspaceSelection,SelectWorkspace} from '../../packages/gateway/contracts/types';
import type {Agent,Caps,Task,Occurrence,Team,Memory,MemoryExport,AgentMessage} from './types';
import type {TaskReadiness,TaskSubtask} from './types';
import type {UpsertTaskSubtask} from '../../packages/gateway/contracts/types';
import type {CreateTaskDelegation,TaskDelegationReceipt} from './types';
import type {SaveTaskCollaboration,TaskCollaboration} from './types';
import type {TaskModelBudget,TaskModelBudgetAttempts,UpdateTaskModelBudget} from './types';
import type {Run,ResumeReceipt} from '../jot/types';
import type {ChannelBinding,ChannelBindingChallenge,CreatePushSubscription,PushVapidPublicKey,PushSubscriptionRevocation,TaskNotificationSettings,UpdateTaskNotifications,TaskNotificationDelivery,TaskNotificationHistoryPage} from './types';
import type {WorkspaceCheckpoint,WorkspaceCheckpointPage,WorkspaceCheckpointRestoreReview,WorkspaceCheckpointRestoreStatus,WorkspaceCheckpointRestoreReceipt,CreateWorkspaceCheckpoint,CreateWorkspaceCheckpointRestoreReview,RestoreWorkspaceCheckpoint,ReconcileWorkspaceCheckpointRestore} from './types';
export const pathId=(value:string)=>encodeURIComponent(value);
export type ReadonlyNotificationInput={readonly [K in keyof UpdateTaskNotifications]:Readonly<UpdateTaskNotifications[K]>};
export const taskActionCommand=(task:Task,action:string,key?:string)=>({
 path:'/persistent-tasks/'+pathId(task.task_id)+'/'+action,method:'POST',
 body:action==='run-now'?{client_message_id:key??crypto.randomUUID()}:{expected_version:task.version}
});
export const hostAdminClient=createHostAdminClient(request,hostBootstrapRequest);
export const workbenchApi={
 workspaceSelection:(signal?:AbortSignal)=>request<WorkspaceSelection>('/workspaces/selection','GET',undefined,undefined,signal),
 selectWorkspace:(input:SelectWorkspace,key:string)=>request<WorkspaceSelection>('/workspaces/selection','POST',input,key),
 gitHistory:(project:string,options:{before?:string;limit?:number}={},signal?:AbortSignal)=>{const query=new URLSearchParams();if(options.before!==undefined)query.set('before',options.before);if(options.limit!==undefined)query.set('limit',String(options.limit));return request<GitIndexHistory>(`/projects/${pathId(project)}/git/history${query.size?'?'+query.toString():''}`,'GET',undefined,undefined,signal)},
 gitStatus:(project:string,execution:string,signal?:AbortSignal)=>request<GitIndexStatus>(`/projects/${pathId(project)}/git/executions/${pathId(execution)}/status`,'GET',undefined,undefined,signal),
 gitDispatch:(project:string,execution:string,key:string,signal?:AbortSignal)=>request<GitIndexStatus>(`/projects/${pathId(project)}/git/executions/${pathId(execution)}/dispatch`,'POST',{},key,signal),
 gitResolve:(project:string,execution:string,input:GitIndexControlInput,key:string,signal?:AbortSignal)=>request<GitIndexResolutionResult>(`/projects/${pathId(project)}/git/executions/${pathId(execution)}/resolve`,'POST',input,key,signal),
 gitAdmit:(project:string,intent:string,input:GitIndexAdmissionInput,key:string,signal?:AbortSignal)=>request<GitIndexAcceptance>(`/projects/${pathId(project)}/git/intents/${pathId(intent)}/admissions`,'POST',input,key,signal),
 gitAdmitControl:(project:string,execution:string,input:GitIndexControlInput,key:string,signal?:AbortSignal)=>request<GitIndexControlAcceptance>(`/projects/${pathId(project)}/git/executions/${pathId(execution)}/controls`,'POST',input,key,signal),
 gitInspection:(project:string,execution:string,signal?:AbortSignal)=>request<GitIndexInspection>(`/projects/${pathId(project)}/git/executions/${pathId(execution)}/inspection`,'GET',undefined,undefined,signal),
 gitControlAcceptance:(project:string,execution:string,requestId:string,signal?:AbortSignal)=>request<GitIndexControlAcceptance>(`/projects/${pathId(project)}/git/executions/${pathId(execution)}/control-admissions/${pathId(requestId)}`,'GET',undefined,undefined,signal),
 gitControlReceipt:(project:string,execution:string,requestId:string,signal?:AbortSignal)=>request<GitIndexControlReceipt>(`/projects/${pathId(project)}/git/executions/${pathId(execution)}/controls/${pathId(requestId)}`,'GET',undefined,undefined,signal),
 projectLifecycle:(signal?:AbortSignal)=>request<ProjectLifecyclePage>('/projects/lifecycle','GET',undefined,undefined,signal),
 updateProjectLifecycle:(projectId:string,input:UpdateProjectLifecycle,key:string)=>request<ProjectLifecycle>(`/projects/${pathId(projectId)}/lifecycle`,'POST',input,key),
 projects:(signal?:AbortSignal)=>request<ProjectPage>('/projects','GET',undefined,undefined,signal),
 createProject:(input:CreateProject,key:string)=>request<Project>('/projects','POST',input,key),
 renameProject:(projectId:string,input:UpdateProject,key:string)=>request<Project>(`/projects/${pathId(projectId)}`,'PATCH',input,key),
 git:(project:string,signal?:AbortSignal)=>request<GitSnapshot>(`/projects/${pathId(project)}/git`,'GET',undefined,undefined,signal),
 gitDiff:(project:string,snapshot:string,file:string,stage:'working'|'staged',signal?:AbortSignal)=>request<GitDiff>(`/projects/${pathId(project)}/git/diff?snapshot_id=${pathId(snapshot)}&path=${pathId(file)}&stage=${stage}`,'GET',undefined,undefined,signal),
 gitReview:(project:string,intent:string,signal?:AbortSignal)=>request<GitReviewIntent>(`/projects/${pathId(project)}/git/intents/${pathId(intent)}`,'GET',undefined,undefined,signal),
 publicationReview:(project:string,intent:string,signal?:AbortSignal)=>request<WorkPublicationReview>(`/projects/${pathId(project)}/work-publications/${pathId(intent)}`,'GET',undefined,undefined,signal),
 publicationSource:(project:string,run:string,signal?:AbortSignal)=>request<WorkPublicationSource>(`/projects/${pathId(project)}/work-publication-sources/${pathId(run)}`,'GET',undefined,undefined,signal),
 publicationHistory:(project:string,run:string,before?:string,signal?:AbortSignal)=>request<WorkPublicationHistory>(`/projects/${pathId(project)}/work-publication-sources/${pathId(run)}/history${before?'?before='+pathId(before):''}`,'GET',undefined,undefined,signal),
 publicationAcceptance:(project:string,requestId:string,signal?:AbortSignal)=>request<WorkPublicationAcceptance>(`/projects/${pathId(project)}/work-publication-admissions/${pathId(requestId)}`,'GET',undefined,undefined,signal),
 publicationStatus:(project:string,executionId:string,signal?:AbortSignal)=>request<WorkPublicationStatus>(`/projects/${pathId(project)}/work-publication-executions/${pathId(executionId)}`,'GET',undefined,undefined,signal),
 publicationSettlementReceipt:(project:string,executionId:string,requestId:string,signal?:AbortSignal)=>request<WorkPublicationSettlementReceipt>(`/projects/${pathId(project)}/work-publication-executions/${pathId(executionId)}/settlements/${pathId(requestId)}`,'GET',undefined,undefined,signal),
 publicationLatestSettlement:(project:string,executionId:string,signal?:AbortSignal)=>request<WorkPublicationSettlementReceipt>(`/projects/${pathId(project)}/work-publication-executions/${pathId(executionId)}/settlement`,'GET',undefined,undefined,signal),
 gitAcceptance:(project:string,requestId:string,signal?:AbortSignal)=>request<GitIndexAcceptance>(`/projects/${pathId(project)}/git/admissions/${pathId(requestId)}`,'GET',undefined,undefined,signal),
 gitExecution:(project:string,executionId:string,signal?:AbortSignal)=>request<GitIndexExecutionResult>(`/projects/${pathId(project)}/git/executions/${pathId(executionId)}`,'GET',undefined,undefined,signal),
 files:(workspace:string,project:string,options:WorkspaceFileListOptions={},signal?:AbortSignal)=>request<WorkspaceFilePage>(`/workspaces/${pathId(workspace)}/files?project_id=${pathId(project)}${options.limit===undefined?'':`&limit=${options.limit}`}${options.cursor===undefined?'':`&cursor=${pathId(options.cursor)}`}`,'GET',undefined,undefined,signal),
 importWorkspaceFileBinary:(workspace:string,project:string,path:string,expected_version:number,file:File,key:string,signal?:AbortSignal)=>request<{workspace_id:string;project_id:string;path:string;version:number;sha256:string;size:number;source:{kind:'directory_import';relative_path:string}}>(`/workspaces/${pathId(workspace)}/files/binary?project_id=${pathId(project)}&path=${pathId(path)}&expected_version=${expected_version}`,'PUT',file,key,signal),
 readWorkspaceFileBinary:(workspace:string,project:string,path:string,version:number,sha256:string,signal?:AbortSignal)=>requestBytes(`/workspaces/${pathId(workspace)}/files/binary?project_id=${pathId(project)}&path=${pathId(path)}&version=${version}&sha256=${sha256}`,signal),
 fileLifecycleHistory:(workspace:string,project:string,options:Omit<WorkbenchFileLifecycleHistoryQuery,'project_id'>={},signal?:AbortSignal)=>request<WorkbenchFileLifecycleHistoryPage>(`/workspaces/${pathId(workspace)}/files/lifecycle-history?project_id=${pathId(project)}${options.limit===undefined?'':`&limit=${options.limit}`}${options.cursor===undefined?'':`&cursor=${pathId(options.cursor)}`}`,'GET',undefined,undefined,signal),
 fileLifecyclePreview:(workspace:string,action:'rename'|'delete',input:PreviewWorkbenchFileRename|PreviewWorkbenchFileDelete,signal?:AbortSignal)=>request<WorkbenchFileLifecyclePreview>(`/workspaces/${pathId(workspace)}/files/${action}-preview?project_id=${pathId(input.project_id)}&path=${pathId(input.path)}${action==='rename'?`&target_path=${pathId((input as PreviewWorkbenchFileRename).target_path)}`:''}&expected_version=${input.expected_version}`,'GET',undefined,undefined,signal),
 applyFileLifecycle:(workspace:string,action:'rename'|'delete',input:ApplyWorkbenchFileRename|ApplyWorkbenchFileDelete,key:string,signal?:AbortSignal)=>request<WorkbenchFileLifecycleReceipt>(`/workspaces/${pathId(workspace)}/files/${action}`,'POST',input,key,signal),
 fileLifecycleStatus:(workspace:string,project:string,commandKey:string,signal?:AbortSignal)=>request<WorkbenchFileLifecycleStatus>(`/workspaces/${pathId(workspace)}/files/lifecycle-commands/${pathId(commandKey)}?project_id=${pathId(project)}`,'GET',undefined,undefined,signal),
 workspaceCheckpoints:(workspace:string,project:string,signal?:AbortSignal)=>request<WorkspaceCheckpointPage>(`/workspaces/${pathId(workspace)}/checkpoints?project_id=${pathId(project)}`,'GET',undefined,undefined,signal),
 workspaceCheckpoint:(workspace:string,project:string,checkpointId:string,signal?:AbortSignal)=>request<WorkspaceCheckpoint>(`/workspaces/${pathId(workspace)}/checkpoints/${pathId(checkpointId)}?project_id=${pathId(project)}`,'GET',undefined,undefined,signal),
 createWorkspaceCheckpoint:(workspace:string,input:CreateWorkspaceCheckpoint,key:string)=>request<WorkspaceCheckpoint>(`/workspaces/${pathId(workspace)}/checkpoints`,'POST',input,key),
 reviewWorkspaceCheckpointRestore:(workspace:string,checkpointId:string,input:CreateWorkspaceCheckpointRestoreReview,key:string)=>request<WorkspaceCheckpointRestoreReview>(`/workspaces/${pathId(workspace)}/checkpoints/${pathId(checkpointId)}/restore-review`,'POST',input,key),
 restoreWorkspaceCheckpoint:(workspace:string,checkpointId:string,input:RestoreWorkspaceCheckpoint,key:string)=>request<WorkspaceCheckpointRestoreReceipt>(`/workspaces/${pathId(workspace)}/checkpoints/${pathId(checkpointId)}/restore`,'POST',input,key),
 workspaceCheckpointRestoreStatus:(workspace:string,project:string,operationId:string,signal?:AbortSignal)=>request<WorkspaceCheckpointRestoreStatus>(`/workspaces/${pathId(workspace)}/checkpoint-restores/${pathId(operationId)}?project_id=${pathId(project)}`,'GET',undefined,undefined,signal),
 reconcileWorkspaceCheckpointRestore:(workspace:string,operationId:string,input:ReconcileWorkspaceCheckpointRestore,key:string)=>request<WorkspaceCheckpointRestoreReceipt>(`/workspaces/${pathId(workspace)}/checkpoint-restores/${pathId(operationId)}/reconcile`,'POST',input,key),
 discoveryPolicy:(agentId:string,signal?:AbortSignal)=>request<DiscoveryPolicyView>(`/agents/${pathId(agentId)}/discovery-policy`,'GET',undefined,undefined,signal),
 discoveryHistory:(agentId:string,before?:string,signal?:AbortSignal)=>request<DiscoveryHistoryPage>(`/agents/${pathId(agentId)}/discovery-history${before?`?before_id=${pathId(before)}`:''}`,'GET',undefined,undefined,signal),
 discoveryHistoryDetail:(agentId:string,admissionId:string,afterPlan?:string,signal?:AbortSignal)=>request<DiscoveryHistoryDetail>(`/agents/${pathId(agentId)}/discovery-history/${pathId(admissionId)}${afterPlan?`?after_plan_id=${pathId(afterPlan)}`:''}`,'GET',undefined,undefined,signal),
 createDiscoveryWorkCycle:(agentId:string,admissionId:string,input:CreateDiscoveryWorkCycle,key:string,signal?:AbortSignal)=>request<DiscoveryWorkCycle>(`/agents/${pathId(agentId)}/discovery-history/${pathId(admissionId)}/work-cycles`,'POST',input,key,signal),
 memoryCapturePolicy:(agentId:string,signal?:AbortSignal)=>request<MemoryCapturePolicy>(`/agents/${pathId(agentId)}/memory-capture-policy`,'GET',undefined,undefined,signal),
 memoryCaptures:(agentId:string,before?:string,signal?:AbortSignal)=>request<MemoryCapturePage>(`/agents/${pathId(agentId)}/memory-captures${before?`?before_id=${pathId(before)}`:''}`,'GET',undefined,undefined,signal),
 memoryCapture:(agentId:string,id:string,signal?:AbortSignal)=>request<MemoryCapture>(`/agents/${pathId(agentId)}/memory-captures/${pathId(id)}`,'GET',undefined,undefined,signal),
 memoryCaptureRecovery:(agentId:string,id:string,signal?:AbortSignal)=>request<MemoryCaptureRecovery>(`/agents/${pathId(agentId)}/memory-captures/${pathId(id)}/recovery`,'GET',undefined,undefined,signal),
 reconcileMemoryCapture:(agentId:string,id:string,input:MemoryCaptureReconcileInput,key:string)=>request<MemoryCaptureReconciliation>(`/agents/${pathId(agentId)}/memory-captures/${pathId(id)}/reconcile`,'POST',input,key),
 capabilities:(signal?:AbortSignal)=>request<Caps>('/capabilities','GET',undefined,undefined,signal),
 channelBindings:(signal?:AbortSignal)=>request<{items:ChannelBinding[]}>('/channel-bindings','GET',undefined,undefined,signal),
 createChannelBinding:(key:string)=>request<ChannelBindingChallenge>('/channel-bindings','POST',{channel:'wecom'},key),
 revokeChannelBinding:(binding:ChannelBinding,key:string)=>request<ChannelBinding>(`/channel-bindings/${pathId(binding.channel_binding_id)}/revoke`,'POST',{expected_version:binding.version},key),
 getPushVapidPublicKey:()=>request<PushVapidPublicKey>('/push/vapid-public-key'),
 registerPushSubscription:(input:CreatePushSubscription,key:string)=>request<ChannelBinding>('/push/subscriptions','POST',input,key),
 revokePushSubscription:(binding:ChannelBinding,key:string,localEndpoint?:string)=>request<PushSubscriptionRevocation>(`/push/subscriptions/${pathId(binding.channel_binding_id)}/revoke`,'POST',{expected_version:binding.version,...(localEndpoint===undefined?{}:{local_endpoint:localEndpoint})},key),
 taskNotifications:(taskId:string,signal?:AbortSignal)=>request<TaskNotificationSettings>(`/persistent-tasks/${pathId(taskId)}/notifications`,'GET',undefined,undefined,signal),
 saveTaskNotifications:(taskId:string,input:ReadonlyNotificationInput,key:string)=>request<TaskNotificationSettings>(`/persistent-tasks/${pathId(taskId)}/notifications`,'PATCH',input,key),
 taskDeliveries:(taskId:string,occurrenceId:string,signal?:AbortSignal)=>request<{items:TaskNotificationDelivery[]}>(`/persistent-tasks/${pathId(taskId)}/occurrences/${pathId(occurrenceId)}/deliveries`,'GET',undefined,undefined,signal),
 taskNotificationHistory:(taskId:string,cursor?:string,signal?:AbortSignal)=>request<TaskNotificationHistoryPage>(`/persistent-tasks/${pathId(taskId)}/deliveries${cursor?`?cursor=${pathId(cursor)}`:''}`,'GET',undefined,undefined,signal),
 agents:(signal?:AbortSignal)=>request<{items:Agent[]}>('/agents','GET',undefined,undefined,signal),
 saveAgent:(input:unknown,agentId?:string,key?:string)=>request<Agent>(agentId?`/agents/${pathId(agentId)}`:'/agents',agentId?'PATCH':'POST',input,key),
 deletionPreview:(agentId:string)=>request<Record<string,unknown>>(`/agents/${pathId(agentId)}/deletion-preview`),
 deleteAgent:(agent:Agent)=>request(`/agents/${pathId(agent.agent_id)}`,'DELETE',{expected_version:agent.version}),
 tasks:(signal?:AbortSignal)=>request<{items:Task[]}>('/persistent-tasks','GET',undefined,undefined,signal),
 saveTask:(input:unknown,taskId?:string)=>request<Task>(taskId?`/persistent-tasks/${pathId(taskId)}`:'/persistent-tasks',taskId?'PATCH':'POST',input),
 taskAction:(task:Task,action:string,key?:string)=>{const command=taskActionCommand(task,action,key);return request(command.path,command.method,command.body,key);},
 occurrences:(taskId:string,signal?:AbortSignal)=>request<{items:Occurrence[]}>(`/persistent-tasks/${pathId(taskId)}/occurrences`,'GET',undefined,undefined,signal),
 resumeTaskRun:(run:Pick<Run,'run_id'|'version'|'checkpoint_id'>,key:string,signal?:AbortSignal)=>request<ResumeReceipt>(`/runs/${pathId(run.run_id)}/resume`,'POST',{expected_run_version:run.version,checkpoint_id:run.checkpoint_id},key,signal),
 taskReadiness:(taskId:string,signal?:AbortSignal)=>request<TaskReadiness>(`/persistent-tasks/${pathId(taskId)}/readiness`,'GET',undefined,undefined,signal),
 taskModelBudget:(taskId:string,signal?:AbortSignal)=>request<TaskModelBudget>(`/persistent-tasks/${pathId(taskId)}/model-budget`,'GET',undefined,undefined,signal),
 taskModelBudgetAttempts:(taskId:string,cursor?:string,signal?:AbortSignal)=>{const query=new URLSearchParams({limit:'20'});if(cursor!==undefined)query.set('cursor',cursor);return request<TaskModelBudgetAttempts>(`/persistent-tasks/${pathId(taskId)}/model-budget/attempts?${query}`,'GET',undefined,undefined,signal)},
 updateTaskModelBudget:(taskId:string,input:UpdateTaskModelBudget,key:string)=>request<TaskModelBudget>(`/persistent-tasks/${pathId(taskId)}/model-budget`,'PATCH',input,key),
  subtasks:(taskId:string,signal?:AbortSignal)=>request<{items:TaskSubtask[]}>(`/persistent-tasks/${pathId(taskId)}/subtasks`,'GET',undefined,undefined,signal),
  upsertSubtask:(taskId:string,input:UpsertTaskSubtask,signal?:AbortSignal)=>request<TaskSubtask>(`/persistent-tasks/${pathId(taskId)}/subtasks`,'POST',input,undefined,signal),
  delegateTask:(taskId:string,input:CreateTaskDelegation)=>request<TaskDelegationReceipt>(`/persistent-tasks/${pathId(taskId)}/delegations`,'POST',input,input.client_message_id),
 taskCollaboration:(taskId:string,signal?:AbortSignal)=>request<TaskCollaboration>(`/persistent-tasks/${pathId(taskId)}/collaboration`,'GET',undefined,undefined,signal),
 saveTaskCollaboration:(taskId:string,input:SaveTaskCollaboration,key:string)=>request<TaskCollaboration>(`/persistent-tasks/${pathId(taskId)}/collaboration`,'PATCH',input,key),
 teams:(signal?:AbortSignal)=>request<{items:Team[]}>('/teams','GET',undefined,undefined,signal),
 saveTeam:(input:unknown,teamId?:string)=>request<Team>(teamId?`/teams/${pathId(teamId)}`:'/teams',teamId?'PATCH':'POST',input),
 deleteTeam:(team:Team)=>request(`/teams/${pathId(team.team_id)}`,'DELETE',{expected_version:team.version}),
 messages:(workspace:string,signal?:AbortSignal)=>request<{items:AgentMessage[]}>(`/workspaces/${pathId(workspace)}/agent-messages`,'GET',undefined,undefined,signal),
 taskMessages:(workspace:string,occurrenceId:string,signal?:AbortSignal)=>request<{items:AgentMessage[]}>(`/workspaces/${pathId(workspace)}/agent-messages?occurrence_id=${pathId(occurrenceId)}`,'GET',undefined,undefined,signal),
 sendMessage:(workspace:string,input:unknown,key:string)=>request(`/workspaces/${pathId(workspace)}/agent-messages`,'POST',input,key),
 brainPublications:(workspace:string,project:string,before:string|undefined,signal?:AbortSignal)=>request<BrainPublicationPage>(`/workspaces/${pathId(workspace)}/brain-publications?project_id=${pathId(project)}${before?'&before_id='+pathId(before):''}`,'GET',undefined,undefined,signal),
 brainPublication:(workspace:string,id:string,signal?:AbortSignal)=>request<BrainPublication>(`/workspaces/${pathId(workspace)}/brain-publications/${pathId(id)}`,'GET',undefined,undefined,signal),
 memories:(workspace:string,query:string,signal?:AbortSignal)=>request<{items:Memory[]}>(`/workspaces/${pathId(workspace)}/memory${query}`,'GET',undefined,undefined,signal),
 memoryHistory:(workspace:string,memoryId:string,signal?:AbortSignal,beforeVersion?:number)=>request<MemoryHistoryPage>(`/workspaces/${pathId(workspace)}/memory/${pathId(memoryId)}/history${beforeVersion===undefined?'':`?before_version=${beforeVersion}`}`,'GET',undefined,undefined,signal),
 memoryRetrievals:(workspace:string,agentId:string,before?:string,signal?:AbortSignal)=>request<MemoryRetrievalPage>(`/workspaces/${pathId(workspace)}/memory-retrievals?agent_id=${pathId(agentId)}${before?`&before_id=${pathId(before)}`:''}`,'GET',undefined,undefined,signal),
 memoryRetrieval:(workspace:string,id:string,signal?:AbortSignal)=>request<MemoryRetrieval>(`/workspaces/${pathId(workspace)}/memory-retrievals/${pathId(id)}`,'GET',undefined,undefined,signal),
 memoryConsolidations:(workspace:string,query:string,signal?:AbortSignal)=>request<MemoryConsolidationPage>(`/workspaces/${pathId(workspace)}/memory-consolidations${query}`,'GET',undefined,undefined,signal),
 memoryConsolidation:(workspace:string,id:string,signal?:AbortSignal)=>request<MemoryConsolidation>(`/workspaces/${pathId(workspace)}/memory-consolidations/${pathId(id)}`,'GET',undefined,undefined,signal),
 memoryImportReplacementSource:(workspace:string,id:string,memoryId:string,version:number,signal?:AbortSignal)=>request<WorkbenchMemoryImportReplacementSource>(`/workspaces/${pathId(workspace)}/memory/import/${pathId(id)}/replacement/${pathId(memoryId)}?preview_version=${version}`,'GET',undefined,undefined,signal),
 memoryImportSourceHistory:(workspace:string,id:string,section:WorkbenchMemoryImportHistorySection,offset:number,signal?:AbortSignal)=>request<WorkbenchMemoryImportSourceHistory>(`/workspaces/${pathId(workspace)}/memory/import/${pathId(id)}/source/history?section=${section}&offset=${offset}&limit=4096`,'GET',undefined,undefined,signal),
 memoryImportSource:(workspace:string,id:string,signal?:AbortSignal)=>request<WorkbenchMemoryImportBundleSource>(`/workspaces/${pathId(workspace)}/memory/import/${pathId(id)}/source`,'GET',undefined,undefined,signal),
 memoryImport:(workspace:string,id:string,signal?:AbortSignal,offset?:number)=>request<WorkbenchMemoryImportPreview>(`/workspaces/${pathId(workspace)}/memory/import/${pathId(id)}${offset===undefined?'':`?offset=${offset}&limit=25`}`,'GET',undefined,undefined,signal),
 previewMemoryImport:(workspace:string,input:{import_id:string;document:unknown;target:WorkbenchMemoryImportTarget;mode?:'replace_scope'},key:string,signal?:AbortSignal,offset?:number)=>request<WorkbenchMemoryImportPreview>(`/workspaces/${pathId(workspace)}/memory/import/preview${offset===undefined?'':`?offset=${offset}&limit=25`}`,'POST',input,key,signal),
 exportMemory:(workspace:string,query:string,signal?:AbortSignal)=>request<MemoryExport>(`/workspaces/${pathId(workspace)}/memory/export${query}`,'GET',undefined,undefined,signal),
 saveMemory:(workspace:string,input:unknown,memoryId?:string)=>request<Memory>(`/workspaces/${pathId(workspace)}/memory`,'POST',{...input as object,...(memoryId?{memory_id:memoryId}:{})}),
 deleteMemory:(workspace:string,memory:Memory)=>request(`/workspaces/${pathId(workspace)}/memory/${pathId(memory.memory_id)}`,'DELETE',{expected_version:memory.version}),
};
