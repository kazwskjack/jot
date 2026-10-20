import React,{useEffect,useRef,useState} from 'react';
import type {GitIndexAcceptance,GitIndexStatus,GitIndexControlInput,GitReviewIntent} from './types';
import {pathId,workbenchApi} from './client';import {useMutationReceipt} from './useMutationReceipt';
type Pending={kind:'admit'|'control'|'review-cancel';path:string;body:Record<string,unknown>};
function checkAcceptance(a:GitIndexAcceptance,project:string,intent:string){if(a.project_id!==project||a.intent_id!==intent||a.accepted!==true||a.execution_authorized!==false||!['stage','unstage'].includes(a.action))throw Error('GIT_INDEX_SCOPE_CHANGED');return a}
function checkedStatus(s:GitIndexStatus,a:GitIndexAcceptance){const e=s.execution;if(e.execution_id!==a.execution_id||e.project_id!==a.project_id||e.intent_id!==a.intent_id||e.request_id!==a.request_id||e.action!==a.action||s.producer.execution_id!==a.execution_id||s.execution_authorized!==false||e.execution_authorized!==false||s.producer.execution_authorized!==false)throw Error('GIT_INDEX_SCOPE_CHANGED');return s}
const ready=(s:GitIndexStatus)=>s.execution.state==='pending'&&s.producer.state==='not_started'&&s.workspace_state==='not_reserved'&&!s.control;
const finished=(s:GitIndexStatus)=>s.execution.state==='applied'&&s.workspace_state==='released_settled'||['not_dispatched','abandoned_unknown'].includes(s.execution.state)&&s.workspace_state!=='reserved';

/** Same original admission/receipt authority. Native response loss triggers
 * read-only reconciliation, never an automatic replay of physical effects. */
