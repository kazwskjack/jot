import React from 'react';

type Props={uploads:any;busy:boolean;locked:boolean;onAction:(operation:()=>Promise<unknown>)=>void;
 onUpload:(id:string)=>Promise<unknown>;onCancel:(id:string)=>Promise<unknown>;onCancelBatch:(id:string)=>Promise<unknown>};

export default function UploadAttachments({uploads,busy,locked,onAction,onUpload,onCancel,onCancelBatch}:Props){
 const observed:Record<string,string>={created:'等待字节',uploading:'正在接收字节',uploaded:'字节已接收，待封存',completed:'已完成上传',cancelled:'已取消',expired:'保留期已结束'};
 const statuses:Record<string,string>={ready:'上传完成',recovered:'原上传回执已恢复，待核对',uploading:'正在上传',cancelling:'正在取消',cancelled:'已取消',uncertain:'结果尚未确认',rejected:'上传被拒绝',selected:'等待上传'};
 return <>
  {uploads.entries.map((entry:any)=>{
   const name=entry.relativePath||entry.file.name,group=entry.batch,token=group?.batchId||group?.key;
   const first=group&&uploads.entries.find((value:any)=>value.batch===group)?.id===entry.id;
   const pending=group&&group.entries.some((value:any)=>!['ready','recovered','cancelled'].includes(value.status)&&!value.expired);
   const cancelling=entry.stage==='cancel'||entry.stage==='batch-cancel'||entry.cancelPending||group?.cancelPending;
   const needsFile=entry.needsFile&&!entry.expired&&!['complete','done','cancel','batch-cancel','cancelled'].includes(entry.stage);
   const missingBatchFiles=entry.stage==='batch-init'&&!group?.requestBody&&group?.entries.some((value:any)=>value.needsFile);
   return <div key={entry.id} className="jot-upload-entry">
    <span>{name} · {entry.status==='uncertain'&&cancelling?'取消结果未确认':statuses[entry.status]}</span>
    {entry.generated?.delivery==='sending'&&entry.restored&&<p role="status">此截图曾进入消息发送流程，请核对会话记录后确认使用原附件。</p>}
    {entry.generated&&entry.error&&<p role="alert">截图恢复尚未完成 · {entry.error}</p>}
    {entry.observedStatus&&<p role="status">上次读取的服务端状态 · {observed[entry.observedStatus]}</p>}
    {entry.cancelObserved&&<p role="status">已读取到取消状态，原取消请求的回执尚未确认。</p>}
    {entry.cancelObserved&&<button type="button" disabled={busy||locked||entry.reconciling} onClick={()=>void onCancel(entry.id)}>确认原取消回执</button>}
    {uploads.statusSupported&&entry.receipt&&['uncertain','rejected','recovered'].includes(entry.status)&&<button type="button" disabled={busy||locked||entry.running||entry.cancelRequested||entry.reconciling||group?.running||group?.cancelRunning} onClick={()=>onAction(()=>uploads.reconcile(entry.id))}>检查原上传状态</button>}
    {entry.expired&&<p role="status">原上传保留期已结束，可移除此记录。</p>}
    {first&&(pending||group.cancelObserved)&&<button type="button" aria-label={`${group.cancelObserved&&!pending?'确认原取消回执':group.cancelPending?'重试取消':'取消'}批次 ${token}`} disabled={busy||locked} onClick={()=>void onCancelBatch(token)}>{group.cancelObserved&&!pending?'确认原批次取消回执':group.cancelPending?'重试取消批次':'取消此批次'}</button>}
    {['uploading','uncertain','selected'].includes(entry.status)&&entry.stage==='content'&&<button type="button" aria-label={`取消上传 ${name}`} disabled={uploads.blocked||entry.reconciling} onClick={()=>void onCancel(entry.id)}>取消上传</button>}
    {entry.status==='uncertain'&&entry.stage==='cancel'&&<button type="button" disabled={busy||locked} onClick={()=>void onCancel(entry.id)}>重试取消 {name}</button>}
    {needsFile&&!cancelling&&<label>重新选择原文件 {name}<input type="file" aria-label={`重新选择原文件 ${name}`} disabled={busy||locked} onChange={event=>{
     const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)onAction(()=>uploads.reselect(entry.id,file));
    }}/></label>}
    {['uncertain','selected'].includes(entry.status)&&!cancelling&&<button type="button" aria-label={`重试原附件 ${name}`} disabled={busy||locked||needsFile||missingBatchFiles} onClick={()=>onAction(()=>onUpload(entry.id))}>{entry.restored&&entry.stage==='complete'?'确认原上传回执':'重试原附件'}</button>}
    {entry.status==='recovered'&&<><p role="status">请先核对会话中是否已发送此附件。</p><button type="button" disabled={busy||locked} onClick={()=>onAction(()=>uploads.acceptRecovered(entry.id))}>作为待发送附件</button></>}
    {(['ready','recovered','cancelled'].includes(entry.status)||entry.expired||!entry.batchId&&['selected','rejected'].includes(entry.status))&&<button type="button" disabled={busy||locked} onClick={()=>onAction(async()=>{await uploads.remove(entry.id);})}>移除 {name}</button>}
   </div>;
  })}
  <p role="status">原上传请求和阶段回执保存在当前账户与会话下。普通文件刷新后需重新选择原文件，已保存的区域截图会核对本地图片后恢复；已完成的回执须核对后加入待发送附件。</p>
 </>;
}
