import React,{useEffect,useMemo,useState} from 'react';
import {request} from './client';
import {ConversationGoalController,goalPresentation} from './goal-controller.mjs';
const labels:Record<string,string>={pause:'暂停',resume:'继续',stop:'停止'};
export default function ConversationGoal({id,running,runStatus,onPendingChange}:{id:string;running:boolean;runStatus?:string;onPendingChange:(pending:boolean)=>void}){
 const [,render]=useState(0),[error,setError]=useState(''),[confirmStop,setConfirmStop]=useState(false);
 const controller=useMemo(()=>new ConversationGoalController(id,{request}),[id]);
 useEffect(()=>{let mounted=true;controller.onChange=()=>{if(mounted){render(n=>n+1);onPendingChange(controller.pending);}};setError('');setConfirmStop(false);return()=>{mounted=false;controller.onChange=()=>{};controller.dispose();onPendingChange(false);};},[controller,onPendingChange]);
 const refresh=async()=>{try{await controller.refresh();setError('');}catch{setError('目标状态暂不可用，请刷新重试。');}};
 useEffect(()=>{let mounted=true;const read=()=>void controller.refresh().then(()=>{if(mounted)setError('');},()=>{if(mounted)setError('目标状态暂不可用，请刷新重试。');});read();const timer=running?setInterval(read,3000):undefined;return()=>{mounted=false;clearInterval(timer);};},[controller,running,runStatus]);
 const execute=async(action?:string)=>{try{if(action)await controller.control(action);else await controller.retry();setError('');setConfirmStop(false);}catch(reason){setError((reason as {status?:number})?.status===409?'目标或运行状态已变化，请刷新后确认。':'操作结果尚未确认，请核对后重试原操作。');}};
 const goal=controller.goal,view=goal?goalPresentation(goal):null,disabled=controller.busy||controller.pending||!controller.available;
 if(!goal&&controller.available&&!controller.pending&&!error)return null;
 return <section className="jot-native-goal" aria-label="当前目标" aria-busy={controller.loading||controller.busy}>
  <div className="jot-goal-heading"><strong>{view?.label??'目标状态'}</strong><button type="button" disabled={controller.busy||controller.loading} onClick={()=>void refresh()}>刷新目标</button></div>
  {goal&&<><p className="jot-goal-objective">{goal.objective}</p>{goal.roundsStarted!==undefined&&<small>已执行 {goal.roundsStarted} 轮</small>}{goal.phase==='blocked'&&goal.blockedReason?.message&&<p>{goal.blockedReason.message}</p>}
   <div className="jot-goal-actions">{view!.actions.map((action:string)=><button type="button" key={action} title={action==='pause'?'暂停后续轮次；当前操作可能仍在收尾':undefined} disabled={disabled||(action==='resume'&&!running)} onClick={()=>action==='stop'?setConfirmStop(true):void execute(action)}>{labels[action]}</button>)}</div>
   {view!.actions.includes('resume')&&!running&&<p className="jot-goal-hint">目标已保留。当前会话尚未恢复执行，暂不能继续。</p>}
  </>}
  {error&&<p role="alert">{error}</p>}{controller.pending&&<div role="alert"><p>上次操作的结果尚未确认，重试会保留原目标和请求。</p><button type="button" disabled={controller.busy} onClick={()=>void execute()}>重试原目标操作</button></div>}
  {confirmStop&&<div role="alertdialog" aria-label="停止当前目标"><p>停止此目标？已有结果和历史会保留。</p><button type="button" disabled={controller.busy||controller.pending} onClick={()=>setConfirmStop(false)}>返回</button><button type="button" disabled={disabled} onClick={()=>void execute('stop')}>确认停止目标</button></div>}
 </section>;
}
