// Adapts PilotDeck 783499ff DesktopAboutSections; AGPL-3.0.
import React,{useEffect,useRef,useState} from 'react';
import {taskDraftScope} from '../jot/client';
import {canCheckDesktopUpdate,desktopUpdateCheck,desktopUpdateProgress,desktopUpdateStatus,desktopUpdatesBridge,updatePhaseLabel,type DesktopUpdateCheck,type DesktopUpdateStatus} from './desktop-updates';
export default function DesktopUpdatesPanel({scopeKey,onPendingChange}:{scopeKey:string;onPendingChange:(pending:boolean)=>void}){
 const [bridge]=useState(desktopUpdatesBridge),[status,setStatus]=useState<DesktopUpdateStatus|null>(null),[receipt,setReceipt]=useState<DesktopUpdateCheck|null>(null);
 const [settled,setSettled]=useState(false),[loading,setLoading]=useState(false),[checking,setChecking]=useState(false),[error,setError]=useState('');
 const actions=useRef<{refresh:()=>void;check:()=>void}|null>(null);
 useEffect(()=>{
  if(!bridge)return;
  let disposed=false,generation=0,reading=false,localChecking=false,timer:ReturnType<typeof setTimeout>|undefined,last:DesktopUpdateStatus|null=null;
  const current=()=>!disposed&&taskDraftScope()===scopeKey;
  const clearPoll=()=>{if(timer!==undefined)clearTimeout(timer);timer=undefined;};
  const refresh=async()=>{
   if(!current()||reading||localChecking)return;
   clearPoll();reading=true;const revision=++generation;setLoading(true);
   try{
    const next=desktopUpdateStatus(await bridge.getUpdateStatus());
    if(!current()||revision!==generation)return;
    last=next;setStatus(next);setSettled(true);
    // Progress events only trigger an authoritative status read. They carry no
    // byte counts or install/startup confirmation, and must not synthesize either.
    if(next.checking===true||next.actionPending===true)timer=setTimeout(()=>void refresh(),1000);
   }catch{if(current()&&revision===generation){last=null;setStatus(null);setSettled(true);setError('暂时无法读取更新状态。请刷新状态后再操作。');}}
   finally{reading=false;if(current()&&revision===generation)setLoading(false);}
  };
  const check=async()=>{
   if(!current()||localChecking||reading||!canCheckDesktopUpdate(last))return;
   localChecking=true;generation+=1;clearPoll();setChecking(true);setReceipt(null);setError('');onPendingChange(true);
   try{
    const next=desktopUpdateCheck(await bridge.checkForUpdate());
    if(current())setReceipt(next);
   }catch{if(current())setError('检查未返回可确认的结果。请刷新状态查看原操作；不会自动再次检查或下载。');}
   finally{
    localChecking=false;
    if(current()){setChecking(false);onPendingChange(false);void refresh();}
   }
  };
  actions.current={refresh:()=>{setError('');void refresh();},check:()=>void check()};
  let unsubscribe:(()=>void)|undefined;
  if(typeof bridge.onUpdateProgress==='function'){
   try{unsubscribe=bridge.onUpdateProgress(event=>{if(current()&&desktopUpdateProgress(event))void refresh();});}catch{}
  }
  void refresh();
  return()=>{disposed=true;generation+=1;clearPoll();unsubscribe?.();actions.current=null;if(localChecking)onPendingChange(false);};
 },[bridge,scopeKey,onPendingChange]);
 if(!bridge)return null;
 const candidate=receipt?.available&&receipt.operationId===status?.operationId?receipt:null;
 const busy=checking||status?.checking===true||status?.actionPending===true;
 return <section className="wb-form" data-desktop-update-panel data-desktop-update-ready={settled?'true':'false'} tabIndex={-1} aria-labelledby="wb-desktop-updates">
  <h3 id="wb-desktop-updates">桌面更新</h3>
  <p role="status" aria-live="polite">{checking||status?.checking===true?'正在检查更新…':!settled?'正在读取宿主更新状态…':!status?'更新状态未知':!status.enabled?'当前宿主未开放桌面更新':status.operationId&&status.phase?updatePhaseLabel[status.phase]:'尚无待处理操作回执'}</p>
  {status?.reason&&<p className="wb-settings-note">宿主原因：<code>{status.reason}</code></p>}
  {status?.enabled&&(status.checking===null||status.actionPending===null)&&<p className="wb-settings-note">当前桌面版本仅支持查看更新状态。</p>}
  {status?.operationId&&<p className="wb-settings-note">操作 ID：<code>{status.operationId}</code></p>}
  {candidate&&<p>签名候选：{candidate.version} · 序列 {candidate.sequence} · {candidate.channel} / {candidate.platform} / {candidate.arch}</p>}
  {receipt&&!receipt.available&&<p>本次检查未取得新的签名候选（源版本 {receipt.version}，序列 {receipt.sequence}）。安装与启动状态请以宿主回执为准。</p>}
  {error&&<p role="alert">{error}</p>}
  <div className="wb-actions">
   <button type="button" data-desktop-target="check-updates" disabled={loading||busy||!canCheckDesktopUpdate(status)} onClick={()=>actions.current?.check()}>检查更新</button>
   <button type="button" disabled={loading||checking} onClick={()=>actions.current?.refresh()}>刷新状态</button>
  </div>
  <p className="wb-settings-note">检查会读取宿主批准的更新源，不会自动下载或激活。此入口暂只提供状态与检查；下载、恢复及激活操作尚待接入。</p>
 </section>;
}
