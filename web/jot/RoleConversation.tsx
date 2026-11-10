import {validateTextReference} from './composer-draft-recovery.mjs';
import {FileTextReferenceContext,FileTextReferences,fileReferenceMessage,fileReferenceSnapshots,isFileRegion,resolveRegionArtifact,type FileReference,type FileSourceReference,type FileRegionDraft,type FileSelectionReference} from './FileTextReferences';
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
import {UploadRecoveryStore} from './upload-recovery.mjs';
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
import type {ActivityReveal,ActivityArtifactTarget} from './activity-presentation';
import ConversationDisplayBoundary from './ConversationDisplayBoundary';
import RunDiagnostics from './RunDiagnostics';
import {RunCancelWriter} from './run-cancel.mjs';
import {ConversationModeWriter,conversationModeSupport} from './conversation-mode.mjs';
import {modelRoutingStatus,modelSelectionPreservingFallbacks} from './model-routing-status.mjs';
import {ConversationForkWriter,conversationForkRetrySource} from './conversation-fork-controller.mjs';
import {ConversationForkAction} from './conversation-fork-action.mjs';
import PromptComposer from './PromptComposer';
import ConversationHistorySearch from './ConversationHistorySearch';
import {AssistantReplyQuoteAction,AssistantReplyQuotes,replyQuoteMessage,type AssistantReplyQuote} from './AssistantReplyQuote';
import {appendVoiceText} from './voice-draft-controller.mjs';
import {goalPrompt,latestGoalRun} from './goal-controller.mjs';
import type {Artifact,Run,Capabilities,Preview,Conversation,ModelSelection,Message,Activity} from './types';
const active=(run:Run)=>['queued','starting','running','waiting_user','waiting_approval','cancelling'].includes(run.status);
type ConversationProps={ordinary?:boolean;id:string;onClose:()=>void;onTaskSource?:(source:TaskSourceSelection)=>void;onForkConversation?:(conversationId:string,receipt:unknown)=>void};
export default function RoleConversation(props:ConversationProps){
 return <ConversationContent key={`${taskDraftScope()}:${props.id}:${Boolean(props.ordinary)}`} {...props}/>;
}
type NativeMemberActionState='submitting'|'pending'|'unknown'|'accepted'|'superseded'|'resolved';
type NativeMemberAction={runId:string;requestId:string;operation:'interrupt'|'wake';member:NativeMember;state:NativeMemberActionState};
function NativeMemberControls({run}:{run:Run}){
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
 const actionMessage=(action:NativeMemberAction)=>action.state==='submitting'?'正在提交原成员请求。':action.state==='pending'?'继续内容已排队；尚未确认原成员接收。':action.state==='unknown'?`${action.operation==='interrupt'?'中断':'继续'}结果未知或未确认；系统不会自动重发。`:action.state==='accepted'?action.operation==='interrupt'?'中断信号已确认；这不代表成员已停止。刷新成员列表可核对当前状态。':'继续内容已由原成员接收；尚未证明成员已恢复或任务完成。':action.state==='superseded'?'原成员请求已被替代；系统不会自动重发。':action.state==='resolved'?'成员当前空闲；原中断回执仍未知，系统没有重发。':'';
 const status=(value:string)=>value==='running'?'运行中':value==='inactive'?'空闲':value==='provisioning'?'准备中':value==='failed'?'失败':value;
 return <section className="jot-native-member-controls" aria-label="原生协作成员"><h3>原生协作成员</h3><p>以下操作只作用于所选原成员，不更改父目标、授权或预算；中断回执不代表成员已经停止。</p>
  <button type="button" disabled={loading||busy} onClick={()=>void refresh()}>刷新成员列表</button>
  {loading&&!roster&&<p role="status">正在读取成员列表…</p>}
  {error&&<p role="alert">{error}</p>}
  {roster&&<><ul>{roster.members.map(value=><li key={value.child_session_ref}>{value.name} · {status(value.status)} · <code>{value.child_session_ref}</code></li>)}</ul>
   {roster.members.length===0?<p role="status">当前任务没有可控制的原生成员。</p>:<><label htmlFor={`native-member-${run.run_id}`}>成员</label><select id={`native-member-${run.run_id}`} value={selected} disabled={loading||busy||locked} onChange={event=>{setSelected(event.currentTarget.value);setError('');}}>{roster.members.map(value=><option key={value.child_session_ref} value={value.child_session_ref}>{value.name} · {status(value.status)} · {value.child_session_ref}</option>)}</select>
    {member&&<ConversationDisplayBoundary label="原成员步骤"><NativeMemberDetails key={member.child_session_ref} rootRunId={run.run_id} childSessionRef={member.child_session_ref}/></ConversationDisplayBoundary>}
    <button type="button" disabled={!member||member.status!=='running'||busy||locked||sameMemberLocked} onClick={()=>void submit('interrupt')}>中断选中成员</button>
    <label htmlFor={`native-member-message-${run.run_id}`}>给原成员的继续内容</label><textarea id={`native-member-message-${run.run_id}`} value={text} maxLength={32768} disabled={!member||busy||locked||sameMemberLocked} onChange={event=>setText(event.currentTarget.value)}/>
    <button type="button" disabled={!member||!text.trim()||new TextEncoder().encode(text).byteLength>32768||busy||locked||sameMemberLocked} onClick={()=>void submit('wake')}>明确继续此成员</button>
   </>}
  </>}
  {Object.values(actionStates).map(action=><p role="status" key={action.requestId}>{action.member.name} · {actionMessage(action)} {action.operation==='interrupt'&&action.state==='unknown'&&<><button type="button" disabled={busy} onClick={()=>void inspectAction(action)}>检查原中断回执</button><button type="button" disabled={loading||busy} onClick={()=>void refresh()}>检查成员状态</button></>} {action.operation==='wake'&&['pending','unknown'].includes(action.state)&&<button type="button" disabled={busy} onClick={()=>void inspectAction(action)}>检查原请求状态</button>}</p>)}
 </section>;
}
function ConversationMessageBody({message,onOpenReference}:{message:Message;onOpenReference:(value:FileSourceReference)=>void}){
 return <div data-chat-search-message={message.message_id} {...(message.role==='assistant'?{'data-assistant-quote-source':'','data-assistant-quote-message-id':message.message_id}:{})}>
  {message.blocks.filter(block=>block.kind==='text').map(block=><TwemojiMarkdown key={block.block_id}>{block.text}</TwemojiMarkdown>)}
  <MessageFileReferences message={message} onOpen={onOpenReference}/>
 </div>;
}
type ComposerDraft={text:string;replyQuotes:AssistantReplyQuote[];textReferences:FileSelectionReference[];goalMode:boolean};
function ConversationContent({id,onClose,onTaskSource,onForkConversation,ordinary=false}:ConversationProps){
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
 useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{if(draft.trim()||draftBackup||controller.draftDirty||controller.draftSavePromise||quoteCount||uploads.entries.length||controller.pendingMessage||goalPending||voiceBusy||modeWriter.pending||cancelWriter.pending){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[uploads,controller,draft,draftBackup,goalPending,voiceBusy,modeWriter.pending,cancelWriter.pending,quoteCount]);
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
 const conversationRuns=state?(Object.values(state.runs) as Run[]).filter(value=>value.conversation_id===id)
  .sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.run_id.localeCompare(a.run_id)):[];
 const diagnosticRun=conversationRuns[0];
  const catalogMount=catalogMountForRun(run?.run_id,taskDraftScope(),ordinary);
  const recoveryRuns=conversationRuns.filter(value=>value.run_id!==catalogMount?.runId);
  const recoveryRun=recoveryRuns.find(value=>value.run_id===recoveryRunId)??recoveryRuns[0];
  const queryRecoveryMount=catalogMountForRun(recoveryRun?.run_id,taskDraftScope(),ordinary);
 const chatMode=ordinary&&conversation?.mode==='chat';
 const routingStatus=modelRoutingStatus(conversation?.model,models);
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
     &&(!('text_view' in value)||value.text_view!==2||modeCaps?.reference_snapshots?.docx_text_views?.includes(2)));
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
   const location=reference.selectionMode==='cells'?[reference.locator,reference.cells]
    :reference.renderer.id==='pdf'?[reference.selectedText,reference.locator.pageNumbers]:[('text_view' in item?item.text_view:undefined),reference.selectedText,reference.locator];
   return JSON.stringify([item.runId,item.activityId,item.resultSha,item.file.path,item.file.version,item.file.sha256,item.file.size,location]);
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
  const {reference}=value,rect=reference.locator.rect;
  if(reference.schemaVersion!==1||reference.kind!=='content-reference'||reference.selectionMode!=='region'||reference.renderer.id!=='pdf'||reference.renderer.backend!=='builtin'||reference.locator.surface!=='page'
   ||reference.source.relativePath!==value.file.path||reference.source.revision?.sha256!==value.file.sha256||reference.source.revision?.id!==String(value.file.version)||reference.source.revision?.size!==value.file.size
   ||!Number.isSafeInteger(value.file.version)||value.file.version<0||!Number.isSafeInteger(value.file.size)||value.file.size<0||!/^[a-f0-9]{64}$/.test(value.file.sha256)||!/^[a-f0-9]{64}$/.test(value.resultSha)
   ||!Number.isSafeInteger(reference.locator.pageNumber)||Number(reference.locator.pageNumber)<1||!Number.isSafeInteger(reference.image.width)||reference.image.width<1||!Number.isSafeInteger(reference.image.height)||reference.image.height<1
   ||[rect.x,rect.y,rect.width,rect.height].some(number=>!Number.isFinite(number)||number<0||number>1)||!rect.width||!rect.height
   ||reference.image.mimeType!=='image/png'||file.type!=='image/png'||file.name!==reference.image.name||file.size!==value.imageBytes||file.size<1||file.size>maxBytes
   ||!/^[a-f0-9]{64}$/.test(reference.image.sha256??'')||![0,90,180,270].includes(value.rotation)){setError('区域引用或截图信息未能核对，请重新选择。');return Promise.resolve(false);}
  if(fileReferences.some(item=>isFileRegion(item)&&item.runId===value.runId&&item.activityId===value.activityId&&item.resultSha===value.resultSha&&item.file.path===value.file.path&&item.file.version===value.file.version&&item.file.sha256===value.file.sha256&&item.reference.image.sha256===reference.image.sha256&&JSON.stringify(item.reference.locator)===JSON.stringify(reference.locator)&&item.rotation===value.rotation))return Promise.resolve(true);
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
 return <FileTextReferenceContext.Provider value={{owner:fileOwner,conversationId:id,disabled:quoteLocked,regionDisabled,onAdd:addFileReference,onAddMany:addFileReferences,onAddRegion:addRegionReference}}><section ref={conversationRegion} data-chat-search-scope tabIndex={-1} className="workbench-conversation jot-goal-stop-focus-target" aria-label={ordinary?"Ordinary conversation":"Role conversation"}><button disabled={busy||goalPending||controller.pendingMessage||!!draftBackup||controller.draftDirty||!!controller.draftSavePromise||draftSnapshot!==JSON.stringify(controller.draft)||quoteCount>0||uploads.entries.length>0||modelMutation.pending||modeWriter.pending||cancelWriter.pending} onClick={onClose}>返回工作台</button><h2>{ordinary?'我的对话':'角色对话'}</h2>{ordinary&&conversation&&<button type="button" className="jot-conversation-mode" style={{fontStyle:'italic',fontWeight:700,background:'transparent',border:0,color:'inherit'}} aria-label={`切换到 ${chatMode?'work':'chat'}`} disabled={!canToggle} onClick={()=>void saveMode()}>{chatMode?'chat':'work'}</button>}<p role="status">{controller.connection==='connected'?'已连接':controller.connection==='reconnecting'?'正在重新连接':'正在连接'}{run?` · ${run.status}`:''}</p>{controller.error&&<p role="alert">{controller.error}</p>}
 <ConversationDisplayBoundary label="会话搜索"><ConversationHistorySearch root={conversationRegion} conversationId={id} messages={displayedMessages} activities={activityValues} runs={state?.runs??{}} onRevealActivity={revealActivity} onLoadActivityHistory={loadActivityHistory} {...(state?.snapshotSeq?{activityHistorySeq:state.snapshotSeq}:{})} {...(state?.seq?{resultSearchSeq:state.seq}:{})} renderedRevision={renderedMessages} revealedMessageId={historySelection} ready={Boolean(state)} onReveal={revealHistoryMessage} {...(state?.historyComplete!==undefined?{historyComplete:state.historyComplete}:{})} {...(state?.nextHistoryCursor?{historyCursor:state.nextHistoryCursor}:{})} onHistoryLoaded={retainHistory}/></ConversationDisplayBoundary>
 {!ordinary&&run&&['starting','running'].includes(run.status)&&<NativeMemberControls key={`native-member-controls:${run.run_id}`} run={run}/>}
 {ordinary&&conversation&&!chatMode&&<div inert={cancelWriter.pending||messageLocked}><ConversationGoal key={id} id={id} running={run?.status==='running'} runStatus={run?.status} controlRun={state?latestGoalRun(Object.values(state.runs),id):undefined} onResumeAccepted={()=>{void controller.refresh().catch(()=>{});}} onStopCompleted={focusConversationAfterStop} onPendingChange={setGoalPending}/></div>}
  {catalogMount&&<SkillCatalogPanel runId={catalogMount.runId} ownerScope={catalogMount.ownerScope} onUseSkill={name=>editDraft(skillGestureDraft(draftRef.current,name))}/>}
  {queryRecoveryMount&&<details><summary>历史运行的命令与恢复记录</summary>
   <label>选择原运行 <select value={queryRecoveryMount.runId} onChange={event=>setRecoveryRunId(event.currentTarget.value)}>
    {recoveryRuns.map(value=><option key={value.run_id} value={value.run_id}>{value.created_at} · {value.status} · {value.run_id}</option>)}
   </select></label>
   <NativeCommandQueries key={queryRecoveryMount.ownerScope+':'+queryRecoveryMount.runId}
    runId={queryRecoveryMount.runId} ownerScope={queryRecoveryMount.ownerScope} commands={[]} catalogSha256=""/>
   <NativeCommandQueries key={queryRecoveryMount.ownerScope+':'+queryRecoveryMount.runId+':plan'} planMode
    runId={queryRecoveryMount.runId} ownerScope={queryRecoveryMount.ownerScope} commands={[]} catalogSha256=""/>
  </details>}
  {!ordinary&&<ConversationDisplayBoundary label="成员执行历史"><NativeMemberHistory key={id} conversationId={id}/></ConversationDisplayBoundary>}
  {diagnosticRun&&<ConversationDisplayBoundary label="运行诊断"><RunDiagnostics key={diagnosticRun.run_id} run={diagnosticRun}/></ConversationDisplayBoundary>}
 {state&&<>
  <ConversationDisplayBoundary label="上下文整理状态"><CompactionActivities activities={activityValues} runs={state.runs}/></ConversationDisplayBoundary>
  <ConversationDisplayBoundary label="公开步骤历史"><ActivityHistory conversationId={id} {...(state.snapshotSeq?{snapshotSeq:state.snapshotSeq}:{})} requestVersion={activityHistoryRequest} onLoaded={retainActivityHistory}/></ConversationDisplayBoundary>
  <ConversationDisplayBoundary label="会话成果目录"><ConversationArtifacts key={JSON.stringify([taskDraftScope(),id])} conversationId={id} runs={Object.values(state.runs)}/></ConversationDisplayBoundary>
  <ConversationDisplayBoundary label="问题与确认历史"><InteractionHistory key={id} conversationId={id}/></ConversationDisplayBoundary>
  <ConversationDisplayBoundary label="工具时间线"><ActivityTimeline conversationId={id} activities={activityValues} runs={state.runs} onOpenMember={setSelectedNativeMember} {...(activityReveal?{reveal:activityReveal}:{})}/></ConversationDisplayBoundary>
 </>}
  {selectedNativeMember&&<section ref={nativeMemberPanel} tabIndex={-1} aria-label="父步骤关联的原成员执行">
   <button type="button" onClick={()=>setSelectedNativeMember(undefined)}>关闭成员详情</button>
   <ConversationDisplayBoundary label="父步骤成员详情"><NativeMemberDetails
    key={JSON.stringify(selectedNativeMember)} rootRunId={selectedNativeMember.root_run_id}
    childSessionRef={selectedNativeMember.child_session_ref} childRunId={selectedNativeMember.child_run_id} initialOpen/></ConversationDisplayBoundary>
  </section>}
  {displayedMessages.length>200&&<nav aria-label="消息历史翻页">
   <span>{historyStart+1}–{Math.min(historyStart+200,displayedMessages.length)} / {displayedMessages.length} 条已加载消息</span>
   <button type="button" disabled={historyStart===0} onClick={()=>setHistorySelection(displayedMessages[Math.max(0,historyStart-150)]!.message_id)}>更早消息</button>
   <button type="button" disabled={historyStart+200>=displayedMessages.length} onClick={()=>setHistorySelection(displayedMessages[Math.min(displayedMessages.length-1,historyStart+250)]!.message_id)}>更晚消息</button>
   <button type="button" disabled={!historySelection} onClick={()=>setHistorySelection('')}>返回最新消息</button>
  </nav>}
  {state&&renderedMessages.map((message:any)=>{
   const files=messageFiles(state,message) as Artifact[],open=expanded[message.message_id],forkState=forkStates[message.message_id],pendingFork=forkWriter.pendingSelection;
   const pendingForkForMessage=forkWriter.pending&&pendingFork?.sourceConversationId===id&&pendingFork?.throughMessageId===message.message_id;
   const forkActionVisible=message.status==='complete'&&Boolean(onForkConversation)
    &&(pendingForkForMessage||modeCaps?.conversation_forks?.available===true)&&(!forkWriter.pending||pendingForkForMessage);
   return <article key={message.message_id} className={message.role}>
    <small>{message.role==='user'?'YOU':'JOT'}</small>
    {message.status==='complete'&&onTaskSource&&<button disabled={busy||goalPending||messageLocked||modeWriter.pending||cancelWriter.pending||uploads.entries.length>0} onClick={()=>onTaskSource({conversation_id:id,message})}>设为持续任务</button>}
    {forkActionVisible&&<ConversationForkAction source={conversationForkRetrySource(conversation,pendingFork,message.message_id)} message={message} writer={forkWriter}
     busy={busy||goalPending||messageLocked||modeWriter.pending||cancelWriter.pending||uploads.entries.length>0||(!pendingForkForMessage&&Boolean(run))}
     onOpenConversation={(target,receipt)=>onForkConversation?.(target,receipt)}
     onStateChange={next=>setForkStates(current=>({...current,[message.message_id]:next}))}
     onNoEffect={()=>controller.refresh()}/>}
    {pendingForkForMessage&&!forkState?.error&&<p role="status">副本请求结果尚未确认；重试会复用原命令。</p>}
    {forkState?.error&&<p role="status">{forkState.error}</p>}
    <ConversationDisplayBoundary label="消息正文"><ConversationMessageBody message={message} onOpenReference={openReferenceSource}/></ConversationDisplayBoundary>
    <div className={`jot-message-files ${message.role==='user'?'uploaded':''}`}>{(message.role==='user'||open?files:files.slice(0,3)).map(file=><React.Fragment key={`${file.artifact_id}:${file.version}`}>{message.role==='user'&&<button type="button" onClick={()=>showPreview(file)} disabled={busy}>预览 {file.relative_path||file.file_name}</button>}<button type="button" onClick={()=>file.part_count?setMessageArtifact({owner:taskDraftScope(),target:{kind:'file',artifactId:file.artifact_id,label:file.file_name,version:file.version,sha256:file.sha256}}):download(file)} disabled={busy}>{file.part_count?'查看各卷':'下载'} {file.relative_path||file.file_name}</button></React.Fragment>)}</div>
    {message.role==='user'&&Object.hasOwn(message,'attachment_refs')&&(message.attachments?.length??0)>files.length&&<p role="status">原附件版本暂不可用，请重新添加文件。</p>}
    {message.role==='assistant'&&files.length>3&&<button onClick={()=>setExpanded(value=>({...value,[message.message_id]:!open}))}>{open?'收起':`展开其余 ${files.length-3} 个文件`}</button>}
   </article>;
  })}
 {state&&Object.values(state.interactions).filter((value:any)=>value.status==='pending').map((value:any)=><InteractionCard key={value.interaction_id} value={value} disabled={busy||cancelWriter.pending||messageLocked||controller.connection!=='connected'} submit={(body,key,signal)=>request(`/interactions/${encodeURIComponent(value.interaction_id)}/${value.kind==='approval'?'decision':'response'}`,'POST',body,key,signal)} onRefresh={()=>controller.refresh()}/>)}
 {ordinary&&modeCaps&&!modes.chatReady&&<p role="status">{modeCapabilityError||(modes.aware?'Chat 暂不可用':'当前后端未声明 Chat 模式')}</p>}
 {cancelWriter.pending&&<p role="status">停止结果尚未确认；请保留当前页面。<button type="button" disabled={busy} onClick={()=>cancelTask(true)}>重试原停止请求</button></p>}
 {modeWriter.pending&&<p role="status">模式设置结果尚未确认。<button type="button" disabled={busy} onClick={()=>void saveMode(true)}>重试原模式设置</button></p>}
 {referenceSource&&referenceSource.owner===fileOwner&&referenceSource.conversationId===id&&<ConversationDisplayBoundary key={referenceSource.requestId} label="原文件引用来源"><FileReferenceSource value={referenceSource.value} requestId={referenceSource.requestId} onClose={closeReferenceSource}/></ConversationDisplayBoundary>}
 {error&&<p role="alert">{error}</p>}{controller.pendingMessage&&<p role="status">{controller.pending.receipt?'原消息已确认，重试将继续完成本地回执清理。':'原发送请求已保留，重试会沿用原消息或原任务补充的请求正文、附件和幂等键。'}</p>}
 {controller.pendingMessage&&<details><summary>查看原发送内容</summary>
  <p>{controller.pending.kind==='steer'?`原任务补充 · ${controller.pending.runId}`:'原会话消息'} · 客户端消息标识 <code>{controller.pending.body.client_message_id}</code></p>
  <pre>{controller.pending.kind==='steer'?controller.pending.body.text:controller.pending.body.content.filter((part:any)=>part.type==='text').map((part:any)=>part.text).join('\n')}</pre>
  {controller.pendingAttachments.length>0&&<p>原附件标识 · {controller.pendingAttachments.join('、')}</p>}
  {controller.pending.body.reference_snapshots&&<details><summary>原请求引用快照</summary><pre>{JSON.stringify(controller.pending.body.reference_snapshots,null,2)}</pre></details>}
 </details>}
 {(messageRecoveryError||controller.recoveryError)&&<p role="alert">原发送请求存储尚未确认，消息操作已暂停。<button type="button" disabled={busy||controller.recoveryBusy||voiceBusy} onClick={()=>setMessageRecoveryRevision(value=>value+1)}>重读原发送回执</button></p>}
 {!controller.recoveryReady&&!messageRecoveryError&&<p role="status">正在读取原发送请求…</p>}
 {draftBackup&&<section aria-label="本页未保存草稿"><p role="alert">重读前本页草稿与已保存记录不同。请核对后选择要使用的草稿。</p>
  <details><summary>查看本页未保存草稿</summary><pre>{JSON.stringify(draftBackup,null,2)}</pre></details>
  <button type="button" disabled={busy||controller.recoveryBlocked||controller.pendingMessage} onClick={()=>{applyComposerDraft(draftBackup);setDraftBackup(undefined);}}>恢复本页草稿</button>
  <button type="button" disabled={busy||controller.recoveryBlocked||controller.pendingMessage} onClick={()=>setDraftBackup(undefined)}>保留已保存草稿并清除本页备份</button>
 </section>}
 {controller.recoveryReady&&!controller.pendingMessage&&<p role="status">{controller.draftSavePromise?'草稿正在保存，请等待保存完成后离开。':controller.draftDirty||draftSnapshot!==JSON.stringify(controller.draft)?'草稿尚未保存，请查看提示并保留当前页面。':'文字、回复引用和PDF文字引用已随当前账户与会话保存。'}</p>}

 {modelMutation.pending&&<p role="status">模型设置结果尚未确认。<button type="button" disabled={busy} onClick={()=>{if(conversation)changeModel(conversation.model);}}>重试原模型设置</button></p>}
 {messageArtifact&&messageArtifact.owner===taskDraftScope()&&<section aria-label="消息关联成果详情">
  <button type="button" onClick={()=>setMessageArtifact(undefined)}>关闭成果详情</button>
  <ConversationDisplayBoundary label="消息成果详情"><ActivityArtifactDetails key={JSON.stringify([messageArtifact.owner,id,messageArtifact.target.artifactId])} conversationId={id} target={messageArtifact.target} onOpen={target=>setMessageArtifact({owner:taskDraftScope(),target})}/></ConversationDisplayBoundary>
 </section>}
 {(uploadRecoveryError||uploads.recoveryError)&&<p role="alert">上传回执存储尚未确认，附件操作已暂停。<button type="button" disabled={busy||uploads.recoveryBusy} onClick={()=>setUploadRecoveryRevision(value=>value+1)}>重读上传回执</button></p>}
 {!uploads.recoveryReady&&!uploadRecoveryError&&<p role="status">正在读取原上传回执…</p>}
 {preview&&<section role="region" aria-label="附件预览" className="jot-file-preview"><h3>{preview.name}</h3><button onClick={()=>{previewRequest.current?.abort();previewRequest.current=undefined;setPreview(undefined);}}>关闭预览</button>{preview.loading&&<p role="status">正在读取文件内容…</p>}{preview.url&&<img src={preview.url} alt={preview.name}/>} {preview.text!==undefined&&<pre>{preview.text}</pre>}{preview.truncated&&<p>预览内容已截短</p>}{preview.unsupported&&<p>此文件暂不支持在线预览</p>}</section>}
 <input ref={fileInput} type="file" aria-label="添加文件" multiple hidden disabled={!state||busy||cancelWriter.pending||goalPending||messageLocked||uploads.blocked||uploads.unresolved||!maxBytes} onChange={select}/>
 {ordinary&&!chatMode&&conversation&&<aside className="jot-model-routing-status" aria-label="模型路由状态"><p role="status">{routingStatus.primary}</p><p>{routingStatus.fallbacks}</p></aside>}
 <input ref={folderInput} type="file" aria-label="添加文件夹" multiple hidden disabled={!state||busy||cancelWriter.pending||goalPending||messageLocked||uploads.blocked||uploads.unresolved||!maxBytes} onChange={select}/>
 {ordinary&&!chatMode&&goalMode&&<p role="status">目标模式</p>}
 <AssistantReplyQuoteAction root={conversationRegion} conversationId={id} disabled={quoteLocked} onAdd={addReplyQuote}/>
 <PromptComposer className={chatMode?'jot-prompt-chat':''} value={draft} onChange={editDraft} onSubmit={send} placeholder={ordinary&&!chatMode&&goalMode?'描述你的目标…':'输入消息…'} ariaLabel={ordinary?'对话消息':'角色消息'}
  disabled={!state||busy||goalPending||modelMutation.pending||modeWriter.pending||cancelWriter.pending||controller.recoveryBlocked||!!draftBackup&&!controller.pendingMessage||chatUnavailable&&!controller.pendingMessage} inputDisabled={messageLocked||modeWriter.pending||cancelWriter.pending} submitDisabled={controller.recoveryBlocked||!!draftBackup&&!controller.pendingMessage||voiceBusy||!controller.pendingMessage&&(!regionsReady||uploads.entries.length>0&&uploads.blocked||uploads.entries.some((entry:any)=>entry.status!=='ready')||ordinary&&goalMode&&!draft.trim()&&!quoteCount)} submitLabel={controller.pendingMessage?'重试原消息':run?(ordinary?'补充当前任务':'加入队列'):'发送'}
  selection={chatMode?undefined:conversation?.model} modelOptions={chatMode?[]:models} onSelectionChange={ordinary&&!chatMode&&!modeWriter.pending&&!cancelWriter.pending&&!run&&!messageLocked&&!uploads.entries.length&&!voiceBusy&&!goalPending&&!modelMutation.pending?changeModel:undefined}
  onAttach={()=>fileInput.current?.click()} attachDisabled={!state||busy||cancelWriter.pending||goalPending||messageLocked||uploads.blocked||uploads.unresolved||!maxBytes} uploadMenu={<button type="button" role="menuitem" disabled={!state||busy||cancelWriter.pending||goalPending||messageLocked||uploads.blocked||uploads.unresolved||!maxBytes} onClick={()=>folderInput.current?.click()}>添加文件夹</button>} onDropFiles={selectFiles} onDropError={error=>setError(error instanceof Error?error.message:'无法读取所选文件夹')}
   hasAttachments={controller.pendingMessage||uploads.entries.length>0||quoteCount>0} attachments={<><FileTextReferences references={fileReferences} disabled={quoteLocked} onChange={editFileReferences} imageFile={imageFile} resolveImage={imageArtifact} onOpen={openReferenceSource}/><AssistantReplyQuotes quotes={replyQuotes} disabled={quoteLocked} onChange={setReplyQuotes}/><UploadAttachments uploads={uploads} busy={busy} locked={uploads.blocked||cancelWriter.pending||goalPending||messageLocked||modeWriter.pending} onAction={operation=>void action(operation)} onUpload={uploadEntry} onCancel={cancelUpload} onCancelBatch={cancelUploadBatch}/></>}
  keepVoiceVisible voiceActive={voiceBusy} voiceControl={<VoiceInput id={id} voice={voice} disabled={!state||busy||goalPending||messageLocked||modelMutation.pending||modeWriter.pending||cancelWriter.pending||chatUnavailable} onText={appendTranscript} onBusyChange={setVoiceBusy}/>}
  goalMenu={ordinary&&!chatMode?<button type="button" role="menuitemcheckbox" disabled={messageLocked} aria-checked={goalMode} onClick={()=>setGoalMode(value=>!value)}>目标模式{goalMode?' ✓':''}</button>:undefined}
  responding={Boolean(run)} stopDisabled={busy||cancelWriter.pending||messageLocked||run?.status==='cancelling'} onStop={run?()=>cancelTask():undefined}/>
 </section></FileTextReferenceContext.Provider>;
}
