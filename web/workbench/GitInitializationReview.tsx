import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {GitInitializationReviewIntent} from './types';
import {pathId,workbenchApi} from './client';
import {useGitMutationReceipt} from './useGitMutationReceipt';
import GitIndexOperation from './GitIndexOperation';
import {mutationRejected} from './task-save-receipt.mjs';

type Command={path:string;body:Record<string,unknown>};
export default function GitInitializationReview({project,snapshotId,onClose,onBusy,allowExecution=false,allowReinitializationExecution=false,reinitializing=false,initialBranch='',initialObjectFormat='',initialReview,onInitialized,blocked=false}:{
 project:string;snapshotId:string;onClose:()=>void;onBusy:(busy:boolean)=>void;allowExecution?:boolean;allowReinitializationExecution?:boolean;reinitializing?:boolean;initialBranch?:string;initialObjectFormat?:''|'sha1'|'sha256';initialReview?:GitInitializationReviewIntent;onInitialized?:()=>void;blocked?:boolean;
}){
 const mutation=useGitMutationReceipt(project),[name,setName]=useState(initialReview?.initial_branch??initialBranch),[format,setFormat]=useState<''|'sha1'|'sha256'>(initialReview?.object_format??initialObjectFormat),[review,setReview]=useState<GitInitializationReviewIntent|null>(initialReview??null);
 const [busy,setBusy]=useState(false),[executionBusy,setExecutionBusy]=useState(false),[verified,setVerified]=useState(!!initialReview),[stale,setStale]=useState(false),[error,setError]=useState('');
 const alive=useRef(true),inflight=useRef(false),active=useRef<AbortController|null>(null),command=useRef<Command|null>(null),input=useRef<HTMLInputElement>(null),decision=useRef<HTMLButtonElement>(null);
 const report=useRef(onBusy);report.current=onBusy;
 const locked=busy||mutation.pending||executionBusy,branch=review?.initial_branch??name.trim(),objectFormat=review?.object_format??format;
 const base=`/projects/${pathId(project)}/git/initialization-intents`;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;active.current?.abort();report.current(false)}},[project,snapshotId]);
 useEffect(()=>{report.current(locked)},[locked]);
 useLayoutEffect(()=>{if(review){if(verified)decision.current?.focus()}else input.current?.focus()},[review?.intent_id,verified]);
 const scoped=(value:GitInitializationReviewIntent,id?:string)=>{
  if(value.project_id!==project||value.snapshot_id!==snapshotId||value.action!=='init'||value.initial_branch!==branch||value.object_format!==objectFormat||value.execution_authorized!==false||id!==undefined&&value.intent_id!==id)throw Error('GIT_INITIALIZATION_REVIEW_SCOPE_CHANGED');
  return value;
 };
 const check=(signal:AbortSignal)=>{signal.throwIfAborted();if(!alive.current)throw new DOMException('Aborted','AbortError')};
 const read=async(id:string,signal:AbortSignal)=>{const value=scoped(await workbenchApi.gitInitializationReview(project,id,signal),id);check(signal);setReview(value);setVerified(true)};
 const begin=()=>{if(inflight.current)return null;inflight.current=true;const control=new AbortController();active.current=control;setBusy(true);setError('');return control};
 const end=()=>{inflight.current=false;if(alive.current)setBusy(false)};
 const send=async(kind:'prepare'|'approve'|'cancel'|'retry')=>{
  const control=begin();if(!control)return;let received=false;
  try{
   if(!mutation.pending){
    if(kind==='prepare')command.current={path:base,body:{request_id:crypto.randomUUID(),action:'init',initial_branch:branch,object_format:objectFormat,snapshot_id:snapshotId}};
    else if(review&&(kind==='approve'||kind==='cancel'))command.current={path:base+'/'+pathId(review.intent_id)+'/control',body:{request_id:crypto.randomUUID(),expected_version:review.version,review_sha256:review.review_sha256,action:kind}};
    else throw Error('GIT_INITIALIZATION_REVIEW_REQUEST_MISSING');
   }
   if(!command.current)throw Error('GIT_INITIALIZATION_REVIEW_REQUEST_MISSING');
   const result=await mutation.submit(command.current.path,'POST',command.current.body) as GitInitializationReviewIntent;received=true;command.current=null;
   check(control.signal);const value=scoped(result,kind==='prepare'?undefined:review?.intent_id);
   setReview(value);setVerified(false);await read(value.intent_id,control.signal);
  }catch(value){
   if(!alive.current||control.signal.aborted)return;
   if(mutationRejected(value))command.current=null;
   const code=value instanceof Error?value.message:'',status=(value as {status?:number})?.status;
   if(received){setVerified(false);setError('审核回执已收到，当前状态尚未确认，请刷新审核状态。')}
   else if(['GIT_SNAPSHOT_CHANGED','GIT_REPOSITORY_CHANGED','GIT_REVIEW_CHANGED','GIT_INITIALIZATION_REVIEW_CHANGED','GIT_INITIALIZATION_SOURCE_CHANGED','GIT_INITIALIZATION_METADATA_PRESENT','GIT_REINITIALIZATION_REVIEW_REQUIRED','GIT_REINITIALIZATION_METADATA_CHANGED'].includes(code)){
    setStale(true);setError('初始化依据已变化，请取消审核并刷新项目仓库。');
   }else if(code==='GIT_INITIALIZATION_BRANCH_INVALID'||code==='GIT_INITIALIZATION_INVALID')setError('初始化参数无效，请核对初始分支名称与对象格式。');
   else if(code==='GIT_REPOSITORY_BUSY')setError('原仓库存在 Git 锁，请等待当前操作完成后重新核对审核。');
   else if(code==='GIT_REINITIALIZATION_OBJECT_FORMAT_CHANGED')setError('已有仓库的对象格式与请求不一致，请保留原格式重新生成审核。');
   else if(code==='GIT_INITIALIZATION_BINDING_INVALID')setError('当前仓库绑定需要先核对服务端初始化配置。');
   else if(code==='VERSION_CONFLICT'){setVerified(false);setError('审核状态已变化，请刷新审核状态。')}
   else if(!status||status>=500||status===408||code==='IDEMPOTENCY_IN_PROGRESS')setError('请求结果尚未确认，请保留此页并重试原请求。');
   else setError('审核未完成，请核对初始化参数和项目状态后重试。');
  }finally{end()}
 };
 const refresh=async()=>{if(!review)return;const control=begin();if(!control)return;try{await read(review.intent_id,control.signal)}catch{if(alive.current&&!control.signal.aborted){setVerified(false);setError('当前审核状态尚未确认，请重试读取。')}}finally{end()}};
 return <section className="wb-form wb-git-review" aria-label="初始化 Git 仓库审核">
  <div className="wb-toolbar"><h3>{review?.reinitialization||reinitializing?'重新初始化仓库':'初始化仓库'}</h3><button type="button" disabled={locked||blocked} onClick={onClose}>关闭初始化审核</button></div>
  {!review?<>
   <label>{reinitializing?'初始分支请求参数（保留原 HEAD）':'初始分支名称'}<input ref={input} aria-label={reinitializing?'重初始化的初始分支请求参数':'初始分支名称'} maxLength={1013} value={name} disabled={locked||blocked} onChange={event=>setName(event.target.value)}/></label>
   <label>对象格式<select aria-label="初始化对象格式" value={format} disabled={locked||blocked} onChange={event=>setFormat(event.target.value as ''|'sha1'|'sha256')}><option value="">请选择对象格式</option><option value="sha1">SHA-1</option><option value="sha256">SHA-256</option></select></label>
   <button type="button" disabled={locked||blocked||!branch||!objectFormat} onClick={()=>void send('prepare')}>生成初始化审核</button>
  </>:<>
   <dl aria-label="固定初始化元数据">
    <dt>{review.reinitialization?'请求初始分支参数':'初始分支'}</dt><dd><code>{review.initial_branch}</code></dd>
    <dt>对象格式</dt><dd>{review.object_format}</dd>
    <dt>内部忽略规则</dt><dd><code>{review.internal_ignore.path}</code> · {review.internal_ignore.changed?'写入审核后的规则':'保留当前规则'}</dd>
    <dt>规则原 SHA-256</dt><dd><code>{review.internal_ignore.before_sha256??'文件尚不存在'}</code></dd>
    <dt>规则审核后 SHA-256</dt><dd><code>{review.internal_ignore.after_sha256}</code> · {review.internal_ignore.size} 字节</dd>
    {review.reinitialization&&<>
     <dt>保留原 HEAD</dt><dd><code>{review.reinitialization.head.branch??'分离 HEAD'}</code> · <code>{review.reinitialization.head.oid??'尚无提交'}</code></dd>
     {review.reinitialization.layout_sha256&&<><dt>原目录布局 SHA-256</dt><dd><code>{review.reinitialization.layout_sha256}</code></dd></>}
     <dt>原仓库元数据 SHA-256</dt><dd><code>{review.reinitialization.source_metadata_sha256}</code></dd>
     {review.reinitialization.configuration&&<>
      <dt>文件模式探测为 false 的配置 SHA-256</dt><dd><code>{review.reinitialization.configuration.filemode_false_sha256}</code></dd>
      <dt>文件模式探测为 true 的配置 SHA-256</dt><dd><code>{review.reinitialization.configuration.filemode_true_sha256}</code></dd>
     </>}
     <dt>原公共配置 SHA-256</dt><dd><code>{review.reinitialization.common_config_sha256??'文件尚不存在'}</code></dd>
     <dt>原工作树配置 SHA-256</dt><dd><code>{review.reinitialization.worktree_config_sha256??'文件尚不存在'}</code> · {review.reinitialization.worktree_config_enabled?'已启用':'未启用'}</dd>
    </>}
    <dt>审核 SHA-256</dt><dd><code>{review.review_sha256}</code></dd>
   </dl>
   <p role="status">{!verified?'当前审核状态尚未确认。':review.state==='prepared'?'等待批准。':review.state==='approved'?'审核已批准。':'审核已取消。'}</p>
   <div className="wb-actions">{review.state==='prepared'&&<button ref={decision} type="button" disabled={locked||blocked||!verified||stale} onClick={()=>void send('approve')}>批准初始化审核</button>}
    {review.state!=='cancelled'&&<button ref={review.state==='prepared'?undefined:decision} type="button" disabled={locked||blocked||!verified} onClick={()=>void send('cancel')}>取消初始化审核</button>}
    <button ref={review.state==='cancelled'?decision:undefined} type="button" disabled={locked||blocked} onClick={()=>void refresh()}>刷新初始化审核状态</button></div>
  </>}
  {review&&verified&&<GitIndexOperation key={review.intent_id} project={project} review={review} allowDispatch={false} allowInitializationDispatch={allowExecution&&!stale&&!blocked} allowReinitializationDispatch={allowReinitializationExecution&&!stale&&!blocked} onInitializationReviewChange={setReview} onBusy={setExecutionBusy} onInitializationConfirmed={onInitialized}/>}
  {review?.reinitialization&&<p role="status">本次审核固定原 HEAD、配置与内部忽略规则。批准后可受理，再单独派发重初始化。</p>}
  {!(review?.reinitialization||reinitializing?allowReinitializationExecution:allowExecution)&&<p role="status">当前初始化操作需要匹配的原生连接和存储版本。</p>}
  {error&&<p role="alert" className="wb-error">{error}</p>}
  {mutation.pending&&<button type="button" disabled={busy||executionBusy} onClick={()=>void send('retry')}>重试原初始化审核请求</button>}
 </section>;
}
