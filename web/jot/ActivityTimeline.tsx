// Phase grouping and expandable nested tool history adapt PilotDeck 783499ff,
// AgentTimeline.tsx/SubagentContainer.tsx. Adapted portions retain AGPL-3.0 terms.
import React,{useEffect,useMemo,useRef,useState} from 'react';
import type {Activity} from './types';
import {activityDetailRows,activityDisplayStatus,activityForest,activityIsActive as running,visibleActivityRows,activityKindLabels,activityStatusLabels,type ActivityRow,type ToolActivity,type ActivityReveal,type ActivityRun} from './activity-presentation';
import './activity-timeline.css';

type Group={id:string;kind:ToolActivity['kind'];rows:ActivityRow[]};

function ActivityGroup({group,run,onSelectRun,availableRuns,reveal}:{group:Group;run?:ActivityRun;onSelectRun:(id:string)=>void;availableRuns:Set<string>;reveal?:ActivityReveal}){
 const active=group.rows.filter(row=>running(row.activity,run)).length;
 const failed=group.rows.filter(row=>activityDisplayStatus(row.activity,run)==='failed').length;
 const unconfirmed=group.rows.filter(row=>activityDisplayStatus(row.activity,run)==='unknown').length;
 const [open,setOpen]=useState(active>0),[expanded,setExpanded]=useState<Record<string,boolean>>({}),[page,setPage]=useState(0);
 const expandedRef=useRef(expanded),appliedReveal=useRef('');
 expandedRef.current=expanded;
 useEffect(()=>{
  if(!reveal||appliedReveal.current===reveal.key)return;
  const targetIndex=group.rows.findIndex(row=>row.activity.activity_id===reveal.activityId);
  if(targetIndex<0)return;
  const target=group.rows[targetIndex]!,next={...expandedRef.current,[reveal.activityId]:true};
  let depth=target.depth;
  for(let index=targetIndex-1;index>=0&&depth>0;index--){
   const ancestor=group.rows[index]!;
   if(ancestor.depth<depth){next[ancestor.activity.activity_id]=true;depth=ancestor.depth;}
  }
  const visible=visibleActivityRows(group.rows,next,run);
  const index=visible.findIndex(row=>row.activity.activity_id===reveal.activityId);
  setExpanded(next);setOpen(true);setPage(Math.max(0,Math.floor(index/50)));
  appliedReveal.current=reveal.key;
 },[reveal,group.rows,run]);
 const visible=visibleActivityRows(group.rows,expanded,run);
 const pageCount=Math.max(1,Math.ceil(visible.length/50)),currentPage=Math.min(page,pageCount-1);
 return <details className="jot-activity-group" open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
  <summary>{activityKindLabels[group.kind]} · {group.rows.length} 个步骤{active>0?` · ${active} 个进行中`:''}{failed>0?` · ${failed} 个失败`:''}{unconfirmed>0?` · ${unconfirmed} 个状态待确认`:''}</summary>
  {open&&<>
   <ol start={currentPage*50+1}>{visible.slice(currentPage*50,currentPage*50+50).map(row=>{
    const activity=row.activity,status=activityDisplayStatus(activity,run),isExpanded=expanded[activity.activity_id]??running(activity,run);
    const child=activity.kind==='subagent'?activity.detail.child_run_id:undefined;
    return <li key={activity.activity_id} data-chat-search-activity={activity.activity_id} data-chat-search-ready={isExpanded?'true':'false'} style={{paddingInlineStart:Math.min(row.depth,8)*12}}>
     <button type="button" aria-expanded={isExpanded} onClick={()=>setExpanded(prior=>({...prior,[activity.activity_id]:!isExpanded}))}>
      <span aria-hidden="true">{isExpanded?'收起':'展开'} </span>{activityKindLabels[activity.kind]} · {activity.title} · {activityStatusLabels[status]??activityStatusLabels.unknown}<span data-chat-search-ignore>{row.children>0?` · ${row.children} 个子步骤`:''}</span>
     </button>
     {row.depth>0&&<small data-chat-search-ignore>层级 {row.depth+1} · 父步骤 {activity.parent_activity_id}</small>}
     {row.issue&&<p role="status" data-chat-search-ignore>{row.issue}</p>}
     {isExpanded&&<>
      {status==='unknown'&&activity.status!=='unknown'&&<p role="status" data-chat-search-ignore>所属运行已结束，此步骤尚无终态回执。</p>}
      <dl>{activityDetailRows(activity).map((detail,index)=><React.Fragment key={index}><dt>{detail.label}</dt><dd>{detail.value}</dd></React.Fragment>)}</dl>
      {child&&child!==activity.run_id&&availableRuns.has(child)&&<button type="button" data-chat-search-ignore onClick={()=>onSelectRun(child)}>查看子运行步骤</button>}
     </>}
    </li>;
   })}</ol>
   {pageCount>1&&<nav aria-label="步骤翻页"><button type="button" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>上一页步骤</button><span>{currentPage+1} / {pageCount}</span><button type="button" disabled={currentPage+1===pageCount} onClick={()=>setPage(currentPage+1)}>下一页步骤</button></nav>}
  </>}
 </details>;
}

export default function ActivityTimeline({activities,runs,reveal}:{activities:Activity[];runs:Record<string,ActivityRun>;reveal?:ActivityReveal}){
 const [selection,setSelection]=useState('');
 const appliedReveal=useRef('');
 const tools=useMemo(()=>activities.filter((activity):activity is ToolActivity=>activity.kind!=='compaction'),[activities]);
 const runIds=useMemo(()=>[...new Set(tools.slice().sort((a,b)=>b.started_at.localeCompare(a.started_at)).map(activity=>activity.run_id))],[tools]);
 useEffect(()=>{
  if(!reveal||appliedReveal.current===reveal.key)return;
  const target=tools.find(activity=>activity.activity_id===reveal.activityId);
  if(target){setSelection(target.run_id);appliedReveal.current=reveal.key;}
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
 return <section className="jot-activity-timeline" aria-label="工具与子任务时间线">
  <h3>工具与子任务</h3>
  <label>运行记录 <select value={selected} onChange={event=>setSelection(event.currentTarget.value)}>{runIds.map(id=><option key={id} value={id}>{runs[id]?.created_at??id} · {runs[id]?.status??'历史运行'}</option>)}</select></label>
  <small>当前已加载的公开步骤。父步骤缺失或终态未确认时会保留提示。</small>
  {groups.map(group=><ActivityGroup key={`${selected}:${group.id}`} group={group} {...(run?{run}:{})} onSelectRun={setSelection} availableRuns={availableRuns} {...(reveal?{reveal}:{})}/>)}
 </section>;
}
