import {useApplicationLanguage} from '../jot/application-language';
import {desktopUiMessage} from './desktop-ui-messages';
// Adapts PilotDeck 783499ff DesktopAboutSections; AGPL-3.0.
import React,{useEffect,useRef,useState} from 'react';
import {taskDraftScope} from '../jot/client';
import {canCheckDesktopUpdate,desktopUpdateActionAllowed,desktopUpdateCheck,desktopUpdateProgress,desktopUpdateStatus,desktopUpdatesBridge,updatePhaseLabel,type DesktopUpdateAction,type DesktopUpdateCheck,type DesktopUpdateStatus} from './desktop-updates';
export default function DesktopUpdatesPanel({scopeKey,onPendingChange,canBeginAction}:{scopeKey:string;onPendingChange:(pending:boolean)=>void;canBeginAction:()=>boolean}){
 const language=useApplicationLanguage(),message=(value:string)=>desktopUiMessage(value,language);
 const [bridge]=useState(desktopUpdatesBridge),[status,setStatus]=useState<DesktopUpdateStatus|null>(null),[receipt,setReceipt]=useState<DesktopUpdateCheck|null>(null);
 const [settled,setSettled]=useState(false),[loading,setLoading]=useState(false),[checking,setChecking]=useState(false),[error,setError]=useState('');
 const [action,setAction]=useState<'download'|'activate'|null>(null),[cancelling,setCancelling]=useState(false),[cancelRequested,setCancelRequested]=useState<string|null>(null);
 const [transferAction,setTransferAction]=useState<'pause'|'resume'|null>(null);
 const actions=useRef<{refresh:()=>void;check:()=>void;run:(kind:DesktopUpdateAction)=>void}|null>(null);
 useEffect(()=>{
  if(!bridge)return;
  let disposed=false,generation=0,reading=false,localChecking=false,timer:ReturnType<typeof setTimeout>|undefined;
  let last:DesktopUpdateStatus|null=null,lastReceipt:DesktopUpdateCheck|null=null,localAction:'download'|'activate'|null=null,localCancel=false,reported=false,cancellationFor:string|null=null;
  let localControl:'pause'|'resume'|null=null;
  const current=()=>!disposed&&taskDraftScope()===scopeKey;
  const syncPending=()=>{const pending=localChecking||localAction!==null||localCancel||localControl!==null;if(pending!==reported){reported=pending;onPendingChange(pending);}};
  const clearPoll=()=>{if(timer!==undefined)clearTimeout(timer);timer=undefined;};
  const refresh=async()=>{
   if(!current()||reading||localChecking)return;
   clearPoll();reading=true;const revision=++generation;setLoading(true);
   try{
    const next=desktopUpdateStatus(await bridge.getUpdateStatus());
    if(!current()||revision!==generation)return;
    last=next;setStatus(next);setSettled(true);
    if(cancellationFor&&(next.operationId!==cancellationFor||next.actionPending===false)){cancellationFor=null;setCancelRequested(null);}
    // Events and command replies never synthesize progress or install success.
    // Only native status is displayed; while our command settles, keep reading.
    if(next.checking===true||next.actionPending===true||localAction!==null||localCancel||localControl!==null)timer=setTimeout(()=>void refresh(),1000);
   }catch{if(current()&&revision===generation){last=null;setStatus(null);setSettled(true);setError('暂时无法读取更新状态。请刷新状态后再操作。');}}
   finally{reading=false;if(current()&&revision===generation)setLoading(false);}
  };
  const check=async()=>{
   if(!current()||localChecking||localAction!==null||localCancel||localControl!==null||reading||!canCheckDesktopUpdate(last))return;
   if(!canBeginAction()){setError('其他设置操作尚未确认，请等待后再检查更新。');return;}
   localChecking=true;generation+=1;clearPoll();setChecking(true);lastReceipt=null;setReceipt(null);setError('');syncPending();
   try{
    const next=desktopUpdateCheck(await bridge.checkForUpdate());
    if(current()){lastReceipt=next;setReceipt(next);}
   }catch{if(current())setError('检查未返回可确认的结果。请刷新状态查看原操作；不会自动再次检查或下载。');}
   finally{localChecking=false;if(current()){setChecking(false);syncPending();void refresh();}}
  };
  const run=async(kind:DesktopUpdateAction)=>{
   if(!current()||localChecking||!desktopUpdateActionAllowed(last,lastReceipt,kind))return;
   if((kind==='download'||kind==='activate')&&!canBeginAction()){setError('其他设置操作尚未确认，请等待后再更新。');return;}
   const operationId=last!.operationId!;
   const method=kind==='download'?bridge.downloadUpdate:kind==='cancel'?bridge.cancelUpdate:kind==='pause'?bridge.pauseUpdate:kind==='resume'?bridge.resumeUpdate:bridge.activateUpdate;
   if(typeof method!=='function')return;
   if(kind==='cancel'){
    if(localCancel||localAction==='activate'||cancellationFor===operationId)return;
    localCancel=true;cancellationFor=operationId;setCancelling(true);setCancelRequested(operationId);
   }else if(kind==='pause'||kind==='resume'){
    if(localControl!==null||localCancel||localAction==='activate')return;
    localControl=kind;setTransferAction(kind);
   }else{
    if(reading||localAction!==null||localCancel||localControl!==null)return;
    localAction=kind;setAction(kind);
   }
   setError('');syncPending();
   try{
    // Invoke only the selected method once, with the current original UUID.
    // Native signature/backup/probe/confirmation remains the execution authority.
    const result=method.call(bridge,operationId);void refresh();await result;
   }catch{
    if(current()){
     if(kind!=='download'||cancellationFor!==operationId)setError('更新操作未返回可确认的结果。请刷新宿主状态；不会自动重试操作。');
     lastReceipt=null;setReceipt(null);
     if(kind==='cancel'){cancellationFor=null;setCancelRequested(null);}
    }
   }finally{
    if(kind==='cancel')localCancel=false;else if(kind==='pause'||kind==='resume')localControl=null;else localAction=null;
    if(current()){if(kind==='cancel')setCancelling(false);else if(kind==='pause'||kind==='resume')setTransferAction(null);else setAction(null);syncPending();void refresh();}
   }
  };
  actions.current={refresh:()=>{setError('');void refresh();},check:()=>void check(),run:kind=>void run(kind)};
  let unsubscribe:(()=>void)|undefined;
  if(typeof bridge.onUpdateProgress==='function'){
   try{unsubscribe=bridge.onUpdateProgress(event=>{if(current()&&desktopUpdateProgress(event))void refresh();});}catch{}
  }
  void refresh();
  return()=>{disposed=true;generation+=1;clearPoll();try{unsubscribe?.();}finally{actions.current=null;if(reported){reported=false;onPendingChange(false);}}};
 },[bridge,scopeKey,onPendingChange,canBeginAction]);
 if(!bridge)return null;
 const candidate=receipt?.available&&receipt.operationId===status?.operationId?receipt:null;
 const busy=checking||action!==null||cancelling||transferAction!==null||status?.checking===true||status?.actionPending===true;
 const otherPending=!canBeginAction();
 const hasActions=status?.operationCommands===1&&typeof bridge.downloadUpdate==='function'&&typeof bridge.cancelUpdate==='function'&&typeof bridge.activateUpdate==='function';
 const cancellingOperation=!!cancelRequested&&cancelRequested===status?.operationId&&(cancelling||action==='download'||status?.actionPending===true);
 const phaseText=status?.downloadControl?.paused?(status.downloadControl.waiting?'已暂停在文件写入边界':'已请求暂停，等待写入边界'):!settled?'正在读取宿主更新状态…':!status?'更新状态未知':!status.enabled?'当前宿主未开放桌面更新':status.operationId&&status.phase?updatePhaseLabel[status.phase]:'尚无待处理操作回执';
 return <section lang={language} className="wb-form" data-desktop-update-panel data-desktop-update-ready={settled?'true':'false'} tabIndex={-1} aria-labelledby="wb-desktop-updates" aria-busy={busy}>
  <h3 id="wb-desktop-updates">{message("桌面更新")}</h3>
  <p role="status" aria-live="polite">{checking||status?.checking===true?message('正在检查更新…'):cancellingOperation?message('取消请求正在处理，请等待宿主状态确认。'):action==='activate'?message('正在等待原生确认或宿主处理激活…'):message(phaseText)}</p>
  {status?.reason&&<p className="wb-settings-note">{message("宿主原因：")}<code>{status.reason}</code></p>}
  {status?.enabled&&(status.checking===null||status.actionPending===null)&&<p className="wb-settings-note">{message("当前桌面版本仅支持查看更新状态。")}</p>}
  {status?.enabled&&!hasActions&&<p className="wb-settings-note">{message("当前桌面版本未开放手动更新操作。")}</p>}
  {status?.operationId&&<p className="wb-settings-note">{message("操作 ID：")}<code>{status.operationId}</code></p>}
  {candidate&&<p>{message("签名候选：")}{candidate.version}{message(" · 序列 ")}{candidate.sequence} · {candidate.channel} / {candidate.platform} / {candidate.arch}</p>}
  {receipt&&!receipt.available&&<p>{message("本次检查未取得新的签名候选（源版本 ")}{receipt.version}{message("，序列 ")}{receipt.sequence}{message("）。安装与启动状态请以宿主回执为准。")}</p>}
  {status?.operationId&&!candidate&&['available','downloading','downloaded','staged','awaiting-activation'].includes(status.phase??'')&&<p className="wb-settings-note">{message("先检查并恢复原候选，再选择下载或激活。")}</p>}
  {status?.transfer&&<div>
   <p>{message("文件数据进度：")}{status.transfer.transferred.toLocaleString()} / {status.transfer.total.toLocaleString()}{message(" 字节")}</p>
   {status.transfer.total>0&&<progress max={status.transfer.total} value={status.transfer.transferred} aria-label={message("更新文件数据进度")}/>}
   <p>{message("下载速率：")}{status.downloadControl?.paused?message('已暂停'):status.transfer.bytesPerSecond===null?message('暂无有效样本'):status.transfer.bytesPerSecond.toLocaleString(undefined,{maximumFractionDigits:1})+message(' 字节/秒')}</p>
   <p className="wb-settings-note">{message("仅统计已写入或重新核对的文件数据，不表示签名校验、准备或安装已完成。速率仅来自本次新下载并写入的数据。")}</p>
  </div>}
  {error&&<p role="alert">{message(error)}</p>}
  <div className="wb-actions">
   <button type="button" data-desktop-target="check-updates" disabled={otherPending||loading||busy||!canCheckDesktopUpdate(status)} onClick={()=>actions.current?.check()}>{message("检查更新／恢复候选")}</button>
   <button type="button" disabled={loading||checking} onClick={()=>actions.current?.refresh()}>{message("刷新状态")}</button>
   {hasActions&&<>
    <button type="button" disabled={otherPending||loading||busy||!desktopUpdateActionAllowed(status,receipt,'download')} onClick={()=>actions.current?.run('download')}>{status?.phase==='available'?message('下载并准备'):message('恢复下载与准备')}</button>
    {status?.downloadControlRevision===1&&typeof bridge.pauseUpdate==='function'&&typeof bridge.resumeUpdate==='function'&&<button type="button" disabled={transferAction!==null||cancelling||cancellingOperation||!desktopUpdateActionAllowed(status,receipt,status.downloadControl?.paused?'resume':'pause')} onClick={()=>actions.current?.run(status.downloadControl?.paused?'resume':'pause')}>{transferAction==='pause'?message('正在请求暂停…'):transferAction==='resume'?message('正在请求继续…'):status.downloadControl?.paused?message('继续当前下载'):message('暂停当前下载')}</button>}
    <button type="button" disabled={checking||cancelling||action==='activate'||cancellingOperation||!desktopUpdateActionAllowed(status,receipt,'cancel')} onClick={()=>actions.current?.run('cancel')}>{message("取消此更新")}</button>
    <button type="button" disabled={otherPending||loading||busy||!desktopUpdateActionAllowed(status,receipt,'activate')} onClick={()=>actions.current?.run('activate')}>{message("激活并重启")}</button>
   </>}
  </div>
  <p className="wb-settings-note">{message("检查不会自动下载或激活。下载会校验签名、准备备份及候选版本；激活前需在原生对话框确认，确认后可能重启应用。取消请求返回后仍需等待宿主状态确认。")}</p>
 </section>;
}
