import {useApplicationLanguage,useApplicationText} from './application-language';
import React from 'react';

type Props={uploads:any;busy:boolean;locked:boolean;onAction:(operation:()=>Promise<unknown>)=>void;
 onUpload:(id:string)=>Promise<unknown>;onCancel:(id:string)=>Promise<unknown>;onCancelBatch:(id:string)=>Promise<unknown>};

export default function UploadAttachments({uploads,busy,locked,onAction,onUpload,onCancel,onCancelBatch}:Props){
 const language=useApplicationLanguage(),t=useApplicationText();
 const observed:Record<string,string>={created:t("等待字节","Awaiting Bytes"),uploading:t("正在接收字节","Receiving Bytes"),uploaded:t("字节已接收，待封存","Bytes Received, Awaiting Sealing"),completed:t("已完成上传","Upload Completed"),cancelled:t("已取消","Cancelled"),expired:t("保留期已结束","Retention Period Ended")};
 const statuses:Record<string,string>={ready:t("上传完成","Upload Complete"),recovered:t("原上传回执已恢复，待核对","Original Upload Receipt Restored, Awaiting Verification"),uploading:t("正在上传","Uploading"),cancelling:t("正在取消","Cancelling"),cancelled:t("已取消","Cancelled"),uncertain:t("结果尚未确认","Result Unconfirmed"),rejected:t("上传被拒绝","Upload Rejected"),selected:t("等待上传","Awaiting Upload")};
 return <>
  {uploads.entries.map((entry:any)=>{
   const name=entry.relativePath||entry.file.name,group=entry.batch,token=group?.batchId||group?.key;
   const first=group&&uploads.entries.find((value:any)=>value.batch===group)?.id===entry.id;
   const pending=group&&group.entries.some((value:any)=>!['ready','recovered','cancelled'].includes(value.status)&&!value.expired);
   const cancelling=entry.stage==='cancel'||entry.stage==='batch-cancel'||entry.cancelPending||group?.cancelPending;
   const needsFile=entry.needsFile&&!entry.expired&&!['complete','done','cancel','batch-cancel','cancelled'].includes(entry.stage);
   const missingBatchFiles=entry.stage==='batch-init'&&!group?.requestBody&&group?.entries.some((value:any)=>value.needsFile);
   return <div key={entry.id} lang={language} className="jot-upload-entry">
    <span>{name} · {entry.status==='uncertain'&&cancelling?t('取消结果未确认','Cancellation Unconfirmed'):Object.hasOwn(statuses,entry.status)?statuses[entry.status]:entry.status}</span>
    {entry.generated?.delivery==='sending'&&entry.restored&&<p role="status">{t("此截图曾进入消息发送流程，请核对会话记录后确认使用原附件。","This screenshot previously entered the message-send flow. Check the conversation before confirming use of the original attachment.")}</p>}
    {entry.generated&&entry.error&&<p role="alert">{t('截图恢复尚未完成','Screenshot Recovery Incomplete')} · {entry.error}</p>}
    {entry.observedStatus&&<p role="status">{t('上次读取的服务端状态','Last Observed Server State')} · {Object.hasOwn(observed,entry.observedStatus)?observed[entry.observedStatus]:entry.observedStatus}</p>}
    {entry.cancelObserved&&<p role="status">{t("已读取到取消状态，原取消请求的回执尚未确认。","Cancellation state has been observed, but the original cancellation request receipt is unconfirmed.")}</p>}
    {entry.cancelObserved&&<button type="button" disabled={busy||locked||entry.reconciling} onClick={()=>void onCancel(entry.id)}>{t("确认原取消回执","Confirm Original Cancellation Receipt")}</button>}
    {uploads.statusSupported&&entry.receipt&&['uncertain','rejected','recovered'].includes(entry.status)&&<button type="button" disabled={busy||locked||entry.running||entry.cancelRequested||entry.reconciling||group?.running||group?.cancelRunning} onClick={()=>onAction(()=>uploads.reconcile(entry.id))}>{t("检查原上传状态","Check Original Upload State")}</button>}
    {entry.expired&&<p role="status">{t("原上传保留期已结束，可移除此记录。","The original upload retention period has ended. This record can be removed.")}</p>}
    {first&&(pending||group.cancelObserved)&&<button type="button" aria-label={t(`${group.cancelObserved&&!pending?'确认原取消回执':group.cancelPending?'重试取消':'取消'}批次 ${token}`,`${group.cancelObserved&&!pending?'Confirm Original Cancellation Receipt for':group.cancelPending?'Retry Cancellation of':'Cancel'} Batch ${token}`)} disabled={busy||locked} onClick={()=>void onCancelBatch(token)}>{group.cancelObserved&&!pending?t('确认原批次取消回执','Confirm Original Batch Cancellation Receipt'):group.cancelPending?t('重试取消批次','Retry Batch Cancellation'):t('取消此批次','Cancel This Batch')}</button>}
    {['uploading','uncertain','selected'].includes(entry.status)&&entry.stage==='content'&&<button type="button" aria-label={t(`取消上传 ${name}`,`Cancel Upload ${name}`)} disabled={uploads.blocked||entry.reconciling} onClick={()=>void onCancel(entry.id)}>{t("取消上传","Cancel Upload")}</button>}
    {entry.status==='uncertain'&&entry.stage==='cancel'&&<button type="button" disabled={busy||locked} onClick={()=>void onCancel(entry.id)}>{t('重试取消','Retry Cancellation')} {name}</button>}
    {needsFile&&!cancelling&&<label>{t('重新选择原文件','Reselect Original File')} {name}<input type="file" aria-label={t(`重新选择原文件 ${name}`,`Reselect Original File ${name}`)} disabled={busy||locked} onChange={event=>{
     const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)onAction(()=>uploads.reselect(entry.id,file));
    }}/></label>}
    {['uncertain','selected'].includes(entry.status)&&!cancelling&&<button type="button" aria-label={t(`重试原附件 ${name}`,`Retry Original Attachment ${name}`)} disabled={busy||locked||needsFile||missingBatchFiles} onClick={()=>onAction(()=>onUpload(entry.id))}>{entry.restored&&entry.stage==='complete'?t('确认原上传回执','Confirm Original Upload Receipt'):t('重试原附件','Retry Original Attachment')}</button>}
    {entry.status==='recovered'&&<><p role="status">{t("请先核对会话中是否已发送此附件。","Check whether this attachment was already sent in the conversation first.")}</p><button type="button" disabled={busy||locked} onClick={()=>onAction(()=>uploads.acceptRecovered(entry.id))}>{t("作为待发送附件","Use as an Attachment to Send")}</button></>}
    {(['ready','recovered','cancelled'].includes(entry.status)||entry.expired||!entry.batchId&&['selected','rejected'].includes(entry.status))&&<button type="button" disabled={busy||locked} onClick={()=>onAction(async()=>{await uploads.remove(entry.id);})}>{t('移除','Remove')} {name}</button>}
   </div>;
  })}
  <p lang={language} role="status">{t('原上传请求和阶段回执保存在当前账户与会话下。普通文件刷新后需重新选择原文件，已保存的区域截图会核对本地图片后恢复；已完成的回执须核对后加入待发送附件。','Original upload requests and stage receipts are saved for the current account and conversation. After refresh, reselect original ordinary files. Saved region screenshots are restored after checking the local image. Verify completed receipts before adding them as attachments to send.')}</p>
 </>;
}
