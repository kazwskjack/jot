import {useApplicationLanguage,useApplicationText,applicationText} from '../jot/application-language';
import type {ApplicationLanguage} from '../../packages/desktop/src/application-language.mjs';
import {mcpUiMessage} from './mcp-ui-messages';
import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { request, taskDraftScope } from '../jot/client';
import { useResource } from './useResource';
import { TaskSaveReceipt } from './task-save-receipt.mjs';
import {MutationPending} from './MutationContext';
import { McpCommandStore, buildMcpConfig } from './mcp-connections-ui.mjs';
import { McpPanelContext, createMcpConnectionsClient, projectMcpConnectionState } from './mcp-connections-client.mjs';
import type {McpTool,McpConnection,McpConnectionPage as McpList} from '../../packages/gateway/contracts/types';
import './workbench.css';
import './McpConnectionsPanel.css';
import McpOperationStatusPanel from './McpOperationStatusPanel';


type Draft = { server_name: string; transport: string; command: string; args_json: string; cwd: string; env_refs_json: string; url: string; header_refs_json: string };
type Editor = { identity: string; kind: 'create' | 'edit'; connection: McpConnection | null; draft: Draft };
type Review = { identity: string; title: string; explanation: string; path: string; method: string; body: unknown; config?: unknown; toolIds?: string[] };
type ScopedList = McpList & { agent_id: string; owner_scope: string; context_identity: string };

const emptyDraft = (): Draft => ({ server_name: '', transport: 'stdio', command: '', args_json: '', cwd: '', env_refs_json: '', url: '', header_refs_json: '' });
const errorText = (reason: unknown) => {
  const code = reason instanceof Error ? reason.message : '';
  return ({ MCP_COMMAND_PENDING: '已有原命令待处理，请先确认原回执。', MCP_COMMAND_STORAGE_UNAVAILABLE: '本地回执存储不可用，请保留原命令。', VERSION_CONFLICT: '连接版本已变化，请重新读取后审阅新配置。', MCP_CONNECTION_BUSY: '连接仍有操作在处理，请先读取当前状态。', MCP_RELOAD_IN_PROGRESS: '目录重载仍在处理，请读取当前状态。', MCP_CONNECTION_DISABLED: '请先启用连接，再显式重载。', MCP_SERVER_NAME_CONFLICT: '该角色已有同名连接，请修改服务名称。', MCP_CONNECTIONS_LIMIT: '该角色已达到连接数量上限。', MCP_TOOL_CATALOG_LIMIT: '工具目录超过当前限制，请调整服务器目录。', MCP_RELOAD_UNAVAILABLE: 'Host 重载入口暂不可用，请保留配置并检查宿主。', MCP_RESPONSE_UNKNOWN: '连接回执无效，结果仍未知；原请求已保留。', MCP_CONTEXT_CHANGED: '用户、Agent 或能力代次已变化；原请求结果不会应用到当前页面。', MCP_RECEIPT_EPOCH_CHANGED: '原请求属于不同能力代次，结果仍未知。请读取连接状态并保留原回执。', MCP_RECEIPT_EPOCH_UNKNOWN: '原回执缺少能力代次，结果仍未知。请读取连接状态并保留原回执。' } as Record<string, string>)[code] ?? (code || '操作未完成');
};
const pathId = (value: string) => encodeURIComponent(value);

function commandSummary(command: { path: string; method: string; body: any },language:ApplicationLanguage) {
  const t=applicationText(language);
  if (command.method === 'POST' && command.path.endsWith('/mcp/connections')) return t(`新增连接「${command.body?.server_name ?? '未命名'}」`,`Add Connection “${command.body?.server_name ?? 'Unnamed'}”`);
  const operation = command.path.endsWith('/config') ? t("变更配置","Change Configuration") : command.path.endsWith('/enabled') ? (command.body?.enabled ? t("启用连接","Enable Connection") : t("停用连接","Disable Connection")) : command.path.endsWith('/tools') ? t("更新工具授权","Update Tool Approval") : command.path.endsWith('/reload') ? t("重载工具目录","Reload Tool Catalog") : t("移除连接","Remove Connection");
  return `${operation} · ${command.path.split('/').at(-2) ?? ''}`;
}