export default function GitIndexOperation({project,review,acceptance,allowDispatch,onBusy,onReviewChange,onChanged,refreshToken=0}:{project:string;review?:GitReviewIntent;acceptance?:GitIndexAcceptance;allowDispatch:boolean;onBusy?:(value:boolean)=>void;onReviewChange?:(review:GitReviewIntent)=>void;onChanged?:()=>void;refreshToken?:number}){
 const mutation=useMutationReceipt(),[accepted,setAccepted]=useState<GitIndexAcceptance|null>(acceptance??null),[status,setStatus]=useState<GitIndexStatus|null>(null),[currentReview,setCurrentReview]=useState<GitReviewIntent|null>(review??null),[verified,setVerified]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[ack,setAck]=useState(false),[attempted,setAttempted]=useState(false);
 const command=useRef<Pending|null>(null),alive=useRef(true),inflight=useRef(false),active=useRef<AbortController|null>(null),report=useRef(onBusy),changed=useRef(onChanged),reviewChanged=useRef(onReviewChange),reviewSnapshot=useRef<GitReviewIntent|null>(review??null);report.current=onBusy;changed.current=onChanged;reviewChanged.current=onReviewChange;
 const intent=acceptance?.intent_id??review?.intent_id??'',base=`/projects/${pathId(project)}/git`,isClosed=!!status&&finished(status);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;active.current?.abort();report.current?.(false)}},[project,intent]);
 useEffect(()=>{report.current?.(busy||mutation.pending)},[busy,mutation.pending]);
 useEffect(()=>{if(review){reviewSnapshot.current=review;setCurrentReview(review)}},[review?.intent_id,review?.version,review?.state]);
 const check=(signal:AbortSignal)=>{signal.throwIfAborted();if(!alive.current)throw new DOMException('Aborted','AbortError')};
 const read=async(a:GitIndexAcceptance,signal:AbortSignal)=>{
  checkAcceptance(a,project,intent);const [s,r]=await Promise.all([workbenchApi.gitStatus(project,a.execution_id,signal),workbenchApi.gitReview(project,intent,signal)]);check(signal);checkedStatus(s,a);
  if(r.intent_id!==intent||r.project_id!==project||r.action!==a.action||r.execution_authorized!==false)throw Error('GIT_INDEX_SCOPE_CHANGED');
  reviewSnapshot.current=r;setAccepted(a);setStatus(s);setCurrentReview(r);setVerified(true);setAck(false);reviewChanged.current?.(r);changed.current?.();return s;
 };
 const begin=()=>{if(inflight.current)return null;inflight.current=true;const c=new AbortController();active.current=c;setBusy(true);setError('');return c};
 const end=()=>{inflight.current=false;if(alive.current)setBusy(false)};
 const fail=()=>{if(alive.current){setVerified(false);setError('结果尚未确认，请读取原操作状态。不会自动重新执行。')}};
 const refresh=async()=>{if(!accepted)return;const c=begin();if(!c)return;try{await read(accepted,c.signal)}catch{fail()}finally{end()}};
 useEffect(()=>{if(!acceptance)return;const c=new AbortController();read(acceptance,c.signal).catch(()=>{if(!c.signal.aborted)fail()});return()=>c.abort()},[project,acceptance?.execution_id,refreshToken]);
 const dispatch=async(a:GitIndexAcceptance,c:AbortController)=>{
  setAttempted(true);setVerified(false);
  try{await workbenchApi.gitDispatch(project,a.execution_id,crypto.randomUUID(),c.signal);check(c.signal);await read(a,c.signal)}
  catch{fail();if(!c.signal.aborted&&alive.current)try{const s=await read(a,c.signal);if(finished(s))setError('')}catch{}}
 };
 const admit=async(retry=false)=>{
  const c=begin();if(!c)return;
  try{
   if(!command.current){if(!allowDispatch||!review||review.state!=='approved'||!['stage','unstage'].includes(review.action))throw Error('GIT_INDEX_SCOPE_CHANGED');command.current={kind:'admit',path:base+'/intents/'+pathId(intent)+'/admissions',body:{request_id:crypto.randomUUID(),expected_version:review.version,review_sha256:review.review_sha256}}}
   if(command.current.kind!=='admit')throw Error('GIT_INDEX_SCOPE_CHANGED');
   const a=checkAcceptance(await mutation.submit(command.current.path,'POST',command.current.body) as GitIndexAcceptance,project,intent);check(c.signal);command.current=null;setAccepted(a);const s=await read(a,c.signal);
   // Recovering an atomic admission response does not replay the subsequent I/O.
   const approval=reviewSnapshot.current;
   if(!retry&&ready(s)&&approval?.state==='approved'&&approval.review_sha256===review?.review_sha256&&approval.version===review?.version)await dispatch(a,c);
  }catch{fail()}finally{end()}
 };
 const execute=async()=>{if(!accepted){await admit();return}if(!status||!verified||!ready(status)||attempted||!allowDispatch||currentReview?.state!=='approved')return;const c=begin();if(!c)return;try{await dispatch(accepted,c)}finally{end()}};
 const recover=async(retry=false)=>{
  if(!accepted)return;const c=begin();if(!c)return;
  try{
   let input:GitIndexControlInput;
   if(command.current){if(command.current.kind!=='control')throw Error('GIT_INDEX_SCOPE_CHANGED');input=command.current.body as GitIndexControlInput}
   else if(status?.control){input={request_id:status.control.request_id,expected_state_sha256:status.control.expected_state_sha256,acknowledge_unknown:true}}
   else{if(!status||!verified||!ack||finished(status))throw Error('GIT_INDEX_SCOPE_CHANGED');input={request_id:crypto.randomUUID(),expected_state_sha256:status.state_sha256,acknowledge_unknown:true};command.current={kind:'control',path:base+'/executions/'+pathId(accepted.execution_id)+'/controls',body:input}}
   if(command.current){const value=await mutation.submit(command.current.path,'POST',command.current.body) as {execution_id:string;project_id:string;request_id:string;expected_state_sha256:string;accepted:boolean;execution_authorized:boolean};check(c.signal);if(value.execution_id!==accepted.execution_id||value.project_id!==project||value.request_id!==input.request_id||value.expected_state_sha256!==input.expected_state_sha256||value.accepted!==true||value.execution_authorized!==false)throw Error('GIT_INDEX_SCOPE_CHANGED');command.current=null;await read(accepted,c.signal)}
   if(retry)return;
   setVerified(false);await workbenchApi.gitResolve(project,accepted.execution_id,input,crypto.randomUUID(),c.signal);check(c.signal);await read(accepted,c.signal);
  }catch{fail();if(!mutation.pending&&!c.signal.aborted&&alive.current)try{const s=await read(accepted,c.signal);if(finished(s))setError('')}catch{}}
  finally{end()}
 };
 const cancelReview=async()=>{
  if(!accepted)return;const c=begin();if(!c)return;
  try{
   if(!command.current){if(!verified||!currentReview||currentReview.state!=='approved'||!status||finished(status))throw Error('GIT_INDEX_SCOPE_CHANGED');command.current={kind:'review-cancel',path:base+'/intents/'+pathId(intent)+'/control',body:{request_id:crypto.randomUUID(),expected_version:currentReview.version,review_sha256:currentReview.review_sha256,action:'cancel'}}}
   if(command.current.kind!=='review-cancel')throw Error('GIT_INDEX_SCOPE_CHANGED');const r=await mutation.submit(command.current.path,'POST',command.current.body) as GitReviewIntent;check(c.signal);if(r.project_id!==project||r.intent_id!==intent||r.state!=='cancelled'||r.execution_authorized!==false)throw Error('GIT_INDEX_SCOPE_CHANGED');command.current=null;await read(accepted,c.signal);
  }catch{fail()}finally{end()}
 };
 const locked=busy||mutation.pending,canExecute=allowDispatch&&!attempted&&(accepted?verified&&!!status&&ready(status)&&currentReview?.state==='approved':review?.state==='approved');
 return <section className="wb-form" aria-label="选定文件执行"><p role="status">{!accepted?'只执行本次批准的选定文件，不提交或丢弃工作区内容。':!verified?'当前执行状态尚未确认。':status?.execution.state==='applied'&&status.workspace_state==='released_settled'?'变更已应用，工作区已释放。':isClosed&&status?.execution.state==='not_dispatched'?'操作未执行，工作区已释放。':isClosed?'操作已结束，实际效果仍未确认。':status?.workspace_state==='reserved'?'原操作仍占用工作区，尚未完成收尾。':'操作已受理，尚未执行。'}</p>
  {accepted&&<p style={{overflowWrap:'anywhere'}}><code>{accepted.execution_id}</code></p>}{status&&<ul>{status.execution.paths.map(path=><li key={path} style={{overflowWrap:'anywhere'}}><code>{path}</code></li>)}</ul>}
  {!isClosed&&canExecute&&<button type="button" disabled={locked} onClick={()=>void execute()}>执行选定变更</button>}
  {accepted&&<button type="button" disabled={locked} onClick={()=>void refresh()}>刷新执行状态</button>}
  {accepted&&verified&&!isClosed&&currentReview?.state==='approved'&&<button type="button" disabled={locked} onClick={()=>void cancelReview()}>取消原审核</button>}
  {accepted&&verified&&status&&!isClosed&&!mutation.pending&&<div>{!status.control&&<label><input type="checkbox" checked={ack} disabled={busy} onChange={event=>setAck(event.target.checked)}/>我已核对当前结果，确认结束原操作；这不会回滚未知变更。</label>}<button type="button" disabled={busy||!status.control&&!ack} onClick={()=>void recover()}>{status.control?'完成原操作收尾':'核对并结束原操作'}</button></div>}
  {mutation.pending&&<button type="button" disabled={busy} onClick={()=>void(command.current?.kind==='admit'?admit(true):command.current?.kind==='review-cancel'?cancelReview():recover(true))}>{command.current?.kind==='admit'?'重试原受理请求':command.current?.kind==='review-cancel'?'重试原取消请求':'重试原确认请求'}</button>}
  {error&&<p role="alert" className="wb-error">{error}</p>}
 </section>;
}
