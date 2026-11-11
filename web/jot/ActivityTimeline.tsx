import {taskDraftScope} from './client';
import {useToolDisplayPreference} from './useToolDisplayPreference';
import NativeTodoInputContent from './NativeTodoInputContent';
import ConversationDisplayBoundary from './ConversationDisplayBoundary';
// Phase grouping and expandable nested tool history adapt PilotDeck 783499ff,
// AgentTimeline.tsx/SubagentContainer.tsx. Adapted portions retain AGPL-3.0 terms.
import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import type {Activity} from './types';
import type {NativeMemberTarget} from './native-member-execution';
import {activityTodoSourceKey,activityArtifactTargets,type ActivityArtifactTarget,activityDetailRows,activityDisplayStatus,activityForest,activityTreeProgress,type ActivityProgress,activityIsActive as running,visibleActivityRows,activityKindLabels,activityStatusLabels,type ActivityRow,type ToolActivity,type ActivityReveal,type ActivityRun} from './activity-presentation';
import ActivityArtifactDetails from './ActivityArtifactDetails';
import ActivityToolResult from './ActivityToolResult';
import './activity-timeline.css';

function progressText(value:ActivityProgress){
 return [`${value.total} 个已加载步骤`,value.active&&`${value.active} 个进行中`,value.succeeded&&`${value.succeeded} 个已完成`,value.failed&&`${value.failed} 个失败`,
  value.cancelled&&`${value.cancelled} 个已取消`,value.partial&&`${value.partial} 个部分完成`,value.unknown&&`${value.unknown} 个状态待确认`].filter(Boolean).join(' · ');
}

type GroupDisplay={open?:boolean;expanded:Record<string,boolean>;page:number};
type TimelineDisplays={identity:string;groups:Map<string,Omit<GroupDisplay,'expanded'>>;steps:Map<string,Record<string,boolean>>};
type Group={id:string;kind:ToolActivity['kind'];rows:ActivityRow[]};
type ToolResultAction={onOpenToolResult:(activity:ToolActivity,nativeSource?:boolean)=>void};
type ArtifactAction={onOpenArtifact:(activity:ToolActivity,target:ActivityArtifactTarget)=>void};
type MemberDetailsAction={onOpenMember?:(target:NativeMemberTarget)=>void};

