import React,{useState} from 'react';
import {useResource} from '../workbench/useResource';
import {request} from './client';
import ConversationDisplayBoundary from './ConversationDisplayBoundary';
import type {Interaction,InteractionHistoryPage,QuestionAnswer} from './types';

const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const statusLabels={pending:'待处理',answered:'已回答',denied:'已拒绝',cancelled:'已取消',expired:'已过期'};
type Cursor={id:string;createdAt:string};

function SavedAnswer({answer,labels}:{answer:QuestionAnswer;labels:Map<string,string>}){
 return <div><p>已保存的回答</p>
  {answer.selected_option_ids.length>0&&<ul>{answer.selected_option_ids.map((option,index)=><li key={index}>{labels.get(option)??`原选项 ${option}`}</li>)}</ul>}
  {answer.custom_text&&<p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{answer.custom_text}</p>}
  {!answer.selected_option_ids.length&&!answer.custom_text&&<p>该回答内容为空。</p>}
 </div>;
}

function InteractionRecord({value}:{value:Interaction}){
 return <article className="jot-interaction-record">
  <h4>{value.kind==='question'?'问题记录':'确认记录'} · {value.kind==='approval'&&value.status==='answered'?'已决定':statusLabels[value.status]}</h4>
  <p>创建时间 {value.created_at} · 版本 {value.version}</p>
  {value.kind==='question'?<>
   {value.questions.map(question=>{
    const answers=(value.answers??[]).filter(answer=>answer.question_id===question.question_id);
    const labels=new Map(question.options.map(option=>[option.option_id,option.label]));
    return <section key={question.question_id}><h5>{question.prompt}</h5><p>{question.multiple?'可多选':'单选'}{question.allow_custom?' · 可填写补充内容':''}</p>
     {question.description&&<p style={{whiteSpace:'pre-wrap'}}>{question.description}</p>}
     {question.options.length>0&&<ul>{question.options.map(option=><li key={option.option_id}>{option.label}{option.description&&<p>{option.description}</p>}</li>)}</ul>}
     {answers.map((answer,index)=><SavedAnswer key={index} answer={answer} labels={labels}/>)}
     {!answers.length&&<p>尚无公开回答记录。</p>}
    </section>;
   })}
   {(value.answers??[]).filter(answer=>!value.questions.some(question=>question.question_id===answer.question_id)).map((answer,index)=><section key={index}>
    <h5>原问题 {answer.question_id}</h5><SavedAnswer answer={answer} labels={new Map()}/>
   </section>)}
  </>:<>
   <p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{value.action_summary}</p><p>风险 {value.risk}</p>
   {value.decision&&<p>已保存的决定 · {value.decision==='approve'?'批准':'拒绝'}</p>}
  </>}
  <details><summary>原记录信息</summary><dl>
   <dt>交互编号</dt><dd>{value.interaction_id}</dd><dt>运行编号</dt><dd>{value.run_id}</dd>
   <dt>工具调用</dt><dd>{value.tool_call_id}</dd><dt>有效期</dt><dd>{value.expires_at}</dd>
   {value.purpose&&<><dt>用途</dt><dd>{value.purpose}</dd></>}
  </dl></details>
 </article>;
}

export default function InteractionHistory({conversationId,runId}:{conversationId:string;runId?:string}){
 const [open,setOpen]=useState(false),[page,setPage]=useState(0),[cursors,setCursors]=useState<Cursor[]>([]);
 const cursor=page>0?cursors[page-1]:undefined;
 const identity=JSON.stringify([conversationId,runId??null,page,cursor?.id??null]);
 const resource=useResource(async signal=>{
  const query=new URLSearchParams({limit:'10'});
  if(runId)query.set('run_id',runId);
  if(cursor)query.set('cursor',cursor.id);
  const value=await request<InteractionHistoryPage>(`/conversations/${encodeURIComponent(conversationId)}/interaction-history?${query}`,'GET',undefined,undefined,signal);
  if(!value||value.conversation_id!==conversationId||value.run_id!==runId||value.execution_authorized!==false
   ||!Array.isArray(value.items)||value.items.length>10)throw Error('问题历史来源尚未确认');
  let previous=cursor;const seen=new Set<string>();
  for(const item of value.items){
   if(!item||typeof item.interaction_id!=='string'||!id.test(item.interaction_id)||typeof item.run_id!=='string'||!id.test(item.run_id)
    ||runId!==undefined&&item.run_id!==runId||!['question','approval'].includes(item.kind)
    ||!Object.hasOwn(statusLabels,item.status)||!Number.isSafeInteger(item.version)||item.version<1
    ||typeof item.created_at!=='string'||!Number.isFinite(Date.parse(item.created_at))
    ||seen.has(item.interaction_id)||previous&&(item.created_at>previous.createdAt
     ||item.created_at===previous.createdAt&&item.interaction_id>=previous.id))throw Error('问题历史顺序或身份尚未确认');
   seen.add(item.interaction_id);previous={id:item.interaction_id,createdAt:item.created_at};
  }
  if(value.next_cursor!==undefined&&(typeof value.next_cursor!=='string'||!id.test(value.next_cursor)
   ||value.items.length!==10||value.next_cursor!==value.items.at(-1)?.interaction_id))throw Error('问题历史游标尚未确认');
  return {identity,value};
 },identity,open);
 const current=resource.data?.identity===identity?resource.data.value:undefined;
 const refresh=()=>{setPage(0);setCursors([]);resource.reload();};
 const older=()=>{
  const last=current?.items.at(-1);
  if(!current?.next_cursor||!last)return;
  setCursors(values=>[...values.slice(0,page),{id:last.interaction_id,createdAt:last.created_at}]);setPage(value=>value+1);
 };
 return <details className="jot-interaction-history" open={open} onToggle={event=>setOpen(event.currentTarget.open)} data-chat-search-ignore>
  <summary>问题与确认历史</summary>
  {open&&<>
   <p>原请求及当前已保存的公开回答。</p>
   <button type="button" disabled={resource.loading} onClick={refresh}>刷新交互历史</button>
   {resource.loading&&<p role="status">正在读取交互历史…</p>}
   {resource.error&&<p role="alert">{resource.error}</p>}
   {current?.items.map(item=><ConversationDisplayBoundary key={`${item.interaction_id}:${item.version}`} label="交互历史记录"><InteractionRecord value={item}/></ConversationDisplayBoundary>)}
   {current&&!current.items.length&&<p role="status">此范围暂无交互记录。</p>}
   <nav aria-label="交互历史翻页"><button type="button" disabled={resource.loading||page===0} onClick={()=>setPage(value=>value-1)}>较新交互</button>
    <span>第 {page+1} 页</span><button type="button" disabled={resource.loading||!current?.next_cursor} onClick={older}>更早交互</button></nav>
  </>}
 </details>;
}
