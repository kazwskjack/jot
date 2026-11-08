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

function commandSummary(command: { path: string; method: string; body: any }) {
  if (command.method === 'POST' && command.path.endsWith('/mcp/connections')) return `新增连接「${command.body?.server_name ?? '未命名'}」`;
  const operation = command.path.endsWith('/config') ? '变更配置' : command.path.endsWith('/enabled') ? (command.body?.enabled ? '启用连接' : '停用连接') : command.path.endsWith('/tools') ? '更新工具授权' : command.path.endsWith('/reload') ? '重载工具目录' : '移除连接';
  return `${operation} · ${command.path.split('/').at(-2) ?? ''}`;
}

export function McpConnectionsPanel({ agentId, agentName, capabilityEpoch, expectedOwnerScope, onClose, onChanged }: { expectedOwnerScope?:string; agentId: string; agentName: string; capabilityEpoch: number; onClose?: () => void; onChanged?: () => void }) {
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

  const pendingState=pending&&<section aria-label="原命令与当前连接状态">
    <button type="button" disabled={busy||resource.loading} onClick={resource.reload}>读取当前连接状态</button>
    {resource.loading&&<p role="status">正在读取当前目录…</p>}
    {resource.error&&<p role="alert">当前目录暂不可用，请重试读取。</p>}
    {matches&&<ul>{items.map(connection=><li key={connection.connection_id}>{connection.server_name} · 版本 {connection.version} · {projectMcpConnectionState(connection).message}</li>)}</ul>}
    <p>原请求结果仍待原回执确认。</p>
  </section>;
  return <section className="wb-mcp" aria-label="MCP 连接">
    <header className="wb-toolbar">
      <div><h2>MCP 连接</h2><p>管理「{ownerMatches?agentName:'用户范围待确认'}」的 MCP 来源、工具目录与逐项授权。</p></div>
      <div className="wb-actions">
        {onClose && <button type="button" disabled={busy||pending} onClick={onClose}>返回</button>}
        <button type="button" disabled={busy || !context.active} onClick={resource.reload}>重新读取连接</button>
        <button type="button" className="wb-primary" disabled={locked} onClick={beginCreate}>新增 MCP 连接</button>
      </div>
    </header>
    <p className="wb-hint">页面文字、工具说明与 schema 按展示数据处理。配置保存 secret:// 引用，代码注册、实际启动和 HTTP 出站由 Host 授权。</p>
    {!ownerScope && capabilities.data && <p className="wb-error" role="alert">无法确认当前用户范围，请重新读取页面。</p>}
    {recovery.error && <p className="wb-error" role="alert">本机会话无法安全恢复待处理命令：{recovery.error}</p>}
    {(pending || recovery.error) && <p className="wb-hint">读取连接状态用于查看当前目录，原请求结果依原回执确认。</p>}
    {capabilities.loading && <p className="wb-status" role="status">正在确认工作台用户范围…</p>}
    {capabilities.error && <div className="wb-error" role="alert"><span>{capabilities.error}</span><button type="button" onClick={capabilities.reload}>重新读取工作台范围</button></div>}
    {resource.loading && <p className="wb-status" role="status">正在读取 MCP 连接…</p>}
    {resource.error && <div className="wb-error" role="alert"><span>{resource.error}</span><button type="button" onClick={resource.reload}>重新读取连接</button></div>}
    {currentFeedback && <p className="wb-error" role="alert">{currentFeedback}</p>}
    {ready && items.length === 0 && <p className="wb-empty">尚未配置 MCP 连接。</p>}
    {ready && <div className="wb-mcp-list">{items.map(connection => {
      const state = projectMcpConnectionState(connection);
      const chosen = currentSelection?.connectionId === connection.connection_id ? currentSelection.ids : connection.tools.filter(tool => tool.approved).map(tool => tool.tool_id);
      return <article className="wb-mcp-card" key={connection.connection_id} aria-label={`MCP 连接 ${connection.server_name}`}>
        <div className="wb-card-top"><div><h3>{connection.server_name}</h3><small>来源：Owner 配置的 {connection.transport === 'stdio' ? '本机进程' : 'HTTP 服务'} · Gateway MCP 目录</small></div><span className="wb-badge">{connection.enabled ? '已启用' : '已停用'} · {state.kind === 'reload-failed-retained' ? '重载失败（保留旧目录）' : connection.state}</span></div>
        <dl className="wb-mcp-meta">
          <div><dt>版本</dt><dd>{connection.version}</dd></div><div><dt>活动目录代次</dt><dd>{connection.active_generation}</dd></div>
          <div><dt>待处理代次</dt><dd>{connection.pending_generation ?? '无'}</dd></div><div><dt>凭据引用</dt><dd>{connection.credentials_configured ? '已填写引用，凭据状态由 Host 确认' : '未填写引用'}</dd></div>
        </dl>
        <p className="wb-status" role="status">{state.message}</p>
        {connection.last_error_code && <p className="wb-status">最近安全错误码：{connection.last_error_code}</p>}
        <div className="wb-actions">
          <button type="button" disabled={locked} onClick={() => beginEdit(connection)}>变更配置</button>
          <button type="button" disabled={locked} onClick={() => connectionAction(connection, 'enable')}>{connection.enabled ? '停用连接' : '启用连接'}</button>
          <button type="button" disabled={locked || !connection.enabled} onClick={() => connectionAction(connection, 'reload')}>重载工具目录</button>
          <button type="button" className="wb-danger" disabled={locked} onClick={() => connectionAction(connection, 'remove')}>移除连接</button>
        </div>
        <div className="wb-mcp-tools"><h4>发现的工具与输入 schema</h4>
          {!connection.tools.length && <p className="wb-status">尚未发现工具。需要显式审核并重载目录。</p>}
          {connection.tools.map(tool => <section className="wb-mcp-tool" key={tool.tool_id}>
            <div className="wb-card-top"><label className="wb-checkbox"><input type="checkbox" aria-label={tool.public_name} checked={chosen.includes(tool.tool_id)} disabled={locked || !state.canApproveTools} onChange={event => toggleTool(connection, tool, event.target.checked)}/><strong>{tool.public_name}</strong></label><span className="wb-badge">{tool.approved ? (state.canApproveTools ? '已批准（活动目录）' : '已批准（连接未就绪）') : '未批准'}</span></div>
            <p>{tool.source === 'mcp_server' ? 'MCP 服务器返回' : '来源未核实'} · {tool.source_untrusted ? '描述和输入 schema 是不可信资料' : '来源标记无效'}</p>
            <p>来源工具 ID：<code>{tool.raw_name}</code></p>
            <p className="wb-mcp-description">{tool.description}</p>
            <details><summary>查看输入 schema</summary><pre>{JSON.stringify(tool.input_schema, null, 2)}</pre></details>
          </section>)}
          {connection.tools.length > 0 && <button type="button" disabled={locked || !state.canApproveTools} onClick={() => reviewGrant(connection)}>审阅工具授权变更</button>}
        </div>
      </article>;
    })}</div>}

    {currentEditor && !pending && <form className="wb-form" aria-label={currentEditor.kind === 'create' ? '新增 MCP 连接配置' : 'MCP 连接新配置'} onSubmit={reviewEditor}>
      <div className="wb-form-head"><h3>{currentEditor.kind === 'create' ? '新增 MCP 连接' : `为「${currentEditor.connection?.server_name}」提交完整新配置`}</h3><button type="button" onClick={() => setEditor(null)}>关闭配置</button></div>
      {currentEditor.kind === 'edit' && <p className="wb-hint">Gateway 提供脱敏投影，编辑时请重新输入完整配置。</p>}
      <fieldset className="wb-input-fields" disabled={locked}>
        <label>服务名称<input required maxLength={32} pattern="[A-Za-z][A-Za-z0-9_-]{0,31}" value={currentEditor.draft.server_name} onChange={event => setEditor({ ...currentEditor, draft: { ...currentEditor.draft, server_name: event.target.value } })}/></label>
        <label>传输方式<select value={currentEditor.draft.transport} onChange={event => setEditor({ ...currentEditor, draft: { ...currentEditor.draft, transport: event.target.value } })}><option value="stdio">stdio 本机进程</option><option value="streamable-http">Streamable HTTP</option></select></label>
        {currentEditor.draft.transport === 'stdio' ? <>
          <label>启动命令<input required maxLength={1024} value={currentEditor.draft.command} onChange={event => setEditor({ ...currentEditor, draft: { ...currentEditor.draft, command: event.target.value } })}/></label>
          <label>启动参数（JSON 数组）<textarea rows={3} value={currentEditor.draft.args_json} onChange={event => setEditor({ ...currentEditor, draft: { ...currentEditor.draft, args_json: event.target.value } })} placeholder='["--safe-mode"]'/></label>
          <label>工作目录（可选）<input maxLength={2048} value={currentEditor.draft.cwd} onChange={event => setEditor({ ...currentEditor, draft: { ...currentEditor.draft, cwd: event.target.value } })}/></label>
          <label>环境变量秘密引用（JSON 对象）<textarea rows={3} value={currentEditor.draft.env_refs_json} onChange={event => setEditor({ ...currentEditor, draft: { ...currentEditor.draft, env_refs_json: event.target.value } })} placeholder='{"TOKEN":"secret://owner/server-token"}'/></label>
        </> : <>
          <label>Streamable HTTP 服务地址<input required type="url" maxLength={2048} value={currentEditor.draft.url} onChange={event => setEditor({ ...currentEditor, draft: { ...currentEditor.draft, url: event.target.value } })} placeholder="https://mcp.example.invalid/mcp"/></label>
          <label>HTTP Header 秘密引用（JSON 对象）<textarea rows={3} value={currentEditor.draft.header_refs_json} onChange={event => setEditor({ ...currentEditor, draft: { ...currentEditor.draft, header_refs_json: event.target.value } })} placeholder='{"Authorization":"secret://owner/http-token"}'/></label>
        </>}
      </fieldset>
      <p className="wb-hint">秘密栏只接受 secret:// 引用；不要粘贴 token、密码或其他秘密值。</p>
      <button className="wb-primary" type="submit" disabled={locked}>检查配置并继续</button>
    </form>}

    {currentReview && <dialog ref={dialogRef} className="wb-form wb-mcp-review" role="alertdialog" aria-label={currentReview.title} onCancel={event=>{event.preventDefault();if(!busy&&!pending)setReview(null);}}>
      <h3>{currentReview.title}</h3><p>{currentReview.explanation}</p>
      {pendingState}
      {currentReview.config !== undefined && <><h4>将提交的完整配置</h4><pre>{JSON.stringify(currentReview.config, null, 2)}</pre></>}
      {currentReview.toolIds && <><h4>精确授权列表</h4><ul>{currentReview.toolIds.map(id => <li key={id}><code>{id}</code></li>)}</ul></>}
      {pending && pendingCommand && <p className="wb-status" role="status">上次请求结果未知。当前回执已冻结为：{commandSummary(pendingCommand)}。重试会使用原请求体和幂等键。</p>}
      {currentFeedback && <p className="wb-error" role="alert">{currentFeedback}</p>}
      <div className="wb-actions"><button type="button" disabled={busy || pending} onClick={() => { setReview(null); setEditor(null); }}>返回编辑</button><button className="wb-primary" type="button" disabled={busy || (!pending && !ready)} onClick={confirmReview}>{busy ? '正在提交…' : pending ? '重试原请求' : currentReview.title === '审核新增 MCP 连接' ? '确认新增连接' : currentReview.title === '审核 MCP 配置变更' ? '确认提交新配置' : currentReview.title === '审核启用 MCP 连接' ? '确认启用' : currentReview.title === '审核停用 MCP 连接' ? '确认停用' : currentReview.title === '审核 MCP 工具目录重载' ? '确认重载工具目录' : currentReview.title === '审核工具授权' ? '确认授权所选工具' : '确认移除连接'}</button></div>
    </dialog>}

    {pending && !currentReview && pendingCommand && <dialog ref={dialogRef} className="wb-form wb-mcp-review" role="alertdialog" aria-label="待确认的 MCP 变更" onCancel={event=>event.preventDefault()}>
      {pendingState}
      <h3>待确认的 MCP 变更</h3><p>上次请求结果未知：{commandSummary(pendingCommand)}。此命令按 owner 与 Agent 隔离保存；重试会复用原请求体和幂等键。</p>
      {currentFeedback && <p className="wb-error" role="alert">{currentFeedback}</p>}
      <button className="wb-primary" type="button" disabled={busy} onClick={retryPending}>{busy ? '正在提交…' : '重试原请求'}</button>
    </dialog>}
  </section>;
}

export default McpConnectionsPanel;
