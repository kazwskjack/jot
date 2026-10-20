import React,{useEffect,useRef,useState} from 'react';
import {request} from '../jot/client';
import {validateWorkReview} from '../jot/review-output-client';
import TaskWorkReviewView from '../jot/TaskWorkReview';
import {workbenchApi,pathId} from './client';
import {publicationSelection,publicationStatusPresentation,publicationRecoveryCommand,publicationMutationCanRetry,publicationHistorySelection} from './publication-ui.mjs';
import type {WorkPublicationSource,WorkPublicationReview,WorkPublicationAcceptance,WorkPublicationStatus,WorkPublicationHistoryItem,WorkPublicationSettlementReceipt} from './types';

type Command={kind:string;path:string;body:any;key:string};
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const labels={prepared:'待批准',approved:'已批准',cancelled:'已取消'};
export default function WorkPublicationPanel({conversationId,runId,taskId,onBusy}:{conversationId:string;runId:string;taskId:string;onBusy?:(busy:boolean)=>void}){
 const [opened,setOpened]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[source,setSource]=useState<WorkPublicationSource|null>(null),[project,setProject]=useState('');
 const [choicePage,setChoicePage]=useState(0),[choices,setChoices]=useState<string[]>([]),[selected,setSelected]=useState<string[]>([]),[history,setHistory]=useState<WorkPublicationHistoryItem[]>([]),[cursor,setCursor]=useState<string|null>(null);
 const [review,setReview]=useState<WorkPublicationReview|null>(null),[accepted,setAccepted]=useState<WorkPublicationAcceptance|null>(null),[status,setStatus]=useState<WorkPublicationStatus|null>(null),[receipt,setReceipt]=useState<WorkPublicationSettlementReceipt|null>(null);
 const [verified,setVerified]=useState(false),[reviewAck,setReviewAck]=useState(false),[recoverAck,setRecoverAck]=useState(false),[pending,setPending]=useState<Command|null>(null),[preview,setPreview]=useState('');
 const active=useRef<AbortController|null>(null),alive=useRef(true),inflight=useRef(false),report=useRef(onBusy),pendingRef=useRef<Command|null>(null);report.current=onBusy;
 const scope=JSON.stringify([conversationId,runId,taskId]),currentScope=useRef(scope);currentScope.current=scope;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;active.current?.abort();report.current?.(false)}},[scope]);
 useEffect(()=>{report.current?.(busy||!!pending)},[busy,pending]);
 useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{if(pendingRef.current||inflight.current){e.preventDefault();e.returnValue=''}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)},[]);
 const check=(signal:AbortSignal)=>{signal.throwIfAborted();if(!alive.current||currentScope.current!==scope)throw new DOMException('Aborted','AbortError')};
 const sourceScope=(value:WorkPublicationSource,p:string)=>{publicationSelection(value,{project_id:p,run_id:runId,task_id:taskId});validateWorkReview(value.work_review);return value};
 const reviewScope=(value:WorkPublicationReview,p:string,s:WorkPublicationSource,id:string)=>{
  if(value.intent_id!==id||value.project_id!==p||value.source.source_sha256!==s.source_sha256||!digest(value.review_sha256)||!Number.isSafeInteger(value.version)||value.version<1||value.execution_authorized!==false)throw Error('PUBLICATION_SCOPE_CHANGED');sourceScope(value.source,p);return value;
 };
 const acceptanceScope=(a:WorkPublicationAcceptance,r:WorkPublicationReview)=>{if(a.project_id!==r.project_id||a.intent_id!==r.intent_id||a.review_sha256!==r.review_sha256||a.source_sha256!==r.source.source_sha256||a.target_sha256!==r.target.target_sha256||a.state!=='accepted'||a.execution_authorized!==false)throw Error('PUBLICATION_SCOPE_CHANGED');return a};
 const readStatus=async(p:string,a:WorkPublicationAcceptance,signal:AbortSignal)=>{
  const value=await workbenchApi.publicationStatus(p,a.execution_id,signal);check(signal);if(value.execution_id!==a.execution_id||value.project_id!==p||value.intent_id!==a.intent_id||value.execution_authorized!==false||publicationStatusPresentation(value.state).blocked)throw Error('PUBLICATION_SCOPE_CHANGED');
  let record:WorkPublicationSettlementReceipt|null=null;
  if(['applied_pending_settlement','abandon_pending_settlement'].includes(value.state))try{record=await workbenchApi.publicationLatestSettlement(p,a.execution_id,signal);check(signal);if(record.execution_id!==a.execution_id||record.project_id!==p||record.execution_authorized!==false)throw Error('PUBLICATION_SCOPE_CHANGED')}catch(e){if((e as Error).message!=='WORK_PUBLICATION_SETTLEMENT_NOT_FOUND')throw e}
  setStatus(value);setReceipt(record);setRecoverAck(false);return value;
 };
 const readCurrent=async(p:string,s:WorkPublicationSource,id?:string,known?:WorkPublicationAcceptance|null)=>{
  const signal=active.current!.signal,page=await workbenchApi.publicationHistory(p,runId,undefined,signal);check(signal);
  if(page.project_id!==p||page.source_run_id!==runId)throw Error('PUBLICATION_SCOPE_CHANGED');setHistory(old=>publicationHistorySelection(page.items,old,id));setCursor(page.next_cursor);
  const item=id?page.items.find(v=>v.intent_id===id):page.items[0],wanted=id??item?.intent_id;
  if(!wanted){setReview(null);setAccepted(null);setStatus(null);setReceipt(null);setVerified(true);return}
  const r=reviewScope(await workbenchApi.publicationReview(p,wanted,signal),p,s,wanted);check(signal);setReview(r);setPreview('');setReviewAck(false);
  let a=item?.acceptance??known??null;
  if(a){a=acceptanceScope(await workbenchApi.publicationAcceptance(p,a.request_id,signal),r);check(signal);await readStatus(p,a,signal)}else{setStatus(null);setReceipt(null)}
  setAccepted(a);setVerified(true);
 };
 const start=()=>{if(inflight.current)return null;inflight.current=true;const controller=new AbortController();active.current=controller;setBusy(true);setError('');return controller};
 const finish=()=>{inflight.current=false;if(alive.current)setBusy(false)};
 const fail=(e:unknown)=>{if(!alive.current)return;setVerified(false);setError((e as Error).message==='PUBLICATION_SCOPE_CHANGED'?'记录范围已变化，请重新核对。':'当前操作未能确认，请核对原始记录。')};
 const open=async()=>{const c=start();if(!c)return;setOpened(true);try{const conv=await request<{conversation_id:string;project_id:string}>(`/conversations/${pathId(conversationId)}`,'GET',undefined,undefined,c.signal);check(c.signal);if(conv.conversation_id!==conversationId||!conv.project_id)throw Error('PUBLICATION_SCOPE_CHANGED');const s=sourceScope(await workbenchApi.publicationSource(conv.project_id,runId,c.signal),conv.project_id);check(c.signal);setProject(conv.project_id);setSource(s);setChoices(publicationSelection(s,{project_id:conv.project_id,run_id:runId,task_id:taskId}));await readCurrent(conv.project_id,s)}catch(e){fail(e)}finally{finish()}};
 const refresh=async(id=review?.intent_id,a=accepted)=>{if(!source)return;const c=start();if(!c)return;try{await readCurrent(project,source,id,a)}catch(e){fail(e)}finally{finish()}};
 const mutate=async(kind:'prepare'|'approve'|'cancel'|'admit'|'retry')=>{
  if(!source)return;const c=start();if(!c)return;setVerified(false);
  try{
   let command=pendingRef.current;
   if(!command){
    const base=`/projects/${pathId(project)}/work-publications`,id=crypto.randomUUID();
    if(kind==='prepare')command={kind,path:base,body:{request_id:id,source_run_id:runId,source_sha256:source.source_sha256,paths:[...selected]},key:crypto.randomUUID()};
    else if(review&&kind!=='retry')command={kind,path:base+'/'+pathId(review.intent_id)+(kind==='admit'?'/admissions':'/control'),body:kind==='admit'?{request_id:id,expected_version:review.version,review_sha256:review.review_sha256}:{request_id:id,expected_version:review.version,review_sha256:review.review_sha256,action:kind},key:crypto.randomUUID()};
   }
   if(!command||!publicationMutationCanRetry(command.kind))throw Error('PUBLICATION_SCOPE_CHANGED');pendingRef.current=command;setPending(command);
   const result=await request<any>(command.path,'POST',command.body,command.key,c.signal);check(c.signal);
   const id=command.kind==='admit'?review!.intent_id:result.intent_id;if(command.kind==='admit')acceptanceScope(result,review!);else reviewScope(result,project,source,id);
   pendingRef.current=null;setPending(null);await readCurrent(project,source,id,command.kind==='admit'?result:null);
  }catch(e){const status=(e as {status?:number}).status;if(status&&status>=400&&status<500&&status!==408&&(e as Error).message!=='IDEMPOTENCY_IN_PROGRESS'){pendingRef.current=null;setPending(null)}fail(e)}finally{finish()}
 };
 const io=async(kind:'dispatch'|'settle')=>{
  if(!accepted||!source||!status||!verified||pending)return;const c=start();if(!c)return;setVerified(false);
  try{const command=kind==='settle'?publicationRecoveryCommand(status,{request_id:crypto.randomUUID(),action:receipt?.action??(status.state==='applied_pending_settlement'?'confirm_recorded':'abandon_unknown'),acknowledge_unknown:recoverAck},receipt):{};
   await request(`/projects/${pathId(project)}/work-publication-executions/${pathId(accepted.execution_id)}/${kind}`,'POST',command,crypto.randomUUID(),c.signal);check(c.signal);await readCurrent(project,source,review!.intent_id,accepted);
  }catch(e){fail(e);if(alive.current&&!c.signal.aborted)try{await readCurrent(project,source,review!.intent_id,accepted)}catch{} }
  finally{finish()}
 };
 const more=async()=>{if(!cursor)return;const c=start();if(!c)return;try{const page=await workbenchApi.publicationHistory(project,runId,cursor,c.signal);check(c.signal);if(page.project_id!==project||page.source_run_id!==runId)throw Error('PUBLICATION_SCOPE_CHANGED');setHistory(old=>[...old,...page.items.filter(row=>!old.some(v=>v.intent_id===row.intent_id))]);setCursor(page.next_cursor)}catch(e){fail(e)}finally{finish()}};
 const locked=busy||!!pending,presentation=status?publicationStatusPresentation(status.state):null;
 if(!opened)return <button type="button" onClick={()=>void open()}>查看工作区改动</button>;
 return <section className="wb-form" aria-label="工作区修改复核" style={{minWidth:0,overflowWrap:'anywhere'}}><h4>工作区修改</h4>{busy&&<p role="status">正在核对原始记录</p>}{error&&<p role="alert" className="wb-error">{error}</p>}
  {source&&<><TaskWorkReviewView value={source.work_review} publication/>{history.length>0&&<label>发布记录<select aria-label="发布记录" disabled={locked} value={review?.intent_id??''} onChange={e=>{if(!e.target.value){setReview(null);setAccepted(null);setStatus(null);setReceipt(null);setSelected([]);setVerified(true)}else{const item=history.find(v=>v.intent_id===e.target.value);void refresh(e.target.value,item?.acceptance??null)}}}><option value="">新建复核</option>{history.map(item=><option key={item.intent_id} value={item.intent_id}>{item.created_at} · {labels[item.state]} · {item.paths.length} 项</option>)}</select></label>}{cursor&&<button type="button" disabled={locked} onClick={()=>void more()}>更早记录</button>}
  {!review?<><p>选择本次修改（每次最多 100 项）。其他改动仍保留在完整清单中。</p>{choices.slice(choicePage*50,choicePage*50+50).map(path=><label key={path}><input type="checkbox" aria-label={'选择 '+path} checked={selected.includes(path)} disabled={locked||!selected.includes(path)&&selected.length>=100} onChange={e=>setSelected(old=>e.target.checked?[...old,path]:old.filter(v=>v!==path))}/><code>{path}</code></label>)}{choices.length>50&&<nav aria-label="可选修改分页"><button type="button" disabled={locked||choicePage===0} onClick={()=>setChoicePage(n=>n-1)}>上一页</button><span>{choicePage*50+1}–{Math.min(choicePage*50+50,choices.length)} / {choices.length}</span><button type="button" disabled={locked||(choicePage+1)*50>=choices.length} onClick={()=>setChoicePage(n=>n+1)}>下一页</button></nav>}<button type="button" disabled={locked||!verified||!selected.length} onClick={()=>void mutate('prepare')}>生成复核</button></>:<><p role="status">{labels[review.state]}</p><p>目标分支：{review.target.head.branch??'独立提交'} · 所选 {review.paths.length} 项</p><div>{review.changes.map(change=><button type="button" key={change.path} disabled={busy} onClick={()=>setPreview(change.path)}>查看 {change.path} 的变化</button>)}</div>{review.changes.filter(change=>change.path===preview).map(change=><article key={change.path}><h5>{change.path}</h5><p>原内容</p><pre style={{whiteSpace:'pre-wrap',maxHeight:280,overflow:'auto'}}>{change.before_text??'新增文件'}</pre><p>新内容</p><pre style={{whiteSpace:'pre-wrap',maxHeight:280,overflow:'auto'}}>{change.after_text}</pre></article>)}
   {review.state==='prepared'&&<><label><input type="checkbox" aria-label="已核对所选文件的目标修改" checked={reviewAck} disabled={locked} onChange={e=>setReviewAck(e.target.checked)}/>已核对所选文件的目标修改</label><button type="button" disabled={locked||!verified||!reviewAck} onClick={()=>void mutate('approve')}>批准复核</button></>}
   {review.state!=='cancelled'&&!accepted&&<button type="button" disabled={locked||!verified} onClick={()=>void mutate('cancel')}>取消复核</button>}
   {review.state==='approved'&&!accepted&&<button type="button" disabled={locked||!verified} onClick={()=>void mutate('admit')}>受理应用</button>}
   {presentation&&<p role="status">{presentation.label}</p>}{accepted&&status?.state==='not_started'&&review.state==='approved'&&<button type="button" disabled={locked||!verified} onClick={()=>void io('dispatch')}>应用到工作区</button>}
   {presentation?.canRecover&&<><label><input type="checkbox" checked={recoverAck} disabled={locked||!verified} onChange={e=>setRecoverAck(e.target.checked)}/>我已核对原始记录，确认本次恢复操作不会回滚或重放文件</label><button type="button" disabled={locked||!verified||!recoverAck} onClick={()=>void io('settle')}>{status?.state==='applied_pending_settlement'?'确认已记录的应用':'结束本次不确定应用'}</button></>}
  </>}
  <button type="button" disabled={busy} onClick={()=>void refresh()}>核对当前记录</button></>}{pending&&<button type="button" disabled={busy} onClick={()=>void mutate('retry')}>重试原请求</button>}{busy&&<button type="button" onClick={()=>active.current?.abort()}>停止等待并核对</button>}
 </section>;
}
