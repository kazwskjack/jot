import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import React,{useEffect,useRef,useState} from 'react';
import {useResource} from '../workbench/useResource';
import {ApiError,request,taskDraftScope} from './client';
import ConversationDisplayBoundary from './ConversationDisplayBoundary';
import type {Interaction,InteractionHistoryPage,InteractionHistoryRecord,QuestionAnswer} from './types';

const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const statusLabels={pending:'待处理',answered:'已回答',denied:'已拒绝',cancelled:'已取消',expired:'已过期'};
type Cursor={id:string;createdAt:string};

function MarkedText({text,query}:{text:string;query?:string}){
 if(!query)return <>{text}</>;
 const match=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'iu').exec(text);
 return match?<>{text.slice(0,match.index)}<mark>{match[0]}</mark>{text.slice(match.index+match[0].length)}</>:<>{text}</>;
}

function SavedAnswer({answer,labels,highlight}:{answer:QuestionAnswer;labels:Map<string,string>;highlight?:string}){
 const t=useApplicationText();
 return <div><p>{t("已保存的回答","Saved Answer")}</p>
  {answer.selected_option_ids.length>0&&<ul>{answer.selected_option_ids.map((option,index)=><li key={index}><MarkedText text={labels.get(option)??t(`原选项 ${option}`,`Original Option ${option}`)} query={highlight}/></li>)}</ul>}
  {answer.custom_text&&<p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}><MarkedText text={answer.custom_text} query={highlight}/></p>}
  {!answer.selected_option_ids.length&&!answer.custom_text&&<p>{t('该回答内容为空。','This answer is empty.')}</p>}
 </div>;
}

function InteractionRecord({value,searchId,highlight}:{value:Interaction;searchId:string;highlight?:string}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const labels={pending:t("待处理","Pending"),answered:t("已回答","Answered"),denied:t("已拒绝","Denied"),cancelled:t("已取消","Cancelled"),expired:t("已过期","Expired")};
 return <article lang={language} className="jot-interaction-record" data-chat-search-content={searchId}>
  <h4>{value.kind==='question'?t('问题记录','Question Record'):t('确认记录','Approval Record')} · {value.kind==='approval'&&value.status==='answered'?t('已决定','Decided'):labels[value.status]}</h4>
  <p>{t('创建时间','Created At')} {value.created_at} · {t('版本','Version')} {value.version}</p>
  {value.kind==='question'?<>
   {value.questions.map(question=>{
    const answers=(value.answers??[]).filter(answer=>answer.question_id===question.question_id);
    const labels=new Map(question.options.map(option=>[option.option_id,option.label]));
    return <section key={question.question_id}><h5><MarkedText text={question.prompt} query={highlight}/></h5><p>{question.multiple?t('可多选','Multiple Choices Allowed'):t('单选','Single Choice')}{question.allow_custom?t(' · 可填写补充内容',' · Additional Text Allowed'):''}</p>
     {question.description&&<p style={{whiteSpace:'pre-wrap'}}><MarkedText text={question.description} query={highlight}/></p>}
     {question.options.length>0&&<ul>{question.options.map(option=><li key={option.option_id}><MarkedText text={option.label} query={highlight}/>{option.description&&<p><MarkedText text={option.description} query={highlight}/></p>}</li>)}</ul>}
     {answers.map((answer,index)=><SavedAnswer key={index} answer={answer} labels={labels} highlight={highlight}/>)}
     {!answers.length&&<p>{t('尚无公开回答记录。','No public answer has been recorded yet.')}</p>}
    </section>;
   })}
   {(value.answers??[]).filter(answer=>!value.questions.some(question=>question.question_id===answer.question_id)).map((answer,index)=><section key={index}>
    <h5>{t('原问题','Original Question')} {answer.question_id}</h5><SavedAnswer answer={answer} labels={new Map()} highlight={highlight}/>
   </section>)}
  </>:<>
   <p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}><MarkedText text={value.action_summary} query={highlight}/></p><p>{t('风险','Risk')} <MarkedText text={value.risk} query={highlight}/></p>
   {value.decision&&<p>{t('已保存的决定','Saved Decision')} · <MarkedText text={value.decision==='approve'?t('批准','Approved'):t('拒绝','Denied')} query={highlight}/></p>}
  </>}
  <details><summary>{t('原记录信息','Original Record Information')}</summary><dl>
   <dt>{t('交互编号','Interaction ID')}</dt><dd>{value.interaction_id}</dd><dt>{t('运行编号','Run ID')}</dt><dd>{value.run_id}</dd>
   <dt>{t('工具调用','Tool Call')}</dt><dd>{value.tool_call_id}</dd><dt>{t('有效期','Expires At')}</dt><dd>{value.expires_at}</dd>
   {value.purpose&&<><dt>{t('用途','Purpose')}</dt><dd>{value.purpose}</dd></>}
  </dl></details>
 </article>;
}

