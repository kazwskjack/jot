import React,{useEffect,useMemo,useState} from 'react';
import {request,taskDraftScope} from './client';
import {GoalReceiptStore} from './goal-receipts.mjs';
import {ConversationGoalController,goalPresentation,goalControlError,goalResumeHint,goalExecutionHint} from './goal-controller.mjs';
import type {Run} from './types';
const labels:Record<string,string>={pause:'暂停',resume:'继续',stop:'停止'};
export default function ConversationGoal({id,running,runStatus,controlRun,onResumeAccepted,onPendingChange}:{id:string;running:boolean;runStatus?:string;controlRun?:Run|undefined;onResumeAccepted?:()=>void;onPendingChange:(pending:boolean)=>void}){
 const [,render]=useState(0),[error,setError]=useState(''),[confirmStop,setConfirmStop]=useState(false);
 const controller=useMemo(()=>new ConversationGoalController(id,{request},()=>{},true),[id]);
 const ensureRecovery=async()=>{if(controller.recoveryReady)return;await request('/capabilities');controller.configureRecovery(new GoalReceiptStore(window.localStorage,taskDraftScope(),id),async(scope:string)=>{await request('/capabilities');return taskDraftScope()===scope;});};
 useEffect(()=>{let mounted=true;controller.onChange=()=>{if(mounted){render(n=>n+1);onPendingChange(controller.pending);}};setError('');setConfirmStop(false);return()=>{mounted=false;controller.onChange=()=>{};controller.dispose();onPendingChange(false);};},[controller,onPendingChange]);
 const refresh=async()=>{try{await ensureRecovery();await controller.refresh();setError('');if(controller.goal&&goalPresentation(controller.goal).actions.includes('resume'))await controller.refreshReadiness().catch(()=>setError('续跑状态暂不可用，请稍后刷新。'));}catch{setError('目标或操作回执暂不可用，请检查浏览器存储后刷新。');}};
 useEffect(()=>{let mounted=true;const read=async()=>{try{await ensureRecovery();if(!mounted)return;await controller.refresh();if(mounted)setError('');if(controller.goal&&goalPresentation(controller.goal).actions.includes('resume'))await controller.refreshReadiness();}catch{if(mounted)setError('目标或操作回执暂不可用，请检查浏览器存储后刷新。');}};void read();const timer=(running||controller.executing)?setInterval(()=>void read(),3000):undefined;return()=>{mounted=false;clearInterval(timer);};},[controller,running,runStatus,controller.executing]);
 useEffect(()=>{controller.observeRun(controlRun);},[controller,controlRun?.run_id,controlRun?.version,controlRun?.status,controlRun?.error_code]);
 const execute=async(action?:string)=>{try{const result=action?await controller.control(action):await controller.retry();setError('');setConfirmStop(false);if(result?.accepted)onResumeAccepted?.();else if(controller.goal&&goalPresentation(controller.goal).actions.includes('resume'))await controller.refreshReadiness().catch(()=>{});}catch(reason){setError(goalControlError(reason));}};
 const goal=controller.goal,view=goal?goalPresentation(goal):null,disabled=controller.busy||controller.pending||!controller.available||!controller.recoveryReady;
 if(!goal&&controller.available&&!controller.pending&&!error)return null;
 return <section className="jot-native-goal" aria-label="当前目标" aria-busy={controller.loading||controller.busy}>
  <div className="jot-goal-heading"><strong>{view?.label??'目标状态'}</strong><button type="button" disabled={controller.busy||controller.loading} onClick={()=>void refresh()}>刷新目标</button></div>
  {goal&&<><p className="jot-goal-objective">{goal.objective}</p>{goal.roundsStarted!==undefined&&<small>已执行 {goal.roundsStarted} 轮</small>}{goal.phase==='blocked'&&goal.blockedReason?.message&&<p>{goal.blockedReason.message}</p>}
   <div className="jot-goal-actions">{view!.actions.map((action:string)=><button type="button" key={action} title={action==='pause'?'暂停后续轮次；当前操作可能仍在收尾':undefined} disabled={disabled||(action==='resume'&&(controller.executing||['queued','starting','running','waiting_user','waiting_approval','cancelling'].includes(runStatus??'')||controller.resumeReadiness?.ready!==true))} onClick={()=>action==='stop'?setConfirmStop(true):void execute(action)}>{labels[action]}</button>)}</div>
   {view!.actions.includes('resume')&&!controller.executing&&controller.resumeReadiness?.ready!==true&&<p className="jot-goal-hint">{goalResumeHint(controller.resumeReadiness)}</p>}
   {controller.executing&&goal.phase!=='complete'&&!(goal.phase==='active'&&goal.activation==='armed')&&<p role="status" className="jot-goal-hint">续跑已受理，正在同步目标状态。</p>}
   {goalExecutionHint(controller.execution)&&<p role="status" className="jot-goal-hint">{goalExecutionHint(controller.execution)}</p>}
  </>}
  {error&&<p role="alert">{error}</p>}{controller.pending&&<div role="alert"><p>上次操作的结果尚未确认，重试会保留原目标和请求。</p><button type="button" disabled={controller.busy} onClick={()=>void execute()}>重试原目标操作</button></div>}
  {confirmStop&&<div role="alertdialog" aria-label="停止当前目标"><p>停止此目标？已有结果和历史会保留。</p><button type="button" disabled={controller.busy||controller.pending} onClick={()=>setConfirmStop(false)}>返回</button><button type="button" disabled={disabled} onClick={()=>void execute('stop')}>确认停止目标</button></div>}
 </section>;
}
