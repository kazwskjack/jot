import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {GitCheckoutReviewIntent} from './types';
import {pathId,workbenchApi} from './client';
import {useGitMutationReceipt} from './useGitMutationReceipt';
import GitCheckoutEvidence from './GitCheckoutEvidence';

type Command={path:string;body:Record<string,unknown>};
export default function GitCheckoutReview({project,snapshotId,targetRef,onClose,onBusy,initialReview}:{
 project:string;snapshotId:string;targetRef:string;onClose:()=>void;onBusy:(busy:boolean)=>void;initialReview?:GitCheckoutReviewIntent;
}){
 const mutation=useGitMutationReceipt(project),[review,setReview]=useState<GitCheckoutReviewIntent|null>(initialReview??null);
 const [busy,setBusy]=useState(false),[verified,setVerified]=useState(!!initialReview),[error,setError]=useState('');
 const alive=useRef(true),inflight=useRef(false),active=useRef<AbortController|null>(null),command=useRef<Command|null>(null),decision=useRef<HTMLButtonElement>(null);
 const report=useRef(onBusy);report.current=onBusy;
 const locked=busy||mutation.pending,referencePlan=review?.witness.reference_plan,logMetadata=review?.witness.log_metadata;
 const base=`/projects/${pathId(project)}/git/checkout-intents`;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;active.current?.abort();report.current(false)}},[project,snapshotId,targetRef]);
 useEffect(()=>{report.current(locked)},[locked]);
 useLayoutEffect(()=>{if(!review||verified)decision.current?.focus()},[review?.intent_id,verified]);
 const scoped=(value:GitCheckoutReviewIntent,id?:string)=>{
  if(value.project_id!==project||value.snapshot_id!==snapshotId||value.action!=='checkout-branch'||value.target_ref!==targetRef
   ||value.witness.project_id!==project||value.witness.snapshot_id!==snapshotId||value.witness.target.ref!==targetRef
   ||value.witness.preview.target_ref!==targetRef||value.witness.preview.target_oid!==value.witness.target.checkout_oid
   ||value.execution_authorized!==false||value.witness.execution_authorized!==false||id!==undefined&&value.intent_id!==id)throw Error('GIT_CHECKOUT_REVIEW_SCOPE_CHANGED');
  return value;
 };
 const check=(signal:AbortSignal)=>{signal.throwIfAborted();if(!alive.current)throw new DOMException('Aborted','AbortError')};
 const read=async(id:string,signal:AbortSignal)=>{const value=scoped(await workbenchApi.gitCheckoutReview(project,id,signal),id);check(signal);setReview(value);setVerified(true)};
 const begin=()=>{if(inflight.current)return null;inflight.current=true;const control=new AbortController();active.current=control;setBusy(true);setError('');return control};
 const end=()=>{inflight.current=false;if(alive.current)setBusy(false)};
 const send=async(kind:'prepare'|'cancel'|'retry')=>{
  const control=begin();if(!control)return;let received=false;
  try{
   if(!mutation.pending){
    if(kind==='prepare')command.current={path:base,body:{request_id:crypto.randomUUID(),action:'checkout-branch',target_ref:targetRef,snapshot_id:snapshotId}};
    else if(review&&kind==='cancel')command.current={path:base+'/'+pathId(review.intent_id)+'/control',body:{request_id:crypto.randomUUID(),expected_version:review.version,review_sha256:review.review_sha256,action:kind}};
    else throw Error('GIT_CHECKOUT_REVIEW_REQUEST_MISSING');
   }
   if(!command.current)throw Error('GIT_CHECKOUT_REVIEW_REQUEST_MISSING');
   const result=await mutation.submit(command.current.path,'POST',command.current.body) as GitCheckoutReviewIntent;received=true;command.current=null;
   check(control.signal);const value=scoped(result,kind==='prepare'?undefined:review?.intent_id);
   setReview(value);setVerified(false);await read(value.intent_id,control.signal);
  }catch(value){
   if(!alive.current||control.signal.aborted)return;
   const code=value instanceof Error?value.message:'',status=(value as {status?:number})?.status;
   if(received){setVerified(false);setError('审核回执已收到，当前状态尚未确认，请刷新审核状态。')}
   else if(['GIT_SNAPSHOT_CHANGED','GIT_REPOSITORY_CHANGED','GIT_REVIEW_CHANGED','GIT_CHECKOUT_TARGET_UNAVAILABLE'].includes(code)){
    setError('审核依据或目标已变化，请取消已有审核并刷新仓库。');
   }else if(code==='VERSION_CONFLICT'){setVerified(false);setError('审核状态已变化，请刷新审核状态。')}
   else if(!status||status>=500||status===408||code==='IDEMPOTENCY_IN_PROGRESS')setError('请求结果尚未确认，请保留此页并重试原请求。');
   else setError('审核未完成，请核对目标引用和仓库状态后重试。');
  }finally{end()}
 };
 const refresh=async()=>{if(!review)return;const control=begin();if(!control)return;try{await read(review.intent_id,control.signal)}catch{if(alive.current&&!control.signal.aborted){setVerified(false);setError('当前审核状态尚未确认，请重试读取。')}}finally{end()}};
 return <section className="wb-form wb-git-review" aria-label="Git 分支切换审核">
  <div className="wb-toolbar"><h3>分支切换审核</h3><button type="button" disabled={locked} onClick={onClose}>关闭切换审核</button></div>
  {!review?<><p>目标引用 <code>{targetRef}</code></p><button ref={decision} type="button" disabled={locked} onClick={()=>void send('prepare')}>固定切换审核内容</button></>:<>
   <p>审核 SHA-256 <code>{review.review_sha256}</code></p>
   <GitCheckoutEvidence preview={review.witness.preview} target={review.witness.target}/>
   {referencePlan?.state==='planned'?<section aria-label="切换引用预期"><h4>切换引用预期</h4>
    <dl><dt>HEAD 状态</dt><dd>{referencePlan.mode==='branch'?'本地分支':'分离 HEAD'} · <code>{referencePlan.head.branch??referencePlan.head.oid}</code></dd>
     <dt>HEAD 文件预期</dt><dd>{referencePlan.head_file.size} 字节 · SHA-256 <code>{referencePlan.head_file.sha256}</code></dd>
     <dt>HEAD 日志</dt><dd>{referencePlan.head_log.append?'追加切换记录':'按当前策略跳过日志追加'} · <code>{referencePlan.head_log.message}</code></dd>
     <dt>日志原提交</dt><dd><code>{referencePlan.head_log.old_oid}</code></dd><dt>日志目标提交</dt><dd><code>{referencePlan.head_log.new_oid}</code></dd>
     <dt>保留公共配置</dt><dd><code>{referencePlan.configuration.common_sha256??'原文件缺失'}</code></dd>
     <dt>保留工作区配置</dt><dd><code>{referencePlan.configuration.worktree_sha256??'独立配置未启用或原文件缺失'}</code></dd>
    </dl>
    {logMetadata?<dl aria-label="固定日志条目"><dt>日志操作者</dt><dd>{logMetadata.committer.name} &lt;{logMetadata.committer.email}&gt; · {logMetadata.committer.timestamp}</dd>
     <dt>追加条目</dt><dd>{logMetadata.entry_size} 字节 · SHA-256 <code>{logMetadata.entry_sha256}</code></dd></dl>:referencePlan.head_log.append&&<p role="status">日志操作者及条目字节尚未固定，需要项目仓库配置中的操作者身份。</p>}
    <p>目标引用的对象值保持原值。完整日志文件与工作区发布、批准及恢复方案继续补齐。</p>
   </section>:<p role="status">{referencePlan?.state==='policy_required'?'本地引用指向非 commit 对象，引用发布策略仍待补齐。':'此历史审核尚无引用变更预期，请重新生成审核以固定该内容。'}</p>}
   <p role="status">{!verified?'当前审核状态尚未确认。':review.state==='prepared'?'切换依据已固定，等待完整执行策略。':'审核已取消。'}</p>
   <div className="wb-actions">{review.state==='prepared'&&<button ref={decision} type="button" disabled={locked||!verified} onClick={()=>void send('cancel')}>取消切换审核</button>}
    <button ref={review.state==='cancelled'?decision:undefined} type="button" disabled={locked} onClick={()=>void refresh()}>刷新切换审核状态</button></div>
  </>}
  <p role="status">文件发布、引用、日志、跟踪及恢复策略仍需完整实现，后续接入审核批准与原生切换派发。</p>
  {error&&<p role="alert" className="wb-error">{error}</p>}
  {mutation.pending&&<button type="button" disabled={busy} onClick={()=>void send('retry')}>重试原切换审核请求</button>}
 </section>;
}
