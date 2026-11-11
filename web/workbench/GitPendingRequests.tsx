import {useApplicationLanguage} from '../jot/application-language';
import {gitUiMessage} from './git-ui-messages';
import React,{useCallback,useContext,useEffect,useMemo,useRef,useState} from 'react';
import {taskDraftScope} from '../jot/client';import {GitCommandDraftStore,listGitCommandDrafts,gitCommandDraftEvent} from './git-command-draft.mjs';import {MutationPending,useMutationReceipt} from './useMutationReceipt';import {workbenchApi} from './client';
import type {GitReviewIntent,GitBranchReviewIntent,GitCheckoutReviewIntent,GitInitializationReviewIntent,GitIndexAcceptance} from './types';import GitReview from './GitReview';import GitCheckoutReview from './GitCheckoutReview';import GitBranchReview from './GitBranchReview';import GitIndexOperation from './GitIndexOperation';import GitInitializationReview from './GitInitializationReview';
type Hint=ReturnType<typeof listGitCommandDrafts>[number];
function PendingRow({row,scope,project,onKnown}:{row:Hint;scope:string;project:string;onKnown:(value:any,hint:Hint)=>Promise<void>}){
 const language=useApplicationLanguage(),message=(value:string)=>gitUiMessage(value,language);
 const store=useMemo(()=>new GitCommandDraftStore(()=>window.localStorage,scope,project,row.key),[scope,project,row.key]),receipt=useMutationReceipt(store,()=>row.key),[busy,setBusy]=useState(false),[error,setError]=useState(''),alive=useRef(true),inflight=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 const retry=async()=>{if(inflight.current)return;inflight.current=true;setBusy(true);setError('');try{const value=await receipt.submit(row.command.path,row.command.method,row.command.body);if(alive.current)await onKnown(value,row)}catch{if(alive.current)setError('原请求仍未确认，请保留原记录重试。')}finally{inflight.current=false;if(alive.current)setBusy(false)}};
 return <li lang={language}><p>{row.kind==='admit'?message('Git 操作受理'):row.kind==='control'?message('原操作确认'):row.kind.startsWith('initialization-review')?message('初始化审核'):row.kind.startsWith('checkout-review')?message('切换审核'):row.kind.startsWith('branch-review')?message('分支审核'):message('变更审核')} · <code>{row.command.body.request_id}</code></p><button type="button" disabled={busy} onClick={()=>void retry()}>{message("重试原请求并确认")}</button>{error&&<p role="alert">{message(error)}</p>}</li>;
}
export default function GitPendingRequests({project,allowDispatch,allowCommitDispatch=false,allowBranchDispatch=false,allowInitializationDispatch=false,allowReinitializationDispatch=false,onInitialized,onPending}:{project:string;allowDispatch:boolean;allowCommitDispatch?:boolean;allowBranchDispatch?:boolean;allowInitializationDispatch?:boolean;allowReinitializationDispatch?:boolean;onInitialized?:()=>void;onPending:(value:boolean)=>void}){
 const language=useApplicationLanguage(),message=(value:string)=>gitUiMessage(value,language);
 const scope=taskDraftScope(),[rows,setRows]=useState<Hint[]>([]),[error,setError]=useState(''),[readError,setReadError]=useState(''),[readRetry,setReadRetry]=useState<{result:any;hint:Hint}|null>(null),[known,setKnown]=useState(false),[view,setView]=useState<{review?:GitReviewIntent|GitBranchReviewIntent|GitCheckoutReviewIntent|GitInitializationReviewIntent;accepted?:GitIndexAcceptance}|null>(null),[childBusy,setChildBusy]=useState(false),report=useContext(MutationPending),alive=useRef(true),controller=useRef<AbortController|null>(null);
 const load=useCallback(()=>{try{setRows(listGitCommandDrafts(()=>window.localStorage,scope,project));setError('')}catch{setError('本地原请求记录暂时无法读取，请核对会话后重试。')}},[scope,project]);
 useEffect(()=>{alive.current=true;load();window.addEventListener(gitCommandDraftEvent,load);window.addEventListener('storage',load);return()=>{alive.current=false;controller.current?.abort();window.removeEventListener(gitCommandDraftEvent,load);window.removeEventListener('storage',load);onPending(false);report(false)}},[load,onPending,report]);
 useEffect(()=>{const blocked=rows.length>0||!!error||childBusy;onPending(blocked);if(blocked)report(true)},[rows,error,childBusy,onPending,report]);
 const confirmed=async(result:any,hint:Hint)=>{
  if(!alive.current)return;setKnown(true);setReadError('');setReadRetry({result,hint});setView(null);const c=new AbortController();controller.current?.abort();controller.current=c;
  try{
   if(hint.kind==='initialization-review-prepare'||hint.kind==='initialization-review-control'){
    const id=hint.kind==='initialization-review-control'?hint.intent_id:result?.intent_id;if(typeof id!=='string')throw Error('GIT_REQUEST_SCOPE_CHANGED');
    const r=await workbenchApi.gitInitializationReview(project,id,c.signal);c.signal.throwIfAborted();
    if(r.project_id!==project||r.intent_id!==id||r.action!=='init'||r.execution_authorized!==false
     ||hint.kind==='initialization-review-prepare'&&(r.snapshot_id!==hint.command.body.snapshot_id||r.initial_branch!==hint.command.body.initial_branch||r.object_format!==hint.command.body.object_format))throw Error('GIT_REQUEST_SCOPE_CHANGED');
    if(alive.current)setView({review:r});
   }else if(hint.kind==='checkout-review-prepare'||hint.kind==='checkout-review-control'){
    const id=hint.kind==='checkout-review-control'?hint.intent_id:result?.intent_id;if(typeof id!=='string')throw Error('GIT_REQUEST_SCOPE_CHANGED');
    const r=await workbenchApi.gitCheckoutReview(project,id,c.signal);c.signal.throwIfAborted();
    if(r.project_id!==project||r.intent_id!==id||r.action!=='checkout-branch'||r.execution_authorized!==false
     ||hint.kind==='checkout-review-prepare'&&(r.target_ref!==hint.command.body.target_ref||r.snapshot_id!==hint.command.body.snapshot_id))throw Error('GIT_REQUEST_SCOPE_CHANGED');
    if(alive.current)setView({review:r});
   }else if(hint.kind==='branch-review-prepare'||hint.kind==='branch-review-control'){
    const id=hint.kind==='branch-review-control'?hint.intent_id:result?.intent_id;if(typeof id!=='string')throw Error('GIT_REQUEST_SCOPE_CHANGED');
    const r=await workbenchApi.gitBranchReview(project,id,c.signal);c.signal.throwIfAborted();
    if(r.project_id!==project||r.intent_id!==id||r.action!=='create-branch'||r.execution_authorized!==false
     ||hint.kind==='branch-review-prepare'&&(r.branch!==hint.command.body.branch||r.snapshot_id!==hint.command.body.snapshot_id))throw Error('GIT_REQUEST_SCOPE_CHANGED');
    if(alive.current)setView({review:r});
   }else if(hint.kind==='review-prepare'||hint.kind==='review-control'){
    const id=hint.kind==='review-control'?hint.intent_id:result?.intent_id;if(typeof id!=='string')throw Error('GIT_REQUEST_SCOPE_CHANGED');const r=await workbenchApi.gitReview(project,id,c.signal);c.signal.throwIfAborted();if(r.project_id!==project||r.intent_id!==id||r.execution_authorized!==false)throw Error('GIT_REQUEST_SCOPE_CHANGED');if(alive.current)setView({review:r});
   }else{
    let request=hint.command.body.request_id;
    if(hint.kind==='control'){const s=await workbenchApi.gitStatus(project,hint.execution_id!,c.signal);if(s.execution.project_id!==project||s.execution.execution_id!==hint.execution_id||!s.control||s.control.request_id!==hint.command.body.request_id||s.control.expected_state_sha256!==hint.command.body.expected_state_sha256)throw Error('GIT_REQUEST_SCOPE_CHANGED');request=s.execution.request_id}
    const a=await workbenchApi.gitAcceptance(project,request,c.signal);c.signal.throwIfAborted();if(a.project_id!==project||a.accepted!==true||a.execution_authorized!==false||(hint.kind==='admit'?a.intent_id!==hint.intent_id:a.execution_id!==hint.execution_id))throw Error('GIT_REQUEST_SCOPE_CHANGED');if(alive.current)setView({accepted:a});
   }
   if(alive.current)setReadRetry(null);
  }catch{if(alive.current&&!c.signal.aborted)setReadError('原请求已确认，当前记录尚未读取，请重试读取。')}finally{if(alive.current)load()}
 };
 return <section lang={language} aria-label={message("未确认的 Git 请求")}>{rows.length>0&&<><p>{message("发现未确认的原请求。读取记录不会重新执行。")}</p><ul>{rows.map(row=><PendingRow key={row.key} row={row} scope={scope} project={project} onKnown={confirmed}/>)}</ul></>}{known&&<p role="status">{message("原请求已确认。")}</p>}{error&&<p role="alert">{message(error)}<button type="button" onClick={load}>{message("重新读取原请求")}</button></p>}
  {readError&&<p role="alert">{message(readError)}{readRetry&&<button type="button" onClick={()=>void confirmed(readRetry.result,readRetry.hint)}>{message("重新读取已确认记录")}</button>}</p>}
  {view?.review?.action==='init'&&<GitInitializationReview key={view.review.intent_id} project={project} snapshotId={view.review.snapshot_id} initialReview={view.review} onClose={()=>setView(null)} onBusy={setChildBusy} allowExecution={allowInitializationDispatch} allowReinitializationExecution={allowReinitializationDispatch} onInitialized={onInitialized}/>}
  {view?.review?.action==='create-branch'&&<GitBranchReview key={view.review.intent_id} project={project} snapshotId={view.review.snapshot_id} initialReview={view.review} onClose={()=>setView(null)} onBusy={setChildBusy} allowExecution={allowBranchDispatch}/>}
  {view?.review?.action==='checkout-branch'&&<GitCheckoutReview key={view.review.intent_id} project={project} snapshotId={view.review.snapshot_id} targetRef={view.review.target_ref} initialReview={view.review} onClose={()=>setView(null)} onBusy={setChildBusy}/>}
  {view?.review&&view.review.action!=='init'&&view.review.action!=='create-branch'&&view.review.action!=='checkout-branch'&&<GitReview key={view.review.intent_id} draft={{project,snapshot:view.review.snapshot_id,paths:view.review.paths,action:view.review.action,actions:[view.review.action]}} initialReview={view.review} onClose={()=>setView(null)} onBusy={setChildBusy} allowIndexExecution={allowDispatch&&['stage','unstage'].includes(view.review.action)} allowCommitExecution={allowCommitDispatch&&view.review.action==='commit'}/>}
  {view?.accepted&&<GitIndexOperation key={view.accepted.execution_id} project={project} acceptance={view.accepted} allowDispatch={allowDispatch} allowCommitDispatch={allowCommitDispatch} allowBranchDispatch={allowBranchDispatch} allowInitializationDispatch={allowInitializationDispatch} allowReinitializationDispatch={allowReinitializationDispatch} onInitializationConfirmed={onInitialized} onBusy={setChildBusy}/>}
 </section>;
}
