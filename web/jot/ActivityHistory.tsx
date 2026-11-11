import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import React,{useEffect,useRef,useState} from 'react';
import {request} from './client';
import type {Activity,ActivityHistoryPage} from './types';
import './activity-timeline.css';

function sequence(value:unknown):bigint{
 if(typeof value!=='string'||!/^(0|[1-9]\d{0,18})$/.test(value)||BigInt(value)>9223372036854775807n)throw Error('公开步骤历史序号尚未确认');
 return BigInt(value);
}

function validatePage(page:ActivityHistoryPage,conversationId:string,asOf:string,before:string|undefined,runId:string|undefined){
 if(!page||page.conversation_id!==conversationId||page.as_of_seq!==asOf||page.run_id!==runId||!Array.isArray(page.items)||page.items.length>200
  ||!page.coverage||typeof page.coverage.complete!=='boolean')throw Error('公开步骤历史结果尚未确认');
 const through=before===undefined?sequence(asOf):sequence(before)-1n;
 if(sequence(page.coverage.through_seq)!==through)throw Error('公开步骤历史区间尚未确认');
 let previous=through+1n;
 for(const entry of page.items){
  const current=sequence(entry?.seq),activity=entry?.activity;
  if(current<1n||current>=previous||!activity||typeof activity.activity_id!=='string'||!activity.activity_id
   ||typeof activity.run_id!=='string'||(runId!==undefined&&activity.run_id!==runId)||!['search','browse','file_read','file_edit','command','subagent','crawl','compaction'].includes(activity.kind))throw Error('公开步骤历史顺序或身份尚未确认');
  previous=current;
 }
 const next=page.next_before_seq;
 if(next!==undefined&&(typeof next!=='string'||!page.items.length||next!==page.items.at(-1)?.seq))throw Error('公开步骤历史分页尚未确认');
 const from=next===undefined?(through===0n?0n:1n):sequence(next);
 const expected=through===0n?0n:through-from+1n,count=sequence(page.coverage.event_count);
 if(sequence(page.coverage.from_seq)!==from||count>expected||page.coverage.complete!==(count===expected))throw Error('公开步骤历史覆盖范围尚未确认');
}

export default function ActivityHistory({conversationId,snapshotSeq,requestVersion,onLoaded,runId}:{
 conversationId:string;snapshotSeq?:string;runId?:string;requestVersion:number;onLoaded:(activities:Activity[])=>void;
}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const [enabled,setEnabled]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const [loadedCount,setLoadedCount]=useState(0),[finished,setFinished]=useState(false),[gap,setGap]=useState(false);
 const cursor=useRef<string>(),states=useRef(new Map<string,Activity>()),finishedRef=useRef(false),coverageComplete=useRef(true);
 const loaded=useRef(onLoaded);loaded.current=onLoaded;
 useEffect(()=>{
  cursor.current=undefined;states.current.clear();finishedRef.current=false;coverageComplete.current=true;
  setLoadedCount(0);setFinished(false);setGap(false);setError('');
 },[conversationId,snapshotSeq,runId]);
 useEffect(()=>{if(requestVersion>0&&!finishedRef.current)setEnabled(true);},[requestVersion]);
 useEffect(()=>{
  if(!enabled||!snapshotSeq||finishedRef.current)return;
  const abort=new AbortController();setLoading(true);setError('');
  void(async()=>{
   try{
    sequence(snapshotSeq);
    while(!abort.signal.aborted){
     const before=cursor.current;
     const path=`/conversations/${encodeURIComponent(conversationId)}/activities?as_of_seq=${encodeURIComponent(snapshotSeq)}&limit=200${runId?`&run_id=${encodeURIComponent(runId)}`:''}${before?`&before_seq=${encodeURIComponent(before)}`:''}`;
     const page=await request<ActivityHistoryPage>(path,'GET',undefined,undefined,abort.signal);
     if(abort.signal.aborted)return;
     validatePage(page,conversationId,snapshotSeq,before,runId);
     for(const entry of page.items){
      const activity=entry.activity;
      if(activity.kind!=='compaction'&&!states.current.has(activity.activity_id))states.current.set(activity.activity_id,activity);
     }
     coverageComplete.current&&=page.coverage.complete;
     setGap(!coverageComplete.current);setLoadedCount(states.current.size);
     cursor.current=page.next_before_seq;
     if(page.next_before_seq===undefined){
      loaded.current([...states.current.values()]);states.current.clear();finishedRef.current=true;
      setFinished(true);setEnabled(false);return;
     }
    }
   }catch(cause){if(!abort.signal.aborted){setError(cause instanceof Error?cause.message:'公开步骤历史加载失败');setEnabled(false);}}
   finally{if(!abort.signal.aborted)setLoading(false);}
  })();
  return()=>{abort.abort();setLoading(false);};
 },[enabled,conversationId,snapshotSeq,runId]);
 const start=()=>{
  if(finishedRef.current){
   cursor.current=undefined;states.current.clear();finishedRef.current=false;coverageComplete.current=true;
   setLoadedCount(0);setFinished(false);setGap(false);
  }
  setEnabled(true);
 };
 return <section lang={language} aria-label={t("公开步骤历史","Public Step History")} className="jot-activity-history">
  <button type="button" disabled={!snapshotSeq||loading} onClick={start}>{finished?t('重新读取公开步骤','Read Public Steps Again'):loadedCount?t('继续加载公开步骤','Continue Loading Public Steps'):t('加载全部公开步骤','Load All Public Steps')}</button>
  {loading&&<button type="button" onClick={()=>setEnabled(false)}>{t('停止加载步骤','Stop Loading Steps')}</button>}
  <span role="status">{loading?t('正在读取步骤历史','Reading step history'):finished?t('可用步骤已载入','Available steps loaded'):t('完整步骤历史尚未加载','Full step history has not loaded')} · {t(`本轮已读 ${loadedCount} 个工具步骤`,`${loadedCount} tool steps read in this load`)}</span>
  {gap&&<p role="status">{t('原事件历史存在保留缺口，当前结果仅覆盖可用记录。','Original event history has retention gaps. Current results cover only available records.')}</p>}
  {error&&<p role="alert">{conversationUiError(error,language)}{' '}{t('已加载的时间线会保留，可继续读取。','The loaded timeline is retained. You can continue reading.')}</p>}
 </section>;
}