function ActivityGroup({group,run,onSelectRun,availableRuns,reveal,onOpenMember,onOpenArtifact,onOpenToolResult,display,onDisplayChange,autoExpand}:{display:GroupDisplay;onDisplayChange:(update:(previous:GroupDisplay)=>GroupDisplay)=>void;autoExpand:boolean;group:Group;run?:ActivityRun;onSelectRun:(id:string)=>void;availableRuns:Set<string>;reveal?:ActivityReveal}&MemberDetailsAction&ArtifactAction&ToolResultAction){
 const progress=useMemo(()=>activityTreeProgress(group.rows,run),[group.rows,run]),active=progress.total.active;
 const region=useRef<HTMLDetailsElement>(null),pendingFocus=useRef<string>();
 const [openedWhileActive,setOpenedWhileActive]=useState(active>0),[autoOpened,setAutoOpened]=useState(false);
 const {expanded,page}=display,open=display.open??(openedWhileActive||autoExpand&&autoOpened),expandDefault=autoExpand&&autoOpened;
 useEffect(()=>{if(active>0)setOpenedWhileActive(true);},[active]);
 useEffect(()=>{
  if(!autoExpand){setAutoOpened(false);return;}
  const element=region.current?.querySelector(':scope > summary');if(!element)return;
  if(typeof IntersectionObserver==='undefined'){setAutoOpened(true);return;}
  const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){setAutoOpened(true);observer.disconnect();}},{threshold:0.1});
  observer.observe(element);return()=>observer.disconnect();
 },[autoExpand]);
 const [artifactPages,setArtifactPages]=useState(()=>new Map<string,number>());
 const appliedReveal=useRef(''),navigation=useRef<{activityId:string;rows:ActivityRow[];expandDefault:boolean;runStatus?:ActivityRun['status']}>();
 const revealStep=useCallback((activityId:string)=>{
  const targetIndex=group.rows.findIndex(row=>row.activity.activity_id===activityId);
  if(targetIndex<0)return false;
  const target=group.rows[targetIndex]!,path:Record<string,boolean>={[activityId]:true};
  let depth=target.depth;
  for(let index=targetIndex-1;index>=0&&depth>0;index--){
   const ancestor=group.rows[index]!;
   if(ancestor.depth<depth){path[ancestor.activity.activity_id]=true;depth=ancestor.depth;}
  }
  navigation.current={activityId,rows:group.rows,expandDefault,runStatus:run?.status};
  onDisplayChange(previous=>{
   const next={...previous.expanded,...path},visible=visibleActivityRows(group.rows,next,run,expandDefault);
   const index=visible.findIndex(row=>row.activity.activity_id===activityId);
   return {...previous,expanded:next,open:true,page:Math.max(0,Math.floor(index/50))};
  });
  return true;
 },[group.rows,run,expandDefault,onDisplayChange]);
 useEffect(()=>{if(reveal&&appliedReveal.current!==reveal.key&&revealStep(reveal.activityId))appliedReveal.current=reveal.key;},[reveal,revealStep]);
 // Keep an explicit target on its page when viewport defaults or loaded ancestry change.
 useEffect(()=>{const target=navigation.current;if(target&&(target.expandDefault!==expandDefault||target.rows!==group.rows||target.runStatus!==run?.status))revealStep(target.activityId);},[expandDefault,group.rows,run?.status,revealStep]);
 const locate=(activityId:string)=>{pendingFocus.current=activityId;if(!revealStep(activityId))pendingFocus.current=undefined;};
 const visible=visibleActivityRows(group.rows,expanded,run,expandDefault);
 const pageCount=Math.max(1,Math.ceil(visible.length/50)),currentPage=Math.min(page,pageCount-1);
 useEffect(()=>{
  const id=pendingFocus.current;if(!id||!open)return;
  const row=Array.from(region.current?.querySelectorAll<HTMLElement>('[data-chat-search-activity]')??[]).find(element=>element.dataset.chatSearchActivity===id);
  if(!row)return;pendingFocus.current=undefined;row.querySelector<HTMLButtonElement>(':scope > button')?.focus();row.scrollIntoView({block:'nearest'});
 },[open,expanded,currentPage,group.rows]);
 return <details ref={region} className="jot-activity-group" open={open} onToggle={event=>{if(event.target!==event.currentTarget)return;const next=event.currentTarget.open;if(!next)pendingFocus.current=undefined;if(next!==open){navigation.current=undefined;onDisplayChange(previous=>({...previous,open:next}));}}}>
  <summary onClick={event=>{if(event.target instanceof Element&&event.target.closest('button,a,input,select,textarea'))return;event.preventDefault();navigation.current=undefined;pendingFocus.current=undefined;onDisplayChange(previous=>({...previous,open:!open}));}}>{activityKindLabels[group.kind]} · {progressText(progress.total)}{progress.total.latest&&<span> · 最近活动：{progress.total.latest.detail.tool_name??activityKindLabels[progress.total.latest.kind]} · {progress.total.latest.title} · {activityStatusLabels[activityDisplayStatus(progress.total.latest,run)]??activityStatusLabels.unknown}</span>}</summary>
  {open&&<>
   {progress.total.latest&&<button type="button" data-chat-search-ignore onClick={()=>locate(progress.total.latest!.activity_id)}>定位最近活动步骤</button>}
   <ol start={currentPage*50+1}>{visible.slice(currentPage*50,currentPage*50+50).map(row=>{
    const nested=progress.descendants.get(row.activity.activity_id);
    const activity=row.activity,status=activityDisplayStatus(activity,run),isExpanded=expanded[activity.activity_id]??(expandDefault||running(activity,run));
    const targets=isExpanded?activityArtifactTargets(activity):[],targetPageCount=Math.max(1,Math.ceil(targets.length/10));
    const targetPage=Math.min(artifactPages.get(activity.activity_id)??0,targetPageCount-1);
    const child=activity.kind==='subagent'?activity.detail.child_run_id:undefined;
    const native=activity.kind==='subagent'&&activity.detail.native_request_id&&activity.detail.reservation_id
     &&activity.detail.child_conversation_id&&activity.detail.child_session_ref&&activity.detail.role_ref
     &&child&&child!==activity.run_id
      ?{root_run_id:activity.run_id,child_session_ref:activity.detail.child_session_ref,child_run_id:child}:undefined;
    return <li key={activity.activity_id} data-chat-search-activity={activity.activity_id} data-chat-search-ready={isExpanded?'true':'false'} style={{paddingInlineStart:Math.min(row.depth,8)*12}}>
     <button type="button" aria-expanded={isExpanded} onClick={()=>{navigation.current=undefined;onDisplayChange(previous=>({...previous,expanded:{...previous.expanded,[activity.activity_id]:!isExpanded}}));}}>
      <span aria-hidden="true">{isExpanded?'收起':'展开'} </span>{activityKindLabels[activity.kind]} · {activity.title} · {activityStatusLabels[status]??activityStatusLabels.unknown}<span data-chat-search-ignore>{row.children>0?` · ${row.children} 个子步骤`:''}</span>
     </button>
     {nested&&nested.total>0&&<div data-chat-search-ignore><small>嵌套步骤 · {progressText(nested)}</small>
      {nested.latest&&<p>最近活动：<code>{nested.latest.detail.tool_name??activityKindLabels[nested.latest.kind]}</code> · {nested.latest.title} · {activityStatusLabels[activityDisplayStatus(nested.latest,run)]??activityStatusLabels.unknown}{' '}
       <button type="button" onClick={()=>locate(nested.latest!.activity_id)}>定位活动子步骤</button></p>}
     </div>}
     {row.depth>0&&<small data-chat-search-ignore>层级 {row.depth+1} · 父步骤 {activity.parent_activity_id}</small>}
     {row.issue&&<p role="status" data-chat-search-ignore>{row.issue}</p>}
     {isExpanded&&<>
      {status==='unknown'&&activity.status!=='unknown'&&<p role="status" data-chat-search-ignore>所属运行已结束，此步骤尚无终态回执。</p>}
      {activity.kind==='subagent'&&activity.detail.todo_input&&<NativeTodoInputContent value={activity.detail.todo_input} sourceKey={activityTodoSourceKey(activity)} {...(reveal?.activityId===activity.activity_id?{reveal}:{})}/>}
      <dl>{activityDetailRows(activity).map((detail,index)=><React.Fragment key={index}><dt>{detail.label}</dt><dd style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{detail.value}</dd></React.Fragment>)}</dl>
      {typeof activity.detail.tool_name==='string'&&(activity.detail.tool_name==='jot_workspace'||/^jot_mcp_[a-z0-9_]{1,50}$/.test(activity.detail.tool_name)
       ||(activity.kind==='search'||activity.kind==='subagent')&&['glob','grep'].includes(activity.detail.tool_name)&&activity.detail.file_search)&&<button type="button" data-chat-search-ignore onClick={()=>onOpenToolResult(activity)}>查看工具结果正文</button>}
      {activity.status==='succeeded'&&(activity.kind==='search'||activity.kind==='subagent')&&['glob','grep'].includes(String(activity.detail.tool_name))
       &&Number.isSafeInteger(activity.detail.native_search_call_seq)&&Number.isSafeInteger(activity.detail.native_search_result_seq)
       &&activity.detail.file_search&&(activity.detail.file_search.shape==='source_limit'||activity.detail.file_search.truncated)
       &&<button type="button" data-chat-search-ignore onClick={()=>onOpenToolResult(activity,true)}>读取已保留的大结果来源</button>}
      {targets.slice(targetPage*10,targetPage*10+10).map(target=><button type="button" key={JSON.stringify(target)} data-chat-search-ignore onClick={()=>onOpenArtifact(activity,target)}>{target.label}</button>)}
      {targetPageCount>1&&<nav aria-label="结果引用文件翻页" data-chat-search-ignore>
       <button type="button" disabled={targetPage===0} onClick={()=>setArtifactPages(values=>new Map(values).set(activity.activity_id,targetPage-1))}>上一页文件</button>
       <span>{targetPage+1} / {targetPageCount}</span>
       <button type="button" disabled={targetPage+1===targetPageCount} onClick={()=>setArtifactPages(values=>new Map(values).set(activity.activity_id,targetPage+1))}>下一页文件</button>
      </nav>}
      {native&&onOpenMember&&<button type="button" data-chat-search-ignore onClick={()=>onOpenMember(native)}>查看原成员执行步骤</button>}
      {child&&child!==activity.run_id&&availableRuns.has(child)&&<button type="button" data-chat-search-ignore onClick={()=>onSelectRun(child)}>查看子运行步骤</button>}
     </>}
    </li>;
   })}</ol>
   {pageCount>1&&<nav aria-label="步骤翻页"><button type="button" disabled={currentPage===0} onClick={()=>{navigation.current=undefined;onDisplayChange(previous=>({...previous,page:currentPage-1}));}}>上一页步骤</button><span>{currentPage+1} / {pageCount}</span><button type="button" disabled={currentPage+1===pageCount} onClick={()=>{navigation.current=undefined;onDisplayChange(previous=>({...previous,page:currentPage+1}));}}>下一页步骤</button></nav>}
  </>}
 </details>;
}