export function InteractionHistorySelection({conversationId,interactionId,runId,version,highlight}:{conversationId:string;interactionId:string;runId:string;version:number;highlight:string}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const owner=taskDraftScope(),identity=JSON.stringify([owner,conversationId,interactionId,runId,version]);
 const region=useRef<HTMLElement>(null);
 const resource=useResource(async signal=>{
  const query=new URLSearchParams({run_id:runId,expected_version:String(version)});
  let result:InteractionHistoryRecord;
  try{result=await request<InteractionHistoryRecord>(`/conversations/${encodeURIComponent(conversationId)}/interaction-history/${encodeURIComponent(interactionId)}?${query}`,'GET',undefined,undefined,signal);}
  catch(error){if(error instanceof ApiError&&error.status===409)throw Error('记录已更新，请刷新搜索后重新打开。');throw error;}
  const item=result?.item;
  if(taskDraftScope()!==owner||!result||result.conversation_id!==conversationId||result.execution_authorized!==false
   ||!item||item.interaction_id!==interactionId||item.run_id!==runId||item.version!==version
   ||!['question','approval'].includes(item.kind)||!Object.hasOwn(statusLabels,item.status))throw Error('原交互记录的身份或版本尚未确认');
  return {identity,item};
 },identity);
 const item=!resource.loading&&!resource.error&&resource.data?.identity===identity?resource.data.item:undefined;
 useEffect(()=>{
  region.current?.focus();
  (region.current?.querySelector('mark')??region.current)?.scrollIntoView({block:'nearest'});
 },[identity,item]);
 return <section lang={language} ref={region} tabIndex={-1} className="jot-activity-content" aria-label={t("已选交互历史记录","Selected Interaction History Record")}>
  {resource.loading&&<p role="status">{t('正在核对原交互记录…','Verifying the original interaction record…')}</p>}
  {resource.error&&<p role="alert">{conversationUiError(resource.error,language)} <button type="button" onClick={resource.reload}>{t('重试读取','Retry Reading')}</button></p>}
  {item&&<>
   <p>{t(`当前显示检索时的公开版本 ${version}。`,`Showing public version ${version} from the search.`)}</p>
   <ConversationDisplayBoundary label={t('搜索命中交互','Matching Interaction')}><InteractionRecord value={item} highlight={highlight}
    searchId={JSON.stringify(['interaction',owner,conversationId,runId,interactionId,version])}/></ConversationDisplayBoundary>
  </>}
 </section>;
}

export default function InteractionHistory({conversationId,runId}:{conversationId:string;runId?:string}){
 const language=useApplicationLanguage(),t=useApplicationText();
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
 return <details lang={language} className="jot-interaction-history" open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
  <summary>{t('问题与确认历史','Question and Approval History')}</summary>
  {open&&<>
   <p>{t('原请求及当前已保存的公开回答。','Original requests and currently saved public answers.')}</p>
   <button type="button" disabled={resource.loading} onClick={refresh}>{t('刷新交互历史','Refresh Interaction History')}</button>
   {resource.loading&&<p role="status">{t('正在读取交互历史…','Reading interaction history…')}</p>}
   {resource.error&&<p role="alert">{conversationUiError(resource.error,language)}</p>}
   {current?.items.map(item=><ConversationDisplayBoundary key={`${item.interaction_id}:${item.version}`} label={t('交互历史记录','Interaction History Record')}><InteractionRecord value={item} searchId={JSON.stringify(['interaction',conversationId,item.run_id,item.interaction_id,item.version])}/></ConversationDisplayBoundary>)}
   {current&&!current.items.length&&<p role="status">{t('此范围暂无交互记录。','No interaction records are available in this scope.')}</p>}
   <nav aria-label={t('交互历史翻页','Interaction History Pages')}><button type="button" disabled={resource.loading||page===0} onClick={()=>setPage(value=>value-1)}>{t('较新交互','Newer Interactions')}</button>
    <span>{t(`第 ${page+1} 页`,`Page ${page+1}`)}</span><button type="button" disabled={resource.loading||!current?.next_cursor} onClick={older}>{t('更早交互','Earlier Interactions')}</button></nav>
  </>}
 </details>;
}
