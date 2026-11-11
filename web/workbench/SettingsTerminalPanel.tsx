// Settings terminal entry adapts PilotDeck ProviderLoginModal/StandaloneShell; AGPL-3.0.
import {useCallback,useContext,useState} from 'react';
import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {request,taskDraftScope} from '../jot/client';
import ConversationTerminals from '../jot/ConversationTerminals';
import ConversationDisplayBoundary from '../jot/ConversationDisplayBoundary';
import {validateTerminalSessionCatalog,type TerminalSessionChoice} from '../../packages/gateway/src/terminal/session-catalog';
import {useResource} from './useResource';
import {MutationPendingState} from './useMutationReceipt';

export default function SettingsTerminalPanel({scopeKey,onPendingChange}:{scopeKey:string;onPendingChange:(value:boolean)=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const [opened,setOpened]=useState(false),[cursors,setCursors]=useState<Array<string|null>>([null]),[page,setPage]=useState(0);
 const [target,setTarget]=useState<{scope:string;value:TerminalSessionChoice}>(),[inputPending,setInputPending]=useState(false);
 const pending=useContext(MutationPendingState),locked=pending||inputPending,before=cursors[page]??null;
 const reportInput=useCallback((value:boolean)=>{setInputPending(value);onPendingChange(value);},[onPendingChange]);
 const catalog=useResource(async signal=>{
  if(taskDraftScope()!==scopeKey)throw Error('terminal_session_scope_changed');
  const value=validateTerminalSessionCatalog(await request<unknown>('/terminal-sessions'+(before?'?before_run_id='+encodeURIComponent(before):''),'GET',undefined,undefined,signal),before);
  if(taskDraftScope()!==scopeKey)throw Error('terminal_session_scope_changed');
  return {...value,scope:scopeKey};
 },JSON.stringify(['settings-terminal-sessions',scopeKey,before]),opened&&/^[a-f0-9]{64}$/.test(scopeKey));
 const current=!catalog.loading&&!catalog.error&&catalog.data?.scope===scopeKey&&catalog.data.before_run_id===before?catalog.data:null;
 const selected=target?.scope===scopeKey?target.value:undefined;
 return <section lang={language} className="wb-form" aria-label={t('提供方登录终端','Provider Login Terminal')}>
  <h3>{t('提供方登录终端','Provider Login Terminal')}</h3>
  <p>{t('选择已有会话，在其原生终端中运行提供方登录或配置命令。打开目录不会创建会话或运行命令。','Choose an existing conversation to run provider login or configuration commands in its native terminal. Opening the catalog does not create a session or run a command.')}</p>
  <details open={opened} onToggle={event=>{if(event.target===event.currentTarget)setOpened(event.currentTarget.open);}}>
   <summary>{t('选择已有原生会话','Choose an Existing Native Session')}</summary>
   {catalog.loading&&<p role="status">{t('正在读取会话目录…','Reading session catalog…')}</p>}
   {catalog.error&&<p role="alert">{t('会话目录尚未确认，请重读。','The session catalog is unconfirmed. Read it again.')}</p>}
   <button type="button" disabled={locked||catalog.loading} onClick={catalog.reload}>{t('重新读取目录','Read Catalog Again')}</button>
   {current&&<>{!current.items.length?<p role="status">{t('此页没有已绑定原生会话的未归档对话。','This page has no active conversations with native session bindings.')}</p>:<ul>{current.items.map(item=><li key={item.run_id}>
    <strong>{item.title||t('未命名对话','Untitled Conversation')}</strong> · <code>{item.workspace_id}</code> · <time>{item.created_at}</time>
    <p><code>{item.conversation_id}</code> · <code>{item.run_id}</code></p>
    <button type="button" disabled={locked} aria-pressed={selected?.run_id===item.run_id&&selected.conversation_id===item.conversation_id} onClick={()=>{if(!locked&&taskDraftScope()===scopeKey)setTarget({scope:scopeKey,value:item});}}>{t('打开终端控件','Open Terminal Controls')}</button>
   </li>)}</ul>}</>}
   <nav aria-label={t('会话目录分页','Session Catalog Pages')}>
    <button type="button" disabled={locked||catalog.loading||page===0} onClick={()=>setPage(value=>value-1)}>{t('上一页','Previous Page')}</button>
    <span>{t(`第 ${page+1} 页`,`Page ${page+1}`)}</span>
    <button type="button" disabled={locked||!current?.next_before_run_id} onClick={()=>{const next=current?.next_before_run_id;if(next){setCursors(values=>[...values.slice(0,page+1),next]);setPage(value=>value+1);}}}>{t('下一页','Next Page')}</button>
   </nav>
  </details>
  {selected&&<>
   <p>{t('已选对话：','Selected Conversation: ')}{selected.title||selected.conversation_id} · <code>{selected.run_id}</code></p>
   <button type="button" disabled={locked} onClick={()=>{if(!locked)setTarget(undefined);}}>{t('关闭此终端入口','Close This Terminal Entry')}</button>
   <ConversationDisplayBoundary key={JSON.stringify([scopeKey,selected.conversation_id,selected.run_id])} label={t('登录终端','Login Terminal')}><ConversationTerminals conversationId={selected.conversation_id} runId={selected.run_id} onInputPendingChange={reportInput}/></ConversationDisplayBoundary>
  </>}
  <p>{t('目录记录只表示原生会话绑定；是否仍可加载、终端控制权和登录结果以原 Host 与提供方回执为准。','Catalog records indicate native session bindings only. The original Host and provider receipts determine load availability, terminal control and login results.')}</p>
 </section>;
}