export function McpConnectionsPanel({ agentId, agentName, capabilityEpoch, expectedOwnerScope, onClose, onChanged }: { expectedOwnerScope?:string; agentId: string; agentName: string; capabilityEpoch: number; onClose?: () => void; onChanged?: () => void }) {
  const language=useApplicationLanguage(),t=useApplicationText();
  const message=(value:string)=>mcpUiMessage(value,language);
  const capabilities = useResource(signal => request<Record<string, unknown>>('/capabilities', 'GET', undefined, undefined, signal), 'mcp-panel-capabilities');
  const ownerScope = taskDraftScope();
  const ownerMatches=expectedOwnerScope===undefined||expectedOwnerScope===ownerScope;
  const reportPending=useContext(MutationPending);
  const contexts = useRef(new McpPanelContext());
  const dialogRef=useRef<HTMLDialogElement|null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const context = contexts.current.select(ownerMatches?ownerScope:'', agentId, capabilityEpoch);
  const identity = context.identity;
  const recovery = useMemo(() => {
    if (!ownerScope) return { receipt: null as TaskSaveReceipt | null, error: '' };
    if (!context.active) return { receipt: null as TaskSaveReceipt | null, error: '无法确认当前 Agent 的能力代次，请重新读取角色。' };
    try {
      const store = new McpCommandStore(window.sessionStorage, ownerScope, agentId, capabilityEpoch);
      return { receipt: new TaskSaveReceipt(() => crypto.randomUUID(), store), error: '' };
    } catch (reason) {
      return { receipt: null as TaskSaveReceipt | null, error: errorText(reason) };
    }
  }, [ownerScope, agentId, capabilityEpoch, identity]);
  const receipt = recovery.receipt;
  const client = useMemo(() => createMcpConnectionsClient({ request, receipt, context, isCurrent: () => mounted.current && contexts.current.isCurrent(context, taskDraftScope()) }), [receipt, context]);
  const resource = useResource(async signal => {
    const page = await client.read(signal);
    return { ...page, agent_id: agentId, owner_scope: ownerScope, context_identity: identity } as ScopedList;
  }, identity, Boolean(capabilities.data && context.active));
  const [receiptRevision, setReceiptRevision] = useState(0);
  const [busyIdentity, setBusyIdentity] = useState('');
  const [feedback, setFeedback] = useState<{ identity: string; text: string } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [selection, setSelection] = useState<{ identity: string; connectionId: string; ids: string[] } | null>(null);
  const matches = resource.data?.context_identity === identity && resource.data.agent_id === agentId && resource.data.owner_scope === ownerScope && taskDraftScope() === ownerScope;
  const items = matches ? resource.data?.items ?? [] : [];
  const currentReview = review?.identity === identity ? review : null;
  const currentEditor = editor?.identity === identity ? editor : null;
  const currentSelection = selection?.identity === identity ? selection : null;
  const currentFeedback = feedback?.identity === identity ? feedback.text : '';
  const busy = busyIdentity === identity;
  const pending = Boolean(receipt?.pending);
  useEffect(()=>{
    const dialog=dialogRef.current;
    if(dialog&&!dialog.open)dialog.showModal();
  },[currentReview,pending,identity]);
  useEffect(()=>{reportPending(busy||pending);return()=>reportPending(false);},[busy,pending,reportPending]);
  useEffect(()=>{
    const warn=(event:BeforeUnloadEvent)=>{if(receipt?.pending){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',warn);
    return()=>window.removeEventListener('beforeunload',warn);
  },[receipt]);
  const pendingCommand = receipt?.command as { path: string; method: string; body: any; key: string } | null;
  // Reading the receipt revision makes mutations observable without giving the
  // reusable receipt class a React dependency.
  void receiptRevision;
  const ready = Boolean(matches && !resource.loading && !resource.error && context.active);
  const locked = busy || pending || !ready || !receipt || Boolean(recovery.error);

  const current = (captured: string) => mounted.current && contexts.current.current?.identity === captured && contexts.current.isCurrent(context, taskDraftScope());
  const makeReview = (title: string, explanation: string, path: string, method: string, body: unknown, extras: Partial<Review> = {}) => {
    setFeedback(null);
    setReview({ identity, title, explanation, path, method, body, ...extras });
  };
  const submit = async (command: { path: string; method: string; body: unknown }, captured: string) => {
    if (!receipt || busyIdentity === captured || (pending && receipt.command == null)) return;
    setBusyIdentity(captured);
    setFeedback(null);
    try {
      const operation = client.submit(command.path, command.method, command.body);
      setReceiptRevision(value => value + 1);
      await operation;
      if (!current(captured)) return;
      setReview(null);
      setEditor(null);
      setSelection(null);
      resource.reload();
      onChanged?.();
    } catch (reason) {
      if (current(captured)) setFeedback({ identity: captured, text: errorText(reason) });
    } finally {
      setReceiptRevision(value => value + 1);
      setBusyIdentity(value => value === captured ? '' : value);
    }
  };
  const confirmReview = () => {
    if (!currentReview || !receipt) return;
    const original = receipt.pending ? receipt.command : currentReview;
    if (!original) return;
    void submit(original, identity);
  };
  const retryPending = () => {
    if (!pendingCommand) return;
    void submit(pendingCommand, identity);
  };
  const beginCreate = () => {
    setFeedback(null);
    setReview(null);
    setEditor({ identity, kind: 'create', connection: null, draft: emptyDraft() });
  };
  const beginEdit = (connection: McpConnection) => {
    setFeedback(null);
    setReview(null);
    setEditor({ identity, kind: 'edit', connection, draft: { ...emptyDraft(), server_name: connection.server_name, transport: connection.transport } });
  };
  const reviewEditor = (event: React.FormEvent) => {
    event.preventDefault();
    if (!currentEditor) return;
    try {
      const config = buildMcpConfig(currentEditor.draft);
      const creating = currentEditor.kind === 'create';
      const path = creating ? `/agents/${pathId(agentId)}/mcp/connections` : `/agents/${pathId(agentId)}/mcp/connections/${pathId(currentEditor.connection!.connection_id)}/config`;
      const body = creating ? config : { expected_version: currentEditor.connection!.version, config };
      makeReview(creating ? '审核新增 MCP 连接' : '审核 MCP 配置变更', creating ? '新连接保存为停用状态，工具目录由你显式重载。' : '确认后提交这份完整新配置，再显式请求工具目录重载。', path, creating ? 'POST' : 'PATCH', body, { config });
    } catch (reason) {
      setFeedback({ identity, text: errorText(reason) });
    }
  };
  const connectionAction = (connection: McpConnection, action: 'enable' | 'reload' | 'remove') => {
    const path = `/agents/${pathId(agentId)}/mcp/connections/${pathId(connection.connection_id)}`;
    if (action === 'enable') makeReview(connection.enabled ? '审核停用 MCP 连接' : '审核启用 MCP 连接', connection.enabled ? '停用会撤销该连接的运行授权，并保留配置与工具目录。' : '启用后请手动重载，再逐项批准工具。', `${path}/enabled`, 'PATCH', { expected_version: connection.version, enabled: !connection.enabled });
    if (action === 'reload') makeReview('审核 MCP 工具目录重载', '将按当前配置请求 Host 重载，发现的工具进入待审核目录。', `${path}/reload`, 'POST', { expected_version: connection.version });
    if (action === 'remove') makeReview('审核移除 MCP 连接', '移除后会撤销该连接的工具授权。', path, 'DELETE', { expected_version: connection.version });
  };
  const reviewGrant = (connection: McpConnection) => {
    const ids = currentSelection?.connectionId === connection.connection_id ? currentSelection.ids : connection.tools.filter(tool => tool.approved).map(tool => tool.tool_id);
    const chosen = [...new Set(ids)].sort();
    makeReview('审核工具授权', `只授权以下 ${chosen.length} 个工具；新发现或未列出的工具不会获批。`, `/agents/${pathId(agentId)}/mcp/connections/${pathId(connection.connection_id)}/tools`, 'PUT', { expected_version: connection.version, tool_ids: chosen }, { toolIds: chosen });
  };
  const toggleTool = (connection: McpConnection, tool: McpTool, checked: boolean) => {
    const base = currentSelection?.connectionId === connection.connection_id
      ? currentSelection.ids
      : connection.tools.filter(item => item.approved).map(item => item.tool_id);
    const ids = checked ? [...new Set([...base, tool.tool_id])] : base.filter(id => id !== tool.tool_id);
    setSelection({ identity, connectionId: connection.connection_id, ids });
  };

  const pendingState=pending&&<section aria-label={t("原命令与当前连接状态","Original Command and Current Connection Status")}>
    <button type="button" disabled={busy||resource.loading} onClick={resource.reload}>{t("读取当前连接状态","Read Current Connection Status")}</button>
    {resource.loading&&<p role="status">{t("正在读取当前目录…","Reading Current Catalog…")}</p>}
    {resource.error&&<p role="alert">{t("当前目录暂不可用，请重试读取。","The current catalog is unavailable. Retry reading.")}</p>}
    {matches&&<ul>{items.map(connection=><li key={connection.connection_id}>{connection.server_name}{t(" · 版本 "," · Version ")}{connection.version} · {message(projectMcpConnectionState(connection).message)}</li>)}</ul>}
    <p>{t("原请求结果仍待原回执确认。","The original request result still requires its original receipt.")}</p>
  </section>;
  return <section lang={language} className="wb-mcp" aria-label={t("MCP 连接","MCP Connections")}>
    <header className="wb-toolbar">
      <div><h2>{t("MCP 连接","MCP Connections")}</h2><p>{t("管理「","Manage MCP sources, tool catalogs and individual approvals for “")}{ownerMatches?agentName:t("用户范围待确认","User Scope Unconfirmed")}{t("」的 MCP 来源、工具目录与逐项授权。","”.")}</p></div>
      <div className="wb-actions">
        {onClose && <button type="button" disabled={busy||pending} onClick={onClose}>{t("返回","Back")}</button>}
        <button type="button" disabled={busy || !context.active} onClick={resource.reload}>{t("重新读取连接","Read Connections Again")}</button>
        <button type="button" className="wb-primary" disabled={locked} onClick={beginCreate}>{t("新增 MCP 连接","Add MCP Connection")}</button>
      </div>
    </header>
    <p className="wb-hint">{t("页面文字、工具说明与 schema 按展示数据处理。配置保存 secret:// 引用，代码注册、实际启动和 HTTP 出站由 Host 授权。","Page text, tool descriptions and schemas are display data. Configurations store secret:// references. Code registration, actual startup and outbound HTTP require Host authorization.")}</p>
    {!ownerScope && capabilities.data && <p className="wb-error" role="alert">{t("无法确认当前用户范围，请重新读取页面。","The current user scope is unconfirmed. Read the page again.")}</p>}
    {recovery.error && <p className="wb-error" role="alert">{t("本机会话无法安全恢复待处理命令：","This Local Session Cannot Safely Recover Pending Commands: ")}{message(recovery.error)}</p>}
    {(pending || recovery.error) && <p className="wb-hint">{t("读取连接状态用于查看当前目录，原请求结果依原回执确认。","Connection status shows the current catalog. Confirm the original request result using its original receipt.")}</p>}
    {capabilities.loading && <p className="wb-status" role="status">{t("正在确认工作台用户范围…","Confirming Workbench User Scope…")}</p>}
    {capabilities.error && <div className="wb-error" role="alert"><span>{message(capabilities.error)}</span><button type="button" onClick={capabilities.reload}>{t("重新读取工作台范围","Read Workbench Scope Again")}</button></div>}
    {resource.loading && <p className="wb-status" role="status">{t("正在读取 MCP 连接…","Reading MCP Connections…")}</p>}
    {resource.error && <div className="wb-error" role="alert"><span>{message(resource.error)}</span><button type="button" onClick={resource.reload}>{t("重新读取连接","Read Connections Again")}</button></div>}
    {currentFeedback && <p className="wb-error" role="alert">{message(currentFeedback)}</p>}
    {context.active&&capabilities.data&&<McpOperationStatusPanel client={client} identity={identity}/>}
    {ready && items.length === 0 && <p className="wb-empty">{t("尚未配置 MCP 连接。","No MCP connection is configured.")}</p>}
    {ready && <div className="wb-mcp-list">{items.map(connection => {
      const state = projectMcpConnectionState(connection);
      const chosen = currentSelection?.connectionId === connection.connection_id ? currentSelection.ids : connection.tools.filter(tool => tool.approved).map(tool => tool.tool_id);
      return <article className="wb-mcp-card" key={connection.connection_id} aria-label={t(`MCP 连接 ${connection.server_name}`,`MCP Connection ${connection.server_name}`)}>
        <div className="wb-card-top"><div><h3>{connection.server_name}</h3><small>{t('来源：Owner 配置的 ','Source: Owner-configured ')}{connection.transport === 'stdio' ? t("本机进程","Local Process") : t("HTTP 服务","HTTP Service")}{t(' · Gateway MCP 目录',' · Gateway MCP Catalog')}</small></div><span className="wb-badge">{connection.enabled ? t("已启用","Enabled") : t("已停用","Disabled")} · {state.kind === 'reload-failed-retained' ? t("重载失败（保留旧目录）","Reload Failed (Previous Catalog Retained)") : connection.state}</span></div>
        <dl className="wb-mcp-meta">
          <div><dt>{t("版本","Version")}</dt><dd>{connection.version}</dd></div><div><dt>{t("活动目录代次","Active Catalog Generation")}</dt><dd>{connection.active_generation}</dd></div>
          <div><dt>{t("待处理代次","Pending Generation")}</dt><dd>{connection.pending_generation ?? t("无","None")}</dd></div><div><dt>{t("凭据引用","Credential References")}</dt><dd>{connection.credentials_configured ? t("已填写引用，凭据状态由 Host 确认","References Supplied; Host Confirms Credential Status") : t("未填写引用","No References Supplied")}</dd></div>
        </dl>
        <p className="wb-status" role="status">{message(state.message)}</p>
        {connection.last_error_code && <p className="wb-status">{t("最近安全错误码：","Latest Safe Error Code: ")}{connection.last_error_code}</p>}
        <div className="wb-actions">
          <button type="button" disabled={locked} onClick={() => beginEdit(connection)}>{t("变更配置","Change Configuration")}</button>
          <button type="button" disabled={locked} onClick={() => connectionAction(connection, 'enable')}>{connection.enabled ? t("停用连接","Disable Connection") : t("启用连接","Enable Connection")}</button>
          <button type="button" disabled={locked || !connection.enabled} onClick={() => connectionAction(connection, 'reload')}>{t("重载工具目录","Reload Tool Catalog")}</button>
          <button type="button" className="wb-danger" disabled={locked} onClick={() => connectionAction(connection, 'remove')}>{t("移除连接","Remove Connection")}</button>
        </div>
        <div className="wb-mcp-tools"><h4>{t("发现的工具与输入 schema","Discovered Tools and Input Schemas")}</h4>
          {!connection.tools.length && <p className="wb-status">{t("尚未发现工具。需要显式审核并重载目录。","No tools discovered yet. Explicitly review and reload the catalog.")}</p>}
          {connection.tools.map(tool => <section className="wb-mcp-tool" key={tool.tool_id}>
            <div className="wb-card-top"><label className="wb-checkbox"><input type="checkbox" aria-label={tool.public_name} checked={chosen.includes(tool.tool_id)} disabled={locked || !state.canApproveTools} onChange={event => toggleTool(connection, tool, event.target.checked)}/><strong>{tool.public_name}</strong></label><span className="wb-badge">{tool.approved ? (state.canApproveTools ? t("已批准（活动目录）","Approved (Active Catalog)") : t("已批准（连接未就绪）","Approved (Connection Not Ready)")) : t("未批准","Not Approved")}</span></div>
            <p>{tool.source === 'mcp_server' ? t("MCP 服务器返回","Returned by MCP Server") : t("来源未核实","Source Unverified")} · {tool.source_untrusted ? t("描述和输入 schema 是不可信资料","Descriptions and Input Schemas Are Untrusted Data") : t("来源标记无效","Invalid Source Marker")}</p>
            <p>{t("来源工具 ID：","Source Tool ID: ")}<code>{tool.raw_name}</code></p>
            <p className="wb-mcp-description">{tool.description}</p>
            <details><summary>{t("查看输入 schema","View Input Schema")}</summary><pre>{JSON.stringify(tool.input_schema, null, 2)}</pre></details>
          </section>)}
          {connection.tools.length > 0 && <button type="button" disabled={locked || !state.canApproveTools} onClick={() => reviewGrant(connection)}>{t("审阅工具授权变更","Review Tool Approval Changes")}</button>}
        </div>
      </article>;
    })}</div>}

    {currentEditor && !pending && <form className="wb-form" aria-label={currentEditor.kind === 'create' ? t("新增 MCP 连接配置","New MCP Connection Configuration") : t("MCP 连接新配置","New Configuration for MCP Connection")} onSubmit={reviewEditor}>
      <div className="wb-form-head"><h3>{currentEditor.kind === 'create' ? t("新增 MCP 连接","Add MCP Connection") : t(`为「${currentEditor.connection?.server_name}」提交完整新配置`,`Submit Complete New Configuration for “${currentEditor.connection?.server_name}”`)}</h3><button type="button" onClick={() => setEditor(null)}>{t("关闭配置","Close Configuration")}</button></div>
      {currentEditor.kind === 'edit' && <p className="wb-hint">{t("Gateway 提供脱敏投影，编辑时请重新输入完整配置。","The Gateway provides a redacted projection. Enter the complete configuration again when editing.")}</p>}
      <fieldset className="wb-input-fields" disabled={locked}>
        <label>{t("服务名称","Server Name")}<input required maxLength={32} pattern="[A-Za-z][A-Za-z0-9_-]{0,31}" value={currentEditor.draft.server_name} onChange={event => setEditor({ ...currentEditor, draft: { ...currentEditor.draft, server_name: event.target.value } })}/></label>
        <label>{t("传输方式","Transport")}<select value={currentEditor.draft.transport} onChange={event => setEditor({ ...currentEditor, draft: { ...currentEditor.draft, transport: event.target.value } })}><option value="stdio">{t("stdio 本机进程","stdio Local Process")}</option><option value="streamable-http">Streamable HTTP</option></select></label>
        {currentEditor.draft.transport === 'stdio' ? <>
          <label>{t("启动命令","Launch Command")}<input required maxLength={1024} value={currentEditor.draft.command} onChange={event => setEditor({ ...currentEditor, draft: { ...currentEditor.draft, command: event.target.value } })}/></label>
          <label>{t("启动参数（JSON 数组）","Launch Arguments (JSON Array)")}<textarea rows={3} value={currentEditor.draft.args_json} onChange={event => setEditor({ ...currentEditor, draft: { ...currentEditor.draft, args_json: event.target.value } })} placeholder='["--safe-mode"]'/></label>
          <label>{t("工作目录（可选）","Working Directory (Optional)")}<input maxLength={2048} value={currentEditor.draft.cwd} onChange={event => setEditor({ ...currentEditor, draft: { ...currentEditor.draft, cwd: event.target.value } })}/></label>
          <label>{t("环境变量秘密引用（JSON 对象）","Environment Secret References (JSON Object)")}<textarea rows={3} value={currentEditor.draft.env_refs_json} onChange={event => setEditor({ ...currentEditor, draft: { ...currentEditor.draft, env_refs_json: event.target.value } })} placeholder='{"TOKEN":"secret://owner/server-token"}'/></label>
        </> : <>
          <label>{t("Streamable HTTP 服务地址","Streamable HTTP Server Address")}<input required type="url" maxLength={2048} value={currentEditor.draft.url} onChange={event => setEditor({ ...currentEditor, draft: { ...currentEditor.draft, url: event.target.value } })} placeholder="https://mcp.example.invalid/mcp"/></label>
          <label>{t("HTTP Header 秘密引用（JSON 对象）","HTTP Header Secret References (JSON Object)")}<textarea rows={3} value={currentEditor.draft.header_refs_json} onChange={event => setEditor({ ...currentEditor, draft: { ...currentEditor.draft, header_refs_json: event.target.value } })} placeholder='{"Authorization":"secret://owner/http-token"}'/></label>
        </>}
      </fieldset>
      <p className="wb-hint">{t("秘密栏只接受 secret:// 引用；不要粘贴 token、密码或其他秘密值。","Secret fields accept only secret:// references. Do not paste tokens, passwords or other secret values.")}</p>
      <button className="wb-primary" type="submit" disabled={locked}>{t("检查配置并继续","Check Configuration and Continue")}</button>
    </form>}

    {currentReview && <dialog ref={dialogRef} className="wb-form wb-mcp-review" role="alertdialog" aria-label={message(currentReview.title)} onCancel={event=>{event.preventDefault();if(!busy&&!pending)setReview(null);}}>
      <h3>{message(currentReview.title)}</h3><p>{message(currentReview.explanation)}</p>
      {pendingState}
      {currentReview.config !== undefined && <><h4>{t("将提交的完整配置","Complete Configuration to Submit")}</h4><pre>{JSON.stringify(currentReview.config, null, 2)}</pre></>}
      {currentReview.toolIds && <><h4>{t("精确授权列表","Exact Approval List")}</h4><ul>{currentReview.toolIds.map(id => <li key={id}><code>{id}</code></li>)}</ul></>}
      {pending && pendingCommand && <p className="wb-status" role="status">{t('上次请求结果未知。当前回执已冻结为：','The previous request result is unknown. The current receipt is frozen as: ')}{commandSummary(pendingCommand,language)}{t('。重试会使用原请求体和幂等键。','. Retrying uses the original request body and idempotency key.')}</p>}
      {currentFeedback && <p className="wb-error" role="alert">{message(currentFeedback)}</p>}
      <div className="wb-actions"><button type="button" disabled={busy || pending} onClick={() => { setReview(null); setEditor(null); }}>{t("返回编辑","Back to Edit")}</button><button className="wb-primary" type="button" disabled={busy || (!pending && !ready)} onClick={confirmReview}>{busy ? t("正在提交…","Submitting…") : pending ? t("重试原请求","Retry Original Request") : currentReview.title === '审核新增 MCP 连接' ? t("确认新增连接","Confirm New Connection") : currentReview.title === '审核 MCP 配置变更' ? t("确认提交新配置","Confirm New Configuration") : currentReview.title === '审核启用 MCP 连接' ? t("确认启用","Confirm Enable") : currentReview.title === '审核停用 MCP 连接' ? t("确认停用","Confirm Disable") : currentReview.title === '审核 MCP 工具目录重载' ? t("确认重载工具目录","Confirm Tool Catalog Reload") : currentReview.title === '审核工具授权' ? t("确认授权所选工具","Confirm Approval of Selected Tools") : t("确认移除连接","Confirm Connection Removal")}</button></div>
    </dialog>}

    {pending && !currentReview && pendingCommand && <dialog ref={dialogRef} className="wb-form wb-mcp-review" role="alertdialog" aria-label={t("待确认的 MCP 变更","Unconfirmed MCP Change")} onCancel={event=>event.preventDefault()}>
      {pendingState}
      <h3>{t("待确认的 MCP 变更","Unconfirmed MCP Change")}</h3><p>{t('上次请求结果未知：','The previous request result is unknown: ')}{commandSummary(pendingCommand,language)}{t('。此命令按 owner 与 Agent 隔离保存；重试会复用原请求体和幂等键。','. This command is stored separately by owner and Agent; retrying reuses the original body and idempotency key.')}</p>
      {currentFeedback && <p className="wb-error" role="alert">{message(currentFeedback)}</p>}
      <button className="wb-primary" type="button" disabled={busy} onClick={retryPending}>{busy ? t("正在提交…","Submitting…") : t("重试原请求","Retry Original Request")}</button>
    </dialog>}
  </section>;
}

export default McpConnectionsPanel;
