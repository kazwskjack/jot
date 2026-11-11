import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {GitBranchReviewIntent,GitIndexStatus} from './types';
import {pathId,workbenchApi} from './client';
import {useGitMutationReceipt} from './useGitMutationReceipt';
import GitIndexOperation from './GitIndexOperation';
import {useApplicationLanguage} from '../jot/application-language';
import {gitUiMessage} from './git-ui-messages';

type Command={path:string;body:Record<string,unknown>};
export default function GitBranchReview({project,snapshotId,onClose,onBusy,allowExecution=false,initialReview,onChanged}:{
 project:string;snapshotId:string;onClose:()=>void;onBusy:(busy:boolean)=>void;allowExecution?:boolean;initialReview?:GitBranchReviewIntent;onChanged?:(status:GitIndexStatus)=>void;
}){
 const language=useApplicationLanguage(),message=(value:string)=>gitUiMessage(value,language);
 const mutation=useGitMutationReceipt(project),[name,setName]=useState(initialReview?.branch??''),[review,setReview]=useState<GitBranchReviewIntent|null>(initialReview??null);
 const [busy,setBusy]=useState(false),[executionBusy,setExecutionBusy]=useState(false),[verified,setVerified]=useState(!!initialReview),[stale,setStale]=useState(false),[error,setError]=useState('');
 const alive=useRef(true),inflight=useRef(false),active=useRef<AbortController|null>(null),command=useRef<Command|null>(null),input=useRef<HTMLInputElement>(null),decision=useRef<HTMLButtonElement>(null);
 const report=useRef(onBusy);report.current=onBusy;
 const locked=busy||mutation.pending||executionBusy,branch=review?.branch??name.trim(),completeMetadata=!!review?.branch_metadata?.configuration_sha256;
 const base=`/projects/${pathId(project)}/git/branch-intents`;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;active.current?.abort();report.current(false)}},[project,snapshotId]);
 useEffect(()=>{report.current(locked)},[locked]);
 useLayoutEffect(()=>{if(review){if(verified)decision.current?.focus()}else input.current?.focus()},[review?.intent_id,verified]);
 const scoped=(value:GitBranchReviewIntent,id?:string)=>{
  if(value.project_id!==project||value.snapshot_id!==snapshotId||value.action!=='create-branch'||value.branch!==branch
   ||value.target_ref!=='refs/heads/'+branch||value.execution_authorized!==false||id!==undefined&&value.intent_id!==id)throw Error('GIT_BRANCH_REVIEW_SCOPE_CHANGED');
  return value;
 };
 const check=(signal:AbortSignal)=>{signal.throwIfAborted();if(!alive.current)throw new DOMException('Aborted','AbortError')};
 const read=async(id:string,signal:AbortSignal)=>{const value=scoped(await workbenchApi.gitBranchReview(project,id,signal),id);check(signal);setReview(value);setVerified(true)};
 const begin=()=>{if(inflight.current)return null;inflight.current=true;const control=new AbortController();active.current=control;setBusy(true);setError('');return control};
 const end=()=>{inflight.current=false;if(alive.current)setBusy(false)};
 const send=async(kind:'prepare'|'approve'|'cancel'|'retry')=>{
  const control=begin();if(!control)return;let received=false;
  try{
   if(!mutation.pending){
    if(kind==='prepare')command.current={path:base,body:{request_id:crypto.randomUUID(),action:'create-branch',branch,snapshot_id:snapshotId}};
    else if(review&&(kind==='approve'||kind==='cancel'))command.current={path:base+'/'+pathId(review.intent_id)+'/control',body:{request_id:crypto.randomUUID(),expected_version:review.version,review_sha256:review.review_sha256,action:kind}};
    else throw Error('GIT_BRANCH_REVIEW_REQUEST_MISSING');
   }
   if(!command.current)throw Error('GIT_BRANCH_REVIEW_REQUEST_MISSING');
   const result=await mutation.submit(command.current.path,'POST',command.current.body) as GitBranchReviewIntent;received=true;command.current=null;
   check(control.signal);const value=scoped(result,kind==='prepare'?undefined:review?.intent_id);
   setReview(value);setVerified(false);await read(value.intent_id,control.signal);
  }catch(value){
   if(!alive.current||control.signal.aborted)return;
   const code=value instanceof Error?value.message:'',status=(value as {status?:number})?.status;
   if(received){setVerified(false);setError('审核回执已收到，当前状态尚未确认，请刷新审核状态。')}
   else if(['GIT_SNAPSHOT_CHANGED','GIT_REPOSITORY_CHANGED','GIT_REVIEW_CHANGED','GIT_BRANCH_REVIEW_CHANGED','GIT_BRANCH_SOURCE_CHANGED','GIT_BRANCH_REVIEW_REQUIRED'].includes(code)){
    setStale(true);setError('审核依据已变化或缺少完整元数据，请取消审核并刷新仓库。');
   }else if(code==='GIT_BRANCH_EXISTS')setError('分支已存在或引用名称冲突，请刷新仓库后核对。');
   else if(code==='GIT_BRANCH_INVALID')setError('分支名称无效，请修改后重新生成审核。');
   else if(code==='GIT_BRANCH_IDENTITY_UNCONFIGURED')setError('操作者尚未配置日志提交者身份，请完成项目仓库配置。');
   else if(code==='VERSION_CONFLICT'){setVerified(false);setError('审核状态已变化，请刷新审核状态。')}
   else if(!status||status>=500||status===408||code==='IDEMPOTENCY_IN_PROGRESS')setError('请求结果尚未确认，请保留此页并重试原请求。');
   else setError('审核未完成，请核对分支名称和仓库状态后重试。');
  }finally{end()}
 };
 const refresh=async()=>{if(!review)return;const control=begin();if(!control)return;try{await read(review.intent_id,control.signal)}catch{if(alive.current&&!control.signal.aborted){setVerified(false);setError('当前审核状态尚未确认，请重试读取。')}}finally{end()}};
 return <section lang={language} className="wb-form wb-git-review" aria-label={message("创建 Git 分支审核")}>
  <div className="wb-toolbar"><h3>{message("创建并切换分支")}</h3><button type="button" disabled={locked} onClick={onClose}>{message("关闭分支审核")}</button></div>
  {!review?<><label>{message("新分支名称")}<input ref={input} aria-label={message("新分支名称")} maxLength={1013} value={name} disabled={locked} onChange={event=>setName(event.target.value)}/></label><button type="button" disabled={locked||!branch} onClick={()=>void send('prepare')}>{message("生成分支审核")}</button></>:<>
   <dl aria-label={message("固定分支元数据")}>
    <dt>{message("新分支引用")}</dt><dd><code>{review.target_ref}</code></dd>
    <dt>{message("创建起点")}</dt><dd><code>{review.target_oid??message('尚无提交')}</code> · {review.object_format}</dd>
    <dt>{message("原 HEAD")}</dt><dd><code>{review.head.branch??message('分离 HEAD')}</code></dd>
    {review.branch_metadata&&<><dt>{message("日志提交者")}</dt><dd>{review.branch_metadata.committer.name} &lt;{review.branch_metadata.committer.email}&gt; · {review.branch_metadata.committer.timestamp}</dd>
     <dt>{message("日志追加")}</dt><dd>HEAD {review.branch_metadata.logs.head?message('追加'):message('跳过')}{message("，分支 ")}{review.branch_metadata.logs.branch?message('追加'):message('跳过')}</dd>
     <dt>{message("自动 tracking 配置")}</dt><dd>{review.branch_metadata.configuration_changed?message('写入已审核的新分支配置'):message('保留当前配置')}<code>{review.branch_metadata.configuration_sha256}</code></dd></>}
    <dt>{message("审核 SHA-256")}</dt><dd><code>{review.review_sha256}</code></dd>
   </dl>
   {!completeMetadata&&<p role="alert">{message("此历史审核缺少完整日志或配置信息，请取消并重新生成审核。")}</p>}
   <p role="status">{!verified?message('当前审核状态尚未确认。'):review.state==='prepared'?message('等待批准。'):review.state==='approved'?message('审核已批准。'):message('审核已取消。')}</p>
   <div className="wb-actions">{review.state==='prepared'&&<button ref={completeMetadata?decision:undefined} type="button" disabled={locked||!verified||stale||!completeMetadata} onClick={()=>void send('approve')}>{message("批准分支审核")}</button>}
    {review.state!=='cancelled'&&<button ref={review.state==='prepared'&&completeMetadata?undefined:decision} type="button" disabled={locked||!verified} onClick={()=>void send('cancel')}>{message("取消分支审核")}</button>}
    <button ref={review.state==='cancelled'?decision:undefined} type="button" disabled={locked} onClick={()=>void refresh()}>{message("刷新分支审核状态")}</button></div>
  </>}
  {review&&verified&&completeMetadata&&<GitIndexOperation key={review.intent_id} project={project} review={review} allowDispatch={false} allowBranchDispatch={allowExecution&&!stale} onBranchReviewChange={setReview} onBusy={setExecutionBusy} onChanged={onChanged}/>}
  {!allowExecution&&<p role="status">{message("创建分支派发需要匹配的原生连接、操作者身份和分支存储版本。")}</p>}
  {error&&<p role="alert" className="wb-error">{message(error)}</p>}
  {mutation.pending&&<button type="button" disabled={busy} onClick={()=>void send('retry')}>{message("重试原分支审核请求")}</button>}
 </section>;
}