export default function ActivityTimeline({conversationId,activities,runs,reveal,onOpenMember}:{conversationId:string;activities:Activity[];runs:Record<string,ActivityRun>;reveal?:ActivityReveal}&MemberDetailsAction){
 const toolDisplay=useToolDisplayPreference(),owner=taskDraftScope(),displayIdentity=JSON.stringify([owner,conversationId]);
 const [displays,setDisplays]=useState<TimelineDisplays>(()=>({identity:displayIdentity,groups:new Map(),steps:new Map()}));
 const currentDisplayIdentity=useRef(displayIdentity);currentDisplayIdentity.current=displayIdentity;
 const [selection,setSelection]=useState('');
 const [artifact,setArtifact]=useState<{conversationId:string;runId:string;activityId:string;target:ActivityArtifactTarget}>();
 const [toolResult,setToolResult]=useState<{conversationId:string;runId:string;activityId:string;toolName:string;nativeSource?:boolean}>();
 const selectRun=(id:string)=>{setSelection(id);setArtifact(undefined);setToolResult(undefined);};
 const appliedReveal=useRef('');
 const tools=useMemo(()=>activities.filter((activity):activity is ToolActivity=>activity.kind!=='compaction'),[activities]);
 const runIds=useMemo(()=>[...new Set(tools.slice().sort((a,b)=>b.started_at.localeCompare(a.started_at)).map(activity=>activity.run_id))],[tools]);
 useEffect(()=>{
  if(!reveal||appliedReveal.current===reveal.key)return;
  const target=tools.find(activity=>activity.activity_id===reveal.activityId);
  if(target){setSelection(target.run_id);setArtifact(undefined);setToolResult(undefined);appliedReveal.current=reveal.key;}
 },[reveal,tools]);
 const selected=runIds.includes(selection)?selection:runIds[0];
 const groups=useMemo(()=>{
  const result:Group[]=[];
  for(const row of activityForest(tools.filter(activity=>activity.run_id===selected))){
   let group=result.at(-1);
   if(!group||(row.depth===0&&group.kind!==row.activity.kind)){
    group={id:row.activity.activity_id,kind:row.activity.kind,rows:[]};result.push(group);
   }
   group.rows.push(row);
  }
  return result;
 },[tools,selected]);
 if(!tools.length)return null;
 const availableRuns=new Set(runIds),run=selected?runs[selected]:undefined;
 const displayForGroup=(group:Group,source:TimelineDisplays=displays):GroupDisplay=>{
  const saved=source.identity===displayIdentity?source:undefined;
  let choice=saved?.groups.get(JSON.stringify([selected,group.kind,group.id]));
  // Earlier history can extend a group; retain a choice anchored to an original member step.
  if(!choice)for(const row of group.rows){choice=saved?.groups.get(JSON.stringify([selected,group.kind,row.activity.activity_id]));if(choice)break;}
  return {...(choice??{page:0}),expanded:selected?saved?.steps.get(selected)??{}:{}};
 };
 return <section className="jot-activity-timeline" aria-label="工具与子任务时间线">
  <h3>工具与子任务</h3>
  <label>运行记录 <select value={selected} onChange={event=>selectRun(event.currentTarget.value)}>{runIds.map(id=><option key={id} value={id}>{runs[id]?.created_at??id} · {runs[id]?.status??'历史运行'}</option>)}</select></label>
  <small>当前已加载的公开步骤。父步骤缺失或终态未确认时会保留提示。</small>
  {groups.map(group=><ConversationDisplayBoundary key={`${selected}:${group.id}`} label="步骤分组"><ActivityGroup group={group} autoExpand={toolDisplay.enabled} display={displayForGroup(group)} onDisplayChange={update=>{
   if(!selected||taskDraftScope()!==owner||currentDisplayIdentity.current!==displayIdentity)return;
   setDisplays(previous=>{
    if(taskDraftScope()!==owner||currentDisplayIdentity.current!==displayIdentity)return previous;
    const saved=previous.identity===displayIdentity?previous:undefined,groups=new Map(saved?.groups),steps=new Map(saved?.steps);
    const key=JSON.stringify([selected,group.kind,group.id]),current=displayForGroup(group,previous),next=update({...current,expanded:steps.get(selected)??current.expanded});
    groups.set(key,{open:next.open??true,page:next.page});steps.set(selected,next.expanded);
    return {identity:displayIdentity,groups,steps};
   });
  }} {...(run?{run}:{})} onSelectRun={selectRun} onOpenArtifact={(activity,target)=>{setToolResult(undefined);setArtifact({conversationId,runId:activity.run_id,activityId:activity.activity_id,target});}} onOpenToolResult={(activity,nativeSource)=>{setArtifact(undefined);setToolResult({conversationId,runId:activity.run_id,activityId:activity.activity_id,toolName:activity.detail.tool_name!,...(nativeSource?{nativeSource:true}:{})});}} availableRuns={availableRuns} {...(onOpenMember?{onOpenMember}:{})} {...(reveal?{reveal}:{})}/></ConversationDisplayBoundary>)}
  {toolResult&&toolResult.conversationId===conversationId&&toolResult.runId===selected&&<section aria-label="已选步骤工具结果">
   <button type="button" data-chat-search-ignore onClick={()=>setToolResult(undefined)}>关闭工具结果正文</button>
   <ConversationDisplayBoundary key={JSON.stringify(toolResult)} label="步骤工具结果"><ActivityToolResult conversationId={conversationId} target={toolResult}/></ConversationDisplayBoundary>
  </section>}
  {artifact&&artifact.conversationId===conversationId&&artifact.runId===selected&&<section aria-label="已选步骤文件">
   <button type="button" data-chat-search-ignore onClick={()=>setArtifact(undefined)}>关闭步骤文件</button>
   <ConversationDisplayBoundary key={JSON.stringify([conversationId,artifact.runId,artifact.activityId,artifact.target])} label="步骤文件详情"><ActivityArtifactDetails conversationId={conversationId} target={artifact.target} onOpen={target=>setArtifact(prior=>prior&&prior.conversationId===conversationId&&prior.target.artifactId===target.artifactId?{...prior,target}:prior)}/></ConversationDisplayBoundary>
  </section>}
 </section>;
}
