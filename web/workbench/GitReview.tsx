import React,{useEffect,useRef,useState} from 'react';
import type {GitReviewPrepare,GitReviewIntent} from './types';
import {pathId,workbenchApi} from './client';
import {useMutationReceipt} from './useMutationReceipt';
export type GitReviewDraft={project:string;snapshot:string;paths:string[];action:GitReviewPrepare['action'];actions:GitReviewPrepare['action'][]};
const titles:Record<GitReviewPrepare['action'],string>={stage:'暂存选定文件',unstage:'取消选定文件的暂存',commit:'提交全部已暂存文件',discard:'丢弃选定的工作区修改','delete-untracked':'删除选定的未跟踪文件'};
type Command={path:string;body:unknown};
export default function GitReview({draft,onClose,onBusy}:{draft:GitReviewDraft;onClose:()=>void;onBusy:(busy:boolean)=>void}){
 const mutation=useMutationReceipt(),[action,setAction]=useState(draft.action),[message,setMessage]=useState(''),[review,setReview]=useState<GitReviewIntent|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[verified,setVerified]=useState(false),[stale,setStale]=useState(false);
 const command=useRef<Command|null>(null),alive=useRef(true),inflight=useRef(false),base=`/projects/${pathId(draft.project)}/git/intents`;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;onBusy(false);};},[onBusy]);
 const locked=busy||mutation.pending;
 const begin=()=>{if(inflight.current)return false;inflight.current=true;setBusy(true);setError('');onBusy(true);return true;};
 const end=()=>{inflight.current=false;if(alive.current){setBusy(false);onBusy(false);}};
 const readCurrent=async(id:string)=>{const current=await workbenchApi.gitReview(draft.project,id);if(current.project_id!==draft.project||current.snapshot_id!==draft.snapshot||current.intent_id!==id)throw Error('GIT_REVIEW_SCOPE_CHANGED');if(alive.current){setReview(current);setVerified(true);}};
 const send=async(kind:'prepare'|'approve'|'cancel'|'retry')=>{
  if(!begin())return;let accepted=false;
  try{
   if(!mutation.pending){
    if(kind==='prepare')command.current={path:base,body:{request_id:crypto.randomUUID(),action,paths:draft.paths,snapshot_id:draft.snapshot,...(action==='commit'?{message}:{})}};
    else if(review&&['approve','cancel'].includes(kind))command.current={path:base+'/'+pathId(review.intent_id)+'/control',body:{request_id:crypto.randomUUID(),expected_version:review.version,action:kind,review_sha256:review.review_sha256}};
    else throw Error('GIT_REVIEW_REQUEST_MISSING');
   }
   if(!command.current)throw Error('GIT_REVIEW_REQUEST_MISSING');
   const receipt=await mutation.submit(command.current.path,'POST',command.current.body) as GitReviewIntent;accepted=true;command.current=null;
   if(!alive.current)return;
   setReview(receipt);setVerified(false);await readCurrent(receipt.intent_id);
  }catch(value){if(!alive.current)return;const code=value instanceof Error?value.message:'',status=(value as {status?:number})?.status;
   if(accepted){setVerified(false);setError('审核回执已收到，当前状态尚未确认。请刷新审核状态。');}
   else if(['GIT_SNAPSHOT_CHANGED','GIT_REPOSITORY_CHANGED','GIT_REVIEW_CHANGED'].includes(code)){setStale(true);setError('文件已变化，请取消或关闭审核，再刷新仓库。');}
   else if(code==='VERSION_CONFLICT'){setVerified(false);setError('审核状态已变化，请刷新审核状态。');}
   else if(!status||status>=500||status===408||code==='IDEMPOTENCY_IN_PROGRESS')setError('结果尚未确认。请保留此页，重试原请求。');
   else setError(code==='PROJECT_NOT_FOUND'?'项目已不可用，请重新核对。':status===404?'此服务暂不支持审核，请核对服务版本。':'审核未完成，请核对当前变更后重试。');
  }finally{end();}
 };
 const refresh=async()=>{if(!review||!begin())return;try{await readCurrent(review.intent_id);}catch{if(alive.current){setVerified(false);setError('当前审核状态尚未确认，请重试读取。');}}finally{end();}};
 return <section className="wb-form wb-git-review" aria-label="Git 变更审核"><div className="wb-toolbar"><h3>变更审核</h3><button type="button" disabled={locked} onClick={onClose}>关闭审核</button></div><p>审核不会修改仓库。</p><ul>{draft.paths.map(path=><li key={path}><code>{path}</code></li>)}</ul>
  {!review?<><fieldset disabled={locked}><label>计划操作<select aria-label="计划操作" value={action} onChange={e=>setAction(e.target.value as GitReviewPrepare['action'])}>{draft.actions.map(value=><option key={value} value={value}>{titles[value]}</option>)}</select></label>{action==='commit'&&<label>提交说明<textarea aria-label="提交说明" maxLength={4096} value={message} onChange={e=>setMessage(e.target.value)}/></label>}</fieldset><button type="button" disabled={busy||mutation.pending||action==='commit'&&!message.trim()} onClick={()=>void send('prepare')}>生成审核</button></>
   :<><p><strong>{titles[review.action]}</strong></p>{review.message&&<p>{review.message}</p>}<p role="status">{!verified?'当前审核状态尚未确认。':review.state==='prepared'?'等待批准，尚未执行。':review.state==='approved'?'审核已批准，尚未执行。':'审核已取消。'}</p><div className="wb-actions">{review.state==='prepared'&&<button type="button" disabled={locked||!verified||stale} onClick={()=>void send('approve')}>批准审核</button>}{review.state!=='cancelled'&&<button type="button" disabled={locked||!verified} onClick={()=>void send('cancel')}>取消审核</button>}<button type="button" disabled={locked} onClick={()=>void refresh()}>刷新审核状态</button></div></>}
  {error&&<p role="alert" className="wb-error">{error}</p>}{mutation.pending&&<button type="button" disabled={busy} onClick={()=>void send('retry')}>重试原请求</button>}
 </section>;
}
