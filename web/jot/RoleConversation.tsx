import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import {validateTextReference} from './composer-draft-recovery.mjs';
import {FileTextReferenceContext,FileTextReferences,fileRegionCapture,nativeReferenceIdentity,fileReferenceMessage,fileReferenceSnapshots,isFileRegion,isFileCells,resolveRegionArtifact,type FileReference,type FileSourceReference,type FileRegionDraft,type FileSelectionReference} from './FileTextReferences';
import FileReferenceSource from './FileReferenceSource';
import MessageFileReferences from './MessageFileReferences';
import type {TaskSourceSelection} from '../workbench/types';
import {useMutationReceipt} from '../workbench/useMutationReceipt';
import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import TwemojiMarkdown from './TwemojiMarkdown';
import {ApiError,request,follow,snapshot,base,taskDraftScope,listNativeMembers,isNativeMemberObservedStopped,interruptNativeMember,readNativeMemberInterruptReceipt,continueNativeMember,readNativeMemberWakeReceipt,readNativeMemberPendingActions,writeNativeMemberPendingAction,dispatchNativeMemberAction,clearNativeMemberPendingAction} from './client';
import type {NativeMember,NativeMemberRoster,NativeMemberPendingAction} from './client';
import {RoleChatController} from './conversation-controller.mjs';
import {UploadController} from './upload-controller.mjs';
import {UploadRecoveryStore,validateRegionCapture} from './upload-recovery.mjs';
import {MessageIntentRecoveryStore} from './message-intent-recovery.mjs';
import UploadAttachments from './UploadAttachments';
import {messageFiles} from './message-files.mjs';
import {artifactPreviewErrorMessage,fetchVerifiedArtifactPreviewBytes} from './artifact-preview-bytes.mjs';
import {formatDocumentPreviewContent,isDocumentPreviewMediaType} from './document-preview-content.mjs';
import InteractionCard from './InteractionCard';
import InteractionHistory from './InteractionHistory';
import ConversationGoal from './ConversationGoal';
import VoiceInput from './VoiceInput';
import SkillCatalogPanel from './SkillCatalogPanel';
import NativeCommandQueries from './NativeCommandQueries';
import NativeMemberDetails from './NativeMemberDetails';
import NativeMemberHistory from './NativeMemberHistory';
import type {NativeMemberTarget} from './native-member-execution';
import {catalogMountForRun,skillGestureDraft} from './skill-catalog-mount.js';
import CompactionActivities from './CompactionActivities';
import ActivityTimeline from './ActivityTimeline';
import ConversationArtifacts from './ConversationArtifacts';
import ActivityArtifactDetails from './ActivityArtifactDetails';
import ActivityHistory from './ActivityHistory';
import ConversationTerminals from './ConversationTerminals';
import type {ActivityReveal,ActivityArtifactTarget} from './activity-presentation';
import ConversationDisplayBoundary from './ConversationDisplayBoundary';
import RunDiagnostics from './RunDiagnostics';
import {RunCancelWriter} from './run-cancel.mjs';
import {ConversationModeWriter,conversationModeSupport} from './conversation-mode.mjs';
import {modelRoutingStatus,modelSelectionPreservingFallbacks} from './model-routing-status.mjs';
import {ConversationForkWriter,conversationForkRetrySource} from './conversation-fork-controller.mjs';
import {ConversationForkAction} from './conversation-fork-action.mjs';
import PromptComposer from './PromptComposer';
import MessageThinking from './MessageThinking';
import {useLayoutDisplayPreferences,useMessageDisplayPreferences} from './useToolDisplayPreference';
import {useScrollFollow} from './vendor/pilotdeck-use-scroll-follow';
import ConversationHistorySearch from './ConversationHistorySearch';
import {AssistantReplyQuoteAction,AssistantReplyQuotes,replyQuoteMessage,type AssistantReplyQuote} from './AssistantReplyQuote';
import {appendVoiceText} from './voice-draft-controller.mjs';
import {goalPrompt,latestGoalRun} from './goal-controller.mjs';
import type {Artifact,Run,Capabilities,Preview,Conversation,ModelSelection,Message,Activity} from './types';
const active=(run:Run)=>['queued','starting','running','waiting_user','waiting_approval','cancelling'].includes(run.status);
type ConversationProps={ordinary?:boolean;id:string;onClose:()=>void;onReload?:(conversationId:string)=>boolean;onTaskSource?:(source:TaskSourceSelection)=>void;onForkConversation?:(conversationId:string,receipt:unknown)=>void};
export default function RoleConversation(props:ConversationProps){
 return <ConversationContent key={`${taskDraftScope()}:${props.id}:${Boolean(props.ordinary)}`} {...props}/>;
}
type NativeMemberActionState='submitting'|'pending'|'unknown'|'accepted'|'superseded'|'resolved';
type NativeMemberAction={runId:string;requestId:string;operation:'interrupt'|'wake';member:NativeMember;state:NativeMemberActionState};
function NativeMemberControls({run}:{run:Run}){
 const language=useApplicationLanguage(),t=useApplicationText(),displayError=(value:string)=>conversationUiError(value,language);
 const [roster,setRoster]=useState<NativeMemberRoster>(),[selected,setSelected]=useState(''),[text,setText]=useState(''),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[restoring,setRestoring]=useState(true),[storageBlocked,setStorageBlocked]=useState(false),[error,setError]=useState(''),[actionStates,setActionStates]=useState<Record<string,NativeMemberAction>>({});
 const restoreStarted=useRef(false),actionStatesRef=useRef(actionStates);actionStatesRef.current=actionStates;
 const updateAction=useCallback((action:NativeMemberAction)=>setActionStates(current=>({...current,[action.member.child_session_ref]:action})),[]);
 const pending=useCallback((action:NativeMemberAction,state:NativeMemberPendingAction['state']):NativeMemberPendingAction=>({run_id:action.runId,child_session_ref:action.member.child_session_ref,request_id:action.requestId,operation:action.operation,state}),[]);
 const persist=useCallback((action:NativeMemberAction,state:NativeMemberPendingAction['state'])=>writeNativeMemberPendingAction(pending(action,state)),[pending]);
 const reconcileAction=useCallback(async(action:NativeMemberAction,observedRoster?:NativeMemberRoster)=>{
  try{
   if(action.operation==='interrupt'){
    if(observedRoster&&isNativeMemberObservedStopped(observedRoster,action.member.child_session_ref)){
     await clearNativeMemberPendingAction(action.runId,action.member.child_session_ref,action.requestId);updateAction({...action,state:'resolved'});return;
    }
    const receipt=await readNativeMemberInterruptReceipt(action.runId,action.member.child_session_ref,action.requestId);
    if(receipt.request_id!==action.requestId)throw new Error('native_member_receipt_identity_mismatch');
    if(receipt.status==='accepted'){await clearNativeMemberPendingAction(action.runId,action.member.child_session_ref,action.requestId);updateAction({...action,state:'accepted'});}
    else{await persist(action,'unknown');updateAction({...action,state:'unknown'});}
   }else{
    const receipt=await readNativeMemberWakeReceipt(action.runId,action.member.child_session_ref,action.requestId);
    if(receipt.request_id!==action.requestId)throw new Error('native_member_receipt_identity_mismatch');
    if(receipt.status==='pending'||receipt.status==='unknown')await persist(action,receipt.status);else await clearNativeMemberPendingAction(action.runId,action.member.child_session_ref,action.requestId);
    updateAction({...action,state:receipt.status});
   }
  }catch(reason){
   const unknown={...action,state:'unknown' as const};let journalError:unknown;try{await persist(unknown,'unknown');}catch(storageError){setStorageBlocked(true);journalError=storageError;}
   updateAction(unknown);setError(journalError instanceof Error?journalError.message:reason instanceof Error?reason.message:'原成员请求结果尚未确认');
  }
 },[persist,updateAction]);
 const resolveObservedInterrupt=useCallback(async(value:NativeMemberRoster)=>{
  for(const action of Object.values(actionStatesRef.current))if(action.operation==='interrupt'&&action.state==='unknown'&&isNativeMemberObservedStopped(value,action.member.child_session_ref)){
   try{await clearNativeMemberPendingAction(action.runId,action.member.child_session_ref,action.requestId);updateAction({...action,state:'resolved'});setError('');}
   catch(reason){setStorageBlocked(true);setError(reason instanceof Error?reason.message:'无法清除已停止成员的请求记录');}
  }
 },[updateAction]);
 const refresh=useCallback(async(signal?:AbortSignal)=>{setLoading(true);setError('');try{const value=await listNativeMembers(run.run_id,signal);setRoster(value);setSelected(current=>value.members.some(member=>member.child_session_ref===current)?current:value.members[0]?.child_session_ref??'');await resolveObservedInterrupt(value);}catch(reason){if(!signal?.aborted){setRoster(undefined);setSelected('');setError(reason instanceof Error?reason.message:'无法读取成员列表');}}finally{if(!signal?.aborted)setLoading(false);}},[run.run_id,resolveObservedInterrupt]);
 useEffect(()=>{const abort=new AbortController();void refresh(abort.signal);return()=>abort.abort();},[refresh]);
 const inspectAction=useCallback(async(action:NativeMemberAction)=>{if(busy)return;setBusy(true);setError('');try{await reconcileAction(action,roster);}finally{setBusy(false);}},[busy,reconcileAction,roster]);
 useEffect(()=>{
  if(!roster||restoreStarted.current)return;restoreStarted.current=true;
  let saved:NativeMemberPendingAction[];
  try{saved=readNativeMemberPendingActions(run.run_id);}catch(reason){setStorageBlocked(true);setError(reason instanceof Error?reason.message:'无法恢复原成员请求状态');setRestoring(false);return;}
  if(!saved.length){setRestoring(false);return;}
  const restored=saved.map(item=>{const listed=roster.members.find(value=>value.child_session_ref===item.child_session_ref),member=listed??{child_session_ref:item.child_session_ref,name:item.child_session_ref,role:'teammate' as const,status:'unknown'};return {runId:item.run_id,requestId:item.request_id,operation:item.operation,member,state:item.operation==='interrupt'||item.state==='submitting'?'unknown' as const:item.state};});
  setActionStates(current=>({...current,...Object.fromEntries(restored.map(action=>[action.member.child_session_ref,action]))}));setSelected(current=>roster.members.some(member=>member.child_session_ref===current)?current:restored[0]?.member.child_session_ref??'');setBusy(true);
  void Promise.all(restored.map(action=>reconcileAction(action,roster))).finally(()=>{setBusy(false);setRestoring(false);});
 },[roster,run.run_id,reconcileAction]);
 const member=roster?.members.find(value=>value.child_session_ref===selected),actionState=actionStates[selected],sameMemberLocked=Boolean(actionState&&(['submitting','pending'].includes(actionState.state)||actionState.state==='unknown')),locked=restoring||storageBlocked;
 const submit=async(operation:'interrupt'|'wake')=>{
  if(!member||busy||locked||operation==='interrupt'&&member.status!=='running'||operation==='wake'&&(!text.trim()||new TextEncoder().encode(text).byteLength>32768))return;
  const next:NativeMemberAction={runId:run.run_id,requestId:crypto.randomUUID(),operation,member,state:'submitting'};
  updateAction(next);setBusy(true);setError('');
  try{
   if(operation==='interrupt'){
    const receipt=await dispatchNativeMemberAction(pending(next,'submitting'),()=>interruptNativeMember(run.run_id,member.child_session_ref,run.version,next.requestId));
    if(receipt.status==='unknown')await persist(next,'unknown');else await clearNativeMemberPendingAction(run.run_id,member.child_session_ref,next.requestId);
    updateAction({...next,state:receipt.status});
   }else{
    await dispatchNativeMemberAction(pending(next,'submitting'),()=>continueNativeMember(run.run_id,member.child_session_ref,run.version,next.requestId,text));
    await persist(next,'pending');updateAction({...next,state:'pending'});
   }
  }catch(reason){
   if(reason instanceof ApiError&&reason.status>=400&&reason.status<500){
    try{await clearNativeMemberPendingAction(run.run_id,next.member.child_session_ref,next.requestId);setActionStates(current=>{const nextStates={...current};delete nextStates[next.member.child_session_ref];return nextStates;});setRoster(undefined);setSelected('');setError(reason.message);}
    catch(storageError){setStorageBlocked(true);updateAction({...next,state:'unknown'});setError(storageError instanceof Error?storageError.message:'无法清除原成员请求状态');}
   }else{
    const unknown={...next,state:'unknown' as const};let journalError:unknown;try{await persist(unknown,'unknown');}catch(storageError){setStorageBlocked(true);journalError=storageError;}
    updateAction(unknown);setError(journalError instanceof Error?journalError.message:reason instanceof Error?reason.message:'原请求结果尚未确认');
   }
  }
  finally{setBusy(false);}
 };
 const actionMessage=(action:NativeMemberAction)=>action.state==='submitting'?t('正在提交原成员请求。','Submitting the original member request.'):action.state==='pending'?t('继续内容已排队；尚未确认原成员接收。','The continuation is queued; receipt by the original member is unconfirmed.'):action.state==='unknown'?t(`${action.operation==='interrupt'?'中断':'继续'}结果未知或未确认；系统不会自动重发。`,`${action.operation==='interrupt'?'Interrupt':'Continue'} result is unknown or unconfirmed. The system will not resend automatically.`):action.state==='accepted'?action.operation==='interrupt'?t('中断信号已确认；这不代表成员已停止。刷新成员列表可核对当前状态。','The interrupt signal is acknowledged; this does not mean the member has stopped. Refresh members to check the current state.'):t('继续内容已由原成员接收；尚未证明成员已恢复或任务完成。','The original member has received the continuation; this does not prove that it has resumed or completed the task.'):action.state==='superseded'?t('原成员请求已被替代；系统不会自动重发。','The original member request has been superseded. The system will not resend automatically.'):action.state==='resolved'?t('成员当前空闲；原中断回执仍未知，系统没有重发。','The member is currently idle; the original interrupt receipt remains unknown and the system has not resent it.'):'';
 const status=(value:string)=>value==='running'?t('运行中','Running'):value==='inactive'?t('空闲','Idle'):value==='provisioning'?t('准备中','Provisioning'):value==='failed'?t('失败','Failed'):value;
 return <section lang={language} className="jot-native-member-controls" aria-label={t("原生协作成员","Native Collaboration Members")}><h3 lang={language}>{t("原生协作成员","Native Collaboration Members")}</h3><p lang={language}>{t("以下操作只作用于所选原成员，不更改父目标、授权或预算；中断回执不代表成员已经停止。","These actions affect only the selected original member, without changing the parent goal, authorization or budget. An interrupt receipt does not mean the member has stopped.")}</p>
  <button lang={language} type="button" disabled={loading||busy} onClick={()=>void refresh()}>{t("刷新成员列表","Refresh Members")}</button>
  {loading&&!roster&&<p lang={language} role="status">{t("正在读取成员列表…","Loading members…")}</p>}
  {error&&<p lang={language} role="alert">{displayError(error)}</p>}
  {roster&&<><ul>{roster.members.map(value=><li key={value.child_session_ref}>{value.name} · {status(value.status)} · <code>{value.child_session_ref}</code></li>)}</ul>
   {roster.members.length===0?<p lang={language} role="status">{t("当前任务没有可控制的原生成员。","This task has no controllable native members.")}</p>:<><label lang={language} htmlFor={`native-member-${run.run_id}`}>{t("成员","Member")}</label><select id={`native-member-${run.run_id}`} value={selected} disabled={loading||busy||locked} onChange={event=>{setSelected(event.currentTarget.value);setError('');}}>{roster.members.map(value=><option key={value.child_session_ref} value={value.child_session_ref}>{value.name} · {status(value.status)} · {value.child_session_ref}</option>)}</select>
    {member&&<ConversationDisplayBoundary label={t("原成员步骤","Original Member Steps")}><NativeMemberDetails key={member.child_session_ref} rootRunId={run.run_id} childSessionRef={member.child_session_ref}/></ConversationDisplayBoundary>}
    <button lang={language} type="button" disabled={!member||member.status!=='running'||busy||locked||sameMemberLocked} onClick={()=>void submit('interrupt')}>{t("中断选中成员","Interrupt Selected Member")}</button>
    <label lang={language} htmlFor={`native-member-message-${run.run_id}`}>{t("给原成员的继续内容","Continuation for the Original Member")}</label><textarea id={`native-member-message-${run.run_id}`} value={text} maxLength={32768} disabled={!member||busy||locked||sameMemberLocked} onChange={event=>setText(event.currentTarget.value)}/>
    <button lang={language} type="button" disabled={!member||!text.trim()||new TextEncoder().encode(text).byteLength>32768||busy||locked||sameMemberLocked} onClick={()=>void submit('wake')}>{t("明确继续此成员","Explicitly Continue This Member")}</button>
   </>}
  </>}
  {Object.values(actionStates).map(action=><p lang={language} role="status" key={action.requestId}>{action.member.name} · {actionMessage(action)} {action.operation==='interrupt'&&action.state==='unknown'&&<><button lang={language} type="button" disabled={busy} onClick={()=>void inspectAction(action)}>{t("检查原中断回执","Check Original Interrupt Receipt")}</button><button lang={language} type="button" disabled={loading||busy} onClick={()=>void refresh()}>{t("检查成员状态","Check Member State")}</button></>} {action.operation==='wake'&&['pending','unknown'].includes(action.state)&&<button lang={language} type="button" disabled={busy} onClick={()=>void inspectAction(action)}>{t("检查原请求状态","Check Original Request State")}</button>}</p>)}
 </section>;
}
function ConversationMessageBody({message,onOpenReference}:{message:Message;onOpenReference:(value:FileSourceReference)=>void}){
 return <div data-chat-search-message={message.message_id} {...(message.role==='assistant'?{'data-assistant-quote-source':'','data-assistant-quote-message-id':message.message_id}:{})}>
  {message.blocks.filter(block=>block.kind==='text').map(block=><TwemojiMarkdown key={block.block_id}>{block.text}</TwemojiMarkdown>)}
  <MessageFileReferences message={message} onOpen={onOpenReference}/>
 </div>;
}
type ComposerDraft={text:string;replyQuotes:AssistantReplyQuote[];textReferences:FileSelectionReference[];goalMode:boolean};
function ConversationContent({id,onClose,onReload,onTaskSource,onForkConversation,ordinary=false}:ConversationProps){
 const language=useApplicationLanguage(),t=useApplicationText(),displayError=(value:string)=>conversationUiError(value,language);
 const {value:displayPreferences}=useMessageDisplayPreferences(),{value:layoutPreferences}=useLayoutDisplayPreferences();
 const [returnVersion,setReturnVersion]=useState(0),returnToLatest=useRef(false),initialPosition=useRef(true);
 const [,render]=useState(0),[draft,setDraft]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[expanded,setExpanded]=useState<Record<string,boolean>>({}),[maxBytes,setMaxBytes]=useState<number>(),[preview,setPreview]=useState<{name:string;text?:string;url?:string;unsupported?:boolean;truncated?:boolean;loading?:boolean}>(),[forkStates,setForkStates]=useState<Record<string,{state:string;retryable:boolean;error:string}>>({});
 const [voice,setVoice]=useState<Capabilities['voice']>(),[voiceBusy,setVoiceBusy]=useState(false),draftRef=useRef(draft),conversationRegion=useRef<HTMLElement>(null),previewRequest=useRef<AbortController|undefined>(undefined);
 const [replyQuotes,setReplyQuotes]=useState<AssistantReplyQuote[]>([]);
 const fileOwner=taskDraftScope();
 const [fileReferenceState,setFileReferenceState]=useState<{owner:string;conversationId:string;values:FileReference[]}>({owner:fileOwner,conversationId:id,values:[]});
 const fileReferences=fileReferenceState.owner===fileOwner&&fileReferenceState.conversationId===id?fileReferenceState.values:[];
 const setFileReferences=(values:FileReference[])=>{if(taskDraftScope()===fileOwner)setFileReferenceState({owner:fileOwner,conversationId:id,values});};
 const [referenceSource,setReferenceSource]=useState<{owner:string;conversationId:string;value:FileSourceReference;requestId:string}>();
 const referenceReturnFocus=useRef<HTMLElement|null>(null);
 const openReferenceSource=(value:FileSourceReference)=>{
  if(value.owner!==fileOwner||taskDraftScope()!==fileOwner){setError('原文件引用所属账户已变化');return;}
  referenceReturnFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
  setReferenceSource({owner:fileOwner,conversationId:id,value:structuredClone(value),requestId:crypto.randomUUID()});
 };
 const closeReferenceSource=()=>{
  setReferenceSource(undefined);
  if(taskDraftScope()===fileOwner&&referenceReturnFocus.current?.isConnected)referenceReturnFocus.current.focus();
 };
 const quoteCount=replyQuotes.length+fileReferences.length;
 const [olderMessages,setOlderMessages]=useState<Message[]>([]),[historySelection,setHistorySelection]=useState('');
 const [historicalActivities,setHistoricalActivities]=useState<Activity[]>([]),[activityHistoryRequest,setActivityHistoryRequest]=useState(0);
 const retainActivityHistory=useCallback((activities:Activity[])=>setHistoricalActivities(activities),[]);
 const loadActivityHistory=useCallback(()=>setActivityHistoryRequest(version=>version+1),[]);
 const [activityReveal,setActivityReveal]=useState<ActivityReveal>();
 const [selectedNativeMember,setSelectedNativeMember]=useState<NativeMemberTarget>();
 const [messageArtifact,setMessageArtifact]=useState<{owner:string;target:ActivityArtifactTarget}>();
 const nativeMemberPanel=useRef<HTMLElement>(null);
 useEffect(()=>{if(selectedNativeMember)nativeMemberPanel.current?.focus();},[selectedNativeMember]);
 const revealActivity=useCallback((request:ActivityReveal)=>setActivityReveal(prior=>prior?.key===request.key&&prior.activityId===request.activityId?prior:request),[]);
 const revealHistoryMessage=useCallback((messageId:string)=>setHistorySelection(messageId),[]);
 const retainHistory=useCallback((messages:Message[])=>setOlderMessages(messages),[]);
 const focusConversationAfterStop=useCallback(()=>conversationRegion.current?.focus(),[]);
 const modelMutation=useMutationReceipt();
 const modeWriter=useMemo(()=>new ConversationModeWriter(request,()=>render(n=>n+1)),[id]);
 const forkWriter=useMemo(()=>{let storage:Storage|null=null;try{storage=globalThis.sessionStorage??null;}catch{}return new ConversationForkWriter(request,{storage,sourceConversationId:id});},[id]);
 const cancelWriter=useMemo(()=>new RunCancelWriter(request,()=>render(n=>n+1)),[id]);
 const [modeCaps,setModeCaps]=useState<Capabilities>();
 const rememberConversation=useCallback((value:Conversation)=>setConversation(prior=>prior&&prior.conversation_id===value.conversation_id&&prior.version>value.version?prior:value),[]);
 const editDraft=useCallback((value:string)=>{if(cancelWriter.pending)return;draftRef.current=value;setDraft(value);},[cancelWriter]);
 const appendTranscript=useCallback((text:string)=>editDraft(appendVoiceText(draftRef.current,text)),[editDraft]);
 const [models,setModels]=useState<Capabilities['models']>([]),[conversation,setConversation]=useState<Conversation>(),fileInput=useRef<HTMLInputElement>(null),folderInput=useRef<HTMLInputElement>(null);
 const controller=useMemo(()=>new RoleChatController(id,{request,follow,snapshot:async(conversationId:string,signal?:AbortSignal)=>{const value=await snapshot(conversationId,signal);if(!signal?.aborted)rememberConversation(value.conversation);return value;}},()=>render(n=>n+1),{recoveryRequired:true,currentScope:taskDraftScope}),[id,rememberConversation,fileOwner]);
 const [draftRecoveryVersion,setDraftRecoveryVersion]=useState(-1),[draftRecoveryController,setDraftRecoveryController]=useState<RoleChatController>();
 const [draftBackupState,setDraftBackupState]=useState<{owner:string;conversationId:string;value:ComposerDraft}>();
 const draftBackup=draftBackupState?.owner===fileOwner&&draftBackupState.conversationId===id?draftBackupState.value:undefined;
 const setDraftBackup=(value:ComposerDraft|undefined)=>setDraftBackupState(value?{owner:fileOwner,conversationId:id,value}:undefined);
 const messageLocked=controller.pendingMessage||controller.recoveryBlocked||!!draftBackup;
 const [messageRecoveryRevision,setMessageRecoveryRevision]=useState(0),[messageRecoveryError,setMessageRecoveryError]=useState('');
 const [goalMode,setGoalMode]=useState(false),[goalPending,setGoalPending]=useState(false);
 const [terminalInputPending,setTerminalInputPending]=useState(false);
 const reloadGate=useRef<{owner:string;draft:string;uploads:string;unsafe:boolean}>();
 const reloadPermit=useRef<{owner:string;draft:string;uploads:string}>(),reloadInFlight=useRef(false);
 const [recoveryRunId,setRecoveryRunId]=useState('');
 useEffect(()=>{setGoalMode(false);},[id,ordinary]);
 const composerDraft:ComposerDraft={text:draft,replyQuotes,textReferences:fileReferences.filter((value):value is FileSelectionReference=>!isFileRegion(value)),goalMode};
 const draftSnapshot=JSON.stringify(composerDraft);
 const applyComposerDraft=(value:ComposerDraft)=>{
  draftRef.current=value.text;setDraft(value.text);setReplyQuotes(value.replyQuotes);setGoalMode(value.goalMode);
  setFileReferenceState(previous=>({owner:fileOwner,conversationId:id,values:[...value.textReferences,...(previous.owner===fileOwner&&previous.conversationId===id?previous.values.filter(isFileRegion):[])]}));
  setDraftRecoveryController(controller);setDraftRecoveryVersion(controller.draftGeneration);
 };
 useEffect(()=>{
  if(draftRecoveryController!==controller||draftRecoveryVersion!==controller.draftGeneration||controller.recoveryBlocked||controller.pendingMessage||controller.sending||draftBackup)return;
  void controller.saveDraft(JSON.parse(draftSnapshot)).catch(reason=>setError(reason instanceof Error?reason.message:'草稿暂时无法保存'));
 },[controller,draftSnapshot,draftRecoveryController,draftRecoveryVersion,controller.draftGeneration,controller.recoveryBlocked,controller.pendingMessage,draftBackup]);

 const uploads=useMemo(()=>new UploadController(id,{request},()=>render(n=>n+1),{recoveryRequired:true,currentScope:taskDraftScope}),[id]);
 const [uploadRecoveryRevision,setUploadRecoveryRevision]=useState(0),[uploadRecoveryError,setUploadRecoveryError]=useState('');
 useEffect(()=>{
  let mounted=true,store:MessageIntentRecoveryStore|undefined;const abort=new AbortController();
  const local=draftRecoveryController===controller&&draftRecoveryVersion===controller.draftGeneration&&(controller.draftDirty||draftSnapshot!==JSON.stringify(controller.draft))?JSON.parse(draftSnapshot) as ComposerDraft:undefined;
  controller.recoveryReady=false;controller.changed();
  void request('/capabilities','GET',undefined,undefined,abort.signal).then(async()=>{
   if(!mounted)return;
   store=await MessageIntentRecoveryStore.open(window.indexedDB,taskDraftScope(),id);
   if(!mounted){store.close();return;}
   await controller.configureRecovery(store);
   if(mounted){
    if(local&&!draftBackup&&JSON.stringify(local)!==JSON.stringify(controller.draft))setDraftBackup(local);
    applyComposerDraft(controller.draft);setMessageRecoveryError('');
   }
  }).catch(reason=>{store?.close();if(mounted){controller.recoveryReady=false;setMessageRecoveryError(reason instanceof Error?reason.message:'message_recovery_unavailable');controller.changed();}});
  return()=>{mounted=false;abort.abort();controller.disposeRecovery();};
 },[controller,id,messageRecoveryRevision]);
 useEffect(()=>{let mounted=true;controller.onChange=()=>{if(mounted)render(n=>n+1);};void controller.start();return()=>{mounted=false;controller.stop();};},[controller]);
 useEffect(()=>{
  let mounted=true,store:UploadRecoveryStore|undefined;const abort=new AbortController();
  uploads.disposed=false;uploads.recoveryReady=false;uploads.onChange=()=>{if(mounted)render(n=>n+1);};uploads.onChange();
  void request<Capabilities>('/capabilities','GET',undefined,undefined,abort.signal).then(async value=>{
   if(!mounted)return;
   setMaxBytes(value.limits.max_upload_bytes);setVoice(value.voice);setModels(value.models??[]);setModeCaps(value);uploads.statusSupported=value.upload_recovery?.protocol===1&&value.upload_recovery.status===true;
   store=await UploadRecoveryStore.open(window.indexedDB,taskDraftScope(),id);
   if(!mounted){store.close();return;}
   await uploads.configureRecovery(store);
   if(mounted)setUploadRecoveryError('');
  }).catch(reason=>{store?.close();if(mounted){uploads.recoveryReady=false;setUploadRecoveryError(reason instanceof Error?reason.message:'upload_recovery_unavailable');render(n=>n+1);}});
  return()=>{mounted=false;abort.abort();uploads.dispose();};
 },[uploads,id,uploadRecoveryRevision]);
 const generatedProjection=JSON.stringify(uploads.entries.filter((entry:any)=>entry.generated).map((entry:any)=>[entry.id,entry.generated.delivery,entry.status,entry.generatedCommitted]));
 useEffect(()=>{
  if(uploads.blocked||!fileOwner||taskDraftScope()!==fileOwner||uploads.store?.scope!==fileOwner)return;
  const recovered=uploads.entries.filter((entry:any)=>entry.generated&&entry.generatedCommitted&&entry.generated.delivery==='draft').map((entry:any)=>({...entry.generated.capture,uploadEntryId:entry.id}) as FileReference);
  setFileReferenceState(previous=>{
   const existing=previous.owner===fileOwner&&previous.conversationId===id?previous.values:[];
   const retained=existing.filter(value=>!isFileRegion(value)||uploads.entries.some((entry:any)=>entry.id===value.uploadEntryId)&&!recovered.some((item:FileReference)=>isFileRegion(item)&&item.uploadEntryId===value.uploadEntryId));
   return {owner:fileOwner,conversationId:id,values:[...retained,...recovered]};
  });
 },[generatedProjection,fileOwner,id,uploads.recoveryReady,uploads.recoveryError]);
 useEffect(()=>{folderInput.current?.setAttribute('webkitdirectory','');},[]);
 useEffect(()=>()=>{if(preview?.url)URL.revokeObjectURL(preview.url);},[preview]);
 useEffect(()=>()=>previewRequest.current?.abort(),[]);
 useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{const permit=reloadPermit.current,gate=reloadGate.current;reloadPermit.current=undefined;if(permit&&gate&&!gate.unsafe&&gate.owner===taskDraftScope()&&permit.owner===gate.owner&&permit.draft===gate.draft&&permit.uploads===gate.uploads&&!controller.draftDirty&&!controller.draftSavePromise&&!uploads.blocked&&!uploads.recoveryBusy&&!uploads.unresolved)return;if(draft.trim()||draftBackup||controller.draftDirty||controller.draftSavePromise||quoteCount||uploads.entries.length||controller.pendingMessage||goalPending||terminalInputPending||voiceBusy||modeWriter.pending||cancelWriter.pending){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[uploads,controller,draft,draftBackup,goalPending,terminalInputPending,voiceBusy,modeWriter.pending,cancelWriter.pending,quoteCount]);
 const state=controller.state,run=state?(Object.values(state.runs) as Run[]).find(active):undefined;
 const activityValues=useMemo(()=>{
  const merged=new Map(historicalActivities.map(activity=>[activity.activity_id,activity]));
  for(const activity of Object.values(state?.activities??{}) as Activity[])merged.set(activity.activity_id,activity);
  return [...merged.values()];
 },[historicalActivities,state?.activities]);
 const displayedMessages=useMemo(()=>{
  const current:Record<string,Message>=state?.messages??{};
  const currentIds=new Set(Object.keys(current));
  const messages=[...olderMessages.filter(message=>!currentIds.has(message.message_id)),...Object.values(current)];
  const finalRuns=new Set(messages.filter(message=>message.role==='assistant'&&message.status==='complete'&&!message.message_id.startsWith('stream-')).map(message=>message.run_id));
  return messages.filter(message=>!(message.role==='assistant'&&message.message_id.startsWith('stream-')&&finalRuns.has(message.run_id)));
 },[olderMessages,state?.messages]);
 const selectedHistoryIndex=displayedMessages.findIndex(message=>message.message_id===historySelection);
 const historyStart=selectedHistoryIndex<0?Math.max(0,displayedMessages.length-200):Math.max(0,Math.min(selectedHistoryIndex-50,displayedMessages.length-200));
 const renderedMessages=useMemo(()=>displayedMessages.slice(historyStart,historyStart+200),[displayedMessages,historyStart]);
 const stateReady=Boolean(state);
 const scrollFollow=useScrollFollow({containerRef:conversationRegion,windowViewport:true,enabled:stateReady&&layoutPreferences.autoScrollToBottom,
  scopeKey:JSON.stringify([fileOwner,id]),contentSelector:'[data-conversation-follow-content]',canFollow:()=>taskDraftScope()===fileOwner&&!historySelection
   &&!conversationRegion.current?.querySelector('[role="search"], [role="dialog"], [role="alertdialog"]')&&(window.getSelection()?.isCollapsed??true)});
 useLayoutEffect(()=>{
  if(!initialPosition.current||!stateReady)return;
  initialPosition.current=false;
  if(renderedMessages.length&&!historySelection&&!scrollFollow.getIsPaused())scrollFollow.scheduleInitialPosition();
 },[stateReady,renderedMessages.length,historySelection,scrollFollow.getIsPaused,scrollFollow.scheduleInitialPosition]);
 useEffect(()=>{if(historySelection)scrollFollow.pause();},[historySelection,scrollFollow.pause]);
 useEffect(()=>{
  const pauseSelection=()=>{const selection=window.getSelection();if(!scrollFollow.getIsPaused()&&selection&&!selection.isCollapsed&&conversationRegion.current?.contains(selection.anchorNode))scrollFollow.pause();};
  document.addEventListener('selectionchange',pauseSelection);return()=>document.removeEventListener('selectionchange',pauseSelection);
 },[scrollFollow.pause,scrollFollow.getIsPaused]);
 useLayoutEffect(()=>{
  if(!returnToLatest.current||historySelection)return;
  returnToLatest.current=false;scrollFollow.scrollToBottom();scrollFollow.scheduleInitialPosition();
 },[returnVersion,historySelection,renderedMessages,scrollFollow.scrollToBottom,scrollFollow.scheduleInitialPosition]);
 const requestLatest=()=>{returnToLatest.current=true;setHistorySelection('');setReturnVersion(value=>value+1);};
 const inspectDisplay=(target:EventTarget)=>{
  if(target instanceof Element&&!target.closest('.jot-prompt-composer')&&target.closest('button,a,summary,select,input,textarea,[contenteditable="true"]'))scrollFollow.pause();
 };
 const conversationRuns=state?(Object.values(state.runs) as Run[]).filter(value=>value.conversation_id===id)
  .sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.run_id.localeCompare(a.run_id)):[];
 const diagnosticRun=conversationRuns[0];
  const catalogMount=catalogMountForRun(run?.run_id,taskDraftScope(),ordinary);
  const recoveryRuns=conversationRuns.filter(value=>value.run_id!==catalogMount?.runId);
  const recoveryRun=recoveryRuns.find(value=>value.run_id===recoveryRunId)??recoveryRuns[0];
  const queryRecoveryMount=catalogMountForRun(recoveryRun?.run_id,taskDraftScope(),ordinary);
 const chatMode=ordinary&&conversation?.mode==='chat';
 const routingStatus=modelRoutingStatus(conversation?.model,models,language);
 let modes={aware:false,default:'work',chatReady:false},modeCapabilityError='';
 try{modes=conversationModeSupport(modeCaps);}catch(e){modeCapabilityError=e instanceof Error?e.message:'对话模式能力尚未确认';}
 const chatUnavailable=chatMode&&!!modeCaps&&!modes.chatReady;
 const canToggle=ordinary&&!!conversation&&controller.connection==='connected'&&!busy&&!run&&!messageLocked&&!uploads.entries.length&&!voiceBusy&&!goalPending&&!modelMutation.pending&&!modeWriter.pending&&!cancelWriter.pending&&modes.aware&&(chatMode||modes.chatReady);
 const action=async(fn:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError('');try{await fn();}catch(e){if(!(e instanceof DOMException&&e.name==='AbortError'))setError(artifactPreviewErrorMessage(e));if((e as {status?:number}).status===409&&!controller.pendingMessage&&!controller.recoveryBlocked)await controller.refresh().catch(()=>{});}finally{setBusy(false);}};
 const send=()=>{
  if(controller.recoveryBlocked||draftBackup&&!controller.pendingMessage||voiceBusy||modeWriter.pending||cancelWriter.pending||chatUnavailable&&!controller.pendingMessage)return;
  if(!controller.pendingMessage&&fileReferences.length&&taskDraftScope()!==fileOwner){setError('文件引用所属账户已变化，请重新打开会话');return;}
  void action(async()=>{
   const retry=controller.pendingMessage;
   const preview=retry?'':replyQuoteMessage(fileReferenceMessage(draft,fileReferences,imageArtifact),replyQuotes);
   const structured=!retry&&fileReferences.length>0&&modeCaps?.reference_snapshots?.protocol===1&&modeCaps.reference_snapshots.request===true
    &&fileReferences.every(value=>(value.reference.renderer.id==='pdf'||modeCaps?.reference_snapshots?.renderers?.some(renderer=>renderer===value.reference.renderer.id))
     &&(!isFileRegion(value)||value.reference.renderer.id==='pdf'||modeCaps?.reference_snapshots?.region_renderers?.some(renderer=>renderer===value.reference.renderer.id))
     &&(!isFileCells(value)||value.cell_view!==2||modeCaps?.reference_snapshots?.xlsx_cell_views?.includes(2))
     &&(!('text_view' in value)||value.text_view!==2||modeCaps?.reference_snapshots?.docx_text_views?.includes(2))
     &&(!value.print_view||modeCaps?.reference_snapshots?.office_print_views?.includes(1))
     &&(!value.native_source||modeCaps?.reference_snapshots?.native_file_sources?.includes(1)));
   if(!retry&&fileReferences.some(value=>isFileRegion(value)&&['docx','pptx','xlsx'].includes(value.reference.renderer.id))&&!structured)throw Error('服务尚未确认整组引用快照及Office区域PNG输入能力，请刷新能力后重试。');
   if(!retry&&fileReferences.some(value=>isFileCells(value)&&value.cell_view===2)&&!structured)throw Error('服务尚未确认整组引用快照及原生单元格视图，请刷新能力后重试。');
   if(!retry&&fileReferences.some(value=>!!value.native_source)&&!structured)throw Error('服务尚未确认原生来源引用快照，请刷新能力后重试。');
   if(!retry&&fileReferences.some(value=>!!value.print_view)&&!structured)throw Error('服务尚未确认整组转换PDF引用及来源证明，请刷新能力后重试。');
   const message=structured?replyQuoteMessage(draft.trim()||'请结合以下原文件引用继续。',replyQuotes):preview;
   const referenceSnapshots=structured?{protocol:1,items:fileReferenceSnapshots(fileReferences,imageArtifact)}:undefined;
   if(!retry&&quoteCount&&goalPrompt(preview,ordinary&&!chatMode&&!run&&goalMode).length>100000)throw Error('引用与消息过长，请减少引用或缩短消息后发送');
   const references=retry?controller.pendingAttachments:uploads.references();
   if(!retry){await controller.saveDraft(JSON.parse(draftSnapshot));await uploads.markGeneratedSending(fileReferences.filter(isFileRegion).map(value=>value.uploadEntryId));}
   const receipt=await controller.send(message,references,{referenceSnapshots,goalMode:ordinary&&!chatMode&&!run&&goalMode,originalTask:ordinary,steeringConfigured:modeCaps?.conversation_commands?.protocol===1&&modeCaps.conversation_commands.ordinary_steer?.configured===true,attachmentSteeringConfigured:modeCaps?.conversation_commands?.protocol===1&&modeCaps.conversation_commands.ordinary_steer?.attachments===true});
   let cleanupError='';
   try{await uploads.clearSent(references,true);await controller.acknowledgeSent();}
   catch{cleanupError='消息已发送，本地发送或附件回执清理尚未保存。请重读回执后重试原消息，核对原会话。';}
   setReplyQuotes([]);setFileReferences([]);editDraft('');setDraftRecoveryVersion(controller.draftGeneration);
   if(cleanupError)setError(cleanupError);else if(receipt.command_id)setError('补充已保留给原任务，正在等待接收');
   await controller.refresh();
  });
 };

 const quoteLocked=!state||busy||goalPending||voiceBusy||modelMutation.pending||modeWriter.pending||cancelWriter.pending||messageLocked||chatUnavailable;
 const regionDisabled=quoteLocked||uploads.blocked||uploads.unresolved||!maxBytes;
 const uploadReloadStamp=()=>JSON.stringify(uploads.entries.map((entry:any)=>[entry.id,entry.status,entry.sha,entry.batchId,entry.generated?.delivery,entry.artifact]));
 const reloadUnsafe=!state||controller.recoveryBlocked||controller.sending||!!draftBackup||goalPending||terminalInputPending||voiceBusy
  ||modelMutation.pending||modeWriter.pending||cancelWriter.pending||controller.pendingMessage||forkWriter.pending
  ||uploads.blocked||uploads.recoveryBusy||uploads.unresolved||!!fileRegionCapture.owner
  ||uploads.entries.some((entry:any)=>!['ready','recovered','cancelled'].includes(entry.status))
  ||Object.values(state?.runs??{}).some(value=>active(value as Run))||Object.values(state?.interactions??{}).some((value:any)=>value.status==='pending');
 reloadGate.current={owner:fileOwner,draft:draftSnapshot,uploads:uploadReloadStamp(),unsafe:!!reloadUnsafe};
 const reloadInterface=()=>{
  if(!onReload||busy||reloadUnsafe||reloadInFlight.current)return;
  const expected=reloadGate.current!;reloadInFlight.current=true;
  void action(async()=>{
   try{
    await uploads.persist();await controller.saveDraft(JSON.parse(expected.draft));
    const current=reloadGate.current;
    if(!current||current.unsafe||taskDraftScope()!==expected.owner||current.owner!==expected.owner||current.draft!==expected.draft
      ||uploadReloadStamp()!==expected.uploads||controller.recoveryBlocked||controller.pendingMessage||controller.draftDirty||controller.draftSavePromise
      ||uploads.blocked||uploads.recoveryBusy||uploads.unresolved||fileRegionCapture.owner||controller.sending||modeWriter.pending||cancelWriter.pending||forkWriter.pending
      ||uploads.entries.some((entry:any)=>!['ready','recovered','cancelled'].includes(entry.status))
      ||Object.values(controller.state?.runs??{}).some(value=>active(value as Run))||Object.values(controller.state?.interactions??{}).some((value:any)=>value.status==='pending'))throw Error('会话内容或操作状态已变化，已保留页面，请核对后重试。');
    reloadPermit.current={owner:expected.owner,draft:expected.draft,uploads:expected.uploads};
    try{if(!onReload(id))reloadPermit.current=undefined;}catch(reason){reloadPermit.current=undefined;throw reason;}
   }finally{reloadInFlight.current=false;}
  });
 };
 const imageArtifact=(entryId:string)=>{const entry=uploads.entries.find((entry:any)=>entry.id===entryId);return entry?.status==='ready'?entry.artifact:undefined;};
 const imageFile=(entryId:string)=>{const file=uploads.entries.find((entry:any)=>entry.id===entryId)?.file;return file instanceof File?file:undefined;};
 const regionsReady=fileReferences.every(value=>!isFileRegion(value)||!!resolveRegionArtifact(value,imageArtifact));
 const addReplyQuote=(quote:AssistantReplyQuote)=>{
  if(quoteLocked||quote.conversationId!==id)return false;
  if(replyQuotes.some(value=>value.messageId===quote.messageId&&value.selectedText===quote.selectedText))return true;
  const next=[...replyQuotes,quote];
  if(goalPrompt(replyQuoteMessage(fileReferenceMessage(draft,fileReferences),next),ordinary&&!chatMode&&!run&&goalMode).length>100000){setError('引用与消息过长，请减少引用或缩短消息');return false;}
  setReplyQuotes(next);
  conversationRegion.current?.querySelector<HTMLTextAreaElement>('.jot-prompt-composer textarea')?.focus();
  return true;
 };
 const addFileReferences=(values:FileSelectionReference[])=>{
  if(!values.length||quoteLocked||taskDraftScope()!==fileOwner)return false;
  try{for(const value of values)validateTextReference(value,id,fileOwner);}catch{return false;}
  const fingerprint=(item:FileSelectionReference)=>{
   const reference=item.reference;
   const location=reference.selectionMode==='cells'?[('cell_view' in item?item.cell_view??1:1),reference.locator,reference.cells,reference.headers,reference.surroundingValues]
    :reference.renderer.id==='pdf'?[reference.selectedText,reference.locator.pageNumbers]:[('text_view' in item?item.text_view:undefined),reference.selectedText,reference.locator];
   return JSON.stringify([item.runId,item.activityId,item.resultSha,item.file.path,item.file.version,item.file.sha256,item.file.size,nativeReferenceIdentity(item.native_source),item.print_view,location]);
  };
  const known=new Set(fileReferences.filter((item):item is FileSelectionReference=>!isFileRegion(item)).map(fingerprint));
  const added:FileSelectionReference[]=[];
  for(const value of values){const key=fingerprint(value);if(!known.has(key)){known.add(key);added.push(value);}}
  if(!added.length)return true;
  const next=[...fileReferences,...added];
  if(goalPrompt(replyQuoteMessage(fileReferenceMessage(draft,next),replyQuotes),ordinary&&!chatMode&&!run&&goalMode).length>100000){setError('引用与消息过长，请减少引用或缩短消息');return false;}
  setFileReferences(next);conversationRegion.current?.querySelector<HTMLTextAreaElement>('.jot-prompt-composer textarea')?.focus();return true;
 };
 const addFileReference=(value:FileSelectionReference)=>addFileReferences([value]);
 const addRegionReference=(value:FileRegionDraft,file:File)=>{
  if(regionDisabled||!maxBytes||taskDraftScope()!==fileOwner||value.owner!==fileOwner||value.conversationId!==id)return Promise.resolve(false);
  const {reference}=value;
  try{validateRegionCapture(value,id,fileOwner);}catch{setError('区域引用或截图信息未能核对，请重新选择。');return Promise.resolve(false);}
  if(file.type!=='image/png'||file.name!==reference.image.name||file.size!==value.imageBytes||file.size<1||file.size>maxBytes){setError('区域引用或截图信息未能核对，请重新选择。');return Promise.resolve(false);}
  if(fileReferences.some(item=>isFileRegion(item)&&item.runId===value.runId&&item.activityId===value.activityId&&item.resultSha===value.resultSha&&item.file.path===value.file.path&&item.file.version===value.file.version&&item.file.sha256===value.file.sha256&&nativeReferenceIdentity(item.native_source)===nativeReferenceIdentity(value.native_source)&&item.reference.image.sha256===reference.image.sha256&&JSON.stringify(item.reference.locator)===JSON.stringify(reference.locator)&&JSON.stringify(item.region_view)===JSON.stringify(value.region_view)&&JSON.stringify(item.print_view)===JSON.stringify(value.print_view)&&item.rotation===value.rotation))return Promise.resolve(true);
  const candidate={...value,uploadEntryId:''};
  if(goalPrompt(replyQuoteMessage(fileReferenceMessage(draft,[...fileReferences,candidate]),replyQuotes),ordinary&&!chatMode&&!run&&goalMode).length>100000){setError('引用与消息过长，请减少引用或缩短消息');return Promise.resolve(false);}
  return new Promise<boolean>(resolve=>{
   void action(async()=>{
    const entry=await uploads.addGenerated(file,maxBytes,value);
    try{await uploads.persist();}
    catch(error){uploads.discardGenerated(entry.id);throw error;}
    uploads.assertRecoveryScope();
    setFileReferences([...fileReferences,{...value,uploadEntryId:entry.id}]);resolve(true);
    await uploads.prepareBatch([entry.id]);await uploadEntry(entry.id);
   }).finally(()=>resolve(false));
  });
 };
 const editFileReferences=(values:FileReference[])=>{
  if(quoteLocked)return;
  const removed=fileReferences.filter(isFileRegion).filter(value=>!values.some(item=>item.reference.id===value.reference.id));
  if(!removed.length){setFileReferences(values);return;}
  void action(async()=>{
   let retained=fileReferences;
   for(const value of removed){
    if(taskDraftScope()!==fileOwner)throw Error('截图所属账户已变化');
    const entry=uploads.entries.find((entry:any)=>entry.id===value.uploadEntryId);
    if(entry){
     if(!['ready','recovered','cancelled'].includes(entry.status)&&!entry.expired){
      if(entry.batch){if(entry.batch.entries.length!==1)throw Error('请在附件区处理此上传批次');await uploads.cancelBatch(entry.batch.batchId||entry.batch.key);}
      else await uploads.cancel(entry.id);
     }
     await uploads.remove(entry.id);
    }
    retained=retained.filter(item=>item.reference.id!==value.reference.id);setFileReferences(retained);
   }
   setFileReferences(values);
  });
 };
 const cancelTask=(retry=false)=>void action(async()=>{
  try{if(retry)await cancelWriter.retry();else if(run){const latest=await request<Run>(`/runs/${encodeURIComponent(run.run_id)}`);if(latest.run_id!==run.run_id||latest.conversation_id!==id)throw Error('停止目标状态尚未确认');if(active(latest)&&latest.status!=='cancelling')await cancelWriter.cancel(latest);}await controller.refresh();}
  catch(e){if(!cancelWriter.pending)await controller.refresh().catch(()=>{});throw e;}
 });
 const uploadEntry=async(entryId:string)=>{await uploads.upload(entryId);await controller.refresh();};
 const cancelUpload=async(entryId:string)=>{setError('');try{await uploads.cancel(entryId);}catch(e){setError(e instanceof Error?e.message:'取消结果未确认，请重试');}};
 const cancelUploadBatch=async(batchId:string)=>{setError('');try{await uploads.cancelBatch(batchId);}catch(e){setError(e instanceof Error?e.message:'批次取消结果未确认，请重试');}};
 const selectFiles=(files:File[],relativePaths?:string[])=>{if(!state||busy||goalPending||messageLocked||modeWriter.pending||cancelWriter.pending||uploads.blocked||uploads.unresolved||!maxBytes)return;void action(async()=>{const entries=files.map((file,index)=>uploads.add(file,maxBytes,relativePaths?.[index]||file.webkitRelativePath||file.name));await uploads.prepareBatch(entries.map(entry=>entry.id));for(const entry of entries)await uploadEntry(entry.id);});};
 const select=(event:React.ChangeEvent<HTMLInputElement>)=>{const files=Array.from(event.target.files??[]);event.target.value='';selectFiles(files);};
 const changeModel=(model:ModelSelection)=>{if(!ordinary||chatMode||!conversation||run||messageLocked||uploads.entries.length||voiceBusy||goalPending||modeWriter.pending||cancelWriter.pending)return;void action(async()=>{const selected=modelSelectionPreservingFallbacks(model,conversation.model);const saved=await modelMutation.submit(`/conversations/${encodeURIComponent(id)}`,'PATCH',{expected_version:conversation.version,model:selected}) as Conversation;rememberConversation(saved);await controller.refresh();});};
 const saveMode=async(retry=false)=>{
  if(!retry&&!canToggle||retry&&!modeWriter.pending)return;
  await action(async()=>{
   try{
    const saved=await (retry?modeWriter.retry():modeWriter.change(conversation!,chatMode?'work':'chat')) as Conversation;
    rememberConversation(saved);if(saved.mode==='chat')setGoalMode(false);await controller.refresh();
   }catch(error){
    // A definite conflict permits an owned read, never a replacement mutation.
    if((error as {status?:number}).status===409&&!modeWriter.pending)try{await controller.refresh();}catch{}
    throw error;
   }
  });
 };
 const showPreview=(file:Artifact)=>void action(async()=>{
  previewRequest.current?.abort();setPreview(undefined);const controller=new AbortController();previewRequest.current=controller;const signal=controller.signal;
  const identity=()=>{if(signal.aborted)throw new DOMException('Aborted','AbortError');};
  const value=await request<Preview>(`/artifacts/${encodeURIComponent(file.artifact_id)}/preview?version=${file.version}`,'GET',undefined,undefined,signal);identity();
  if(value.artifact_id!==file.artifact_id||value.version!==file.version)throw new Error('文件预览未确认');
  if(value.kind==='text'){const verified=await fetchVerifiedArtifactPreviewBytes(file,'text',signal),text=new TextDecoder().decode(verified.bytes);identity();setPreview({name:file.relative_path||file.file_name,text:text.slice(0,200000),truncated:text.length>200000});}
  else if(value.kind==='image'){const verified=await fetchVerifiedArtifactPreviewBytes(file,'image',signal),blob=new Blob([verified.bytes],{type:verified.media_type});identity();setPreview({name:file.relative_path||file.file_name,url:URL.createObjectURL(blob)});}
  else if(isDocumentPreviewMediaType(file.media_type)){
   setPreview({name:file.relative_path||file.file_name,loading:true});
   const job=await request<Record<string,any>>(`/artifacts/${encodeURIComponent(file.artifact_id)}/file-operations`,'POST',{
    conversation_id:id,operation:'document.inspect',base_version:file.version,base_sha256:file.sha256,
   },crypto.randomUUID(),signal);identity();
   const jobId=job.job_id;
   const verifyJob=(current:Record<string,any>)=>{
    if(current.job_id!==jobId||current.artifact_ref!==file.artifact_id||current.operation!=='document.inspect'||current.base_version!==file.version)throw new Error('DOCUMENT_PREVIEW_RESULT_INVALID');
   };
   if(typeof jobId!=='string'||!jobId||!['queued','running','completed','failed'].includes(job.status))throw new Error('DOCUMENT_PREVIEW_RESULT_INVALID');
   verifyJob(job);let current=job;
   for(let attempt=0;current.status!=='completed'&&current.status!=='failed';attempt++){
    if(attempt>=240)throw new Error('DOCUMENT_PREVIEW_TIMEOUT');
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(done,500);function done(){signal.removeEventListener('abort',aborted);resolve()}function aborted(){clearTimeout(timer);signal.removeEventListener('abort',aborted);reject(new DOMException('Aborted','AbortError'))}if(signal.aborted)aborted();else signal.addEventListener('abort',aborted,{once:true});});
    current=await request<Record<string,any>>(`/file-jobs/${encodeURIComponent(jobId)}`,'GET',undefined,undefined,signal);identity();verifyJob(current);
    if(!['queued','running','completed','failed'].includes(current.status))throw new Error('DOCUMENT_PREVIEW_RESULT_INVALID');
   }
   if(current.status==='failed')throw new Error(typeof current.error_code==='string'?current.error_code:'DOCUMENT_PREVIEW_FAILED');
   const result=current.result,source=result?.source;
   if(!result?.ok||!source||source.artifact_id!==file.artifact_id||source.version!==file.version||source.sha256!==file.sha256)throw new Error('FILE_SOURCE_INTEGRITY_FAILED');
   const formatted=formatDocumentPreviewContent(file.media_type,result.content);
   identity();setPreview({name:file.relative_path||file.file_name,text:formatted.text,truncated:formatted.truncated});
  }else setPreview({name:file.relative_path||file.file_name,unsupported:true});
 });
 const download=(file:Artifact)=>void action(async()=>{const response=await fetch(`${base}/v1/artifacts/${encodeURIComponent(file.artifact_id)}/download?version=${file.version}`,{credentials:'same-origin'});if(!response.ok)throw new Error('文件暂不可下载');const url=URL.createObjectURL(await response.blob());const link=document.createElement('a');link.href=url;link.download=file.file_name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
 return <FileTextReferenceContext.Provider value={{owner:fileOwner,conversationId:id,disabled:quoteLocked,regionDisabled,printViews:modeCaps?.reference_snapshots?.office_print_views,nativeSources:modeCaps?.reference_snapshots?.native_file_sources,regionRenderers:modeCaps?.reference_snapshots?.region_renderers,cellViews:modeCaps?.reference_snapshots?.xlsx_cell_views,onAdd:addFileReference,onAddMany:addFileReferences,onAddRegion:addRegionReference}}><section ref={conversationRegion} data-chat-search-scope data-stream-scroll-viewport onClickCapture={event=>inspectDisplay(event.target)} onFocusCapture={event=>{if(event.target instanceof Element&&event.target.matches('input,textarea,select,[contenteditable="true"]'))inspectDisplay(event.target);}} tabIndex={-1} className="workbench-conversation jot-goal-stop-focus-target" aria-label={ordinary?t('普通对话','Ordinary conversation'):t('角色对话','Role conversation')} lang={language}><div data-conversation-follow-content lang="zh-CN"><button lang={language} data-desktop-navigation-guard data-desktop-conversation={id} data-desktop-owner={fileOwner} disabled={busy||goalPending||terminalInputPending||controller.pendingMessage||!!draftBackup||controller.draftDirty||!!controller.draftSavePromise||draftSnapshot!==JSON.stringify(controller.draft)||quoteCount>0||uploads.entries.length>0||modelMutation.pending||modeWriter.pending||cancelWriter.pending} onClick={onClose}>{t("返回工作台","Back to Workbench")}</button><h2 lang={language}>{ordinary?t('我的对话','Conversations'):t('角色对话','Role Conversation')}</h2>{ordinary&&conversation&&<button lang={language} type="button" className="jot-conversation-mode" style={{fontStyle:'italic',fontWeight:700,background:'transparent',border:0,color:'inherit'}} aria-label={t(`切换到 ${chatMode?'work':'chat'}`,`Switch to ${chatMode?'work':'chat'}`)} disabled={!canToggle} onClick={()=>void saveMode()}>{chatMode?'chat':'work'}</button>}<p lang={language} role="status">{controller.connection==='connected'?t('已连接','Connected'):controller.connection==='reconnecting'?t('正在重新连接','Reconnecting'):t('正在连接','Connecting')}{run?` · ${run.status}`:''}</p>{controller.error&&<p lang={language} role="alert">{displayError(controller.error)}</p>}
 {onReload&&<div data-chat-search-ignore><button lang={language} type="button" disabled={busy||!!reloadUnsafe} onClick={reloadInterface}>{t("保存并重载界面","Save and Reload Interface")}</button>{reloadUnsafe&&<small lang={language}>{t("请先处理当前运行、交互或未确认操作，再重载界面。","Resolve the current run, interaction or unconfirmed operation before reloading.")}</small>}</div>}
 <ConversationDisplayBoundary label={t("会话搜索","Conversation Search")}><ConversationHistorySearch root={conversationRegion} conversationId={id} messages={displayedMessages} activities={activityValues} runs={state?.runs??{}} onRevealActivity={revealActivity} onLoadActivityHistory={loadActivityHistory} {...(state?.snapshotSeq?{activityHistorySeq:state.snapshotSeq}:{})} {...(state?.seq?{resultSearchSeq:state.seq}:{})} renderedRevision={renderedMessages} revealedMessageId={historySelection} ready={Boolean(state)} onReveal={revealHistoryMessage} {...(state?.historyComplete!==undefined?{historyComplete:state.historyComplete}:{})} {...(state?.nextHistoryCursor?{historyCursor:state.nextHistoryCursor}:{})} onHistoryLoaded={retainHistory}/></ConversationDisplayBoundary>
 {diagnosticRun&&<ConversationDisplayBoundary label={t("会话终端","Conversation Terminals")}><ConversationTerminals key={`terminals:${id}`} conversationId={id} runId={run?.run_id??diagnosticRun.run_id} onInputPendingChange={setTerminalInputPending}/></ConversationDisplayBoundary>}
 {!ordinary&&run&&['starting','running'].includes(run.status)&&<NativeMemberControls key={`native-member-controls:${run.run_id}`} run={run}/>}
 {ordinary&&conversation&&!chatMode&&<div inert={cancelWriter.pending||messageLocked}><ConversationGoal key={id} id={id} running={run?.status==='running'} runStatus={run?.status} controlRun={state?latestGoalRun(Object.values(state.runs),id):undefined} onResumeAccepted={()=>{void controller.refresh().catch(()=>{});}} onStopCompleted={focusConversationAfterStop} onPendingChange={setGoalPending}/></div>}
  {catalogMount&&<SkillCatalogPanel runId={catalogMount.runId} ownerScope={catalogMount.ownerScope} onUseSkill={name=>editDraft(skillGestureDraft(draftRef.current,name))}/>}
  {queryRecoveryMount&&<details><summary lang={language}>{t("历史运行的命令与恢复记录","Historical Run Commands and Recovery Records")}</summary>
   <label lang={language}>{t('选择原运行','Select Original Run')} <select value={queryRecoveryMount.runId} onChange={event=>setRecoveryRunId(event.currentTarget.value)}>
    {recoveryRuns.map(value=><option key={value.run_id} value={value.run_id}>{value.created_at} · {value.status} · {value.run_id}</option>)}
   </select></label>
   <NativeCommandQueries key={queryRecoveryMount.ownerScope+':'+queryRecoveryMount.runId}
    runId={queryRecoveryMount.runId} ownerScope={queryRecoveryMount.ownerScope} commands={[]} catalogSha256=""/>
   <NativeCommandQueries key={queryRecoveryMount.ownerScope+':'+queryRecoveryMount.runId+':plan'} planMode
    runId={queryRecoveryMount.runId} ownerScope={queryRecoveryMount.ownerScope} commands={[]} catalogSha256=""/>
  </details>}
  {!ordinary&&<ConversationDisplayBoundary label={t("成员执行历史","Member Execution History")}><NativeMemberHistory key={id} conversationId={id}/></ConversationDisplayBoundary>}
  {diagnosticRun&&<ConversationDisplayBoundary label={t("运行诊断","Run Diagnostics")}><RunDiagnostics key={diagnosticRun.run_id} run={diagnosticRun}/></ConversationDisplayBoundary>}
 {state&&<>
  <ConversationDisplayBoundary label={t("上下文整理状态","Context Compaction Status")}><CompactionActivities activities={activityValues} runs={state.runs}/></ConversationDisplayBoundary>
  <ConversationDisplayBoundary label={t("公开步骤历史","Public Activity History")}><ActivityHistory conversationId={id} {...(state.snapshotSeq?{snapshotSeq:state.snapshotSeq}:{})} requestVersion={activityHistoryRequest} onLoaded={retainActivityHistory}/></ConversationDisplayBoundary>
  <ConversationDisplayBoundary label={t("会话成果目录","Conversation Artifacts")}><ConversationArtifacts key={JSON.stringify([taskDraftScope(),id])} conversationId={id} runs={Object.values(state.runs)}/></ConversationDisplayBoundary>
  <ConversationDisplayBoundary label={t("问题与确认历史","Question and Confirmation History")}><InteractionHistory key={id} conversationId={id}/></ConversationDisplayBoundary>
  <ConversationDisplayBoundary label={t("工具时间线","Tool Timeline")}><ActivityTimeline conversationId={id} activities={activityValues} runs={state.runs} onOpenMember={setSelectedNativeMember} {...(activityReveal?{reveal:activityReveal}:{})}/></ConversationDisplayBoundary>
 </>}
  {selectedNativeMember&&<section lang={language} ref={nativeMemberPanel} tabIndex={-1} aria-label={t("父步骤关联的原成员执行","Original Member Execution Linked to Parent Activity")}>
   <button lang={language} type="button" onClick={()=>setSelectedNativeMember(undefined)}>{t("关闭成员详情","Close Member Details")}</button>
   <ConversationDisplayBoundary label={t("父步骤成员详情","Parent Activity Member Details")}><NativeMemberDetails
    key={JSON.stringify(selectedNativeMember)} rootRunId={selectedNativeMember.root_run_id}
    childSessionRef={selectedNativeMember.child_session_ref} childRunId={selectedNativeMember.child_run_id} initialOpen/></ConversationDisplayBoundary>
  </section>}
  {displayedMessages.length>200&&<nav lang={language} aria-label={t("消息历史翻页","Message History Pagination")}>
   <span lang={language}>{historyStart+1}–{Math.min(historyStart+200,displayedMessages.length)} / {displayedMessages.length} {t('条已加载消息','loaded messages')}</span>
   <button lang={language} type="button" disabled={historyStart===0} onClick={()=>setHistorySelection(displayedMessages[Math.max(0,historyStart-150)]!.message_id)}>{t("更早消息","Earlier Messages")}</button>
   <button lang={language} type="button" disabled={historyStart+200>=displayedMessages.length} onClick={()=>setHistorySelection(displayedMessages[Math.min(displayedMessages.length-1,historyStart+250)]!.message_id)}>{t("更晚消息","Later Messages")}</button>
   <button lang={language} type="button" disabled={!historySelection} onClick={()=>setHistorySelection('')}>{t("返回最新消息","Latest Messages")}</button>
  </nav>}
  {state&&renderedMessages.map((message:any)=>{
   const files=messageFiles(state,message) as Artifact[],open=expanded[message.message_id],forkState=forkStates[message.message_id],pendingFork=forkWriter.pendingSelection;
   const pendingForkForMessage=forkWriter.pending&&pendingFork?.sourceConversationId===id&&pendingFork?.throughMessageId===message.message_id;
   const forkActionVisible=message.status==='complete'&&Boolean(onForkConversation)
    &&(pendingForkForMessage||modeCaps?.conversation_forks?.available===true)&&(!forkWriter.pending||pendingForkForMessage);
   return <article key={message.message_id} data-message-key={JSON.stringify(['message',message.message_id])} className={message.role}>
    <small lang={language}>{message.role==='user'?t('你','YOU'):'JOT'}</small>
    {message.status==='complete'&&onTaskSource&&<button lang={language} disabled={busy||goalPending||terminalInputPending||messageLocked||modeWriter.pending||cancelWriter.pending||uploads.entries.length>0} onClick={()=>onTaskSource({conversation_id:id,message})}>{t("设为持续任务","Create Persistent Task")}</button>}
    {forkActionVisible&&<ConversationForkAction source={conversationForkRetrySource(conversation,pendingFork,message.message_id)} message={message} writer={forkWriter}
     busy={busy||goalPending||terminalInputPending||messageLocked||modeWriter.pending||cancelWriter.pending||uploads.entries.length>0||(!pendingForkForMessage&&Boolean(run))}
     onOpenConversation={(target,receipt)=>onForkConversation?.(target,receipt)}
     onStateChange={next=>setForkStates(current=>({...current,[message.message_id]:next}))}
     onNoEffect={()=>controller.refresh()}/>}
    {pendingForkForMessage&&!forkState?.error&&<p lang={language} role="status">{t("副本请求结果尚未确认；重试会复用原命令。","The fork request result is unconfirmed. Retrying reuses the original command.")}</p>}
    {forkState?.error&&<p lang={language} role="status">{displayError(forkState.error)}</p>}
    <ConversationDisplayBoundary label={t("模型思考与摘要","Model Thinking and Summaries")}><MessageThinking message={message} owner={fileOwner} conversationId={id} show={displayPreferences.showThinking} inline={displayPreferences.inlineThinking}/></ConversationDisplayBoundary>
    <ConversationDisplayBoundary label={t("消息正文","Message Content")}><ConversationMessageBody message={message} onOpenReference={openReferenceSource}/></ConversationDisplayBoundary>
    <div className={`jot-message-files ${message.role==='user'?'uploaded':''}`}>{(message.role==='user'||open?files:files.slice(0,3)).map(file=><React.Fragment key={`${file.artifact_id}:${file.version}`}>{message.role==='user'&&<button lang={language} type="button" onClick={()=>showPreview(file)} disabled={busy}>{t('预览','Preview')} {file.relative_path||file.file_name}</button>}<button lang={language} type="button" onClick={()=>file.part_count?setMessageArtifact({owner:taskDraftScope(),target:{kind:'file',artifactId:file.artifact_id,label:file.file_name,version:file.version,sha256:file.sha256}}):download(file)} disabled={busy}>{file.part_count?t('查看各卷','View Parts'):t('下载','Download')} {file.relative_path||file.file_name}</button></React.Fragment>)}</div>
    {message.role==='user'&&Object.hasOwn(message,'attachment_refs')&&(message.attachments?.length??0)>files.length&&<p lang={language} role="status">{t("原附件版本暂不可用，请重新添加文件。","The original attachment version is unavailable. Attach the file again.")}</p>}
    {message.role==='assistant'&&files.length>3&&<button lang={language} onClick={()=>setExpanded(value=>({...value,[message.message_id]:!open}))}>{open?t('收起','Collapse'):t(`展开其余 ${files.length-3} 个文件`,`Show ${files.length-3} More Files`)}</button>}
   </article>;
  })}
 {state&&Object.values(state.interactions).filter((value:any)=>value.status==='pending').map((value:any)=><InteractionCard key={value.interaction_id} value={value} disabled={busy||cancelWriter.pending||messageLocked||controller.connection!=='connected'} submit={(body,key,signal)=>request(`/interactions/${encodeURIComponent(value.interaction_id)}/${value.kind==='approval'?'decision':'response'}`,'POST',body,key,signal)} onRefresh={()=>controller.refresh()}/>)}
 {ordinary&&modeCaps&&!modes.chatReady&&<p lang={language} role="status">{displayError(modeCapabilityError)||(modes.aware?t('Chat 暂不可用','Chat is unavailable'):t('当前后端未声明 Chat 模式','The backend has not declared Chat mode'))}</p>}
 {cancelWriter.pending&&<p lang={language} role="status">{t('停止结果尚未确认；请保留当前页面。','The stop result is unconfirmed. Keep this page open.')}<button lang={language} type="button" disabled={busy} onClick={()=>cancelTask(true)}>{t("重试原停止请求","Retry Original Stop Request")}</button></p>}
 {modeWriter.pending&&<p lang={language} role="status">{t('模式设置结果尚未确认。','The mode setting result is unconfirmed.')}<button lang={language} type="button" disabled={busy} onClick={()=>void saveMode(true)}>{t("重试原模式设置","Retry Original Mode Setting")}</button></p>}
 {referenceSource&&referenceSource.owner===fileOwner&&referenceSource.conversationId===id&&<ConversationDisplayBoundary key={referenceSource.requestId} label={t("原文件引用来源","Original File Reference Source")}><FileReferenceSource value={referenceSource.value} requestId={referenceSource.requestId} onClose={closeReferenceSource}/></ConversationDisplayBoundary>}
 {error&&<p lang={language} role="alert">{displayError(error)}</p>}{controller.pendingMessage&&<p lang={language} role="status">{controller.pending.receipt?t('原消息已确认，重试将继续完成本地回执清理。','The original message is confirmed. Retrying continues local receipt cleanup.'):t('原发送请求已保留，重试会沿用原消息或原任务补充的请求正文、附件和幂等键。','The original send request is retained. Retrying reuses the original message or task follow-up body, attachments and idempotency key.')}</p>}
 {controller.pendingMessage&&<details><summary lang={language}>{t("查看原发送内容","View Original Message")}</summary>
  <p lang={language}>{controller.pending.kind==='steer'?t(`原任务补充 · ${controller.pending.runId}`,`Original Task Follow-up · ${controller.pending.runId}`):t('原会话消息','Original Conversation Message')} · {t('客户端消息标识','Client Message ID')} <code>{controller.pending.body.client_message_id}</code></p>
  <pre>{controller.pending.kind==='steer'?controller.pending.body.text:controller.pending.body.content.filter((part:any)=>part.type==='text').map((part:any)=>part.text).join('\n')}</pre>
  {controller.pendingAttachments.length>0&&<p lang={language}>{t('原附件标识','Original Attachment IDs')} · {controller.pendingAttachments.join('、')}</p>}
  {controller.pending.body.reference_snapshots&&<details><summary lang={language}>{t("原请求引用快照","Original Request Reference Snapshots")}</summary><pre>{JSON.stringify(controller.pending.body.reference_snapshots,null,2)}</pre></details>}
 </details>}
 {(messageRecoveryError||controller.recoveryError)&&<p lang={language} role="alert">{t('原发送请求存储尚未确认，消息操作已暂停。','Original send-request storage is unconfirmed. Message operations are paused.')}<button lang={language} type="button" disabled={busy||controller.recoveryBusy||voiceBusy} onClick={()=>setMessageRecoveryRevision(value=>value+1)}>{t("重读原发送回执","Reread Original Message Receipt")}</button></p>}
 {!controller.recoveryReady&&!messageRecoveryError&&<p lang={language} role="status">{t("正在读取原发送请求…","Loading the original message request…")}</p>}
 {draftBackup&&<section lang={language} aria-label={t("本页未保存草稿","Unsaved Draft on This Page")}><p lang={language} role="alert">{t("重读前本页草稿与已保存记录不同。请核对后选择要使用的草稿。","The draft on this page differs from the saved record before rereading. Compare them and choose which draft to use.")}</p>
  <details><summary lang={language}>{t("查看本页未保存草稿","View Unsaved Page Draft")}</summary><pre>{JSON.stringify(draftBackup,null,2)}</pre></details>
  <button lang={language} type="button" disabled={busy||controller.recoveryBlocked||controller.pendingMessage} onClick={()=>{applyComposerDraft(draftBackup);setDraftBackup(undefined);}}>{t("恢复本页草稿","Restore Page Draft")}</button>
  <button lang={language} type="button" disabled={busy||controller.recoveryBlocked||controller.pendingMessage} onClick={()=>setDraftBackup(undefined)}>{t("保留已保存草稿并清除本页备份","Keep Saved Draft and Clear Page Backup")}</button>
 </section>}
 {controller.recoveryReady&&!controller.pendingMessage&&<p lang={language} role="status">{controller.draftSavePromise?t('草稿正在保存，请等待保存完成后离开。','The draft is being saved. Wait for saving to finish before leaving.'):controller.draftDirty||draftSnapshot!==JSON.stringify(controller.draft)?t('草稿尚未保存，请查看提示并保留当前页面。','The draft is unsaved. Check the notice and keep this page open.'):t('文字、回复引用和PDF文字引用已随当前账户与会话保存。','Text, reply quotes and PDF text references are saved for the current account and conversation.')}</p>}

 {modelMutation.pending&&<p lang={language} role="status">{t('模型设置结果尚未确认。','The model setting result is unconfirmed.')}<button lang={language} type="button" disabled={busy} onClick={()=>{if(conversation)changeModel(conversation.model);}}>{t("重试原模型设置","Retry Original Model Setting")}</button></p>}
 {messageArtifact&&messageArtifact.owner===taskDraftScope()&&<section lang={language} aria-label={t("消息关联成果详情","Message-linked Artifact Details")}>
  <button lang={language} type="button" onClick={()=>setMessageArtifact(undefined)}>{t("关闭成果详情","Close Artifact Details")}</button>
  <ConversationDisplayBoundary label={t("消息成果详情","Message Artifact Details")}><ActivityArtifactDetails key={JSON.stringify([messageArtifact.owner,id,messageArtifact.target.artifactId])} conversationId={id} target={messageArtifact.target} onOpen={target=>setMessageArtifact({owner:taskDraftScope(),target})}/></ConversationDisplayBoundary>
 </section>}
 {(uploadRecoveryError||uploads.recoveryError)&&<p lang={language} role="alert">{t('上传回执存储尚未确认，附件操作已暂停。','Upload receipt storage is unconfirmed. Attachment operations are paused.')}<button lang={language} type="button" disabled={busy||uploads.recoveryBusy} onClick={()=>setUploadRecoveryRevision(value=>value+1)}>{t("重读上传回执","Reread Upload Receipts")}</button></p>}
 {!uploads.recoveryReady&&!uploadRecoveryError&&<p lang={language} role="status">{t("正在读取原上传回执…","Loading original upload receipts…")}</p>}
 {preview&&<section lang={language} role="region" aria-label={t("附件预览","Attachment Preview")} className="jot-file-preview"><h3 lang={language}>{preview.name}</h3><button lang={language} onClick={()=>{previewRequest.current?.abort();previewRequest.current=undefined;setPreview(undefined);}}>{t("关闭预览","Close Preview")}</button>{preview.loading&&<p lang={language} role="status">{t("正在读取文件内容…","Loading file content…")}</p>}{preview.url&&<img src={preview.url} alt={preview.name}/>} {preview.text!==undefined&&<pre>{preview.text}</pre>}{preview.truncated&&<p lang={language}>{t("预览内容已截短","Preview content is truncated")}</p>}{preview.unsupported&&<p lang={language}>{t("此文件暂不支持在线预览","Online preview is not supported for this file")}</p>}</section>}
 <input ref={fileInput} type="file" aria-label={t("添加文件","Attach Files")} multiple hidden disabled={!state||busy||cancelWriter.pending||goalPending||messageLocked||uploads.blocked||uploads.unresolved||!maxBytes} onChange={select}/>
 {ordinary&&!chatMode&&conversation&&<aside lang={language} className="jot-model-routing-status" aria-label={t("模型路由状态","Model Routing Status")}><p lang={language} role="status">{routingStatus.primary}</p><p lang={language}>{routingStatus.fallbacks}</p></aside>}
 <input ref={folderInput} type="file" aria-label={t("添加文件夹","Attach Folder")} multiple hidden disabled={!state||busy||cancelWriter.pending||goalPending||messageLocked||uploads.blocked||uploads.unresolved||!maxBytes} onChange={select}/>
 {ordinary&&!chatMode&&goalMode&&<p lang={language} role="status">{t("目标模式","Goal Mode")}</p>}
 <AssistantReplyQuoteAction root={conversationRegion} conversationId={id} disabled={quoteLocked} onAdd={addReplyQuote}/>
 <PromptComposer className={chatMode?'jot-prompt-chat':''} value={draft} onChange={editDraft} onSubmit={send} placeholder={ordinary&&!chatMode&&goalMode?t('描述你的目标…','Describe your goal…'):t('输入消息…','Type a message…')} ariaLabel={ordinary?t('对话消息','Conversation message'):t('角色消息','Role message')}
  disabled={!state||busy||goalPending||modelMutation.pending||modeWriter.pending||cancelWriter.pending||controller.recoveryBlocked||!!draftBackup&&!controller.pendingMessage||chatUnavailable&&!controller.pendingMessage} inputDisabled={messageLocked||modeWriter.pending||cancelWriter.pending} submitDisabled={controller.recoveryBlocked||!!draftBackup&&!controller.pendingMessage||voiceBusy||!controller.pendingMessage&&(!regionsReady||uploads.entries.length>0&&uploads.blocked||uploads.entries.some((entry:any)=>entry.status!=='ready')||ordinary&&goalMode&&!draft.trim()&&!quoteCount)} submitLabel={controller.pendingMessage?t('重试原消息','Retry Original Message'):run?(ordinary?t('补充当前任务','Follow Up on Current Task'):t('加入队列','Add to Queue')):t('发送','Send')}
  selection={chatMode?undefined:conversation?.model} modelOptions={chatMode?[]:models} onSelectionChange={ordinary&&!chatMode&&!modeWriter.pending&&!cancelWriter.pending&&!run&&!messageLocked&&!uploads.entries.length&&!voiceBusy&&!goalPending&&!modelMutation.pending?changeModel:undefined}
  onAttach={()=>fileInput.current?.click()} attachDisabled={!state||busy||cancelWriter.pending||goalPending||messageLocked||uploads.blocked||uploads.unresolved||!maxBytes} uploadMenu={<button lang={language} type="button" role="menuitem" disabled={!state||busy||cancelWriter.pending||goalPending||messageLocked||uploads.blocked||uploads.unresolved||!maxBytes} onClick={()=>folderInput.current?.click()}>{t("添加文件夹","Attach Folder")}</button>} onDropFiles={selectFiles} onDropError={error=>setError(error instanceof Error?error.message:'无法读取所选文件夹')}
   hasAttachments={controller.pendingMessage||uploads.entries.length>0||quoteCount>0} attachments={<><FileTextReferences references={fileReferences} disabled={quoteLocked} onChange={editFileReferences} imageFile={imageFile} resolveImage={imageArtifact} onOpen={openReferenceSource}/><AssistantReplyQuotes quotes={replyQuotes} disabled={quoteLocked} onChange={setReplyQuotes}/><UploadAttachments uploads={uploads} busy={busy} locked={uploads.blocked||cancelWriter.pending||goalPending||messageLocked||modeWriter.pending} onAction={operation=>void action(operation)} onUpload={uploadEntry} onCancel={cancelUpload} onCancelBatch={cancelUploadBatch}/></>}
  keepVoiceVisible voiceActive={voiceBusy} voiceControl={<VoiceInput id={id} voice={voice} disabled={!state||busy||goalPending||messageLocked||modelMutation.pending||modeWriter.pending||cancelWriter.pending||chatUnavailable} onText={appendTranscript} onBusyChange={setVoiceBusy}/>}
  goalMenu={ordinary&&!chatMode?<button lang={language} type="button" role="menuitemcheckbox" disabled={messageLocked} aria-checked={goalMode} onClick={()=>setGoalMode(value=>!value)}>{t('目标模式','Goal Mode')}{goalMode?' ✓':''}</button>:undefined}
  responding={Boolean(run)} stopDisabled={busy||cancelWriter.pending||messageLocked||run?.status==='cancelling'} onStop={run?()=>cancelTask():undefined}/>
 {(scrollFollow.canReturnToLatest||!!historySelection)&&<button lang={language} type="button" className="jot-conversation-return-latest" data-chat-search-ignore onClick={requestLatest}>{t("回到会话末尾","Return to Latest")}</button>}
 </div></section></FileTextReferenceContext.Provider>;
}
