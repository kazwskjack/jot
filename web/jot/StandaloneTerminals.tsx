import {useCallback,useContext,useEffect,useRef,useState} from 'react';
import {useApplicationLanguage,useApplicationText} from './application-language';
import {request,taskDraftScope} from './client';
import {TerminalPanel} from './ConversationTerminals';
import ConversationDisplayBoundary from './ConversationDisplayBoundary';
import StandaloneTerminalCommandHistory from './StandaloneTerminalCommandHistory';
import type {StandaloneTerminalCommandRecord} from '../../packages/gateway/src/terminal/standalone-commands';
import {MutationPendingState} from '../workbench/useMutationReceipt';
import {useResource} from '../workbench/useResource';
import {StandaloneTerminalCommandStore} from './terminal-command-store.mjs';
import {StandaloneTerminalSessionStore,validateStandaloneTerminalAdmission,validateStandaloneTerminalCatalog} from './standalone-terminal-session.mjs';
import type {StandaloneTerminalAdmission,StandaloneTerminalAdmissionCatalog} from '../../packages/gateway/src/terminal/standalone-admissions';
type Intent={request_id:string;workspace_id:string};
type Workspace={workspace_id:string;title:string;can_read:boolean;can_write:boolean};
/** Explicit independent Session creation preserves its identity before the first request. */
export default function StandaloneTerminals({scopeKey,workspaces,onInputPendingChange}:{scopeKey:string;workspaces:readonly Workspace[];onInputPendingChange:(value:boolean)=>void}){
 const language=useApplicationLanguage(),t=useApplicationText(),mutationPending=useContext(MutationPendingState);
 const [journal]=useState(()=>{try{
  const store=new StandaloneTerminalSessionStore(window.sessionStorage,scopeKey),items=store.read() as Intent[];let selected=items[0]?.request_id??'';
  for(const item of items){try{if(!new StandaloneTerminalCommandStore(window.sessionStorage,scopeKey,item.request_id).read()?.command)continue;}catch{}selected=item.request_id;break;}
  return{store,items,selected,error:''};
 }catch{return{store:null,items:[] as Intent[],selected:'',error:'standalone_terminal_storage_invalid'};}});
 const [items,setItems]=useState<Intent[]>(journal.items),[selected,setSelected]=useState(journal.selected);
 const [workspace,setWorkspace]=useState(workspaces.find(item=>item.can_read&&item.can_write)?.workspace_id??'');
 const [opened,setOpened]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [snapshot,setSnapshot]=useState<StandaloneTerminalAdmission>(),[inputPending,setInputPending]=useState(false);
 const [terminalEpoch,setTerminalEpoch]=useState(0),[historyRevision,setHistoryRevision]=useState(0);
 const pendingInput=useRef(false);
 const alive=useRef(true),operation=useRef<AbortController|null>(null),selection=useRef(selected);selection.current=selected;
 const intent=items.find(item=>item.request_id===selected),value=snapshot?.request_id===selected?snapshot:undefined;
 const locked=busy||mutationPending||inputPending,canPrepare=workspaces.some(item=>item.workspace_id===workspace&&item.can_read&&item.can_write);
 const [cursors,setCursors]=useState<Array<string|null>>([null]),[page,setPage]=useState(0),before=cursors[page]??null;
 const catalog=useResource(async signal=>{
  if(taskDraftScope()!==scopeKey)throw Error('terminal_session_scope_changed');
  const result=validateStandaloneTerminalCatalog(await request<unknown>('/standalone-terminals/admissions'+(before?'?before_request_id='+encodeURIComponent(before):''),'GET',undefined,undefined,signal),before) as StandaloneTerminalAdmissionCatalog;
  if(taskDraftScope()!==scopeKey)throw Error('terminal_session_scope_changed');
  return{...result,scope:scopeKey};
 },JSON.stringify(['standalone-terminal-catalog',scopeKey,before]),opened&&/^[a-f0-9]{64}$/.test(scopeKey));
 const currentCatalog=!catalog.loading&&!catalog.error&&catalog.data?.scope===scopeKey&&catalog.data.before_request_id===before?catalog.data:null;
 const inputChanged=useCallback((_id:string,pending:boolean)=>{pendingInput.current=pending;setInputPending(pending);onInputPendingChange(pending);},[onInputPendingChange]);
 const activeChanged=useCallback((_id:string,_active:boolean)=>{},[]);
 const settled=useCallback((message?:string)=>{if(message)setNotice(message);setHistoryRevision(value=>value+1);},[]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;operation.current?.abort();onInputPendingChange(false);};},[onInputPendingChange]);
 async function perform(original:Intent,action:'read'|'prepare'|'dispatch'|'observe'|'cancel'){
  if(operation.current||pendingInput.current||taskDraftScope()!==scopeKey||!journal.store)return;
  const current=value;
  if(!['read','prepare'].includes(action)&&(!current||current.request_id!==original.request_id))return;
  const abort=new AbortController();operation.current=abort;setBusy(true);setError('');
  const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(30000)]),path='/standalone-terminals/admissions';
  try{
   const result=action==='read'?await request<unknown>(path+'/'+original.request_id,'GET',undefined,undefined,signal)
    :action==='prepare'?await request<unknown>(path,'POST',original,original.request_id,signal)
    :await request<unknown>(path+'/'+original.request_id+'/control','POST',{action,expected_version:current!.version,expected_state_sha256:current!.state_sha256},original.request_id,signal);
   signal.throwIfAborted();if(!alive.current||abort.signal.aborted||taskDraftScope()!==scopeKey)return;
   const admitted=validateStandaloneTerminalAdmission(result,original) as StandaloneTerminalAdmission;
   if(selection.current===original.request_id)setSnapshot(admitted);
   if(action!=='read')catalog.reload();
  }catch{
   if(alive.current&&!abort.signal.aborted&&taskDraftScope()===scopeKey)setError(t('原请求尚未确认，请读取原请求。不会自动重发创建。','The original request is unconfirmed. Read it again; creation is never automatically resent.'));
  }finally{if(operation.current===abort){operation.current=null;if(alive.current)setBusy(false);}}
 }
 useEffect(()=>{if(opened&&intent)void perform(intent,'read');},[opened,selected]);
 function prepare(){
  if(locked||pendingInput.current||operation.current||!journal.store||taskDraftScope()!==scopeKey||!canPrepare)return;
  const original={request_id:crypto.randomUUID(),workspace_id:workspace};
  try{const next=journal.store.add(original) as Intent[];setItems(next);selection.current=original.request_id;setSelected(original.request_id);setSnapshot(undefined);void perform(original,'prepare');}
  catch{setError(t('无法保存原请求，尚未发送。请保留当前记录。','The original request could not be saved and was not sent. Keep the current records.'));}
 }
 function openExisting(admitted:StandaloneTerminalAdmission){
  if(locked||pendingInput.current||operation.current||!journal.store||taskDraftScope()!==scopeKey)return;
  const original={request_id:admitted.request_id,workspace_id:admitted.workspace_id};
  try{setItems(journal.store.add(original) as Intent[]);selection.current=original.request_id;setSelected(original.request_id);setSnapshot(undefined);void perform(original,'read');}
  catch{setError(t('无法保留此请求，请先清理已确认的本地记录；服务端会话仍保留。','This request could not be retained. Remove a confirmed local record first; server sessions remain unchanged.'));}
 }
 function restoreOriginalCommand(admissionId:string,item:StandaloneTerminalCommandRecord){
  if(locked||pendingInput.current||operation.current||taskDraftScope()!==scopeKey||value?.state!=='ready'||value.request_id!==admissionId)return;
  try{
   const store=new StandaloneTerminalCommandStore(window.sessionStorage,scopeKey,admissionId);
   store.restoreCommand({path:'/standalone-terminals/admissions/'+admissionId+'/terminals/commands',method:'POST',key:item.command.request_id,body:item.command});
   setTerminalEpoch(value=>value+1);
   setNotice(t('已保留原请求。请在终端控件中核对原回执；不会重发操作。','The original request is retained. Reconcile its receipt in terminal controls; the operation will not be resent.'));
  }catch{setError(t('无法恢复此原请求，请先保留并处理当前未确认记录。','This original request could not be restored. Retain and resolve the current unconfirmed record first.'));}
 }
 function forgetLocal(){
  if(locked||pendingInput.current||operation.current||!journal.store||!intent||!value||taskDraftScope()!==scopeKey)return;
  try{
   if(new StandaloneTerminalCommandStore(window.sessionStorage,scopeKey,intent.request_id).read()?.command)throw Error('terminal_request_pending');
   const next=journal.store.remove(intent) as Intent[];setItems(next);selection.current=next[0]?.request_id??'';setSelected(selection.current);setSnapshot(undefined);
   setNotice(t('仅移除了本标签页记录，服务端会话和终端仍保留。','Only this tab record was removed. The server session and terminals are retained.'));
  }catch{setError(t('记录仍需保留：请先核对原命令回执或结束等待。','Keep this record until the original command receipt is checked or its wait is ended.'));}
 }
 const states={prepared:t('已准备，尚未建立会话','Prepared; Session Not Created'),dispatched:t('已派发，待确认','Dispatched; Awaiting Confirmation'),unknown:t('结果未知','Outcome Unknown'),ready:t('原生会话已确认','Native Session Confirmed'),cancelled:t('未启动请求已取消','Unstarted Request Cancelled')};
 return <details lang={language} open={opened} onToggle={event=>{if(event.target===event.currentTarget)setOpened(event.currentTarget.open);}}>
  <summary>{t('独立终端会话','Standalone Terminal Sessions')}</summary>
  <p>{t('无需对话或模型任务。先准备请求，再显式建立原生会话和终端；不会自动运行登录命令。','No conversation or model task is needed. Prepare a request, then explicitly create its native session and terminal. Login commands never run automatically.')}</p>
  {journal.error&&<p role="alert">{t('当前账户的请求记录无法读取，已停止创建。','The current account request records could not be read. Creation is disabled.')}</p>}
  <fieldset disabled={locked||Boolean(journal.error)}><legend>{t('准备独立会话','Prepare Standalone Session')}</legend>
   <label>{t('工作区 ','Workspace ')}<select value={workspace} onChange={event=>setWorkspace(event.currentTarget.value)}>
    <option value="">{t('选择可写工作区','Choose a Writable Workspace')}</option>
    {workspaces.filter(item=>item.can_read&&item.can_write).map(item=><option key={item.workspace_id} value={item.workspace_id}>{item.title||item.workspace_id}</option>)}
   </select></label>
   <button type="button" disabled={!canPrepare} onClick={prepare}>{t('准备新请求','Prepare New Request')}</button>
  </fieldset>
  <label>{t('本标签页保留的原请求 ','Original Requests Kept in This Tab ')}<select value={selected} disabled={locked||Boolean(journal.error)} onChange={event=>{if(pendingInput.current||operation.current||mutationPending)return;setSelected(event.currentTarget.value);setSnapshot(undefined);setError('');setNotice('');}}>
   <option value="">{t('选择原请求','Choose Original Request')}</option>
   {items.map(item=><option key={item.request_id} value={item.request_id}>{item.workspace_id} · {item.request_id}</option>)}
  </select></label>
  {busy&&<p role="status">{t('正在核对原请求…','Checking Original Request…')}</p>}
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <section aria-label={t('服务端独立会话目录','Server Standalone Session Catalog')}>
   <h4>{t('已有独立会话','Existing Standalone Sessions')}</h4>
   <p>{t('目录仅展示当前账户、已配置工作区的持久记录。选择会话不会创建或恢复执行环境。','The catalog contains persisted records for this account and configured workspaces. Selecting a session does not create or recover its execution environment.')}</p>
   <button type="button" disabled={catalog.loading||busy||inputPending} onClick={catalog.reload}>{t('重新读取目录','Read Catalog Again')}</button>
   {catalog.loading&&<p role="status">{t('正在读取目录…','Reading Catalog…')}</p>}
   {catalog.error&&<p role="alert">{t('目录尚未确认，可重新读取或返回首页。','The catalog is unconfirmed. Read it again or return to the first page.')}</p>}
   {currentCatalog&&<>{!currentCatalog.items.length&&<p role="status">{t('此页没有独立会话记录。','This page has no standalone session records.')}</p>}
    <ul>{currentCatalog.items.map(item=><li key={item.request_id}>
     <code>{item.workspace_id}</code> · {states[item.state]} · <time>{item.created_at}</time>
     <p><code>{item.request_id}</code></p>
     <button type="button" disabled={locked||Boolean(journal.error)||selected===item.request_id} onClick={()=>openExisting(item)}>{t('打开原会话控件','Open Original Session Controls')}</button>
    </li>)}</ul>
   </>}
   <nav aria-label={t('独立会话目录分页','Standalone Catalog Pages')}>
    <button type="button" disabled={locked||catalog.loading||page===0} onClick={()=>{setPage(0);setCursors([null]);}}>{t('返回首页','First Page')}</button>
    <button type="button" disabled={locked||catalog.loading||page===0} onClick={()=>setPage(value=>value-1)}>{t('上一页','Previous Page')}</button>
    <span>{t(`第 ${page+1} 页`,`Page ${page+1}`)}</span>
    <button type="button" disabled={locked||!currentCatalog?.next_before_request_id} onClick={()=>{const next=currentCatalog?.next_before_request_id;if(next){setCursors(values=>[...values.slice(0,page+1),next]);setPage(value=>value+1);}}}>{t('下一页','Next Page')}</button>
   </nav>
  </section>
  {intent&&<>
   <p>{t('请求 ','Request ')}<code>{intent.request_id}</code> · <code>{intent.workspace_id}</code></p>
   <button type="button" disabled={busy||inputPending} onClick={()=>void perform(intent,'read')}>{t('读取原请求','Read Original Request')}</button>
   {!value&&<button type="button" disabled={locked||Boolean(journal.error)} onClick={()=>void perform(intent,'prepare')}>{t('重新准备同一请求','Prepare the Same Request Again')}</button>}
  </>}
  {value&&<>
   <button type="button" disabled={locked||Boolean(journal.error)} onClick={forgetLocal}>{t('移除此标签页记录（保留服务端会话）','Remove This Tab Record (Keep Server Session)')}</button>
   <p role="status">{states[value.state]}</p><p>{t('原生会话 ','Native Session ')}<code>{value.session_id}</code></p>
   {value.state==='prepared'&&<>
    <button type="button" disabled={locked} onClick={()=>void perform(intent!,'dispatch')}>{t('建立此原生会话','Create This Native Session')}</button>
    <button type="button" disabled={locked} onClick={()=>void perform(intent!,'cancel')}>{t('取消未启动请求','Cancel Unstarted Request')}</button>
   </>}
   {(value.state==='unknown'||value.state==='dispatched')&&<button type="button" disabled={locked} onClick={()=>void perform(intent!,'observe')}>{t('只观察原生结果','Observe Original Native Result')}</button>}
   {value.state==='ready'&&<>
    <StandaloneTerminalCommandHistory key={value.request_id} admission={value} scopeKey={scopeKey} locked={locked} revision={historyRevision} onRestore={restoreOriginalCommand}/>
    <ConversationDisplayBoundary key={value.request_id+':'+terminalEpoch} label={t('独立终端','Standalone Terminal')}>
     <TerminalPanel admissionId={value.request_id} expectedSessionId={value.session_id} onSettled={settled} onActiveChange={activeChanged} onInputPendingChange={inputChanged}/>
    </ConversationDisplayBoundary>
   </>}
  </>}
  <p>{t('本标签页请求与服务端目录分开保留；移除本地记录不会关闭原生终端。登录状态以提供方原回执为准。','Tab requests and the server catalog are separate. Removing a local record does not close a native terminal. Login status comes from original provider receipts.')}</p>
 </details>;
}
