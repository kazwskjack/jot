import {useState} from 'react';
import {useApplicationLanguage,useApplicationText} from './application-language';
import {request,taskDraftScope} from './client';
import {useResource} from '../workbench/useResource';
import {validateStandaloneTerminalCommandCatalog} from './standalone-terminal-command-history.mjs';
import type {StandaloneTerminalAdmission} from '../../packages/gateway/src/terminal/standalone-admissions';
import type {StandaloneTerminalCommandCatalog,StandaloneTerminalCommandRecord} from '../../packages/gateway/src/terminal/standalone-commands';
export default function StandaloneTerminalCommandHistory({admission,scopeKey,locked,revision,onRestore}:{admission:StandaloneTerminalAdmission;scopeKey:string;locked:boolean;revision:number;onRestore:(admissionId:string,item:StandaloneTerminalCommandRecord)=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const [opened,setOpened]=useState(false),[cursors,setCursors]=useState<Array<string|null>>([null]),[page,setPage]=useState(0),before=cursors[page]??null;
 const history=useResource(async signal=>{
  if(taskDraftScope()!==scopeKey)throw Error('terminal_session_scope_changed');
  const value=validateStandaloneTerminalCommandCatalog(await request<unknown>('/standalone-terminals/admissions/'+admission.request_id+'/terminals/commands'+(before?'?before_request_id='+encodeURIComponent(before):''),'GET',undefined,undefined,signal),admission,before) as StandaloneTerminalCommandCatalog;
  if(taskDraftScope()!==scopeKey)throw Error('terminal_session_scope_changed');
  return{...value,scope:scopeKey};
 },JSON.stringify(['standalone-terminal-command-history',scopeKey,admission.request_id,admission.session_id,admission.state_sha256,before,revision]),opened&&admission.state==='ready');
 const current=!history.loading&&!history.error&&history.data?.scope===scopeKey&&history.data.admission_id===admission.request_id
  &&history.data.session_id===admission.session_id&&history.data.admission_state_sha256===admission.state_sha256&&history.data.before_request_id===before?history.data:null;
 const states={unknown:t('原结果未知','Original Outcome Unknown'),completed:t('原操作已完成','Original Operation Completed'),rejected:t('原操作已拒绝','Original Operation Rejected'),wait_ended_unknown:t('已结束等待，结果保留未知','Wait Ended; Outcome Remains Unknown')};
 return <details lang={language} open={opened} onToggle={event=>{if(event.target===event.currentTarget)setOpened(event.currentTarget.open);}}>
  <summary>{t('原终端创建/关闭记录','Original Terminal Create/Close Records')}</summary>
  <p>{t('这里只读取原请求和持久回执状态，不包含终端输入文本。恢复后仍需显式核对回执，不重发操作。','This reads original requests and persisted receipt status, without terminal input text. Restored requests require explicit receipt reconciliation and are never resent.')}</p>
  <button type="button" disabled={history.loading} onClick={history.reload}>{t('重新读取原记录','Read Original Records Again')}</button>
  {history.loading&&<p role="status">{t('正在读取原操作记录…','Reading Original Operation Records…')}</p>}
  {history.error&&<p role="alert">{t('原记录尚未确认，可重新读取或返回首页。','The original records are unconfirmed. Read again or return to the first page.')}</p>}
  {current&&<>{!current.items.length&&<p role="status">{t('此页没有已保存的创建/关闭请求。','This page has no retained create/close requests.')}</p>}
   <ul>{current.items.map(item=><li key={item.request_id}>
    <strong>{item.command.action==='create'?t('创建','Create'):t('关闭','Close')}</strong> · {states[item.receipt_state]} · <time>{item.created_at}</time>
    <p><code>{item.request_id}</code> · <code>{item.command.terminal_id}</code></p>
    <details><summary>{t('查看原操作参数','Read Original Operation Parameters')}</summary>
     <p>{t('原终端实例 ','Original Host Instance ')}<code>{item.command.host_instance}</code></p>
     {item.command.action==='create'&&<><p>{item.command.cols} × {item.command.rows}</p><p>Shell <code style={{overflowWrap:'anywhere'}}>{item.command.shell_path??t('原执行环境默认值','Original Environment Default')}</code></p></>}
    </details>
    <button type="button" disabled={locked||history.loading} onClick={()=>onRestore(admission.request_id,item)}>{t('恢复原请求以核对回执','Restore Original Request for Reconciliation')}</button>
   </li>)}</ul>
  </>}
  <nav aria-label={t('原终端操作记录分页','Original Terminal Operation Pages')}>
   <button type="button" disabled={history.loading||page===0} onClick={()=>{setPage(0);setCursors([null]);}}>{t('返回首页','First Page')}</button>
   <button type="button" disabled={history.loading||page===0} onClick={()=>setPage(value=>value-1)}>{t('上一页','Previous Page')}</button>
   <span>{t(`第 ${page+1} 页`,`Page ${page+1}`)}</span>
   <button type="button" disabled={history.loading||!current?.next_before_request_id} onClick={()=>{const next=current?.next_before_request_id;if(next){setCursors(values=>[...values.slice(0,page+1),next]);setPage(value=>value+1);}}}>{t('下一页','Next Page')}</button>
  </nav>
 </details>;
}
